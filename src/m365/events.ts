/**
 * ChatHub 事件分类（移植自 M365-Copilot2API internal/chathub/stream_events.go + events.go）。
 * 把 SignalR update 帧里的 messages[] 转成协议无关事件：
 * text / reasoning（ChainOfThought）/ tool / progress。
 */

export type ChatHubStreamEvent = {
  kind: 'text' | 'reasoning' | 'tool' | 'progress'
  text?: string
  messageType?: string
  contentType?: string
  toolName?: string
  arguments?: string
  raw?: unknown
}

/** 解析单条 SignalR JSON 帧 → 归一化 Event */
export function normalizeFrame(raw: string): { type: number; target?: string; arguments?: unknown[]; item?: unknown; error?: unknown } | null {
  try {
    const obj = JSON.parse(raw)
    if (!obj || typeof obj !== 'object') return null
    return {
      type: typeof obj['type'] === 'number' ? obj['type'] : -1,
      target: typeof obj['target'] === 'string' ? obj['target'] : undefined,
      arguments: Array.isArray(obj['arguments']) ? obj['arguments'] : undefined,
      item: obj['item'],
      error: obj['error'],
    }
  } catch {
    return null
  }
}

/** 从单个 message 对象提取工具名/参数（兼容多种字段名，同原版 extractToolFields） */
function extractToolFields(m: Record<string, unknown>): { name: string; args?: string } {
  let name = ''
  for (const k of ['name', 'toolName', 'pluginName', 'functionName']) {
    const v = m[k]
    if (typeof v === 'string' && v !== '') {
      name = v
      break
    }
  }
  if (!name) return { name: '' }
  for (const k of ['arguments', 'args', 'parameters', 'input', 'functionArguments']) {
    const v = m[k]
    if (v !== undefined && v !== null) {
      try {
        const s = JSON.stringify(v)
        if (s && s.length > 0) return { name, args: s }
      } catch { /* ignore */ }
    }
  }
  return { name: '' }
}

/** 把 ChatHub messages[] 数组转成 StreamEvent 列表 */
export function classifyUpdateMessages(messages: unknown[]): ChatHubStreamEvent[] {
  const out: ChatHubStreamEvent[] = []
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const m = raw as Record<string, unknown>
    const text = typeof m['text'] === 'string' ? m['text'] : ''
    const mt = typeof m['messageType'] === 'string' ? m['messageType'] : ''
    const ct = typeof m['contentType'] === 'string' ? m['contentType'] : ''
    const origin = typeof m['contentOrigin'] === 'string' ? m['contentOrigin'] : ''
    const cot = m['addToChainOfThought'] === true
    let kind: ChatHubStreamEvent['kind'] = 'text'
    if (mt === 'Progress' || ct === 'SearchResults' || ct === 'Code' || ct === 'ToolCall') {
      kind = 'progress'
    }
    // ChatHub 用 contentOrigin / addToChainOfThought 标记多步推理（ChainOfThought）
    if (origin === 'ChainOfThoughtSummary' || cot) {
      kind = 'reasoning'
    }
    const { name, args } = extractToolFields(m)
    if (name && args) {
      kind = 'tool'
    }
    if (text === '' && kind === 'text') continue
    out.push({ kind, text, messageType: mt, contentType: ct, toolName: name || undefined, arguments: args })
  }
  return out
}

/**
 * 递归遍历整个 update 参数，提取原生插件调用（ChatHub 常把调用放在 messages[] 之外）。
 * seen 用于去重（同工具+同参数只报一次）。
 */
export function extractToolEvents(value: unknown, seen: Set<string>): ChatHubStreamEvent[] {
  const out: ChatHubStreamEvent[] = []
  const walk = (x: unknown) => {
    if (Array.isArray(x)) {
      for (const item of x) walk(item)
      return
    }
    if (x && typeof x === 'object') {
      const m = x as Record<string, unknown>
      const { name, args } = extractToolFields(m)
      if (name && args) {
        const key = name + '|' + args
        if (!seen.has(key)) {
          seen.add(key)
          out.push({ kind: 'tool', toolName: name, arguments: args, raw: x })
        }
      }
      for (const k of Object.keys(m)) walk(m[k])
    }
  }
  walk(value)
  return out
}

/** 从事件列表提取图片 URL（供多模态结果转写，非核心路径） */
export function imageURLs(events: unknown[]): string[] {
  const out: string[] = []
  const walk = (x: unknown) => {
    if (Array.isArray(x)) {
      for (const item of x) walk(item)
      return
    }
    if (x && typeof x === 'object') {
      const m = x as Record<string, unknown>
      const t = m['type']
      if (t === 'Image' && typeof m['url'] === 'string') out.push(m['url'])
      for (const k of Object.keys(m)) walk(m[k])
    }
  }
  for (const e of events) walk(e)
  return out
}
