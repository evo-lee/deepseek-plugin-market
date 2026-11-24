/**
 * Correction history for `dsh-english-buddy`.
 *
 * One JSONL file per local day under `$DSH_HOME/english-buddy/`. The store is
 * deliberately small and self-owned: the Harness session log cannot hold the
 * original prompt once `agent/pre-step` rewrites it, so this is the only place
 * the pre-rewrite text survives.
 *
 * Every failure mode degrades to "no history": a broken line is skipped, an
 * unwritable directory flips the store to memory-only, and neither ever
 * prevents a prompt from being sent.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

/** File-name prefix and suffix around the local day key. */
const PREFIX = 'corrections-'
const SUFFIX = '.jsonl'

/** Hard cap on lines read per day, so one runaway file cannot stall a report. */
const MAX_LINES = 20_000

/** Max entries the reports list individually. */
const REPORT_LIMIT = 10

/** Local `YYYY-MM-DD` for one instant. */
export function dayKey(ms = Date.now()) {
  const date = new Date(ms)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Local midnight at the start of the day containing `ms`. */
export function dayStart(ms = Date.now()) {
  const date = new Date(ms)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** Local day key `days` before the day containing `ms`. */
export function dayBefore(ms, days) {
  const date = new Date(dayStart(ms))
  date.setDate(date.getDate() - days)
  return dayKey(date.getTime())
}

/**
 * Open (or create) the history store.
 *
 * @param root - absolute directory for the JSONL files.
 * @param options.retentionDays - files older than this are pruned on start; 0 disables writing.
 * @param options.now - injectable clock, for tests.
 */
export function createStore(root, options = {}) {
  const retentionDays = Number.isSafeInteger(options.retentionDays) ? options.retentionDays : 120
  // Every failure is reported here before the call degrades. History must never
  // block a prompt, but it must never disappear without a trace either.
  const onError = typeof options.onError === 'function' ? options.onError : () => {}
  const now = typeof options.now === 'function' ? options.now : Date.now
  const writable = retentionDays > 0
  let degraded = false
  let pruned = false

  const ensure = () => {
    if (degraded || !writable) return false
    try {
      mkdirSync(root, { recursive: true })
      return true
    } catch (error) {
      degraded = true
      onError('store-init-failed', error)
      return false
    }
  }

  /**
   * Create the history directory if it can be created.
   *
   * Called once at plugin load so an unwritable home is visible immediately
   * rather than at the first correction, and so `prune()` has a directory.
   *
   * @returns true when the store can accept records.
   */
  const init = () => writable && ensure()

  /**
   * Append one record.
   * @returns false when the record could not be written (history is memory-only).
   */
  const append = record => {
    if (!writable || !ensure()) return false
    const line = `${JSON.stringify(record)}\n`
    try {
      appendFileSync(join(root, `${PREFIX}${dayKey(now())}${SUFFIX}`), line, { encoding: 'utf8', mode: 0o600 })
      return true
    } catch (error) {
      degraded = true
      onError('store-write-failed', error)
      return false
    }
  }

  /** Read one day key; malformed lines are skipped. */
  const readDay = key => {
    const file = join(root, `${PREFIX}${key}${SUFFIX}`)
    if (!existsSync(file)) return []
    let raw
    try {
      raw = readFileSync(file, 'utf8')
    } catch (error) {
      onError('store-read-failed', error)
      return []
    }
    const records = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      if (records.length >= MAX_LINES) break
      let parsed
      try {
        parsed = JSON.parse(trimmed)
      } catch (error) {
        onError('store-parse-failed', error)
        continue
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      records.push(parsed)
    }
    return records
  }

  /** Read the last `days` local days, oldest first. */
  const readWindow = (days, at = now()) => {
    const today = dayKey(at)
    const records = []
    for (let offset = days - 1; offset >= 0; offset -= 1) {
      records.push(...readDay(dayBefore(at, offset)))
    }
    return { today, records }
  }

  /** Delete files whose day is older than the retention window. */
  const prune = (at = now()) => {
    if (!writable || pruned || retentionDays <= 0) return
    pruned = true
    const cutoff = dayBefore(at, retentionDays)
    let names
    try {
      names = readdirSync(root)
    } catch (error) {
      onError('store-prune-failed', error)
      return
    }
    for (const name of names) {
      if (!name.startsWith(PREFIX) || !name.endsWith(SUFFIX)) continue
      const key = name.slice(PREFIX.length, name.length - SUFFIX.length)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || key >= cutoff) continue
      try {
        if (statSync(join(root, name)).isFile()) unlinkSync(join(root, name))
      } catch (error) {
        // The file is simply kept; the failure is still recorded.
        onError('store-prune-failed', error)
      }
    }
  }

  return {
    root,
    retentionDays,
    init,
    append,
    readDay,
    readWindow,
    prune,
    get degraded() { return degraded || !writable },
  }
}

/** Score one record for the "prompt that was coached" denominator. */
function isEnglishPrompt(record) {
  return record.mode === 'correct' || record.mode === 'clean'
}

/**
 * Fold one set of records into counters and rankings.
 * @param records - raw stored records.
 * @returns a summary used by both the reports and the Client state route.
 */
export function summarize(records) {
  const summary = {
    prompts: 0,
    corrected: 0,
    clean: 0,
    translated: 0,
    refined: 0,
    literalRejected: 0,
    rate: 0,
    categories: [],
    lessons: [],
    hints: [],
  }
  const categories = new Map()
  const lessons = new Map()
  const hints = []

  for (const record of Array.isArray(records) ? records : []) {
    if (record === null || typeof record !== 'object') continue
    const mode = typeof record.mode === 'string' ? record.mode : ''
    if (mode === 'literal') {
      summary.literalRejected += 1
      continue
    }
    if (mode === 'english') summary.translated += 1
    else if (mode === 'refine') summary.refined += 1
    else if (mode === 'clean') summary.clean += 1
    else if (mode === 'correct') summary.corrected += 1
    else continue
    // Hints belong to a restatement, which is never part of the English rate.
    for (const hint of Array.isArray(record.hints) ? record.hints : []) {
      if (typeof hint === 'string' && hint.trim().length > 0) hints.push(hint.trim())
    }
    if (!isEnglishPrompt(record)) continue
    summary.prompts += 1
    for (const note of Array.isArray(record.notes) ? record.notes : []) {
      if (note === null || typeof note !== 'object') continue
      const label = typeof note.category === 'string' && note.category.length > 0
        ? note.category
        : `${String(note.wrong ?? '')} → ${String(note.right ?? '')}`
      increment(categories, label)
      if (typeof note.category === 'string' && note.category.length > 0) increment(lessons, label)
    }
  }

  const graded = summary.corrected + summary.clean
  summary.rate = graded === 0 ? 0 : summary.corrected / graded
  summary.categories = rank(categories)
  summary.lessons = rank(lessons)
  summary.hints = hints.slice(-8).reverse()
  return summary
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1)
}

function rank(map) {
  return [...map.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 5)
    .map(([label, count]) => ({ label, count }))
}

/** Shorten text for one report line without splitting a surrogate pair. */
function clip(text, limit) {
  const value = typeof text === 'string' ? text.replace(/\s+/gu, ' ').trim() : ''
  const chars = [...value]
  return chars.length <= limit ? value : `${chars.slice(0, limit - 1).join('')}…`
}

/** One line describing a stored rewrite, for the reports and the pill. */
export function describeRecord(record) {
  const before = clip(record.before, 60)
  const after = clip(record.after, 60)
  const notes = (Array.isArray(record.notes) ? record.notes : [])
    .slice(0, 3)
    .map(note => `${String(note.wrong ?? '')} → ${String(note.right ?? '')}${note.category ? `   (${note.category})` : ''}`)
  return {
    mode: typeof record.mode === 'string' ? record.mode : 'correct',
    at: typeof record.at === 'number' ? record.at : 0,
    before,
    after,
    notes,
    hints: (Array.isArray(record.hints) ? record.hints : []).slice(0, 2),
  }
}

const MODE_LABEL = {
  correct: '纠错',
  english: '译为英文',
  refine: '重写',
}

/** Plain-text daily report. */
export function formatToday(key, summary, records) {
  const lines = [`今日语言报告 · ${key}`]
  const rate = Math.round(summary.rate * 100)
  lines.push(`英文提示 ${summary.prompts} · 更正 ${summary.corrected} (${rate}%) · 无错 ${summary.clean}`)
  if (summary.translated > 0 || summary.refined > 0) {
    lines.push(`中文重述 ${summary.translated} · 手动重写 ${summary.refined}`)
  }
  if (summary.literalRejected > 0) {
    lines.push(`原样保留 ${summary.literalRejected}（改写会改动代码/数字/引号内容，已放弃）`)
  }

  const rewrites = (Array.isArray(records) ? records : [])
    .filter(record => record.mode === 'correct' || record.mode === 'english' || record.mode === 'refine')
    .slice(-REPORT_LIMIT)
    .reverse()

  if (rewrites.length === 0) {
    lines.push('', '今天没有需要改动的地方。')
  } else {
    lines.push('', `今日改写（最近 ${rewrites.length} 条）`)
    rewrites.forEach((record, index) => {
      const label = MODE_LABEL[record.mode] ?? record.mode
      lines.push(` ${index + 1}. [${label}] ${clip(record.before, 50)} → ${clip(record.after, 50)}`)
      for (const note of (Array.isArray(record.notes) ? record.notes : []).slice(0, 3)) {
        const category = note.category ? `   (${note.category})` : ''
        lines.push(`      ${String(note.wrong ?? '')} → ${String(note.right ?? '')}${category}`)
      }
    })
  }

  if (summary.lessons.length > 0) {
    lines.push('', '今日三课')
    for (const lesson of summary.lessons.slice(0, 3)) {
      lines.push(` · ${lesson.label}（${lesson.count} 次）`)
    }
  }

  if (summary.hints.length > 0) {
    lines.push('', '表达建议（只提示，没有改动你的 prompt）')
    for (const hint of summary.hints.slice(0, 3)) lines.push(` ? ${hint}`)
  }

  return lines.join('\n')
}

/** Plain-text windowed statistics. */
export function formatStats(shortSummary, longSummary, days) {
  const lines = [`语言趋势 · 近 ${days} 天`]
  const percent = value => Math.round(value * 100)
  lines.push(
    `近 7 天  提示 ${shortSummary.prompts} · 更正 ${shortSummary.corrected} (${percent(shortSummary.rate)}%) · 无错 ${shortSummary.clean}`,
    `近 30 天 提示 ${longSummary.prompts} · 更正 ${longSummary.corrected} (${percent(longSummary.rate)}%) · 无错 ${longSummary.clean}`,
  )
  const delta = percent(longSummary.rate) - percent(shortSummary.rate)
  if (shortSummary.prompts > 0 && longSummary.prompts > 0) {
    lines.push(delta > 0 ? `更正率比 30 天均值低 ${delta} 个百分点，在变好。`
      : delta < 0 ? `更正率比 30 天均值高 ${Math.abs(delta)} 个百分点，最近更容易出错。`
        : '更正率与 30 天均值持平。')
  }

  if (shortSummary.translated + longSummary.translated > 0) {
    lines.push('', `中文重述 近 7 天 ${shortSummary.translated} · 近 30 天 ${longSummary.translated}`)
  }

  if (longSummary.categories.length > 0) {
    lines.push('', '最常犯的 5 个模式（近 30 天）')
    for (const item of longSummary.categories) lines.push(` · ${item.label}（${item.count} 次）`)
  }

  if (longSummary.literalRejected > 0) {
    lines.push('', `因改动 literal 被放弃的改写：${longSummary.literalRejected} 次`)
  }

  return lines.join('\n')
}
