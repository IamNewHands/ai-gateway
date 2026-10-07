/**
 * identity.ts — Qoder 池账号 uid 的权威来源，以及「兜底 uid」的归正。
 *
 * 池账号的 uid 有三种来源，可靠性依次下降（见 oauth.ts pollOauthQoderFlow 与 qoderPoolUpsert）：
 *   1. `/api/v1/userinfo` 的 `id`  —— 上游权威 uid。hub qoder_accounts.py:1739 就是拿它覆盖
 *      设备授权响应里的 `user_id`（`uid = str(ui.get("id") or uid)`），qoder2api 同样以 userinfo 为准。
 *   2. 设备授权轮询响应的 `user_id`。
 *   3. `access_token.slice(0, 16)` —— 兜底。`dt-OlN11…` 这种 **token 切片不是账号身份**。
 *
 * 第 3 种是问题所在（2026-10-07 用户批准顺手修）：它会随每次 token 刷新而变化，而 uid 是池的
 * 主键——「首选账号」和客户端 `X-Qoder-Account` 记的都是它。于是同一账号重新登录后会以**新 uid**
 * 再进一次池，面板上裂成两条，而旧那条的首选指定永远匹配不上（静默退化成自动挑选）。
 *
 * 本模块只做两件事，且都在「已经拿到 userinfo」的时机做，不额外增加上游请求：
 *   - `isFallbackQoderUid`：判断一个 uid 是不是兜底值；
 *   - `repairQoderPoolUid`：把兜底 uid 换成权威 uid，并**同步面板的 preferOauthUid**。
 * 不让新的兜底 uid 产生属于登录路径的职责（oauth.ts 里 userinfo 优先于 token 切片）。
 */
import type { Env, OAuthTokenState, Provider } from '../types'
import { updateProvider } from '../storage'
import { isRealQoderNickname, readQoderPool, writeQoderPool, type QoderPoolState } from './pool'

/**
 * uid 是否是「access_token 切片」这种兜底值。
 *
 * 为什么只认 `dt-` / `jt-` 前缀：这是**我们自己的兜底写法**唯一会产生的形状
 * （oauth.ts `access_token.slice(0, 16)`，而 access_token 形如 `dt-OlN11…` / `jt-…`，
 * hub 也是用这两个前缀区分设备 token 与 job token —— qoder_accounts.py:1986）。
 * 权威 uid 是 UUID（实测 `01a0fb50-84b9-7848-a8d1-240c89950b79`），不可能以这两个前缀开头。
 * 刻意不去猜「不像 UUID 就当兜底」：那会把上游将来可能改用的其它 id 形状误判成脏值。
 */
export function isFallbackQoderUid(uid: unknown): boolean {
  const v = typeof uid === 'string' ? uid.trim() : ''
  return /^(dt|jt)-/.test(v)
}

/** 一次 uid 归正的结果，供调用方显示/记日志（不返回就等于什么都没做）。 */
export interface QoderUidMigration {
  fromUid: string
  toUid: string
  /** 权威 uid 那条已存在 → 两条并成一条（旧的兜底条目被移除） */
  merged: boolean
  /** provider.preferOauthUid 原本指向旧 uid，已一并改到新 uid */
  pinMoved: boolean
}

/** 合并时取「信息更多」的那份额度状态：有额度包明细的优先，其次剩余积分多的。 */
function richerQoderState(a: QoderPoolState | undefined, b: QoderPoolState | undefined): QoderPoolState | undefined {
  if (!a) return b
  if (!b) return a
  const packDiff = (b.packages?.length ?? 0) - (a.packages?.length ?? 0)
  if (packDiff !== 0) return packDiff > 0 ? b : a
  return (b.credits ?? 0) > (a.credits ?? 0) ? b : a
}

/** 合并时取「更不容易立刻过期」的那份凭证（同一账号的两份 token 都有效，取新的少一次刷新）。 */
function fresherQoderToken(a: OAuthTokenState | undefined, b: OAuthTokenState | undefined): OAuthTokenState {
  if (!a) return b as OAuthTokenState
  if (!b) return a
  return (b.expires_at ?? 0) > (a.expires_at ?? 0) ? b : a
}

/**
 * 把池内 `fromUid`（兜底 uid）归正为 `toUid`（上游权威 uid）。
 *
 * 只归正兜底 uid：真 uid 之间的差异属于上游侧的变化（换号/风控），本函数**绝不**擅自改写，
 * 否则一次上游抖动就可能把用户的账号重新编号。返回 null = 什么都没做（不满足前提）。
 *
 * 目标 uid 已被占用时按「同一个 Qoder 账号只留一条」合并（通常来自后来那次 `user_id` 正常的登录）：
 *   - 主键取权威 uid 那条作为账号本体；
 *   - 额度状态取信息更多的那份，凭证取更晚过期的那份（见上面两个 helper）；
 *   - 昵称优先真名（`nickname === uid` 的历史脏值不作数）；
 *   - 只要有一条未禁用，合并后即未禁用 —— 与本池既有口径一致：禁用多是鉴权误判的残留，
 *     另一条记录健康本身就是该账号可用的证据（对照 pool.ts reenableQoderIfCredits 的说明）。
 *
 * 同时把 `provider.preferOauthUid` 从旧 uid 改到新 uid。**这一步不能省**：不改的话
 * pickQoderAccount 按旧 uid 找不到账号，「面板指定首选账号」会静默退化成自动挑选，
 * 面板下拉框也会悄悄弹回「自动挑选」——用户完全看不出发生过什么。
 */
export async function repairQoderPoolUid(
  env: Env,
  provider: Provider,
  fromUid: string,
  toUid: string
): Promise<QoderUidMigration | null> {
  const from = String(fromUid || '').trim()
  const to = String(toUid || '').trim()
  if (!from || !to || from === to) return null
  if (!isFallbackQoderUid(from)) return null

  const pool = await readQoderPool(env, provider.id)
  const src = pool.find((a) => a.uid === from)
  if (!src) return null
  const dst = pool.find((a) => a.uid === to)

  if (dst) {
    dst.nickname = isRealQoderNickname(dst.nickname, dst.uid)
      ? dst.nickname
      : (isRealQoderNickname(src.nickname, src.uid) ? String(src.nickname).trim() : undefined)
    dst.token = fresherQoderToken(dst.token, src.token)
    dst.state = richerQoderState(dst.state, src.state) as QoderPoolState
    dst.enabled = dst.enabled !== false || src.enabled !== false
    dst.updatedAt = Math.max(dst.updatedAt || 0, src.updatedAt || 0)
    // filter 产出新数组，不改动调用方可能正在 for...of 迭代的那个数组（否则会跳账号）
    await writeQoderPool(env, provider.id, pool.filter((a) => a.uid !== from))
  } else {
    // 原地改名：调用方持有的对象引用仍然有效，后续按 uid 的写入会落到新键上
    src.uid = to
    await writeQoderPool(env, provider.id, pool)
  }

  let pinMoved = false
  if (String(provider.preferOauthUid || '').trim() === from) {
    await updateProvider(env, provider.id, { preferOauthUid: to })
    pinMoved = true
  }
  // 落一条日志：uid 变了是用户可见的变化（面板行首字符串变了、甚至少一行），
  // 不记的话事后只能靠猜是什么改的（wrangler tail 可见）
  console.log(`[qoder-uid] ${provider.id}: ${from} → ${to}${dst ? '（已合并同一账号的两条记录）' : ''}${pinMoved ? '，首选账号同步迁移' : ''}`)
  return { fromUid: from, toUid: to, merged: !!dst, pinMoved }
}
