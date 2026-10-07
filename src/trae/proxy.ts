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
import { TRAE_DEFAULT_MODEL, TRAE_KEEPALIVE_MS, TRAE_RAW_MAX_HISTORY_CHARS, TRAE_RAW_MAX_MESSAGES, TRAE_RAW_MAX_TOOL_SCHEMA_CHARS, TRAE_STATIC_MODEL_IDS, TRAE_STREAM_IDLE_TIMEOUT_MS, TRAE_WORK_CONSTANTS, isWorkModel, normalizeTraeModelName } from './constants'
import { chatStream, chatWorkStream, exchangeToken, extractLastUserPrompt, isTraeRequestSideError, needsTraeRefresh, parseAuth, probeTraeCredits, type TraeConnectTiming } from './upstream'
import { isRemoteOnlyModel, type HistoryBudget } from './payload'
import { aggregateSoloSse, aggregateWorkSse, soloStreamToOpenAIStream, workStreamToOpenAIStream } from './sse'
import type { SOLOStreamError } from './types'
import { writeLog } from '../admin'
import {
  acquireTraeSession,
  cooldownTraeAccount,
  cooldownTraeWorkAccount,
  disableTraeAccount,
  getTraeAccounts,
  noteTraeError,
  noteTraeSuccess,
  noteTraeWorkError,
  noteTraeWorkSuccess,
  pickTraeAccount,
  pickTraeWorkAccount,
  releaseTraeSession,
  resolveTraeCooldown,
  saveTraeAccount,
  setTraeCredits,
  setTraeWorkCredits,
} from './pool'
import type { TraeCooldownConfig } from './pool'

export const TRAE_PROVIDER_ID = 'trae'

/** 单请求最多换号次数（Go 默认 3）。 */
const MAX_ROTATE = 3

/**
 * transport（建连超时/被掐断）连续撞满几次即停止换号。
 *
 * 依据：transport 与账号健康无关（`applyChatError` 对它刻意不罚号），**换号没有信息增益**——
 * 第 2 次仍是同一个「网关↔上游建连」问题，只是再白耗一个 `TRAE_CHAT_CONNECT_TIMEOUT_MS`(30s)。
 * 实测 2026-09-27：连撞两个账号 62s ≈ 2×30s，而 520ms 后重试即成功（池子本来是健康的）。
 *
 * 保留 2 次而非 1 次：单次失败可能只是瞬时抖动，换一个账号再试一次仍有信息量（能区分
 * 「抖动」与「链路持续不可达」）；第 2 次仍失败即可定性为后者，继续轮转纯属浪费。
 */
const MAX_TRANSPORT_ATTEMPTS = 2

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
  if (m.toLowerCase() === 'work') return TRAE_WORK_CONSTANTS.DefaultWorkModel
  let base = m
  const i = m.indexOf('__')
  if (i >= 0) base = m.substring(0, i)
  if (known.has(base)) return base
  if (isWorkModel(base)) return base
  // 宽松匹配：下划线 → 横线，大小写不敏感（deepseek_v4_pro → DeepSeek-V4-Pro）
  const norm = normalizeTraeModelName(base)
  if (known.has(norm)) return norm
  if (isWorkModel(norm)) return norm
  throw new Error(`unknown model ${model}`)
}

/**
 * 管理后台"测试连接"（handleTestModel 的 TRAE 分支）。
 * 不能像普通 OpenAI 提供商那样 POST baseUrl/chat/completions——TRAE 上游是 SOLO 私有协议，
 * 且账号凭证存于 provider.apiKeys（每个 key 是一个账号 JSON），Bearer 直发必然失败。
 * 这里走真实账号池发最小请求验证：挑健康账号 → llm_utils_chat / Work 通道 → 读到首个字节即视为连接成功。
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

  // Work 专有通道模型测试
  if (isWorkModel(configName)) {
    const workAccount = await pickTraeWorkAccount(env, provider.id, accounts, new Set(), provider.preferTraeUid)
    if (!workAccount) {
      return { success: false, message: '没有可用 Work 账号（全部冷却/禁用）' }
    }
    try {
      const resp = await chatWorkStream(workAccount, configName, 'hi')
      if (!resp.body) return { success: false, message: '上游 Work 返回空响应体' }
      const reader = resp.body.getReader()
      const { value } = await reader.read()
      await reader.cancel().catch(() => {})
      if (!value || value.length === 0) {
        return { success: false, message: '上游 Work 无输出' }
      }
      return { success: true, message: 'Work 连接成功', statusCode: resp.status }
    } catch (e) {
      const err = e as Error & { kind?: string; status?: number }
      return {
        success: false,
        message: `Work 连接失败: ${(err.message || '未知错误').substring(0, 200)}`,
        statusCode: err.status,
      }
    }
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

/**
 * 请求侧参数错的 OpenAI 兼容 4xx 终态。
 *
 * 与 openaiError 分开的理由有两条，都不能省：
 *  1. `type` 必须是 invalid_request_error —— 客户端据此区分「我发的 body 有问题」与
 *     「网关/上游故障」，前者重试无用；
 *  2. 状态码必须原样回 4xx —— 不能退化成 503「账号池无可用账号」。把请求侧问题伪装成
 *     账号问题正是本层要修的误导（用户看到 503 会去查账号池，而账号池是健康的）。
 *
 * 上游原文截断 + 剥离控制字符后透传（对齐本仓脱敏口径；错误原因要可诊断）。
 */
function traeClientParamsError(detail: string, httpStatus = 400): Response {
  const status = httpStatus >= 400 && httpStatus < 500 ? httpStatus : 400
  const text = String(detail || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().substring(0, 300)
  return new Response(JSON.stringify({
    error: {
      message: '请求参数被上游拒绝（同一 body 换任何账号都会撞同一校验，已停止轮转）'
        + (text ? '：' + text : ''),
      type: 'invalid_request_error',
      code: 'client_params',
    },
  }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

/**
 * 连接层失败（网关↔TRAE 上游）落 KV 日志。
 *
 * 2026-10-07 定责（DSH 会话 `session-5890068d`）：这类 503 原先**一条日志都不落**，
 * 面板「系统日志」完全看不到，只能靠翻 DSH 会话记录反推「每次 62s ≈ 2×30s 建连超时」。
 * 与 cline 的 `[cline-attempt]` 同一纪律：定性字段必须落 KV，否则线上排查只能靠猜。
 *
 * 固定字段：`connect=<ms>`（连接阶段实际耗时）、`timeout=<true|false>`（是否被网关
 * 自己的 30s 定时器掐断）。据此可判：30s 常量是否在误杀「其实 31-60s 才出响应头」
 * 的合法请求（对照成功路径 `[trae-stream] ... connect=` 的分布），还是上游确实整段不通。
 */
function logTraeTransport(env: Env, msg: string): Promise<void> {
  console.log(msg) // codeql-disable: 纯诊断日志，不含密钥/敏感 token
  // 有意 await（与 cline `[cline-attempt]` 同口径）：响应返回时日志已落盘，
  // 避免 isolate 收尾时丢掉这条唯一的定性线索。失败路径本来就是 30s 级，KV 往返可忽略。
  return writeLog(env, 'warn', msg).catch(() => { /* 日志失败不影响响应 */ })
}

/**
 * HTTP 错误分类 → 冷却状态机（Go chatCompletions status >= 400 分支）。 */
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
    case 'client_params':
      // 请求侧参数错（4027 invalid_parameter_error 等）：**不罚号**。
      // 同一 body 换任何账号都会撞同一个参数校验，罚号只会把健康的池刷成不可用
      // （这正是「界面全绿却报无可用账号」的成因之一）。终态出口由调用方负责。
      break
    default:
      await noteTraeError(env, providerId, uid, cd.errThreshold, cd.errMs)
  }
}

/**
 * 流内业务错误 → 冷却状态机（Go handleStreamError：1005 plan → 长冷却；其余累计错误）。
 *
 * @returns true = 请求侧错误：**不罚号**，调用方须走 4xx 终态且不轮转。
 */
async function applyStreamError(env: Env, providerId: string, uid: string, se: SOLOStreamError, cd: TraeCooldownConfig): Promise<boolean> {
  if (isTraeRequestSideError(se.code, se.msg)) return true
  if (se.code === 1005) {
    await cooldownTraeAccount(env, providerId, uid, cd.planMs, 'plan 权益不足')
  } else {
    await noteTraeError(env, providerId, uid, cd.errThreshold, cd.errMs)
  }
  return false
}

/**
 * 使用账号池多账号动态轮转调度执行 Work 通道请求（消费 work_credits）。
 * 调度与容灾策略（对齐 trae2api executeWorkRequest）：
 * 1. 优先按可用 workCredits 降序选取健康账号；
 * 2. 检查并按需预刷新 token；
 * 3. 发起 chatWorkStream 调用（原生 HTTP/2 直连）；
 * 4. 故障时（429 限流/401 会话失效/400 额度不足）进入 Work 专属冷却并自动轮转下一账号；
 * 5. 成功后触发异步探针更新账号真实 workCredits 与 ideCredits 余额；
 * 6. 返回流式或非流式 OpenAI 兼容 Response。
 */
export async function executeWorkRequest(
  env: Env,
  provider: Provider,
  body: Record<string, unknown>,
  configName: string,
  prompt: string,
  stream: boolean
): Promise<Response | null> {
  const accounts = getTraeAccounts(provider)
  if (accounts.length === 0) return null

  const cd = resolveTraeCooldown(provider)
  const tried = new Set<string>()
  let lastErr: Error | null = null
  // transport 计数：与账号无关的链路故障，换号无信息增益（见 MAX_TRANSPORT_ATTEMPTS）。
  let transportAttempts = 0
  // 非流式聚合见过「上游没发 done」：Work 是最后一层兜底，此时不能回半句话，
  // 也不能用 no_healthy_account 把网络截断说成账号池不可用（曾把排查引到账号上）。
  let truncationSeen = false

  // 默认使用请求模型；若非 Work 模型则回退 DefaultWorkModel
  let workModel = configName
  if (!isWorkModel(workModel)) {
    workModel = TRAE_WORK_CONSTANTS.DefaultWorkModel
  }

  for (let i = 0; i < MAX_ROTATE; i++) {
    const account = await pickTraeWorkAccount(env, provider.id, accounts, tried, provider.preferTraeUid)
    if (!account) break
    tried.add(account.uid)

    // Token 预刷新
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
      if (kind === 'transport') {
        // 刷新阶段的连接层失败同样与账号无关（upstream.doJson 已打 transport 标记）：
        // 不冷却、不累计 workErrCount，只计数——撞满即跳出，避免把健康账号逐个刷进冷却。
        transportAttempts++
        if (transportAttempts >= MAX_TRANSPORT_ATTEMPTS) break
      } else if (kind === 'session_dead') {
        await disableTraeAccount(env, provider.id, account.uid, 'refresh session dead')
      } else {
        await cooldownTraeWorkAccount(env, provider.id, account.uid, cd.errMs, 'refresh: ' + ((e as Error).message || '').substring(0, 120))
      }
      continue
    }

    let resp: Response
    const timing: TraeConnectTiming = {}
    const attemptStartedAt = Date.now()
    try {
      resp = await chatWorkStream(account, workModel, prompt, timing)
    } catch (e) {
      lastErr = e as Error
      const status = (e as any).status || 0
      const kind = (e as any).kind || ''
      const msg = (e as any).msg || (e as Error).message || ''
      if (kind === 'transport') {
        // 连接层失败（建连超时/被掐断）与账号健康无关：**不冷却、不累计 workErrCount**
        //（与 SOLO 侧 `applyChatError` 的 transport 分支同纪律，见 CODING_NOTES
        //「连接层/收尾层失败不是账号故障，禁止罚号」）。换号也没有信息增益——第 2 次
        // 撞的是同一条「网关↔上游建连」，故撞满 MAX_TRANSPORT_ATTEMPTS 即跳出。
        transportAttempts++
        // Work 侧同口径落 KV：尾部的 503 文案可能带的是 Work 的错误消息，
        // 少了这条就分不清「SOLO 撞满」还是「Work 也撞了」。
        await logTraeTransport(env, `[trae-transport] provider=${provider.id} uid=${account.uid} model=${workModel}`
          + ` phase=work attempt=${transportAttempts}/${MAX_TRANSPORT_ATTEMPTS}`
          + ` connect=${timing.connectMs ?? -1}ms timeout=${timing.connectTimeout === true}`
          + ` elapsed=${Date.now() - attemptStartedAt}ms err=${msg.slice(0, 160)}`)
        if (transportAttempts >= MAX_TRANSPORT_ATTEMPTS) break
      } else if (status === 429) {
        await cooldownTraeWorkAccount(env, provider.id, account.uid, cd.softMs, 'work 429 rate limit')
      } else if (status === 401 || status === 403) {
        await disableTraeAccount(env, provider.id, account.uid, 'work session dead')
      } else if (status === 400 && (msg.includes('credit') || msg.includes('1005') || msg.includes('4008'))) {
        await cooldownTraeWorkAccount(env, provider.id, account.uid, cd.planMs, 'work_credits 余额不足')
      } else {
        await noteTraeWorkError(env, provider.id, account.uid, cd.errThreshold, cd.errMs)
      }
      continue
    }

    await noteTraeWorkSuccess(env, provider.id, account.uid)

    // 异步探测更新该账号的真实双通道余额
    void (async () => {
      try {
        const snap = await probeTraeCredits(account)
        if (snap) {
          await setTraeWorkCredits(env, provider.id, account.uid, snap.workCredits)
          await setTraeCredits(env, provider.id, account.uid, snap.ideCredits)
          if (snap.workCredits <= 0) {
            await cooldownTraeWorkAccount(env, provider.id, account.uid, cd.planMs, 'work_credits 余额不足')
          }
        }
      } catch { /* ignore */ }
    })()

    if (stream) {
      if (!resp.body) {
        return openaiError(502, 'upstream_empty', 'upstream work returned empty body')
      }
      const perf = await getPerfSettings(env)
      const keepAliveMs = perf.keepAliveMs > 0 ? perf.keepAliveMs : TRAE_KEEPALIVE_MS
      const idleTimeoutMs = perf.idleTimeoutMs || TRAE_STREAM_IDLE_TIMEOUT_MS
      const startedAt = Date.now()
      let lastWorkErr: SOLOStreamError | null = null
      const onErr = (se: SOLOStreamError) => {
        lastWorkErr = se
        if (se.code === 1005 || se.code === 4008) {
          void cooldownTraeWorkAccount(env, provider.id, account.uid, cd.planMs, 'work_credits 余额不足')
        } else {
          void noteTraeWorkError(env, provider.id, account.uid, cd.errThreshold, cd.errMs)
        }
      }
      const sseBody = withSSEKeepAlive(
        workStreamToOpenAIStream(resp.body, workModel, onErr, (info) => {
          // 推理退化（plan_item 思考文本重复）熔断：同样不冷却账号（模型行为非账号故障）
          const msg = `[trae-work-stream] provider=${provider.id} uid=${account.uid} model=${workModel}`
            + ` end=runaway kind=${info.kind} reasoning=${info.reasoningChars} content=${info.contentChars}`
          console.log(msg) // codeql-disable: 纯诊断日志，不含密钥/敏感 token
          writeLog(env, 'warn', msg).catch(() => { /* 日志失败不影响流 */ })
        }),
        keepAliveMs,
        idleTimeoutMs,
        (reason) => {
          const secs = Math.round((Date.now() - startedAt) / 1000)
          const errInfo = lastWorkErr ? ` errCode=${lastWorkErr.code} errMsg=${lastWorkErr.msg}` : ''
          const msg = `[trae-work-stream] provider=${provider.id} uid=${account.uid} model=${workModel} end=${reason} duration=${secs}s${errInfo}`
          console.log(msg) // codeql-disable: 纯诊断日志，不含密钥/敏感 token
          writeLog(env, 'info', msg).catch(() => {})
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

    // 非流式
    let workReadError = false
    const text = await resp.text().catch(() => { workReadError = true; return '' })
    const agg = aggregateWorkSse(text, workModel, { readError: workReadError })
    if (agg.err) {
      lastErr = new Error(`work stream error code=${agg.err.code} msg=${agg.err.msg}`)
      if (agg.err.code === 1005 || agg.err.code === 4008) {
        await cooldownTraeWorkAccount(env, provider.id, account.uid, cd.planMs, 'work_credits 余额不足')
      } else {
        await noteTraeWorkError(env, provider.id, account.uid, cd.errThreshold, cd.errMs)
      }
      continue
    }

    // 上游没发 done 就断：不罚号（noteTraeWorkError 会把一次上游截断累计成 Work 通道冷却，
    // 账号本身没问题），换号重试；全部撞完由下方统一报 503 upstream_unreachable。
    if (agg.truncated) {
      const info = agg.truncated
      truncationSeen = true
      const msg = `[trae-work-agg] provider=${provider.id} uid=${account.uid} model=${workModel}`
        + ` end=truncated kind=${info.kind} content=${info.contentChars} reasoning=${info.reasoningChars}`
        + ` usage=${info.sawUsage}`
      console.log(msg) // codeql-disable: 纯诊断日志，不含密钥/敏感 token
      writeLog(env, 'warn', msg).catch(() => { /* 日志失败不影响响应 */ })
      continue
    }

    const out = agg.resp!
    out['model'] = workModel
    return new Response(JSON.stringify(out), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
  }

  // Work 通道是最后一层兜底：上游没发 done 时既不能回半句话（旧行为：聚合出的
  // finish_reason='stop' + 200），也不能报 no_healthy_account 把网络截断说成账号问题。
  if (truncationSeen) {
    return openaiError(
      503,
      'upstream_unreachable',
      'TRAE Work 通道上游未发送 done/收尾事件（账号未被惩罚，非账号池问题）'
    )
  }

  return null
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

  const prompt = extractLastUserPrompt(body['messages'] as any[])
  const hasTools = Array.isArray(body['tools']) && (body['tools'] as unknown[]).length > 0

  // 1. 若显式请求 Work 专属通道模型（且未携带外部自定义 tools），直接走 Work 通道
  if (isWorkModel(model) && !hasTools) {
    const workResp = await executeWorkRequest(env, provider, body, configName, prompt, stream)
    if (workResp) return workResp
  }

  // 特性C：模型级 remote 路由（省输入积分预算改写路径）。
  // 受 traeEnableRemoteBudget 开关控制（界面「省钱预算」开关）：开启且下方勾选了
  // 「命中省钱预算」的模型（traeRemoteOnlyModels 非空）才走历史裁剪 + 工具 schema 压缩；
  // 未勾选任何模型 = 不触发。关闭（默认）= 现有 SOLO 路径完全不变。
  const remoteEnabled = provider.traeEnableRemoteBudget === true
  const remoteCfg = (provider.traeRemoteOnlyModels || '').trim()
  if (remoteEnabled && remoteCfg !== '' && isRemoteOnlyModel(configName, remoteCfg)) {
    const budget: HistoryBudget = {
      maxMessages: typeof provider.traeMaxMessages === 'number' ? provider.traeMaxMessages : TRAE_RAW_MAX_MESSAGES,
      maxHistoryChars: typeof provider.traeMaxHistoryChars === 'number' ? provider.traeMaxHistoryChars : TRAE_RAW_MAX_HISTORY_CHARS,
      maxToolSchemaChars: typeof provider.traeMaxToolSchemaChars === 'number' ? provider.traeMaxToolSchemaChars : TRAE_RAW_MAX_TOOL_SCHEMA_CHARS,
    }
    body['__budget'] = budget
  }

  const accounts = getTraeAccounts(provider)
  const cd = resolveTraeCooldown(provider)
  const tried = new Set<string>()
  let lastErr: Error | null = null
  // transport 计数：与账号无关的链路故障，换号无信息增益（见 MAX_TRANSPORT_ATTEMPTS）。
  let transportAttempts = 0
  // Work 兜底是否已在本循环内尝试过：跳出后函数末尾还会再兜底一次，每次兜底都是
  // 2×30s 的建连等待。已在循环内试过就不再重复（同一 body、同一时刻、同一条链路）。
  let workFallbackTried = false
  // 特性A：账号级并发上限与空闲回收阈值（未配置则维持原独占挑选语义）
  const concurrency = typeof provider.traeConcurrency === 'number' ? provider.traeConcurrency : 0
  const idleMs = typeof provider.traeSessionIdleMs === 'number' ? provider.traeSessionIdleMs : 0

  for (let i = 0; i < MAX_ROTATE; i++) {
    const account = await pickTraeAccount(env, provider.id, accounts, tried, provider.preferTraeUid, concurrency, idleMs)
    if (!account) break
    tried.add(account.uid)
    // 占用会话：并发控制开启时 +1 计数；否则仅刷新活跃时刻（始终便于空闲感知）
    await acquireTraeSession(env, provider.id, account.uid, concurrency > 0).catch(() => {})

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
      if (kind === 'transport') {
        // 刷新阶段的连接层失败与账号无关（upstream.doJson 已打 transport 标记）：不冷却。
        // 与转发阶段同一纪律——换号也没有信息增益，撞满即跳出（跳出后由函数末尾按 transport
        // 定责报 503 upstream_unreachable）。
        transportAttempts++
        if (transportAttempts >= MAX_TRANSPORT_ATTEMPTS) break
      } else if (kind === 'session_dead') {
        await disableTraeAccount(env, provider.id, account.uid, 'refresh session dead')
      } else {
        await cooldownTraeAccount(env, provider.id, account.uid, cd.errMs, 'refresh: ' + ((e as Error).message || '').substring(0, 120))
      }
      await releaseTraeSession(env, provider.id, account.uid).catch(() => {})
      continue
    }

    let resp: Response
    // 本次尝试的连接阶段采样：成功路径进 [trae-stream] end= 日志，失败路径进 [trae-transport]。
    const timing: TraeConnectTiming = {}
    const attemptStartedAt = Date.now()
    try {
      resp = await chatStream(account, body, timing)
    } catch (e) {
      lastErr = e as Error
      const kind = (e as any).kind || 'client'
      await applyChatError(env, provider.id, account.uid, kind, cd)
      await releaseTraeSession(env, provider.id, account.uid).catch(() => {})

      // 请求侧参数错是**本请求的终态**：同一 body 换任何账号都会撞同一校验，继续轮转
      // 只会白扔健康号配额，且最终被误报成 503「账号池无可用账号」（账号其实是好的）。
      if (kind === 'client_params') {
        return traeClientParamsError((e as any).msg || (e as Error).message || '', (e as any).status || 400)
      }

      // 核心容灾降级：若 SOLO 通道因额度耗尽（4008/1005 plan_limit）、限流（429 soft_rate）
      // 或连接层故障（transport：建连超时/被掐断）失败，且无自定义 tools，自动切换到 Work 通道！
      // transport 也纳入的理由：它不罚号、也不证明账号坏（见 applyChatError），继续轮流撞
      // 同一个建连超时只会把 30s×N 白耗完再回 503（实测 2026-09-27 连撞两个账号 62s）。
      // Work 走的是另一条 host/协议（chatWorkStream），是同因不同路的真兜底。
      if (kind === 'transport') {
        // 换号没有信息增益：transport 与账号无关（applyChatError 对它刻意不罚号），第 2 次撞的
        // 还是同一条「网关↔上游建连」。撞满 MAX_TRANSPORT_ATTEMPTS 即跳出，不再用健康账号白耗 30s。
        transportAttempts++
        // 每次连接层失败都落 KV：`connect` 与实际耗时对比 `timeout` 标记，即可区分
        // 「我们掐的 30s 建连超时」与「上游/网络自己断的」；改超时常量前先看这条日志。
        await logTraeTransport(env, `[trae-transport] provider=${provider.id} uid=${account.uid} model=${configName}`
          + ` phase=solo attempt=${transportAttempts}/${MAX_TRANSPORT_ATTEMPTS}`
          + ` connect=${timing.connectMs ?? -1}ms timeout=${timing.connectTimeout === true}`
          + ` elapsed=${Date.now() - attemptStartedAt}ms`
          + ` err=${((e as Error).message || String(e)).slice(0, 160)}`)
        // Work 兜底只试一次：Work 侧同样撞「网关↔上游建连」，试过就不再重复（跳出后函数末尾
        // 也会按 workFallbackTried 跳过），否则同一条链路会被撞两轮、等待被放大成 2×。
        if (!hasTools && !workFallbackTried) {
          workFallbackTried = true
          const fallbackResp = await executeWorkRequest(env, provider, body, configName, prompt, stream)
          if (fallbackResp) return fallbackResp
        }
        if (transportAttempts >= MAX_TRANSPORT_ATTEMPTS) break
        continue
      }
      if ((kind === 'plan_limit' || kind === 'soft_rate') && !hasTools) {
        const fallbackResp = await executeWorkRequest(env, provider, body, configName, prompt, stream)
        if (fallbackResp) return fallbackResp
      }
      continue
    }

    if (stream) {
      await noteTraeSuccess(env, provider.id, account.uid)
      if (!resp.body) {
        await releaseTraeSession(env, provider.id, account.uid).catch(() => {})
        return openaiError(502, 'upstream_empty', 'upstream returned empty body')
      }
      // 流内业务错误（1005 plan/5xx 等）→ 冷却账号，错误信息注入 SSE
      // 记录最后一次 solo 错误，结束日志带上真实错误码（否则日志只见 end=complete，真因被掩盖）
      let lastSoloErr: SOLOStreamError | null = null
      // 请求侧错误（4027 等）由 applyStreamError 内部判定为「不罚号」：流已开、状态码改不了，
      // 客户端由 sse.ts 的标准 error 帧获知（帧里有 code/msg），这里只保证不误伤账号。
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
        soloStreamToOpenAIStream(resp.body, configName, onErr, (info) => {
          // 静默截断定责标记：end=complete 既可能是上游自然收尾，也可能是「没发 done 就断」
          // 被 sse.ts 兜底成 stop。这条日志把两者分开——事后按 end=truncated 直接定位，
          // 不必再从客户端会话记录反推（2026-09-27 那次只能靠 DSH 会话文件才查出）。
          const msg = `[trae-stream] provider=${provider.id} uid=${account.uid} model=${configName}`
            + ` end=truncated kind=${info.kind} content=${info.contentChars} reasoning=${info.reasoningChars}`
            + ` toolCalls=${info.sawToolCalls} usage=${info.sawUsage}`
          console.log(msg) // codeql-disable: 纯诊断日志，不含密钥/敏感 token
          writeLog(env, 'warn', msg).catch(() => { /* 日志失败不影响流 */ })
        }, (info) => {
          // 推理退化（思考死循环）熔断标记：与「上游截断」分开记，事后按 end=runaway 直接定位。
          // **刻意不冷却账号**：退化是模型采样行为，不是账号故障；罚号会把健康池刷成
          // no_healthy_account（本仓 applyChatError 的 transport/client_params 分支同纪律）。
          const msg = `[trae-stream] provider=${provider.id} uid=${account.uid} model=${configName}`
            + ` end=runaway kind=${info.kind} reasoning=${info.reasoningChars} content=${info.contentChars}`
            + ` toolCalls=${info.sawToolCalls}`
          console.log(msg) // codeql-disable: 纯诊断日志，不含密钥/敏感 token
          writeLog(env, 'warn', msg).catch(() => { /* 日志失败不影响流 */ })
        }, (info) => {
          // 收尾审计（SoloDoneAudit）：把「上游发了 done、正文却停在半句」与「上游没发 done」
          // 分开。2026-09-27 的实证是前者——截断带着 finish=stop 到达客户端，`!sawDone` 那道
          // 防线抓不到，只能靠 done 次数与「done 之后还有多少正文」定性：
          //   postDoneContent=0 且 dones=1 → 上游自己就产出了这么多（模型早停/上游报 stop）；
          //   postDoneContent>0 或 dones>1 → 上游 done 之后仍在发正文，客户端按 [DONE] 丢弃。
          // 只记日志，不改任何下行帧、不罚号；dones=0 的流已由 end=truncated 那条 warn 覆盖。
          if (info.dones === 0) return
          const audit = `[trae-stream] provider=${provider.id} uid=${account.uid} model=${configName}`
            + ` end=done-audit dones=${info.dones} postDoneContent=${info.postDoneContentChars}`
            + ` postDoneReasoning=${info.postDoneReasoningChars} postDoneToolCalls=${info.postDoneToolCalls}`
            + ` content=${info.contentChars} reasoning=${info.reasoningChars} toolCalls=${info.sawToolCalls}`
          console.log(audit) // codeql-disable: 纯诊断日志，不含密钥/敏感 token
          writeLog(env, 'info', audit).catch(() => { /* 日志失败不影响流 */ })
        }),
        keepAliveMs,
        idleTimeoutMs,
        (reason) => {
          // 流结束态诊断：区分 上游自然读完(complete) / 空闲超时(idle) / 客户端断开(cancel) / 读体异常(error)。
          // 用于排查"回答中途停住"——若 9 分多钟那次的结束态是 cancel，说明是客户端掐断；
          // idle 说明上游长时间无数据被 idle 兜底；complete 则是上游正常收尾。
          const secs = Math.round((Date.now() - startedAt) / 1000)
          const errInfo = lastSoloErr ? ` errCode=${lastSoloErr.code} errMsg=${lastSoloErr.msg}` : ''
          // connect= 是「建连+响应头」耗时：成功样本的分布是判断 30s 常量是否过紧的唯一依据
          // （若成功样本长期贴着 20-29s，说明临界；若普遍 <10s，则 30s 不是瓶颈）。
          const msg = `[trae-stream] provider=${provider.id} uid=${account.uid} model=${configName} end=${reason} duration=${secs}s connect=${timing.connectMs ?? -1}ms${errInfo}`
          console.log(msg) // codeql-disable: 纯诊断日志，不含密钥/敏感 token
          writeLog(env, 'info', msg).catch(() => { /* 日志失败不影响流 */ })
          // 流真正结束后释放会话占用（只在 acquire 过时实际减计数；release 幂等）
          void releaseTraeSession(env, provider.id, account.uid).catch(() => {})
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
    // 读体抛错也要记下来：聚合层只能看见「没有 done」，区分不了「干净 EOF」与「读体异常」
    //（与流式路径的 readErrored 同义，决定 truncated.kind 是 no_done 还是 read_error）。
    let aggReadError = false
    const text = await resp.text().catch(() => { aggReadError = true; return '' })
    const agg = aggregateSoloSse(text, { readError: aggReadError })
    if (agg.err) {
      lastErr = new Error(`solo stream error code=${agg.err.code} msg=${agg.err.msg}`)
      const requestSide = await applyStreamError(env, provider.id, account.uid, agg.err, cd)
      await releaseTraeSession(env, provider.id, account.uid).catch(() => {})
      // 请求侧参数错 → 4xx 终态，不轮转（同 HTTP 路径；避免被误报成 503 账号池无可用账号）
      if (requestSide) {
        return traeClientParamsError(`solo error code=${agg.err.code} msg=${agg.err.msg}`)
      }
      // 聚合发现 1005 或 4008 额度不足，自动尝试 Work 通道
      if ((agg.err.code === 1005 || agg.err.code === 4008) && !hasTools) {
        const fallbackResp = await executeWorkRequest(env, provider, body, configName, prompt, stream)
        if (fallbackResp) return fallbackResp
      }
      continue
    }
    await noteTraeSuccess(env, provider.id, account.uid)
    await releaseTraeSession(env, provider.id, account.uid).catch(() => {})

    // 上游没发 done 就断（非流式聚合截断）：与流式路径同构的处理——
    //   1. 不罚号：这条路径的聚合结果不会经过 applyStreamError，但若把截断塞进 err 通道，
    //      noteTraeError 会把一次网络抖动累计成账号冷却，最后又报「账号池无可用账号」；
    //   2. 不返回 agg.resp：那是半句话，客户端会当完整回答（2026-09-27 事故）；
    //   3. 先降级 Work 通道（另一条 host/协议），仍失败则由函数末尾按 transport 定责报
    //      503 upstream_unreachable（可重试，且不冤枉账号）。
    if (agg.truncated) {
      const info = agg.truncated
      const msg = `[trae-agg] provider=${provider.id} uid=${account.uid} model=${configName}`
        + ` end=truncated kind=${info.kind} content=${info.contentChars} reasoning=${info.reasoningChars}`
        + ` toolCalls=${info.sawToolCalls} usage=${info.sawUsage}`
      console.log(msg) // codeql-disable: 纯诊断日志，不含密钥/敏感 token
      writeLog(env, 'warn', msg).catch(() => { /* 日志失败不影响响应 */ })
      const e = new Error(
        `TRAE SOLO 非流式聚合未收到 done（kind=${info.kind} content=${info.contentChars}）`
      ) as Error & { kind?: string }
      e.kind = 'transport' // 复用末尾 503 定责：不罚号、不报「账号池无可用账号」
      lastErr = e
      if (!hasTools) {
        const fallbackResp = await executeWorkRequest(env, provider, body, configName, prompt, stream)
        if (fallbackResp) return fallbackResp
      }
      continue
    }

    const out = agg.resp!
    out['model'] = configName
    return new Response(JSON.stringify(out), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
  }

  // 2. 所有 SOLO 账号均不可用（全部冷却/禁用/额度耗尽），最终尝试 Work 通道兜底。
  //    循环内已兜底过就不再重复：transport 撞满跳出时循环里刚试过 Work，而 Work 侧同样
  //    撞的是「网关↔上游建连」，再撞一遍只是又白等 2×30s（实测 62s 那次的放大来源）。
  if (!hasTools && !workFallbackTried) {
    const fallbackResp = await executeWorkRequest(env, provider, body, configName, prompt, stream)
    if (fallbackResp) return fallbackResp
  }

  // 连接层失败（建连超时/掐断）不会罚号（applyChatError 的 transport 分支），此时报
  // 「所有账号 cooling/disabled」是把排查方向引到账号上——实测 2026-09-27 用户据此去查
  // 账号池，真因却是网关↔上游的 30s 建连超时连续撞了两个账号（62s ≈ 2×
  // TRAE_CHAT_CONNECT_TIMEOUT_MS），且 520ms 后重试即成功（池子健康）。
  // 仍用 503（客户端按可重试 5xx 处理，不变），只把 code/文案改成真因。
  if ((lastErr as any)?.kind === 'transport') {
    // 聚合结论行：与每条尝试的 [trae-transport] 配对（同 cline `[cline-attempt]` 口径），
    // 面板搜一次即可看到「这次请求总共撞了几次、有没有试过 Work 兜底」。
    await logTraeTransport(env, `[trae-transport] provider=${provider.id} model=${configName}`
      + ` end=503 upstream_unreachable attempts=${transportAttempts} tools=${hasTools} workFallback=${workFallbackTried}`
      + ` err=${(lastErr?.message || '').slice(0, 160)}`)
    return openaiError(
      503,
      'upstream_unreachable',
      'TRAE SOLO 上游连接超时/中断（账号未被惩罚，非账号池问题）：' + (lastErr?.message || '')
    )
  }

  const msg = 'all accounts unavailable (cooling/disabled)' + (lastErr ? ': ' + lastErr.message : '')
  return openaiError(503, 'no_healthy_account', msg)
}
