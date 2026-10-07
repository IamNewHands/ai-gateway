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
import type { Env, OAuthDeviceConfig, OAuthTokenState, PackageInfo, Provider } from '../types'
import { KV_KEYS, OAUTH_TOKEN_REFRESH_MARGIN_MS } from '../config'
import { readOauthToken } from '../oauth'
import { CREDIT_EXPIRY_WINDOW_MS, soonestPackageExpiryAt } from '../credit-expiry'
import type { QoderAddonGrant } from './grants'

/** 池内账号状态（冷却/禁用/积分/额度包）。 */
export interface QoderPoolState {
  credits: number
  disabled: boolean
  reason?: string
  /** 冷却至 epoch ms；0 = 无冷却 */
  until: number
  errCount: number
  /**
   * 额度包明细（到期 + 已用/总额度），签到/刷新额度时落盘。
   * 「7 天内到期优先消耗」挑号与面板「⏳ N 个包 7 天内到期」徽章的唯一数据源。
   */
  packages?: PackageInfo[]
  /** packages 的探测时刻（面板据此说明数据新鲜度） */
  packagesAt?: number
  /**
   * 加购（签到/赠送）额度的**按笔记账**：上游只给聚合桶，逐笔明细与各自到期时间在这里攒
   * （见 qoder/grants.ts 文件头）。它同时是 packages 里签到包的来源，也是「7 天内到期优先」
   * 挑号能看见"最早那笔何时作废"的前提。
   *
   * 与 packages 的关系：packages = 套餐额度 + 账本里每一笔（billing.buildQoderPacks）。
   * 缺省 = 该账号还没有账本（首次探测时由 reconcileQoderAddonGrants 迁移建账）。
   */
  addonGrants?: QoderAddonGrant[]
}

/** 池内账号（凭证 + 状态），存于 KV qoder:pool:<providerId> */
export interface QoderPoolAccount {
  uid: string
  nickname?: string
  token: OAuthTokenState
  enabled: boolean
  state: QoderPoolState
  updatedAt: number
  /** 账号所属域：cn（默认）/ global，决定推理(payload)与模型端点（gateway.qoder.com.cn vs api3.qoder.sh） */
  realm?: 'cn' | 'global'
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
    nickname: isRealQoderNickname(single.nickname, uid) ? String(single.nickname).trim() : undefined,
    token: single,
    enabled: true,
    state: { credits: 0, disabled: false, until: 0, errCount: 0 },
    updatedAt: Date.now(),
    realm: single.realm === 'global' ? 'global' : 'cn',
  }])
  return true
}

/**
 * 账号「7 天内到期且仍有剩余」的最早到期时刻（epoch ms）；没有 → null。
 * 数据来自 state.packages（签到/刷新额度时才探测，请求热路径不写），未探测过 → null。
 * 判定本体在 credit-expiry.ts（workbuddy / trae / qoder 三池共用同一份口径）。
 */
export function soonestQoderExpiryAt(
  state: QoderPoolState | undefined,
  now: number,
  windowMs: number = CREDIT_EXPIRY_WINDOW_MS
): number | null {
  return soonestPackageExpiryAt(state?.packages, now, windowMs)
}

/**
 * 挑号用的「首选账号」：客户端请求头优先，其次面板指定。
 *
 * 两者都是用户的明确意图，但请求头是**本次请求**级的、更具体，所以压过 provider 级设置
 * （与 WorkBuddy 池 `stickyUid || provider.preferOauthUid` 同序，两池不各立一套语义）。
 * 空白请求头视为未指定（常见于客户端把变量留空的场景），此时回落到面板指定。
 *
 * 为什么要单独一个函数：这段优先级有两个调用点（OpenAI / Anthropic 两条转发路径），
 * 各写一遍 `header || provider.preferOauthUid` 迟早会漂移成两套行为。
 */
export function resolveQoderPreferUid(headerValue: string | null | undefined, provider: Provider): string | undefined {
  const fromHeader = String(headerValue ?? '').trim()
  if (fromHeader) return fromHeader
  const pinned = String(provider?.preferOauthUid ?? '').trim()
  return pinned || undefined
}

/**
 * 挑号（两段式，与 trae / workbuddy 池同口径）：
 *  - 指定 preferUid（客户端 X-Qoder-Account 或面板首选账号）且健康 → 直接用它；
 *  - 第二段：**7 天内到期且有剩余**的账号里，到期最早者优先（同到期比积分高低）。
 *    为什么必须这样：积分带到期时间，高分号若一直占坑，低分号整包额度会直接作废；
 *  - 第三段（兜底）：窗口内没有待救积分 → 原策略「剩余积分最多者优先」。
 *
 * 注：积分最低但马上要过期的号会赢过积分最高的长期号——这正是本段的目的。
 */
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
  // 第二段：7 天内到期的积分优先（到期越早越优先，同到期比积分高低）
  let best: QoderPoolAccount | null = null
  let bestExpiry: number | null = null
  let bestExpiryCredits = -Infinity
  for (const a of pool) {
    if (tried.has(a.uid)) continue
    if (!isQoderAccountHealthy(a, now)) continue
    const exp = soonestQoderExpiryAt(a.state, now)
    if (exp === null) continue
    const credits = a.state?.credits ?? 0
    if (bestExpiry === null || exp < bestExpiry || (exp === bestExpiry && credits > bestExpiryCredits)) {
      best = a
      bestExpiry = exp
      bestExpiryCredits = credits
    }
  }
  if (best) return best
  // 第三段：窗口内没有待救积分 → 剩余积分最多者优先（原自动策略）
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

/**
 * 回写额度 + 额度包明细的内部实现。
 *
 * `unfreeze` 决定是否顺带清冷却/禁用，两个调用方语义不同，必须分开：
 *   - 签到成功（true）：签到通过上游鉴权 = token 有效的直接证据，冷却与「需重新登录」都不再成立；
 *   - 面板「刷新账号池」的额度探测（false）：**只读一次额度不该解冻账号**——把 429 冷却中的
 *     账号放出来等于绕过限流保护，禁用标记同理（留给签到或人工处理）。
 */
async function writeQoderQuota(
  env: Env,
  providerId: string,
  uid: string,
  credits: number,
  packages: PackageInfo[] | undefined,
  grants: QoderAddonGrant[] | undefined,
  unfreeze: boolean
): Promise<void> {
  const pool = await readQoderPool(env, providerId)
  const acc = pool.find((a) => a.uid === uid)
  if (!acc) return
  const st = acc.state || { credits: 0, disabled: false, until: 0, errCount: 0 }
  acc.state = { ...st, credits }
  // 额度包明细与 credits 同一次 KV 写落盘（它是「到期优先」挑号的数据源，分开写会读到半旧状态）
  if (Array.isArray(packages)) {
    acc.state = { ...acc.state, packages, packagesAt: Date.now() }
  }
  // 账本与 packages 同一次写：packages 就是账本渲染出来的，两者分开写会出现
  // 「面板显示 6 笔、挑号只看得见 2 笔」这种自相矛盾（下一次结算又会以账本为准覆盖 packages）
  if (Array.isArray(grants)) {
    acc.state = { ...acc.state, addonGrants: grants }
  }
  if (unfreeze && credits > 0) {
    acc.state = { ...acc.state, until: 0, disabled: false, reason: '', errCount: 0 }
  }
  await writeQoderPool(env, providerId, pool)
}

/**
 * 只回写额度、额度包明细与加购账本，**不动冷却/禁用**（面板「刷新账号池」的额度探测用）。
 * 见 writeQoderQuota 的 unfreeze 说明。
 */
export async function setQoderPoolQuota(
  env: Env,
  providerId: string,
  uid: string,
  credits: number,
  packages?: PackageInfo[],
  grants?: QoderAddonGrant[]
): Promise<void> {
  await writeQoderQuota(env, providerId, uid, credits, packages, grants, false)
}

/**
 * 签到后解冻：remain > 0 时把冷却**与 `disabled` 一起**清掉。
 *
 * 为什么成功签到要连 `disabled` 一起清：`disabled` 的语义是「token 已失效，需重新登录」，
 * 而签到成功本身就是「这个 token 现在能通过上游鉴权」的直接反证——留着它自相矛盾。
 * 旧实现只清冷却、保留 `disabled`，于是历史误判（如 c7b79c8 之前 10605 排队被当成鉴权故障）
 * 会把好账号**永久钉死**：签到照常成功、积分照常恢复，但转发永远跳过它，
 * 面板显示成「积分=400 已禁用（鉴权失败：…）」，而那段 reason 原文只有旧代码写得出来
 * （新文案是「鉴权失败（会话已失效，需重新登录）：…」，见 proxy.ts markQoderAccountClassified）。
 *
 * remain <= 0 时保持原样：没有积分就解冻只会让它立刻被挑中再撞额度耗尽，反而多一次无效上游请求。
 */
export async function reenableQoderIfCredits(
  env: Env,
  providerId: string,
  uid: string,
  remain: number,
  packages?: PackageInfo[],
  grants?: QoderAddonGrant[]
): Promise<void> {
  await writeQoderQuota(env, providerId, uid, remain, packages, grants, true)
}

/**
 * 昵称是否可用作展示名（而不是 uid 的复读）。
 *
 * 背景：旧签到路径把 `account.nickname || account.uid` 当昵称回写进池，于是 uid 被当成昵称
 * 永久存了下来；面板的渲染分支 `a.nickname ? 昵称 : 'uid=' + uid` 因此永远走「有昵称」那支，
 * 显示成一长串 36 位 UUID（2026-10-07 用户报的正是这个）。
 * 统一的判定放在这里，避免挑号/面板/转发各写一份 `nickname !== uid` 而漂移。
 */
export function isRealQoderNickname(nickname: unknown, uid: string): boolean {
  const v = typeof nickname === 'string' ? nickname.trim() : ''
  return v !== '' && v !== uid
}

/**
 * 签到时回写昵称（池账号登录时可能未带 nickname，签到后补齐供面板展示）。
 *
 * 空值与「等值于 uid」都拒绝写入：写进去只会让面板永远显示 UUID，比留空更差
 * （留空时面板至少会走 `uid=` 前缀分支，语义明确）。
 */
export async function setQoderPoolAccountNickname(env: Env, providerId: string, uid: string, nickname: string): Promise<void> {
  const name = typeof nickname === 'string' ? nickname.trim() : ''
  if (!isRealQoderNickname(name, uid)) return
  const pool = await readQoderPool(env, providerId)
  const acc = pool.find((a) => a.uid === uid)
  if (!acc || acc.nickname === name) return
  acc.nickname = name
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
    // 历史脏数据（nickname === uid）按「无昵称」透出，让面板显示 `uid=xxx` 而不是把 UUID 当名字
    nickname: isRealQoderNickname(a.nickname, a.uid) ? String(a.nickname).trim() : '',
    credits: a.state?.credits ?? 0,
    // 额度包明细 + 探测时刻：「7 天内到期优先」挑号的可见依据（面板据此解释"为何选这个号"）
    packages: a.state?.packages,
    packagesAt: a.state?.packagesAt,
    enabled: a.enabled !== false,
    disabled: a.state?.disabled === true,
    cooling: a.state?.until ? a.state.until > now : false,
    until: a.state?.until || 0,
    reason: a.state?.reason || '',
    errCount: a.state?.errCount || 0,
    tokenExpiresAt: a.token?.expires_at || 0,
    updatedAt: a.updatedAt || 0,
    tokenMask: a.token?.access_token ? `${a.token.access_token.slice(0, 8)}••••${a.token.access_token.slice(-6)}` : '',
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
