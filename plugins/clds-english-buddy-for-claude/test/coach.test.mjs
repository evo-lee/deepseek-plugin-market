import assert from "node:assert/strict";
import test from "node:test";

import {
  formatAnnotationsForDisplay,
  formatAnnotationsForStorage,
  isCleanText,
  parseAnnotations,
} from "../scripts/lib/annotations.mjs";
import {
  evaluateOutput,
  extractLiterals,
  parseCoachingOutput,
  parseTranslationOutput,
  preservesLiterals,
} from "../scripts/lib/coach.mjs";

test("arrow annotations parse across variants and suppress no-ops", () => {
  const items = parseAnnotations([
    "- autentication → authentication (spelling)",
    "2. its -> it's (apostrophe)",
    "* modul => module",
    "same → same (spelling)",
    "not an annotation",
  ].join("\n"));
  assert.deepEqual(items, [
    { original: "autentication", corrected: "authentication", category: "spelling" },
    { original: "its", corrected: "it's", category: "apostrophe" },
    { original: "modul", corrected: "module", category: null },
  ]);
  assert.equal(formatAnnotationsForStorage(items).split("\n").length, 3);
  assert.match(formatAnnotationsForDisplay(items), /• autentication → authentication/);
});

test("legacy parenthesized annotations stay readable", () => {
  assert.deepEqual(parseAnnotations("(autentication>authentication; its>it's)"), [
    { original: "autentication", corrected: "authentication", category: null },
    { original: "its", corrected: "it's", category: null },
  ]);
});

test("clean detection is strict but tolerant", () => {
  assert.equal(isCleanText("CLEAN"), true);
  assert.equal(isCleanText("clean."), true);
  assert.equal(isCleanText("No errors."), true);
  assert.equal(isCleanText("Clean up the parser."), false);
});

test("CORRECTED/ANNOTATIONS contract parses multi-line corrections", () => {
  const raw = `CORRECTED:
Fix the parser.
Keep the API stable.
ANNOTATIONS:
parser → the parser (article)
`;
  const parsed = parseCoachingOutput(raw);
  assert.equal(parsed.kind, "correction");
  assert.equal(parsed.corrected, "Fix the parser.\nKeep the API stable.");
  assert.deepEqual(parsed.annotations, [{ original: "parser", corrected: "the parser", category: "article" }]);
});

test("legacy first-line format still parses", () => {
  const raw = "Fix the authentication module.\n\nautentication → authentication (spelling)\nmodul → module (spelling)";
  const parsed = parseCoachingOutput(raw);
  assert.equal(parsed.corrected, "Fix the authentication module.");
  assert.equal(parsed.annotations.length, 2);
});

test("multi-paragraph corrections are not truncated when no annotations follow", () => {
  const parsed = parseCoachingOutput("First paragraph.\n\nSecond paragraph.");
  assert.equal(parsed.corrected, "First paragraph.\n\nSecond paragraph.");
  assert.deepEqual(parsed.annotations, []);
});

test("code fences and labels are stripped", () => {
  const raw = "```\nCORRECTED:\nFix it.\nANNOTATIONS:\nits → it's (apostrophe)\n```";
  const parsed = parseCoachingOutput(raw);
  assert.equal(parsed.corrected, "Fix it.");
  assert.equal(parsed.annotations.length, 1);
});

test("translation parses two lines and a language tag", () => {
  assert.deepEqual(parseTranslationOutput("Fix the error handling.\n(Chinese)"), {
    kind: "translation",
    translated: "Fix the error handling.",
    sourceLanguage: "Chinese",
  });
  assert.equal(parseTranslationOutput("Translation: Fix it.\n(Japanese)").translated, "Fix it.");
});

test("literal guard protects code, paths, URLs, flags and numbers", () => {
  const original = "Update `src/app.js` and run --strict with 3 tests at https://example.com/x";
  const literals = extractLiterals(original);
  assert.ok(literals.includes("src/app.js"));
  assert.ok(literals.includes("--strict"));
  assert.ok(literals.includes("3"));
  assert.ok(literals.includes("https://example.com/x"));
  assert.equal(preservesLiterals(original, "Update `src/app.js` and run --strict with 3 tests at https://example.com/x").ok, true);
  const changed = preservesLiterals(original, "Update `src/main.js` and run --strict with 3 tests at https://example.com/x");
  assert.equal(changed.ok, false);
  assert.deepEqual(changed.missing, ["src/app.js"]);
});

test("evaluateOutput returns correction, clean, and literal rejection", () => {
  const config = { strictness: "standard", domain_terms: [] };
  const correction = evaluateOutput(
    "correct",
    "CORRECTED:\nrefactor the authentication module\nANNOTATIONS:\nautentication → authentication (spelling)",
    "refactor the autentication modul",
    config,
  );
  assert.equal(correction.kind, "correction");
  assert.equal(correction.corrected, "refactor the authentication module");
  assert.equal(correction.annotations.length, 1);

  assert.equal(evaluateOutput("correct", "CLEAN", "This is fine.", config).kind, "clean");
  assert.equal(evaluateOutput("correct", "CORRECTED:\nFix it.\nANNOTATIONS:\n", "This is fine.", config).kind, "correction");
  assert.equal(evaluateOutput("correct", "CORRECTED:\nUse `src/main.js`.\nANNOTATIONS:\nsrc/app.js → src/main.js (path)", "Use `src/app.js`.", config).kind, "rejected");
});
