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
  source?: { type: string; media_type: string; data: string }
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
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
      })
    }
  }

  const userMsg: Record<string, unknown> = { role: 'user', content: parts.length === 1 && parts[0].type === 'text'
    ? parts[0].text
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
  }
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
  if (!choice) return events.join('\n')

  const delta = choice.delta
  if (!delta) {
    // 没有 delta 但有 finish_reason？usage 可能在此
    if (choice.finish_reason && !acc.stopReason) {
      acc.stopReason = mapFinishReason(choice.finish_reason)
      if (chunk.usage) {
        acc.outputTokens = chunk.usage.completion_tokens ?? chunk.usage.total_tokens ?? acc.outputTokens
      }
      events.push(`event: message_delta`)
      events.push(`data: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: acc.stopReason, stop_sequence: null },
        usage: { output_tokens: acc.outputTokens },
      })}`)
      events.push(`event: message_stop`)
      events.push(`data: ${JSON.stringify({ type: 'message_stop' })}`)
    }
    return events.join('\n')
  }

  // 处理 text delta
  if (delta.content) {
    const isNewTextBlock = ensureTextBlock(acc)
    if (isNewTextBlock) {
      // 发送 content_block_start 事件
      events.push(`event: content_block_start`)
      events.push(`data: ${JSON.stringify({
        type: 'content_block_start',
        index: acc.currentBlockIndex,
        content_block: { type: 'text', text: '' },
      })}`)
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

      // 新的 tool call
      if (tc.id && tc.function?.name) {
        // 如果之前是 text block，先关闭
        closeCurrentTextBlock(acc, events)

        const blockIndex = acc.contentBlocks.length
        acc.contentBlocks.push({
          type: 'tool_use',
          index: blockIndex,
          text: '',
          id: tc.id,
          name: tc.function.name,
          input: tc.function.arguments || '',
        })
        acc.currentBlockIndex = blockIndex

        events.push(`event: content_block_start`)
        events.push(`data: ${JSON.stringify({
          type: 'content_block_start',
          index: blockIndex,
          content_block: { type: 'tool_use', id: tc.id, name: tc.function.name, input: {} },
        })}`)
      } else if (tc.function?.arguments) {
        // 累积 arguments
        const block = acc.contentBlocks[acc.currentBlockIndex]
        if (block && block.type === 'tool_use') {
          block.input += tc.function.arguments
          events.push(`event: content_block_delta`)
          events.push(`data: ${JSON.stringify({
            type: 'content_block_delta',
            index: acc.currentBlockIndex,
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

    // 关闭当前 content block
    if (acc.currentBlockIndex >= 0 && acc.currentBlockIndex < acc.contentBlocks.length) {
      const block = acc.contentBlocks[acc.currentBlockIndex]
      if (block.type === 'tool_use') {
        // 解析累积的 input JSON
        try {
          const parsed = JSON.parse(block.input)
          block.input = JSON.stringify(parsed)
        } catch { /* 保留原始字符串 */ }
      }
      events.push(`event: content_block_stop`)
      events.push(`data: ${JSON.stringify({ type: 'content_block_stop', index: acc.currentBlockIndex })}`)
    }

    events.push(`event: message_delta`)
    events.push(`data: ${JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: acc.stopReason, stop_sequence: null },
      usage: { output_tokens: acc.outputTokens },
    })}`)
    events.push(`event: message_stop`)
    events.push(`data: ${JSON.stringify({ type: 'message_stop' })}`)
  }

  // Anthropic SSE: events separated by double newline, terminated with double newline
  return events.length > 0 ? events.join('\n') + '\n\n' : ''
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

function closeCurrentTextBlock(acc: AnthropicSSEAccumulator, events: string[]): void {
  if (acc.currentBlockIndex >= 0 && acc.contentBlocks[acc.currentBlockIndex]?.type === 'text') {
    events.push(`event: content_block_stop`)
    events.push(`data: ${JSON.stringify({ type: 'content_block_stop', index: acc.currentBlockIndex })}`)
  }
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
 * 聚合 OpenAI SSE 流为 Anthropic 非流式响应
 */
export function aggregateOpenAIToAnthropic(chunks: OpenAIChunk[]): Record<string, unknown> {
  let content = ''
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

// ============================================================
//  OpenAI Responses API ← Chat Completions  格式转换
// ============================================================

interface ResponsesRequest {
  model: string
  input: string | Array<{ role: string; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> }>
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

  // instructions → system message
  if (responsesReq.instructions) {
    messages.push({ role: 'system', content: responsesReq.instructions })
  }

  // input → messages
  if (typeof responsesReq.input === 'string') {
    messages.push({ role: 'user', content: responsesReq.input })
  } else if (Array.isArray(responsesReq.input)) {
    for (const item of responsesReq.input) {
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

  // tools
  if (responsesReq.tools?.length) {
    body['tools'] = responsesReq.tools.map((t) => ({
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
  if (!choice) return events.join('\n')

  const delta = choice.delta
  if (!delta) {
    if (choice.finish_reason) {
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
    return events.join('\n')
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
  return events.length > 0 ? events.join('\n') + '\n\n' : ''
}
