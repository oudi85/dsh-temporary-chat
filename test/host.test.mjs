import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-no-memory-test-'))
process.env.DSH_HOME = path.join(root, 'home'); await mkdir(process.env.DSH_HOME)
const { NoMemoryRegistry } = await import('../lib/registry.js')
const { apply } = await import('../lib/index.js')
const event = (id,text) => ({ type:'user/message',seq:1,time:1700000000000,data:{id,role:'user',source:{kind:'user'},content:[{type:'text',text}]} })
const makeSession = (id,parentSession) => ({id,header:{id,cwd:root,...(parentSession?{parentSession,delegationDepth:1}:{})},snapshotEvents:()=>[event('msg-'+id,'fixture user message')],requestHeader:()=>({config:{provider:'fixture-provider',model:'fixture-model',reasoningEffort:'max'}}),append(type,data){this.appended.push({type,data})},appended:[]})
try {
  const sessions = new Map(), hooks = new Map(), prompts = [], routes = [], disposed = [];
  const normal = makeSession('ordinary'); sessions.set(normal.id,normal)
  let custom = false;
  const permissions = {current:()=>custom?'custom':'full',set:(s,p)=>s.append('permission/preset',{preset:p}),permissionState:()=>({sandbox:'workspace-write',approval:'never'})}
  const services={sessions:{get:id=>sessions.get(id)},agents:{get:id=>id===normal.id?{session:normal}:undefined},permissionPresets:permissions,
    sessionController:{agents:{selectionFor:()=>({current:normal.requestHeader().config}),presetForSession:()=> 'default'}},
    workspaceRegistry:{list:()=>[{id:'workspace-fixture',sessionIds:new Set([normal.id])}]}}
  const ctx={get:name=>services[name],webServer:{register:r=>{routes.push(r);return()=>{}}},systemPrompt:{section:p=>{prompts.push(p);return()=>{}}},on:(name,fn)=>{hooks.set(name,fn);return()=>{}},effect:factory=>disposed.push(factory())}
  apply(ctx);assert.equal(routes[0].path,'/api/dsh-temporary-chat')
  const call = async (route,body,remoteAddress='127.0.0.1',headers={}) => {
    const bytes=body===undefined?[]:[...Buffer.from(JSON.stringify(body))].map(byte=>Buffer.from([byte]));
    const req=Readable.from(bytes);req.socket={remoteAddress};req.headers={host:'127.0.0.1:19387',...headers};req.method=body===undefined?'GET':'POST';req.url='/api/dsh-temporary-chat/'+route
    const res={writeHead(status){this.status=status},end(text){this.body=JSON.parse(text)}}
    await routes[0].handler(req,res);return res;
  }
  const reservation=(await call('reserve',{fromSessionId:normal.id})).body
  assert.ok(reservation.sessionId.startsWith('dsh-nomemory-'));assert.equal(reservation.reasoningEffort,'max');assert.equal(reservation.agentPreset,'default');assert.equal(reservation.workspaceId,'workspace-fixture')
  const registryFile=path.join(process.env.DSH_HOME,'no-memory-sessions.json')
  assert.ok(new NoMemoryRegistry(registryFile).has(reservation.sessionId),'recorded before creation')
  const temp=makeSession(reservation.sessionId),child=makeSession('child',temp.id),grandchild=makeSession('grandchild','child');[temp,child,grandchild].forEach(s=>sessions.set(s.id,s))
  const allowed=['bash','web_search','read_file','subagent_spawn','ptc','memory_recall','memory_write','calendar_add'];const denied=[]
  const agent={session:temp,ctx:{tools:{view:()=>({restrictableNames:allowed,visible:new Map(allowed.filter(n=>!denied.includes(n)).map(n=>[n,{}]))}),restrict:({deny})=>{denied.push(...deny);return()=>{}}}}};
  await hooks.get('agent/created')({agent});assert.deepEqual(denied,['memory_recall','memory_write','calendar_add']);assert.ok(allowed.filter(n=>!denied.includes(n)).includes('subagent_spawn'))
  const childAgent={...agent,session:child};await hooks.get('agent/created')({agent:childAgent});assert.ok(new NoMemoryRegistry(registryFile).has('child'),'child remains excluded after parent unload/restart')
  const grandAgent={...agent,session:grandchild};await hooks.get('agent/pre-step')({agent:grandAgent},()=> 'next');assert.ok(new NoMemoryRegistry(registryFile).has('grandchild'))
  assert.ok(prompts[0].text({agent}).includes('关闭窗口或重启不会自动删除'));assert.equal(prompts[0].text({agent:{session:normal}}),'')
  assert.equal((await call('prepare',{sessionId:temp.id,nonce:'wrong'})).status,403)
  assert.equal((await call('prepare',{sessionId:temp.id,nonce:reservation.nonce})).status,200);assert.equal(temp.appended[0].data.preset,'full')
  assert.equal((await call('prepare',{sessionId:temp.id,nonce:reservation.nonce})).status,200,'lost-response retries are idempotent');assert.equal(temp.appended.length,1)
  custom=true;const customReserve=(await call('reserve',{fromSessionId:normal.id})).body;const customSession=makeSession(customReserve.sessionId);sessions.set(customSession.id,customSession);custom=false
  assert.equal((await call('prepare',{sessionId:customSession.id,nonce:customReserve.nonce})).status,200);assert.deepEqual(customSession.appended,[{type:'sandbox/mode',data:{mode:'workspace-write'}},{type:'approval/policy',data:{policy:'never'}}]);custom=false
  assert.equal((await call('config',{enabled:false})).status,200);assert.equal((await call('reserve',{fromSessionId:normal.id})).status,409)
  const disabled=(await call('state?sessionId='+temp.id)).body;assert.equal(disabled.enabled,false);assert.equal(disabled.temporary,true)
  assert.equal((await call('reserve',{fromSessionId:normal.id,temporary:false})).status,200,'can return to normal chat with entrance disabled')
  assert.equal((await call('state',undefined,'10.0.0.8')).status,403)
  assert.equal((await call('config',{enabled:true},'127.0.0.1',{origin:'https://foreign.example'})).status,403)
  assert.equal((await call('state',undefined,'127.0.0.1',{host:'foreign.example:19387'})).status,403)
  assert.equal((await call('config',null)).status,400)
  assert.equal((await call('config',{enabled:true,label:'中文💜'})).status,200,'UTF-8 request chunks retain split multibyte characters')
  assert.equal((await call('config',{enabled:true,padding:'字'.repeat(3000)})).status,413,'limit is measured in bytes')
  assert.equal((await call('config',{enabled:false})).status,200)
  services.loader={entries:()=>[{options:{name:'@a9i5k4/dsh-auto-memory'},disabled:false}]}
  await call('config',{enabled:true})
  assert.equal((await call('reserve',{fromSessionId:normal.id})).status,409,'unadapted memory cannot silently capture a new temporary conversation')
  assert.equal((await call('state')).body.compatible,false)
  services.loader=undefined
  await call('config',{enabled:false})
  assert.equal(JSON.parse(await readFile(path.join(process.env.DSH_HOME,'dsh-temporary-chat.json'))).enabled,false)

  console.log('standalone host checks passed')
} finally { await rm(root,{recursive:true,force:true}) }
