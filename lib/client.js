window.__ModuleLoader__.load({
  id: '@deepseek-ai/dsh-task-notify',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')

    // Client→Host RPC via the raw connection rpc seam (bypasses the typert
    // namespace-face machinery, which requires inject-declared dotted services
    // that a self-mounted namespace cannot satisfy).
    const inject = ['slots', 'locale', 'timer', 'connection']

    const DICTS = {
      zh: {
        bellLabel: '任务通知', panelTitle: '任务通知',
        approvalTitle: '需要审批', replyTitle: '需要回复',
        endSubagentTitle: '子任务结束', endWorkflowTitle: '工作流结束', endJobTitle: '后台任务结束',
        markAllRead: '全部已读', empty: '暂无通知',
        outcomeOk: '完成', outcomeFailed: '失败', outcomeKilled: '已终止',
        justNow: '刚刚', minAgo: '分钟前', hourAgo: '小时前', close: '关闭',
        permHint: '系统通知未开启 — 点击铃铛授权',
        testNotify: '测试通知',
        diagLabel: '系统通知',
        pushOk: '上次推送:成功', pushSkip: '上次推送:跳过', pushErr: '上次推送:失败',
        retry: '重发',
        purgeBtn: '清理',
        mountLabel: '挂载', mountOk: '成功', mountFail: '失败',
        pollLabel: '轮询', pollOk: '成功', pollFail: '失败',
      },
      en: {
        bellLabel: 'Task Notifications', panelTitle: 'Task Notifications',
        approvalTitle: 'Approval required', replyTitle: 'Awaiting your reply',
        endSubagentTitle: 'Subagent finished', endWorkflowTitle: 'Workflow finished', endJobTitle: 'Background job finished',
        markAllRead: 'Mark all read', empty: 'No notifications',
        outcomeOk: 'done', outcomeFailed: 'failed', outcomeKilled: 'killed',
        justNow: 'just now', minAgo: 'min ago', hourAgo: 'h ago', close: 'Close',
        permHint: 'System notifications off — click the bell to enable',
        testNotify: 'Test notification',
        diagLabel: 'Notifications',
        pushOk: 'last push: ok', pushSkip: 'last push: skipped', pushErr: 'last push: failed',
        retry: 'Re-send',
        purgeBtn: 'Clear',
        mountLabel: 'mount', mountOk: 'ok', mountFail: 'failed',
        pollLabel: 'poll', pollOk: 'ok', pollFail: 'failed',
      },
    }

    async function apply(ctx) {
      const mountState = { ok: true, why: '' }
      const slots = ctx.get('slots')
      if (slots === undefined) return

      // ── store ──
      const state = { items: [], toasts: [], open: false }
      const listeners = new Set()
      const emit = () => { for (const fn of listeners) fn() }
      const subscribe = (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } }

      // ── i18n ──
      let lang = 'zh'
      const locale = ctx.get('locale')
      const readLang = () => {
        try {
          if (locale !== undefined) {
            const snap = locale.getLocale()
            if (snap && typeof snap.active === 'string' && snap.active) lang = snap.active
          }
        } catch (e) { /* ignore */ }
      }
      readLang()
      if (locale !== undefined && typeof locale.subscribe === 'function') {
        ctx.effect(() => locale.subscribe(() => { readLang(); emit() }))
      }
      const t = (key) => (DICTS[lang] || DICTS.zh)[key] || DICTS.zh[key] || key

      // ── helpers ──
      const kindClass = (item) =>
        item.kind === 'approval' ? 'ntfy-kind-approval' : item.kind === 'reply' ? 'ntfy-kind-reply' : 'ntfy-kind-task-end'

      const textOf = (item) => {
        if (item.kind === 'approval') return { title: t('approvalTitle'), body: item.detail || item.label || '' }
        if (item.kind === 'reply') return { title: t('replyTitle'), body: item.label || '' }
        const title = item.subkind === 'subagent' ? t('endSubagentTitle') : item.subkind === 'workflow' ? t('endWorkflowTitle') : t('endJobTitle')
        const parts = []
        if (item.label) parts.push(item.label)
        if (item.detail) parts.push(item.detail)
        if (item.outcome === 'ok') parts.push(t('outcomeOk'))
        else if (item.outcome === 'failed') parts.push(t('outcomeFailed'))
        else if (item.outcome === 'killed') parts.push(t('outcomeKilled'))
        return { title, body: parts.join(' · ') }
      }

      const relTime = (at) => {
        const diff = Date.now() - Number(at)
        if (!(diff >= 0)) return ''
        if (diff < 60000) return t('justNow')
        const min = Math.floor(diff / 60000)
        if (min < 60) return String(min) + ' ' + t('minAgo')
        return String(Math.floor(min / 60)) + ' ' + t('hourAgo')
      }

      // ── system notifications ──
      const canNativeNotify = () =>
        typeof Notification !== 'undefined' && typeof Notification.requestPermission === 'function'

      const lastPush = { ok: null, why: '', at: 0 }

      const reportDiag = () => {
        try {
          ctx.connection.rpc.call('/api', 'taskNotify/diag', { args: { state: {
            supported: canNativeNotify(),
            permission: typeof Notification !== 'undefined' ? String(Notification.permission) : 'unavailable',
            secure: typeof window !== 'undefined' && typeof window.isSecureContext === 'boolean' ? window.isSecureContext === true : false,
            at: Date.now(),
          } } }).catch(() => {})
        } catch (e) { /* ignore */ }
      }

      let audioCtx = null
      const ensureAudio = () => {
        try {
          if (audioCtx === null) {
            if (typeof AudioContext !== 'undefined') audioCtx = new AudioContext()
            else if (typeof window !== 'undefined' && typeof window.webkitAudioContext === 'function') audioCtx = new window.webkitAudioContext()
          }
          if (audioCtx !== null && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {})
          return audioCtx
        } catch (e) { return null }
      }

      const playTone = (a, freq, start, dur, gainVal) => {
        try {
          const osc = a.createOscillator()
          const gain = a.createGain()
          osc.type = 'sine'
          osc.frequency.value = freq
          gain.gain.setValueAtTime(0.0001, a.currentTime + start)
          gain.gain.exponentialRampToValueAtTime(gainVal, a.currentTime + start + 0.02)
          gain.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + start + dur)
          osc.connect(gain)
          gain.connect(a.destination)
          osc.start(a.currentTime + start)
          osc.stop(a.currentTime + start + dur + 0.05)
        } catch (e) { /* ignore */ }
      }

      const playChime = (kind) => {
        const a = ensureAudio()
        if (a === null) return
        try {
          if (kind === 'approval') {
            playTone(a, 880, 0, 0.18, 0.25)
            playTone(a, 880, 0.22, 0.22, 0.25)
          } else if (kind === 'reply') {
            playTone(a, 660, 0, 0.3, 0.22)
          } else {
            playTone(a, 523, 0, 0.18, 0.22)
            playTone(a, 784, 0.18, 0.25, 0.22)
          }
        } catch (e) { /* ignore */ }
      }

      const osNotify = (item) => {
        lastPush.at = Date.now()
        try {
          if (!canNativeNotify()) { lastPush.ok = false; lastPush.why = 'unsupported'; return }
          if (Notification.permission !== 'granted') { lastPush.ok = false; lastPush.why = 'permission'; return }
          const text = textOf(item)
          const body = (text.body || '').slice(0, 140)
          const n = new Notification(text.title, { body: body || undefined, tag: 'ntfy-' + item.id, silent: false })
          n.onclick = () => { try { window.focus() } catch (e) { /* ignore */ } }
          lastPush.ok = true
          lastPush.why = ''
        } catch (e) { lastPush.ok = false; lastPush.why = e instanceof Error ? e.message : String(e) }
      }

      const ensurePermission = async () => {
        try {
          if (!canNativeNotify()) return 'unsupported'
          if (Notification.permission === 'granted') return 'granted'
          if (Notification.permission === 'denied') return 'denied'
          return await Notification.requestPermission()
        } catch (e) { return 'denied' }
      }

      const sendTest = async () => {
        const perm = await ensurePermission()
        if (perm === 'granted' && canNativeNotify()) {
          try {
            new Notification(t('panelTitle'), { body: t('testNotify'), silent: false })
            lastPush.ok = true; lastPush.why = ''
          } catch (e) { lastPush.ok = false; lastPush.why = e instanceof Error ? e.message : String(e) }
        } else {
          lastPush.ok = false; lastPush.why = 'permission'
        }
        lastPush.at = Date.now()
        playChime('reply')
        reportDiag()
        emit()
      }

      const retryLast = async () => {
        const unread = state.items.find((x) => !x.read)
        const item = unread === undefined ? state.items[0] : unread
        if (item === undefined) return
        const perm = await ensurePermission()
        if (perm !== 'granted') { lastPush.ok = false; lastPush.why = 'permission'; lastPush.at = Date.now(); emit(); return }
        osNotify(item)
        playChime(item.kind)
        emit()
      }

      // ── store operations ──
      const ingest = (list) => {
        if (!Array.isArray(list)) return
        let changed = false
        for (const item of list) {
          const prev = state.items.find((x) => x.id === item.id)
          if (prev !== undefined) {
            if (prev.read !== item.read) { prev.read = item.read; changed = true }
            continue
          }
          state.items.unshift(item)
          if (state.items.length > 300) state.items.pop()
          changed = true
          if (!item.read) {
            osNotify(item)
            playChime(item.kind)
            state.toasts.push(item.id)
            if (state.toasts.length > 3) state.toasts.shift()
            ctx.timeout(() => {
              const i = state.toasts.indexOf(item.id)
              if (i >= 0) state.toasts.splice(i, 1)
              emit()
            }, 6000)
          }
        }
        if (changed) emit()
      }

      const dismissToast = (id) => {
        const i = state.toasts.indexOf(id)
        if (i >= 0) { state.toasts.splice(i, 1); emit() }
      }

      const ack = async (id) => {
        const item = state.items.find((x) => x.id === id)
        if (item !== undefined && !item.read) { item.read = true; emit() }
        try { await ctx.connection.rpc.call('/api', 'taskNotify/ack', { args: { id } }) } catch (e) { /* ignore */ }
      }

      const clearAll = async () => {
        let changed = false
        for (const item of state.items) if (!item.read) { item.read = true; changed = true }
        if (changed) emit()
        try { await ctx.connection.rpc.call('/api', 'taskNotify/clear', { args: {} }) } catch (e) { /* ignore */ }
      }

      const purgeAll = async () => {
        state.items = []
        state.toasts = []
        emit()
        try { await ctx.connection.rpc.call('/api', 'taskNotify/purge', { args: {} }) } catch (e) { /* ignore */ }
      }

      const useStore = () => {
        const [, force] = React.useState(0)
        React.useEffect(() => subscribe(() => force((x) => x + 1)), [])
        return state
      }

      // ── components ──
      const BellIcon = () => React.createElement('svg', { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' },
        React.createElement('path', { d: 'M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9' }),
        React.createElement('path', { d: 'M13.73 21a2 2 0 0 1-3.46 0' }))

      const KindIcon = ({ kind }) => {
        const props = { viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', style: { flex: 'none', marginTop: 1 } }
        if (kind === 'approval') return React.createElement('svg', props,
          React.createElement('path', { d: 'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z' }),
          React.createElement('line', { x1: '12', y1: '9', x2: '12', y2: '13' }),
          React.createElement('line', { x1: '12', y1: '17', x2: '12.01', y2: '17' }))
        if (kind === 'reply') return React.createElement('svg', props,
          React.createElement('path', { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' }))
        return React.createElement('svg', props,
          React.createElement('path', { d: 'M22 11.08V12a10 10 0 1 1-5.93-9.14' }),
          React.createElement('polyline', { points: '22 4 12 14.01 9 11.01' }))
      }

      const Bell = ({ wide }) => {
        const s = useStore()
        const unread = s.items.reduce((n, x) => n + (x.read ? 0 : 1), 0)
        const onClick = () => {
          s.open = !s.open
          emit()
          ensurePermission().then(reportDiag)
        }
        return React.createElement('button', {
          className: 'ntfy-bell' + (s.open ? ' ntfy-bell-on' : ''),
          onClick, title: t('bellLabel'), 'aria-label': t('bellLabel'), type: 'button',
        },
          React.createElement(BellIcon, null),
          wide ? React.createElement('span', { className: 'ntfy-bell-label' }, t('bellLabel')) : null,
          unread > 0 ? React.createElement('span', { className: 'ntfy-bell-badge' }, unread > 99 ? '99+' : String(unread)) : null)
      }

      const Toast = ({ item }) => {
        const text = textOf(item)
        const onClick = () => {
          dismissToast(item.id)
          state.open = true
          emit()
          ack(item.id)
        }
        return React.createElement('div', { className: 'ntfy-toast', onClick, role: 'status' },
          React.createElement(KindIcon, { kind: item.kind }),
          React.createElement('div', { style: { minWidth: 0, flex: 1 } },
            React.createElement('div', { className: 'ntfy-toast-title' }, text.title),
            text.body ? React.createElement('div', { className: 'ntfy-toast-body' }, text.body) : null),
          React.createElement('button', { className: 'ntfy-toast-x', type: 'button', 'aria-label': t('close'), onClick: (e) => { e.stopPropagation(); dismissToast(item.id) } }, '✕'))
      }

      const Item = ({ item }) => {
        const text = textOf(item)
        const onClick = () => { ack(item.id); state.open = false; emit() }
        return React.createElement('div', { className: 'ntfy-item' + (item.read ? ' ntfy-item-read' : ''), onClick },
          React.createElement(KindIcon, { kind: item.kind }),
          React.createElement('div', { style: { minWidth: 0, flex: 1 } },
            React.createElement('div', { className: 'ntfy-item-title' }, text.title),
            text.body ? React.createElement('div', { className: 'ntfy-item-body' }, text.body) : null),
          React.createElement('span', { className: 'ntfy-item-time' }, relTime(item.at)))
      }

      const Panel = () => {
        const s = useStore()
        if (!s.open) return null
        const unread = s.items.reduce((n, x) => n + (x.read ? 0 : 1), 0)
        const permOff = canNativeNotify() && Notification.permission !== 'granted'
        const mountTxt = mountState.ok === null ? '?' : mountState.ok === true ? t('mountOk') : t('mountFail') + ': ' + mountState.why
        const pollTxt = lastPoll.ok === null ? '?' : lastPoll.ok === true ? t('pollOk') + ' (' + String(lastPoll.count) + ')' : t('pollFail') + ': ' + lastPoll.why
        const diagText = lastPush.ok === null
          ? (canNativeNotify() ? String(Notification.permission) : 'unsupported')
          : lastPush.ok === true
            ? t('pushOk')
            : lastPush.why === 'permission' ? t('pushSkip') + ' (' + t('permHint') + ')' : t('pushErr') + ': ' + lastPush.why
        return React.createElement('div', { className: 'ntfy-panel', role: 'dialog', 'aria-label': t('panelTitle') },
          React.createElement('div', { className: 'ntfy-panel-head' },
            React.createElement('span', { className: 'ntfy-panel-title' }, t('panelTitle') + (unread > 0 ? ' (' + String(unread) + ')' : '')),
            React.createElement('div', { className: 'ntfy-panel-actions' },
              React.createElement('button', { className: 'ntfy-panel-test', type: 'button', onClick: sendTest }, t('testNotify')),
              unread > 0 ? React.createElement('button', { className: 'ntfy-panel-clear', type: 'button', onClick: clearAll }, t('markAllRead')) : null,
            React.createElement('button', { className: 'ntfy-panel-purge', type: 'button', onClick: purgeAll }, t('purgeBtn')))),
          React.createElement('div', { className: 'ntfy-diag', role: 'note' },
            React.createElement('span', {}, t('diagLabel') + ': ' + diagText + ' · ' + t('mountLabel') + ': ' + mountTxt + ' · ' + t('pollLabel') + ': ' + pollTxt),
            React.createElement('button', { className: 'ntfy-panel-test', type: 'button', onClick: retryLast }, t('retry'))),
          permOff ? React.createElement('div', { className: 'ntfy-perm-hint', role: 'note' }, t('permHint')) : null,
          s.items.length === 0
            ? React.createElement('div', { className: 'ntfy-empty' }, t('empty'))
            : React.createElement('div', { className: 'ntfy-list' }, s.items.map((item) => React.createElement(Item, { key: item.id, item }))))
      }

      const Toasts = () => {
        const s = useStore()
        if (s.toasts.length === 0) return null
        return React.createElement('div', { className: 'ntfy-toasts' },
          s.toasts.map((id) => {
            const item = s.items.find((x) => x.id === id)
            return item === undefined ? null : React.createElement(Toast, { key: id, item })
          }))
      }

      const lastPoll = { ok: null, why: '', count: 0, at: 0 }
      const Poller = () => {
        React.useEffect(() => {
          let alive = true
          const poll = async () => {
            try {
              const answered = await ctx.connection.rpc.call('/api', 'taskNotify/pull', { args: {} })
              if (alive && answered && answered.ok === true && Array.isArray(answered.value)) {
                lastPoll.ok = true; lastPoll.why = ''; lastPoll.count = answered.value.length; lastPoll.at = Date.now()
                ingest(answered.value)
              } else {
                lastPoll.ok = false
                lastPoll.why = answered && answered.error ? (answered.error.code + ': ' + (answered.error.message || '')) : 'bad-envelope'
                lastPoll.at = Date.now()
              }
            } catch (e) { lastPoll.ok = false; lastPoll.why = e instanceof Error ? e.message : String(e); lastPoll.at = Date.now() }
          }
          poll()
          const disposer = ctx.interval(() => { poll() }, 1500)
          return () => { alive = false; disposer() }
        }, [])
        return null
      }

      // ── slots ──
      slots.inject('sidebar.footer.action', () => slots.register(
        { name: 'sidebar.footer.action', id: 'task-notify-bell', order: 30, label: () => t('bellLabel') },
        (props) => React.createElement(Bell, { wide: !!props.wide }),
      ))

      slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'task-notify-layer', order: 10 },
        () => React.createElement('div', { className: 'ntfy-layer' },
          React.createElement(Poller, null),
          React.createElement(Toasts, null),
          React.createElement(Panel, null)),
      ))

      // ── styles ──
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.textContent = `
.ntfy-layer { position: fixed; inset: 0; pointer-events: none; z-index: 50; }
.ntfy-toasts { position: fixed; top: 12px; right: 12px; display: flex; flex-direction: column; gap: 8px; z-index: 60; pointer-events: auto; }
.ntfy-toast { display: flex; align-items: flex-start; gap: 8px; width: 300px; max-width: calc(100vw - 24px); padding: 10px 12px; border-radius: 10px; background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l1); box-shadow: 0 8px 24px rgba(0,0,0,.18); color: var(--dsw-alias-label-primary); cursor: pointer; }
.ntfy-toast-title { font-size: 13px; font-weight: 600; }
.ntfy-toast-body { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.ntfy-toast-x { border: none; background: none; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 12px; padding: 0 2px; }
.ntfy-kind-approval { color: var(--dsw-alias-state-warn-primary); }
.ntfy-kind-reply { color: var(--dsw-alias-brand-primary); }
.ntfy-kind-task-end { color: var(--dsw-alias-state-success-primary); }
.ntfy-panel { position: fixed; left: 12px; bottom: 104px; width: 340px; max-width: calc(100vw - 24px); max-height: 65vh; display: flex; flex-direction: column; border-radius: 12px; background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l1); box-shadow: 0 12px 32px rgba(0,0,0,.22); z-index: 55; pointer-events: auto; overflow: hidden; }
.ntfy-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.ntfy-panel-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.ntfy-panel-actions { display: flex; align-items: center; gap: 8px; flex: none; }
.ntfy-panel-test, .ntfy-panel-clear { font-size: 12px; background: none; border: none; cursor: pointer; padding: 2px 4px; }
.ntfy-panel-test { color: var(--dsw-alias-label-secondary); }
.ntfy-panel-test:hover { color: var(--dsw-alias-label-primary); }
.ntfy-panel-clear { color: var(--dsw-alias-brand-primary); }
.ntfy-panel-purge { font-size: 12px; background: none; border: none; cursor: pointer; padding: 2px 4px; color: var(--dsw-alias-state-error-primary); }
.ntfy-diag { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 12px; font-size: 11px; color: var(--dsw-alias-label-secondary); border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.ntfy-perm-hint { padding: 8px 12px; font-size: 12px; color: var(--dsw-alias-state-warn-primary); border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.ntfy-list { overflow-y: auto; padding: 4px; }
.ntfy-item { display: flex; align-items: flex-start; gap: 8px; padding: 8px; border-radius: 8px; cursor: pointer; }
.ntfy-item:hover { background: var(--dsw-alias-bg-layer-1); }
.ntfy-item-read { opacity: .55; }
.ntfy-item-title { font-size: 13px; color: var(--dsw-alias-label-primary); font-weight: 500; }
.ntfy-item-body { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ntfy-item-time { font-size: 11px; color: var(--dsw-alias-label-secondary); flex: none; margin-left: auto; padding-top: 2px; }
.ntfy-empty { padding: 24px 12px; text-align: center; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.ntfy-bell { display: inline-flex; align-items: center; gap: 6px; position: relative; border: none; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; padding: 6px; border-radius: 8px; }
.ntfy-bell:hover, .ntfy-bell-on { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); }
.ntfy-bell-label { font-size: 12px; }
.ntfy-bell-badge { position: absolute; top: -2px; right: -2px; min-width: 14px; height: 14px; padding: 0 3px; border-radius: 7px; background: var(--dsw-alias-state-error-primary); color: #fff; font-size: 10px; line-height: 14px; text-align: center; }
`
        document.head.appendChild(tag)
        return () => { tag.remove() }
      })

      // ── initial diagnostic report ──
      reportDiag()
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
