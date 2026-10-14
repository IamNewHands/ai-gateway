/**
 * session-registry.ts — Remote 上游会话的「存活登记表」+ 僵尸回收。
 *
 * ## 为什么需要它（这是最后一条泄漏路径）
 *
 * Remote 的会话回收已经覆盖了所有**正常**出口：`onDone`（模型说完）、`onClose`
 *（客户端断连 / idle / 读错误）、非流式成功、各种失败路径。这些都要求**当前这次
 * 请求的隔离进程还活着**。
 *
 * 但还有一种情况：隔离进程在「建好会话」与「发出 stop」之间**直接死掉**
 *（Worker 被驱逐、CPU 时间超限、平台故障）。此时上游那个会话仍然在跑、仍然占着
 * 账号并发槽位，而**再也没有任何人知道它的 id** —— 于是它永久泄漏，积满上限 2 之后
 * 新会话只排队、executor 不启动（2026-10-14 现场）。
 *
 * 源侧的对策是同一进程内的 `register_web_lease` / `touch_web_lease` /
 * `idle_web_leases` + 每 10s 的 `reap_idle_web_sessions`。Workers 里没有常驻进程，
 * 所以等价物是：**把会话登记到 KV，靠租约（lease）判活，靠 cron 回收**。
 *
 * ## 租约模型
 *
 *  - 建会话成功后 `registerRemoteSession` 写一条记录（每会话一个 KV key，避免
 *    读改写竞态：KV 没有 CAS，把多个会话塞进一个数组会丢记录）。
 *  - 会话活着时，流式路径每 `TRAE_REMOTE_LEASE_TOUCH_MS` 调一次
 *    `touchRemoteSession` 刷新 `lastSeenAt`。
 *  - 隔离进程一死，续期立刻停止 → `lastSeenAt` 变陈旧 → cron 里的 reaper 判定为
 *    僵尸，发 `stop` 并删记录。
 *
 * 阈值取「续期间隔的 3 倍」：一次续期抖动（平台调度、冷启动）不会误杀活会话，
 * 而僵尸最多多活 2 个续期周期。
 *
 * ## 两条硬约束
 *
 * 1. **登记表故障绝不影响对话**：所有函数吞异常。KV 挂了只是失去兜底，不能因此
 *    让用户的请求失败。
 * 2. **`touch` 绝不复活已摘除的记录**：它先读后写，记录不存在就直接返回。
 *    否则「续期请求在途 + 回收已完成」会让已回收的会话重新出现在表里。
 */
import type { Env, Provider } from '../types'
import { getTraeAccounts, releaseTraeSession } from './pool'
import { stopRemoteSession } from './remote'

/** 每会话一个 key；前缀列出即「当前登记的存活会话」。 */
const KEY_PREFIX = 'trae:remote:live'

/** 租约续期间隔（流式路径按此刷新 `lastSeenAt`）。 */
export const TRAE_REMOTE_LEASE_TOUCH_MS = 30_000

/** 超过这个时长没续期 → 判定为「持有者已死」的僵尸会话。取续期间隔的 3 倍。 */
export const TRAE_REMOTE_LEASE_STALE_MS = 90_000

/**
 * 登记记录的兜底 TTL（秒）。即使 reaper 从不运行（cron 未部署 / KV 只读），
 * 记录也会自己过期，不会在 KV 里永久残留。续期时会一并刷新 TTL。
 */
export const TRAE_REMOTE_LEASE_TTL_SECONDS = 2 * 60 * 60

/** 一条存活会话的登记记录。`baseUrl` 不入表：它由 provider 决定，reaper 自己取。 */
export interface TraeRemoteSessionRecord {
  uid: string
  sessionId: string
  messageId: string
  agentType: string
  startedAt: number
  lastSeenAt: number
}

function keyOf(providerId: string, sessionId: string): string {
  return `${KEY_PREFIX}:${providerId}:${sessionId}`
}

/** 登记一个刚建好的上游会话。失败只丢兜底能力，不影响本次对话。 */
export async function registerRemoteSession(
  env: Env,
  providerId: string,
  rec: TraeRemoteSessionRecord
): Promise<void> {
  if (!rec.sessionId) return
  try {
    await env.KV.put(keyOf(providerId, rec.sessionId), JSON.stringify(rec), {
      expirationTtl: TRAE_REMOTE_LEASE_TTL_SECONDS,
    })
  } catch { /* 登记失败不影响对话 */ }
}

/**
 * 租约续期。**先读后写**：记录已被摘除（正常回收 / 已被 reaper 回收）时直接返回，
 * 绝不把一条已死的会话重新写回表里。
 */
export async function touchRemoteSession(
  env: Env,
  providerId: string,
  rec: TraeRemoteSessionRecord
): Promise<void> {
  if (!rec.sessionId) return
  const key = keyOf(providerId, rec.sessionId)
  try {
    const existing = await env.KV.get(key)
    if (!existing) return
    await env.KV.put(key, JSON.stringify({ ...rec, lastSeenAt: Date.now() }), {
      expirationTtl: TRAE_REMOTE_LEASE_TTL_SECONDS,
    })
  } catch { /* 续期失败不影响对话 */ }
}

/** 摘除登记（正常回收路径调用）。 */
export async function unregisterRemoteSession(
  env: Env,
  providerId: string,
  sessionId: string
): Promise<void> {
  if (!sessionId) return
  try {
    await env.KV.delete(keyOf(providerId, sessionId))
  } catch { /* 摘除失败不影响对话；记录会靠 TTL 或 reaper 收尾 */ }
}

/** 列出当前登记的存活会话（reaper 与排障用）。 */
export async function listRemoteSessions(
  env: Env,
  providerId: string
): Promise<TraeRemoteSessionRecord[]> {
  const out: TraeRemoteSessionRecord[] = []
  try {
    const listed = await env.KV.list({ prefix: `${KEY_PREFIX}:${providerId}:` })
    for (const entry of listed.keys) {
      const raw = await env.KV.get(entry.name)
      if (!raw) continue
      try {
        const parsed = JSON.parse(raw) as TraeRemoteSessionRecord
        if (parsed && parsed.sessionId) out.push(parsed)
      } catch { /* 记录损坏：跳过，TTL 会清掉 */ }
    }
  } catch { /* 列表失败当作「没有僵尸」—— 宁可漏收也不误杀 */ }
  return out
}

export interface ReapResult {
  scanned: number
  reaped: number
  skipped: number
  failed: number
}

/**
 * 回收一个 provider 下的僵尸会话：`now - lastSeenAt > staleMs` 的一律停掉并摘除。
 *
 * 刻意**只**按租约陈旧度判定，不按「会话总数」或「运行时长」：活着的会话一直在续期，
 * 长跑几十分钟也不会被误杀；而死掉的会话续期停止，最多多活 2 个续期周期。
 */
export async function reapRemoteSessions(
  env: Env,
  provider: Provider,
  opts?: { staleMs?: number; now?: number }
): Promise<ReapResult> {
  const staleMs = opts?.staleMs ?? TRAE_REMOTE_LEASE_STALE_MS
  const now = opts?.now ?? Date.now()
  const result: ReapResult = { scanned: 0, reaped: 0, skipped: 0, failed: 0 }

  const records = await listRemoteSessions(env, provider.id)
  result.scanned = records.length
  if (records.length === 0) return result

  const accounts = getTraeAccounts(provider)
  const baseUrl = provider.baseUrl || null

  for (const rec of records) {
    if (now - rec.lastSeenAt <= staleMs) { result.skipped++; continue }
    const account = accounts.find((a) => a.uid === rec.uid)
    if (account) {
      // stopRemoteSession 自己吞异常，所以这里没有可失败的分支。
      await stopRemoteSession(account, rec.sessionId, rec.messageId, { baseUrl, agentType: rec.agentType })
      result.reaped++
    } else {
      // 账号已被移除/禁用 → 无法构造鉴权头，停不掉。
      result.failed++
    }
    // **本地并发计数也要减**（这一条不能省）：reaper 停掉的是**上游**会话，而
    // `pickTraeAccount` 的并发判定读的是 KV 里的 `activeSessions`。只停上游不减计数，
    // 那个账号会一直被跳过 —— 泄漏的槽位只是从「上游占满」变成「本地占满」，
    // 症状一模一样（503 no_healthy_account）。持有者死掉时那次 release 永远不会发生，
    // 所以必须由 reaper 补上。
    await releaseTraeSession(env, provider.id, rec.uid).catch(() => { /* 计数失败不影响回收 */ })
    await unregisterRemoteSession(env, provider.id, rec.sessionId)
  }
  return result
}
