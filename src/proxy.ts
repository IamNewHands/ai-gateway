import { Context } from 'hono'
import { getProvider, getProviders, getModelsListCache, setModelsListCache, getUnimodel, getUnimodels, resolveProviderBaseUrl, getResponseHistory, saveResponseHistory } from './storage'
import { KV_KEYS, KEY_HEALTH_COOLDOWN_MS, KEY_HEALTH_MAX_FAILURES, UNIMODEL_PROVIDER_ID } from './config'
import type { AppEnv, Env, ProxyRequestBody } from './types'
import { createAnalyticsContext, normalizeAnthropicUsage, normalizeChatUsage, normalizeResponsesUsage, summarizeError } from './analytics/types'
import type { AnalyticsContext, UsageMetrics } from './analytics/types'
import { createStreamUsageProbe, writeAnalyticsEvent } from './analytics/usage-logger'
import {
  isOpenCodeProvider,
  proxyOpenCodeRequest,
  resolveOpenCodeUrls,
  streamFetchWithTimeout,
  withSSEKeepAlive,
  OPENCODE_STREAM_IDLE_TIMEOUT_MS,
} from './opencode'
import { isQoderProvider, proxyQoderChatRequest } from './qoder/proxy'
import { isClineProvider, proxyClineChatRequest } from './cline/proxy'
import { isVisionBridgeProvider, buildVisionBridgeRequestBody } from './vision/bridge'
import { isGeminiProvider, proxyGeminiChatRequest } from './gemini/proxy'
import { isCnbProvider, proxyCnbChatRequest, CnbStreamDiag } from './cnb/proxy'
import { isM365Provider, proxyM365ChatRequest } from './m365/proxy'
import { isTraeProvider, proxyTraeChatRequest } from './trae/proxy'
import { writeLog } from './admin'
import { getPerfSettings } from './perf'
import { applyThinkingInjection } from './thinking'
import { applyCachePrefixInjection } from './cache-prefix'
import { getOauthAccessToken, readOauthToken, refreshOauthToken, detectTokenRealm, buildOauthHeaders } from './oauth'
import {
  anthropicToOpenAI,
  openAIToAnthropic,
  createAnthropicSSEAccumulator,
  openAIChunkToAnthropicSSE,
  aggregateOpenAIToAnthropic,
  responsesToOpenAI,
  openAIToResponses,
  openAIChunkToResponsesSSE,
  responsesOutputToAssistantMessage,
  aggregateOpenAIToResponses,
  finalizeAnthropicStream,
  diagnoseAnthropicAccumulator,
  openAIRequestToAnthropic,
  anthropicResponseToOpenAI,
  anthropicResponseToResponses,
  createAnthropicSSEToOpenAI,
  createAnthropicSSEToResponses,
} from './formats'

// ===== Key 健康状态类型和辅助函数 =====

interface KeyHealth {
  failures: number
  lastFailed: boolean
  demotedAt?: number  // 首次达到降权阈值的时间戳 (Date.now())
}
type HealthMap = Record<string, KeyHealth>

// 转换后 SSE 流（Anthropic/Responses）统一心跳配置：距上次输出超过 8s 注入
// `: keep-alive\n\n` 注释行，防客户端（AI SDK / iOS 严格解析器，常见 ~15s 空闲超时）
// 在模型静默期判定流结束而截断回答；上游超过 180s 完全无数据视为挂起，主动结束流。
const SSE_KEEPALIVE_MS = 8000
const SSE_IDLE_TIMEOUT_MS = 180000

const HEALTH_KEY = (providerId: string) => KV_KEYS.KEY_HEALTH_PREFIX + providerId

// R1：health 读写缓存。同一 isolate 内并发请求共享同一 healthMap 对象（10s TTL），
// 消除「readHealth → failures++ → writeHealth 整条覆盖写」并发时的计数互相覆盖。
// 跨 isolate 的极端并发仍受 KV 无原子增量限制，但失败计数失陪几秒可接受。
const HEALTH_CACHE_TTL_MS = 10_000
interface HealthCacheEntry { map: HealthMap | null; at: number }
const healthCache = new Map<string, HealthCacheEntry>()

async function readHealth(env: Env, providerId: string): Promise<HealthMap> {
  const key = HEALTH_KEY(providerId)
  const cache = healthCache.get(key)
  if (cache && Date.now() - cache.at < HEALTH_CACHE_TTL_MS) {
    return cache.map || {}
  }
  const raw = await env.KV.get(key)
  const map: HealthMap = raw ? JSON.parse(raw) : {}
  healthCache.set(key, { map, at: Date.now() })
  return map
}

async function writeHealth(env: Env, providerId: string, health: HealthMap): Promise<void> {
  // 只保存有失败记录的 key，避免 KV 膨胀
  const filtered: HealthMap = {}
  for (const [k, v] of Object.entries(health)) {
    if (v.failures > 0) filtered[k] = v
  }
  const key = HEALTH_KEY(providerId)
  if (Object.keys(filtered).length > 0) {
    await env.KV.put(key, JSON.stringify(filtered))
    healthCache.set(key, { map: filtered, at: Date.now() })
  } else {
    // 全部健康，删除 KV 条目
    await env.KV.delete(key).catch(() => {})
    healthCache.set(key, { map: null, at: Date.now() })
  }
}

/** 解析模型 ID，如 "deepseek/deepseek-chat" → { providerId, modelId } */
function parseModelId(model: string): { providerId: string; modelId: string } | null {
  const slashIndex = model.indexOf('/')
  if (slashIndex === -1) return null
  return {
    providerId: model.substring(0, slashIndex),
    modelId: model.substring(slashIndex + 1),
  }
}

/** 生成请求体摘要：保留顶层字段名和结构，但截断 messages 内容 */
function summarizeRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  try {
    const summary: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(body)) {
      if (key === 'messages' && Array.isArray(value)) {
        summary[key] = value.map((msg: any) => {
          if (!msg || typeof msg !== 'object') return String(msg)
          const entry: Record<string, unknown> = { role: msg.role || 'unknown' }
          if (typeof msg.content === 'string') {
            entry.content_length = msg.content.length
          } else if (Array.isArray(msg.content)) {
            entry.content_blocks = msg.content.length
            // 记录每个 block 的类型和文本预览，便于定位上游不支持的 block 类型
            entry.block_types = msg.content.map((b: any) => {
              if (!b || typeof b !== 'object') return String(b)
              const t = b.type || 'unknown'
              const txt = (typeof b.text === 'string' ? b.text : b.output ? String(b.output) : '').slice(0, 50)
              return txt ? `${t}:${txt}` : t
            })
          }
          if (Array.isArray(msg.tool_calls)) entry.tool_calls_count = msg.tool_calls.length
          if (typeof msg.tool_call_id === 'string') entry.tool_call_id = msg.tool_call_id
          return entry
        })
      } else if (key === 'tools' && Array.isArray(value)) {
        summary[key] = value.map((t: any) => (t && t.function ? { name: t.function.name } : String(t)))
      } else {
        summary[key] = value
      }
    }
    return summary
  } catch {
    return { _error: 'summarize failed', keys: Object.keys(body) }
  }
}

/**
 * 清洗上游错误文本后再回显给客户端（S8）：
 * - 截断到安全长度，避免上游返回超大/恶意 body 时整段回显
 * - 仅保留可打印 ASCII 与常见 CJK，剥离控制字符/转义序列（防终端注入与日志逃逸）
 * - 移除疑似内网/元数据地址与「Authorization/Bearer」等敏感字样的裸露段
 */
function sanitizeUpstreamError(text: string, max = 400): string {
  const raw = String(text || '')
  const noControl = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  const cleaned = noControl
    .replace(/https?:\/\/(?:[0-9]{1,3}\.){3}[0-9]{1,3}[^\s'"]*/gi, '')
    .replace(/https?:\/\/(?:localhost|127\.0\.0\.1|10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)[^\s'"]*/gi, '')
    .replace(/(authorization|proxy-authorization|api[_-]?key|bearer)\s*[:=]\s*\S+/gi, '$1: ***')
  return cleaned.slice(0, max)
}

/**
 * 清理被 Tencent CodeBuddy 内容过滤器屏蔽的 Claude Code 模板短语。
 * CPA 使用零宽空格 \u200B 插入到短语中来绕过精确匹配过滤。
 */
function sanitizeBlockedTemplates(body: Record<string, unknown>): void {
  const messages = body['messages'] as any[]
  if (!Array.isArray(messages)) return
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue
    const content = msg.content
    if (typeof content === 'string') {
      msg.content = sanitizeText(content)
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part.text === 'string') {
          part.text = sanitizeText(part.text)
        }
      }
    }
  }
}

/**
 * 清理上游不支持的请求体字段：
 * - developer role → system（WorkBuddy 不支持 developer）
 * - 删除 reasoning_effort（上游 OpenAI 兼容 API 不支持）
 * - 空 content 数组 → 空字符串
 */
function sanitizeUpstreamBody(body: Record<string, unknown>): void {
  // 删除 reasoning_effort
  delete body['reasoning_effort']

  const messages = body['messages'] as any[]
  if (!Array.isArray(messages)) return
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue
    // developer → system
    if (msg.role === 'developer') {
      msg.role = 'system'
    }
    // 空 content 数组 → 空字符串（OpenAI API 不接受 content: []）
    if (Array.isArray(msg.content) && msg.content.length === 0) {
      msg.content = ''
    }
  }
}

/** 在匹配的屏蔽短语中插入零宽空格来绕过精确匹配过滤 */
function sanitizeText(s: string): string {
  // "You are Claude Code, Anthropic's official CLI tool for Claude." 中的 "Claude" 后插入 \u200B
  s = s.replace(
    /You are Claude Code, Anthropic's official CLI tool for Claude\./g,
    'You are Claude\u200B Code, Anthropic\u200B\'s official CLI tool for Claude.'
  )
  // "Default branch (you will usually use this for PRs)" 中的 "Default" 后插入 \u200B
  s = s.replace(
    /Default branch \(you will usually use this for PRs\)/g,
    'Default\u200B branch (you will usually use this for PRs)'
  )
  return s
}

/**
 * WorkBuddy SSE 流聚合：收集所有 chunk 拼接为非流式 chat.completion 响应。
 * 参考 cpa-plugin stream.go 的 aggregateCompletion 实现。
 */
async function aggregateWorkbuddySSE(body: ReadableStream<Uint8Array>, model: string): Promise<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let content = '', reasoning = '', role = '', respModel = '', respID = '', finish = ''
  let created = 0
  let usage: Record<string, unknown> | null = null
  const toolCalls: Map<number, Record<string, unknown>> = new Map()
  const toolOrder: number[] = []

  // 按 index 合并 tool_call delta
  function mergeToolCallDelta(merged: Record<string, unknown>, delta: Record<string, unknown>) {
    for (const k of ['id', 'type']) {
      if (!(k in merged) && typeof delta[k] === 'string' && delta[k] !== '') {
        merged[k] = delta[k]
      }
    }
    // function.name 可能分片，拼接
    if (delta.function && typeof delta.function === 'object') {
      const df = delta.function as Record<string, unknown>
      if (!merged.function) merged.function = {}
      const mf = merged.function as Record<string, unknown>
      if (typeof df.name === 'string') {
        mf.name = (mf.name as string || '') + df.name
      }
      if (typeof df.arguments === 'string') {
        mf.arguments = (mf.arguments as string || '') + df.arguments
      }
    }
  }

  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    // 按行处理
    const lines = buffer.split('\n')
    buffer = lines.pop() || '' // 保留未完成的行
    for (const line of lines) {
      let data = line.trim()
      if (!data) continue
      if (data.startsWith('data:')) data = data.slice(5).trim()
      if (!data || data === '[DONE]') continue

      try {
        const chunk = JSON.parse(data)
        if (chunk.id) respID = chunk.id
        if (chunk.model) respModel = chunk.model
        if (chunk.created) created = chunk.created
        if (chunk.usage) usage = chunk.usage

        const choices = chunk.choices as any[]
        if (Array.isArray(choices)) {
          for (const choice of choices) {
            const delta = choice?.delta
            if (delta && typeof delta === 'object') {
              if (delta.role) role = delta.role
              if (typeof delta.content === 'string') content += delta.content
              if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content
              if (Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls) {
                  if (!tc || typeof tc !== 'object') continue
                  const idx = typeof tc.index === 'number' ? tc.index : 0
                  if (!toolCalls.has(idx)) {
                    toolCalls.set(idx, { index: idx })
                    toolOrder.push(idx)
                  }
                  mergeToolCallDelta(toolCalls.get(idx)!, tc)
                }
              }
            }
            if (choice.finish_reason) finish = choice.finish_reason
          }
        }
      } catch {
        // 跳过无法解析的行
      }
    }
  }
  // 处理 buffer 中剩余的行
  if (buffer.trim()) {
    let data = buffer.trim()
    if (data.startsWith('data:')) data = data.slice(5).trim()
    if (data && data !== '[DONE]') {
      try {
        const chunk = JSON.parse(data)
        if (chunk.usage) usage = chunk.usage
      } catch { /* ignore */ }
    }
  }

  const message: Record<string, unknown> = {
    role: role || 'assistant',
    content: content,
  }
  if (reasoning) message.reasoning_content = reasoning
  if (toolOrder.length > 0) {
    toolOrder.sort((a, b) => a - b)
    message.tool_calls = toolOrder.map(idx => toolCalls.get(idx)!)
  }

  const result: Record<string, unknown> = {
    id: respID || 'chatcmpl-workbuddy',
    object: 'chat.completion',
    created: created || Math.floor(Date.now() / 1000),
    model: respModel || model || 'unknown',
    choices: [{
      index: 0,
      message: message,
      finish_reason: finish || 'stop',
    }],
  }
  if (usage) result.usage = usage

  return JSON.stringify(result)
}

/**
 * WorkBuddy SSE chunk 清洗：去掉空 tool_calls/function_call 等噪音字段。
 * 参考 cpa-plugin stream.go 的 cleanChunkJSON 实现。
 * 不清洗这些字段会导致 strict 客户端（如某些 OpenAI SDK）解码失败：
 * "SSE stream error: Transport error: error decoding response body"
 */
function cleanWorkbuddyChunk(chunk: string): string {
  // 只处理 SSE data: 行
  let data = chunk.trim()
  if (!data) return chunk

  const hasPrefix = data.startsWith('data:')
  if (hasPrefix) {
    data = data.slice(5).trim()
  }
  if (!data || data === '[DONE]') return chunk

  try {
    const obj = JSON.parse(data)
    let changed = false
    const choices = obj?.choices as any[]
    if (Array.isArray(choices)) {
      for (const choice of choices) {
        const delta = choice?.delta
        if (!delta || typeof delta !== 'object') continue

        // 去掉空的/全空值的 function_call（WorkBuddy 终端 chunk 常有
        // function_call: {"name":"","arguments":""}，2 个 key 但全是空值）
        if (delta.function_call !== undefined) {
          if (delta.function_call === null) {
            delete delta.function_call
            changed = true
          } else if (typeof delta.function_call === 'object') {
            const vals = Object.values(delta.function_call)
            if (vals.length === 0 || vals.every((v: any) => v === null || v === '')) {
              delete delta.function_call
              changed = true
            }
          }
        }

        // 去掉空的 tool_calls 数组（WorkBuddy 终端 chunk 的标志性问题）
        if (Array.isArray(delta.tool_calls) && delta.tool_calls.length === 0) {
          delete delta.tool_calls
          changed = true
        }
        // 去掉空的噪音字段
        for (const noise of ['extra_fields', 'refusal', 'reasoning_content']) {
          if (delta[noise] === null || delta[noise] === '' || delta[noise] === undefined) {
            delete delta[noise]
            changed = true
          }
        }
        // 如果 delta 完全为空且没有 finish_reason，整个 chunk 丢弃
        if (Object.keys(delta).length === 0 && !choice.finish_reason) {
          return ''
        }
      }
    }
    if (!changed) return chunk
    const cleaned = JSON.stringify(obj)
    return hasPrefix ? `data: ${cleaned}` : cleaned
  } catch {
    // 非 JSON 行原样返回
    return chunk
  }
}

/**
 * 透传上游响应，保留 Content-Type（含 SSE text/event-stream）等关键头。
 * 修复 SSE 流式响应被截断/解码失败的问题：
 * - 不硬编码 application/json 作为 fallback（SSE 流的 Content-Type 是 text/event-stream）
 * - 添加 X-Accel-Buffering: no 防止中间代理缓冲 SSE 流
 * - 保留上游的 Transfer-Encoding 相关行为（Workers 自动处理 chunked）
 */
function passthroughResponse(response: Response, cleanFn?: (chunk: string) => string): Response {
  const headers: Record<string, string> = {
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
  }
  const ct = response.headers.get('Content-Type')
  if (ct) headers['Content-Type'] = ct
  // R9：3xx 重定向响应补透传 Location，否则客户端（curl/客户端 SDK）重定向链断裂。
  // 其他头（Cookie、Set-Cookie 等）不与透传——避免把敏感控制面头泄漏给模型客户端。
  if (response.status >= 300 && response.status < 400) {
    const loc = response.headers.get('Location')
    if (loc) headers['Location'] = loc
  }

  // 无清洗函数或 body 不存在，直接透传
  if (!cleanFn || !response.body) {
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }

  // 通过 TransformStream 对 SSE 文本流做逐行清洗
  const { readable, writable } = new TransformStream<string, Uint8Array>({
    transform(chunk, controller) {
      const encoder = new TextEncoder()
      // 空行是 SSE 事件分隔符（\n\n 中的第二个 \n），必须原样保留，
      // 否则严格 SSE 解析器（如 Trae/OpenCode）会把所有 data: 行合并成
      // 一个事件，JSON 解析失败导致内容被整体丢弃。
      if (chunk === '') {
        controller.enqueue(encoder.encode('\n'))
        return
      }
      const cleaned = cleanFn(chunk)
      if (cleaned) {
        controller.enqueue(encoder.encode(cleaned + '\n'))
      }
    },
  })

  // 使用 pipeTo 将上游 body 通过 TextDecoderStream 管道化到清洗流。
  // 关键：TextDecoderStream 按底层缓冲区切分 chunk，可能在任何位置切断。
  // 必须维护行缓冲区，将不完整的行与下一个 chunk 拼接，否则 SSE data: 行
  // 的 JSON 可能被换行符截断（如 data: {"id":"xxx-\n yyy"...}），导致
  // 客户端 SSE 解析器（如 OpenMinis 的 ssePayload）收到不以 "data:" 开头
  // 的行而丢弃，最终造成内容不完整。
  const writer = writable.getWriter()
  const decoder = new TextDecoderStream()
  const reader = response.body.pipeThrough(decoder).getReader()
  ;(async () => {
    let lineBuffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        // 将缓冲区与当前 chunk 拼接
        const combined = lineBuffer + value
        const lines = combined.split('\n')
        // 最后一行可能不完整，保留到缓冲区
        lineBuffer = lines.pop() || ''
        for (const line of lines) {
          // 空行也要传递（SSE 事件分隔符），不能过滤
          await writer.write(line)
        }
      }
      // 流结束后，处理缓冲区中剩余的最后一行
      if (lineBuffer.trim()) {
        await writer.write(lineBuffer)
      }
    } catch { /* 流异常，忽略 */ }
    try { await writer.close() } catch { /* already closed */ }
  })()

  return new Response(readable, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

const isStreamRequest = (body: ProxyRequestBody): boolean => body.stream === true
const getRoute = (url: URL): string => url.pathname.replace(/^\/v1\//, '') || 'chat/completions'

// P7：上游请求头白名单透传（从 aihub 移植）。
// 客户端发来的一层自定义头（如 OpenRouter 的 X-Title / HTTP-Referer、x-api-key 认证、
// Anthropic 的 anthropic-version / anthropic-beta、企业网关 user- 身份头）默认被丢弃，
// 这里按前缀白名单透传给上游。仅过滤前缀，无需关心值内容。
const PASSTHROUGH_HEADER_PREFIXES = ['x-', 'anthropic-', 'user-', 'referer', 'http-referer']

/**
 * 从客户端请求中收集白名单前缀头（小写匹配，保留原始大小写），供转发上游时附加。
 * 独立于具体转发路径：通用转发 / opencode / qoder 等均可复用。
 */
export function buildPassthroughHeaders(c: Context<AppEnv>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of c.req.raw.headers.entries()) {
    const lower = key.toLowerCase()
    if (PASSTHROUGH_HEADER_PREFIXES.some((p) => lower.startsWith(p)) && value) {
      out[key] = value
    }
  }
  return out
}

/**
 * P2：上游 fetch——取消「5 分钟整体超时」对流式 body 的持续生效（长思考/agent 中途被掐断）。
 * - 非流式：保持整体超时（totalTimeoutMs，默认 5 分钟）行为。
 * - 流式：连接/首字节超时（connectTimeoutMs，默认 90s），拿到 response 后 clearTimeout；
 *   SSE body 额外包 withSSEKeepAlive（idle 兜底 + 心跳，默认 240s / 15s）。
 * 以上阈值均来自「性能设置」（KV 可编辑，见 src/perf.ts），后台可调。
 */
function fetchUpstream(
  env: Env,
  url: string,
  init: RequestInit,
  isStream: boolean,
): Promise<Response> {
  return getPerfSettings(env).then((perf) => {
    if (!isStream) {
      return fetch(url, { ...init, signal: AbortSignal.timeout(perf.totalTimeoutMs) })
    }
    return streamFetchWithTimeout(url, init, {
      connectTimeoutMs: perf.connectTimeoutMs,
      idleTimeoutMs: perf.idleTimeoutMs,
      keepAliveMs: perf.keepAliveMs,
    })
  })
}

// ===== 瞬时错误自动重试 =====
// Trae 等客户端直连网关时，上游偶发瞬时 5xx/网络抖动会直接透传失败，
// 客户端在读取响应流时再叠加 TLS/网络抖动（如 SEC_E_MESSAGE_ALTERED）就报错。
// 既然"重试一次又正常"，网关侧对瞬时错误自动重试 1 次即可消除大部分此类问题。
// 注意：500 也纳入——上游过载/限流网关常见偶发 500，重试与 502/503/504 一视同仁。
const TRANSIENT_RETRY_MAX = 1
const TRANSIENT_RETRY_DELAY_MS = 400
/** 瞬时性上游状态码：可安全对同一请求重试（区别于 4xx 的确定性错误） */
function isTransientStatus(status: number): boolean {
  return status === 500 || status === 502 || status === 503 || status === 504
}

/**
 * Anthropic 原生上游转发（provider.apiType === 'anthropic'，如 api.anthropic.com）。
 * 请求体 / 认证 / 路径都走 Anthropic 原生格式：
 * - URL：{base}/v1/messages（自动去掉 baseUrl 末尾的 /v1）
 * - 认证：x-api-key + anthropic-version: 2023-06-01（+ 浏览器直连标记）
 * - 请求体：内部 OpenAI 规范格式经 openAIRequestToAnthropic 转回 Anthropic
 * 响应按客户端 route 处理：
 * - 'messages'：Anthropic → Anthropic，直接透传（保真度最高，thinking/tool_use 原样保留）
 * - 'chat'    ：Anthropic → OpenAI chat.completion（非流式 / 流式）
 * - 'responses'：Anthropic → OpenAI Responses（非流式 / 流式）
 * 多 Key 顺序 failover，与 messages / responses 通用兜底路径一致。
 */
async function proxyAnthropicNativeUpstream(
  c: Context<AppEnv>,
  provider: import('./types').Provider,
  providerId: string,
  model: string,
  openaiBody: Record<string, unknown>,
  originalStream: boolean,
  route: 'messages' | 'chat' | 'responses',
  g5Base?: unknown[],
  g5Save?: (respId: string, fullHistory: unknown[]) => void
): Promise<Response> {
  const enabledKeys = provider.apiKeys.filter((k) => k.enabled)
  if (enabledKeys.length === 0) {
    return c.json({
      error: { type: 'configuration_error', message: `提供商 "${provider.name}" 未配置可用的 API Key` },
    }, 500)
  }

  const resolvedBase = resolveProviderBaseUrl(c.env, provider.baseUrl)
  if (!resolvedBase) {
    return c.json({
      error: { type: 'configuration_error', message: `提供商 "${provider.name}" 的 baseUrl 含 {CF_ACCOUNT_ID} 占位符，但环境变量 CF_ACCOUNT_ID 未配置` },
    }, 500)
  }
  // 归一 baseUrl：去掉末尾斜杠与 /v1，统一拼 v1/messages
  //（兼容 https://api.anthropic.com 与 https://api.anthropic.com/v1 两种写法）
  let cleanBase = resolvedBase.replace(/\/+$/, '')
  cleanBase = cleanBase.replace(/\/v1\/?$/, '')
  const forwardUrl = `${cleanBase}/v1/messages`

  const upstreamBody = openAIRequestToAnthropic(openaiBody)

  // R3 风格多 Key 顺序 failover：单 key 故障（HTTP 非 2xx 或网络异常）自动切换下一个
  let response: Response | undefined
  let lastErrText = ''
  let lastStatus = 502
  for (const key of enabledKeys) {
    try {
      const r = await fetchUpstream(c.env, forwardUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key.key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
          ...buildPassthroughHeaders(c),
        },
        body: JSON.stringify(upstreamBody),
      }, originalStream === true)
      if (r.ok) { response = r; break }
      lastStatus = r.status
      lastErrText = await r.text().catch(() => '')
    } catch (err) {
      lastStatus = 502
      lastErrText = (err as Error).message || '网络错误'
    }
  }

  if (!response) {
    try { c.executionCtx.waitUntil(writeLog(c.env, 'error', `[anthropic-native] ${model} → failover 全部失败 ${forwardUrl}`, JSON.stringify({ error: lastErrText, body: summarizeRequestBody(openaiBody), url: forwardUrl }).substring(0, 4000))) } catch {}
    return c.json({
      error: { type: 'upstream_error', message: `Upstream error: ${sanitizeUpstreamError(lastErrText)}` },
    }, lastStatus as Parameters<typeof c.json>[1])
  }

  try { c.executionCtx.waitUntil(writeLog(c.env, 'request', `[anthropic-native] ${model} → 200 ${forwardUrl}`, `route=${route} stream=${originalStream}`)) } catch {}

  // ---- route: messages —— Anthropic → Anthropic，直接透传（最大保真） ----
  if (route === 'messages') {
    if (originalStream && response.body) {
      return new Response(withSSEKeepAlive(response.body, SSE_KEEPALIVE_MS, SSE_IDLE_TIMEOUT_MS), {
        status: response.status,
        statusText: response.statusText,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          'X-Accel-Buffering': 'no',
        },
      })
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: response.headers })
  }

  // ---- route: chat / responses —— Anthropic → OpenAI 反向转换 ----

  // 流式：Anthropic SSE → OpenAI SSE / Responses SSE 实时转换
  if (originalStream && response.body) {
    const so = openaiBody['stream_options'] as Record<string, unknown> | undefined
    const includeUsage = route === 'chat' ? (so === undefined ? true : so['include_usage'] === true) : true
    const conv = route === 'chat' ? createAnthropicSSEToOpenAI(model, { includeUsage }) : createAnthropicSSEToResponses(model, {
      onCompleted: g5Save && g5Base ? (info) => {
        try { g5Save(info.responseId, [...g5Base, buildG5AssistantMessage(info.textContent, info.toolCalls)]) } catch {}
      } : undefined,
    })
    const readable = new ReadableStream({
      async start(controller) {
        const decoder = new TextDecoderStream()
        const textReader = response.body!.pipeThrough(decoder).getReader()
        let lineBuffer = ''
        let currentEvent = ''
        try {
          while (true) {
            const { done, value } = await textReader.read()
            if (done) break
            lineBuffer += value
            let nl: number
            while ((nl = lineBuffer.indexOf('\n')) >= 0) {
              const line = lineBuffer.slice(0, nl)
              lineBuffer = lineBuffer.slice(nl + 1)
              const trimmed = line.trim()
              if (!trimmed) continue
              if (trimmed.startsWith('event:')) {
                currentEvent = trimmed.slice(6).trim()
              } else if (trimmed.startsWith('data:')) {
                const data = trimmed.slice(5).trim()
                if (!data) continue
                let parsed: Record<string, unknown>
                try { parsed = JSON.parse(data) as Record<string, unknown> } catch { continue }
                for (const s of conv(currentEvent, parsed)) {
                  controller.enqueue(new TextEncoder().encode(s))
                }
              }
            }
          }
        } catch { /* stream error */ }
        controller.close()
      },
    })
    return new Response(readable, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      },
    })
  }

  // 非流式：Anthropic JSON → OpenAI / Responses
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null
  const converted = route === 'chat'
    ? anthropicResponseToOpenAI(payload || {}, model)
    : anthropicResponseToResponses(payload || {}, model)
  // G5: 非流式 responses 路径保存多轮历史
  if (route === 'responses' && g5Base && g5Save) {
    try {
      const r = converted as Record<string, unknown>
      g5Save(String(r['id'] ?? ''), [
        ...g5Base,
        responsesOutputToAssistantMessage(r['output'] as Array<Record<string, unknown>> | undefined),
      ])
    } catch { /* 保存失败不影响响应 */ }
  }
  return c.json(converted)
}

const normalizeUsage = (route: string, provider: import('./types').Provider, payload: unknown): UsageMetrics | null => {
  if (route === 'responses') return normalizeResponsesUsage(payload)
  if (route === 'messages' || provider.apiType === 'anthropic') return normalizeAnthropicUsage(payload)
  return normalizeChatUsage(payload)
}

const readErrorResponse = async (response: Response): Promise<{ payload: unknown; summary: string }> => {
  const text = await response.text().catch(() => '')
  try {
    const payload: unknown = JSON.parse(text)
    return { payload, summary: summarizeError(payload) }
  } catch {
    return { payload: { error: { message: text || `HTTP ${response.status}` } }, summary: summarizeError(text || `HTTP ${response.status}`) }
  }
}

const finalizeProxyResponse = async (
  c: Context<AppEnv>,
  response: Response,
  context: AnalyticsContext,
  route: string,
): Promise<Response> => {
  const headers = new Headers(response.headers)
  headers.set('Cache-Control', 'no-store')
  if (!response.body) {
    writeAnalyticsEvent(c, { context, result: 'success', upstreamStatus: response.status })
    return new Response(null, { status: response.status, statusText: response.statusText, headers })
  }

  if (context.streamMode === 'stream') {
    // R2：单消费链——usage 探针内联进透传管道（pipeThrough）。
    // 不再 tee 出独立观察支流：旧实现里客户端断开后观察支流仍会继续读完上游
    // body；现在客户端 Cancel 会沿管道传播到上游，立即停止后续流消费。
    let usage: UsageMetrics | undefined
    const probe = createStreamUsageProbe('', (value) => {
      usage = usage ? {
        promptTokens: Math.max(usage.promptTokens, value.promptTokens),
        completionTokens: Math.max(usage.completionTokens, value.completionTokens),
        cachedTokens: Math.max(usage.cachedTokens, value.cachedTokens),
        totalTokens: Math.max(usage.totalTokens, value.totalTokens),
      } : value
    }, () => {
      // 正常流结束时写 analytics；客户端中途断开（cancel）不会走到这里
      writeAnalyticsEvent(c, { context, result: 'success', usage, upstreamStatus: response.status })
    })
    const clientStream = response.body.pipeThrough(probe)
    return new Response(clientStream, { status: response.status, statusText: response.statusText, headers })
  }

  // 非流式：不 tee（P3，避免响应体双份缓冲），先整体读一次解析 usage，再用同一份 payload 构造响应
  const contentType = headers.get('Content-Type') || ''
  if (contentType.includes('json')) {
    const payload = await response.json().catch(() => null) as unknown
    const usage = normalizeUsage(route, { apiType: 'openai' } as import('./types').Provider, payload) || undefined
    writeAnalyticsEvent(c, { context, result: 'success', usage, upstreamStatus: response.status })
    headers.delete('Content-Length')  // 重序列化后长度可能变化，去掉上游旧值
    return new Response(JSON.stringify(payload), { status: response.status, statusText: response.statusText, headers })
  }
  writeAnalyticsEvent(c, { context, result: 'success', upstreamStatus: response.status })
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

/** 测试模型连接，发送最小请求验证 */
export async function testModelConnection(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  apiType?: 'openai' | 'anthropic'
): Promise<{ success: boolean; message: string; statusCode?: number }> {
  try {
    const cleanBase = baseUrl.replace(/\/$/, '')
    // aigateway 内部始终用 OpenAI chat/completions 格式与上游通信，
    // apiType 只影响客户端侧暴露的 API 格式（Anthropic/Responses 等）。
    const url = `${cleanBase}/chat/completions`

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    // 始终用 Bearer Authorization 发 OpenAI 格式请求到上游
    headers['Authorization'] = `Bearer ${apiKey}`

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(15000),
    })

    if (response.ok) {
      return { success: true, message: '连接成功', statusCode: response.status }
    }

    let errorBody = ''
    // body 只能读一次：先取全文，再按 JSON 解析（json() 失败后 catch 里再 text()
    // 会抛 "Body has already been used. Use tee() first"——同一 body 被消费两次）
    const rawText = await response.text().catch(() => '')
    try {
      const errorData = JSON.parse(rawText) as { error?: { message?: string } }
      errorBody = errorData?.error?.message || JSON.stringify(errorData)
    } catch {
      errorBody = rawText
    }

    return {
      success: false,
      message: `HTTP ${response.status}: ${errorBody.substring(0, 200)}`,
      statusCode: response.status,
    }
  } catch (err) {
    const error = err as Error
    return {
      success: false,
      message: `连接失败: ${error.message?.substring(0, 200) || '未知错误'}`,
    }
  }
}

/** 处理 /v1/chat/completions 等 API 转发（HTTP 路径） */
export async function handleProxy(c: Context<AppEnv>): Promise<Response> {
  const url = new URL(c.req.url)
  const route = getRoute(url)
  const proxyKey = c.get('proxyKey') || null
  const proxyKeyHash = c.get('proxyKeyHash') || ''
  let context = createAnalyticsContext(c, proxyKey, proxyKeyHash, route, '', 'sync')

  try {
    const body = await c.req.json<ProxyRequestBody>()
    const model = body.model || ''
    context = createAnalyticsContext(c, proxyKey, proxyKeyHash, route, model, isStreamRequest(body) ? 'stream' : 'sync')
    const response = await forwardProxy(c, body, c.req.method)
    return finalizeProxyResponse(c, response, context, route)
  } catch (err) {
    const error = err as Error
    writeAnalyticsEvent(c, { context, result: 'failure', errorSummary: summarizeError(error) })
    return c.json({
      error: { message: error.message || '代理转发内部错误', type: 'server_error' },
    }, 500)
  }
}

/**
 * 提供商级共享识图（普通提供商模式）：provider.visionBridge 已配置且非独立桥时，
 * 含图请求自动由视觉模型链转写为文本，请求仍转发给本提供商当前的模型（model 不变）。
 * 一个提供商只配一次识图模型，其下所有模型自动受益。
 * 返回转写后的 body；主文本模型未配置/转写失败时返回错误。
 */
async function transcribeImagesForProvider(
  env: Env,
  provider: import('./types').Provider,
  forwardBody: Record<string, unknown>
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> {
  const vb = await buildVisionBridgeRequestBody(env, provider, forwardBody as ProxyRequestBody)
  if (!vb.ok || !vb.body) {
    return { ok: false, error: vb.error || '识图转写失败' }
  }
  // primary 留空时 body.model 与原始请求一致（可能是完整 provider/model 引用），
  // 转发时 model 必须保持当前 modelId，故剔除 model 后再合并
  const { model: _model, ...rest } = vb.body as Record<string, unknown>
  return { ok: true, body: { ...forwardBody, ...rest } }
}

/**
 * 转发核心逻辑：校验模型 → 路由到对应上游（opencode / qoder / oauth / 通用 Key 轮询），
 * 返回上游 Response。HTTP 路径由 handleProxy 直接返回；WS 桥接路径（ws.ts）读取其
 * 响应体并分块以 WS 文本帧回推。
 *
 * @param method 请求方法，HTTP 路径默认取 c.req.method；WS 桥接强制传 'POST'
 */
export async function forwardProxy(
  c: Context<AppEnv>,
  body: ProxyRequestBody,
  method: string = c.req.method
): Promise<Response> {
  const model = body.model

  if (!model) {
      return c.json({ error: { message: '缺少 model 参数', type: 'invalid_request_error' } }, 400)
    }

    const parsed = parseModelId(model)
    if (!parsed) {
      return c.json({
        error: {
          message: `模型格式错误 "${model}"，请使用 提供商ID/模型ID 格式`,
          type: 'invalid_request_error',
        },
      }, 400)
    }

    const { providerId, modelId } = parsed

    // 转发 Key 模型权限检查
    const proxyKey = (c as any).get('proxyKey') as import('./types').ProxyKey | undefined
    if (proxyKey?.allowedModels && proxyKey.allowedModels.length > 0) {
      if (!proxyKey.allowedModels.includes(model)) {
        return c.json({
          error: { message: `模型 "${model}" 不在当前 Key 的允许列表中`, type: 'permission_error' },
        }, 403)
      }
    }

    // uni-model 联合模型（从 aihub 移植）：一个逻辑模型名映射一组 providerId/modelId 候选，
    // 按顺序逐个递归 failover，第一个成功即返回。顶层模型 ID 形如 unimodel/xxx。
    if (providerId === UNIMODEL_PROVIDER_ID) {
      const unimodel = await getUnimodel(c.env, modelId)
      if (!unimodel) {
        return c.json({
          error: { message: `联合模型 "${modelId}" 不存在，请先在管理后台配置`, type: 'invalid_request_error' },
        }, 404)
      }
      if (!unimodel.enabled) {
        return c.json({
          error: { message: `联合模型 "${unimodel.name}" 已禁用`, type: 'model_disabled' },
        }, 403)
      }
      if (unimodel.models.length === 0) {
        return c.json({
          error: { message: `联合模型 "${unimodel.name}" 未配置候选模型`, type: 'configuration_error' },
        }, 500)
      }

      // 递归转发期间不做候选模型的 Key 权限二次校验（顶层 unimodel/xxx 已校验通过即可访问组内全部候选）
      const savedProxyKey = (c as any).get('proxyKey')
      ;(c as any).set('proxyKey', undefined)
      try {
        let lastError: { status: number; data: string } | null = null
        for (const ref of unimodel.models) {
          let resp: Response
          try {
            resp = await forwardProxy(c, { ...body, model: ref }, method)
          } catch (err) {
            lastError = { status: 502, data: err instanceof Error ? err.message : String(err) }
            continue
          }
          if (resp.status >= 200 && resp.status < 300) {
            try { c.executionCtx.waitUntil(writeLog(c.env, 'request', `[联合模型 ${unimodel.name}] ${model} → ${ref} 成功`)) } catch { /* log failure must not break */ }
            return resp
          }
          lastError = { status: resp.status, data: (await resp.text().catch(() => '')).substring(0, 500) }
        }
        // 全部候选失败
        return c.json({
          error: {
            message: `联合模型 "${unimodel.name}" 所有候选均失败，最后一次错误: HTTP ${lastError?.status || 502}`,
            type: 'unimodel_exhausted',
            detail: lastError?.data || '',
          },
        }, (lastError?.status || 502) as Parameters<typeof c.json>[1])
      } finally {
        ;(c as any).set('proxyKey', savedProxyKey)
      }
    }

    const provider = await getProvider(c.env, providerId)

    if (!provider) {
      return c.json({
        error: { message: `提供商 "${providerId}" 不存在`, type: 'invalid_request_error' },
      }, 404)
    }

    if (!provider.enabled) {
      return c.json({
        error: { message: `提供商 "${provider.name}" 已禁用`, type: 'provider_disabled' },
      }, 403)
    }

    const modelConfig = provider.models.find((m) => m.id === modelId)
    if (!modelConfig) {
      // P6：允许未配置模型透传开关开启时跳过"未配置"校验，模型是否有效交由上游判断
      //（适合模型频繁上架、不想每次后台手动加模型的提供商）。
      if (!provider.allowUnlistedModels) {
        return c.json({
          error: { message: `模型 "${modelId}" 未在提供商 "${provider.name}" 中配置`, type: 'invalid_request_error' },
        }, 404)
      }
    } else if (!modelConfig.enabled) {
      return c.json({
        error: { message: `模型 "${modelId}" 已禁用`, type: 'model_disabled' },
      }, 403)
    }

    const enabledKeys = provider.apiKeys.filter(k => k.enabled)
    const forwardBody = { ...body, model: modelId }
    // 缓存前缀注入：提供商勾选了该 modelId 时，在 messages 头部注入固定缓存前缀（提升前缀缓存命中率）
    await applyCachePrefixInjection(c.env, provider, modelId, forwardBody as Record<string, unknown>)
    // 思维模式引导注入：提供商勾选了该 modelId 时，在 messages 头部注入思维引导 system 提示词
    await applyThinkingInjection(c.env, provider, modelId, forwardBody as Record<string, unknown>)
    const url = new URL(c.req.url)
    const subPath = url.pathname.replace(/^\/v1\//, '') || 'chat/completions'

    // 提供商级共享识图：普通提供商配置了识图模型（visionBridge，非独立桥）后，
    // 其下所有模型自动获得图片能力——含图请求先转写为文本，再按原逻辑转发。
    if (provider.visionBridge && provider.type !== 'vision-bridge') {
      const vb = await transcribeImagesForProvider(c.env, provider, forwardBody)
      if (!vb.ok) {
        return c.json({ error: { message: vb.error, type: 'invalid_request_error' } }, 422)
      }
      Object.assign(forwardBody, vb.body)
    }

    if (isOpenCodeProvider(providerId)) {
      const response = await proxyOpenCodeRequest({
        baseUrl: provider.baseUrl,
        apiKeys: enabledKeys,
        method,
        subPath,
        search: url.search,
        body: JSON.stringify(forwardBody),
        mirrorUrls: resolveOpenCodeUrls(c.env),
        providerName: provider.name,
        // opencode 内部 key 切换 / 走 public 等关键事件透传到系统日志
        logger: (level, message, details) => {
          const logType = level === 'info' ? 'request' : level
          try {
            c.executionCtx.waitUntil(writeLog(c.env, logType, `${message} [${model}]`, details))
          } catch { /* log failure must not break */ }
        },
      })
      // OpenCode 路径之前缺少日志记录，导致请求成功但后台无记录
      const logLevel = response.ok ? 'request' : (response.status >= 500 ? 'error' : 'warn')
      try {
        const bodySummary = summarizeRequestBody(forwardBody)
        c.executionCtx.waitUntil(writeLog(c.env, logLevel,
          `[${provider.name}] ${model} → ${response.status}`,
          JSON.stringify({ providerId, subPath, body: bodySummary }).substring(0, 4000)
        ))
      } catch { /* log failure must not break */ }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    }

    // QoderWork：COSY 签名转发（flowType=qoder）。与 opencode 一样需记录日志，
    // 否则请求成功但后台无记录。
    if (isQoderProvider(providerId)) {
      const response = await proxyQoderChatRequest(c.env, provider, forwardBody as Record<string, unknown>)
      const logLevel = response.ok ? 'request' : (response.status >= 500 ? 'error' : 'warn')
      try {
        const bodySummary = summarizeRequestBody(forwardBody)
        c.executionCtx.waitUntil(writeLog(c.env, logLevel,
          `[${provider.name}] ${model} → ${response.status}`,
          JSON.stringify({ providerId, subPath, body: bodySummary }).substring(0, 4000)
        ))
      } catch { /* log failure must not break */ }
      return response
    }

    // Cline（cline2api）：refreshToken 换 accessToken 转发到 api.cline.bot，
    // 账号池在 cline/proxy.ts 内部管理（多账号自动切换），不走普通 API Key 逻辑。
    if (isClineProvider(providerId)) {
      const response = await proxyClineChatRequest(c.env, provider, forwardBody as Record<string, unknown>)
      const logLevel = response.ok ? 'request' : (response.status >= 500 ? 'error' : 'warn')
      try {
        const bodySummary = summarizeRequestBody(forwardBody)
        c.executionCtx.waitUntil(writeLog(c.env, logLevel,
          `[${provider.name}] ${model} → ${response.status}`,
          JSON.stringify({ providerId, subPath, body: bodySummary }).substring(0, 4000)
        ))
      } catch { /* log failure must not break */ }
      return response
    }

    // Vision Bridge（图片转写桥）：把图片转写为文本后转发给主文本模型，
    // 让不支持图片输入的模型具备图片理解能力。见 src/vision/bridge.ts。
    if (isVisionBridgeProvider(provider)) {
      const vbResult = await buildVisionBridgeRequestBody(c.env, provider, forwardBody as ProxyRequestBody)
      if (!vbResult.ok || !vbResult.body) {
        return c.json({
          error: { message: vbResult.error || 'Vision Bridge 配置错误', type: 'invalid_request_error' },
        }, 422)
      }
      const logLevel = 'request'
      try {
        const hasImage = (Array.isArray(vbResult.body.messages) && (vbResult.body.messages as Array<{ content?: unknown }>).some(
          (m) => Array.isArray(m.content) && (m.content as Array<Record<string, unknown>>).some((p) => p?.type === 'image_url')
        ))
        c.executionCtx.waitUntil(writeLog(c.env, logLevel,
          `[vision-bridge] ${model} ${hasImage ? '含图' : '纯文本'} → primary ${vbResult.body.model}`,
          JSON.stringify({ model, primary: vbResult.body.model }).substring(0, 4000)
        ))
      } catch { /* log failure must not break */ }
      // 递归转发：vbResult.body.model 已是 primary 的 providerId/modelId 引用，
      // 走通用转发逻辑（Key 健康轮询 / OAuth / 特殊提供商均被复用）
      return await forwardProxy(c, vbResult.body as ProxyRequestBody, method)
    }

    // Gemini CLI：OAuth 授权码（flowType=gemini）转发到 cloudcode-pa.googleapis.com，
    // OpenAI 请求体先转成 Gemini generateContent 再发上游，响应解包回 OpenAI 格式。
    // 与 workbuddy/qoder 一样需记录日志。
    if (isGeminiProvider(provider)) {
      const response = await proxyGeminiChatRequest(c.env, provider, forwardBody as Record<string, unknown>)
      const logLevel = response.ok ? 'request' : (response.status >= 500 ? 'error' : 'warn')
      try {
        const bodySummary = summarizeRequestBody(forwardBody)
        c.executionCtx.waitUntil(writeLog(c.env, logLevel,
          `[${provider.name}] ${model} → ${response.status}`,
          JSON.stringify({ providerId, subPath, body: bodySummary }).substring(0, 4000)
        ))
      } catch { /* log failure must not break */ }
      return response
    }

    // CNB（cnb.cool）：免费获取 deepseek-v4，CSRF 凭证免登录免 Key。
    // 上游强制流式，网关把 OpenAI 请求体转成上游可接受的 user/assistant 序列，
    // 并把上游 SSE 转回 OpenAI 格式；开启 toolBridge 时走 XYML 工具桥（见 src/cnb/proxy.ts）。
    if (isCnbProvider(provider)) {
      try {
        const diagLog = (diag: CnbStreamDiag) => {
          // 流式收尾诊断：区分「内容未说完就停」是上游发了 [DONE](cleanEnd 且无 finish_reason，
          // 被网关补报 stop) 还是上游直接关流(cleanEnd=false)。这决定客户端是否自动续写。
          try {
            const detail = JSON.stringify({ providerId, subPath, diag, toolBridge: provider.toolBridge === true }).substring(0, 2000)
            c.executionCtx.waitUntil(writeLog(c.env, diag.finalReason === 'length' ? 'warn' : 'request',
              `[${provider.name}] ${model} → stream finish=${diag.finalReason} clean=${diag.cleanEnd}`,
              detail))
          } catch { /* log failure must not break */ }
        }
        const response = await proxyCnbChatRequest(c.env, provider, forwardBody as Record<string, unknown>, diagLog)
        const logLevel = response.ok ? 'request' : (response.status >= 500 ? 'error' : 'warn')
        try {
          const bodySummary = summarizeRequestBody(forwardBody)
          c.executionCtx.waitUntil(writeLog(c.env, logLevel,
            `[${provider.name}] ${model} → ${response.status}`,
            JSON.stringify({ providerId, subPath, body: bodySummary, toolBridge: provider.toolBridge === true }).substring(0, 4000)
          ))
        } catch { /* log failure must not break */ }
        return response
      } catch (err) {
        // 异常路径也记录日志（CSRF 获取失败、重试耗尽等），否则该调用在日志里完全不可见
        try {
          const errText = (err as Error).message || String(err)
          c.executionCtx.waitUntil(writeLog(c.env, 'error',
            `[${provider.name}] ${model} → cnb 转发异常`,
            JSON.stringify({ providerId, subPath, error: errText, body: summarizeRequestBody(forwardBody) }).substring(0, 4000)
          ))
        } catch { /* log failure must not break */ }
        throw err
      }
    }

    // TRAE SOLO：免费模型多账号反代（移植自 traework2api）。账号池在 src/trae/ 内部管理
    // （积分最高者优先、1005/429/401 冷却或禁用、签到解冻），账号凭证存在 provider.apiKeys。
    if (isTraeProvider(provider)) {
      const response = await proxyTraeChatRequest(c.env, provider, forwardBody as Record<string, unknown>)
      const logLevel = response.ok ? 'request' : (response.status >= 500 ? 'error' : 'warn')
      try {
        const bodySummary = summarizeRequestBody(forwardBody)
        c.executionCtx.waitUntil(writeLog(c.env, logLevel,
          `[${provider.name}] ${model} → ${response.status}`,
          JSON.stringify({ providerId, subPath, body: bodySummary }).substring(0, 4000)
        ))
      } catch { /* log failure must not break */ }
      // 非成功响应直接返回
      if (!response.ok) return response
      // Anthropic 格式转换：TRAE 返回 OpenAI SSE，客户端期望 Anthropic SSE 时需转换
      if (provider.apiType === 'anthropic' && (forwardBody as any)?.stream !== false && response.body) {
        const acc = createAnthropicSSEAccumulator()
        const readable = new ReadableStream({
          async start(controller) {
            const decoder = new TextDecoderStream()
            const textReader = response.body!.pipeThrough(decoder).getReader()
            let lineBuffer = ''
            try {
              while (true) {
                const { done, value } = await textReader.read()
                if (done) break
                const combined = lineBuffer + value
                const lines = combined.split('\n')
                lineBuffer = lines.pop() || ''
                for (const line of lines) {
                  const trimmed = line.trim()
                  if (!trimmed.startsWith('data:')) continue
                  const data = trimmed.slice(5).trim()
                  if (!data || data === '[DONE]') continue
                  try {
                    const chunk = JSON.parse(data)
                    cleanChunkDelta(chunk)
                    const anthropicSSE = openAIChunkToAnthropicSSE(chunk, acc)
                    if (anthropicSSE) controller.enqueue(new TextEncoder().encode(anthropicSSE))
                  } catch { /* skip malformed */ }
                }
              }
              if (lineBuffer.trim().startsWith('data:')) {
                const data = lineBuffer.trim().slice(5).trim()
                if (data && data !== '[DONE]') {
                  try {
                    const chunk = JSON.parse(data)
                    cleanChunkDelta(chunk)
                    const anthropicSSE = openAIChunkToAnthropicSSE(chunk, acc)
                    if (anthropicSSE) controller.enqueue(new TextEncoder().encode(anthropicSSE))
                  } catch { /* skip */ }
                }
              }
            } catch { /* stream error */ }
            const finalizeDiag = diagnoseAnthropicAccumulator(acc)
            const finalized = finalizeAnthropicStream(acc)
            if (finalized) {
              try { controller.enqueue(new TextEncoder().encode(finalized)) } catch { /* enqueue failed */ }
              try {
                c.executionCtx.waitUntil(writeLog(c.env, 'warn',
                  `[${provider.name}] 流结束兜底触发 ${model}`,
                  JSON.stringify({ providerId: provider.id, model, ...finalizeDiag })
                ))
              } catch { /* log failure must not break */ }
            }
            controller.close()
          },
        })
        return new Response(withSSEKeepAlive(readable, SSE_KEEPALIVE_MS, SSE_IDLE_TIMEOUT_MS), {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
            'X-Accel-Buffering': 'no',
          },
        })
      }
      return response
    }

    // M365 Copilot：ChatHub WS 对话（OAuth flowType ∈ m365-pkce/m365-ropc），
    // 协议适配与 WS 会话承载在 Durable Object（env.M365_SESSION）中完成，
    // 网关透传 DO 返回的 OpenAI SSE/JSON。
    if (isM365Provider(provider)) {
      const response = await proxyM365ChatRequest(c.env, provider, forwardBody as Record<string, unknown>, {
        explicitSessionId: c.req.header('X-M365-Session-Id') || '',
        ip: c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || '',
        userAgent: c.req.header('user-agent') || '',
      })
      const logLevel = response.ok ? 'request' : (response.status >= 500 ? 'error' : 'warn')
      try {
        const bodySummary = summarizeRequestBody(forwardBody)
        c.executionCtx.waitUntil(writeLog(c.env, logLevel,
          `[${provider.name}] ${model} → ${response.status}`,
          JSON.stringify({ providerId, subPath, body: bodySummary }).substring(0, 4000)
        ))
      } catch { /* log failure must not break */ }
      return response
    }

    // OAuth 设备码提供商：使用 KV 中保存的 access_token 转发，401 时尝试刷新后重试
    if (provider.authType === 'oauth-device' && provider.oauth) {
      return await proxyOAuthRequest(c, provider, subPath, url.search, forwardBody, method)
    }

    // Anthropic 原生上游（provider.apiType === 'anthropic'，如 api.anthropic.com）：
    // 请求体/认证头/路径都转成 Anthropic 原生格式，响应再按客户端 route 转回 OpenAI
    if (provider.apiType === 'anthropic' && subPath === 'chat/completions') {
      return await proxyAnthropicNativeUpstream(
        c,
        provider,
        providerId,
        modelId,
        forwardBody as Record<string, unknown>,
        isStreamRequest(forwardBody as ProxyRequestBody),
        'chat',
      )
    }

    if (enabledKeys.length === 0) {
      return c.json({
        error: { message: `提供商 "${provider.name}" 未配置可用的 API Key`, type: 'configuration_error' },
      }, 500)
    }

    const resolvedBase = resolveProviderBaseUrl(c.env, provider.baseUrl)
    if (!resolvedBase) {
      return c.json({
        error: { message: `提供商 "${provider.name}" 的 baseUrl 含 {CF_ACCOUNT_ID} 占位符，但环境变量 CF_ACCOUNT_ID 未配置`, type: 'configuration_error' },
      }, 500)
    }
    const cleanBase = resolvedBase.replace(/\/$/, '')
    const forwardUrl = `${cleanBase}/${subPath}${url.search}`

    // 按健康状态排序 key：健康→洗牌，不健康→末尾，冷却到期→试用，连续失败3次→降权排除
    const healthData = await readHealth(c.env, providerId)
    const healthy: number[] = []
    const unhealthy: number[] = []
    const probation: number[] = []
    const demoted: number[] = []

    if (enabledKeys.length === 1) {
      // 只有一个 key，跳过健康检查，直接使用
      healthy.push(0)
    } else {
      for (let i = 0; i < enabledKeys.length; i++) {
        const h = healthData[enabledKeys[i].key]
        if (h && h.failures >= KEY_HEALTH_MAX_FAILURES) {
          // 兼容旧数据：无 demotedAt 视为现在刚降权，统一走冷却逻辑
          if (!h.demotedAt) {
            h.demotedAt = Date.now()
          }
          if (Date.now() - h.demotedAt >= KEY_HEALTH_COOLDOWN_MS) {
            probation.push(i)  // 冷却到期，进入试用组
          } else {
            demoted.push(i)    // 仍在冷却，继续保持降权
          }
        } else if (h && h.lastFailed) {
          unhealthy.push(i)
        } else {
          healthy.push(i)
        }
      }
    }

    // Fisher-Yates 洗牌（仅健康 key）
    for (let i = healthy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [healthy[i], healthy[j]] = [healthy[j], healthy[i]]
    }

    const keyOrder = [...healthy, ...unhealthy, ...probation]

    // 所有 key 都在冷却中时，降级尝试 demoted key（修复旧数据缺失 demotedAt 的死循环）
    if (keyOrder.length === 0 && demoted.length > 0) {
      keyOrder.push(...demoted)
      console.log(`[proxy] ${providerId}: all keys demoted, falling back to ${demoted.length} key(s)`)
    }

    if (demoted.length > 0 || probation.length > 0) {
      console.log(`[proxy] ${providerId}: ${demoted.length} key(s) demoted, ${probation.length} key(s) on probation (cooldown expired)`)
    }

    let lastError: Response | null = null
    let healthUpdated = false

    for (const keyIndex of keyOrder) {
      const apiKey = enabledKeys[keyIndex].key
      // 提升到 try/catch 外层，供 catch 分支做瞬时错误重试时复用
      const forwardHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        // P7：白名单前缀头（x- / anthropic- / user-）透传，供上游识别客户端
        ...buildPassthroughHeaders(c),
      }
      const requestBody = JSON.stringify(forwardBody)
      const isStream = isStreamRequest(forwardBody as ProxyRequestBody)
      try {
        // 瞬时错误自动重试：对同一 key 的瞬时 5xx / 网络抖动重试，
        // 消除"偶发 500/断连，客户端重试一次又正常"的体验问题。
        let response = await fetchUpstream(c.env, forwardUrl, {
          method,
          headers: forwardHeaders,
          body: requestBody,
        }, isStream)
        let transientRetries = 0
        while (isTransientStatus(response.status) && transientRetries < TRANSIENT_RETRY_MAX) {
          transientRetries++
          try { c.executionCtx.waitUntil(writeLog(c.env, 'warn', `[${provider.name}] ${model} → 瞬时 ${response.status}，${transientRetries}/${TRANSIENT_RETRY_MAX} 次重试`)) } catch {}
          await new Promise((r) => setTimeout(r, TRANSIENT_RETRY_DELAY_MS * transientRetries))
          response = await fetchUpstream(c.env, forwardUrl, {
            method,
            headers: forwardHeaders,
            body: requestBody,
          }, isStream)
        }

        if (response.ok) {
          // 成功：重置健康状态
          if (healthData[apiKey]?.failures > 0) {
            delete healthData[apiKey]
            healthUpdated = true
          }
          if (healthUpdated) await writeHealth(c.env, providerId, healthData)

          try { c.executionCtx.waitUntil(writeLog(c.env, 'request', `[${provider.name}] ${model} → 200`, `provider=${providerId}`)) } catch {}
          return passthroughResponse(response)
        }

        // 429 限流：跳过当前 key，不标记失败
        if (response.status === 429) {
          lastError = response
          continue
        }

        // 401/403/5xx 尝试下一个 key（标记失败）
        if (response.status === 401 || response.status === 403 || response.status >= 500) {
          const h = healthData[apiKey] || { failures: 0, lastFailed: false }
          h.failures++
          h.lastFailed = true
          if (h.failures >= KEY_HEALTH_MAX_FAILURES) {
            h.demotedAt = Date.now()  // 达到降权阈值或试用失败，重置冷却计时
          }
          healthData[apiKey] = h
          healthUpdated = true
          lastError = response
          continue
        }

        // 其他错误（400/404 等）直接返回。
        // body 只能读一次：json() 失败后再 text() 会抛 "Body has already been used"，
        // 改为先取全文再 JSON.parse。
        const errRaw = await response.text().catch(() => '')
        let errorData: any = { error: { message: errRaw || `HTTP ${response.status}` } }
        try {
          const parsed = JSON.parse(errRaw)
          if (parsed && typeof parsed === 'object') errorData = parsed
        } catch { /* 非 JSON，保留原文 */ }
        try { c.executionCtx.waitUntil(writeLog(c.env, 'error', `[${provider.name}] ${model} → ${response.status} ${forwardUrl}`, JSON.stringify({ error: errorData, body: summarizeRequestBody(forwardBody), url: forwardUrl }).substring(0, 4000))) } catch {}
        return c.json(errorData, response.status as Parameters<typeof c.json>[1])
      } catch (err) {
        const error = err as Error
        // 网络异常/连接被重置等瞬时错误：对同一 key 短暂退避后重试 1 次，
        // 多数情况下重试即恢复（对应客户端"重试一次又正常"的现象）。
        let lastErr: Error = error
        let netRetries = 0
        while (netRetries < TRANSIENT_RETRY_MAX) {
          netRetries++
          try { c.executionCtx.waitUntil(writeLog(c.env, 'warn', `[${provider.name}] ${model} → 网络瞬时错误，${netRetries}/${TRANSIENT_RETRY_MAX} 次重试: ${String(error.message || error).substring(0, 200)}`)) } catch {}
          await new Promise((r) => setTimeout(r, TRANSIENT_RETRY_DELAY_MS * netRetries))
          try {
            const retryResp = await fetchUpstream(c.env, forwardUrl, {
              method,
              headers: forwardHeaders,
              body: requestBody,
            }, isStream)
            if (retryResp.ok) {
              if (healthData[apiKey]?.failures > 0) {
                delete healthData[apiKey]
                healthUpdated = true
                await writeHealth(c.env, providerId, healthData)
              }
              try { c.executionCtx.waitUntil(writeLog(c.env, 'request', `[${provider.name}] ${model} → 200（重试成功）`)) } catch {}
              return passthroughResponse(retryResp)
            }
            // 重试返回了瞬时 5xx，继续下一轮；确定性错误则直接按原逻辑处理
            if (!isTransientStatus(retryResp.status)) {
              lastErr = new Error(`HTTP ${retryResp.status}`)
              if (retryResp.status === 401 || retryResp.status === 403 || retryResp.status >= 500) {
                const rh = healthData[apiKey] || { failures: 0, lastFailed: false }
                rh.failures++
                rh.lastFailed = true
                if (rh.failures >= KEY_HEALTH_MAX_FAILURES) rh.demotedAt = Date.now()
                healthData[apiKey] = rh
                healthUpdated = true
              }
              lastError = retryResp
              break
            }
          } catch (retryErr) {
            lastErr = retryErr as Error
          }
        }
        if (lastError) continue
        // 重试耗尽仍失败，标记健康状态并切下一个 key
        const h = healthData[apiKey] || { failures: 0, lastFailed: false }
        h.failures++
        h.lastFailed = true
        if (h.failures >= KEY_HEALTH_MAX_FAILURES) {
          h.demotedAt = Date.now()  // 达到降权阈值或试用失败，重置冷却计时
        }
        healthData[apiKey] = h
        healthUpdated = true
        lastError = new Response(JSON.stringify({
          error: { message: lastErr.message || '请求失败', type: 'proxy_error' },
        }), { status: 502 })
        continue
      }
    }

    // 写回健康状态
    if (healthUpdated) await writeHealth(c.env, providerId, healthData)

    // 所有 key 均失败
    if (lastError) {
      const errorBody = await lastError.text().catch(() => '所有 API Key 均失败')
      return c.json({
        error: {
          message: `所有 API Key 已用完，最后一次错误: HTTP ${lastError.status}`,
          type: 'key_exhausted',
          detail: errorBody.substring(0, 500),
        },
      }, (lastError.status || 502) as Parameters<typeof c.json>[1])
    }

    return c.json({
      error: { message: '没有可用的 API Key', type: 'configuration_error' },
    }, 500)
}

/**
 * OAuth 设备码提供商转发：取 token → 注入请求头 → 转发；401 时刷新 token 重试，
 * 刷新后仍 401 则自动切换域重试（Global ↔ CN）。
 * 参考 cpa-plugin/models.go 的域路由逻辑。
 */
/** 记录 OAuth 代理请求日志（复用 forwardProxy 的日志格式，与 opencode/qoder 等一致） */
function logOAuthRequest(c: Context<AppEnv>, provider: import('./types').Provider, model: string, subPath: string, forwardBody: object, status: number) {
  const logLevel = status >= 200 && status < 300 ? 'request' : (status >= 500 ? 'error' : 'warn')
  try {
    const bodySummary = summarizeRequestBody(forwardBody as Record<string, unknown>)
    c.executionCtx.waitUntil(writeLog(c.env, logLevel,
      `[${provider.name}] ${model} → ${status}`,
      JSON.stringify({ providerId: provider.id, subPath, body: bodySummary }).substring(0, 4000)
    ))
  } catch { /* log failure must not break */ }
}

async function proxyOAuthRequest(
  c: Context<AppEnv>,
  provider: import('./types').Provider,
  subPath: string,
  search: string,
  forwardBody: object,
  method: string = c.req.method
): Promise<Response> {
  const cfg = provider.oauth!
  const model = (forwardBody as Record<string, unknown>).model as string

  // 先从 KV 读取 token 状态（含 cookies）
  let tokenState = await readOauthToken(c.env, provider.id)

  // 域路由：根据 token 的 JWT iss 决定走 CN (copilot.tencent.com) 还是 Global (www.workbuddy.ai)。
  const resolveRealm = (token: string): 'cn' | 'global' => {
    return detectTokenRealm(token) === 'global' ? 'global' : 'cn'
  }
  const buildForwardUrl = (realm: 'cn' | 'global') => {
    const realmBase = (realm === 'global' && cfg.globalBaseUrl ? cfg.globalBaseUrl : provider.baseUrl).replace(/\/$/, '')
    return `${realmBase}/${subPath}${search}`
  }
  const buildOrigin = (realm: 'cn' | 'global') => {
    return realm === 'global' && cfg.globalOrigin ? cfg.globalOrigin : (cfg.extraHeaders?.Origin)
  }
  // 备用域（401 自动切换用）：CN token 不尝试 Global 域
  const altRealm = (realm: 'cn' | 'global'): 'cn' | 'global' | null => {
    if (realm === 'cn') return null  // CN token 在 Global 域必然 401，不浪费请求
    if (realm === 'global') return 'cn'
    return null
  }

  const doFetch = (token: string, realm?: 'cn' | 'global') => {
    const r = realm || resolveRealm(token)
    const body = { ...forwardBody } as Record<string, unknown>
    // WorkBuddy 只支持流式请求，强制 stream: true（所有以 workbuddy 开头的 provider ID）
    const originalStream = body.stream
    if (provider.id.startsWith('workbuddy') && body.stream !== true) {
      body.stream = true
    }
    return fetchUpstream(c.env, buildForwardUrl(r), {
      method,
      headers: buildOauthHeaders(cfg, token, { origin: buildOrigin(r), apiType: provider.apiType, cookies: tokenState?.cookies }),
      body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body),
    }, (body as Record<string, unknown>).stream === true || provider.id.startsWith('workbuddy')).then(resp => ({ resp, originalStream }))
  }

  // 瞬时错误自动重试：对同一 token 的瞬时 5xx / 网络抖动重试 1 次，
  // 消除"偶发 500，客户端重试一次又正常"的体验问题（复用 doFetch 的流式/非流式语义）。
  const doFetchWithRetry = async (token: string, realm?: 'cn' | 'global') => {
    let result = await doFetch(token, realm)
    let transientRetries = 0
    while (isTransientStatus(result.resp.status) && transientRetries < TRANSIENT_RETRY_MAX) {
      transientRetries++
      try { c.executionCtx.waitUntil(writeLog(c.env, 'warn', `[${provider.name}] ${model} → 瞬时 ${result.resp.status}，${transientRetries}/${TRANSIENT_RETRY_MAX} 次重试`)) } catch {}
      await new Promise((r) => setTimeout(r, TRANSIENT_RETRY_DELAY_MS * transientRetries))
      result = await doFetch(token, realm)
    }
    return result
  }

  try {
    let token = tokenState?.access_token ?? null
    if (!token) {
      // 尝试用 refresh_token 刷新一次
      const refreshed = await refreshOauthToken(c.env, provider.id, cfg)
      if (refreshed) {
        const freshState = await readOauthToken(c.env, provider.id)
        if (freshState) {
          tokenState = freshState
          token = freshState.access_token ?? null
        }
      }
    }
    if (!token) {
      logOAuthRequest(c, provider, model, subPath, forwardBody, 502)
      return c.json({
        error: { message: 'OAuth 未连接或 Token 已失效，请在管理后台重新授权', type: 'oauth_not_connected' },
      }, 502)
    }

    const primaryRealm = resolveRealm(token)
    let { resp: response, originalStream } = await doFetchWithRetry(token)

    // 401/403：可能 token 过期，刷新后重试一次
    if ((response.status === 401 || response.status === 403) && tokenState?.refresh_token) {
      const refreshed = await refreshOauthToken(c.env, provider.id, cfg)
      if (refreshed) {
        const freshState = await readOauthToken(c.env, provider.id)
        if (freshState) {
          tokenState = freshState
          const retry = await doFetchWithRetry(freshState.access_token)
          response = retry.resp
          originalStream = retry.originalStream
        }
      }
    }

    // 刷新后仍 401：自动切换域重试（Global ↔ CN）
    if (response.status === 401) {
      const alt = altRealm(primaryRealm)
      if (alt) {
        console.log(`[proxy-oauth] ${primaryRealm} 域 401，自动切换到 ${alt} 域重试`)
        const altResult = await doFetchWithRetry(token, alt)
        if (altResult.resp.ok || altResult.resp.status !== 401) {
          response = altResult.resp
          originalStream = altResult.originalStream
        }
      }
    }

    // WorkBuddy 非流式请求：收集 SSE 流并聚合成非流式 chat.completion 返回
    // 注意：WorkBuddy 上游 API 不直接支持非流式请求，必须发流式请求再聚合。
    // 所有以 workbuddy 开头的 provider ID 均需此处理（workbuddy, workbuddy2 等）。
    if (response.ok && originalStream !== true && provider.id.startsWith('workbuddy') && response.body) {
      try {
        const aggregated = await aggregateWorkbuddySSE(response.body, (forwardBody as Record<string, unknown>).model as string)
        logOAuthRequest(c, provider, model, subPath, forwardBody, 200)
        return new Response(aggregated, {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        })
      } catch (aggErr) {
        console.error('[proxy-oauth] SSE aggregation failed:', aggErr)
        // 聚合失败，回退到透传（客户端可能能处理）
      }
    }

    // 诊断：WorkBuddy 流式透传前，统计上游响应实际字节数并采样内容。
    // 用于区分 "Trae 收到的为空响应" 与 "上游正常返回但客户端解析为空"。
    if (provider.id.startsWith('workbuddy') && originalStream === true && response.status === 200 && response.body) {
      const [countStream, teeStream] = response.body.tee()
      const counter = (async () => {
        let bytes = 0
        let sample = ''
        const rr = countStream.getReader()
        try {
          while (true) {
            const { done, value } = await rr.read()
            if (done) break
            bytes += value?.byteLength || 0
            if (sample.length < 1500) sample += new TextDecoder().decode(value).slice(0, 1500 - sample.length)
          }
        } catch { /* ignore */ }
        return { bytes, sample }
      })()
      c.executionCtx.waitUntil(counter.then(({ bytes, sample }) =>
        writeLog(c.env, 'request',
          `[WorkBuddyDebug] ${model} → 上游响应字节`,
          `HTTP ${response.status}, bytes=${bytes}, stream=${originalStream}\nSAMPLE: ${sample}`
        ).catch(() => {})
      ))
      const respForLog = new Response(teeStream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
      logOAuthRequest(c, provider, model, subPath, forwardBody, response.status)
      return passthroughResponse(respForLog, cleanWorkbuddyChunk)
    }

    logOAuthRequest(c, provider, model, subPath, forwardBody, response.status)
    return passthroughResponse(response, cleanWorkbuddyChunk)
  } catch (err) {
    const error = err as Error
    logOAuthRequest(c, provider, model, subPath, forwardBody, 502)
    return c.json({
      error: { message: `OAuth 转发失败: ${error.message || '未知错误'}`, type: 'proxy_error' },
    }, 502)
  }
}

/** 处理 /v1/models — 返回所有已启用的模型（含提供商前缀）。
 * 全量列表在内存中缓存（TTL 同 providers，可经管理后台「内存缓存」查看/清空），
 * 之后按转发 Key 的 allowedModels 逐请求过滤；并回写 Cache-Control 让客户端/CDN 缓存。 */
export async function handleModels(c: Context<AppEnv>) {
  const cached = getModelsListCache()
  let models: Array<{
    id: string
    provider: string
    provider_name: string
    object: string
    created: number
    owned_by: string
  }> = cached ? JSON.parse(cached) : []

  if (!cached) {
    const providers = await getProviders(c.env)
    const nowTs = Math.floor(Date.now() / 1000)
    for (const provider of providers) {
      if (!provider.enabled) continue
      for (const model of provider.models) {
        if (!model.enabled) continue
        const fullId = `${provider.id}/${model.id}`
        models.push({
          id: fullId,
          provider: provider.id,
          provider_name: provider.name,
          object: 'model',
          created: nowTs,
          owned_by: provider.id,
        })
      }
    }
    // 注入联合模型（uni-model）条目（模型 ID 形如 unimodel/xxx）
    const unimodels = await getUnimodels(c.env)
    for (const um of unimodels) {
      if (!um.enabled) continue
      const fullId = `${UNIMODEL_PROVIDER_ID}/${um.name}`
      models.push({
        id: fullId,
        provider: UNIMODEL_PROVIDER_ID,
        provider_name: '联合模型',
        object: 'model',
        created: nowTs,
        owned_by: UNIMODEL_PROVIDER_ID,
      })
    }
    setModelsListCache(JSON.stringify(models))
  }

  // 从中间件获取转发 Key（可能带有 allowedModels 过滤）—— 过滤在缓存之后，保证各 Key 命中同一份全量列表
  const proxyKey = (c as any).get('proxyKey') as import('./types').ProxyKey | undefined
  const allowed = proxyKey?.allowedModels
  const allowSet = allowed && allowed.length > 0 ? new Set(allowed) : null
  const filtered = allowSet ? models.filter((m) => allowSet.has(m.id)) : models

  c.header('Cache-Control', 'public, max-age=10')
  return c.json({
    object: 'list',
    data: filtered,
  })
}

// ============================================================
//  Anthropic Messages API 代理  /v1/messages
//  将 Anthropic 格式请求转为 OpenAI Chat Completions，
//  调用 WorkBuddy 上游，再将响应转回 Anthropic 格式。
// ============================================================

export async function handleAnthropicMessages(c: Context<AppEnv>) {
  try {
    const anthropicBody = await c.req.json<Record<string, unknown>>()
    const model = anthropicBody['model'] as string

    if (!model) {
      return c.json({ type: 'error', error: { type: 'invalid_request_error', message: 'Missing model' } }, 400)
    }

    // 解析 providerId/modelId 格式
    const parsed = parseModelId(model)
    if (!parsed) {
      return c.json({
        type: 'error',
        error: { type: 'invalid_request_error', message: `Invalid model format "${model}", use providerId/modelId` },
      }, 400)
    }

    const { providerId, modelId } = parsed

    // 权限检查
    const proxyKey = (c as any).get('proxyKey') as import('./types').ProxyKey | undefined
    if (proxyKey?.allowedModels && proxyKey.allowedModels.length > 0) {
      if (!proxyKey.allowedModels.includes(model)) {
        return c.json({
          type: 'error',
          error: { type: 'permission_error', message: `Model "${model}" not allowed for this key` },
        }, 403)
      }
    }

    const provider = await getProvider(c.env, providerId)
    if (!provider) {
      return c.json({
        type: 'error',
        error: { type: 'invalid_request_error', message: `Provider "${providerId}" not found` },
      }, 404)
    }
    if (!provider.enabled) {
      return c.json({
        type: 'error',
        error: { type: 'provider_disabled', message: `Provider "${provider.name}" is disabled` },
      }, 403)
    }

    const modelConfig = provider.models.find((m) => m.id === modelId)
    if (!modelConfig) {
      return c.json({
        type: 'error',
        error: { type: 'invalid_request_error', message: `Model "${modelId}" not configured` },
      }, 404)
    }

    // Anthropic → OpenAI 转换
    const anthropicReq = anthropicBody as any
    const openaiBody = anthropicToOpenAI(anthropicReq)
    // 替换为上游模型 ID
    openaiBody['model'] = modelId
    // 缓存前缀注入：提供商勾选该模型时，在 messages 头部注入固定缓存前缀（提升前缀缓存命中率）
    await applyCachePrefixInjection(c.env, provider, modelId, openaiBody)
    // 思维模式引导注入：提供商勾选该模型时，在 messages 头部注入思维引导 system 提示词
    await applyThinkingInjection(c.env, provider, modelId, openaiBody)

    const originalStream = anthropicReq.stream === true

    // 提供商级共享识图：普通提供商配置识图模型后，Anthropic 格式含图请求同样自动转写
    if (provider.visionBridge && provider.type !== 'vision-bridge') {
      const vb = await transcribeImagesForProvider(c.env, provider, openaiBody)
      if (!vb.ok) {
        return c.json({
          type: 'error',
          error: { type: 'invalid_request_error', message: vb.error },
        }, 422)
      }
      Object.assign(openaiBody, vb.body)
    }

    // QoderWork：COSY 签名转发（Anthropic 格式）。上游只收 OpenAI 格式流式，
    // 由 proxyQoderChatRequest 转发后返回 OpenAI SSE，这里再转回 Anthropic SSE。
    if (isQoderProvider(provider.id)) {
      return await handleAnthropicQoder(c, provider, model, openaiBody, originalStream)
    }

    // Cline：refreshToken 换 token 转发（OpenAI 格式），再转回 Anthropic SSE。
    if (isClineProvider(provider.id)) {
      return await handleAnthropicCline(c, provider, model, openaiBody, originalStream)
    }

    // Gemini：OAuth 授权码转发（OpenAI 格式），再转回 Anthropic SSE。
    if (isGeminiProvider(provider)) {
      return await handleAnthropicGemini(c, provider, model, openaiBody, originalStream)
    }

    // CNB：CSRF 凭证转发（OpenAI 格式），再转回 Anthropic SSE。
    if (isCnbProvider(provider)) {
      return await handleAnthropicCnb(c, provider, model, openaiBody, originalStream)
    }

    // M365 Copilot：OAuth 授权码转发（OpenAI 格式），再转回 Anthropic SSE。
    if (isM365Provider(provider)) {
      return await handleAnthropicM365(c, provider, model, openaiBody, originalStream)
    }

    // Vision Bridge：图片转写后转发给主文本模型（OpenAI 格式），再转回 Anthropic 格式。
    if (isVisionBridgeProvider(provider)) {
      return await handleAnthropicVisionBridge(c, provider, model, openaiBody, originalStream)
    }

    // OAuth 提供商走 OAuth 代理路径
    if (provider.authType === 'oauth-device' && provider.oauth) {
      const cfg = provider.oauth
      // 强制流式（WorkBuddy 只支持流式）
      const upstreamBody: Record<string, unknown> = { ...openaiBody, stream: true }
      // 清理上游不支持的字段 + 被屏蔽的 Claude Code 模板短语
      sanitizeUpstreamBody(upstreamBody)
      sanitizeBlockedTemplates(upstreamBody)
      // max_completion_tokens → max_tokens（部分上游只认 max_tokens）
      if (upstreamBody['max_completion_tokens'] !== undefined && upstreamBody['max_tokens'] === undefined) {
        upstreamBody['max_tokens'] = upstreamBody['max_completion_tokens']
        delete upstreamBody['max_completion_tokens']
      }
      // 清理被 CodeBuddy 内容过滤器屏蔽的 Claude Code 模板短语
      sanitizeBlockedTemplates(upstreamBody)

      // 读取 token 状态
      let tokenState = await readOauthToken(c.env, providerId)
      if (!tokenState?.access_token) {
        // 尝试刷新
        const refreshed = await refreshOauthToken(c.env, providerId, cfg)
        if (refreshed) tokenState = await readOauthToken(c.env, providerId)
      }
      if (!tokenState?.access_token) {
        return c.json({
          type: 'error',
          error: { type: 'authentication_error', message: 'OAuth token not available. Please login first.' },
        }, 401)
      }

      // 域路由：根据 JWT iss 判断 CN vs Global
      const realm = detectTokenRealm(tokenState.access_token)
      const isGlobal = realm === 'global'
      const realmBase = (isGlobal && cfg.globalBaseUrl ? cfg.globalBaseUrl : provider.baseUrl).replace(/\/$/, '')
      const origin = isGlobal && cfg.globalOrigin ? cfg.globalOrigin : (cfg.extraHeaders?.Origin)
      const upstreamUrl = `${realmBase}/chat/completions`

      // Global 域需要 system message
      if (isGlobal) {
        const msgs = upstreamBody['messages'] as any[]
        if (msgs && !msgs.some((m: any) => m.role === 'system')) {
          msgs.unshift({ role: 'system', content: 'You are a helpful assistant.' })
        }
      }

      const headers = buildOauthHeaders(cfg, tokenState.access_token, {
        origin,
        cookies: tokenState.cookies,
      })

      let response = await fetchUpstream(c.env, upstreamUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(upstreamBody),
      }, originalStream === true)

      // 401/403 时刷新 token 重试
      if ((response.status === 401 || response.status === 403) && tokenState.refresh_token) {
        const refreshed = await refreshOauthToken(c.env, providerId, cfg)
        if (refreshed) {
          const freshState = await readOauthToken(c.env, providerId)
          if (freshState?.access_token) {
            const retryHeaders = buildOauthHeaders(cfg, freshState.access_token, {
              origin,
              cookies: freshState.cookies,
            })
            response = await fetchUpstream(c.env, upstreamUrl, {
              method: 'POST',
              headers: retryHeaders,
              body: JSON.stringify(upstreamBody),
            }, originalStream === true)
          }
        }
      }

      if (!response.ok) {
        const errText = await response.text()
        try {
          const bodySummary = summarizeRequestBody(upstreamBody)
          c.executionCtx.waitUntil(writeLog(c.env, 'error', `[anthropic] ${model} → ${response.status} ${upstreamUrl}`, JSON.stringify({ error: errText, body: bodySummary, url: upstreamUrl }).substring(0, 4000)))
        } catch { /* log failure must not break request */ }
        return c.json({
          type: 'error',
          error: { type: 'upstream_error', message: `Upstream error: ${sanitizeUpstreamError(errText)}` },
        }, response.status as Parameters<typeof c.json>[1])
      }

      try { c.executionCtx.waitUntil(writeLog(c.env, 'request', `[anthropic] ${model} → 200 ${upstreamUrl}`, `stream=${originalStream}`)) } catch {}

      // 流式：OpenAI SSE → Anthropic SSE 实时转换
      if (originalStream && response.body) {
        const acc = createAnthropicSSEAccumulator()
        const readable = new ReadableStream({
          async start(controller) {
            const decoder = new TextDecoderStream()
            const textReader = response.body!.pipeThrough(decoder).getReader()
            let lineBuffer = ''

            try {
              while (true) {
                const { done, value } = await textReader.read()
                if (done) break
                const combined = lineBuffer + value
                const lines = combined.split('\n')
                lineBuffer = lines.pop() || ''

                for (const line of lines) {
                  const trimmed = line.trim()
                  if (!trimmed.startsWith('data:')) continue
                  const data = trimmed.slice(5).trim()
                  if (!data || data === '[DONE]') continue

                  try {
                    const chunk = JSON.parse(data)
                    // 清洗 WorkBuddy 噪音
                    cleanChunkDelta(chunk)
                    const anthropicSSE = openAIChunkToAnthropicSSE(chunk, acc)
                    if (anthropicSSE) {
                      controller.enqueue(new TextEncoder().encode(anthropicSSE))
                    }
                  } catch { /* skip malformed */ }
                }
              }
              // 处理剩余缓冲
              if (lineBuffer.trim().startsWith('data:')) {
                const data = lineBuffer.trim().slice(5).trim()
                if (data && data !== '[DONE]') {
                  try {
                    const chunk = JSON.parse(data)
                    cleanChunkDelta(chunk)
                    const anthropicSSE = openAIChunkToAnthropicSSE(chunk, acc)
                    if (anthropicSSE) {
                      controller.enqueue(new TextEncoder().encode(anthropicSSE))
                    }
                  } catch { /* skip */ }
                }
              }
            } catch { /* stream error */ }
            // 流结束兜底：补发缺失的 content_block_stop / message_stop 事件。
            // 上游偶尔未正常发送 finish_reason，或在 tool_use 块未关闭时就结束流，
            // 会导致客户端报 "truncated: stream ended"。此处保证流的正确结束，
            // 并在触发兜底时记录诊断日志（含 tool_use 名称/id），便于定位问题工具调用。
            const finalizeDiag = diagnoseAnthropicAccumulator(acc)
            const finalized = finalizeAnthropicStream(acc)
            if (finalized) {
              try {
                controller.enqueue(new TextEncoder().encode(finalized))
              } catch { /* enqueue failed */ }
              // 仅在确实补发了事件时记录 warn 日志（正常结束不会触发）
              try {
                c.executionCtx.waitUntil(writeLog(c.env, 'warn',
                  `[anthropic] 流结束兜底触发 ${model}`,
                  JSON.stringify({ providerId: provider.id, model, ...finalizeDiag })
                ))
              } catch { /* log failure must not break */ }
            }
            controller.close()
          },
        })

        return new Response(withSSEKeepAlive(readable, SSE_KEEPALIVE_MS, SSE_IDLE_TIMEOUT_MS), {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
            'X-Accel-Buffering': 'no',
          },
        })
      }

      // 非流式：收集所有 OpenAI SSE → 聚合 → Anthropic
      const allChunks: any[] = []
      const decoder2 = new TextDecoderStream()
      const textReader2 = response.body!.pipeThrough(decoder2).getReader()
      let lineBuffer2 = ''

      try {
        while (true) {
          const { done, value } = await textReader2.read()
          if (done) break
          const combined = lineBuffer2 + value
          const lines = combined.split('\n')
          lineBuffer2 = lines.pop() || ''
          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data:')) continue
            const data = trimmed.slice(5).trim()
            if (!data || data === '[DONE]') continue
            try {
              const chunk = JSON.parse(data)
              cleanChunkDelta(chunk)
              allChunks.push(chunk)
            } catch { /* skip */ }
          }
        }
      } catch { /* stream error */ }

      const anthropicResp = aggregateOpenAIToAnthropic(allChunks)
      return c.json(anthropicResp)
    }

    // TRAE：账号池管理，转发 OpenAI 格式后转回 Anthropic SSE
    if (isTraeProvider(provider)) {
      // 强制流式（TRAE 上游只支持流式 SSE），由本层决定是否转非流式 Anthropic
      const upstreamBody: Record<string, unknown> = { ...openaiBody, stream: true }
      sanitizeUpstreamBody(upstreamBody)
      const response = await proxyTraeChatRequest(c.env, provider, upstreamBody)
      if (!response.ok) {
        const errText = await response.text()
        try {
          c.executionCtx.waitUntil(writeLog(c.env, 'error', `[anthropic] ${model} → ${response.status} TRAE`, JSON.stringify({ error: errText, body: summarizeRequestBody(openaiBody) }).substring(0, 4000)))
        } catch { /* log failure must not break request */ }
        return c.json({
          type: 'error',
          error: { type: 'upstream_error', message: `Upstream error: ${sanitizeUpstreamError(errText)}` },
        }, response.status as Parameters<typeof c.json>[1])
      }
      try { c.executionCtx.waitUntil(writeLog(c.env, 'request', `[anthropic] ${model} → 200 TRAE`, `stream=${originalStream}`)) } catch {}

      // 流式：OpenAI SSE → Anthropic SSE 实时转换
      if (originalStream && response.body) {
        const acc = createAnthropicSSEAccumulator()
        const readable = new ReadableStream({
          async start(controller) {
            const decoder = new TextDecoderStream()
            const textReader = response.body!.pipeThrough(decoder).getReader()
            let lineBuffer = ''
            try {
              while (true) {
                const { done, value } = await textReader.read()
                if (done) break
                const combined = lineBuffer + value
                const lines = combined.split('\n')
                lineBuffer = lines.pop() || ''
                for (const line of lines) {
                  const trimmed = line.trim()
                  if (!trimmed.startsWith('data:')) continue
                  const data = trimmed.slice(5).trim()
                  if (!data || data === '[DONE]') continue
                  try {
                    const chunk = JSON.parse(data)
                    cleanChunkDelta(chunk)
                    const anthropicSSE = openAIChunkToAnthropicSSE(chunk, acc)
                    if (anthropicSSE) controller.enqueue(new TextEncoder().encode(anthropicSSE))
                  } catch { /* skip malformed */ }
                }
              }
              if (lineBuffer.trim().startsWith('data:')) {
                const data = lineBuffer.trim().slice(5).trim()
                if (data && data !== '[DONE]') {
                  try {
                    const chunk = JSON.parse(data)
                    cleanChunkDelta(chunk)
                    const anthropicSSE = openAIChunkToAnthropicSSE(chunk, acc)
                    if (anthropicSSE) controller.enqueue(new TextEncoder().encode(anthropicSSE))
                  } catch { /* skip */ }
                }
              }
            } catch { /* stream error */ }
            const finalizeDiag = diagnoseAnthropicAccumulator(acc)
            const finalized = finalizeAnthropicStream(acc)
            if (finalized) {
              try { controller.enqueue(new TextEncoder().encode(finalized)) } catch { /* enqueue failed */ }
              try {
                c.executionCtx.waitUntil(writeLog(c.env, 'warn',
                  `[anthropic] 流结束兜底触发 ${model} (trae)`,
                  JSON.stringify({ providerId: provider.id, model, ...finalizeDiag })
                ))
              } catch { /* log failure must not break */ }
            }
            controller.close()
          },
        })
        return new Response(withSSEKeepAlive(readable, SSE_KEEPALIVE_MS, SSE_IDLE_TIMEOUT_MS), {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
            'X-Accel-Buffering': 'no',
          },
        })
      }

      // 非流式：收集所有 OpenAI SSE → 聚合 → Anthropic
      const allChunks: any[] = []
      const decoder2 = new TextDecoderStream()
      const textReader2 = response.body!.pipeThrough(decoder2).getReader()
      let lineBuffer2 = ''
      try {
        while (true) {
          const { done, value } = await textReader2.read()
          if (done) break
          const combined = lineBuffer2 + value
          const lines = combined.split('\n')
          lineBuffer2 = lines.pop() || ''
          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data:')) continue
            const data = trimmed.slice(5).trim()
            if (!data || data === '[DONE]') continue
            try {
              const chunk = JSON.parse(data)
              cleanChunkDelta(chunk)
              allChunks.push(chunk)
            } catch { /* skip */ }
          }
        }
      } catch { /* stream error */ }
      const anthropicResp = aggregateOpenAIToAnthropic(allChunks)
      return c.json(anthropicResp)
    }

    // Anthropic 原生上游（provider.apiType === 'anthropic'，如 api.anthropic.com）：
    // 请求体/认证头/路径都转成 Anthropic 原生格式，响应原样透传（Anthropic → Anthropic，保真度最高）
    if (provider.apiType === 'anthropic') {
      return await proxyAnthropicNativeUpstream(c, provider, providerId, modelId, openaiBody, originalStream, 'messages')
    }

    // 非 OAuth 提供商：用 apiKey 标准转发，始终发 OpenAI 格式到上游
    const enabledKeys = provider.apiKeys.filter(k => k.enabled)
    if (enabledKeys.length === 0) {
      return c.json({
        type: 'error',
        error: { type: 'configuration_error', message: `Provider "${provider.name}" has no enabled API keys` },
      }, 500)
    }

    const resolvedBase = resolveProviderBaseUrl(c.env, provider.baseUrl)
    if (!resolvedBase) {
      return c.json({
        type: 'error',
        error: { type: 'configuration_error', message: `Provider "${provider.name}" baseUrl has {CF_ACCOUNT_ID} placeholder but CF_ACCOUNT_ID env is not set` },
      }, 500)
    }
    const cleanBase = resolvedBase.replace(/\/$/, '')
    const forwardUrl = `${cleanBase}/chat/completions`
    const upstreamBody: Record<string, unknown> = { ...openaiBody, stream: true }
    // 清理上游不支持的字段 + 被屏蔽的 Claude Code 模板短语
    sanitizeUpstreamBody(upstreamBody)
    sanitizeBlockedTemplates(upstreamBody)
    // max_completion_tokens → max_tokens（部分上游只认 max_tokens）
    if (upstreamBody['max_completion_tokens'] !== undefined && upstreamBody['max_tokens'] === undefined) {
      upstreamBody['max_tokens'] = upstreamBody['max_completion_tokens']
      delete upstreamBody['max_completion_tokens']
    }
    // 清理上游不支持的字段 + 被屏蔽的 Claude Code 模板短语
    sanitizeUpstreamBody(upstreamBody)
    sanitizeBlockedTemplates(upstreamBody)
    // R3：多 Key 顺序 failover——单 key 故障（HTTP 非 2xx 或网络异常）自动切换
    // 下一个启用的 key，全部失败才把最后一次错误返回给客户端。
    let response: Response | undefined
    let lastErrText = ''
    let lastStatus = 502
    for (const key of enabledKeys) {
      try {
        const r = await fetchUpstream(c.env, forwardUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key.key}`,
          },
          body: JSON.stringify(upstreamBody),
        }, originalStream === true)
        if (r.ok) {
          response = r
          break
        }
        lastStatus = r.status
        lastErrText = await r.text()
      } catch (err) {
        lastStatus = 502
        lastErrText = (err as Error).message || '网络错误'
      }
    }

    if (!response) {
      try { c.executionCtx.waitUntil(writeLog(c.env, 'error', `[anthropic] ${model} → failover 全部失败 ${forwardUrl}`, JSON.stringify({ error: lastErrText, body: summarizeRequestBody(upstreamBody), url: forwardUrl }).substring(0, 4000))) } catch {}
      return c.json({
        type: 'error',
        error: { type: 'upstream_error', message: `Upstream error: ${sanitizeUpstreamError(lastErrText)}` },
      }, lastStatus as Parameters<typeof c.json>[1])
    }

    try { c.executionCtx.waitUntil(writeLog(c.env, 'request', `[anthropic] ${model} → 200 ${forwardUrl}`, `stream=${originalStream}`)) } catch {}

    // 流式：OpenAI SSE → Anthropic SSE 实时转换
    if (originalStream && response.body) {
      const acc = createAnthropicSSEAccumulator()
      const readable = new ReadableStream({
        async start(controller) {
          const decoder = new TextDecoderStream()
          const textReader = response.body!.pipeThrough(decoder).getReader()
          let lineBuffer = ''

          try {
            while (true) {
              const { done, value } = await textReader.read()
              if (done) break
              const combined = lineBuffer + value
              const lines = combined.split('\n')
              lineBuffer = lines.pop() || ''

              for (const line of lines) {
                const trimmed = line.trim()
                if (!trimmed.startsWith('data:')) continue
                const data = trimmed.slice(5).trim()
                if (!data || data === '[DONE]') continue

                try {
                  const chunk = JSON.parse(data)
                  cleanChunkDelta(chunk)
                  const anthropicSSE = openAIChunkToAnthropicSSE(chunk, acc)
                  if (anthropicSSE) {
                    controller.enqueue(new TextEncoder().encode(anthropicSSE))
                  }
                } catch { /* skip malformed */ }
              }
            }
          } catch { /* stream error */ }
          // 流结束兜底：补发缺失的 content_block_stop / message_stop 事件。
          // 上游偶尔未正常发送 finish_reason，或在 tool_use 块未关闭时就结束流，
          // 会导致客户端报 "truncated: stream ended"。此处保证流的正确结束，
          // 并在触发兜底时记录诊断日志（含 tool_use 名称/id），便于定位问题工具调用。
          const finalizeDiag = diagnoseAnthropicAccumulator(acc)
          const finalized = finalizeAnthropicStream(acc)
          if (finalized) {
            try {
              controller.enqueue(new TextEncoder().encode(finalized))
            } catch { /* enqueue failed */ }
            // 仅在确实补发了事件时记录 warn 日志（正常结束不会触发）
            try {
              c.executionCtx.waitUntil(writeLog(c.env, 'warn',
                `[anthropic] 流结束兜底触发 ${model}`,
                JSON.stringify({ providerId: provider.id, model, ...finalizeDiag })
              ))
            } catch { /* log failure must not break */ }
          }
          controller.close()
        },
      })

      return new Response(readable, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          'X-Accel-Buffering': 'no',
        },
      })
    }

    // 非流式：收集所有 OpenAI SSE → 聚合 → Anthropic
    const allChunks: any[] = []
    const decoder = new TextDecoderStream()
    const textReader = response.body!.pipeThrough(decoder).getReader()
    let lineBuffer2 = ''

    try {
      while (true) {
        const { done, value } = await textReader.read()
        if (done) break
        const combined = lineBuffer2 + value
        const lines = combined.split('\n')
        lineBuffer2 = lines.pop() || ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const data = trimmed.slice(5).trim()
          if (!data || data === '[DONE]') continue
          try {
            const chunk = JSON.parse(data)
            cleanChunkDelta(chunk)
            allChunks.push(chunk)
          } catch { /* skip */ }
        }
      }
    } catch { /* stream error */ }

    const anthropicResp = aggregateOpenAIToAnthropic(allChunks)
    return c.json(anthropicResp)
  } catch (err) {
    console.error('[anthropic] error:', err)
    return c.json({ type: 'error', error: { type: 'server_error', message: 'Internal server error' } }, 500)
  }
}

/**
 * QoderWork Anthropic 格式转发：OpenAI 请求体 → COSY 转发 → SSE 解包（proxyQoderChatRequest
 * 已把嵌套 SSE 解成 OpenAI SSE）→ 再转回 Anthropic SSE。转换逻辑与 WorkBuddy 分支一致。
 */
async function handleAnthropicQoder(
  c: Context<AppEnv>,
  provider: import('./types').Provider,
  model: string,
  openaiBody: Record<string, unknown>,
  originalStream: boolean
): Promise<Response> {
  // 强制流式（QoderWork 只支持流式）
  const upstreamBody: Record<string, unknown> = { ...openaiBody, stream: true }
  // 清理上游不支持的字段 + 被屏蔽的 Claude Code 模板短语
  sanitizeUpstreamBody(upstreamBody)
  sanitizeBlockedTemplates(upstreamBody)
  // max_completion_tokens → max_tokens（部分上游只认 max_tokens）
  if (upstreamBody['max_completion_tokens'] !== undefined && upstreamBody['max_tokens'] === undefined) {
    upstreamBody['max_tokens'] = upstreamBody['max_completion_tokens']
    delete upstreamBody['max_completion_tokens']
  }

  const response = await proxyQoderChatRequest(c.env, provider, upstreamBody, { stream: true })

  if (!response.ok) {
    const errText = await response.text().catch(() => '')
    try {
      const bodySummary = summarizeRequestBody(upstreamBody)
      c.executionCtx.waitUntil(writeLog(c.env, 'error', `[anthropic] ${model} → ${response.status} QoderWork`, JSON.stringify({ error: errText, body: bodySummary }).substring(0, 4000)))
    } catch { /* log failure must not break request */ }
    return c.json({
      type: 'error',
      error: { type: 'upstream_error', message: `Upstream error: ${sanitizeUpstreamError(errText)}` },
    }, response.status as Parameters<typeof c.json>[1])
  }

  try { c.executionCtx.waitUntil(writeLog(c.env, 'request', `[anthropic] ${model} → 200 QoderWork`, `stream=${originalStream}`)) } catch {}

  if (!response.body) {
    return c.json({ type: 'error', error: { type: 'upstream_error', message: 'Upstream returned empty body' } }, 502)
  }

  // 流式：OpenAI SSE → Anthropic SSE 实时转换
  if (originalStream) {
    const acc = createAnthropicSSEAccumulator()
    const readable = new ReadableStream({
      async start(controller) {
        const decoder = new TextDecoderStream()
        const textReader = response.body!.pipeThrough(decoder).getReader()
        let lineBuffer = ''

        try {
          while (true) {
            const { done, value } = await textReader.read()
            if (done) break
            const combined = lineBuffer + value
            const lines = combined.split('\n')
            lineBuffer = lines.pop() || ''

            for (const line of lines) {
              const trimmed = line.trim()
              if (!trimmed.startsWith('data:')) continue
              const data = trimmed.slice(5).trim()
              if (!data || data === '[DONE]') continue
              try {
                const chunk = JSON.parse(data)
                cleanChunkDelta(chunk)
                const anthropicSSE = openAIChunkToAnthropicSSE(chunk, acc)
                if (anthropicSSE) {
                  controller.enqueue(new TextEncoder().encode(anthropicSSE))
                }
              } catch { /* skip malformed */ }
            }
          }
          if (lineBuffer.trim().startsWith('data:')) {
            const data = lineBuffer.trim().slice(5).trim()
            if (data && data !== '[DONE]') {
              try {
                const chunk = JSON.parse(data)
                cleanChunkDelta(chunk)
                const anthropicSSE = openAIChunkToAnthropicSSE(chunk, acc)
                if (anthropicSSE) {
                  controller.enqueue(new TextEncoder().encode(anthropicSSE))
                }
              } catch { /* skip */ }
            }
          }
        } catch { /* stream error */ }
        // 流结束兜底：补发缺失的 content_block_stop / message_stop 事件
        const finalizeDiag = diagnoseAnthropicAccumulator(acc)
        const finalized = finalizeAnthropicStream(acc)
        if (finalized) {
          try {
            controller.enqueue(new TextEncoder().encode(finalized))
          } catch { /* enqueue failed */ }
          try {
            c.executionCtx.waitUntil(writeLog(c.env, 'warn',
              `[anthropic] 流结束兜底触发 ${model} (qoder)`,
              JSON.stringify({ providerId: provider.id, model, ...finalizeDiag })
            ))
          } catch { /* log failure must not break */ }
        }
        controller.close()
      },
    })

    return new Response(readable, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      },
    })
  }

  // 非流式：收集所有 OpenAI SSE → 聚合 → Anthropic
  const allChunks: any[] = []
  const decoder2 = new TextDecoderStream()
  const textReader2 = response.body.pipeThrough(decoder2).getReader()
  let lineBuffer2 = ''

  try {
    while (true) {
      const { done, value } = await textReader2.read()
      if (done) break
      const combined = lineBuffer2 + value
      const lines = combined.split('\n')
      lineBuffer2 = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (!data || data === '[DONE]') continue
        try {
          const chunk = JSON.parse(data)
          cleanChunkDelta(chunk)
          allChunks.push(chunk)
        } catch { /* skip */ }
      }
    }
  } catch { /* stream error */ }

  const anthropicResp = aggregateOpenAIToAnthropic(allChunks)
  return c.json(anthropicResp)
}

/**
 * Anthropic 入口的 Vision Bridge 分支：
 * 图片转写 → 替换图片块 → 递归 forwardProxy 发给 primary（OpenAI 格式）→
 * 将 primary 的 OpenAI 响应转回 Anthropic 格式（流式 / 非流式）。
 */
async function handleAnthropicVisionBridge(
  c: Context<AppEnv>,
  provider: import('./types').Provider,
  model: string,
  openaiBody: Record<string, unknown>,
  originalStream: boolean
): Promise<Response> {
  // 1. 图片转写（含无图直通 primary），model 已被替换为 primary 的 providerId/modelId 引用
  const vbResult = await buildVisionBridgeRequestBody(c.env, provider, openaiBody as ProxyRequestBody)
  if (!vbResult.ok || !vbResult.body) {
    return c.json({
      type: 'error',
      error: { type: 'invalid_request_error', message: vbResult.error || 'Vision Bridge 配置错误' },
    }, 422)
  }

  // 2. 递归转发到 primary（强制流式，由 Anthropic 格式决定最终转换）
  const upstreamBody: Record<string, unknown> = { ...(vbResult.body as Record<string, unknown>), stream: true }
  sanitizeUpstreamBody(upstreamBody)
  sanitizeBlockedTemplates(upstreamBody)
  if (upstreamBody['max_completion_tokens'] !== undefined && upstreamBody['max_tokens'] === undefined) {
    upstreamBody['max_tokens'] = upstreamBody['max_completion_tokens']
    delete upstreamBody['max_completion_tokens']
  }

  const response = await forwardProxy(c, upstreamBody as ProxyRequestBody, 'POST')

  if (!response.ok) {
    const errText = await response.text().catch(() => '')
    try {
      c.executionCtx.waitUntil(writeLog(c.env, 'error', `[anthropic] ${model} → ${response.status} VisionBridge`, JSON.stringify({ error: errText, model, primary: upstreamBody['model'] }).substring(0, 4000)))
    } catch { /* log failure must not break request */ }
    return c.json({
      type: 'error',
      error: { type: 'upstream_error', message: `Upstream error: ${sanitizeUpstreamError(errText)}` },
    }, response.status as Parameters<typeof c.json>[1])
  }

  try { c.executionCtx.waitUntil(writeLog(c.env, 'request', `[anthropic] ${model} → 200 VisionBridge primary=${upstreamBody['model']}`, `stream=${originalStream}`)) } catch {}

  if (!response.body) {
    return c.json({ type: 'error', error: { type: 'upstream_error', message: 'Upstream returned empty body' } }, 502)
  }

  // 流式：OpenAI SSE → Anthropic SSE 实时转换
  if (originalStream) {
    const acc = createAnthropicSSEAccumulator()
    const readable = new ReadableStream({
      async start(controller) {
        const decoder = new TextDecoderStream()
        const textReader = response.body!.pipeThrough(decoder).getReader()
        let lineBuffer = ''
        try {
          while (true) {
            const { done, value } = await textReader.read()
            if (done) break
            const combined = lineBuffer + value
            const lines = combined.split('\n')
            lineBuffer = lines.pop() || ''
            for (const line of lines) {
              const trimmed = line.trim()
              if (!trimmed.startsWith('data:')) continue
              const data = trimmed.slice(5).trim()
              if (!data || data === '[DONE]') continue
              try {
                const chunk = JSON.parse(data)
                cleanChunkDelta(chunk)
                const anthropicSSE = openAIChunkToAnthropicSSE(chunk, acc)
                if (anthropicSSE) controller.enqueue(new TextEncoder().encode(anthropicSSE))
              } catch { /* skip malformed */ }
            }
          }
          if (lineBuffer.trim().startsWith('data:')) {
            const data = lineBuffer.trim().slice(5).trim()
            if (data && data !== '[DONE]') {
              try {
                const chunk = JSON.parse(data)
                cleanChunkDelta(chunk)
                const anthropicSSE = openAIChunkToAnthropicSSE(chunk, acc)
                if (anthropicSSE) controller.enqueue(new TextEncoder().encode(anthropicSSE))
              } catch { /* skip */ }
            }
          }
        } catch { /* stream error */ }
        const finalized = finalizeAnthropicStream(acc)
        if (finalized) {
          try { controller.enqueue(new TextEncoder().encode(finalized)) } catch { /* enqueue failed */ }
        }
        controller.close()
      },
    })
    return new Response(readable, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      },
    })
  }

  // 非流式：聚合所有 OpenAI SSE → Anthropic
  const allChunks: any[] = []
  const decoder2 = new TextDecoderStream()
  const textReader2 = response.body.pipeThrough(decoder2).getReader()
  let lineBuffer2 = ''
  try {
    while (true) {
      const { done, value } = await textReader2.read()
      if (done) break
      const combined = lineBuffer2 + value
      const lines = combined.split('\n')
      lineBuffer2 = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (!data || data === '[DONE]') continue
        try {
          const chunk = JSON.parse(data)
          cleanChunkDelta(chunk)
          allChunks.push(chunk)
        } catch { /* skip */ }
      }
    }
  } catch { /* stream error */ }

  const anthropicResp = aggregateOpenAIToAnthropic(allChunks)
  return c.json(anthropicResp)
}

/**
 * Cline Anthropic 格式转发：OpenAI 请求体 → Cline 上游转发（proxyClineChatRequest
 * 已把嵌套 SSE 解成 OpenAI SSE）→ 再转回 Anthropic SSE。转换逻辑与 qoder 分支一致。
 */
async function handleAnthropicCline(
  c: Context<AppEnv>,
  provider: import('./types').Provider,
  model: string,
  openaiBody: Record<string, unknown>,
  originalStream: boolean
): Promise<Response> {
  return handleAnthropicSpecial(c, provider, model, openaiBody, originalStream, proxyClineChatRequest, 'Cline')
}

/** 特殊提供商（Cline/Gemini/CNB）的 Anthropic 格式转发共用实现。 */
type SpecialChatProxy = (env: Env, provider: import('./types').Provider, body: Record<string, unknown>) => Promise<Response>

async function handleAnthropicSpecial(
  c: Context<AppEnv>,
  provider: import('./types').Provider,
  model: string,
  openaiBody: Record<string, unknown>,
  originalStream: boolean,
  proxyFn: SpecialChatProxy,
  label: string
): Promise<Response> {
  // 上游支持流式，非流式时也先强制流式再由客户端格式决定转换
  const upstreamBody: Record<string, unknown> = { ...openaiBody, stream: true }
  // 清理上游不支持的字段 + 被屏蔽的 Claude Code 模板短语
  sanitizeUpstreamBody(upstreamBody)
  sanitizeBlockedTemplates(upstreamBody)
  // max_completion_tokens → max_tokens（部分上游只认 max_tokens）
  if (upstreamBody['max_completion_tokens'] !== undefined && upstreamBody['max_tokens'] === undefined) {
    upstreamBody['max_tokens'] = upstreamBody['max_completion_tokens']
    delete upstreamBody['max_completion_tokens']
  }

  const response = await proxyFn(c.env, provider, upstreamBody)

  if (!response.ok) {
    const errText = await response.text().catch(() => '')
    try {
      const bodySummary = summarizeRequestBody(upstreamBody)
      c.executionCtx.waitUntil(writeLog(c.env, 'error', `[anthropic] ${model} → ${response.status} ${label}`, JSON.stringify({ error: errText, body: bodySummary }).substring(0, 4000)))
    } catch { /* log failure must not break request */ }
    return c.json({
      type: 'error',
      error: { type: 'upstream_error', message: `Upstream error: ${sanitizeUpstreamError(errText)}` },
    }, response.status as Parameters<typeof c.json>[1])
  }

  try { c.executionCtx.waitUntil(writeLog(c.env, 'request', `[anthropic] ${model} → 200 ${label}`, `stream=${originalStream}`)) } catch {}

  if (!response.body) {
    return c.json({ type: 'error', error: { type: 'upstream_error', message: 'Upstream returned empty body' } }, 502)
  }

  // 流式：OpenAI SSE → Anthropic SSE 实时转换
  if (originalStream) {
    const acc = createAnthropicSSEAccumulator()
    const readable = new ReadableStream({
      async start(controller) {
        const decoder = new TextDecoderStream()
        const textReader = response.body!.pipeThrough(decoder).getReader()
        let lineBuffer = ''

        try {
          while (true) {
            const { done, value } = await textReader.read()
            if (done) break
            const combined = lineBuffer + value
            const lines = combined.split('\n')
            lineBuffer = lines.pop() || ''

            for (const line of lines) {
              const trimmed = line.trim()
              if (!trimmed.startsWith('data:')) continue
              const data = trimmed.slice(5).trim()
              if (!data || data === '[DONE]') continue
              try {
                const chunk = JSON.parse(data)
                cleanChunkDelta(chunk)
                const anthropicSSE = openAIChunkToAnthropicSSE(chunk, acc)
                if (anthropicSSE) {
                  controller.enqueue(new TextEncoder().encode(anthropicSSE))
                }
              } catch { /* skip malformed */ }
            }
          }
          if (lineBuffer.trim().startsWith('data:')) {
            const data = lineBuffer.trim().slice(5).trim()
            if (data && data !== '[DONE]') {
              try {
                const chunk = JSON.parse(data)
                cleanChunkDelta(chunk)
                const anthropicSSE = openAIChunkToAnthropicSSE(chunk, acc)
                if (anthropicSSE) {
                  controller.enqueue(new TextEncoder().encode(anthropicSSE))
                }
              } catch { /* skip */ }
            }
          }
        } catch { /* stream error */ }
        // 流结束兜底：补发缺失的 content_block_stop / message_stop 事件
        const finalizeDiag = diagnoseAnthropicAccumulator(acc)
        const finalized = finalizeAnthropicStream(acc)
        if (finalized) {
          try {
            controller.enqueue(new TextEncoder().encode(finalized))
          } catch { /* enqueue failed */ }
          try {
            c.executionCtx.waitUntil(writeLog(c.env, 'warn',
              `[anthropic] 流结束兜底触发 ${model} (${label.toLowerCase()})`,
              JSON.stringify({ providerId: provider.id, model, ...finalizeDiag })
            ))
          } catch { /* log failure must not break */ }
        }
        controller.close()
      },
    })

    return new Response(readable, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      },
    })
  }

  // 非流式：收集所有 OpenAI SSE → 聚合 → Anthropic
  const allChunks: any[] = []
  const decoder2 = new TextDecoderStream()
  const textReader2 = response.body.pipeThrough(decoder2).getReader()
  let lineBuffer2 = ''

  try {
    while (true) {
      const { done, value } = await textReader2.read()
      if (done) break
      const combined = lineBuffer2 + value
      const lines = combined.split('\n')
      lineBuffer2 = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (!data || data === '[DONE]') continue
        try {
          const chunk = JSON.parse(data)
          cleanChunkDelta(chunk)
          allChunks.push(chunk)
        } catch { /* skip */ }
      }
    }
  } catch { /* stream error */ }

  const anthropicResp = aggregateOpenAIToAnthropic(allChunks)
  return c.json(anthropicResp)
}

/**
 * Gemini Anthropic 格式转发：OpenAI 请求体 → Gemini 上游转发（proxyGeminiChatRequest
 * 已把 Gemini 响应解包成 OpenAI SSE）→ 再转回 Anthropic SSE。转换逻辑与 qoder 分支一致。
 */
async function handleAnthropicGemini(
  c: Context<AppEnv>,
  provider: import('./types').Provider,
  model: string,
  openaiBody: Record<string, unknown>,
  originalStream: boolean
): Promise<Response> {
  return handleAnthropicSpecial(c, provider, model, openaiBody, originalStream, proxyGeminiChatRequest, 'Gemini')
}

/**
 * CNB Anthropic 格式转发：OpenAI 请求体 → CNB 上游转发（proxyCnbChatRequest 已把
 * CNB SSE 解包成 OpenAI SSE）→ 再转回 Anthropic SSE。
 */
async function handleAnthropicCnb(
  c: Context<AppEnv>,
  provider: import('./types').Provider,
  model: string,
  openaiBody: Record<string, unknown>,
  originalStream: boolean
): Promise<Response> {
  return handleAnthropicSpecial(c, provider, model, openaiBody, originalStream, proxyCnbChatRequest, 'CNB')
}

/**
 * M365 Copilot Anthropic 格式转发：OpenAI 请求体 → M365 DO 转发（proxyM365ChatRequest
 * 返回 OpenAI SSE）→ 再转回 Anthropic SSE。
 */
async function handleAnthropicM365(
  c: Context<AppEnv>,
  provider: import('./types').Provider,
  model: string,
  openaiBody: Record<string, unknown>,
  originalStream: boolean
): Promise<Response> {
  // 透传 X-M365-Session-Id 请求头到 body（Anthropic 路径无 context 直传，靠 extractExplicitSession 识别）
  const sid = c.req.header('X-M365-Session-Id')
  if (sid) openaiBody['m365_session_id'] = sid
  return handleAnthropicSpecial(c, provider, model, openaiBody, originalStream, proxyM365ChatRequest, 'M365')
}

// ============================================================
//  OpenAI Responses API 代理  /v1/responses
//  将 Responses 格式请求转为 Chat Completions，调用上游，
//  再将响应转回 Responses 格式。
// ============================================================

export async function handleResponses(c: Context<AppEnv>) {
  try {
    const responsesBody = await c.req.json<Record<string, unknown>>()
    const model = responsesBody['model'] as string

    if (!model) {
      return c.json({ error: { message: 'Missing model', type: 'invalid_request_error' } }, 400)
    }

    const parsed = parseModelId(model)
    if (!parsed) {
      return c.json({
        error: { message: `Invalid model format "${model}", use providerId/modelId`, type: 'invalid_request_error' },
      }, 400)
    }

    const { providerId, modelId } = parsed

    const proxyKey = (c as any).get('proxyKey') as import('./types').ProxyKey | undefined
    if (proxyKey?.allowedModels && proxyKey.allowedModels.length > 0) {
      if (!proxyKey.allowedModels.includes(model)) {
        return c.json({
          error: { message: `Model "${model}" not allowed for this key`, type: 'permission_error' },
        }, 403)
      }
    }

    const provider = await getProvider(c.env, providerId)
    if (!provider) {
      return c.json({ error: { message: `Provider "${providerId}" not found`, type: 'invalid_request_error' } }, 404)
    }
    if (!provider.enabled) {
      return c.json({ error: { message: `Provider "${provider.name}" is disabled`, type: 'provider_disabled' } }, 403)
    }

    const modelConfig = provider.models.find((m) => m.id === modelId)
    if (!modelConfig) {
      return c.json({ error: { message: `Model "${modelId}" not configured`, type: 'invalid_request_error' } }, 404)
    }

    // Responses → OpenAI 转换
    const responsesReq = responsesBody as any
    const openaiBody = responsesToOpenAI(responsesReq)
    openaiBody['model'] = modelId

    // G5：解析 previous_response_id 指定的多轮历史（在缓存前缀/思维注入之前，避免把网关提示词写入会话历史）。
    // g5Base = 已解析历史 + 本次输入（副本，防止随后的 unshift 注入污染会话历史）。
    const inputMsgs = ((openaiBody['messages'] as unknown[]) || [])
    let g5Base = [...inputMsgs]
    const prevRespId = responsesBody['previous_response_id']
    if (prevRespId) {
      const prior = await getResponseHistory(c.env, String(prevRespId))
      if (prior && prior.length > 0) {
        openaiBody['messages'] = [...prior, ...inputMsgs]
        g5Base = [...prior, ...g5Base]
      }
    }

    // 缓存前缀注入：提供商勾选该模型时，在 messages 头部注入固定缓存前缀（提升前缀缓存命中率）
    await applyCachePrefixInjection(c.env, provider, modelId, openaiBody)
    // 思维模式引导注入：提供商勾选该模型时，在 messages 头部注入思维引导 system 提示词
    await applyThinkingInjection(c.env, provider, modelId, openaiBody)

    // G5：把「已解析历史 + 本次输入 + assistant 输出」按 response.id 存入 KV
    const g5Save = (respId: string, fullHistory: unknown[]) => {
      try { c.executionCtx.waitUntil(saveResponseHistory(c.env, respId, fullHistory)) } catch {}
    }

    const originalStream = responsesReq.stream === true

    // 提供商级共享识图：普通提供商配置识图模型后，Responses 格式含图请求同样自动转写
    if (provider.visionBridge && provider.type !== 'vision-bridge') {
      const vb = await transcribeImagesForProvider(c.env, provider, openaiBody)
      if (!vb.ok) {
        return c.json({ error: { message: vb.error, type: 'invalid_request_error' } }, 422)
      }
      Object.assign(openaiBody, vb.body)
    }

    // Vision Bridge：图片转写后转发给主文本模型（OpenAI 格式），再转回 Responses 格式。
    if (isVisionBridgeProvider(provider)) {
      return await handleResponsesVisionBridge(c, provider, model, openaiBody, originalStream, g5Base, g5Save)
    }

    // Gemini：OAuth 授权码转发（OpenAI 格式），再转回 Responses 格式。
    if (isGeminiProvider(provider)) {
      return await handleResponsesGemini(c, provider, model, openaiBody, originalStream, g5Base, g5Save)
    }

    // CNB：CSRF 凭证转发（OpenAI 格式），再转回 Responses 格式。
    if (isCnbProvider(provider)) {
      return await handleResponsesCnb(c, provider, model, openaiBody, originalStream, g5Base, g5Save)
    }

    // M365 Copilot：OAuth 授权码转发（OpenAI 格式），再转回 Responses 格式。
    if (isM365Provider(provider)) {
      return await handleResponsesM365(c, provider, model, openaiBody, originalStream, g5Base, g5Save)
    }

    // TRAE SOLO：账号池 + SOLO 协议转发（proxyTraeChatRequest 返回 OpenAI SSE），再转回 Responses 格式。
    if (isTraeProvider(provider)) {
      return handleResponsesSpecial(c, provider, model, openaiBody, originalStream, proxyTraeChatRequest, 'TRAE', g5Base, g5Save)
    }

    // Cline：refreshToken 账号池转发（proxyClineChatRequest 返回 OpenAI SSE），再转回 Responses 格式。
    if (isClineProvider(provider.id)) {
      return handleResponsesSpecial(c, provider, model, openaiBody, originalStream, proxyClineChatRequest, 'Cline', g5Base, g5Save)
    }

    // OAuth 提供商
    if (provider.authType === 'oauth-device' && provider.oauth) {
      const cfg = provider.oauth
      const upstreamBody: Record<string, unknown> = { ...openaiBody, stream: true }
      // 清理上游不支持的字段（developer → system, 删除 reasoning_effort 等）
      sanitizeUpstreamBody(upstreamBody)

      // 读取 token 状态
      let tokenState = await readOauthToken(c.env, providerId)
      if (!tokenState?.access_token) {
        const refreshed = await refreshOauthToken(c.env, providerId, cfg)
        if (refreshed) tokenState = await readOauthToken(c.env, providerId)
      }
      if (!tokenState?.access_token) {
        return c.json({
          error: { message: 'OAuth token not available. Please login first.', type: 'authentication_error' },
        }, 401)
      }

      // 域路由
      const realm = detectTokenRealm(tokenState.access_token)
      const isGlobal = realm === 'global'
      const realmBase = (isGlobal && cfg.globalBaseUrl ? cfg.globalBaseUrl : provider.baseUrl).replace(/\/$/, '')
      const origin = isGlobal && cfg.globalOrigin ? cfg.globalOrigin : (cfg.extraHeaders?.Origin)
      const upstreamUrl = `${realmBase}/chat/completions`

      // Global 域需要 system message
      if (isGlobal) {
        const msgs = upstreamBody['messages'] as any[]
        if (msgs && !msgs.some((m: any) => m.role === 'system')) {
          msgs.unshift({ role: 'system', content: 'You are a helpful assistant.' })
        }
      }

      const headers = buildOauthHeaders(cfg, tokenState.access_token, {
        origin,
        apiType: provider.apiType,
        cookies: tokenState.cookies,
      })

      let response = await fetchUpstream(c.env, upstreamUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(upstreamBody),
      }, originalStream === true)

      // 401/403 时刷新重试
      if ((response.status === 401 || response.status === 403) && tokenState.refresh_token) {
        const refreshed = await refreshOauthToken(c.env, providerId, cfg)
        if (refreshed) {
          const freshState = await readOauthToken(c.env, providerId)
          if (freshState?.access_token) {
            const retryHeaders = buildOauthHeaders(cfg, freshState.access_token, {
              origin,
              apiType: provider.apiType,
              cookies: freshState.cookies,
            })
            response = await fetchUpstream(c.env, upstreamUrl, {
              method: 'POST',
              headers: retryHeaders,
              body: JSON.stringify(upstreamBody),
            }, originalStream === true)
          }
        }
      }

      if (!response.ok) {
        const errText = await response.text()
        try { c.executionCtx.waitUntil(writeLog(c.env, 'error', `[responses] ${model} → ${response.status} ${upstreamUrl}`, JSON.stringify({ error: errText, body: summarizeRequestBody(upstreamBody), url: upstreamUrl }).substring(0, 4000))) } catch {}
        return c.json({
          error: { message: `Upstream error: ${sanitizeUpstreamError(errText)}`, type: 'upstream_error' },
        }, response.status as Parameters<typeof c.json>[1])
      }

      try { c.executionCtx.waitUntil(writeLog(c.env, 'request', `[responses] ${model} → 200 ${upstreamUrl}`, `stream=${originalStream}`)) } catch {}

      // 流式
      if (originalStream && response.body) {
        const acc = {
          responseId: '',
          model: '',
          itemId: null as string | null,
          textContent: '',
          toolCalls: new Map<number, { id: string; name: string; args: string }>(),
          inputTokens: 0,
          outputTokens: 0,
          hasStarted: false,
          completed: false,
        }

        const readable = new ReadableStream({
          async start(controller) {
            const decoder = new TextDecoderStream()
            const textReader = response.body!.pipeThrough(decoder).getReader()
            let lineBuffer = ''

            try {
              while (true) {
                const { done, value } = await textReader.read()
                if (done) break
                const combined = lineBuffer + value
                const lines = combined.split('\n')
                lineBuffer = lines.pop() || ''

                for (const line of lines) {
                  const trimmed = line.trim()
                  if (!trimmed.startsWith('data:')) continue
                  const data = trimmed.slice(5).trim()
                  if (!data || data === '[DONE]') continue

                  try {
                    const chunk = JSON.parse(data)
                    cleanChunkDelta(chunk)
                    const responsesSSE = openAIChunkToResponsesSSE(chunk, acc)
                    if (responsesSSE) {
                      controller.enqueue(new TextEncoder().encode(responsesSSE))
                    }
                  } catch { /* skip */ }
                }
              }
            } catch { /* stream error */ }
            // 确保发送 response.completed
            if (!acc.completed) {
              try {
                controller.enqueue(new TextEncoder().encode(
                  `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: acc.responseId || 'resp_unknown', output: [] } })}\n\n`
                ))
              } catch { /* enqueue failed */ }
            }
            // G5: 流式结束后保存多轮历史
            try {
              if (g5Base && g5Save) g5Save(acc.responseId || `resp_${Date.now()}`, [...g5Base, buildG5AssistantMessage(acc.textContent, acc.toolCalls)])
            } catch { /* 保存失败不影响响应 */ }
            controller.close()
          },
        })

        return new Response(readable, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
            'X-Accel-Buffering': 'no',
          },
        })
      }

      // 非流式：聚合 OpenAI SSE → chat.completion → Responses
      const allChunks: any[] = []
      const decoder3 = new TextDecoderStream()
      const textReader3 = response.body!.pipeThrough(decoder3).getReader()
      let lineBuffer3 = ''

      try {
        while (true) {
          const { done, value } = await textReader3.read()
          if (done) break
          const combined = lineBuffer3 + value
          const lines = combined.split('\n')
          lineBuffer3 = lines.pop() || ''
          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data:')) continue
            const data = trimmed.slice(5).trim()
            if (!data || data === '[DONE]') continue
            try {
              const chunk = JSON.parse(data)
              cleanChunkDelta(chunk)
              allChunks.push(chunk)
            } catch { /* skip */ }
          }
        }
      } catch { /* stream error */ }

      // 聚合为 OpenAI chat.completion 再转为 Responses
      const openaiResp = aggregateOpenAIToResponses(allChunks)
      // G5: 保存本轮历史
      try {
        if (g5Base && g5Save) g5Save(String(openaiResp['id'] ?? ''), [...g5Base, responsesOutputToAssistantMessage(openaiResp['output'] as Array<Record<string, unknown>> | undefined)])
      } catch { /* 保存失败不影响响应 */ }
      return c.json(openaiResp)
    }

    // Anthropic 原生上游（provider.apiType === 'anthropic'，如 api.anthropic.com）：
    // 请求体/认证头/路径都转成 Anthropic 原生格式，响应再转回 OpenAI Responses 格式
    if (provider.apiType === 'anthropic') {
      return await proxyAnthropicNativeUpstream(c, provider, providerId, modelId, openaiBody, originalStream, 'responses', g5Base, g5Save)
    }

    // 非 OAuth 提供商：用 apiKey 标准转发，始终发 OpenAI 格式到上游
    const enabledKeys = provider.apiKeys.filter(k => k.enabled)
    if (enabledKeys.length === 0) {
      return c.json({
        error: { type: 'configuration_error', message: `Provider "${provider.name}" has no enabled API keys` },
      }, 500)
    }

    const resolvedBase = resolveProviderBaseUrl(c.env, provider.baseUrl)
    if (!resolvedBase) {
      return c.json({
        error: { type: 'configuration_error', message: `Provider "${provider.name}" baseUrl has {CF_ACCOUNT_ID} placeholder but CF_ACCOUNT_ID env is not set` },
      }, 500)
    }
    const cleanBase = resolvedBase.replace(/\/$/, '')
    const forwardUrl = `${cleanBase}/chat/completions`
    const upstreamBody: Record<string, unknown> = { ...openaiBody, stream: true }
    // 清理上游不支持的字段 + 被屏蔽的 Claude Code 模板短语
    sanitizeUpstreamBody(upstreamBody)
    sanitizeBlockedTemplates(upstreamBody)
    // R3：多 Key 顺序 failover——单 key 故障（HTTP 非 2xx 或网络异常）自动切换
    // 下一个启用的 key，全部失败才把最后一次错误返回给客户端。
    let response: Response | undefined
    let lastErrText = ''
    let lastStatus = 502
    for (const key of enabledKeys) {
      try {
        const r = await fetchUpstream(c.env, forwardUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key.key}`,
          },
          body: JSON.stringify(upstreamBody),
        }, true)
        if (r.ok) {
          response = r
          break
        }
        lastStatus = r.status
        lastErrText = await r.text()
      } catch (err) {
        lastStatus = 502
        lastErrText = (err as Error).message || '网络错误'
      }
    }

    if (!response) {
      try { c.executionCtx.waitUntil(writeLog(c.env, 'error', `[responses] ${model} → failover 全部失败 ${forwardUrl}`, JSON.stringify({ error: lastErrText, body: summarizeRequestBody(upstreamBody), url: forwardUrl }).substring(0, 4000))) } catch {}
      return c.json({
        error: { message: `Upstream error: ${lastErrText}`, type: 'upstream_error' },
      }, lastStatus as Parameters<typeof c.json>[1])
    }

    try { c.executionCtx.waitUntil(writeLog(c.env, 'request', `[responses] ${model} → 200 ${forwardUrl}`, `stream=${originalStream}`)) } catch {}

    // 流式：OpenAI SSE → Responses SSE 实时转换
    if (originalStream && response.body) {
      const acc = {
        responseId: '',
        model: '',
        itemId: null as string | null,
        textContent: '',
        toolCalls: new Map<number, { id: string; name: string; args: string }>(),
        inputTokens: 0,
        outputTokens: 0,
        hasStarted: false,
        completed: false,
      }

      const readable = new ReadableStream({
        async start(controller) {
          const decoder = new TextDecoderStream()
          const textReader = response.body!.pipeThrough(decoder).getReader()
          let lineBuffer = ''

          try {
            while (true) {
              const { done, value } = await textReader.read()
              if (done) break
              const combined = lineBuffer + value
              const lines = combined.split('\n')
              lineBuffer = lines.pop() || ''

              for (const line of lines) {
                const trimmed = line.trim()
                if (!trimmed.startsWith('data:')) continue
                const data = trimmed.slice(5).trim()
                if (!data || data === '[DONE]') continue

                try {
                  const chunk = JSON.parse(data)
                  cleanChunkDelta(chunk)
                  const responsesSSE = openAIChunkToResponsesSSE(chunk, acc)
                  if (responsesSSE) {
                    controller.enqueue(new TextEncoder().encode(responsesSSE))
                  }
                } catch { /* skip */ }
              }
            }
          } catch { /* stream error */ }
          // G5: 本次流式结束后，保存「已解析历史 + 本次输入 + assistant 输出」供下一轮 previous_response_id
          try {
            const toolCalls: Array<Record<string, unknown>> = []
            for (const [, t] of acc.toolCalls) toolCalls.push({ id: t.id, type: 'function', function: { name: t.name, arguments: t.args } })
            const am = { role: 'assistant', content: acc.textContent || null } as Record<string, unknown>
            if (toolCalls.length > 0) am['tool_calls'] = toolCalls
            g5Save(acc.responseId || `resp_${Date.now()}`, [...g5Base, am])
          } catch { /* 保存失败不影响响应 */ }
          // 确保发送 response.completed
          if (!acc.completed) {
            try {
              controller.enqueue(new TextEncoder().encode(
                `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: acc.responseId || 'resp_unknown', output: [] } })}\n\n`
              ))
            } catch { /* enqueue failed */ }
          }
          controller.close()
        },
      })

      return new Response(readable, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          'X-Accel-Buffering': 'no',
        },
      })
    }

    // 非流式：聚合 OpenAI SSE → Responses
    const allChunks: any[] = []
    const decoder = new TextDecoderStream()
    const textReader = response.body!.pipeThrough(decoder).getReader()
    let lineBuffer3 = ''

    try {
      while (true) {
        const { done, value } = await textReader.read()
        if (done) break
        const combined = lineBuffer3 + value
        const lines = combined.split('\n')
        lineBuffer3 = lines.pop() || ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const data = trimmed.slice(5).trim()
          if (!data || data === '[DONE]') continue
          try {
            const chunk = JSON.parse(data)
            cleanChunkDelta(chunk)
            allChunks.push(chunk)
          } catch { /* skip */ }
        }
      }
    } catch { /* stream error */ }

    const openaiResp = aggregateOpenAIToResponses(allChunks)
    // G5: 保存本轮历史（已解析历史 + 本次输入 + assistant 输出）
    try {
      const am = responsesOutputToAssistantMessage(openaiResp['output'] as Array<Record<string, unknown>> | undefined)
      g5Save(String(openaiResp['id'] ?? ''), [...g5Base, am])
    } catch { /* 保存失败不影响响应 */ }
    return c.json(openaiResp)
  } catch (err) {
    console.error('[responses] error:', err)
    return c.json({ error: { message: 'Internal server error', type: 'server_error' } }, 500)
  }
}

/**
 * Responses 入口的 Vision Bridge 分支：
 * 图片转写 → 替换图片块 → 递归 forwardProxy 发给 primary（OpenAI 格式）→
 * 将 primary 的 OpenAI 响应转回 Responses 格式（流式 / 非流式）。
 */
/**
 * G5 辅助：把流式 acc 累积的文本与工具调用，整理成一条 OpenAI Chat 格式的 assistant 消息。
 */
function buildG5AssistantMessage(textContent: string, toolCalls: Map<number, { id: string; name: string; args: string }> | Array<{ id: string; name: string; args: string }>): Record<string, unknown> {
  const calls: Array<Record<string, unknown>> = []
  const list = toolCalls instanceof Map ? Array.from(toolCalls.values()) : toolCalls
  for (const t of list) calls.push({ id: t.id, type: 'function', function: { name: t.name, arguments: t.args } })
  const msg: Record<string, unknown> = { role: 'assistant', content: textContent || null }
  if (calls.length > 0) msg['tool_calls'] = calls
  return msg
}

async function handleResponsesVisionBridge(
  c: Context<AppEnv>,
  provider: import('./types').Provider,
  model: string,
  openaiBody: Record<string, unknown>,
  originalStream: boolean,
  g5Base?: unknown[],
  g5Save?: (respId: string, fullHistory: unknown[]) => void
): Promise<Response> {
  // 1. 图片转写（含无图直通 primary），model 已被替换为 primary 的 providerId/modelId 引用
  const vbResult = await buildVisionBridgeRequestBody(c.env, provider, openaiBody as ProxyRequestBody)
  if (!vbResult.ok || !vbResult.body) {
    return c.json({
      error: { message: vbResult.error || 'Vision Bridge 配置错误', type: 'invalid_request_error' },
    }, 422)
  }

  // 2. 递归转发到 primary（强制流式，由 Responses 格式决定最终转换）
  const upstreamBody: Record<string, unknown> = { ...(vbResult.body as Record<string, unknown>), stream: true }
  sanitizeUpstreamBody(upstreamBody)
  sanitizeBlockedTemplates(upstreamBody)

  const response = await forwardProxy(c, upstreamBody as ProxyRequestBody, 'POST')

  if (!response.ok) {
    const errText = await response.text().catch(() => '')
    try {
      c.executionCtx.waitUntil(writeLog(c.env, 'error', `[responses] ${model} → ${response.status} VisionBridge`, JSON.stringify({ error: errText, model, primary: upstreamBody['model'] }).substring(0, 4000)))
    } catch { /* log failure must not break request */ }
    return c.json({
      error: { message: `Upstream error: ${sanitizeUpstreamError(errText)}`, type: 'upstream_error' },
    }, response.status as Parameters<typeof c.json>[1])
  }

  try { c.executionCtx.waitUntil(writeLog(c.env, 'request', `[responses] ${model} → 200 VisionBridge primary=${upstreamBody['model']}`, `stream=${originalStream}`)) } catch {}

  if (!response.body) {
    return c.json({ error: { message: 'Upstream returned empty body', type: 'upstream_error' } }, 502)
  }

  // 流式：OpenAI SSE → Responses SSE 实时转换
  if (originalStream) {
    const acc = {
      responseId: '',
      model: '',
      itemId: null as string | null,
      textContent: '',
      toolCalls: new Map<number, { id: string; name: string; args: string }>(),
      inputTokens: 0,
      outputTokens: 0,
      hasStarted: false,
      completed: false,
    }

    const readable = new ReadableStream({
      async start(controller) {
        const decoder = new TextDecoderStream()
        const textReader = response.body!.pipeThrough(decoder).getReader()
        let lineBuffer = ''
        try {
          while (true) {
            const { done, value } = await textReader.read()
            if (done) break
            const combined = lineBuffer + value
            const lines = combined.split('\n')
            lineBuffer = lines.pop() || ''
            for (const line of lines) {
              const trimmed = line.trim()
              if (!trimmed.startsWith('data:')) continue
              const data = trimmed.slice(5).trim()
              if (!data || data === '[DONE]') continue
              try {
                const chunk = JSON.parse(data)
                cleanChunkDelta(chunk)
                const responsesSSE = openAIChunkToResponsesSSE(chunk, acc)
                if (responsesSSE) controller.enqueue(new TextEncoder().encode(responsesSSE))
              } catch { /* skip */ }
            }
          }
        } catch { /* stream error */ }
        if (!acc.completed) {
          try {
            controller.enqueue(new TextEncoder().encode(
              `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: acc.responseId || 'resp_unknown', output: [] } })}\n\n`
            ))
          } catch { /* enqueue failed */ }
        }
        // G5: 流式结束后保存多轮历史（已解析历史 + 本次输入 + assistant 输出）
        try {
          if (g5Base && g5Save) g5Save(acc.responseId || `resp_${Date.now()}`, [...g5Base, buildG5AssistantMessage(acc.textContent, acc.toolCalls)])
        } catch { /* 保存失败不影响响应 */ }
        controller.close()
      },
    })

    return new Response(withSSEKeepAlive(readable, SSE_KEEPALIVE_MS, SSE_IDLE_TIMEOUT_MS), {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      },
    })
  }

  // 非流式：聚合所有 OpenAI SSE → Responses
  const allChunks: any[] = []
  const decoder2 = new TextDecoderStream()
  const textReader2 = response.body.pipeThrough(decoder2).getReader()
  let lineBuffer2 = ''
  try {
    while (true) {
      const { done, value } = await textReader2.read()
      if (done) break
      const combined = lineBuffer2 + value
      const lines = combined.split('\n')
      lineBuffer2 = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (!data || data === '[DONE]') continue
        try {
          const chunk = JSON.parse(data)
          cleanChunkDelta(chunk)
          allChunks.push(chunk)
        } catch { /* skip */ }
      }
    }
  } catch { /* stream error */ }

  const openaiResp = aggregateOpenAIToResponses(allChunks)
  // G5: 保存本轮历史（已解析历史 + 本次输入 + assistant 输出）
  try {
    if (g5Base && g5Save) g5Save(String(openaiResp['id'] ?? ''), [...g5Base, responsesOutputToAssistantMessage(openaiResp['output'] as Array<Record<string, unknown>> | undefined)])
  } catch { /* 保存失败不影响响应 */ }
  return c.json(openaiResp)
}

/**
 * Gemini Responses 格式转发：OpenAI 请求体 → Gemini 上游转发（proxyGeminiChatRequest
 * 已把 Gemini 响应解包成 OpenAI SSE）→ 再转回 Responses SSE。转换逻辑与 OAuth 分支一致。
 */
async function handleResponsesGemini(
  c: Context<AppEnv>,
  provider: import('./types').Provider,
  model: string,
  openaiBody: Record<string, unknown>,
  originalStream: boolean,
  g5Base?: unknown[],
  g5Save?: (respId: string, fullHistory: unknown[]) => void
): Promise<Response> {
  return handleResponsesSpecial(c, provider, model, openaiBody, originalStream, proxyGeminiChatRequest, 'Gemini', g5Base, g5Save)
}

/** 特殊提供商（Gemini/CNB 等）的 Responses 格式转发共用实现。 */
async function handleResponsesSpecial(
  c: Context<AppEnv>,
  provider: import('./types').Provider,
  model: string,
  openaiBody: Record<string, unknown>,
  originalStream: boolean,
  proxyFn: SpecialChatProxy,
  label: string,
  g5Base?: unknown[],
  g5Save?: (respId: string, fullHistory: unknown[]) => void
): Promise<Response> {
  // 上游支持流式；统一强制流式，由客户端格式决定最终转换
  const upstreamBody: Record<string, unknown> = { ...openaiBody, stream: true }
  sanitizeUpstreamBody(upstreamBody)
  sanitizeBlockedTemplates(upstreamBody)

  const response = await proxyFn(c.env, provider, upstreamBody)

  if (!response.ok) {
    const errText = await response.text().catch(() => '')
    try {
      const bodySummary = summarizeRequestBody(upstreamBody)
      c.executionCtx.waitUntil(writeLog(c.env, 'error', `[responses] ${model} → ${response.status} ${label}`, JSON.stringify({ error: errText, body: bodySummary }).substring(0, 4000)))
    } catch { /* log failure must not break request */ }
    return c.json({
      error: { message: `Upstream error: ${sanitizeUpstreamError(errText)}`, type: 'upstream_error' },
    }, response.status as Parameters<typeof c.json>[1])
  }

  try { c.executionCtx.waitUntil(writeLog(c.env, 'request', `[responses] ${model} → 200 ${label}`, `stream=${originalStream}`)) } catch {}

  if (!response.body) {
    return c.json({ error: { message: 'Upstream returned empty body', type: 'upstream_error' } }, 502)
  }

  // 流式：OpenAI SSE → Responses SSE 实时转换
  if (originalStream) {
    const acc = {
      responseId: '',
      model: '',
      itemId: null as string | null,
      textContent: '',
      toolCalls: new Map<number, { id: string; name: string; args: string }>(),
      inputTokens: 0,
      outputTokens: 0,
      hasStarted: false,
      completed: false,
    }

    const readable = new ReadableStream({
      async start(controller) {
        const decoder = new TextDecoderStream()
        const textReader = response.body!.pipeThrough(decoder).getReader()
        let lineBuffer = ''

        try {
          while (true) {
            const { done, value } = await textReader.read()
            if (done) break
            const combined = lineBuffer + value
            const lines = combined.split('\n')
            lineBuffer = lines.pop() || ''

            for (const line of lines) {
              const trimmed = line.trim()
              if (!trimmed.startsWith('data:')) continue
              const data = trimmed.slice(5).trim()
              if (!data || data === '[DONE]') continue

              try {
                const chunk = JSON.parse(data)
                cleanChunkDelta(chunk)
                const responsesSSE = openAIChunkToResponsesSSE(chunk, acc)
                if (responsesSSE) {
                  controller.enqueue(new TextEncoder().encode(responsesSSE))
                }
              } catch { /* skip */ }
            }
          }
          if (lineBuffer.trim().startsWith('data:')) {
            const data = lineBuffer.trim().slice(5).trim()
            if (data && data !== '[DONE]') {
              try {
                const chunk = JSON.parse(data)
                cleanChunkDelta(chunk)
                const responsesSSE = openAIChunkToResponsesSSE(chunk, acc)
                if (responsesSSE) {
                  controller.enqueue(new TextEncoder().encode(responsesSSE))
                }
              } catch { /* skip */ }
            }
          }
        } catch { /* stream error */ }
        // 确保发送 response.completed
        if (!acc.completed) {
          try {
            controller.enqueue(new TextEncoder().encode(
              `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: acc.responseId || 'resp_unknown', output: [] } })}\n\n`
            ))
          } catch { /* enqueue failed */ }
        }
        // G5: 流式结束后保存多轮历史
        try {
          if (g5Base && g5Save) g5Save(acc.responseId || `resp_${Date.now()}`, [...g5Base, buildG5AssistantMessage(acc.textContent, acc.toolCalls)])
        } catch { /* 保存失败不影响响应 */ }
        controller.close()
      },
    })

    return new Response(readable, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      },
    })
  }

  // 非流式：聚合所有 OpenAI SSE → Responses
  const allChunks: any[] = []
  const decoder2 = new TextDecoderStream()
  const textReader2 = response.body.pipeThrough(decoder2).getReader()
  let lineBuffer2 = ''
  try {
    while (true) {
      const { done, value } = await textReader2.read()
      if (done) break
      const combined = lineBuffer2 + value
      const lines = combined.split('\n')
      lineBuffer2 = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (!data || data === '[DONE]') continue
        try {
          const chunk = JSON.parse(data)
          cleanChunkDelta(chunk)
          allChunks.push(chunk)
        } catch { /* skip */ }
      }
    }
  } catch { /* stream error */ }

  const openaiResp = aggregateOpenAIToResponses(allChunks)
  // G5: 保存本轮历史
  try {
    if (g5Base && g5Save) g5Save(String(openaiResp['id'] ?? ''), [...g5Base, responsesOutputToAssistantMessage(openaiResp['output'] as Array<Record<string, unknown>> | undefined)])
  } catch { /* 保存失败不影响响应 */ }
  return c.json(openaiResp)
}

/**
 * CNB Responses 格式转发：OpenAI 请求体 → CNB 上游转发（proxyCnbChatRequest 已把
 * CNB SSE 解包成 OpenAI SSE）→ 再转回 Responses SSE。
 */
async function handleResponsesCnb(
  c: Context<AppEnv>,
  provider: import('./types').Provider,
  model: string,
  openaiBody: Record<string, unknown>,
  originalStream: boolean,
  g5Base?: unknown[],
  g5Save?: (respId: string, fullHistory: unknown[]) => void
): Promise<Response> {
  return handleResponsesSpecial(c, provider, model, openaiBody, originalStream, proxyCnbChatRequest, 'CNB', g5Base, g5Save)
}

/**
 * M365 Copilot Responses 格式转发：OpenAI 请求体 → M365 DO 转发（proxyM365ChatRequest
 * 返回 OpenAI SSE）→ 再转回 Responses SSE。
 */
async function handleResponsesM365(
  c: Context<AppEnv>,
  provider: import('./types').Provider,
  model: string,
  openaiBody: Record<string, unknown>,
  originalStream: boolean,
  g5Base?: unknown[],
  g5Save?: (respId: string, fullHistory: unknown[]) => void
): Promise<Response> {
  // 透传 X-M365-Session-Id 请求头到 body（Responses 路径无 context 直传，靠 extractExplicitSession 识别）
  const sid = c.req.header('X-M365-Session-Id')
  if (sid) openaiBody['m365_session_id'] = sid
  return handleResponsesSpecial(c, provider, model, openaiBody, originalStream, proxyM365ChatRequest, 'M365', g5Base, g5Save)
}

/**
 * 对单个 chunk 的 delta 做轻量清洗（去掉空 function_call 等噪音），
 * 不修改原始 JSON 字符串，直接操作对象。
 */
function cleanChunkDelta(chunk: any): void {
  const choices = chunk?.choices
  if (!Array.isArray(choices)) return
  for (const choice of choices) {
    const delta = choice?.delta
    if (!delta || typeof delta !== 'object') continue
    // 去掉全空 function_call
    if (delta.function_call !== undefined) {
      if (delta.function_call === null) {
        delete delta.function_call
      } else if (typeof delta.function_call === 'object') {
        const vals = Object.values(delta.function_call)
        if (vals.length === 0 || vals.every((v: any) => v === null || v === '')) {
          delete delta.function_call
        }
      }
    }
    // 去掉空 tool_calls 数组
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length === 0) {
      delete delta.tool_calls
    }
    // 去掉噪音字段
    for (const noise of ['extra_fields', 'refusal', 'reasoning_content']) {
      if (delta[noise] === null || delta[noise] === '' || delta[noise] === undefined) {
        delete delta[noise]
      }
    }
  }
}
