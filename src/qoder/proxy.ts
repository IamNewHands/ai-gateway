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
import { buildQoderBody, cpaToUpstreamKey, fallbackUnknownModel, pickQoderModels, qoderStructuredToolMode, useQoderStructuredToolHistory } from './body'
import type { QoderMetaRealm } from './model-meta'
import { qoderEncode, cosySessionFor, cosyHeaders, buildBearer, type CosySession } from './cosy'
import { classifyQoderError, qoderOpenAIErrorBody, noteQoderInnerError, qoderInnerErrorDetail, qoderInnerErrorClassified, type QoderClassified } from './classify'
import {
  seedQoderPoolFromSingle,
  readQoderPool,
  pickQoderAccount,
  refreshQoderPoolAccountIfNeeded,
  cooldownQoderAccount,
  cooldownQoderAccountModel,
  clearQoderModelCooldown,
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

/**
 * QoderWork 提供商的**唯一**判定入口（路由/签到/模型/测试都必须用它）。
 *
 * 为什么必须集中成一个 owner：同一件事此前有 **3 套写法分布在 8 处**——
 *   1. `isQoderProvider(id)`（只看 id）
 *   2. `isQoderProvider(id) || oauth.flowType === 'qoder'`
 *   3. 上面两条再加 `baseUrl.includes('qoder')`
 * 判定不一致会造成「一半走 COSY、一半走通用 OpenAI」的撕裂：模型列表用写法 3
 * 命中（所以能拉到模型），而推理/测试用写法 1 未命中，于是 POST 到
 * `{baseUrl}/chat/completions`（**不是** Qoder 接口），边缘 ALB 直接回自己的
 * 503 HTML 页 —— 表现为「账号坏了」的**假阴性**，实际是路由判错。
 *
 * 三个信号都是真实存在的用户配置形态：
 *   - 预置模板：`id === 'qoder'`
 *   - 自定义 id 但走了 Qoder 设备授权：`oauth.flowType === 'qoder'`
 *   - 手工填了 Qoder 域名但没选授权流程：`baseUrl` 含 qoder
 */
export function isQoderFlow(provider: { id?: string; baseUrl?: string; oauth?: { flowType?: string } } | null | undefined): boolean {
  if (!provider) return false
  if (provider.id === QODER_PROVIDER_ID) return true
  if (provider.oauth?.flowType === 'qoder') return true
  return String(provider.baseUrl || '').toLowerCase().includes('qoder')
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
 * 会话死亡标记（与 hub qoder_accounts.py:303 `SESSION_DEAD_MARKERS` 同口径）。
 *
 * 上游主动吊销离线会话，此时刷新 token 已无意义，必须停用账号等重新登录；
 * 而**其余** 401/403 只是权限抖动/风控瞬时拒绝，冷却后换号重试即可。
 * 把两者混为一谈的代价是：一次瞬时 403 就把好账号永久禁用（签到也不会解冻）。
 */
const QODER_SESSION_DEAD_MARKERS = ['TOKEN_EXPIRE', '12153', 'Offline user session not found']

/** 上游错误文本（消息或 code）是否表明会话已被吊销。 */
export function isQoderSessionDead(text: string): boolean {
  return QODER_SESSION_DEAD_MARKERS.some((m) => text.includes(m))
}

/**
 * 按错误分类对池账号施加冷却/禁用（对齐 cli2api pool.MarkClassified 语义）：
 *   quota      → 长冷却（planMs，签到恢复积分后自动解冻）
 *   rate_limit → **模型级**短冷却（上游 retryAfterSeconds / Retry-After 优先，回退 softMs）
 *   auth       → **只有会话被上游吊销才停用**；其余 401/403 冷却 60s 后轮换
 *                （hub qoder_proxy.py:2642-2656 口径：dead→300s+停用，非 dead→60s）
 *   content_policy → **不记任何状态**：这是客户端输入被审核拒绝，账号本身没问题；
 *                    记错误会让连续几次敏感输入把好账号冷却掉
 *   其余       → 分类器给出的冷却时长（>0 时），并记一次连续错误
 *
 * `model` 非空时 **rate_limit 只写模型级冷却**（hub `note_error(model=…)`，
 * qoder_accounts.py:610-616）：上游的 429 常是单个模型的频控，账号本身仍可服务其它模型。
 * 旧实现一律写账号级 `until`，于是「在 qmodel 上撞限流」会把该账号在 dmodel/gm51model 上
 * 也一起冻结——白白少用一个健康账号，并把「模型级限流」误报成「账号不可用」。
 */
export async function markQoderAccountClassified(
  env: Env,
  provider: Provider,
  uid: string,
  c: QoderClassified,
  model?: string
): Promise<void> {
  const cd = resolveQoderCooldown(provider)
  switch (c.kind) {
    case 'content_policy':
      // 账号无过错：不改冷却、不改错误计数
      break
    case 'quota':
      await cooldownQoderAccount(env, provider.id, uid, cd.planMs, '额度耗尽（' + c.message.substring(0, 80) + '）')
      break
    case 'auth':
      // 只有会话被吊销才停用账号（hub qoder_proxy.py:2642-2656）：
      //   dead（TOKEN_EXPIRE / 12153 / Offline user session not found）→ 停用，需重新登录；
      //   其余 401/403（权限抖动、风控瞬时拒绝）→ 冷却 60s 后轮换，账号本身没问题。
      // 旧实现一律 disableQoderAccount：一次瞬时 403 就把账号永久打死，且签到不会解冻。
      // 安全网：token 真过期时 buildQoderAccountSession 刷新失败也会走停用分支（见池循环）。
      if (isQoderSessionDead(`${c.code} ${c.message}`)) {
        await disableQoderAccount(env, provider.id, uid, '鉴权失败（会话已失效，需重新登录）：' + c.message.substring(0, 80))
      } else {
        await cooldownQoderAccount(
          env,
          provider.id,
          uid,
          // 基准 60s（hub 同值）；上游若给了更长的 Retry-After 则从长，不缩短
          Math.max(60, c.cooldownSeconds) * 1000,
          '鉴权被拒（非会话失效，冷却后轮换）：' + c.message.substring(0, 60)
        )
      }
      break
    case 'rate_limit': {
      const ms = (c.cooldownSeconds || 0) * 1000 || cd.softMs
      // 有模型上下文 → 只冻这个模型（账号级状态不动）
      if (model) {
        await cooldownQoderAccountModel(env, provider.id, uid, model, ms, `限流（429，仅模型 ${model}）`)
      } else {
        await cooldownQoderAccount(env, provider.id, uid, ms, '限流（429）')
      }
      break
    }
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
 * 上游信封帧 `{headers, body:"<inner chunk>", statusCodeValue}` 的解析结果。
 * statusCodeValue 缺失按 200 处理（部分帧不带该字段）。
 */
interface QoderEnvelope {
  status: number
  /** 内层 OpenAI chunk 原文；非字符串/空串表示本帧无内容 */
  body: string
  /** 信封错误详情（内层 body 优先，回退整帧截断），供错误分类使用 */
  detail: string
}

/**
 * 信封 statusCodeValue 归一化为 int（对齐 qoder2api internal/bridge/delta.go:115-131）：
 * 上游可能给 number / string；无法解析时按 502（瞬时故障）处理而非当成正常帧。
 */
function toEnvelopeStatus(v: unknown): number {
  if (v === undefined || v === null) return 200
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : 502
  if (typeof v === 'string') {
    const n = Number.parseInt(v, 10)
    return Number.isFinite(n) ? n : 502
  }
  return 502
}

/** 解析一帧 `data:` 载荷为信封；非 JSON / 非对象返回 null（调用方跳过）。 */
function parseQoderEnvelope(payload: string): QoderEnvelope | null {
  let outer: any
  try {
    outer = JSON.parse(payload)
  } catch {
    return null
  }
  if (!outer || typeof outer !== 'object') return null
  const status = toEnvelopeStatus(outer.statusCodeValue)
  const body = typeof outer.body === 'string' ? outer.body : ''
  return { status, body, detail: body || payload.slice(0, 400) }
}

/**
 * 解析一行 `data:` 载荷；非信封行返回 null（调用方跳过）。
 * `[DONE]` 与无 body 的帧由调用方处理（本函数只做信封解析）。
 */
function readQoderFrame(line: string): QoderEnvelope | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return null
  const payload = trimmed.slice(5).trim()
  if (!payload) return null
  return parseQoderEnvelope(payload)
}

/** 逐行累加器：把任意分块拼成完整行，未结束的尾行留在缓冲里。 */
function makeLineSplitter(): (chunk: string) => string[] {
  let buf = ''
  return (chunk: string) => {
    const combined = buf + chunk
    const lines = combined.split('\n')
    buf = lines.pop() || ''
    return lines
  }
}

/**
 * 上游「HTTP 200 建流 + 0 有效帧」的空流错误帧（移植 qoder2api internal/bridge/errors.go:31-34
 * `ErrEmptyStream`）。wire 已是 200，只能靠帧内错误让客户端知道失败——否则客户端收到空
 * assistant 消息却按正常 finish 结束（假成功）。
 *
 * code 取 `upstream_parse`，与仓库既有空流口径一致（见 workbuddy-sse.ts 的
 * WORKBUDDY_EMPTY_STREAM_FRAME 注释）。
 */
export const QODER_EMPTY_STREAM_FRAME =
  '{"error":{"message":"empty upstream stream","type":"upstream_error","code":"upstream_parse"}}'

/** 空流的结构化分类：不罚号（cooldownSeconds=0 → 仅记一次错误），允许轮转下一个账号。 */
const QODER_EMPTY_STREAM_CLASSIFIED: QoderClassified = {
  status: 502,
  kind: 'unavailable',
  failover: true,
  cooldownSeconds: 0,
  message: 'empty upstream stream',
  code: 'upstream_parse',
  type: 'upstream_error',
}

/**
 * 首帧闸门最多预读的上游分块数。有界是为了不让「只发噪声帧的长流」把首字节拖到不可预期；
 * 达到上限即放弃闸门、直接按流式透传（后续信封错误仍由流内检测兜底）。
 */
const QODER_GATE_MAX_READS = 4

type QoderSSEOpenResult =
  | { ok: true; stream: ReadableStream<Uint8Array> }
  | { ok: false; classified: QoderClassified }

/**
 * 打开上游嵌套 SSE 流 → 客户端 OpenAI SSE 流，并在**发出 HTTP 头之前**做有界首帧闸门。
 *
 * 为什么要有闸门：源实现（qoder2api `CallQoderWithOpts` 的 emitted 闸门，commit f8037f5）
 * 能在首帧前发现信封错误并**换账号重开**；而「先建流再读」的写法头已发出，只能把错误塞进
 * 帧里，池循环拿不到失败信号、无法轮转。闸门把这两种情形拉回到可重试的位置：
 *
 *  1. **信封错误**：上游把 provider 故障包在 HTTP200 的信封里（statusCodeValue=418/5xx，
 *     access log 记 200 而业务错）→ 不建流，交回池循环按分类冷却/换号。
 *  2. **空流**：建流成功但首帧即正常关流且零有效内容 → 不建流，按 `upstream_parse` 处理。
 *
 * 闸门之后的流内仍保留同样的信封检测：上游完全可能首帧正常、第 N 帧才报错。
 */
async function openQoderSSE(upstreamBody: ReadableStream<Uint8Array>, _model: string): Promise<QoderSSEOpenResult> {
  const reader = upstreamBody.pipeThrough(new TextDecoderStream()).getReader()
  const encoder = new TextEncoder()
  const splitter = makeLineSplitter()
  /** 闸门期已清洗好的、待下发的内层 chunk */
  const pending: string[] = []
  let envelopeError: QoderClassified | null = null
  let streamEnded = false

  let gateReads = 0
  while (pending.length === 0 && !envelopeError && gateReads < QODER_GATE_MAX_READS) {
    const { done, value } = await reader.read()
    gateReads++
    if (done) {
      streamEnded = true
      break
    }
    for (const line of splitter(value)) {
      const env = readQoderFrame(line)
      if (!env) continue
      if (env.status !== 200) {
        envelopeError = classifyQoderError({ status: env.status, body: env.detail })
        break
      }
      if (!env.body || env.body === '[DONE]') continue
      // 内层错误只观测、不改行为：流式把这个 chunk 原样透传给客户端（客户端能看到 error），
      // 但网关侧此前**零痕迹**——排障时无法判断「客户端说上游报错」到底发生过没有。
      noteQoderInnerError(env.body, 'stream')
      const cleaned = cleanQoderChunk(env.body)
      if (!cleaned) continue
      pending.push(cleaned)
    }
  }

  if (envelopeError) {
    // 上游可能仍开着流：主动取消，避免继续读（上游白烧配额）
    try { await reader.cancel() } catch { /* ignore */ }
    return { ok: false, classified: envelopeError }
  }
  if (streamEnded && pending.length === 0) {
    return { ok: false, classified: QODER_EMPTY_STREAM_CLASSIFIED }
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // 已下发的有效帧数：为 0 说明闸门与流内都没拿到内容，收尾补错误帧
      let validFrames = 0
      let midStreamError: QoderClassified | null = null
      for (const c of pending) {
        validFrames++
        controller.enqueue(encoder.encode(`data: ${c}\n\n`))
      }

      try {
        readLoop: while (true) {
          const { done, value } = await reader.read()
          if (done) break
          for (const line of splitter(value)) {
            const env = readQoderFrame(line)
            if (!env) continue
            if (env.status !== 200) {
              midStreamError = classifyQoderError({ status: env.status, body: env.detail })
              break readLoop
            }
            if (!env.body || env.body === '[DONE]') continue
            // 同闸门期：内层错误只观测（见 openQoderSSE 的说明）
            noteQoderInnerError(env.body, 'stream')
            const cleaned = cleanQoderChunk(env.body)
            if (!cleaned) continue
            validFrames++
            controller.enqueue(encoder.encode(`data: ${cleaned}\n\n`))
          }
        }
      } catch (e) {
        // 上游读到一半断开：正文可能已下发一部分，交给客户端按帧内容判断；
        // 至少不能把「静默断流」伪装成正常收尾。
        if (validFrames === 0) {
          controller.enqueue(encoder.encode(`data: ${QODER_EMPTY_STREAM_FRAME}\n\n`))
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
          return
        }
        midStreamError = classifyQoderError({ status: 0, body: (e as Error).message || 'upstream stream aborted' })
      }

      if (midStreamError) {
        try { await reader.cancel() } catch { /* ignore */ }
        controller.enqueue(encoder.encode(`data: ${qoderOpenAIErrorBody(midStreamError)}\n\n`))
      } else if (validFrames === 0) {
        controller.enqueue(encoder.encode(`data: ${QODER_EMPTY_STREAM_FRAME}\n\n`))
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

  return { ok: true, stream }
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
  /**
   * 会话注入路径的账号域（`opts.session` 时生效，缺省 cn）。
   *
   * 池路径的域来自 `account.realm`，不走这里；这条只服务「测试/工具注入会话」的单次直发，
   * 让调用方能显式指定国际版账号，从而拿到正确的 model_config 元数据。
   */
  realm?: QoderMetaRealm
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
    // 有界首帧闸门：信封错误/空流在此被拦下，池循环得以冷却并轮转下一个账号
    const opened = await openQoderSSE(resp.body, model)
    if (!opened.ok) return { ok: false, classified: opened.classified }
    return {
      ok: true,
      response: new Response(opened.stream, {
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
  const reader = resp.body.pipeThrough(new TextDecoderStream()).getReader()
  const chunks: string[] = []
  const splitter = makeLineSplitter()
  let envelopeErr: QoderClassified | null = null
  /**
   * 内层错误（hub task-34 / v1.2.6）：外层信封 statusCodeValue=200，错误藏在**内层 chunk** 里。
   *
   * 为什么非流式**必须**处理而不能只记日志：流式路径把这个 chunk 原样转发给客户端，客户端
   * 至少能看到 error；而非流式要聚合，`aggregateQoderChunks` 对没有 `choices` 的帧直接
   * `continue` → 内层错误被整帧丢掉 → 网关返回「200 + 空 content + finish_reason: stop」。
   * 客户端看到的是「模型什么都没说」，日志里没有任何痕迹，排障成本极高（hub 原文：
   * 「客户端只看到 200 的空正文，排障成本极高」）。
   */
  let innerErr: QoderClassified | null = null
  readLoop: while (true) {
    const { done, value } = await reader.read()
    if (done) break
    for (const line of splitter(value)) {
      const env = readQoderFrame(line)
      if (!env) continue
      // 信封状态检查同流式路径：HTTP200 里包着 418/5xx 时必须报错，不能聚合出空回复
      if (env.status !== 200) {
        envelopeErr = classifyQoderError({ status: env.status, body: env.detail })
        break readLoop
      }
      if (!env.body || env.body === '[DONE]') continue
      // 只观测（计数 + 按类别首次告警）；是否升级为可见错误由聚合结果决定（见下）
      if (!innerErr) {
        const inner = qoderInnerErrorDetail(env.body)
        if (inner) {
          noteQoderInnerError(env.body, 'nonstream')
          innerErr = qoderInnerErrorClassified(inner.kind, inner.code, inner.message)
        }
      }
      chunks.push(`data: ${env.body}\n\n`)
    }
  }
  if (envelopeErr) {
    try { await reader.cancel() } catch { /* ignore */ }
    // 非流式尚未发出响应体，可以给出真实 HTTP 状态码
    return { ok: false, classified: envelopeErr }
  }
  if (chunks.length === 0) {
    // 零有效帧：不再返回「200 + 空 content + finish_reason: stop」的假成功
    return { ok: false, classified: QODER_EMPTY_STREAM_CLASSIFIED }
  }
  const aggregated = aggregateQoderChunks(chunks.join(''), model)
  // 内层错误 + 聚合不出任何正文 → 上游的失败被 200 信封藏住了，必须如实报错。
  // 只在「正文为空」时升级：若上游先吐了正文再报错，那部分正文是真实产出，照常返回
  // （与流式路径「已下发的内容不撤回」一致，也不改变任何有正文请求的行为）。
  if (innerErr && qoderCompletionIsEmpty(aggregated)) {
    return { ok: false, classified: innerErr }
  }
  return {
    ok: true,
    response: new Response(aggregated, {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders },
    }),
  }
}

/**
 * 聚合结果是否「没有任何正文」：content 为空串、无 reasoning、且没有 tool_calls。
 *
 * 为什么要连 tool_calls 一起看：只有工具调用的回复 content 本来就为空，那是**正常**产出，
 * 不能当成失败（否则会把纯工具调用的非流式请求误报成上游错误）。
 */
function qoderCompletionIsEmpty(aggregated: string): boolean {
  try {
    const obj = JSON.parse(aggregated)
    const msg = obj?.choices?.[0]?.message
    if (!msg || typeof msg !== 'object') return true
    const content = typeof msg.content === 'string' ? msg.content.trim() : ''
    const reasoning = typeof msg.reasoning_content === 'string' ? msg.reasoning_content.trim() : ''
    const hasTools = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0
    return content === '' && reasoning === '' && !hasTools
  } catch {
    return false
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
  const modelKey = opts?.modelKey || fallbackUnknownModel(cpaToUpstreamKey(stripProviderPrefix(model)))
  const messages = Array.isArray(forwardBody.messages) ? (forwardBody.messages as any[]) : []
  // 工具历史结构化直传（hub v1.2.6）：默认 auto —— 仅在确实存在工具历史且 id 齐备时启用，
  // 纯对话请求形态与旧版逐字节一致。`QODER_STRUCTURED_TOOL_HISTORY=off` 可一键回退。
  const structuredTools = useQoderStructuredToolHistory(messages, qoderStructuredToolMode(env))
  /**
   * 请求体渲染按**账号域**取模型元数据（两区同 key 的 display_name/is_vl/is_reasoning/
   * max_input_tokens 确实不同，见 model-meta.ts 文件头）。
   *
   * 为什么渲染必须放进账号循环：域是**账号**属性（`account.realm`），池内可以混区。
   * 在循环外渲染一次只能瞎猜一个域，混区时必然有一半账号拿到另一区的元数据。
   * 代价只有一次 JSON.stringify + 一次 qoderEncode（仅在该账号上重试时才重算）。
   */
  const renderBody = (realm: QoderMetaRealm) =>
    qoderEncode(buildQoderBody(messages, modelKey, undefined, forwardBody.tools, structuredTools, {
      realm,
      // 兼容 max_tokens / max_completion_tokens 两种写法（源 translate_max_completion_tokens 同口径）
      maxTokens: forwardBody.max_tokens ?? forwardBody.max_completion_tokens,
      // 兼容 reasoning_effort / reasoning.effort / thinking.effort / thinking.level（源同款）
      reasoningEffort: pickQoderReasoningEffort(forwardBody),
    }))
  const wantStream = opts?.stream ?? forwardBody.stream === true

  // 会话注入（测试/工具）：单次直发，不经过池。域由调用方显式给出，缺省 cn。
  if (opts?.session) {
    const encodedBody = renderBody(opts?.realm === 'global' ? 'global' : 'cn')
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
        // 账号固定：首轮优先用 X-Qoder-Account 指定的 uid，之后自动挑号轮转。
        // 传 model：模型级冷却的账号在该模型上被跳过，但在其它模型上仍可服务。
        account = await pickQoderAccount(env, provider.id, tried, i === 0 ? opts?.preferUid : undefined, model)
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

      const accountRealm: QoderMetaRealm = account.realm === 'global' ? 'global' : 'cn'
      const encodedBody = renderBody(accountRealm)
      const r = await sendQoderChatOnce(session, encodedBody, modelKey, model, wantStream, account.uid, accountRealm)
      if (r.ok) {
        await noteQoderSuccess(env, provider.id, account.uid)
        // 该账号在该模型上刚成功 → 清掉它的模型级冷却（hub `clear_error(model=)`
        // qoder_proxy.py:2885：成功一次就解除该模型的频控标记，不必等冷却自然到期）。
        // 只在确实有冷却记录时才写 KV（clearQoderModelCooldown 内部判空）。
        try { await clearQoderModelCooldown(env, provider.id, account.uid, model) } catch { /* ignore */ }
        return r.response
      }
      // 内容审核是**请求**属性而非账号属性：换号必然被同样拒绝，继续轮转只会白烧
      // 其他账号的请求配额并推迟错误。立即停止轮转，把 400 交给客户端改输入。
      if (r.classified.kind === 'content_policy') {
        return classifiedErrorResponse(r.classified)
      }
      // 失败：按分类冷却/禁用，然后轮转下一个账号（带 model → 429 只冻该模型）
      await markQoderAccountClassified(env, provider, account.uid, r.classified, model)
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
  const r = await sendQoderChatOnce(data.session, renderBody(data.realm), modelKey, model, wantStream, undefined, data.realm)
  return r.ok ? r.response : classifiedErrorResponse(r.classified)
}

/**
 * 从客户端请求体里取思考档位，兼容四种写法（hub qoder_proxy.py:2389-2395 同款）：
 *   `reasoning_effort` / `reasoning.effort` / `thinking.effort` / `thinking.level`
 *
 * 为什么要兼容：不同客户端（Claude Code / Cline / Roo / 各 SDK）把档位放在不同位置，
 * 只认顶层 `reasoning_effort` 会让其余客户端的档位设置静默失效。
 */
function pickQoderReasoningEffort(forwardBody: Record<string, unknown>): unknown {
  if (forwardBody.reasoning_effort) return forwardBody.reasoning_effort
  const reasoning = forwardBody.reasoning
  if (reasoning && typeof reasoning === 'object') {
    const e = (reasoning as Record<string, unknown>).effort
    if (e) return e
  }
  const thinking = forwardBody.thinking
  if (thinking && typeof thinking === 'object') {
    const t = thinking as Record<string, unknown>
    return t.effort || t.level
  }
  return undefined
}

/**
 * 管理后台「测试」按钮（handleTestModel 的 qoder 分支）。
 *
 * 为什么不能走通用 OpenAI 路径：Qoder 的 authType 是 oauth-device，通用分支会
 * POST `${provider.baseUrl}/chat/completions`（即 gateway.qoder.com.cn/chat/completions），
 * 而该路径根本不是 Qoder 接口——边缘 ALB 直接回自己的 503 HTML 错误页
 * （`<title>503 Service Temporarily Unavailable</title> … alb`），
 * 与账号是否可用无关。真实推理必须走 COSY 签名 +
 * /algo/api/v2/service/pro/sse/agent_chat_generation。
 *
 * 这里复用**真实转发管线**（proxyQoderChatRequest）发一次最小非流式请求：
 * 池挑选/轮转、COSY 签名、信封解析、错误分类全部与线上一致，测出来的结论才可信。
 * 非流式让错误能带真实 HTTP 状态码（流式在首帧闸门后已发头，无法改状态码）。
 */
export async function testQoderModel(
  env: Env,
  provider: Provider,
  modelId: string
): Promise<{ success: boolean; message: string; statusCode?: number }> {
  const model = String(modelId || '').trim()
  if (!model) return { success: false, message: '模型 ID 为空' }

  let resp: Response
  try {
    resp = await proxyQoderChatRequest(
      env,
      provider,
      { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false },
      { stream: false }
    )
  } catch (err) {
    return { success: false, message: `测试异常: ${((err as Error).message || String(err)).substring(0, 200)}` }
  }

  if (resp.ok) {
    return { success: true, message: `连接成功（${model}，COSY 链路）`, statusCode: resp.status }
  }
  const text = await resp.text().catch(() => '')
  let msg = text.substring(0, 300)
  try {
    const j = JSON.parse(text)
    msg = j?.error?.message || j?.message || msg
  } catch { /* 非 JSON：原样回显（如上游 HTML 错误页） */ }
  // 前缀是**部署自证**：管理后台出现「[COSY 链路]」即说明跑的是含本分支的构建。
  // 若仍显示裸的「HTTP 503：<html>…alb…」，说明请求走的是通用 oauth-device 分支
  // （旧构建，或 isQoderFlow 未命中）——两种情况要采取的动作完全不同，不能靠猜。
  return { success: false, message: `[COSY 链路] ${msg || `HTTP ${resp.status}`}`, statusCode: resp.status }
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
  console.log(`[qoder-models] start provider=${provider.id} flowType=${provider.oauth?.flowType}`) // codeql-disable: 纯诊断日志，不含敏感 token
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
  debug.realm = sessionRealm
  debug.modelsUrl = qoderModelsUrl(sessionRealm)

  // GET 请求**不带 body**，故签名必须覆盖空串（qoder2api client.go:85-89 同）。
  // 旧实现签 qoderEncode('{}') 却发空 body → 服务端重算不匹配 →
  // {"code":"101","message":"Signature invalid"}（实测 403）。
  const signedBody = ''
  debug.encodedBodyLen = signedBody.length

  let headers: Record<string, string>
  const modelsUrl = qoderModelsUrl(sessionRealm)
  try {
    // 先单独调用 buildBearer 获取签名中间值用于调试
    const bearerInfo = buildBearer(session, signedBody, modelsUrl)
    debug.bearerDate = bearerInfo.date
    debug.bearerSigLen = bearerInfo.sigInput.length
    debug.cosyKeyLen = session.cosyKey.length

    headers = cosyHeaders(session, signedBody, modelsUrl, 'application/json', false)
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
  // 场景分类读取（bridge.go:195-206 parseQoderModels）。只读 chat 会在某些
  // 区域/账号下拿到空列表或明显偏少的模型；pickQoderModels 按
  // assistant → developer → chat 取第一个非空桶。
  const pick = pickQoderModels(json)
  debug.categoryCounts = pick.counts
  debug.pickedCategory = pick.category
  if (pick.error) {
    return { ok: false, message: pick.error, debug }
  }
  console.log(`[qoder-models] category=${pick.category} enabled=${pick.models.length}`)
  return { ok: true, message: 'success', models: pick.models, debug }
}
