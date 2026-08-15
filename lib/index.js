import { defineTool } from '@deepseek-ai/dsh-tools'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { TYPERT } from './typert.js'

const name = 'task-notify'
const inject = ['tools', 'typert']

const CAP = 300
// Process-unique boot nonce: record ids must never repeat across plugin
// restarts, because the client uses them as OS-notification tags and a reused
// tag silently replaces an old notification-center entry instead of showing a
// new banner.
const BOOT = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)

function apply(ctx) {
  // typert-loader validates ./typert exports against the strict FaceModel
  // format (model.services + strict zod codecs), which this hand-written
  // src-json manifest predates. Register directly: the registry itself
  // accepts src-json codecs and does not require a non-empty model.
  const disposeTypert = ctx.typert.register(TYPERT)
  ctx.on('dispose', disposeTypert)
  const records = new Map()
  const keyIndex = new Map()
  let nextId = 1
  const titleSvc = ctx.get('sessionTitle')

  const labelOf = (agent) => {
    if (!agent) return ''
    try {
      if (titleSvc !== undefined) {
        const snap = titleSvc.get(agent.session)
        if (snap !== undefined && typeof snap.title === 'string' && snap.title) return snap.title
      }
    } catch (e) { /* best-effort */ }
    try { return String(agent.id) } catch (e) { return '' }
  }

  const prune = () => {
    if (records.size <= CAP) return
    let victim = null
    for (const r of records.values()) {
      if (r.read && (victim === null || r.at < victim.at)) victim = r
    }
    if (victim === null) {
      for (const r of records.values()) {
        if (victim === null || r.at < victim.at) victim = r
      }
    }
    if (victim !== null) {
      records.delete(victim.id)
      for (const [k, v] of keyIndex) if (v === victim.id) keyIndex.delete(k)
    }
  }

  const push = (key, kind, subkind, label, detail, outcome) => {
    try {
      const now = Date.now()
      if (key) {
        const existingId = keyIndex.get(key)
        if (existingId !== undefined) {
          const rec = records.get(existingId)
          if (rec !== undefined) { rec.at = now; return existingId }
        }
      }
      const id = 'nt-' + BOOT + '-' + String(nextId++)
      records.set(id, { id, kind, subkind, label: label || '', detail: detail || '', outcome: outcome || '', at: now, read: false })
      if (key) keyIndex.set(key, id)
      prune()
      return id
    } catch (e) {
      console.error('task-notify push failed', e)
      return undefined
    }
  }

  const snapshotList = () =>
    [...records.values()].sort((a, b) => b.at - a.at).slice(0, CAP)

  // ── 需要审批: observe only — never break the waterfall ──
  ctx.on('approval/request', (req, next) => {
    try {
      if (req && typeof req === 'object') {
        const aid = req.agent ? String(req.agent.id) : ''
        const label = req.agent ? labelOf(req.agent) : aid
        let detail = typeof req.toolName === 'string' ? req.toolName : ''
        if (typeof req.reason === 'string' && req.reason) detail = detail ? detail + ' — ' + req.reason : req.reason
        if (detail.length > 140) detail = detail.slice(0, 140) + '…'
        push(req.callId ? 'approval:' + String(req.callId) : undefined, 'approval', 'approval', label, detail, '')
      }
    } catch (e) { console.error('task-notify approval listener failed', e) }
    return next()
  }, { global: true, prepend: true })

  // ── 需要回复: turn closes, the model owes no response ──
  ctx.on('agent/turn-stopping', (payload) => {
    try {
      if (payload && payload.agent) {
        const aid = String(payload.agent.id)
        push('reply:' + aid + ':' + String(payload.turn), 'reply', 'reply', labelOf(payload.agent), '', '')
      }
    } catch (e) { console.error('task-notify turn-stopping listener failed', e) }
  })

  // ── 任务结束: subagents ──
  ctx.on('subagent/end', (info) => {
    try {
      if (!info) return
      const ok = info.stopReason === 'completed'
      let summary = ''
      if (Array.isArray(info.lastAssistantMessage)) {
        for (const block of info.lastAssistantMessage) {
          if (block && typeof block.text === 'string' && block.text) { summary = block.text.trim(); break }
        }
      }
      if (summary.length > 120) summary = summary.slice(0, 120) + '…'
      let detail = (typeof info.provider === 'string' ? info.provider : 'subagent') + ' · ' + String(info.stopReason || 'ended')
      if (summary) detail += ' — ' + summary
      push(info.runId ? 'sub:' + String(info.runId) : undefined, 'task-end', 'subagent', info.id ? String(info.id) : '', detail, ok ? 'ok' : 'failed')
    } catch (e) { console.error('task-notify subagent/end listener failed', e) }
  })

  // ── 任务结束: workflows ──
  ctx.on('workflow/end', (info, result) => {
    try {
      if (!info) return
      const name = info.meta && typeof info.meta.name === 'string' ? info.meta.name : ''
      const ok = !result || result.stopReason === 'completed'
      const detail = (result && result.stopReason ? String(result.stopReason) : '') + (result && result.error ? ' — ' + String(result.error) : '')
      push('wf:' + String(info.id), 'task-end', 'workflow', name, detail, ok ? 'ok' : 'failed')
    } catch (e) { console.error('task-notify workflow/end listener failed', e) }
  })

  // ── 任务结束: background jobs (host scope serves every owner) ──
  const jobs = ctx.get('jobs')
  if (jobs !== undefined && typeof jobs.onJobDone === 'function') {
    ctx.effect(() => jobs.onJobDone((snapshot) => {
      try {
        if (!snapshot) return
        const label = typeof snapshot.label === 'string' ? snapshot.label : ''
        const detail = (typeof snapshot.kind === 'string' ? snapshot.kind : 'job') + ' · ' + String(snapshot.status || 'ended')
        const outcome = snapshot.status === 'completed' ? 'ok' : snapshot.status === 'killed' ? 'killed' : 'failed'
        push('job:' + String(snapshot.id), 'task-end', 'job', label, detail, outcome)
      } catch (e) { console.error('task-notify job listener failed', e) }
    }))
  }

  // ── host service the client polls through the Remote gateway.
  // Must carry a typertRemote binding (TypertRemoteService base) or the
  // gateway rejects the receiver with 'no visible typertRemote binding'.
  let clientDiag = null
  class TaskNotifyService extends TypertRemoteService {
    pull() { return snapshotList() }
    ack(input) {
      try {
        if (input && typeof input.id === 'string') {
          const rec = records.get(input.id)
          if (rec !== undefined) rec.read = true
        }
      } catch (e) { /* ignore */ }
      return null
    }
    clear() {
      for (const rec of records.values()) rec.read = true
      return null
    }
    purge() {
      records.clear()
      keyIndex.clear()
      return null
    }
    diag(state) {
      if (state && typeof state === 'object') clientDiag = state
      return null
    }
  }
  new TaskNotifyService(ctx, 'taskNotify')

  // ── diagnostic tool: read the client Notification state ──
  ctx.tools.register(defineTool({
    name: 'ntfy_status',
    description: 'Read the task-notify plugin client diagnostics: whether the browser supports the Notification API, the current permission state, secure-context status, the last report time, and whether that report has gone stale (older than two minutes).',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          reported: { type: 'boolean' },
          stale: { type: 'boolean' },
          supported: { type: 'boolean' },
          permission: { type: 'string' },
          secure: { type: 'boolean' },
          at: { type: 'number' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute() {
      if (clientDiag === null) return { reported: false, stale: true }
      const at = typeof clientDiag.at === 'number' ? clientDiag.at : 0
      return {
        reported: true,
        stale: Date.now() - at > 2 * 60 * 1000,
        supported: clientDiag.supported === true,
        permission: typeof clientDiag.permission === 'string' ? clientDiag.permission : 'unknown',
        secure: clientDiag.secure === true,
        at,
      }
    },
  }))
}

export { name, inject, apply, TYPERT }
