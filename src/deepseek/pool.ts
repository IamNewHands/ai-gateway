/**
 * deepseek/pool.ts — token 池（KV 持久化 + per-isolate 轮转/并发控制）。
 *
 * 为什么是 token 池而不是账号池：上游硬卡密码登录（真实浏览器同样 `biz_code 11`），
 * 短信登录又需要浏览器侧 Shumei `rid`，无头进程两条都走不了。所以这里的「凭据」=
 * 一个 web token + 它对应的 header device id / UA（浏览器登录后从 localStorage 取），
 * 由管理面板注入。详见 DEEPSEEK-APP-PORT.md。
 *
 * 设计取舍：
 *  - 持久层只有一个 KV 键（整表读写）。token 数量是「人手工注入的个位数」，不需要
 *    按键分片，也不需要并发合并；整表读写让「注入/删除」永远原子。
 *  - 运行态（游标、每 token 在飞数）留在 isolate 内存，与 trae/kuku/cnb 同形态；
 *    Workers 多 isolate 下轮转是「每 isolate 各自轮」，不影响正确性。
 *  - token 失效**必须显式标记**并让面板可见，不做静默降级（否则用户会看到随机失败）。
 *  - 被上游禁言/封禁/判风险的 token 必须 **park**（停用一段时间），见下方 park 段：
 *    不 park 就会在下一次请求里继续打同一账号，上游会**续期窗口甚至升级处罚**
 *    （Go 版注释里的实测：6h 禁言 → 3 天封禁）。
 */

import { KV_KEYS } from '../config'
import type { Env } from '../types'

export type DeepseekTokenState = 'ready' | 'expired'

/** park 种类，与上游 `biz_code` 一一对应（10/5/11）。 */
export type DeepseekParkKind = 'banned' | 'muted' | 'risk'

/**
 * 一次 park：该 token 在 `until` 之前不参与轮转。
 *
 * `until` 缺省 = **永久**（只有 `banned` 会这样）：上游封禁没有窗口，只能人工处理。
 */
export interface DeepseekPark {
  kind: DeepseekParkKind
  /** 到期时刻（ms epoch）。省略 = 永久 park。 */
  until?: number
  reason: string
  /** park 发生时刻（ms epoch），面板展示用。 */
  at: number
}

/** 禁言 park 的兜底时长：上游常不给 `mute_until`。与 Go 版 `MuteParkDefault` 一致（6h）。 */
export const DEEPSEEK_MUTE_PARK_DEFAULT_MS = 6 * 60 * 60 * 1000

/** 设备风险 park 的冷却时长。与 Go 版 `RiskCooldown` 一致（10min）。 */
export const DEEPSEEK_RISK_COOLDOWN_MS = 10 * 60 * 1000

/** 池里的一条 token 凭据。 */
export interface DeepseekTokenRecord {
  /** 面板标识（短随机串；token 本身不回显）。 */
  id: string
  token: string
  /** 与 token 匹配的 `x-device-id`（浏览器 localStorage `deepseek-device-id:chat`）。 */
  headerDeviceId: string
  /** 浏览器 UA（web 线上指纹的一部分）。 */
  userAgent: string
  /** 登录体里的 Shumei device_id（备用；当前 API 调用不需要）。 */
  shumeiDeviceId?: string
  /** 人可读备注（如「主号」）。 */
  label?: string
  state: DeepseekTokenState
  /** 上游处罚窗口；缺省 = 未被 park。过期的 park 会被惰性清除（= 自然解禁）。 */
  park?: DeepseekPark
  addedAt: number
  lastOkAt?: number
  lastErrorAt?: number
  lastError?: string
}

/** 面板展示用的脱敏视图（永不回显 token 本体）。 */
export interface DeepseekTokenView {
  id: string
  label?: string
  state: DeepseekTokenState
  park?: DeepseekPark
  /** 该 token 是否正处于 park 窗口内（过期的 park 不算）。 */
  parked: boolean
  tokenTail: string
  addedAt: number
  lastOkAt?: number
  lastErrorAt?: number
  lastError?: string
}

export function toTokenView(rec: DeepseekTokenRecord, now = Date.now()): DeepseekTokenView {
  return {
    id: rec.id,
    label: rec.label,
    state: rec.state,
    park: rec.park,
    parked: isDeepseekTokenParked(rec, now),
    tokenTail: rec.token.slice(-6),
    addedAt: rec.addedAt,
    lastOkAt: rec.lastOkAt,
    lastErrorAt: rec.lastErrorAt,
    lastError: rec.lastError,
  }
}

// ===== park 语义（移植自 simple-chat `internal/upstream/pool.go`）=====

/**
 * 该 token 现在是否被 park。
 *
 * 过期即「自然解禁」（Go 的 `healthNow` 同语义）：`banned` 永久；`muted`/`risk`
 * 以 `until` 为准，缺省 `until` 视作**已过期**——一条 `until` 缺失的禁言记录
 * 不该把账号永久锁死。
 */
export function isDeepseekTokenParked(rec: DeepseekTokenRecord, now = Date.now()): boolean {
  const park = rec.park
  if (!park) return false
  if (park.kind === 'banned') return true
  if (park.until === undefined) return false
  return park.until > now
}

/**
 * 由上游错误算出一条 park（**纯函数**，便于测试与「先本地生效、再落 KV」）。
 *
 * 窗口规则逐条对齐 Go 版 `Lease.NoteError`：
 *  - `banned`：永久（无 `until`）；
 *  - `muted`：用上游 `mute_until`；缺失或已过期则退化为 `MUTE_PARK_DEFAULT_MS`；
 *  - `risk`：固定 `RISK_COOLDOWN_MS`（上游不给窗口）。
 */
export function computeDeepseekPark(
  kind: DeepseekParkKind,
  opts: { until?: Date | null; reason: string; now?: number } = { reason: '' },
): DeepseekPark {
  const now = opts.now ?? Date.now()
  const park: DeepseekPark = { kind, reason: opts.reason, at: now }
  if (kind === 'banned') return park
  if (kind === 'risk') {
    park.until = now + DEEPSEEK_RISK_COOLDOWN_MS
    return park
  }
  const until = opts.until ?? null
  const untilMs = until ? until.getTime() : NaN
  park.until = Number.isFinite(untilMs) && untilMs > now ? untilMs : now + DEEPSEEK_MUTE_PARK_DEFAULT_MS
  return park
}

/** 把一条 park 写进池（按面板 id）。返回更新后的记录，未命中返回 null。 */
export async function parkDeepseekToken(
  env: Env,
  id: string,
  park: DeepseekPark,
): Promise<DeepseekTokenRecord | null> {
  const tokens = await readDeepseekPool(env)
  const rec = tokens.find((t) => t.id === id)
  if (!rec) return null
  rec.park = park
  rec.lastError = park.reason
  rec.lastErrorAt = park.at
  await writeDeepseekPool(env, tokens)
  return rec
}

/** 人工解除 park（面板「解除」按钮；Go 版对应手工删 accounts.json 里的 park 字段）。 */
export async function unparkDeepseekToken(env: Env, id: string): Promise<DeepseekTokenRecord | null> {
  const tokens = await readDeepseekPool(env)
  const rec = tokens.find((t) => t.id === id)
  if (!rec) return null
  if (rec.park === undefined) return rec
  delete rec.park
  await writeDeepseekPool(env, tokens)
  return rec
}

/**
 * 清除**已过期**的 park（惰性、幂等）。
 *
 * 为什么必须回写：过期 park 留在 KV 里，重启后会被当成「仍在 park」重新装载
 * （Go 版 `TestRestartExpiredParkRotatesNormally` 测的正是这条）。返回被清掉的条数，
 * 只有真的清了才写 KV。
 */
export async function clearExpiredDeepseekParks(
  env: Env,
  tokens: DeepseekTokenRecord[],
  now = Date.now(),
): Promise<number> {
  const expired = tokens.filter((t) => t.park !== undefined && !isDeepseekTokenParked(t, now))
  if (expired.length === 0) return 0
  for (const t of expired) delete t.park
  await writeDeepseekPool(env, tokens)
  return expired.length
}

/** 读取整池。键不存在/内容损坏都当空池处理——空池是合法状态（面板会提示注入）。 */
export async function readDeepseekPool(env: Env): Promise<DeepseekTokenRecord[]> {
  try {
    const raw = await env.KV.get(KV_KEYS.DEEPSEEK_POOL)
    if (!raw) return []
    const parsed = JSON.parse(raw) as { tokens?: unknown }
    if (!Array.isArray(parsed.tokens)) return []
    return parsed.tokens.filter(isRecord)
  } catch {
    return []
  }
}

export async function writeDeepseekPool(env: Env, tokens: DeepseekTokenRecord[]): Promise<void> {
  await env.KV.put(KV_KEYS.DEEPSEEK_POOL, JSON.stringify({ tokens }))
}

export interface AddTokenInput {
  token: string
  headerDeviceId: string
  userAgent: string
  shumeiDeviceId?: string
  label?: string
}

export interface AddTokenResult {
  ok: boolean
  record?: DeepseekTokenRecord
  duplicate?: DeepseekTokenRecord
  error?: string
}

function shortId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 10)
}

/** 注入一条 token。重复（同一 token）不覆盖，返回既有记录。 */
export async function addDeepseekToken(env: Env, input: AddTokenInput): Promise<AddTokenResult> {
  const token = (input.token ?? '').trim()
  if (!token) return { ok: false, error: 'token is required' }
  if (!(input.headerDeviceId ?? '').trim()) return { ok: false, error: 'headerDeviceId is required' }

  const tokens = await readDeepseekPool(env)
  const existing = tokens.find((t) => t.token === token)
  if (existing) return { ok: false, duplicate: existing }

  const record: DeepseekTokenRecord = {
    id: shortId(),
    token,
    headerDeviceId: input.headerDeviceId.trim(),
    userAgent: (input.userAgent ?? '').trim(),
    shumeiDeviceId: input.shumeiDeviceId?.trim() || undefined,
    label: input.label?.trim() || undefined,
    state: 'ready',
    addedAt: Date.now(),
  }
  tokens.push(record)
  await writeDeepseekPool(env, tokens)
  return { ok: true, record }
}

/** 按面板 id 删除。返回是否真的删掉了。 */
export async function removeDeepseekToken(env: Env, id: string): Promise<DeepseekTokenRecord | null> {
  const tokens = await readDeepseekPool(env)
  const idx = tokens.findIndex((t) => t.id === id)
  if (idx < 0) return null
  const [removed] = tokens.splice(idx, 1)
  await writeDeepseekPool(env, tokens)
  return removed
}

/**
 * 标记状态/错误（40003/token 过期）。重复标记安全。
 *
 * `ok: true` 时同时清掉 park：能成功就说明处罚窗口已经过去（park 期间根本不会被
 * 取到，所以走到这里只可能是「已过期但字段还在」）——这正是 Go 版的「自然解禁
 * 要回写持久层」那条，否则重启会把过期 park 重新装载。
 */
export async function markDeepseekToken(
  env: Env,
  id: string,
  patch: { state?: DeepseekTokenState; error?: string; ok?: boolean },
): Promise<DeepseekTokenRecord | null> {
  const tokens = await readDeepseekPool(env)
  const rec = tokens.find((t) => t.id === id)
  if (!rec) return null
  const now = Date.now()
  if (patch.state) rec.state = patch.state
  if (patch.error !== undefined) {
    rec.lastError = patch.error
    rec.lastErrorAt = now
  }
  if (patch.ok) {
    rec.lastOkAt = now
    rec.lastError = undefined
    rec.lastErrorAt = undefined
    rec.state = 'ready'
    delete rec.park
  }
  await writeDeepseekPool(env, tokens)
  return rec
}

/** 池内可用 token 数（面板提示用）：状态 ready 且不在 park 窗口内。 */
export function countReady(tokens: DeepseekTokenRecord[], now = Date.now()): number {
  return tokens.filter((t) => t.state === 'ready' && !isDeepseekTokenParked(t, now)).length
}

// ===== 运行态轮转（per isolate）=====

interface RotatorState {
  cursor: number
  inflight: Map<string, number>
}

const rotatorStates = new Map<string, RotatorState>()

/** 每 token 并发上限（上游对同一账号并发敏感，2 是本仓库其他池的默认值）。 */
export const DEEPSEEK_DEFAULT_MAX_INFLIGHT = 2

export interface AcquiredToken {
  record: DeepseekTokenRecord
  release: () => void
}

/**
 * 取一条可用 token（严格轮转 + 每 token 在飞上限 + **跳过 park 中的 token**）。
 * 无可用 token（空池/全部失效/全部 park/全部在飞）返回 null，由调用方给出明确错误。
 *
 * `now` 可注入：park 到期判定要能被测试固定（与 Go 版 `healthNow(pa, now)` 同形态）。
 */
export function acquireDeepseekToken(
  poolKey: string,
  tokens: DeepseekTokenRecord[],
  maxInflight = DEEPSEEK_DEFAULT_MAX_INFLIGHT,
  now = Date.now(),
): AcquiredToken | null {
  const ready = tokens.filter((t) => t.state === 'ready' && !isDeepseekTokenParked(t, now))
  if (ready.length === 0) return null

  let state = rotatorStates.get(poolKey)
  if (!state) {
    state = { cursor: 0, inflight: new Map() }
    rotatorStates.set(poolKey, state)
  }

  for (let i = 0; i < ready.length; i++) {
    const idx = (state.cursor + i) % ready.length
    const rec = ready[idx]
    const inflight = state.inflight.get(rec.id) ?? 0
    if (inflight >= maxInflight) continue
    state.inflight.set(rec.id, inflight + 1)
    state.cursor = (idx + 1) % ready.length
    return {
      record: rec,
      release: () => {
        const cur = state?.inflight.get(rec.id) ?? 0
        if (cur <= 1) state?.inflight.delete(rec.id)
        else state?.inflight.set(rec.id, cur - 1)
      },
    }
  }
  return null
}

/** 测试用：清掉轮转运行态。 */
export function resetDeepseekRotatorForTest(): void {
  rotatorStates.clear()
}

function isRecord(v: unknown): v is DeepseekTokenRecord {
  return (
    v !== null &&
    typeof v === 'object' &&
    typeof (v as DeepseekTokenRecord).id === 'string' &&
    typeof (v as DeepseekTokenRecord).token === 'string'
  )
}
