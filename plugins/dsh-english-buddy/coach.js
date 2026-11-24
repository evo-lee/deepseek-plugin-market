/**
 * Pure coaching logic for `dsh-english-buddy`: no IO, no Cordis, no globals.
 *
 * Mode detection, prompt construction, output parsing, the literal guard, and
 * the message rewrite are all here so they can be tested without a Host.
 *
 * The coaching rules and the annotation vocabulary are adapted from the
 * `xiaolai/english-buddy-for-claude` project (ISC licensed), specifically
 * `.claude/rules/01-voice-preservation.md`, `02-minimal-invasiveness.md`,
 * `03-no-over-polishing.md`, and the `SYSTEM_CORRECT` / `SYSTEM_TRANSLATE` /
 * `SYSTEM_REFINE` instructions in `scripts/prompt-coach-hook.mjs`. The
 * implementation is rewritten for DeepSeek Harness.
 */

/** Sentinel that separates the rewritten prompt from machine-readable notes. */
export const SENTINEL = '---english-buddy---'

/** ASCII-printable ratio at or above which text counts as English. */
const ENGLISH_RATIO = 85

/** Corrections kept per prompt; the upstream "three-lesson cap". */
const MAX_NOTES = 3

/** Expressiveness hints kept per prompt; display only, never injected. */
const MAX_HINTS = 2

/** Skip rules ported from the upstream `shouldSkip()`. */
const SKIP_PREFIX = /^(?:https?:|git@|ssh:\/\/|\{|\[|\(|npm |pip |cargo |brew |sudo |cd |ls |cat |grep |find |docker |kubectl )/i

/** Categories the correction prompt is allowed to use. */
const CATEGORIES = [
  'missing article',
  'acronym capitalization',
  'verb tense',
  'word choice',
  'spelling',
  'apostrophe',
  'preposition',
  'punctuation',
  'capitalization',
  'agreement',
]

/** Default plugin-row configuration. */
export const DEFAULT_CONFIG = Object.freeze({
  mode: 'automatic',
  authoritative: 'rewrite',
  strictness: 'standard',
  translate: 'auto',
  escapePrefix: ';;',
  provider: null,
  model: 'deepseek-flash',
  timeoutMs: 4000,
  maxInputChars: 4000,
  maxOutputTokens: 1600,
  sampleRate: 1,
  domainTerms: [],
  retentionDays: 120,
  hints: true,
})

const MODES = ['automatic', 'off', 'onDemand']
const AUTHORITATIVE = ['rewrite', 'original']
const STRICTNESS = ['gentle', 'standard', 'strict']
const TRANSLATE = ['auto', 'off']

/**
 * Validate a raw plugin-row config and fill defaults.
 *
 * Invalid values throw rather than silently degrading, matching the way other
 * Harness plugins fail their row on bad configuration; the message names the
 * key so the fix is obvious in the loader log.
 *
 * @param raw - the `config` value from `cordis.patch.yml`, or undefined.
 * @returns a frozen, fully populated configuration.
 */
export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const config = { ...DEFAULT_CONFIG }

  if (input.mode !== undefined) {
    assertOneOf('mode', input.mode, MODES)
    config.mode = input.mode
  }
  if (input.authoritative !== undefined) {
    assertOneOf('authoritative', input.authoritative, AUTHORITATIVE)
    config.authoritative = input.authoritative
  }
  if (input.strictness !== undefined) {
    assertOneOf('strictness', input.strictness, STRICTNESS)
    config.strictness = input.strictness
  }
  if (input.translate !== undefined) {
    assertOneOf('translate', input.translate, TRANSLATE)
    config.translate = input.translate
  }
  if (input.escapePrefix !== undefined) {
    if (input.escapePrefix !== null && typeof input.escapePrefix !== 'string') {
      throw new TypeError('english-buddy: escapePrefix must be a string or null')
    }
    config.escapePrefix = input.escapePrefix
  }
  if (input.provider !== undefined) {
    if (input.provider !== null && (typeof input.provider !== 'string' || input.provider.length === 0)) {
      throw new TypeError('english-buddy: provider must be a non-empty string or null')
    }
    config.provider = input.provider
  }
  if (input.model !== undefined) {
    if (typeof input.model !== 'string' || input.model.length === 0) {
      throw new TypeError('english-buddy: model must be a non-empty string')
    }
    config.model = input.model
  }
  if (input.timeoutMs !== undefined) config.timeoutMs = integer('timeoutMs', input.timeoutMs, 100, 30_000)
  if (input.maxInputChars !== undefined) config.maxInputChars = integer('maxInputChars', input.maxInputChars, 40, 100_000)
  if (input.maxOutputTokens !== undefined) config.maxOutputTokens = integer('maxOutputTokens', input.maxOutputTokens, 64, 32_000)
  if (input.retentionDays !== undefined) config.retentionDays = integer('retentionDays', input.retentionDays, 0, 3650)
  if (input.sampleRate !== undefined) {
    const rate = Number(input.sampleRate)
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
      throw new TypeError(`english-buddy: sampleRate must be between 0 and 1, got ${String(input.sampleRate)}`)
    }
    config.sampleRate = rate
  }
  if (input.domainTerms !== undefined) {
    if (!Array.isArray(input.domainTerms)) throw new TypeError('english-buddy: domainTerms must be an array of strings')
    config.domainTerms = input.domainTerms
      .filter(term => typeof term === 'string')
      .map(term => term.trim())
      .filter(term => term.length > 0)
  }
  if (input.hints !== undefined) config.hints = input.hints !== false

  return Object.freeze(config)
}

function assertOneOf(key, value, allowed) {
  if (!allowed.includes(value)) {
    throw new TypeError(`english-buddy: ${key} must be one of ${allowed.join(', ')}, got ${JSON.stringify(value)}`)
  }
}

function integer(key, value, min, max) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new TypeError(`english-buddy: ${key} must be an integer between ${min} and ${max}, got ${String(value)}`)
  }
  return number
}

/** ASCII-printable ratio of `text`, 0–100, matching the upstream heuristic. */
export function asciiRatio(text) {
  const chars = [...text]
  if (chars.length === 0) return 0
  let ascii = 0
  for (const char of chars) {
    const code = char.charCodeAt(0)
    if (code >= 0x20 && code <= 0x7e) ascii += 1
  }
  return Math.round((ascii / chars.length) * 100)
}

/** Whether `text` reads as English by the upstream ASCII-ratio heuristic. */
export function isLikelyEnglish(text) {
  return asciiRatio(text) >= ENGLISH_RATIO
}

/**
 * Whether a prompt should never be sent to the coach.
 * @param text - the raw human prompt.
 * @returns true for commands, code/URL fragments, and prompts too short to teach from.
 */
export function shouldSkip(text) {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (trimmed.length === 0) return true
  if (text.startsWith('/') || text.startsWith('$')) return true
  const charCount = [...trimmed].length
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length
  if (charCount < 10 && wordCount < 3) return true
  return SKIP_PREFIX.test(trimmed)
}

/**
 * Decide what to do with one human prompt.
 *
 * Order matters: the bypass prefix wins over everything, then `::` refine,
 * then the skip rules, then language detection.
 *
 * @param text - the raw human prompt text.
 * @param config - a normalized configuration.
 * @returns `{ kind: 'pass' | 'skip' | 'correct' | 'english' | 'refine', text }`.
 */
export function planMode(text, config) {
  const raw = typeof text === 'string' ? text : ''
  const start = raw.trimStart()

  const escape = config.escapePrefix
  if (escape && start.startsWith(escape)) {
    return { kind: 'pass', text: start.slice(escape.length).trimStart() }
  }
  if (start.startsWith('::')) {
    const rest = start.slice(2).trimStart()
    return rest.length === 0 ? { kind: 'pass', text: '' } : { kind: 'refine', text: rest }
  }
  if (config.mode === 'onDemand') return { kind: 'skip', text: raw }
  if (shouldSkip(raw)) return { kind: 'skip', text: raw }
  if (isLikelyEnglish(raw)) return { kind: 'correct', text: raw }
  return config.translate === 'auto' ? { kind: 'english', text: raw } : { kind: 'skip', text: raw }
}

/** Deterministic 0–1 sample position for one prompt. */
export function sampleOf(text) {
  // FNV-1a: no dependency on a hash API, and stable across processes.
  let hash = 0x811c9dc5
  for (const byte of Buffer.from(text, 'utf8')) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash / 0x1_0000_0000
}

/** Whether this prompt is sampled in under the configured rate. */
export function sampledIn(text, config) {
  if (config.sampleRate >= 1) return true
  if (config.sampleRate <= 0) return false
  return sampleOf(text) < config.sampleRate
}

const STRICTNESS_RULE = {
  gentle: 'Be conservative: fix only clear errors. Leave informal grammar, fragments and casual register alone.',
  standard: 'Fix errors. Leave correct text alone even when a more elegant version exists.',
  strict: 'Also flag understandable-but-ungrammatical phrasing that a native speaker would notice. Never restyle correct text and never change the author\'s register.',
}

/** Content rule for the expressiveness hints (display only, never injected). */
const HINT_RULE = `Hints: when the request leaves out a detail a coding assistant would need — which file, which scope, whether existing behaviour must be kept, what "done" looks like — name at most ${MAX_HINTS} of those gaps, one per line, after the metadata separator. Name the gap; never answer the request, never restate the rewrite there. If nothing is genuinely missing, emit no hint.`

/**
 * The output contract, shared by every mode.
 *
 * The separator and the enumerated metadata lines are one block so the model
 * cannot satisfy one instruction by breaking another; an earlier wording let
 * the "no commentary" rule swallow both the `(source language)` tag and the
 * hints.
 *
 * @param kinds - which optional metadata lines this mode accepts.
 */
function formatRule(kinds) {
  const lines = [
    'Output format (strict):',
    '- If you have nothing to change, output EXACTLY this and nothing else: CLEAN',
    '- Otherwise output the rewritten prompt first. It may span lines and paragraphs, including blank lines.',
    `- Then one line containing exactly ${SENTINEL}`,
    '- Then the metadata lines. Each is optional; emit only the ones that apply:',
  ]
  if (kinds.includes('source')) lines.push('    (source language)        e.g. (Chinese)')
  if (kinds.includes('notes')) lines.push('    {wrong} → {right} ({category})')
  if (kinds.includes('hints')) lines.push('    ? one detail the request leaves out')
  lines.push('- Never wrap the output in a code fence. Never explain your work. Never repeat the rewritten prompt after the separator.')
  return lines.join('\n')
}

/** Build the system prompt for one coaching mode. */
export function buildSystem(mode, config) {
  const terms = config.domainTerms.length > 0
    ? `\nTreat these domain terms as correctly spelled English and keep them unchanged: ${config.domainTerms.join(', ')}.`
    : ''
  const wantsHints = config.hints === true && mode !== 'correct'
  const hints = wantsHints ? `\n\n${HINT_RULE}` : ''

  if (mode === 'correct') {
    return `You are an English language coach for a non-native speaker who uses AI coding tools daily.
The user's prompt is understood by an AI assistant regardless of errors. Your job is to help the USER improve by showing what was wrong.

Rules:
- Fix spelling, grammar, punctuation, agreement, tense, articles and wrong word choice.
- Keep technical terms, code references, file paths, identifiers and tool names unchanged.
- Keep command and skill invocations (tokens starting with / or $) exactly as written.
- Preserve the user's intent and structure exactly.
- Do NOT restructure or expand the prompt: only correct errors. Never shorten a correct sentence, never reorder it for flow, never add transitions, never upgrade the register.
- Never emit a note whose two sides are identical after trimming.
- Show the smallest token that actually changed ("html → HTML", not the whole phrase around it).
- Surface at most ${MAX_NOTES} notes; pick the ones most worth learning from.${terms}
- ${STRICTNESS_RULE[config.strictness]}

- Use one of these categories in a note: ${CATEGORIES.join(', ')}.

${formatRule(['notes'])}`
  }

  if (mode === 'english') {
    return `You are a translator for a developer who uses AI coding tools. They write in Chinese or another non-English language; the assistant works in English.

Rules:
- Produce one complete English version of what the user asked, faithful to their intent and scope.
- Preserve the intent and structure exactly. Do not add, remove, merge, split or infer requirements.
- Do not answer the request, do not add steps, do not turn it into a specification.
- Use imperative voice where the user is instructing the assistant.
- Keep ALL technical terms, code, file paths, identifiers, command names, URLs and quoted strings unchanged. If a quoted string is text the user wants produced in Chinese, keep it in Chinese.
- Expand an abbreviation only when its meaning is unambiguous.
- Keep markdown, code fences and line structure.${terms}
- ${STRICTNESS_RULE[config.strictness]}

${hints}

${formatRule(['source'].concat(wantsHints ? ['hints'] : []))}`
  }

  if (mode === 'refine') {
    return `You are a prompt engineer. Rewrite the user's rough idea into a precise, effective prompt for an AI coding assistant.

Rules:
- Use imperative voice. Be specific and actionable.
- Add structure (numbered steps, categories) only when the task is complex.
- Expand vague requests into concrete instructions.
- Keep technical terms intact.
- Translate non-English to English.
- Do not invent facts about the codebase. When the request depends on a detail you do not have, name it as an unknown to confirm instead of guessing.${terms}
- ${STRICTNESS_RULE[config.strictness]}

${hints}

${formatRule(wantsHints ? ['hints'] : [])}`
  }

  throw new TypeError(`english-buddy: unknown coaching mode ${String(mode)}`)
}

/**
 * Parse one coaching response.
 *
 * The separator line splits the rewritten prompt from the notes. A model that
 * ignores the separator still parses: everything before the first annotation
 * line becomes the prompt. `CLEAN`, an empty prompt, or a prompt identical to
 * the original all mean "nothing to change".
 *
 * @param raw - the assembled model output.
 * @param original - the prompt that was sent.
 * @returns a coaching result, or undefined when the output is unusable.
 */
export function parseOutput(raw, original) {
  if (typeof raw !== 'string') return undefined
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim()
  if (text.length === 0) return undefined
  if (/^CLEAN\b/.test(text)) return { kind: 'clean', notes: [], hints: [], source: null }

  const lines = text.split('\n')
  let body = text
  let meta = ''

  const separator = findSeparator(lines)
  if (separator !== undefined) {
    body = lines.slice(0, separator).join('\n')
    meta = lines.slice(separator + 1).join('\n')
  } else {
    // Tolerate a model that skipped the separator entirely: cut at the first annotation.
    const firstNote = lines.findIndex(line => /→| -> /.test(line))
    if (firstNote !== -1) {
      body = lines.slice(0, firstNote).join('\n')
      meta = lines.slice(firstNote).join('\n')
    }
  }

  const trimmed = unwrapFence(body).trim()
  if (trimmed.length === 0) return undefined

  const notes = parseAnnotations(meta)
  const hints = parseHints(meta)
  const source = parseSourceTag(meta)

  if (trimmed === original.trim()) return { kind: 'clean', notes, hints, source }
  return { kind: 'rewrite', text: trimmed, notes, hints, source }
}

/**
 * Index of the line that separates the rewrite from its metadata.
 *
 * The exact sentinel is preferred. A model that substitutes a plain markdown
 * rule is accepted only when every line after it is metadata, because a rule
 * inside the prompt itself must not truncate the user's text.
 *
 * @param lines - the model output split on newlines.
 * @returns the separator line index, or undefined.
 */
function findSeparator(lines) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (line === SENTINEL) return index
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (/^-{3,}$/u.test(line) && isMetadataTail(lines.slice(index + 1))) return index
  }
  return undefined
}

/** Whether every non-empty line after a candidate separator is metadata. */
function isMetadataTail(lines) {
  let seen = 0
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    const metadata = /^\([^)]{1,40}\)$/u.test(line)
      || line.startsWith('?')
      || /→| -> /.test(line)
    if (!metadata) return false
    seen += 1
  }
  return seen > 0
}

/** Drop one code fence that wraps the whole body; leave real fences alone. */
function unwrapFence(body) {
  const text = body.trim()
  const match = /^```[a-zA-Z0-9-]*\n([\s\S]*?)\n```$/.exec(text)
  return match === null ? text : match[1]
}

/**
 * Parse correction notes, tolerating format drift.
 * @param meta - every line after the separator.
 * @returns up to MAX_NOTES `{ wrong, right, category }` entries.
 */
export function parseAnnotations(meta) {
  if (typeof meta !== 'string' || meta.trim().length === 0) return []
  const notes = []
  for (const rawLine of meta.split('\n')) {
    const line = rawLine.replace(/^\s*[-•*]\s*/u, '').trim()
    if (line.length === 0 || line.startsWith('?')) continue
    const arrow = /^(.+?)\s*(?:→|->)\s*(.+?)(?:\s*\(([^)]+)\))?\s*$/u.exec(line)
    if (arrow !== null) {
      pushNote(notes, arrow[1], arrow[2], arrow[3])
      continue
    }
    const legacy = /^\((.+)\)$/.exec(line)
    if (legacy !== null) {
      for (const pair of legacy[1].split(';')) {
        const index = pair.indexOf('>')
        if (index === -1) continue
        pushNote(notes, pair.slice(0, index), pair.slice(index + 1), undefined)
      }
    }
  }
  return notes.slice(0, MAX_NOTES)
}

function pushNote(notes, wrongRaw, rightRaw, categoryRaw) {
  if (notes.length >= MAX_NOTES) return
  const wrong = String(wrongRaw).trim()
  const right = String(rightRaw).trim()
  if (wrong.length === 0 || right.length === 0 || wrong === right) return
  const category = typeof categoryRaw === 'string' && categoryRaw.trim().length > 0 ? categoryRaw.trim() : null
  notes.push({ wrong, right, category })
}

/**
 * Parse the `? ...` expressiveness hints.
 * @param meta - every line after the separator.
 * @returns up to MAX_HINTS short strings.
 */
export function parseHints(meta) {
  if (typeof meta !== 'string') return []
  const hints = []
  for (const rawLine of meta.split('\n')) {
    const line = rawLine.trim()
    if (!line.startsWith('?')) continue
    const hint = line.replace(/^\?\s*/, '').trim()
    if (hint.length === 0) continue
    hints.push(hint.slice(0, 120))
    if (hints.length >= MAX_HINTS) break
  }
  return hints
}

/** Parse a `(Chinese)` style source-language tag. */
function parseSourceTag(meta) {
  if (typeof meta !== 'string') return null
  const match = /^\s*\(([^)]{1,40})\)\s*$/m.exec(meta)
  if (match === null) return null
  const value = match[1].trim()
  // A correction note reads "… (spelling)"; only treat a bare tag line as a language.
  return value.length > 0 ? value : null
}

/**
 * Extract literals that a rewrite must carry over byte-for-byte.
 *
 * The rule is "backticks are literal, quotes are just quotation". Only
 * mechanically checkable tokens are protected: backticked spans, numbers with
 * units, paths and URLs, code identifiers, `--flags`, and dotted names. Quoted
 * natural language is deliberately **not** protected, because quoting is how
 * people talk about text and a translation legitimately reorders it — an
 * earlier version treated every quoted span as a literal, so a prompt quoting
 * four words was rejected whole and never coached.
 *
 * A user who needs a quoted string kept verbatim wraps it in backticks.
 * Passing this floor does not prove semantic equivalence, which is why a
 * failure keeps the original.
 *
 * @param text - the original prompt.
 * @returns the distinct literal strings, longest first.
 */
export function literalsOf(text) {
  if (typeof text !== 'string') return []
  const found = new Set()
  const collect = term => {
    const value = term.trim()
    if (value.length >= 2) found.add(value)
  }
  for (const match of text.matchAll(/`[^`\n]+`/gu)) collect(match[0])
  for (const match of text.matchAll(/\b\d+(?:[.,]\d+)*(?:\s*(?:ms|milliseconds?|seconds?|minutes?|hours?|px|rem|em|%|mb|gb|kb|fps))?/giu)) {
    if (match[0].trim().length >= 2) collect(match[0])
  }
  for (const match of text.matchAll(/(?:^|[\s(（"'“「])((?:~|\.{0,2}\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)/gu)) collect(match[1])
  for (const match of text.matchAll(/\b\d+\.[A-Za-z0-9]+\b/gu)) collect(match[0])
  // Filenames by extension, so `package.json` is protected while a sentence-ending
  // period or an abbreviation like `e.g` is not swept in.
  for (const match of text.matchAll(/\b[\w-]+\.(?:json|jsonl|js|mjs|cjs|ts|tsx|jsx|md|css|html|yml|yaml|toml|ini|lock|sh|py|rs|go|java|rb|php|swift|sql|txt|svg|png|zst|log|env)\b/giu)) collect(match[0])
  for (const match of text.matchAll(/\b[a-z]\w*(?:_[a-z0-9]\w*)+\b/gu)) collect(match[0])
  for (const match of text.matchAll(/\b[a-z]+(?:[A-Z][a-z0-9]*)+\b/gu)) collect(match[0])
  for (const match of text.matchAll(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b/gu)) collect(match[0])
  for (const match of text.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/gu)) collect(match[0])
  for (const match of text.matchAll(/\B--[a-z][a-z0-9-]*/gu)) collect(match[0])
  return [...found].sort((a, b) => b.length - a.length)
}

/**
 * Whether every literal of `original` survives in `rewritten`.
 * @param original - the prompt that was sent.
 * @param rewritten - the model's rewrite.
 * @returns true when nothing protected was dropped.
 */
export function preservesLiterals(original, rewritten) {
  if (typeof rewritten !== 'string' || rewritten.trim().length === 0) return false
  return literalsOf(original).every(literal => rewritten.includes(literal))
}

/**
 * Token-level fallback diff, used only when the model returned no notes.
 * @returns up to MAX_NOTES changed pairs.
 */
export function wordDiff(before, after) {
  const left = tokenize(before)
  const right = tokenize(after)
  if (left.length === 0 || right.length === 0) return []
  const pairs = []
  const lcs = longestCommonSubsequence(left, right)
  let i = 0
  let j = 0
  for (const [li, rj] of lcs) {
    if (li > i || rj > j) {
      const wrong = left.slice(i, li).join(' ').trim()
      const rightText = right.slice(j, rj).join(' ').trim()
      if (wrong.length > 0 && rightText.length > 0 && wrong !== rightText) {
        pairs.push({ wrong, right: rightText, category: null })
      }
    }
    i = li + 1
    j = rj + 1
  }
  const tailWrong = left.slice(i).join(' ').trim()
  const tailRight = right.slice(j).join(' ').trim()
  if (tailWrong.length > 0 && tailRight.length > 0 && tailWrong !== tailRight) {
    pairs.push({ wrong: tailWrong, right: tailRight, category: null })
  }
  return pairs.slice(0, MAX_NOTES)
}

function tokenize(text) {
  return String(text)
    .split(/(\s+)/u)
    .filter(token => token.trim().length > 0)
}

function longestCommonSubsequence(left, right) {
  const rows = left.length
  const columns = right.length
  const table = Array.from({ length: rows + 1 }, () => new Uint16Array(columns + 1))
  for (let i = 1; i <= rows; i += 1) {
    for (let j = 1; j <= columns; j += 1) {
      table[i][j] = left[i - 1] === right[j - 1]
        ? table[i - 1][j - 1] + 1
        : Math.max(table[i - 1][j], table[i][j - 1])
    }
  }
  const pairs = []
  let i = rows
  let j = columns
  while (i > 0 && j > 0) {
    if (left[i - 1] === right[j - 1]) {
      pairs.push([i - 1, j - 1])
      i -= 1
      j -= 1
    } else if (table[i - 1][j] >= table[i][j - 1]) {
      i -= 1
    } else {
      j -= 1
    }
  }
  return pairs.reverse()
}

/** Concatenate the text blocks of one message. */
export function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

/**
 * Pick the message this plugin may coach: the last human-authored one.
 *
 * A real composer submission carries `source.kind === 'user'`; injected
 * context, subagent prompts, reminders and schedule deliveries do not.
 *
 * @param messages - the claimed pre-step batch.
 * @returns `{ index, message, text }`, or undefined.
 */
export function pickCoachable(messages) {
  if (!Array.isArray(messages)) return undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === null || typeof message !== 'object') continue
    if (message.role !== 'user') continue
    if (message.source === null || typeof message.source !== 'object' || message.source.kind !== 'user') continue
    const text = textOf(message.content)
    if (text.trim().length === 0) continue
    return { index, message, text }
  }
  return undefined
}

/**
 * Replace the text blocks of one message, keeping identity and every non-text
 * block (images, files) exactly where they were.
 *
 * `note`, when given, rides on the message source as `source.englishBuddy`. The
 * source is durable display metadata: the model never sees it, the transcript
 * can, which is how the user's original wording stays visible after a rewrite.
 *
 * @param messages - the claimed pre-step batch.
 * @param index - message to rewrite.
 * @param text - the new model-facing text.
 * @param note - display annotation for humans, e.g. `{ before, after, mode }`.
 */
export function replaceText(messages, index, text, note) {
  const next = messages.slice()
  const message = next[index]
  const content = []
  let placed = false
  for (const block of message.content) {
    if (block !== null && typeof block === 'object' && block.type === 'text') {
      if (!placed) {
        content.push({ ...block, text })
        placed = true
      }
      continue
    }
    content.push(block)
  }
  if (!placed) content.unshift({ type: 'text', text })
  const rewritten = { ...message, content }
  if (note !== undefined) rewritten.source = { ...message.source, englishBuddy: note }
  next[index] = rewritten
  return next
}

/**
 * Append the coaching as supplementary context instead of rewriting the prompt.
 * @returns a new message array with one extra injected user-role message.
 */
export function appendContextMessage(messages, text, id) {
  return [...messages, {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'english-buddy' },
  }]
}

/** Prefix attached to every injected coaching message. */
export const CONTEXT_PREFIX = 'Coaching is supplementary. The original user prompt is authoritative; preserve literal code, names, constraints and intent.\n'
