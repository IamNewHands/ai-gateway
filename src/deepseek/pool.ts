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
 */

import { KV_KEYS } from '../config'
import type { Env } from '../types'

export type DeepseekTokenState = 'ready' | 'expired'

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
  tokenTail: string
  addedAt: number
  lastOkAt?: number
  lastErrorAt?: number
  lastError?: string
}

export function toTokenView(rec: DeepseekTokenRecord): DeepseekTokenView {
  return {
    id: rec.id,
    label: rec.label,
    state: rec.state,
    tokenTail: rec.token.slice(-6),
    addedAt: rec.addedAt,
    lastOkAt: rec.lastOkAt,
    lastErrorAt: rec.lastErrorAt,
    lastError: rec.lastError,
  }
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

/** 标记失效（40003/token 过期）。重复标记安全。 */
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
  }
  await writeDeepseekPool(env, tokens)
  return rec
}

/** 池内失效 token 数（面板提示用）。 */
export function countReady(tokens: DeepseekTokenRecord[]): number {
  return tokens.filter((t) => t.state === 'ready').length
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
 * 取一条可用 token（严格轮转 + 每 token 在飞上限）。
 * 无可用 token（空池/全部失效/全部在飞）返回 null，由调用方给出明确错误。
 */
export function acquireDeepseekToken(
  poolKey: string,
  tokens: DeepseekTokenRecord[],
  maxInflight = DEEPSEEK_DEFAULT_MAX_INFLIGHT,
): AcquiredToken | null {
  const ready = tokens.filter((t) => t.state === 'ready')
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
