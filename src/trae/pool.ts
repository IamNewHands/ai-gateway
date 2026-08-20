/**
 * pool.ts — TRAE SOLO 账号池（移植自 traework2api/internal/pool/pool.go）。
 *
 * 挑选策略：healthy 账号中剩余积分最多者优先（SPEC §4.7）。
 * 冷却状态机（SPEC §4.3）：
 *   plan_limit（1005）   → 硬冷却 12h
 *   soft_rate（429）     → 短冷却 60s
 *   not_found（404）     → 短冷却 60s（不累计 errCount，防雪崩）
 *   session_dead（401）  → 永久禁用（需重新登录）
 *   连续错误 ≥ 3 次       → 中冷却 10m
 * 签到成功后积分 > 0 的冷却账号自动解冻。
 *
 * 与 Go 版单机内存池不同，Worker 是无状态多 isolate 环境，故池状态持久化到
 * KV（trae:pool:<providerId>，uid → 状态），每次读改即写，保证跨 isolate
 * 冷却/禁用/积分共享。
 */
import type { Env, Provider } from '../types'
import { KV_KEYS } from '../config'
import { parseAuth, serializeAccount } from './upstream'
import { updateProvider } from '../storage'
import type { TraeAccount, TraeAccountState, TraeAccountStatus, TraePool } from './types'

// 冷却/错误阈值（与 traework2api pool.CoolPlan/CoolSoft/CoolErr 对齐）
export const TRAE_PLAN_COOLDOWN_MS = 12 * 60 * 60 * 1000
export const TRAE_SOFT_COOLDOWN_MS = 60 * 1000
export const TRAE_ERR_THRESHOLD = 3
export const TRAE_ERR_COOLDOWN_MS = 10 * 60 * 1000

const poolKey = (providerId: string) => `${KV_KEYS.TRAE_POOL_PREFIX}${providerId}`

export async function readTraePool(env: Env, providerId: string): Promise<TraePool> {
  try {
    const raw = await env.KV.get(poolKey(providerId))
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as TraePool) : {}
  } catch {
    return {}
  }
}

async function writeTraePool(env: Env, providerId: string, pool: TraePool): Promise<void> {
  try {
    await env.KV.put(poolKey(providerId), JSON.stringify(pool))
  } catch {
    /* KV 写失败不阻断主流程 */
  }
}

/** 账号是否健康：未禁用且不在冷却期。无状态（新账号）视为健康。 */
export function isTraeHealthy(state: TraeAccountState | undefined, now: number): boolean {
  if (!state) return true
  if (state.disabled) return false
  if (state.until && state.until > now) return false
  return true
}

// ===== 账号凭证存取（provider.apiKeys：每行一个 JSON 凭证） =====

/** 解析 provider.apiKeys 中所有启用的账号凭证；非法行跳过。 */
export function getTraeAccounts(provider: Provider): TraeAccount[] {
  const out: TraeAccount[] = []
  for (const k of provider.apiKeys || []) {
    if (!k.enabled) continue
    const raw = (k.key || '').trim()
    if (!raw) continue
    try {
      out.push(parseAuth(raw))
    } catch {
      /* 跳过损坏的账号行 */
    }
  }
  return out
}

/** 更新单个账号凭证（token 刷新/登录换新后落盘），按 uid 匹配替换。 */
export async function saveTraeAccount(env: Env, providerId: string, account: TraeAccount): Promise<void> {
  const provider = await updateProvider(env, providerId, {})
  if (!provider) return
  const apiKeys = [...(provider.apiKeys || [])]
  const serialized = serializeAccount(account)
  let idx = apiKeys.findIndex((k) => {
    try {
      return parseAuth(k.key).uid === account.uid
    } catch {
      return false
    }
  })
  if (idx >= 0) {
    // 保留原 enabled 状态，替换凭证
    const enabled = apiKeys[idx].enabled
    apiKeys[idx] = { key: serialized, enabled }
  } else {
    apiKeys.push({ key: serialized, enabled: true })
  }
  await updateProvider(env, providerId, { apiKeys })
}

/** 删除指定 uid 的账号（面板「删除账号」用）。 */
export async function removeTraeAccount(env: Env, providerId: string, uid: string): Promise<boolean> {
  const provider = await updateProvider(env, providerId, {})
  if (!provider) return false
  const apiKeys = (provider.apiKeys || []).filter((k) => {
    try {
      return parseAuth(k.key).uid !== uid
    } catch {
      return true
    }
  })
  if (apiKeys.length === (provider.apiKeys || []).length) return false
  await updateProvider(env, providerId, { apiKeys })
  // 清理池状态
  const pool = await readTraePool(env, providerId)
  delete pool[uid]
  await writeTraePool(env, providerId, pool)
  return true
}

// ===== 挑选 / 状态机 =====

/**
 * 挑选账号：
 *  - 若指定 preferUid（面板手工指定），且该 uid 账号 healthy 且尚未 tried，则优先返回它；
 *  - 否则在 healthy 且未 tried 的账号中按剩余积分最多者挑选（原自动策略兜底）。
 */
export async function pickTraeAccount(
  env: Env,
  providerId: string,
  accounts: TraeAccount[],
  tried: Set<string>,
  preferUid?: string
): Promise<TraeAccount | null> {
  if (accounts.length === 0) return null
  const pool = await readTraePool(env, providerId)
  const now = Date.now()

  // 手工指定优先：精确匹配首选 uid，只在 healthy 且未 tried 时采用
  if (preferUid) {
    const preferred = accounts.find(a => a.uid === preferUid && !tried.has(a.uid) && isTraeHealthy(pool[a.uid], now))
    if (preferred) return preferred
  }

  let best: TraeAccount | null = null
  let bestCredits = -Infinity
  for (const a of accounts) {
    if (tried.has(a.uid)) continue
    if (!isTraeHealthy(pool[a.uid], now)) continue
    const credits = pool[a.uid]?.credits ?? 0
    if (credits > bestCredits) {
      best = a
      bestCredits = credits
    }
  }
  return best
}

/** 更新账号积分。 */
export async function setTraeCredits(env: Env, providerId: string, uid: string, credits: number): Promise<void> {
  const pool = await readTraePool(env, providerId)
  pool[uid] = { ...(pool[uid] || {}), credits }
  await writeTraePool(env, providerId, pool)
}

/** 冷却账号至 now+ms（清零 errCount，对齐 Go pool.Cooldown）。 */
export async function cooldownTraeAccount(env: Env, providerId: string, uid: string, ms: number, reason: string): Promise<void> {
  const pool = await readTraePool(env, providerId)
  pool[uid] = { ...(pool[uid] || {}), until: Date.now() + ms, reason, errCount: 0 }
  await writeTraePool(env, providerId, pool)
}

/** 永久禁用（session 失效，需重新登录）。 */
export async function disableTraeAccount(env: Env, providerId: string, uid: string, reason: string): Promise<void> {
  const pool = await readTraePool(env, providerId)
  pool[uid] = { ...(pool[uid] || {}), disabled: true, reason }
  await writeTraePool(env, providerId, pool)
}

/** 记录一次错误；达到 threshold 自动冷却 cooldownMs。 */
export async function noteTraeError(env: Env, providerId: string, uid: string, threshold: number, cooldownMs: number): Promise<void> {
  const pool = await readTraePool(env, providerId)
  const st = pool[uid] || {}
  const errCount = (st.errCount || 0) + 1
  if (errCount >= threshold) {
    pool[uid] = { ...st, errCount: 0, until: Date.now() + cooldownMs, reason: 'consecutive errors' }
  } else {
    pool[uid] = { ...st, errCount }
  }
  await writeTraePool(env, providerId, pool)
}

/** 成功请求重置错误计数。 */
export async function noteTraeSuccess(env: Env, providerId: string, uid: string): Promise<void> {
  const pool = await readTraePool(env, providerId)
  const st = pool[uid]
  if (st && (st.errCount || 0) > 0) {
    pool[uid] = { ...st, errCount: 0 }
    await writeTraePool(env, providerId, pool)
  }
}

/** 签到后解冻：仅当 remain > 0 且账号处于冷却（非禁用）时恢复。 */
export async function reenableTraeIfCredits(env: Env, providerId: string, uid: string, remain: number): Promise<void> {
  const pool = await readTraePool(env, providerId)
  const st = pool[uid] || {}
  pool[uid] = { ...st, credits: remain }
  if (remain > 0 && !st.disabled) {
    pool[uid] = { ...pool[uid], until: 0, reason: '', errCount: 0 }
  }
  await writeTraePool(env, providerId, pool)
}

/** 对外状态列表（脱敏，不含 token），按 uid 排序稳定输出。 */
export async function listTraeStatus(env: Env, provider: Provider): Promise<TraeAccountStatus[]> {
  const accounts = getTraeAccounts(provider)
  const pool = await readTraePool(env, provider.id)
  const now = Date.now()
  const uids = accounts.map((a) => a.uid)
  // 池中有状态但账号已被移除的 uid 也展示（便于排查冷却/禁用残留）
  for (const uid of Object.keys(pool)) {
    if (!uids.includes(uid)) uids.push(uid)
  }
  uids.sort()
  const out: TraeAccountStatus[] = []
  for (const uid of uids) {
    const a = accounts.find((x) => x.uid === uid)
    const st = pool[uid]
    out.push({
      uid,
      nickname: a?.nickname || '',
      credits: st?.credits ?? 0,
      cooling: st ? st.until > now : false,
      until: st?.until,
      reason: st?.reason || '',
      disabled: st?.disabled === true,
      errCount: st?.errCount || 0,
    })
  }
  return out
}
