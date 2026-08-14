/**
 * M365 Session Durable Object。
 *
 * 职责：
 * 1. 串行化同一会话的并发请求（ChatHub 不支持同一 conversation 并发）
 * 2. 承载 ChatHub WS 对话（事件流 → OpenAI SSE / JSON）
 * 3. 会话绑定读写在 KV（复用 session.ts），DO 作为执行隔离点
 *
 * Worker 入口：`env.M365_SESSION.get(sessionKey).fetch(chatRequest)`
 * 其中 sessionKey = providerId + ':' + explicitSessionId | contextFingerprint
 */
import type { Env } from '../types'
import { chatWithHandlers } from './chathub'
import type { ChatHubAccount, ChatHubTool } from './chathub'
import { extractToolCalls, flattenPromptMessages } from './tools'
import type { DetectedToolCall } from './tools'
import { resolveSession, bindSession } from './session'
import { getM365Account } from './oauth'

export interface M365ChatPayload {
  providerId: string
  model: string
  /** OpenAI chat body（messages/tools/tool_choice/stream 等） */
  body: Record<string, unknown>
  stream: boolean
  explicitSessionId?: string
  user?: string
  ip?: string
  userAgent?: string
}

interface ChatOutcome {
  text: string
  reasoning: string
  conversationId: string
  sessionId: string
  toolCalls: DetectedToolCall[]
}

function sha256Hex(s: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < s.length; i++) {
    h1 = (h1 ^ s.charCodeAt(i)) >>> 0
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 = (h2 ^ s.charCodeAt(i)) >>> 0
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')
}

/** 估算 token 数（同原版 EstimateTokens：英文按 4 字符，中文按 1.5 字符） */
export function estimateTokens(s: string): number {
  if (!s) return 0
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length
  const other = s.length - cjk
  return Math.ceil(cjk / 1.5) + Math.ceil(other / 4)
}

export class M365Session {
  env: Env
  /** 会话串行队列：同一 DO 实例的请求逐个执行 */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(ctx: DurableObjectState, env: Env) {
    this.env = env
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => {})
    return run
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/chat' && request.method === 'POST') {
      let payload: M365ChatPayload
      try {
        payload = (await request.json()) as M365ChatPayload
      } catch {
        return cjson({ error: { message: 'bad json', type: 'invalid_request_error' } }, 400)
      }
      return this.enqueue(() => this.handleChat(payload))
    }
    return cjson({ error: { message: 'not found', type: 'not_found' } }, 404)
  }

  private async handleChat(payload: M365ChatPayload): Promise<Response> {
    const { providerId, model, body, stream, explicitSessionId, user, ip, userAgent } = payload
    const messages = (body['messages'] as Array<Record<string, unknown>>) || []
    const tools = (body['tools'] as unknown[]) || []
    const toolChoice = body['tool_choice']

    // 1) 账号 token（KV 中该 provider 的 OAuth token；过期自动刷新）
    const account = await getM365Account(this.env, providerId)
    if (!account || !account.accessToken) {
      return cjson({ error: { message: 'M365 账号未授权或 token 失效，请在管理后台重新授权', type: 'auth_error' } }, 401)
    }
    const acc: ChatHubAccount = { accessToken: account.accessToken, oid: account.oid, tid: account.tid }

    // 2) 会话解析（显式 ID / 内容键）
    const ctx = { explicitSessionId, user, ip, userAgent }
    const resolved = await resolveSession(this.env, providerId, messages as never[], ctx)

    // 3) 构建 ChatHub 请求：messages 扁平化为单文本 prompt；复用命中只发增量
    const { prompt, attachments } = flattenPromptMessages(messages as never[])
    let answerPrompt = prompt
    if (!resolved.isNew && resolved.historyLen > 0 && resolved.historyLen < messages.length) {
      const inc = flattenPromptMessages(messages.slice(resolved.historyLen) as never[])
      if (inc.prompt.trim() !== '') {
        answerPrompt = inc.prompt
        attachments.length = 0
        attachments.push(...inc.attachments)
      }
    }

    const toolDefs: ChatHubTool[] = tools.map((t) => {
      const obj = t as Record<string, unknown>
      const f = (obj['function'] || {}) as Record<string, unknown>
      return { type: typeof obj['type'] === 'string' ? obj['type'] : 'function', function: { name: String(f['name'] || ''), description: typeof f['description'] === 'string' ? f['description'] : undefined, parameters: f['parameters'] } }
    })

    // 4) 执行 ChatHub 对话（事件流 → 组装）
    let streamedText = ''
    let reasoning = ''
    const result = await chatWithHandlers(
      acc,
      {
        text: answerPrompt,
        conversationId: resolved.isNew ? undefined : resolved.conversationId,
        sessionId: resolved.isNew ? undefined : resolved.sessionId,
        started: resolved.isNew,
        attachments,
        tools: toolDefs,
        toolChoice,
      },
      { timeoutMs: 300_000 },
      (delta) => { streamedText += delta },
      (ev) => { if (ev.kind === 'reasoning') reasoning += ev.text || '' },
    )
    streamedText = streamedText || result.text

    const outcome: ChatOutcome = {
      text: result.text,
      reasoning: result.reasoning || reasoning,
      conversationId: result.conversationId,
      sessionId: result.sessionId,
      toolCalls: extractToolCalls(result.text, toolDefs, toolChoice),
    }

    // 5) 绑定会话（记录全量历史 + 助手回复）
    await bindSession(this.env, providerId, outcome.sessionId, outcome.conversationId, providerId, messages as never[], outcome.text + (outcome.reasoning ? '\n<reasoning>\n' + outcome.reasoning + '\n</reasoning>' : ''), ctx)

    const id = 'chatcmpl-' + crypto.randomUUID()
    if (stream) {
      return buildSSE(id, model, outcome, payload)
    }
    return buildJSON(id, model, outcome)
  }
}

function cjson(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

function buildJSON(id: string, model: string, o: ChatOutcome): Response {
  const pt = estimateTokens(o.text) + (o.reasoning ? estimateTokens(o.reasoning) : 0)
  const ct = pt
  const msg: Record<string, unknown> = { role: 'assistant', content: o.text }
  if (o.reasoning) msg['reasoning_content'] = o.reasoning
  let finish: string = 'stop'
  if (o.toolCalls.length > 0) {
    msg['tool_calls'] = o.toolCalls.map((tc) => ({ id: tc.id, type: tc.type, function: { name: tc.name, arguments: tc.arguments } }))
    finish = 'tool_calls'
  }
  return cjson({
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: msg, finish_reason: finish }],
    usage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct, m365_conversation: o.conversationId },
  }, 200)
}

function buildSSE(id: string, model: string, o: ChatOutcome, payload: M365ChatPayload): Response {
  const encoder = new TextEncoder()
  const created = Math.floor(Date.now() / 1000)
  const pt = estimateTokens(o.text) + (o.reasoning ? estimateTokens(o.reasoning) : 0)
  const ct = pt
  const chunks: Uint8Array[] = []

  const base = (delta: Record<string, unknown>, finish: unknown, extra: Record<string, unknown> = {}): string => {
    const chunk: Record<string, unknown> = {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    }
    for (const [k, v] of Object.entries(extra)) chunk[k] = v
    return 'data: ' + JSON.stringify(chunk) + '\n\n'
  }
  const push = (s: string) => chunks.push(encoder.encode(s))

  const first: Record<string, unknown> = { role: 'assistant', content: '' }
  if (o.reasoning) first['reasoning_content'] = o.reasoning
  push(base(first, null))

  if (o.toolCalls.length > 0) {
    // 工具块外的前置文本
    if (o.text.trim() !== '') push(base({ content: o.text }, null))
    o.toolCalls.forEach((tc, i) => {
      push(base({ tool_calls: [{ index: i, id: tc.id, type: tc.type, function: { name: tc.name, arguments: tc.arguments } }] }, null))
    })
    const usageChunk = {
      id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct, m365_conversation: o.conversationId },
    }
    push('data: ' + JSON.stringify(usageChunk) + '\n\n')
  } else if (o.reasoning) {
    // 推理先行，正文逐字流式
    push(base({ reasoning_content: o.reasoning }, null))
    push(base({ content: o.text }, null))
    const usageChunk = {
      id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct, m365_conversation: o.conversationId },
    }
    push('data: ' + JSON.stringify(usageChunk) + '\n\n')
  } else {
    push(base({ content: o.text }, null))
    const usageChunk = {
      id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct, m365_conversation: o.conversationId },
    }
    push('data: ' + JSON.stringify(usageChunk) + '\n\n')
  }
  push('data: [DONE]\n\n')

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c)
      controller.close()
    },
  })
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' } })
}

/** 计算会话路由键（DO instance 分片） */
export function sessionKey(providerId: string, explicitSessionId: string | undefined, messages: Array<Record<string, unknown>> | undefined): string {
  if (explicitSessionId) return `${providerId}:ex:${explicitSessionId}`
  if (messages && messages.length > 0) {
    const parts: string[] = []
    const limit = Math.min(messages.length, 3)
    for (let i = messages.length - limit; i < messages.length; i++) {
      const m = messages[i]
      parts.push(`${m['role']}:${typeof m['content'] === 'string' ? String(m['content']).substring(0, 200) : JSON.stringify(m['content'] || '')}`)
    }
    return `${providerId}:ctx:${sha256Hex(parts.join('||'))}`
  }
  return `${providerId}:ex:${crypto.randomUUID()}`
}