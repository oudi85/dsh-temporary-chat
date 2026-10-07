import { readFile, writeFile, mkdir, rename, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'

const integration = fileURLToPath(new URL('../integration/', import.meta.url))
const digest = value => createHash('sha256').update(value).digest('hex')
const normalize = value => value.replaceAll('\r\n', '\n')
const missingOK = async file => { try { return await readFile(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
async function replace(file, bytes) {
  const temp = file + '.' + randomUUID() + '.tmp'
  try { await writeFile(temp, bytes, { flag: 'wx' }); await rename(temp, file) }
  finally { await rm(temp, { force: true }).catch(() => {}) }
}
export function applyRules(text, rules) {
  let result = normalize(text)
  for (const [index, rule] of rules.entries()) {
    if (result.split(rule.before).length !== 2) throw Error('记忆插件版本不匹配，已停止修改。冲突位置：' + (index + 1))
    result = result.replace(rule.before, rule.after)
  }
  return text.includes('\r\n') ? result.replaceAll('\n', '\r\n') : result
}
export async function integrate(pluginDir, mode = 'check') {
  if (!['check', 'apply', 'restore'].includes(mode)) throw Error('未知操作')
  const root = await realpath(path.resolve(pluginDir))
  const locate = relative => {
    const target = path.resolve(root, relative)
    if (!target.startsWith(root + path.sep)) throw Error('目标路径超出插件目录')
    return target
  }
  const backup = locate('.dsh-temporary-chat-backup'), manifestFile = path.join(backup, 'manifest.json')
  if (mode === 'restore') {
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
    const originals = []
    for (const row of manifest.files) {
      const file = locate(row.file), current = await missingOK(file)
      if (!current || digest(current) !== row.patchedHash) throw Error('适配后文件被改动，为保留你的修改，已停止恢复：' + row.file)
      const bytes = row.originalHash ? await readFile(locate('.dsh-temporary-chat-backup/' + row.file)) : null
      if (bytes && digest(bytes) !== row.originalHash) throw Error('备份校验失败：' + row.file)
      originals.push({ file, bytes })
    }
    for (const row of originals) { if (row.bytes) await replace(row.file, row.bytes); else await rm(row.file) }
    await rm(manifestFile)
    return { restored: true }
  }
  const pkg = JSON.parse(await readFile(locate('package.json'), 'utf8'))
  if (pkg.name !== '@a9i5k4/dsh-auto-memory') throw Error('这不是支持的 dsh-auto-memory 插件目录')
  const source = await readFile(locate('lib/index.js'), 'utf8')
  if (source.includes('installNoMemoryGuards(this')) {
    const adapter = await readFile(locate('lib/no-memory-mode.js'), 'utf8')
    if (!adapter.includes('registry.adapterVersion = 1')) throw Error('现有适配版本过旧，请更新适配文件后再启用')
    return { alreadyAdapted: true, version: pkg.version }
  }
  if (!/^3\.2\.(?:8|10)(?:-|$)/.test(pkg.version)) throw Error('暂未验证该记忆插件版本，请先等待兼容更新：' + pkg.version)
  if (await missingOK(manifestFile)) throw Error('存在上一次适配备份，请先恢复再重新安装')
  const rules = JSON.parse(await readFile(path.join(integration, 'auto-memory-rules.json'), 'utf8'))
  const edits = [{ file: 'lib/index.js', text: applyRules(source, rules) }]
  const details = await missingOK(locate('lib/user-details.js'))
  if (details) edits.push({ file: 'lib/user-details.js', text: applyRules(details.toString('utf8'), [
    { before: "import { retryRename } from './fs-retry.js'\n", after: "import { retryRename } from './fs-retry.js'\nimport { isNoMemoryId } from './no-memory-mode.js'\n" },
    { before: '  async capture({ workspace, sessionId, messages }) {\n', after: '  async capture({ workspace, sessionId, messages }) {\n    if (isNoMemoryId(sessionId)) return 0\n' }
  ]) })
  const previousAdapter = await missingOK(locate('lib/no-memory-mode.js'))
  if (previousAdapter) throw Error('存在其他无记忆适配文件，已停止覆盖')
  edits.push({ file: 'lib/no-memory-mode.js', text: await readFile(path.join(integration, 'no-memory-mode.js'), 'utf8') })
  if (await missingOK(locate('lib/temporary-chat-registry.js'))) throw Error('存在其他模式注册表模块，已停止覆盖')
  edits.push({ file: 'lib/temporary-chat-registry.js', text: await readFile(path.join(integration, 'temporary-chat-registry.js'), 'utf8') })
  // Validate every anchor before touching any installed source. Rename avoids editing package-store hardlinks.
  if (mode === 'check') return { compatible: true, version: pkg.version, files: edits.map(row => row.file) }
  const manifest = { version: 1, files: [] }, originals = new Map()
  for (const edit of edits) {
    const original = await missingOK(locate(edit.file)); originals.set(edit.file, original)
    const target = locate('.dsh-temporary-chat-backup/' + edit.file)
    await mkdir(path.dirname(target), { recursive: true })
    if (original) await writeFile(target, original)
    manifest.files.push({ file: edit.file, originalHash: original ? digest(original) : null, patchedHash: digest(Buffer.from(edit.text)) })
  }
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n')
  try { for (const edit of edits) await replace(locate(edit.file), edit.text) }
  catch (error) {
    for (const edit of edits) { const original = originals.get(edit.file); if (original) await replace(locate(edit.file), original); else await rm(locate(edit.file), { force: true }) }
    await rm(manifestFile); throw error
  }
  return { applied: true, version: pkg.version, backup }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), at = args.indexOf('--plugin-dir'), pluginDir = args[at + 1]
  if (at < 0 || !pluginDir || pluginDir.startsWith('--')) {
    console.error('用法：node scripts/integrate-auto-memory.mjs --plugin-dir "记忆插件目录" [--apply|--restore]'); process.exitCode = 1
  } else {
    try { console.log(JSON.stringify(await integrate(pluginDir, args.includes('--restore') ? 'restore' : args.includes('--apply') ? 'apply' : 'check'), null, 2)) }
    catch (error) { console.error(error.message); process.exitCode = 1 }
  }
}
