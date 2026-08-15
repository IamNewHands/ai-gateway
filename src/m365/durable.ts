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
import type { ChatHubAccount, ChatHubTool, ChatHubResult } from './chathub'
import { flattenPromptMessages, modelToolRouterPrompt, parseModelToolDecision, fencedToolCalls, nativeToolCalls, compactToolResult, buildAgentLedger, ledgerRouterContext, filterCompletedCalls, completionEvidenceAllows, isToolRefusal } from './tools'
import type { DetectedToolCall, AgentLedger, OaiMsgLite } from './tools'
import { resolveSession, bindSession } from './session'
import { getM365Account } from './oauth'
import { writeLog } from '../admin'

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

    // 多轮工具证据 ledger：从 messages 历史解析已完成/待处理的工具调用，去重并注入上下文
    const ledger: AgentLedger = buildAgentLedger(messages as OaiMsgLite[])
    const ledgerCtx = ledger.toolRounds > 0 ? ledgerRouterContext(ledger) : ''

    // 4) 工具路由：带 tools 且 toolChoice != none 时，先发起一次独立的路由对话，
    //    注入完整工具定义 + ledger 证据让模型显式决策是否调用工具（同原版 planningMode="router"）。
    //    路由对话是临时会话（started=true，不绑定持久会话）。
    const choiceStr = String(toolChoice ?? 'auto').toLowerCase()
    if (toolDefs.length > 0 && choiceStr !== 'none') {
      const route = await this.tryToolRouter(acc, answerPrompt, toolDefs, toolChoice, attachments, ledgerCtx)
      if (route && route.calls.length > 0) {
        // 有工具调用：直接返回 tool_calls 给客户端（客户端执行后再续聊）
        const outcome: ChatOutcome = {
          text: '',
          reasoning: route.res.reasoning || '',
          conversationId: route.res.conversationId,
          sessionId: route.res.sessionId,
          toolCalls: route.calls,
        }
        const id = 'chatcmpl-' + crypto.randomUUID()
        return stream ? buildSSE(id, model, outcome, payload) : buildJSON(id, model, outcome)
      }
      if (route && route.requiredFailed) {
        const detail = `model=${model} tools=${toolDefs.length} promptLen=${answerPrompt.length}`
        try { await writeLog(this.env, 'error', `[m365-chat] provider=${providerId} → model did not select a required tool`, detail) } catch { /* ignore */ }
        return cjson({ error: { message: 'model did not select a required tool after constrained retry', type: 'tool_required' } }, 502)
      }
    }

    // 5) 执行主回答对话（持久会话）
    //    多轮时在主回答注入 ledger 证据 + 最终回答规则，避免模型虚构未经验证的操作
    let mainPrompt = answerPrompt
    if (ledger.completed.length > 0 || ledger.pending.length > 0) mainPrompt += '\n' + ledgerCtx
    if (ledger.completed.length > 0) mainPrompt += '\nFINAL ANSWER RULE: Report only actions supported by completed tool results. If the goal is not fully verified, state exactly what remains unconfirmed.'

    let streamedText = ''
    let reasoning = ''
    let result: Awaited<ReturnType<typeof chatWithHandlers>>
    try {
      result = await chatWithHandlers(
        acc,
        {
          text: mainPrompt,
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
    } catch (err) {
      // 记录完整 ChatHub 错误（含微软服务端返回的 detail）便于排查真实对话 500
      const msg = err instanceof Error ? err.message : String(err)
      const detail =
        `model=${model} isNew=${resolved.isNew} tools=${toolDefs.length} ` +
        `promptLen=${mainPrompt.length} stream=${stream} historyLen=${resolved.historyLen} ` +
        `err=${msg}`
      try { await writeLog(this.env, 'error', `[m365-chat] provider=${providerId} → ${msg}`, detail) } catch { /* ignore */ }
      // 上游限流：返回 429 + Retry-After（同原版 upstreamStatus / writeUpstreamError），
      // 让客户端退避重试，而不是报 500/502 误导为服务端内部错误。
      if (msg.includes('upstream rate-limit notice')) {
        return cjson({ error: { message: 'upstream is rate limiting; try again shortly', type: 'rate_limit_error' } }, 429, { 'Retry-After': '60' })
      }
      return cjson({ error: { message: msg, type: 'internal_error' } }, 500)
    }
    streamedText = streamedText || result.text

    // 主回答兜底 1：模型错误拒绝使用工具时，发起纠正对话重试（同原版 isToolRefusal）
    if (toolDefs.length > 0 && isToolRefusal(result.text || streamedText)) {
      const correction =
        'Your previous response incorrectly denied that caller tools are available. They are real, active, and callable on the caller\'s Windows machine. Call the appropriate tool now. Do not explain tool availability.\n\nUser request:\n' + mainPrompt
      try {
        const corrRes = await chatWithHandlers(acc, { text: correction, conversationId: resolved.isNew ? undefined : resolved.conversationId, sessionId: resolved.isNew ? undefined : resolved.sessionId, started: resolved.isNew, attachments }, { timeoutMs: 300_000 })
        if (!isToolRefusal(corrRes.text)) {
          result = { ...corrRes, events: result.events }
          streamedText = corrRes.text
        }
      } catch { /* keep original result */ }
    }

    // 主回答兜底 2：提取工具调用。先 fenced block（<m365-tool-call> / ```name\n{json}```），再原生工具事件；用 ledger 过滤已完成调用
    const rawCalls: DetectedToolCall[] =
      fencedToolCalls(result.text || streamedText, toolDefs, toolChoice)
    const allCalls = rawCalls.length > 0 ? rawCalls : nativeToolCalls(result.events, toolDefs)
    const calls = filterCompletedCalls(allCalls, ledger)

    let finalText = result.text
    // 兜底 3：若存在工具证据但回答声称"已完成"，且无匹配工具结果，则替换为未确认措辞
    if (toolDefs.length > 0 && !completionEvidenceAllows(finalText, ledger)) {
      finalText = 'I cannot confirm completion because no matching tool results were returned. No external action has been verified.'
    }

    const outcome: ChatOutcome = {
      text: finalText,
      reasoning: result.reasoning || reasoning,
      conversationId: result.conversationId,
      sessionId: result.sessionId,
      toolCalls: calls,
    }

    // 6) 绑定会话（记录全量历史 + 助手回复）
    await bindSession(this.env, providerId, outcome.sessionId, outcome.conversationId, providerId, messages as never[], outcome.text + (outcome.reasoning ? '\n<reasoning>\n' + outcome.reasoning + '\n</reasoning>' : ''), ctx)

    const id = 'chatcmpl-' + crypto.randomUUID()
    if (stream) {
      return buildSSE(id, model, outcome, payload)
    }
    return buildJSON(id, model, outcome)
  }

  /**
   * 工具路由对话：注入完整工具定义 + ledger 证据让模型决策是否调用工具。
   * 返回 { calls, res, requiredFailed }；无工具调用或未带 tools 时返回 null（走主回答）。
   * 路由对话使用独立临时会话（started=true），不绑定持久会话，避免污染多轮上下文。
   */
  private async tryToolRouter(
    acc: ChatHubAccount,
    prompt: string,
    toolDefs: ChatHubTool[],
    toolChoice: unknown,
    attachments: { type: 'image'; url: string }[],
    ledgerCtx: string,
  ): Promise<{ calls: DetectedToolCall[]; res: ChatHubResult; requiredFailed?: boolean } | null> {
    if (toolDefs.length === 0) return null
    const choiceStr = String(toolChoice ?? 'auto').toLowerCase()
    if (choiceStr === 'none') return null

    const opts = { timeoutMs: 300_000 }
    const routePrompt = modelToolRouterPrompt(prompt + (ledgerCtx ? '\n' + ledgerCtx : ''), toolDefs, toolChoice)
    // 路由对话是"决策是否调用工具"的辅助轮：上游限流/异常时优雅降级（返回 null 走主回答），
    // 不应让一次可选的决策对话因限流而阻断整个请求（同原版 failover 对路由阶段限流不致命）。
    let routeRes: Awaited<ReturnType<typeof chatWithHandlers>>
    try {
      routeRes = await chatWithHandlers(acc, { text: routePrompt, started: true, attachments }, opts)
    } catch {
      return null
    }
    let { calls, parsed } = parseModelToolDecision(routeRes.text, toolDefs, toolChoice)
    if (!parsed) {
      // 修复对话：让模型输出纯 JSON envelope
      const repairPrompt =
        'Repair this tool routing output into JSON only with shape {"calls":[{"name":"function_name","arguments":{}}]}. ' +
        'Do not invent calls; use {"calls":[]} if unrecoverable. OUTPUT:\n' +
        compactToolResult(routeRes.text, 6000)
      try {
        const repairRes = await chatWithHandlers(acc, { text: repairPrompt, started: true, attachments }, opts)
        const r2 = parseModelToolDecision(repairRes.text, toolDefs, toolChoice)
        if (r2.parsed) {
          calls = r2.calls
          return { calls, res: repairRes }
        }
      } catch { /* fall through */ }
      // 解析失败：非 required 时降级走主回答；required 时视为选择失败
      if (choiceStr !== 'required') return null
      return { calls: [], res: routeRes, requiredFailed: true }
    }
    // tool_choice='required' 时必须调用工具：路由判定无调用时强制重试（注入完整工具定义）
    if (calls.length === 0 && choiceStr === 'required') {
      const retryPrompt =
        'Select at least one required next tool call from FUNCTION_DEFINITIONS. Validate every argument against its schema. ' +
        'Return JSON only as {"calls":[{"name":"function_name","arguments":{}}]}.\n' +
        'APPLICATION_REQUEST_AND_EVIDENCE:\n' + prompt + (ledgerCtx ? '\n' + ledgerCtx : '') + '\nFUNCTION_DEFINITIONS:\n' + JSON.stringify(toolDefs)
      try {
        const retryRes = await chatWithHandlers(acc, { text: retryPrompt, started: true, attachments }, opts)
        const r3 = parseModelToolDecision(retryRes.text, toolDefs, toolChoice)
        if (r3.parsed && r3.calls.length > 0) return { calls: r3.calls, res: retryRes }
      } catch { /* fall through */ }
      return { calls: [], res: routeRes, requiredFailed: true }
    }
    if (calls.length === 0) return null
    return { calls, res: routeRes }
  }
}

function cjson(data: unknown, status: number, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...extraHeaders } })
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