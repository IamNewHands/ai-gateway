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
import { TRAE_DEFAULT_MODEL, TRAE_STATIC_MODEL_IDS, normalizeTraeModelName } from './constants'
import { chatStream, exchangeToken, needsTraeRefresh } from './upstream'
import { aggregateSoloSse, soloStreamToOpenAIStream } from './sse'
import type { SOLOStreamError } from './types'
import {
  TRAE_ERR_COOLDOWN_MS,
  TRAE_ERR_THRESHOLD,
  TRAE_PLAN_COOLDOWN_MS,
  TRAE_SOFT_COOLDOWN_MS,
  cooldownTraeAccount,
  disableTraeAccount,
  getTraeAccounts,
  noteTraeError,
  noteTraeSuccess,
  pickTraeAccount,
  saveTraeAccount,
} from './pool'

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
async function applyChatError(env: Env, providerId: string, uid: string, kind: string): Promise<void> {
  switch (kind) {
    case 'plan_limit':
      await cooldownTraeAccount(env, providerId, uid, TRAE_PLAN_COOLDOWN_MS, 'plan 权益不足')
      break
    case 'soft_rate':
      await cooldownTraeAccount(env, providerId, uid, TRAE_SOFT_COOLDOWN_MS, '429 rate limit')
      break
    case 'session_dead':
      await disableTraeAccount(env, providerId, uid, 'session dead')
      break
    case 'not_found':
      // 404 短冷却不累计 errCount（防雪崩）
      await cooldownTraeAccount(env, providerId, uid, TRAE_SOFT_COOLDOWN_MS, 'upstream 404')
      break
    default:
      await noteTraeError(env, providerId, uid, TRAE_ERR_THRESHOLD, TRAE_ERR_COOLDOWN_MS)
  }
}

/** 流内业务错误 → 冷却状态机（Go handleStreamError：1005 plan → 长冷却；其余累计错误）。 */
async function applyStreamError(env: Env, providerId: string, uid: string, se: SOLOStreamError): Promise<void> {
  if (se.code === 1005) {
    await cooldownTraeAccount(env, providerId, uid, TRAE_PLAN_COOLDOWN_MS, 'plan 权益不足')
  } else {
    await noteTraeError(env, providerId, uid, TRAE_ERR_THRESHOLD, TRAE_ERR_COOLDOWN_MS)
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
  const tried = new Set<string>()
  let lastErr: Error | null = null

  for (let i = 0; i < MAX_ROTATE; i++) {
    const account = await pickTraeAccount(env, provider.id, accounts, tried)
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
        await cooldownTraeAccount(env, provider.id, account.uid, TRAE_ERR_COOLDOWN_MS, 'refresh: ' + ((e as Error).message || '').substring(0, 120))
      }
      continue
    }

    let resp: Response
    try {
      resp = await chatStream(account, body)
    } catch (e) {
      lastErr = e as Error
      await applyChatError(env, provider.id, account.uid, (e as any).kind || 'client')
      continue
    }

    if (stream) {
      await noteTraeSuccess(env, provider.id, account.uid)
      if (!resp.body) {
        return openaiError(502, 'upstream_empty', 'upstream returned empty body')
      }
      // 流内业务错误（1005 plan/5xx 等）→ 冷却账号，错误信息注入 SSE
      const onErr = (se: SOLOStreamError) => { void applyStreamError(env, provider.id, account.uid, se) }
      return new Response(resp.body.pipeThrough(soloStreamToOpenAIStream(configName, onErr)), {
        status: resp.status,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      })
    }

    // 非流式：聚合 SOLO SSE 为单条 chat.completion
    const text = await resp.text().catch(() => '')
    const agg = aggregateSoloSse(text)
    if (agg.err) {
      lastErr = new Error(`solo stream error code=${agg.err.code} msg=${agg.err.msg}`)
      await applyStreamError(env, provider.id, account.uid, agg.err)
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
