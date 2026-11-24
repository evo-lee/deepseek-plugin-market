/**
 * Client half of `dsh-english-buddy`.
 *
 * One `conversation.composer.dock` entry: a quiet pill that says how many
 * prompts were rewritten today and, on hover, exactly what changed. It reads
 * the Host route this bundle's `index.js` registers.
 *
 * The pill renders nothing at all on a day with no rewrites — absence of a
 * correction is the signal, the same way the original plugin treats silence as
 * "your English was fine".
 */

window.__ModuleLoader__.load({
  id: 'dsh-english-buddy',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const NS = 'englishBuddy'
    const SLOT = 'conversation.composer.dock'
    /** Chain slot above one user bubble; owner supplies the durable message `source`. */
    const SLOT_USER_BEFORE = 'conversation.chat.user.before'
    const STATE_URL = '/api/english-buddy/state'
    const DETAIL_ID = 'dsh-english-buddy-detail'
    const POLL_MS = 15_000
    const TIMEOUT_MS = 15_000

    const copy = {
      zh: {
        corrected: '修正',
        translate: '重述',
        refine: '重写',
        unavailable: '纠错未启用',
        today: '今日',
        englishPrompts: '英文提示',
        clean: '无错',
        rate: '更正率',
        recent: '最近改写',
        failed: '最近失败',
        failedTail: '次（原文已保留）',
        literal: '因改动代码/数字/引号内容而放弃',
        literalTail: '次',
        noRoute: '没有可用的 DeepSeek 路由（deepseek-account / deepseek-official 均不可用）',
        loading: '读取中…',
        clickToRefresh: '点击刷新',
        refreshFailed: '刷新失败',
        staleNote: '显示上次成功读取的数据',
        updatedAt: '更新于',
        hintNote: '以下只是提示，没有改动你的 prompt',
        modeCorrect: '纠错',
        modeEnglish: '译为英文',
        modeRefine: '重写',
        youWrote: '你写的',
        lastIssue: '最近一次降级',
        historyDegraded: '⚠ 历史读写失败，只统计本进程的记录',
      },
      en: {
        corrected: 'fix',
        translate: 'restated',
        refine: 'refined',
        unavailable: 'Coaching unavailable',
        today: 'Today',
        englishPrompts: 'English prompts',
        clean: 'clean',
        rate: 'correction rate',
        recent: 'Recent rewrites',
        failed: 'Recent failures',
        failedTail: '(prompt kept unchanged)',
        literal: 'Rewrites rejected for changing code/numbers/quotes',
        literalTail: '',
        noRoute: 'No DeepSeek route available (neither deepseek-account nor deepseek-official)',
        loading: 'Reading…',
        clickToRefresh: 'Click to refresh',
        refreshFailed: 'Refresh failed',
        staleNote: 'Showing the last successful reading',
        updatedAt: 'Updated',
        hintNote: 'These are hints only; your prompt was not changed',
        modeCorrect: 'fix',
        modeEnglish: 'restated',
        modeRefine: 'refined',
        youWrote: 'You wrote',
        lastIssue: 'Last degraded path',
        historyDegraded: 'History could not be read or written; counting this process only',
      },
    }

    /** Map a stored mode onto its short label. */
    const modeLabel = (t, mode) => {
      if (mode === 'english') return t('modeEnglish')
      if (mode === 'refine') return t('modeRefine')
      return t('modeCorrect')
    }

    /** Pill text: how much was rewritten today, in the fewest words that fit. */
    const heading = (t, today) => {
      const corrected = today?.corrected ?? 0
      const translated = today?.translated ?? 0
      const refined = today?.refined ?? 0
      const parts = []
      if (corrected > 0) parts.push(`${t('corrected')} ${corrected}`)
      if (translated > 0) parts.push(`${t('translate')} ${translated}`)
      if (parts.length === 0 && refined > 0) parts.push(`${t('refine')} ${refined}`)
      return parts.join(' · ')
    }

    /** Whether today produced anything worth a pill at all. */
    const hasActivity = data => {
      const today = data?.today
      if (today === undefined) return false
      return (today.corrected ?? 0) + (today.translated ?? 0) + (today.refined ?? 0) > 0
    }

    /** Multi-line tooltip text. */
    const detailText = (t, state) => {
      const lines = []
      if (state.status === 'loading') {
        lines.push(t('loading'))
        return lines.join('\n')
      }
      const data = state.data
      if (data?.coach?.status !== 'ready') {
        lines.push(t('unavailable'))
        lines.push(data?.coach?.reason === 'no-route' ? t('noRoute') : String(data?.coach?.reason ?? t('unavailable')))
      } else {
        const today = data?.today ?? {}
        const rate = Math.round((today.rate ?? 0) * 100)
        lines.push(`${t('today')} — ${data.coach.model} · ${data.coach.provider}`)
        lines.push(`${t('englishPrompts')} ${today.prompts ?? 0} · ${t('corrected')} ${today.corrected ?? 0} (${rate}%) · ${t('clean')} ${today.clean ?? 0}`)
        const restored = `${t('translate')} ${today.translated ?? 0} · ${t('refine')} ${today.refined ?? 0}`
        if ((today.translated ?? 0) + (today.refined ?? 0) > 0) lines.push(restored)

        const recent = Array.isArray(data.recent) ? data.recent : []
        if (recent.length > 0) {
          lines.push(null)
          lines.push(t('recent'))
          for (const entry of recent) {
            lines.push(`• ${modeLabel(t, entry.mode)}  ${entry.before} → ${entry.after}`)
            for (const note of Array.isArray(entry.notes) ? entry.notes : []) {
              const category = note.category ? `   (${note.category})` : ''
              lines.push(`    ${note.wrong} → ${note.right}${category}`)
            }
            if (Array.isArray(entry.hints) && entry.hints.length > 0) {
              lines.push(`    ${t('hintNote')}`)
              for (const hint of entry.hints) lines.push(`    ? ${hint}`)
            }
          }
        }
        const counters = data.counters ?? {}
        if ((counters.failures ?? 0) > 0) {
          lines.push(null)
          lines.push(`${t('failed')} ${counters.failures} ${t('failedTail')}`)
        }
        if ((counters.literalRejected ?? 0) > 0) {
          lines.push(`${t('literal')} ${counters.literalRejected} ${t('literalTail')}`.trimEnd())
        }
      }

      const diagnostics = data?.diagnostics
      if (diagnostics?.last !== undefined && diagnostics.last !== null) {
        lines.push(null)
        const tail = typeof diagnostics.last.message === 'string' && diagnostics.last.message.length > 0
          ? ` — ${diagnostics.last.message}`
          : ''
        lines.push(`${t('lastIssue')}: ${diagnostics.last.code}${tail}`)
      }
      if (data?.store?.degraded === true) lines.push(t('historyDegraded'))

      if (state.status === 'stale') {
        lines.push(null)
        lines.push(`${t('refreshFailed')}: ${state.reason}`)
        lines.push(t('staleNote'))
      } else {
        lines.push(null)
        lines.push(`${t('updatedAt')} ${clock(data?.fetchedAt)} · ${t('clickToRefresh')}`)
      }
      return lines.filter(line => line !== undefined).join('\n')
    }

    /** Short local clock, following the UI language. */
    const clock = at => {
      const date = new Date(Number.isFinite(at) ? at : Date.now())
      const lang = document?.documentElement?.lang || 'zh-CN'
      return date.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' })
    }

    /** The dock pill. */
    function BuddyPill(props) {
      const t = props.t
      const [state, setState] = useState({ status: 'loading' })
      const [hover, setHover] = useState(false)
      const alive = useRef(true)
      const inFlight = useRef(undefined)

      const load = useCallback(async force => {
        inFlight.current?.abort()
        const controller = new AbortController()
        inFlight.current = controller
        const signal = typeof AbortSignal.any === 'function' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.any([controller.signal, AbortSignal.timeout(TIMEOUT_MS)])
          : controller.signal
        try {
          const response = await fetch(STATE_URL, { headers: { accept: 'application/json' }, credentials: 'same-origin', signal })
          if (!response.ok) throw new Error(`http-${response.status}`)
          const data = await response.json()
          if (!alive.current) return
          setState({ status: 'ready', data })
        } catch (error) {
          if (!alive.current) return
          if (error?.name === 'AbortError') return
          const reason = error?.name === 'TimeoutError' ? 'timeout' : String(error?.message ?? error)
          setState(previous => (previous.data === undefined
            ? { status: 'error', reason }
            : { status: 'stale', data: previous.data, reason }))
        } finally {
          if (inFlight.current === controller) inFlight.current = undefined
        }
      }, [])

      useEffect(() => {
        alive.current = true
        void load(false)
        const timer = setInterval(() => {
          if (document?.visibilityState === 'hidden') return
          void load(false)
        }, POLL_MS)
        const onVisible = () => {
          if (document?.visibilityState === 'visible') void load(false)
        }
        document?.addEventListener?.('visibilitychange', onVisible)
        return () => {
          alive.current = false
          clearInterval(timer)
          document?.removeEventListener?.('visibilitychange', onVisible)
          inFlight.current?.abort()
        }
      }, [load])

      const data = state.data
      const unavailable = state.status !== 'loading' && data?.coach?.status !== 'ready'
      const active = state.status === 'loading' ? false : hasActivity(data)
      // Silence is the signal: nothing to say while loading, on a clean day, or on a fetch error.
      if (state.status === 'loading' || state.status === 'error') return null
      if (!active && !unavailable) return null

      const headingText = unavailable ? t('unavailable') : heading(t, data?.today)
      if (headingText.length === 0 && !unavailable) return null
      const text = `✎ ${headingText}`

      return h('button', {
        type: 'button',
        title: detailText(t, state),
        'aria-describedby': DETAIL_ID,
        onClick: () => { void load(true) },
        // Keep the composer's draft, selection and caret focus where the user left them.
        onMouseDown: event => event.preventDefault(),
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          minWidth: 0,
          maxWidth: '100%',
          padding: '1px 8px',
          border: 'none',
          borderRadius: 'var(--dsw-radius-sm)',
          background: hover ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
          color: unavailable
            ? 'var(--dsw-alias-state-warn-label)'
            : hover ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-label-tertiary)',
          fontFamily: 'inherit',
          fontWeight: 400,
          fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
          lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
          cursor: 'pointer',
          userSelect: 'none',
          opacity: state.status === 'loading' ? 0.7 : 1,
          transition: 'opacity 120ms ease, background-color 120ms ease',
        },
      },
      h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 } }, text),
      h('span', {
        id: DETAIL_ID,
        style: {
          position: 'absolute',
          width: '1px',
          height: '1px',
          margin: '-1px',
          padding: 0,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
          whiteSpace: 'nowrap',
          border: 0,
        },
      }, detailText(t, state)))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        let t = key => copy.zh[key] ?? key
        let localized = false
        try {
          ctx.effect(() => ctx.locale.register(NS, copy), 'english-buddy: copy')
          const bound = ctx.locale.bind(NS)
          if (typeof bound === 'function') {
            t = bound
            localized = true
          }
        } catch {
          // Keep the literal Chinese fallback so the pill still renders.
        }
        const options = { name: SLOT, id: 'english-buddy', order: 3 }
        if (localized) options.locale = NS
        ctx.slots.inject(SLOT, () => ctx.slots.register(options, () => h(BuddyPill, { t })))

        // The rewrite keeps the user's own wording on the message source, which
        // the model never sees. Render it above the bubble so the transcript
        // still shows what was actually typed.
        function OriginalNote(props) {
          const note = props?.matched
          if (note === null || typeof note !== 'object' || typeof note.before !== 'string' || note.before.length === 0) return null
          return h('div', {
            title: note.before,
            style: {
              alignSelf: 'flex-end',
              maxWidth: '100%',
              margin: '0 2px 4px',
              color: 'var(--dsw-alias-label-caption)',
              fontFamily: 'inherit',
              fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 2px)',
              lineHeight: 1.45,
              textAlign: 'right',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              overflow: 'hidden',
              display: '-webkit-box',
              WebkitLineClamp: 3,
              WebkitBoxOrient: 'vertical',
            },
          }, `${t('youWrote')} · ${note.before}`)
        }

        try {
          ctx.slots.inject(SLOT_USER_BEFORE, () => ctx.slots.register({
            name: SLOT_USER_BEFORE,
            id: 'english-buddy-original',
            priority: 100,
            select: owner => {
              if (owner === null || typeof owner !== 'object' || owner.kind !== 'user') return null
              const note = owner.source?.englishBuddy
              if (note === null || typeof note !== 'object') return null
              return typeof note.before === 'string' && note.before.length > 0 ? note : null
            },
          }, OriginalNote))
        } catch {
          // The annotation is a convenience; never let it cost the transcript.
        }
      },
    }
  },
})
