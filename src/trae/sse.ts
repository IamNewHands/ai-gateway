/**
 * sse.ts — SOLO 自定义 SSE 解析 → OpenAI SSE（流式转换 + 非流式聚合）。
 * 移植自 traework2api/internal/upstream/solosse.go。
 *
 * SOLO 事件序列（SPEC §4.6，实测）：
 *   id:1 / event:metadata / data:{...}
 *   id:2 / event:timing_cost / data:{...}
 *   event:output（×N，核心内容）data:{"response":"...","reasoning_content":"...","tool_calls":...}
 *   event:extra_info
 *   event:token_usage data:{"prompt_tokens":21,...}
 *   event:done data:{"finish_reason":"stop"}
 */
import { buildTraeRunawayInfo, isDegenerateReasoningText, TraeReasoningGuard, TRAE_RUNAWAY_GRACE_CHARS, traeRunawayErrorFrame, type TraeRunawayInfo } from './runaway'
import type { SOLOEvent, SOLOStreamError } from './types'

/** 解析一条事件（eventName 为 event 行值，dataLine 为 data 行值）。 */
export function parseSoloLine(eventName: string, dataLine: string): SOLOEvent | null {
  const ev: SOLOEvent = {
    event: eventName.trim(),
    response: '',
    reasoning: '',
    toolCalls: null,
    usage: null,
    finishReason: '',
    errorCode: 0,
    errorMessage: '',
  }
  if (dataLine === '') return ev
  let raw: Record<string, any>
  try {
    raw = JSON.parse(dataLine)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return ev
  switch (ev.event) {
    case 'output':
      if (typeof raw['response'] === 'string') ev.response = raw['response']
      if (typeof raw['reasoning_content'] === 'string') ev.reasoning = raw['reasoning_content']
      if (raw['tool_calls'] !== undefined) ev.toolCalls = raw['tool_calls']
      break
    case 'token_usage':
      ev.usage = raw
      break
    case 'done':
      if (typeof raw['finish_reason'] === 'string') ev.finishReason = raw['finish_reason']
      break
    case 'error': {
      // 上游实测会把业务码下发成数字**或数字字符串**（`"4008"`），键名也见过
      // error_code / errorCode。只认 `typeof code === 'number'` 会让 1005 / 4008 / 4027
      // 三条判据同时失效（errorCode 停在 0），账号策略退化成「普通错误计数」——
      // 额度已耗尽的账号不会被冷却，继续占 MAX_ROTATE 轮转位。
      const code = toCount(raw['code'] ?? raw['error_code'] ?? raw['errorCode'])
      if (code !== null) ev.errorCode = code
      // 文案键同样不止 message 一种；只取字符串，避免把对象拼成 "[object Object]" 后
      // 再拿去做额度文案匹配（isTraeQuotaError 依赖那几条英文原文）。
      const message = raw['message'] ?? raw['msg'] ?? raw['detail'] ?? raw['reason']
      if (typeof message === 'string') ev.errorMessage = message
      break
    }
  }
  return ev
}

/** 计数读取：数字 / 数字字符串 → number；其余 → null（不编造）。 */
function toCount(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

/** 取嵌套对象为可合并副本（非对象 → 空对象），避免覆盖上游已下发的兄弟字段。 */
function asRecord(v: unknown): Record<string, any> {
  return v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Record<string, any>) } : {}
}

/**
 * SOLO / Work 上游 token_usage → 补 OpenAI 口径字段（其余字段原样保留）。
 *
 * 上游实测（2026-09-27，同一段 19635 token 前缀连发两次）：
 *  1. 缓存命中放在 Anthropic 口径 `cache_read_input_tokens`（首回合 0，次回合 19584），
 *     **没有** OpenAI 口径的 `prompt_tokens_details.cached_tokens`；
 *  2. 缓存写入放在 Anthropic 口径 `cache_creation_input_tokens`（实测恒 0，但字段确实在），
 *     **没有** OpenAI 口径的 `prompt_tokens_details.cache_write_tokens`；
 *  3. 推理 token 放在**顶层** `reasoning_tokens`（如 58），**没有** OpenAI 口径的
 *     `completion_tokens_details.reasoning_tokens`。
 *
 * 而 OpenAI 兼容客户端（DSH 的 pi-ai 等）分别只认
 * `prompt_tokens_details.cached_tokens`（→ prompt_cache_hit_tokens → cached_tokens）、
 * `prompt_tokens_details.cache_write_tokens` 与 `completion_tokens_details.reasoning_tokens`，
 * 于是上游明明命中缓存 / 有写入 / 有推理量，客户端与管理端统计却恒显示 0。
 *
 * 这里只补别名，不改写、不删除上游原字段（Anthropic /v1/messages 通路仍读
 * `cache_read_input_tokens`）。上游未上报对应字段（缺失 / 非数字）时不补该别名，不编造 0。
 */
export function normalizeSoloUsage(raw: unknown): Record<string, any> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const usage = { ...(raw as Record<string, any>) }

  const cacheRead = toCount(usage['cache_read_input_tokens'])
  if (cacheRead !== null) {
    usage['prompt_tokens_details'] = { ...asRecord(usage['prompt_tokens_details']), cached_tokens: cacheRead }
  }

  const cacheWrite = toCount(usage['cache_creation_input_tokens'])
  if (cacheWrite !== null) {
    usage['prompt_tokens_details'] = { ...asRecord(usage['prompt_tokens_details']), cache_write_tokens: cacheWrite }
  }

  const reasoning = toCount(usage['reasoning_tokens'])
  if (reasoning !== null) {
    usage['completion_tokens_details'] = { ...asRecord(usage['completion_tokens_details']), reasoning_tokens: reasoning }
  }

  return usage
}

/** SSE 行级状态：维护 event/data 跨行累积。 */
interface SseState {
  event: string
  data: string
}

function resetState(st: SseState): void {
  st.event = ''
  st.data = ''
}

/** 处理一行；返回该行触发的事件（事件边界时解析并返回）。 */
function scanLine(st: SseState, line: string): SOLOEvent | null {
  if (line === '') {
    if (st.event === '') {
      resetState(st)
      return null
    }
    const ev = parseSoloLine(st.event, st.data)
    resetState(st)
    return ev
  }
  if (line.startsWith('event:')) {
    st.event = line.slice(6).trim()
  } else if (line.startsWith('data:')) {
    st.data += line.slice(5)
  }
  // 注释行（以 ":" 开头）忽略
  return null
}

/** 按行切分文本并喂给 scanLine，返回触发的事件列表。 */
function feedLines(st: SseState, text: string, events: SOLOEvent[]): void {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const isLast = i === lines.length - 1
    const line = lines[i]
    // 只有非末尾行视为完整行（末尾可能是不完整缓冲）；Go 版按 "\n" 切分同理
    if (isLast) {
      if (line !== '') {
        // 保留到下一段继续累积
        st.data = line.startsWith('data:') ? st.data + line.slice(5) : st.data
        if (line.startsWith('event:')) st.event = line.slice(6).trim()
      }
      continue
    }
    const ev = scanLine(st, line.replace(/\r$/, ''))
    if (ev) events.push(ev)
  }
}

/**
 * 聚合完整 SOLO SSE 文本 → 单个 OpenAI chat.completion（非流式）。
 * 上游 error 事件返回 { err }（err 优先，此时 truncated 恒为 null）；成功返回 { resp }。
 *
 * 关键：「收到 done」与「没收到 done」是两种结局，必须分开报。事故证据（2026-09-27）：
 * 上游半路断流时既无 done 也无 error，本函数此前留下默认的 `finish_reason='stop'`，
 * 调用方据此回 200 —— 客户端把半句话当完整回答（与流式路径 `soloStreamToOpenAIStream`
 * 的 no_done 分支同一个真因，只是这条路没有错误帧可发）。
 *
 * 因此新增 `truncated`：**调用方不得在它非空时把 resp 当成功返回**。同时在这种情形下
 * `finish_reason` 不再谎报 stop（无工具调用时降级为 length），作为客户端侧的最后一道可见信号。
 *
 * @param opts.readError 读取响应体时已抛错（调用方 catch 后传 true）：用于区分「读体异常」
 *   与「干净 EOF 但没有 done」，与流式路径的 readError 标记同义。
 */
export function aggregateSoloSse(text: string, opts?: { readError?: boolean }): { resp: Record<string, any> | null; err: SOLOStreamError | null; truncated: SoloStreamEndInfo | null } {
  const st: SseState = { event: '', data: '' }
  const events: SOLOEvent[] = []
  feedLines(st, text, events)
  // 处理残留缓冲（文本末尾无 \n 的情况）
  if (st.event !== '' || st.data !== '') {
    const ev = parseSoloLine(st.event, st.data)
    if (ev) events.push(ev)
  }

  let content = ''
  let reasoning = ''
  let finishReason = 'stop'
  let usage: Record<string, any> | null = null
  const toolMerger = new SoloToolCallMerger()
  let upstreamErr: SOLOStreamError | null = null
  let sawDone = false

  for (const ev of events) {
    switch (ev.event) {
      case 'output':
        content += ev.response
        reasoning += ev.reasoning
        toolMerger.add(ev.toolCalls)
        break
      case 'token_usage':
        usage = normalizeSoloUsage(ev.usage)
        break
      case 'done':
        sawDone = true
        if (ev.finishReason !== '') finishReason = ev.finishReason
        break
      case 'error':
        upstreamErr = { code: ev.errorCode, msg: ev.errorMessage }
        break
    }
  }
  if (upstreamErr) return { resp: null, err: upstreamErr, truncated: null }

  // 工具调用先落定（repair → split → drop 三档降级），后续所有「有没有工具调用」的判定
  // 都必须以这个结果为准，不能再看原始帧数 —— 被丢弃的孤立帧不算工具调用。
  const mergedToolCalls = toolMerger.results()

  // 推理退化（runaway.ts 的行重复判据）：非流式没有「中途抑制」的机会，只能事后处置。
  //  - 全程无正文/工具调用 → 不是成功结果：返回 truncated（调用方按可重试失败处理，
  //    且**不得罚号**——退化成因在模型侧）。拿垃圾推理当答案返回，就是本防护要消灭的假成功；
  //  - 有正文 → 只剔除退化推理文本，正文照常返回（不能因为思考脏了就丢掉可用答案）。
  if (isDegenerateReasoningText(reasoning)) {
    if (content === '' && mergedToolCalls.length === 0) {
      return {
        resp: null,
        err: null,
        truncated: {
          kind: 'degenerate_reasoning',
          contentChars: 0,
          reasoningChars: reasoning.length,
          sawToolCalls: false,
          sawUsage: usage !== null,
        },
      }
    }
    reasoning = ''
  }

  const message: Record<string, any> = { role: 'assistant', content }
  if (reasoning !== '') message['reasoning_content'] = reasoning
  if (mergedToolCalls.length > 0) {
    // OpenAI 非流式 tool_call：不含 index（index 仅流式增量用），type 由合并器补 function
    message['tool_calls'] = mergedToolCalls
    // 本回合模型发起工具调用 → finish_reason 必须是 tool_calls（上游常自报 stop）
    finishReason = 'tool_calls'
  }

  // 非流式没有错误帧可发，finish_reason 是客户端唯一可见的收尾信号：没收到 done 就不能给
  // stop 的假象（有工具调用时保留 tool_calls —— 那是可执行动作，不该被降级成 length）。
  if (!sawDone && mergedToolCalls.length === 0) finishReason = 'length'

  // 无 done = 上游半路断流（或读体异常）。调用方必须据此判失败，不得把 resp 当成功返回。
  const truncated: SoloStreamEndInfo | null = sawDone ? null : {
    kind: opts?.readError ? 'read_error' : 'no_done',
    contentChars: content.length,
    reasoningChars: reasoning.length,
    sawToolCalls: mergedToolCalls.length > 0,
    sawUsage: usage !== null,
  }

  const resp: Record<string, any> = {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: '',
    choices: [{ index: 0, message, finish_reason: finishReason }],
  }
  if (usage) resp['usage'] = usage
  return { resp, err: null, truncated }
}

// ===== SOLO 工具调用合并 / 参数修复（移植自 Trae2api-cn 4f9451e + 85978c3）=====
//
// 上游 SOLO 原生工具流的实测坏形态（Trae2api-cn issue #8，2026-10-05，d4.1f 最明显，
// 并发 4 工具修前 0/12、修后 15/15）：
//  1. 分片截断      `{"command": "git status"` 缺闭合 `}`
//  2. 同 index 压栈  `{"a":1}{"b":2}` 拼进同一个 arguments
//  3. 跨调用交织    Bash 尾部 + Write body 混合
//  4. 孤立闭合帧    单独一个 `}` 成为 tool_call
//  5. 无 name/id 续片 被「按数组位补 index」归并到错误调用
// 任一形态都会让客户端报 `inputSchema validation failed`（旧实现更早的版本直接整请求 502）。
//
// 三条纪律（对齐源侧 ToolCallAccumulator）：
//  - 首帧带 id+name、续片不带（上游实测）⇒ **无 index 的续片不得按数组位补 index**，
//    只能并入「最近一个未闭合调用」；
//  - 已闭合（arguments 已是合法 JSON）的调用再收到以 `{`/`[` 开头的片段 = 新逻辑调用，
//    必须开新 index，绝不字符串拼接；
//  - 无归属的孤立闭合/空片段直接丢弃，不得污染前一个完整调用。
//
// 对外 index 由合并器**按创建顺序**分配（0,1,2…），不透传上游 index：上游 index 会被
// 并发调用复用，透传就会让两个逻辑调用撞同一 index，而客户端对同一 index 是拼接语义。

/** 合法 JSON 文本（含标量）→ true；空串与解析失败 → false。 */
export function isJsonText(text: string): boolean {
  if (text === '') return false
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/** 片段是否像一个新 JSON 值的起点（`{` 或 `[`，允许前导空白）。 */
function startsNewJsonValue(text: string): boolean {
  const c = text.replace(/^\s+/, '').slice(0, 1)
  return c === '{' || c === '['
}

/** 上游遗留的孤立闭合/空片段（丢弃用）。 */
function isOrphanClosingFragment(text: string): boolean {
  const s = text.trim()
  return s === '' || s === '}' || s === ']' || s === '{}' || s === '[]'
}

/**
 * 尽力补全被截断的 JSON 参数（补未闭合字符串与括号栈）。
 * 对齐源侧 `_repair_json_arguments`：只在结果能通过 `JSON.parse` 时才返回新值，否则原样返回
 * —— 宁可不修，也不编造一个能过 schema 的错误参数。
 */
export function repairJsonArguments(argumentsText: string): string {
  if (!argumentsText || isJsonText(argumentsText)) return argumentsText
  let repaired = argumentsText.replace(/\s+$/, '')
  const stack: string[] = []
  let inStr = false
  let esc = false
  for (const ch of repaired) {
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{' || ch === '[') stack.push(ch)
    else if (ch === '}' || ch === ']') {
      if (stack.length > 0) stack.pop()
    }
  }
  if (inStr) repaired += '"'
  for (let i = stack.length - 1; i >= 0; i--) repaired += stack[i] === '{' ? '}' : ']'
  return isJsonText(repaired) ? repaired : argumentsText
}

/** 返回从 start 起的完整 JSON 值的结束下标（不含）；失败返回 -1。 */
function jsonValueEnd(text: string, start: number): number {
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0) return i + 1
      if (depth < 0) return -1
    }
  }
  return -1
}

/**
 * 从 `{..}{..}` 拼接串里切出一个个合法 JSON 值（对齐 Python `raw_decode` 语义）。
 * 起点不是 `{`/`[`、或中途截断 → 返回 null（调用方再走 repair / drop）。
 */
export function splitJsonStream(text: string): unknown[] | null {
  const out: unknown[] = []
  let i = 0
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++
    if (i >= text.length) break
    const first = text[i]
    if (first !== '{' && first !== '[') return null
    const end = jsonValueEnd(text, i)
    if (end < 0) return null
    try {
      out.push(JSON.parse(text.slice(i, end)))
    } catch {
      return null
    }
    i = end
  }
  return out.length > 0 ? out : null
}

/** 上游 tool_calls 的三种承载形态（null/对象/数组/JSON 字符串）→ 数组。 */
function toToolCallArray(raw: unknown): Record<string, any>[] | null {
  if (raw === null || raw === undefined || raw === 'null') return null
  if (Array.isArray(raw)) return raw as Record<string, any>[]
  if (typeof raw === 'object') return [raw as Record<string, any>]
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed as Record<string, any>[]
      if (parsed && typeof parsed === 'object') return [parsed as Record<string, any>]
    } catch {
      return null
    }
  }
  return null
}

/** 取 function / function_call 子对象（SOLO 用前者，OpenAI 标准用后者）。 */
function pickFunctionDelta(call: Record<string, any>): Record<string, any> | null {
  const fn = call['function']
  if (fn && typeof fn === 'object' && !Array.isArray(fn)) return fn as Record<string, any>
  const legacy = call['function_call']
  if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) return legacy as Record<string, any>
  return null
}

interface MergedSoloToolCall {
  outIndex: number
  id: string
  name: string
  args: string
  hadUpstreamIndex: boolean
}

/**
 * SOLO 工具调用合并器：流式（增量下发）与非流式（事后聚合）共用的唯一 owner。
 *
 * 两条路径必须共用同一套归并规则，否则流式与非流式对同一段上游流会给出不同的工具调用
 * —— 客户端拿非流式结果和流式结果会对不上（这正是把两处实现合并成一个类的原因）。
 */
export class SoloToolCallMerger {
  private calls = new Map<number, MergedSoloToolCall>()
  private order: number[] = []
  private idToOut = new Map<string, number>()
  private upstreamToOut = new Map<number, number>()
  private nextOut = 0
  private dropped = 0
  private repaired = 0
  private splits = 0

  /** 合并一帧上游 tool_calls；返回本帧应下发的 OpenAI 增量（整帧被丢则为空数组）。 */
  add(raw: unknown): Record<string, any>[] {
    const arr = toToolCallArray(raw)
    if (!arr) return []
    const deltas: Record<string, any>[] = []
    for (const call of arr) {
      if (!call || typeof call !== 'object') continue
      const delta = this.mergeOne(call)
      if (delta) deltas.push(delta)
    }
    return deltas
  }

  /** 累计结果（已做 repair / split / drop），供非流式 `message.tool_calls` 使用。 */
  results(): Record<string, any>[] {
    const out: Record<string, any>[] = []
    const completeSignatures = new Set<string>()
    for (const outIndex of this.order) {
      const merged = this.calls.get(outIndex)
      if (!merged) continue
      const calls = this.normalizeMerged(merged)
      if (calls.length === 0) {
        this.dropped += 1
        continue
      }
      for (const call of calls) {
        const args = String((call['function'] as Record<string, any>)['arguments'] ?? '')
        // 无上游 id 的完整重复调用 = 上游重放：同一 (name, args) 只保留第一条。
        // 带 id 的调用不参与去重 —— 上游给了不同 id 就是两个逻辑调用（哪怕参数相同）。
        if (merged.id === '' && isJsonText(args)) {
          const signature = `${merged.name}\u0000${args}`
          if (completeSignatures.has(signature)) {
            this.dropped += 1
            continue
          }
          completeSignatures.add(signature)
        }
        out.push(call)
      }
    }
    const { dropped, repaired, splits } = this.stats()
    if (dropped > 0 || repaired > 0 || splits > 0) {
      console.warn(`[trae-tool-calls] repaired=${repaired} dropped=${dropped} splits=${splits}`)
    }
    return out
  }

  /** 诊断计数（供调用方记日志/告警）。 */
  stats(): { dropped: number; repaired: number; splits: number } {
    return { dropped: this.dropped, repaired: this.repaired, splits: this.splits }
  }

  private mergeOne(call: Record<string, any>): Record<string, any> | null {
    const fnRaw = pickFunctionDelta(call)
    const name = fnRaw && typeof fnRaw['name'] === 'string' ? fnRaw['name'].trim() : ''
    const args = fnRaw && typeof fnRaw['arguments'] === 'string' ? fnRaw['arguments'] : ''
    const id = typeof call['id'] === 'string' ? call['id'].trim() : ''
    const upstreamIndex =
      typeof call['index'] === 'number' && Number.isFinite(call['index']) ? call['index'] : null

    // 噪音帧（如 {index:0} / {function:{}}）：无 name、无 id、无参数 → 丢弃，不下发空增量
    if (name === '' && id === '' && args === '') return null

    const resolved = this.resolveTarget(name, id, args, upstreamIndex)
    if (resolved === null) {
      this.dropped += 1
      return null
    }
    const { outIndex, isNew } = resolved
    const merged = this.calls.get(outIndex)
    if (!merged) return null

    let emitId = ''
    if (id !== '' && merged.id !== id) {
      merged.id = id
      this.idToOut.set(id, outIndex)
      emitId = id
    }
    if (isNew) {
      // 拆出来的新调用可能继承同 index 前一个调用的函数名（见 resolveTarget 形态2），
      // 此时本帧没有 name，不得用空名覆盖。
      if (name !== '') merged.name = name
      merged.args = args
      merged.hadUpstreamIndex = upstreamIndex !== null
    } else {
      if (name !== '' && merged.name === '') merged.name = name
      merged.args += args
    }

    // 续片且既无 name 又无参数 → 无可下发内容（不得发空 id/name 冲掉首帧已落定的值）
    if (!isNew && name === '' && args === '') return null

    const delta: Record<string, any> = { index: outIndex }
    if (isNew) delta['type'] = 'function'
    if (emitId !== '') delta['id'] = emitId
    const fn: Record<string, any> = {}
    if (name !== '') fn['name'] = name
    if (args !== '') fn['arguments'] = args
    if (Object.keys(fn).length > 0) delta['function'] = fn
    return delta
  }

  private resolveTarget(
    name: string,
    id: string,
    args: string,
    upstreamIndex: number | null,
  ): { outIndex: number; isNew: boolean } | null {
    // 1) 带 id 且该 id 已归并过 → 同一逻辑调用
    if (id !== '') {
      const known = this.idToOut.get(id)
      if (known !== undefined) return { outIndex: known, isNew: false }
    }

    if (name !== '') {
      // 2) 具名帧：同一上游 index 上「同名且未闭合」视为 name 重复的续片
      if (upstreamIndex !== null) {
        const cand = this.byUpstreamIndex(upstreamIndex)
        if (cand && cand.name === name && !this.isClosed(cand.outIndex)) {
          return { outIndex: cand.outIndex, isNew: false }
        }
      }
      // 3) 其余具名帧一律是新逻辑调用（含上游 index 复用）
      return { outIndex: this.allocate(upstreamIndex), isNew: true }
    }

    // 4) 无 name 的续片
    if (upstreamIndex !== null) {
      const cand = this.byUpstreamIndex(upstreamIndex)
      if (!cand) {
        // 无 name 的帧是续片，不能凭空开新调用：只有看起来是新 JSON 值起点才接受。
        // 否则就是一条没有归属的孤立闭合/垃圾帧（形态4）→ 丢弃，绝不下发。
        if (!startsNewJsonValue(args)) return null
        return { outIndex: this.allocate(upstreamIndex), isNew: true }
      }
      if (this.isClosed(cand.outIndex)) {
        if (startsNewJsonValue(args)) {
          // 形态2：同一 index 串了新调用 → 开新 index，并把该上游 index 改指向新调用，
          // 否则新调用的后续续片会被误判成「已闭合调用的遗留帧」而丢弃。
          this.splits += 1
          const outIndex = this.allocate(null)
          this.upstreamToOut.set(upstreamIndex, outIndex)
          const fresh = this.calls.get(outIndex)
          // 继承被复用 index 的调用名：源侧同款（`current_name or previous["name"]`）。
          // 不继承会让「无 id 的完整重复调用」去重签名对不上（名字为空 vs 有名字）。
          if (fresh) fresh.name = cand.name
          return { outIndex, isNew: true }
        }
        // 形态4：遗留闭合/空帧 → 丢弃
        return null
      }
      return { outIndex: cand.outIndex, isNew: false }
    }

    // 5) 无 index 无 name：并入最近一个未闭合调用；无归属则丢弃（**不按数组位补 index**）
    const open = this.latestOpen()
    return open === null ? null : { outIndex: open, isNew: false }
  }

  private byUpstreamIndex(upstreamIndex: number): MergedSoloToolCall | null {
    const out = this.upstreamToOut.get(upstreamIndex)
    if (out === undefined) return null
    return this.calls.get(out) ?? null
  }

  private isClosed(outIndex: number): boolean {
    const call = this.calls.get(outIndex)
    return !!call && isJsonText(call.args)
  }

  private latestOpen(): number | null {
    for (let i = this.order.length - 1; i >= 0; i--) {
      if (!this.isClosed(this.order[i])) return this.order[i]
    }
    return null
  }

  private allocate(upstreamIndex: number | null): number {
    const outIndex = this.nextOut++
    this.calls.set(outIndex, { outIndex, id: '', name: '', args: '', hadUpstreamIndex: upstreamIndex !== null })
    this.order.push(outIndex)
    if (upstreamIndex !== null) this.upstreamToOut.set(upstreamIndex, outIndex)
    return outIndex
  }

  /** 单个累计调用 → 0..N 条 OpenAI tool_call（repair → split → drop 三档降级）。 */
  private normalizeMerged(merged: MergedSoloToolCall): Record<string, any>[] {
    const baseId = merged.id !== '' ? merged.id : `call_${merged.outIndex}`
    const build = (args: string, id: string): Record<string, any> => ({
      id,
      type: 'function',
      function: { name: merged.name, arguments: args },
    })

    // 零参数调用与已合法参数原样保留（不编造、不重写）
    if (merged.args === '' || isJsonText(merged.args)) return [build(merged.args, baseId)]

    const parts = splitJsonStream(merged.args)
    if (parts !== null && parts.length > 0) {
      this.splits += 1
      const seen = new Set<string>()
      const out: Record<string, any>[] = []
      for (let i = 0; i < parts.length; i++) {
        const args = JSON.stringify(parts[i])
        const signature = `${merged.name}\u0000${args}`
        if (seen.has(signature)) continue
        seen.add(signature)
        out.push(build(args, i === 0 ? baseId : `${baseId}:${i}`))
      }
      if (out.length > 0) return out
    }

    const fixed = repairJsonArguments(merged.args)
    if (isJsonText(fixed)) {
      this.repaired += 1
      return [build(fixed, baseId)]
    }

    // 孤立闭合/垃圾帧与不可用参数都不下发（宁可少一个调用，也不给客户端坏 schema）
    if (!isOrphanClosingFragment(merged.args)) this.repaired += 1
    return []
  }
}

// ===== 流式转换：SOLO SSE → OpenAI SSE chunk（ReadableStream + start 回调） =====
// ！
// 使用 ReadableStream 而非 TransformStream + pipeThrough，因为 CF Workers 中
// pipeThrough 的 flush 在 fetch 响应体结束时可能不被可靠调用，导致残留事件未处理、
// [DONE] 未发送，客户端报 "truncated: stream ended"（尤其工具调用场景）。
// ReadableStream 的 start 回调在循环结束后总处理残留缓冲并主动 close，保证流正确结束。

function encodeSse(data: string): Uint8Array {
  return new TextEncoder().encode(`data: ${data}\n\n`)
}

/**
 * 上游收尾诊断（供调用方记日志/告警，判定「静默截断」）。
 *
 * 同一个类型服务两条路：流式 `soloStreamToOpenAIStream` 的 `onTruncated` 回调，
 * 以及非流式聚合（`aggregateSoloSse` / `aggregateWorkSse` 的 `truncated` 字段）。
 *
 * `kind` 三个取值对应三类收尾异常：
 *  - `read_error`：读上游响应体时抛错（连接被掐断/重置）；
 *  - `no_done`：上游干净 EOF，但全程没发 `done`（模型早停与上游截断在协议上同形）；
 *  - `degenerate_reasoning`：推理退化空转（`runaway.ts`），网关已抑制退化推理并提前熔断。
 *    与上两者不同，这条路的**上游流本身是正常的**（常常还有 done）——问题出在内容质量，
 *    因此调用方同样不得把结果当成功返回，但**不得据此罚号**（退化成因在模型侧）。
 */
export interface SoloStreamEndInfo {
  kind: 'read_error' | 'no_done' | 'degenerate_reasoning'
  contentChars: number
  reasoningChars: number
  sawToolCalls: boolean
  sawUsage: boolean
}

/**
 * 收尾审计（`onAudit`）：流正常读到 EOF 时对「上游到底收尾了几次」计数。
 *
 * 为什么需要它（2026-09-27，`fd301f9` 上线后仍复现半句截断）：`fd301f9` 那道防线只在
 * `!sawDone` 时触发（见下方 `if (!sawDone)` 分支），而线上复现的截断**带着
 * `finish_reason=stop` 到达客户端**（DSH 会话记录 2026-09-27 18:49，`finish=stop` +
 * `turn/end=completed`），防线按设计抓不到。剩下两种可能，本计数就是把它们分开的证据：
 *  - `dones === 1` 且 `postDone*` 全为 0：上游只产出了这么多就收尾（模型早停，或上游半路
 *    掐断但发了 done）；网关无事可做，只能在内容层做兜底。
 *  - `postDoneContentChars > 0`（或 `dones > 1`）：上游在 done 之后仍在发正文，而网关照发、
 *    客户端见 `[DONE]` 即丢弃后续帧（OpenAI 兼容客户端一律如此）→ 网关侧缺一个
 *    「done 之后停发」的刹车，属本仓可修。
 *
 * 只做诊断：**不改变任何下行帧**，调用方也不得据此判罚账号（与 `onRunaway` 同纪律）。
 */
export interface SoloDoneAudit {
  /** 本流收到的 `done` 事件次数（上游正常收尾恒为 1；0 表示走了 `!sawDone` 兜底路径）。 */
  dones: number
  /** 首个 done 之后才到达的内容规模（>0 即「done 后仍有内容」）。 */
  postDoneContentChars: number
  postDoneReasoningChars: number
  postDoneToolCalls: number
  /** 全程累计（与 `SoloStreamEndInfo` 同口径，便于和收尾日志对照）。 */
  contentChars: number
  reasoningChars: number
  sawToolCalls: boolean
}

/**
 * 流式转换：SOLO SSE → OpenAI SSE chunk，使用 ReadableStream 确保流正确结束。
 * 上游流内 error 事件：回调 onErr（供冷却账号/记录日志）并注入一条 error 事件。
 *
 * 上游**没有发 `done` 就结束**（截断/连接被掐）：不再静默兜底成 stop，而是先注入一帧
 * 具名 error（`upstream_no_finish` / `upstream_interrupted`）再照常收尾，见下方
 * `if (!sawDone)` 分支的定责说明。
 *
 * @param upstream 上游 SOLO SSE 响应体（ReadableStream<Uint8Array>）。
 * @param model 写入 chunk 的模型名（OpenAI 兼容客户端校验用）。
 * @param onErr 上游流内 error 事件回调。
 * @param onTruncated 收尾异常回调（可选）：上游未发 done 即结束时触发一次。
 * @param onRunaway 推理退化熔断回调（可选）：命中 `runaway.ts` 的退化/预算判据并抑制后
 *   触发一次，供调用方记日志。**不要在回调里冷却账号**——退化是模型行为不是账号故障。
 * @param onAudit 收尾审计回调（可选）：流读到 EOF 时触发一次，报告 done 次数与 done 之后
 *   仍到达的内容规模（见 `SoloDoneAudit`）。退化熔断路径不触发，那条由 `onRunaway` 记，
 *   两路口径不混。同样**不要据此罚号**。
 */
export function soloStreamToOpenAIStream(
  upstream: ReadableStream<Uint8Array>,
  model: string,
  onErr?: (se: SOLOStreamError) => void,
  onTruncated?: (info: SoloStreamEndInfo) => void,
  onRunaway?: (info: TraeRunawayInfo) => void,
  onAudit?: (info: SoloDoneAudit) => void
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      const st: SseState = { event: '', data: '' }
      const id = `chatcmpl-${Date.now()}`
      let pendingUsage: Record<string, any> | null = null
      let sawDone = false
      let sawToolCalls = false
      let sentRole = false
      let lineBuffer = ''
      // 收尾诊断计数：用于区分「上游正常收尾」与「上游没发 done 就断」
      let readErrored = false
      let contentChars = 0
      let reasoningChars = 0
      let sawUsage = false
      // 推理退化防护（runaway.ts）：命中后抑制推理增量，并在「既无正文也无工具调用」时熔断。
      const guard = new TraeReasoningGuard()
      /** 已发过合成熔断终态帧：此后上游帧全部丢弃，收尾兜底也不得再补第二套收尾。 */
      let runawayTerminated = false
      // 收尾审计（onAudit）：done 次数 + 首个 done 之后仍到达的内容规模，见 SoloDoneAudit。
      let doneEvents = 0
      let postDoneContentChars = 0
      let postDoneReasoningChars = 0
      let postDoneToolCalls = 0
      // 工具调用合并器：与非流式聚合共用同一套归并规则（见 SoloToolCallMerger）。
      // 必须在流式路径上增量归并，而不是逐帧原样透传 —— 上游会把多个并发调用压在同一个
      // index 上，透传后由客户端拼接 `arguments` 就会得到 `{"a":1}{"b":2}`。
      const toolMerger = new SoloToolCallMerger()

      const writeChunk = (delta: Record<string, any>, finish: string, extra?: Record<string, unknown>): void => {
        // OpenAI 兼容客户端通常期望首块 delta 带 role（openai SDK / AI SDK 均按此解析）
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
        if (pendingUsage) {
          chunk['usage'] = pendingUsage
          pendingUsage = null
        }
        if (extra) Object.assign(chunk, extra)
        controller.enqueue(encodeSse(JSON.stringify(chunk)))
      }
      const writeDone = (): void => {
        controller.enqueue(encodeSse('[DONE]'))
      }

      /** 「本轮尚未产出任何可用结果」：退化熔断与 runaway 报错都只在这种形态下触发。 */
      const noProgress = (): boolean => contentChars === 0 && !sawToolCalls

      /**
       * 合成熔断收尾：错误帧（客户端按可重试失败处理）+ `finish_reason:"length"` + [DONE]。
       *
       * 为什么用 length 而不是 stop：stop 会让客户端把「只有垃圾推理、没有答案」当正常完成
       * （这正是 2026-09-27 静默截断事故的同一类误导）。length 语义诚实：模型被掐了。
       * `x_trae_runaway` 是网关自加的标记，用于把「护盾熔断」与上游真实的 token 上限区分开。
       */
      const emitRunawayTerminal = (): void => {
        if (runawayTerminated) return
        runawayTerminated = true
        const info = buildTraeRunawayInfo(guard, contentChars, sawToolCalls)
        if (onRunaway) {
          try { onRunaway(info) } catch { /* 诊断回调不得影响流 */ }
        }
        // 刻意**不走** onTruncated：那一路的日志口径是「上游截断」（end=truncated），
        // 与「上游正常收尾、只是内容退化了」是两种归因；同一次事件报两条互相矛盾的日志
        // 会把排查带回错误方向。退化只经 onRunaway 上报（非流式路径则用 truncated.kind）。
        try {
          controller.enqueue(encodeSse(JSON.stringify(traeRunawayErrorFrame(info))))
        } catch { /* 流已被取消 */ }
        writeChunk({}, 'length', { x_trae_runaway: info.kind })
        writeDone()
      }

      const processEvents = (events: SOLOEvent[]): void => {
        for (const ev of events) {
          // 已熔断收尾：剩余上游帧一律丢弃（含 done，避免出现第二套收尾/[DONE]）
          if (runawayTerminated) return
          switch (ev.event) {
            case 'output': {
              const delta: Record<string, any> = {}
              contentChars += ev.response.length
              reasoningChars += ev.reasoning.length
              // 审计：首个 done 之后还来 output，说明上游收尾不止一次（这段内容客户端收不到，
              // 见 SoloDoneAudit）。只计数，不影响下发。
              if (sawDone) {
                postDoneContentChars += ev.response.length
                postDoneReasoningChars += ev.reasoning.length
              }
              // 退化防护：先投喂判定，再决定是否下发推理增量（抑制后思考面板不再被刷屏）。
              // hasProgress 用本帧更新后的计数：本帧带正文/已有工具调用时属正常链路，不做判定。
              if (ev.reasoning !== '') guard.feed(ev.reasoning, contentChars > 0 || sawToolCalls)
              if (ev.response !== '') delta['content'] = ev.response
              if (ev.reasoning !== '' && !guard.suppressed) delta['reasoning_content'] = ev.reasoning
              if (ev.toolCalls !== null && ev.toolCalls !== undefined && ev.toolCalls !== 'null') {
                const tc = toolMerger.add(ev.toolCalls)
                if (tc.length > 0) {
                  delta['tool_calls'] = tc
                  sawToolCalls = true
                  if (sawDone) postDoneToolCalls += 1
                }
              }
              if (Object.keys(delta).length > 0) writeChunk(delta, '')
              // 提前熔断：已抑制后又空转 TRAE_RUNAWAY_GRACE_CHARS 仍无任何产出 → 立刻收尾并
              // 取消上游读取（上游不会自己停，继续读只会烧积分）。
              if (guard.suppressed && noProgress() && guard.graceChars >= TRAE_RUNAWAY_GRACE_CHARS) {
                emitRunawayTerminal()
                return
              }
              break
            }
            case 'token_usage':
              pendingUsage = normalizeSoloUsage(ev.usage)
              sawUsage = true
              break
            case 'done': {
              doneEvents += 1
              // 退化熔断优先于正常收尾：只有垃圾推理、没有正文/工具调用时，上游的 done
              // 不能当成功收尾（否则客户端把空转当完成，正是本防护要消灭的假成功）。
              if (guard.suppressed && noProgress()) {
                emitRunawayTerminal()
                break
              }
              // 上游 SOLO 的 done 常自报 finish_reason=stop，即使本回合已发起工具调用。
              // OpenAI 协议规定：消息含 tool_calls 时 finish_reason 必须是 tool_calls，
              // 否则客户端（如 opencode 用的 AI SDK runToolsTransform）收不到收尾信号，
              // 缓存的工具调用永不落定 → 报 "truncated: stream ended"。
              // 仅兜底 stop/缺失：length/content_filter 等真实截断保留原值。
              let finish = ev.finishReason
              if (sawToolCalls && (finish === '' || finish === 'stop')) finish = 'tool_calls'
              if (!finish) finish = sawToolCalls ? 'tool_calls' : 'stop'
              writeChunk({}, finish)
              writeDone()
              sawDone = true
              break
            }
            case 'error': {
              const se: SOLOStreamError = { code: ev.errorCode, msg: ev.errorMessage }
              if (onErr) onErr(se)
              // 标准 OpenAI 错误帧：data 必须是 JSON 对象，不能是字符串。
              // 原来这里发 `event: error` + `data:"solo error..."`，严格客户端
              // （go-openai/langchaingo）会把字符串反序列化成流式对象失败 →
              // "cannot unmarshal string into ... ChatOpenAIHTTPStreamResponse"。
              // 改为标准 {error:{...}} 对象帧并去掉自定义 event: error。
              const errFrame = { error: { message: `solo error code=${ev.errorCode} msg=${ev.errorMessage}`, type: 'upstream_error', code: String(ev.errorCode) } }
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(errFrame)}\n\n`))
              // 仍补标准收尾 chunk + [DONE]，避免客户端因无 finish_reason 而报 truncated
              writeChunk({}, sawToolCalls ? 'tool_calls' : 'stop')
              writeDone()
              sawDone = true
              break
            }
          }
        }
      }

      // 读取上游 SSE 流
      const decoder = new TextDecoderStream()
      const textReader = upstream.pipeThrough(decoder).getReader()

      try {
        while (true) {
          const { done, value } = await textReader.read()
          if (done) break
          const combined = lineBuffer + value
          const lines = combined.split('\n')
          lineBuffer = lines.pop() || ''

          const events: SOLOEvent[] = []
          for (const line of lines) {
            const ev = scanLine(st, line.replace(/\r$/, ''))
            if (ev) events.push(ev)
          }
          processEvents(events)
          if (runawayTerminated) {
            // 已熔断收尾：立刻停止读上游（上游不会自己停，继续读只烧积分）
            await textReader.cancel().catch(() => { /* 取消失败不影响已发出的收尾帧 */ })
            break
          }
        }
      } catch {
        // 读体异常（连接重置/掐断）不再静默吞掉：记标记，收尾时如实上报。
        readErrored = true
      }

      // 处理残留行缓冲（上游流未以 \n 结束）
      if (lineBuffer !== '') {
        const events: SOLOEvent[] = []
        const ev = scanLine(st, lineBuffer.replace(/\r$/, ''))
        lineBuffer = ''
        if (ev) events.push(ev)
        processEvents(events)
      }
      // 处理未关闭的 SSE 事件：上游在 event/data 行后直接结束流（无空行触发事件边界）
      if (st.event !== '' || st.data !== '') {
        const ev = parseSoloLine(st.event, st.data)
        resetState(st)
        if (ev) {
          processEvents([ev])
        }
      }
      // 幂等兜底：上游中断（无 done）仍写标准收尾 chunk + [DONE]，
      // 否则客户端收到 [DONE] 却无 finish_reason → "truncated: stream ended"。
      //
      // 但这层兜底会把「上游被掐断」伪装成正常收尾：客户端只看到半截正文 + stop，
      // 既不报错也不重试，事后无从归因（实测 2026-09-27 trae/deepseek-v4.1-flash：
      // 回复停在半句、DSH 记到 finish=stop、turn/end=completed，用户只能怀疑客户端）。
      // 现在先补一帧具名 error 再照常收尾：
      //  - OpenAI 官方 SDK 见到 `data:{"error":...}` 即抛 APIError
      //    （openai/core/streaming.js:49），DSH 的 pi-ai 据此走「可重试失败」而不是
      //    把半截正文当成功；
      //  - 宽松客户端仍随后拿到 stop + [DONE]，行为与修复前一致，不引入新的挂起风险。
      if (!runawayTerminated && guard.suppressed && noProgress()) {
        // 收尾时机兜底：抑制后上游自己结束了（无论有没有 done），而全程仍无产出 →
        // 必须补熔断收尾。否则会落进下面的 no-done 分支，把「模型空转」误报成「上游截断」，
        // 定责方向就错了（用户会去查网络，而真因是模型退化）。
        emitRunawayTerminal()
      }

      if (!runawayTerminated && !sawDone) {
        const kind = readErrored ? 'upstream_interrupted' : 'upstream_no_finish'
        const detail = `content=${contentChars}, reasoning=${reasoningChars}, toolCalls=${sawToolCalls}, usage=${sawUsage}`
        const text = readErrored
          ? `Trae SOLO 上游流中途断开（连接异常终止）：${detail}`
          : `Trae SOLO 上游流未发送 done 即结束（疑似截断）：${detail}`
        if (onTruncated) {
          try {
            onTruncated({ kind: readErrored ? 'read_error' : 'no_done', contentChars, reasoningChars, sawToolCalls, sawUsage })
          } catch { /* 诊断回调不得影响流 */ }
        }
        try {
          controller.enqueue(encodeSse(JSON.stringify({ error: { message: text, type: kind, code: kind } })))
        } catch { /* 流已被取消 */ }
        writeChunk({}, sawToolCalls ? 'tool_calls' : 'stop')
        writeDone()
      }
      // 收尾审计：流正常读完时上报一次（退化熔断路径由 onRunaway 记，两路口径不混）。
      // 只计数、不改任何下行帧；`dones=0` 的流已由 onTruncated 记过，调用方可据此去重。
      if (!runawayTerminated && onAudit) {
        try {
          onAudit({
            dones: doneEvents,
            postDoneContentChars,
            postDoneReasoningChars,
            postDoneToolCalls,
            contentChars,
            reasoningChars,
            sawToolCalls,
          })
        } catch { /* 诊断回调不得影响流 */ }
      }
      controller.close()
    },
  })
}

// 原 `normalizeStreamToolCalls`（形状归一 + 按数组位补 index + 剔空 id/name）已由
// `SoloToolCallMerger` 取代：形状归一（function_call→function、清 namespace/partial_arguments）
// 与「不落空 id/name」两条纪律保留，但**按数组位补 index 被刻意去掉** —— 那正是
// 「无 name/id 续片归并到错误调用」这条坏形态（Trae2api-cn issue #8 形态 5）的成因。

// ===== Work 通道流式与非流式转换 (移植自 trae2api StreamWorkToOpenAI / AggregateWork) =====

/**
 * 从 Work `done.last_assistant_response` 已解析值里取最终正文（流式与非流式共用）。
 *
 * 上游该字段有**三种**实测形态，此前只认第一种，另两种会被静默丢掉：
 *  1. JSON 数组 `["答案"]`（原实现唯一覆盖的形态）；
 *  2. **JSON 字符串** `"答案"` —— `JSON.parse` 成功返回 string，`Array.isArray` 不成立，
 *     且因为解析成功也不会走 catch 分支 → 最终答案被无声吞掉（客户端只看到空内容）；
 *  3. 非 JSON 裸文本（如 `答案`）—— 由调用方 catch 分支处理，不经本函数。
 *
 * 数组形态取**第一个非空字符串元素**（原实现固定取 `arr[0]`，`["", "答案"]` 会被丢空）。
 * 其它类型（数字/对象/null）返回空串：宁可不发，也不把 `[object Object]` 当答案下发。
 */
export function pickWorkFinalAnswer(parsed: unknown): string {
  if (typeof parsed === 'string') return parsed
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (typeof item === 'string' && item !== '') return item
    }
  }
  return ''
}


/**
 * 将 Work 专有通道下行 SSE 事件流转换为标准 OpenAI chat.completion.chunk SSE 流。
 *
 * 与 SOLO 侧同样挂推理退化防护（`runaway.ts`）：Work 的 `plan_item` 思考文本走
 * `reasoning_content` 通道，是同一个退化现场的另一条来源。
 *
 * @param onRunaway 推理退化熔断回调（可选）：仅供调用方记日志，**不得**据此冷却账号。
 */
export function workStreamToOpenAIStream(
  upstream: ReadableStream<Uint8Array>,
  model: string,
  onErr?: (se: SOLOStreamError) => void,
  onRunaway?: (info: TraeRunawayInfo) => void
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      const id = `chatcmpl-${Date.now()}`
      let pendingUsage: Record<string, any> | null = null
      let sawDone = false
      let sentRole = false
      let lineBuffer = ''
      let currentEvent = ''
      let fullText = ''
      let contentChars = 0
      // 推理退化防护（同 SOLO 侧）：Work 聚合不解析工具调用，故「产出」只以正文字符计。
      const guard = new TraeReasoningGuard()
      let runawayTerminated = false

      const handleDelta = (text: string): string => {
        if (!text) return ''
        if (text.startsWith(fullText) && text.length > fullText.length) {
          const delta = text.slice(fullText.length)
          fullText = text
          return delta
        } else if (!fullText.includes(text)) {
          fullText += text
          return text
        }
        return ''
      }

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
        if (pendingUsage) {
          chunk['usage'] = pendingUsage
          pendingUsage = null
        }
        if (extra) Object.assign(chunk, extra)
        controller.enqueue(encodeSse(JSON.stringify(chunk)))
      }

      const writeDone = (): void => {
        controller.enqueue(encodeSse('[DONE]'))
      }

      /** 合成熔断收尾（语义同 SOLO 侧 `emitRunawayTerminal`）。 */
      const writeRunawayTerminal = (): void => {
        if (runawayTerminated) return
        runawayTerminated = true
        const info = buildTraeRunawayInfo(guard, contentChars, false)
        if (onRunaway) {
          try { onRunaway(info) } catch { /* 诊断回调不得影响流 */ }
        }
        try {
          controller.enqueue(encodeSse(JSON.stringify(traeRunawayErrorFrame(info))))
        } catch { /* 流已被取消 */ }
        writeChunk({}, 'length', { x_trae_runaway: info.kind })
        writeDone()
      }

      /** 提前熔断判定：已抑制后空转满 grace 字符仍无正文 → 收尾（上游不会自己停）。 */
      const runawayGraceExhausted = (): boolean =>
        guard.suppressed && contentChars === 0 && guard.graceChars >= TRAE_RUNAWAY_GRACE_CHARS

      const processLine = (line: string): void => {
        // 已熔断收尾：剩余上游行全部丢弃（含 [DONE]，避免出现第二套收尾）
        if (runawayTerminated) return
        const trimmed = line.trim()
        if (!trimmed) return
        if (trimmed.startsWith('event:')) {
          currentEvent = trimmed.slice(6).trim()
          return
        }
        if (!trimmed.startsWith('data:')) return

        // 提前熔断：已抑制后空转满 grace 字符仍无正文 → 立刻收尾（上游不会自己停）
        if (runawayGraceExhausted()) {
          writeRunawayTerminal()
          return
        }

        const dataContent = trimmed.slice(5).trim()
        if (dataContent === '[DONE]') {
          sawDone = true
          // 空转到底：只回过垃圾推理，[DONE] 不能当成功收尾
          if (guard.suppressed && contentChars === 0) {
            writeRunawayTerminal()
            return
          }
          writeDone()
          return
        }
        if (dataContent.includes('"chat.completion.chunk"')) {
          controller.enqueue(encodeSse(dataContent))
          return
        }

        let evObj: any = null
        try {
          evObj = JSON.parse(dataContent)
        } catch {
          return
        }
        if (!evObj || typeof evObj !== 'object') return

        const ev = evObj.event || (evObj.data && evObj.data.event) || currentEvent
        const payload = evObj.payload || (evObj.data && evObj.data.payload) || evObj

        switch (ev) {
          case 'plan_item': {
            const thoughtText = payload.reasoning_content || payload.thought || payload.plan_title
            if (thoughtText) {
              // 退化防护投喂用的是**上游原文**而非 handleDelta 的去重结果：
              // 上游重复下发同一段思考时 handleDelta 返回 ''（客户端看不到重复），
              // 若只在去重结果上判退化，网关会把「上游正在空转」这一段盲掉——UI 干净了，
              // 积分却照样在烧。判定与转发因此解耦。
              guard.feed(String(thoughtText), contentChars > 0)
              const d = handleDelta(String(thoughtText))
              if (d && !guard.suppressed) writeChunk({ reasoning_content: d }, '')
            }
            if (payload.tool_call_info?.params?.summary) {
              const d = handleDelta(String(payload.tool_call_info.params.summary))
              if (d) {
                contentChars += d.length
                writeChunk({ content: d }, '')
              }
            }
            break
          }
          case 'output': {
            if (Array.isArray(payload.choices)) {
              for (const choice of payload.choices) {
                if (choice?.text && choice.text !== '[]') {
                  const d = handleDelta(String(choice.text))
                  if (d) {
                    contentChars += d.length
                    writeChunk({ content: d }, '')
                  }
                }
              }
            } else if (typeof payload.response === 'string') {
              const d = handleDelta(payload.response)
              if (d) {
                contentChars += d.length
                writeChunk({ content: d }, '')
              }
            } else if (typeof payload.text === 'string') {
              const d = handleDelta(payload.text)
              if (d) {
                contentChars += d.length
                writeChunk({ content: d }, '')
              }
            }
            break
          }
          case 'token_usage': {
            pendingUsage = normalizeSoloUsage(payload)
            break
          }
          case 'done': {
            if (payload.last_assistant_response) {
              let finalText = ''
              try {
                finalText = pickWorkFinalAnswer(JSON.parse(payload.last_assistant_response))
              } catch {
                // 非 JSON 裸文本：按原样当正文（形态 3）
                finalText = String(payload.last_assistant_response)
              }
              if (finalText) {
                const d = handleDelta(finalText)
                if (d) {
                  contentChars += d.length
                  writeChunk({ content: d }, '')
                }
              }
            }
            // 退化空转：done 到了但全程没有正文（只有被抑制的垃圾推理）→ 不能当成功收尾
            if (guard.suppressed && contentChars === 0) {
              sawDone = true
              writeRunawayTerminal()
              break
            }
            writeChunk({}, 'stop')
            writeDone()
            sawDone = true
            break
          }
          case 'error': {
            const errMsg = evObj.message || payload.message || 'upstream work error'
            const errCode = evObj.code || payload.code || 500
            const se: SOLOStreamError = { code: errCode, msg: errMsg }
            if (onErr) onErr(se)
            const errFrame = { error: { message: `work error code=${errCode} msg=${errMsg}`, type: 'upstream_error', code: String(errCode) } }
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(errFrame)}\n\n`))
            writeChunk({}, 'stop')
            writeDone()
            sawDone = true
            break
          }
        }
      }

      const decoder = new TextDecoderStream()
      const textReader = upstream.pipeThrough(decoder).getReader()

      try {
        while (true) {
          const { done, value } = await textReader.read()
          if (done) break
          if (!value) continue
          lineBuffer += value
          const lines = lineBuffer.split('\n')
          lineBuffer = lines.pop() || ''
          for (const line of lines) {
            processLine(line.replace(/\r$/, ''))
          }
          if (runawayTerminated) {
            // 已熔断收尾：立刻停止读上游（上游不会自己停，继续读只烧积分）
            await textReader.cancel().catch(() => { /* 取消失败不影响已发出的收尾帧 */ })
            break
          }
        }
        if (lineBuffer.trim()) {
          processLine(lineBuffer.replace(/\r$/, ''))
        }
      } catch (e) {
        if (!runawayTerminated && !sawDone) {
          const errFrame = { error: { message: (e as Error).message || 'stream read error', type: 'transport_error' } }
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(errFrame)}\n\n`))
        }
      } finally {
        // 退化熔断兜底（先于 no-done 兜底）：抑制后上游自己结束/异常收尾而全程无正文时，
        // 必须报「模型空转」而不是落进下面的 stop 兜底（那会把空转伪装成正常收尾）。
        if (!runawayTerminated && guard.suppressed && contentChars === 0) {
          writeRunawayTerminal()
        }
        if (!runawayTerminated && !sawDone) {
          writeChunk({}, 'stop')
          writeDone()
        }
        controller.close()
      }
    },
  })
}

/**
 * 将完整的 Work SSE 文本聚合成非流式 OpenAI chat.completion 响应。
 *
 * 与 `aggregateSoloSse` 同一条判定：**没收到 done 就不是成功**。Work 侧的自然收尾信号
 * 有两个（`event: done` 与 SSE 层 `[DONE]`，与 `workStreamToOpenAIStream` 的 sawDone 一致），
 * 二者都没出现时返回 `truncated`，且 finish_reason 不再硬编码 stop（降级为 length）。
 * 此前该值是无条件 `'stop'`，等价于把上游截断伪装成正常完成。
 */
export function aggregateWorkSse(text: string, model: string, opts?: { readError?: boolean }): { resp: Record<string, any> | null; err: SOLOStreamError | null; truncated: SoloStreamEndInfo | null } {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed)
      if (obj && Array.isArray(obj.choices)) {
        return { resp: obj, err: null, truncated: null }
      }
    } catch { /* continue */ }
  }

  let fullContent = ''
  let fullReasoning = ''
  let usage: Record<string, any> | null = null
  let upstreamErr: SOLOStreamError | null = null
  let sawDone = false
  let currentEvent = ''
  let fullText = ''

  const handleDelta = (t: string): string => {
    if (!t) return ''
    if (t.startsWith(fullText) && t.length > fullText.length) {
      const delta = t.slice(fullText.length)
      fullText = t
      return delta
    } else if (!fullText.includes(t)) {
      fullText += t
      return t
    }
    return ''
  }

  const lines = text.split('\n')
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '').trim()
    if (!line) continue
    if (line.startsWith('event:')) {
      currentEvent = line.slice(6).trim()
      continue
    }
    if (!line.startsWith('data:')) continue
    const dataContent = line.slice(5).trim()
    if (dataContent === '[DONE]') { sawDone = true; break }

    let evObj: any = null
    try {
      evObj = JSON.parse(dataContent)
    } catch {
      continue
    }
    if (!evObj || typeof evObj !== 'object') continue

    const ev = evObj.event || (evObj.data && evObj.data.event) || currentEvent
    const payload = evObj.payload || (evObj.data && evObj.data.payload) || evObj

    switch (ev) {
      case 'plan_item': {
        const thoughtText = payload.reasoning_content || payload.thought || payload.plan_title
        if (thoughtText) {
          const d = handleDelta(String(thoughtText))
          if (d) fullReasoning += d
        }
        if (payload.tool_call_info?.params?.summary) {
          const d = handleDelta(String(payload.tool_call_info.params.summary))
          if (d) fullContent += d
        }
        break
      }
      case 'output': {
        if (Array.isArray(payload.choices)) {
          for (const choice of payload.choices) {
            if (choice?.text && choice.text !== '[]') {
              const d = handleDelta(String(choice.text))
              if (d) fullContent += d
            }
          }
        } else if (typeof payload.response === 'string') {
          const d = handleDelta(payload.response)
          if (d) fullContent += d
        } else if (typeof payload.text === 'string') {
          const d = handleDelta(payload.text)
          if (d) fullContent += d
        }
        break
      }
      case 'token_usage': {
        usage = normalizeSoloUsage(payload)
        break
      }
      case 'done': {
        sawDone = true
        if (payload.last_assistant_response) {
          // 与流式路径同一提取口径（pickWorkFinalAnswer）：JSON 字符串形态也必须落地
          let finalText = ''
          try {
            finalText = pickWorkFinalAnswer(JSON.parse(payload.last_assistant_response))
          } catch {
            finalText = String(payload.last_assistant_response)
          }
          if (finalText) {
            const d = handleDelta(finalText)
            if (d) fullContent += d
          }
        }
        break
      }
      case 'error': {
        const errMsg = evObj.message || payload.message || 'upstream work error'
        const errCode = evObj.code || payload.code || 500
        upstreamErr = { code: errCode, msg: errMsg }
        break
      }
    }
  }

  if (upstreamErr) return { resp: null, err: upstreamErr, truncated: null }

  // 推理退化（同 SOLO 聚合口径）：Work 聚合不解析工具调用，「产出」只以正文计。
  if (isDegenerateReasoningText(fullReasoning)) {
    if (fullContent === '') {
      return {
        resp: null,
        err: null,
        truncated: {
          kind: 'degenerate_reasoning',
          contentChars: 0,
          reasoningChars: fullReasoning.length,
          sawToolCalls: false,
          sawUsage: usage !== null,
        },
      }
    }
    fullReasoning = ''
  }

  const message: Record<string, any> = { role: 'assistant', content: fullContent }
  if (fullReasoning) message['reasoning_content'] = fullReasoning

  const truncated: SoloStreamEndInfo | null = sawDone ? null : {
    kind: opts?.readError ? 'read_error' : 'no_done',
    contentChars: fullContent.length,
    reasoningChars: fullReasoning.length,
    sawToolCalls: false, // Work 聚合不解析工具调用
    sawUsage: usage !== null,
  }

  const resp: Record<string, any> = {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: truncated ? 'length' : 'stop' }],
  }
  if (usage) resp['usage'] = usage
  return { resp, err: null, truncated }
}
