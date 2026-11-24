// Prompt construction, output parsing, and the mechanical literal guard.
//
// The guard is deliberately conservative: if the model rewrites a backticked
// token, a path, a URL, a number, a flag, or a code identifier, the coaching
// result is discarded and the original prompt is left untouched. It cannot
// prove semantic equivalence; it only catches the most common destructive
// rewrite.

import {
  isCleanText,
  parseAnnotations,
  stripCodeFence,
} from "./annotations.mjs";

const OUTPUT_CONTRACT = `Output format (strict):
- If the prompt has NO errors, output exactly: CLEAN
- Otherwise output exactly these sections, in this order:
CORRECTED:
<the corrected prompt, preserving its line breaks>
ANNOTATIONS:
wrong → right (short category)
wrong → right (short category)

Do not add bullets, numbering, quotes, commentary, or code fences. Do not repeat the corrected prompt in the annotation section. If a change is not tied to a real error, do not make it.`;

function strictnessRule(strictness) {
  switch (strictness) {
    case "gentle":
      return "Only fix clear errors. Accept informal register and phrasing that is already understandable. Do not suggest stylistic alternatives.";
    case "strict":
      return "Fix errors and clearly awkward phrasing, and suggest a more natural wording only where the original is genuinely unnatural. Still do not restructure the request.";
    default:
      return "Fix errors and clearly awkward phrasing. Do not rewrite correct sentences merely because a different wording is possible.";
  }
}

export function buildCorrectSystem(config = {}) {
  const domain = Array.isArray(config.domain_terms) && config.domain_terms.length > 0
    ? `\nAlways preserve these domain terms exactly: ${config.domain_terms.join(", ")}`
    : "";
  return `You are an English language coach for a non-native speaker who uses AI coding tools daily.
The message will be read by an AI assistant that understands it even when it contains errors. Your job is to help the USER improve by showing the smallest real corrections.

Rules:
- Fix spelling, grammar, punctuation, agreement, articles, prepositions, and word choice.
- Keep technical terms, code references, file paths, tool names, commands, flags, and numbers exactly as written.
- Preserve the user's intent, structure, line breaks, and level of detail.
- ${strictnessRule(config.strictness)}
- Surface at most 3 corrections, choosing the ones most worth learning.
- Never emit a pair whose two sides are identical after trimming.
- Show the smallest token that changed, not the whole surrounding phrase.
- If the message is already correct, output CLEAN.${domain}

${OUTPUT_CONTRACT}`;
}

export function buildTranslateSystem(config = {}) {
  const domain = Array.isArray(config.domain_terms) && config.domain_terms.length > 0
    ? `\nAlways preserve these domain terms exactly: ${config.domain_terms.join(", ")}`
    : "";
  return `You are a translator for a developer who uses AI coding tools in English.
Translate the message into natural, idiomatic English.

Rules:
- Keep ALL technical terms, code references, file paths, commands, flags, and numbers unchanged.
- Preserve the user's intent, structure, and level of detail.
- Use imperative voice where the original is an instruction.
- Do not answer the request; translate it.
- Output exactly two lines:
  Line 1: the English translation
  Line 2: the detected source language in parentheses, for example (Chinese)
- Output no commentary, labels, or code fences.${domain}`;
}

export function buildRefineSystem(config = {}) {
  const domain = Array.isArray(config.domain_terms) && config.domain_terms.length > 0
    ? `\nAlways preserve these domain terms exactly: ${config.domain_terms.join(", ")}`
    : "";
  return `You are a prompt engineer. Rewrite the user's rough idea into a precise, effective prompt for an AI coding assistant.

Rules:
- Use imperative voice.
- Be specific and actionable.
- Add structure (numbered steps or categories) when the task is complex.
- Expand vague requests into concrete instructions, but preserve every named file, command, constraint, and number.
- Translate non-English text to English.
- Output ONLY the refined prompt. No preamble, no commentary, no code fences.${domain}`;
}

export function buildReviewSystem(config = {}) {
  const domain = Array.isArray(config.domain_terms) && config.domain_terms.length > 0
    ? `\nPreserve these domain terms exactly: ${config.domain_terms.join(", ")}`
    : "";
  return `You are a careful English writing reviewer for a non-native developer. Review the supplied text for grammar, punctuation, clarity, tone, structure, and technical accuracy.

Return Markdown with exactly these sections:

# English Review

**Overall quality**: Excellent / Good / Needs Work / Poor
**Error count**: N

## Corrected Version

<the full corrected text>

## Changes Made

| # | Original | Corrected | Category | Explanation |
|---|----------|-----------|----------|-------------|

## Style Suggestions

<optional, clearly non-error improvements; omit the section when there are none>

## Summary

<2-3 sentences: what is good, what needs work, one actionable tip>

Rules:
- Fix errors; do not rewrite correct prose for taste.
- Preserve code, paths, identifiers, commands, numbers, and the author's voice.
- Never put a row in Changes Made where Original and Corrected are identical; that is not a change.
- Surface at most three lessons in the Summary.
- If the text has no errors, say so; do not invent findings.${domain}`;
}

export function buildSummaryContext(summaryLanguage) {
  if (!summaryLanguage) return "";
  return `After your response, add a brief summary in ${summaryLanguage} under a --- separator. Summarize the key points, actions taken, and decisions made. Keep it concise (2-5 sentences). Label it: **${summaryLanguage} Summary**`;
}

/**
 * Parse the correction/translation output contract, with a legacy fallback for
 * the upstream "corrected prompt on line 1, annotations after a blank line"
 * format.
 */
export function parseCoachingOutput(raw) {
  const text = stripCodeFence(raw).trim();
  if (text === "") return { kind: "error", failureCode: "empty-output", message: "The coaching model returned no text." };
  if (isCleanText(text)) return { kind: "clean" };

  const lines = text.split(/\r?\n/);
  const correctedIndex = lines.findIndex((line) => /^CORRECTED\s*:?/i.test(line.trim()));
  const annotationIndex = lines.findIndex((line) => /^ANNOTATIONS\s*:?/i.test(line.trim()));

  let corrected = "";
  let annotationText = "";

  if (correctedIndex !== -1) {
    const first = lines[correctedIndex].replace(/^CORRECTED\s*:\s*/i, "");
    const end = annotationIndex > correctedIndex ? annotationIndex : lines.length;
    corrected = [first, ...lines.slice(correctedIndex + 1, end)].join("\n").trim();
  }
  if (annotationIndex !== -1) {
    const first = lines[annotationIndex].replace(/^ANNOTATIONS\s*:\s*/i, "");
    annotationText = [first, ...lines.slice(annotationIndex + 1)].join("\n").trim();
  }

  if (!corrected) {
    // Legacy: corrected prompt in the first paragraph, annotations after the
    // first blank line. If the later paragraphs contain no arrow pairs, treat
    // the whole answer as the corrected prompt so multi-paragraph corrections
    // are not truncated.
    const blocks = text.split(/\n\s*\n/);
    const rest = blocks.slice(1).join("\n\n").trim();
    const restHasAnnotations = rest.split(/\r?\n/).some((line) => /(?:→|⟶|➜|➡|=>|->)/.test(line));
    if (rest && restHasAnnotations) {
      corrected = (blocks[0] || "").trim();
      annotationText = rest;
    } else {
      corrected = text.trim();
      annotationText = "";
    }
  }

  corrected = corrected
    .replace(/^(?:corrected(?:\s+(?:prompt|version))?|revised|rewritten)\s*[:：]\s*/i, "")
    .trim();

  return {
    kind: "correction",
    corrected,
    annotations: parseAnnotations(annotationText),
    annotationText,
  };
}

/**
 * Translation output is two lines: translation, then "(Language)".
 */
export function parseTranslationOutput(raw) {
  const text = stripCodeFence(raw).trim();
  if (text === "") return { kind: "error", failureCode: "empty-output", message: "The translation model returned no text." };

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let translated = "";
  let sourceLanguage = "";

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const languageMatch = line.match(/^\(([^)]{1,40})\)$/);
    if (languageMatch && index > 0) {
      sourceLanguage = languageMatch[1].trim();
      continue;
    }
    if (translated === "") {
      translated = line.replace(/^(?:translation|english|translated)\s*[:：]\s*/i, "").trim();
    }
  }
  if (!translated) {
    return { kind: "error", failureCode: "unparsable-output", message: "The translation output could not be parsed." };
  }
  return { kind: "translation", translated, sourceLanguage };
}

export function buildReviewUser(text) {
  return `Review this text:\n\n<<<TEXT\n${text}\nTEXT>>>`;
}

/**
 * Extract tokens that must survive a rewrite. The list is intentionally
 * narrow: false positives here would reject legitimate corrections.
 */
export function extractLiterals(text) {
  if (!text) return [];
  const out = new Set();
  const add = (value) => {
    const trimmed = String(value ?? "").trim();
    if (trimmed) out.add(trimmed);
  };

  for (const match of text.matchAll(/```[a-z0-9_-]*\n?[\s\S]*?\n?```/gi)) add(match[0].replace(/^```[a-z0-9_-]*\n?|```$/gi, ""));
  for (const match of text.matchAll(/`[^`\n]+`/g)) add(match[0].replace(/^`|`$/g, ""));
  for (const match of text.matchAll(/\bhttps?:\/\/[^\s)>\]}]+/g)) add(match[0].replace(/[.,;:]+$/, ""));
  for (const match of text.matchAll(/(?:^|\s)(--?[A-Za-z][\w-]*)/g)) add(match[1]);
  for (const match of text.matchAll(/\b(?:\.{0,2}\/)?(?:[\w.@-]+\/)+[\w.@-]+\b/g)) add(match[0]);
  for (const match of text.matchAll(/\b[\w.-]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|md|py|rb|go|rs|java|kt|swift|sh|bash|zsh|yml|yaml|toml|ini|env|html|css|scss|sql|lock|txt|csv)\b/g)) add(match[0]);
  for (const match of text.matchAll(/\b(?:[a-z]+[A-Z][A-Za-z0-9]*|[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+|[A-Za-z_][A-Za-z0-9_]*\(\))\b/g)) add(match[0]);
  for (const match of text.matchAll(/\b\d+(?:\.\d+)?(?:\s*(?:ms|milliseconds|seconds|minutes|hours|px|rem|em|%|KB|MB|GB|TB))?\b/gi)) add(match[0]);

  // "src/app.js" and "app.js" are the same requirement; keep the longer path
  // so a failure list names the specific file once.
  const values = [...out].sort((a, b) => b.length - a.length);
  const filtered = [];
  for (const value of values) {
    if (filtered.some((longer) => longer !== value && longer.endsWith(`/${value}`))) continue;
    filtered.push(value);
  }
  return filtered;
}

export function preservesLiterals(original, rewritten) {
  const missing = extractLiterals(original).filter((literal) => !rewritten.includes(literal));
  return { ok: missing.length === 0, missing };
}

/**
 * Turn raw model output into a decision the hook can act on.
 */
export function evaluateOutput(mode, raw, original, config = {}) {
  if (mode === "translate") {
    const parsed = parseTranslationOutput(raw);
    if (parsed.kind === "error") return parsed;
    if (parsed.translated.trim() === original.trim()) {
      return { kind: "clean", reason: "translation-unchanged" };
    }
    const guard = preservesLiterals(original, parsed.translated);
    if (!guard.ok) return { kind: "rejected", failureCode: "literal-changed", message: `Translation changed a literal: ${guard.missing.slice(0, 3).join(", ")}`, ...parsed };
    return { kind: "translation", ...parsed };
  }

  if (mode === "refine") {
    const parsed = parseCoachingOutput(raw);
    if (parsed.kind === "error") return parsed;
    if (parsed.kind === "clean") return { kind: "error", failureCode: "empty-output", message: "The refinement was empty." };
    const corrected = parsed.corrected;
    if (!corrected) return { kind: "error", failureCode: "unparsable-output", message: "The refined prompt could not be parsed." };
    const guard = preservesLiterals(original, corrected);
    if (!guard.ok) return { kind: "rejected", failureCode: "literal-changed", message: `Refinement changed a literal: ${guard.missing.slice(0, 3).join(", ")}` };
    return { kind: "refinement", corrected };
  }

  const parsed = parseCoachingOutput(raw);
  if (parsed.kind === "error" || parsed.kind === "clean") return parsed;
  const corrected = parsed.corrected;
  if (!corrected) return { kind: "error", failureCode: "unparsable-output", message: "The corrected prompt could not be parsed." };
  if (corrected === original.trim()) return { kind: "clean", reason: "no-change" };
  const guard = preservesLiterals(original, corrected);
  if (!guard.ok) return { kind: "rejected", failureCode: "literal-changed", message: `Correction changed a literal: ${guard.missing.slice(0, 3).join(", ")}` };
  return { kind: "correction", corrected, annotations: parsed.annotations };
}
