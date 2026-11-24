/**
 * Client half of `dsh-deepseek-meter`.
 *
 * One `conversation.composer.dock` entry: an ambient pill under the composer
 * that shows the DeepSeek wallet balance and today's DeepSeek token usage, read
 * from the Host route this bundle's `index.js` registers. Clicking refreshes.
 */
window.__ModuleLoader__.load({
  id: 'dsh-deepseek-meter',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const NS = 'deepseekMeter'
    const SLOT = 'conversation.composer.dock'
    const STATE_URL = '/api/deepseek-meter/state'
    const DETAIL_ID = 'dsh-deepseek-meter-detail'
    const POLL_MS = 60_000
    const TIMEOUT_MS = 15_000
    /** Wallet total at or below which the pill warns. */
    const LOW_BALANCE = 5

    const copy = {
      zh: {
        unit: 'tok',
        loading: '余额读取中…',
        unavailable: '余额与用量不可用',
        balance: '余额',
        today: '今日',
        session: '会话',
        account: 'DeepSeek 余额',
        toppedUp: '充值',
        granted: '赠送',
        input: '输入',
        cacheRead: '缓存命中',
        cacheWrite: '缓存写入',
        output: '输出',
        calls: '调用',
        sessions: '会话',
        times: '次',
        lowBalance: '余额偏低（低于 ¥5）',
        refused: '余额不足，接口可能拒绝调用',
        unconfigured: '未配置 DEEPSEEK_API_KEY',
        cost: '今日花费',
        estimateNote: '按官方价目表估算：空闲时段半价，节假日按高峰计',
        unpriced: '未定价模型',
        noUsage: '会话用量不可用',
        updatedAt: '更新于',
        refreshFailed: '刷新失败',
        clickToRefresh: '点击刷新',
        staleNote: '显示上次成功读取的数据',
        reasonUnauthorized: '密钥无效或已过期',
        reasonForbidden: '无权访问该接口',
        reasonHostMissing: '插件后端未加载',
        reasonThrottled: '请求过于频繁',
        reasonServer: '服务端错误',
        reasonTimeout: '请求超时',
        reasonNetwork: '网络不可用',
        reasonUnknown: '请求失败',
      },
      en: {
        unit: 'tok',
        loading: 'Reading balance…',
        unavailable: 'Balance and usage unavailable',
        balance: 'Balance',
        today: 'Today',
        session: 'Session',
        account: 'DeepSeek balance',
        toppedUp: 'Topped up',
        granted: 'Granted',
        input: 'Input',
        cacheRead: 'Cache hit',
        cacheWrite: 'Cache write',
        output: 'Output',
        calls: 'Calls',
        sessions: 'Sessions',
        times: '',
        lowBalance: 'Low balance (below ¥5)',
        refused: 'Insufficient balance; calls may be rejected',
        unconfigured: 'DEEPSEEK_API_KEY is not configured',
        cost: 'Spent today',
        estimateNote: 'Estimated from the official rate card: off-peak is half price, holidays counted as peak',
        unpriced: 'Unpriced models',
        noUsage: 'Session usage unavailable',
        updatedAt: 'Updated',
        refreshFailed: 'Refresh failed',
        clickToRefresh: 'Click to refresh',
        staleNote: 'Showing the last successful reading',
        reasonUnauthorized: 'Invalid or expired key',
        reasonForbidden: 'Not allowed to read this endpoint',
        reasonHostMissing: 'Plugin host not loaded',
        reasonThrottled: 'Too many requests',
        reasonServer: 'Server error',
        reasonTimeout: 'Request timed out',
        reasonNetwork: 'Network unavailable',
        reasonUnknown: 'Request failed',
      },
    }

    /** Group thousands without depending on a locale bundle. */
    const group = value => {
      if (!Number.isFinite(value)) return '0'
      return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }

    /** Compact token count that promotes units instead of printing `1000K`. */
    const compact = value => {
      if (!Number.isFinite(value) || value <= 0) return '0'
      if (value < 1000) return String(Math.trunc(value))
      const thousands = value / 1000
      const shown = thousands < 10 ? thousands.toFixed(1) : String(Math.round(thousands))
      if (Number(shown) < 1000) return `${shown}K`
      const millions = value / 1_000_000
      return `${millions < 10 ? millions.toFixed(2) : millions.toFixed(1)}M`
    }

    const symbol = currency => (currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : `${currency} `)

    /** Money with grouped integer digits and the server's own decimals. */
    const money = wallet => {
      if (wallet === undefined || wallet.total === null) return undefined
      const [whole, fraction] = wallet.total.split('.')
      const grouped = group(Number(whole))
      const negative = whole.startsWith('-')
      return `${symbol(wallet.currency)}${negative ? `-${grouped.replace('-', '')}` : grouped}${fraction === undefined ? '' : `.${fraction}`}`
    }

    /** Prefer a CNY wallet, otherwise the first wallet with a readable total. */
    const pickWallet = balance => {
      const wallets = Array.isArray(balance?.wallets) ? balance.wallets : []
      return wallets.find(wallet => wallet.currency === 'CNY' && wallet.total !== null)
        ?? wallets.find(wallet => wallet.total !== null)
        ?? wallets[0]
    }

    /** Fixed two decimals with grouped integer digits, for the priced estimate. */
    const amount = value => {
      const rounded = Math.round(value * 100) / 100
      const [whole, cents] = rounded.toFixed(2).split('.')
      return `${group(Number(whole))}.${cents}`
    }

    /**
     * Today's spend in the wallet's own currency, priced by the Host from the
     * official rate card. Undefined when the Host could not price the day.
     */
    const costText = (usage, wallet) => {
      const cost = usage?.cost
      if (cost === null || cost === undefined) return undefined
      const currency = wallet?.currency === 'USD' ? 'USD' : 'CNY'
      const value = cost[currency]
      if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
      return `${symbol(currency)}${amount(value)}`
    }

    const walletNumber = wallet => (wallet === undefined || wallet.total === null ? Number.NaN : Number(wallet.total))

    /** Map a Host failure code onto localized copy, keeping raw codes out of the UI. */
    const reasonText = (t, reason) => {
      const text = typeof reason === 'string' ? reason : ''
      if (text.startsWith('missing-credential:')) return t('unconfigured')
      if (text === 'timeout') return t('reasonTimeout')
      if (text === 'http-401') return t('reasonUnauthorized')
      if (text === 'http-403') return t('reasonForbidden')
      // The route only exists once the Host half registered it; a 404 means it did not.
      if (text === 'http-404' || text === 'http-405') return t('reasonHostMissing')
      if (text === 'http-429') return t('reasonThrottled')
      if (/^http-5\d\d$/.test(text)) return t('reasonServer')
      if (/fetch failed|network|failed to fetch|econnrefused/i.test(text)) return t('reasonNetwork')
      if (text === 'missing-session-query') return t('noUsage')
      return t('reasonUnknown')
    }

    /** Display-time view of the latest state, including the retained last good read. */
    const viewOf = state => {
      const data = state.data
      const balance = data?.balance
      const usage = data?.usage
      const wallet = pickWallet(balance)
      const total = walletNumber(wallet)
      const low = balance?.status === 'ready' && !(balance.isAvailable === false) && Number.isFinite(total) && total <= LOW_BALANCE
      const refused = balance?.status === 'ready' && balance.isAvailable === false
      return { data, balance, usage, wallet, total, low, refused, stale: state.status === 'stale' }
    }

    /** The two summary segments the pill always shows, once data exists. */
    const segments = (t, view) => {
      const balance = view.balance
      let balanceText
      if (balance?.status === 'ready') {
        const amount = money(view.wallet)
        balanceText = `${t('balance')} ${amount === undefined ? '—' : amount}`
      } else {
        balanceText = `${t('balance')} —`
      }
      const usage = view.usage
      const spend = usage?.status === 'ready' ? costText(usage, view.wallet) : undefined
      const usageText = usage?.status !== 'ready'
        ? `${t('cost')} —`
        : spend === undefined
          ? `${t('today')} ${compact(usage.totalTokens ?? 0)} ${t('unit')}`
          : `${t('cost')} ≈${spend}`
      return { balanceText, usageText }
    }

    /** Multi-line detail text for the native tooltip. */
    const detailText = (t, state) => {
      const view = viewOf(state)
      const lines = []
      if (state.status === 'loading') {
        lines.push(t('loading'))
      } else if (state.status === 'error') {
        lines.push(t('unavailable'), reasonText(t, state.reason))
      } else {
        lines.push(t('account'))
        if (view.balance?.status === 'ready') {
          if (view.refused) lines.push(t('refused'))
          if (view.low) lines.push(t('lowBalance'))
          const amount = money(view.wallet)
          lines.push(`${t('balance')} ${amount === undefined ? '—' : amount}`)
          if (view.wallet !== undefined && view.wallet.total !== null) {
            const toppedUp = view.wallet.toppedUp === null ? '—' : view.wallet.toppedUp
            const granted = view.wallet.granted === null ? '—' : view.wallet.granted
            lines.push(`${t('toppedUp')} ${symbol(view.wallet.currency)}${toppedUp} · ${t('granted')} ${symbol(view.wallet.currency)}${granted}`)
          }
        } else if (view.balance?.status === 'unconfigured') {
          lines.push(t('unconfigured'))
        } else {
          lines.push(reasonText(t, view.balance?.reason))
        }

        lines.push(null)
        const usage = view.usage
        if (usage?.status === 'ready') {
          const spend = costText(usage, view.wallet)
          if (spend !== undefined) {
            const partial = usage.cost?.status === 'partial' ? '+' : ''
            lines.push(`${t('cost')} ≈${spend}${partial}`)
          }
          lines.push(`${t('today')} — ${compact(usage.totalTokens ?? 0)} ${t('unit')}`)
          const buckets = [
            `${t('input')} ${group(usage.inputTokens)}`,
            `${t('cacheRead')} ${group(usage.cacheReadTokens)}`,
          ]
          if ((usage.cacheWriteTokens ?? 0) > 0) buckets.push(`${t('cacheWrite')} ${group(usage.cacheWriteTokens)}`)
          buckets.push(`${t('output')} ${group(usage.outputTokens)}`)
          lines.push(buckets.join(' · '))
          const calls = `${t('calls')} ${group(usage.calls)} ${t('times')}`.trim()
          lines.push(`${calls} · ${t('sessions')} ${group(usage.sessions)}`)
          if (spend !== undefined) {
            lines.push(t('estimateNote'))
            if (usage.cost?.status === 'partial' && Array.isArray(usage.cost.unpriced) && usage.cost.unpriced.length > 0) {
              lines.push(`${t('unpriced')} ${usage.cost.unpriced.join(' · ')}`)
            }
          }
        } else {
          lines.push(t('noUsage'))
        }

        if (view.stale) {
          lines.push(null)
          lines.push(`${t('refreshFailed')}: ${reasonText(t, state.reason)}`)
          lines.push(t('staleNote'))
        } else {
          lines.push(null)
          lines.push(`${t('updatedAt')} ${clock(state.data?.fetchedAt)}`)
        }
      }
      lines.push(t('clickToRefresh'))
      return lines.filter(line => line !== undefined).join('\n')
    }

    /** Short local clock, following the UI language rather than the OS default. */
    const clock = at => {
      const date = new Date(Number.isFinite(at) ? at : Date.now())
      const lang = document?.documentElement?.lang || 'zh-CN'
      return date.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' })
    }

    /** Palette driven by the same status the text uses, so colour never contradicts copy. */
    const palette = (state, view) => {
      if (state.status === 'loading') return { text: 'var(--dsw-alias-label-caption)', dot: 'var(--dsw-alias-label-caption)', dim: 0.9 }
      if (state.status === 'error') return { text: 'var(--dsw-alias-state-error-primary)', dot: 'var(--dsw-alias-state-error-primary)', dim: 1 }
      if (view.refused || view.low) return { text: 'var(--dsw-alias-state-warn-label)', dot: 'var(--dsw-alias-state-warn-primary)', dim: 1 }
      if (view.balance?.status !== 'ready') return { text: 'var(--dsw-alias-label-caption)', dot: 'var(--dsw-alias-label-caption)', dim: 1 }
      return { text: 'var(--dsw-alias-label-tertiary)', dot: 'var(--dsw-alias-state-business-primary)', dim: 1 }
    }

    /** Ambient pill: balance · today's tokens, refreshed on click and once a minute. */
    function MeterPill(props) {
      const t = props.t
      const [state, setState] = useState({ status: 'loading' })
      const [busy, setBusy] = useState(false)
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
          const response = await fetch(`${STATE_URL}${force ? '?refresh=1' : ''}`, {
            headers: { accept: 'application/json' },
            credentials: 'same-origin',
            signal,
          })
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
          // A hidden tab wastes an authenticated round trip; refresh on return instead.
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

      const refresh = useCallback(() => {
        if (busy) return
        setBusy(true)
        void load(true).finally(() => { if (alive.current) setBusy(false) })
      }, [busy, load])

      const view = viewOf(state)
      const tone = palette(state, view)
      const detail = detailText(t, state)
      const summary = state.status === 'loading'
        ? t('loading')
        : state.status === 'error'
          ? t('unavailable')
          : segments(t, view)
      const text = typeof summary === 'string' ? summary : `${summary.balanceText} · ${summary.usageText}`

      return h('button', {
        type: 'button',
        title: detail,
        'aria-busy': busy || state.status === 'loading' ? 'true' : 'false',
        'aria-describedby': DETAIL_ID,
        onClick: refresh,
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
          color: hover ? 'var(--dsw-alias-label-secondary)' : tone.text,
          fontFamily: 'inherit',
          fontWeight: 400,
          fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
          lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
          cursor: 'pointer',
          userSelect: 'none',
          opacity: (busy ? 0.6 : 1) * tone.dim,
          transition: 'opacity 120ms ease, background-color 120ms ease',
        },
      },
      h('span', {
        'aria-hidden': true,
        style: {
          width: '6px',
          height: '6px',
          borderRadius: '50%',
          flex: '0 0 auto',
          background: tone.dot,
        },
      }),
      h('span', {
        style: { overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 },
      }, text),
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
      }, detail))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        let t = key => copy.zh[key] ?? key
        let localized = false
        try {
          ctx.effect(() => ctx.locale.register(NS, copy), 'deepseek-meter: copy')
          const bound = ctx.locale.bind(NS)
          if (typeof bound === 'function') {
            t = bound
            localized = true
          }
        } catch {
          // Keep the literal Chinese fallback so the pill still renders.
        }
        const options = { name: SLOT, id: 'deepseek-meter', order: 2 }
        // Only name the namespace once its copy is registered, so slot resolution
        // never asks for a namespace this activation failed to provide.
        if (localized) options.locale = NS
        ctx.slots.inject(SLOT, () => ctx.slots.register(options, () => h(MeterPill, { t })))
      },
    }
  },
})
