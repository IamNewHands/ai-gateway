/**
 * proxy.ts — TRAE SOLO 上游转发（移植自 traework2api/internal/server/handler.go）。
 *
 * 核心链路（对齐 Go handler.chatCompletions）：
 *   1. 模型映射：auto/空 → 默认 glm-5.2；剥 __suffix；下划线 → 横线归一化。
 *   2. 单请求最多轮转 3 个账号：pool 挑积分最高者 → token 临近过期先 ExchangeToken
 *      刷新 → llm_utils_chat 转发（prepareBody 已强制 stream:true）。
 *   3. 流式：SOLO SSE → OpenAI SSE 转换，流内业务错误（1005/5xx）冷却账号；
 *      非流式：聚合 SOLO SSE 为单条 chat.completion，聚合失败按错误分类冷却并继续轮转。
 *   4. 错误分类（SPEC §4.3）：1005 plan → 12h 冷却；429 → 60s；401 → 禁用；
 *      404 → 60s 短冷却（不累计 errCount）；其余 → 累计错误 3 次冷却 10m。
 */
import type { Env, Provider } from '../types'
import { withSSEKeepAlive } from '../opencode'
import { getPerfSettings } from '../perf'
import { TRAE_DEFAULT_MODEL, TRAE_KEEPALIVE_MS, TRAE_STATIC_MODEL_IDS, TRAE_STREAM_IDLE_TIMEOUT_MS, normalizeTraeModelName } from './constants'
import { chatStream, exchangeToken, needsTraeRefresh, parseAuth } from './upstream'
import { aggregateSoloSse, soloStreamToOpenAIStream } from './sse'
import type { SOLOStreamError } from './types'
import { writeLog } from '../admin'
import {
  cooldownTraeAccount,
  disableTraeAccount,
  getTraeAccounts,
  noteTraeError,
  noteTraeSuccess,
  pickTraeAccount,
  resolveTraeCooldown,
  saveTraeAccount,
} from './pool'
import type { TraeCooldownConfig } from './pool'

export const TRAE_PROVIDER_ID = 'trae'

/** 单请求最多换号次数（Go 默认 3）。 */
const MAX_ROTATE = 3

/** 是否是 TRAE SOLO 提供商（id 固定或用 trae 域）。 */
export function isTraeProvider(provider: Provider): boolean {
  return Boolean(provider.id === TRAE_PROVIDER_ID || (provider.baseUrl && provider.baseUrl.includes('trae')))
}

/**
 * 模型映射（SPEC §4.5）：
 *   "glm-5.2"（config_name）    → 直接转发
 *   "glm-5.2__dev"（内部名）    → 去掉后缀映射回 config_name
 *   "auto" / ""                 → 默认模型
 *   其他未知（归一化后仍不匹配） → 抛错
 */
export function mapTraeModel(model: string, known: ReadonlySet<string>): string {
  const m = (model || '').trim()
  if (m === '' || m === 'auto') return TRAE_DEFAULT_MODEL
  let base = m
  const i = m.indexOf('__')
  if (i >= 0) base = m.substring(0, i)
  if (known.has(base)) return base
  // 宽松匹配：下划线 → 横线，大小写不敏感（deepseek_v4_pro → DeepSeek-V4-Pro）
  const norm = normalizeTraeModelName(base)
  if (known.has(norm)) return norm
  throw new Error(`unknown model ${model}`)
}

/**
 * 管理后台"测试连接"（handleTestModel 的 TRAE 分支）。
 * 不能像普通 OpenAI 提供商那样 POST baseUrl/chat/completions——TRAE 上游是 SOLO 私有协议，
 * 且账号凭证存于 provider.apiKeys（每个 key 是一个账号 JSON），Bearer 直发必然失败。
 * 这里走真实账号池发最小请求验证：挑健康账号 → llm_utils_chat → 读到首个字节即视为连接成功。
 */
export async function testTraeModel(
  env: Env,
  provider: Provider,
  modelId: string
): Promise<{ success: boolean; message: string; statusCode?: number }> {
  const known = new Set<string>()
  for (const m of provider.models || []) known.add(m.id)
  for (const id of TRAE_STATIC_MODEL_IDS) known.add(id)
  let configName: string
  try {
    configName = mapTraeModel(modelId, known)
  } catch {
    return { success: false, message: `未知模型 ${modelId}` }
  }
  const accounts = getTraeAccounts(provider)
  if (accounts.length === 0) {
    return { success: false, message: '未配置 TRAE 账号，请先「登录账号」后再测试' }
  }
  const account = await pickTraeAccount(env, provider.id, accounts, new Set(), provider.preferTraeUid)
  if (!account) {
    return { success: false, message: '没有可用账号（全部冷却/禁用），请刷新状态或签到解冻' }
  }
  try {
    const resp = await chatStream(account, {
      model: configName,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
      stream: true,
    })
    if (!resp.body) return { success: false, message: '上游返回空响应体' }
    // 首字节非空只代表"握手通了"，不代表模型可用：SOLO 流内 error（1005 plan 不足
    // / 4008 配额耗尽等）也是非空字节，若只读首字节会误判为"连接成功"。
    // 这里解析首块：命中 `event: error` 则如实报失败并带真实错误码。
    const reader = resp.body.getReader()
    const { value } = await reader.read()
    await reader.cancel().catch(() => {})
    if (!value || value.length === 0) {
      return { success: false, message: '上游无输出（可能被限流或 plan 权益不足）' }
    }
    const firstText = new TextDecoder().decode(value)
    const errHit = /event:\s*error\s*\r?\ndata:\s*([^\n]*)/i.exec(firstText)
    if (errHit) {
      return {
        success: false,
        statusCode: resp.status,
        message: `连接成功但模型不可用（上游 error）: ${(errHit[1] || '无详情').trim()}`,
      }
    }
    return { success: true, message: '连接成功', statusCode: resp.status }
  } catch (e) {
    const err = e as Error & { kind?: string; status?: number }
    return {
      success: false,
      message: `连接失败: ${(err.message || '未知错误').substring(0, 200)}`,
      statusCode: err.status,
    }
  }
}

/**
 * 管理后台"测试账号凭证"（handleTestKey 的 TRAE 分支）。
 * 针对单个粘贴进去的账号 JSON 做连通性验证：parseAuth 解析 → 用该账号发最小
 * llm_utils_chat 请求 → 读到首字节即成功。不触碰账号池，避免测试副作用冷却真实账号。
 */
export async function testTraeCredential(
  jsonText: string
): Promise<{ success: boolean; message: string; statusCode?: number }> {
  let account
  try {
    account = parseAuth(jsonText)
  } catch (e) {
    return { success: false, message: `凭证解析失败: ${(e as Error).message || '未知错误'}` }
  }
  try {
    const resp = await chatStream(account, {
      model: TRAE_DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
      stream: true,
    })
    if (!resp.body) return { success: false, message: '上游返回空响应体' }
    // 同上：只读首字节会漏掉流内 error，这边也校验首块 error 事件
    const reader = resp.body.getReader()
    const { value } = await reader.read()
    await reader.cancel().catch(() => {})
    if (!value || value.length === 0) {
      return { success: false, message: '上游无输出（可能被限流或 plan 权益不足）' }
    }
    const firstText = new TextDecoder().decode(value)
    const errHit = /event:\s*error\s*\r?\ndata:\s*([^\n]*)/i.exec(firstText)
    if (errHit) {
      return {
        success: false,
        statusCode: resp.status,
        message: `连接成功但模型不可用（上游 error）: ${(errHit[1] || '无详情').trim()}`,
      }
    }
    return { success: true, message: '连接成功', statusCode: resp.status }
  } catch (e) {
    const err = e as Error & { kind?: string; status?: number }
    return {
      success: false,
      message: `连接失败: ${(err.message || '未知错误').substring(0, 200)}`,
      statusCode: err.status,
    }
  }
}

/** OpenAI 兼容错误响应。 */
function openaiError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({
    error: { message, type: 'api_error', code },
  }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

/** HTTP 错误分类 → 冷却状态机（Go chatCompletions status >= 400 分支）。 */
async function applyChatError(env: Env, providerId: string, uid: string, kind: string, cd: TraeCooldownConfig): Promise<void> {
  switch (kind) {
    case 'plan_limit':
      await cooldownTraeAccount(env, providerId, uid, cd.planMs, 'plan 权益不足')
      break
    case 'soft_rate':
      await cooldownTraeAccount(env, providerId, uid, cd.softMs, '429 rate limit')
      break
    case 'session_dead':
      await disableTraeAccount(env, providerId, uid, 'session dead')
      break
    case 'not_found':
      // 404 短冷却不累计 errCount（防雪崩）
      await cooldownTraeAccount(env, providerId, uid, cd.softMs, 'upstream 404')
      break
    case 'transport':
      // 网络/连接中断（建连超时、客户端掐断等）与账号健康无关：
      // 不冷却、不累计 errCount，避免一次网络抖动把整个账号池刷成 no_healthy_account。
      break
    default:
      await noteTraeError(env, providerId, uid, cd.errThreshold, cd.errMs)
  }
}

/** 流内业务错误 → 冷却状态机（Go handleStreamError：1005 plan → 长冷却；其余累计错误）。 */
async function applyStreamError(env: Env, providerId: string, uid: string, se: SOLOStreamError, cd: TraeCooldownConfig): Promise<void> {
  if (se.code === 1005) {
    await cooldownTraeAccount(env, providerId, uid, cd.planMs, 'plan 权益不足')
  } else {
    await noteTraeError(env, providerId, uid, cd.errThreshold, cd.errMs)
  }
}

/**
 * TRAE 对话转发入口（在 src/proxy.ts 分发中调用）。
 * 返回 OpenAI 兼容 Response（流式 SSE / 非流式 JSON / 错误 JSON）。
 */
export async function proxyTraeChatRequest(
  env: Env,
  provider: Provider,
  body: Record<string, unknown>
): Promise<Response> {
  const stream = body['stream'] === true
  const model = String(body['model'] || '')

  // 已知模型表 = 提供商已配置模型 ∪ 静态 SOLO 模型表
  const known = new Set<string>()
  for (const m of provider.models || []) known.add(m.id)
  for (const id of TRAE_STATIC_MODEL_IDS) known.add(id)

  let configName: string
  try {
    configName = mapTraeModel(model, known)
  } catch (e) {
    return openaiError(400, 'invalid_request', (e as Error).message)
  }
  body['model'] = configName // setModelInBody：替换为 config_name

  const accounts = getTraeAccounts(provider)
  const cd = resolveTraeCooldown(provider)
  const tried = new Set<string>()
  let lastErr: Error | null = null

  for (let i = 0; i < MAX_ROTATE; i++) {
    const account = await pickTraeAccount(env, provider.id, accounts, tried, provider.preferTraeUid)
    if (!account) break
    tried.add(account.uid)

    // token 临近过期 → 先 ExchangeToken 刷新（持锁换新并落盘；失败按错误分类冷却换号）
    try {
      if (needsTraeRefresh(account)) {
        const res = await exchangeToken(account)
        account.accessToken = res.accessToken
        account.refreshToken = res.refreshToken
        account.expiresAt = res.expiresAt
        await saveTraeAccount(env, provider.id, account).catch(() => {})
      }
    } catch (e) {
      lastErr = e as Error
      const kind = (e as any).kind
      if (kind === 'session_dead') {
        await disableTraeAccount(env, provider.id, account.uid, 'refresh session dead')
      } else {
        await cooldownTraeAccount(env, provider.id, account.uid, cd.errMs, 'refresh: ' + ((e as Error).message || '').substring(0, 120))
      }
      continue
    }

    let resp: Response
    try {
      resp = await chatStream(account, body)
    } catch (e) {
      lastErr = e as Error
      await applyChatError(env, provider.id, account.uid, (e as any).kind || 'client', cd)
      continue
    }

    if (stream) {
      await noteTraeSuccess(env, provider.id, account.uid)
      if (!resp.body) {
        return openaiError(502, 'upstream_empty', 'upstream returned empty body')
      }
      // 流内业务错误（1005 plan/5xx 等）→ 冷却账号，错误信息注入 SSE
      // 记录最后一次 solo 错误，结束日志带上真实错误码（否则日志只见 end=complete，真因被掩盖）
      let lastSoloErr: SOLOStreamError | null = null
      const onErr = (se: SOLOStreamError) => { lastSoloErr = se; void applyStreamError(env, provider.id, account.uid, se, cd) }
      // 包 SSE 心跳 + idle 兜底：思考模型静默期客户端会因无事件 idle 超时判定流结束
      //（实测 ~15-20s 自动截断），`: keep-alive\n\n` 注释行重置客户端计时器；上游
      // 超过 idle 超时完全无数据则主动结束流防挂起。
      // 心跳/idle 阈值与 workbuddy 等 OAuth/通用路径一致，读「性能设置」（KV 可编辑，
      // src/perf.ts），未自定义时回退 TRAE 内置常量（8s 心跳 / 180s idle）。
      const perf = await getPerfSettings(env)
      const keepAliveMs = perf.keepAliveMs > 0 ? perf.keepAliveMs : TRAE_KEEPALIVE_MS
      const idleTimeoutMs = perf.idleTimeoutMs || TRAE_STREAM_IDLE_TIMEOUT_MS
      const startedAt = Date.now()
      const sseBody = withSSEKeepAlive(
        soloStreamToOpenAIStream(resp.body, configName, onErr),
        keepAliveMs,
        idleTimeoutMs,
        (reason) => {
          // 流结束态诊断：区分 上游自然读完(complete) / 空闲超时(idle) / 客户端断开(cancel) / 读体异常(error)。
          // 用于排查"回答中途停住"——若 9 分多钟那次的结束态是 cancel，说明是客户端掐断；
          // idle 说明上游长时间无数据被 idle 兜底；complete 则是上游正常收尾。
          const secs = Math.round((Date.now() - startedAt) / 1000)
          const errInfo = lastSoloErr ? ` errCode=${lastSoloErr.code} errMsg=${lastSoloErr.msg}` : ''
          const msg = `[trae-stream] provider=${provider.id} uid=${account.uid} model=${configName} end=${reason} duration=${secs}s${errInfo}`
          console.log(msg)
          writeLog(env, 'info', msg).catch(() => { /* 日志失败不影响流 */ })
        }
      )
      return new Response(sseBody, {
        status: resp.status,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Accel-Buffering': 'no',
          Connection: 'keep-alive',
        },
      })
    }

    // 非流式：聚合 SOLO SSE 为单条 chat.completion
    const text = await resp.text().catch(() => '')
    const agg = aggregateSoloSse(text)
    if (agg.err) {
      lastErr = new Error(`solo stream error code=${agg.err.code} msg=${agg.err.msg}`)
      await applyStreamError(env, provider.id, account.uid, agg.err, cd)
      continue
    }
    await noteTraeSuccess(env, provider.id, account.uid)
    const out = agg.resp!
    out['model'] = configName
    return new Response(JSON.stringify(out), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
  }

  const msg = 'all accounts unavailable (cooling/disabled)' + (lastErr ? ': ' + lastErr.message : '')
  return openaiError(503, 'no_healthy_account', msg)
}
