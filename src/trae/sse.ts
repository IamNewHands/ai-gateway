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
 * 上游 error 事件返回 { err }；成功返回 { resp }。
 */
export function aggregateSoloSse(text: string): { resp: Record<string, any> | null; err: SOLOStreamError | null } {
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

  for (const ev of events) {
    switch (ev.event) {
      case 'output':
        content += ev.response
        reasoning += ev.reasoning
        mergeToolCallJSON(toolCalls, toolOrder, ev.toolCalls)
        break
      case 'token_usage':
        usage = ev.usage
        break
      case 'done':
        if (ev.finishReason !== '') finishReason = ev.finishReason
        break
      case 'error':
        upstreamErr = { code: ev.errorCode, msg: ev.errorMessage }
        break
    }
  }
  if (upstreamErr) return { resp: null, err: upstreamErr }

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

  const resp: Record<string, any> = {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: '',
    choices: [{ index: 0, message, finish_reason: finishReason }],
  }
  if (usage) resp['usage'] = usage
  return { resp, err: null }
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
 * 流式转换：SOLO SSE → OpenAI SSE chunk，使用 ReadableStream 确保流正确结束。
 * 上游流内 error 事件：回调 onErr（供冷却账号/记录日志）并注入一条 error 事件。
 * @param upstream 上游 SOLO SSE 响应体（ReadableStream<Uint8Array>）。
 * @param model 写入 chunk 的模型名（OpenAI 兼容客户端校验用）。
 */
export function soloStreamToOpenAIStream(
  upstream: ReadableStream<Uint8Array>,
  model: string,
  onErr?: (se: SOLOStreamError) => void
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

      const writeChunk = (delta: Record<string, any>, finish: string): void => {
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
        controller.enqueue(encodeSse(JSON.stringify(chunk)))
      }
      const writeDone = (): void => {
        controller.enqueue(encodeSse('[DONE]'))
      }

      const processEvents = (events: SOLOEvent[]): void => {
        for (const ev of events) {
          switch (ev.event) {
            case 'output': {
              const delta: Record<string, any> = {}
              if (ev.response !== '') delta['content'] = ev.response
              if (ev.reasoning !== '') delta['reasoning_content'] = ev.reasoning
              if (ev.toolCalls !== null && ev.toolCalls !== undefined && ev.toolCalls !== 'null') {
                const tc = normalizeStreamToolCalls(ev.toolCalls)
                if (tc) {
                  delta['tool_calls'] = tc
                  sawToolCalls = true
                }
              }
              if (Object.keys(delta).length > 0) writeChunk(delta, '')
              break
            }
            case 'token_usage':
              pendingUsage = ev.usage
              break
            case 'done': {
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
        }
      } catch { /* stream error */ }

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
      if (!sawDone) {
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
