/**
 * probe.ts — 面板「刷新账号池」的额度探测（Qoder）。
 *
 * 为什么需要它：Qoder 的额度**只有签到会拉**（cron 每天两次），所以面板上的「额度包明细 /
 * 到期天数」最多滞后一天，也就意味着「7 天内到期优先消耗」的挑号依据可能是昨天的。
 * 换账号、改配置、想立刻确认到期情况时，需要一个手动探测入口。
 *
 * 与签到路径的**关键差别**（见 pool.ts writeQoderQuota 的 unfreeze 说明）：
 * 本探测只回写额度与额度包明细，**不动冷却/禁用状态**。点一下刷新就把 429 冷却中的账号
 * 放出来，等于绕过限流保护；禁用标记同理，留给签到（能证明 token 有效）或人工处理。
 *
 * 账号级串行：账号数通常很少，且并发刷新 token 会互相打架（与 runAllCheckins 同口径）。
 * 单个账号失败不中断其余账号——面板要能看到「哪个号探不到、为什么」。
 */
import type { Env, Provider } from '../types'
import { OAUTH_TOKEN_REFRESH_MARGIN_MS } from '../config'
import { refreshQoderTokenPair } from '../oauth'
import { buildQoderPacks, fetchQoderUserInfo, fetchQoderUserResource, normalizeQoderRealm } from './billing'
import { isRealQoderNickname, readQoderPool, refreshQoderPoolAccountIfNeeded, setQoderPoolAccountNickname, setQoderPoolQuota } from './pool'
import { isFallbackQoderUid, repairQoderPoolUid } from './identity'

/** 单个账号的探测结果（供面板逐条显示，脱敏：不含 token）。 */
export interface QoderQuotaProbeOutcome {
  uid: string
  ok: boolean
  /** 成功时的剩余额度合计（基础 + 加购） */
  credits?: number
  /** 失败原因（上游报错 / 无 token / 接口无数据） */
  error?: string
}

/** 探测池内所有账号的额度并回写（只写额度与额度包，不解冻）。 */
export async function probeQoderPoolQuota(env: Env, provider: Provider): Promise<QoderQuotaProbeOutcome[]> {
  const pool = await readQoderPool(env, provider.id)
  const out: QoderQuotaProbeOutcome[] = []
  /**
   * 待归正的兜底 uid（`dt-…` token 切片），循环结束后统一落地。两个理由都不能省：
   *   1. 合并会从池数组里删掉一条，而这里正 `for...of` 迭代同一个数组，中途删元素会跳账号
   *      （表现是「点一下刷新，某个号的额度没更新」且不报错）；
   *   2. 就地改名会让紧随其后的 `setQoderPoolQuota(uid=旧值)` **静默落空**——刚探到的额度白探了
   *      （原本会写成 credits=0）。归正本身不影响本次探测结论，延后到循环外做最省事。
   * 两条都已用测试反向验证过。
   */
  const pendingUidRepairs: Array<{ from: string; to: string }> = []
  for (const acc of pool) {
    const uid = acc.uid || ''
    try {
      let token = acc.token?.access_token || ''
      if (!token) {
        out.push({ uid, ok: false, error: '无 access token' })
        continue
      }
      // 临近过期先刷新（与签到路径同一条件），否则探测会拿一个马上失效的 token 去打上游
      if (acc.token?.refresh_token && acc.token.expires_at - Date.now() < OAUTH_TOKEN_REFRESH_MARGIN_MS) {
        try {
          const refreshed = await refreshQoderPoolAccountIfNeeded(env, provider.id, uid, provider.oauth!, refreshQoderTokenPair)
          if (refreshed) token = refreshed.token.access_token
        } catch { /* 刷新失败继续用旧 token，让上游如实报错 */ }
      }
      // 身份回填（2026-10-07）：面板「刷新账号池」已经是「每账号打一次上游」的动作，
      // 顺手取一次 userinfo，同时解决两件事——昵称与兜底 uid。
      // 只在**确实需要**时才请求（有真昵称且 uid 正常就跳过），不给正常账号白发请求。
      // 注意：这里只写 nickname（纯展示）与 uid（主键归正），文件头「不动冷却/禁用状态」
      // 的不变式照旧。
      const needsNickname = !isRealQoderNickname(acc.nickname, uid)
      const needsUidRepair = isFallbackQoderUid(uid)
      if (needsNickname || needsUidRepair) {
        const ui = await fetchQoderUserInfo(token, normalizeQoderRealm(acc.realm))
        if (ui?.name && needsNickname) await setQoderPoolAccountNickname(env, provider.id, uid, ui.name)
        // uid 归正：uid 是池主键，「首选账号」/X-Qoder-Account 记的都是它；而兜底 uid
        // （`dt-…` token 切片）会随 token 刷新变化 → 同一账号重新登录后裂成两条，
        // 旧那条的首选指定再也匹配不上。userinfo 的 id 是权威 uid（见 qoder/identity.ts）。
        if (ui?.uid && needsUidRepair) pendingUidRepairs.push({ from: uid, to: ui.uid })
      }
      const quota = await fetchQoderUserResource(token, normalizeQoderRealm(acc.realm))
      if (!quota) {
        out.push({ uid, ok: false, error: '额度接口无数据（响应为空或结构变了）' })
        continue
      }
      // 没有新 grant → 签到包的到期时间用池里已存的值兜底（不让一次刷新把到期时间擦成长期）
      const packs = buildQoderPacks(quota, undefined, acc.state?.packages)
      await setQoderPoolQuota(env, provider.id, uid, quota.totalRemain, packs)
      out.push({ uid, ok: true, credits: quota.totalRemain })
    } catch (e) {
      out.push({ uid, ok: false, error: (e as Error).message || '探测失败' })
    }
  }
  // 归正延后到这里落地（见 pendingUidRepairs 的说明），并把摘要里的 uid 一并改成新值，
  // 否则面板刚刷新完显示的仍是那个已经不存在于池里的旧 uid，看起来像「刷新后账号没了」。
  for (const r of pendingUidRepairs) {
    const mig = await repairQoderPoolUid(env, provider, r.from, r.to)
    if (!mig) continue
    for (const o of out) if (o.uid === mig.fromUid) o.uid = mig.toUid
  }
  return out
}
