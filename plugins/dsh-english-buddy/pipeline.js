/**
 * The coaching pipeline for `dsh-english-buddy`, isolated from Cordis so the
 * pre-step rewrite can be tested without a Host.
 *
 * `createPipeline()` owns the route probe, the auxiliary model call, and the
 * pre-step listener. It is given a store, a config, a counter bag, and a getter
 * for the LLM service; it owns nothing else.
 */

import { randomUUID } from 'node:crypto'

import {
  appendContextMessage,
  buildSystem,
  parseOutput,
  pickCoachable,
  planMode,
  preservesLiterals,
  replaceText,
  sampledIn,
  wordDiff,
} from './coach.js'

/** Route ids that can serve the coaching model, in preference order. */
const ROUTE_CANDIDATES = ['deepseek-account', 'deepseek-official']

/** How long a route probe is trusted. */
const ROUTE_TTL_MS = 60_000

/** Ceiling on one coaching response, independent of the token cap. */
const MAX_OUTPUT_CHARS = 8_000

/** Frame an injected coaching message for the model (the `original` strategy). */
function contextText(mode, text) {
  if (mode === 'english') return `Translated prompt: ${text}`
  if (mode === 'refine') {
    return `The user requested prompt refinement. Suggested wording: ${text}\nPreserve the original request's constraints whenever wording differs.`
  }
  return `Corrected prompt: ${text}`
}

/**
 * Whether an agent drives a top-level session rather than a subagent child.
 *
 * Subagent prompts are submitted with `source.kind === 'user'`, so the source
 * alone cannot tell them apart from a human prompt; the session header can.
 * Coaching a delegation prompt would waste a call and rewrite instructions the
 * user never typed. An unreadable header is treated as top-level.
 */
function isTopLevel(agent) {
  const header = agent?.session?.header
  if (header === null || typeof header !== 'object') return true
  if (header.origin === 'subagent') return false
  return !(typeof header.delegationDepth === 'number' && header.delegationDepth > 0)
}

/** Whether the caller's own signal (not the deadline) ended the request. */
function cancelled(signal) {
  return signal !== undefined && signal.aborted
}

/**
 * Build the pipeline.
 *
 * @param options.cfg - a normalized configuration.
 * @param options.store - anything with `append(record)`.
 * @param options.counters - mutable `{ attempts, failures, literalRejected }`.
 * @param options.getLlm - returns the LLM service or undefined.
 * @param options.report - called as `report(code, error?)` for every failure
 *   that this pipeline degrades on; diagnostics are never silent.
 */
export function createPipeline(options) {
  const { cfg, store, counters } = options
  const getLlm = typeof options.getLlm === 'function' ? options.getLlm : () => undefined
  const report = typeof options.report === 'function' ? options.report : () => {}
  let routeCache

  /** Forget the cached route; called when the model catalog changes. */
  const invalidateRoute = () => { routeCache = undefined }

  /** Resolve the provider/model route that can serve the coaching model. */
  const routeOf = async llm => {
    if (cfg.provider !== null) return { provider: cfg.provider, model: cfg.model }
    const now = Date.now()
    if (routeCache !== undefined && now - routeCache.at < ROUTE_TTL_MS) return routeCache.value
    let value
    try {
      const available = new Set(llm.listProviders().map(row => row.id))
      for (const provider of ROUTE_CANDIDATES) {
        if (!available.has(provider)) continue
        let models = []
        try {
          models = await llm.listModels(provider)
        } catch (error) {
          report('route-probe-failed', error)
          continue
        }
        if (models.some(model => model.id === cfg.model)) {
          value = { provider, model: cfg.model }
          break
        }
      }
    } catch (error) {
      report('route-probe-failed', error)
      value = undefined
    }
    routeCache = { at: now, value }
    return value
  }

  /**
   * Run one coaching request over an already-resolved route.
   *
   * Every way this can fail is a named code, so the caller reports the actual
   * cause instead of a generic "it did not work".
   *
   * @returns `{ ok: true, raw, ms }` or `{ ok: false, code, error? }`.
   */
  const request = async (llm, route, text, mode, signal) => {
    const timeout = AbortSignal.timeout(cfg.timeoutMs)
    const parts = [timeout]
    if (signal !== undefined) parts.push(signal)
    const combined = typeof AbortSignal.any === 'function' ? AbortSignal.any(parts) : timeout
    const started = Date.now()
    let prepared
    try {
      prepared = await llm.prepareCall({
        provider: route.provider,
        model: route.model,
        reasoningEffort: 'off',
        maxTokens: cfg.maxOutputTokens,
      }, combined)
    } catch (error) {
      // Preparation and streaming fail for different reasons; keep them apart.
      return { ok: false, code: cancelled(signal) ? 'aborted' : 'prepare-failed', error }
    }
    try {
      if (prepared === undefined) return { ok: false, code: 'prepare-failed' }
      if (prepared.config?.reasoningEffort !== 'off') return { ok: false, code: 'thinking-required' }

      const limit = Math.max(MAX_OUTPUT_CHARS, [...text].length * 4)
      let deltas = ''
      let blocks = ''
      let terminal
      for await (const chunk of prepared.stream({
        ...prepared.config,
        system: buildSystem(mode, cfg),
        messages: [{ role: 'user', content: [{ type: 'text', text }] }],
        signal: combined,
      })) {
        if (combined.aborted) return { ok: false, code: cancelled(signal) ? 'aborted' : 'timeout' }
        switch (chunk?.type) {
          case 'text-delta':
            deltas += chunk.text
            break
          case 'block-end':
            if (chunk.block?.type !== 'text') return { ok: false, code: 'non-text-output' }
            blocks += chunk.block.text
            break
          case 'block-start':
            if (chunk.blockType !== 'text') return { ok: false, code: 'non-text-output' }
            break
          case 'reasoning-delta':
          case 'tool-call-delta':
            return { ok: false, code: 'non-text-output' }
          case 'finish':
            terminal = chunk.reason
            break
          default:
            break
        }
        if (deltas.length > limit || blocks.length > limit) return { ok: false, code: 'output-limit' }
      }
      if (combined.aborted) return { ok: false, code: cancelled(signal) ? 'aborted' : 'timeout' }
      const kind = terminal?.kind
      if (kind !== 'stop') return { ok: false, code: `finish-${kind ?? 'missing'}` }
      const raw = blocks.length > 0 ? blocks : deltas
      if (raw.trim().length === 0) return { ok: false, code: 'empty-output' }
      return { ok: true, raw, ms: Date.now() - started }
    } catch (error) {
      if (cancelled(signal)) return { ok: false, code: 'aborted' }
      if (timeout.aborted) return { ok: false, code: 'timeout', error }
      return { ok: false, code: 'stream-failed', error }
    }
  }

  /**
   * The `agent/pre-step` listener.
   *
   * Never throws and never rejects a step: every failure path returns the
   * decision it was given, so a broken coach cannot cost the user their prompt.
   */
  const listener = async (payload, next) => {
    const decision = await next()
    if (decision === undefined || decision.kind !== 'enter') return decision
    try {
      if (cfg.mode === 'off') return decision
      if (!isTopLevel(payload?.agent)) return decision
      const signal = payload?.signal
      if (signal !== undefined && signal.aborted) return decision

      const batch = Array.isArray(decision.messages) ? decision.messages : []
      const target = pickCoachable(batch)
      if (target === undefined) return decision

      const plan = planMode(target.text, cfg)
      if (plan.kind === 'skip') return decision
      if (plan.kind === 'pass') {
        if (plan.text.length === 0 || plan.text === target.text) return decision
        return { ...decision, messages: replaceText(batch, target.index, plan.text) }
      }
      if ([...plan.text].length > cfg.maxInputChars) return decision
      if (!sampledIn(plan.text, cfg)) return decision

      const llm = getLlm()
      if (llm === undefined) return decision

      // Probe the route before counting: no configured route is a normal state,
      // not a coaching failure, but it is still recorded for diagnostics.
      const route = await routeOf(llm)
      if (route === undefined) {
        report('no-route')
        return decision
      }

      counters.attempts += 1
      const answered = await request(llm, route, plan.text, plan.kind, signal)
      if (answered.ok !== true) {
        if (answered.code === 'aborted') return decision
        counters.failures += 1
        report(answered.code, answered.error)
        return decision
      }

      const parsed = parseOutput(answered.raw, plan.text)
      if (parsed === undefined) {
        counters.failures += 1
        report('unparsable-output')
        return decision
      }

      const sid = payload?.agent?.id === undefined ? '' : String(payload.agent.id)
      if (parsed.kind === 'clean') {
        store.append({ v: 1, at: Date.now(), sid, mode: 'clean', ms: answered.ms })
        return decision
      }

      if (!preservesLiterals(plan.text, parsed.text)) {
        counters.literalRejected += 1
        store.append({
          v: 1,
          at: Date.now(),
          sid,
          mode: 'literal',
          before: plan.text,
          after: parsed.text,
          ms: answered.ms,
        })
        return decision
      }

      // A correction is shown as the smallest changed units; a cross-language
      // restatement has no word-level diff to show, so it keeps the model's hints only.
      const notes = parsed.notes.length > 0 || plan.kind === 'english'
        ? parsed.notes
        : wordDiff(plan.text, parsed.text)

      store.append({
        v: 1,
        at: Date.now(),
        sid,
        mode: plan.kind,
        before: plan.text,
        after: parsed.text,
        notes,
        hints: parsed.hints,
        ms: answered.ms,
      })

      if (cfg.authoritative === 'original') {
        // The user's text stays the message; the English is extra context.
        const text = `Coaching is supplementary. The original user prompt is authoritative; preserve literal code, names, constraints and intent.\n${contextText(plan.kind, parsed.text)}`
        return { ...decision, messages: appendContextMessage(batch, text, randomUUID()) }
      }
      // Rewrite mode: the model sees English only, while the durable display
      // annotation keeps the user's own wording visible in the transcript.
      return {
        ...decision,
        messages: replaceText(batch, target.index, parsed.text, {
          before: plan.text,
          after: parsed.text,
          mode: plan.kind,
        }),
      }
    } catch (error) {
      counters.failures += 1
      report('listener-error', error)
      return decision
    }
  }

  return { listener, routeOf, request, invalidateRoute }
}
