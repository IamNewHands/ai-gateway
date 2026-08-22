/**
 * perf.ts — 性能设置（超时分级配置化）。
 *
 * 网关默认按 opencode 路径的经验值写死连接/首字节/idle/整体超时。这里把
 * 通用转发（OpenAI / OAuth / Anthropic / Responses）统一改为读取可配置的性能设置：
 * - totalTimeoutMs    非流式请求整体超时（首字节+读体）
 * - connectTimeoutMs  流式请求连接/首字节超时（拿到 response 后不再生效）
 * - idleTimeoutMs     流式请求上游无数据 idle 兜底（自动结束防挂起）
 * - keepAliveMs       向客户端注入 SSE 心跳注释行的空闲阈值（防客户端断流）
 *
 * 存储于 KV（KV_KEYS.PERF_SETTINGS），管理后台可编辑；未设置时回退内置默认。
 * 带 10s 内存缓存，改动后最多一个 TTL 内生效。
 */

import { KV_KEYS } from './config'
import type { Env } from './types'

export interface PerfSettings {
  /** 非流式请求整体超时（毫秒） */
  totalTimeoutMs: number
  /** 流式请求连接/首字节超时（毫秒） */
  connectTimeoutMs: number
  /** 流式请求上游无数据 idle 超时（毫秒） */
  idleTimeoutMs: number
  /** 向客户端注入 SSE 心跳注释行的空闲阈值（毫秒，0 = 不注入心跳） */
  keepAliveMs: number
}

export const DEFAULT_PERF_SETTINGS: PerfSettings = {
  totalTimeoutMs: 300_000,
  connectTimeoutMs: 90_000,
  idleTimeoutMs: 240_000,
  keepAliveMs: 15_000,
}

const SETTINGS_TTL_MS = 10_000
const settingsCache = new Map<string, { settings: PerfSettings; at: number }>()

/** 安全解析 KV 中的性能设置：结构不符/数值非法时回退默认，避免 500 */
function normalize(raw: unknown): PerfSettings {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out = { ...DEFAULT_PERF_SETTINGS }
  const clampInt = (v: unknown, def: number, min: number, max: number): number => {
    const n = typeof v === 'number' && Number.isFinite(v) ? v : def
    return Math.min(max, Math.max(min, Math.round(n)))
  }
  out.totalTimeoutMs = clampInt(src['totalTimeoutMs'], DEFAULT_PERF_SETTINGS.totalTimeoutMs, 5_000, 3_600_000)
  out.connectTimeoutMs = clampInt(src['connectTimeoutMs'], DEFAULT_PERF_SETTINGS.connectTimeoutMs, 1_000, 300_000)
  out.idleTimeoutMs = clampInt(src['idleTimeoutMs'], DEFAULT_PERF_SETTINGS.idleTimeoutMs, 1_000, 600_000)
  out.keepAliveMs = clampInt(src['keepAliveMs'], DEFAULT_PERF_SETTINGS.keepAliveMs, 0, 120_000)
  return out
}

/** 读取当前生效的性能设置：KV 有则用之，否则回退内置默认。 */
export async function getPerfSettings(env: Env): Promise<PerfSettings> {
  const cached = settingsCache.get(KV_KEYS.PERF_SETTINGS)
  if (cached && Date.now() - cached.at <= SETTINGS_TTL_MS) return cached.settings
  let settings = DEFAULT_PERF_SETTINGS
  try {
    const raw = await env.KV.get(KV_KEYS.PERF_SETTINGS, 'json')
    settings = normalize(raw)
  } catch { /* KV 异常时用默认 */ }
  settingsCache.set(KV_KEYS.PERF_SETTINGS, { settings, at: Date.now() })
  return settings
}

/** 覆盖保存性能设置（部分字段合并，空对象 = 清空回退默认）。 */
export async function setPerfSettings(env: Env, partial: Partial<PerfSettings>): Promise<void> {
  const current = await getPerfSettings(env)
  const next = normalize({ ...current, ...(partial ?? {}) })
  const isDefault =
    next.totalTimeoutMs === DEFAULT_PERF_SETTINGS.totalTimeoutMs &&
    next.connectTimeoutMs === DEFAULT_PERF_SETTINGS.connectTimeoutMs &&
    next.idleTimeoutMs === DEFAULT_PERF_SETTINGS.idleTimeoutMs &&
    next.keepAliveMs === DEFAULT_PERF_SETTINGS.keepAliveMs
  if (isDefault) {
    await env.KV.delete(KV_KEYS.PERF_SETTINGS)
    settingsCache.delete(KV_KEYS.PERF_SETTINGS)
  } else {
    await env.KV.put(KV_KEYS.PERF_SETTINGS, JSON.stringify(next))
    settingsCache.set(KV_KEYS.PERF_SETTINGS, { settings: next, at: Date.now() })
  }
}

/** 是否已自定义（KV 中存在非默认值），用于后台显示「恢复默认」 */
export async function isPerfSettingsCustom(env: Env): Promise<boolean> {
  const raw = await env.KV.get(KV_KEYS.PERF_SETTINGS)
  return !!raw?.trim()
}
