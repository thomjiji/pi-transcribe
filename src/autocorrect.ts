import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HAS_HAN = /\p{Script=Han}/u;
const AUTOCORRECT_TIMEOUT_MS = 15_000;

type TextFormatter = (text: string) => Promise<string>;

function autocorrectExecutable(): string | undefined {
  const configured = process.env.PI_TRANSCRIBE_AUTOCORRECT_PATH?.trim();
  if (configured) return configured;

  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  const executable = join(agentDir, "bin", process.platform === "win32" ? "autocorrect.exe" : "autocorrect");
  return existsSync(executable) ? executable : undefined;
}

async function runAutocorrect(executable: string, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["--stdin", "--type", "txt", "--no-diff-bg-color"], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const output: Buffer[] = [];
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, AUTOCORRECT_TIMEOUT_MS);

    child.stdout!.on("data", (chunk: Buffer) => output.push(chunk));
    child.stdin!.once("error", reject);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error("autocorrect timed out"));
        return;
      }
      if (code !== 0) {
        reject(new Error(`autocorrect exited with code ${code ?? "unknown"}`));
        return;
      }
      resolve(Buffer.concat(output).toString("utf8"));
    });
    child.stdin!.end(text);
  });
}

async function runConfiguredAutocorrect(text: string): Promise<string> {
  const executable = autocorrectExecutable();
  return executable ? runAutocorrect(executable, text) : text;
}

/** Format final CJK transcripts without allowing formatter failures to lose speech. */
export async function autocorrectCjkText(
  text: string,
  format: TextFormatter = runConfiguredAutocorrect,
): Promise<string> {
  if (!HAS_HAN.test(text)) return text;
  try {
    return (await format(text)).trim() || text;
  } catch {
    return text;
  }
}
