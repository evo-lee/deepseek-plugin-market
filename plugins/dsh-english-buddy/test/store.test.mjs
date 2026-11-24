// Offline harness for dsh-english-buddy/store.js: per-day JSONL, tolerant
// reads, rollups, retention, and the two plain-text reports.
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createStore,
  dayBefore,
  dayKey,
  describeRecord,
  formatStats,
  formatToday,
  summarize,
} from '../store.js'

const tests = []
const test = (name, body) => tests.push({ name, body })

const DAY = 86_400_000
const NOW = new Date(2026, 10, 22, 15, 30).getTime() // local, 2026-11-22 15:30

const repair = (overrides = {}) => ({
  v: 1,
  at: NOW,
  sid: 'session-1',
  mode: 'correct',
  before: 'its got too many responsibilties',
  after: 'it has too many responsibilities',
  notes: [{ wrong: 'its got', right: 'it has', category: 'verb tense' }],
  hints: [],
  ms: 900,
  ...overrides,
})

const workspace = () => mkdtempSync(join(tmpdir(), 'english-buddy-'))

test('day keys and offsets follow the local calendar', () => {
  assert.equal(dayKey(NOW), '2026-11-22')
  assert.equal(dayKey(new Date(2026, 10, 22, 0, 0, 1).getTime()), '2026-11-22')
  assert.equal(dayKey(new Date(2026, 10, 22, 23, 59).getTime()), '2026-11-22')
  assert.equal(dayBefore(NOW, 1), '2026-11-21')
  assert.equal(dayBefore(NOW, 30), '2026-10-23')
})

test('init creates the history directory and reports writability', () => {
  const root = join(workspace(), 'nested', 'english-buddy')
  try {
    const store = createStore(root, { retentionDays: 30, now: () => NOW })
    assert.equal(store.init(), true)
    assert.deepEqual(readdirSync(root), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  const disabled = createStore(join(workspace(), 'off'), { retentionDays: 0, now: () => NOW })
  assert.equal(disabled.init(), false)
  assert.equal(disabled.degraded, true)
})

test('append writes one line, and readDay returns it', () => {
  const root = workspace()
  try {
    const store = createStore(root, { now: () => NOW })
    assert.equal(store.append(repair()), true)
    assert.equal(store.append(repair({ mode: 'clean' })), true)
    const file = join(root, 'corrections-2026-11-22.jsonl')
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 2)
    const records = store.readDay('2026-11-22')
    assert.equal(records.length, 2)
    assert.equal(records[0].mode, 'correct')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a malformed line is skipped instead of failing the read', () => {
  const root = workspace()
  try {
    writeFileSync(join(root, 'corrections-2026-11-22.jsonl'), `{"v":1,"mode":"clean"}\nnot json\n\n[1,2]\n`)
    const store = createStore(root, { now: () => NOW })
    const records = store.readDay('2026-11-22')
    assert.equal(records.length, 1)
    assert.equal(records[0].mode, 'clean')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readWindow walks the last N local days, oldest first', () => {
  const root = workspace()
  try {
    createStore(root, { now: () => NOW }).append(repair({ at: NOW }))
    createStore(root, { now: () => NOW - 2 * DAY }).append(repair({ at: NOW - 2 * DAY, mode: 'clean' }))
    createStore(root, { now: () => NOW - 8 * DAY }).append(repair({ at: NOW - 8 * DAY }))
    const store = createStore(root, { now: () => NOW })
    const seventh = store.readWindow(7)
    assert.equal(seventh.today, '2026-11-22')
    assert.equal(seventh.records.length, 2)
    assert.equal(seventh.records[0].mode, 'clean')
    assert.equal(seventh.records[1].mode, 'correct')
    assert.equal(store.readWindow(30).records.length, 3)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('summarize uses English prompts as the denominator and separates modes', () => {
  const summary = summarize([
    repair(),
    repair({ mode: 'correct', notes: [{ wrong: 'modul', right: 'module', category: 'spelling' }] }),
    repair({ mode: 'clean', notes: [], before: '', after: '' }),
    repair({ mode: 'clean', notes: [], before: '', after: '' }),
    repair({ mode: 'english', notes: [], hints: ['Which file?'] }),
    repair({ mode: 'refine', notes: [] }),
    repair({ mode: 'literal', notes: [] }),
  ])
  assert.equal(summary.prompts, 4) // 2 corrected + 2 clean
  assert.equal(summary.corrected, 2)
  assert.equal(summary.clean, 2)
  assert.equal(summary.translated, 1)
  assert.equal(summary.refined, 1)
  assert.equal(summary.literalRejected, 1)
  assert.equal(summary.rate, 0.5)
  assert.equal(summary.categories.length, 2)
  assert.ok(summary.categories.some(item => item.label === 'verb tense' && item.count === 1))
  assert.ok(summary.categories.some(item => item.label === 'spelling' && item.count === 1))
  assert.deepEqual(summary.hints, ['Which file?'])
})

test('summarize handles an empty history', () => {
  const summary = summarize([])
  assert.equal(summary.prompts, 0)
  assert.equal(summary.rate, 0)
  assert.deepEqual(summary.categories, [])
})

test('store failures are reported instead of swallowed', () => {
  const root = workspace()
  try {
    const errors = []
    const store = createStore(root, {
      now: () => NOW,
      onError: (code, error) => errors.push({ code, message: String(error?.message) }),
    })
    assert.equal(store.init(), true)
    assert.deepEqual(errors, [])

    writeFileSync(join(root, 'corrections-2026-11-22.jsonl'), 'not json\n{"v":1,"mode":"clean"}\n')
    assert.equal(store.readDay('2026-11-22').length, 1)
    assert.deepEqual(errors.map(entry => entry.code), ['store-parse-failed'])
    assert.match(errors[0].message, /JSON/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  const blocked = []
  const broken = createStore('/proc/definitely-not-writable/english-buddy', {
    retentionDays: 5,
    now: () => NOW,
    onError: (code, error) => blocked.push({ code, error }),
  })
  assert.equal(broken.init(), false)
  assert.deepEqual(blocked.map(entry => entry.code), ['store-init-failed'])
})

test('retentionDays 0 disables writing instead of failing', () => {
  const root = workspace()
  try {
    const store = createStore(root, { retentionDays: 0, now: () => NOW })
    assert.equal(store.append(repair()), false)
    assert.equal(store.degraded, true)
    assert.deepEqual(readdirSync(root), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('prune removes files older than the retention window and keeps the rest', () => {
  const root = workspace()
  try {
    const old = createStore(root, { now: () => NOW - 200 * DAY })
    old.append(repair({ at: NOW - 200 * DAY }))
    const recent = createStore(root, { now: () => NOW - 10 * DAY })
    recent.append(repair({ at: NOW - 10 * DAY }))
    const names = readdirSync(root).sort()
    assert.equal(names.length, 2)

    const store = createStore(root, { retentionDays: 120, now: () => NOW })
    store.prune()
    const kept = readdirSync(root)
    assert.equal(kept.length, 1)
    assert.equal(kept[0], 'corrections-2026-11-12.jsonl')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an unwritable root degrades to no history', () => {
  const store = createStore('/proc/definitely-not-writable/english-buddy', { retentionDays: 7, now: () => NOW })
  assert.equal(store.append(repair()), false)
  assert.equal(store.degraded, true)
  assert.deepEqual(store.readDay('2026-11-22'), [])
})

test('formatToday reports counts, rewrites, lessons and hints', () => {
  const records = [
    repair(),
    repair({ mode: 'english', notes: [], before: '把这个文件的错误处理改一下', after: 'Fix the error handling in this file.', hints: ['Which file?'] }),
    repair({ mode: 'clean', notes: [], before: '', after: '' }),
  ]
  const text = formatToday('2026-11-22', summarize(records), records)
  assert.match(text, /今日语言报告 · 2026-11-22/)
  assert.match(text, /英文提示 2 · 更正 1 \(50%\) · 无错 1/)
  assert.match(text, /中文重述 1/)
  assert.match(text, /\[译为英文\] 把这个文件的错误处理改一下 → Fix the error handling/)
  assert.match(text, /its got → it has   \(verb tense\)/)
  assert.match(text, /今日三课/)
  assert.match(text, /表达建议（只提示，没有改动你的 prompt）/)
  assert.match(text, /\? Which file\?/)
})

test('formatToday says so when nothing changed', () => {
  const records = [repair({ mode: 'clean', notes: [], before: '', after: '' })]
  const text = formatToday('2026-11-22', summarize(records), records)
  assert.match(text, /今天没有需要改动的地方。/)
})

test('formatStats compares the two windows', () => {
  const short = summarize([repair(), repair({ mode: 'clean', notes: [], before: '', after: '' })])
  const long = summarize([
    repair(), repair(), repair(),
    repair({ mode: 'clean', notes: [], before: '', after: '' }),
    repair({ mode: 'literal', notes: [] }),
  ])
  const text = formatStats(short, long, 30)
  assert.match(text, /语言趋势 · 近 30 天/)
  assert.match(text, /近 7 天 {2}提示 2 · 更正 1 \(50%\)/)
  assert.match(text, /近 30 天 提示 4 · 更正 3 \(75%\)/)
  assert.match(text, /更正率比 30 天均值低 25 个百分点/)
  assert.match(text, /最常犯的 5 个模式/)
  assert.match(text, /因改动 literal 被放弃的改写：1 次/)
})

test('describeRecord clips text and keeps at most three notes', () => {
  const record = repair({
    before: 'a'.repeat(200),
    after: 'b'.repeat(200),
    notes: [1, 2, 3, 4].map(index => ({ wrong: `w${index}`, right: `r${index}`, category: null })),
    hints: ['one', 'two', 'three'],
  })
  const described = describeRecord(record)
  assert.equal([...described.before].length, 60)
  assert.equal(described.notes.length, 3)
  assert.equal(described.hints.length, 2)
  assert.equal(described.mode, 'correct')
})

// ------------------------------------------------------------------- runner

let failed = 0
for (const { name, body } of tests) {
  try {
    await body()
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}`)
    console.error(error)
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`)
if (failed > 0) process.exitCode = 1
