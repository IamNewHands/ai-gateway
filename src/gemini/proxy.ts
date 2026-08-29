/**
 * proxy.ts — Gemini CLI 上游转发（移植自 router-for-me/cpa-plugin-gemini-cli）。
 *
 * 差异点：
 *   1. 参考插件由 CLIProxyAPI 宿主的 builtin 翻译器把 OpenAI/Anthropic/Responses
 *      格式转成 Gemini generateContent 请求体；网关没有该 SDK，这里自行实现
 *      OpenAI chat.completions → Gemini generateContent 的转换（messages→contents、
 *      tools→function_declarations+parametersJsonSchema、system→systemInstruction）。
 *   2. 上游端点 cloudcode-pa.googleapis.com/v1internal:* 要求请求体包一层
 *      {"project": <project_id>, "request": <gemini body>, "model": <model>}，
 *      与参考项目 compat.WrapRequest 一致。
 *   3. 流式响应每行 `data: {"response":{...}}`，需剥掉 data: 前缀并取 response 字段
 *      （compat.UnwrapResponse），再转成 OpenAI SSE chunk。
 *
 * 端点：
 *   POST /v1internal:generateContent
 *   POST /v1internal:streamGenerateContent?alt=sse
 *   POST /v1internal:countTokens
 */

import type { Env, Provider } from '../types'
import { getOauthAccessToken, readOauthToken, refreshOauthToken, GEMINI_OAUTH, GEMINI_API_CLIENT_HEADER, geminiUserAgent } from '../oauth'
import { streamFetchWithTimeout } from '../opencode'
import { isSafeHttpUrl } from '../admin'

export const GEMINI_BASE_URL = 'https://cloudcode-pa.googleapis.com'
export const GEMINI_GENERATE_PATH = '/v1internal:generateContent'
export const GEMINI_STREAM_PATH = '/v1internal:streamGenerateContent'
export const GEMINI_COUNT_TOKENS_PATH = '/v1internal:countTokens'

/**
 * 解析 Gemini 推理基地址：优先取 provider.geminiBaseUrl（用户配置的美国中转地址），
 * 其次回退到内置默认直连地址。
 */
export function resolveGeminiBaseUrl(provider: Provider): string {
  return (provider.geminiBaseUrl || GEMINI_BASE_URL).replace(/\/$/, '')
}

/** 静态模型列表（参考 internal/models/models.go，输入 1048576 / 输出 65536） */
export const GEMINI_MODELS: Array<{ id: string; displayName: string }> = [
  { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
  { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
  { id: 'gemini-2.5-flash-lite', displayName: 'Gemini 2.5 Flash Lite' },
  { id: 'gemini-3-pro-preview', displayName: 'Gemini 3 Pro Preview' },
  { id: 'gemini-3.1-pro-preview', displayName: 'Gemini 3.1 Pro Preview' },
  { id: 'gemini-3-flash-preview', displayName: 'Gemini 3 Flash Preview' },
  { id: 'gemini-3.1-flash-lite-preview', displayName: 'Gemini 3.1 Flash Lite Preview' },
  { id: 'gemini-3.5-flash', displayName: 'Gemini 3.5 Flash' },
]

/** 是否 Gemini 提供商（OAuth flowType === 'gemini'），providerId 可自定义 */
export function isGeminiProvider(provider: Provider): boolean {
  return provider.oauth?.flowType === 'gemini'
}

function stripProviderPrefix(model: string): string {
  const i = model.indexOf('/')
  if (i > 0) return model.slice(i + 1)
  return model
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10)
}

// ===== 标识符清洗（参考 compat/tools.go SanitizeFunctionName/SanitizeFunctionID） =====

const IDENTIFIER_BAD = /[^a-zA-Z0-9_.:-]/

function sanitizeIdentifier(value: string): string {
  let v = String(value || '').trim()
  if (!v) return ''
  v = v.replace(IDENTIFIER_BAD, '_')
  if (!v) return '_'
  const first = v[0]
  if (!((first >= 'a' && first <= 'z') || (first >= 'A' && first <= 'Z') || first === '_')) {
    if (v.length >= 64) v = v.slice(0, 63)
    v = '_' + v
  }
  if (v.length > 64) v = v.slice(0, 64)
  return v
}

// ===== JSON Schema 清洗（参考 compat/schema.go CleanJSONSchemaForGemini） =====

const UNSUPPORTED_SCHEMA_KEYS = new Set([
  '$schema', '$defs', 'definitions', 'const', '$ref', '$id', '$comment',
  'additionalProperties', 'propertyNames', 'patternProperties',
  'minLength', 'maxLength', 'exclusiveMinimum', 'exclusiveMaximum',
  'pattern', 'minItems', 'maxItems', 'uniqueItems', 'format',
  'default', 'examples', 'nullable', 'title', 'enumDescriptions',
  'enumTitles', 'prefill', 'deprecated', 'strict',
])

/** 递归清洗 JSON Schema：删除 Gemini 不支持的字段，enum 值转字符串，type 数组拍平，required 只保留有效键 */
function cleanJSONSchemaForGemini(schema: unknown): Record<string, unknown> {
  const clean = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(clean)
    if (!node || typeof node !== 'object') return node
    const src = node as Record<string, any>
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(src)) {
      if (key.startsWith('x-') || UNSUPPORTED_SCHEMA_KEYS.has(key)) continue
      if (key === 'enum' && Array.isArray(value)) {
        out['enum'] = value.map((v: unknown) => String(v))
        out['type'] = 'string'
        continue
      }
      if (key === 'type' && Array.isArray(value)) {
        const types = (value as string[]).filter((t) => t && t !== 'null')
        out['type'] = types.length > 0 ? types[0] : 'string'
        if (types.length > 1 && typeof src.description === 'string') {
          out['description'] = `${src.description} (Accepts: ${types.join(' | ')})`
        }
        continue
      }
      if (key === 'required' && Array.isArray(value) && src.properties && typeof src.properties === 'object') {
        const valid = (value as string[]).filter((k: string) => Object.prototype.hasOwnProperty.call(src.properties, k))
        if (valid.length > 0) out['required'] = valid
        continue
      }
      out[key] = clean(value)
    }
    return out
  }
  const cleaned = clean(schema)
  if (cleaned && typeof cleaned === 'object' && !Array.isArray(cleaned)) {
    return cleaned as Record<string, unknown>
  }
  return { type: 'object', properties: {} }
}

// ===== OpenAI → Gemini 请求转换 =====

/** OpenAI messages 的 content 字段（string 或 part 数组）取文本 */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return (content as Array<Record<string, any>>)
      .filter((p) => p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('')
  }
  return ''
}

/** data URL / http(s) 图片 → Gemini inlineData；失败返回 null */
async function imageToInlineData(url: string): Promise<{ mimeType: string; data: string } | null> {
  const trimUrl = String(url || '').trim()
  if (!trimUrl) return null
  if (trimUrl.startsWith('data:')) {
    const comma = trimUrl.indexOf(',')
    if (comma < 0) return null
    const meta = trimUrl.slice(5, comma)
    const mimeMatch = /mimeType=([^;]+)/.exec(meta)
    const b64 = trimUrl.slice(comma + 1)
    if (!b64) return null
    return { mimeType: mimeMatch ? mimeMatch[1] : 'image/png', data: b64 }
  }
  if (trimUrl.startsWith('http://') || trimUrl.startsWith('https://')) {
    // S6：SSRF 防护——只允许公网 http/https 且无凭据 URL，拒绝本机/内网/保留 IP；
    // 同时限制单张图片大小，防止恶意超大图拉爆 Worker 内存。
    if (!isSafeHttpUrl(trimUrl)) return null
    const MAX_IMAGE_BYTES = 8 * 1024 * 1024
    try {
      const resp = await fetch(trimUrl, { signal: AbortSignal.timeout(10000) })
      if (!resp.ok) return null
      const declared = Number(resp.headers.get('Content-Length') || 0)
      if (declared > MAX_IMAGE_BYTES) return null
      const reader = resp.body ? resp.body.getReader() : null
      if (!reader) return null
      const parts: Uint8Array[] = []
      let total = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) {
            total += value.byteLength
            if (total > MAX_IMAGE_BYTES) {
              await reader.cancel().catch(() => {})
              return null
            }
            parts.push(value)
          }
        }
      } catch {
        return null
      }
      const buf = new Uint8Array(total)
      let offset = 0
      for (const p of parts) {
        buf.set(p, offset)
        offset += p.byteLength
      }
      let bin = ''
      for (const b of buf) bin += String.fromCharCode(b)
      const mime = resp.headers.get('Content-Type') || 'image/png'
      return { mimeType: mime.split(';')[0] || 'image/png', data: btoa(bin) }
    } catch {
      return null
    }
  }
  return null
}

/** OpenAI tools → Gemini tools（function_declarations + parametersJsonSchema，snake_case 为内部 API 所需） */
function buildGeminiTools(tools: unknown): any[] {
  if (!Array.isArray(tools)) return []
  const declarations: any[] = []
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue
    const fn = (tool as Record<string, any>).function
    if (!fn || typeof fn !== 'object') continue
    declarations.push({
      name: sanitizeIdentifier(fn.name),
      description: typeof fn.description === 'string' ? fn.description : '',
      parametersJsonSchema: cleanJSONSchemaForGemini(fn.parameters),
    })
  }
  return declarations.length > 0 ? [{ function_declarations: declarations }] : []
}

/**
 * OpenAI chat.completions 请求体 → Gemini generateContent 请求体。
 * - system → systemInstruction
 * - assistant.tool_calls → model content 的 functionCall parts
 * - tool 消息 → user content 的 functionResponse parts（按参考 groupFunctionResponses 归组）
 * - image_url → inlineData（data URL 直接解析，http(s) 由 Worker 抓取）
 */
async function openAIToGeminiRequest(body: Record<string, any>): Promise<Record<string, any>> {
  const messages: any[] = Array.isArray(body.messages) ? body.messages : []
  const systemTexts: string[] = []
  const contents: any[] = []
  let pendingCalls: string[] = [] // 待回应的 function 名（与 functionResponse 按序对应）
  let collectedResponses: any[] = []

  const flushResponses = () => {
    if (collectedResponses.length === 0) return
    contents.push({ role: 'user', parts: collectedResponses.splice(0) })
    pendingCalls = []
  }

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue
    const role = msg.role

    if (role === 'system') {
      const text = contentToText(msg.content)
      if (text) systemTexts.push(text)
      continue
    }

    if (role === 'tool') {
      const idx = collectedResponses.length
      collectedResponses.push({
        functionResponse: {
          name: sanitizeIdentifier(msg.name || pendingCalls[idx] || 'unknown'),
          id: sanitizeIdentifier(msg.tool_call_id || `call_${idx}`),
          response: msg.content ?? '',
        },
      })
      continue
    }

    if (role === 'assistant') {
      flushResponses()
      const parts: any[] = []
      const text = contentToText(msg.content)
      if (text) parts.push({ text })
      const toolCalls: any[] = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
      for (const tc of toolCalls) {
        if (!tc || typeof tc !== 'object') continue
        let args: unknown = {}
        try {
          args = JSON.parse(tc.function?.arguments || '{}')
        } catch {
          args = {}
        }
        parts.push({
          functionCall: {
            name: sanitizeIdentifier(tc.function?.name || ''),
            id: sanitizeIdentifier(tc.id || ''),
            args,
          },
        })
      }
      if (parts.length > 0) {
        contents.push({ role: 'model', parts })
        pendingCalls = toolCalls.map((tc) => tc.function?.name || '').filter((n) => n)
      }
      continue
    }

    // user
    flushResponses()
    const parts: any[] = []
    const content = msg.content
    if (typeof content === 'string') {
      if (content) parts.push({ text: content })
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== 'object') continue
        if (part.type === 'text' && typeof part.text === 'string' && part.text) {
          parts.push({ text: part.text })
        } else if (part.type === 'image_url' && part.image_url?.url) {
          const inline = await imageToInlineData(part.image_url.url)
          if (inline) parts.push({ inlineData: inline })
        }
      }
    }
    if (parts.length > 0) contents.push({ role: 'user', parts })
  }
  flushResponses()

  const tools = buildGeminiTools(body.tools)
  const generationConfig: Record<string, unknown> = {}
  if (typeof body.temperature === 'number') generationConfig['temperature'] = body.temperature
  if (typeof body.top_p === 'number') generationConfig['topP'] = body.top_p
  if (typeof body.top_k === 'number') generationConfig['topK'] = body.top_k
  const maxTokens = body.max_tokens ?? body.max_completion_tokens
  if (typeof maxTokens === 'number') generationConfig['maxOutputTokens'] = maxTokens
  if (Array.isArray(body.stop) && body.stop.length > 0) generationConfig['stopSequences'] = body.stop

  const gemini: Record<string, any> = { contents }
  if (systemTexts.length > 0) {
    gemini['systemInstruction'] = { parts: systemTexts.map((t) => ({ text: t })) }
  }
  if (tools.length > 0) gemini['tools'] = tools
  if (Object.keys(generationConfig).length > 0) gemini['generationConfig'] = generationConfig

  return gemini
}

// ===== thinking 归一化（参考 executor/request.go normalizeGemini25Thinking） =====

function thinkingLevelBudget(level: string): number | null {
  switch (String(level || '').trim().toLowerCase()) {
    case 'none': return 0
    case 'auto': return -1
    case 'minimal': return 512
    case 'low': return 1024
    case 'medium': return 8192
    case 'high': return 24576
    case 'xhigh': return 32768
    case 'max': return 128000
    default: return null
  }
}

function clampGemini25Budget(budget: number, maxBudget: number, zeroAllowed: boolean): number {
  if (budget === -1) return budget
  if (budget === 0) return zeroAllowed ? 0 : 128
  if (budget < 128) return 128
  if (maxBudget > 0 && budget > maxBudget) return maxBudget
  return budget
}

/** 2.5 系模型：thinkingLevel → thinkingBudget，none=0、auto=-1，裁剪到模型上限 */
function normalizeGemini25Thinking(body: Record<string, any>, model: string): Record<string, any> {
  const baseModel = stripProviderPrefix(model).split('(')[0].trim().toLowerCase()
  const limits: Record<string, { max: number; zero: boolean }> = {
    'gemini-2.5-pro': { max: 32768, zero: false },
    'gemini-2.5-flash': { max: 24576, zero: true },
    'gemini-2.5-flash-lite': { max: 24576, zero: true },
  }
  const limit = limits[baseModel]
  if (!limit) return body
  const gc = body.generationConfig
  const tc = gc?.thinkingConfig
  if (!tc || typeof tc !== 'object') return body

  let budget: number | null = null
  let modeNone = false
  const level = String(tc.thinkingLevel ?? tc.thinking_level ?? '').trim()
  if (level) {
    const b = thinkingLevelBudget(level)
    if (b === null) return body
    modeNone = level.toLowerCase() === 'none'
    budget = clampGemini25Budget(b, limit.max, limit.zero)
  } else if (typeof tc.thinkingBudget === 'number') {
    budget = clampGemini25Budget(tc.thinkingBudget, limit.max, limit.zero)
  } else if (typeof tc.thinking_budget === 'number') {
    budget = clampGemini25Budget(tc.thinking_budget, limit.max, limit.zero)
  }
  if (budget !== null) tc.thinkingBudget = budget
  if (typeof tc.include_thoughts === 'boolean' && tc.includeThoughts === undefined) {
    tc.includeThoughts = tc.include_thoughts
  }
  if (modeNone) tc.includeThoughts = false
  delete tc.thinkingLevel
  delete tc.thinking_level
  delete tc.thinking_budget
  delete tc.include_thoughts
  return body
}

/** 默认关闭内容安全过滤（参考 compat/tools.go attachDefaultSafetySettings） */
function attachDefaultSafetySettings(body: Record<string, any>): Record<string, any> {
  if (body.safetySettings) return body
  body.safetySettings = [
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
    { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' },
  ]
  return body
}

/** 组装发给 cloudcode-pa 的包装请求体（参考 compat.WrapRequest + BuildRequestInput） */
function wrapGeminiRequest(projectId: string, geminiBody: Record<string, any>, model: string): Record<string, any> {
  return { project: projectId, request: geminiBody, model }
}

// ===== Gemini → OpenAI 响应转换 =====

function mapUsage(usage: any): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
  return {
    prompt_tokens: usage?.promptTokenCount ?? 0,
    completion_tokens: usage?.candidatesTokenCount ?? 0,
    total_tokens: usage?.totalTokenCount ?? 0,
  }
}

function mapGeminiFinish(fr: string | null | undefined, hasToolCalls: boolean): string {
  if (hasToolCalls) return 'tool_calls'
  switch (String(fr || '').toUpperCase()) {
    case 'MAX_TOKENS': return 'length'
    case 'SAFETY':
    case 'RECITATION':
    case 'PROHIBITED_CONTENT':
    case 'BLOCKLIST':
    case 'IMAGE_SAFETY': return 'content_filter'
    case 'MALFORMED_FUNCTION_CALL':
    case 'FUNCTION_CALL': return 'tool_calls'
    case 'NO_CANDIDATES':
    case 'OTHER': return 'stop'
    default: return 'stop'
  }
}

function geminiPartsToOpenAI(parts: any[], out: { content: string; toolCalls: any[] }): void {
  if (!Array.isArray(parts)) return
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue
    if (typeof part.text === 'string') out.content += part.text
    if (part.functionCall && typeof part.functionCall === 'object') {
      const fc = part.functionCall
      out.toolCalls.push({
        id: fc.id || `call_${out.toolCalls.length}`,
        type: 'function',
        function: {
          name: fc.name || '',
          arguments: JSON.stringify(fc.args ?? {}),
        },
      })
    }
  }
}

/** 非流式 Gemini generateContent 响应 → OpenAI chat.completion */
function geminiToOpenAIResponse(resp: any, model: string): Record<string, any> {
  const candidate = resp?.candidates?.[0]
  const parts = candidate?.content?.parts
  const acc = { content: '', toolCalls: [] as any[] }
  geminiPartsToOpenAI(parts, acc)

  const message: Record<string, any> = { role: 'assistant', content: acc.content || null }
  if (acc.toolCalls.length > 0) message.tool_calls = acc.toolCalls

  const out: Record<string, any> = {
    id: `chatcmpl-gemini-${randomId()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: mapGeminiFinish(candidate?.finishReason, acc.toolCalls.length > 0),
    }],
  }
  if (resp?.usageMetadata) out.usage = mapUsage(resp.usageMetadata)
  return out
}

/** 流式单个 Gemini chunk → OpenAI chat.completion.chunk；无可输出内容返回 null */
function geminiChunkToOpenAIDelta(chunk: any, model: string, streamId: string): Record<string, any> | null {
  const candidate = chunk?.candidates?.[0]
  const out: Record<string, any> = {
    id: `chatcmpl-gemini-${streamId}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {} as Record<string, any>, finish_reason: null }],
  }
  if (candidate) {
    const parts = candidate?.content?.parts
    const acc = { content: '', toolCalls: [] as any[] }
    geminiPartsToOpenAI(parts, acc)
    const delta = out.choices[0].delta as Record<string, any>
    if (acc.content) delta['content'] = acc.content
    if (acc.toolCalls.length > 0) {
      delta['tool_calls'] = acc.toolCalls.map((tc, i) => ({ index: i, ...tc }))
    }
    if (candidate.finishReason) {
      out.choices[0].finish_reason = mapGeminiFinish(candidate.finishReason, acc.toolCalls.length > 0)
    }
  }
  if (chunk?.usageMetadata) out.usage = mapUsage(chunk.usageMetadata)
  // 无候选且无 usage 的空包直接丢弃
  if (!candidate && !chunk?.usageMetadata) return null
  return out
}

/**
 * 上游 SSE → OpenAI SSE：每行 `data:{"response":{...}}` → 解包 → 转 OpenAI delta →
 * 输出 `data: <json>\n\n`，末尾 `data: [DONE]\n\n`。
 */
function unwrapGeminiSSE(upstreamBody: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  const decoder = new TextDecoderStream()
  const reader = upstreamBody.pipeThrough(decoder).getReader()
  const encoder = new TextEncoder()
  const streamId = randomId()
  let lineBuffer = ''

  return new ReadableStream({
    async start(controller) {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const combined = lineBuffer + value
        const lines = combined.split('\n')
        lineBuffer = lines.pop() || ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          let data = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed
          if (!data || data === '[DONE]') continue
          let payload: unknown
          try {
            payload = JSON.parse(data)
          } catch {
            continue
          }
          // 解包：取 response 字段（参考 compat.UnwrapResponse）
          let inner: any = payload
          if (payload && typeof payload === 'object' && (payload as any).response !== undefined) {
            inner = (payload as any).response
          }
          const chunk = geminiChunkToOpenAIDelta(inner, model, streamId)
          if (chunk) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
        }
      }
      if (lineBuffer.trim()) {
        let data = lineBuffer.trim()
        if (data.startsWith('data:')) data = data.slice(5).trim()
        if (data && data !== '[DONE]') {
          try {
            const payload = JSON.parse(data)
            let inner: any = payload
            if (payload && typeof payload === 'object' && (payload as any).response !== undefined) {
              inner = (payload as any).response
            }
            const chunk = geminiChunkToOpenAIDelta(inner, model, streamId)
            if (chunk) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
          } catch { /* skip */ }
        }
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
    async cancel() {
      try { await reader.cancel() } catch { /* ignore */ }
    },
  })
}

/** 上游错误 → OpenAI 错误格式 */
function geminiErrorResponse(status: number, bodyText: string): Response {
  const text = String(bodyText || '').substring(0, 500)
  return new Response(
    JSON.stringify({ error: { message: `Gemini 上游 HTTP ${status}: ${text}`, type: 'upstream_error' } }),
    { status: status || 502, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
  )
}

function geminiHeaders(token: string, model: string, stream: boolean): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Accept': stream ? 'text/event-stream' : 'application/json',
    'Authorization': `Bearer ${token}`,
    'User-Agent': geminiUserAgent(model),
    'X-Goog-Api-Client': GEMINI_API_CLIENT_HEADER,
  }
}

export interface GeminiProxyOptions {
  /** 客户端是否要求流式（false 时非流式 generateContent + 聚合为 chat.completion） */
  stream?: boolean
}

/**
 * 转发一次 chat 请求到 Gemini CLI 上游。
 * 返回 Response：
 *   - stream=true：OpenAI SSE（解包后的 Gemini chunk → OpenAI delta）
 *   - stream=false：非流式 generateContent → OpenAI chat.completion JSON
 */
export async function proxyGeminiChatRequest(
  env: Env,
  provider: Provider,
  forwardBody: Record<string, unknown>,
  opts?: GeminiProxyOptions
): Promise<Response> {
  const cfg = provider.oauth
  if (!cfg) {
    return new Response(
      JSON.stringify({ error: { message: '该提供商未配置 Gemini OAuth', type: 'configuration_error' } }),
      { status: 400, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    )
  }

  let token = await getOauthAccessToken(env, provider.id, cfg)
  let tokenState = await readOauthToken(env, provider.id)
  if (!token) {
    // 尝试用 refresh_token 刷新一次
    const ok = await refreshOauthToken(env, provider.id, cfg)
    if (ok) {
      tokenState = await readOauthToken(env, provider.id)
      token = await getOauthAccessToken(env, provider.id, cfg)
    }
  }
  if (!token) {
    return new Response(
      JSON.stringify({ error: { message: 'OAuth 未连接或 Token 已失效，请在管理后台重新授权', type: 'oauth_not_connected' } }),
      { status: 502, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    )
  }

  const projectId = tokenState?.projectId || ''
  if (!projectId) {
    return new Response(
      JSON.stringify({ error: { message: 'Gemini 项目 ID 缺失，请重新授权', type: 'configuration_error' } }),
      { status: 502, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    )
  }

  const model = stripProviderPrefix(String(forwardBody.model || ''))
  const stream = opts?.stream ?? forwardBody.stream === true

  let geminiBody = await openAIToGeminiRequest(forwardBody as Record<string, any>)
  geminiBody = normalizeGemini25Thinking(geminiBody, model)
  geminiBody = attachDefaultSafetySettings(geminiBody)
  const wrapped = wrapGeminiRequest(projectId, geminiBody, model)

  const base = resolveGeminiBaseUrl(provider)
  const endpoint = stream
    ? `${base}${GEMINI_STREAM_PATH}?alt=sse`
    : `${base}${GEMINI_GENERATE_PATH}`

  let resp: Response
  try {
    resp = await streamFetchWithTimeout(endpoint, {
      method: 'POST',
      headers: geminiHeaders(token, model, stream),
      body: JSON.stringify(wrapped),
    })
  } catch (err) {
    return geminiErrorResponse(502, (err as Error).message || '网络请求失败')
  }

  // 401/403：token 过期，刷新后重试一次
  if ((resp.status === 401 || resp.status === 403) && tokenState?.refresh_token) {
    const refreshed = await refreshOauthToken(env, provider.id, cfg)
    if (refreshed) {
      const fresh = await readOauthToken(env, provider.id)
      token = fresh?.access_token || token
      try {
        resp = await streamFetchWithTimeout(endpoint, {
          method: 'POST',
          headers: geminiHeaders(token, model, stream),
          body: JSON.stringify(wrapped),
        })
      } catch (err) {
        return geminiErrorResponse(502, (err as Error).message || '网络请求失败')
      }
    }
  }

  if (!resp.ok || !resp.body) {
    const errText = await resp.text().catch(() => '')
    return geminiErrorResponse(resp.status, errText)
  }

  if (stream) {
    const readable = unwrapGeminiSSE(resp.body, model)
    return new Response(readable, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      },
    })
  }

  // 非流式：收集响应体 → 解包 → 转换
  const raw = await resp.text()
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return geminiErrorResponse(502, `响应不是合法 JSON: ${raw.substring(0, 200)}`)
  }
  let inner: any = payload
  if (payload && typeof payload === 'object' && (payload as any).response !== undefined) {
    inner = (payload as any).response
  }
  const openai = geminiToOpenAIResponse(inner, model)
  return new Response(JSON.stringify(openai), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

/**
 * Gemini 模型连通性测试：走正常转发链路（token 自动刷新 + 401 重试），
 * 发送最小请求验证。返回与 testModelConnection 兼容的结构。
 */
export async function testGeminiModel(
  env: Env,
  provider: Provider,
  modelId: string
): Promise<{ success: boolean; message: string; statusCode?: number }> {
  const resp = await proxyGeminiChatRequest(
    env,
    provider,
    { model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false }
  )
  if (resp.ok) {
    return { success: true, message: '连接成功', statusCode: resp.status }
  }
  const text = await resp.text().catch(() => '')
  let detail = text
  try {
    const j = JSON.parse(text)
    detail = j?.error?.message || text
  } catch { /* keep text */ }
  return { success: false, message: `HTTP ${resp.status}: ${detail.substring(0, 200)}`, statusCode: resp.status }
}

/** countTokens（内部 API 需要去掉 project/model 包装，响应为 {totalTokens,...}） */
export async function proxyGeminiCountTokens(
  env: Env,
  provider: Provider,
  forwardBody: Record<string, unknown>
): Promise<Response> {
  const cfg = provider.oauth
  if (!cfg) return geminiErrorResponse(400, '该提供商未配置 Gemini OAuth')
  const token = await getOauthAccessToken(env, provider.id, cfg)
  if (!token) {
    return new Response(
      JSON.stringify({ error: { message: 'OAuth 未连接或 Token 已失效，请在管理后台重新授权', type: 'oauth_not_connected' } }),
      { status: 502, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    )
  }
  const model = stripProviderPrefix(String(forwardBody.model || ''))
  const geminiBody = await openAIToGeminiRequest(forwardBody as Record<string, any>)
  const body = { request: geminiBody }
  try {
    const resp = await fetch(`${resolveGeminiBaseUrl(provider)}${GEMINI_COUNT_TOKENS_PATH}`, {
      method: 'POST',
      headers: geminiHeaders(token, model, false),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    })
    if (!resp.ok) {
      return geminiErrorResponse(resp.status, await resp.text().catch(() => ''))
    }
    const raw = await resp.text()
    let inner: any = null
    try { inner = JSON.parse(raw) } catch { /* ignore */ }
    if (inner && inner.response !== undefined) inner = inner.response
    return new Response(JSON.stringify(inner ?? { totalTokens: 0 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    })
  } catch (err) {
    return geminiErrorResponse(502, (err as Error).message || '网络请求失败')
  }
}
