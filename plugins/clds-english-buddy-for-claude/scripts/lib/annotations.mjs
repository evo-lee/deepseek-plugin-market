// Parse correction annotations from model output.
//
// DeepSeek follows the requested "wrong → right (category)" format well, but
// it sometimes adds bullets, numbering, a "Corrected:" prefix, or wraps the
// whole answer in a code fence. The parser accepts those variants, and it
// suppresses no-op pairs so a cosmetic echo never becomes a "correction".

const ARROW = " → ";

export function parseAnnotations(annotations) {
  if (!annotations || typeof annotations !== "string") return [];
  const trimmed = annotations.trim();
  if (!trimmed) return [];

  // Legacy storage from upstream 0.x: "(a>b; c>d)". Keep old history readable.
  if (/^\(.*\)$/.test(trimmed) && trimmed.includes(">")) return parseLegacy(trimmed);

  const out = [];
  const seen = new Set();
  for (const rawLine of trimmed.split(/\r?\n/)) {
    let line = rawLine
      .replace(/^\s*(?:[-*•·]|\d+[.)])\s*/, "")
      .replace(/^\s*`+|`+\s*$/g, "")
      .trim();
    if (!line) continue;
    // A model may put several pairs on one line separated by semicolons.
    const arrowCount = (line.match(/→|⟶|➜|➡|=>|->/g) || []).length;
    const pieces = arrowCount > 1 && line.includes(";") ? line.split(/\s*;\s*/) : [line];
    for (const piece of pieces) {
      const parsed = parseAnnotationLine(piece);
      if (!parsed) continue;
      const key = `${parsed.original.toLowerCase()}\u0000${parsed.corrected.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(parsed);
    }
  }
  return out;
}

function parseLegacy(text) {
  const inner = text.replace(/^\(/, "").replace(/\)$/, "");
  const out = [];
  for (const raw of inner.split(";")) {
    const fix = raw.trim();
    const index = fix.indexOf(">");
    if (index === -1) continue;
    const original = fix.slice(0, index).trim();
    const corrected = fix.slice(index + 1).trim();
    if (!original || !corrected || original === corrected) continue;
    out.push({ original, corrected, category: null });
  }
  return out;
}

export function parseAnnotationLine(line) {
  if (!line || typeof line !== "string") return null;
  let text = line
    .replace(/^\s*(?:[-*•·]|\d+[.)])\s*/, "")
    .replace(/^\s*`+|`+\s*$/g, "")
    .trim();
  if (!text) return null;

  const match = text.match(/^(.+?)\s*(?:→|⟶|➜|➡|=>|->)\s*(.+?)\s*(?:\(([^()]{0,60})\)|\[([^\[\]]{0,60})\])?\s*$/);
  if (!match) return null;

  const strip = (value) => value
    .replace(/^\s*`+|`+\s*$/g, "")
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .trim();
  const original = strip(match[1]);
  const corrected = strip(match[2]);
  const category = (match[3] || match[4] || "").trim() || null;

  if (!original || !corrected) return null;
  if (original === corrected) return null;
  if (original.length > 200 || corrected.length > 200) return null;
  if (/^(?:clean|no errors?|none)$/i.test(original)) return null;
  return { original, corrected, category };
}

// Storage keeps one normalized pair per line, without display bullets.
export function formatAnnotationsForStorage(items) {
  return items
    .map(({ original, corrected, category }) => `${original}${ARROW}${corrected}${category ? ` (${category})` : ""}`)
    .join("\n");
}

// Display adds bullets; bullets are never stored in JSONL.
export function formatAnnotationsForDisplay(items, { indent = "  " } = {}) {
  return items
    .map(({ original, corrected, category }) => `${indent}• ${original}${ARROW}${corrected}${category ? `   (${category})` : ""}`)
    .join("\n");
}

export function isCleanText(text) {
  if (!text) return false;
  const first = text
    .replace(/^\s*```[a-z]*\s*/i, "")
    .split(/\r?\n/)[0]
    .replace(/`/g, "")
    .replace(/[.!。！]+$/g, "")
    .trim();
  return /^(?:clean|no errors?|no corrections?|no changes?|looks good)$/i.test(first);
}

export function stripCodeFence(text) {
  if (!text) return "";
  const trimmed = text.trim();
  const match = trimmed.match(/^```[a-z0-9_-]*\s*\n?([\s\S]*?)\n?```$/i);
  return match ? match[1].trim() : trimmed;
}
