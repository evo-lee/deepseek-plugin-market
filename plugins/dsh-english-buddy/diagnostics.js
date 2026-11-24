/**
 * Degradation reporting for `dsh-english-buddy`.
 *
 * The plugin is built to fail open: a coaching failure must never cost the user
 * their prompt, and a history failure must never block a turn. Failing open is
 * not the same as failing silently, so every degraded path goes through here:
 * it is written to the Harness log at a severity that matches its meaning, and
 * the most recent ones are kept for the status route and the pill tooltip.
 */

/**
 * Severity per failure code.
 *
 * Codes that describe normal operation (no route configured yet, a cancelled
 * turn, one unreadable history line) stay at debug so a working plugin does not
 * flood the console. Everything else is a warning; an error in our own listener
 * is an error.
 */
export const SEVERITY = {
  'aborted': 'debug',
  'no-route': 'debug',
  'route-probe-failed': 'debug',
  'store-parse-failed': 'debug',
  'listener-error': 'error',
}

/** How many entries the bounded recent list keeps. */
const RECENT_LIMIT = 20

/** How long a repeat of the same code is folded into one log line. */
const DEDUPE_MS = 60_000

/** Longest message kept, so one giant stack cannot bloat a log line. */
const MESSAGE_LIMIT = 300

/**
 * Create one reporter bound to an optional logger.
 * @param logger - a Cordis named logger (`ctx.logger(name)`), or undefined.
 */
export function createReporter(logger) {
  const recent = []
  const codes = new Map()
  let last
  let reportedAt = 0

  const report = (code, error) => {
    const at = Date.now()
    // The same code repeating within a minute is one story, not a flood.
    if (last !== undefined && last.code === code && at - reportedAt < DEDUPE_MS) return last
    reportedAt = at
    const entry = { at, code, message: messageOf(error) }
    last = entry
    recent.push(entry)
    if (recent.length > RECENT_LIMIT) recent.shift()
    codes.set(code, (codes.get(code) ?? 0) + 1)
    const level = SEVERITY[code] ?? 'warn'
    try {
      logger?.[level]?.(`${code}: ${entry.message ?? 'no detail'}`)
    } catch {
      // A logger failure cannot be allowed to break the prompt path either.
    }
    return entry
  }

  return {
    report,
    /** Last entry, recent window, and per-code counts; safe to serialize. */
    snapshot() {
      return { last: last ?? null, recent: recent.slice(-5), codes: Object.fromEntries(codes) }
    },
  }
}

/** Short, serializable message for an unknown caught value. */
export function messageOf(error) {
  if (error === undefined || error === null) return null
  const text = error instanceof Error ? error.message : String(error)
  return text.slice(0, MESSAGE_LIMIT)
}
