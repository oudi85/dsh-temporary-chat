import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, access, symlink } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { SessionDeletion, checkedDirectory } from '../lib/delete-session.js'
import { NoMemoryRegistry } from '../lib/registry.js'

async function fixture(run) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-delete-test-')), root = path.join(home, 'sessions')
  await mkdir(path.join(root, 'project'), { recursive: true })
  const headers = new Map(), live = new Map(), cacheRows = new Map(), emitted = [], pinned = new Set(), archived = new Set()
  const file = id => path.join(root, 'project', id, 'session.v4.jsonl')
  const exists = async id => { try { await access(file(id)); return true } catch { return false } }
  const persistence = { root, locate: header => ({ path: file(header.id) }), coldLogMemo: new Map(), async list() { const rows = []; for (const header of headers.values()) if (await exists(header.id) || live.has(header.id)) rows.push({ header }); return rows } }
  const factory = {
    async createAgent(owner, options) {
      const id = options.sessionId, header = { id, createdAt: Date.now(), cwd: home, ...options.meta }
      headers.set(id, header); await mkdir(path.dirname(file(id)), { recursive: true }); await writeFile(file(id), 'chat content')
      const agent = { id, status: 'idle', session: { id, header }, whenIdle: async () => {} }
      live.set(id, agent); cacheRows.set(id, 'cached content'); persistence.coldLogMemo.set(id, 'cached log')
      return { agent, async dispose() { live.delete(id); await services.sessionProjectionCache.put(id, {}, { content: 'late detach write' }) } }
    },
    async resume(owner, options) { return this.createAgent(owner, { sessionId: options.resumeSessionId }) }
  }
  const membership = new Set(), entity = { get sessionIds() { return [...membership] }, async detachSession(id) { membership.delete(id) } }
  const workspace = { list: () => [entity], headers: new Map(), sessionPaths: new Map(), invalidSessionPaths: new Map(), async unpinSession(id) { pinned.delete(id) }, async unarchiveSession(id) { archived.delete(id) }, async stopSessionActivity(id) { const agent = live.get(id); if (agent) agent.status = 'idle' } }
  const services = {
    sessionPersistence: persistence, sessions: { get: id => live.get(id)?.session, list: () => [...live.values()].map(agent => agent.session) },
    agents: { get: id => live.get(id), requireFactory: () => ({ target: factory }) }, workspaceRegistry: workspace,
    sessionProjectionCache: { table: { delete: async id => cacheRows.delete(id) }, put: async (id, _, rows) => cacheRows.set(id, rows) },
    sessionQuery: { _observations: { cache: new Map() }, _db: {}, listSessions: () => persistence.list(), _serialized: async (_, fn) => fn(), _reconcile: async () => { services.sessionQuery.reconciled = true } }
  }
  const ctx = { get: key => services[key], emit: (...args) => emitted.push(args), waterfall: async (_, { sessionId }) => live.get(sessionId)?.status === 'running' ? [{ kind: 'turn' }] : [] }
  const registry = new NoMemoryRegistry(path.join(home, 'registry.json')), deletion = new SessionDeletion(ctx, registry, home)
  const create = async (id, meta = {}) => { const handle = await factory.createAgent(ctx, { sessionId: id, meta }); membership.add(id); pinned.add(id); archived.add(id); workspace.headers.set(id, handle.agent.session.header); return handle.agent }
  try { await run({ home, root, headers, live, cacheRows, emitted, pinned, archived, file, exists, services, factory, registry, deletion, create, membership, ctx }) }
  finally { deletion.dispose(); await rm(home, { recursive: true, force: true }) }
}

test('confirmation is required; only temporary roots and their subagents are permanently removed', async () => fixture(async f => {
  const rootId = await f.registry.reserve(), ordinary = randomUUID(), child = randomUUID(), grandchild = randomUUID(), fork = randomUUID()
  await f.create(rootId); await f.create(ordinary); await f.create(child, { origin: 'subagent', parentSession: rootId }); await f.create(grandchild, { origin: 'subagent', parentSession: child }); await f.create(fork, { origin: 'fork', parentSession: rootId })
  await assert.rejects(f.deletion.preview(ordinary), error => error.status === 403)
  await assert.rejects(f.deletion.preview(child), /临时主会话/)
  const preview = await f.deletion.preview(rootId)
  assert.equal(preview.descendants, 2); assert.equal(await f.exists(rootId), true, 'preview and cancellation leave records intact')
  await assert.rejects(f.deletion.commit({ ...preview, confirmed: false }), error => error.status === 403)
  await assert.rejects(f.deletion.commit({ ...preview, nonce: 'forged', confirmed: true }), error => error.status === 403)
  const result = await f.deletion.commit({ ...preview, confirmed: true })
  assert.equal(result.deletedSessionIds.length, 3)
  for (const id of [rootId, child, grandchild]) {
    assert.equal(await f.exists(id), false); assert.equal(f.live.has(id), false); assert.equal(f.cacheRows.has(id), false)
    assert.equal(f.membership.has(id), false); assert.equal(f.pinned.has(id), false); assert.equal(f.archived.has(id), false)
    assert.equal(f.services.sessionPersistence.coldLogMemo.has(id), false)
  }
  assert.equal(await readFile(f.file(ordinary), 'utf8'), 'chat content')
  assert.equal(await f.exists(fork), true, 'independent forks survive')
  assert.equal(f.services.sessionQuery.reconciled, true)
  assert.deepEqual(await f.deletion.commit({ ...preview, confirmed: true }), result, 'lost-response retry is idempotent')
  await assert.rejects(f.factory.resume(f.ctx, { resumeSessionId: rootId }), /彻底删除/)
  await f.services.sessionProjectionCache.put(rootId, {}, { content: 'late write' }); assert.equal(f.cacheRows.has(rootId), false)
  f.deletion.dispose(); const restarted = new SessionDeletion(f.ctx, f.registry, f.home)
  try { assert.equal(restarted.blocks(rootId), true); await assert.rejects(f.factory.createAgent(f.ctx, { sessionId: rootId }), /彻底删除/) } finally { restarted.dispose() }
}))

test('new subagents require a fresh confirmation; active work requires explicit stop', async () => fixture(async f => {
  const id = await f.registry.reserve(), agent = await f.create(id), preview = await f.deletion.preview(id)
  await f.create(randomUUID(), { origin: 'subagent', parentSession: id })
  await assert.rejects(f.deletion.commit({ ...preview, confirmed: true }), /重新确认/)
  agent.status = 'running'; const next = await f.deletion.preview(id); assert.equal(next.running, true)
  await assert.rejects(f.deletion.commit({ ...next, confirmed: true }), /仍在运行/)
  assert.equal(await f.exists(id), true)
  await f.deletion.commit({ ...next, confirmed: true, stopRunning: true }); assert.equal(await f.exists(id), false)
}))

test('path escapes and directory links are refused before deletion', async () => fixture(async f => {
  const id = await f.registry.reserve(), agent = await f.create(id), header = agent.session.header
  await assert.rejects(checkedDirectory({ root: f.root, locate: () => ({ path: path.join(f.home, 'outside', id, 'log') }) }, header), /路径/)
  const outside = path.join(f.home, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'keep.txt'), 'retain')
  await rm(path.dirname(f.file(id)), { recursive: true, force: true })
  await symlink(outside, path.dirname(f.file(id)), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(f.deletion.preview(id), /链接|异常路径/)
  assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'retain')
}))
