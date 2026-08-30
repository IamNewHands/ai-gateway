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
const RATE_LIMIT_BACKOFF_BASE_MS = 30 * 1000 // 指数退避基数：30s·2^(n-1)（同原版）
const MAX_COOLDOWN_MS = 30 * 60 * 1000 // 最大冷却 30 分钟
const AUTH_FAIL_COOLDOWN_MS = 24 * 60 * 60 * 1000 // 鉴权/403 冷却 24h（同原版）
const SERVICE_UNAVAILABLE_COOLDOWN_MS = 15 * 1000 // 503 冷却 15s（同原版）
const EMPTY_COOLDOWN_MS = 10 * 1000 // 空响应冷却 10s（原版 10–30s）
const UNKNOWN_COOLDOWN_MS = 30 * 1000 // 未知错误冷却 30s（原版 10–30s）
const IMAGE_LIMIT_COOLDOWN_MS = 24 * 60 * 60 * 1000 // 图片额度耗尽冷却 24h（同原版 MarkImageLimited）
const METERING_COOLDOWN_MS = 15 * 60 * 1000 // 结构化 metering 节流固定冷却 15min（同原版 8-27）
// 全局熔断器参数（同原版：30s 窗口内失败 ≥10 次且失败率 ≥50% → 熔断 30s）。
// KV 落盘使其在跨实例/跨 DO 间共享，达到"全局"熔断语义。
const BREAKER_WINDOW_MS = 30 * 1000
const BREAKER_MIN_FAILURES = 10
const BREAKER_FAIL_RATE = 0.5
const BREAKER_TRIP_MS = 30 * 1000

export interface AccountHealthState {
  /** 冷却到期时间（Unix ms），0 表示未冷却 */
  cooldownUntil: number
  /** 是否鉴权失败（token 无效） */
  authFailed: boolean
  /** 图片额度耗尽到期时间（Unix ms），0 表示正常 */
  imageLimitedUntil: number
  /** 连续限流次数（供指数退避） */
  rlFailures?: number
  /** 熔断器滑动窗口起点（Unix ms） */
  breakerStart?: number
  /** 窗口内失败次数 */
  breakerFailures?: number
  /** 窗口内总请求数 */
  breakerTotal?: number
  /** 熔断到期时间（Unix ms），0 表示未熔断 */
  trippedUntil?: number
  /** 最后更新时间 */
  updatedAt: number
}

async function readHealth(env: Env, accountId: string): Promise<AccountHealthState> {
  try {
    const raw = await env.KV.get(ACCOUNT_HEALTH_PREFIX + accountId)
    if (!raw) return { cooldownUntil: 0, authFailed: false, imageLimitedUntil: 0, rlFailures: 0, updatedAt: 0 }
    const s = JSON.parse(raw) as Partial<AccountHealthState>
    return {
      cooldownUntil: s.cooldownUntil || 0,
      authFailed: !!s.authFailed,
      imageLimitedUntil: s.imageLimitedUntil || 0,
      rlFailures: s.rlFailures || 0,
      breakerStart: s.breakerStart || 0,
      breakerFailures: s.breakerFailures || 0,
      breakerTotal: s.breakerTotal || 0,
      trippedUntil: s.trippedUntil || 0,
      updatedAt: s.updatedAt || 0,
    }
  } catch {
    return { cooldownUntil: 0, authFailed: false, imageLimitedUntil: 0, rlFailures: 0, updatedAt: 0 }
  }
}

/** 熔断器事件：维护 30s 滑动窗口计数，达阈值则熔断 30s（同原版断路器） */
function updateBreaker(state: AccountHealthState, now: number, ok: boolean): void {
  if (!state.breakerStart || now - state.breakerStart > BREAKER_WINDOW_MS) {
    state.breakerStart = now
    state.breakerFailures = 0
    state.breakerTotal = 0
  }
  state.breakerTotal = (state.breakerTotal || 0) + 1
  if (!ok) state.breakerFailures = (state.breakerFailures || 0) + 1
  // 仅当未处于熔断中才触发（一旦熔断，isAccountAvailable 会暂时跳过该账号，窗口自然冷却）
  if (!state.trippedUntil || now >= state.trippedUntil) {
    if ((state.breakerFailures || 0) >= BREAKER_MIN_FAILURES && (state.breakerTotal || 0) > 0
      && (state.breakerFailures || 0) / (state.breakerTotal || 1) >= BREAKER_FAIL_RATE) {
      state.trippedUntil = now + BREAKER_TRIP_MS
    }
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

/** 判断错误是否是限流相关（429 / 503 / 上游限流提示） */
export function isRateLimited(err: Error | string): boolean {
  const msg = typeof err === 'string' ? err : err.message || ''
  const low = msg.toLowerCase()
  return (
    low.includes('upstream rate-limit notice') ||
    low.includes('rate limit') ||
    low.includes('too many requests') ||
    low.includes('429') ||
    low.includes('503') ||
    low.includes('service unavailable') ||
    low.includes('throttl')
  )
}

/** 判断错误是否是 503 服务不可用（同原版 IsRateLimited 含 503，但冷却更短） */
export function isServiceUnavailable(err: Error | string): boolean {
  const msg = typeof err === 'string' ? err : err.message || ''
  const low = msg.toLowerCase()
  return low.includes('503') || low.includes('service unavailable')
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

/** 判断错误是否为空响应 */
export function isEmptyCompletion(err: Error | string): boolean {
  const msg = typeof err === 'string' ? err : err.message || ''
  return msg.includes('empty completion') || msg.includes('empty response')
}

/** 判断错误是否为结构化 metering 节流（同原版 ErrMeteringThrottled，固定 15min 冷却） */
function isMeteringThrottle(err: Error | string): boolean {
  const msg = typeof err === 'string' ? err : err.message || ''
  return msg.includes('metering throttle') || msg.includes('capability access denied')
}

/**
 * 判断错误是否"可重试"（同原版 IsRetryable：CategoryRetryable422 / 传输类临时错误）。
 * 用于新会话 failover 时决定是否切下一健康账号，而非直接返回 502。
 * - 422（Unprocessable Entity）：可重试，客户端/网关换参数或账号再试
 * - 传输类（TLS/DNS/连接/握手/读超时/EOF/SOCKS）：临时网络故障，可换号重试
 * - 鉴权类（401/403/令牌失效）除外（属永久/需重新授权的失败）
 */
export function isRetryable(err: Error | string): boolean {
  const msg = typeof err === 'string' ? err : err.message || ''
  const low = msg.toLowerCase()
  if (isAuthFailure(err)) return false
  // 内容策略 / 空完成 属"永久/需改词"失败，不参与切号重试
  if (low.includes('content policy') || low.includes('offensive') || low.includes('empty completion') || low.includes('empty response')) return false
  // 无语义进展超时是微软长时间不吐内容、属于"卡住"，切号重试只会放大账号负载（同原版 mayFailOverChatHubFailure=false）
  if (low.includes('chat_progress_timeout')) return false
  if (low.includes('422') || low.includes('unprocessable')) return true
  if (
    low.includes('connection ') || low.includes('connection refused') ||
    low.includes('tls') || low.includes('dns') || low.includes('no such host') ||
    low.includes('handshake') || low.includes('read timeout') || low.includes('i/o timeout') ||
    low.includes('eof') || low.includes('timeout') || low.includes('reset') ||
    low.includes('socket') || low.includes('socks') || low.includes('upstream')
  ) return true
  return false
}

/**
 * 标记账户失败（分类冷却）。
 * - 鉴权失败（401/403）：冷却 24h（同原版）
 * - 限流（429/503）：指数退避 30s·2^(n-1) 封顶 30min；503 用 15s；上游 Retry-After 优先
 * - 空响应：冷却 10s
 * - 未知错误：短冷却 30s（原版 10–30s）
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
  const msg = typeof err === 'string' ? err : err.message || ''

  updateBreaker(state, now, false)

  if (isAuthFailure(err)) {
    state.authFailed = true
    state.rlFailures = 0
    state.cooldownUntil = now + AUTH_FAIL_COOLDOWN_MS
  } else if (isRateLimited(err)) {
    state.authFailed = false
    let cd: number
    if (retryAfterSeconds && retryAfterSeconds > 0) {
      cd = retryAfterSeconds * 1000
    } else if (isMeteringThrottle(err)) {
      // 结构化 metering 节流且无上游 Retry-After：固定 15min 冷却并复位退避计数（同原版 8-27）
      state.rlFailures = 0
      cd = METERING_COOLDOWN_MS
    } else if (isServiceUnavailable(msg)) {
      cd = SERVICE_UNAVAILABLE_COOLDOWN_MS
    } else {
      // 指数退避：连续限流越多次冷却越久
      const n = (state.rlFailures || 0) + 1
      state.rlFailures = n
      cd = Math.min(RATE_LIMIT_BACKOFF_BASE_MS * Math.pow(2, n - 1), MAX_COOLDOWN_MS)
    }
    if (cd > MAX_COOLDOWN_MS) cd = MAX_COOLDOWN_MS
    state.cooldownUntil = now + cd
  } else if (isEmptyCompletion(err)) {
    state.authFailed = false
    state.cooldownUntil = now + EMPTY_COOLDOWN_MS
  } else {
    // 未知错误：短冷却（原版 10–30s）
    state.authFailed = false
    state.cooldownUntil = now + UNKNOWN_COOLDOWN_MS
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
  state.rlFailures = 0
  await writeHealth(env, accountId, state)
  console.log(`[account-health] ${accountId} marked image-limited until ${new Date(state.imageLimitedUntil).toISOString()}`)
}

/** 标记账户成功（清除失败状态与限流退避计数；图片额度封禁保留至到期，同原版 MarkSuccess） */
export async function markAccountSuccess(env: Env, accountId: string): Promise<void> {
  const state = await readHealth(env, accountId)
  // 成功计入熔断窗口（用于失败率分母），并复位限流退避计数
  updateBreaker(state, Date.now(), true)
  await writeHealth(env, accountId, {
    cooldownUntil: 0,
    authFailed: false,
    rlFailures: 0,
    // 熔断窗口延续（updateBreaker 已更新 state）
    breakerStart: state.breakerStart,
    breakerFailures: state.breakerFailures,
    breakerTotal: state.breakerTotal,
    trippedUntil: state.trippedUntil,
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
  // 全局熔断器：命中时跳过该账号（跨实例/跨 DO 共享）
  if (state.trippedUntil && Date.now() < state.trippedUntil) return false
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
  retryAfterSeconds?: number,
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

  await markAccountFailure(env, accountId, originalErr, retryAfterSeconds)
  return true
}
