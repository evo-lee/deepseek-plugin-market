/**
 * Host half of `dsh-english-buddy`.
 *
 * Wiring only: it validates the row config, opens the history store, and
 * registers the three surfaces the plugin exposes —
 *
 *   - the `agent/pre-step` listener from `pipeline.js`, which rewrites a human
 *     prompt into better English before the model sees it;
 *   - two report commands;
 *   - `GET /api/english-buddy/state` for the composer pill.
 *
 * Coaching is an auxiliary `deepseek-flash` call through `ctx.llm`, so no second
 * credential exists. A missing route, a timeout, an unparsable answer, or a
 * rewrite that drops a protected literal all fall back to the prompt exactly as
 * the user typed it.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { normalizeConfig } from './coach.js'
import { createReporter } from './diagnostics.js'
import { createPipeline } from './pipeline.js'
import { createStore, dayKey, describeRecord, formatStats, formatToday, summarize } from './store.js'

/** Plugin name used by the loader. */
export const name = 'english-buddy'

/** State route consumed by the composer pill. */
const ROUTE_PATH = '/api/english-buddy/state'

/** Resolve `$DSH_HOME/english-buddy`, matching the Harness home precedence. */
function historyRoot() {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return join(configured.length > 0 ? configured : join(homedir(), '.dsh'), 'english-buddy')
}

/**
 * Install the coaching pipeline for this plugin's lifetime.
 * @param ctx - plugin context.
 * @param config - the `english-buddy` row configuration.
 */
export function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  let logger
  try {
    logger = typeof ctx.logger === 'function' ? ctx.logger('english-buddy') : undefined
  } catch {
    logger = undefined
  }
  const reporter = createReporter(logger)
  const store = createStore(historyRoot(), {
    retentionDays: cfg.retentionDays,
    onError: (code, error) => reporter.report(code, error),
  })
  const counters = { attempts: 0, failures: 0, literalRejected: 0 }
  let llmService

  try {
    store.init()
    store.prune()
  } catch (error) {
    // Housekeeping only; neither step may stop the plugin from loading.
    reporter.report('store-init-failed', error)
  }

  const pipeline = createPipeline({
    cfg,
    store,
    counters,
    getLlm: () => llmService,
    report: (code, error) => reporter.report(code, error),
  })

  /** Warning prefix for a report whose numbers may be incomplete. */
  const historyWarning = () => store.degraded
    ? '⚠ 历史读取或写入失败，下面的数字可能不完整（原因见 /english-buddy-stats 与插件日志）。\n\n'
    : ''

  ctx.inject(['llm'], scope => {
    llmService = scope.get('llm')
    scope.effect(() => scope.on('agent/pre-step', pipeline.listener), 'english-buddy: pre-step')
    scope.effect(() => scope.on('llm/models-updated', pipeline.invalidateRoute), 'english-buddy: route cache')
  })

  ctx.inject(['commands'], scope => {
    const commands = scope.get('commands')
    scope.effect(() => commands.register({
      name: 'english-buddy-today',
      description: '今日英文纠错与重述报告',
      handler: async () => {
        const records = store.readDay(dayKey())
        return { kind: 'success', text: `${historyWarning()}${formatToday(dayKey(), summarize(records), records)}` }
      },
    }), 'english-buddy: today command')
    scope.effect(() => commands.register({
      name: 'english-buddy-stats',
      description: '近 7 / 30 天英文更正率趋势',
      handler: async () => {
        const short = store.readWindow(7).records
        const long = store.readWindow(30).records
        const diagnostics = reporter.snapshot()
        const lastLine = diagnostics.last === null
          ? ''
          : `\n\n最近一次降级：${diagnostics.last.code}${diagnostics.last.message === null ? '' : ` — ${diagnostics.last.message}`}`
        return { kind: 'success', text: `${historyWarning()}${formatStats(summarize(short), summarize(long), 30)}${lastLine}` }
      },
    }), 'english-buddy: stats command')
  })

  ctx.inject(['connection'], scope => {
    const connection = scope.get('connection')
    if (connection === undefined || typeof connection.fetch?.register !== 'function') return
    scope.effect(() => connection.fetch.register({
      path: ROUTE_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        const records = store.readDay(dayKey())
        const recent = records
          .filter(record => record.mode === 'correct' || record.mode === 'english' || record.mode === 'refine')
          .slice(-5)
          .reverse()
          .map(describeRecord)
        const route = llmService === undefined
          ? undefined
          : await pipeline.routeOf(llmService).catch(error => {
            reporter.report('route-probe-failed', error)
            return undefined
          })
        const body = {
          version: 1,
          fetchedAt: Date.now(),
          coach: route === undefined
            ? { status: 'unavailable', reason: 'no-route', provider: null, model: cfg.model }
            : { status: 'ready', reason: null, provider: route.provider, model: route.model },
          today: summarize(records),
          recent,
          counters: { ...counters },
          diagnostics: reporter.snapshot(),
          store: { degraded: store.degraded },
          authoritative: cfg.authoritative,
        }
        return new Response(JSON.stringify(body), {
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        })
      },
    }), 'english-buddy: state route')
  })
}
