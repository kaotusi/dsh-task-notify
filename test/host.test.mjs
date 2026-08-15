// Black-box tests for the host side of dsh-task-notify (lib/index.js):
// push key-dedup, prune, snapshot order, ack/clear/purge, and the ntfy_status
// stale diagnostic.
//
// Depends on the plugin's peer packages being resolvable from the repo root.
// A local symlink to an installed DSH profile's node_modules suffices:
//   ln -s ~/.dsh/profiles/node_modules node_modules
//
// Run: node --test test/host.test.mjs

import assert from 'node:assert/strict'
import { test } from 'node:test'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const { apply, name, inject } = await import(pathToFileURL(path.resolve('lib/index.js')).href)

function makeHost() {
  const host = { provided: {}, listeners: {}, tools: [], typert: null }
  const ctx = {
    reflect: { provide: (n, svc) => { host.provided[n] = svc; return () => {} } },
    get: () => undefined, // sessionTitle / jobs services absent
    on: (evt, cb) => { host.listeners[evt] = cb; return () => {} },
    effect: (fn) => fn(),
    typert: { register: (m) => { host.typert = m; return () => {} } },
    tools: { register: (t) => { host.tools.push(t) } },
  }
  return { ctx, host }
}

const svc = (host) => host.provided.taskNotify

test('exports name + inject contract', () => {
  assert.equal(name, 'task-notify')
  assert.deepEqual(inject, ['tools', 'typert'])
})

test('boot wires the typert manifest and the taskNotify service', async () => {
  const { ctx, host } = makeHost()
  await apply(ctx)
  assert.ok(host.typert)
  assert.equal(host.typert.package, '@deepseek-ai/dsh-task-notify')
  assert.ok(Array.isArray(host.typert.invocations))
  assert.ok(svc(host))
  assert.deepEqual(svc(host).pull(), [])
})

test('turn-stopping pushes a reply record labeled by agent id', async () => {
  const { ctx, host } = makeHost()
  await apply(ctx)
  host.listeners['agent/turn-stopping']({ agent: { id: 'a1', session: 's1' }, turn: 1 })
  const list = svc(host).pull()
  assert.equal(list.length, 1)
  assert.equal(list[0].kind, 'reply')
  assert.equal(list[0].label, 'a1')
  assert.equal(list[0].read, false)
})

test('approval request dedupes by callId and never breaks the waterfall', async () => {
  const { ctx, host } = makeHost()
  await apply(ctx)
  let nextCalls = 0
  const req = { agent: { id: 'a1' }, callId: 'c1', toolName: 'bash', reason: 'rm -rf' }
  host.listeners['approval/request'](req, () => { nextCalls++ })
  host.listeners['approval/request'](req, () => { nextCalls++ })
  assert.equal(nextCalls, 2)
  const list = svc(host).pull()
  assert.equal(list.length, 1)
  assert.equal(list[0].kind, 'approval')
  assert.match(list[0].detail, /bash/)
  assert.match(list[0].detail, /rm -rf/)
})

test('subagent/end carries child id and output summary', async () => {
  const { ctx, host } = makeHost()
  await apply(ctx)
  host.listeners['subagent/end']({
    runId: 'r1', provider: 'claude', id: 'ses-9', stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: '  done with the audit  ' }],
  })
  const [rec] = svc(host).pull()
  assert.equal(rec.subkind, 'subagent')
  assert.equal(rec.label, 'ses-9')
  assert.equal(rec.outcome, 'ok')
  assert.match(rec.detail, /claude/)
  assert.match(rec.detail, /completed/)
  assert.match(rec.detail, /done with the audit/)
})

test('subagent/end marks non-completed outcomes failed', async () => {
  const { ctx, host } = makeHost()
  await apply(ctx)
  host.listeners['subagent/end']({ runId: 'r2', provider: 'claude', id: 'ses-10', stopReason: 'error' })
  const [rec] = svc(host).pull()
  assert.equal(rec.outcome, 'failed')
})

test('workflow/end records name and stop reason', async () => {
  const { ctx, host } = makeHost()
  await apply(ctx)
  host.listeners['workflow/end']({ id: 'wf1', meta: { name: 'audit' } }, { stopReason: 'completed' })
  const [rec] = svc(host).pull()
  assert.equal(rec.subkind, 'workflow')
  assert.equal(rec.label, 'audit')
  assert.equal(rec.outcome, 'ok')
})

test('prune keeps at most 300 records, evicting the oldest unread', async () => {
  const { ctx, host } = makeHost()
  await apply(ctx)
  const realNow = Date.now
  let t = 1_000_000
  Date.now = () => t++
  try {
    for (let i = 0; i < 301; i++) {
      host.listeners['approval/request']({ agent: { id: 'a' + i }, callId: 'c' + i, toolName: 't' }, () => {})
    }
  } finally {
    Date.now = realNow
  }
  const list = svc(host).pull()
  assert.equal(list.length, 300)
  assert.ok(!list.some((r) => r.id === undefined))
  // newest first
  const first = list[0]
  assert.equal(first.detail, 't')
})

test('ack marks read, clear marks all read, purge empties', async () => {
  const { ctx, host } = makeHost()
  await apply(ctx)
  host.listeners['agent/turn-stopping']({ agent: { id: 'a1' }, turn: 1 })
  host.listeners['agent/turn-stopping']({ agent: { id: 'a1' }, turn: 2 })
  const [newer, older] = svc(host).pull()
  assert.equal(newer.read, false)
  svc(host).ack({ id: older.id })
  assert.equal(svc(host).pull().find((r) => r.id === older.id).read, true)
  svc(host).clear()
  assert.ok(svc(host).pull().every((r) => r.read === true))
  svc(host).purge()
  assert.deepEqual(svc(host).pull(), [])
})

test('ntfy_status reports stale diagnostics', async () => {
  const { ctx, host } = makeHost()
  await apply(ctx)
  assert.equal(host.tools.length, 1)
  const tool = host.tools[0]
  assert.equal(tool.name, 'ntfy_status')
  // never reported
  assert.deepEqual(await tool.execute({}), { reported: false, stale: true })
  // reported 10 minutes ago → stale
  svc(host).diag({ supported: true, permission: 'granted', secure: true, at: Date.now() - 10 * 60 * 1000 })
  const stale = await tool.execute({})
  assert.equal(stale.reported, true)
  assert.equal(stale.stale, true)
  // reported just now → fresh
  svc(host).diag({ supported: true, permission: 'denied', secure: true, at: Date.now() })
  const fresh = await tool.execute({})
  assert.equal(fresh.stale, false)
  assert.equal(fresh.permission, 'denied')
})
