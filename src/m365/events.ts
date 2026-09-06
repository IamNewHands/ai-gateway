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

/** 判断是否像图片 URL（同原版 chathub isImageURL 启发式；2026-09-06 增补微软系域名判定，移植自 M365-2api multimodal.ts:271-301） */
function looksLikeImageURL(v: string): boolean {
  if (v.startsWith('data:image/')) return true
  let url: URL
  try {
    url = new URL(v)
  } catch {
    return false
  }
  const host = url.hostname.toLowerCase()
  const path = url.pathname.toLowerCase()
  const withQuery = (v.split('#')[0] || '').toLowerCase()
  // 微软系域名（Bing/Designer/Office/SharePoint）生成的图片 URL：扩展名常在 query 里，
  // 或以 /th、create、image 等路径特征出现，仅靠扩展名/substring 'image' 会漏判
  if (
    host.endsWith('bing.com') || host.endsWith('bing.net') ||
    host.endsWith('windows.net') || host.endsWith('microsoft.com') ||
    host.endsWith('office.com') || host.endsWith('sharepoint.com')
  ) {
    if (
      path.includes('/th') || path.includes('create') || path.includes('image') ||
      url.searchParams.has('id') || url.searchParams.has('pid') ||
      /\.(?:gif|jpe?g|png|webp)(&|$)/.test(path)
    ) return true
  }
  if (/\.(png|jpe?g|gif|webp)(&|$)/.test(withQuery)) return true
  if (withQuery.includes('image')) return true
  return false
}

/**
 * 从事件列表提取图片 URL（供多模态结果转写）。
 * 兼容原版启发式：键 url/imageurl/thumbnailurl/downloadurl/src/value/data、
 * 结尾为 *Urls/videoUrls 的数组、以及 data:image base64。
 */
export function imageURLs(events: unknown[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const IMG_KEYS = new Set(['url', 'imageurl', 'thumbnailurl', 'downloadurl', 'src', 'contenturl', 'mediaurl', 'originalimageurl'])
  const walk = (x: unknown) => {
    if (Array.isArray(x)) {
      for (const item of x) walk(item)
      return
    }
    if (x && typeof x === 'object') {
      const m = x as Record<string, unknown>
      for (const [k, v] of Object.entries(m)) {
        const lk = k.toLowerCase()
        if (typeof v === 'string') {
          if (lk === 'value' || lk === 'data') {
            // 原版对 value/data 键同样接受 https 图片 URL（不只 data:image）
            pushImage(v)
          } else if (IMG_KEYS.has(lk)) {
            pushImage(v)
          } else {
            walk(v)
          }
        } else if (Array.isArray(v) && lk.includes('url')) {
          // 原版：键名含 url 的字符串数组都提取（urlList/imageUrls/urls...）
          for (const item of v) {
            if (typeof item === 'string') pushImage(item)
          }
        } else {
          walk(v)
        }
      }
    }
  }
  const pushImage = (s: string) => {
    if (looksLikeImageURL(s) && !seen.has(s)) {
      seen.add(s)
      out.push(s)
    }
  }
  for (const e of events) walk(e)
  return out
}
