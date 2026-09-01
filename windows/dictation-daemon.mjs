import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const SAMPLE_RATE = 16_000;
const FRAME_LENGTH = 512;
const CHINESE_OUTPUTS = new Set(["simplified", "traditional-taiwan", "traditional-hong-kong"]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function getAgentDir(environment = process.env, home = homedir()) {
  return environment.PI_CODING_AGENT_DIR?.trim() || join(home, ".pi", "agent");
}

export function parseSettings(value, source = "pi-transcribe.json") {
  if (!isRecord(value) || value.version !== 1 || value.backend?.type !== "transcribe-cpp") {
    throw new Error(`Invalid pi-transcribe settings in ${source}`);
  }
  if (!isRecord(value.model) || typeof value.model.id !== "string" || typeof value.model.path !== "string") {
    throw new Error(`Missing model settings in ${source}`);
  }
  if (typeof value.transcriptionLanguage !== "string" || !value.transcriptionLanguage.trim()) {
    throw new Error(`Missing transcription language in ${source}`);
  }
  if (!isRecord(value.microphone)) {
    throw new Error(`Missing microphone settings in ${source}`);
  }

  let microphone;
  if (value.microphone.type === "system-default") {
    microphone = { type: "system-default" };
  } else if (
    value.microphone.type === "device" &&
    typeof value.microphone.name === "string" &&
    value.microphone.name &&
    Number.isInteger(value.microphone.occurrence) &&
    value.microphone.occurrence >= 0
  ) {
    microphone = {
      type: "device",
      name: value.microphone.name,
      occurrence: value.microphone.occurrence,
    };
  } else {
    throw new Error(`Invalid microphone settings in ${source}`);
  }

  return {
    model: { id: value.model.id, path: value.model.path },
    transcriptionLanguage: value.transcriptionLanguage,
    chineseOutput: CHINESE_OUTPUTS.has(value.chineseOutput) ? value.chineseOutput : "simplified",
    microphone,
  };
}

export function convertFrames(frames) {
  const length = frames.reduce((total, frame) => total + frame.length, 0);
  const pcm = new Float32Array(length);
  let offset = 0;
  for (const frame of frames) {
    for (let index = 0; index < frame.length; index += 1) {
      pcm[offset + index] = frame[index] / 32_768;
    }
    offset += frame.length;
  }
  return pcm;
}

function readSettings() {
  const path = join(getAgentDir(), "pi-transcribe.json");
  let settings;
  try {
    settings = parseSettings(JSON.parse(readFileSync(path, "utf8")), path);
  } catch (error) {
    throw new Error(`Could not load ${path}: ${errorMessage(error)}`);
  }
  if (!existsSync(settings.model.path)) {
    throw new Error(`Configured model file is missing: ${settings.model.path}`);
  }
  return settings;
}

function emit(type, values = {}) {
  process.stdout.write(`${JSON.stringify({ type, ...values })}\n`);
}

function isChineseLanguage(language) {
  const base = language.toLowerCase().split("-", 1)[0];
  return base === "zh" || base === "yue";
}

function microphoneIndex(PvRecorder, microphone) {
  if (microphone.type === "system-default") return -1;

  let occurrence = 0;
  for (const [index, name] of PvRecorder.getAvailableDevices().entries()) {
    if (name !== microphone.name) continue;
    if (occurrence === microphone.occurrence) return index;
    occurrence += 1;
  }
  throw new Error(`Selected microphone is unavailable: ${microphone.name}`);
}

function createFormatter(OpenCC, chineseOutput) {
  const converter = OpenCC.Converter({
    simplified: { from: "t", to: "cn" },
    "traditional-taiwan": { from: "cn", to: "tw" },
    "traditional-hong-kong": { from: "cn", to: "hk" },
  }[chineseOutput]);

  return (text, detectedLanguage, configuredLanguage) => {
    const trimmed = text.trim();
    return isChineseLanguage(detectedLanguage || configuredLanguage || "")
      ? converter(trimmed)
      : trimmed;
  };
}

async function loadRuntime() {
  const [recorder, transcribe, opencc] = await Promise.all([
    import("@picovoice/pvrecorder-node"),
    import("transcribe-cpp"),
    import("opencc-js"),
  ]);
  return {
    PvRecorder: recorder.PvRecorder,
    TranscribeModel: transcribe.TranscribeModel,
    OpenCC: opencc.default,
  };
}

class DictationDaemon {
  constructor(settings, runtime) {
    this.settings = settings;
    this.runtime = runtime;
    this.format = createFormatter(runtime.OpenCC, settings.chineseOutput);
    this.state = "idle";
    this.model = undefined;
    this.modelLoading = undefined;
    this.recorder = undefined;
    this.readLoop = undefined;
    this.frames = [];
    this.captureError = undefined;
    this.stopping = false;
  }

  async toggle() {
    if (this.state === "idle") {
      try {
        await this.startRecording();
      } catch (error) {
        this.state = "idle";
        emit("error", { message: errorMessage(error) });
      }
      return;
    }
    if (this.state !== "recording") {
      emit("busy");
      return;
    }

    this.state = "transcribing";
    emit("transcribing");
    try {
      const pcm = await this.finishCapture();
      if (pcm.length === 0) {
        emit("empty");
        return;
      }
      const model = await this.loadModel();
      const language = this.settings.transcriptionLanguage === "auto"
        ? undefined
        : this.settings.transcriptionLanguage;
      if (language && !model.capabilities.languages.includes(language)) {
        throw new Error(`Configured language ${language} is not supported by this model`);
      }
      const result = await model.transcribe(pcm, {
        timestamps: "none",
        ...(language ? { language } : {}),
      });
      const text = this.format(result.text, result.language, language);
      emit(text ? "transcript" : "empty", text ? { text } : {});
    } catch (error) {
      emit("error", { message: errorMessage(error) });
    } finally {
      this.state = "idle";
    }
  }

  async shutdown() {
    if (this.recorder) await this.finishCapture().catch(() => undefined);
    await this.modelLoading?.catch(() => undefined);
    this.model?.dispose();
    this.model = undefined;
  }

  async loadModel() {
    if (this.model) return this.model;
    if (!this.modelLoading) {
      this.modelLoading = this.runtime.TranscribeModel.load(this.settings.model.path).then((model) => {
        this.model = model;
        return model;
      });
    }
    try {
      return await this.modelLoading;
    } catch (error) {
      this.modelLoading = undefined;
      throw error;
    }
  }

  async startRecording() {
    const recorder = new this.runtime.PvRecorder(
      FRAME_LENGTH,
      microphoneIndex(this.runtime.PvRecorder, this.settings.microphone),
    );
    if (recorder.sampleRate !== SAMPLE_RATE) {
      recorder.release();
      throw new Error(`Recorder returned ${recorder.sampleRate} Hz; expected ${SAMPLE_RATE} Hz`);
    }

    this.frames = [];
    this.captureError = undefined;
    this.stopping = false;
    try {
      recorder.start();
      this.recorder = recorder;
      this.readLoop = this.readFrames(recorder);
      this.state = "recording";
      void this.loadModel().catch(() => undefined);
      emit("recording");
    } catch (error) {
      recorder.release();
      throw error;
    }
  }

  async readFrames(recorder) {
    try {
      while (!this.stopping && recorder.isRecording) {
        const frame = await recorder.read();
        if (!this.stopping) this.frames.push(frame);
      }
    } catch (error) {
      if (!this.stopping) this.captureError = error;
    }
  }

  async finishCapture() {
    const recorder = this.recorder;
    if (!recorder) throw new Error("Microphone capture is not active");

    this.stopping = true;
    let stopError;
    try {
      if (recorder.isRecording) recorder.stop();
    } catch (error) {
      stopError = error;
    }
    try {
      await this.readLoop;
    } finally {
      recorder.release();
      if (this.recorder === recorder) this.recorder = undefined;
      this.readLoop = undefined;
    }
    if (stopError) throw stopError;
    if (this.captureError) throw this.captureError;

    const pcm = convertFrames(this.frames);
    this.frames = [];
    return pcm;
  }
}

async function main() {
  if (process.platform !== "win32") throw new Error("Windows dictation is only supported on Windows");

  const daemon = new DictationDaemon(readSettings(), await loadRuntime());
  const input = createInterface({ input: process.stdin });
  let queue = Promise.resolve();
  let toggleQueued = false;
  let shuttingDown = false;

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await daemon.shutdown();
    emit("stopped");
    input.close();
  };
  const enqueue = (task) => {
    queue = queue.then(task, task).catch((error) => emit("error", { message: errorMessage(error) }));
  };

  input.on("line", (line) => {
    switch (line.trim()) {
      case "toggle":
        if (toggleQueued || daemon.state === "transcribing") {
          emit("busy");
          break;
        }
        toggleQueued = true;
        enqueue(async () => {
          try {
            await daemon.toggle();
          } finally {
            toggleQueued = false;
          }
        });
        break;
      case "shutdown":
        enqueue(shutdown);
        break;
      default:
        emit("error", { message: `Unknown command: ${line.trim()}` });
    }
  });
  input.on("close", () => {
    if (!shuttingDown) enqueue(shutdown);
  });
  process.once("SIGINT", () => enqueue(shutdown));
  process.once("SIGTERM", () => enqueue(shutdown));
  process.stdout.once("error", () => process.exit(0));

  emit("ready", { model: daemon.settings.model.id });
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    emit("error", { message: errorMessage(error) });
    process.exitCode = 1;
  });
}
