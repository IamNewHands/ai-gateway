/**
 * oauth-pool.ts — WorkBuddy/CodeBuddy OAuth 多账号池（移植 workbuddy-wild internal/pool 思路）。
 *
 * 现状：browser 登录流每个 provider 只存一份 token（oauth:token:<id>），一个账号失效即 502，
 * 无冷却/禁用概念。本模块为这类提供商加"账号池"：
 *   - 池内每个账号（按 JWT uid 去重）存一份 OAuthTokenState（含 cookies）；
 *   - 转发时按三因子加权随机挑号（移植 workbuddy2api pool.go），失败按错误分类冷却/禁用并轮转下一个账号；
 *   - 签到成功后 credits>0 的冷却账号自动解冻（对齐 workbuddy-wild ReenableIfCredits）。
 *
 * 挑选策略（对齐 workbuddy2api pool.go pick/weightOf）：
 *   权重 = credits 比例 ×10 + 闲置补偿（每小时 +0.5 封顶 5.0）+ 成功率 ×3
 *   - 候选按权重降序取 Top5 短名单，再在 Top5 内按同权重加权随机（credits 只是因子之一，
 *     闲置补偿与成功率同样决定谁进短名单，打散热点避免永远打同一个账号）；
 *   - 防惊群：同一账号 100ms 内不重复被选中（除非 Top5 全部刚被用过 → LRU 兜底）；
 *   - 全冷却兜底（allowCoolingFallback）：无健康账号时从冷却账号中选最早到期者顶班
 *     （禁用与余额耗尽号永不参与，对齐 workbuddy2api pickEarliestExpiryLocked）。
 *
 * 运行态说明：lastUsed（防惊群 + 闲置补偿）与 successCount 存于模块级内存 Map（隔离重启归零、
 * 多隔离实例各自记账，best-effort），不写 KV —— 避免每请求一次 KV 写的超额消耗；
 * errTotal 随 noteOauthError 的既有 KV 写顺带持久化。credits / 冷却 / 禁用仍以 KV 为唯一权威。
 *
 * 池 KV key：oauth:pool:<providerId>（OAUTH_POOL_KV_PREFIX，与 oauth.ts 共用，避免循环依赖）。
 * 兼容迁移：池为空时若存在单 token（oauth:token:<id>），自动种子成池账号。
 * 冷却参数默认对齐 workbuddy-wild cooldown.*（12h / 60s / 5 次 / 10m），可被 provider.cooldown 覆盖。
 */
import type { Env, OAuthDeviceConfig, OAuthTokenState, Provider } from './types'
import { OAUTH_POOL_KV_PREFIX, decodeJwtUid, readOauthToken, refreshBrowserTokenState } from './oauth'
import { nextDay4AMMs } from './workbuddy-upstream'

/** 池内账号状态（冷却/禁用/积分） */
export interface OAuthPoolState {
  credits: number
  disabled: boolean
  reason?: string
  /** 冷却至 epoch ms；0 = 无冷却 */
  until: number
  errCount: number
  // ===== 三因子加权扩展字段（可选，兼容旧 KV 数据：缺省按 0 处理） =====
  /** 累计成功请求数（节流落盘，内存优先） */
  successCount?: number
  /** 累计错误请求数（随 noteOauthError 的 KV 写持久化，供成功率因子） */
  errTotal?: number
  /** 最近成功时间（epoch ms） */
  lastSuccess?: number
  /** 最近错误时间（epoch ms） */
  lastErr?: number
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

// ===== 挑选运行态（内存态，不写 KV；隔离重启归零，多隔离实例各自记账） =====

/** 单账号运行态：最近被选中时刻 + 成功计数（内存优先，成功率因子用）。 */
interface PickRuntimeStats {
  lastUsed: number
  successCount: number
}

const pickRuntime = new Map<string, PickRuntimeStats>()
const runtimeKey = (providerId: string, uid: string) => `${providerId}:${uid}`

/** 取（或以 seed 初始化）账号运行态。 */
function touchRuntimeStats(providerId: string, uid: string, seedSuccessCount = 0): PickRuntimeStats {
  const key = runtimeKey(providerId, uid)
  let rt = pickRuntime.get(key)
  if (!rt) {
    rt = { lastUsed: 0, successCount: seedSuccessCount }
    pickRuntime.set(key, rt)
  }
  return rt
}

/** 仅供测试：清空挑选运行态（lastUsed / 成功率统计内存缓存）。 */
export function __resetOauthPoolRuntimeForTests(): void {
  pickRuntime.clear()
}

/** 防惊群窗口：同一账号在该窗口内不重复被选中（对齐 workbuddy2api minPickGap = 100ms）。 */
const MIN_PICK_GAP_MS = 100

/** 闲置补偿默认参数（对齐 workbuddy2api defaultIdle*）。 */
const IDLE_WEIGHT_PER_HOUR = 0.5
const IDLE_WEIGHT_MAX = 5.0

/**
 * 余额耗尽类冷却原因（硬冷却）：兜底顶班永不选这类账号——调了必 402，
 * 等签到恢复即可（对齐 workbuddy2api CoolHard 排除语义）。
 * 需覆盖 cooldownOauthAccountUntilTomorrow4AM / 既有 'plan 权益不足' 等 reason 文案。
 */
const HARD_COOL_REASON_RE = /余额|1005|plan|credit|402|insufficient|quota/i

/**
 * 三因子权重（对齐 workbuddy2api weightOf）：
 *   weight = credits 比例 ×10 + 闲置补偿 + 成功率 ×3
 *   - credits 比例 = 该号 credits / 候选集内最大 credits（避免量纲爆炸）
 *   - 闲置补偿 = min(距 lastUsed 小时数 × 0.5, 5.0)；从未使用给满分
 *   - 成功率 = successCount/(successCount+errTotal)；无记录给 1.5（中性偏信任）
 * credits 全 0 时仍按闲置 + 成功率加权（不退化均匀随机）。
 */
function accountWeight(providerId: string, acc: OAuthPoolAccount, maxCredits: number, now: number): number {
  const st = acc.state
  let w = 1.0

  // 1. credits 比例 ×10
  if (maxCredits > 0) {
    w += ((st?.credits ?? 0) / maxCredits) * 10
  }

  // 2. 闲置补偿（lastUsed 为运行态内存值；0 = 从未使用 → 满分）
  const rt = pickRuntime.get(runtimeKey(providerId, acc.uid))
  const lastUsed = rt?.lastUsed ?? 0
  if (lastUsed <= 0) {
    w += IDLE_WEIGHT_MAX
  } else {
    const idleW = Math.min(((now - lastUsed) / 3_600_000) * IDLE_WEIGHT_PER_HOUR, IDLE_WEIGHT_MAX)
    w += Math.max(0, idleW)
  }

  // 3. 成功率 ×3（successCount 内存优先，回退 KV 快照；errTotal 以 KV 为准）
  const successCount = rt?.successCount ?? st?.successCount ?? 0
  const errTotal = st?.errTotal ?? 0
  const totalReq = successCount + errTotal
  if (totalReq > 0) {
    w += (successCount / totalReq) * 3
  } else {
    w += 1.5
  }
  return w
}

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

/** pickOauthAccount 可选项。 */
export interface PickOauthOptions {
  /** 注入随机源（返回 [0,1)），供测试确定性；缺省 Math.random。 */
  rng?: () => number
  /**
   * 全冷却兜底（对齐 workbuddy2api pickEarliestExpiryLocked）：无健康账号时，
   * 从冷却账号中选「最早到期」者顶班。禁用与余额耗尽（硬冷却）账号永不参与兜底；
   * 尊重 tried 集合（失败轮转时逐个换下一个最早到期的冷却号）。默认 false（返回 null）。
   */
  allowCoolingFallback?: boolean
}

/**
 * 挑号（三因子加权随机，对齐 workbuddy2api pool.go pick）：
 *   1. preferUid（面板手工指定）且 healthy 且未 tried → 直接采用（显式指定最优先）；
 *   2. healthy + 未 tried 候选按权重降序取 Top5，防惊群过滤后在 Top5 内加权随机；
 *      Top5 全部刚被用过 → LRU 兜底（维持发散且不饿死任一候选）；
 *   3. 无健康候选且 allowCoolingFallback → 冷却账号中选最早到期者顶班。
 * 被选中的账号会记录运行态 lastUsed（防惊群 + 闲置补偿），不写 KV。
 */
export async function pickOauthAccount(
  env: Env,
  providerId: string,
  tried: Set<string>,
  preferUid?: string,
  opts?: PickOauthOptions
): Promise<OAuthPoolAccount | null> {
  const pool = await readOauthPool(env, providerId)
  const now = Date.now()

  let chosen: OAuthPoolAccount | null = null

  // 手工指定优先：精确匹配首选 uid，只在 healthy 且未 tried 时采用
  if (preferUid) {
    const preferred = pool.find((a) => a.uid === preferUid && !tried.has(a.uid) && isOauthAccountHealthy(a, now))
    if (preferred) chosen = preferred
  }

  if (!chosen) {
    const candidates = pool.filter((a) => !tried.has(a.uid) && isOauthAccountHealthy(a, now))
    if (candidates.length > 0) {
      chosen = pickWeightedTop5(providerId, candidates, now, opts?.rng)
    } else if (opts?.allowCoolingFallback) {
      chosen = pickEarliestCoolingFallback(pool, tried, now)
    }
  }

  if (chosen) {
    touchRuntimeStats(providerId, chosen.uid).lastUsed = now
  }
  return chosen
}

/**
 * Top5 短名单 + 防惊群 + 加权随机（对齐 workbuddy2api pick/pickWeighted）。
 * 候选按三因子权重降序取前 5（credits 只是因子之一，闲置补偿与成功率同样决定谁进短名单）；
 * 跳过 100ms 内刚被选中的账号，迫使高并发请求发散而非全部撞同一高分账号；
 * Top5 全部刚被用时退回最近最少使用（LRU）账号。
 */
function pickWeightedTop5(
  providerId: string,
  candidates: OAuthPoolAccount[],
  now: number,
  rng?: () => number
): OAuthPoolAccount | null {
  let maxCredits = 0
  for (const a of candidates) {
    const c = a.state?.credits ?? 0
    if (c > maxCredits) maxCredits = c
  }
  // 权重预计算一次（O(n)），再按 (权重, uid) 降序排序，供 Top5 截断
  const scored = candidates
    .map((a) => ({ a, w: accountWeight(providerId, a, maxCredits, now) }))
    .sort((x, y) => (y.w !== x.w ? y.w - x.w : (x.a.uid < y.a.uid ? -1 : 1)))
  const top5 = scored.slice(0, 5)

  // 防惊群：跳过 100ms 内刚被选中的账号
  const eligible = top5.filter((s) => {
    const lastUsed = pickRuntime.get(runtimeKey(providerId, s.a.uid))?.lastUsed ?? 0
    return now - lastUsed >= MIN_PICK_GAP_MS
  })
  let shortlist: Array<{ a: OAuthPoolAccount; w: number }>
  if (eligible.length > 0) {
    shortlist = eligible
  } else {
    // Top5 全部刚被用过：LRU 兜底（最近最少使用者）
    let lru = top5[0]
    for (const s of top5) {
      const lu = pickRuntime.get(runtimeKey(providerId, s.a.uid))?.lastUsed ?? 0
      const lruLu = pickRuntime.get(runtimeKey(providerId, lru.a.uid))?.lastUsed ?? 0
      if (lu < lruLu) lru = s
    }
    shortlist = [lru]
  }

  // 加权随机抽签（短名单内按同一三因子权重）
  const rnd = rng ?? Math.random
  const total = shortlist.reduce((s, x) => s + x.w, 0)
  if (total <= 0) {
    const idx = Math.min(Math.max(Math.floor(rnd() * shortlist.length), 0), shortlist.length - 1)
    return shortlist[idx].a
  }
  let r = rnd() * total
  for (const s of shortlist) {
    r -= s.w
    if (r <= 0) return s.a
  }
  return shortlist[shortlist.length - 1].a
}

/**
 * 全冷却兜底：在冷却账号中选「until 最早到期」的一个（对齐 workbuddy2api pickEarliestExpiryLocked）。
 * 分级排除：禁用（enabled=false / state.disabled）永不参与；余额耗尽类硬冷却号（HARD_COOL_REASON_RE）
 * 不参与——调了必 402，等签到恢复；尊重 tried（轮转时换下一个最早到期者）。
 */
function pickEarliestCoolingFallback(pool: OAuthPool, tried: Set<string>, now: number): OAuthPoolAccount | null {
  let best: OAuthPoolAccount | null = null
  let bestUntil = 0
  for (const a of pool) {
    if (!a || tried.has(a.uid)) continue
    if (a.enabled === false) continue
    const st = a.state
    if (!st || st.disabled) continue
    const until = st.until || 0
    if (until <= now) continue
    if (HARD_COOL_REASON_RE.test(st.reason || '')) continue
    if (!best || until < bestUntil) {
      best = a
      bestUntil = until
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

/** 硬冷却（余额/权益耗尽）至次日 04:00 本地时区（对齐 workbuddy2api CooldownUntilTomorrow4AM，等签到恢复）。 */
export async function cooldownOauthAccountUntilTomorrow4AM(
  env: Env,
  providerId: string,
  uid: string,
  reason: string
): Promise<void> {
  await cooldownOauthAccount(env, providerId, uid, Math.max(60_000, nextDay4AMMs() - Date.now()), reason)
}

/** 永久禁用（session 失效，需重新登录）。 */
export async function disableOauthAccount(env: Env, providerId: string, uid: string, reason: string): Promise<void> {
  const pool = await readOauthPool(env, providerId)
  const acc = pool.find((a) => a.uid === uid)
  if (!acc) return
  acc.state = { ...(acc.state || {}), disabled: true, reason }
  await writeOauthPool(env, providerId, pool)
}

/**
 * 记录一次错误；达到阈值自动冷却 errMs。
 * errTotal（累计错误，供三因子成功率因子）随本次既有 KV 写顺带持久化；
 * errCount 语义不变（连续错误计数，成功清零）。
 */
export async function noteOauthError(env: Env, providerId: string, uid: string, cd: OAuthCooldownConfig): Promise<void> {
  const pool = await readOauthPool(env, providerId)
  const acc = pool.find((a) => a.uid === uid)
  if (!acc) return
  const st = acc.state || { credits: 0, disabled: false, until: 0, errCount: 0 }
  const errCount = (st.errCount || 0) + 1
  const errTotal = (st.errTotal || 0) + 1
  if (errCount >= cd.errThreshold) {
    acc.state = { ...st, errCount: 0, errTotal, lastErr: Date.now(), until: Date.now() + cd.errMs, reason: 'consecutive errors' }
  } else {
    acc.state = { ...st, errCount, errTotal, lastErr: Date.now() }
  }
  await writeOauthPool(env, providerId, pool)
}

/**
 * 成功请求记账：成功计数入内存运行态（成功率因子用），并按节流规则落盘 KV——
 *  - 错误→成功转变（errCount>0，既有行为：清零连续错误计数）
 *  - 每 SUCCESS_FLUSH_EVERY 次成功摊销一次 KV 写（避免每请求一次写超 KV 配额）
 * 运行态在隔离重启后从 KV 快照种子（touchRuntimeStats 的 seed），误差有限可接受。
 */
const SUCCESS_FLUSH_EVERY = 20

export async function noteOauthSuccess(env: Env, providerId: string, uid: string): Promise<void> {
  const pool = await readOauthPool(env, providerId)
  const acc = pool.find((a) => a.uid === uid)
  if (!acc) return
  const st = acc.state || { credits: 0, disabled: false, until: 0, errCount: 0 }
  const rt = touchRuntimeStats(providerId, uid, st.successCount || 0)
  rt.successCount++
  if ((st.errCount || 0) > 0 || rt.successCount % SUCCESS_FLUSH_EVERY === 0) {
    acc.state = { ...st, errCount: 0, successCount: rt.successCount, lastSuccess: Date.now() }
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
    // 三因子加权观测字段（纯增量）：累计成功/错误 + 最近被选中时刻（运行态内存值，重启归零）
    successCount: pickRuntime.get(runtimeKey(providerId, a.uid))?.successCount ?? a.state?.successCount ?? 0,
    errTotal: a.state?.errTotal || 0,
    lastUsed: pickRuntime.get(runtimeKey(providerId, a.uid))?.lastUsed ?? 0,
  }))
}
