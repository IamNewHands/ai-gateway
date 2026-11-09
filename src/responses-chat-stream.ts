type JsonObject = Record<string, unknown>
type FinishReason = 'stop' | 'tool_calls' | 'length'

export interface ResponsesChatFailure {
  code: string
  message: string
  status: number
}

export interface ResponsesChatStreamSummary {
  outcome: 'completed' | 'incomplete' | 'failed' | 'cancelled'
  terminalEvent: string
  responseId: string
  events: number
  contentChars: number
  reasoningChars: number
  toolCalls: number
  empty: boolean
  errorCode?: string
}

export interface ResponsesChatStreamOptions {
  includeUsage?: boolean
  /** 由调用方复用网关的脱敏策略；未提供时不回显上游文案。 */
  sanitizeErrorText?: (text: string) => string
  onFinish?: (summary: ResponsesChatStreamSummary) => void
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function index(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

function errorCode(value: unknown): string {
  const code = string(value)
  return /^[a-z][a-z0-9_.-]{0,80}$/i.test(code) && !/sk-|bearer/i.test(code) ? code : 'upstream_error'
}

function failure(code: string, message: string, status = 502): ResponsesChatFailure {
  return { code, message, status }
}

function upstreamFailure(value: unknown): ResponsesChatFailure {
  const err = object(value)
  const code = errorCode(err?.['code'] ?? err?.['type'])
  const message = string(err?.['message']) || string(value) || 'Responses upstream failed without error details'
  const status = code === 'rate_limit_exceeded' ? 429
    : ['invalid_request_error', 'content_filter', 'context_length_exceeded'].includes(code) ? 400
    : ['authentication_error', 'invalid_api_key'].includes(code) ? 401
    : 502
  return failure(code, message, status)
}

export function responsesChatErrorBody(
  err: ResponsesChatFailure,
  options?: ResponsesChatStreamOptions,
): { error: { type: string; code: string; message: string } } {
  let message = err.code
  try { message = options?.sanitizeErrorText?.(err.message) ?? err.code } catch { /* 未净化原文不能回显 */ }
  return { error: { type: 'upstream_error', code: err.code, message: `${err.status} Responses upstream [${err.code}]: ${message}` } }
}

function toolFailure(callId: string, name: string, args: unknown, finalized: boolean): ResponsesChatFailure | undefined {
  if (!callId || !name || !finalized) return failure('upstream_invalid_response', 'Responses completed with an unfinished tool call')
  let parsed: unknown = args
  if (typeof args === 'string') {
    try { parsed = JSON.parse(args) } catch { return failure('upstream_invalid_response', 'Responses completed with invalid tool arguments') }
  }
  if (!object(parsed)) return failure('upstream_invalid_response', 'Responses tool arguments must be a JSON object')
  return undefined
}

function nestedPartsFailure(item: JsonObject): ResponsesChatFailure | undefined {
  if (item['type'] !== 'message' && item['type'] !== 'reasoning') return undefined
  for (const key of ['content', 'summary']) {
    const parts = item[key]
    if (Array.isArray(parts) && parts.some(part => !object(part))) {
      return failure('upstream_invalid_response', 'Responses content or summary contains a non-object part')
    }
  }
  return undefined
}

/** 终态 output 的结构/工具校验供 JSON 和 SSE 共用；不校验被明确标记 length 的截断参数。 */
function outputFailure(value: unknown, truncated: boolean): ResponsesChatFailure | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return failure('upstream_invalid_response', 'Responses output is not an array')
  for (const raw of value) {
    const item = object(raw)
    if (!item || !['message', 'output_text', 'reasoning', 'function_call'].includes(string(item['type']))) {
      return failure('upstream_invalid_response', 'Unsupported Responses output item type')
    }
    const nestedError = nestedPartsFailure(item)
    if (nestedError) return nestedError
    if (item['type'] === 'function_call' && !truncated) {
      const err = toolFailure(string(item['call_id']) || string(item['id']), string(item['name']), item['arguments'], item['status'] === undefined || item['status'] === 'completed')
      if (err) return err
    }
  }
  return undefined
}

/** JSON 与 SSE 共用终态语义；缺省 status 保留现有兼容。 */
export function responsesChatTerminal(response: JsonObject, eventName = 'response.completed'): {
  finishReason: 'stop' | 'length'
  error?: ResponsesChatFailure
} {
  if (response['error'] != null || eventName === 'response.failed' || response['status'] === 'failed') {
    return { finishReason: 'stop', error: upstreamFailure(response['error']) }
  }
  let finishReason: 'stop' | 'length' = 'stop'
  if (eventName === 'response.incomplete' || response['status'] === 'incomplete') {
    const reason = string(object(response['incomplete_details'])?.['reason'])
    if (reason !== 'max_output_tokens') return {
      finishReason,
      error: failure(reason === 'content_filter' ? reason : 'upstream_incomplete', `Responses incomplete: ${reason || 'no reason'}`, reason === 'content_filter' ? 400 : 502),
    }
    finishReason = 'length'
  } else if (response['status'] !== undefined && response['status'] !== 'completed') {
    return { finishReason, error: failure('upstream_invalid_response', 'Responses terminal event has a non-terminal status') }
  }
  const error = outputFailure(response['output'], finishReason === 'length')
  return { finishReason, ...(error ? { error } : {}) }
}

function outputKind(item: JsonObject): OutputItem['kind'] | undefined {
  return item['type'] === 'output_text' ? 'message'
    : ['message', 'reasoning', 'function_call'].includes(string(item['type'])) ? item['type'] as OutputItem['kind'] : undefined
}

function snapshotParts(snapshot: JsonObject): Map<string, string> {
  const parts = new Map<string, string>()
  const kind = outputKind(snapshot)
  if (snapshot['type'] === 'output_text' && typeof snapshot['text'] === 'string') parts.set('text:0', snapshot['text'])
  if (typeof snapshot['content'] === 'string') parts.set('text:0', snapshot['content'])
  if (Array.isArray(snapshot['content'])) for (const [partIndex, raw] of snapshot['content'].entries()) {
    const part = object(raw)
    if (!part) continue
    const refusal = part['type'] === 'refusal'
    const channel = kind === 'reasoning' ? 'reasoning' : refusal ? 'refusal' : 'text'
    const value = refusal ? part['refusal'] : part['text']
    if (typeof value === 'string') parts.set(`${channel}:${partIndex}`, value)
  }
  if (kind === 'reasoning' && Array.isArray(snapshot['summary'])) for (const [partIndex, raw] of snapshot['summary'].entries()) {
    const value = object(raw)?.['text']
    if (typeof value === 'string') parts.set(`summary:${partIndex}`, value)
  }
  return parts
}

interface OutputItem {
  kind: 'message' | 'reasoning' | 'function_call'
  id: string
  outputIndex?: number
  snapshot?: JsonObject
  finalParts?: Map<string, string>
  parts: Map<string, string>
  callId: string
  name: string
  arguments: string
  sentArguments: string
  toolIndex?: number
  announced: boolean
  finalized: boolean
}

/**
 * Responses SSE → Chat SSE。按 output item/part 对账，最终快照只补未发送后缀。
 * 保留可调用的原接口；end/fail/cancel 由字节流 owner 收口生命周期。
 */
export function createResponsesSSEToOpenAI(modelHint: string, options?: ResponsesChatStreamOptions) {
  let messageId = `chatcmpl_${Math.random().toString(36).slice(2, 12)}`
  let responseId = ''
  let model = modelHint
  const created = Math.floor(Date.now() / 1000)
  let started = false
  let finished = false
  let events = 0
  let contentChars = 0
  let reasoningChars = 0
  let nextToolIndex = 0
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } }
  const items = new Set<OutputItem>()
  const byId = new Map<string, OutputItem>()
  const byIndex = new Map<number, OutputItem>()
  const anonymous = new Map<OutputItem['kind'], OutputItem>()

  const chunk = (delta: JsonObject, finishReason: FinishReason | null = null, includeUsage = false): string => `data: ${JSON.stringify({
    id: messageId, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
    ...(includeUsage && (options?.includeUsage ?? true) ? { usage } : {}),
  })}\n\n`

  const start = (out: string[]): void => {
    if (started) return
    started = true
    out.push(chunk({ role: 'assistant', content: '' }))
  }

  const notify = (outcome: ResponsesChatStreamSummary['outcome'], terminalEvent: string, error?: ResponsesChatFailure): void => {
    const summary: ResponsesChatStreamSummary = {
      outcome, terminalEvent, responseId, events, contentChars, reasoningChars, toolCalls: nextToolIndex,
      empty: contentChars === 0 && reasoningChars === 0 && nextToolIndex === 0,
      ...(error ? { errorCode: error.code } : {}),
    }
    try { options?.onFinish?.(summary) } catch { /* 诊断失败不能改变客户端流 */ }
  }

  const fail = (err: ResponsesChatFailure, eventName = 'transport.error'): string[] => {
    if (finished) return []
    finished = true
    notify('failed', eventName, err)
    return [`data: ${JSON.stringify(responsesChatErrorBody(err, options))}\n\n`, 'data: [DONE]\n\n']
  }

  const invalid: (message: string) => never = (message) => { throw new Error(message) }

  const readUsage = (value: unknown): void => {
    const u = object(value)
    if (!u) return
    if (typeof u['input_tokens'] === 'number') usage.prompt_tokens = u['input_tokens']
    if (typeof u['output_tokens'] === 'number') usage.completion_tokens = u['output_tokens']
    usage.total_tokens = typeof u['total_tokens'] === 'number' ? u['total_tokens'] : usage.prompt_tokens + usage.completion_tokens
    const details = object(u['input_tokens_details'])
    if (typeof details?.['cached_tokens'] === 'number') usage.prompt_tokens_details.cached_tokens = details['cached_tokens']
  }

  const itemFor = (data: JsonObject, kind: OutputItem['kind'], snapshot?: JsonObject): OutputItem => {
    const id = string(snapshot?.['id']) || string(data['item_id'])
    const outputIndex = index(data['output_index'])
    const idItem = id ? byId.get(id) : undefined
    const indexItem = outputIndex === undefined ? undefined : byIndex.get(outputIndex)
    if (idItem && indexItem && idItem !== indexItem) invalid('Conflicting Responses output item identities')
    let item = idItem ?? indexItem
    if (!id && outputIndex === undefined) {
      const candidates = [...items].filter(candidate => candidate.kind === kind && !candidate.finalized)
      if (candidates.length > 1) invalid('Responses delta has an ambiguous output item identity')
      item ??= candidates[0]
    }
    // 只有明确身份或唯一活跃项可以绑定；匿名增量留到完整快照对账。
    if (!id && outputIndex === undefined) item ??= anonymous.get(kind)
    if (!item) {
      item = { kind, id: '', parts: new Map(), callId: '', name: '', arguments: '', sentArguments: '', announced: false, finalized: false }
      items.add(item)
    }
    if (item.kind !== kind) invalid('Responses output item changed type')
    if (id && item.id && id !== item.id) invalid('Responses output item changed id')
    if (outputIndex !== undefined && item.outputIndex !== undefined && item.outputIndex !== outputIndex) invalid('Responses output item changed index')
    if (id) { item.id = id; byId.set(id, item) }
    if (outputIndex !== undefined) { item.outputIndex = outputIndex; byIndex.set(outputIndex, item) }
    if (!item.id && item.outputIndex === undefined) anonymous.set(kind, item)
    else if (anonymous.get(kind) === item) anonymous.delete(kind)
    return item
  }

  const appendPart = (out: string[], item: OutputItem, part: string, text: string, snapshot: boolean): void => {
    if (snapshot && anonymous.has(item.kind) && anonymous.get(item.kind) !== item) {
      item.finalParts ??= new Map()
      item.finalParts.set(part, text)
      return
    }
    const previous = item.parts.get(part) ?? ''
    if (snapshot && !text.startsWith(previous)) invalid('Responses final text disagrees with streamed prefix')
    const delta = snapshot ? text.slice(previous.length) : text
    item.parts.set(part, snapshot ? text : previous + text)
    if (!delta) return
    start(out)
    const reasoning = item.kind === 'reasoning'
    if (reasoning) reasoningChars += delta.length
    else contentChars += delta.length
    out.push(chunk({ [reasoning ? 'reasoning_content' : 'content']: delta }))
  }

  const emitTool = (out: string[], item: OutputItem): void => {
    if (!item.callId || !item.name || (anonymous.has('function_call') && anonymous.get('function_call') !== item)) return
    start(out)
    if (!item.announced) {
      item.announced = true
      item.toolIndex = nextToolIndex++
      out.push(chunk({ tool_calls: [{ index: item.toolIndex, id: item.callId, type: 'function', function: { name: item.name, arguments: '' } }] }))
    }
    const delta = item.arguments.slice(item.sentArguments.length)
    for (let offset = 0; offset < delta.length; offset += 512) {
      out.push(chunk({ tool_calls: [{ index: item.toolIndex, function: { arguments: delta.slice(offset, offset + 512) } }] }))
    }
    item.sentArguments = item.arguments
  }

  const toolArguments = (out: string[], item: OutputItem, text: string, snapshot: boolean): void => {
    if (snapshot && anonymous.has('function_call') && anonymous.get('function_call') !== item) return
    if (snapshot && !text.startsWith(item.arguments)) invalid('Responses final tool arguments disagree with streamed prefix')
    item.arguments = snapshot ? text : item.arguments + text
    emitTool(out, item)
  }

  const applyItem = (out: string[], data: JsonObject, value: unknown, final: boolean): void => {
    const snapshot = object(value)
    if (!snapshot) invalid('Responses output item is not an object')
    const type = snapshot['type']
    if (!['message', 'output_text', 'reasoning', 'function_call'].includes(string(type))) {
      if (final) invalid('Unsupported Responses output item type')
      return
    }
    const nestedError = nestedPartsFailure(snapshot)
    if (nestedError) invalid(nestedError.message)
    const kind = type === 'output_text' ? 'message' : type as OutputItem['kind']
    const item = itemFor(data, kind, snapshot)
    item.snapshot = snapshot
    if (kind === 'function_call') {
      const callId = string(snapshot['call_id']) || item.callId || (final ? string(snapshot['id']) : '')
      const name = string(snapshot['name']) || item.name
      if ((item.callId && callId !== item.callId) || (item.name && name !== item.name)) invalid('Responses tool identity changed')
      item.callId = callId
      item.name = name
      const args = snapshot['arguments']
      if (args !== undefined) toolArguments(out, item, typeof args === 'string' ? args : JSON.stringify(args), true)
      else emitTool(out, item)
      if (final) item.finalized = snapshot['status'] === undefined || snapshot['status'] === 'completed'
      return
    }
    if (!final) return
    item.finalized = true
    if (anonymous.has(kind) && anonymous.get(kind) !== item) return
    for (const [part, text] of snapshotParts(snapshot)) appendPart(out, item, part, text, true)
  }

  const settleAnonymous = (output: unknown, outForAnonymous: string[]): void => {
    const candidates = Array.isArray(output) && output.length > 0
      ? output.map((snapshot, outputIndex) => ({ snapshot: object(snapshot), outputIndex }))
      : [...items].filter(item => item.snapshot && item.finalized).map(item => ({ snapshot: item.snapshot, outputIndex: item.outputIndex }))
    for (const [kind, pending] of anonymous) {
      const matching = candidates.filter(({ snapshot }) => {
        if (!snapshot || outputKind(snapshot) !== kind) return false
        if (kind === 'function_call') {
          const args = snapshot['arguments']
          const text = typeof args === 'string' ? args : JSON.stringify(args ?? {})
          return text.startsWith(pending.arguments)
        }
        const parts = snapshotParts(snapshot)
        return [...pending.parts].every(([part, text]) => parts.get(part)?.startsWith(text))
      })
      if (matching.length === 0 && candidates.length === 0 && ![...items].some(item => item !== pending && item.kind === kind)) continue
      if (matching.length !== 1) invalid('Responses anonymous output cannot be uniquely reconciled')
      const { snapshot, outputIndex } = matching[0]
      const target = itemFor({ output_index: outputIndex }, kind, snapshot)
      if (target !== pending) {
        if (target.sentArguments) invalid('Responses anonymous tool output overlaps an announced item')
        const complete = snapshotParts(snapshot!)
        for (const part of new Set([...pending.parts.keys(), ...target.parts.keys()])) {
          const combined = (pending.parts.get(part) ?? '') + (target.parts.get(part) ?? '')
          if (!complete.get(part)?.startsWith(combined)) invalid('Responses anonymous and identified text disagree with final snapshot')
          target.parts.set(part, combined)
        }
        if (kind === 'function_call') {
          const combined = pending.arguments + target.arguments
          const args = snapshot!['arguments']
          const text = typeof args === 'string' ? args : JSON.stringify(args ?? {})
          if (!text.startsWith(combined)) invalid('Responses anonymous and identified arguments disagree with final snapshot')
          target.arguments = combined
          target.sentArguments = pending.sentArguments
        }
        items.delete(pending)
      }
      anonymous.delete(kind)
      for (const item of items) if (item.kind === kind && item.finalParts) {
        for (const [part, text] of item.finalParts) appendPart(outForAnonymous, item, part, text, true)
        item.finalParts = undefined
      }
    }
  }

  const finish = (out: string[], reason: 'stop' | 'length', eventName: string): void => {
    for (const item of items) if (reason !== 'length' && item.kind === 'function_call') {
      const err = toolFailure(item.callId, item.name, item.arguments, item.finalized)
      if (err) invalid(err.message)
    }
    finished = true
    start(out)
    out.push(chunk({}, reason === 'length' ? 'length' : nextToolIndex > 0 ? 'tool_calls' : 'stop', true), 'data: [DONE]\n\n')
    notify(reason === 'length' ? 'incomplete' : 'completed', eventName)
  }

  const convert = (eventName: string, data: JsonObject): string[] => {
    if (finished) return []
    events++
    const out: string[] = []
    try {
      if (eventName === 'error') return fail(upstreamFailure(data['error'] ?? data), eventName)
      if (eventName === 'response.created') {
        const r = object(data['response'])
        responseId = string(r?.['id'])
        if (responseId) messageId = `chatcmpl_${responseId.replace(/^resp_/, '')}`
        model = string(r?.['model']) || model
        readUsage(r?.['usage'])
        start(out)
      } else if (eventName === 'response.output_item.added' || eventName === 'response.output_item.done') {
        applyItem(out, data, data['item'], eventName.endsWith('.done'))
      } else if (eventName === 'response.function_call_arguments.delta' || eventName === 'response.function_call_arguments.done') {
        const item = itemFor(data, 'function_call')
        const done = eventName.endsWith('.done')
        const text = data[done ? 'arguments' : 'delta']
        if (typeof text !== 'string') invalid('Responses tool arguments event has no string payload')
        toolArguments(out, item, text, done)
      } else if (['response.output_text.delta', 'response.output_text.done', 'response.refusal.delta', 'response.refusal.done', 'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done', 'response.reasoning_text.delta', 'response.reasoning_text.done'].includes(eventName)) {
        const reasoning = eventName.includes('.reasoning')
        const summary = eventName.includes('_summary_')
        const refusal = eventName.includes('.refusal.')
        const done = eventName.endsWith('.done')
        const partIndex = index(data[summary ? 'summary_index' : 'content_index']) ?? 0
        const item = itemFor(data, reasoning ? 'reasoning' : 'message')
        const channel = summary ? 'summary' : reasoning ? 'reasoning' : refusal ? 'refusal' : 'text'
        const text = data[done ? refusal ? 'refusal' : 'text' : 'delta']
        if (typeof text !== 'string') invalid('Responses text event has no string payload')
        appendPart(out, item, `${channel}:${partIndex}`, text, done)
      } else if (['response.completed', 'response.done', 'response.incomplete', 'response.failed'].includes(eventName)) {
        const r = object(data['response'])
        if (!r) invalid('Responses terminal event has no response object')
        responseId = string(r['id']) || responseId
        const terminal = responsesChatTerminal(r, eventName)
        readUsage(r['usage'])
        if (terminal.error) return fail(terminal.error, eventName)
        const output = r['output']
        settleAnonymous(output, out)
        if (Array.isArray(output) && output.length > 0) {
          for (const [outputIndex, item] of output.entries()) applyItem(out, { output_index: outputIndex }, item, true)
        } else {
          for (const item of items) if (item.snapshot && item.finalized) applyItem(out, { output_index: item.outputIndex }, item.snapshot, true)
        }
        finish(out, terminal.finishReason, eventName)
      }
    } catch (err) {
      out.push(...fail(failure('upstream_invalid_response', err instanceof Error ? err.message : 'Invalid Responses stream'), eventName))
    }
    return out
  }

  return Object.assign(convert, {
    isFinished: () => finished,
    fail,
    end: () => fail(failure('upstream_no_finish', 'Responses stream ended without a terminal response event'), 'transport.eof'),
    cancel: () => {
      if (finished) return
      finished = true
      notify('cancelled', 'transport.cancel')
    },
  })
}

/** 最大单帧 4 MiB（字符），防坏上游不换行时无界增长；不限制整个回答长度。 */
const MAX_SSE_FRAME_CHARS = 4 * 1024 * 1024

/** 按完整 SSE 帧分派；终态后取消上游，客户端取消时不伪造错误。 */
export function responsesSSEToChatStream(
  body: ReadableStream<Uint8Array>,
  model: string,
  options?: ResponsesChatStreamOptions,
): ReadableStream<Uint8Array> {
  const conv = createResponsesSSEToOpenAI(model, options)
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let cancelled = false
  let lineBuffer = ''
  let eventName = ''
  let dataLines: string[] = []
  let frameChars = 0
  let eof = false
  const pending: Uint8Array[] = []

  const emit = (frames: string[]): void => { for (const frame of frames) pending.push(encoder.encode(frame)) }
  const tooLarge = (): void => { emit(conv.fail(failure('upstream_invalid_sse', 'Responses SSE frame exceeds 4 MiB'))) }
  const dispatch = (): void => {
    const data = dataLines.join('\n')
    const event = eventName
    eventName = ''
    dataLines = []
    frameChars = 0
    if (!data || conv.isFinished()) return
    if (data.trim() === '[DONE]') { emit(conv.end()); return }
    let parsed: JsonObject | undefined
    try { parsed = object(JSON.parse(data)) } catch { /* 不回显坏帧 */ }
    if (!parsed) { emit(conv.fail(failure('upstream_invalid_sse', 'Invalid JSON object in Responses SSE frame'))); return }
    emit(conv(event || string(parsed['type']), parsed))
  }
  const line = (value: string, width = 1): void => {
    if (value === '') { dispatch(); return }
    frameChars += value.length + width
    if (frameChars > MAX_SSE_FRAME_CHARS) { tooLarge(); return }
    if (value.startsWith(':')) return
    const colon = value.indexOf(':')
    const field = colon < 0 ? value : value.slice(0, colon)
    let data = colon < 0 ? '' : value.slice(colon + 1)
    if (data.startsWith(' ')) data = data.slice(1)
    if (field === 'event') eventName = data
    if (field === 'data') dataLines.push(data)
  }
  // 每次只消费到一个下行事件；剩余已读 chunk 留到下一次 pull，不预读整个回答。
  const consume = (): void => {
    while (!conv.isFinished() && pending.length === 0) {
      const nl = lineBuffer.search(/[\r\n]/)
      if (nl < 0 || (!eof && nl === lineBuffer.length - 1 && lineBuffer[nl] === '\r')) break
      const value = lineBuffer.slice(0, nl)
      const width = lineBuffer[nl] === '\r' && lineBuffer[nl + 1] === '\n' ? 2 : 1
      lineBuffer = lineBuffer.slice(nl + width)
      line(value, width)
    }
    if (pending.length || conv.isFinished()) return
    if (lineBuffer.length + frameChars > MAX_SSE_FRAME_CHARS) { tooLarge(); return }
    if (eof) {
      if (lineBuffer) line(lineBuffer, 0)
      lineBuffer = ''
      if (!conv.isFinished()) dispatch()
      emit(conv.end())
    }
  }
  const stopUpstream = (): void => { void reader.cancel().catch(() => {}) }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (!cancelled && pending.length === 0 && !conv.isFinished()) {
          consume()
          if (pending.length || conv.isFinished()) break
          const result = await reader.read()
          if (cancelled) return
          eof = result.done
          lineBuffer += result.done ? decoder.decode() : decoder.decode(result.value, { stream: true })
        }
      } catch {
        if (!cancelled) emit(conv.fail(failure('upstream_interrupted', 'Responses stream read failed before completion'), 'transport.read_error'))
      }
      if (cancelled) return
      const frame = pending.shift()
      if (frame) controller.enqueue(frame)
      if (conv.isFinished()) {
        stopUpstream()
        if (pending.length === 0) controller.close()
      }
    },
    cancel() {
      cancelled = true
      pending.length = 0
      lineBuffer = ''
      dataLines = []
      conv.cancel()
      return reader.cancel().catch(() => {})
    },
  }, { highWaterMark: 0 })
}
