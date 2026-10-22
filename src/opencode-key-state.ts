/**
 * OpenCode 每个 Key 的检查结果留档（面板可见的真值）。
 *
 * 为什么必须落 KV，而不是面板直接读内存：
 *   `src/opencode.ts` 的 `keyHealth`（失败计数 + cooldownUntil）是 **isolate 内存**，
 *   面板请求与业务流量不保证落在同一个 isolate，部署/回收还会清零。把内存状态直接喂给面板，
 *   最常见的后果是「这个 Key 明明刚从 401 掉下来，面板显示一切正常」——正是要消灭的谎报。
 *   所以检查结果在**用户点检测的那一刻**写 KV，面板从 KV 读，任何 isolate 都看到同一份事实。
 *
 * 为什么还要记 `masked`：
 *   面板按 `index + masked` 认「这条记录说的是哪个 Key」。同一行被换成另一个 Key 后，掩码不符
 *   就作废这条记录，不做任何猜测（与 cline/account-state.ts 同一纪律）。
 *
 * 为什么没有「自动关联账号邮箱」：
 *   Cline 能自动关联是因为 `/auth/refresh` 会回 `userInfo.email`。OpenCode（opencode.ai 的
 *   Zen / inference 兼容面）**不提供账号身份端点**：2026-10-22 实测 `/zen/v1/me`、
 *   `/zen/v1/usage`、`/inference/v1/me` 全部 404，只有 `/zen/v1/models` 公开可读（无 Key 也 200）。
 *   因此账号名只能是用户自己填的显示名（provider.apiKeys[i].label），面板绝不编造一个。
 */
import type { Env } from './types'
import type { OpenCodeKeyStatus } from './opencode'

/** 一条已落盘的检查结果。字符串状态沿用 `OpenCodeKeyStatus`（与 opcode2api debug.go 的分类对齐）。 */
export interface OpenCodeKeyState {
  /** 对应 provider.apiKeys 的下标；与 `masked` 一起构成「这条记录是哪个 Key」的判据。 */
  index: number
  /** 掩码后的 Key（只留末 4 位）。与当前 Key 不符 → 该记录作废。 */
  masked: string
  status: OpenCodeKeyStatus
  /** 上游原文摘要或网关自述，截断后用于面板 tooltip。 */
  message: string
  /** 上游 HTTP 状态码；无响应（网络错误）为 0。 */
  httpStatus: number
  /** 探测耗时（毫秒）。 */
  latencyMs: number
  /** 实际用于探测的模型；未探测为 null。 */
  model: string | null
  /** 记录时刻（毫秒）。 */
  at: number
}

export const OPENCODE_KEY_STATE_PREFIX = 'opencode:keystate:'
/** 7 天：检查是用户显式发起的低频动作，留久一点便于回溯；是否可信由面板显示的时刻决定。 */
export const OPENCODE_KEY_STATE_TTL_SEC = 7 * 24 * 3600
/** 单提供商最多留档多少条（防异常情况下无限增长）。 */
const OPENCODE_KEY_STATE_CAP = 50

/** 面板用掩码：只露末 4 位，绝不落完整 Key。 */
export function maskOpenCodeKey(key: string): string {
  const k = (key || '').trim()
  return k.length > 4 ? `****${k.slice(-4)}` : '****'
}

/** 截断上游原文，避免把整段 JSON/HTML 塞进 KV 与面板。 */
function trimMessage(text: string): string {
  const flat = (text || '').replace(/\s+/g, ' ').trim()
  return flat.length > 240 ? `${flat.slice(0, 240)}…` : flat
}

const VALID_STATUS: OpenCodeKeyStatus[] = [
  'usable', 'rejected', 'rate_limited', 'transport_error', 'upstream_error', 'request_error', 'unavailable',
]

function isStatus(v: unknown): v is OpenCodeKeyStatus {
  return typeof v === 'string' && (VALID_STATUS as string[]).includes(v)
}

function normalizeEntry(raw: unknown): OpenCodeKeyState | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!isStatus(r.status)) return null
  const at = Number(r.at)
  const index = Number(r.index)
  if (!Number.isFinite(at) || !Number.isFinite(index)) return null
  const httpStatus = Number(r.httpStatus)
  const latencyMs = Number(r.latencyMs)
  return {
    index,
    masked: typeof r.masked === 'string' ? r.masked : '',
    status: r.status,
    message: typeof r.message === 'string' ? r.message : '',
    httpStatus: Number.isFinite(httpStatus) ? httpStatus : 0,
    latencyMs: Number.isFinite(latencyMs) ? latencyMs : 0,
    model: typeof r.model === 'string' && r.model ? r.model : null,
    at,
  }
}

/** 读一个提供商的全部 Key 检查留档（无则空数组；任何脏值都被丢弃，绝不猜）。 */
export async function readOpenCodeKeyStates(env: Env | undefined, providerId: string): Promise<OpenCodeKeyState[]> {
  if (!env?.KV) return []
  try {
    const raw = await env.KV.get(OPENCODE_KEY_STATE_PREFIX + providerId)
    if (!raw) return []
    const parsed = JSON.parse(raw) as { states?: unknown }
    const list = parsed?.states
    if (!Array.isArray(list)) return []
    return list.map(normalizeEntry).filter((s): s is OpenCodeKeyState => s !== null)
  } catch { return [] }
}

/**
 * 落一条检查结果（按 index 覆盖）。
 *
 * 永不抛错：留档失败不该让「检查」这个动作本身报错——面板仍会显示本次响应里的实时结果，
 * 只是下次展开卡片时看不到它。
 */
export async function recordOpenCodeKeyState(
  env: Env | undefined,
  providerId: string,
  state: OpenCodeKeyState
): Promise<void> {
  if (!env?.KV) return
  const next: OpenCodeKeyState = { ...state, message: trimMessage(state.message) }
  try {
    const existing = await readOpenCodeKeyStates(env, providerId)
    const merged = existing.filter((s) => s.index !== next.index)
    merged.push(next)
    merged.sort((a, b) => a.index - b.index)
    await env.KV.put(
      OPENCODE_KEY_STATE_PREFIX + providerId,
      JSON.stringify({ states: merged.slice(0, OPENCODE_KEY_STATE_CAP) }),
      { expirationTtl: OPENCODE_KEY_STATE_TTL_SEC }
    )
  } catch { /* 留档失败不影响检查结论；下次检测会再写 */ }
}

/** 状态的中文短标签 + 徽章色调。文案是服务端的唯一真源，客户端只负责画。 */
const STATUS_VIEW: Record<OpenCodeKeyStatus, { label: string; tone: 'on' | 'warn' | 'danger' | 'off' }> = {
  usable: { label: '可用', tone: 'on' },
  rejected: { label: 'Key 被拒', tone: 'danger' },
  rate_limited: { label: '限流', tone: 'warn' },
  upstream_error: { label: '上游故障', tone: 'warn' },
  request_error: { label: '请求被拒', tone: 'warn' },
  transport_error: { label: '网络错误', tone: 'danger' },
  unavailable: { label: '未测出', tone: 'off' },
}

export interface OpenCodeKeyStateView {
  /** 徽章文案，如「可用 · 312ms」。 */
  label: string
  /** 徽章样式后缀：`bd-on` / `bd-warn` / `bd-danger` / `bd-off`。 */
  tone: 'on' | 'warn' | 'danger' | 'off'
  /** tooltip：状态 + 模型 + HTTP 码 + 报文 + 检查时刻。 */
  detail: string
  /** 已过去多久（毫秒），面板用它写「5 分钟前」。 */
  ageMs: number
}

/**
 * 把一条留档翻译成面板可直接渲染的东西。**纯函数**：面板文案的唯一真源在服务端，
 * 客户端不自己拼结论（否则两端口径迟早分叉）。
 */
export function describeOpenCodeKeyState(state: OpenCodeKeyState, now: number): OpenCodeKeyStateView {
  const view = STATUS_VIEW[state.status] || STATUS_VIEW.unavailable
  const latency = state.latencyMs > 0 ? ` · ${state.latencyMs}ms` : ''
  const parts = [
    `状态：${view.label}`,
    state.model ? `模型：${state.model}` : '',
    state.httpStatus ? `HTTP ${state.httpStatus}` : '',
    `检查于：${new Date(state.at).toLocaleString()}`,
    state.message ? `报文：${state.message}` : '',
  ].filter(Boolean)
  return {
    label: `${view.label}${latency}`,
    tone: view.tone,
    detail: parts.join(' · '),
    ageMs: Math.max(0, now - state.at),
  }
}
