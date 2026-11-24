// Prompt classification: refine (::), escape (;;), skip (commands/code), or
// coach (correct English / translate non-English).
//
// The upstream ASCII-ratio heuristic misread Chinese prompts that contain a lot
// of code. Any run of CJK characters now decides the language before the ratio
// is considered.

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/;

const SKIP_PREFIXES = [
  /^\//, // Claude Code slash command
  /^\$/, // Codex-style skill invocation
  /^!/, // shell command
  /^@/, // file mention
  /^```/,
  /^~~~/,
  /^(?:https?:|git@|ssh:\/\/)/i,
  /^(?:\{|\[|\()/,
  /^(?:npm|pnpm|yarn|pip|pip3|cargo|brew|sudo|cd|ls|cat|grep|rg|find|docker|kubectl|git)\s/i,
];

export function countCjk(text) {
  let count = 0;
  for (const char of text) if (CJK.test(char)) count += 1;
  return count;
}

export function detectLanguage(text) {
  if (!text || text.trim() === "") return { language: "unknown", mode: "skip", ratio: 0, cjk: 0 };

  const chars = [...text];
  let ascii = 0;
  for (const char of chars) {
    const code = char.codePointAt(0);
    if (code >= 0x20 && code <= 0x7e) ascii += 1;
  }
  const ratio = chars.length > 0 ? Math.round((ascii / chars.length) * 100) : 0;
  const cjk = countCjk(text);

  if (cjk >= 2) return { language: "non-english", mode: "translate", ratio, cjk };
  if (ratio >= 85) return { language: "english", mode: "correct", ratio, cjk };
  return { language: "non-english", mode: "translate", ratio, cjk };
}

export function shouldSkip(prompt, { maxInputChars = 8000 } = {}) {
  if (!prompt || prompt.trim() === "") return true;
  if (SKIP_PREFIXES.some((pattern) => pattern.test(prompt))) return true;

  const charCount = [...prompt].length;
  const wordCount = prompt.trim().split(/\s+/).filter(Boolean).length;
  if (charCount < 10 && wordCount < 3) return true;
  if (charCount > maxInputChars) return true;
  return false;
}

/**
 * @returns {{mode: "refine"|"escape"|"skip"|"correct"|"translate", text: string, reason?: string, language?: string, ratio?: number, cjk?: number}}
 */
export function detectMode(prompt, options = {}) {
  const escapePrefix = typeof options.escapePrefix === "string" && options.escapePrefix !== "" ? options.escapePrefix : ";;";

  if (prompt.startsWith("::")) {
    return { mode: "refine", text: prompt.slice(2).trimStart(), reason: "refine-prefix" };
  }
  if (prompt.startsWith(escapePrefix)) {
    return { mode: "escape", text: prompt.slice(escapePrefix.length).trimStart(), reason: "escape-prefix" };
  }
  if (shouldSkip(prompt, options)) {
    const tooLong = [...prompt].length > (options.maxInputChars ?? 8000);
    return { mode: "skip", text: prompt, reason: tooLong ? "too-long" : "filtered" };
  }

  const detection = detectLanguage(prompt);
  return { mode: detection.mode, text: prompt, ...detection };
}

export function sampleAllows(prompt, rate) {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  // A stable hash keeps a given prompt consistently in or out of the sample.
  let hash = 2166136261;
  for (const char of prompt) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 2 ** 32 < rate;
}
