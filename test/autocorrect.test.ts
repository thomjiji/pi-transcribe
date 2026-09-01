import assert from "node:assert/strict";
import test from "node:test";
import { autocorrectCjkText } from "../src/autocorrect.js";

test("autocorrect formats final CJK text and removes its trailing newline", async () => {
  let input = "";
  const output = await autocorrectCjkText("这是GPT-5.6和Windows 11。", async (text) => {
    input = text;
    return "这是 GPT-5.6 和 Windows 11。\n";
  });

  assert.equal(input, "这是GPT-5.6和Windows 11。");
  assert.equal(output, "这是 GPT-5.6 和 Windows 11。");
});

test("autocorrect skips text without Han characters", async () => {
  let called = false;
  const output = await autocorrectCjkText("GPT-5.6 and Windows 11", async () => {
    called = true;
    return "unexpected";
  });

  assert.equal(called, false);
  assert.equal(output, "GPT-5.6 and Windows 11");
});

test("autocorrect failure preserves the transcript", async () => {
  const text = "这是GPT-5.6。";
  assert.equal(
    await autocorrectCjkText(text, async () => {
      throw new Error("formatter unavailable");
    }),
    text,
  );
});
