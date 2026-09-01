/**
 * credit.ts — 回合级积分配对 / 快照回退（特性D）。
 *
 * 背景：Trae2api 在每回合 SSE 流的 timing_cost / 会话元数据里携带"剩余额度"快照，
 * 用"上一快照 - 本次快照"差值做精确扣费，而不用每次都拉全量 ide_user_ent_usage。
 * 本项目池积分来自 fetchUserEntUsage（admin/login 全量拉取），为免高成本网络调用，
 * 这里提供纯函数：从回合事件 data 稳健提取剩余额度（不臆造字段名），并用
 * prev/now 快照做配对核验；当差值过大/数据缺失时回退到 up-to-date 快照，避免误记。
 */
import type { SOLOEvent } from './types'

/** 从任意值里拿数字；字符串转数字。 */
function toNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

/** 常见"剩余额度"字段名（部分包/net_value 时返回负标记）。 */
const REMAIN_KEYS = ['remain', 'remainPoints', 'remain_points', 'remainPoint', 'balance', 'credit', 'credits']

function isPlainObj(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/**
 * 从 SSE 回合事件 data（对象）稳健提取"剩余额度"。
 * 支持：
 *  - 常见标量字段 remain/balance/credit/...（含字符串数）
 *  - net_value[]：按 net_value 净值求和
 *  - user_entitlement_pack_list[]：各包 credits_limit - credits_amount 之和
 * 无法识别返回 null；识别到但净值为 0 返回 0。
 * 不臆造字段名——只识别明确见过的结构。
 */
export function extractRemainValue(data: unknown): number | null {
  if (typeof data === 'number' && Number.isFinite(data)) return data
  if (typeof data === 'string') return toNum(data)
  if (!isPlainObj(data)) return null

  // 1) 常见标量字段
  for (const k of REMAIN_KEYS) {
    if (data[k] !== undefined) {
      const n = toNum(data[k])
      if (n !== null) return n
    }
  }
  // 2) net_value 数组：部分包净值求和
  if (Array.isArray(data['net_value'])) {
    let sum = 0
    let hit = false
    for (const p of data['net_value']) {
      if (isPlainObj(p)) {
        const n = toNum(p['net_value'])
        if (n !== null) { sum += n; hit = true }
      }
    }
    if (hit) return sum
  }
  // 3) user_entitlement_pack_list：各包 credits_limit - credits_amount 之和
  if (Array.isArray(data['user_entitlement_pack_list'])) {
    let sum = 0
    let hit = false
    for (const p of data['user_entitlement_pack_list']) {
      if (!isPlainObj(p)) continue
      const quota = p['allowance'] && isPlainObj(p['allowance'])
        ? p['allowance']['quota']
        : p['entitlement_base_info'] && isPlainObj(p['entitlement_base_info'])
          ? p['entitlement_base_info']['quota']
          : undefined
      if (!isPlainObj(quota)) continue
      const limit = toNum(quota['credits_limit'])
      const used = p['usage'] && isPlainObj(p['usage']) ? toNum(p['usage']['credits_amount']) : null
      if (limit !== null) {
        hit = true
        sum += Math.max(0, limit - (used ?? 0))
      }
    }
    if (hit) return sum
  }
  return null
}

/**
 * 快照配对校验：本次快照相对上一快照的差值是否在可接受范围（|prev - now| <= limit）。
 * 差值超限（可能充值跳变或数据失真）→ false，需回退。
 */
export function lookaheadLimited(prev: number, now: number, limit: number): boolean {
  return Math.abs(prev - now) <= limit
}

/**
 * 回合级积分配对：
 *  - prev 缺失（首回合）→ 直接用 now（无需核对）
 *  - now 缺失 → 回退 prev
 *  - 差值超限 → 回退 prev（防充值/失真导致误记）
 *  - 差值合理 → 用 now（精确扣费）
 * prev 与 now 皆缺失 → null（保持池内现值不动）。
 * 返回 { newCredits, reverted }。
 */
export function reconcileTurnCredit(args: {
  prev: number | null
  now: number | null
  limit: number
}): { newCredits: number | null; reverted: boolean } {
  const { prev, now, limit } = args
  if (prev === null) {
    return { newCredits: now, reverted: false }
  }
  if (now === null) {
    return { newCredits: prev, reverted: true }
  }
  if (!lookaheadLimited(prev, now, limit)) {
    return { newCredits: prev, reverted: true }
  }
  return { newCredits: now, reverted: false }
}

/** 由 SOLOEvent 中任意 source 字段做余额提取（接入 SSE 聚合的落点封装）。 */
export function extractRemainFromEvent(ev: SOLOEvent, source: keyof SOLOEvent): number | null {
  return extractRemainValue(ev[source])
}