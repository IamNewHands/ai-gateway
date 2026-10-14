/**
 * web-sse.ts — TRAE **Remote** 事件流 → OpenAI SSE / chat.completion。
 * 移植自 Trae2api-cn `src/sse.py` 的 `translate_web_events` + `collect_nonstream_web`。
 *
 * ## 为什么单独一个文件
 *
 * Remote 的事件模型与 SOLO 完全不同，硬塞进 `sse.ts` 会把两套语义混在一个文件里：
 *
 * | | SOLO | Remote |
 * |---|---|---|
 * | 核心事件 | `output`（**增量**） | `plan_item`（**累积快照**） |
 * | 正文 | `output.response` | `plan_item.content` / `message.content` |
 * | 思考 | `output.reasoning_content` | `plan_item.thought` / `reasoning_content` |
 * | 心跳 | 无（靠网关注入） | **上游主动发** `heartbeat` |
 *
 * **累积快照是本文件的核心难点**：上游每帧重发「到目前为止的全部文本」，而不是增量。
 * 直接转发会让客户端看到 `a`、`ab`、`abc` 拼成 `aababc`。所有 delta 计算
 *（`cliTextDelta` / `mergePlanMessageText` / `ProtocolTextAccumulator`）都是为这件事服务。
 *
 * ## 保留心跳是硬要求
 *
 * 源侧注释记录过实测：静默丢弃 `heartbeat` 会让 zcode 之类客户端**误判本轮结束并重放
 * 上一次的工具请求**。所以心跳帧必须原样透成 SSE 注释行。
 */
import { encodeSse, normalizeSoloUsage, SoloToolCallMerger, type SoloStreamEndInfo } from './sse'
import { buildTraeRunawayInfo, TraeReasoningGuard, TRAE_RUNAWAY_GRACE_CHARS, traeRunawayErrorFrame, type TraeRunawayInfo } from './runaway'
import type { SOLOStreamError, TraeRemoteEvent } from './types'

/** SSE 注释行：客户端忽略内容，但会重置 idle 计时器。 */
export const WEB_HEARTBEAT_LINE = ': keep-alive\n\n'

// ===== 纯文本工具块处理 =====

/** 已知的「文本形态工具调用」标记对（上游偶尔把调用序列化进正文）。 */
const TOOL_BLOCK_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['<opencode_tool_call>', '</opencode_tool_call>'],
  ['<tool_use>', '</tool_use>'],
  ['<tool_call', '</tool_call>'],
  ['<tool_cell', '</tool_cell>'],
  ['<invoke', '</invoke>'],
  ['<bash>', '</bash>'],
  ['<read>', '</read>'],
  ['<write>', '</write>'],
  ['<edit>', '</edit>'],
  ['<glob>', '</glob>'],
  ['<grep>', '</grep>'],
  ['<task>', '</task>'],
]

/**
 * 隐藏一个**尚未闭合**的文本工具块。
 *
 * 为什么必须「隐藏」而不是「等它完整再删」：流式路径上一旦把半个 `<tool_call` 发给客户端
 * 就无法撤回，而它后面紧跟的才是正文 —— 用户会先看到一串协议碎片。
 * 因此从「可能的块起点」开始全部扣住，等闭合或 EOF 再决定。
 */
export function holdIncompleteToolBlock(text: string, holdEscapePrefix = true): string {
  if (!text) return ''
  const lowered = text.toLowerCase()
  let earliest = text.length
  for (const [opening, closing] of TOOL_BLOCK_PAIRS) {
    const start = lowered.indexOf(opening)
    if (start >= 0 && lowered.indexOf(closing, start + opening.length) < 0) {
      earliest = Math.min(earliest, start)
    }
  }
  // 快照可能正好切在 `<tool_ca` 这种半截标记上：尾部若是一个已知标记的前缀也要扣住。
  const lastLt = lowered.lastIndexOf('<')
  if (lastLt >= 0) {
    const suffix = lowered.slice(lastLt)
    if (TOOL_BLOCK_PAIRS.some(([opening]) => opening.startsWith(suffix))) {
      earliest = Math.min(earliest, lastLt)
    }
  }
  if (holdEscapePrefix) {
    // 转义等待帧可能在首个 `<` 出现前就断在反斜杠串里。
    const m = /\\+[ \t\r\n]*$/.exec(text)
    if (m) earliest = Math.min(earliest, m.index)
  }
  return text.slice(0, earliest)
}

/** 剥掉**已闭合**的文本工具块，返回可见正文。 */
export function stripToolCallBlocks(text: string): string {
  if (!text) return ''
  let out = text
  for (const [opening, closing] of TOOL_BLOCK_PAIRS) {
    let guard = 0
    while (guard++ < 64) {
      const start = out.toLowerCase().indexOf(opening)
      if (start < 0) break
      const end = out.toLowerCase().indexOf(closing, start + opening.length)
      if (end < 0) break
      out = out.slice(0, start) + out.slice(end + closing.length)
    }
  }
  return out
}

/** 可见文本 = 剥掉完整工具块。 */
export function visibleText(text: unknown): string {
  return typeof text === 'string' ? stripToolCallBlocks(text) : ''
}

// ===== delta 计算 =====

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length)
  let i = 0
  while (i < limit && left[i] === right[i]) i++
  return i
}

/** 最长「左串后缀 == 右串前缀」重叠长度。 */
function textSuffixPrefixOverlap(left: string, right: string, minimum = 4): number {
  const limit = Math.min(left.length, right.length)
  for (let size = limit; size >= minimum; size--) {
    if (left.slice(left.length - size) === right.slice(0, size)) return size
  }
  return 0
}

/**
 * 由「上一个已下发文本」和「当前完整文本」算出本帧该下发的增量。
 *
 * 三种情形：
 *  - 当前以旧串开头 → 增量就是多出来的尾巴（最常见的快照推进）；
 *  - 旧串以当前开头 → 收到的是**过期快照**，不发（发出去等于回退）；
 *  - 两者都不包含 → 按公共前缀切（上游重写了开头，只能发差异部分）。
 */
export function cliTextDelta(previous: string, current: string): string {
  if (!current) return ''
  if (current.startsWith(previous)) return current.slice(previous.length)
  if (previous.startsWith(current)) return ''
  return current.slice(commonPrefixLength(previous, current))
}

/**
 * 合并 `plan_item` 正文与 `message` 正文，且**不重放**任何一边。
 *
 * Remote 会把同一段回答同时放在 plan（过程快照）和 message（最终消息）里，
 * 两边都发就会重复。这里用「包含关系 → 前缀关系 → 后缀/前缀重叠 → 硬拼接」四级降级，
 * 覆盖上游各种下发顺序。
 */
export function mergePlanMessageText(planText: string, messageText: string): string {
  const plan = planText || ''
  const message = messageText || ''
  if (!plan) return message
  if (!message) return plan
  if (plan === message || plan.startsWith(message) || plan.endsWith(message)) return plan
  if (message.startsWith(plan)) return message
  const overlap = textSuffixPrefixOverlap(plan, message)
  if (overlap) return plan + message.slice(overlap)
  return plan.replace(/\s+$/, '') + '\n\n' + message.replace(/^\s+/, '')
}

// ===== 内嵌思考块 =====

const EMBEDDED_THINK_RE = /<(think|thinking)\b[^>]*>([\s\S]*?)<\/\1>/gi

/** 拆出 `<think>…</think>` 内嵌思考块，返回 `[reasoning, visible]`。 */
export function splitEmbeddedReasoning(text: unknown): [string, string] {
  if (typeof text !== 'string' || !text) return ['', '']
  const bodies: string[] = []
  EMBEDDED_THINK_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = EMBEDDED_THINK_RE.exec(text)) !== null) {
    if (m[2]) bodies.push(m[2])
  }
  if (bodies.length === 0) return ['', text]
  EMBEDDED_THINK_RE.lastIndex = 0
  return [bodies.join('\n'), text.replace(EMBEDDED_THINK_RE, '')]
}

// ===== 推理叙述过滤 =====

/** 叙述句首：上游把「用户想…」「让我…」这类过程独白混进正文。 */
const NARRATION_SENTENCE_RE = new RegExp(
  '^[ \\t]*(?:'
  + "(?:the\\s+)?user(?:'s)?\\s+(?:wants?|asks?|is\\s+asking|input|query|question|has\\s+sent|request(?:s|ed)?|needs?)\\b"
  + "|(?:so\\s+|ok(?:ay)?[,.]?\\s+|now[,.]?\\s+)?let(?:'s|\\s+me)\\b"
  + "|i\\s+(?:need\\s+to|should|will|'ll|must|can)\\b"
  + '|(?:this|that)\\s+(?:is|does\\s?n?o?t?|require)\\b.{0,60}?(?:question|request|tool|skill|exploration|change)'
  + '|(?:no|nothing)\\s+(?:tools?|skill|codebase|file)\\b'
  + '|simple\\s+(?:factual|conceptual|knowledge)\\s+question\\b'
  + '|(?:this\\s+is\\s+a\\s+)?(?:straightforward|simple|direct)\\s+(?:question|request|task)\\b'
  + '|(?:the\\s+)?(?:simplest|easiest|best|standard)\\s+way\\s+(?:is|would\\s+be)\\b'
  + "|(?:i'?ll\\s+|i\\s+will\\s+)?answer\\s+(?:in|with|concisely|directly|briefly)\\b"
  + "|(?:here'?s|here\\s+is)\\s+(?:the|a)\\s+(?:answer|solution|approach)\\b"
  + ')[^\\n]*?(?:[.!?]|\\n|$)',
  'i'
)

/** 可能是叙述句的**未完成**前缀（如 "The" / "The user"）。 */
/**
 * ⚠️ 已知边界（忠实移植源侧，未扩大）：本正则只覆盖到 `the user('s)` / `let me` /
 * `i need|should|will|must|can` 等**词前缀**为止。源侧 docstring 举的
 * `"The user wa"` 其实**不在**匹配范围内（`t` 分支在 `user` 后只能再接 `'?s?`），
 * 故那种中间态不会被扣住。这里保持与源侧一致——扩大匹配范围有误扣正常答案开头的风险，
 * 而那比偶尔放出一段待删叙述更糟。
 */
const NARRATION_PREFIX_RE = new RegExp(
  '^[ \\t]*(?:'
  + "t(?:h(?:e(?:\\s+u(?:s(?:e(?:r(?:'?s?)?)?)?)?)?)?)?"
  + "|l(?:e(?:t(?:'?s?|\\s+m(?:e)?)?)?)?"
  + '|i(?:\\s+(?:n(?:e(?:e(?:d)?)?)?|s(?:h(?:o(?:u(?:l(?:d)?)?)?)?)?|w(?:i(?:l(?:l)?)?)?|m(?:u(?:s(?:t)?)?)?))?'
  + '|s(?:i(?:m(?:p(?:l(?:e)?)?)?)?)?'
  + '|n(?:o(?:\\s+t(?:o(?:o(?:l(?:s)?)?)?)?)?)?'
  + '|t(?:h(?:i(?:s)?)?)?'
  + ')[ \\t]*$',
  'i'
)

/** 是否启用「精简推理」（关掉 = 原样透出思考）。 */
export function conciseReasoningEnabled(): boolean {
  return true
}

/**
 * 丢掉累积快照**开头**的元叙述句。
 *
 * 只删前缀（不删中间），这样结果随快照增长保持稳定 —— 增量流式依赖这个性质。
 * `holdIncomplete=true` 时，若整段目前还只是叙述（或停在叙述半句上）就返回 `''`，
 * 让调用方**扣住**不发：一旦发到线上就收不回，而真正的答案会跟在被删的叙述后面。
 */
export function stripReasoningNarration(text: string, holdIncomplete = false): string {
  if (!text || !conciseReasoningEnabled()) return text
  if (holdIncomplete && NARRATION_PREFIX_RE.test(text)) return ''
  let remainder = text
  let removed = false
  for (let i = 0; i < 6; i++) {
    const m = NARRATION_SENTENCE_RE.exec(remainder)
    if (!m || m.index !== 0 || m[0].length === 0) break
    const candidate = remainder.slice(m[0].length)
    if (!candidate.trim()) return holdIncomplete ? '' : text
    remainder = candidate
    removed = true
  }
  if (!removed) return text
  if (!remainder.trim()) return text
  return remainder.replace(/^[ \t\n]+/, '')
}

const REASONING_NODE_SPLIT_RE = /(?<=[。！？!?；;])\s*|\r?\n+/
const REASONING_PRIORITY_RE = /(?:结论|结果|原因|关键|方案|修复|验证|完成|失败|成功|风险|因此|最终|conclusion|result|because|therefore|fix(?:ed)?|verified|success|fail(?:ed)?|risk)/i

/**
 * 把完整推理链压成几段要点（有界、抽取式）。
 *
 * 目的：**不把模型的完整工作轨迹当推理下发**。上游思考链可以长到几万字，
 * 原样转发既撑爆客户端上下文也泄露过程细节。这里只留「定向段 + 结论段 + 最新段」。
 */
export function compactReasoningText(text: unknown, maxChars = 800, maxLines = 6): string {
  if (typeof text !== 'string' || !text.trim() || maxChars <= 0 || maxLines <= 0) return ''
  let cleaned = visibleText(text)
  cleaned = cleaned.replace(/<(?:think|thinking)\b[^>]*>|<\/(?:think|thinking)>/gi, '')
  cleaned = stripReasoningNarration(cleaned.trim(), false).trim()
  if (!cleaned) return ''

  const nodes: string[] = []
  const seen = new Set<string>()
  for (const raw of cleaned.split(REASONING_NODE_SPLIT_RE)) {
    let node = raw.replace(/[ \t]+/g, ' ').trim()
    if (!node) continue
    if (node.length > 240) node = node.slice(0, 237).replace(/\s+$/, '') + '...'
    const fingerprint = node.replace(/\s+/g, ' ').toLowerCase()
    if (seen.has(fingerprint)) continue
    seen.add(fingerprint)
    nodes.push(node)
  }
  if (nodes.length === 0) return ''

  let selectedNodes = nodes
  if (nodes.length > maxLines) {
    const priority: number[] = []
    nodes.forEach((node, i) => { if (REASONING_PRIORITY_RE.test(node)) priority.push(i) })
    const selected: number[] = [0]
    for (const i of priority) {
      if (!selected.includes(i)) selected.push(i)
      if (selected.length >= maxLines) break
    }
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (!selected.includes(i)) selected.push(i)
      if (selected.length >= maxLines) break
    }
    selectedNodes = selected.slice(0, maxLines).sort((a, b) => a - b).map((i) => nodes[i])
  }
  let result = selectedNodes.join('\n')
  if (result.length > maxChars) result = result.slice(0, maxChars - 3).replace(/\s+$/, '') + '...'
  return result
}

// ===== Remote payload 提取 =====

/** 从 payload 里取推理文本（不当作正文）。 */
export function payloadReasoningText(data: unknown): string {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ''
  const obj = data as Record<string, any>
  for (const key of ['reasoning_content', 'reasoningContent', 'thought', 'thinking']) {
    const value = obj[key]
    if (typeof value === 'string' && value) return value
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const nestedKey of ['content', 'text', 'summary']) {
        const nested = (value as Record<string, any>)[nestedKey]
        if (typeof nested === 'string' && nested) return nested
      }
    }
  }
  const message = obj['message']
  if (message && typeof message === 'object' && !Array.isArray(message)) {
    const nested = payloadReasoningText(message)
    if (nested) return nested
    const content = (message as Record<string, any>)['content']
    if (Array.isArray(content)) {
      const parts: string[] = []
      for (const block of content) {
        if (!block || typeof block !== 'object' || Array.isArray(block)) continue
        const b = block as Record<string, any>
        const type = String(b['type'] || '').toLowerCase()
        if (type !== 'reasoning' && type !== 'thinking' && type !== 'reasoning_text') continue
        const value = b['text'] ?? b['content'] ?? b['value']
        if (typeof value === 'string') parts.push(value)
      }
      if (parts.length > 0) return parts.join('\n')
    }
  }
  return ''
}

/**
 * `plan_item` 是否采用「分离式」布局。
 *
 * 两种上游布局必须区分：
 *  - **分离式**（新）：`reasoning_content` 是思考、`thought` 是**答案快照**
 *    （例如 `thought="pong", reasoning_content=""`）；
 *  - **旧式**：没有 `reasoning_content` 键，`thought` 就是思考轨迹。
 *
 * 判错会让答案被当成思考丢掉（或反过来把思考当答案发出去）。
 */
export function webPlanHasSplitReasoning(data: Record<string, any>): boolean {
  return 'reasoning_content' in data || 'reasoningContent' in data
}

/** `plan_item` 的思考文本。 */
export function webPlanReasoning(data: Record<string, any>): string {
  if (webPlanHasSplitReasoning(data)) {
    const value = data['reasoning_content']
    if (typeof value === 'string' && value) return value
    const camel = data['reasoningContent']
    return typeof camel === 'string' ? camel : ''
  }
  return payloadReasoningText(data)
}

/** `plan_item` 的**可见答案**快照。 */
export function webPlanContent(data: Record<string, any>): string {
  const content = webMessageText({ content: data['content'] })
  if (content) return content
  if (webPlanHasSplitReasoning(data)) {
    const thought = data['thought']
    if (typeof thought === 'string') return thought
  }
  return ''
}

/** 从 finish 工具调用里取最终摘要。 */
export function webFinishSummary(data: Record<string, any>): string {
  const tci = data['tool_call_info'] ?? data['toolCallInfo'] ?? {}
  if (tci && typeof tci === 'object' && !Array.isArray(tci)) {
    const rec = tci as Record<string, any>
    if (rec['name'] === 'finish') {
      const params = rec['params'] ?? {}
      if (params && typeof params === 'object' && !Array.isArray(params)) {
        return String((params as Record<string, any>)['summary'] ?? '')
      }
    }
  }
  return ''
}

/** 从 message / content 事件里取可见正文。 */
export function webMessageText(data: unknown): string {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ''
  let obj = data as Record<string, any>
  for (const key of ['message', 'agent_message', 'assistant_message']) {
    const nested = obj[key]
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      obj = nested as Record<string, any>
      break
    }
  }
  const content = obj['content']
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (typeof block === 'string') { parts.push(block); continue }
      if (block && typeof block === 'object' && !Array.isArray(block)) {
        const b = block as Record<string, any>
        const type = String(b['type'] || '').toLowerCase()
        if (type === 'reasoning' || type === 'thinking' || type === 'reasoning_text') continue
        const text = b['text'] ?? b['content']
        if (typeof text === 'string') parts.push(text)
      }
    }
    return parts.join('')
  }
  for (const key of ['text', 'response', 'answer', 'output']) {
    const value = obj[key]
    if (typeof value === 'string') return value
    if (Array.isArray(value)) {
      const parts: string[] = []
      for (const block of value) {
        if (typeof block === 'string') parts.push(block)
        else if (block && typeof block === 'object' && typeof (block as Record<string, any>)['text'] === 'string') {
          parts.push((block as Record<string, any>)['text'])
        }
      }
      if (parts.length > 0) return parts.join('')
    }
  }
  return ''
}

// ===== 工具调用提取 =====

/**
 * 从 Remote payload 里抽调用方可见的工具调用。
 *
 * 只认两种来源：`tool_calls`（OpenAI 形）与 `tool_call_info`（Trae 形，`{name, params}`）。
 * 刻意**不**做文本嗅探 —— 把正文里的疑似 JSON 当工具调用会产生幻觉调用，
 * 而这正是「模型自己发明工具」类事故的来源。
 */
export function callsFromRemotePayload(data: unknown): Record<string, any>[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return []
  const obj = data as Record<string, any>
  const out: Record<string, any>[] = []

  const rawCalls = obj['tool_calls'] ?? obj['toolCalls']
  if (Array.isArray(rawCalls)) {
    for (const call of rawCalls) {
      if (!call || typeof call !== 'object' || Array.isArray(call)) continue
      const c = call as Record<string, any>
      const fn = c['function'] && typeof c['function'] === 'object' && !Array.isArray(c['function'])
        ? (c['function'] as Record<string, any>)
        : c
      const name = String(fn['name'] ?? '').trim()
      if (!name) continue
      const argsRaw = fn['arguments'] ?? fn['input'] ?? '{}'
      const args = typeof argsRaw === 'string' ? argsRaw : JSON.stringify(argsRaw ?? {})
      out.push({
        id: String(c['id'] ?? c['tool_call_id'] ?? ''),
        type: 'function',
        function: { name, arguments: args },
      })
    }
  }

  const info = obj['tool_call_info'] ?? obj['toolCallInfo']
  if (info && typeof info === 'object' && !Array.isArray(info)) {
    const rec = info as Record<string, any>
    const name = String(rec['name'] ?? '').trim()
    // `finish` 不是调用方工具，它是上游的收尾信号（其 summary 走 webFinishSummary）。
    if (name && name !== 'finish') {
      const params = rec['params'] ?? rec['arguments'] ?? {}
      const args = typeof params === 'string' ? params : JSON.stringify(params ?? {})
      out.push({
        id: String(rec['tool_call_id'] ?? rec['id'] ?? obj['id'] ?? ''),
        type: 'function',
        function: { name, arguments: args },
      })
    }
  }
  return out
}

/** 归一化 finish_reason。 */
export function remoteFinishReason(value: unknown, hasToolCalls: boolean): string {
  if (hasToolCalls) return 'tool_calls'
  const text = String(value ?? '').trim().toLowerCase()
  if (text === 'tool_calls' || text === 'tool_call') return 'tool_calls'
  if (text === 'length' || text === 'max_tokens') return 'length'
  return 'stop'
}

// ===== 文本累积器 =====

/**
 * 文本累积器：吃「累积快照」或「增量」，吐出**待下发增量**。
 *
 * 三种投喂方式的区别（源侧同名方法）：
 *  - `add`：不确定是快照还是增量，按公共前缀猜（上游两种都发过）；
 *  - `addSnapshot`：明确是快照，旧快照直接忽略（比当前短的前缀/后缀 = 迟到的旧帧）；
 *  - `addDelta`：明确是增量，直接追加。
 *
 * 选错会让文本重复或丢失，所以上游布局变化时先确认这里。
 */
export class ProtocolTextAccumulator {
  raw = ''
  visible = ''

  private result(final: boolean): [string, Record<string, any>[]] {
    const visible = holdIncompleteToolBlock(visibleText(this.raw), !final)
    const delta = cliTextDelta(this.visible, visible)
    this.visible = visible
    // 工具调用从**未剥壳的原文**里抽：剥壳是为了展示，抽取是为了协议，两者不能共用一份文本。
    const calls = this.raw ? extractToolCallsFromText(this.raw) : []
    return [delta, calls]
  }

  finalize(): [string, Record<string, any>[]] {
    return this.result(true)
  }

  addDelta(value: unknown): [string, Record<string, any>[]] {
    if (typeof value === 'string' && value) this.raw += value
    return this.result(false)
  }

  addSnapshot(value: unknown): [string, Record<string, any>[]] {
    const text = typeof value === 'string' ? value : ''
    if (text) {
      // 累积快照可能乱序到达：比当前短的前缀/后缀是**旧帧**，不是新回答。
      if (this.raw.startsWith(text)) return this.result(false)
      if (this.raw.endsWith(text) && text.length < this.raw.length) return this.result(false)
      this.raw = text
    }
    return this.result(false)
  }

  add(value: unknown): [string, Record<string, any>[]] {
    const text = typeof value === 'string' ? value : ''
    if (text) {
      if (text.startsWith(this.raw)) {
        this.raw = text
      } else if (!this.raw.startsWith(text)) {
        const common = commonPrefixLength(this.raw, text)
        const shorter = Math.min(this.raw.length, text.length)
        if (common >= 4 || (shorter > 0 && common * 2 >= shorter)) this.raw = text
        else this.raw += text
      }
    }
    return this.result(false)
  }
}

/** 从自由文本里抽 OpenAI 形 `tool_calls` JSON（源侧 `_extract_tool_calls` 的窄化版）。 */
function extractToolCallsFromText(text: string): Record<string, any>[] {
  if (!text) return []
  const out: Record<string, any>[] = []
  // 只认「形如 tool_calls 数组」的 JSON 片段，不做通用嗅探。
  const re = /"tool_calls"\s*:\s*(\[[\s\S]*?\])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(m[1])
      if (!Array.isArray(parsed)) continue
      for (const call of parsed) {
        if (!call || typeof call !== 'object' || Array.isArray(call)) continue
        const c = call as Record<string, any>
        const fn = c['function'] && typeof c['function'] === 'object' ? (c['function'] as Record<string, any>) : null
        if (!fn || typeof fn['name'] !== 'string' || !fn['name'].trim()) continue
        const argsRaw = fn['arguments']
        out.push({
          id: String(c['id'] ?? ''),
          type: 'function',
          function: {
            name: fn['name'].trim(),
            arguments: typeof argsRaw === 'string' ? argsRaw : JSON.stringify(argsRaw ?? {}),
          },
        })
      }
    } catch { /* 不是完整 JSON，跳过 */ }
  }
  return out
}

// ===== 流式翻译 =====

export interface WebStreamOptions {
  /** 是否把压缩后的思考作为 `reasoning_content` 下发 */
  includeReasoning?: boolean
  /** 调用方声明的工具名集合（用于过滤上游幻觉调用）；`undefined` = 未声明 */
  allowedTools?: unknown
  toolChoice?: unknown
  forwardUsage?: boolean
  onErr?: (se: SOLOStreamError) => void
  onTruncated?: (info: SoloStreamEndInfo) => void
  onRunaway?: (info: TraeRunawayInfo) => void
  /**
   * 收到上游 `done` 时**立刻**回调 —— 用来回收上游会话（`stopRemoteSession`）。
   *
   * 为什么不只在流收尾（`withSSEKeepAlive` 的 `onClose`）时回收：
   *  - `done` 到达时**请求还在飞**（我们正往响应里写帧），此刻发起的子请求属于本次请求，
   *    一定跑得完；
   *  - `onClose` 是在 `controller.close()` **之后**才跑的，响应已经结束，此刻发起的子请求
   *    可能被运行时直接丢弃 —— 回收静默失败 = 会话泄漏 = 上游并发槽位（实测上限 2）积满，
   *    之后新会话只排队、executor 不启动（2026-10-14 现场就是这个形态）。
   *
   * 附带收益：模型一说完就释放槽位，不必等客户端把流慢慢读完。
   */
  onDone?: () => void
  /**
   * 流**正常收尾**时回传一次可比指标（诊断 / 验收用）。
   *
   * 为什么不能复用 `onDone`：它触发时思考摘要还没算出来（`reasoningChars` 恒为 0），
   * 而「思考强度到底有没有生效」唯一可比的量就是思考字符数 —— 同一道题在 `light` 与
   * `extra_high` 下的 `reasoningChars` 若没有量级差，说明档位根本没被上游采纳。
   */
  onFinish?: (info: WebStreamDoneInfo) => void
}

/**
 * 流收尾指标。
 *
 * `reasoningChars` 是核对思考强度的**可比量**：同一 prompt 下它应随档位单调增长
 *（`light` < `high` < `extra_high`）。若三档的字符数几乎相同，则档位未生效 ——
 * 要么上游忽略了字段，要么我们在下发前就被钳制掉了。
 */
export interface WebStreamDoneInfo {
  contentChars: number
  reasoningChars: number
  sawToolCalls: boolean
  finishReason: string
}

/** 从 OpenAI `tools` 字段抽出工具名集合（`undefined` = 未声明，`Set()` = 显式禁用）。 */
export function allowedToolNames(tools: unknown): Set<string> | undefined {
  if (tools === undefined || tools === null) return undefined
  if (!Array.isArray(tools)) return new Set()
  const names = new Set<string>()
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) continue
    const rec = tool as Record<string, any>
    const fn = rec['function'] && typeof rec['function'] === 'object' ? (rec['function'] as Record<string, any>) : rec
    const name = typeof fn['name'] === 'string' ? fn['name'].trim() : ''
    if (name) names.add(name)
  }
  return names
}

/**
 * Remote 事件流 → OpenAI SSE（ReadableStream）。
 *
 * 收尾纪律与 SOLO 侧一致：**没收到 `done` 就不是成功**。Remote 尤其需要这条——
 * 上游在扁平 query 超限时会**静默关连接**（不报错），此时半句话会被伪装成完整回答。
 * 这里把它报成 `truncated`，由调用方定责（且**不罚号**：不是账号故障）。
 */
export function webStreamToOpenAIStream(
  events: AsyncIterable<TraeRemoteEvent>,
  model: string,
  opts: WebStreamOptions = {}
): ReadableStream<Uint8Array> {
  const includeReasoning = opts.includeReasoning === true
  const forwardUsage = opts.forwardUsage !== false
  const allowed = allowedToolNames(opts.allowedTools)

  return new ReadableStream({
    async start(controller) {
      const id = `chatcmpl-${Date.now()}`
      let sentRole = false
      let sawDone = false
      let sawUsage = false
      let pendingUsage: Record<string, any> | null = null
      let contentChars = 0
      let reasoningChars = 0
      let errorEvent: Record<string, any> | null = null

      const reasoningStates = new Map<string, ProtocolTextAccumulator>()
      const reasoningOrder: string[] = []
      const planStates = new Map<string, ProtocolTextAccumulator>()
      const messageState = new ProtocolTextAccumulator()
      const toolMerger = new SoloToolCallMerger()
      let planStreamedText = ''
      let messageVisibleText = ''
      let streamedText = ''
      let finalSummary = ''
      let finalReason = 'stop'
      let legacyPlanReasoning = false
      const guard = new TraeReasoningGuard()
      let runawayTerminated = false

      const writeChunk = (delta: Record<string, any>, finish: string, extra?: Record<string, unknown>): void => {
        if (!sentRole && Object.keys(delta).length > 0) {
          delta['role'] = 'assistant'
          sentRole = true
        }
        const chunk: Record<string, any> = {
          id,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta }],
        }
        if (finish !== '') chunk['choices'][0]['finish_reason'] = finish
        if (pendingUsage) { chunk['usage'] = pendingUsage; pendingUsage = null }
        if (extra) Object.assign(chunk, extra)
        try { controller.enqueue(encodeSse(JSON.stringify(chunk))) } catch { /* 流已取消 */ }
      }

      const writeDone = (): void => {
        try { controller.enqueue(encodeSse('[DONE]')) } catch { /* 流已取消 */ }
      }

      const writeRunawayTerminal = (): void => {
        if (runawayTerminated) return
        runawayTerminated = true
        const info = buildTraeRunawayInfo(guard, contentChars, false)
        if (opts.onRunaway) { try { opts.onRunaway(info) } catch { /* 诊断不得影响流 */ } }
        try { controller.enqueue(encodeSse(JSON.stringify(traeRunawayErrorFrame(info)))) } catch { /* 已取消 */ }
        writeChunk({}, 'length', { x_trae_runaway: info.kind })
        writeDone()
      }

      const emitCalls = (calls: Record<string, any>[]): boolean => {
        const filtered = filterRemoteCalls(calls, allowed, opts.toolChoice)
        if (filtered.length === 0) return false
        const deltas = toolMerger.add(filtered)
        let emitted = false
        for (const d of deltas) {
          writeChunk({ tool_calls: [d] }, '')
          emitted = true
        }
        return emitted
      }

      const emitMergedText = (): void => {
        const merged = mergePlanMessageText(planStreamedText, messageVisibleText)
        const delta = cliTextDelta(streamedText, merged)
        if (!delta) return
        streamedText += delta
        contentChars += delta.length
        writeChunk({ content: delta }, '')
      }

      try {
        for await (const ev of events) {
          if (runawayTerminated) break
          const event = ev.event
          const data = (ev.data && typeof ev.data === 'object' && !Array.isArray(ev.data))
            ? ev.data as Record<string, any>
            : {}

          if (event === 'heartbeat' || event === 'keepalive' || event === 'ping') {
            // 必须透传：静默丢弃会让客户端误判本轮结束并重放上一次工具请求。
            try { controller.enqueue(new TextEncoder().encode(WEB_HEARTBEAT_LINE)) } catch { /* 已取消 */ }
            continue
          }
          if (event === 'error') {
            errorEvent = data
            break
          }
          if (event === 'token_usage') {
            pendingUsage = normalizeSoloUsage(data['usage'] ?? data)
            sawUsage = true
            continue
          }

          if (event === 'plan_item') {
            const pid = String(data['id'] ?? `plan-${reasoningOrder.length}`)
            const planReasoning = webPlanReasoning(data)
            if (!webPlanHasSplitReasoning(data) && planReasoning) legacyPlanReasoning = true

            let reasoningState = reasoningStates.get(pid)
            if (!reasoningState) { reasoningState = new ProtocolTextAccumulator(); reasoningStates.set(pid, reasoningState) }
            if (!reasoningOrder.includes(pid)) reasoningOrder.push(pid)
            const [, reasoningCalls] = reasoningState.add(planReasoning)

            let visibleState = planStates.get(pid)
            if (!visibleState) { visibleState = new ProtocolTextAccumulator(); planStates.set(pid, visibleState) }
            const [contentDelta, contentCalls] = visibleState.add(webPlanContent(data))

            const planCalls = callsFromRemotePayload(data)
            planCalls.push(...reasoningCalls, ...contentCalls)
            emitCalls(planCalls)

            if (contentDelta) {
              planStreamedText += contentDelta
              emitMergedText()
            }
            const summary = webFinishSummary(data)
            if (summary) finalSummary = summary
            continue
          }

          if (event === 'message' || event === 'assistant_message' || event === 'response'
            || event === 'text' || event === 'output') {
            let text = webMessageText(data)
            const eventReasoning = payloadReasoningText(data)
            const [embeddedReasoning, stripped] = splitEmbeddedReasoning(text)
            text = stripped
            if (eventReasoning || embeddedReasoning) {
              const key = '__messages__'
              let state = reasoningStates.get(key)
              if (!state) { state = new ProtocolTextAccumulator(); reasoningStates.set(key, state) }
              if (!reasoningOrder.includes(key)) reasoningOrder.push(key)
              if (eventReasoning) state.add(eventReasoning)
              if (embeddedReasoning) state.add(embeddedReasoning)
            }
            if (text) {
              // 上游原文投喂退化防护（不是去重后的增量）：重复下发同一段思考时
              // 增量恒为 ''，只在增量上判退化会把「正在空转」整段盲掉。
              guard.feed(text, contentChars > 0)
              const [, messageCalls] = messageState.addSnapshot(text)
              emitCalls(messageCalls)
              messageVisibleText = messageState.visible
              emitMergedText()
            }
            continue
          }

          if (event === 'done') {
            finalReason = String(data['finish_reason'] ?? data['finishReason'] ?? finalReason)
            sawDone = true
            if (opts.onDone) { try { opts.onDone() } catch { /* 回收回调不得影响流 */ } }
            break
          }
        }
      } catch (e) {
        if (!runawayTerminated) {
          const message = (e as Error).message || 'remote stream error'
          try {
            controller.enqueue(encodeSse(JSON.stringify({ error: { message, type: 'transport_error', code: 'remote_stream_error' } })))
          } catch { /* 已取消 */ }
        }
      }

      // ===== 收尾 =====

      // 1) 释放所有累积器里被扣住的尾巴（工具块 / 转义前缀）。
      for (const state of reasoningStates.values()) {
        const [, calls] = state.finalize()
        emitCalls(calls)
      }
      for (const state of planStates.values()) {
        const [contentDelta, calls] = state.finalize()
        emitCalls(calls)
        if (contentDelta) { planStreamedText += contentDelta; emitMergedText() }
      }
      {
        const [, calls] = messageState.finalize()
        emitCalls(calls)
        messageVisibleText = messageState.visible
        emitMergedText()
      }

      // 2) 思考：压缩后走独立通道（正文通道只放答案）。
      const reasoningRaw = reasoningOrder
        .map((k) => reasoningStates.get(k)?.raw ?? '')
        .filter(Boolean)
        .join('\n')
      const reasoningSummary = compactReasoningText(reasoningRaw)
      reasoningChars = reasoningSummary.length
      let sawReasoningOutput = false

      if (finalSummary) {
        const summaryCalls = callsFromRemotePayload({ tool_calls: extractToolCallsFromText(finalSummary) })
        emitCalls(summaryCalls)
        finalSummary = stripReasoningNarration(visibleText(finalSummary).trim(), true).trim()
      }

      const hasToolCalls = toolMerger.results().length > 0

      if (includeReasoning && reasoningSummary) {
        writeChunk({ reasoning_content: reasoningSummary }, '')
        sawReasoningOutput = true
      }

      // 3) 正文补全：finish 摘要可能是唯一答案，或补上快照缺的尾巴。
      if (!hasToolCalls && finalSummary) {
        if (!streamedText) {
          streamedText += finalSummary
          contentChars += finalSummary.length
          writeChunk({ content: finalSummary }, '')
        } else {
          const summary = finalSummary.replace(/\s+$/, '')
          const head = streamedText.trim()
          if (head && summary.startsWith(head)) {
            const tail = summary.slice(head.length)
            if (tail) { streamedText += tail; contentChars += tail.length; writeChunk({ content: tail }, '') }
          } else if (!streamedText.replace(/\s+$/, '').endsWith(summary)) {
            streamedText += '\n\n' + finalSummary
            contentChars += finalSummary.length + 2
            writeChunk({ content: '\n\n' + finalSummary }, '')
          }
        }
      }

      // 4) 分离式布局下「只有思考、没有答案」：把思考放进专用通道，
      //    而不是当成正文 —— 否则用户会看到模型的工作轨迹被当作回答。
      if (!streamedText && !hasToolCalls && reasoningSummary && !sawReasoningOutput && !legacyPlanReasoning) {
        writeChunk({ reasoning_content: reasoningSummary }, '')
        sawReasoningOutput = true
      }

      // 4b) 旧式布局的兜底：该布局下 `thought` **本来就承载答案**（不是思考），
      //     所以这里把它当正文回退，而不是当成「把思考当正文」。
      //     条件里带 `!sawReasoningOutput`：分离式布局已在第 4 步走过，不会重复。
      //     内容取的是**已压缩**的摘要（有界），避免把完整工作轨迹当回答下发。
      if (!streamedText && !hasToolCalls && reasoningSummary && !sawReasoningOutput) {
        streamedText += reasoningSummary
        contentChars += reasoningSummary.length
        writeChunk({ content: reasoningSummary }, '')
      }

      // 5) 退化熔断：只回了垃圾推理且全程无正文 → 不能当成功收尾。
      if (!runawayTerminated && guard.suppressed && contentChars === 0 && !hasToolCalls) {
        writeRunawayTerminal()
        try { controller.close() } catch { /* 已关闭 */ }
        return
      }

      if (errorEvent) {
        const code = String(errorEvent['code'] ?? '')
        const message = String(errorEvent['message'] ?? errorEvent['error'] ?? 'remote upstream error')
        const se: SOLOStreamError = { code: Number(code) || 0, msg: message }
        if (opts.onErr) { try { opts.onErr(se) } catch { /* 诊断不得影响流 */ } }
        writeChunk({}, 'stop', { error: { message: `trae ${code}: ${message}`, type: 'api_error' } })
        writeDone()
        try { controller.close() } catch { /* 已关闭 */ }
        return
      }

      if (!sawDone) {
        // 上游静默断流：不发「成功」的 stop，让调用方按截断定责（不罚号）。
        if (opts.onTruncated) {
          try {
            opts.onTruncated({
              kind: 'no_done',
              contentChars,
              reasoningChars,
              sawToolCalls: hasToolCalls,
              sawUsage,
            })
          } catch { /* 诊断不得影响流 */ }
        }
        writeChunk({}, 'length', { x_trae_truncated: 'no_done' })
        writeDone()
        try { controller.close() } catch { /* 已关闭 */ }
        return
      }

      if (!hasToolCalls && !streamedText && !sawReasoningOutput) {
        writeChunk({ content: '(trae upstream returned an empty response)' }, '')
      }
      // 收尾指标（见 WebStreamDoneInfo）：思考字符数是「档位有没有生效」的唯一可比量。
      if (opts.onFinish) {
        try {
          opts.onFinish({
            contentChars,
            reasoningChars,
            sawToolCalls: hasToolCalls,
            finishReason: remoteFinishReason(finalReason, hasToolCalls),
          })
        } catch { /* 诊断不得影响流 */ }
      }
      writeChunk({}, remoteFinishReason(finalReason, hasToolCalls))
      writeDone()
      try { controller.close() } catch { /* 已关闭 */ }
    },
  })
}

/**
 * 按调用方声明的工具集过滤上游调用。
 *
 * `undefined` = 调用方**没声明** tools 字段 → 保留（兼容自定义入口）；
 * 空集合 = 显式禁用 → 全部丢弃。这个区分是刻意的：把「没声明」当「禁用」
 * 会让不用 tools 字段的普通聊天丢掉上游返回的调用。
 */
export function filterRemoteCalls(
  calls: Record<string, any>[],
  allowed: Set<string> | undefined,
  toolChoice: unknown
): Record<string, any>[] {
  if (!Array.isArray(calls) || calls.length === 0) return []
  if (String(toolChoice ?? '').trim().toLowerCase() === 'none') return []
  let selected = ''
  if (toolChoice && typeof toolChoice === 'object' && !Array.isArray(toolChoice)) {
    const rec = toolChoice as Record<string, any>
    const fn = rec['function'] && typeof rec['function'] === 'object' ? (rec['function'] as Record<string, any>) : rec
    if (typeof fn['name'] === 'string') selected = fn['name'].trim()
  } else if (typeof toolChoice === 'string' && toolChoice.trim() && toolChoice.trim().toLowerCase() !== 'auto' && toolChoice.trim().toLowerCase() !== 'required') {
    selected = toolChoice.trim()
  }
  const out: Record<string, any>[] = []
  for (const call of calls) {
    const name = String(call?.['function']?.['name'] ?? '').trim()
    if (!name) continue
    if (allowed !== undefined && !allowed.has(name)) continue
    if (selected && name !== selected) continue
    out.push(call)
  }
  return out
}

// ===== 非流式聚合 =====

export interface WebAggregateResult {
  resp: Record<string, any> | null
  err: SOLOStreamError | null
  truncated: SoloStreamEndInfo | null
}

/**
 * Remote 事件流 → 单条 `chat.completion`（非流式）。
 *
 * 与流式路径共用同一套 delta / 合并 / 过滤规则，只是不往线上写帧。
 * 收尾判定完全一致：没有 `done` 就是 `truncated`（**不得**把半句话当完整回答返回）。
 */
export async function aggregateWebSse(
  events: AsyncIterable<TraeRemoteEvent>,
  model: string,
  opts: WebStreamOptions = {}
): Promise<WebAggregateResult> {
  const includeReasoning = opts.includeReasoning === true
  const allowed = allowedToolNames(opts.allowedTools)
  const reasoningStates = new Map<string, ProtocolTextAccumulator>()
  const reasoningOrder: string[] = []
  const planStates = new Map<string, ProtocolTextAccumulator>()
  const messageState = new ProtocolTextAccumulator()
  const toolMerger = new SoloToolCallMerger()
  let planText = ''
  let messageVisible = ''
  let usage: Record<string, any> | null = null
  let errorEvent: Record<string, any> | null = null
  let finalSummary = ''
  let finalReason = 'stop'
  let sawDone = false
  let sawUsage = false
  let contentChars = 0
  let legacyPlanReasoning = false

  const collectCalls = (calls: Record<string, any>[]): void => {
    const filtered = filterRemoteCalls(calls, allowed, opts.toolChoice)
    if (filtered.length > 0) toolMerger.add(filtered)
  }

  try {
    for await (const ev of events) {
      const event = ev.event
      const data = (ev.data && typeof ev.data === 'object' && !Array.isArray(ev.data))
        ? ev.data as Record<string, any>
        : {}
      if (event === 'heartbeat' || event === 'keepalive' || event === 'ping') continue
      if (event === 'error') { errorEvent = data; break }
      if (event === 'token_usage') { usage = normalizeSoloUsage(data['usage'] ?? data); sawUsage = true; continue }

      if (event === 'plan_item') {
        const pid = String(data['id'] ?? `plan-${reasoningOrder.length}`)
        const planReasoning = webPlanReasoning(data)
        if (!webPlanHasSplitReasoning(data) && planReasoning) legacyPlanReasoning = true
        let rs = reasoningStates.get(pid)
        if (!rs) { rs = new ProtocolTextAccumulator(); reasoningStates.set(pid, rs) }
        if (!reasoningOrder.includes(pid)) reasoningOrder.push(pid)
        const [, rCalls] = rs.add(planReasoning)
        let vs = planStates.get(pid)
        if (!vs) { vs = new ProtocolTextAccumulator(); planStates.set(pid, vs) }
        const [contentDelta, cCalls] = vs.add(webPlanContent(data))
        collectCalls([...callsFromRemotePayload(data), ...rCalls, ...cCalls])
        if (contentDelta) planText += contentDelta
        const summary = webFinishSummary(data)
        if (summary) finalSummary = summary
        continue
      }

      if (event === 'message' || event === 'assistant_message' || event === 'response'
        || event === 'text' || event === 'output') {
        let text = webMessageText(data)
        const eventReasoning = payloadReasoningText(data)
        const [embeddedReasoning, stripped] = splitEmbeddedReasoning(text)
        text = stripped
        if (eventReasoning || embeddedReasoning) {
          const key = '__messages__'
          let state = reasoningStates.get(key)
          if (!state) { state = new ProtocolTextAccumulator(); reasoningStates.set(key, state) }
          if (!reasoningOrder.includes(key)) reasoningOrder.push(key)
          if (eventReasoning) state.add(eventReasoning)
          if (embeddedReasoning) state.add(embeddedReasoning)
        }
        if (text) {
          const [, calls] = messageState.addSnapshot(text)
          collectCalls(calls)
          messageVisible = messageState.visible
        }
        continue
      }

      if (event === 'done') {
        finalReason = String(data['finish_reason'] ?? data['finishReason'] ?? finalReason)
        sawDone = true
        if (opts.onDone) { try { opts.onDone() } catch { /* 回收回调不得影响聚合 */ } }
        break
      }
    }
  } catch (e) {
    if (!errorEvent) {
      return {
        resp: null,
        err: null,
        truncated: { kind: 'read_error', contentChars, reasoningChars: 0, sawToolCalls: toolMerger.results().length > 0, sawUsage },
      }
    }
  }

  // 释放累积器
  for (const state of reasoningStates.values()) collectCalls(state.finalize()[1])
  for (const state of planStates.values()) {
    const [delta, calls] = state.finalize()
    collectCalls(calls)
    if (delta) planText += delta
  }
  {
    const [, calls] = messageState.finalize()
    collectCalls(calls)
    messageVisible = messageState.visible
  }

  const calls = toolMerger.results()
  let content = planStates.size > 0
    ? Array.from(planStates.values()).map((s) => s.visible.trim()).filter(Boolean).join('\n\n')
    : planText
  if (messageVisible.trim()) content = mergePlanMessageText(content, messageVisible.trim())
  if (finalSummary) {
    collectCalls(callsFromRemotePayload({ tool_calls: extractToolCallsFromText(finalSummary) }))
    const summaryText = visibleText(finalSummary).trim()
    const filtered = stripReasoningNarration(summaryText, true).trim()
    const hasPlanReasoning = Array.from(reasoningStates.values()).some((s) => s.raw)
    finalSummary = filtered || (content || hasPlanReasoning ? '' : summaryText)
  }
  const finalCalls = toolMerger.results()

  if (!finalCalls.length) {
    if (!content) content = finalSummary
    else if (finalSummary && finalSummary.trim().startsWith(content.trim())) content = finalSummary.trim()
    else if (finalSummary && !content.replace(/\s+$/, '').endsWith(finalSummary.replace(/\s+$/, ''))) {
      content = content.replace(/\s+$/, '') + '\n\n' + finalSummary
    }
  }

  const reasoningRaw = reasoningOrder.map((k) => reasoningStates.get(k)?.raw ?? '').filter(Boolean).join('\n')
  const reasoningSummary = compactReasoningText(reasoningRaw)
  let publicReasoning = includeReasoning ? reasoningSummary : ''
  if (!content && !finalCalls.length && reasoningSummary && !includeReasoning && !legacyPlanReasoning) {
    publicReasoning = reasoningSummary
  }
  if (!content && !publicReasoning && !finalCalls.length && reasoningSummary && !includeReasoning) {
    content = reasoningSummary
  }

  if (errorEvent) {
    const code = String(errorEvent['code'] ?? '')
    const message = String(errorEvent['message'] ?? errorEvent['error'] ?? 'remote upstream error')
    return { resp: null, err: { code: Number(code) || 0, msg: message }, truncated: null }
  }

  if (!sawDone) {
    return {
      resp: null,
      err: null,
      truncated: {
        kind: 'no_done',
        contentChars: content.length,
        reasoningChars: reasoningSummary.length,
        sawToolCalls: finalCalls.length > 0,
        sawUsage,
      },
    }
  }

  if (!content && !publicReasoning && !finalCalls.length) content = '(trae upstream returned an empty response)'

  const promptTokens = Number((usage as any)?.['prompt_tokens'] ?? 0) || 0
  const completionTokens = Number((usage as any)?.['completion_tokens'] ?? 0) || estimateTokens(content + publicReasoning)
  const finalUsage = usage ?? {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  }

  const resp: Record<string, any> = {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: content || null,
        ...(finalCalls.length > 0 ? { tool_calls: finalCalls } : {}),
        ...(publicReasoning ? { reasoning_content: publicReasoning } : {}),
      },
      finish_reason: remoteFinishReason(finalReason, finalCalls.length > 0),
    }],
    usage: finalUsage,
  }
  return { resp, err: null, truncated: null }
}

/** 粗略 token 估算（上游未上报 usage 时的兜底，不编造精确值）。 */
function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.max(1, Math.ceil(text.length / 4))
}
