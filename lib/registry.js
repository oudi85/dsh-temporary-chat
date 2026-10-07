import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { mkdir, open, rename, rm } from 'node:fs/promises'
export async function atomicReplace(file, text) {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = file + '.' + randomUUID() + '.tmp'
  try {
  const handle = await open(tmp, 'wx', 0o600)
  try { await handle.writeFile(text); await handle.sync() } finally { await handle.close() }
  for (let n = 0; ; n++) {
    try { await rename(tmp, file); return } catch (e) {
      if (n >= 4 || !['EPERM','EACCES','EBUSY'].includes(e.code)) throw e
      await new Promise(resolve => setTimeout(resolve, 30 * 2 ** n))
    }
  }
  } finally { await rm(tmp, { force: true }).catch(() => {}) }
}


export const NO_MEMORY_NOTICE = '[无记忆对话]\n本对话保留正常模型、权限及工具调用能力。只使用当前对话提供的信息及本对话历史；不要读取其他对话或长期记忆，也不要向长期记忆、项目记忆、日志、白板、日历、技能记忆写入内容。memory_* 与 calendar_* 记忆工具已关闭。对话记录正常保存，关闭窗口或重启不会自动删除。用户自行管理本对话。'
export const isNoMemoryId = id => /^dsh-nomemory-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id || '').replace(/^session-(?=dsh-nomemory-)/, ''))

// Metadata only: these identities prevent preserved chats and child sessions becoming memory sources.
export class NoMemoryRegistry {
  constructor(file) {
    this.file = file; this.ids = new Set(); this.pending = Promise.resolve(); this.error = ''
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'))
      if (data.version !== 1 || !Array.isArray(data.sessionIds) || data.sessionIds.some(id => typeof id !== 'string' || !id)) throw Error('invalid no-memory registry')
      this.ids = new Set(data.sessionIds)
    } catch (error) { if (error.code !== 'ENOENT') this.error = error.message }
  }
  has(value, lookup) {
    let session = typeof value === 'string' ? { id: value } : value?.session || value
    const seen = new Set()
    for (let depth = 0; session && depth < 32; depth++) {
      const id = String(session.id || session.header?.id || '')
      if (isNoMemoryId(id) || this.ids.has(id) || session.header?.noMemory === true) return true
      const parent = session.header?.parentSession || session.parentSession
      if (!parent || seen.has(parent)) return false
      if (isNoMemoryId(parent) || this.ids.has(parent)) return true
      seen.add(parent); session = lookup?.(parent)
    }
    return false
  }
  remember(id) {
    if (this.error) return Promise.reject(Error(this.error))
    if (typeof id !== 'string' || !id || this.ids.has(id)) return this.pending
    this.ids.add(id) // Isolation takes effect synchronously before any first step/event.
    const run = this.pending.catch(() => {}).then(async () => {
      await atomicReplace(this.file, JSON.stringify({ version: 1, sessionIds: [...this.ids] }) + '\n')
    }).catch(error => { this.error = error.message; throw error })
    this.pending = run; return run
  }
  async reserve() {
    const id = 'dsh-nomemory-' + randomUUID()
    await this.remember(id); return id
  }
}

export function sharedNoMemoryRegistry(registry) {
  const key = Symbol.for('dsh.noMemoryMode.registries.v1')
  const registries = globalThis[key] || (globalThis[key] = new Map())
  const resolved = path.resolve(registry.file)
  const file = process.platform === 'win32' ? resolved.toLowerCase() : resolved
  if (!registries.has(file)) registries.set(file, registry)
  return registries.get(file)
}
