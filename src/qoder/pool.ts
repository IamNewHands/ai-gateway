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
import { qoderExclusiveRealm, type QoderMetaRealm } from './model-meta'
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
  /**
   * **模型级**冷却：上游 key → 冷却至 epoch ms。
   *
   * 为什么必须与账号级 `until` 分开（hub `model_cooldowns`，qoder_accounts.py:483/597/615）：
   * 上游的 429 常是**单个模型**的频控，不是账号不可用。旧实现一律写账号级 `until`，于是
   * 「在 qmodel 上撞限流」会把该账号在 dmodel/gm51model 上也一起冻结——白白少用一个健康账号，
   * 并把「模型级限流」误报成「账号坏了」。
   *
   * hub 的写法（`note_error(model=…)`）：**model 非空时只写模型级冷却并 return**，
   * 不动账号级 `cooldown_until`；`ready(model)` 两者都查；`throttle_wait(model)` 取两者最大值。
   * 这里同口径。
   */
  modelCooldowns?: Record<string, number>
  /**
   * 券类活动已领到的**兑换码**：campaignId → code（hub `campaignCodes`，
   * qoder_accounts.py:489/529/1074）。
   *
   * 为什么必须持久化：`redemptionCode` **只回一次**，错过永久丢失——这是本模块唯一涉及
   * 不可恢复用户资产的字段。服务端只在 claim 响应里给码，之后再查活动列表也拿不回来。
   * 落在这里（与 addonGrants 同级）而不是签到结果 KV：签到结果的 TTL 只有 2 天
   * （config.CHECKIN_RESULT_TTL_SEC），码会跟着过期消失。
   */
  campaignCodes?: Record<string, string>
  /**
   * 券类活动的**同人去重冷却**：campaignId → 冷却至 epoch ms（hub `campaignBlockedUntil`，
   * qoder_accounts.py:492/1173，固定 6 小时）。
   *
   * 服务端按「人」去重（SAME_PERSON_ALREADY_CLAIMED）：同一设备/身份下其他账号本轮已领时，
   * 本账号再 POST 也只会被同样拒绝。不记冷却就会每轮重复 POST 同一活动，白白消耗请求。
   */
  campaignBlockedUntil?: Record<string, number>
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

/**
 * 账号是否健康：启用、未禁用、不在冷却期。无状态（新账号）视为健康。
 *
 * `model` 非空时**叠加**模型级冷却检查（hub `ready(model)` 同口径，qoder_accounts.py:592-598）：
 * 账号级冷却与模型级冷却都要过。缺省不传 = 只看账号级（既有调用方行为不变）。
 */
export function isQoderAccountHealthy(acc: QoderPoolAccount, now: number, model?: string): boolean {
  if (!acc || acc.enabled === false) return false
  if (acc.state?.disabled) return false
  if (acc.state?.until && acc.state.until > now) return false
  if (model) {
    const until = acc.state?.modelCooldowns?.[model] || 0
    if (until > now) return false
  }
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
 * 该账号的域（缺省 cn）。
 *
 * 为什么单独一个函数：`acc.realm === 'global' ? 'global' : 'cn'` 这个三元式在
 * proxy.ts 里已散落 4 处（renderBody 调用点、sendQoderChatOnce 参数、debug 等），
 * 再加一处区域过滤就会漂移出两套口径。
 */
export function qoderAccountRealm(acc: QoderPoolAccount | undefined | null): QoderMetaRealm {
  return acc?.realm === 'global' ? 'global' : 'cn'
}

/**
 * 该账号能否服务**要求某区域**的模型；`requiredRealm` 为空 → true。
 *
 * 只解决「模型只在另一区提供」这一种错配：`gm51model` 落到国际号**必然 403**。
 * 不解决「同区但该账号套餐不含此模型」——那要问上游，不是静态表能答的。
 *
 * 为什么收「区域」而不是「模型名」：独占判定的输入必须同时含**上游 key 与原始客户端名**
 * （`glm-5.2` → `gm51model` 的别名解析在 body.ts），而 pool 不能依赖 body（会成环）。
 * 故由调用方（proxy.ts，两处名字都在手）用 `qoderExclusiveRealm` 算出区域后传进来，
 * 本模块只做过滤——模型→区域的**唯一数据源**仍是 model-meta。
 */
export function qoderAccountServesModel(
  acc: QoderPoolAccount | undefined | null,
  requiredRealm?: QoderMetaRealm | ''
): boolean {
  if (!requiredRealm) return true
  return requiredRealm === qoderAccountRealm(acc)
}

/**
 * 池内是否有账号能服务要求该区域的模型。
 *
 * 调用方据此把「区域错配」与「全部冷却/禁用」分成两种可读结局：前者是**模型选错**，
 * 换账号或等待都没用；后者等待即可。混成一句 503「所有账号均不可用」会让用户
 * 在错误的模型上反复重试（对照 2026-10-09 三个同类缺陷：可区分状态被塌缩成一句话）。
 */
export function qoderPoolServesModel(pool: QoderPool, requiredRealm?: QoderMetaRealm | ''): boolean {
  if (!requiredRealm) return true
  return pool.some((a) => a.enabled !== false && qoderAccountRealm(a) === requiredRealm)
}

/**
 * 挑号（两段式，与 trae / workbuddy 池同口径）：
 *  - 指定 preferUid（客户端 X-Qoder-Account 或面板首选账号）且健康 → 直接用它；
 *  - 第二段：**7 天内到期且有剩余**的账号里，到期最早者优先（同到期比积分高低）。
 *    为什么必须这样：积分带到期时间，高分号若一直占坑，低分号整包额度会直接作废；
 *  - 第三段（兜底）：窗口内没有待救积分 → 原策略「剩余积分最多者优先」。
 *
 * 注：积分最低但马上要过期的号会赢过积分最高的长期号——这正是本段的目的。
 *
 * `model` 非空时把**模型级**冷却纳入健康判定（hub `ready(model)`）：某模型被频控的账号
 * 只是在该模型上不可用，仍可服务其它模型。缺省不传 = 只看账号级冷却，既有调用方行为不变。
 *
 * 同时按 `requiredRealm` 做**区域**过滤（见 `qoderAccountServesModel`）：区域错配的账号被跳过，
 * 而不是选中后拿一个必然的 403（那还会白冻该账号 60 秒，见 proxy.ts markQoderAccountClassified）。
 * 全池都错配时返回 null —— 调用方用 `qoderPoolServesModel` 区分「错配」与「全冷却」。
 */
export async function pickQoderAccount(
  env: Env,
  providerId: string,
  tried: Set<string>,
  preferUid?: string,
  model?: string,
  requiredRealm?: QoderMetaRealm | ''
): Promise<QoderPoolAccount | null> {
  const pool = await readQoderPool(env, providerId)
  const now = Date.now()
  // 区域错配的账号一律不选（含用户固定账号：固定的是「账号」，而该模型根本不在这个区）
  const usable = (a: QoderPoolAccount) =>
    isQoderAccountHealthy(a, now, model) && qoderAccountServesModel(a, requiredRealm)
  // 账号固定：客户端 X-Qoder-Account 指定的账号（uid）若健康则强制使用
  if (preferUid) {
    const pinned = pool.find((a) => a.uid === preferUid)
    if (pinned && !tried.has(pinned.uid) && usable(pinned)) return pinned
  }
  // 第二段：7 天内到期的积分优先（到期越早越优先，同到期比积分高低）
  let best: QoderPoolAccount | null = null
  let bestExpiry: number | null = null
  let bestExpiryCredits = -Infinity
  for (const a of pool) {
    if (tried.has(a.uid)) continue
    if (!usable(a)) continue
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
    if (!usable(a)) continue
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

/**
 * **模型级**冷却该账号至 now+ms（hub `note_error(model=…)`，qoder_accounts.py:610-616）。
 *
 * 与 `cooldownQoderAccount` 的关键差异：**不动账号级 `until`，也不清 `errCount`**。
 * 上游的 429 常是单个模型的频控——账号本身健康，其它模型照常可用；写成账号级冷却会让
 * 一次 qmodel 限流冻结整账号在 dmodel/gm51model 上的可用性。
 *
 * `reason` 仍会写：面板要能说明「为什么这个号这次没被选中」。
 */
export async function cooldownQoderAccountModel(
  env: Env,
  providerId: string,
  uid: string,
  model: string,
  ms: number,
  reason: string
): Promise<void> {
  if (!model) return
  const pool = await readQoderPool(env, providerId)
  const acc = pool.find((a) => a.uid === uid)
  if (!acc) return
  const st = acc.state || { credits: 0, disabled: false, until: 0, errCount: 0 }
  const modelCooldowns = { ...(st.modelCooldowns || {}), [model]: Date.now() + ms }
  acc.state = { ...st, modelCooldowns, reason }
  await writeQoderPool(env, providerId, pool)
}

/**
 * 清掉该账号在指定模型上的冷却（hub `clear_error(model=)`，qoder_accounts.py:630-633）。
 * 不传 model 时清空全部模型级冷却。账号级冷却/禁用不在此函数职责内。
 */
export async function clearQoderModelCooldown(
  env: Env,
  providerId: string,
  uid: string,
  model?: string
): Promise<void> {
  const pool = await readQoderPool(env, providerId)
  const acc = pool.find((a) => a.uid === uid)
  if (!acc) return
  const st = acc.state
  if (!st?.modelCooldowns) return
  let next: Record<string, number>
  if (model) {
    if (!(model in st.modelCooldowns)) return
    next = { ...st.modelCooldowns }
    delete next[model]
  } else {
    next = {}
  }
  acc.state = { ...st, modelCooldowns: next }
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
 * 记录券类活动领到的兑换码（hub `campaign_codes[campaign_id] = code` + save，
 * qoder_accounts.py:1072-1076）。
 *
 * **只在拿到非空码时写**：码是幂等的事实（同一活动重复领取返回同一个码），
 * 用空值覆盖会把已观测到的码擦掉——而那是**不可恢复**的资产。
 */
export async function setQoderCampaignCode(
  env: Env,
  providerId: string,
  uid: string,
  campaignId: string,
  code: string
): Promise<void> {
  const cid = String(campaignId || '').trim()
  const c = String(code || '').trim()
  if (!cid || !c) return
  const pool = await readQoderPool(env, providerId)
  const acc = pool.find((a) => a.uid === uid)
  if (!acc) return
  const st = acc.state || { credits: 0, disabled: false, until: 0, errCount: 0 }
  if (st.campaignCodes?.[cid] === c) return
  acc.state = { ...st, campaignCodes: { ...(st.campaignCodes || {}), [cid]: c } }
  await writeQoderPool(env, providerId, pool)
}

/**
 * 记一次券类活动的**同人去重冷却**（hub `campaign_blocked_until[cid] = time.time() + 6*3600`，
 * qoder_accounts.py:1173）。
 *
 * 6 小时是源定值：每日活动按 CST 10:00 换轮，6h 足以跨过「同设备多号轮流试」的窗口，
 * 又不至于把下一轮也挡掉。
 */
export const QODER_CAMPAIGN_BLOCK_MS = 6 * 60 * 60 * 1000

export async function blockQoderCampaign(
  env: Env,
  providerId: string,
  uid: string,
  campaignId: string,
  ms: number = QODER_CAMPAIGN_BLOCK_MS
): Promise<void> {
  const cid = String(campaignId || '').trim()
  if (!cid) return
  const pool = await readQoderPool(env, providerId)
  const acc = pool.find((a) => a.uid === uid)
  if (!acc) return
  const st = acc.state || { credits: 0, disabled: false, until: 0, errCount: 0 }
  acc.state = { ...st, campaignBlockedUntil: { ...(st.campaignBlockedUntil || {}), [cid]: Date.now() + ms } }
  await writeQoderPool(env, providerId, pool)
}

/** 该活动当前是否处于同人去重冷却中（hub `campaign_blocked_until.get(cid,0) > now`）。 */
export function isQoderCampaignBlocked(state: QoderPoolState | undefined, campaignId: string, now: number): boolean {
  const until = state?.campaignBlockedUntil?.[campaignId] || 0
  return until > now
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
    /**
     * 仍在冷却中的**模型级**频控（模型 → 剩余秒数）。
     *
     * 为什么要透出：账号级 `cooling` 为 false 时，面板看起来「这个号完全可用」，
     * 但它可能在某个模型上被上游频控——不显示就只能靠猜为什么某模型请求被跳过。
     * 已过期的条目不列出（面板只关心当下挡着什么）。
     */
    modelCooldowns: Object.fromEntries(
      Object.entries(a.state?.modelCooldowns || {})
        .filter(([, until]) => until > now)
        .map(([m, until]) => [m, Math.max(1, Math.round((until - now) / 1000))])
    ),
    /** 已领到的兑换码（campaignId → code）：不可恢复资产，面板要能展示与复制。 */
    campaignCodes: a.state?.campaignCodes || {},
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
