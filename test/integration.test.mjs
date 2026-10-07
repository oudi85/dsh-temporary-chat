import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { applyRules, integrate } from '../scripts/integrate-auto-memory.mjs'

test('conflicting anchors abort without overwriting source', () => {
  assert.throws(() => applyRules('duplicate duplicate', [{ before: 'duplicate', after: 'changed' }]), /停止修改/)
  assert.throws(() => applyRules('different', [{ before: 'missing', after: 'changed' }]), /停止修改/)
  assert.equal(applyRules('a\r\nb\r\n', [{ before: 'a\n', after: 'z\n' }]), 'z\r\nb\r\n')
})
test('check is read-only; apply backs up exact bytes; restore refuses later edits', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-adapter-test-'))
  try {
    await mkdir(path.join(root, 'lib'))
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: '@a9i5k4/dsh-auto-memory', version: '3.2.10' }))
    const rules = JSON.parse(await readFile(new URL('../integration/auto-memory-rules.json', import.meta.url)))
    const original = Buffer.from(rules.map(row => row.before).join('\n// fixture boundary\n').replaceAll('\n', '\r\n'))
    const file = path.join(root, 'lib/index.js')
    await writeFile(file, original)
    assert.equal((await integrate(root)).compatible, true)
    assert.deepEqual(await readFile(file), original)
    assert.equal((await integrate(root, 'apply')).applied, true)
    const patched = await readFile(file)
    await writeFile(file, Buffer.concat([patched, Buffer.from('\n// later edit')]))
    await assert.rejects(integrate(root, 'restore'), /保留你的修改/)
    await writeFile(file, patched)
    assert.equal((await integrate(root, 'restore')).restored, true)
    assert.deepEqual(await readFile(file), original)
    await assert.rejects(readFile(path.join(root, 'lib/no-memory-mode.js')), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
