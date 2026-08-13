/**
 * proxy.ts — CNB（cnb.cool）上游转发（移植自 lwjlwjlwjlwj/cnb2api，MIT）。
 *
 * 核心链路：
 *   1. GET https://cnb.cool/ 首页 → 提取 Set-Cookie 里的 csrfkey（32hex）+
 *      页面内嵌 window.csrftoken（40hex），二者配对使用（免登录、免费）。
 *   2. POST /ai/chat/completions 带 iCsrftoken 头 + csrfkey Cookie + Origin/Referer，
 *      上游强制 stream:true，返回 OpenAI 格式 SSE（delta.content + reasoning_content）。
 *   3. 凭证缓存：内存 + KV（TTL 30min），401/403 含 csrf 关键字自动换证重试（最多 3 次）。
 *
 * 工具桥（provider.toolBridge）：上游禁原生 tools（403 Agent calls not allowed），
 * 开启后把客户端 tools 转成 XYML 提示词注入（见 ./xyml.ts），模型文本流经 ToolSieve
 * 流式解析回标准 tool_calls 返回客户端。
 */

import type { Env, Provider } from '../types'
import { streamFetchWithTimeout } from '../opencode'
import {
  buildToolInstructions,
  renderToolCall,
  openAIToolCalls,
  randomId,
  ToolSieve,
} from './xyml'

export const CNB_BASE_URL = 'https://cnb.cool'
export const CNB_CHAT_PATH = '/ai/chat/completions'

export const CNB_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro']

const CNB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const CSRF_TTL_MS = 30 * 60 * 1000
const CSRF_MAX_ERR = 3

/** 是否是 CNB 提供商（id 固定或用 cnb.cool 域） */
export function isCnbProvider(provider: Provider): boolean {
  return Boolean(provider.id === 'cnb' || (provider.baseUrl && provider.baseUrl.includes('cnb.cool')))
}

// ===== CSRF 凭证 =====

interface CnbCsrf {
  key: string
  token: string
  created: number
  errCnt: number
}

const csrfMem = new Map<string, CnbCsrf>()

const kvKey = (providerId: string) => `cnb:csrf:${providerId}`

function validCsrf(cs: CnbCsrf | null | undefined): cs is CnbCsrf {
  return Boolean(cs && cs.key && cs.token && Date.now() - cs.created < CSRF_TTL_MS && (cs.errCnt || 0) < CSRF_MAX_ERR)
}

/** 用全新会话访问首页，提取 csrfkey(cookie) + csrftoken(html) 配对。 */
async function fetchCsrfFresh(): Promise<CnbCsrf> {
  const resp = await streamFetchWithTimeout(CNB_BASE_URL + '/', {
    method: 'GET',
    headers: {
      'User-Agent': CNB_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  })
  if (!resp.ok || !resp.body) {
    throw new Error(`cnb: fetch home failed (${resp.status})`)
  }
  const html = await resp.text()
  const tokenMatch = html.match(/window\.csrftoken="([0-9a-f]{32,64})"/)
  if (!tokenMatch) throw new Error('cnb: invalid csrf token — csrftoken not found in home page')
  const setCookie = resp.headers.get('set-cookie') || ''
  const keyMatch = setCookie.match(/(?:^|;)\s*csrfkey=([0-9a-f]{32,64})/i)
  if (!keyMatch) throw new Error('cnb: invalid csrf token — csrfkey cookie not found')
  return { key: keyMatch[1], token: tokenMatch[1], created: Date.now(), errCnt: 0 }
}

async function getCsrf(env: Env, providerId: string): Promise<CnbCsrf> {
  const mem = csrfMem.get(providerId)
  if (validCsrf(mem)) return mem
  try {
    const raw = await env.KV.get(kvKey(providerId))
    if (raw) {
      const cached = JSON.parse(raw) as CnbCsrf
      if (validCsrf(cached)) {
        csrfMem.set(providerId, cached)
        return cached
      }
    }
  } catch { /* corrupt cache: refetch */ }
  const fresh = await fetchCsrfFresh()
  csrfMem.set(providerId, fresh)
  try {
    await env.KV.put(kvKey(providerId), JSON.stringify(fresh), { expirationTtl: Math.floor(CSRF_TTL_MS / 1000) })
  } catch { /* KV 不可用时内存兜底 */ }
  return fresh
}

async function invalidateCsrf(env: Env, providerId: string): Promise<void> {
  csrfMem.delete(providerId)
  try { await env.KV.delete(kvKey(providerId)) } catch { /* ignore */ }
}

function bumpCsrfErr(cs: CnbCsrf): void {
  cs.errCnt = (cs.errCnt || 0) + 1
}

/** 判定 401/403 响应体是否 CSRF 校验失败（区别于业务拒绝，如 Agent calls not allowed）。 */
function isCsrfErrorBody(body: string): boolean {
  const lower = body.toLowerCase()
  return lower.includes('csrf') ||
    lower.includes('blocked by csrf') ||
    lower.includes('csrf 校验失败')
}

// ===== 请求体构造 =====

interface CnbMessage {
  role: string
  content: string
}

interface UpstreamBodyInput {
  model?: string
  messages?: Array<Record<string, unknown>>
  stream?: boolean
  temperature?: unknown
  top_p?: unknown
  enable_thinking?: unknown
  presence_penalty?: unknown
}

function stripModelPrefix(model: string): string {
  const i = model.indexOf('/')
  return i > 0 ? model.slice(i + 1) : model
}

/** content 兼容 string / 数组（text / thinking / toolCall / toolResult / image_url 忽略） */
function extractChatContent(content: unknown): string {
  if (content === null || content === undefined) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const p = part as Record<string, unknown>
      switch (p.type) {
        case 'text':
          if (typeof p.text === 'string' && p.text) parts.push(p.text)
          break
        case 'thinking':
          if (typeof p.thinking === 'string' && p.thinking) parts.push(p.thinking)
          break
        case 'toolCall': {
          const args = p.arguments !== undefined ? jsonSafe(p.arguments) : ''
          parts.push(`(assistant called tool ${p.name} with args ${args})`)
          break
        }
        default:
          if (typeof p.text === 'string' && p.text) parts.push(p.text)
      }
    }
    return parts.join('')
  }
  return String(content)
}

function jsonSafe(value: unknown): string {
  try { return JSON.stringify(value) } catch { return String(value ?? '') }
}

/**
 * 消息转换：OpenAI 标准消息（含 tool_calls / tool 角色）→ CNB 可接受的 user/assistant 文本序列。
 * bridge=true 时：assistant 的 tool_calls 渲染成 XYML 文本、tool 结果转 [Tool Result id=...]。
 */
function convertMessages(
  rawMessages: unknown,
  bridge: boolean,
): CnbMessage[] {
  const msgs = Array.isArray(rawMessages) ? rawMessages : []
  const converted: CnbMessage[] = []
  const appendUser = (content: string) => {
    const last = converted[converted.length - 1]
    if (last && last.role === 'user') {
      if (last.content !== '') last.content += '\n\n'
      last.content += content
    } else {
      converted.push({ role: 'user', content })
    }
  }
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue
    const msg = m as Record<string, unknown>
    const content = extractChatContent(msg.content)
    let role = String(msg.role || 'user')
    // 过滤失败的 assistant 占位
    if (role === 'assistant' && (content.includes('[assistant turn failed') || content.includes('turn failed before producing'))) {
      continue
    }
    // toolResult（OpenClaw 自定义角色）→ user
    if (role === 'toolResult') {
      appendUser('[工具执行结果] ' + (content || '(tool result)'))
      continue
    }
    // tool 角色 → user（携带 id 信息）
    if (role === 'tool') {
      const toolCallId = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : ''
      const name = typeof msg.name === 'string' ? msg.name : ''
      if (bridge) {
        const header = `[Tool Result id=${toolCallId || 'unknown'}${name ? ` name=${name}` : ''}]`
        appendUser(`${header}\n${content || '(tool result)'}`)
      } else {
        appendUser('[工具执行结果] ' + (content || '(tool result)'))
      }
      continue
    }
    // assistant 带 tool_calls：bridge 渲染 XYML，否则转说明文本
    if (role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      const blocks: string[] = []
      if (content.trim()) blocks.push(content)
      if (bridge) {
        for (const call of msg.tool_calls) {
          if (call && typeof call === 'object') {
            const fn = (call as Record<string, unknown>).function
            if (fn && typeof fn === 'object') {
              const fnObj = fn as Record<string, unknown>
              blocks.push(renderToolCall(fnObj.name, fnObj.arguments && typeof fnObj.arguments === 'string' ? safeParse(fnObj.arguments) : fnObj.arguments))
            }
          }
        }
      } else {
        for (const call of msg.tool_calls) {
          if (call && typeof call === 'object') {
            const fn = (call as Record<string, unknown>).function as Record<string, unknown> | undefined
            if (fn && typeof fn.name === 'string') {
              blocks.push(`(assistant called tool ${fn.name} with args ${typeof fn.arguments === 'string' ? fn.arguments : jsonSafe(fn.arguments)})`)
            }
          }
        }
      }
      converted.push({ role: 'assistant', content: blocks.join('\n') })
      continue
    }
    if (role === 'assistant' && content === '') role = 'assistant'
    if (role === 'user') {
      appendUser(content)
      continue
    }
    converted.push({ role, content })
  }
  // 清理空 user 消息与尾部空 user
  const cleaned: CnbMessage[] = []
  for (let i = 0; i < converted.length; i++) {
    const c = converted[i]
    if (c.role === 'user' && c.content === '') continue
    cleaned.push(c)
  }
  while (cleaned.length && cleaned[cleaned.length - 1].role === 'user' && cleaned[cleaned.length - 1].content === '') {
    cleaned.pop()
  }
  return cleaned
}

function safeParse(value: string): unknown {
  try { return JSON.parse(value) } catch { return value }
}

function buildUpstreamBody(input: UpstreamBodyInput, messages: CnbMessage[], tools: unknown, bridge: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: stripModelPrefix(String(input.model || CNB_MODELS[0])),
    stream: true, // 上游强制流式
    messages,
    // 强制 maxTokens 避免长上下文被截断（deepseek-v4 默认支持 65k 输出）
    maxTokens: 60000,
  }
  for (const key of ['temperature', 'top_p', 'enable_thinking', 'presence_penalty'] as const) {
    if (input[key] !== undefined && input[key] !== null) body[key] = input[key]
  }
  // 工具桥：注入 XYML 提示词、剥掉原生 tools（上游禁止）
  if (bridge && Array.isArray(tools) && tools.length) {
    let messages2 = messages
    const instructions = buildToolInstructions(tools)
    if (messages2.length && messages2[0].role === 'system') {
      messages2 = [
        { role: 'system', content: (messages2[0].content || '').trim() + '\n\n' + instructions },
        ...messages2.slice(1),
      ]
    } else {
      messages2 = [{ role: 'system', content: instructions }, ...messages2]
    }
    body.messages = messages2
  }
  return body
}

// ===== 上游请求 =====

async function chatOnce(
  env: Env,
  provider: Provider,
  upBody: Record<string, unknown>,
): Promise<Response> {
  const csrf = await getCsrf(env, provider.id)
  const resp = await streamFetchWithTimeout(CNB_BASE_URL + CNB_CHAT_PATH, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream, application/json, text/plain, */*',
      'User-Agent': CNB_UA,
      'Origin': CNB_BASE_URL,
      'Referer': CNB_BASE_URL + '/',
      'Csrftoken': csrf.token,
      'Cookie': `csrfkey=${csrf.key}`,
    },
    body: JSON.stringify(upBody),
  })
  // 凭证失效（401/403 且响应体含 csrf）：标记重试由调用方处理
  if (resp.status === 401 || resp.status === 403) {
    const text = await resp.clone().text()
    if (isCsrfErrorBody(text)) {
      bumpCsrfErr(csrf)
      // 内存缓存更新（KV 由 invalidate 删除）
      csrfMem.set(provider.id, csrf)
      throw new CnbCsrfError(resp.status, text.slice(0, 500))
    }
  }
  return resp
}

class CnbCsrfError extends Error {
  status: number
  constructor(status: number, detail: string) {
    super(`cnb: csrf rejected (${status}): ${detail}`)
    this.status = status
  }
}

export async function proxyCnbChatRequest(
  env: Env,
  provider: Provider,
  clientBody: Record<string, unknown>,
): Promise<Response> {
  const bridge = provider.toolBridge === true
  const tools = Array.isArray(clientBody.tools) ? clientBody.tools : []
  const messages = convertMessages(clientBody.messages, bridge)
  const upBody = buildUpstreamBody(clientBody as UpstreamBodyInput, messages, tools, bridge)
  const isStream = clientBody.stream === true

  let lastResp: Response | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await chatOnce(env, provider, upBody)
      lastResp = resp
      if (!resp.ok) return resp // 非 2xx（业务拒绝等）原样透传
      if (isStream) return buildStreamResponse(resp, { bridge, tools })
      return await buildNonStreamResponse(resp, { bridge, tools })
    } catch (err) {
      if (err instanceof CnbCsrfError && attempt < 2) {
        await invalidateCsrf(env, provider.id)
        continue
      }
      if (lastResp && !lastResp.ok) return lastResp
      throw err
    }
  }
  if (lastResp && !lastResp.ok) return lastResp
  throw new Error('cnb: chat failed after retries')
}

// ===== 流式响应 =====

interface BridgeOptions {
  bridge: boolean
  tools: unknown[]
}

/** 读上游 SSE 流，逐 chunk 回调解码后的对象；done=true 表示 [DONE]。 */
async function readUpstreamSSE(
  body: ReadableStream<Uint8Array> | null,
  onChunk: (obj: UpstreamChunk | null, done: boolean) => Promise<void> | void,
): Promise<void> {
  if (!body) return
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') {
          await onChunk(null, true)
          return
        }
        if (payload === '' ) continue
        try {
          const obj = JSON.parse(payload) as UpstreamChunk
          await onChunk(obj, false)
        } catch { /* 单块解析失败跳过 */ }
      }
    }
    // 上游 EOF（未发 [DONE]，部分上游以关流代替）：先消化 buf 里未换行的尾部残余，
    // 再触发收尾让 buildStreamResponse 正确 flush 并补发 finish/[DONE]，
    // 避免尾部 chunk 丢失、客户端拿到无 finish 的裸 EOF 而误判为截断/异常。
    if (buf.trim()) {
      const payload = buf.trim()
      if (payload !== '[DONE]' && payload.startsWith('{')) {
        try {
          const obj = JSON.parse(payload) as UpstreamChunk
          await onChunk(obj, false)
        } catch { /* ignore */ }
      }
    }
    await onChunk(null, true)
  } finally {
    try { await reader.cancel() } catch { /* ignore */ }
  }
}

interface UpstreamChunk {
  id?: string
  model?: string
  created?: number
  usage?: unknown
  choices?: Array<{
    delta?: { content?: string; reasoning_content?: string; tool_calls?: unknown[] }
    finish_reason?: string | null
  }>
}

function stdChunk(id: string, model: string, created: number, delta: Record<string, unknown>, finishReason: string | null): string {
  return 'data: ' + JSON.stringify({
    id, model, created, object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }) + '\n\n'
}

function buildStreamResponse(upstream: Response, opts: BridgeOptions): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()
  const encoder = new TextEncoder()
  let stdID = '', stdModel = CNB_MODELS[0], stdCreated = Math.floor(Date.now() / 1000), stdUsage: unknown = null
  let finished = false
  let emittedToolCalls = false
  // bridge 模式下始终启用 ToolSieve：即使当前请求未携带 tools（多轮对话时客户端可能只在首轮传 tools，
  // 但历史仍让模型按 XYML 输出），也要拦截并剥离原始 XYML 标记，避免泄漏给客户端。
  const sieve = opts.bridge ? new ToolSieve(opts.tools) : null
  let toolIdx = 0

  const write = (s: string) => writer.write(encoder.encode(s))
  const done = (): Promise<void> => writer.close()
  const fail = (e: unknown): Promise<void> => writer.abort(e)

  // 把解析出的每个工具调用切成增量 tool_calls 块（名称 → 参数）
  const emitToolCallDeltas = (calls: Array<Record<string, unknown>>): void => {
    emittedToolCalls = true
    for (const call of calls) {
      const idx = toolIdx++
      const fn = (call.function && typeof call.function === 'object')
        ? call.function as Record<string, unknown>
        : {}
      const id = String(call.id || `call_${idx}`)
      const name = String(fn.name || '')
      const args = String(fn.arguments || '')
      // 名称增量块
      write(stdChunk(stdID || randomId(), stdModel, stdCreated, {
        tool_calls: [{ index: idx, id, type: 'function', function: { name, arguments: '' } }],
      }, null))
      // 参数增量块（可为空参数对象）
      write(stdChunk(stdID || randomId(), stdModel, stdCreated, {
        tool_calls: [{ index: idx, function: { arguments: args } }],
      }, null))
    }
  }

  ;(async () => {
    try {
      await readUpstreamSSE(upstream.body, (obj, isDone) => {
        if (finished) return
        if (isDone) {
          finished = true
          // 收尾：先 flush sieve 剩余内容 / 工具调用，再写 finish chunk + [DONE]
          if (sieve) {
            for (const ev of sieve.flush()) {
              if (ev.type === 'tool_calls' && ev.calls) emitToolCallDeltas(openAIToolCalls(ev.calls))
              else if (ev.text) write(stdChunk(stdID || randomId(), stdModel, stdCreated, { content: ev.text }, null))
            }
          }
          const final: Record<string, unknown> = {
            id: stdID || randomId(), model: stdModel, created: stdCreated,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: {}, finish_reason: emittedToolCalls ? 'tool_calls' : 'stop' }],
          }
          if (stdUsage) final['usage'] = stdUsage
          write('data: ' + JSON.stringify(final) + '\n\n')
          write('data: [DONE]\n\n')
          return
        }
        if (!obj) return
        if (obj.id) stdID = obj.id
        if (obj.model) stdModel = obj.model
        if (obj.created) stdCreated = obj.created
        if (obj.usage) stdUsage = obj.usage
        const choices = obj.choices || []
        for (const choice of choices) {
          const delta = choice.delta || {}
          const content = delta.content || ''
          const reasoning = delta.reasoning_content || ''
          // 推理内容与正文分开透传（bridge 模式 reasoning 不进 sieve，避免误判工具标记）
          if (reasoning) write(stdChunk(stdID, stdModel, stdCreated, { reasoning_content: reasoning }, null))
          if (content) {
            if (sieve) {
              for (const ev of sieve.processChunk(content)) {
                if (ev.type === 'tool_calls' && ev.calls) emitToolCallDeltas(openAIToolCalls(ev.calls))
                else if (ev.text) write(stdChunk(stdID, stdModel, stdCreated, { content: ev.text }, null))
              }
            } else {
              write(stdChunk(stdID, stdModel, stdCreated, { content }, null))
            }
          }
        }
      })
    } catch (e) {
      await fail(e)
      return
    }
    await done()
  })()

  return new Response(readable, {
    status: upstream.status === 200 ? 200 : upstream.status,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  })
}

/** 非流式：聚合上游 SSE 为单次 chat.completion JSON（上游强制流式，客户端 stream=false 时用）。 */
async function buildNonStreamResponse(upstream: Response, opts: BridgeOptions): Promise<Response> {
  let content = ''
  let reasoning = ''
  let stdID = '', stdModel = '', stdCreated = Math.floor(Date.now() / 1000)
  let stdUsage: unknown = null
  let finish = 'stop'
  // bridge 模式下始终启用 ToolSieve（理由同 buildStreamResponse：避免无 tools 请求时 XYML 泄漏）
  const sieve = opts.bridge ? new ToolSieve(opts.tools) : null
  const toolCalls: Array<Record<string, unknown>> = []

  await readUpstreamSSE(upstream.body, (obj, isDone) => {
    if (isDone || !obj) return
    if (obj.id) stdID = obj.id
    if (obj.model) stdModel = obj.model
    if (obj.created) stdCreated = obj.created
    if (obj.usage) stdUsage = obj.usage
    for (const choice of obj.choices || []) {
      const delta = choice.delta || {}
      if (delta.reasoning_content) reasoning += delta.reasoning_content
      const c = delta.content || ''
      if (c) {
        if (sieve) {
          for (const ev of sieve.processChunk(c)) {
            if (ev.type === 'tool_calls' && ev.calls) toolCalls.push(...openAIToolCalls(ev.calls))
            else if (ev.text) content += ev.text
          }
        } else {
          content += c
        }
      }
      if (choice.finish_reason) finish = choice.finish_reason
    }
  })
  if (sieve) {
    for (const ev of sieve.flush()) {
      if (ev.type === 'tool_calls' && ev.calls) toolCalls.push(...openAIToolCalls(ev.calls))
      else if (ev.text) content += ev.text
    }
  }

  const message: Record<string, unknown> = { role: 'assistant', content }
  if (reasoning) message['reasoning_content'] = reasoning
  if (toolCalls.length) {
    message['tool_calls'] = toolCalls
    finish = 'tool_calls'
  }
  const respObj: Record<string, unknown> = {
    id: stdID || `chatcmpl-cnb-${randomId()}`,
    object: 'chat.completion',
    created: stdCreated,
    model: stdModel,
    choices: [{ index: 0, message, finish_reason: finish }],
  }
  if (stdUsage) respObj['usage'] = stdUsage
  return new Response(JSON.stringify(respObj), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

/** 获取 CSRF 凭证并发一个最小 chat 请求，验证 CNB 完整链路（凭证 + 模型连通性）。 */
export async function testCnbConnection(
  env: Env,
  provider: Provider,
  model?: string,
): Promise<{ success: boolean; statusCode?: number; message?: string; data?: unknown }> {
  try {
    const csrf = await getCsrf(env, provider.id)
    const modelName = model
      || (Array.isArray(provider.models) && provider.models[0]?.id)
      || 'deepseek-v4-flash'
    // 最小 chat 请求验证真实链路；stream:false 由网关聚合上游 SSE 后返回 JSON
    const resp = await proxyCnbChatRequest(env, provider, {
      model: modelName,
      messages: [{ role: 'user', content: 'ping' }],
      stream: false,
      max_tokens: 16,
    })
    if (!resp.ok) {
      let detail = ''
      try { detail = (await resp.text()).substring(0, 300) } catch { /* ignore */ }
      return {
        success: false,
        statusCode: resp.status,
        message: `chat 请求失败 HTTP ${resp.status}${detail ? `：${detail}` : ''}`,
      }
    }
    let content = ''
    let finishReason = ''
    let usage: unknown = null
    try {
      const data = await resp.json() as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; usage?: unknown }
      content = String(data?.choices?.[0]?.message?.content || '').trim()
      finishReason = String(data?.choices?.[0]?.finish_reason || '')
      usage = data?.usage ?? null
    } catch { /* 解析失败不影响结论 */ }
    return {
      success: true,
      statusCode: 200,
      message: `连接成功（${modelName} 已响应）${content ? `，回复：${content.substring(0, 80)}` : ''}`,
      data: {
        cnb: true,
        model: modelName,
        csrfKeyLen: csrf.key.length,
        csrfTokenLen: csrf.token.length,
        reply: content.substring(0, 200),
        finishReason,
        usage,
      },
    }
  } catch (err) {
    const msg = (err as Error).message || String(err)
    return { success: false, message: `连接失败：${msg}` }
  }
}