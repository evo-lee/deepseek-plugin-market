// Offline harness for dsh-deepseek-meter/index.js: exercises the state route
// with stubbed credentials, sessionQuery and global fetch.
import assert from 'node:assert/strict'

const ROUTE = '/api/deepseek-meter/state'
const todayAt = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime() + 3600_000
const day = 86_400_000

const deepseek = provider => ({ message: { source: { kind: 'model', provider, model: 'deepseek-flash' } } })
const other = { message: { source: { kind: 'model', provider: 'kimi-coding', model: 'kimi-k2' } } }

function message(time, usage, source = deepseek('deepseek-official')) {
  return { type: 'assistant/message', time, data: { ...source, usage } }
}

function makeCtx({ key = 'sk-test', sessions = [] } = {}) {
  const routes = new Map()
  const ctx = {
    get(name) {
      if (name === 'credentials') {
        return key === null ? {} : { resolve: async ref => (ref === 'DEEPSEEK_API_KEY' ? { value: key, source: 'stored' } : undefined) }
      }
      if (name === 'sessionQuery') {
        return {
          listSessions: async () => sessions.map(s => ({ header: { id: s.id, createdAt: s.createdAt }, live: false, persisted: true })),
          readSession: async id => {
            const session = sessions.find(s => s.id === id)
            if (session?.fails === true) throw new Error('corrupt log')
            return session?.snapshot
          },
        }
      }
      if (name === 'connection') return { fetch: { register: route => { routes.set(route.path, route); return () => Promise.resolve() } } }
      return undefined
    },
    effect(fn) { fn() },
    inject(deps, callback) { return callback(ctx) },
  }
  return { ctx, routes }
}

const state = async routes => (await routes.get(ROUTE).fetch(new Request('http://127.0.0.1:1' + ROUTE))).json()

globalThis.fetch = async url => {
  if (String(url).endsWith('/user/balance')) {
    return new Response(JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '42.50', granted_balance: '2.50', topped_up_balance: '40.00' }] }), { status: 200 })
  }
  throw new Error('unexpected url ' + url)
}

const { apply, internals } = await import('../index.js')

// 1. Balance plus owned DeepSeek usage only: forks and other providers excluded.
{
  const events = [
    // Inherited parent prefix (same timestamps, must not be counted again).
    message(todayAt, { inputTokens: 9999, outputTokens: 9999 }),
    message(todayAt, { inputTokens: 9999, outputTokens: 9999 }),
    // Owned events.
    message(todayAt, { inputTokens: 1000, cacheReadTokens: 200, outputTokens: 300, totalTokens: 1500 }),
    message(todayAt + 1000, { inputTokens: 500, outputTokens: 100 }, other),
    message(todayAt + 2000, { inputTokens: 500, outputTokens: 100 }),
    message(todayAt - 2 * day, { inputTokens: 9999, outputTokens: 9999 }),
  ]
  const sessions = [{ id: 's1', createdAt: todayAt - 60_000, snapshot: { inheritedEventCount: 2, events } }]
  const { ctx, routes } = makeCtx({ sessions })
  apply(ctx, {})
  const route = routes.get(ROUTE)
  assert.ok(route, 'route registered')
  assert.deepEqual(route.methods, ['GET'])
  const body = await state(routes)
  assert.equal(body.balance.status, 'ready')
  assert.equal(body.balance.wallets[0].total, '42.50')
  assert.equal(body.usage.status, 'ready')
  assert.equal(body.usage.calls, 2, 'fork prefix, other provider and yesterday excluded')
  assert.equal(body.usage.inputTokens, 1500)
  assert.equal(body.usage.cacheReadTokens, 200)
  assert.equal(body.usage.outputTokens, 400)
  assert.equal(body.usage.totalTokens, 2100, 'reported total wins over bucket sum')
  assert.equal(body.usage.sessions, 1)
  assert.deepEqual(body.usage.providers, ['deepseek'])
  console.log('ok: scoped usage', JSON.stringify(body.usage))
}

// 2. Model-scoped match: a proxy provider id still counts when the model is DeepSeek.
{
  const sessions = [{
    id: 's2',
    createdAt: todayAt,
    snapshot: { events: [message(todayAt, { inputTokens: 7, outputTokens: 3 }, { message: { source: { provider: 'my-proxy', model: 'deepseek-chat' } } })] },
  }]
  const { ctx, routes } = makeCtx({ sessions })
  apply(ctx, {})
  const body = await state(routes)
  assert.equal(body.usage.calls, 1)
  assert.equal(body.usage.totalTokens, 10)
  console.log('ok: model-scoped match')
}

// 3. No credential: unconfigured, no crash, usage still reported.
{
  const { ctx, routes } = makeCtx({ key: null, sessions: [] })
  apply(ctx, {})
  const body = await state(routes)
  assert.equal(body.balance.status, 'unconfigured')
  assert.equal(body.balance.reason, 'missing-credential:DEEPSEEK_API_KEY')
  assert.equal(body.usage.status, 'ready')
  assert.equal(body.usage.totalTokens, 0)
  console.log('ok: unconfigured')
}

// 4. Rejected key: error status, no throw.
{
  globalThis.fetch = async () => new Response('unauthorized', { status: 401 })
  const { ctx, routes } = makeCtx({})
  apply(ctx, {})
  const body = await state(routes)
  assert.equal(body.balance.status, 'error')
  assert.equal(body.balance.reason, 'http-401')
  console.log('ok: rejected key')
}

// 5. One unreadable session does not blank the others.
{
  const sessions = [
    { id: 'bad', createdAt: todayAt, fails: true },
    { id: 'good', createdAt: todayAt, snapshot: { events: [message(todayAt, { inputTokens: 5, outputTokens: 5 })] } },
  ]
  const { ctx, routes } = makeCtx({ sessions })
  // `readSession` throws for `bad`; the loop skips that session only.
  apply(ctx, {})
  const body = await state(routes)
  assert.equal(body.usage.status, 'ready')
  assert.equal(body.usage.calls, 1)
  console.log('ok: resilient to unreadable session')
}

// 6. No connection service: apply is inert.
{
  const routes = new Map()
  const bare = { get: () => undefined, effect: () => {}, inject: (deps, callback) => callback(bare) }
  apply(bare, {})
  assert.equal(routes.size, 0)
  console.log('ok: inert without connection')
}

// 7. The connection arrives after activation: registration waits for it.
{
  const routes = new Map()
  let available
  const later = {
    get: name => (name === 'connection' && available ? available : undefined),
    effect: fn => fn(),
    inject: (deps, callback) => { assert.deepEqual(deps, ['connection']); later.start = () => callback(later) },
  }
  apply(later, {})
  assert.equal(routes.size, 0)
  available = { fetch: { register: route => { routes.set(route.path, route); return () => Promise.resolve() } } }
  later.start()
  assert.equal(routes.size, 1)
  console.log('ok: registers once the connection appears')
}

// 8. Peak windows are Beijing-time weekdays, 09–12 and 14–18.
{
  const beijing = (month, day, hour, minute = 0) => Date.UTC(2026, month - 1, day, hour - 8, minute)
  assert.equal(internals.isPeak(beijing(11, 23, 10)), true, 'Monday 10:00 is peak')
  assert.equal(internals.isPeak(beijing(11, 23, 8, 59)), false, 'Monday 08:59 is off-peak')
  assert.equal(internals.isPeak(beijing(11, 23, 12)), false, 'Monday 12:00 is off-peak')
  assert.equal(internals.isPeak(beijing(11, 23, 17, 59)), true, 'Monday 17:59 is peak')
  assert.equal(internals.isPeak(beijing(11, 23, 18)), false, 'Monday 18:00 is off-peak')
  assert.equal(internals.isPeak(beijing(11, 21, 10)), false, 'Saturday 10:00 is off-peak')
  console.log('ok: peak windows in Beijing time')
}

// 9. Today's spend prices each bucket at the rate of the hour the call happened.
{
  const events = [message(todayAt, { inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 })]
  const sessions = [{ id: 'c1', createdAt: todayAt - 60_000, snapshot: { events } }]
  const { ctx, routes } = makeCtx({ sessions })
  apply(ctx, {})
  const body = await state(routes)
  // Flash peak: 2 + 0.04 + 8 CNY and 0.3 + 0.006 + 1.2 USD per million tokens; off-peak halves both.
  const peak = internals.isPeak(todayAt)
  assert.equal(body.usage.cost.status, 'ready')
  assert.ok(Math.abs(body.usage.cost.CNY - (peak ? 10.04 : 5.02)) < 1e-6, `CNY ${body.usage.cost.CNY} (peak ${peak})`)
  assert.ok(Math.abs(body.usage.cost.USD - (peak ? 1.506 : 0.753)) < 1e-6, `USD ${body.usage.cost.USD}`)
  assert.equal(body.usage.models[0].model, 'deepseek-flash')
  assert.equal(body.usage.models[0].calls, 1)
  console.log('ok: today spend priced at the hour rate')
}

// 10. Retired names bill at the Flash rate; unknown models are reported, not guessed.
{
  const events = [
    message(todayAt, { inputTokens: 1000, outputTokens: 100 }, { message: { source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' } } }),
    message(todayAt, { inputTokens: 1000, outputTokens: 100 }, { message: { source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-unreleased-9' } } }),
  ]
  const sessions = [{ id: 'm1', createdAt: todayAt - 60_000, snapshot: { events } }]
  const { ctx, routes } = makeCtx({ sessions })
  apply(ctx, {})
  const body = await state(routes)
  assert.equal(body.usage.cost.status, 'partial')
  assert.deepEqual(body.usage.cost.unpriced, ['deepseek-unreleased-9'])
  assert.deepEqual(body.usage.models.map(model => model.model).sort(), ['deepseek-unreleased-9', 'deepseek-v4-flash'])
  console.log('ok: aliases priced, unknown models flagged')
}
