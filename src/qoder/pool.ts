/**
 * pool.ts — QoderWork 多账号池（对齐 WorkBuddy oauth-pool / TRAE pool 模式）。
 *
 * Qoder 的 dt-/drt- token 非 JWT，账号身份用 OAuth 响应中的 user_id 标识：
 *   - 池内每个账号（按 user_id 去重）存一份 OAuthTokenState；
 *   - 转发时按剩余积分最高者挑号，失败按错误分类冷却/禁用并轮转下一个账号；
 *   - 签到成功后积分 > 0 的冷却账号自动解冻。
 *
 * 冷却状态机（对齐 cli2api classify.go + WorkBuddy 池）：
 *   quota（额度耗尽）  → 长冷却（默认 12h，签到恢复自动解冻）
 *   rate_limit（429）  → 短冷却（Retry-After 优先，默认 60s）
 *   auth（401/403）    → 禁用（需重新登录）
 *   not_ready（503）   → 短冷却 10s
 *   unavailable（5xx） → 冷却 15s
 *   连续错误 ≥ 阈值     → 中冷却（默认 10m）
 *
 * 池 KV key：qoder:pool:<providerId>（KV_KEYS.QODER_POOL_PREFIX）。
 * 兼容迁移：池为空时若存在单 token（oauth:token:<id>），自动种子成池账号。
 */
import type { Env, OAuthDeviceConfig, OAuthTokenState, Provider } from '../types'
import { KV_KEYS, OAUTH_TOKEN_REFRESH_MARGIN_MS } from '../config'
import { readOauthToken } from '../oauth'

/** 池内账号状态（冷却/禁用/积分）。 */
export interface QoderPoolState {
  credits: number
  disabled: boolean
  reason?: string
  /** 冷却至 epoch ms；0 = 无冷却 */
  until: number
  errCount: number
}

/** 池内账号（凭证 + 状态），存于 KV qoder:pool:<providerId> */
export interface QoderPoolAccount {
  uid: string
  nickname?: string
  token: OAuthTokenState
  enabled: boolean
  state: QoderPoolState
  updatedAt: number
}

export type QoderPool = QoderPoolAccount[]

/** 解析后的冷却参数（默认对齐 WorkBuddy 池，可被 provider.cooldown 覆盖）。 */
export interface QoderCooldownConfig {
  planMs: number
  softMs: number
  errThreshold: number
  errMs: number
}

// 默认冷却（对齐 WorkBuddy oauth-pool 默认值）
const DEFAULT_PLAN_MS = 12 * 60 * 60 * 1000
const DEFAULT_SOFT_MS = 60 * 1000
const DEFAULT_ERR_THRESHOLD = 5
const DEFAULT_ERR_MS = 10 * 60 * 1000

/** 合并 provider.cooldown 与默认值。 */
export function resolveQoderCooldown(provider: Provider): QoderCooldownConfig {
  const c = provider.cooldown
  return {
    planMs: c?.planMs && c.planMs > 0 ? c.planMs : DEFAULT_PLAN_MS,
    softMs: c?.softMs && c.softMs > 0 ? c.softMs : DEFAULT_SOFT_MS,
    errThreshold: c?.errThreshold && c.errThreshold > 0 ? c.errThreshold : DEFAULT_ERR_THRESHOLD,
    errMs: c?.errMs && c.errMs > 0 ? c.errMs : DEFAULT_ERR_MS,
  }
}

const poolKey = (providerId: string) => KV_KEYS.QODER_POOL_PREFIX + providerId

// ===== 内存 + KV 双缓存（同 trae / oauth-pool 模式，短 TTL） =====
const poolCache = new Map<string, { pool: QoderPool; at: number }>()
const POOL_CACHE_TTL_MS = 1000

export async function readQoderPool(env: Env, providerId: string): Promise<QoderPool> {
  const hit = poolCache.get(providerId)
  if (hit && Date.now() - hit.at < POOL_CACHE_TTL_MS) return hit.pool
  let pool: QoderPool = []
  try {
    const raw = await env.KV.get(poolKey(providerId))
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      pool = Array.isArray(parsed) ? (parsed as QoderPool) : []
    }
  } catch { /* 损坏当空池 */ }
  poolCache.set(providerId, { pool, at: Date.now() })
  return pool
}

export async function writeQoderPool(env: Env, providerId: string, pool: QoderPool): Promise<void> {
  poolCache.set(providerId, { pool, at: Date.now() })
  try {
    await env.KV.put(poolKey(providerId), JSON.stringify(pool))
  } catch { /* KV 写失败不阻断主流程 */ }
}

/** 账号是否健康：启用、未禁用、不在冷却期。无状态（新账号）视为健康。 */
export function isQoderAccountHealthy(acc: QoderPoolAccount, now: number): boolean {
  if (!acc || acc.enabled === false) return false
  if (acc.state?.disabled) return false
  if (acc.state?.until && acc.state.until > now) return false
  return true
}

/**
 * 兼容迁移：池为空时把单 token（oauth:token:<id>）种子成池账号。
 * uid 优先取 token 状态里的 user_id，缺失时用 access_token 前缀兜底。
 */
export async function seedQoderPoolFromSingle(env: Env, providerId: string): Promise<boolean> {
  const pool = await readQoderPool(env, providerId)
  if (pool.length > 0) return false
  const single = await readOauthToken(env, providerId)
  if (!single?.access_token) return false
  const uid = single.user_id || single.access_token.slice(0, 16)
  await writeQoderPool(env, providerId, [{
    uid,
    nickname: single.nickname,
    token: single,
    enabled: true,
    state: { credits: 0, disabled: false, until: 0, errCount: 0 },
    updatedAt: Date.now(),
  }])
  return true
}

/** 挑号：health + 未 tried 中剩余积分最多者优先；若指定 preferUid（账号固定）且该账号健康则固定返回它。 */
export async function pickQoderAccount(
  env: Env,
  providerId: string,
  tried: Set<string>,
  preferUid?: string
): Promise<QoderPoolAccount | null> {
  const pool = await readQoderPool(env, providerId)
  const now = Date.now()
  // 账号固定：客户端 X-Qoder-Account 指定的账号（uid）若健康则强制使用
  if (preferUid) {
    const pinned = pool.find((a) => a.uid === preferUid)
    if (pinned && !tried.has(pinned.uid) && isQoderAccountHealthy(pinned, now)) return pinned
  }
  let best: QoderPoolAccount | null = null
  let bestCredits = -Infinity
  for (const a of pool) {
    if (tried.has(a.uid)) continue
    if (!isQoderAccountHealthy(a, now)) continue
    const credits = a.state?.credits ?? 0
    if (credits > bestCredits) {
      best = a
      bestCredits = credits
    }
  }
  return best
}

/** 冷却账号至 now+ms（清零 errCount）。 */
export async function cooldownQoderAccount(
  env: Env,
  providerId: string,
  uid: string,
  ms: number,
  reason: string
): Promise<void> {
  const pool = await readQoderPool(env, providerId)
  const acc = pool.find((a) => a.uid === uid)
  if (!acc) return
  acc.state = { ...(acc.state || { credits: 0, disabled: false, until: 0, errCount: 0 }), until: Date.now() + ms, reason, errCount: 0 }
  await writeQoderPool(env, providerId, pool)
}

/** 永久禁用（token 失效，需重新登录）。 */
export async function disableQoderAccount(env: Env, providerId: string, uid: string, reason: string): Promise<void> {
  const pool = await readQoderPool(env, providerId)
  const acc = pool.find((a) => a.uid === uid)
  if (!acc) return
  acc.state = { ...(acc.state || { credits: 0, disabled: false, until: 0, errCount: 0 }), disabled: true, reason }
  await writeQoderPool(env, providerId, pool)
}

/** 记录一次错误；达到阈值自动冷却 errMs。 */
export async function noteQoderError(env: Env, providerId: string, uid: string, cd: QoderCooldownConfig): Promise<void> {
  const pool = await readQoderPool(env, providerId)
  const acc = pool.find((a) => a.uid === uid)
  if (!acc) return
  const st = acc.state || { credits: 0, disabled: false, until: 0, errCount: 0 }
  const errCount = (st.errCount || 0) + 1
  if (errCount >= cd.errThreshold) {
    acc.state = { ...st, errCount: 0, until: Date.now() + cd.errMs, reason: 'consecutive errors' }
  } else {
    acc.state = { ...st, errCount }
  }
  await writeQoderPool(env, providerId, pool)
}

/** 成功请求重置错误计数。 */
export async function noteQoderSuccess(env: Env, providerId: string, uid: string): Promise<void> {
  const pool = await readQoderPool(env, providerId)
  const acc = pool.find((a) => a.uid === uid)
  if (acc && (acc.state?.errCount || 0) > 0) {
    acc.state = { ...acc.state, errCount: 0 }
    await writeQoderPool(env, providerId, pool)
  }
}

/** 签到后解冻：仅当 remain > 0 且账号处于冷却（非禁用）时恢复。 */
export async function reenableQoderIfCredits(env: Env, providerId: string, uid: string, remain: number): Promise<void> {
  const pool = await readQoderPool(env, providerId)
  const acc = pool.find((a) => a.uid === uid)
  if (!acc) return
  const st = acc.state || { credits: 0, disabled: false, until: 0, errCount: 0 }
  acc.state = { ...st, credits: remain }
  if (remain > 0 && !st.disabled) {
    acc.state = { ...acc.state, until: 0, reason: '', errCount: 0 }
  }
  await writeQoderPool(env, providerId, pool)
}

/** 签到时回写昵称（池账号登录时可能未带 nickname，签到后补齐供面板展示）。 */
export async function setQoderPoolAccountNickname(env: Env, providerId: string, uid: string, nickname: string): Promise<void> {
  const pool = await readQoderPool(env, providerId)
  const acc = pool.find((a) => a.uid === uid)
  if (!acc || acc.nickname === nickname) return
  acc.nickname = nickname
  await writeQoderPool(env, providerId, pool)
}

/** 删除指定 uid 账号。 */
export async function removeQoderAccount(env: Env, providerId: string, uid: string): Promise<boolean> {
  const pool = await readQoderPool(env, providerId)
  const next = pool.filter((a) => a.uid !== uid)
  if (next.length === pool.length) return false
  await writeQoderPool(env, providerId, next)
  return true
}

/** 对外状态列表（脱敏，不含 token）。 */
export async function listQoderPoolStatus(env: Env, providerId: string): Promise<Array<Record<string, unknown>>> {
  const pool = await readQoderPool(env, providerId)
  const now = Date.now()
  return pool.map((a) => ({
    uid: a.uid,
    nickname: a.nickname || '',
    credits: a.state?.credits ?? 0,
    enabled: a.enabled !== false,
    disabled: a.state?.disabled === true,
    cooling: a.state?.until ? a.state.until > now : false,
    until: a.state?.until || 0,
    reason: a.state?.reason || '',
    errCount: a.state?.errCount || 0,
    tokenExpiresAt: a.token?.expires_at || 0,
    updatedAt: a.updatedAt || 0,
  }))
}

/**
 * 刷新池内某账号 token（写回池）。临近过期（< OAUTH_TOKEN_REFRESH_MARGIN_MS）才刷新。
 * 返回刷新后的账号或 null。
 */
export async function refreshQoderPoolAccountIfNeeded(
  env: Env,
  providerId: string,
  uid: string,
  cfg: OAuthDeviceConfig,
  refreshFn: (cfg: OAuthDeviceConfig, refreshToken: string, prev?: OAuthTokenState) => Promise<OAuthTokenState | null>
): Promise<QoderPoolAccount | null> {
  const pool = await readQoderPool(env, providerId)
  const acc = pool.find((a) => a.uid === uid)
  if (!acc || !acc.token?.refresh_token) return acc ?? null // 无 refresh_token 时原样返回（视为未过期）
  if (acc.token.expires_at && acc.token.expires_at - Date.now() > OAUTH_TOKEN_REFRESH_MARGIN_MS) return acc
  try {
    const fresh = await refreshFn(cfg, acc.token.refresh_token, acc.token)
    if (!fresh) return null
    acc.token = fresh
    acc.updatedAt = Date.now()
    await writeQoderPool(env, providerId, pool)
    return acc
  } catch {
    return null
  }
}
