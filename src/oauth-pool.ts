/**
 * oauth-pool.ts — WorkBuddy/CodeBuddy OAuth 多账号池（移植 workbuddy-wild internal/pool 思路）。
 *
 * 现状：browser 登录流每个 provider 只存一份 token（oauth:token:<id>），一个账号失效即 502，
 * 无冷却/禁用概念。本模块为这类提供商加"账号池"：
 *   - 池内每个账号（按 JWT uid 去重）存一份 OAuthTokenState（含 cookies）；
 *   - 转发时按剩余积分最高者挑号，失败按错误分类冷却/禁用并轮转下一个账号；
 *   - 签到成功后 credits>0 的冷却账号自动解冻（对齐 workbuddy-wild ReenableIfCredits）。
 *
 * 池 KV key：oauth:pool:<providerId>（OAUTH_POOL_KV_PREFIX，与 oauth.ts 共用，避免循环依赖）。
 * 兼容迁移：池为空时若存在单 token（oauth:token:<id>），自动种子成池账号。
 * 冷却参数默认对齐 workbuddy-wild cooldown.*（12h / 60s / 5 次 / 10m），可被 provider.cooldown 覆盖。
 */
import type { Env, OAuthDeviceConfig, OAuthTokenState, Provider } from './types'
import { OAUTH_POOL_KV_PREFIX, decodeJwtUid, readOauthToken, refreshBrowserTokenState } from './oauth'

/** 池内账号状态（冷却/禁用/积分） */
export interface OAuthPoolState {
  credits: number
  disabled: boolean
  reason?: string
  /** 冷却至 epoch ms；0 = 无冷却 */
  until: number
  errCount: number
}

/** 池内账号（凭证 + 状态），存于 KV oauth:pool:<providerId> */
export interface OAuthPoolAccount {
  uid: string
  nickname?: string
  token: OAuthTokenState
  enabled: boolean
  state: OAuthPoolState
  updatedAt: number
}

export type OAuthPool = OAuthPoolAccount[]

/** 解析后的冷却参数 */
export interface OAuthCooldownConfig {
  planMs: number
  softMs: number
  errThreshold: number
  errMs: number
}

// 默认冷却（对齐 workbuddy-wild config cooldown.*）
const DEFAULT_PLAN_MS = 12 * 60 * 60 * 1000
const DEFAULT_SOFT_MS = 60 * 1000
const DEFAULT_ERR_THRESHOLD = 5
const DEFAULT_ERR_MS = 10 * 60 * 1000

/** 合并 provider.cooldown 与默认值。 */
export function resolveOauthCooldown(provider: Provider): OAuthCooldownConfig {
  const c = provider.cooldown
  return {
    planMs: c?.planMs && c.planMs > 0 ? c.planMs : DEFAULT_PLAN_MS,
    softMs: c?.softMs && c.softMs > 0 ? c.softMs : DEFAULT_SOFT_MS,
    errThreshold: c?.errThreshold && c.errThreshold > 0 ? c.errThreshold : DEFAULT_ERR_THRESHOLD,
    errMs: c?.errMs && c.errMs > 0 ? c.errMs : DEFAULT_ERR_MS,
  }
}

/** 是否为 WorkBuddy 多账号池提供商（browser 登录流）。 */
export function isOAuthPoolProvider(provider: { authType?: string; oauth?: { flowType?: string } }): boolean {
  return provider.authType === 'oauth-device' && provider.oauth?.flowType === 'browser'
}

const poolKey = (providerId: string) => OAUTH_POOL_KV_PREFIX + providerId

// ===== 内存 + KV 双缓存（同 trae 池模式，短 TTL） =====
const poolCache = new Map<string, { pool: OAuthPool; at: number }>()
const POOL_CACHE_TTL_MS = 1000

export async function readOauthPool(env: Env, providerId: string): Promise<OAuthPool> {
  const hit = poolCache.get(providerId)
  if (hit && Date.now() - hit.at < POOL_CACHE_TTL_MS) return hit.pool
  let pool: OAuthPool = []
  try {
    const raw = await env.KV.get(poolKey(providerId))
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      pool = Array.isArray(parsed) ? (parsed as OAuthPool) : []
    }
  } catch { /* 损坏当空池 */ }
  poolCache.set(providerId, { pool, at: Date.now() })
  return pool
}

export async function writeOauthPool(env: Env, providerId: string, pool: OAuthPool): Promise<void> {
  poolCache.set(providerId, { pool, at: Date.now() })
  try {
    await env.KV.put(poolKey(providerId), JSON.stringify(pool))
  } catch { /* KV 写失败不阻断主流程 */ }
}

/** 账号是否健康：启用、未禁用、不在冷却期。无状态（新账号）视为健康。 */
export function isOauthAccountHealthy(acc: OAuthPoolAccount, now: number): boolean {
  if (!acc || acc.enabled === false) return false
  if (acc.state?.disabled) return false
  if (acc.state?.until && acc.state.until > now) return false
  return true
}

/** 兼容迁移：池为空时把单 token（oauth:token:<id>）种子成池账号；返回是否迁移。 */
export async function seedOauthPoolFromSingle(env: Env, providerId: string): Promise<boolean> {
  const pool = await readOauthPool(env, providerId)
  if (pool.length > 0) return false
  const single = await readOauthToken(env, providerId)
  if (!single?.access_token) return false
  const uid = decodeJwtUid(single.access_token)
  if (!uid) return false
  await writeOauthPool(env, providerId, [{
    uid,
    token: single,
    enabled: true,
    state: { credits: 0, disabled: false, until: 0, errCount: 0 },
    updatedAt: Date.now(),
  }])
  return true
}

/** upsert 一个账号（按 uid），返回新池。 */
export async function upsertOauthAccount(
  env: Env,
  providerId: string,
  token: OAuthTokenState,
  nickname?: string
): Promise<OAuthPool> {
  const uid = decodeJwtUid(token.access_token)
  if (!uid) return readOauthPool(env, providerId)
  const pool = await readOauthPool(env, providerId)
  const existing = pool.find((a) => a.uid === uid)
  if (existing) {
    existing.token = token
    existing.enabled = true
    if (nickname) existing.nickname = nickname
    existing.updatedAt = Date.now()
  } else {
    pool.push({
      uid,
      nickname,
      token,
      enabled: true,
      state: { credits: 0, disabled: false, until: 0, errCount: 0 },
      updatedAt: Date.now(),
    })
  }
  await writeOauthPool(env, providerId, pool)
  return pool
}

/** 挑号：healthy + 未 tried 中剩余积分最多者优先。 */
export async function pickOauthAccount(
  env: Env,
  providerId: string,
  tried: Set<string>
): Promise<OAuthPoolAccount | null> {
  const pool = await readOauthPool(env, providerId)
  const now = Date.now()
  let best: OAuthPoolAccount | null = null
  let bestCredits = -Infinity
  for (const a of pool) {
    if (tried.has(a.uid)) continue
    if (!isOauthAccountHealthy(a, now)) continue
    const credits = a.state?.credits ?? 0
    if (credits > bestCredits) {
      best = a
      bestCredits = credits
    }
  }
  return best
}

/** 刷新池内某账号 token（写回池），返回刷新后的账号或 null。 */
export async function refreshOauthPoolAccount(
  env: Env,
  providerId: string,
  uid: string,
  cfg: OAuthDeviceConfig
): Promise<OAuthPoolAccount | null> {
  const pool = await readOauthPool(env, providerId)
  const acc = pool.find((a) => a.uid === uid)
  if (!acc || !acc.token?.refresh_token) return null
  const fresh = await refreshBrowserTokenState(env, providerId, cfg, acc.token)
  if (!fresh) return null
  acc.token = fresh
  acc.updatedAt = Date.now()
  await writeOauthPool(env, providerId, pool)
  return acc
}

/** 冷却账号至 now+ms（清零 errCount）。 */
export async function cooldownOauthAccount(
  env: Env,
  providerId: string,
  uid: string,
  ms: number,
  reason: string
): Promise<void> {
  const pool = await readOauthPool(env, providerId)
  const acc = pool.find((a) => a.uid === uid)
  if (!acc) return
  acc.state = { ...(acc.state || {}), until: Date.now() + ms, reason, errCount: 0 }
  await writeOauthPool(env, providerId, pool)
}

/** 永久禁用（session 失效，需重新登录）。 */
export async function disableOauthAccount(env: Env, providerId: string, uid: string, reason: string): Promise<void> {
  const pool = await readOauthPool(env, providerId)
  const acc = pool.find((a) => a.uid === uid)
  if (!acc) return
  acc.state = { ...(acc.state || {}), disabled: true, reason }
  await writeOauthPool(env, providerId, pool)
}

/** 记录一次错误；达到阈值自动冷却 errMs。 */
export async function noteOauthError(env: Env, providerId: string, uid: string, cd: OAuthCooldownConfig): Promise<void> {
  const pool = await readOauthPool(env, providerId)
  const acc = pool.find((a) => a.uid === uid)
  if (!acc) return
  const st = acc.state || { credits: 0, disabled: false, until: 0, errCount: 0 }
  const errCount = (st.errCount || 0) + 1
  if (errCount >= cd.errThreshold) {
    acc.state = { ...st, errCount: 0, until: Date.now() + cd.errMs, reason: 'consecutive errors' }
  } else {
    acc.state = { ...st, errCount }
  }
  await writeOauthPool(env, providerId, pool)
}

/** 成功请求重置错误计数。 */
export async function noteOauthSuccess(env: Env, providerId: string, uid: string): Promise<void> {
  const pool = await readOauthPool(env, providerId)
  const acc = pool.find((a) => a.uid === uid)
  if (acc && (acc.state?.errCount || 0) > 0) {
    acc.state = { ...(acc.state || {}), errCount: 0 }
    await writeOauthPool(env, providerId, pool)
  }
}

/** 签到后解冻：仅当 remain > 0 且账号处于冷却（非禁用）时恢复。 */
export async function reenableOauthIfCredits(env: Env, providerId: string, uid: string, remain: number): Promise<void> {
  const pool = await readOauthPool(env, providerId)
  const acc = pool.find((a) => a.uid === uid)
  if (!acc) return
  const st = acc.state || { credits: 0, disabled: false, until: 0, errCount: 0 }
  acc.state = { ...st, credits: remain }
  if (remain > 0 && !st.disabled) {
    acc.state = { ...acc.state, until: 0, reason: '', errCount: 0 }
  }
  await writeOauthPool(env, providerId, pool)
}

/** 签到时回写昵称：池账号登录时可能未解出 JWT 昵称，签到后补齐供面板展示/对齐。 */
export async function setOauthPoolAccountNickname(env: Env, providerId: string, uid: string, nickname: string): Promise<void> {
  const pool = await readOauthPool(env, providerId)
  const acc = pool.find((a) => a.uid === uid)
  if (!acc || acc.nickname === nickname) return
  acc.nickname = nickname
  await writeOauthPool(env, providerId, pool)
}

/** 删除指定 uid 账号。 */
export async function removeOauthAccount(env: Env, providerId: string, uid: string): Promise<boolean> {
  const pool = await readOauthPool(env, providerId)
  const next = pool.filter((a) => a.uid !== uid)
  if (next.length === pool.length) return false
  await writeOauthPool(env, providerId, next)
  return true
}

/** 对外状态列表（脱敏，不含 token/cookie），供面板与 API 展示。 */
export async function listOauthPoolStatus(env: Env, providerId: string): Promise<Array<Record<string, unknown>>> {
  const pool = await readOauthPool(env, providerId)
  const now = Date.now()
  return pool.map((a) => ({
    uid: a.uid,
    nickname: a.nickname || '',
    enabled: a.enabled !== false,
    credits: a.state?.credits ?? 0,
    cooling: !!(a.state?.until && a.state.until > now),
    until: a.state?.until ?? 0,
    reason: a.state?.reason || '',
    disabled: a.state?.disabled === true,
    errCount: a.state?.errCount || 0,
    expiresAt: a.token?.expires_at ?? 0,
    updatedAt: a.updatedAt,
  }))
}
