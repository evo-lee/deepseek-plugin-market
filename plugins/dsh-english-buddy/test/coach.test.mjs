// Offline harness for dsh-english-buddy/coach.js and pipeline.js: pure parsing
// rules plus the pre-step rewrite driven by a stubbed LLM service.
import assert from 'node:assert/strict'

import {
  buildSystem,
  isLikelyEnglish,
  literalsOf,
  normalizeConfig,
  parseAnnotations,
  parseOutput,
  pickCoachable,
  planMode,
  preservesLiterals,
  replaceText,
  shouldSkip,
  wordDiff,
} from '../coach.js'
import { createReporter, messageOf } from '../diagnostics.js'
import { createPipeline } from '../pipeline.js'

const SENTINEL = '---english-buddy---'

/** One identified human message. */
function userMessage(text, source = { kind: 'user' }) {
  return { id: 'm1', role: 'user', content: [{ type: 'text', text }], source }
}

/** One stubbed LLM service; `output` is wrapped in a normal text stream. */
function fakeLlm({ output, finish = { kind: 'stop' }, fail, chunks, streamThrows }) {
  const calls = { prepare: 0, stream: 0, configs: [], options: [] }
  return {
    calls,
    listProviders: () => [{ id: 'deepseek-account' }, { id: 'llm-pi-ai' }],
    listModels: async provider => (provider === 'deepseek-account' ? [{ id: 'deepseek-flash' }] : [{ id: 'kimi-k2' }]),
    prepareCall: async (config, signal) => {
      calls.prepare += 1
      calls.configs.push(config)
      if (typeof fail === 'function') await fail(signal)
      return {
        config: { ...config, provider: config.provider, model: config.model },
        stream: options => {
          calls.stream += 1
          calls.options.push(options)
          return (async function* emit() {
            if (streamThrows === true) throw new Error('stream exploded')
            if (Array.isArray(chunks)) {
              for (const chunk of chunks) yield chunk
              return
            }
            yield { type: 'block-start', index: 0, blockType: 'text' }
            yield { type: 'text-delta', index: 0, text: output }
            yield { type: 'block-end', index: 0, block: { type: 'text', text: output } }
            yield { type: 'finish', reason: finish }
          })()
        },
      }
    },
  }
}

/** A pipeline over an in-memory store. */
function harness({ output, finish, fail, chunks, streamThrows, store, ...overrides } = {}) {
  const cfg = normalizeConfig({ timeoutMs: 3000, ...overrides })
  const records = []
  const reports = []
  const counters = { attempts: 0, failures: 0, literalRejected: 0 }
  const llm = fakeLlm({ output, finish, fail, chunks, streamThrows })
  const pipeline = createPipeline({
    cfg,
    store: store ?? { append: record => records.push(record) },
    counters,
    getLlm: () => llm,
    report: (code, error) => reports.push({ code, error }),
  })
  const signal = new AbortController().signal
  const run = (messages, agent = { id: 'session-1' }) => pipeline.listener(
    { agent, signal },
    async () => ({ kind: 'enter', messages }),
  )
  run.cfg = cfg
  run.records = records
  run.reports = reports
  run.counters = counters
  run.llm = llm
  run.pipeline = pipeline
  return run
}

const tests = []
const test = (name, body) => tests.push({ name, body })

// ---------------------------------------------------------------- pure rules

test('language detection follows the upstream 85% ASCII threshold', () => {
  assert.equal(isLikelyEnglish('Refactor the authentication module.'), true)
  assert.equal(isLikelyEnglish('把这个文件的错误处理改一下'), false)
  assert.equal(isLikelyEnglish('把这个 file 的 error handling 改一下'), false)
  assert.equal(isLikelyEnglish('a'.repeat(85) + '中'.repeat(15)), true)
})

test('skip rules cover commands, fragments and URL/shell prefixes', () => {
  assert.equal(shouldSkip('/english-buddy-today'), true)
  assert.equal(shouldSkip('$my-skill go'), true)
  assert.equal(shouldSkip('fix typo'), true) // < 10 chars and < 3 words
  assert.equal(shouldSkip('npm install left-pad'), true)
  assert.equal(shouldSkip('https://example.com/a/b'), true)
  assert.equal(shouldSkip('please refactor the auth module'), false)
})

test('planMode resolves prefixes before language and skip rules', () => {
  const cfg = normalizeConfig({})
  assert.deepEqual(planMode(';; 保持中文原文', cfg), { kind: 'pass', text: '保持中文原文' })
  assert.deepEqual(planMode(':: make it shorter', cfg), { kind: 'refine', text: 'make it shorter' })
  assert.deepEqual(planMode('::   ', cfg), { kind: 'pass', text: '' })
  assert.equal(planMode('/english-buddy-today', cfg).kind, 'skip')
  assert.equal(planMode('把这句中文改一下再说', cfg).kind, 'english')
  assert.equal(planMode('please fix the auth flow', cfg).kind, 'correct')
  assert.equal(planMode('把这句中文改一下再说', normalizeConfig({ translate: 'off' })).kind, 'skip')
  assert.equal(planMode('please fix the auth flow', normalizeConfig({ mode: 'onDemand' })).kind, 'skip')
  assert.equal(planMode(':: make it shorter', normalizeConfig({ mode: 'onDemand' })).kind, 'refine')
})

test('the correction prompt forbids restructuring; refine is the only expanding mode', () => {
  const cfg = normalizeConfig({})
  assert.match(buildSystem('correct', cfg), /Do NOT restructure or expand/)
  assert.match(buildSystem('correct', cfg), /smallest token/)
  assert.match(buildSystem('english', cfg), /Preserve the intent and structure exactly/)
  assert.doesNotMatch(buildSystem('english', cfg), /Expand vague requests/)
  assert.match(buildSystem('refine', cfg), /Expand vague requests into concrete instructions/)
  assert.match(buildSystem('correct', normalizeConfig({ domainTerms: ['MagicDNS'] })), /MagicDNS/)
  // The metadata contract must stay in one block, or "no commentary" eats the tags.
  assert.match(buildSystem('english', cfg), /\(source language\)/)
  assert.match(buildSystem('english', cfg), /\? one detail/)
  assert.match(buildSystem('refine', cfg), /\? one detail/)
  assert.doesNotMatch(buildSystem('correct', cfg), /\? one detail/)
  assert.doesNotMatch(buildSystem('correct', normalizeConfig({ hints: false })), /\? one detail/)
})

test('annotation parsing tolerates bullets, missing categories, legacy syntax and no-ops', () => {
  assert.deepEqual(parseAnnotations('- its → it\'s (apostrophe)'), [{ wrong: 'its', right: "it's", category: 'apostrophe' }])
  assert.deepEqual(parseAnnotations('modul → module'), [{ wrong: 'modul', right: 'module', category: null }])
  assert.deepEqual(parseAnnotations('(a > b; c > c)'), [{ wrong: 'a', right: 'b', category: null }])
  assert.deepEqual(parseAnnotations('same → same'), [])
  assert.deepEqual(parseAnnotations('• 1 → 2 (x)\n• 3 → 4 (y)\n• 5 → 6 (z)\n• 7 → 8 (w)').length, 3)
  assert.deepEqual(parseAnnotations('no arrow here'), [])
})

test('parseOutput splits on the sentinel and keeps multi-paragraph prompts', () => {
  const original = 'first paragraph\n\nsecond paragraph'
  const raw = `${original}\n\n${SENTINEL}\nfoo → bar (spelling)\n? which file?`
  const parsed = parseOutput(raw, 'placeholder')
  assert.equal(parsed.kind, 'rewrite')
  assert.equal(parsed.text, original)
  assert.deepEqual(parsed.notes, [{ wrong: 'foo', right: 'bar', category: 'spelling' }])
  assert.deepEqual(parsed.hints, ['which file?'])
})

test('parseOutput falls back when the sentinel is missing, and treats CLEAN as clean', () => {
  const parsed = parseOutput('Fixed line\n\nits → it\'s (apostrophe)', 'x')
  assert.equal(parsed.text, 'Fixed line')
  assert.equal(parsed.notes.length, 1)
  assert.equal(parseOutput('CLEAN', 'x').kind, 'clean')
  assert.equal(parseOutput('   ', 'x'), undefined)
  assert.equal(parseOutput('same text', 'same text').kind, 'clean')
})

test('parseOutput accepts a plain markdown rule as the separator only when the tail is metadata', () => {
  const raw = `Create a market.\n\n---\n(Chinese)\n? Which layout?\n? Where does agent.md go?`
  const parsed = parseOutput(raw, '原文')
  assert.equal(parsed.kind, 'rewrite')
  assert.equal(parsed.text, 'Create a market.')
  assert.deepEqual(parsed.hints, ['Which layout?', 'Where does agent.md go?'])
  assert.equal(parsed.source, 'Chinese')

  // A rule inside the prompt itself must not truncate it.
  const kept = parseOutput('Use a rule:\n\n---\n\nThen write the docs.', 'x')
  assert.equal(kept.text, 'Use a rule:\n\n---\n\nThen write the docs.')

  // A rule followed by annotation lines is still a separator.
  const annotated = parseOutput(`Fixed.\n\n---\nits → it's (apostrophe)`, 'x')
  assert.equal(annotated.text, 'Fixed.')
  assert.equal(annotated.notes.length, 1)
})

test('parseOutput unwraps one fence wrapping the whole rewrite', () => {
  const parsed = parseOutput('```\nrewritten text\n```', 'other')
  assert.equal(parsed.text, 'rewritten text')
})

test('literal guard protects code, numbers, paths, identifiers, flags and quotes', () => {
  const original = 'Do not rename `usr_id`, run `rm -rf`, or change the 250 ms limit in src/app/main.js; keep --dry-run and "提交" as-is.'
  const literals = literalsOf(original)
  for (const expected of ['`usr_id`', '250 ms', 'src/app/main.js', '--dry-run', '"提交"']) {
    assert.ok(literals.includes(expected), `missing literal ${expected} in ${JSON.stringify(literals)}`)
  }
  assert.equal(preservesLiterals(original, original), true)
  assert.equal(preservesLiterals(original, 'Do not rename anything or change the limit.'), false)
})

test('wordDiff reports contiguous changed runs and nothing for equal text', () => {
  assert.deepEqual(wordDiff('same text', 'same text'), [])
  const pairs = wordDiff('its got too many responsibilties', 'it has too many responsibilities')
  assert.deepEqual(pairs[0], { wrong: 'its got', right: 'it has', category: null })
  assert.deepEqual(pairs[1], { wrong: 'responsibilties', right: 'responsibilities', category: null })
})

test('pickCoachable only takes the last human message with text', () => {
  const injected = userMessage('injected context', { kind: 'time-context' })
  const human = userMessage('please refactor the auth module')
  assert.equal(pickCoachable([injected, human]).text, 'please refactor the auth module')
  assert.equal(pickCoachable([human, injected]).text, 'please refactor the auth module')
  assert.equal(pickCoachable([injected]), undefined)
  assert.equal(pickCoachable([{ id: 'x', role: 'user', content: [{ type: 'image' }], source: { kind: 'user' } }]), undefined)
})

test('replaceText keeps identity, source, and non-text blocks in place', () => {
  const message = {
    id: 'm1',
    role: 'user',
    content: [{ type: 'image', ref: 'a' }, { type: 'text', text: 'old' }, { type: 'file', ref: 'b' }],
    source: { kind: 'user' },
  }
  const next = replaceText([message], 0, 'new')
  assert.equal(next[0].id, 'm1')
  assert.deepEqual(next[0].source, { kind: 'user' })
  assert.deepEqual(next[0].content.map(block => block.type), ['image', 'text', 'file'])
  assert.equal(next[0].content[1].text, 'new')
  assert.equal(message.content[1].text, 'old')
})

test('normalizeConfig rejects nonsense and fills defaults', () => {
  assert.equal(normalizeConfig({}).model, 'deepseek-flash')
  assert.equal(normalizeConfig({ sampleRate: 0.5 }).sampleRate, 0.5)
  assert.throws(() => normalizeConfig({ mode: 'sometimes' }), /mode must be one of/)
  assert.throws(() => normalizeConfig({ timeoutMs: 5 }), /timeoutMs must be an integer/)
  assert.throws(() => normalizeConfig({ authoritative: 'maybe' }), /authoritative must be one of/)
})

// --------------------------------------------------------------- diagnostics

test('the reporter dedupes, ranks severity and truncates what it records', () => {
  const logged = []
  const logger = {
    debug: message => logged.push(['debug', message]),
    info: message => logged.push(['info', message]),
    warn: message => logged.push(['warn', message]),
    error: message => logged.push(['error', message]),
  }
  const reporter = createReporter(logger)

  reporter.report('no-route')
  reporter.report('no-route') // folded into the first report
  assert.deepEqual(logged.map(entry => entry[0]), ['debug'])
  assert.match(logged[0][1], /^no-route: no detail$/)

  reporter.report('stream-failed', new Error('boom'))
  assert.equal(logged[1][0], 'warn')
  assert.match(logged[1][1], /stream-failed: boom/)

  reporter.report('listener-error', new Error('x'.repeat(500)))
  assert.equal(logged[2][0], 'error')

  const snapshot = reporter.snapshot()
  assert.equal(snapshot.last.code, 'listener-error')
  assert.equal(snapshot.last.message.length, 300)
  assert.deepEqual(snapshot.codes, { 'no-route': 1, 'stream-failed': 1, 'listener-error': 1 })
  assert.equal(snapshot.recent.length, 3)
  assert.equal(messageOf(undefined), null)
  assert.equal(messageOf('plain text'), 'plain text')
})

test('a failing logger cannot break the prompt path', () => {
  const reporter = createReporter({ warn() { throw new Error('logger down') } })
  assert.doesNotThrow(() => reporter.report('stream-failed', new Error('boom')))
  assert.equal(reporter.snapshot().last.code, 'stream-failed')
})

// ------------------------------------------------------------ the pipeline

test('corrects an English prompt and records notes', async () => {
  const run = harness({
    output: `Refactor the authentication module. It has too many responsibilities.\n\n${SENTINEL}\nautentication → authentication (spelling)\nits got → it has (verb tense)`,
  })
  const messages = [userMessage('refactor the autentication modul, its got too many responsibilties')]
  const decision = await run(messages)
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 1)
  assert.equal(decision.messages[0].id, 'm1')
  // The source keeps identifying the message as a real prompt, and carries the
  // user's own wording as display metadata the model never sees.
  assert.equal(decision.messages[0].source.kind, 'user')
  assert.deepEqual(decision.messages[0].source.englishBuddy, {
    before: 'refactor the autentication modul, its got too many responsibilties',
    after: 'Refactor the authentication module. It has too many responsibilities.',
    mode: 'correct',
    withAttachments: false,
  })
  assert.equal(decision.messages[0].content[0].text, 'Refactor the authentication module. It has too many responsibilities.')
  assert.equal(run.records.length, 1)
  assert.equal(run.records[0].mode, 'correct')
  assert.equal(run.records[0].notes.length, 2)
  assert.equal(run.records[0].sid, 'session-1')
  assert.equal(run.llm.calls.prepare, 1)
  assert.equal(run.llm.calls.configs[0].reasoningEffort, 'off')
  assert.equal(run.llm.calls.options[0].messages[0].content[0].text.includes('autentication'), true)
})

test('restates a Chinese prompt in English and keeps the hints', async () => {
  const run = harness({
    output: `Fix the error handling in this file; do not swallow exceptions.\n\n${SENTINEL}\n(Chinese)\n? Which file?`,
  })
  const decision = await run([userMessage('把这个文件的错误处理改一下，别吞异常')])
  assert.equal(decision.messages[0].content[0].text, 'Fix the error handling in this file; do not swallow exceptions.')
  assert.equal(run.records[0].mode, 'english')
  assert.deepEqual(run.records[0].hints, ['Which file?'])
  assert.deepEqual(run.records[0].notes, [])
  assert.match(run.llm.calls.options[0].system, /Preserve the intent and structure exactly/)
})

test('leaves a correct sentence untouched, matching the upstream eval', async () => {
  const run = harness({ output: 'CLEAN' })
  const messages = [userMessage('The cache expires after 250 milliseconds.')]
  const decision = await run(messages)
  assert.equal(decision.messages, messages)
  assert.equal(run.records.length, 1)
  assert.equal(run.records[0].mode, 'clean')
})

test('drops a rewrite that loses a protected literal', async () => {
  const run = harness({
    output: `Do not rename the user id, run the delete command, or change the time limit.\n\n${SENTINEL}\nusr_id → user id (word choice)`,
  })
  const text = 'Do not rename `usr_id`, run `rm -rf`, or change the 250 ms limit.'
  const messages = [userMessage(text)]
  const decision = await run(messages)
  assert.equal(decision.messages, messages)
  assert.equal(run.counters.literalRejected, 1)
  assert.equal(run.records[0].mode, 'literal')
})

test('a message that carries attachments keeps the host bubble untouched', async () => {
  const run = harness({ output: `Fixed text.\n\n${SENTINEL}\nits → it's (apostrophe)` })
  const message = {
    id: 'm1',
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'image', ref: 'a' }, { type: 'text', text: 'please fix the autentication modul' }],
  }
  const decision = await run([message])
  assert.equal(decision.messages[0].source.englishBuddy.withAttachments, true)
  assert.deepEqual(decision.messages[0].content.map(block => block.type), ['image', 'text'])
})

test('the escape prefix strips itself with no model call', async () => {
  const run = harness({ output: 'should not be used' })
  const decision = await run([userMessage(';; 按钮文案写「提交」，别翻译')])
  assert.equal(decision.messages[0].content[0].text, '按钮文案写「提交」，别翻译')
  assert.equal(run.llm.calls.prepare, 0)
  assert.equal(run.records.length, 0)
})

test('refine mode rewrites through the prompt-engineer branch', async () => {
  const run = harness({ output: `1. Read src/app.js.\n2. Rename the flag.\n\n${SENTINEL}` })
  const decision = await run([userMessage(':: 把那个开关改名')])
  assert.match(decision.messages[0].content[0].text, /Read src\/app\.js/)
  assert.equal(run.records[0].mode, 'refine')
  assert.match(run.llm.calls.options[0].system, /prompt engineer/)
})

test('original strategy keeps the prompt and appends coaching context', async () => {
  const run = harness({
    authoritative: 'original',
    output: `Refactor the authentication module.\n\n${SENTINEL}\nautentication → authentication (spelling)`,
  })
  const messages = [userMessage('refactor the autentication modul')]
  const decision = await run(messages)
  assert.equal(decision.messages.length, 2)
  assert.equal(decision.messages[0], messages[0])
  assert.equal(decision.messages[0].source.englishBuddy, undefined)
  assert.equal(decision.messages[1].source.kind, 'english-buddy')
  assert.match(decision.messages[1].content[0].text, /original user prompt is authoritative/)
  assert.match(decision.messages[1].content[0].text, /Corrected prompt:/)
})

test('every transport and parse failure falls back to the original prompt with a named code', async () => {
  const cases = [
    { name: 'error finish', options: { finish: { kind: 'error', failure: { message: 'x', code: 'X' } } }, code: 'finish-error' },
    { name: 'aborted finish', options: { finish: { kind: 'aborted', failure: { message: 'x', code: 'X' } } }, code: 'finish-aborted' },
    { name: 'max-tokens finish', options: { finish: { kind: 'max-tokens' } }, code: 'finish-max-tokens' },
    { name: 'reasoning chunks', options: { chunks: [{ type: 'reasoning-delta', index: 0, text: 'thinking' }, { type: 'finish', reason: { kind: 'stop' } }] }, code: 'non-text-output' },
    { name: 'prepare throws', options: { fail: async () => { throw new Error('boom') } }, code: 'prepare-failed' },
    { name: 'stream throws', options: { output: 'x', streamThrows: true }, code: 'stream-failed' },
    { name: 'empty output', options: { output: '   ' }, code: 'empty-output' },
    { name: 'separator only', options: { output: `${SENTINEL}\nits → it's (apostrophe)` }, code: 'unparsable-output' },
  ]
  for (const { name, options, code } of cases) {
    const run = harness(options)
    const messages = [userMessage('please fix the autentication modul')]
    const decision = await run(messages)
    assert.equal(decision.messages, messages, `${name} should keep the prompt`)
    assert.equal(run.counters.attempts, 1, `${name} counts one attempt`)
    assert.equal(run.counters.failures, 1, `${name} counts one failure`)
    assert.equal(run.reports.at(-1)?.code, code, `${name} reports ${code}, got ${JSON.stringify(run.reports)}`)
  }
})

test('a bug in our own listener is reported as an error, not hidden', async () => {
  const run = harness({
    output: `Fixed text.\n\n${SENTINEL}\nits → it's (apostrophe)`,
    store: { append() { throw new Error('store exploded') } },
  })
  const messages = [userMessage('please fix the autentication modul')]
  const decision = await run(messages)
  assert.equal(decision.messages, messages)
  assert.equal(run.reports.at(-1)?.code, 'listener-error')
  assert.match(String(run.reports.at(-1)?.error?.message), /store exploded/)
})

test('aborted turns never call the model', async () => {
  const run = harness({ output: 'Fixed text.' })
  const controller = new AbortController()
  controller.abort()
  const messages = [userMessage('please fix the autentication modul')]
  const decision = await run.pipeline.listener({ agent: { id: 's' }, signal: controller.signal }, async () => ({ kind: 'enter', messages }))
  assert.equal(decision.messages, messages)
  assert.equal(run.llm.calls.prepare, 0)
})

test('gates: mode off, onDemand, long input, sampling and non-human sources', async () => {
  const cases = [
    { name: 'mode off', overrides: { mode: 'off' }, text: 'please fix the autentication modul' },
    { name: 'onDemand', overrides: { mode: 'onDemand' }, text: 'please fix the autentication modul' },
    { name: 'too long', overrides: { maxInputChars: 40 }, text: 'please fix the autentication module in a very long sentence that keeps going' },
    { name: 'sampled out', overrides: { sampleRate: 0 }, text: 'please fix the autentication modul' },
  ]
  for (const { name, overrides, text } of cases) {
    const run = harness({ output: 'Fixed.', ...overrides })
    const messages = [userMessage(text)]
    const decision = await run(messages)
    assert.equal(decision.messages, messages, name)
    assert.equal(run.llm.calls.prepare, 0, `${name} must not call the model`)
  }

  const injected = harness({ output: 'Fixed.' })
  const message = userMessage('reminder: the user asked something', { kind: 'repeat-tool-reminder' })
  const decision = await injected([message])
  assert.deepEqual(decision.messages, [message])
  assert.equal(injected.llm.calls.prepare, 0)
})

test('subagent sessions are never coached, even though their prompts look human', async () => {
  const run = harness({ output: 'Fixed.' })
  const message = userMessage('please fix the autentication modul')
  const viaOrigin = await run([message], { id: 'child-1', session: { header: { origin: 'subagent' } } })
  assert.deepEqual(viaOrigin.messages, [message])
  const viaDepth = await run([message], { id: 'child-2', session: { header: { delegationDepth: 2 } } })
  assert.deepEqual(viaDepth.messages, [message])
  assert.equal(run.llm.calls.prepare, 0)
})

test('a downstream rejection is passed through untouched', async () => {
  const run = harness({ output: 'Fixed.' })
  const decision = await run.pipeline.listener({ agent: { id: 's' } }, async () => ({ kind: 'reject' }))
  assert.deepEqual(decision, { kind: 'reject' })
  assert.equal(run.llm.calls.prepare, 0)
})

test('the route falls back to the official key when the account route is absent', async () => {
  const cfg = normalizeConfig({})
  const records = []
  const counters = { attempts: 0, failures: 0, literalRejected: 0 }
  const seen = []
  const llm = {
    listProviders: () => [{ id: 'deepseek-official' }],
    listModels: async () => [{ id: 'deepseek-flash' }],
    prepareCall: async config => {
      seen.push(config.provider)
      return {
        config,
        stream: () => (async function* emit() {
          yield { type: 'text-delta', index: 0, text: 'CLEAN' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })(),
      }
    },
  }
  const pipeline = createPipeline({ cfg, store: { append: r => records.push(r) }, counters, getLlm: () => llm })
  await pipeline.listener({ agent: { id: 's' } }, async () => ({ kind: 'enter', messages: [userMessage('please fix the autentication modul')] }))
  assert.deepEqual(seen, ['deepseek-official'])
})

test('a missing route leaves the prompt alone without counting an attempt', async () => {
  const cfg = normalizeConfig({})
  const counters = { attempts: 0, failures: 0, literalRejected: 0 }
  const llm = { listProviders: () => [], listModels: async () => [], prepareCall: async () => { throw new Error('unreachable') } }
  const reports = []
  const pipeline = createPipeline({
    cfg,
    store: { append: () => true },
    counters,
    getLlm: () => llm,
    report: (code, error) => reports.push({ code, error }),
  })
  const messages = [userMessage('please fix the autentication modul')]
  const decision = await pipeline.listener({ agent: { id: 's' } }, async () => ({ kind: 'enter', messages }))
  assert.equal(decision.messages, messages)
  assert.equal(counters.attempts, 0)
  assert.equal(counters.failures, 0)
  assert.deepEqual(reports.map(entry => entry.code), ['no-route'])
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
