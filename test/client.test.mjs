import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
let plugin
const window = { __ModuleLoader__: { load({ factory }) { plugin = factory(() => ({})) } } }
vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), { window })
test('a lost create response and a lost prepare response reuse the original chat', async () => {
  const count = { reserve: 0, create: 0, prepare: 0, select: 0, rename: 0, open: 0 }
  let exists = false
  const create = plugin.createChatController({
    request: async name => {
      if (name === 'reserve') { count.reserve++; return { sessionId: 'fixture', nonce: 'nonce', provider: 'provider', model: 'model', reasoningEffort: 'max' } }
      if (name.startsWith('state?')) return { exists }
      if (name === 'prepare' && ++count.prepare === 1) throw Error('response lost')
      return { ok: true }
    },
    remote: {
      create: async () => { count.create++; exists = true; throw Error('response lost') },
      selectModel: async value => { count.select++; assert.equal(value.reasoningEffort, 'max'); return { ok: true } },
      rename: async () => { count.rename++; return { ok: true } }
    },
    open: async id => { count.open++; assert.equal(id, 'fixture') }
  })
  await assert.rejects(create('source', true), /response lost/)
  await assert.rejects(create('source', true), /response lost/)
  await create('source', true)
  assert.deepEqual(count, { reserve: 1, create: 1, prepare: 2, select: 1, rename: 1, open: 1 })
})
test('native model failures stay visible and do not navigate to an unprepared conversation', async () => {
  let opens = 0, reserves = 0, selections = 0
  const create = plugin.createChatController({
    request: async name => name === 'reserve' ? (reserves++, { sessionId: 'fixture', provider: 'p', model: 'm' }) : { ok: true },
    remote: { create: async () => ({ ok: true, value: { sessionId: 'fixture' } }), selectModel: async () => ++selections === 1 ? { ok: false, error: { message: 'selection failed' } } : { ok: true }, rename: async () => ({ ok: true }) },
    open: () => opens++
  })
  await assert.rejects(create('source', false), /selection failed/)
  assert.equal(opens, 0); await create('source', false); assert.equal(opens, 1); assert.equal(reserves, 1)
})
