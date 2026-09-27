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
    case 'error':
      if (typeof raw['code'] === 'number') ev.errorCode = raw['code']
      if (typeof raw['message'] === 'string') ev.errorMessage = raw['message']
      break
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
  const toolCalls = new Map<number, Record<string, any>>()
  const toolOrder: number[] = []
  let upstreamErr: SOLOStreamError | null = null
  let sawDone = false

  for (const ev of events) {
    switch (ev.event) {
      case 'output':
        content += ev.response
        reasoning += ev.reasoning
        mergeToolCallJSON(toolCalls, toolOrder, ev.toolCalls)
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

  // 推理退化（runaway.ts 的行重复判据）：非流式没有「中途抑制」的机会，只能事后处置。
  //  - 全程无正文/工具调用 → 不是成功结果：返回 truncated（调用方按可重试失败处理，
  //    且**不得罚号**——退化成因在模型侧）。拿垃圾推理当答案返回，就是本防护要消灭的假成功；
  //  - 有正文 → 只剔除退化推理文本，正文照常返回（不能因为思考脏了就丢掉可用答案）。
  if (isDegenerateReasoningText(reasoning)) {
    if (content === '' && toolOrder.length === 0) {
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
  if (toolOrder.length > 0) {
    toolOrder.sort((a, b) => a - b)
    // OpenAI 非流式 tool_call：不含 index（index 仅流式增量用），type 缺省补 function
    message['tool_calls'] = toolOrder.map((idx) => {
      const call = toolCalls.get(idx)
      if (call && typeof call === 'object') {
        delete call['index']
        if (typeof call['type'] !== 'string' || call['type'] === '') call['type'] = 'function'
      }
      return call
    })
    // 本回合模型发起工具调用 → finish_reason 必须是 tool_calls（上游常自报 stop）
    finishReason = 'tool_calls'
  }

  // 非流式没有错误帧可发，finish_reason 是客户端唯一可见的收尾信号：没收到 done 就不能给
  // stop 的假象（有工具调用时保留 tool_calls —— 那是可执行动作，不该被降级成 length）。
  if (!sawDone && toolOrder.length === 0) finishReason = 'length'

  // 无 done = 上游半路断流（或读体异常）。调用方必须据此判失败，不得把 resp 当成功返回。
  const truncated: SoloStreamEndInfo | null = sawDone ? null : {
    kind: opts?.readError ? 'read_error' : 'no_done',
    contentChars: content.length,
    reasoningChars: reasoning.length,
    sawToolCalls: toolOrder.length > 0,
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

/**
 * 把 SOLO output.tool_calls（可能 null/对象/数组）合并进 toolCalls（按 index）。
 */
function mergeToolCallJSON(toolCalls: Map<number, Record<string, any>>, toolOrder: number[], raw: unknown): void {
  if (raw === null || raw === undefined || raw === 'null') return
  let arr: Record<string, any>[] | null = null
  if (Array.isArray(raw)) {
    arr = raw as Record<string, any>[]
  } else if (typeof raw === 'object') {
    arr = [raw as Record<string, any>]
  } else if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) arr = parsed
      else if (parsed && typeof parsed === 'object') arr = [parsed]
    } catch { return }
  }
  if (!arr) return
  for (const call of arr) {
    if (!call || typeof call !== 'object') continue
    let idx = 0
    if (typeof call['index'] === 'number') idx = call['index']
    let merged = toolCalls.get(idx)
    if (!merged) {
      merged = { index: idx, type: 'function' }
      toolCalls.set(idx, merged)
      toolOrder.push(idx)
    }
    mergeToolCallDelta(merged, call)
  }
}

/**
 * 把流式 tool_call 片段合并到累计对象：id/type/function.name 直覆盖，function.arguments 拼接。
 * 上游 SOLO 用 `function_call` 字段（实测），OpenAI 标准用 `function`；两者都兼容。
 */
function mergeToolCallDelta(merged: Record<string, any>, delta: Record<string, any>): void {
  if (typeof delta['id'] === 'string' && delta['id'] !== '') merged['id'] = delta['id']
  if (typeof delta['type'] === 'string' && delta['type'] !== '') merged['type'] = delta['type']
  let df = delta['function']
  if (!df || typeof df !== 'object') df = delta['function_call']
  if (!df || typeof df !== 'object') return
  // 清理 SOLO 专属字段，只保留标准 OpenAI function 结构(name/arguments)
  delete df['namespace']
  delete df['partial_arguments']
  let mf = merged['function']
  if (!mf || typeof mf !== 'object') {
    mf = {}
    merged['function'] = mf
  }
  if (typeof df['name'] === 'string' && df['name'] !== '') mf['name'] = df['name']
  if (typeof df['arguments'] === 'string' && df['arguments'] !== '') {
    if (typeof mf['arguments'] === 'string' && mf['arguments'] !== '') mf['arguments'] += df['arguments']
    else mf['arguments'] = df['arguments']
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
 */
export function soloStreamToOpenAIStream(
  upstream: ReadableStream<Uint8Array>,
  model: string,
  onErr?: (se: SOLOStreamError) => void,
  onTruncated?: (info: SoloStreamEndInfo) => void,
  onRunaway?: (info: TraeRunawayInfo) => void
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
              // 退化防护：先投喂判定，再决定是否下发推理增量（抑制后思考面板不再被刷屏）。
              // hasProgress 用本帧更新后的计数：本帧带正文/已有工具调用时属正常链路，不做判定。
              if (ev.reasoning !== '') guard.feed(ev.reasoning, contentChars > 0 || sawToolCalls)
              if (ev.response !== '') delta['content'] = ev.response
              if (ev.reasoning !== '' && !guard.suppressed) delta['reasoning_content'] = ev.reasoning
              if (ev.toolCalls !== null && ev.toolCalls !== undefined && ev.toolCalls !== 'null') {
                const tc = normalizeStreamToolCalls(ev.toolCalls)
                if (tc) {
                  delta['tool_calls'] = tc
                  sawToolCalls = true
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
      controller.close()
    },
  })
}

/**
 * 把 SOLO output.tool_calls 条目转成 OpenAI 标准（function_call → function，清 SOLO 专属字段）。
 * 过滤空 tool_calls 数组 / 空 function 对象等噪音（strict 客户端会因空数组解码失败），
 * 并补齐流式必填的 index 字段。
 */
function normalizeStreamToolCalls(raw: unknown): unknown[] | null {
  let arr: any[] | null = null
  if (Array.isArray(raw)) {
    arr = raw
  } else if (typeof raw === 'object' && raw !== null) {
    arr = [raw]
  } else {
    try {
      const parsed = JSON.parse(String(raw))
      if (Array.isArray(parsed)) arr = parsed
      else if (parsed && typeof parsed === 'object') arr = [parsed]
    } catch { return null }
  }
  if (!arr || arr.length === 0) return null
  const out: any[] = []
  for (let i = 0; i < arr.length; i++) {
    const call = arr[i]
    if (!call || typeof call !== 'object') continue
    if (call['function_call'] && typeof call['function_call'] === 'object') {
      call['function'] = call['function_call']
      delete call['function_call']
    }
    const fn = call['function']
    if (fn && typeof fn === 'object') {
      delete fn['namespace']
      delete fn['partial_arguments']
    }
    // 流式 tool_call 增量必须带 index，缺失时按数组位补
    if (typeof call['index'] !== 'number') call['index'] = i
    // 空字符串 id / name 直接删掉，只保留非空值：
    // 严格客户端（openai-node 等）对增量可能"覆盖"而非"补缺"，空 id/name 会把
    // 首个 chunk 已落定的合法值冲掉，最终工具调用 id/函数名丢失 → 解析失败/报错。
    if (typeof call['id'] === 'string' && call['id'] === '') delete call['id']
    if (fn && typeof fn === 'object' && typeof fn['name'] === 'string' && fn['name'] === '') delete fn['name']
    // 剔除无实质内容的空条目（如 {index:0} 或 {function:{}}），避免噪音
    const hasId = typeof call['id'] === 'string' && call['id'] !== ''
    const hasFn = !!fn && typeof fn === 'object' && Object.keys(fn).length > 0
    if (!hasId && !hasFn && call['type'] === undefined) continue
    out.push(call)
  }
  return out.length > 0 ? out : null
}

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
