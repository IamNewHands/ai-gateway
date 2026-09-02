/**
 * proxy.ts — QoderWork 上游转发（移植自 cpa-plugin/qoderwork/main.go + stream.go）。
 *
 * 与 WorkBuddy 的差异：
 *   1. 请求体必须是 baseprompt.json 模板渲染出的 agent_chat_generation JSON，
 *      再经 QoderEncoding 编码后 POST 到 gateway 的 SSE 端点。
 *   2. 请求头由 COSY 签名生成（RSA 包 AES key + AES 加密身份 + MD5 摘要）。
 *   3. 上游 SSE 是「嵌套」的：每行 `data:{"body":"<OpenAI chunk JSON 字符串>"}`，
 *      需要先解包出内层 OpenAI chunk，再转发给客户端。
 *
 * 端点：
 *   POST /algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1
 *   GET  /algo/api/v2/model/list?Encode=1（模型发现，同样需要 COSY 签名）
 */

import type { Env, Provider } from '../types'
import { getOauthAccessToken, readOauthToken, refreshOauthToken, refreshQoderTokenPair } from '../oauth'
import { buildQoderBody, cpaToUpstreamKey } from './body'
import { qoderEncode, cosySessionFor, cosyHeaders, buildBearer, type CosySession } from './cosy'
import { classifyQoderError, qoderOpenAIErrorBody, type QoderClassified } from './classify'
import {
  seedQoderPoolFromSingle,
  readQoderPool,
  pickQoderAccount,
  refreshQoderPoolAccountIfNeeded,
  cooldownQoderAccount,
  disableQoderAccount,
  noteQoderError,
  noteQoderSuccess,
  resolveQoderCooldown,
  type QoderPoolAccount,
} from './pool'
import { streamFetchWithTimeout } from '../opencode'

export const QODER_PROVIDER_ID = 'qoder'
export const QODER_GATEWAY = 'https://gateway.qoder.com.cn'
export const QODER_CHAT_URL =
  QODER_GATEWAY +
  '/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1'
export const QODER_MODELS_URL = QODER_GATEWAY + '/algo/api/v2/model/list?Encode=1'

// 国际版（keirouter）端点：授权 qoder.com / 推理 api3.qoder.sh / token openapi.qoder.sh
export const QODER_INTL_GATEWAY = 'https://api3.qoder.sh'
export const QODER_CHAT_URL_INTL =
  QODER_INTL_GATEWAY +
  '/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1'
export const QODER_MODELS_URL_INTL = QODER_INTL_GATEWAY + '/algo/api/v2/model/list?Encode=1'

/** 按账号域解析推理（chat）端点：CN → gateway.qoder.com.cn，global → api3.qoder.sh。 */
export function qoderChatUrl(realm: 'cn' | 'global' = 'cn'): string {
  return realm === 'global' ? QODER_CHAT_URL_INTL : QODER_CHAT_URL
}

/** 按账号域解析模型列表端点（均带 Encode=1 参数）。 */
export function qoderModelsUrl(realm: 'cn' | 'global' = 'cn'): string {
  return realm === 'global' ? QODER_MODELS_URL_INTL : QODER_MODELS_URL
}

export function isQoderProvider(providerId: string): boolean {
  return providerId === QODER_PROVIDER_ID
}

/** 去掉 "qoder/" 前缀，留下裸模型名（与插件 stripProviderPrefix 一致）。 */
function stripProviderPrefix(model: string): string {
  const i = model.indexOf('/')
  if (i > 0) return model.slice(i + 1)
  return model
}

/** 构造 COSY 会话（单 token 回退路径，token 自动刷新）。拿不到 token 返回 null。 */
async function buildQoderSession(
  env: Env,
  provider: Provider
): Promise<{ session: CosySession; accessToken: string; realm: 'cn' | 'global' } | null> {
  const cfg = provider.oauth
  if (!cfg) return null
  let token = await getOauthAccessToken(env, provider.id, cfg)
  if (!token) {
    const ok = await refreshOauthToken(env, provider.id, cfg)
    if (ok) token = await getOauthAccessToken(env, provider.id, cfg)
  }
  if (!token) return null
  const state = await readOauthToken(env, provider.id)
  const session = await cosySessionFor(
    token,
    state?.refresh_token || '',
    state?.user_id || '',
    state?.nickname || ''
  )
  return { session, accessToken: token, realm: state?.realm === 'global' ? 'global' : 'cn' }
}

/** 从池账号构造 COSY 会话（必要时刷新 token 并写回池）。 */
async function buildQoderAccountSession(
  env: Env,
  provider: Provider,
  account: QoderPoolAccount
): Promise<CosySession | null> {
  const cfg = provider.oauth
  if (!cfg) return null
  const refreshed = await refreshQoderPoolAccountIfNeeded(env, provider.id, account.uid, cfg, refreshQoderTokenPair)
  if (!refreshed) return null
  const t = refreshed.token
  return cosySessionFor(t.access_token, t.refresh_token || '', refreshed.uid, refreshed.nickname || '')
}

/**
 * 按错误分类对池账号施加冷却/禁用（对齐 cli2api pool.MarkClassified 语义）：
 *   quota      → 长冷却（planMs，签到恢复积分后自动解冻）
 *   rate_limit → 短冷却（Retry-After 优先，回退 softMs）
 *   auth       → 禁用（需重新登录）
 *   其余       → 分类器给出的冷却时长（>0 时），并记一次连续错误
 */
async function markQoderAccountClassified(
  env: Env,
  provider: Provider,
  uid: string,
  c: QoderClassified
): Promise<void> {
  const cd = resolveQoderCooldown(provider)
  switch (c.kind) {
    case 'quota':
      await cooldownQoderAccount(env, provider.id, uid, cd.planMs, '额度耗尽（' + c.message.substring(0, 80) + '）')
      break
    case 'auth':
      await disableQoderAccount(env, provider.id, uid, '鉴权失败：' + c.message.substring(0, 80))
      break
    case 'rate_limit':
      await cooldownQoderAccount(env, provider.id, uid, (c.cooldownSeconds || 0) * 1000 || cd.softMs, '限流（429）')
      break
    default:
      if (c.cooldownSeconds > 0) {
        await cooldownQoderAccount(env, provider.id, uid, c.cooldownSeconds * 1000, c.kind + ': ' + c.message.substring(0, 60))
      } else {
        await noteQoderError(env, provider.id, uid, cd)
      }
  }
}

/** 判断一个 SSE 字段是否为「零值」（空壳），应被剥离。 */
function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true
  if (typeof v === 'string') return v === ''
  if (Array.isArray(v)) return v.length === 0
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
    if (entries.length === 0) return true
    for (const [, val] of entries) {
      if (!isEmptyValue(val)) return false
    }
    return true
  }
  return false
}

/**
 * 清洗内层 OpenAI chunk（移植自 stream.go cleanChunkJSON）：
 * - 去掉空的 function_call / tool_calls（QoderWork 终包常带，严格客户端会视为截断的工具调用）
 * - 去掉 extra_fields / refusal / reasoning_content 噪音空壳
 * - 完全空 delta 且无 finish_reason 的包直接丢弃
 * 返回 '' 表示该包应被忽略。
 */
function cleanQoderChunk(raw: string): string {
  let obj: any
  try {
    obj = JSON.parse(raw)
  } catch {
    return raw
  }
  let changed = false
  if (Array.isArray(obj.choices)) {
    for (const choice of obj.choices) {
      const delta = choice && typeof choice === 'object' ? choice.delta : null
      if (!delta || typeof delta !== 'object') continue
      if ('function_call' in delta && isEmptyValue(delta.function_call)) {
        delete delta.function_call
        changed = true
      }
      if ('tool_calls' in delta) {
        const v = delta.tool_calls
        if (Array.isArray(v) && v.length === 0) {
          delete delta.tool_calls
          changed = true
        }
      }
      for (const noise of ['extra_fields', 'refusal', 'reasoning_content']) {
        if (noise in delta && isEmptyValue(delta[noise])) {
          delete delta[noise]
          changed = true
        }
      }
      // 完全空的 delta 且该 choice 无 finish_reason → 丢弃整包
      if (Object.keys(delta).length === 0 && !choice.finish_reason) return ''
    }
  }
  return changed ? JSON.stringify(obj) : raw
}

function notEmpty(v: unknown): boolean {
  return typeof v === 'string' && v.trim() !== ''
}

/** 合并流式 tool_call 增量（id/type 首次出现取全量，name/arguments 拼接）。 */
function mergeToolCallDelta(merged: Record<string, any>, delta: Record<string, any>): void {
  for (const k of ['id', 'type']) {
    if (merged[k] === undefined && notEmpty(delta[k])) merged[k] = delta[k]
  }
  const dfn = delta.function
  if (!dfn || typeof dfn !== 'object') return
  let mfn = merged.function
  if (!mfn || typeof mfn !== 'object') {
    mfn = {}
    merged.function = mfn
  }
  if (notEmpty(dfn.name)) mfn.name = (mfn.name || '') + dfn.name
  if (notEmpty(dfn.arguments)) mfn.arguments = (mfn.arguments || '') + dfn.arguments
}

/**
 * 聚合内层 OpenAI chunk 为非流式 chat.completion（移植自 stream.go aggregateCompletion）。
 * 输入：逐行 `data:<json>` 或裸 JSON 行的文本流。
 */
function aggregateQoderChunks(text: string, model: string): string {
  let content = ''
  let reasoning = ''
  let role = ''
  let respModel = ''
  let respID = ''
  let finish = ''
  let created = 0
  let usage: Record<string, unknown> | null = null
  const toolCalls = new Map<number, Record<string, any>>()
  const toolOrder: number[] = []

  for (let line of text.split('\n')) {
    line = line.trim()
    if (!line.startsWith('data:')) continue
    let data = line.slice(5).trim()
    while (data.startsWith('data:')) data = data.slice(5).trim()
    if (!data || data === '[DONE]') continue
    let chunk: any
    try {
      chunk = JSON.parse(data)
    } catch {
      continue
    }
    if (notEmpty(chunk.id)) respID = chunk.id
    if (notEmpty(chunk.model)) respModel = chunk.model
    if (typeof chunk.created === 'number') created = chunk.created
    if (chunk.usage && typeof chunk.usage === 'object') usage = chunk.usage
    if (!Array.isArray(chunk.choices)) continue
    for (const choice of chunk.choices) {
      if (!choice || typeof choice !== 'object') continue
      const delta = choice.delta
      if (delta && typeof delta === 'object') {
        if (notEmpty(delta.role)) role = delta.role
        if (typeof delta.content === 'string') content += delta.content
        if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            if (!tc || typeof tc !== 'object') continue
            const idx = typeof tc.index === 'number' ? tc.index : 0
            let merged = toolCalls.get(idx)
            if (!merged) {
              merged = { index: idx }
              toolCalls.set(idx, merged)
              toolOrder.push(idx)
            }
            mergeToolCallDelta(merged, tc)
          }
        }
      }
      if (notEmpty(choice.finish_reason)) finish = choice.finish_reason
    }
  }

  const message: Record<string, any> = { role: role || 'assistant', content }
  if (reasoning) message.reasoning_content = reasoning
  if (toolOrder.length > 0) {
    toolOrder.sort((a, b) => a - b)
    message.tool_calls = toolOrder.map((idx) => toolCalls.get(idx))
  }
  if (!created) created = Math.floor(Date.now() / 1000)
  const result: Record<string, any> = {
    id: respID || 'chatcmpl-qoderwork',
    object: 'chat.completion',
    created,
    model: respModel || model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finish || 'stop',
      },
    ],
  }
  if (usage) result.usage = usage
  return JSON.stringify(result)
}

/**
 * 将上游嵌套 SSE 流转换为客户端可用的 OpenAI SSE 流：
 * `data:{"body":"<json>"}` → 解包 → 清洗 → `data: <cleaned>\n\n`，末尾 `data: [DONE]\n\n`。
 */
function unwrapQoderSSE(upstreamBody: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  const decoder = new TextDecoderStream()
  const reader = upstreamBody.pipeThrough(decoder).getReader()
  const encoder = new TextEncoder()
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
          if (!trimmed.startsWith('data:')) continue
          const payload = trimmed.slice(5).trim()
          if (!payload) continue
          let outer: any
          try {
            outer = JSON.parse(payload)
          } catch {
            continue
          }
          const bodyStr = outer && typeof outer.body === 'string' ? outer.body : ''
          if (!bodyStr || bodyStr === '[DONE]') continue
          const cleaned = cleanQoderChunk(bodyStr)
          if (!cleaned) continue
          controller.enqueue(encoder.encode(`data: ${cleaned}\n\n`))
        }
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
    async cancel() {
      try {
        await reader.cancel()
      } catch {
        /* ignore */
      }
    },
  })
}

export interface QoderProxyOptions {
  /** 客户端是否要求流式（false 时聚合为非流式 chat.completion）；缺省按 forwardBody.stream */
  stream?: boolean
  /** 签名用的 model key（已 cpaToUpstreamKey 映射） */
  modelKey?: string
  /** 会话注入（测试/工具调用用），缺省按 provider 从 KV 拉取 */
  session?: { session: CosySession }
  /** 请求头 X-Qoder-Account：客户端固定使用指定账号（池内 uid）。缺省自动挑选。 */
  preferUid?: string
}

/** 单次上游发送的结果：成功 Response，或分类后的错误（供池循环决定冷却与轮转）。 */
type QoderSendResult =
  | { ok: true; response: Response }
  | { ok: false; classified: QoderClassified }

/** 用给定 COSY 会话发送一次 chat 请求并构造客户端响应（流式/非流式）。 */
async function sendQoderChatOnce(
  session: CosySession,
  encodedBody: string,
  modelKey: string,
  model: string,
  wantStream: boolean,
  accountUid?: string,
  realm: 'cn' | 'global' = 'cn'
): Promise<QoderSendResult> {
  const chatUrl = qoderChatUrl(realm)
  const headers = cosyHeaders(session, encodedBody, chatUrl, 'text/event-stream', true)
  headers['x-model-key'] = modelKey
  headers['x-model-source'] = 'system'

  let resp: Response
  try {
    resp = await streamFetchWithTimeout(chatUrl, {
      method: 'POST',
      headers,
      body: encodedBody,
    })
  } catch (err) {
    return {
      ok: false,
      classified: classifyQoderError({ status: 0, body: (err as Error).message || '网络请求失败' }),
    }
  }

  if (!resp.ok || !resp.body) {
    const errText = await resp.text().catch(() => '')
    return {
      ok: false,
      classified: classifyQoderError({
        status: resp.status,
        body: errText,
        retryAfter: resp.headers.get('retry-after') || undefined,
      }),
    }
  }

  const extraHeaders: Record<string, string> = accountUid
    ? { 'X-Qoder-Account': accountUid }
    : {}

  if (wantStream) {
    const readable = unwrapQoderSSE(resp.body, model)
    return {
      ok: true,
      response: new Response(readable, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          'X-Accel-Buffering': 'no',
          ...extraHeaders,
        },
      }),
    }
  }

  // 非流式：收集全部内层 chunk 聚合
  const decoder = new TextDecoderStream()
  const reader = resp.body.pipeThrough(decoder).getReader()
  const chunks: string[] = []
  let lineBuffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const combined = lineBuffer + value
    const lines = combined.split('\n')
    lineBuffer = lines.pop() || ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (!payload) continue
      let outer: any
      try {
        outer = JSON.parse(payload)
      } catch {
        continue
      }
      const bodyStr = outer && typeof outer.body === 'string' ? outer.body : ''
      if (!bodyStr || bodyStr === '[DONE]') continue
      chunks.push(`data: ${bodyStr}\n\n`)
    }
  }
  const aggregated = aggregateQoderChunks(chunks.join(''), model)
  return {
    ok: true,
    response: new Response(aggregated, {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders },
    }),
  }
}

/** 分类错误 → 结构化 OpenAI 错误 Response。 */
function classifiedErrorResponse(c: QoderClassified): Response {
  const respHeaders: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' }
  if (c.cooldownSeconds > 0) respHeaders['Retry-After'] = String(c.cooldownSeconds)
  return new Response(qoderOpenAIErrorBody(c), { status: c.status, headers: respHeaders })
}

/**
 * 转发一次 chat 请求到 QoderWork 上游（多账号池模式）。
 * 返回 Response：
 *   - stream=true：OpenAI SSE（解包+清洗后的内层 chunk）
 *   - stream=false：聚合的非流式 chat.completion JSON
 *
 * 池模式：兼容种子单 token → 按「剩余积分最高且健康」挑号 → 失败按错误分类
 * 冷却/禁用并自动轮转下一个账号（quota 也轮转，全部耗尽才向客户端报 429）。
 */
export async function proxyQoderChatRequest(
  env: Env,
  provider: Provider,
  forwardBody: Record<string, unknown>,
  opts?: QoderProxyOptions
): Promise<Response> {
  const model = (forwardBody.model as string) || 'auto'
  const modelKey = opts?.modelKey || cpaToUpstreamKey(stripProviderPrefix(model))
  const messages = Array.isArray(forwardBody.messages) ? (forwardBody.messages as any[]) : []
  const body = buildQoderBody(messages, modelKey)
  const encodedBody = qoderEncode(body)
  const wantStream = opts?.stream ?? forwardBody.stream === true

  // 会话注入（测试/工具）：单次直发，不经过池
  if (opts?.session) {
    const r = await sendQoderChatOnce(opts.session.session, encodedBody, modelKey, model, wantStream)
    return r.ok ? r.response : classifiedErrorResponse(r.classified)
  }

  // 池路径：兼容迁移（池空时把单 token 种子进池），然后挑号轮转
  try { await seedQoderPoolFromSingle(env, provider.id) } catch { /* ignore */ }
  let poolLen = 0
  try {
    const pool = await readQoderPool(env, provider.id)
    poolLen = pool.length
  } catch { /* ignore */ }

  if (poolLen > 0) {
    const tried = new Set<string>()
    let lastErr: QoderClassified | null = null

    for (let i = 0; i < poolLen; i++) {
      let account: QoderPoolAccount | null = null
      try {
        // 账号固定：首轮优先用 X-Qoder-Account 指定的 uid，之后自动挑号轮转
        account = await pickQoderAccount(env, provider.id, tried, i === 0 ? opts?.preferUid : undefined)
      } catch { /* ignore */ }
      if (!account) break
      tried.add(account.uid)

      // 会话构造（含按账号刷新 token）；刷新失败视为鉴权失效 → 禁用并轮转
      let session: CosySession | null = null
      try {
        session = await buildQoderAccountSession(env, provider, account)
      } catch { /* ignore */ }
      if (!session) {
        await disableQoderAccount(env, provider.id, account.uid, 'token 刷新失败（需重新登录）')
        lastErr = {
          status: 401,
          kind: 'auth',
          failover: true,
          cooldownSeconds: 0,
          message: `账号 ${account.nickname || account.uid} token 刷新失败，已禁用并轮转`,
          code: 'unauthorized',
          type: 'api_error',
        }
        continue
      }

      const r = await sendQoderChatOnce(session, encodedBody, modelKey, model, wantStream, account.uid, account.realm === 'global' ? 'global' : 'cn')
      if (r.ok) {
        await noteQoderSuccess(env, provider.id, account.uid)
        return r.response
      }
      // 失败：按分类冷却/禁用，然后轮转下一个账号
      await markQoderAccountClassified(env, provider, account.uid, r.classified)
      lastErr = r.classified
    }

    if (lastErr) {
      // 全部账号失败：把最后一个（或最有代表性的）错误返回给客户端
      return classifiedErrorResponse(lastErr)
    }
    // 无健康账号可用（全冷却/禁用）
    return new Response(
      JSON.stringify({
        error: {
          message: 'QoderWork 所有账号均不可用（冷却中或已禁用），请稍后重试或在管理后台重新登录',
          type: 'api_error',
          code: 'no_available_account',
          kind: 'not_ready',
        },
      }),
      { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    )
  }

  // 回退：无池（旧部署未登录池账号）→ 单 token 直发
  const data = await buildQoderSession(env, provider)
  if (!data) {
    return new Response(
      JSON.stringify({
        error: { message: 'OAuth 未连接或 Token 已失效，请在管理后台重新授权', type: 'oauth_not_connected' },
      }),
      { status: 502, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    )
  }
  const r = await sendQoderChatOnce(data.session, encodedBody, modelKey, model, wantStream, undefined, data.realm)
  return r.ok ? r.response : classifiedErrorResponse(r.classified)
}

/**
 * 拉取 QoderWork 模型列表（GET /algo/api/v2/model/list，COSY 签名，返回普通 JSON）。
 * 响应：{"chat":[{key,display_name,enable,...}], ...}，只取 chat 场景启用的模型。
 */
export async function fetchQoderModels(
  env: Env,
  provider: Provider
): Promise<{ ok: boolean; message: string; models?: Array<{ id: string }>; status?: number; debug?: Record<string, unknown> }> {
  const debug: Record<string, unknown> = {}
  console.log(`[qoder-models] start provider=${provider.id} flowType=${provider.oauth?.flowType}`)
  let session: CosySession | null = null
  let sessionRealm: 'cn' | 'global' = 'cn'
  try {
    // 优先用池内账号（挑剩余积分最高的健康账号），池空回退单 token
    try { await seedQoderPoolFromSingle(env, provider.id) } catch { /* ignore */ }
    const acc = await pickQoderAccount(env, provider.id, new Set())
    if (acc) {
      session = await buildQoderAccountSession(env, provider, acc)
      sessionRealm = acc.realm === 'global' ? 'global' : 'cn'
    }
    if (!session) {
      const data = await buildQoderSession(env, provider)
      session = data?.session || null
      sessionRealm = data?.realm || 'cn'
    }
  } catch (err) {
    console.error(`[qoder-models] buildQoderSession threw:`, err)
    return { ok: false, message: `构建 COSY 会话失败: ${(err as Error).stack || (err as Error).message || err}`, debug }
  }
  if (!session) {
    console.warn(`[qoder-models] no valid token (缺失或刷新失败)`)
    return { ok: false, message: 'OAuth 未连接或 Token 已失效，请先发起连接', debug }
  }
  console.log(`[qoder-models] session ok uid=${session.uid || '(empty)'} machineType=${session.machineType.slice(0, 8)}...`)
  // 只记长度，绝不打印 machineToken / info / cosyKey 原文（均为会话凭据）
  console.log(`[qoder-models] machineId=${session.machineId} machineToken len=${session.machineToken.length}`)
  console.log(`[qoder-models] info len=${session.info.length}`)
  console.log(`[qoder-models] cosyKey len=${session.cosyKey.length}`)
  debug.machineId = session.machineId
  debug.machineType = session.machineType
  debug.machineTokenLen = session.machineToken.length
  debug.infoLen = session.info.length
  debug.cosyKeyLen = session.cosyKey.length
  debug.uid = session.uid || '(empty)'

  let encodedBody: string
  try {
    encodedBody = qoderEncode('{}')
    console.log(`[qoder-models] encodedBody len=${encodedBody.length}`)
    debug.encodedBodyLen = encodedBody.length
  } catch (err) {
    console.error(`[qoder-models] qoderEncode threw:`, err)
    return { ok: false, message: `QoderEncoding 失败: ${(err as Error).message || err}`, debug }
  }

  let headers: Record<string, string>
  const modelsUrl = qoderModelsUrl(sessionRealm)
  try {
    // 先单独调用 buildBearer 获取签名中间值用于调试
    const bearerInfo = buildBearer(session, encodedBody, modelsUrl)
    debug.bearerDate = bearerInfo.date
    debug.bearerSigLen = bearerInfo.sigInput.length
    debug.cosyKeyLen = session.cosyKey.length

    headers = cosyHeaders(session, encodedBody, modelsUrl, 'application/json', false)
    // 请求头可能含 Authorization Bearer 签名，只记头名列表
    console.log(`[qoder-models] request header names:`, Object.keys(headers).join(', '))
    debug.cosyHeaderNames = Object.keys(headers)
  } catch (err) {
    console.error(`[qoder-models] cosyHeaders threw:`, err)
    return { ok: false, message: `COSY 签名失败: ${(err as Error).message || err}`, debug }
  }

  let resp: Response
  try {
    resp = await fetch(modelsUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(20000),
    })
  } catch (err) {
    console.error(`[qoder-models] fetch threw:`, err)
    debug.fetchError = (err as Error).message
    return { ok: false, message: (err as Error).message || '请求失败', debug }
  }
  const rawText = await resp.text().catch(() => '')
  console.log(`[qoder-models] upstream status=${resp.status} body=${rawText.substring(0, 300)}`)
  debug.upstreamStatus = resp.status
  debug.upstreamBody = rawText.substring(0, 500)
  if (!resp.ok) {
    return { ok: false, message: `HTTP ${resp.status}: ${rawText.substring(0, 300)}`, status: resp.status, debug }
  }
  let json: any = null
  try {
    json = JSON.parse(rawText)
  } catch {
    return { ok: false, message: `响应不是合法 JSON: ${rawText.substring(0, 200)}`, debug }
  }
  const chat = json && Array.isArray(json.chat) ? json.chat : null
  if (!chat) {
    return { ok: false, message: `响应缺少 chat 场景，keys=${Object.keys(json || {}).join(',') || '(empty)'}`, debug }
  }
  const models = chat
    .filter((m: any) => m && m.enable === true && m.key)
    .map((m: any) => ({ id: m.key }))
  if (models.length === 0) {
    return { ok: false, message: '没有启用的 chat 模型', debug }
  }
  return { ok: true, message: 'success', models, debug }
}
