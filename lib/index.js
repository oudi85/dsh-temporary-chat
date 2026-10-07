import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { NoMemoryRegistry, sharedNoMemoryRegistry, NO_MEMORY_NOTICE, atomicReplace } from './registry.js'
import { SessionDeletion } from './delete-session.js'

export const name = 'dsh-temporary-chat'
export const inject = ['webServer', 'systemPrompt', 'tools', 'sessions', 'agents']

export function apply(ctx) {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const configFile = path.join(home, 'dsh-temporary-chat.json')
  const registry = sharedNoMemoryRegistry(new NoMemoryRegistry(path.join(home, 'no-memory-sessions.json')))
  const deletion = new SessionDeletion(ctx, registry, home)
  let enabled = true, configError = ''
  try { const cfg = JSON.parse(readFileSync(configFile, 'utf8')); enabled = cfg.enabled !== false } catch (error) { if (error.code !== 'ENOENT') { enabled = false; configError = '插件设置损坏，请重新启用以修复：' + error.message } }
  const reservations = new Map(), restricted = new WeakMap(), disposers = []
  const temporary = value => registry.has(value, id => ctx.get('sessions')?.get?.(id))
  const compatible = () => {
    const entries = ctx.get('loader')?.entries?.() || []
    return ![...entries].some(entry => !entry.disabled && /(?:^|\/)dsh-auto-memory$/.test(entry.options?.name || '')) || registry.adapterVersion === 1
  }
  const warning = () => compatible() ? '' : '当前记忆插件尚未接入无记忆隔离，请先安装兼容适配。'
  const expire = () => { for (const [id,row] of reservations) if (Date.now()-row.at > 300000) reservations.delete(id) }
  const inheritPermissions = (target, reservation) => {
    if (!reservation || reservation.prepared) return
    const knobs = reservation.permissions, permissions = ctx.get('permissionPresets')
    if (knobs.preset && knobs.preset !== 'custom') permissions?.set(target, knobs.preset)
    else if (knobs.preset === 'custom') {
      if (knobs.sandbox) target.append('sandbox/mode', { mode: knobs.sandbox })
      if (knobs.approval) target.append('approval/policy', { policy: knobs.approval })
    }
    reservation.prepared = true
  }
  const resolveAgent = async id => {
    const live = ctx.get('agents')?.get?.(id)
    if (live || !id) return live
    const controller = ctx.get('sessionController')?.agents
    if (!controller?.resolveAgent) return undefined
    const result = await controller.resolveAgent(id)
    if (result.error) throw Error(result.error.message || '对话无法重新打开')
    return result.agent
  }
  const guard = async ({ agent }) => {
    if (deletion.blocks(agent)) throw Object.assign(Error('该临时会话已彻底删除'), { status: 410 })
    if (!agent || !temporary(agent)) return
    await registry.remember(String(agent.session.id))
    // The deny list contains memory capabilities only; shells, web, files, subagents and PTC remain intact.
    const names = [...agent.ctx.tools.view(agent).restrictableNames].filter(name => /^(memory_|calendar_)/.test(name))
    const signature = names.slice().sort().join('\0')
    if (restricted.get(agent)?.signature !== signature && names.length) {
      const prior = restricted.get(agent)
      const dispose = agent.ctx.tools.restrict({ deny: names })
      restricted.set(agent, { signature, dispose }); prior?.dispose?.()
    }
  }
  disposers.push(ctx.on('agent/created', async payload => {
    expire()
    if (payload.agent?.session) inheritPermissions(payload.agent.session, reservations.get(payload.agent.session.id))
    await guard(payload)
  }))
  disposers.push(ctx.on('agent/pre-step', async (payload, next) => { await guard(payload); return next() }))
  // A standalone section also preserves the no-memory policy if the memory plugin is disabled.
  disposers.push(ctx.systemPrompt.section({ name: 'dsh:temporary-chat-policy', order: 9999, text: context => temporary(context?.agent) ? NO_MEMORY_NOTICE : '' }))
  const send = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)) }
  const readBody = async req => {
    let text = '', bytes = 0
    const decoder = new StringDecoder('utf8')
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > 8192) throw Object.assign(Error('请求过长'), { status: 413 })
      text += decoder.write(buffer)
    }
    try {
      const body = JSON.parse(text + decoder.end() || '{}')
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('请提供 JSON 对象')
      return body
    } catch (error) { throw Object.assign(error, { status: 400 }) }
  }
  disposers.push(ctx.webServer.register({ kind: 'prefix', path: '/api/dsh-temporary-chat', handler: async (req, res) => {
    if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)) return send(res,403,{error:'loopback-only'})
    const host = req.headers?.host || ''
    if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)) return send(res,403,{error:'invalid host'})
    const origin = req.headers?.origin
    if (origin && !['dsh-app://app', 'http://' + host, 'https://' + host].includes(origin)) return send(res,403,{error:'invalid origin'})
    try {
      expire()
      const url = new URL(req.url, 'http://127.0.0.1')
      if (req.method === 'GET' && url.pathname === '/api/dsh-temporary-chat/state') {
        const id = url.searchParams.get('sessionId') || ''
        const agent = ctx.get('agents')?.get?.(id)
        const availableTools = url.searchParams.get('inspectTools') === '1' && agent
          ? [...agent.ctx.tools.view(agent).visible.keys()].sort() : undefined
        return send(res,200,{enabled,temporary:temporary(ctx.get('sessions')?.get?.(id) || id),exists:!!ctx.get('sessions')?.get?.(id),persistent:true,compatible:compatible(),warning:warning(),error:registry.error || configError,availableTools,canDelete:deletion.supported(),deleted:deletion.blocks(id)})
      }
      if (req.method !== 'POST') return send(res,405,{error:'method not allowed'})
      const body = await readBody(req)
      if (url.pathname === '/api/dsh-temporary-chat/delete-preview') return send(res,200,await deletion.preview(body.sessionId))
      if (url.pathname === '/api/dsh-temporary-chat/delete') return send(res,200,await deletion.commit(body))
      if (url.pathname === '/api/dsh-temporary-chat/config') {
        if (typeof body.enabled !== 'boolean') return send(res,400,{error:'enabled 必须是布尔值'})
        await atomicReplace(configFile,JSON.stringify({enabled:body.enabled})+'\n')
        enabled=body.enabled; configError=''; return send(res,200,{enabled})
      }
      if (url.pathname === '/api/dsh-temporary-chat/reserve') {
        if (body.temporary !== false && !enabled) return send(res,409,{error:'请先在设置中启用临时对话插件'})
        if (body.temporary !== false && !compatible()) return send(res,409,{error:warning()})
        if (body.temporary !== undefined && typeof body.temporary !== 'boolean') return send(res,400,{error:'temporary 必须是布尔值'})
        const from = String(body.fromSessionId || '')
        if (!from) return send(res,400,{error:'请先打开一条对话'})
        const agent = await resolveAgent(from)
        const session = agent?.session || ctx.get('sessions')?.get?.(from)
        const cwd = session?.header?.cwd
        if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return send(res,400,{error:'无法确定当前工作目录，请先打开一条普通对话'})
        const selection = ctx.get('sessionController')?.agents
        const config = agent && selection?.selectionFor?.(agent)?.current || session?.requestHeader?.()?.config || agent?.options || {}
        const workspace = ctx.get('workspaceRegistry')?.list?.()?.find(row => [...(row.sessionIds || [])].includes(from))
        const sessionId = body.temporary === false ? randomUUID() : await registry.reserve()
        const nonce = randomUUID()
        const permissions = ctx.get('permissionPresets')
        const knobs = session && permissions?.permissionState?.(session) || {}
        reservations.set(sessionId,{from,nonce,at:Date.now(),cwd,permissions:{preset:session && permissions?.current?.(session),sandbox:knobs.sandbox ?? ctx.get('shell')?.sandboxMode,approval:knobs.approval ?? ctx.get('approval')?.config?.policy}})
        return send(res,200,{sessionId,nonce,cwd,workspaceId:workspace?.id,temporary:body.temporary!==false,agentPreset:session && selection?.presetForSession?.(session),provider:config.provider,model:config.model,reasoningEffort:config.reasoningEffort})
      }
      if (url.pathname === '/api/dsh-temporary-chat/prepare') {
        const reservation=reservations.get(body.sessionId)
        if (!reservation || reservation.nonce!==body.nonce) return send(res,403,{error:'invalid reservation'})
        const target=ctx.get('sessions')?.get?.(body.sessionId)
        if (!target) return send(res,409,{error:'新对话尚未就绪，请重试'})
        if (target.header?.cwd !== reservation.cwd) return send(res,409,{error:'新对话工作目录不匹配'})
        inheritPermissions(target,reservation)
        return send(res,200,{ok:true,temporary:temporary(target),persistent:true})
      }
      return send(res,404,{error:'not found'})
    } catch (error) { send(res,error.status || 500,{error:String(error.message || error)}) }
  }}))
  ctx.effect(() => () => { deletion.dispose(); for (const dispose of disposers) dispose?.() }, 'dsh-temporary-chat: surfaces')
}
