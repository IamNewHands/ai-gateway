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
      // 昵称回填（2026-10-07）：面板「刷新账号池」已经是「每账号打一次上游」的动作，
      // 顺手补一次名字，用户就不必等到下一次签到才看到昵称。
      // 注意：这里**只写 nickname 这一个纯展示字段**，文件头「不动冷却/禁用状态」的不变式照旧
      // （setQoderPoolAccountNickname 只改 nickname，不碰 state）。
      if (!isRealQoderNickname(acc.nickname, uid)) {
        const ui = await fetchQoderUserInfo(token, normalizeQoderRealm(acc.realm))
        if (ui?.name) await setQoderPoolAccountNickname(env, provider.id, uid, ui.name)
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
  return out
}
