import { Context } from 'hono'
import { getProvider, getProviders } from './storage'
import { KV_KEYS, KEY_HEALTH_COOLDOWN_MS, KEY_HEALTH_MAX_FAILURES } from './config'
import type { Env, ProxyRequestBody } from './types'
import { isOpenCodeProvider, proxyOpenCodeRequest, resolveOpenCodeUrls } from './opencode'
import { isQoderProvider, proxyQoderChatRequest } from './qoder/proxy'
import { writeLog } from './admin'
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
  aggregateOpenAIToResponses,
  finalizeAnthropicStream,
  diagnoseAnthropicAccumulator,
} from './formats'

// ===== Key 健康状态类型和辅助函数 =====

interface KeyHealth {
  failures: number
  lastFailed: boolean
  demotedAt?: number  // 首次达到降权阈值的时间戳 (Date.now())
}
type HealthMap = Record<string, KeyHealth>

const HEALTH_KEY = (providerId: string) => KV_KEYS.KEY_HEALTH_PREFIX + providerId

async function readHealth(env: Env, providerId: string): Promise<HealthMap> {
  const raw = await env.KV.get(HEALTH_KEY(providerId))
  return raw ? JSON.parse(raw) : {}
}

async function writeHealth(env: Env, providerId: string, health: HealthMap): Promise<void> {
  // 只保存有失败记录的 key，避免 KV 膨胀
  const filtered: HealthMap = {}
  for (const [k, v] of Object.entries(health)) {
    if (v.failures > 0) filtered[k] = v
  }
  if (Object.keys(filtered).length > 0) {
    await env.KV.put(HEALTH_KEY(providerId), JSON.stringify(filtered))
  } else {
    // 全部健康，删除 KV 条目
    await env.KV.delete(HEALTH_KEY(providerId)).catch(() => {})
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
      const cleaned = cleanFn(chunk)
      if (cleaned) {
        const encoder = new TextEncoder()
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
          if (line) await writer.write(line)
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
    try {
      const errorData = await response.json() as { error?: { message?: string } }
      errorBody = errorData?.error?.message || JSON.stringify(errorData)
    } catch {
      errorBody = await response.text()
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
export async function handleProxy(c: Context<{ Bindings: Env }>) {
  try {
    const body = await c.req.json<ProxyRequestBody>()
    return await forwardProxy(c, body, c.req.method)
  } catch (err) {
    const error = err as Error
    return c.json({
      error: { message: error.message || '代理转发内部错误', type: 'server_error' },
    }, 500)
  }
}

/**
 * 转发核心逻辑：校验模型 → 路由到对应上游（opencode / qoder / oauth / 通用 Key 轮询），
 * 返回上游 Response。HTTP 路径由 handleProxy 直接返回；WS 桥接路径（ws.ts）读取其
 * 响应体并分块以 WS 文本帧回推。
 *
 * @param method 请求方法，HTTP 路径默认取 c.req.method；WS 桥接强制传 'POST'
 */
export async function forwardProxy(
  c: Context<{ Bindings: Env }>,
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
      return c.json({
        error: { message: `模型 "${modelId}" 未在提供商 "${provider.name}" 中配置`, type: 'invalid_request_error' },
      }, 404)
    }
    if (!modelConfig.enabled) {
      return c.json({
        error: { message: `模型 "${modelId}" 已禁用`, type: 'model_disabled' },
      }, 403)
    }

    const enabledKeys = provider.apiKeys.filter(k => k.enabled)
    const forwardBody = { ...body, model: modelId }
    const url = new URL(c.req.url)
    const subPath = url.pathname.replace(/^\/v1\//, '') || 'chat/completions'

    if (isOpenCodeProvider(providerId)) {
      const response = await proxyOpenCodeRequest({
        baseUrl: provider.baseUrl,
        apiKeys: enabledKeys,
        method,
        subPath,
        search: url.search,
        body: JSON.stringify(forwardBody),
        mirrorUrls: resolveOpenCodeUrls(c.env),
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

    // OAuth 设备码提供商：使用 KV 中保存的 access_token 转发，401 时尝试刷新后重试
    if (provider.authType === 'oauth-device' && provider.oauth) {
      return await proxyOAuthRequest(c, provider, subPath, url.search, forwardBody, method)
    }

    if (enabledKeys.length === 0) {
      return c.json({
        error: { message: `提供商 "${provider.name}" 未配置可用的 API Key`, type: 'configuration_error' },
      }, 500)
    }

    const cleanBase = provider.baseUrl.replace(/\/$/, '')
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
      try {
        const forwardHeaders: Record<string, string> = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        }

        const response = await fetch(forwardUrl, {
          method,
          headers: forwardHeaders,
          body: JSON.stringify(forwardBody),
          signal: AbortSignal.timeout(300000),
        })

        if (response.ok) {
          // 成功：重置健康状态
          if (healthData[apiKey]?.failures > 0) {
            delete healthData[apiKey]
            healthUpdated = true
          }
          if (healthUpdated) await writeHealth(c.env, providerId, healthData)

          try { c.executionCtx.waitUntil(writeLog(c.env, 'request', `[${provider.name}] ${model} → 200 (key: ${apiKey.substring(0, 8)}...)`, `provider=${providerId}`)) } catch {}
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

        // 其他错误（400/404 等）直接返回
        const errorData = await response.json().catch(async () => ({ error: { message: await response.text() } }))
        try { c.executionCtx.waitUntil(writeLog(c.env, 'error', `[${provider.name}] ${model} → ${response.status} ${forwardUrl}`, JSON.stringify({ error: errorData, body: summarizeRequestBody(forwardBody), url: forwardUrl }).substring(0, 4000))) } catch {}
        return c.json(errorData, response.status as Parameters<typeof c.json>[1])
      } catch (err) {
        const error = err as Error
        // 网络错误也标记为失败
        const h = healthData[apiKey] || { failures: 0, lastFailed: false }
        h.failures++
        h.lastFailed = true
        if (h.failures >= KEY_HEALTH_MAX_FAILURES) {
          h.demotedAt = Date.now()  // 达到降权阈值或试用失败，重置冷却计时
        }
        healthData[apiKey] = h
        healthUpdated = true
        lastError = new Response(JSON.stringify({
          error: { message: error.message || '请求失败', type: 'proxy_error' },
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
async function proxyOAuthRequest(
  c: Context<{ Bindings: Env }>,
  provider: import('./types').Provider,
  subPath: string,
  search: string,
  forwardBody: object,
  method: string = c.req.method
): Promise<Response> {
  const cfg = provider.oauth!

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
    // WorkBuddy 只支持流式请求，强制 stream: true
    const originalStream = body.stream
    if (provider.id === 'workbuddy' && body.stream !== true) {
      body.stream = true
    }
    return fetch(buildForwardUrl(r), {
      method,
      headers: buildOauthHeaders(cfg, token, { origin: buildOrigin(r), apiType: provider.apiType, cookies: tokenState?.cookies }),
      body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(300000),
    }).then(resp => ({ resp, originalStream }))
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
      return c.json({
        error: { message: 'OAuth 未连接或 Token 已失效，请在管理后台重新授权', type: 'oauth_not_connected' },
      }, 502)
    }

    const primaryRealm = resolveRealm(token)
    let { resp: response, originalStream } = await doFetch(token)

    // 401/403：可能 token 过期，刷新后重试一次
    if ((response.status === 401 || response.status === 403) && tokenState?.refresh_token) {
      const refreshed = await refreshOauthToken(c.env, provider.id, cfg)
      if (refreshed) {
        const freshState = await readOauthToken(c.env, provider.id)
        if (freshState) {
          tokenState = freshState
          const retry = await doFetch(freshState.access_token)
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
        const altResult = await doFetch(token, alt)
        if (altResult.resp.ok || altResult.resp.status !== 401) {
          response = altResult.resp
          originalStream = altResult.originalStream
        }
      }
    }

    // WorkBuddy 非流式请求：收集 SSE 流并聚合成非流式 chat.completion 返回
    if (response.ok && originalStream !== true && provider.id === 'workbuddy' && response.body) {
      try {
        const aggregated = await aggregateWorkbuddySSE(response.body, (forwardBody as Record<string, unknown>).model as string)
        return new Response(aggregated, {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        })
      } catch (aggErr) {
        console.error('[proxy-oauth] SSE aggregation failed:', aggErr)
        // 聚合失败，回退到透传（客户端可能能处理）
      }
    }

    return passthroughResponse(response, cleanWorkbuddyChunk)
  } catch (err) {
    const error = err as Error
    return c.json({
      error: { message: `OAuth 转发失败: ${error.message || '未知错误'}`, type: 'proxy_error' },
    }, 502)
  }
}

/** 处理 /v1/models — 返回所有已启用的模型（含提供商前缀） */
export async function handleModels(c: Context<{ Bindings: Env }>) {
  const providers = await getProviders(c.env)
  // 从中间件获取转发 Key（可能带有 allowedModels 过滤）
  const proxyKey = (c as any).get('proxyKey') as import('./types').ProxyKey | undefined
  const allowed = proxyKey?.allowedModels
  const allowSet = allowed && allowed.length > 0 ? new Set(allowed) : null

  const models: Array<{
    id: string
    provider: string
    provider_name: string
    object: string
    created: number
    owned_by: string
  }> = []

  for (const provider of providers) {
    if (!provider.enabled) continue
    for (const model of provider.models) {
      if (!model.enabled) continue
      const fullId = `${provider.id}/${model.id}`
      // 如果转发 Key 配置了 allowedModels，只返回允许的模型
      if (allowSet && !allowSet.has(fullId)) continue
      models.push({
        id: fullId,
        provider: provider.id,
        provider_name: provider.name,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: provider.id,
      })
    }
  }

  return c.json({
    object: 'list',
    data: models,
  })
}

// ============================================================
//  Anthropic Messages API 代理  /v1/messages
//  将 Anthropic 格式请求转为 OpenAI Chat Completions，
//  调用 WorkBuddy 上游，再将响应转回 Anthropic 格式。
// ============================================================

export async function handleAnthropicMessages(c: Context<{ Bindings: Env }>) {
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

    const originalStream = anthropicReq.stream === true

    // QoderWork：COSY 签名转发（Anthropic 格式）。上游只收 OpenAI 格式流式，
    // 由 proxyQoderChatRequest 转发后返回 OpenAI SSE，这里再转回 Anthropic SSE。
    if (isQoderProvider(provider.id)) {
      return await handleAnthropicQoder(c, provider, model, openaiBody, originalStream)
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

      let response = await fetch(upstreamUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(upstreamBody),
        signal: AbortSignal.timeout(300000),
      })

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
            response = await fetch(upstreamUrl, {
              method: 'POST',
              headers: retryHeaders,
              body: JSON.stringify(upstreamBody),
              signal: AbortSignal.timeout(300000),
            })
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
          error: { type: 'upstream_error', message: `Upstream error: ${errText}` },
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

    // 非 OAuth 提供商：用 apiKey 标准转发，始终发 OpenAI 格式到上游
    const enabledKeys = provider.apiKeys.filter(k => k.enabled)
    if (enabledKeys.length === 0) {
      return c.json({
        type: 'error',
        error: { type: 'configuration_error', message: `Provider "${provider.name}" has no enabled API keys` },
      }, 500)
    }

    const cleanBase = provider.baseUrl.replace(/\/$/, '')
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
    const apiKey = enabledKeys[0].key

    const response = await fetch(forwardUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(300000),
    })

    if (!response.ok) {
      const errText = await response.text()
      try { c.executionCtx.waitUntil(writeLog(c.env, 'error', `[anthropic] ${model} → ${response.status} ${forwardUrl}`, JSON.stringify({ error: errText, body: summarizeRequestBody(upstreamBody), url: forwardUrl }).substring(0, 4000))) } catch {}
      return c.json({
        type: 'error',
        error: { type: 'upstream_error', message: `Upstream error: ${errText}` },
      }, response.status as Parameters<typeof c.json>[1])
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
  c: Context<{ Bindings: Env }>,
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
      error: { type: 'upstream_error', message: `Upstream error: ${errText}` },
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

// ============================================================
//  OpenAI Responses API 代理  /v1/responses
//  将 Responses 格式请求转为 Chat Completions，调用上游，
//  再将响应转回 Responses 格式。
// ============================================================

export async function handleResponses(c: Context<{ Bindings: Env }>) {
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

    const originalStream = responsesReq.stream === true

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

      let response = await fetch(upstreamUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(upstreamBody),
        signal: AbortSignal.timeout(300000),
      })

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
            response = await fetch(upstreamUrl, {
              method: 'POST',
              headers: retryHeaders,
              body: JSON.stringify(upstreamBody),
              signal: AbortSignal.timeout(300000),
            })
          }
        }
      }

      if (!response.ok) {
        const errText = await response.text()
        try { c.executionCtx.waitUntil(writeLog(c.env, 'error', `[responses] ${model} → ${response.status} ${upstreamUrl}`, JSON.stringify({ error: errText, body: summarizeRequestBody(upstreamBody), url: upstreamUrl }).substring(0, 4000))) } catch {}
        return c.json({
          error: { message: `Upstream error: ${errText}`, type: 'upstream_error' },
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
      return c.json(openaiResp)
    }

    // 非 OAuth 提供商：用 apiKey 标准转发，始终发 OpenAI 格式到上游
    const enabledKeys = provider.apiKeys.filter(k => k.enabled)
    if (enabledKeys.length === 0) {
      return c.json({
        error: { type: 'configuration_error', message: `Provider "${provider.name}" has no enabled API keys` },
      }, 500)
    }

    const cleanBase = provider.baseUrl.replace(/\/$/, '')
    const forwardUrl = `${cleanBase}/chat/completions`
    const upstreamBody: Record<string, unknown> = { ...openaiBody, stream: true }
    // 清理上游不支持的字段 + 被屏蔽的 Claude Code 模板短语
    sanitizeUpstreamBody(upstreamBody)
    sanitizeBlockedTemplates(upstreamBody)
    const apiKey = enabledKeys[0].key

    const response = await fetch(forwardUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(300000),
    })

    if (!response.ok) {
      const errText = await response.text()
      try { c.executionCtx.waitUntil(writeLog(c.env, 'error', `[responses] ${model} → ${response.status} ${forwardUrl}`, JSON.stringify({ error: errText, body: summarizeRequestBody(upstreamBody), url: forwardUrl }).substring(0, 4000))) } catch {}
      return c.json({
        error: { message: `Upstream error: ${errText}`, type: 'upstream_error' },
      }, response.status as Parameters<typeof c.json>[1])
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
    return c.json(openaiResp)
  } catch (err) {
    console.error('[responses] error:', err)
    return c.json({ error: { message: 'Internal server error', type: 'server_error' } }, 500)
  }
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
