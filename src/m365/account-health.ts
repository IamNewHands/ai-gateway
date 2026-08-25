/**
 * M365 账户健康检测 + 限流确认探测（移植自 M365-Copilot2API
 * internal/web/account_health.go + server.go#confirmRateLimitNotice）。
 *
 * 职责：
 * 1. 跟踪每个账户的失败状态（限流冷却 / 鉴权失败）
 * 2. 在标记限流前做二次确认探测（避免上游偶发误报导致误冷却）
 * 3. 提供 Available() 查询供故障转移跳过热账户
 * 4. 持久化到 KV（Cloudflare Workers 无进程内内存）
 *
 * 与 M365-Copilot2API 的差异：
 * - 原版用进程内 sync.Map，这里用 KV 存储（跨 Worker 实例共享）
 * - 限流确认探测需要在 DO 上下文中完成（需要 ChatHub WS 连接）
 */
import type { Env } from '../types'

const ACCOUNT_HEALTH_PREFIX = 'm365:health:'
const RATE_LIMIT_COOLDOWN_MS = 60 * 1000 // 1 分钟（对齐原版 ~30-60s）
const MAX_COOLDOWN_MS = 30 * 60 * 1000 // 最大冷却 30 分钟
const AUTH_FAIL_COOLDOWN_MS = 2 * 60 * 1000 // 鉴权失败冷却 2 分钟
const IMAGE_LIMIT_COOLDOWN_MS = 24 * 60 * 60 * 1000 // 图片额度耗尽冷却 24h（同原版 MarkImageLimited）

export interface AccountHealthState {
  /** 冷却到期时间（Unix ms），0 表示未冷却 */
  cooldownUntil: number
  /** 是否鉴权失败（token 无效） */
  authFailed: boolean
  /** 图片额度耗尽到期时间（Unix ms），0 表示正常 */
  imageLimitedUntil: number
  /** 最后更新时间 */
  updatedAt: number
}

async function readHealth(env: Env, accountId: string): Promise<AccountHealthState> {
  try {
    const raw = await env.KV.get(ACCOUNT_HEALTH_PREFIX + accountId)
    if (!raw) return { cooldownUntil: 0, authFailed: false, imageLimitedUntil: 0, updatedAt: 0 }
    const s = JSON.parse(raw) as Partial<AccountHealthState>
    return {
      cooldownUntil: s.cooldownUntil || 0,
      authFailed: !!s.authFailed,
      imageLimitedUntil: s.imageLimitedUntil || 0,
      updatedAt: s.updatedAt || 0,
    }
  } catch {
    return { cooldownUntil: 0, authFailed: false, imageLimitedUntil: 0, updatedAt: 0 }
  }
}

async function writeHealth(env: Env, accountId: string, state: AccountHealthState): Promise<void> {
  try {
    state.updatedAt = Date.now()
    // TTL 必须覆盖最长的 imageLimitedUntil（24h），否则闲置 1 小时记录过期、封禁丢失
    const maxUntil = Math.max(state.cooldownUntil, state.imageLimitedUntil)
    const ttlMs = Math.max(maxUntil - Date.now(), 10 * 60 * 1000)
    await env.KV.put(ACCOUNT_HEALTH_PREFIX + accountId, JSON.stringify(state), { expirationTtl: Math.ceil(ttlMs / 1000) })
  } catch { /* 写入失败不影响主流程 */ }
}

/** 判断错误是否是限流相关 */
export function isRateLimited(err: Error | string): boolean {
  const msg = typeof err === 'string' ? err : err.message || ''
  const low = msg.toLowerCase()
  return (
    low.includes('upstream rate-limit notice') ||
    low.includes('rate limit') ||
    low.includes('too many requests') ||
    low.includes('429') ||
    low.includes('throttl')
  )
}

/** 判断错误是否是鉴权失败（对齐原版：仅明确鉴权信号，避免把普通错误误判为鉴权失败） */
export function isAuthFailure(err: Error | string): boolean {
  const msg = typeof err === 'string' ? err : err.message || ''
  const low = msg.toLowerCase()
  return (
    low.includes('401') ||
    low.includes('403') ||
    low.includes('unauthorized') ||
    low.includes('forbidden') ||
    low.includes('token expired') ||
    low.includes('invalid_grant') ||
    low.includes('authentication failed')
  )
}

/** 判断错误是否是空响应 */
export function isEmptyCompletion(err: Error | string): boolean {
  const msg = typeof err === 'string' ? err : err.message || ''
  return msg.includes('empty completion') || msg.includes('empty response')
}

/**
 * 标记账户失败。
 * - 鉴权失败：冷却 2 分钟
 * - 限流：冷却 window（默认 3 分钟，上游 Retry-After 优先）
 * @param retryAfterSeconds 上游给出的 Retry-After 秒数（可选）
 */
export async function markAccountFailure(
  env: Env,
  accountId: string,
  err: Error | string,
  retryAfterSeconds?: number,
): Promise<void> {
  const state = await readHealth(env, accountId)
  const now = Date.now()

  if (isAuthFailure(err)) {
    state.authFailed = true
    state.cooldownUntil = now + AUTH_FAIL_COOLDOWN_MS
  } else if (isRateLimited(err)) {
    state.authFailed = false
    let cd = RATE_LIMIT_COOLDOWN_MS
    if (retryAfterSeconds && retryAfterSeconds > 0) {
      cd = retryAfterSeconds * 1000
      if (cd > MAX_COOLDOWN_MS) cd = MAX_COOLDOWN_MS
    }
    state.cooldownUntil = now + cd
  }

  await writeHealth(env, accountId, state)
  console.log(`[account-health] ${accountId} marked failure: authFailed=${state.authFailed} cooldown=${Math.ceil((state.cooldownUntil - now) / 1000)}s`)
}

/** 标记图片额度耗尽（24h 冷却，同原版 MarkImageLimited） */
export async function markAccountImageLimited(env: Env, accountId: string, hours = 24): Promise<void> {
  const state = await readHealth(env, accountId)
  state.imageLimitedUntil = Date.now() + Math.min(hours, 48) * 60 * 60 * 1000
  state.cooldownUntil = 0
  state.authFailed = false
  await writeHealth(env, accountId, state)
  console.log(`[account-health] ${accountId} marked image-limited until ${new Date(state.imageLimitedUntil).toISOString()}`)
}

/** 标记账户成功（清除失败状态；图片额度封禁保留至到期，同原版 MarkSuccess） */
export async function markAccountSuccess(env: Env, accountId: string): Promise<void> {
  const state = await readHealth(env, accountId)
  await writeHealth(env, accountId, {
    cooldownUntil: 0,
    authFailed: false,
    // 原版显式保留 imageLimited/imageLimitUntil 到自然到期，普通对话成功不解封图片额度
    imageLimitedUntil: state.imageLimitedUntil > Date.now() ? state.imageLimitedUntil : 0,
    updatedAt: Date.now(),
  })
}

/** 账户是否可用 */
export async function isAccountAvailable(env: Env, accountId: string): Promise<boolean> {
  const state = await readHealth(env, accountId)
  if (state.authFailed) return false
  if (state.imageLimitedUntil > 0 && Date.now() < state.imageLimitedUntil) return false
  if (state.cooldownUntil > 0 && Date.now() < state.cooldownUntil) return false
  return true
}

/** 获取冷却剩余秒数（用于 Retry-After，综合限流冷却与图片额度） */
export async function accountCooldownSeconds(env: Env, accountId: string): Promise<number> {
  const state = await readHealth(env, accountId)
  let remaining = 0
  if (state.cooldownUntil > 0) remaining = Math.max(remaining, state.cooldownUntil - Date.now())
  if (state.imageLimitedUntil > 0) remaining = Math.max(remaining, state.imageLimitedUntil - Date.now())
  return Math.ceil(remaining / 1000)
}

/** 获取所有账户的健康快照 */
export async function accountHealthSnapshot(env: Env): Promise<Record<string, { available: boolean; cooldownUntil: number; authFailed: boolean }>> {
  // 不能 list KV keys，这里返回空快照（管理 UI 可后续扩展）
  return {}
}

/**
 * 清除账户健康记录（管理员手动重置）。
 */
export async function clearAccountHealth(env: Env, accountId: string): Promise<void> {
  try {
    await env.KV.delete(ACCOUNT_HEALTH_PREFIX + accountId)
    console.log(`[account-health] ${accountId} health cleared`)
  } catch { /* ignore */ }
}

/**
 * 限流确认探测回调类型。
 * 在 DO 上下文中，用一条最小消息（"Reply with exactly: OK"）发起独立 ChatHub 对话，
 * 如果成功则说明之前的限流是误报，不标记冷却。
 */
export type RateLimitProbeFn = (env: Env, accountId: string) => Promise<boolean>

/**
 * 带确认探测的限流标记。
 * 先用 probe 函数做二次验证，只有确认限流才标记冷却。
 * 返回 true 表示确认限流。
 */
export async function confirmAndMarkRateLimit(
  env: Env,
  accountId: string,
  originalErr: Error | string,
  probe: RateLimitProbeFn,
): Promise<boolean> {
  if (!isRateLimited(originalErr)) return false

  try {
    const confirmed = await probe(env, accountId)
    if (!confirmed) {
      console.log(`[account-health] ${accountId} rate-limit probe passed (false positive), not marking`)
      return false
    }
  } catch {
    // 探测本身失败，保守起见标记限流
    console.log(`[account-health] ${accountId} rate-limit probe failed, marking as rate-limited`)
  }

  await markAccountFailure(env, accountId, originalErr)
  return true
}