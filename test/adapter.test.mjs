import test from 'node:test'
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { NoMemoryRegistry, installNoMemoryGuards, executeMemoryToolGuarded } from '../integration/no-memory-mode.js'

test('memory primitives isolate concurrent chats and retain original memories', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-guard-test-'))
  try {
    const registry = new NoMemoryRegistry(path.join(root, 'registry.json'))
    const temp = { session: { id: await registry.reserve() } }, normal = { session: { id: 'ordinary' } }
    const child = { session: { id: 'child', header: { parentSession: temp.session.id } } }
    const context = new AsyncLocalStorage(), memory = path.join(root, 'memory.md')
    await writeFile(memory, '原有细节完整保留')
    let captures = 0
    const engine = {
      currentRuntime: () => ({ agent: context.getStore() }), withAgent: (agent, fn) => context.run(agent, fn),
      readTextSafe: file => readFile(file, 'utf8'), writeFull: (file, value) => writeFile(file, value),
      captureUserDetails: async () => captures++, renderMemoryDynamic: () => '历史细节',
      searchSessionHistory: async () => ['normal history']
    }
    installNoMemoryGuards(engine, registry)
    assert.equal(registry.adapterVersion, 1)
    await engine.captureUserDetails(temp); await engine.captureUserDetails(child); assert.equal(captures, 0)
    await engine.captureUserDetails(normal); assert.equal(captures, 1)
    assert.equal(engine.renderMemoryDynamic({ agent: temp }), '')
    assert.equal(engine.renderMemoryDynamic({ agent: normal }), '历史细节')
    const values = await Promise.all([
      engine.withAgent(temp, async () => { await Promise.resolve(); await assert.rejects(engine.writeFull(memory, '覆盖'), /写入已关闭/); return engine.readTextSafe(memory) }),
      engine.withAgent(normal, async () => { await Promise.resolve(); return engine.readTextSafe(memory) })
    ])
    assert.deepEqual(values, ['', '原有细节完整保留'])
    assert.deepEqual(await engine.withAgent(temp, () => engine.searchSessionHistory('secret')), [])
    assert.equal(await readFile(memory, 'utf8'), '原有细节完整保留')
    let calls = 0
    await executeMemoryToolGuarded(engine, () => calls++, {}, { agent: temp }); assert.equal(calls, 0)
    await executeMemoryToolGuarded(engine, () => calls++, {}, { agent: normal }); assert.equal(calls, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})
