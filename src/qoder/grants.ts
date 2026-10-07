/**
 * grants.ts — Qoder「签到/赠送额度」的**按笔记账**（纯计算：不碰 KV、不碰网络）。
 *
 * 为什么需要它：上游 `/api/v2/quota/usage` 只给一个聚合的 `addOnQuota`（total/used/remaining），
 * **不返回任何按笔明细**，也不给这个桶的到期时间。WorkBuddy 之所以能按包显示，是因为它的
 * `get-user-resource` 返回 `Accounts[]`，每个包自带 `ExpiredTime`（workbuddy-billing.ts）；
 * Qoder 没有这种数据，只能自己攒。
 *
 * 而每一笔签到**确实各有各的到期时间**：claim 响应的 `expiresAt` 就是这一笔的有效期
 * （见 billing.ts performQoderCheckin 的 rewardExpiresAt）。
 *
 * 2026-10-07 用户报的现象正是把聚合桶当成一个包、并挑「最新一笔」的到期盖上去的结果：
 * 面板把整桶 600 分标成「2026-11-06 到期 · 剩 30 天」——那是**最后一笔**的到期时间
 * （于是每签到一天就往后推一天，看起来"到期时间一直在变"），而真实情况是 6 笔
 * （10-02 ~ 10-07 各 100）分别到期于 11-01 ~ 11-06。
 *
 * 后果不止是显示不准：「7 天内到期优先消耗」的挑号读的就是这个日期
 * （pool.ts soonestQoderExpiryAt）。它永远停在 30 天后 → 该账号永远进不了 7 天窗口
 * → 最早那笔分作废了也不会被优先消耗。WorkBuddy / TRAE 没有这个问题，因为它们的数据
 * 本身就是按包给的。
 *
 * 记账口径（三条，缺一条就会退化成"编数据"或"无限长条目"）：
 *   1. 每次**新领**（claim 返回非 replayed）追加一笔，到期时间取 claim 响应的 expiresAt；
 *      拿不到到期时间就记为未知（不编造）；
 *   2. 用上游 `addOnQuota.remaining`（= 加购桶当前剩余）做 **FIFO 结算**：上游说少了，
 *      就把「最早到期的那些笔」标记为已消耗——积分按最早到期先扣减，这也是挑号规则本身
 *      的假设（到期优先消耗）；上游说多了，见第 3 条；
 *   3. 上游说多了（记账前的历史余额、或非签到发放的赠送分）→ 记进**同一笔**「未记账余额」，
 *      不新增条目（否则每次探测都长一条）。它的到期时间只能沿用历史观测值或标未知。
 *
 * 为什么不给未记账余额编一个到期日期：那个日期我们**没有观测到**。编出来就是用假数据驱动
 * 「到期优先」挑号，会把本来不急的账号排到最前面去消耗——比"标未知、不参与优先"更糟。
 */
/** 账本里的一笔：一次领取发出的积分 + 它自己的到期时间。 */export interface QoderAddonGrant {
  /** 领取时刻（epoch ms）。**0 = 记账前就存在的余额**（未观测到领取时刻，见文件头第 3 条） */
  at: number
  /** 这一笔发出的积分（> 0） */
  size: number
  /** 已从这一笔消耗掉的积分（FIFO 结算写入） */
  used: number
  /** 到期时刻（epoch ms）。**0 = 未知**（面板显示「到期未知」，不参与「7 天内到期优先」） */
  expireAt: number
}

/**
 * 是否属于「未记账余额」那一笔。
 *
 * 判据只有 `at === 0` 一个：真实领取一定有领取时刻（调用方拿不到时用 `now` 兜底），
 * 只有我们自己造的历史余额条目才没有。独此一处定义，避免各调用点各判一套。
 */
export function isQoderUnbookedGrant(g: QoderAddonGrant): boolean {
  return !(g.at > 0)
}

/**
 * 账本条数安全阀。
 *
 * 正常账户永远碰不到：每笔有效期 30 天，所以「未用完且未过期」的笔数天然被限制在
 * 30 笔上下（每天 1 笔）——40 已经留足余量，这里取 90 是给「一天多个活动发放」
 * 留的余量，同时让 KV 值保持在几 KB 量级。
 */
export const QODER_GRANT_MAX = 90

/**
 * 上游 addOnQuota 的**已归一化**分项（字段名与 billing.QoderQuotaSplit 一致：
 * fetchQoderUserResource 已经把上游的 `{total, used, remaining}` 归一成 `{size, used, remain}`）。
 * 只有 `remain` 参与结算，`size`/`used` 留档备查。
 */
export interface QoderAddonObserved {
  size?: number
  used?: number
  remain?: number
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : (Number(v) || 0)
}

/** 有限数才认；否则 null（用于「上游没给/给坏了」与「上游给了 0」的区分）。 */
function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 账本剩余合计（= 未用完的笔的 size - used 之和）。 */
export function sumQoderGrantOutstanding(grants: readonly QoderAddonGrant[] | null | undefined): number {
  if (!Array.isArray(grants)) return 0
  let sum = 0
  for (const g of grants) {
    if (!g) continue
    const free = num(g.size) - num(g.used)
    if (free > 0) sum += free
  }
  return sum
}

/**
 * 消耗顺序：**最早到期的先扣**（到期优先消耗），到期未知的排最后。
 *
 * 到期未知不排前面：排前面等于断言"它最紧急"，而那是我们不知道的事；
 * 排序只影响 FIFO 扣减落在哪一笔上，不影响「哪些笔还有剩余」这个总量。
 */
function byConsumeOrder(a: QoderAddonGrant, b: QoderAddonGrant): number {
  const ka = a.expireAt > 0 ? a.expireAt : Number.MAX_SAFE_INTEGER
  const kb = b.expireAt > 0 ? b.expireAt : Number.MAX_SAFE_INTEGER
  if (ka !== kb) return ka - kb
  return a.at - b.at
}

/** 丢掉「已用完」与「非法」条目（未用完但已过期的保留：它记录着"多少分在何时作废"这个事实）。 */
function pruneQoderAddonGrants(list: readonly QoderAddonGrant[], now: number): QoderAddonGrant[] {
  let kept = list.filter((g) => g.size > 0 && g.used < g.size)
  if (kept.length > QODER_GRANT_MAX) {
    // 安全阀：先丢「已到期且未用完」的（积分已作废，留着不提供可操作信息）。
    // 走到这里说明单日发放笔数远超预期；丢掉的是**明细**不是金额——下一次结算会把这部分
    // 金额并进「未记账余额」那一笔，所以不会凭空多出或少掉额度。
    const drop = new Set<QoderAddonGrant>()
    for (const g of [...kept].sort(byConsumeOrder)) {
      if (kept.length - drop.size <= QODER_GRANT_MAX) break
      if (g.expireAt > 0 && g.expireAt <= now) drop.add(g)
    }
    if (drop.size) kept = kept.filter((g) => !drop.has(g))
  }
  return kept
}

/**
 * 结算账本：`prevGrants` + 本次新领的一笔 − 上游观测到的剩余量 → 新的账本。
 *
 * 纯函数：同样的输入永远得到同样的输出，且不依赖 KV/时间以外的任何状态
 * （`now` 可注入，测试因此不需要假时钟）。
 *
 * @param prevGrants 池里已存的账本。`undefined`/`null` = **没有账本**（首次迁移，见下）；
 *                   `[]` = 有账本但已清空（此时上游若报出余额，那确实是记账后的新增，标未知）。
 * @param addon 上游 addOnQuota（**归一化后的 `{size, used, remain}`**，即 billing.QoderQuotaSplit）。
 *              **本次没探到就别传**：账本原样保留，不让一次失败的探测把已观测到的到期明细擦掉。
 * @param claim 本次新领的一笔（claim 响应）。`size <= 0` 或缺失 → 不追加
 *              （金额都拿不到就没法记账，额度差会由第 3 条兜成"未记账余额"）。
 * @param legacyExpireAt 旧聚合包（`签到/赠送额度`）里记录的历史到期时间，**只在没有账本时**
 *                       用来给历史余额一个观测过的上界；没有 → 0 → 标「到期未知」。
 */
export function reconcileQoderAddonGrants(input: {
  prevGrants?: readonly QoderAddonGrant[] | null
  addon?: QoderAddonObserved | null
  claim?: { at?: number; size?: number; expireAt?: number } | null
  legacyExpireAt?: number
  now?: number
}): QoderAddonGrant[] {
  const now = typeof input.now === 'number' && Number.isFinite(input.now) ? input.now : Date.now()
  const hasLedger = Array.isArray(input.prevGrants)

  const out: QoderAddonGrant[] = []
  for (const g of input.prevGrants || []) {
    if (!g) continue
    const size = num(g.size)
    if (size <= 0) continue
    out.push({
      at: Math.max(0, num(g.at)),
      size,
      used: Math.min(Math.max(0, num(g.used)), size),
      expireAt: Math.max(0, num(g.expireAt)),
    })
  }

  // 上游这次报出的加购桶剩余量。**必须区分「没给」与「给了 0」**：当成 0 会把整个账本当
  // "全部用完"清空，而上游字段缺失/结构变化恰恰是最容易发生的一次探测——那一下就抹掉所有到期明细。
  const observedRemain = input.addon ? finiteOrNull(input.addon.remain) : null
  const cSize = num(input.claim?.size)
  const cExpireAt = Math.max(0, num(input.claim?.expireAt))

  // 1) 首次迁移：没有账本 → 把**本次领取之前**就存在的加购余额记成一笔「未记账余额」。
  //    减去本次领取的金额是必须的：这一笔已经单独入账了，不减就会凭空多出一份额度，
  //    随后 FIFO 结算会去扣那笔真实的新领（因为未记账余额的到期时间未知、排在最后），
  //    结果就是"刚签到的那笔不见了、剩下一笔来路不明的余额"。
  //    迁移前后面板上的额度总量不变，只是从「一个聚合包」变成「一笔历史余额 + 之后每笔签到」，
  //    并且它会随着消耗/作废自然排空（≤ 一个有效期就彻底消失）。
  if (!hasLedger && observedRemain !== null) {
    const remain = Math.max(0, observedRemain - (cSize > 0 ? cSize : 0))
    if (remain > 0) out.push({ at: 0, size: remain, used: 0, expireAt: Math.max(0, num(input.legacyExpireAt)) })
  }

  // 2) 本次新领：按笔追加。
  //    同一笔被重复上报（签到重试 / 部分失败后整轮重跑）会得到**相同的 expireAt**，视为已记账。
  if (input.claim && cSize > 0) {
    const dup = cExpireAt > 0 && out.some((g) => g.expireAt === cExpireAt && g.size === cSize)
    if (!dup) out.push({ at: num(input.claim.at) || now, size: cSize, used: 0, expireAt: cExpireAt })
  }

  // 3) FIFO 结算（只有上游确实给出了有限剩余量时才做；缺失/非法 → 账本原样保留）
  if (observedRemain !== null) {
    const delta = Math.max(0, observedRemain) - sumQoderGrantOutstanding(out)
    if (delta < 0) {
      // 上游说少了：按最早到期先扣减
      let over = -delta
      for (const g of [...out].sort(byConsumeOrder)) {
        const free = g.size - g.used
        if (free <= 0) continue
        const take = Math.min(free, over)
        g.used += take
        over -= take
        if (over <= 0) break
      }
    } else if (delta > 0) {
      // 上游说多了：并进「未记账余额」这一笔（没有就新建），不新增条目避免每次探测都长一条
      const unbooked = out.find(isQoderUnbookedGrant)
      if (unbooked) unbooked.size += delta
      else out.push({ at: 0, size: delta, used: 0, expireAt: 0 })
    }
  }

  return pruneQoderAddonGrants(out, now)
}
