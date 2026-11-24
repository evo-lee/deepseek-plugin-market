import assert from "node:assert/strict";
import test from "node:test";

import { detectLanguage, detectMode, sampleAllows, shouldSkip } from "../scripts/lib/detect.mjs";

test("plain English is corrected", () => {
  assert.equal(detectLanguage("Please review the README carefully.").mode, "correct");
});

test("Chinese is translated even when the prompt contains lots of code", () => {
  const result = detectLanguage("把 `src/app.js` 里的这个函数改一下，别吞异常");
  assert.equal(result.mode, "translate");
  assert.ok(result.cjk >= 2);
});

test("slash commands, shell commands, URLs and code are skipped", () => {
  for (const prompt of ["/help me", "$my-skill do this", "!npm test", "https://example.com/a/b", "```js\nx\n```"]) {
    assert.equal(shouldSkip(prompt), true, prompt);
  }
  assert.equal(shouldSkip("Please explain this function to me."), false);
});

test(":: is refine and ;; is escape", () => {
  assert.equal(detectMode(":: make this better").mode, "refine");
  assert.equal(detectMode(":: make this better").text, "make this better");
  assert.equal(detectMode(";; 这行保持中文").mode, "escape");
  assert.equal(detectMode(";; 这行保持中文").text, "这行保持中文");
});

test("too-long prompts are skipped with a stable reason", () => {
  const result = detectMode("a".repeat(200), { maxInputChars: 100 });
  assert.equal(result.mode, "skip");
  assert.equal(result.reason, "too-long");
});

test("sampleAllows is stable and respects the bounds", () => {
  assert.equal(sampleAllows("hello", 1), true);
  assert.equal(sampleAllows("hello", 0), false);
  const first = sampleAllows("same prompt", 0.5);
  const second = sampleAllows("same prompt", 0.5);
  assert.equal(first, second);
});
