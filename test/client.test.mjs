// Zero-dependency black-box tests for lib/client.js pure logic.
// Mocks the browser globals (window.__ModuleLoader__, React, Notification,
// localStorage, document) and drives the plugin through its slot-render
// callbacks, asserting on the rendered element tree and on Notification calls.
//
// Run: node --test test/client.test.mjs

import assert from 'node:assert/strict'
import { test } from 'node:test'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// ── mocks ──

const React = {
  useState: (init) => [init, () => {}],
  useEffect: (fn) => { try { return fn() } catch (e) { return undefined } },
  createElement: (type, props, ...children) => {
    const p = props || {}
    const kids = children.flat(Infinity)
    // Real React invokes function components at render time; simulate that
    // and merge their props into the result so tests can inspect `item`.
    if (typeof type === 'function') {
      const el = type(p)
      if (el && typeof el === 'object') el.props = Object.assign({}, p, el.props || {})
      return el
    }
    return { type, props: p, children: kids }
  },
}

class FakeNotification {
  static permission = 'granted'
  static requestPermission = async () => 'granted'
  static instances = []
  static reset() { FakeNotification.instances = [] }
  constructor(title, options) {
    this.title = title
    this.options = options || {}
    FakeNotification.instances.push(this)
  }
}

function makeStorage() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    removeItem: (k) => { map.delete(k) },
  }
}

function makeDocument() {
  const doc = {
    visibilityState: 'visible',
    head: { appendChild() {} },
    createElement: () => ({ textContent: '', remove() {}, setAttribute() {} }),
    listeners: new Map(),
    addEventListener(evt, fn) { doc.listeners.set(evt, fn) },
    removeEventListener(evt) { doc.listeners.delete(evt) },
  }
  return doc
}

function makeCtx(rpc, doc) {
  const ctx = {
    injected: {},
    intervalCbs: [],
    timeouts: [],
    get(name) {
      if (name === 'slots') return ctx.slots
      if (name === 'locale') return ctx.locale
      return undefined
    },
    slots: {
      inject(name, cb) { ctx.injected[name] = cb },
      register(_desc, render) { return render },
    },
    locale: {
      getLocale: () => ({ active: 'zh' }),
      subscribe: () => () => {},
    },
    connection: { rpc: { call: rpc } },
    effect(fn) { return fn() },
    timeout(cb) { ctx.timeouts.push(cb); return () => {} },
    interval(cb) { ctx.intervalCbs.push(cb); return () => {} },
  }
  void doc
  return ctx
}

// ── module loading ──

let factory = null
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      if (spec && spec.id === '@deepseek-ai/dsh-task-notify') factory = spec.factory
    },
  },
  isSecureContext: true,
  focus() {},
}
globalThis.Notification = FakeNotification

const modUrl = pathToFileURL(path.resolve('lib/client.js')).href
const applyReady = (async () => {
  await import(modUrl)
  const mod = factory((name) => {
    if (name === 'react') return React
    throw new Error('unexpected require: ' + name)
  })
  return mod
})()

const flush = async () => {
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
}

const item = (id, at, read = false) => ({
  id, kind: 'task-end', subkind: 'job', label: 'job-' + id, detail: '', outcome: 'ok', at, read,
})

function findNodes(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out
  if (pred(node)) out.push(node)
  for (const c of node.children || []) findNodes(c, pred, out)
  return out
}

const renderOverlay = (ctx) => ctx.injected['shell.overlay']()()

function panelItems(tree) {
  const list = findNodes(tree, (n) => n.props && n.props.className === 'ntfy-list')[0]
  if (!list) return []
  return (list.children || []).filter((c) => c && c.props && c.props.item).map((c) => c.props.item)
}

function toastIds(tree) {
  const box = findNodes(tree, (n) => n.props && n.props.className === 'ntfy-toasts')[0]
  if (!box) return []
  return (box.children || []).filter((c) => c && c.props && c.props.item).map((c) => c.props.item.id)
}

function clickBell(ctx) {
  const tree = ctx.injected['sidebar.footer.action']()({})
  const bell = findNodes(tree, (n) => n.props && typeof n.props.className === 'string' && n.props.className.startsWith('ntfy-bell'))[0]
  assert.ok(bell, 'bell should be mounted')
  bell.props.onClick()
  return renderOverlay(ctx)
}

async function boot(pullHandler, { storage = null, hidden = false } = {}) {
  const doc = makeDocument()
  doc.visibilityState = hidden ? 'hidden' : 'visible'
  globalThis.document = doc
  if (storage !== null) globalThis.localStorage = storage
  else delete globalThis.localStorage
  const pullCount = { n: 0 }
  const rpc = async (_channel, method) => {
    if (method === 'taskNotify/pull') {
      pullCount.n++
      return { ok: true, value: pullHandler(pullCount.n) }
    }
    return { ok: true, value: null }
  }
  const ctx = makeCtx(rpc, doc)
  const mod = await applyReady
  await mod.apply(ctx)
  renderOverlay(ctx) // mount the overlay → Poller effect fires its first poll
  return { ctx, doc, pullCount }
}

// ── tests ──

test('module exposes apply + inject', async () => {
  const mod = await applyReady
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(mod.inject, ['slots', 'locale', 'timer', 'connection'])
})

test('dedupes pushes across polls within one session', async () => {
  FakeNotification.reset()
  const list = [item('a', 200), item('b', 100)]
  const { ctx } = await boot(() => list, { storage: makeStorage() })
  await flush()
  assert.equal(FakeNotification.instances.length, 2)
  ctx.intervalCbs[0]()
  await flush()
  assert.equal(FakeNotification.instances.length, 2)
  const tags = FakeNotification.instances.map((n) => n.options.tag).sort()
  assert.deepEqual(tags, ['ntfy-a', 'ntfy-b'])
})

test('refresh does not re-push thanks to localStorage dedupe', async () => {
  FakeNotification.reset()
  const storage = makeStorage()
  const list = [item('a', 200), item('b', 100)]
  await boot(() => list, { storage })
  await flush()
  assert.equal(FakeNotification.instances.length, 2)
  // second page load: fresh module state, same origin storage
  const second = await boot(() => list, { storage })
  await flush()
  assert.equal(FakeNotification.instances.length, 2)
  assert.deepEqual(toastIds(renderOverlay(second.ctx)), [])
  const tree = clickBell(second.ctx)
  assert.deepEqual(panelItems(tree).map((x) => x.id), ['a', 'b'])
})

test('reconciles server-deleted ids out of panel and toasts', async () => {
  FakeNotification.reset()
  const list = [item('a', 300), item('b', 200), item('c', 100)]
  let current = list
  const { ctx } = await boot(() => current, { storage: makeStorage() })
  await flush()
  assert.equal(FakeNotification.instances.length, 3)
  current = [item('b', 200)]
  ctx.intervalCbs[0]()
  await flush()
  const tree = clickBell(ctx)
  assert.deepEqual(panelItems(tree).map((x) => x.id), ['b'])
  assert.deepEqual(toastIds(renderOverlay(ctx)), ['b'])
})

test('keeps server order: newest first', async () => {
  FakeNotification.reset()
  const list = [item('new', 500), item('old', 100)]
  const { ctx } = await boot(() => list, { storage: makeStorage() })
  await flush()
  const tree = clickBell(ctx)
  assert.deepEqual(panelItems(tree).map((x) => x.id), ['new', 'old'])
})

test('skips polling while hidden and polls on visibilitychange', async () => {
  FakeNotification.reset()
  let pulls = 0
  const { ctx, doc } = await boot((n) => { pulls = n; return [item('a', 100)] }, { storage: makeStorage(), hidden: true })
  await flush()
  assert.equal(pulls, 0)
  ctx.intervalCbs[0]()
  await flush()
  assert.equal(pulls, 0)
  assert.equal(FakeNotification.instances.length, 0)
  doc.visibilityState = 'visible'
  doc.listeners.get('visibilitychange')()
  await flush()
  assert.equal(pulls, 1)
  assert.equal(FakeNotification.instances.length, 1)
})

test('budgets at most 3 new pushes per poll round', async () => {
  FakeNotification.reset()
  const list = Array.from({ length: 10 }, (_, i) => item('x' + i, 1000 - i))
  const { ctx } = await boot(() => list) // no storage → in-memory fallback
  await flush()
  assert.equal(FakeNotification.instances.length, 3)
  ctx.intervalCbs[0](); await flush()
  assert.equal(FakeNotification.instances.length, 6)
  ctx.intervalCbs[0](); await flush()
  assert.equal(FakeNotification.instances.length, 9)
  ctx.intervalCbs[0](); await flush()
  assert.equal(FakeNotification.instances.length, 10)
  ctx.intervalCbs[0](); await flush()
  assert.equal(FakeNotification.instances.length, 10)
})

test('never pushes read items', async () => {
  FakeNotification.reset()
  const list = [item('a', 100, true), item('b', 200, false)]
  await boot(() => list, { storage: makeStorage() })
  await flush()
  assert.equal(FakeNotification.instances.length, 1)
  assert.equal(FakeNotification.instances[0].options.tag, 'ntfy-b')
})

test('toast disappears after its timeout', async () => {
  FakeNotification.reset()
  const list = [item('a', 100)]
  const { ctx } = await boot(() => list, { storage: makeStorage() })
  await flush()
  assert.deepEqual(toastIds(renderOverlay(ctx)), ['a'])
  for (const cb of ctx.timeouts) cb()
  assert.deepEqual(toastIds(renderOverlay(ctx)), [])
})
