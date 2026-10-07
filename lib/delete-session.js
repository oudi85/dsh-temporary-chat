import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { lstat, realpath, rm } from 'node:fs/promises'
import { atomicReplace } from './registry.js'

const fail = (status, message) => Object.assign(Error(message), { status })
const encode = id => String(id).split('').map(ch => /^[A-Za-z0-9._-]$/.test(ch) ? ch : '~' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')).join('')
const inside = (root, target) => { const relative = path.relative(root, target); return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative) }

// Deletion is confined to native session-owned directories. User workspace files and billing are separate.
export async function checkedDirectory(persistence, header) {
  const root = path.resolve(persistence.root), canonicalRoot = await realpath(root)
  const directory = path.dirname(persistence.locate(header).path)
  const relative = path.relative(root, directory), segments = relative.split(path.sep)
  if (!inside(root, directory) || segments.length !== 2 || segments[1] !== encode(header.id)) throw fail(409, '会话存储路径无法安全验证，已停止删除')
  for (let n = 1; n <= 2; n++) {
    const target = path.join(root, ...segments.slice(0, n))
    try {
      const info = await lstat(target)
      if (!info.isDirectory() || info.isSymbolicLink() || !inside(canonicalRoot, await realpath(target))) throw fail(409, '会话目录包含链接或异常路径，已停止删除')
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return directory
}

export class SessionDeletion {
  constructor(ctx, registry, home) {
    this.ctx = ctx; this.registry = registry; this.file = path.join(home, 'deleted-temporary-sessions.json')
    this.deleted = new Set(); this.handles = new Map(); this.inflight = new Map(); this.plans = new Map(); this.tail = Promise.resolve(); this.error = ''
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8'))
      if (data.version !== 1 || !Array.isArray(data.sessionIds) || data.sessionIds.some(id => typeof id !== 'string' || !id)) throw Error('invalid deleted-session metadata')
      this.deleted = new Set(data.sessionIds)
    } catch (error) { if (error.code !== 'ENOENT') this.error = '删除状态损坏，已停止删除：' + error.message }
    this.restoreFactory = this.captureHandles()
    const cache = ctx.get('sessionProjectionCache')
    if (cache?.put) {
      const original = cache.put, service = this
      const wrapped = function (id, ...args) { return service.deleted.has(id) ? Promise.resolve() : original.call(this, id, ...args) }
      cache.put = wrapped
      this.restoreCache = () => { if (cache.put === wrapped) cache.put = original }
    }
  }
  supported() {
    const persistence = this.ctx.get('sessionPersistence')
    return !this.error && !!this.restoreFactory && typeof persistence?.locate === 'function' && typeof persistence?.root === 'string'
  }
  blocks(value) {
    let session = typeof value === 'string' ? { id: value } : value?.session || value
    const seen = new Set()
    while (session) {
      const header = session.header || session, id = String(session.id || header.id || '')
      if (this.deleted.has(id)) return true
      const parent = header.parentSession
      if (header.origin !== 'subagent' || !parent || seen.has(parent)) return false
      if (this.deleted.has(parent)) return true
      seen.add(parent); session = this.ctx.get('sessions')?.get(parent)
    }
    return false
  }
  captureHandles() {
    let factory
    try { factory = this.ctx.get('agents')?.requireFactory?.().target || this.ctx.get('agentLoop') } catch { return null }
    if (!factory || !['createAgent', 'resume'].every(key => typeof factory[key] === 'function')) return null
    const undo = []
    for (const key of ['createAgent', 'resume']) {
      const original = factory[key], service = this
      const wrapped = function (...args) {
        const options = args[1] || {}, id = options.sessionId || options.resumeSessionId
        if (service.blocks(id) || service.blocks(options.parentAgent)) return Promise.reject(fail(410, '该临时会话已彻底删除'))
        let task
        task = Promise.resolve().then(() => original.apply(this, args)).then(handle => {
          if (handle?.agent && service.registry.has(handle.agent, sid => service.ctx.get('sessions')?.get(sid))) service.handles.set(handle.agent.id, handle)
          return handle
        }).finally(() => { if (service.inflight.get(id) === task) service.inflight.delete(id) })
        if (id) service.inflight.set(id, task)
        return task
      }
      factory[key] = wrapped
      undo.push(() => { if (factory[key] === wrapped) factory[key] = original })
    }
    return () => undo.forEach(fn => fn())
  }
  async family(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) throw fail(400, '请选择临时会话')
    const query = this.ctx.get('sessionQuery'), persistence = this.ctx.get('sessionPersistence')
    const records = query?.listSessions ? await query.listSessions() : await persistence.list()
    const byId = new Map(records.map(row => { const header = row.header || row; return [header.id, header] }))
    for (const session of this.ctx.get('sessions')?.list?.() || []) byId.set(session.id, session.header)
    const root = byId.get(sessionId)
    if (!root) throw fail(404, '会话不存在或已删除')
    if (!this.registry.has(root, id => byId.get(id))) throw fail(403, '此入口仅允许删除临时会话')
    if (root.origin === 'subagent') throw fail(403, '请从临时主会话删除，子代理记录会一并清理')
    const selected = new Set([sessionId]), headers = [root]
    for (let index = 0; index < headers.length; index++) {
      for (const header of byId.values()) if (header.origin === 'subagent' && header.parentSession === headers[index].id && !selected.has(header.id)) {
        selected.add(header.id); headers.push(header)
      }
    }
    return headers
  }
  async active(headers) {
    for (const header of headers) {
      if (this.ctx.get('agents')?.get(header.id)?.status === 'running') return true
      if (this.ctx.waterfall && (await this.ctx.waterfall('workspace/session-activity', { sessionId: header.id }, () => Promise.resolve([]))).length) return true
    }
    return false
  }
  async preview(sessionId) {
    if (!this.supported()) throw fail(409, this.error || '当前 Harness 的会话存储暂不支持安全删除')
    for (const [nonce, row] of this.plans) if (Date.now() - row.at > 300000 && !row.busy) this.plans.delete(nonce)
    const headers = await this.family(sessionId)
    for (const header of headers) {
      await checkedDirectory(this.ctx.get('sessionPersistence'), header)
      if (this.ctx.get('agents')?.get(header.id) && !this.handles.has(header.id)) throw fail(409, '此会话尚未接入删除管理，请重启 Harness 后重试')
    }
    const nonce = randomUUID(), running = await this.active(headers)
    this.plans.set(nonce, { at: Date.now(), sessionId, headers, running })
    return { sessionId, nonce, count: headers.length, descendants: headers.length - 1, running }
  }
  commit(body) {
    const task = this.tail.catch(() => {}).then(() => this.perform(body))
    this.tail = task; return task
  }
  async perform({ sessionId, nonce, confirmed, stopRunning }) {
    const plan = this.plans.get(nonce)
    if (confirmed !== true || !plan || plan.sessionId !== sessionId || Date.now() - plan.at > 300000) throw fail(403, '删除确认已失效，请重新打开删除窗口')
    if (plan.result) return plan.result
    if (!plan.started) {
      const current = await this.family(sessionId)
      const identity = rows => rows.map(row => row.id + ':' + row.createdAt).sort().join('\n')
      if (identity(current) !== identity(plan.headers)) throw fail(409, '子会话发生变化，请重新确认删除范围')
      if (await this.active(current) && stopRunning !== true) throw fail(409, '会话仍在运行，请确认停止任务后删除')
      for (const header of current) await checkedDirectory(this.ctx.get('sessionPersistence'), header)
      const next = new Set([...this.deleted, ...current.map(header => header.id)])
      await atomicReplace(this.file, JSON.stringify({ version: 1, sessionIds: [...next] }) + '\n')
      this.deleted = next; plan.started = true
    }
    plan.busy = true
    try {
      const persistence = this.ctx.get('sessionPersistence'), sessions = this.ctx.get('sessions'), agents = this.ctx.get('agents')
      if (stopRunning === true) for (const header of plan.headers) await this.ctx.get('workspaceRegistry')?.stopSessionActivity?.(header.id)
      if (stopRunning === true) for (const header of plan.headers) {
        const agent = agents?.get(header.id)
        if (agent?.whenIdle) {
          let timer
          try { await Promise.race([agent.whenIdle(), new Promise((_, reject) => { timer = setTimeout(() => reject(fail(409, '任务还未完全停止，请稍后重试删除')), 12000) })]) }
          finally { clearTimeout(timer) }
        }
      }
      await Promise.allSettled(plan.headers.map(header => this.inflight.get(header.id)).filter(Boolean))
      if (await this.active(plan.headers)) throw fail(409, '任务还未完全停止，请稍后重试删除')
      for (const header of [...plan.headers].reverse()) {
        const handle = this.handles.get(header.id)
        if (agents?.get(header.id) && !handle) throw fail(409, '会话尚未释放，请重启 Harness 后重试删除')
        if (handle) { await handle.dispose(); this.handles.delete(header.id) }
        if (sessions?.get(header.id) || agents?.get(header.id)) throw fail(409, '会话仍被占用，请关闭后重试')
      }
      // Serialize cache deletion after detach-triggered write-backs on the native domain queue.
      const cache = this.ctx.get('sessionProjectionCache')
      for (const header of plan.headers) {
        const directory = await checkedDirectory(persistence, header)
        await rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 })
        persistence.coldLogMemo?.delete(header.id)
        this.ctx.get('sessionQuery')?._observations?.cache?.delete(header.id)
        if (cache?.table) await cache.table.delete(header.id)
      }
      const workspace = this.ctx.get('workspaceRegistry')
      for (const header of plan.headers) {
        for (const entity of workspace?.list?.() || []) if (entity.sessionIds.includes(header.id)) await entity.detachSession(header.id)
        await workspace?.unpinSession?.(header.id); await workspace?.unarchiveSession?.(header.id)
        workspace?.headers?.delete(header.id); workspace?.sessionPaths?.delete(header.id); workspace?.invalidSessionPaths?.delete(header.id)
      }
      const query = this.ctx.get('sessionQuery')
      if (query?._db && query?._serialized && query?._reconcile) await query._serialized(undefined, () => query._reconcile(undefined))
      for (const header of plan.headers) this.ctx.emit?.('api-session/removed', header.id)
      plan.result = { ok: true, sessionId, deletedSessionIds: plan.headers.map(header => header.id), persistent: false }
      return plan.result
    } finally { plan.busy = false }
  }
  dispose() { this.restoreFactory?.(); this.restoreCache?.(); this.handles.clear() }
}
