import { NoMemoryRegistry, sharedNoMemoryRegistry, NO_MEMORY_NOTICE, isNoMemoryId } from './temporary-chat-registry.js'
export { NoMemoryRegistry, sharedNoMemoryRegistry, NO_MEMORY_NOTICE, isNoMemoryId }

// Guard every entry and every disk primitive, not only the raw-message collector.
// Other plugins and ordinary chat/tool capabilities are outside this guard.
export function installNoMemoryGuards(engine, registry) {
  registry = sharedNoMemoryRegistry(registry)
  registry.adapterVersion = 1
  engine._noMemory = registry
  engine.isNoMemorySession = value => registry.has(value, id => {
    const ctx = engine._ctxRef
    return ctx?.get?.('sessions')?.get?.(id) || ctx?.get?.('agents')?.get?.(id)?.session
  })
  const current = () => engine.currentRuntime?.().agent
  const blocks = {
    captureUserDetails: [0, 'promise'], captureUserDetailEvent: [0, 'promise'],
    refresh: [0, 'promise'], _doRefresh: [0, 'promise'],
    consolidateTurn: [1, 'promise'], consolidateMemory: [0, 'promise'], maintain: [1, 'promise'],
    seedRuntimeFromSession: [0, 'void'], observeSessionEvent: [0, 'null'], observeToolResult: [0, 'null'],
    ingestAgentLifecycle: [0, 'null'], ingestEnvelope: [0, 'null'],
    renderMemoryDynamic: [0, 'text'], renderUserDetails: [0, 'text'],
    recall: [2, 'refusal'], searchSessionHistory: [-1, 'empty'], lexicalSessionScanFallback: [-1, 'array'],
    readTextSafe: [-1, 'promise'], writeFull: [-1, 'write'], writeFullRaw: [-1, 'write'],
    appendText: [-1, 'write'], appendTextRaw: [-1, 'write'],
  }
  for (const [name, [index, kind]] of Object.entries(blocks)) {
    const original = engine[name]
    if (typeof original !== 'function') continue
    engine[name] = function (...args) {
      const candidate = index < 0 ? current() : args[index]?.agent || args[index]
      if (this.isNoMemorySession(candidate) || this.isNoMemorySession(current())) {
        if (kind === 'write') return Promise.reject(Error('无记忆对话：记忆写入已关闭。'))
        if (kind === 'refusal') return Promise.resolve('无记忆对话：历史记忆读取已关闭。')
        if (kind === 'empty') return Promise.resolve([])
        if (kind === 'array') return []
        if (kind === 'promise') return Promise.resolve('')
        return kind === 'text' ? '' : null
      }
      return original.apply(this, args)
    }
  }
}

export async function executeMemoryToolGuarded(engine, execute, args, exec) {
  const agent = exec?.agent
  if (engine.isNoMemorySession(agent)) return '本对话已开启无记忆模式，记忆读取和写入已关闭；其他工具照常可用。'
  return agent ? engine.withAgent(agent, () => execute(args, exec)) : execute(args, exec)
}
