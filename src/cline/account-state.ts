/**
 * Cline 账号的运行状态（额度耗尽 / 上游限流 / 余额不足 / 凭据失效 / 推理空转）——面板可见的真值。
 *
 * 为什么必须落 KV，而不是面板直接读内存池：
 *   `Pool.accounts[].cooldownUntil` 与 `modelCooldowns` 是 **isolate 内存**里的对象（proxy.ts 的
 *   `pools` Map）。面板请求与业务流量不保证落在同一个 isolate，重启/部署也会清零。直接把内存状态
 *   喂给面板，最常见的结果是「账号明明正被冷却，面板显示一切正常」——正是要消灭的那种谎报。
 *   所以状态在**冷却发生的那一刻**写 KV，面板从 KV 读，任何 isolate、任何时候都看得到同一份事实。
 *
 * 为什么读的时候按 `until` 判活、而不是只靠 KV TTL：
 *   TTL 只能保证「记录最终会消失」，保证不了「冷却一到期就显示正常」。面板要的是后者，
 *   所以 `describeClineAccountState` 以 `now` 与 `until` 比较为准；TTL 只是防遗留垃圾无限堆积。
 *
 * 为什么写要节流（`CLINE_ACCOUNT_STATE_WRITE_GAP_MS`）：
 *   KV 写配额是全功能共享的（系统日志、渠道留档、流量留档、提供商配置）。冷却中的账号在持续
 *   流量下会**每个请求**失败一次、每次都触发一次冷却——逐次落盘能把配额写爆，而配额耗尽的
 *   后果是提供商配置都存不进去。故同一账号同一原因 30 秒内只落一次盘。代价是面板显示的是
 *   「最近一次落盘的冷却事实」，最多滞后 30 秒；因为读取按 `until` 判活且 `until` 只会被写长，
 *   滞后只会让状态**更早**显示为已到期，绝不把已冷却的账号显示成正常。
 */
import type { Env } from '../types'
import { formatRemaining } from '../remaining'

/** 冷却原因分类。字符串是落 KV 的稳定契约，不要随文案改。 */
export type ClineAccountStateKind =
  /** 免费档空响应（官方免费额度耗尽）：60s 冷却。 */
  | 'quota_empty'
  /** 402 余额/权益不足（credits 计费档模型）：模型级冷却。 */
  | 'plan_exhausted'
  /** 429 上游限流：冷却 + 切号。 */
  | 'rate_limited'
  /** 401 或 refresh 失败：凭据问题。 */
  | 'auth'
  /** 推理空转被截断（预算烧在 reasoning 上）：短冷却。 */
  | 'runaway'

export interface ClineAccountState {
  /** 对应 provider.apiKeys 的下标；与 `masked` 一起构成「这条记录说的是哪个账号」的判据。 */
  index: number
  /** 掩码后的 refreshToken（只留末 4 位）。换号后与当前值不符 → 该记录作废，不做任何猜测。 */
  masked: string
  kind: ClineAccountStateKind
  /** 冷却截止时刻（毫秒）。**是网关自己的禁入窗口，不是上游额度恢复时刻**。 */
  until: number
  /** 记录时刻（毫秒）。 */
  at: number
  /** 触发冷却的模型（模型级冷却才有；账号级为 null）。 */
  model: string | null
  /** 上游原文摘要或网关自述，截断后用于面板 tooltip。 */
  reason: string
}

export const CLINE_ACCOUNT_STATE_PREFIX = 'cline:acctstate:'
/** 24h：覆盖最长冷却（402 的 12h）并留一倍余量；到期判活仍以 `until` 为准。 */
export const CLINE_ACCOUNT_STATE_TTL_SEC = 24 * 3600
/** 同一账号同一原因的最小落盘间隔。见文件头「为什么写要节流」。 */
export const CLINE_ACCOUNT_STATE_WRITE_GAP_MS = 30 * 1000
/** 单提供商最多留档多少条账号状态（防异常情况下无限增长）。 */
const CLINE_ACCOUNT_STATE_CAP = 50

/**
 * 免费档额度耗尽的判据（官方 cline/cline 客户端同款做法）。
 *
 * 一手依据：`Daily free model limit reached on model … Try again in 23h 59m` 是官方客户端
 * `apps/cli/src/utils/cline-pass-errors.ts` 匹配的文案，它把「今天这个模型的免费额度用完了」
 * 与「普通限流」区分开——两者都是 429，但前者该显示成额度耗尽，后者才是限流。
 *
 * `INFERENCE_CAP_ERROR` 只在第三方实现（bouderer/cline2api）的正则里出现，官方源码未取证；
 * 命中最坏后果只是把标签判成「额度耗尽」（冷却时长与切号行为都由调用方另行决定），故保留。
 */
const CLINE_FREE_LIMIT_RE = /daily free (?:model )?limit|free limit reached|free tier.*limit|INFERENCE_CAP_ERROR|quota exceeded/i

/** 该失败是否表示免费额度耗尽（而不只是被限流）。 */
export function isClineFreeLimitError(status: number, text: string): boolean {
  if (status < 400) return false
  return CLINE_FREE_LIMIT_RE.test(text || '')
}

/**
 * 按上游状态码与原文决定冷却原因分类：同为 429，额度耗尽与限流要分开显示。
 * 402（credits 计费档余额不足）与空响应（免费档额度耗尽）由调用方直接给分类，不走这里。
 */
export function classifyClineCooldownKind(status: number, text: string): ClineAccountStateKind {
  if (isClineFreeLimitError(status, text)) return 'quota_empty'
  return 'rate_limited'
}

/** 面板用掩码：只露末 4 位，绝不落完整 refreshToken。 */
export function maskClineToken(key: string): string {
  const k = (key || '').trim()
  return k.length > 4 ? `****${k.slice(-4)}` : '****'
}

/** 截断上游原文，避免把整段 JSON/HTML 塞进 KV 与面板。 */
function trimReason(text: string): string {
  const flat = (text || '').replace(/\s+/g, ' ').trim()
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat
}

/** in-isolate 写节流：`providerId|index` → 上次落盘时刻与内容。 */
const lastWrites = new Map<string, { at: number; state: ClineAccountState }>()

/** 单测用：清空节流表，避免用例之间互相压制。 */
export function __resetClineAccountStateForTests(): void {
  lastWrites.clear()
}

/**
 * 同一条记录「内容是否变了」。`until` 每次冷却都会往前推，若把它算作变化则节流形同虚设，
 * 故只在**原因/模型**变化时视为变化；`until` 取最晚值（单调写长，旧写不许把冷却写短）。
 */
function isSameCause(a: ClineAccountState, b: ClineAccountState): boolean {
  return a.kind === b.kind && a.model === b.model && a.masked === b.masked
}

function normalizeEntry(raw: unknown): ClineAccountState | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const kind = r.kind
  if (
    kind !== 'quota_empty' && kind !== 'plan_exhausted' && kind !== 'rate_limited' &&
    kind !== 'auth' && kind !== 'runaway'
  ) return null
  const until = Number(r.until)
  const at = Number(r.at)
  if (!Number.isFinite(until) || !Number.isFinite(at)) return null
  return {
    index: Number(r.index) || 0,
    masked: typeof r.masked === 'string' ? r.masked : '',
    kind,
    until,
    at,
    model: typeof r.model === 'string' && r.model ? r.model : null,
    reason: typeof r.reason === 'string' ? r.reason : '',
  }
}

/** 读一个提供商的全部账号状态（无则空数组；任何脏值都被丢弃，绝不猜）。 */
export async function readClineAccountStates(env: Env | undefined, providerId: string): Promise<ClineAccountState[]> {
  if (!env?.KV) return []
  try {
    const raw = await env.KV.get(CLINE_ACCOUNT_STATE_PREFIX + providerId)
    if (!raw) return []
    const parsed = JSON.parse(raw) as { states?: unknown }
    const list = parsed?.states
    if (!Array.isArray(list)) return []
    return list.map(normalizeEntry).filter((s): s is ClineAccountState => s !== null)
  } catch { return [] }
}

/**
 * 记录一次账号冷却。同账号同原因在节流窗口内重复触发时**跳过落盘**（内存冷却照旧生效）。
 * 永不抛错：状态留档失败不该影响请求本身。
 */
export async function recordClineAccountState(
  env: Env | undefined,
  providerId: string,
  entry: Omit<ClineAccountState, 'reason'> & { reason?: string }
): Promise<void> {
  if (!env?.KV) return
  const next: ClineAccountState = { ...entry, reason: trimReason(entry.reason || '') }
  const throttleKey = providerId + '|' + next.index
  const now = Date.now()
  const prevWrite = lastWrites.get(throttleKey)
  if (prevWrite && isSameCause(prevWrite.state, next) && now - prevWrite.at < CLINE_ACCOUNT_STATE_WRITE_GAP_MS) {
    return
  }
  lastWrites.set(throttleKey, { at: now, state: next })
  try {
    const existing = await readClineAccountStates(env, providerId)
    const merged = existing.filter((s) => s.index !== next.index)
    // 冷却窗口只许写长：并发/乱序下旧写不能把已记录的 until 提前（同流量留档的"新者胜"纪律）
    const older = existing.find((s) => s.index === next.index && isSameCause(s, next))
    merged.push(older && older.until > next.until ? { ...next, until: older.until } : next)
    merged.sort((a, b) => a.index - b.index)
    await env.KV.put(
      CLINE_ACCOUNT_STATE_PREFIX + providerId,
      JSON.stringify({ states: merged.slice(0, CLINE_ACCOUNT_STATE_CAP) }),
      { expirationTtl: CLINE_ACCOUNT_STATE_TTL_SEC }
    )
  } catch { /* 留档失败不影响本次请求；下一次冷却会再试 */ }
}

/**
 * 清除某账号的状态（该账号成功产出响应时调用）。
 *
 * 为什么必须清：免费额度是按窗口恢复的，上一轮的「额度耗尽」不能挂到恢复之后——
 * 面板会长期显示一个已经不成立的结论。清除只在该账号真的有成功请求时发生，不做定时猜测。
 */
export async function clearClineAccountState(env: Env | undefined, providerId: string, index: number): Promise<void> {
  if (!env?.KV) return
  // 本地节流表也要清，否则「清完又冷却」会被上一次的节流误压掉
  lastWrites.delete(providerId + '|' + index)
  try {
    const existing = await readClineAccountStates(env, providerId)
    if (!existing.some((s) => s.index === index)) return
    const states = existing.filter((s) => s.index !== index)
    await env.KV.put(
      CLINE_ACCOUNT_STATE_PREFIX + providerId,
      JSON.stringify({ states }),
      { expirationTtl: CLINE_ACCOUNT_STATE_TTL_SEC }
    )
  } catch { /* 清除失败不影响请求 */ }
}

/**
 * 同账号换了凭据（上游轮换 refreshToken）时，把留档的掩码改写成新值。
 *
 * 为什么需要：留档靠 `index + masked` 认账号，而 OAuth 轮换会让 refreshToken 变新——同一个账号、
 * 同一份冷却，掩码却不再匹配。不改写的话，一次轮换就会把「额度耗尽被冷却」判成「不是这个账号」
 * 而丢弃，面板重新显示健康（正是要消灭的谎报）。轮换极少发生，所以这里只做最小改写、不做迁移逻辑。
 *
 * 只在**当前掩码确实对应这条留档的旧掩码**时由调用方调用；找不到记录时静默返回（不新建记录）。
 */
export async function rekeyClineAccountState(
  env: Env | undefined,
  providerId: string,
  index: number,
  masked: string
): Promise<void> {
  if (!env?.KV) return
  try {
    const existing = await readClineAccountStates(env, providerId)
    const target = existing.find((s) => s.index === index)
    if (!target || target.masked === masked) return
    const states = existing.map((s) => (s.index === index ? { ...s, masked } : s))
    await env.KV.put(
      CLINE_ACCOUNT_STATE_PREFIX + providerId,
      JSON.stringify({ states }),
      { expirationTtl: CLINE_ACCOUNT_STATE_TTL_SEC }
    )
    // 节流表里的旧掩码也要跟上，否则下一次同原因冷却会被判成"原因变了"而多写一次
    const throttleKey = providerId + '|' + index
    const prev = lastWrites.get(throttleKey)
    if (prev) lastWrites.set(throttleKey, { at: prev.at, state: { ...prev.state, masked } })
  } catch { /* 改写失败不影响请求；下次冷却会重新落档 */ }
}

/** 冷却原因的中文短标签（面板徽章用）。 */
const KIND_LABEL: Record<ClineAccountStateKind, string> = {
  quota_empty: '额度耗尽',
  plan_exhausted: '余额/权益不足',
  rate_limited: '上游限流',
  auth: '凭据失效',
  runaway: '推理空转',
}

/** 剩余时长的紧凑写法：`11h59m` / `8m` / `30s`。
 *
 * 实现已移到 `src/remaining.ts`（WorkBuddy/Qoder 池共用同一份文案），此处只做转出，
 * 保持既有调用方与测试的 import 路径不变。
 */
export { formatRemaining }

export interface ClineAccountStateView {
  /** 该状态此刻是否仍生效（冷却未到期）。false 时面板不该显示任何徽章。 */
  active: boolean
  /** 徽章文案，如「额度耗尽 · 冷却 52s」；未生效时为空串。 */
  label: string
  /** tooltip：原因 + 模型 + 一句「until 是网关冷却窗口，不是额度恢复时刻」。 */
  detail: string
  remainingMs: number
}

/**
 * 把一条留档翻译成面板可直接渲染的东西。**纯函数**：面板文案的唯一真源在服务端，
 * 客户端只负责画，不自己算时间、不自己拼结论（否则两端口径迟早分叉）。
 */
export function describeClineAccountState(state: ClineAccountState, now: number): ClineAccountStateView {
  const remainingMs = Math.max(0, state.until - now)
  const active = remainingMs > 0
  const kindLabel = KIND_LABEL[state.kind] || state.kind
  const parts = [
    `原因：${kindLabel}`,
    state.model ? `模型：${state.model}` : '范围：整个账号',
    `冷却至：${new Date(state.until).toLocaleString()}`,
    '（该时间是网关的禁入窗口，不代表上游额度已恢复）',
  ]
  if (state.reason) parts.push(`上游原文：${state.reason}`)
  return {
    active,
    label: active ? `${kindLabel} · 冷却 ${formatRemaining(remainingMs)}` : '',
    detail: parts.join(' · '),
    remainingMs,
  }
}
