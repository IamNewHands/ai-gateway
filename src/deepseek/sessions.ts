/**
 * deepseek/sessions.ts — 会话生命周期后台维护（移植自 simple-chat
 * `internal/server/sessioncleanup.go` / `sessionpurge.go` / `sessionpolicy.go`）。
 *
 * 四块职责：
 *  1. `listSessions` —— 上游真实抽屉（fetch_page，游标分页，最多 50 页）。
 *  2. `runSessionCleanup` ——「人类节奏」清理：抖动唤醒、只删最老的 1–3 个未置顶会话，
 *     且仅当未置顶会话数超过 floor（默认 5）。
 *  3. `runSessionPurge` —— 每周 `delete_all`（默认周日 04:00 ±30m），启动时若最近
 *     一个窗口在 24h 内且尚未跑过则补跑一次；失败下周再试，**不风暴重试**。
 *  4. `enforceSessionCap` —— `DEEPSEEK_SESSION_CAP` 硬上限：建会话后同步淘汰最老的。
 *
 * 与 Go 版的运行时差异（Workers 没有常驻 goroutine、没有异步删除队列）：
 *  - 没有后台 loop：每个 `run*` 是「一次唤醒」，由调用方（cron / scheduled handler）
 *    触发。下一次唤醒时间由函数返回（`nextFireAt`）并写进 KV 标记，于是「N 小时
 *    ±50%」与「每周同一时刻」在无状态运行时里依然成立，且不是一个可学习的固定钟点。
 *  - 没有 async deleter：删除是 await 的顺序调用（删除间隔仍按 1–6s 抖动，可注入
 *    `sleep`）。一次 run 内顺序 await 天然解决了 Go 版 pending 去重表要防的问题
 *    （同一会话被相邻两次 episode 重复入队）。
 *  - 每周清空的「补跑一次」（catch-up）靠 KV 标记保证：Workers 每次 cron 都是新
 *    isolate，只按时间判断会在 24h 窗口内反复补跑。
 *  - 时间默认按 UTC 计算（Go 用本机 local 时区）。需要北京时间语义时传
 *    `opts.utcOffsetMinutes = 480`。
 *  - Go 配置写错是 `log.Fatalf`（进程退出）；Worker 里非法值回退默认值 + 一行 warning。
 */

import type { Env } from '../types'
import { DeepseekClient, isAuthFailure, type Envelope, type FetchLike } from './client'
import { isDeepseekTokenParked, markDeepseekToken, parkDeepseekToken, readDeepseekPool, type DeepseekTokenRecord } from './pool'
import { parkFromError, webHeaders } from './proxy'

// ===== 常量（对齐 Go 版 Default* 常量）=====

/** 人类节奏清理的基准唤醒间隔（Go `DefaultCleanupInterval`）。 */
export const DEEPSEEK_CLEANUP_DEFAULT_INTERVAL_MS = 60 * 60 * 1000
/** 未置顶会话数 ≤ 此值时一次 episode 什么都不删（Go `DefaultCleanupFloor`）。 */
export const DEEPSEEK_CLEANUP_DEFAULT_FLOOR = 5
/** 每次唤醒里单个账号成为一次 episode 的概率（Go `DefaultCleanupProbability`）。 */
export const DEEPSEEK_CLEANUP_DEFAULT_PROBABILITY = 0.5
/** 一次 episode 删除数量的上下界（Go `MinCleanupBatch`/`MaxCleanupBatch`）。 */
export const DEEPSEEK_CLEANUP_MIN_BATCH = 1
export const DEEPSEEK_CLEANUP_MAX_BATCH = 3
/** episode 内两次删除之间的抖动间隔（Go `DefaultCleanupGapMin/Max`）。 */
export const DEEPSEEK_CLEANUP_GAP_MIN_MS = 1000
export const DEEPSEEK_CLEANUP_GAP_MAX_MS = 6000
/** fetch_page 分页上限（Go `maxSessionPages`）。 */
export const DEEPSEEK_MAX_SESSION_PAGES = 50

/** 每周清空默认：周日（周一基准 0=Mon..6=Sun）04:00（Go `DefaultPurge*`）。 */
export const DEEPSEEK_PURGE_DEFAULT_WEEKDAY = 6
export const DEEPSEEK_PURGE_DEFAULT_HOUR = 4
/** 触发时刻的 ±抖动（Go `DefaultPurgeJitter`）。 */
export const DEEPSEEK_PURGE_DEFAULT_JITTER_MS = 30 * 60 * 1000
/** 进程错过、且窗口在这么久以内 → 补跑一次（Go `purgeCatchUpWindow`）。 */
export const DEEPSEEK_PURGE_CATCHUP_WINDOW_MS = 24 * 60 * 60 * 1000
/** 补跑的启动延迟抖动（Go `purgeCatchUpDelayMin/Max`）：永不「一启动就打」。 */
export const DEEPSEEK_PURGE_CATCHUP_DELAY_MIN_MS = 2000
export const DEEPSEEK_PURGE_CATCHUP_DELAY_MAX_MS = 12000

/** 下一次清理唤醒时间的 KV 标记键（无状态运行时里的「睡眠」替身）。 */
export const DEEPSEEK_CLEANUP_MARKER_KEY = 'deepseek:sessions:cleanup:next'
/** 上一次每周清空真正跑过的时刻（补跑「只补一次」的保证）。 */
export const DEEPSEEK_PURGE_MARKER_KEY = 'deepseek:sessions:purge:last'

const DAY_MS = 24 * 60 * 60 * 1000

// ===== 上游会话抽屉 =====

/** 抽屉里的一条会话（Go `SessionInfo`）。 */
export interface DeepseekSessionInfo {
  id: string
  pinned: boolean
  /** epoch 秒（Go 的 `updated_at` float64）。 */
  updatedAt: number
}

/**
 * listSessions / 删除所需的最小客户端面：`DeepseekClient` 结构化满足（也便于测试注入）。
 */
export interface SessionAdminClient {
  fetchSessionPage(token: string, cursor?: string): Promise<Envelope>
  deleteSession(token: string, sessionId: string): Promise<void>
  deleteAllSessions(token: string): Promise<void>
}

// 字段容错清单：上游不同版本的字段位置/命名变过（见 Go fetch_page 与 apk-behavior
// 记录），所以按候选键逐个探测，而不是一次严格反序列化。
const SESSION_ARRAY_KEYS = ['chat_sessions', 'sessions', 'chat_session_list']
const SESSION_ID_KEYS = ['id', 'chat_session_id', 'session_id']
const SESSION_UPDATED_KEYS = ['updated_at', 'updatedAt', 'update_time', 'updated_time']

function asRecord(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
}

function truthy(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'number') return raw !== 0
  if (typeof raw === 'string') return raw.trim() === 'true' || raw.trim() === '1'
  return false
}

function firstString(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  }
  return ''
}

function firstNumber(obj: Record<string, unknown>, keys: string[]): number {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v)
  }
  return 0
}

/** epoch 秒的文本形式，对齐 Go `strconv.FormatFloat(f, 'f', -1, 64)`。 */
function formatEpochSeconds(n: number): string {
  return String(n)
}

/**
 * 从 biz_data 里取出本页会话数组与 has_more。
 * 返回 null = biz_data 是标量（Go 版这里会 json.Unmarshal 失败 → 计入错误，不静默当空）；
 * 返回空数组 = 结构认识但本页没有会话（未知对象形状当空页处理，容错旧版本）。
 */
function pickSessionPage(biz: unknown): { entries: unknown[]; hasMore: boolean } | null {
  if (biz === null || biz === undefined) return { entries: [], hasMore: false }
  if (Array.isArray(biz)) return { entries: biz, hasMore: false }
  if (typeof biz !== 'object') return null
  const rec = asRecord(biz)
  const nested = asRecord(rec.data)
  for (const k of SESSION_ARRAY_KEYS) {
    if (Array.isArray(rec[k])) {
      return { entries: rec[k] as unknown[], hasMore: truthy(rec.has_more) || truthy(nested.has_more) }
    }
  }
  for (const k of SESSION_ARRAY_KEYS) {
    if (Array.isArray(nested[k])) {
      return { entries: nested[k] as unknown[], hasMore: truthy(rec.has_more) || truthy(nested.has_more) }
    }
  }
  return { entries: [], hasMore: truthy(rec.has_more) || truthy(nested.has_more) }
}

function parseSessionEntry(raw: unknown): DeepseekSessionInfo | null {
  const obj = asRecord(raw)
  const id = firstString(obj, SESSION_ID_KEYS)
  if (!id) return null
  const pinnedRaw = obj.pinned !== undefined ? obj.pinned : obj.is_pinned
  return { id, pinned: truthy(pinnedRaw), updatedAt: firstNumber(obj, SESSION_UPDATED_KEYS) }
}

/**
 * 走一遍账号的会话抽屉：fetch_page 首页无参数，之后带
 * `lte_cursor.pinned=<本页最老条目>&lte_cursor.updated_at=<epoch秒>`（App 的 t72 游标
 * 语义，上游只返回严格更老的会话）。最多 `DEEPSEEK_MAX_SESSION_PAGES` 页，返回顺序为
 * 上游给出顺序（新 → 旧）。
 */
export async function listSessions(client: SessionAdminClient, token: string): Promise<DeepseekSessionInfo[]> {
  const all: DeepseekSessionInfo[] = []
  let cursor: string | undefined
  for (let page = 0; page < DEEPSEEK_MAX_SESSION_PAGES; page++) {
    const env = await client.fetchSessionPage(token, cursor)
    const biz = env?.data?.biz_data
    const picked = pickSessionPage(biz)
    if (picked === null) {
      const shown = typeof biz === 'string' ? biz.slice(0, 200) : JSON.stringify(biz)?.slice(0, 200)
      throw new Error(`upstream: bad fetch_page biz_data: ${shown ?? ''}`)
    }
    for (const raw of picked.entries) {
      const info = parseSessionEntry(raw)
      if (info) all.push(info)
    }
    if (!picked.hasMore || picked.entries.length === 0) break
    // 游标取本页最后一条的 (pinned, updated_at)，字段缺失按零值（与 Go 的零值一致）。
    const last = asRecord(picked.entries[picked.entries.length - 1])
    const lastPinned = truthy(last.pinned !== undefined ? last.pinned : last.is_pinned)
    cursor = `lte_cursor.pinned=${lastPinned}&lte_cursor.updated_at=${formatEpochSeconds(firstNumber(last, SESSION_UPDATED_KEYS))}`
  }
  return all
}

// ===== 配置解析（env 字符串，DS_* → DEEPSEEK_*）=====

const UNIT_MS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  'µs': 1e-3,
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
}

/**
 * Go 风格时长解析：`90m` / `1h30m` / `1.5h` / `500ms`，或纯整数（= 秒，Go 的
 * `strconv.Atoi` 回退分支，`DEEPSEEK_CLEANUP_INTERVAL=3600` 即 1h）。无法解析返回 null。
 *
 * 手写扫描而非正则：原实现用 `/(-?\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g` 逐段 exec，
 * 该形状对「超长数字串 + 无单位」会按起始位置反复回溯（多项式，CodeQL
 * js/polynomial-redos）；输入来自 env/cron 配置，解析必须是线性时间。
 * 语义与旧正则逐字对齐：段间不允许空隙、单位最长匹配优先（ms 先于 m/s）、
 * 数字不接受 `+`/前导点/尾随点/指数。
 */
export function parseDurationMs(raw: string): number | null {
  const s = (raw ?? '').trim()
  if (!s) return null
  if (/^-?\d+$/.test(s)) return Number(s) * 1000
  const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9'
  let total = 0
  let i = 0
  while (i < s.length) {
    const numStart = i
    if (s[i] === '-') i++
    const intStart = i
    while (isDigit(s[i])) i++
    if (i === intStart) return null // 段首不是数字 → 非法（也覆盖段间空隙）
    if (s[i] === '.') {
      i++
      const fracStart = i
      while (isDigit(s[i])) i++
      if (i === fracStart) return null // `1.` 不是合法数字
    }
    // 单位最长匹配优先：两字符单位（ns/us/µs/ms）先试，再试单字符（s/m/h）
    const two = s.slice(i, i + 2)
    const unit = UNIT_MS[two] !== undefined ? two : UNIT_MS[s[i]] !== undefined ? s[i] : ''
    if (!unit) return null
    i += unit.length
    total += Number(s.slice(numStart, i - unit.length)) * UNIT_MS[unit]
  }
  return total
}

/** 读一个字符串类型的 env 绑定（`Env` 未声明这些键，按字符串绑定读取）。 */
function envString(env: Env, key: string): string {
  const raw = (env as unknown as Record<string, unknown>)[key]
  return typeof raw === 'string' ? raw.trim() : ''
}

/** 读一个整数 env：非法/越界 → fallback + warning（Go 版此处 Fatalf）。 */
function envInt(env: Env, key: string, min: number, max: number, fallback: number, warn: (msg: string) => void): number {
  const raw = envString(env, key)
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) {
    warn(`${key} must be an integer in [${min}, ${max}], got ${JSON.stringify(raw)} — falling back to ${fallback}`)
    return fallback
  }
  return n
}

/** 清理策略（Go `cleanupConfig`）。`intervalMs <= 0` = 关闭。 */
export interface DeepseekCleanupConfig {
  intervalMs: number
  floor: number
  probability: number
  gapMinMs: number
  gapMaxMs: number
}

/** 每周清空策略（Go `purgeConfig`）。`weekday < 0` = 关闭。 */
export interface DeepseekPurgeConfig {
  weekday: number
  hour: number
  jitterMs: number
  catchUpWindowMs: number
  catchUpDelayMinMs: number
  catchUpDelayMaxMs: number
  /** 计算「周日 04:00」时用的时区偏移（分钟）；默认 0 = UTC。 */
  utcOffsetMinutes: number
}

function defaultLog(msg: string): void {
  console.log(`[deepseek-sessions] ${msg}`)
}

/**
 * 解析清理配置：显式 opts > env > Go 默认值。
 * `DEEPSEEK_CLEANUP_INTERVAL` 缺省 = 1h；显式 `0` = 关闭；`DEEPSEEK_CLEANUP_FLOOR`
 * ≤0/缺省 = 5（Go `fillDefaults`）。
 */
export function resolveCleanupConfig(env: Env, opts: DeepseekCleanupOptions = {}): DeepseekCleanupConfig {
  const warn = (msg: string) => (opts.log ?? defaultLog)(msg)
  let intervalMs: number
  if (opts.intervalMs !== undefined) {
    intervalMs = opts.intervalMs
  } else {
    const raw = envString(env, 'DEEPSEEK_CLEANUP_INTERVAL')
    if (!raw) {
      intervalMs = DEEPSEEK_CLEANUP_DEFAULT_INTERVAL_MS
    } else {
      const parsed = parseDurationMs(raw)
      if (parsed === null) {
        warn(
          `DEEPSEEK_CLEANUP_INTERVAL must be a duration or non-negative integer (seconds), got ${JSON.stringify(raw)} — falling back to ${DEEPSEEK_CLEANUP_DEFAULT_INTERVAL_MS}ms`,
        )
        intervalMs = DEEPSEEK_CLEANUP_DEFAULT_INTERVAL_MS
      } else {
        intervalMs = parsed
      }
    }
  }
  const floor = opts.floor !== undefined ? opts.floor : envInt(env, 'DEEPSEEK_CLEANUP_FLOOR', 0, 1e9, 0, warn)
  const probability = opts.probability !== undefined ? opts.probability : DEEPSEEK_CLEANUP_DEFAULT_PROBABILITY
  return {
    intervalMs,
    // Go fillDefaults：floor <= 0 取默认 5；probability <= 0 取默认 0.5。
    floor: floor > 0 ? floor : DEEPSEEK_CLEANUP_DEFAULT_FLOOR,
    probability: probability > 0 ? probability : DEEPSEEK_CLEANUP_DEFAULT_PROBABILITY,
    gapMinMs: opts.gapMinMs !== undefined && opts.gapMinMs > 0 ? opts.gapMinMs : DEEPSEEK_CLEANUP_GAP_MIN_MS,
    gapMaxMs:
      opts.gapMaxMs !== undefined && opts.gapMaxMs > (opts.gapMinMs ?? DEEPSEEK_CLEANUP_GAP_MIN_MS)
        ? opts.gapMaxMs
        : DEEPSEEK_CLEANUP_GAP_MAX_MS,
  }
}

/**
 * 解析每周清空配置。`DEEPSEEK_PURGE=0` 或 `DEEPSEEK_PURGE_WEEKDAY=-1` → `weekday < 0`（关闭）。
 */
export function resolvePurgeConfig(env: Env, opts: DeepseekPurgeOptions = {}): DeepseekPurgeConfig {
  const warn = (msg: string) => (opts.log ?? defaultLog)(msg)

  let purgeOn = true
  const rawPurge = envString(env, 'DEEPSEEK_PURGE')
  if (rawPurge !== '') {
    const n = Number(rawPurge)
    if (Number.isFinite(n) && n === 0) purgeOn = false
  }

  let weekday: number
  if (opts.weekday !== undefined) {
    weekday = opts.weekday
  } else {
    weekday = envInt(env, 'DEEPSEEK_PURGE_WEEKDAY', -1, 6, DEEPSEEK_PURGE_DEFAULT_WEEKDAY, warn)
  }
  if (!purgeOn) weekday = -1

  const hour =
    opts.hour !== undefined ? opts.hour : envInt(env, 'DEEPSEEK_PURGE_HOUR', 0, 23, DEEPSEEK_PURGE_DEFAULT_HOUR, warn)

  return {
    weekday,
    hour: hour >= 0 && hour <= 23 ? hour : DEEPSEEK_PURGE_DEFAULT_HOUR,
    jitterMs: opts.jitterMs !== undefined && opts.jitterMs > 0 ? opts.jitterMs : DEEPSEEK_PURGE_DEFAULT_JITTER_MS,
    catchUpWindowMs:
      opts.catchUpWindowMs !== undefined && opts.catchUpWindowMs > 0
        ? opts.catchUpWindowMs
        : DEEPSEEK_PURGE_CATCHUP_WINDOW_MS,
    catchUpDelayMinMs:
      opts.catchUpDelayMinMs !== undefined && opts.catchUpDelayMinMs > 0
        ? opts.catchUpDelayMinMs
        : DEEPSEEK_PURGE_CATCHUP_DELAY_MIN_MS,
    catchUpDelayMaxMs:
      opts.catchUpDelayMaxMs !== undefined && opts.catchUpDelayMaxMs > 0
        ? opts.catchUpDelayMaxMs
        : DEEPSEEK_PURGE_CATCHUP_DELAY_MAX_MS,
    utcOffsetMinutes: opts.utcOffsetMinutes ?? 0,
  }
}

/** `DEEPSEEK_SESSION_CAP`：>0 时开启硬上限；缺省/0/非法 = 关闭（Go 默认无上限）。 */
export function resolveSessionCap(env: Env, warn: (msg: string) => void = defaultLog): number {
  const raw = envString(env, 'DEEPSEEK_SESSION_CAP')
  if (!raw) return 0
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) {
    warn(`DEEPSEEK_SESSION_CAP must be a non-negative integer, got ${JSON.stringify(raw)} — cap disabled`)
    return 0
  }
  return n
}

// ===== 时间计算（全部可注入 now/random，便于稳定验证抖动与补跑）=====

type PurgeTiming = Pick<DeepseekPurgeConfig, 'weekday' | 'hour' | 'jitterMs' | 'utcOffsetMinutes'>

/** 下一次清理唤醒延迟：base 的 [1/2, 3/2] 均匀抖动（Go `nextInterval`）。 */
export function nextCleanupDelayMs(baseMs: number, random: () => number): number {
  const half = Math.floor(baseMs / 2)
  return half + Math.floor(random() * (2 * half + 1))
}

/** 每周清空的抖动偏移：[-jitter, +jitter] 均匀（Go `nextJitter`）。 */
export function nextPurgeJitterMs(jitterMs: number, random: () => number): number {
  if (!(jitterMs > 0)) return 0
  return Math.floor(random() * (2 * jitterMs + 1)) - jitterMs
}

/** 在配置时区下的「周几」（周一基准 0=Mon..6=Sun）。 */
function localWeekday(nowMs: number, offsetMinutes: number): number {
  return (new Date(nowMs + offsetMinutes * 60_000).getUTCDay() + 6) % 7
}

/** 配置时区下、今天 hour:00 的 epoch ms。 */
function todaySlotMs(nowMs: number, hour: number, offsetMinutes: number): number {
  const d = new Date(nowMs + offsetMinutes * 60_000)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, 0, 0, 0) - offsetMinutes * 60_000
}

/** 最近一个（≤ now）未加抖动的每周窗口（Go `lastSlot`）。 */
export function lastPurgeSlotMs(nowMs: number, cfg: PurgeTiming): number {
  const today = todaySlotMs(nowMs, cfg.hour, cfg.utcOffsetMinutes)
  const delta = (localWeekday(nowMs, cfg.utcOffsetMinutes) - cfg.weekday + 7) % 7
  let slot = today - delta * DAY_MS
  if (slot > nowMs) slot -= 7 * DAY_MS
  return slot
}

/** 下一个（严格 > now）未加抖动的每周窗口（Go `nextSlot`）。 */
export function nextPurgeSlotMs(nowMs: number, cfg: PurgeTiming): number {
  const today = todaySlotMs(nowMs, cfg.hour, cfg.utcOffsetMinutes)
  const delta = (cfg.weekday - localWeekday(nowMs, cfg.utcOffsetMinutes) + 7) % 7
  if (delta === 0 && today > nowMs) return today // 今天的窗口还在前面
  return today + (delta === 0 ? 7 : delta) * DAY_MS
}

/** 下一次实际触发时刻：下一个窗口 + 抖动；抖动把时刻推到 now 之前则顺延一周。 */
export function nextPurgeAtMs(nowMs: number, cfg: PurgeTiming, random: () => number): number {
  let slot = nextPurgeSlotMs(nowMs, cfg)
  let fire = slot + nextPurgeJitterMs(cfg.jitterMs, random)
  for (let guard = 0; !(fire > nowMs) && guard < 8; guard++) {
    slot += 7 * DAY_MS
    fire = slot + nextPurgeJitterMs(cfg.jitterMs, random)
  }
  return fire
}

/**
 * 是否需要启动补跑：最近一个窗口已过、且在 `catchUpWindowMs` 以内，并且这个窗口
 * 还没有被记录过的清空覆盖（`lastPurgeAtMs < slot`）。更老的窗口交给上一个实例。
 */
export function purgeCatchUpNeeded(
  nowMs: number,
  cfg: PurgeTiming & { catchUpWindowMs: number },
  lastPurgeAtMs: number | null,
): boolean {
  if (cfg.weekday < 0) return false
  const last = lastPurgeSlotMs(nowMs, cfg)
  if (!(last < nowMs)) return false
  if (nowMs - last >= cfg.catchUpWindowMs) return false
  if (lastPurgeAtMs !== null && lastPurgeAtMs >= last) return false
  return true
}

/** 启动补跑的延迟抖动（Go `nextCatchUpDelay`）：永不 0，避免「一启动就打」。 */
export function nextCatchUpDelayMs(
  cfg: Pick<DeepseekPurgeConfig, 'catchUpDelayMinMs' | 'catchUpDelayMaxMs'>,
  random: () => number,
): number {
  let lo = cfg.catchUpDelayMinMs
  let hi = cfg.catchUpDelayMaxMs
  if (!(lo > 0)) lo = DEEPSEEK_PURGE_CATCHUP_DELAY_MIN_MS
  if (!(hi > lo)) {
    hi = lo + 10_000
    if (lo === DEEPSEEK_PURGE_CATCHUP_DELAY_MIN_MS) hi = DEEPSEEK_PURGE_CATCHUP_DELAY_MAX_MS
  }
  return lo + Math.floor(random() * (hi - lo + 1))
}

// ===== 运行器（注入点）=====

interface Runner {
  now: () => number
  random: () => number
  sleep: (ms: number) => Promise<void>
  log: (msg: string) => void
  persist: boolean
  clientFor: (rec: DeepseekTokenRecord) => SessionAdminClient
}

const defaultSleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms))

interface RunnerOptions {
  now?: () => number
  random?: () => number
  sleep?: (ms: number) => Promise<void>
  log?: (msg: string) => void
  persist?: boolean
  fetch?: FetchLike
  /** 测试注入 token（跳过 KV 读取）。 */
  tokens?: DeepseekTokenRecord[]
  /** 测试注入客户端工厂；默认按 token 记录构造 DeepseekClient（web 指纹）。 */
  clientFor?: (rec: DeepseekTokenRecord) => SessionAdminClient
}

function makeRunner(opts: RunnerOptions): Runner {
  const log = opts.log ?? defaultLog
  const fetchImpl = opts.fetch
  return {
    now: opts.now ?? (() => Date.now()),
    random: opts.random ?? Math.random,
    sleep: opts.sleep ?? defaultSleep,
    log,
    persist: opts.persist !== false,
    clientFor:
      opts.clientFor ??
      ((rec: DeepseekTokenRecord) =>
        new DeepseekClient({
          account: { password: '' },
          fetch: fetchImpl,
          wire: { replaceHeaders: true, headers: webHeaders(rec) },
        })),
  }
}

/**
 * 可用于后台维护的 token：状态 ready **且不在 park 窗口内**。
 *
 * 为什么 park 的账号必须零后台流量（Go 版 `TestCleanupSkipsParkedAccounts` 的契约）：
 * 后台维护也会打上游，而被禁言的账号每被碰一次都可能让上游**续期窗口甚至升级处罚**。
 * 「冷下来」必须是彻底的——这也是 park 存在的全部意义。
 */
async function readyTokens(env: Env, opts: { tokens?: DeepseekTokenRecord[] }): Promise<DeepseekTokenRecord[]> {
  const all = opts.tokens ?? (await readDeepseekPool(env))
  const now = Date.now()
  return all.filter((t) => t.state === 'ready' && !isDeepseekTokenParked(t, now))
}

function tokenLabel(rec: DeepseekTokenRecord): string {
  return rec.label ? `${rec.id}(${rec.label})` : rec.id
}

/**
 * 上游会话维护期间的失败归类：鉴权失效 → 标 expired；处罚（biz 5/10/11）→ park。
 * 两者都显式写回，不静默降级（与 proxy.ts 同一口径）。
 *
 * 后台维护撞上处罚同样要 park：否则这个账号下一轮维护还会被选中，继续把窗口续下去。
 */
async function noteAuthFailure(
  env: Env,
  r: Runner,
  rec: DeepseekTokenRecord,
  where: string,
  err: unknown,
): Promise<void> {
  const ban = parkFromError(err)
  if (ban) {
    if (r.persist) await parkDeepseekToken(env, rec.id, ban.park)
    r.log(`token ${tokenLabel(rec)} parked (${ban.kind}) by ${where}: ${ban.park.reason}`)
    return
  }
  if (!isAuthFailure(err)) return
  if (r.persist) await markDeepseekToken(env, rec.id, { state: 'expired', error: `token expired (${where})` })
  r.log(`token ${tokenLabel(rec)} marked expired (${where})`)
}

async function readMarker(env: Env, key: string): Promise<number | null> {
  try {
    const raw = await env.KV.get(key)
    if (!raw) return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

async function writeMarker(env: Env, key: string, value: number): Promise<void> {
  try {
    await env.KV.put(key, String(value))
  } catch {
    /* 标记只是调度用，写不进去不该让维护失败 */
  }
}

// ===== 1) 人类节奏清理 =====

export interface DeepseekCleanupOptions extends RunnerOptions {
  /** 覆盖 env 的基准间隔；显式传 0 = 关闭本次排程。 */
  intervalMs?: number
  floor?: number
  probability?: number
  gapMinMs?: number
  gapMaxMs?: number
  /** true = 忽略 KV 里的下次唤醒标记，强制执行（面板/手工触发）。 */
  force?: boolean
  /** false = 不读写唤醒标记（调用方自己排程；Go 测试直接调 pass() 的同形态）。 */
  schedule?: boolean
}

export interface CleanupAccountOutcome {
  tokenId: string
  label: string
  /** 概率判定为「这次不清理」时为 true（Go 的 per-account episode roll）。 */
  skipped: boolean
  listed: boolean
  deleted: string[]
  /** 清理后仍未置顶的会话数；未列到时为 null。 */
  remaining: number | null
  error?: string
}

export interface CleanupRunResult {
  enabled: boolean
  ran: boolean
  reason: 'ran' | 'disabled' | 'not-due'
  /** 下一次唤醒时刻（ms epoch）；关闭时为 null。 */
  nextFireAt: number | null
  intervalMs: number
  outcomes: CleanupAccountOutcome[]
  deleted: number
}

/**
 * 从抽屉里挑出这次要删的会话：未置顶数 ≤ floor 时不动；否则在「最老的
 * (未置顶数 - floor) 条」里按 updated_at 升序取最老的 batch 条（Go `episode`）。
 */
export function selectCleanupVictims(
  sessions: DeepseekSessionInfo[],
  floor: number,
  batch: number,
): DeepseekSessionInfo[] {
  const unpinned = sessions.filter((s) => !s.pinned)
  if (unpinned.length <= floor) return []
  const candidates = unpinned.slice(floor).sort((a, b) => a.updatedAt - b.updatedAt)
  const n = Math.min(batch, candidates.length)
  return candidates.slice(0, n)
}

/**
 * 一次「人类节奏」清理唤醒：每个健康（ready）token 各一次 episode，失败只记日志、
 * 不影响其他 token。
 *
 * 返回值里的 `nextFireAt` 是下一次唤醒时刻（base ±50% 抖动）；当 `schedule !== false`
 * 且 `persist !== false` 时，它同时写进 KV（`DEEPSEEK_CLEANUP_MARKER_KEY`），于是
 * 下一次调用在到期前会直接返回 `not-due`。
 */
export async function runSessionCleanup(env: Env, opts: DeepseekCleanupOptions = {}): Promise<CleanupRunResult> {
  const r = makeRunner(opts)
  const cfg = resolveCleanupConfig(env, opts)

  if (!(cfg.intervalMs > 0)) {
    r.log('session cleanup: disabled (DEEPSEEK_CLEANUP_INTERVAL=0)')
    return {
      enabled: false,
      ran: false,
      reason: 'disabled',
      nextFireAt: null,
      intervalMs: cfg.intervalMs,
      outcomes: [],
      deleted: 0,
    }
  }

  const nowMs = r.now()
  const nextFireAt = nowMs + nextCleanupDelayMs(cfg.intervalMs, r.random)
  const useSchedule = opts.schedule !== false && r.persist

  if (useSchedule && !opts.force) {
    const marker = await readMarker(env, DEEPSEEK_CLEANUP_MARKER_KEY)
    if (marker !== null && nowMs < marker) {
      return {
        enabled: true,
        ran: false,
        reason: 'not-due',
        nextFireAt: marker,
        intervalMs: cfg.intervalMs,
        outcomes: [],
        deleted: 0,
      }
    }
  }

  const tokens = await readyTokens(env, opts)
  const outcomes: CleanupAccountOutcome[] = []
  let deletedTotal = 0

  for (const rec of tokens) {
    const base: CleanupAccountOutcome = {
      tokenId: rec.id,
      label: tokenLabel(rec),
      skipped: false,
      listed: false,
      deleted: [],
      remaining: null,
    }
    // probability >= 1 时不再消耗随机数（仅测试确定性；语义与 Go 的按概率掷骰一致）。
    if (cfg.probability < 1 && r.random() >= cfg.probability) {
      outcomes.push({ ...base, skipped: true })
      continue
    }
    try {
      const outcome = await cleanupEpisode(env, r, cfg, rec)
      deletedTotal += outcome.deleted.length
      outcomes.push(outcome)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await noteAuthFailure(env, r, rec, 'session cleanup', err)
      r.log(`cleanup: ${tokenLabel(rec)} session list failed (skipped): ${message}`)
      outcomes.push({ ...base, error: message })
    }
  }

  if (useSchedule) await writeMarker(env, DEEPSEEK_CLEANUP_MARKER_KEY, nextFireAt)
  return {
    enabled: true,
    ran: true,
    reason: 'ran',
    nextFireAt,
    intervalMs: cfg.intervalMs,
    outcomes,
    deleted: deletedTotal,
  }
}

/** 单个 token 的一次整理：列会话 → 选最老的少量未置顶 → 带人类间隔地删。 */
async function cleanupEpisode(
  env: Env,
  r: Runner,
  cfg: DeepseekCleanupConfig,
  rec: DeepseekTokenRecord,
): Promise<CleanupAccountOutcome> {
  const client = r.clientFor(rec)
  const sessions = await listSessions(client, rec.token)
  const unpinned = sessions.filter((s) => !s.pinned)
  const base: CleanupAccountOutcome = {
    tokenId: rec.id,
    label: tokenLabel(rec),
    skipped: false,
    listed: true,
    deleted: [],
    remaining: unpinned.length,
  }
  if (unpinned.length <= cfg.floor) return base

  const batch =
    DEEPSEEK_CLEANUP_MIN_BATCH +
    Math.floor(r.random() * (DEEPSEEK_CLEANUP_MAX_BATCH - DEEPSEEK_CLEANUP_MIN_BATCH + 1))
  const victims = selectCleanupVictims(sessions, cfg.floor, batch)
  const deleted: string[] = []
  for (let i = 0; i < victims.length; i++) {
    if (i > 0) await r.sleep(nextGapMs(cfg, r.random))
    const victim = victims[i]
    try {
      await client.deleteSession(rec.token, victim.id)
      deleted.push(victim.id)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await noteAuthFailure(env, r, rec, 'session delete', err)
      r.log(`cleanup: ${tokenLabel(rec)} delete ${victim.id} failed (continuing): ${message}`)
    }
  }
  const remaining = unpinned.length - deleted.length
  r.log(`cleanup episode: ${tokenLabel(rec)} deleted ${deleted.length}, remaining ${remaining}`)
  return { ...base, deleted, remaining }
}

function nextGapMs(cfg: DeepseekCleanupConfig, random: () => number): number {
  const span = cfg.gapMaxMs - cfg.gapMinMs
  if (span <= 0) return cfg.gapMinMs
  return cfg.gapMinMs + Math.floor(random() * (span + 1))
}

// ===== 2) 每周清空 =====

export interface DeepseekPurgeOptions extends RunnerOptions {
  /** 周一基准 0=Mon..6=Sun；<0 = 关闭。 */
  weekday?: number
  hour?: number
  jitterMs?: number
  catchUpWindowMs?: number
  catchUpDelayMinMs?: number
  catchUpDelayMaxMs?: number
  /** 「周日 04:00」所在时区的偏移分钟；默认 0 = UTC。 */
  utcOffsetMinutes?: number
  /** true = 立即清空（调用方已判定窗口到期 / 手工触发）。 */
  force?: boolean
  /** false = 不做启动补跑判定。 */
  allowCatchUp?: boolean
}

export interface PurgeAccountOutcome {
  tokenId: string
  label: string
  /** 清空前的会话数（-1 = 列表失败，best-effort）。 */
  before: number
  /** 清空后的会话数（-1 = 列表失败）。 */
  after: number
  ok: boolean
  error?: string
}

export interface PurgeRunResult {
  enabled: boolean
  ran: boolean
  reason: 'ran' | 'catch-up' | 'disabled' | 'not-due'
  nextFireAt: number | null
  outcomes: PurgeAccountOutcome[]
  purged: number
  failed: number
}

/**
 * 每周清空：`delete_all` 每个健康（ready）token 一次。调用方二选一：
 *  - `force: true` —— 已判定窗口到期（或面板手工触发），立即执行；
 *  - 默认 —— 启动补跑判定：最近窗口在 24h 内且尚未跑过 → 抖动 2–12s 后补跑一次，
 *    否则返回 `not-due` 与下一次触发时刻（不发起任何上游请求）。
 *
 * 失败（含 biz 5 禁言）只记日志：**下周再试，不风暴重试**。跑过就在 KV 里记一笔，
 * 于是「补跑一次」在每次 cron 都是新 isolate 的 Workers 上也只发生一次。
 */
export async function runSessionPurge(env: Env, opts: DeepseekPurgeOptions = {}): Promise<PurgeRunResult> {
  const r = makeRunner(opts)
  const cfg = resolvePurgeConfig(env, opts)

  if (cfg.weekday < 0) {
    r.log('weekly purge: disabled (DEEPSEEK_PURGE=0)')
    return { enabled: false, ran: false, reason: 'disabled', nextFireAt: null, outcomes: [], purged: 0, failed: 0 }
  }

  const nowMs = r.now()
  let reason: 'ran' | 'catch-up'
  if (opts.force) {
    reason = 'ran'
  } else {
    const lastPurgeAt = r.persist ? await readMarker(env, DEEPSEEK_PURGE_MARKER_KEY) : null
    if (opts.allowCatchUp !== false && purgeCatchUpNeeded(nowMs, cfg, lastPurgeAt)) {
      reason = 'catch-up'
      const delay = nextCatchUpDelayMs(cfg, r.random)
      r.log(
        `weekly purge: missed window within ${Math.round(cfg.catchUpWindowMs / 3_600_000)}h — catch-up in ${delay}ms`,
      )
      await r.sleep(delay)
    } else {
      const nextFireAt = nextPurgeAtMs(nowMs, cfg, r.random)
      r.log(`weekly purge: next fire ${new Date(nextFireAt).toISOString()} (delete_all)`)
      return { enabled: true, ran: false, reason: 'not-due', nextFireAt, outcomes: [], purged: 0, failed: 0 }
    }
  }

  const tokens = await readyTokens(env, opts)
  const outcomes: PurgeAccountOutcome[] = []
  for (const rec of tokens) {
    outcomes.push(await purgeAccount(env, r, rec))
  }
  if (r.persist) await writeMarker(env, DEEPSEEK_PURGE_MARKER_KEY, r.now())
  const purged = outcomes.filter((o) => o.ok).length
  return {
    enabled: true,
    ran: true,
    reason,
    nextFireAt: nextPurgeAtMs(r.now(), cfg, r.random),
    outcomes,
    purged,
    failed: outcomes.length - purged,
  }
}

/** 单个 token 的清空：before 计数 → delete_all → after 计数 → 清掉 cap 注册表。 */
async function purgeAccount(env: Env, r: Runner, rec: DeepseekTokenRecord): Promise<PurgeAccountOutcome> {
  const client = r.clientFor(rec)
  const base: PurgeAccountOutcome = { tokenId: rec.id, label: tokenLabel(rec), before: -1, after: -1, ok: false }

  // 前值 best-effort：列表失败不阻塞清空（delete_all 才是目的）。
  try {
    base.before = (await listSessions(client, rec.token)).length
  } catch (err) {
    r.log(
      `purge: ${tokenLabel(rec)} pre-count failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  try {
    await client.deleteAllSessions(rec.token)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await noteAuthFailure(env, r, rec, 'purge', err)
    r.log(`purge: ${tokenLabel(rec)} delete_all failed (will retry next week): ${message}`)
    return { ...base, error: message }
  }

  try {
    base.after = (await listSessions(client, rec.token)).length
  } catch {
    /* best-effort */
  }
  // 该 token 的会话已在上游消失：清掉 cap 注册表记录，否则后续淘汰会对着幽灵 id 删。
  deepseekSessionCapRegistry.reset(rec.id)
  r.log(`purge: ${tokenLabel(rec)} cleared (${base.before} → ${base.after} sessions)`)
  return { ...base, ok: true }
}

// ===== 3) DEEPSEEK_SESSION_CAP 硬上限 =====

/**
 * 每 token 的建会话顺序表（Go `sessionRegistry` 的 `seq`）。
 *
 * per isolate 内存态，与 pool 的轮转游标同形态：Workers 多 isolate 下各自计账，
 * 不是全局精确计数。真正的清理路径是 runSessionCleanup；这里是应急阀门。
 */
export class DeepseekSessionCapRegistry {
  private readonly seq = new Map<string, string[]>()

  /** 记录一次建会话，返回需要淘汰的最老会话 id（超出 cap 的部分）。 */
  record(key: string, sessionId: string, cap: number): string[] {
    if (cap <= 0) return [] // 无上限时不记账（常驻 isolate 里那会是无界增长）
    const list = this.seq.get(key) ?? []
    list.push(sessionId)
    if (list.length <= cap) {
      this.seq.set(key, list)
      return []
    }
    const evict = list.slice(0, list.length - cap)
    this.seq.set(key, list.slice(list.length - cap))
    return evict
  }

  /** 清掉某个 token 的记录（周清空之后调用）。 */
  reset(key: string): void {
    this.seq.delete(key)
  }

  /** 清空整表（测试用）。 */
  clear(): void {
    this.seq.clear()
  }

  /** 测试/诊断：当前记录的会话 id（按创建顺序）。 */
  recorded(key: string): string[] {
    return [...(this.seq.get(key) ?? [])]
  }
}

/** 进程内默认注册表（导出便于测试重置与诊断）。 */
export const deepseekSessionCapRegistry = new DeepseekSessionCapRegistry()

/** 测试用：清空默认注册表。 */
export function resetDeepseekSessionCapRegistryForTest(): void {
  deepseekSessionCapRegistry.clear()
}

export interface EnforceSessionCapResult {
  cap: number
  evicted: string[]
  errors: string[]
}

/**
 * `DEEPSEEK_SESSION_CAP` 应急阀门：`createSession` 成功后调用，超过上限的最老会话
 * 立即同步删除（Go 版入异步删除队列；Workers 没有后台队列，所以直接 await）。
 * cap ≤ 0 时什么都不做（默认无上限，正常清理交给 runSessionCleanup）。
 */
export async function enforceSessionCap(
  env: Env,
  client: SessionAdminClient,
  rec: DeepseekTokenRecord,
  sessionId: string,
  opts: { cap?: number; log?: (msg: string) => void; persist?: boolean } = {},
): Promise<EnforceSessionCapResult> {
  const log = opts.log ?? defaultLog
  const persist = opts.persist !== false
  const cap = opts.cap !== undefined ? opts.cap : resolveSessionCap(env, log)
  if (!(cap > 0)) return { cap: 0, evicted: [], errors: [] }

  const evicted = deepseekSessionCapRegistry.record(rec.id, sessionId, cap)
  if (evicted.length === 0) return { cap, evicted: [], errors: [] }

  const errors: string[] = []
  for (const id of evicted) {
    try {
      await client.deleteSession(rec.token, id)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push(`${id}: ${message}`)
      if (isAuthFailure(err) && persist) {
        await markDeepseekToken(env, rec.id, { state: 'expired', error: 'token expired (session cap)' })
      }
      log(`session cap: ${tokenLabel(rec)} evict ${id} failed: ${message}`)
    }
  }
  log(`session cap: ${tokenLabel(rec)} evicted ${evicted.length} oldest (cap ${cap})`)
  return { cap, evicted, errors }
}
