import assert from "node:assert/strict";
import test from "node:test";
import { convertFrames, getAgentDir, parseSettings } from "../windows/dictation-daemon.mjs";

const settings = {
  version: 1,
  backend: { type: "transcribe-cpp" },
  transcriptionLanguage: "auto",
  chineseOutput: "simplified",
  microphone: { type: "system-default" },
  model: { id: "Qwen3-ASR-0.6B", path: "C:\\models\\qwen.gguf" },
};

test("Windows dictation reuses valid pi-transcribe settings", () => {
  assert.deepEqual(parseSettings(settings), {
    model: { id: "Qwen3-ASR-0.6B", path: "C:\\models\\qwen.gguf" },
    transcriptionLanguage: "auto",
    chineseOutput: "simplified",
    microphone: { type: "system-default" },
  });
});

test("Windows dictation refuses incomplete pi-transcribe settings", () => {
  assert.throws(
    () => parseSettings({ ...settings, model: { id: "Qwen3-ASR-0.6B" } }),
    /Missing model settings/,
  );
});

test("Windows dictation uses the configured Agent Home and converts recorder frames", () => {
  assert.equal(getAgentDir({ PI_CODING_AGENT_DIR: "C:\\agent" }, "C:\\home"), "C:\\agent");
  assert.deepEqual([...convertFrames([Int16Array.of(-32_768, 0), Int16Array.of(16_384)])], [-1, 0, 0.5]);
});
