/**
 * formats.ts — 多 API 格式支持
 *
 * AI Gateway 支持三种 API 格式，统一转换为 OpenAI chat/completions
 * 发给 WorkBuddy 上游，再将响应转回对应格式：
 *
 *   1. OpenAI Chat Completions  /v1/chat/completions  （透传，已有）
 *   2. OpenAI Responses         /v1/responses          （新增）
 *   3. Anthropic Messages       /v1/messages           （新增）
 */

// ============================================================
//  Anthropic Messages → OpenAI Chat Completions  请求转换
// ============================================================

interface AnthropicContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  source?: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string }
  tool_use_id?: string
  content?: string | AnthropicContentBlock[]
  is_error?: boolean
  thinking?: string
  signature?: string
}

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

interface AnthropicTool {
  name: string
  description?: string
  input_schema: {
    type: 'object'
    properties?: Record<string, unknown>
    required?: string[]
  }
}

interface AnthropicRequest {
  model: string
  messages: AnthropicMessage[]
  max_tokens: number
  system?: string | AnthropicContentBlock[]
  stop_sequences?: string[]
  stream?: boolean
  temperature?: number
  top_p?: number
  top_k?: number
  tools?: AnthropicTool[]
  tool_choice?: { type: 'auto' | 'any' | 'tool' | 'none'; name?: string; disable_parallel_tool_use?: boolean }
  thinking?: { type: 'enabled'; budget_tokens?: number } | { type: 'disabled' }
  metadata?: { user_id?: string }
}

/**
 * 将 Anthropic Messages 请求转换为 OpenAI Chat Completions 请求
 */
export function anthropicToOpenAI(anthropicReq: AnthropicRequest): Record<string, unknown> {
  const openaiMessages: Record<string, unknown>[] = []

  // system prompt → system message
  if (anthropicReq.system) {
    const sysContent = typeof anthropicReq.system === 'string'
      ? anthropicReq.system
      : anthropicReq.system
          .filter((b) => b.type === 'text')
          .map((b) => b.text || '')
          .join('\n')
    if (sysContent) {
      openaiMessages.push({ role: 'system', content: sysContent })
    }
  }

  // messages 转换
  for (const msg of anthropicReq.messages) {
    if (msg.role === 'user') {
      const result = anthropicUserToOpenAI(msg)
      // 如果 user 消息中包含 tool_result，拆分出 tool 消息
      if (Array.isArray(result)) {
        openaiMessages.push(...result)
      } else {
        openaiMessages.push(result)
      }
    } else if (msg.role === 'assistant') {
      openaiMessages.push(anthropicAssistantToOpenAI(msg))
    }
  }

  const body: Record<string, unknown> = {
    model: anthropicReq.model,
    messages: openaiMessages,
    stream: anthropicReq.stream ?? false,
  }

  // max_tokens → max_completion_tokens
  if (anthropicReq.max_tokens !== undefined) {
    body['max_completion_tokens'] = anthropicReq.max_tokens
  }

  // stop_sequences → stop
  if (anthropicReq.stop_sequences?.length) {
    body['stop'] = anthropicReq.stop_sequences
  }

  if (anthropicReq.temperature !== undefined) body['temperature'] = anthropicReq.temperature
  if (anthropicReq.top_p !== undefined) body['top_p'] = anthropicReq.top_p

  // tools 转换
  if (anthropicReq.tools?.length) {
    body['tools'] = anthropicReq.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema,
      },
    }))
  }

  // tool_choice 转换
  if (anthropicReq.tool_choice) {
    switch (anthropicReq.tool_choice.type) {
      case 'auto':
        body['tool_choice'] = 'auto'
        break
      case 'any':
        body['tool_choice'] = 'required'
        break
      case 'tool':
        if (anthropicReq.tool_choice.name) {
          body['tool_choice'] = { type: 'function', function: { name: anthropicReq.tool_choice.name } }
        } else {
          body['tool_choice'] = 'required'
        }
        break
      case 'none':
        body['tool_choice'] = 'none'
        break
    }
    if (anthropicReq.tool_choice.disable_parallel_tool_use) {
      body['parallel_tool_calls'] = false
    }
  }

  // thinking → reasoning_effort
  if (anthropicReq.thinking) {
    if (anthropicReq.thinking.type === 'disabled') {
      body['reasoning_effort'] = 'none'
    } else {
      body['reasoning_effort'] = 'high'
    }
  }

  return body
}

/**
 * 将 Anthropic user 消息转为 OpenAI 消息。
 * 如果包含 tool_result content block，返回数组：[...toolResults, userContent]，
 * 确保 tool 消息紧跟在 assistant tool_calls 之后（OpenAI 要求）。
 */
function anthropicUserToOpenAI(msg: AnthropicMessage): Record<string, unknown> | Record<string, unknown>[] {
  if (typeof msg.content === 'string') {
    return { role: 'user', content: msg.content }
  }

  // 分离 tool_result 和其他 content
  const toolResults: Record<string, unknown>[] = []
  const parts: Record<string, unknown>[] = []

  for (const block of msg.content) {
    if (block.type === 'tool_result') {
      const content = typeof block.content === 'string'
        ? block.content
        : (block.content || []).map((c: AnthropicContentBlock) => c.text || '').join('\n')
      toolResults.push({
        role: 'tool',
        tool_call_id: block.tool_use_id || '',
        content: content,
      })
    } else if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text || '' })
    } else if (block.type === 'image' && block.source) {
      const src = block.source
      let imageUrl: string
      if (src.type === 'url') imageUrl = src.url
      else imageUrl = `data:${src.media_type};base64,${src.data}`
      parts.push({ type: 'image_url', image_url: { url: imageUrl } })
    }
  }

  const userMsg: Record<string, unknown> = { role: 'user', content: parts.length === 1 && parts[0].type === 'text'
    ? parts[0].text
    : parts.length === 0
      ? ''
      : parts }

  // 如果有 tool_results，将它们放在 user 消息之前
  if (toolResults.length > 0) {
    return [...toolResults, userMsg]
  }
  return userMsg
}

function anthropicAssistantToOpenAI(msg: AnthropicMessage): Record<string, unknown> {
  if (typeof msg.content === 'string') {
    return { role: 'assistant', content: msg.content }
  }

  const openaiMsg: Record<string, unknown> = { role: 'assistant' }
  const textParts: string[] = []
  const toolCalls: Record<string, unknown>[] = []

  for (const block of msg.content) {
    if (block.type === 'text') {
      textParts.push(block.text || '')
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id || '',
        type: 'function',
        function: {
          name: block.name || '',
          arguments: JSON.stringify(block.input || {}),
        },
      })
    } else if (block.type === 'thinking') {
      // thinking 内容放入 reasoning_content 字段（如果有的话）
      // OpenAI 格式不支持 thinking，忽略
    }
  }

  if (textParts.length > 0) {
    openaiMsg['content'] = textParts.join('\n')
  } else if (toolCalls.length === 0) {
    openaiMsg['content'] = ''
  }

  if (toolCalls.length > 0) {
    openaiMsg['tool_calls'] = toolCalls
  }

  return openaiMsg
}

// ============================================================
//  Anthropic Messages ← OpenAI Chat Completions  响应转换
// ============================================================

interface OpenAIChunk {
  id: string
  object: string
  created: number
  model: string
  choices?: Array<{
    index: number
    delta?: {
      role?: string
      content?: string
      reasoning_content?: string
      reasoning?: string
      tool_calls?: Array<{
        index?: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    message?: {
      role?: string
      content?: string | null
      tool_calls?: Array<{
        index: number
        id: string
        type: string
        function: { name: string; arguments: string }
      }>
    }
    finish_reason?: string
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

// 非流式 OpenAI → Anthropic 转换
export function openAIToAnthropic(openaiResp: Record<string, unknown>, model: string): Record<string, unknown> {
  const id = (openaiResp['id'] as string) || `msg_${Date.now()}`
  const choices = openaiResp['choices'] as Array<Record<string, unknown>> | undefined
  const usage = openaiResp['usage'] as Record<string, number> | undefined

  const content: AnthropicContentBlock[] = []

  if (choices?.[0]) {
    const message = choices[0]['message'] as Record<string, unknown> | undefined
    if (message) {
      const text = message['content'] as string | undefined
      if (text) {
        content.push({ type: 'text', text })
      }

      const toolCalls = message['tool_calls'] as Array<Record<string, unknown>> | undefined
      if (toolCalls) {
        for (const tc of toolCalls) {
          const fn = tc['function'] as Record<string, unknown> | undefined
          content.push({
            type: 'tool_use',
            id: tc['id'] as string,
            name: fn?.['name'] as string,
            input: parseArgs(fn?.['arguments'] as string),
          })
        }
      }
    }

    const finishReason = choices[0]['finish_reason'] as string | undefined
    let stopReason: string | null = null
    if (finishReason === 'stop') stopReason = 'end_turn'
    else if (finishReason === 'tool_calls') stopReason = 'tool_use'
    else if (finishReason === 'length') stopReason = 'max_tokens'

    return {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: usage?.['prompt_tokens'] ?? 0,
        output_tokens: usage?.['completion_tokens'] ?? 0,
      },
    }
  }

  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: '' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  }
}

function parseArgs(args: string | undefined): Record<string, unknown> {
  if (!args) return {}
  try {
    return JSON.parse(args) as Record<string, unknown>
  } catch {
    return {}
  }
}

// ============================================================
//  Anthropic SSE 流式响应转换
// ============================================================

interface AnthropicSSEAccumulator {
  messageId: string
  model: string
  contentBlocks: Array<{
    type: string
    index: number
    /** OpenAI tool_call 的 index。多条工具调用时 arguments 增量必须按此匹配，不能依赖 currentBlockIndex */
    callIndex?: number
    text: string
    id?: string
    name?: string
    input: string  // 累积的 JSON arguments
    thinking?: string
    signature?: string
  }>
  currentBlockIndex: number
  stopReason: string | null
  inputTokens: number
  outputTokens: number
  /** message_stop 是否已发送（流结束兜底用，避免重复/遗漏） */
  messageStopSent: boolean
  /** 当前 content block 的 content_block_stop 是否已发送 */
  currentBlockClosed: boolean
}

export function createAnthropicSSEAccumulator(): AnthropicSSEAccumulator {
  return {
    messageId: '',
    model: '',
    contentBlocks: [],
    currentBlockIndex: -1,
    stopReason: null,
    inputTokens: 0,
    outputTokens: 0,
    messageStopSent: false,
    currentBlockClosed: true,
  }
}

/**
 * 将 events 数组（event/data 交替成对）格式化为 Anthropic SSE 字符串。
 * 每个 event+data 对内部用 \n 连接，事件对之间用 \n\n 分隔，整体以 \n\n 结尾。
 * 注意：不能用 events.join('\n') —— 多事件时会缺失事件间空行，
 * 客户端解析不到后续的 message_stop，报 "truncated: stream ended"。
 * file tool 的 tool_use 响应在 finish_reason 时会同时发 content_block_stop +
 * message_delta + message_stop 三个事件，必现此问题。
 */
function formatAnthropicSSE(events: string[]): string {
  if (events.length === 0) return ''
  const blocks: string[] = []
  for (let i = 0; i < events.length; i += 2) {
    blocks.push(events[i] + (events[i + 1] !== undefined ? '\n' + events[i + 1] : ''))
  }
  return blocks.join('\n\n') + '\n\n'
}

/**
 * 将一个 OpenAI SSE chunk 转换为零个或多个 Anthropic SSE 事件行。
 * 返回 Anthropic SSE 格式的字符串（多行）。
 * 第一个 chunk 会触发 message_start + content_block_start。
 */
export function openAIChunkToAnthropicSSE(
  chunk: OpenAIChunk,
  acc: AnthropicSSEAccumulator
): string {
  const events: string[] = []

  // 首次：发送 message_start
  if (!acc.messageId) {
    acc.messageId = chunk.id
    acc.model = chunk.model
    acc.inputTokens = chunk.usage?.prompt_tokens ?? 0
    acc.outputTokens = chunk.usage?.completion_tokens ?? 0

    events.push(`event: message_start`)
    events.push(`data: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: acc.messageId,
        type: 'message',
        role: 'assistant',
        model: acc.model,
        content: [],
        usage: { input_tokens: acc.inputTokens, output_tokens: acc.outputTokens },
      },
    })}`)
  }

  const choice = chunk.choices?.[0]
  if (!choice) return formatAnthropicSSE(events)

  const delta = choice.delta
  if (!delta) {
    // 没有 delta 但有 finish_reason？usage 可能在此
    if (choice.finish_reason && !acc.stopReason) {
      acc.stopReason = mapFinishReason(choice.finish_reason)
      if (chunk.usage) {
        acc.outputTokens = chunk.usage.completion_tokens ?? chunk.usage.total_tokens ?? acc.outputTokens
      }
      // 关闭当前未关闭的 content block（text 或 tool_use），
      // 否则客户端会因 content_block 缺少 stop 事件而报 "truncated: stream ended"
      if (!acc.currentBlockClosed) {
        closeCurrentBlock(acc, events)
      }
      events.push(`event: message_delta`)
      events.push(`data: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: acc.stopReason, stop_sequence: null },
        usage: { output_tokens: acc.outputTokens },
      })}`)
      events.push(`event: message_stop`)
      events.push(`data: ${JSON.stringify({ type: 'message_stop' })}`)
      acc.messageStopSent = true
    }
    return formatAnthropicSSE(events)
  }

  // 处理 reasoning delta（思考流 → Anthropic thinking block）。
  // 上游（如 opencode）思考阶段长时间只发 reasoning_content，若不转换，
  // 客户端会长时间收不到任何事件而触发 idle 超时，表现为"思考到一半停住"。
  if (delta.reasoning_content || delta.reasoning) {
    const reasoning = (delta.reasoning_content || delta.reasoning) as unknown
    if (typeof reasoning === 'string' && reasoning.length > 0) {
      if (acc.currentBlockIndex < 0 || acc.contentBlocks[acc.currentBlockIndex]?.type !== 'thinking') {
        // 关闭当前 text/tool_use 块，开启 thinking 块
        closeCurrentBlockForSwitch(acc, events)
        const blockIndex = acc.contentBlocks.length
        acc.contentBlocks.push({ type: 'thinking', index: blockIndex, text: '', input: '', thinking: '' })
        acc.currentBlockIndex = blockIndex
        events.push(`event: content_block_start`)
        events.push(`data: ${JSON.stringify({
          type: 'content_block_start',
          index: blockIndex,
          content_block: { type: 'thinking', thinking: '' },
        })}`)
        acc.currentBlockClosed = false
      }
      const thinkingBlock = acc.contentBlocks[acc.currentBlockIndex]
      thinkingBlock.thinking = (thinkingBlock.thinking || '') + reasoning
      events.push(`event: content_block_delta`)
      events.push(`data: ${JSON.stringify({
        type: 'content_block_delta',
        index: acc.currentBlockIndex,
        delta: { type: 'thinking_delta', thinking: reasoning },
      })}`)
    }
  }

  // 处理 text delta
  if (delta.content) {
    // 若当前是 thinking 块，先关闭再进入正文
    if (acc.currentBlockIndex >= 0 && acc.contentBlocks[acc.currentBlockIndex]?.type === 'thinking') {
      closeCurrentBlock(acc, events)
    }
    const isNewTextBlock = ensureTextBlock(acc)
    if (isNewTextBlock) {
      // 发送 content_block_start 事件
      events.push(`event: content_block_start`)
      events.push(`data: ${JSON.stringify({
        type: 'content_block_start',
        index: acc.currentBlockIndex,
        content_block: { type: 'text', text: '' },
      })}`)
      acc.currentBlockClosed = false
    }
    acc.contentBlocks[acc.currentBlockIndex].text += delta.content
    events.push(`event: content_block_delta`)
    events.push(`data: ${JSON.stringify({
      type: 'content_block_delta',
      index: acc.currentBlockIndex,
      delta: { type: 'text_delta', text: delta.content },
    })}`)
  }

  // 处理 tool_call delta
  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0

      // 按 tool_call 序号（tc.index）查找已存在的 tool_use 块。
      // 多条工具调用时增量会交错到达，绝不能依赖 currentBlockIndex（只指向最后创建的块），
      // 否则第一条工具调用的 arguments 会被追加到别的块上，导致 input JSON 残缺、
      // 客户端解析失败报 "truncated: stream ended"。
      let block = acc.contentBlocks.find((b) => b.type === 'tool_use' && b.callIndex === idx)

      if (!block && (tc.id || tc.function?.name)) {
        // 新的 tool call：先关闭当前 text/thinking 块
        closeCurrentBlockForSwitch(acc, events)

        const blockIndex = acc.contentBlocks.length
        block = {
          type: 'tool_use',
          index: blockIndex,
          callIndex: idx,
          text: '',
          id: tc.id || '',
          name: tc.function?.name || '',
          input: tc.function?.arguments || '',
        }
        acc.contentBlocks.push(block)
        acc.currentBlockIndex = blockIndex

        events.push(`event: content_block_start`)
        events.push(`data: ${JSON.stringify({
          type: 'content_block_start',
          index: blockIndex,
          content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
        })}`)
        acc.currentBlockClosed = false
      } else if (block) {
        // 已存在的块：补全 id/name，累积 arguments
        if (tc.id) block.id = tc.id
        if (tc.function?.name) block.name = tc.function.name
        if (tc.function?.arguments) {
          block.input += tc.function.arguments
          events.push(`event: content_block_delta`)
          events.push(`data: ${JSON.stringify({
            type: 'content_block_delta',
            index: block.index,
            delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
          })}`)
        }
      }
    }
  }

  // 处理 finish_reason
  if (choice.finish_reason && !acc.stopReason) {
    acc.stopReason = mapFinishReason(choice.finish_reason)
    if (chunk.usage) {
      acc.outputTokens = chunk.usage.completion_tokens ?? chunk.usage.total_tokens ?? acc.outputTokens
    }

    // 关闭当前未关闭的 content block（text 或 tool_use）
    if (!acc.currentBlockClosed) {
      closeCurrentBlock(acc, events)
    }

    events.push(`event: message_delta`)
    events.push(`data: ${JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: acc.stopReason, stop_sequence: null },
      usage: { output_tokens: acc.outputTokens },
    })}`)
    events.push(`event: message_stop`)
    events.push(`data: ${JSON.stringify({ type: 'message_stop' })}`)
    acc.messageStopSent = true
  }

  // Anthropic SSE: 每个 event+data 对用 \n 连接，事件对间用 \n\n 分隔（见 formatAnthropicSSE）
  return formatAnthropicSSE(events)
}

/** 确保当前 block 是 text 类型，若不是则创建新的。返回是否新建了 block。 */
function ensureTextBlock(acc: AnthropicSSEAccumulator): boolean {
  if (acc.currentBlockIndex < 0 || acc.contentBlocks[acc.currentBlockIndex]?.type !== 'text') {
    const blockIndex = acc.contentBlocks.length
    acc.contentBlocks.push({ type: 'text', index: blockIndex, text: '', input: '' })
    acc.currentBlockIndex = blockIndex
    return true
  }
  return false
}

/**
 * 切换 block 类型（text → tool_use / text ↔ thinking）前关闭当前打开的块。
 * 仅当块未关闭时发送 content_block_stop；块已关闭则跳过（幂等）。
 */
function closeCurrentBlockForSwitch(acc: AnthropicSSEAccumulator, events: string[]): void {
  if (acc.currentBlockIndex >= 0 && !acc.currentBlockClosed) {
    closeCurrentBlock(acc, events)
  }
}

/**
 * 关闭当前未关闭的 content block（text 或 tool_use）。
 * 对 tool_use 块会先尝试解析累积的 input JSON 为规范字符串。
 * 发送 content_block_stop 事件并标记 currentBlockClosed = true。
 */
function closeCurrentBlock(acc: AnthropicSSEAccumulator, events: string[]): void {
  if (acc.currentBlockIndex < 0 || acc.currentBlockIndex >= acc.contentBlocks.length) return
  const block = acc.contentBlocks[acc.currentBlockIndex]
  if (block.type === 'tool_use') {
    // 解析累积的 input JSON 为规范字符串（便于非流式聚合/调试）
    try {
      const parsed = JSON.parse(block.input)
      block.input = JSON.stringify(parsed)
    } catch { /* 保留原始字符串 */ }
  }
  events.push(`event: content_block_stop`)
  events.push(`data: ${JSON.stringify({ type: 'content_block_stop', index: acc.currentBlockIndex })}`)
  acc.currentBlockClosed = true
}

function mapFinishReason(fr: string): string {
  switch (fr) {
    case 'stop': return 'end_turn'
    case 'tool_calls': return 'tool_use'
    case 'length': return 'max_tokens'
    default: return 'end_turn'
  }
}

/**
 * 流结束兜底：检查并补发缺失的 content_block_stop 和 message_stop 事件。
 *
 * 适用场景：
 *   - 上游流提前结束（未发送 finish_reason，stopReason 为 null）
 *   - finish_reason 已收到但 content_block 未正常关闭（currentBlockClosed=false）
 *   - 任何导致 message_stop 未发送的边界情况
 *
 * 通过 messageStopSent / currentBlockClosed 标志保证幂等：
 * 已发送过的事件不会重复发送。返回 Anthropic SSE 字符串（可能为空）。
 * 调用方可根据返回值是否为空判断是否触发了兜底，据此记录诊断日志。
 */
export function finalizeAnthropicStream(acc: AnthropicSSEAccumulator): string {
  const events: string[] = []
  // 1. 关闭未关闭的 content block（text 或 tool_use）
  if (!acc.currentBlockClosed && acc.currentBlockIndex >= 0) {
    closeCurrentBlock(acc, events)
  }
  // 2. 发送未发送的 message_stop
  if (!acc.messageStopSent) {
    acc.stopReason = acc.stopReason || 'end_turn'
    events.push(`event: message_delta`)
    events.push(`data: ${JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: acc.stopReason, stop_sequence: null },
      usage: { output_tokens: acc.outputTokens },
    })}`)
    events.push(`event: message_stop`)
    events.push(`data: ${JSON.stringify({ type: 'message_stop' })}`)
    acc.messageStopSent = true
  }
  return events.length > 0 ? formatAnthropicSSE(events) : ''
}

/**
 * 返回累积器的诊断快照（用于日志），包含每个 content block 的类型/索引/名称/id
 * 以及流结束状态标志，便于定位是哪个 tool_use 调用触发了兜底。
 */
export function diagnoseAnthropicAccumulator(acc: AnthropicSSEAccumulator): Record<string, unknown> {
  return {
    stopReason: acc.stopReason,
    messageStopSent: acc.messageStopSent,
    currentBlockClosed: acc.currentBlockClosed,
    currentBlockIndex: acc.currentBlockIndex,
    contentBlocks: acc.contentBlocks.map(b => ({
      type: b.type,
      index: b.index,
      name: b.name,
      id: b.id,
      textLength: b.text?.length ?? 0,
      inputLength: b.input?.length ?? 0,
    })),
  }
}

/**
 * 聚合 OpenAI SSE 流为 Anthropic 非流式响应
 */
export function aggregateOpenAIToAnthropic(chunks: OpenAIChunk[]): Record<string, unknown> {
  let content = ''
  let reasoning = ''
  const toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = []
  const toolCallAccum: Map<number, { id: string; name: string; args: string }> = new Map()
  let finishReason = ''
  let model = ''
  let msgId = ''
  let inputTokens = 0
  let outputTokens = 0

  for (const chunk of chunks) {
    if (!msgId && chunk.id) msgId = chunk.id
    if (!model && chunk.model) model = chunk.model
    if (chunk.usage) {
      inputTokens = chunk.usage.prompt_tokens || inputTokens
      outputTokens = chunk.usage.completion_tokens || outputTokens
    }
    const choice = chunk.choices?.[0]
    if (!choice) continue
    if (choice.finish_reason) finishReason = choice.finish_reason

    const delta = choice.delta
    if (!delta) continue
    if (delta.content) content += delta.content
    if (delta.reasoning_content) reasoning += delta.reasoning_content
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0
        if (!toolCallAccum.has(idx)) {
          toolCallAccum.set(idx, { id: tc.id || '', name: tc.function?.name || '', args: '' })
        }
        const entry = toolCallAccum.get(idx)!
        if (tc.id) entry.id = tc.id
        if (tc.function?.name) entry.name = tc.function.name
        if (tc.function?.arguments) entry.args += tc.function.arguments
      }
    }
  }

  const contentBlocks: AnthropicContentBlock[] = []
  if (reasoning) {
    contentBlocks.push({ type: 'thinking', thinking: reasoning })
  }
  if (content) {
    contentBlocks.push({ type: 'text', text: content })
  }
  for (const [, entry] of toolCallAccum) {
    let input: Record<string, unknown> = {}
    try { input = JSON.parse(entry.args) } catch { /* keep empty */ }
    contentBlocks.push({ type: 'tool_use', id: entry.id, name: entry.name, input })
    toolCalls.push({ id: entry.id, name: entry.name, input })
  }

  return {
    id: msgId || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model,
    content: contentBlocks,
    stop_reason: mapFinishReason(finishReason || 'stop'),
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  }
}

/**
 * 聚合 OpenAI SSE chunks → Responses API 非流式响应
 */
export function aggregateOpenAIToResponses(chunks: OpenAIChunk[]): Record<string, unknown> {
  let content = ''
  const toolCallAccum: Map<number, { id: string; name: string; args: string }> = new Map()
  let model = ''
  let respId = ''
  let inputTokens = 0
  let outputTokens = 0

  for (const chunk of chunks) {
    if (!respId && chunk.id) respId = chunk.id
    if (!model && chunk.model) model = chunk.model
    if (chunk.usage) {
      inputTokens = chunk.usage.prompt_tokens || inputTokens
      outputTokens = chunk.usage.completion_tokens || outputTokens
    }
    const choice = chunk.choices?.[0]
    if (!choice) continue

    const delta = choice.delta
    if (!delta) continue
    if (delta.content) content += delta.content
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0
        if (!toolCallAccum.has(idx)) {
          toolCallAccum.set(idx, { id: tc.id || '', name: tc.function?.name || '', args: '' })
        }
        const entry = toolCallAccum.get(idx)!
        if (tc.id) entry.id = tc.id
        if (tc.function?.name) entry.name = tc.function.name
        if (tc.function?.arguments) entry.args += tc.function.arguments
      }
    }
  }

  const output: Record<string, unknown>[] = []
  if (content) {
    output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] })
  }
  for (const [, entry] of toolCallAccum) {
    output.push({
      type: 'function_call',
      id: entry.id,
      call_id: entry.id,
      name: entry.name,
      arguments: entry.args,
    })
  }

  return {
    id: respId || `resp_${Date.now()}`,
    object: 'response',
    model,
    output,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  }
}

/**
 * G5：把 Responses 的输出项整理成一条 OpenAI Chat 格式的 assistant 消息，
 * 用于存入 KV 多轮历史，供下一轮 previous_response_id 解析往返。
 */
export function responsesOutputToAssistantMessage(output: Array<Record<string, unknown>> | undefined): Record<string, unknown> {
  const contentParts: string[] = []
  const toolCalls: Array<Record<string, unknown>> = []
  for (const item of output || []) {
    const type = item['type']
    if (type === 'output_text' && typeof item['text'] === 'string') {
      contentParts.push(item['text'] as string)
    } else if (type === 'message' && Array.isArray(item['content'])) {
      for (const c of item['content'] as Array<Record<string, unknown>>) {
        if (c['type'] === 'output_text' && typeof c['text'] === 'string') contentParts.push(c['text'] as string)
      }
    } else if (type === 'function_call') {
      const args = item['arguments']
      toolCalls.push({
        id: (item['id'] as string) || '',
        type: 'function',
        function: {
          name: (item['name'] as string) || '',
          arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
        },
      })
    }
  }
  const msg: Record<string, unknown> = { role: 'assistant', content: contentParts.length > 0 ? contentParts.join('') : null }
  if (toolCalls.length > 0) msg['tool_calls'] = toolCalls
  return msg
}

// ============================================================
//  OpenAI Responses API ← Chat Completions  格式转换
// ============================================================

interface ResponsesRequest {
  model: string
  input: string | Array<{
    role?: string
    type?: string
    content?: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
    /** Codex 等客户端把工具声明放进 input 项的 additional_tools，而非顶层 tools */
    tools?: Array<{
      type: string
      name?: string
      description?: string
      parameters?: Record<string, unknown>
    }>
  }>
  instructions?: string
  tools?: Array<{
    type: string
    name?: string
    description?: string
    parameters?: Record<string, unknown>
  }>
  stream?: boolean
  max_output_tokens?: number
  temperature?: number
  top_p?: number
  tool_choice?: string | { type: string; function?: { name: string } }
  reasoning?: { effort?: string }
}

/**
 * OpenAI Responses → Chat Completions 请求转换
 */
export function responsesToOpenAI(responsesReq: ResponsesRequest): Record<string, unknown> {
  const messages: Record<string, unknown>[] = []
  // Codex 等客户端把工具声明放在 input 数组的 additional_tools 项里（而非顶层 tools），
  // 这里单独收集，末尾与顶层 tools 合并后统一注入（同原版 #71）。
  const additionalTools: Array<{ type: string; name?: string; description?: string; parameters?: Record<string, unknown> }> = []

  // instructions → system message
  if (responsesReq.instructions) {
    messages.push({ role: 'system', content: responsesReq.instructions })
  }

  // input → messages
  if (typeof responsesReq.input === 'string') {
    messages.push({ role: 'user', content: responsesReq.input })
  } else if (Array.isArray(responsesReq.input)) {
    for (const item of responsesReq.input) {
      // additional_tools：非消息项，提取其工具声明，不进入 messages
      if (item.type === 'additional_tools' && Array.isArray(item.tools)) {
        for (const t of item.tools) {
          // 过滤 Codex 内部工具（wait / request_user_input），仅保留可投递给上游的声明
          const name = t.name || ''
          if (name === 'wait' || name === 'request_user_input') continue
          additionalTools.push(t)
        }
        continue
      }
      if (typeof item.content === 'string') {
        messages.push({ role: item.role, content: item.content })
      } else if (Array.isArray(item.content)) {
        // multimodal content
        const parts = item.content.map((c) => {
          if (c.type === 'text') return { type: 'text', text: c.text }
          if (c.type === 'image_url') return { type: 'image_url', image_url: c.image_url }
          return c
        })
        messages.push({ role: item.role, content: parts })
      }
    }
  }

  const body: Record<string, unknown> = {
    model: responsesReq.model,
    messages,
    stream: responsesReq.stream ?? false,
  }

  if (responsesReq.max_output_tokens) body['max_completion_tokens'] = responsesReq.max_output_tokens
  if (responsesReq.temperature !== undefined) body['temperature'] = responsesReq.temperature
  if (responsesReq.top_p !== undefined) body['top_p'] = responsesReq.top_p

  // tools（合并顶层 tools 与 input 内 additional_tools 声明）
  const toolDecls = [
    ...(responsesReq.tools || []),
    ...additionalTools,
  ]
  if (toolDecls.length) {
    body['tools'] = toolDecls.map((t) => ({
      type: 'function',
      function: {
        name: t.name || t.type,
        description: t.description || '',
        parameters: t.parameters || { type: 'object', properties: {} },
      },
    }))
  }

  // tool_choice
  if (responsesReq.tool_choice) {
    if (typeof responsesReq.tool_choice === 'string') {
      body['tool_choice'] = responsesReq.tool_choice
    } else if (responsesReq.tool_choice.type === 'function' && responsesReq.tool_choice.function?.name) {
      body['tool_choice'] = { type: 'function', function: { name: responsesReq.tool_choice.function.name } }
    }
  }

  // reasoning
  if (responsesReq.reasoning?.effort) {
    body['reasoning_effort'] = responsesReq.reasoning.effort
  }

  return body
}

/**
 * Chat Completions 响应 → Responses API 非流式响应
 */
export function openAIToResponses(openaiResp: Record<string, unknown>): Record<string, unknown> {
  const id = (openaiResp['id'] as string) || `resp_${Date.now()}`
  const model = (openaiResp['model'] as string) || ''
  const usage = openaiResp['usage'] as Record<string, number> | undefined
  const choices = openaiResp['choices'] as Array<Record<string, unknown>> | undefined

  const output: Record<string, unknown>[] = []

  if (choices?.[0]) {
    const message = choices[0]['message'] as Record<string, unknown> | undefined
    if (message) {
      const text = message['content'] as string | undefined
      if (text) {
        output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
      }

      const toolCalls = message['tool_calls'] as Array<Record<string, unknown>> | undefined
      if (toolCalls) {
        for (const tc of toolCalls) {
          const fn = tc['function'] as Record<string, unknown> | undefined
          output.push({
            type: 'function_call',
            id: tc['id'],
            call_id: tc['id'],
            name: fn?.['name'],
            arguments: fn?.['arguments'] || '{}',
          })
        }
      }
    }
  }

  return {
    id,
    object: 'response',
    model,
    output,
    usage: usage ? {
      input_tokens: usage['prompt_tokens'] ?? 0,
      output_tokens: usage['completion_tokens'] ?? 0,
      total_tokens: usage['total_tokens'] ?? 0,
    } : null,
  }
}

/**
 * OpenAI SSE chunk → Responses API SSE 事件
 */
export function openAIChunkToResponsesSSE(
  chunk: OpenAIChunk,
  acc: {
    responseId: string
    model: string
    itemId: string | null
    textContent: string
    toolCalls: Map<number, { id: string; name: string; args: string }>
    inputTokens: number
    outputTokens: number
    hasStarted: boolean
    completed: boolean
    /** item8：推理内容（reasoning_content → reasoning_summary_text.delta）。可选，未提供则跳过。 */
    reasoningContent?: string
    reasoningItemId?: string | null
  }
): string {
  const events: string[] = []

  if (!acc.hasStarted) {
    acc.responseId = chunk.id
    acc.model = chunk.model
    acc.inputTokens = chunk.usage?.prompt_tokens ?? 0
    acc.hasStarted = true

    events.push(`event: response.created`)
    events.push(`data: ${JSON.stringify({
      type: 'response.created',
      response: {
        id: acc.responseId,
        object: 'response',
        model: acc.model,
        output: [],
        usage: null,
      },
    })}`)
  }

  const choice = chunk.choices?.[0]
  if (!choice) return formatAnthropicSSE(events)

  const delta = choice.delta
  if (!delta) {
    if (choice.finish_reason) {
      acc.completed = true
      events.push(`event: response.completed`)
      events.push(`data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          id: acc.responseId,
          object: 'response',
          model: acc.model,
          output: [],
          usage: chunk.usage ? {
            input_tokens: chunk.usage.prompt_tokens ?? acc.inputTokens,
            output_tokens: chunk.usage.completion_tokens ?? 0,
            total_tokens: chunk.usage.total_tokens ?? 0,
          } : null,
        },
      })}`)
    }
    return formatAnthropicSSE(events)
  }

  // item8：推理内容 delta → response.reasoning_summary_text.delta（含摘要结构），
  // 与 anthropic 的 thinking / 直连客户端的 reasoning 事件对齐（移植自 luawei1/cline2api responses.go）。
  if (delta.reasoning_content) {
    if (!acc.reasoningContent) {
      acc.reasoningContent = ''
      acc.reasoningItemId = acc.reasoningItemId || `reasoning_${Date.now()}`
      events.push(`event: response.output_item.added`)
      events.push(`data: ${JSON.stringify({
        type: 'response.output_item.added',
        output_index: acc.itemId ? 2 : 1,
        item: { id: acc.reasoningItemId, type: 'reasoning', summary: [], status: 'in_progress' },
      })}`)
      events.push(`event: response.reasoning_summary_part.added`)
      events.push(`data: ${JSON.stringify({
        type: 'response.reasoning_summary_part.added',
        item_id: acc.reasoningItemId,
        output_index: acc.itemId ? 2 : 1,
        summary_index: 0,
        part: { type: 'summary_text', text: '' },
      })}`)
    }
    acc.reasoningContent += delta.reasoning_content
    events.push(`event: response.reasoning_summary_text.delta`)
    events.push(`data: ${JSON.stringify({
      type: 'response.reasoning_summary_text.delta',
      item_id: acc.reasoningItemId,
      output_index: acc.itemId ? 2 : 1,
      summary_index: 0,
      delta: delta.reasoning_content,
    })}`)
  }

  // text delta
  if (delta.content) {
    if (!acc.itemId) {
      acc.itemId = `item_${Date.now()}`
      events.push(`event: response.output_item.added`)
      events.push(`data: ${JSON.stringify({
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: acc.itemId, type: 'message', role: 'assistant', content: [] },
      })}`)
      events.push(`event: response.content_part.added`)
      events.push(`data: ${JSON.stringify({
        type: 'response.content_part.added',
        item_id: acc.itemId,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '' },
      })}`)
    }
    acc.textContent += delta.content
    events.push(`event: response.output_text.delta`)
    events.push(`data: ${JSON.stringify({
      type: 'response.output_text.delta',
      item_id: acc.itemId,
      output_index: 0,
      content_index: 0,
      delta: delta.content,
    })}`)
  }

  // tool call delta
  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0
      if (tc.id && tc.function?.name) {
        acc.toolCalls.set(idx, { id: tc.id, name: tc.function.name, args: tc.function.arguments || '' })
        const callId = `fc_${tc.id}`
        events.push(`event: response.output_item.added`)
        events.push(`data: ${JSON.stringify({
          type: 'response.output_item.added',
          output_index: acc.toolCalls.size,
          item: { id: callId, type: 'function_call', call_id: tc.id, name: tc.function.name, arguments: '' },
        })}`)
      } else if (tc.function?.arguments) {
        const entry = acc.toolCalls.get(idx)
        if (entry) {
          entry.args += tc.function.arguments
          events.push(`event: response.function_call_arguments.delta`)
          events.push(`data: ${JSON.stringify({
            type: 'response.function_call_arguments.delta',
            item_id: `fc_${entry.id}`,
            output_index: idx,
            delta: tc.function.arguments,
          })}`)
        }
      }
    }
  }

  if (choice.finish_reason) {
    // 关闭 text item
    if (acc.itemId) {
      events.push(`event: response.output_text.done`)
      events.push(`data: ${JSON.stringify({
        type: 'response.output_text.done',
        item_id: acc.itemId,
        output_index: 0,
        content_index: 0,
        text: acc.textContent,
      })}`)
      events.push(`event: response.content_part.done`)
      events.push(`data: ${JSON.stringify({
        type: 'response.content_part.done',
        item_id: acc.itemId,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: acc.textContent },
      })}`)
      events.push(`event: response.output_item.done`)
      events.push(`data: ${JSON.stringify({
        type: 'response.output_item.done',
        output_index: 0,
        item: { id: acc.itemId, type: 'message', role: 'assistant', content: [] },
      })}`)
    }

    // 关闭 tool call items
    for (const [idx, entry] of acc.toolCalls) {
      events.push(`event: response.function_call_arguments.done`)
      events.push(`data: ${JSON.stringify({
        type: 'response.function_call_arguments.done',
        item_id: `fc_${entry.id}`,
        output_index: idx,
        arguments: entry.args,
      })}`)
      events.push(`event: response.output_item.done`)
      events.push(`data: ${JSON.stringify({
        type: 'response.output_item.done',
        output_index: idx + 1,
        item: {
          id: `fc_${entry.id}`,
          type: 'function_call',
          call_id: entry.id,
          name: entry.name,
          arguments: entry.args,
        },
      })}`)
    }

    acc.completed = true
    events.push(`event: response.completed`)
    events.push(`data: ${JSON.stringify({
      type: 'response.completed',
      response: {
        id: acc.responseId,
        object: 'response',
        model: acc.model,
        output: [],
        usage: chunk.usage ? {
          input_tokens: chunk.usage.prompt_tokens ?? acc.inputTokens,
          output_tokens: chunk.usage.completion_tokens ?? 0,
          total_tokens: chunk.usage.total_tokens ?? 0,
        } : null,
      },
    })}`)
  }

  // SSE: events separated by double newline
  return formatAnthropicSSE(events)
}

// ============================================================
//  OpenAI Chat Completions 请求 → Anthropic Messages 请求  反向转换
//  （用于 apiType=anthropic 的原生上游，如 api.anthropic.com）
// ============================================================

/** 把 OpenAI content（string | content 数组 | null/undefined）折叠为字符串 */
function openaiContentToString(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return (content as Array<Record<string, unknown>>)
      .map((c) => (c['type'] === 'text' ? (c['text'] as string) || '' : ''))
      .join('\n')
  }
  return ''
}

/** 解析 data:media_type;base64,xxx 形式的图片 data URL */
function parseAnthropicImageUrl(url: string): { media_type: string; data: string } | undefined {
  if (!url || !url.startsWith('data:')) return undefined
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url)
  if (!m) return undefined
  return { media_type: m[1], data: m[2] }
}

/** Anthropic stop_reason → OpenAI finish_reason 映射 */
function mapAnthropicStopReason(stopReason: string | undefined): string | null {
  switch (stopReason) {
    case 'end_turn': return 'stop'
    case 'stop_sequence': return 'stop'
    case 'max_tokens': return 'length'
    case 'tool_use': return 'tool_calls'
    case 'pause_turn': return 'stop'
    default: return stopReason || 'stop'
  }
}

/**
 * 将 OpenAI Chat Completions 请求转换为 Anthropic Messages 请求。
 * 这是 anthropicToOpenAI 的反向转换，供 apiType=anthropic 的原生上游使用：
 * 内部保持 OpenAI 规范格式（消息/工具/注入等中间件都作用于 OpenAI 形态），
 * 在出口处转回 Anthropic 发送给 api.anthropic.com。
 */
export function openAIRequestToAnthropic(openaiReq: Record<string, unknown>): Record<string, unknown> {
  const messages = (openaiReq['messages'] as Array<Record<string, unknown>>) || []
  const systemParts: string[] = []
  const anthropicMessages: Array<{ role: 'user' | 'assistant'; content: string | AnthropicContentBlock[] }> = []
  // 累积 role:'tool' 消息，合并进紧随其后的 user 消息（Anthropic 要求 tool_result 位于 user 消息内）
  let pendingToolResults: AnthropicContentBlock[] = []

  // 冲刷挂起的 tool_result：与紧随的用户内容合并为同一条 user 消息
  //（Anthropic 要求 tool_result 及其后的用户文本在同一条 user 消息内，
  //  拆成两条连续 user 消息会破坏多轮工具调用语义）。
  const flushUser = (content?: string | AnthropicContentBlock[]): void => {
    if (pendingToolResults.length === 0) {
      if (content !== undefined && (typeof content === 'string' ? content.length > 0 : content.length > 0)) {
        anthropicMessages.push({ role: 'user', content })
      }
      return
    }
    const merged: AnthropicContentBlock[] = [...pendingToolResults]
    pendingToolResults = []
    if (content !== undefined) {
      if (typeof content === 'string') {
        if (content) merged.push({ type: 'text', text: content })
      } else if (content.length > 0) {
        merged.push(...content)
      }
    }
    anthropicMessages.push({ role: 'user', content: merged })
  }

  for (const m of messages) {
    const role = m['role'] as string
    if (role === 'system') {
      const s = openaiContentToString(m['content'])
      if (s) systemParts.push(s)
      continue
    }
    if (role === 'tool') {
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: (m['tool_call_id'] as string) || '',
        content: openaiContentToString(m['content']),
      })
      continue
    }
    if (role === 'assistant') {
      flushUser()
      const content = m['content']
      const toolCalls = m['tool_calls'] as Array<Record<string, unknown>> | undefined
      const text = openaiContentToString(content)
      if (toolCalls && toolCalls.length > 0) {
        const blocks: AnthropicContentBlock[] = []
        if (text) blocks.push({ type: 'text', text })
        for (const tc of toolCalls) {
          const fn = (tc['function'] as Record<string, unknown>) || {}
          blocks.push({
            type: 'tool_use',
            id: (tc['id'] as string) || '',
            name: (fn['name'] as string) || '',
            input: parseArgs(fn['arguments'] as string | undefined),
          })
        }
        anthropicMessages.push({ role: 'assistant', content: blocks })
      } else {
        anthropicMessages.push({ role: 'assistant', content: text })
      }
      continue
    }
    // role === 'user'
    const content = m['content']
    if (typeof content === 'string') {
      flushUser(content)
    } else if (Array.isArray(content)) {
      const blocks: AnthropicContentBlock[] = []
      for (const part of content as Array<Record<string, unknown>>) {
        if (part['type'] === 'text') {
          blocks.push({ type: 'text', text: (part['text'] as string) || '' })
        } else if (part['type'] === 'image_url') {
          const url = ((part['image_url'] as Record<string, unknown>)?.['url'] as string) || ''
          const img = parseAnthropicImageUrl(url)
          if (img) blocks.push({ type: 'image', source: { type: 'base64', ...img } })
          else if (url.startsWith('http')) blocks.push({ type: 'image', source: { type: 'url', url } })
        }
      }
      flushUser(blocks)
    }
  }
  flushUser()

  const body: Record<string, unknown> = {
    model: openaiReq['model'],
    messages: anthropicMessages,
    stream: openaiReq['stream'] ?? false,
  }

  // G1: Anthropic 无原生 response_format，将 json_object/json_schema 约束注入 system 提示词
  const rf = openaiReq['response_format'] as Record<string, unknown> | undefined
  if (rf && (rf['type'] === 'json_object' || rf['type'] === 'json_schema')) {
    systemParts.push('You must respond with valid JSON.')
  }
  if (systemParts.length > 0) body['system'] = systemParts.join('\n\n')

  // max_tokens 必填（Anthropic）：取 max_tokens / max_completion_tokens，缺省给 4096
  const maxTokens = (openaiReq['max_tokens'] as number | undefined) ?? (openaiReq['max_completion_tokens'] as number | undefined)
  body['max_tokens'] = typeof maxTokens === 'number' && maxTokens > 0 ? maxTokens : 4096

  if (openaiReq['temperature'] !== undefined) body['temperature'] = openaiReq['temperature']
  if (openaiReq['top_p'] !== undefined) body['top_p'] = openaiReq['top_p']
  // G3a: stop 兼容字符串与数组（Anthropic 需要数组形态的 stop_sequences）
  const stopVal = openaiReq['stop']
  if (typeof stopVal === 'string' && stopVal) {
    body['stop_sequences'] = [stopVal]
  } else if (Array.isArray(stopVal) && (stopVal as unknown[]).length > 0) {
    body['stop_sequences'] = stopVal
  }

  // tools：OpenAI function → Anthropic {name, description, input_schema}
  if (Array.isArray(openaiReq['tools']) && (openaiReq['tools'] as unknown[]).length > 0) {
    body['tools'] = (openaiReq['tools'] as Array<Record<string, unknown>>).map((t) => {
      const fn = (t['function'] as Record<string, unknown>) || {}
      return {
        name: (fn['name'] as string) || (t['name'] as string) || '',
        description: (fn['description'] as string) || '',
        input_schema: (fn['parameters'] as object) || { type: 'object' },
      }
    })
  }

  // tool_choice：OpenAI auto/none/required/{type:function} → Anthropic auto/none/any/{type:tool}
  const tc = openaiReq['tool_choice']
  if (typeof tc === 'string') {
    if (tc === 'required') body['tool_choice'] = { type: 'any' }
    else if (tc === 'none') body['tool_choice'] = { type: 'none' }
    else body['tool_choice'] = { type: 'auto' }
  } else if (tc && typeof tc === 'object') {
    const t = tc as Record<string, unknown>
    const fnName = ((t['function'] as Record<string, unknown>)?.['name']) as string | undefined
    if ((t['type'] === 'function' || t['type'] === 'tool') && fnName) {
      body['tool_choice'] = { type: 'tool', name: fnName }
    } else if (t['type'] === 'required' || t['type'] === 'any') {
      body['tool_choice'] = { type: 'any' }
    } else {
      body['tool_choice'] = { type: 'auto' }
    }
  }

  // reasoning_effort → thinking（None/minimal → disabled；low/medium/high → enabled 带预算）
  // 档位归一化：除 OpenAI 标准 low/medium/high 外，识别客户端自定义"超高"档
  // （ultra/max/extreme/super 等）→ 更高预算，避免被降级为中等档；none/off/minimal → disabled。
  const re = openaiReq['reasoning_effort'] as string | undefined
  if (re) {
    const level = String(re).trim().toLowerCase()
    if (level === 'none' || level === 'off' || level === 'disabled' || level === 'minimal') {
      body['thinking'] = { type: 'disabled' }
    } else if (level === 'low') {
      body['thinking'] = { type: 'enabled', budget_tokens: 2048 }
    } else if (level === 'high') {
      body['thinking'] = { type: 'enabled', budget_tokens: 16384 }
    } else if (level === 'ultra' || level === 'max' || level === 'extreme' || level === 'super' || level === 'x') {
      body['thinking'] = { type: 'enabled', budget_tokens: 32768 }
    } else {
      // medium 及未识别值
      body['thinking'] = { type: 'enabled', budget_tokens: 8192 }
    }
  }

  // parallel_tool_calls=false → disable_parallel_tool_use
  if (openaiReq['parallel_tool_calls'] === false) body['disable_parallel_tool_use'] = true

  // G3b: user → metadata.user_id（Anthropic 可用 metadata 携带用户标识）
  if (typeof openaiReq['user'] === 'string' && openaiReq['user']) {
    body['metadata'] = { user_id: openaiReq['user'] }
  }

  return body
}

// ============================================================
//  Anthropic Messages 响应 → OpenAI Chat Completions 响应  反向转换
//  （apiType=anthropic 原生上游 + /v1/chat/completions 客户端）
// ============================================================

/** 非流式：Anthropic Messages 响应 → OpenAI chat.completion 响应 */
export function anthropicResponseToOpenAI(
  anthropicResp: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  const blocks = (anthropicResp['content'] as Array<Record<string, unknown>>) || []
  const text: string[] = []
  const toolCalls: Array<Record<string, unknown>> = []
  const reasoning: string[] = []
  for (const b of blocks) {
    if (b['type'] === 'text') text.push((b['text'] as string) || '')
    else if (b['type'] === 'tool_use') {
      toolCalls.push({
        id: (b['id'] as string) || '',
        type: 'function',
        function: { name: (b['name'] as string) || '', arguments: JSON.stringify(b['input'] ?? {}) },
      })
    } else if (b['type'] === 'thinking') {
      reasoning.push((b['thinking'] as string) || '')
    }
  }
  const message: Record<string, unknown> = { role: 'assistant' }
  if (text.length > 0) message['content'] = text.join('')
  if (reasoning.length > 0) message['reasoning_content'] = reasoning.join('')
  if (toolCalls.length > 0) message['tool_calls'] = toolCalls

  const u = anthropicResp['usage'] as Record<string, number> | undefined
  const inputTokens = u?.['input_tokens'] ?? 0
  const outputTokens = u?.['output_tokens'] ?? 0
  return {
    id: (anthropicResp['id'] as string) || `chatcmpl_${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || '',
    choices: [{
      index: 0,
      message,
      finish_reason: mapAnthropicStopReason(anthropicResp['stop_reason'] as string),
      logprobs: null,
    }],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      prompt_tokens_details: { cached_tokens: u?.['cache_read_input_tokens'] ?? 0 },
    },
  }
}

/** 非流式：Anthropic Messages 响应 → OpenAI Responses 响应 */
export function anthropicResponseToResponses(
  anthropicResp: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  const blocks = (anthropicResp['content'] as Array<Record<string, unknown>>) || []
  const output: Array<Record<string, unknown>> = []
  for (const b of blocks) {
    if (b['type'] === 'text') {
      output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: (b['text'] as string) || '' }] })
    } else if (b['type'] === 'tool_use') {
      const id = (b['id'] as string) || ''
      const args = JSON.stringify(b['input'] ?? {})
      output.push({ type: 'function_call', id, call_id: id, name: (b['name'] as string) || '', arguments: args })
    }
  }
  const u = anthropicResp['usage'] as Record<string, number> | undefined
  const inputTokens = u?.['input_tokens'] ?? 0
  const outputTokens = u?.['output_tokens'] ?? 0
  return {
    id: (anthropicResp['id'] as string) || `resp_${Date.now()}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: model || '',
    output,
    parallel_tool_calls: true,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      input_tokens_details: { cached_tokens: u?.['cache_read_input_tokens'] ?? 0 },
    },
  }
}

// ============================================================
//  Anthropic SSE → OpenAI SSE / Responses SSE  流式反向转换
//  （apiType=anthropic 原生上游 + 流式 chat/completions 或 responses 客户端）
//  用法：const conv = createAnthropicSSEToOpenAI(model)；对每条 SSE 记录
//  （eventName + data）调用 conv(eventName, data)，返回 OpenAI SSE 片段数组。
// ============================================================

export function createAnthropicSSEToOpenAI(modelHint: string, options?: { includeUsage?: boolean }) {
  const state = {
    messageId: `chatcmpl_${Math.random().toString(36).slice(2, 12)}`,
    model: modelHint,
    created: Math.floor(Date.now() / 1000),
    inputTokens: 0,
    outputTokens: 0,
    toolOrdinal: 0,
    blockToTool: new Map<number, number>(),
    // message_delta 可能多次出现（usage 更新也会触发），finish_reason 只输出一次
    finished: false,
  }
  const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null, usage?: Record<string, unknown>): string =>
    `data: ${JSON.stringify({
      id: state.messageId,
      object: 'chat.completion.chunk',
      created: state.created,
      model: state.model,
      choices: [{ index: 0, delta, logprobs: null, finish_reason }],
      ...(usage ? { usage } : {}),
    })}\n\n`

  return (eventName: string, data: Record<string, unknown>): string[] => {
    const out: string[] = []
    switch (eventName) {
      case 'message_start': {
        const m = data['message'] as Record<string, unknown> | undefined
        if (m?.['id']) state.messageId = `chatcmpl_${String(m['id']).replace(/^msg_/, '')}`
        if (m?.['model']) state.model = String(m['model'])
        const mu = m?.['usage'] as Record<string, number> | undefined
        if (mu) { state.inputTokens = mu['input_tokens'] || 0; state.outputTokens = mu['output_tokens'] || 0 }
        out.push(chunk({ role: 'assistant', content: '' }))
        break
      }
      case 'content_block_start': {
        const cb = data['content_block'] as Record<string, unknown> | undefined
        if (cb?.['type'] === 'tool_use') {
          const idx = state.toolOrdinal++
          const blockIndex = data['index'] as number
          if (typeof blockIndex === 'number') state.blockToTool.set(blockIndex, idx)
          out.push(chunk({
            tool_calls: [{ index: idx, id: (cb['id'] as string) || '', type: 'function', function: { name: (cb['name'] as string) || '', arguments: '' } }],
          }))
        }
        break
      }
      case 'content_block_delta': {
        const d = data['delta'] as Record<string, unknown> | undefined
        if (d?.['type'] === 'text_delta' && d['text']) {
          out.push(chunk({ content: d['text'] }))
        } else if (d?.['type'] === 'thinking_delta' && d['thinking']) {
          out.push(chunk({ reasoning_content: d['thinking'] }))
        } else if (d?.['type'] === 'input_json_delta' && d['partial_json']) {
          const idx = state.blockToTool.get(data['index'] as number) ?? 0
          // G4: 工具参数按 512 字符分片输出，避免超大单帧撑爆客户端单帧缓冲
          const argStr = String(d['partial_json'])
          for (let off = 0; off < argStr.length; off += 512) {
            out.push(chunk({ tool_calls: [{ index: idx, function: { arguments: argStr.slice(off, off + 512) } }] }))
          }
        }
        break
      }
      case 'message_delta': {
        if (state.finished) break
        const dd = data['delta'] as Record<string, unknown> | undefined
        state.outputTokens = ((data['usage'] as Record<string, number> | undefined)?.['output_tokens']) ?? state.outputTokens
        state.finished = true
        // G2: stream_options.include_usage=false 时，结束分片不再携带 usage（默认 true 保持原有行为）
        const use = (options?.includeUsage ?? true)
          ? { prompt_tokens: state.inputTokens, completion_tokens: state.outputTokens, total_tokens: state.inputTokens + state.outputTokens }
          : undefined
        out.push(chunk({}, mapAnthropicStopReason(dd?.['stop_reason'] as string), use))
        break
      }
      case 'message_stop': {
        out.push('data: [DONE]\n\n')
        break
      }
      default:
        break
    }
    return out
  }
}

export function createAnthropicSSEToResponses(modelHint: string, opts?: { onCompleted?: (info: { responseId: string; textContent: string; toolCalls: Array<{ id: string; name: string; args: string }> }) => void }) {
  const state = {
    responseId: `resp_${Math.random().toString(36).slice(2, 12)}`,
    model: modelHint,
    created: Math.floor(Date.now() / 1000),
    inputTokens: 0,
    outputTokens: 0,
    textContent: '',
    itemId: '',
    functionCallId: '',
    functionCallName: '',
    toolArgs: new Map<number, string>(),
    // 每个 tool 的 id/name（多条 tool_use 时避免全局变量被最后一个覆盖）
    toolMeta: new Map<number, { id: string; name: string }>(),
    blockToTool: new Map<number, number>(),
    toolOrdinal: 0,
    textItemDone: false,
    toolItemDone: new Set<number>(),
    // message_delta 可能多次出现（usage 更新也会触发），response.completed 只输出一次
    completedSent: false,
  }
  const ss = (event: string, data: Record<string, unknown>): string =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

  return (eventName: string, data: Record<string, unknown>): string[] => {
    const out: string[] = []
    switch (eventName) {
      case 'message_start': {
        const m = data['message'] as Record<string, unknown> | undefined
        if (m?.['id']) state.responseId = `resp_${String(m['id']).replace(/^msg_/, '')}`
        if (m?.['model']) state.model = String(m['model'])
        const mu = m?.['usage'] as Record<string, number> | undefined
        if (mu) { state.inputTokens = mu['input_tokens'] || 0; state.outputTokens = mu['output_tokens'] || 0 }
        const base = { id: state.responseId, object: 'response', created_at: state.created, status: 'in_progress', model: state.model, output: [], parallel_tool_calls: true, usage: null }
        out.push(ss('response.created', { type: 'response.created', response: base }))
        out.push(ss('response.in_progress', { type: 'response.in_progress', response: base }))
        break
      }
      case 'content_block_start': {
        const cb = data['content_block'] as Record<string, unknown> | undefined
        if (cb?.['type'] === 'text') {
          state.itemId = `msg_${Math.random().toString(36).slice(2, 10)}`
          out.push(ss('response.output_item.added', {
            type: 'response.output_item.added',
            output_index: 0,
            item: { id: state.itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] },
          }))
          out.push(ss('response.content_part.added', {
            type: 'response.content_part.added',
            item_id: state.itemId,
            output_index: 0,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          }))
        } else if (cb?.['type'] === 'tool_use') {
          const idx = state.toolOrdinal++
          const blockIndex = data['index'] as number
          if (typeof blockIndex === 'number') state.blockToTool.set(blockIndex, idx)
          const id = `fc_${(cb['id'] as string) || Math.random().toString(36).slice(2, 10)}`
          state.functionCallId = id
          state.functionCallName = (cb['name'] as string) || ''
          state.toolMeta.set(idx, { id, name: state.functionCallName })
          state.toolArgs.set(idx, '')
          out.push(ss('response.output_item.added', {
            type: 'response.output_item.added',
            output_index: idx + 1,
            item: { id, type: 'function_call', status: 'in_progress', call_id: id, name: state.functionCallName, arguments: '' },
          }))
        }
        break
      }
      case 'content_block_delta': {
        const d = data['delta'] as Record<string, unknown> | undefined
        if (d?.['type'] === 'text_delta' && d['text']) {
          state.textContent += d['text']
          out.push(ss('response.output_text.delta', {
            type: 'response.output_text.delta',
            item_id: state.itemId,
            output_index: 0,
            content_index: 0,
            delta: d['text'],
          }))
        } else if (d?.['type'] === 'input_json_delta' && d['partial_json']) {
          const idx = state.blockToTool.get(data['index'] as number) ?? 0
          state.toolArgs.set(idx, (state.toolArgs.get(idx) || '') + (d['partial_json'] as string))
          const meta = state.toolMeta.get(idx) || { id: state.functionCallId, name: state.functionCallName }
          out.push(ss('response.function_call_arguments.delta', {
            type: 'response.function_call_arguments.delta',
            item_id: meta.id,
            output_index: idx + 1,
            delta: d['partial_json'],
          }))
        }
        break
      }
      case 'message_delta': {
        if (state.completedSent) break
        state.completedSent = true
        state.outputTokens = ((data['usage'] as Record<string, number> | undefined)?.['output_tokens']) ?? state.outputTokens
        const output: Array<Record<string, unknown>> = []
        if (state.textContent) {
          output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: state.textContent }] })
        }
        for (const [idx, args] of state.toolArgs) {
          const meta = state.toolMeta.get(idx) || { id: `fc_${Math.random().toString(36).slice(2, 10)}`, name: state.functionCallName }
          output.push({ type: 'function_call', id: meta.id, call_id: meta.id, name: meta.name, arguments: args })
        }
        // G5：让代理层在流结束时拿到最终 assistant 结果，用于保存多轮记忆
        if (opts?.onCompleted) {
          try {
            const toolCalls: Array<{ id: string; name: string; args: string }> = []
            for (const [idx, args] of state.toolArgs) {
              const meta = state.toolMeta.get(idx) || { id: state.functionCallId, name: state.functionCallName }
              toolCalls.push({ id: meta.id, name: meta.name, args })
            }
            opts.onCompleted({ responseId: state.responseId, textContent: state.textContent, toolCalls })
          } catch { /* onCompleted 失败不影响响应 */ }
        }
        out.push(ss('response.completed', {
          type: 'response.completed',
          response: {
            id: state.responseId,
            object: 'response',
            created_at: state.created,
            status: 'completed',
            model: state.model,
            output,
            parallel_tool_calls: true,
            usage: {
              input_tokens: state.inputTokens,
              output_tokens: state.outputTokens,
              total_tokens: state.inputTokens + state.outputTokens,
            },
          },
        }))
        break
      }
      default:
        break
    }
    return out
  }
}
