/**
 * workbuddy-inflight.ts — WorkBuddy 池账号的**在途租约**（单账号并发上限）
 * （移植 workbuddy2api internal/pool/pool.go Acquire/Release + pick.go inFlightFull）。
 *
 * 目的：限制单个账号的并发在途请求数（`maxInFlight`，源实现默认 3），
 * 避免"同一账号被高并发打爆"——上游对单账号的并发/速率有风控，
 * 且单账号过载会放大 429/5xx，进而触发冷却。
 *
 * 选号侧配合：`isInFlightFull(uid)` 为 true 的账号不参与挑号（源实现 pick.go:63-65），
 * 使并发请求自然发散到其他健康账号，而非全撞同一个高分号。
 *
 * ⚠️ **Workers 多 isolate 局限（诚实标注）**：本实现用模块级 Map 计数，
 * 只在**同一 isolate 内**有效。Cloudflare Workers 会把同一 isolate 复用于多个并发请求
 * （热 isolate），因此它能拦住"同 isolate 并发打爆单号"这一最常见形态；
 * 但跨 isolate 的并发无法感知，实际并发上限是 `maxInFlight × 活跃 isolate 数`。
 *
 * 若要严格全局上限，需把计数放入 Durable Object（ai-gateway 已有 M365_SESSION /
 * M365_FLUX DO 基础设施可参照）。这里选择 isolate 内近似，理由：
 *  1. 零额外延迟与成本（DO 每请求一次 RPC 会显著增加 TTFB）；
 *  2. 风控的主要风险是"同一连接/同一时刻的并发尖峰"，isolate 内已能覆盖大部分；
 *  3. 与三因子选号的发散目标一致——计数只用于"排除已满号"，漏判不会造成错误，只是少一层保护。
 */
import type { Env } from './types'

/** 默认单账号在途上限（对齐 workbuddy2api config 默认 pool.max_in_flight = 3）。 */
export const DEFAULT_MAX_IN_FLIGHT = 3

/** uid（providerId:uid）→ 当前在途数。 */
const inFlight = new Map<string, number>()

/** 仅供测试：清空在途计数。 */
export function __resetInFlightForTests(): void {
  inFlight.clear()
}

const keyOf = (providerId: string, uid: string) => `${providerId}:${uid}`

/** 读取某账号当前在途数（观测用）。 */
export function inFlightOf(providerId: string, uid: string): number {
  return inFlight.get(keyOf(providerId, uid)) ?? 0
}

/**
 * 该账号是否已占满在途名额（源实现 pick.go:197-202 inFlightFull）。
 * maxInFlight <= 0 表示不限 → 恒 false。
 */
export function isInFlightFull(providerId: string, uid: string, maxInFlight: number = DEFAULT_MAX_IN_FLIGHT): boolean {
  if (maxInFlight <= 0) return false
  return inFlightOf(providerId, uid) >= maxInFlight
}

/**
 * 占用一个在途名额（源实现 Acquire）。
 * 返回 false 表示已满（调用方应换号）；maxInFlight <= 0 时不限但**仍计数**（供观测）。
 *
 * 注意：Workers 的 JS 单线程模型使本函数天然原子（无 await 点），
 * 不需要源实现那种 CAS 循环。
 */
export function acquireInFlight(providerId: string, uid: string, maxInFlight: number = DEFAULT_MAX_IN_FLIGHT): boolean {
  const k = keyOf(providerId, uid)
  const cur = inFlight.get(k) ?? 0
  if (maxInFlight > 0 && cur >= maxInFlight) return false
  inFlight.set(k, cur + 1)
  return true
}

/**
 * 释放在途名额（源实现 Release）。幂等：已为 0 时不做负数。
 * 调用方必须保证成功/失败路径都释放（见 proxy 的 try/finally 语义）。
 */
export function releaseInFlight(providerId: string, uid: string): void {
  const k = keyOf(providerId, uid)
  const cur = inFlight.get(k) ?? 0
  if (cur <= 0) return
  if (cur === 1) inFlight.delete(k)
  else inFlight.set(k, cur - 1)
}

/**
 * 解析 provider 上配置的在途上限（provider.oauth.maxInFlight 优先，否则默认）。
 * 非正数视为"不限"（与源实现 SetMaxInFlight 的 0=不限 语义一致）。
 */
export function resolveMaxInFlight(provider: { oauth?: { maxInFlight?: number } }): number {
  const v = provider.oauth?.maxInFlight
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_MAX_IN_FLIGHT
  return v
}

/** 供运维/面板观测：当前所有账号的在途快照。 */
export function inFlightSnapshot(): Array<{ key: string; count: number }> {
  return Array.from(inFlight.entries()).map(([key, count]) => ({ key, count }))
}

/** 类型别名：便于调用方标注。 */
export type InFlightEnv = Env
