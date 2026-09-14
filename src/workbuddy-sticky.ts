/**
 * workbuddy-sticky.ts — WorkBuddy 多账号池的**会话粘性路由**
 * （移植 workbuddy2api internal/session/session.go）。
 *
 * 背景与价值：ai-gateway 的池化路径此前**完全没有粘性**——每次请求独立做三因子
 * 加权随机挑号，多轮对话会跳到不同账号上。后果：
 *  1. **prompt cache 失效**：上游按账号维度缓存前缀，同一会话换号 → 前缀不命中
 *     → 成本上升、首字延迟变长；
 *  2. 多账号共享会话历史时，上游侧会话状态与请求历史可能不匹配。
 *
 * 移植的核心语义（对齐 session.go:137-195 ResolveForModel）：
 *  - **模型维度校验**：绑定只记 uid，而同一会话可能换模型。账号被 6004 模型级限额后
 *    对**其他模型**仍可用（模型级冷却豁免）。若只按账号级可用性校验，会话会被钉在
 *    一个"对当前模型不可用"的号上反复失败——这正是"限额后换不动号"的观感来源。
 *  - **双段分配**：优先"空闲账号"（未被任何会话绑定的可用号），空闲耗尽才回落全池。
 *    目的是让新会话尽量分散到未被占用的号上，而非全挤在同一个高分号。
 *  - **确定性哈希**：同 key 在同候选集下恒得同一 uid（FNV-1a 32 位）。
 *  - **失败解绑**：绑定号不可用（冷却/禁用/被该模型限额）时解绑并重分配。
 *  - **成功跟随**：轮转到别的号成功后，把会话重绑到新号（多轮下一跳不再随机抽）。
 *
 * Workers 适配（与 Go 单进程实现的差异，均为刻意取舍）：
 *  - Go 用 sync.RWMutex + 进程内存 Map；Workers 多 isolate 无共享内存，故以
 *    **KV 作为跨 isolate 权威**（`oauth:sticky:<providerId>`），isolate 内再加一层
 *    短 TTL 内存缓存减少 KV 读。
 *  - KV 写只在**分配/改绑/解绑**时发生（命中时不写），使写次数与会话数同阶（有界），
 *    避免每请求一次 KV 写的配额放大。命中只滚动内存 lastActive。
 *  - 因此跨 isolate 的粘性为"最终一致"：极短时间内同一会话可能被两个 isolate
 *    分到不同号（各自写 KV，后者覆盖）。这对 prompt cache 的影响远小于"完全无粘性"，
 *    且不引入 Durable Object 的复杂度与成本。若要强一致需落 DO。
 */
import type { Env } from './types'
import type { OAuthPoolAccount } from './oauth-pool'
import { OAUTH_POOL_KV_PREFIX } from './oauth'

/** 粘性绑定表 KV 前缀（与池 key 区分）。 */
export const STICKY_KV_PREFIX = 'oauth:sticky:'

/** 默认绑定 TTL（30 分钟，对齐 workbuddy2api session.New 的默认 TTL）。 */
export const DEFAULT_STICKY_TTL_MS = 30 * 60 * 1000

/** isolate 内内存缓存 TTL：减少 KV 读次数。 */
const MEMORY_CACHE_TTL_MS = 1000

/** 单条绑定：uid + 最近活跃时刻。 */
interface StickyEntry {
  uid: string
  lastActive: number
}

/** 绑定表（会话键 → 绑定）。 */
export type StickyTable = Record<string, StickyEntry>

const stickyCache = new Map<string, { table: StickyTable; at: number }>()

/** 仅供测试：清空粘性内存缓存。 */
export function __resetStickyCacheForTests(): void {
  stickyCache.clear()
}

const stickyKey = (providerId: string) => STICKY_KV_PREFIX + providerId

/** 读取绑定表（KV 权威 + 1s 内存缓存）。损坏/不可读 → 空表。 */
export async function readStickyTable(env: Env, providerId: string): Promise<StickyTable> {
  const hit = stickyCache.get(providerId)
  if (hit && Date.now() - hit.at < MEMORY_CACHE_TTL_MS) return hit.table
  let table: StickyTable = {}
  try {
    const raw = await env.KV.get(stickyKey(providerId))
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) table = parsed as StickyTable
    }
  } catch { /* 损坏当空表 */ }
  stickyCache.set(providerId, { table, at: Date.now() })
  return table
}

/** 写入绑定表（KV + 内存缓存同步更新）。 */
export async function writeStickyTable(env: Env, providerId: string, table: StickyTable): Promise<void> {
  stickyCache.set(providerId, { table, at: Date.now() })
  try {
    await env.KV.put(stickyKey(providerId), JSON.stringify(table))
  } catch { /* KV 写失败不阻断主流程（退化为本次请求无粘性） */ }
}

/**
 * 清理过期绑定（惰性，对齐 workbuddy2api gcOnce）。
 * 返回是否有变更（供调用方决定是否写回）。
 */
export function pruneExpired(table: StickyTable, now: number, ttlMs = DEFAULT_STICKY_TTL_MS): boolean {
  let changed = false
  for (const key of Object.keys(table)) {
    const e = table[key]
    if (!e || typeof e.lastActive !== 'number' || now - e.lastActive > ttlMs) {
      delete table[key]
      changed = true
    }
  }
  return changed
}

/**
 * FNV-1a 32 位哈希取模（对齐 workbuddy2api session.go:286-293 hashIndex）。
 *
 * 用确定性哈希而非随机：同 key 在同候选集下恒得同一 uid，保证"同一会话稳定落同一号"
 * （这是粘性的前提）。offset basis 2166136261 / prime 16777619 为 FNV-1a 标准参数。
 */
export function hashIndex(key: string, n: number): number {
  if (n <= 0) return 0
  let h = 2166136261
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    // FNV prime 乘法：用 Math.imul 保证 32 位溢出语义（JS 位运算会转 int32）
    h = Math.imul(h, 16777619)
  }
  // >>> 0 转无符号，再取模（避免负数取模得到负索引）
  return (h >>> 0) % n
}

/** 粘性解析结果。 */
export interface StickyResolution {
  /** 命中的绑定 uid（未命中/已失效为 ''） */
  uid: string
  /** 是否命中并已滚动 lastActive */
  hit: boolean
}

/**
 * 查询会话的粘性绑定（对齐 ResolveForModel 的快路径 + 失效判定）。
 *
 * @param isAvailable 校验该 uid 在当前请求模型上是否可用（须包含模型级冷却豁免判定）
 *
 * 命中且可用 → 返回 { uid, hit: true }（并滚动 lastActive）；
 * 绑定号不可用/已过期 → 返回 { uid: '', hit: false }（调用方走正常挑号 + 重新 Bind）。
 */
export async function resolveSticky(
  env: Env,
  providerId: string,
  sessionKey: string,
  isAvailable: (uid: string) => boolean,
  ttlMs = DEFAULT_STICKY_TTL_MS
): Promise<StickyResolution> {
  if (!sessionKey) return { uid: '', hit: false }
  const table = await readStickyTable(env, providerId)
  const now = Date.now()
  const e = table[sessionKey]
  if (!e) return { uid: '', hit: false }

  // 过期 → 失效（清掉，避免下次再查）
  if (typeof e.lastActive !== 'number' || now - e.lastActive > ttlMs) {
    delete table[sessionKey]
    await writeStickyTable(env, providerId, table)
    return { uid: '', hit: false }
  }

  // 绑定号在当前模型不可用（冷却/禁用/被该模型限额）→ 失效，落慢路径重分配
  if (!isAvailable(e.uid)) {
    delete table[sessionKey]
    await writeStickyTable(env, providerId, table)
    return { uid: '', hit: false }
  }

  // 命中：滚动 lastActive（只改内存缓存，不写 KV —— 避免每请求一次 KV 写）
  e.lastActive = now
  return { uid: e.uid, hit: true }
}

/**
 * 显式绑定会话到 uid（幂等覆盖，对齐 session.go Bind）。
 * 供"轮转到别的号成功后，把会话重绑到新号"使用。
 */
export async function bindSticky(
  env: Env,
  providerId: string,
  sessionKey: string,
  uid: string
): Promise<void> {
  if (!sessionKey || !uid) return
  const table = await readStickyTable(env, providerId)
  table[sessionKey] = { uid, lastActive: Date.now() }
  await writeStickyTable(env, providerId, table)
}

/** 解绑会话（对齐 session.go Unbind）。 */
export async function unbindSticky(env: Env, providerId: string, sessionKey: string): Promise<boolean> {
  if (!sessionKey) return false
  const table = await readStickyTable(env, providerId)
  if (!table[sessionKey]) return false
  delete table[sessionKey]
  await writeStickyTable(env, providerId, table)
  return true
}

/**
 * 为一个**未绑定**的会话分配 uid（对齐 ResolveForModel 慢路径的双段策略）。
 *
 * 双段策略：优先从「空闲号」（未被任何会话绑定的候选）里哈希取；
 * 空闲耗尽才回落全候选集。目的是让新会话尽量分散到未被占用的号上。
 *
 * @param candidates 当前模型下**可用**的候选 uid 列表（顺序由调用方给定，须稳定）
 * @returns 分配到的 uid；候选为空返回 ''
 */
export function allocateSticky(
  table: StickyTable,
  sessionKey: string,
  candidates: string[]
): string {
  if (candidates.length === 0) return ''
  // 已被任何会话绑定的 uid 集合
  const bound = new Set<string>()
  for (const k of Object.keys(table)) {
    const e = table[k]
    if (e && e.uid) bound.add(e.uid)
  }
  const idle = candidates.filter((u) => !bound.has(u))
  const pool = idle.length > 0 ? idle : candidates
  return pool[hashIndex(sessionKey, pool.length)]
}

/**
 * 便捷入口：解析或分配会话绑定（对齐 ResolveForModel 的完整两段流程）。
 *
 * @param isAvailable 校验 uid 在当前模型可用（含模型级冷却豁免）
 * @param candidates  当前模型下的可用候选 uid（顺序须稳定，用于哈希确定性）
 */
export async function resolveOrAllocateSticky(
  env: Env,
  providerId: string,
  sessionKey: string,
  isAvailable: (uid: string) => boolean,
  candidates: string[],
  ttlMs = DEFAULT_STICKY_TTL_MS
): Promise<string> {
  if (!sessionKey) return ''
  const resolved = await resolveSticky(env, providerId, sessionKey, isAvailable, ttlMs)
  if (resolved.hit) return resolved.uid

  const table = await readStickyTable(env, providerId)
  const now = Date.now()
  // 惰性清理过期项，防表无限膨胀
  pruneExpired(table, now, ttlMs)
  const uid = allocateSticky(table, sessionKey, candidates)
  if (!uid) return ''
  table[sessionKey] = { uid, lastActive: now }
  await writeStickyTable(env, providerId, table)
  return uid
}

/** 供调用方构造"可用性校验"闭包时的类型别名。 */
export type StickyAvailabilityCheck = (uid: string) => boolean

/** 池账号 → uid 列表（保持入参顺序，供哈希确定性）。 */
export function uidsOf(accounts: OAuthPoolAccount[]): string[] {
  return accounts.map((a) => a.uid)
}

/** 与 OAUTH_POOL_KV_PREFIX 的关系说明（导出供测试/运维排查 key 布局）。 */
export const STICKY_KEYS_LAYOUT = {
  pool: OAUTH_POOL_KV_PREFIX + '<providerId>',
  sticky: STICKY_KV_PREFIX + '<providerId>',
} as const
