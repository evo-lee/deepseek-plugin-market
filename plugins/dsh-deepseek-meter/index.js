/**
 * Host half of `dsh-deepseek-meter`.
 *
 * Answers one authenticated, owner-only GET route for the Client pill:
 *   GET /api/deepseek-meter/state[?refresh=1]
 *
 * - Balance: the public DeepSeek API endpoint `GET /user/balance`, called with
 *   the key stored under the `DEEPSEEK_API_KEY` credential reference (or the
 *   environment variable of the same name). Nothing else is read or stored.
 * - Usage: today's provider-reported token usage folded from session logs
 *   through `ctx.sessionQuery`, scoped to DeepSeek providers/models. No usage
 *   endpoint exists in DeepSeek's public API, so this counts the calls this
 *   machine made instead of guessing. Fork-inherited prefixes are skipped so a
 *   branch cannot bill its parent's calls twice.
 *
 * Both sources are best-effort: a missing key, a failing endpoint, or an
 * absent query backend reports a status the Client renders as a reason rather
 * than a number.
 */

/** Public DeepSeek API origin. */
const DEFAULT_ORIGIN = 'https://api.deepseek.com'
/** Credential reference consulted before the process environment. */
const DEFAULT_KEY_REF = 'DEEPSEEK_API_KEY'
/** Exact path under the shared `/api` channel owned by this plugin. */
const ROUTE_PATH = '/api/deepseek-meter/state'
/** Reuse a collected snapshot for this long unless the caller forces a refresh. */
const CACHE_MS = 20_000
/** Upper bound on session logs read in one collection. */
const MAX_SESSIONS = 60
/** Old sessions may still carry today's events; read logs created this recently. */
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000
/** Balance request deadline. */
const REQUEST_TIMEOUT_MS = 10_000

/**
 * Published **peak** rates per million tokens, taken from the DeepSeek pricing
 * page on 2026-11-18. Off-peak is exactly half of peak for every row, so the
 * table carries one set of numbers per currency. A row `config.pricing` value
 * overrides individual models when DeepSeek changes prices.
 */
const DEFAULT_PRICING = {
  CNY: {
    'deepseek-flash': { hit: 0.04, miss: 2, out: 8 },
    'deepseek-v4-pro': { hit: 0.3, miss: 9, out: 27 },
  },
  USD: {
    'deepseek-flash': { hit: 0.006, miss: 0.3, out: 1.2 },
    'deepseek-v4-pro': { hit: 0.044, miss: 1.32, out: 3.96 },
  },
}
/** Retired model names still served and billed at the Flash rate. */
const MODEL_ALIASES = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
}
/** Currencies the rate card covers; both are priced for every response. */
const PRICED_CURRENCIES = ['CNY', 'USD']
/** Beijing is a fixed UTC+8 offset, so peak-hour checks need no time-zone database. */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

/**
 * Register the state route once the Host connection carrier exists.
 *
 * The connection service is provided after the loader has activated its rows,
 * so reading it once at activation can miss it and leave the route unregistered
 * for the rest of the process. `ctx.inject` runs the body when the dependency
 * becomes available instead, however late that is.
 *
 * @param ctx - plugin context.
 * @param config - optional row configuration (`apiKeyRef`, `origin`, `providers`, `pricing`).
 */
export function apply(ctx, config) {
  ctx.inject(['connection'], (ctx) => {
    const connection = ctx.get('connection')
    if (connection === undefined || typeof connection.fetch?.register !== 'function') {
      // No browser carrier in this composition: the Client pill cannot exist either.
      return
    }
    const options = config !== null && typeof config === 'object' ? config : {}
    const origin = typeof options.origin === 'string' ? options.origin : DEFAULT_ORIGIN
    const keyRef = typeof options.apiKeyRef === 'string' ? options.apiKeyRef : DEFAULT_KEY_REF
    const providers = providersOf(options.providers)
    const pricing = pricingOf(options.pricing)

    let cache

    /** Collect the current snapshot, reusing the last one inside the cache window. */
    const snapshot = async (force) => {
      if (!force && cache !== undefined && Date.now() - cache.at < CACHE_MS) return cache.body
      const [balance, usage] = await Promise.all([readBalance(ctx, origin, keyRef), readUsage(ctx, providers, pricing)])
      const body = { version: 1, fetchedAt: Date.now(), balance, usage }
      cache = { at: Date.now(), body }
      return body
    }

    ctx.effect(() => connection.fetch.register({
      path: ROUTE_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body
        try {
          const force = new URL(request.url).searchParams.get('refresh') === '1'
          body = await snapshot(force)
        } catch (error) {
          body = {
            version: 1,
            fetchedAt: Date.now(),
            balance: { status: 'error', reason: describe(error) },
            usage: { status: 'error', reason: describe(error) },
          }
        }
        return new Response(JSON.stringify(body), {
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        })
      },
    }), 'deepseek-meter: state route')
  })
}

/**
 * Resolve the API key from the credential store, then the process environment.
 * @returns the key text, or undefined when neither source has one.
 */
async function resolveKey(ctx, keyRef) {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined && typeof credentials.resolve === 'function') {
    const hit = await credentials.resolve(keyRef)
    if (hit !== null && typeof hit === 'object' && typeof hit.value === 'string' && hit.value.length > 0) {
      return hit.value
    }
  }
  const fromEnv = process.env[keyRef]
  return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : undefined
}

/**
 * Query the public balance endpoint.
 * @returns a status-tagged balance summary; never throws.
 */
async function readBalance(ctx, origin, keyRef) {
  let key
  try {
    key = await resolveKey(ctx, keyRef)
  } catch (error) {
    return { status: 'error', reason: describe(error) }
  }
  if (key === undefined) {
    return { status: 'unconfigured', reason: `missing-credential:${keyRef}` }
  }
  try {
    const response = await fetch(`${origin}/user/balance`, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) {
      return { status: 'error', reason: `http-${response.status}` }
    }
    const payload = await response.json()
    const infos = Array.isArray(payload?.balance_infos) ? payload.balance_infos : []
    return {
      status: 'ready',
      isAvailable: payload?.is_available === true,
      wallets: infos
        .filter(info => info !== null && typeof info === 'object')
        .map(info => ({
          currency: typeof info.currency === 'string' ? info.currency : 'CNY',
          total: decimal(info.total_balance),
          granted: decimal(info.granted_balance),
          toppedUp: decimal(info.topped_up_balance),
        })),
      at: Date.now(),
    }
  } catch (error) {
    return { status: 'error', reason: describe(error) }
  }
}

/**
 * Fold today's provider-reported usage out of session logs and price it with the
 * published DeepSeek rate card: peak hours at full rate, off-peak at half.
 * @returns a status-tagged usage summary; never throws.
 */
async function readUsage(ctx, providers, pricing) {
  const query = ctx.get('sessionQuery')
  if (query === undefined || typeof query.listSessions !== 'function' || typeof query.readSession !== 'function') {
    return { status: 'unavailable', reason: 'missing-session-query' }
  }
  const start = startOfToday()
  const totals = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0, sessions: 0 }
  const spent = { CNY: 0, USD: 0 }
  const byModel = new Map()
  const unpriced = new Set()
  let read = 0
  let skipped = 0
  try {
    const records = await query.listSessions()
    const candidates = (Array.isArray(records) ? records : [])
      .filter(record => createdAt(record) >= start - LOOKBACK_MS)
      .slice(0, MAX_SESSIONS)
    for (const record of candidates) {
      const id = record?.header?.id ?? record?.id
      if (typeof id !== 'string') continue
      let snapshot
      try {
        snapshot = await query.readSession(id)
      } catch {
        skipped += 1
        continue
      }
      const all = Array.isArray(snapshot) ? snapshot : Array.isArray(snapshot?.events) ? snapshot.events : []
      // A fork copies its parent's prefix with the original timestamps; count only owned events.
      const inherited = Number.isSafeInteger(snapshot?.inheritedEventCount) && snapshot.inheritedEventCount > 0
        ? Math.min(snapshot.inheritedEventCount, all.length)
        : 0
      let touched = false
      for (const event of all.slice(inherited)) {
        if (event?.type !== 'assistant/message') continue
        if (typeof event.time !== 'number' || event.time < start) continue
        const usage = event.data?.usage
        if (usage === null || typeof usage !== 'object') continue
        if (!matchesProvider(event.data?.message, providers)) continue
        const input = count(usage.inputTokens)
        const cacheRead = count(usage.cacheReadTokens)
        const cacheWrite = count(usage.cacheWriteTokens)
        const output = count(usage.outputTokens)
        const buckets = input + cacheRead + cacheWrite + output
        const reported = count(usage.totalTokens)
        const total = reported > 0 ? reported : buckets
        if (total === 0) continue
        totals.inputTokens += input
        totals.cacheReadTokens += cacheRead
        totals.cacheWriteTokens += cacheWrite
        totals.outputTokens += output
        totals.totalTokens += total
        totals.calls += 1
        touched = true

        const model = typeof event.data?.message?.source?.model === 'string' && event.data.message.source.model.length > 0
          ? event.data.message.source.model
          : 'unknown'
        const bucket = byModel.get(model) ?? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 }
        bucket.input += input
        bucket.cacheRead += cacheRead
        bucket.cacheWrite += cacheWrite
        bucket.output += output
        bucket.calls += 1
        byModel.set(model, bucket)

        const rates = ratesFor(pricing, model)
        if (rates === undefined) {
          unpriced.add(model)
          continue
        }
        // The rate depends on when the call happened, not on when it was read.
        const factor = isPeak(event.time) ? 1 : 0.5
        for (const currency of PRICED_CURRENCIES) {
          const table = rates[currency]
          if (table === undefined) continue
          spent[currency] += priceOf(table, { input, cacheRead, cacheWrite, output }) * factor / 1_000_000
        }
      }
      if (touched) totals.sessions += 1
      read += 1
    }
    return {
      status: 'ready',
      since: start,
      ...totals,
      providers,
      models: [...byModel].map(([model, bucket]) => ({ model, ...bucket })),
      cost: {
        status: unpriced.size === 0 ? 'ready' : 'partial',
        CNY: round4(spent.CNY),
        USD: round4(spent.USD),
        unpriced: [...unpriced],
      },
      scannedSessions: read,
      skippedSessions: skipped,
    }
  } catch (error) {
    return { status: 'error', reason: describe(error) }
  }
}

/**
 * Merge a row's `pricing` override over the published rate card.
 * @param value - optional `{ CNY: { model: { hit, miss, out } }, USD: {...} }`.
 * @returns a complete table for every priced currency.
 */
function pricingOf(value) {
  const merged = { CNY: { ...DEFAULT_PRICING.CNY }, USD: { ...DEFAULT_PRICING.USD } }
  if (value === null || typeof value !== 'object') return merged
  for (const currency of PRICED_CURRENCIES) {
    const table = value[currency]
    if (table === null || typeof table !== 'object') continue
    for (const [model, rates] of Object.entries(table)) {
      if (rates === null || typeof rates !== 'object') continue
      const hit = Number(rates.hit)
      const miss = Number(rates.miss)
      const out = Number(rates.out)
      if (!Number.isFinite(hit) || !Number.isFinite(miss) || !Number.isFinite(out)) continue
      merged[currency][normalizeModel(model)] = { hit, miss, out }
    }
  }
  return merged
}

/** Peak rates for one model, or undefined when the model is not on the card. */
function ratesFor(pricing, model) {
  const name = normalizeModel(model)
  if (name === '') return undefined
  const keys = Object.keys(pricing.CNY)
  // Tolerate date-suffixed ids such as `deepseek-flash-1017`.
  const key = keys.includes(name) ? name : keys.find(candidate => name.startsWith(candidate))
  return key === undefined ? undefined : { CNY: pricing.CNY[key], USD: pricing.USD[key] }
}

/** Lower-case model id with the `deepseek/` prefix and retired aliases resolved. */
function normalizeModel(model) {
  const lower = model.toLowerCase()
  const bare = lower.startsWith('deepseek/') ? lower.slice('deepseek/'.length) : lower
  return MODEL_ALIASES[bare] ?? bare
}

/**
 * Whether a call at `time` falls in a peak billing window: Beijing time
 * 09:00–12:00 and 14:00–18:00, Monday to Friday. Chinese public holidays are
 * off-peak as well, but their dates change yearly, so they are counted as peak
 * here — that can only overstate the estimate, never hide real spending.
 */
function isPeak(time) {
  const local = new Date(time + BEIJING_OFFSET_MS)
  const day = local.getUTCDay()
  if (day === 0 || day === 6) return false
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes()
  return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60)
}

/** Cost in the currency's unit for one response, before the peak/idle factor. */
function priceOf(rates, tokens) {
  return tokens.input * rates.miss
    + tokens.cacheRead * rates.hit
    + tokens.cacheWrite * rates.miss
    + tokens.output * rates.out
}

/** Keep four decimals so a sub-cent day still reads as a number, not as zero. */
function round4(value) {
  return Math.round(value * 1e4) / 1e4
}

/** Local-midnight Unix epoch milliseconds for the host time zone. */
function startOfToday() {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
}

/** Session creation time from either record shape. */
function createdAt(record) {
  const value = record?.header?.createdAt ?? record?.createdAt
  return typeof value === 'number' ? value : 0
}

/** Non-negative safe-integer token count, or 0 for anything else. */
function count(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/** Keep the server's decimal string; null when the value is not numeric text. */
function decimal(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) ? value : null
}

/** Normalize the configured provider prefixes used to scope `今日` to DeepSeek. */
function providersOf(value) {
  const list = Array.isArray(value) ? value : []
  const cleaned = list.filter(item => typeof item === 'string' && item.length > 0).map(item => item.toLowerCase())
  return cleaned.length > 0 ? cleaned : ['deepseek']
}

/** Whether one assistant message was produced by a configured provider or model. */
function matchesProvider(message, providers) {
  const source = message?.source
  const provider = typeof source?.provider === 'string' ? source.provider.toLowerCase() : ''
  const model = typeof source?.model === 'string' ? source.model.toLowerCase() : ''
  return providers.some(prefix => prefix === '*' || (provider !== '' && provider.startsWith(prefix)) || (model !== '' && model.startsWith(prefix)))
}

/** Short machine-readable reason for a caught failure. */
function describe(error) {
  if (error instanceof Error) return error.name === 'TimeoutError' ? 'timeout' : error.message.slice(0, 200)
  return String(error).slice(0, 200)
}

/**
 * Pure pricing helpers exposed so `test/state.test.mjs` can pin the rate card
 * without a live session log. The Host never reads this export.
 */
export const internals = { isPeak, priceOf, ratesFor, pricingOf, normalizeModel, DEFAULT_PRICING }

