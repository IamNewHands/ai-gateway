/**
 * proxy.ts — Cline 上游转发（移植自 cline2api-workers worker.js）。
 *
 * 核心逻辑：
 *   1. 用 refreshToken（Cline 账号的"长期钥匙"）换 accessToken（内存缓存，过期自动刷新）。
 *   2. 把 OpenAI 请求转发到 https://api.cline.bot/api/v1/chat/completions。
 *   3. SSE 流式响应剥掉上游 {data:{...}} 包装后透传给客户端。
 *
 * 多账号：provider.apiKeys（enabled）里一行一个 refreshToken，
 *   额度用尽(空响应)/刷失败/401 时自动冷却并切换到下一个账号。
 *
 * 可用模型（2026-08 实测，见项目 README）：
 *   poolside/laguna-s-2.1:free 为当前唯一稳定可用（API 免费）；
 *   deepseek/deepseek-v4-flash 与 cline-free/* 被官方锁定(403，仅 Cline 产品界面)；
 *   cline-pass/* 需付费订阅。
 */

import type { Env, Provider } from '../types'
import { updateProvider, getProviders } from '../storage'
import { streamFetchWithTimeout } from '../opencode'

export const CLINE_PROVIDER_ID = 'cline'
export const CLINE_API_BASE = 'https://api.cline.bot/api/v1'

export const DEFAULT_MODEL = 'poolside/laguna-s-2.1:free'

/** 实测模型列表（poolside 免费可用；deepseek 已锁；cline-free 锁定；cline-pass 需订阅）。 */
export const CLINE_MODELS: Array<{ id: string; provider: string; cost: string }> = [
  { id: 'poolside/laguna-s-2.1:free', provider: 'poolside', cost: 'free' },
  { id: 'deepseek/deepseek-v4-flash', provider: 'deepseek', cost: 'locked' },
  { id: 'cline-free/glm-5.2', provider: 'zai', cost: 'locked' },
  { id: 'cline-pass/glm-5.2', provider: 'zai', cost: 'pass' },
  { id: 'cline-pass/deepseek-v4-flash', provider: 'deepseek', cost: 'pass' },
  { id: 'cline-pass/qwen3.7-max', provider: 'qwen', cost: 'pass' },
]

export function isClineProvider(providerId: string): boolean {
  return providerId === CLINE_PROVIDER_ID
}

// ===== 账号池状态（per isolate，按 provider.id 隔离） =====

// Cline 客户端指纹头：模拟官方 Cline 客户端，规避 "only available via Cline product surfaces"
// 这类对非官方客户端的 403 锁定（移植自 cline2api-workers worker.js 的 clineHeaders）。
const CLINE_SDK_VERSION = '3.0.47'
const CLINE_FINGERPRINT_HEADERS: Record<string, string> = {
  'User-Agent': `Cline/${CLINE_SDK_VERSION}`,
  'HTTP-Referer': 'https://cline.bot',
  'X-Title': 'Cline',
  'X-IS-MULTIROOT': 'false',
  'X-CLIENT-TYPE': 'cline-sdk',
  'X-CLIENT-VERSION': CLINE_SDK_VERSION,
  'X-PLATFORM': 'terminal',
  'X-CORE-VERSION': '0.0.66',
}

// 冷却时长（解析上游 Retry-After / "Try again in 2h 51m"，封顶 6h 防止账号被过久冻结）
const CLINE_COOLDOWN_MAX_MS = 6 * 3600 * 1000
const CLINE_COOLDOWN_LIMIT_MS = 5 * 60 * 1000   // 429 默认冷却
const CLINE_COOLDOWN_EMPTY_MS = 60 * 1000       // 空响应（免费额度耗尽）默认冷却
const CLINE_COOLDOWN_401_MS = 60 * 1000         // token 失效默认冷却
// 推理空转（length 截断但无正文）默认冷却：比普通空响应短，便于快速切号重试
const CLINE_COOLDOWN_RUNAWAY_MS = 30 * 1000

/**
 * max_tokens「护栏默认」与 effort 默认档（推理空转防御）。
 *
 * 实测（2026-09 一份 108 轮 cline/z-ai 会话）：正常轮次 reasoning 中位仅 ~1.5k 字符、
 * 重的工具轮 ~10k–55k；真正病态的轮次是「推理退化空转」——吐 ~3.2 万条 reasoning 里
 * 95% 是空白/换行、几乎不产出正文，最后以 length 截断。而 OpenAI 兼容推理模型把
 * reasoning 与最终答案共用一个 max_tokens 总预算，空转会一次性烧光它。
 *
 * 因此把原来无脑兜底 128000 换成「护栏语义」：
 *   - 客户端显式带 max_tokens / max_completion_tokens → 原样透传，尊重客户端请求
 *     （超长回答不会被网关误掐）；
 *   - 客户端没带 → 用 CLINE_MAX_TOKENS 作为护栏默认，避免空转烧光几十万预算。
 * 空转的兜底见 isRunawayReasoningCutoff + proxyNonStreamChat 的重试/冷却。
 *
 * 2026-09-05 复盘：昨天只把空转兜底挂在非流式路径（proxyNonStreamChat），而 DSH 等
 * 客户端走的是流式透传（streamSSE 直通），退化照样直播到 UI（思考一屏一屏的换行/空格），
 * 预算也照样被烧光直到 length 截断。本次给流式加同等防护：
 *   - isDegenerateReasoningDeltas：流式早期退化检测（阈值按 342 个真实 reasoning 步校准）；
 *   - proxyStreamChat：探测期缓冲 → 退化则取消上游 + 冷却 + 换号重试；健康才放行，
 *     放行后继续滚动监控，退化中途出现则抑制后续 reasoning delta（不再往 UI 直播垃圾）。
 */
const CLINE_MAX_TOKENS = 32768          // 客户端未指定 max_tokens 时的护栏默认（原 128000 过激进）
const CLINE_DEFAULT_REASONING_EFFORT = 'medium'  // 免费通道默认档位（原 high 过激进）

/**
 * 判定一次聚合结果是否为「推理空转被截断」：finish_reason=length 且几乎没有真实正文，
 * 说明预算被 reasoning 耗尽而未产出答案。此时应视为失败（冷却+切号/重试），而不是
 * 把一段空转后的 length 当作「正常被截断的答案」返回。
 * @param content  聚合出的真实正文（assistant content）
 * @param toolCalls 聚合出的工具调用
 * @param finishReason 上游 finish_reason
 */
export function isRunawayReasoningCutoff(content: string, toolCalls: unknown[], finishReason: string): boolean {
  if (finishReason !== 'length') return false
  const hasContent = (content || '').trim().length > 0
  const hasToolCall = Array.isArray(toolCalls) && toolCalls.length > 0
  return !hasContent && !hasToolCall
}

// ===== 推理退化检测（流式防护，2026-09-05） =====

// 阈值按 DSH 会话日志（dsh-session-8711a1e7）342 个真实 reasoning 步校准：
//   正常步：trash 比例 = 0、换行率 ≈ 0.01–0.02（哪怕 7k 字符的长思考）；
//   病态步（"一个字一个空格 / 全是换行"）：trash 比例 ≥ 0.5、换行率 ≥ 0.3，且 8 个命中步零漏判零误伤。
const DEGENERATE_MIN_DELTAS = 16   // 样本太少不判定（正常短思考也可能都是小 token）
const DEGENERATE_TRASH_MIN_DELTAS = 24
const DEGENERATE_TRASH_RATIO = 0.6 // "纯空白碎片 delta" 占比（trash = 可见字符 ≤ 2）
const DEGENERATE_NL_RATIO = 0.3    // 换行字符占比（正常 ≈ 0.01，病态 ≥ 0.3，留 10 倍以上裕量）
const DEGENERATE_BLANK_MIN_CHARS = 600
const DEGENERATE_BLANK_MAX_VISIBLE_RATIO = 0.4  // 长文本里几乎全是空白的 "一个字一个空格" 形态
const PROBE_MAX_DELTAS = 24        // 流式探测窗口：缓冲满这个数量即做放行/拦截判定
const RING_SIZE = 32               // 放行后的滚动监控窗口

/**
 * 判定一组 reasoning delta 是否为「推理退化空转」的输出特征：
 * 大量 delta 只有 1–2 个可见字符甚至纯空白/换行，换行密度异常高，
 * 整体像碎片化的乱码而非连贯思考。
 * @param deltas 按到达顺序排列的 reasoning 文本片段
 */
export function isDegenerateReasoningDeltas(deltas: string[]): boolean {
  const n = deltas.length
  if (n < DEGENERATE_MIN_DELTAS) return false
  let chars = 0
  let newlines = 0
  let visible = 0
  let trash = 0
  for (const t of deltas) {
    chars += t.length
    newlines += (t.match(/\n/g) || []).length
    const vis = t.replace(/\s/g, '')
    visible += vis.length
    if (vis.length <= 2) trash++
  }
  if (n >= DEGENERATE_TRASH_MIN_DELTAS && trash / n >= DEGENERATE_TRASH_RATIO && newlines > 0) return true
  if (newlines / Math.max(1, chars) >= DEGENERATE_NL_RATIO) return true
  if (chars >= DEGENERATE_BLANK_MIN_CHARS && visible / Math.max(1, chars) <= DEGENERATE_BLANK_MAX_VISIBLE_RATIO) return true
  return false
}

interface Account {
  refreshToken: string
  accessToken: string | null
  expiry: number
  cooldownUntil: number
  /** 模型级冷却：modelId → 冷却截止时间戳。仅该模型暂停，账号其它模型仍可用。 */
  modelCooldowns: Map<string, number>
}

interface Pool {
  accounts: Account[]
  accountIndex: number
  current: Account | null
  /** refreshToken 轮换回调：上游换发新 refreshToken 时触发，用于持久化到 KV，避免下次 invalid_grant。 */
  onRotate?: (oldRt: string, newRt: string) => void
}

const pools = new Map<string, Pool>()

function getPool(providerId: string, refreshTokens: string[]): Pool {
  const tokens = refreshTokens
    .map((t) => (t || '').trim())
    .filter((t) => t.length > 8)
  let pool = pools.get(providerId)
  const changed =
    !pool ||
    pool.accounts.length !== tokens.length ||
    pool.accounts.some((a, i) => a.refreshToken !== tokens[i])
  if (changed) {
    pool = {
      accounts: tokens.map((rt) => ({ refreshToken: rt, accessToken: null, expiry: 0, cooldownUntil: 0, modelCooldowns: new Map() })),
      accountIndex: 0,
      current: null,
    }
    pools.set(providerId, pool)
  }
  return pool!
}

/** 由 provider 的启用 apiKeys（即各账号 refreshToken）构造账号池。 */
function poolFromProvider(provider: Provider, env?: Env): Pool {
  const tokens = (provider.apiKeys || []).filter((k) => k.enabled).map((k) => k.key)
  const pool = getPool(provider.id, tokens)
  // refreshToken 轮换时回写 KV，避免下次 invalid_grant（永久 key 更新持久）。
  if (env) pool.onRotate = (oldRt, newRt) => { void persistClineRotation(env, provider, oldRt, newRt) }
  return pool
}

async function persistClineRotation(env: Env, provider: Provider, oldRt: string, newRt: string): Promise<void> {
  try {
    const apiKeys = (provider.apiKeys || []).map((k) => (k.key === oldRt ? { ...k, key: newRt } : k))
    if (!apiKeys.some((k) => k.key === oldRt)) return
    await updateProvider(env, provider.id, { apiKeys })
    provider.apiKeys = apiKeys
  } catch { /* 持久化失败不阻断请求，下一轮会重新刷新 */ }
}

// ===== 冷却时长计算（移植 cline2api-workers 的 parseCooldown / Retry-After 支持） =====

/** 解析 "Try again in 2h 51m / 30m / 15s" 这类文本为毫秒；仍封顶 6h。 */
export function parseCooldownMs(text: string): number | null {
  if (!text) return null
  let totalSec = 0
  let found = false
  const re = /(\d+)\s*(h(?:our)?s?|m(?:in(?:ute)?)?s?|s(?:ec(?:ond)?)?s?)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const n = parseInt(m[1], 10)
    const unit = m[2][0]
    totalSec += unit === 'h' ? n * 3600 : unit === 'm' ? n * 60 : n
    found = true
  }
  if (!found) return null
  return Math.min(totalSec * 1000, CLINE_COOLDOWN_MAX_MS)
}

/** 从响应取冷却时长：优先 Retry-After 头，其次响应体 "Try again in..."，否则用 fallbackMs。 */
function cooldownFromResponse(resp: Response, text: string, fallbackMs: number): number {
  const retryAfter = resp?.headers?.get?.('Retry-After')
  if (retryAfter) {
    const sec = parseInt(retryAfter, 10)
    if (!isNaN(sec) && sec > 0) return Math.min(sec * 1000, CLINE_COOLDOWN_MAX_MS)
  }
  const parsed = parseCooldownMs(text)
  if (parsed !== null) return parsed
  return fallbackMs
}

/** 冷却一个账号（整体冷却）。 */
function cooldownAccount(acc: Account, ms: number) {
  acc.cooldownUntil = Date.now() + ms
  acc.accessToken = null
  acc.expiry = 0
}

async function getAccountToken(account: Account, pool?: Pool): Promise<string> {
  const now = Date.now()
  if (account.cooldownUntil > now) throw new Error('account_cooldown')
  if (account.accessToken && now < account.expiry) return account.accessToken

  const resp = await fetch(CLINE_API_BASE + '/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: account.refreshToken, grantType: 'refresh_token' }),
    signal: AbortSignal.timeout(15000),
  })
  if (!resp.ok) {
    account.cooldownUntil = now + CLINE_COOLDOWN_401_MS
    throw new Error('refresh_failed')
  }
  const data = (await resp.json()) as { data?: { accessToken?: string; refreshToken?: string; expiresAt?: number | string } }
  const accessToken = data?.data?.accessToken
  if (!accessToken) {
    account.cooldownUntil = now + CLINE_COOLDOWN_401_MS
    throw new Error('refresh_no_token')
  }
  account.accessToken = accessToken
  // 轮换的新 refreshToken：更新内存并异步持久化到 KV（item2）
  const rotated = data?.data?.refreshToken
  if (rotated && rotated.length > 8 && rotated !== account.refreshToken) {
    const oldRt = account.refreshToken
    account.refreshToken = rotated
    try { pool?.onRotate?.(oldRt, rotated) } catch { /* onRotate 失败不影响 */ }
  }
  // 过期时间：优先服务端，兜底 10 分钟，留 60 秒余量
  const expiresAt = data?.data?.expiresAt
  let expiry = now + 10 * 60 * 1000
  if (typeof expiresAt === 'number') expiry = expiresAt
  else if (typeof expiresAt === 'string') {
    const t = Date.parse(expiresAt)
    if (!isNaN(t)) expiry = t
  }
  account.expiry = expiry - 60000
  return accessToken
}

/** 轮询选一个可用账号，取到 accessToken。全失败则清冷却重试一次最早的。（item7 支持模型级冷却） */
async function getAccessToken(pool: Pool, model?: string): Promise<string> {
  if (pool.accounts.length === 0) throw new Error('未配置 Cline RefreshToken')
  for (let attempt = 0; attempt < pool.accounts.length; attempt++) {
    const acc = pool.accounts[attempt % pool.accounts.length]
    if (acc.cooldownUntil && acc.cooldownUntil > Date.now()) continue
    if (model && acc.modelCooldowns.get(model) && (acc.modelCooldowns.get(model) as number) > Date.now()) continue
    pool.current = acc
    try {
      return await getAccountToken(acc, pool)
    } catch {
      continue // 刷新失败也切下个号
    }
  }
  const acc = pool.accounts[0]
  pool.current = acc
  acc.cooldownUntil = 0
  try {
    return await getAccountToken(acc, pool)
  } catch {
    throw new Error('所有账号刷新 token 均失败')
  }
}

async function clineFetch(
  pool: Pool,
  path: string,
  bodyObj: Record<string, unknown>,
  sessionId: string,
  retried = false
): Promise<Response> {
  const model = String((bodyObj as Record<string, unknown>).model || '')
  const token = await getAccessToken(pool, model || undefined)
  const headers = {
    Authorization: 'Bearer workos:' + token,
    'Content-Type': 'application/json',
    'X-Task-ID': sessionId,
    // item1：Cline 客户端指纹头，规避非官方客户端 403
    ...CLINE_FINGERPRINT_HEADERS,
  }
  const resp = await streamFetchWithTimeout(CLINE_API_BASE + path, {
    method: 'POST',
    headers,
    body: JSON.stringify(bodyObj),
  })
  // token 失效：标记当前账号冷却，强制重试（会用别的账号/刷新）
  if (resp.status === 401 && !retried) {
    if (pool.current) cooldownAccount(pool.current, CLINE_COOLDOWN_401_MS)
    return clineFetch(pool, path, bodyObj, sessionId, true)
  }
  return resp
}

// ===== 并发限流队列：上游免费通道并发 >1 会返回空响应，强制串行 + 间隔 =====

let queueTail: Promise<unknown> = Promise.resolve()
const MIN_GAP_MS = 800

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queueTail.then(() => sleep(MIN_GAP_MS)).then(fn)
  queueTail = run.catch(() => {})
  return run
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 带重试的上游转发：429/空响应自动冷却并切换账号 + 指数退避。item7 优先记模型级冷却。 */
async function clineFetchWithRetry(
  pool: Pool,
  path: string,
  bodyObj: Record<string, unknown>,
  sessionId: string,
  isStream: boolean,
  maxRetries = 4
): Promise<Response> {
  const model = String((bodyObj as Record<string, unknown>).model || '')
  // 冷却当前账号：优先模型级（该账号还能跑其它模型），无模型上下文则整体冷却。
  const applyCooldown = (ms: number) => {
    if (!pool.current) return
    if (model) pool.current.modelCooldowns.set(model, Date.now() + Math.max(ms, 60 * 1000))
    else cooldownAccount(pool.current, ms)
  }
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await enqueue(() => clineFetch(pool, path, bodyObj, sessionId))
    // 明确限流：冷却 + 切号重试
    if (resp.status === 429) {
      const text = await resp.clone().text().catch(() => '')
      applyCooldown(cooldownFromResponse(resp, text, CLINE_COOLDOWN_LIMIT_MS))
      const short = 500 + Math.floor(Math.random() * 500)
      await sleep(short)
      continue
    }
    if (resp.ok) {
      if (!isStream) {
        const text = await resp.clone().text()
        if (!text.includes('empty response content')) return resp
        // 免费额度耗尽空响应：冷却 + 切号
        applyCooldown(cooldownFromResponse(resp, text, CLINE_COOLDOWN_EMPTY_MS))
        await sleep(500 + Math.random() * 500)
        continue
      }
      // 流式：HTTP 200 直接转发，空流/错误由流式/聚合处理器判断
      return resp
    }
    // 非 2xx 且非 429：仅 5xx 这类可重试；403/400 直接返回（模型锁定 / 参数错误）
    const limitable = resp.status === 500 || resp.status === 502 || resp.status === 503 || resp.status === 504
    if (!limitable) return resp
    const errText = await resp.clone().text().catch(() => '')
    if (errText.includes('empty response content')) {
      // 5xx + 空响应：额度耗尽，冷却 + 切号
      applyCooldown(cooldownFromResponse(resp, errText, CLINE_COOLDOWN_EMPTY_MS))
      await sleep(500 + Math.random() * 500)
      continue
    }
    return resp
  }
  return enqueue(() => clineFetch(pool, path, bodyObj, sessionId))
}

// ===== 请求体构造 =====

function buildUpstreamBody(
  forwardBody: Record<string, unknown>,
  isStream: boolean,
  sessionId: string
): Record<string, unknown> {
  // 护栏语义：客户端显式带了 max_tokens 就原样透传（尊重其请求，不误掐长回答）；
  // 客户端没带才用 CLINE_MAX_TOKENS 兜底，避免空转把预算一路烧到几十万。
  const rawMax = forwardBody.max_tokens ?? forwardBody.max_completion_tokens
  const maxTokens =
    rawMax != null && rawMax !== ''
      ? Math.max(Math.floor(Number(rawMax)) || 1, 1)
      : CLINE_MAX_TOKENS
  const body: Record<string, unknown> = {
    model: (forwardBody.model as string) || DEFAULT_MODEL,
    max_tokens: maxTokens,
    session_id: sessionId,
    reasoning_effort: String(forwardBody.reasoning_effort || forwardBody.reasoningEffort || CLINE_DEFAULT_REASONING_EFFORT),
    messages: Array.isArray(forwardBody.messages) ? forwardBody.messages : [],
  }
  if (isStream) body.stream = true
  const passthrough = [
    'temperature', 'top_p', 'tools', 'tool_choice', 'stop',
    'presence_penalty', 'frequency_penalty', 'response_format', 'user', 'n', 'seed',
  ] as const
  for (const k of passthrough) {
    if ((forwardBody as Record<string, unknown>)[k] !== undefined) body[k] = (forwardBody as Record<string, unknown>)[k]
  }
  return body
}

// ===== 响应处理 =====

/** 剥掉上游 {data:{...}} 包装（上游有时包一层 data）。 */
function unwrapData(obj: unknown): unknown {
  if (obj && typeof obj === 'object' && (obj as any).data && typeof (obj as any).data === 'object') {
    const d = (obj as any).data
    if (d.choices || d.id || d.usage) return d
  }
  return obj
}

/** OpenAI SSE 流式帧规整（剥 data 包装），返回要写给客户端的原始文本行；无变化返回 null。 */
function normalizeSSELine(line: string): string | null {
  if (!line.startsWith('data:')) return line + '\n'
  const payload = line.slice(5).trim()
  if (payload === '' || payload === '[DONE]') return line + '\n\n'
  try {
    const normalized = unwrapData(JSON.parse(payload))
    return 'data: ' + JSON.stringify(normalized) + '\n\n'
  } catch {
    return line + '\n'
  }
}

/** 从一帧规整后的 payload 提取 (finish_reason, content 长度, 是否 tool_calls, reasoning 片段)。 */
interface FrameFacts {
  finishReason: string
  contentChars: number
  hasToolCalls: boolean
  reasoningDelta: string | null
}

function inspectFrame(obj: Record<string, unknown> | null): FrameFacts {
  const facts: FrameFacts = { finishReason: '', contentChars: 0, hasToolCalls: false, reasoningDelta: null }
  if (!obj) return facts
  const choice = (((obj.choices as Array<Record<string, unknown>>) || [])[0]) as Record<string, unknown> | undefined
  if (!choice) return facts
  if (choice.finish_reason) facts.finishReason = String(choice.finish_reason)
  const delta = (choice.delta || choice.message) as Record<string, unknown> | undefined
  if (!delta) return facts
  if (delta.content) facts.contentChars = String(delta.content).length
  if (delta.tool_calls && Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) facts.hasToolCalls = true
  const r = (delta.reasoning_content ?? delta.reasoning) as string | undefined
  if (r) facts.reasoningDelta = String(r)
  return facts
}

interface StreamAttemptOutcome {
  kind: 'healthy' | 'degenerate' | 'empty'
  response?: Response
  /** healthy 但透传期触发了抑制空转（全程无产出），调用方仍应冷却该账号。 */
  runaway?: boolean
}

/**
 * 单次流式尝试：探测期缓冲前 PROBE_MAX_DELTAS 条 reasoning delta，用退化检测器判定——
 * 退化 → 取消上游，调用方冷却换号重试；健康 → 一次性放行缓冲帧后转实时透传，
 * 并用滚动窗口持续监控，退化中途出现则抑制后续 reasoning delta（垃圾不再直播到客户端 UI），
 * 全程未产出正文时按空转冷却处理。
 */
async function pumpStreamAttempt(resp: Response): Promise<StreamAttemptOutcome> {
  const reader = resp.body!.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buf = ''
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  let readable: ReadableStream<Uint8Array> | null = null
  const buffered: string[] = []
  const probeDeltas: string[] = []
  let ring: string[] = []
  let suppress = false
  let runaway = false
  let contentChars = 0
  let hasToolCalls = false
  let finishReason = ''

  const openWriter = async (): Promise<WritableStreamDefaultWriter<Uint8Array>> => {
    const ts = new TransformStream<Uint8Array, Uint8Array>()
    readable = ts.readable
    const w = ts.writable.getWriter()
    for (const f of buffered) await w.write(encoder.encode(f))
    buffered.length = 0
    ring = probeDeltas.slice(-RING_SIZE)
    return w
  }

  const writeOut = async (out: string) => {
    if (writer) await writer.write(encoder.encode(out))
    else buffered.push(out)
  }

  const degenerateNow = () =>
    probeDeltas.length >= DEGENERATE_MIN_DELTAS && isDegenerateReasoningDeltas(probeDeltas)

  const finishResponse = async (): Promise<Response> => {
    const w = await openWriter()
    await w.close().catch(() => {})
    return new Response(readable!, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' },
    })
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        const out = normalizeSSELine(line)

        if (!line.startsWith('data:')) {
          if (out) await writeOut(out)
          continue
        }
        const payload = line.slice(5).trim()
        if (payload === '' || payload === '[DONE]') {
          if (out) await writeOut(out)
          continue
        }
        let obj: Record<string, unknown> | null = null
        try { obj = unwrapData(JSON.parse(payload)) as Record<string, unknown> } catch { obj = null }
        const facts = inspectFrame(obj)
        if (facts.finishReason) finishReason = facts.finishReason
        contentChars += facts.contentChars
        if (facts.hasToolCalls) hasToolCalls = true

        const isReasoningFrame = facts.reasoningDelta !== null
        if (!writer) {
          // ---- 探测期：缓冲 + 判定 ----
          if (isReasoningFrame) probeDeltas.push(facts.reasoningDelta as string)
          if (facts.contentChars > 0 || hasToolCalls) {
            // 模型已开始产出正文/工具调用 → 放行
            writer = await openWriter()
            await writeOut(out!)
            continue
          }
          if (probeDeltas.length >= PROBE_MAX_DELTAS) {
            if (degenerateNow()) {
              await reader.cancel().catch(() => {})
              return { kind: 'degenerate' }
            }
            writer = await openWriter()
            await writeOut(out!)
            continue
          }
          if (finishReason) {
            // 上游在窗口内就结束了：退化 → 拦截重试；空转 length → 按空响应处理；否则照常放行
            if (degenerateNow()) {
              await reader.cancel().catch(() => {})
              return { kind: 'degenerate' }
            }
            if (finishReason === 'length' && contentChars === 0 && !hasToolCalls) {
              await reader.cancel().catch(() => {})
              return { kind: 'empty' }
            }
            writer = await openWriter()
            await writer!.close().catch(() => {})
            return { kind: 'healthy', response: new Response(readable!, {
              status: 200,
              headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' },
            }) }
          }
          if (out) await writeOut(out)
          continue
        }

        // ---- 透传期：滚动监控，退化中途出现则抑制 reasoning 帧 ----
        if (suppress && isReasoningFrame) continue
        if (!suppress && isReasoningFrame) {
          ring.push(facts.reasoningDelta as string)
          if (ring.length > RING_SIZE) ring.shift()
          if (ring.length >= DEGENERATE_MIN_DELTAS && isDegenerateReasoningDeltas(ring)) suppress = true
          if (suppress) continue
        }
        if (facts.finishReason && suppress && contentChars === 0 && !hasToolCalls) {
          // 已抑制 + 全程无产出：按空转处理（上游冷却），向客户端明确报错而不是静默空结束
          runaway = true
          const errMsg = { error: { message: 'Cline 推理退化空转：全程未产出正文，已抑制垃圾 reasoning', type: 'upstream_runaway' } }
          await writer.write(encoder.encode('data: ' + JSON.stringify(errMsg) + '\n\n'))
        }
        if (out) await writer.write(encoder.encode(out))
      }
    }
  } catch {
    /* 上游流异常：探测期按空响应处理，透传期尽力收尾 */
  }

  if (writer) {
    await writer.close().catch(() => {})
    return { kind: 'healthy', runaway, response: new Response(readable!, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' },
    }) }
  }
  // 流在探测期内结束：退化 → 拦截；有缓冲内容 → 放行；纯空 → 空响应
  if (degenerateNow()) {
    await reader.cancel().catch(() => {})
    return { kind: 'degenerate' }
  }
  if (buffered.length > 0) return { kind: 'healthy', response: await finishResponse() }
  await reader.cancel().catch(() => {})
  return { kind: 'empty' }
}

/** 模型级冷却（与 clineFetchWithRetry 同语义：有 model 上下文时只冷却该账号的该模型）。 */
function applyModelCooldown(pool: Pool, model: string, ms: number) {
  if (!pool.current) return
  if (model) pool.current.modelCooldowns.set(model, Date.now() + Math.max(ms, 60 * 1000))
  else cooldownAccount(pool.current, ms)
}

/**
 * 流式转发（带推理空转防护）：最多 3 次尝试，退化/空响应冷却切号重试；
 * 全部失败时返回 502 错误 JSON（客户端按错误处理，可自行重试）。
 */
async function proxyStreamChat(pool: Pool, body: Record<string, unknown>, sessionId: string): Promise<Response> {
  const model = String((body as Record<string, unknown>).model || '')
  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await clineFetchWithRetry(pool, '/chat/completions', body, sessionId, true)
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      return jsonResponse(
        { error: { message: `Cline 上游 HTTP ${resp.status}: ${errText.slice(0, 300)}`, type: 'upstream_error' } },
        resp.status || 502
      )
    }
    const outcome = await pumpStreamAttempt(resp)
    if (outcome.kind === 'healthy') {
      if (outcome.runaway) applyModelCooldown(pool, model, CLINE_COOLDOWN_RUNAWAY_MS)
      return outcome.response!
    }
    applyModelCooldown(pool, model, outcome.kind === 'degenerate' ? CLINE_COOLDOWN_RUNAWAY_MS : CLINE_COOLDOWN_EMPTY_MS)
    await sleep(500 + Math.random() * 500)
  }
  return jsonResponse(
    { error: { message: 'Cline 推理退化/空响应连续 3 次未产出正文，已冷却换号仍失败', type: 'upstream_runaway' } },
    502
  )
}

function jsonResponse(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

// ===== 非流式聚合（item4/5）：上游恒定流式，客户端要非流式时把 SSE 聚合成 chat.completion =====

interface AggregatedChat {
  id: string
  model: string
  created: number
  content: string
  reasoning: string
  toolCalls: Array<{ id: string; name: string; arguments: string }>
  usage: Record<string, unknown> | null
  finishReason: string
}

/** 读取整段上游 SSE，累积 content / reasoning / tool_calls / usage，返回聚合后的 chat 状态。 */
async function aggregateStream(upstream: Response): Promise<AggregatedChat> {
  const reader = upstream.body!.getReader()
  const decoder = new TextDecoder()
  const toolIndex = new Map<number, number>()
  const acc: AggregatedChat = { id: '', model: '', created: 0, content: '', reasoning: '', toolCalls: [], usage: null, finishReason: '' }
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '' || payload === '[DONE]') continue
      try {
        const obj = JSON.parse(payload) as Record<string, unknown>
        const o = unwrapData(obj) as Record<string, unknown>
        if (o.id) acc.id = String(o.id)
        if (o.model) acc.model = String(o.model)
        if (o.created) acc.created = Number(o.created)
        if (o.usage) acc.usage = o.usage as Record<string, unknown>
        const choice = (((o.choices as Array<Record<string, unknown>>) || [])[0]) as Record<string, unknown> | undefined
        if (!choice) continue
        if (choice.finish_reason) acc.finishReason = String(choice.finish_reason)
        const delta = (choice.delta || choice.message) as Record<string, unknown> | undefined
        if (!delta) continue
        if (delta.content) acc.content += String(delta.content)
        if (delta.reasoning_content) acc.reasoning += String(delta.reasoning_content)
        else if (delta.reasoning) acc.reasoning += String(delta.reasoning)
        const tcs = delta.tool_calls as Array<Record<string, unknown>> | undefined
        if (Array.isArray(tcs)) {
          for (const tc of tcs) {
            const i = Number(tc.index ?? 0)
            const fn = tc.function as Record<string, unknown> | undefined
            if (tc.id && fn) {
              toolIndex.set(i, acc.toolCalls.length)
              acc.toolCalls.push({ id: String(tc.id), name: String(fn.name || ''), arguments: String(fn.arguments || '') })
            } else if (fn?.arguments) {
              const ti = toolIndex.get(i)
              if (ti !== undefined) acc.toolCalls[ti].arguments += String(fn.arguments)
            }
          }
        }
      } catch { /* 解析失败忽略 */ }
    }
  }
  return acc
}

/** 聚合结果 → OpenAI 非流式 chat.completion JSON。 */
function chatCompletionFromAgg(a: AggregatedChat): Record<string, unknown> {
  const message: Record<string, unknown> = { role: 'assistant', content: a.content }
  if (a.reasoning) message['reasoning_content'] = a.reasoning
  if (a.toolCalls.length) {
    message['tool_calls'] = a.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } }))
  }
  return {
    id: a.id || 'chatcmpl-' + Date.now(),
    object: 'chat.completion',
    created: a.created || Math.floor(Date.now() / 1000),
    model: a.model,
    choices: [{ index: 0, message, finish_reason: a.finishReason || 'stop' }],
    usage: a.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }
}

/**
 * 非流式转发：上游已是 SSE，聚合成非流式。content 为空时冷却当前账号切号重试（最多 3 次），
 * 最后仍空则把 reasoning 兜底拼进 content，避免"静默不回复"（item5）。
 */
async function proxyNonStreamChat(pool: Pool, body: Record<string, unknown>, sessionId: string): Promise<Response> {
  // 恒流式前置：无论调用方 body 是否带 stream，一律强制 stream:true，
  // 否则免费通道非流式返回 500 "empty response content"（item4 修复测试/直连等手工 body 场景）。
  body['stream'] = true
  let last: AggregatedChat | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await clineFetchWithRetry(pool, '/chat/completions', body, sessionId, true)
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      return jsonResponse(
        { error: { message: `Cline 上游 HTTP ${resp.status}: ${errText.slice(0, 300)}`, type: 'upstream_error' } },
        resp.status || 502
      )
    }
    const agg = await aggregateStream(resp)
    last = agg
    if (agg.content) return jsonResponse(chatCompletionFromAgg(agg), 200)
    // 推理空转被截断（length + 无正文/无工具调用）：预算烧在 reasoning 上未产出 → 冷却切号重试
    if (isRunawayReasoningCutoff(agg.content, agg.toolCalls, agg.finishReason)) {
      if (pool.current) cooldownAccount(pool.current, CLINE_COOLDOWN_RUNAWAY_MS)
      await sleep(500 + Math.random() * 500)
      continue
    }
    // 有正常结束原因但无文本：不空转重试（如 stop/tool_calls 但 content 空，属合法但不该重试）
    if (agg.finishReason) break
    if (pool.current) cooldownAccount(pool.current, CLINE_COOLDOWN_EMPTY_MS)
    await sleep(500 + Math.random() * 500)
  }
  if (last && last.content === '' && last.reasoning) last.content = last.reasoning
  return jsonResponse(chatCompletionFromAgg(last as AggregatedChat), 200)
}

// ===== 对外接口 =====

export interface ClineProxyOptions {
  /** 客户端是否要求流式（false 时聚合为非流式 chat.completion） */
  stream?: boolean
}

/**
 * 转发一次 chat 请求到 Cline 上游。
 * 返回 Response：
 *   - stream=true：OpenAI SSE（剥掉 data 包装后的透传）
 *   - stream=false：剥掉 data 包装后的非流式 chat.completion JSON
 */
export async function proxyClineChatRequest(
  _env: unknown,
  provider: Provider,
  forwardBody: Record<string, unknown>,
  opts?: ClineProxyOptions
): Promise<Response> {
  const pool = poolFromProvider(provider, _env as Env)
  const wantStream = opts ? !!opts.stream : forwardBody.stream === true
  const sessionId = 'sess_' + Date.now()
  // 上游恒定强制流式（item4）：免费通道非流式返回 500 "empty response content"，
  // 统一以流式取数，客户端要非流式时再聚合成 chat.completion。
  const body = buildUpstreamBody(forwardBody, true, sessionId)
  try {
    if (wantStream) {
      // 2026-09-05：流式不再纯透传（原 streamSSE），改为带推理退化防护的流式转发：
      // 探测期判定空转 → 冷却换号重试；健康才放行，透传期持续抑制退化 reasoning。
      return await proxyStreamChat(pool, body, sessionId)
    }
    return await proxyNonStreamChat(pool, body, sessionId)
  } catch (err) {
    return jsonResponse({ error: { message: (err as Error).message || 'Cline 转发失败', type: 'api_error' } }, 500)
  }
}

/** 返回 Cline 实测可用模型列表（普通 JSON，供管理面板拉取模型）。 */
export function fetchClineModels(): { ok: true; message: string; models: Array<{ id: string }> } {
  return {
    ok: true,
    message: 'success',
    models: CLINE_MODELS.map((m) => ({ id: m.id })),
  }
}

// ===== 动态模型同步（item6，移植自 luawei1/cline2api models_sync.go） =====

const CLINE_RECOMMENDED_URL = 'https://api.cline.bot/api/v1/ai/cline/recommended-models'

export interface RemoteClineModel { id: string; cost: 'free' | 'pass' }

/** 拉取 Cline 官方推荐/免费/订阅模型清单（免认证），按 free 优先去重。 */
export async function fetchClineRecommendedModels(): Promise<RemoteClineModel[]> {
  const resp = await fetch(CLINE_RECOMMENDED_URL, { signal: AbortSignal.timeout(10000) })
  if (!resp.ok) throw new Error(`recommended-models HTTP ${resp.status}`)
  const data = (await resp.json()) as {
    recommended?: Array<{ id?: string; tags?: string[] }>
    free?: Array<{ id?: string }>
    clinePass?: Array<{ id?: string }>
  }
  const out: RemoteClineModel[] = []
  const seen = new Set<string>()
  const add = (list: Array<{ id?: string; tags?: string[] }> | undefined, cost: 'free' | 'pass') => {
    for (const m of list || []) {
      const id = m?.id
      if (!id || seen.has(id)) continue
      // recommended 组按 tags 是否含 FREE 判定，否则 pass
      const c = cost !== 'free' && Array.isArray(m?.tags) && m.tags.some((t) => (t || '').toUpperCase() === 'FREE') ? 'free' : cost
      seen.add(id)
      out.push({ id, cost: c })
    }
  }
  add(data.free, 'free')
  add(data.recommended, 'pass')
  add(data.clinePass, 'pass')
  return out
}

// ===== 每日健康检查（item10，移植自 Go 版冷却自愈：探活并刷新过期 token） =====

export interface ClineHealthSummary {
  providers: number
  accounts: number
  ok: number
  failed: number
  errors: number
}

/** 遍历 Cline 提供商，逐个账号刷新 accessToken（临期/过期自动刷新，失败标记冷却），并持久化轮换的新 refreshToken。 */
export async function healthCheckClineAll(env: Env): Promise<ClineHealthSummary> {
  let providers = 0
  let accounts = 0
  let ok = 0
  let failed = 0
  let errors = 0
  try {
    const list = await getProviders(env)
    for (const p of list) {
      if (!isClineProvider(p.id)) continue
      providers++
      const enabled = (p.apiKeys || []).filter((k) => k.enabled)
      if (enabled.length === 0) continue
      const pool = getPool(p.id, enabled.map((k) => k.key))
      pool.onRotate = (oldRt, newRt) => { void persistClineRotation(env, p, oldRt, newRt) }
      for (const acc of pool.accounts) {
        accounts++
        acc.cooldownUntil = 0 // 探活忽略既有冷却，尝试复活
        try {
          await getAccountToken(acc, pool)
          ok++
        } catch {
          failed++ // getAccountToken 失败时已标记冷却
        }
      }
    }
  } catch {
    errors++
  }
  return { providers, accounts, ok, failed, errors }
}

/** 校验单个 refreshToken 是否能换取 accessToken（管理面板"测试"用）。 */
export async function testClineRefreshToken(refreshToken: string): Promise<{ success: boolean; message: string; statusCode?: number }> {
  const acc: Account = { refreshToken: refreshToken.trim(), accessToken: null, expiry: 0, cooldownUntil: 0, modelCooldowns: new Map() }
  try {
    await getAccountToken(acc)
    return { success: true, message: 'RefreshToken 有效' }
  } catch (err) {
    return { success: false, message: (err as Error).message || 'RefreshToken 无效' }
  }
}

/** 用给定账号池发送一个最小 chat 请求来测试模型可用性。 */
export async function testClineChat(
  refreshTokens: string[],
  modelId: string
): Promise<{ success: boolean; message: string; statusCode?: number }> {
  const pool = getPool('__cline_test__', refreshTokens)
  const sessionId = 'sess_test_' + Date.now()
  try {
    const body: Record<string, unknown> = {
      model: modelId || DEFAULT_MODEL,
      // 推理模型思考阶段也要消耗 token：max_tokens 太小会一进 reasoning 就 length 截断，
      // 导致"空内容"。给足量让模型能走完思考并产出正文。
      max_tokens: 600,
      session_id: sessionId,
      reasoning_effort: 'medium',
      messages: [{ role: 'user', content: 'hi' }],
    }
    // 走非流式聚合通道：规避免费通道非流式 500，并能在聚合结果里判断模型是否真实回复
    const resp = await proxyNonStreamChat(pool, body, sessionId)
    if (resp.status === 200) {
      const data = (await resp.json().catch(() => null)) as {
        choices?: Array<{ message?: { content?: string; reasoning_content?: string; tool_calls?: unknown[] }; finish_reason?: string }>
      } | null
      const message = data?.choices?.[0]?.message || {}
      const content = String(message.content || '')
      const reasoning = String(message.reasoning_content || '')
      const finishReason = String(data?.choices?.[0]?.finish_reason || '')
      if (content) return { success: true, statusCode: 200, message: `模型可回复（${content.slice(0, 50)}）` }
      // 有思考但没正文：模型是通的（推理模型），只是本次没吐文本
      if (reasoning) return { success: true, statusCode: 200, message: `模型已连通（${reasoning.slice(0, 50)}…）` }
      const detail = finishReason ? `（finish_reason=${finishReason}）` : ''
      return { success: false, statusCode: 200, message: `模型返回空内容${detail}，免费额度可能已耗尽或该模型暂无可输出，请换号或改用 poolside/laguna-s-2.1:free` }
    }
    const t = await resp.text().catch(() => '').then((s) => s.slice(0, 300))
    // 官方锁定模型（仅 Cline 产品界面可用）与需订阅模型的 403，给出更明确的提示
    if (resp.status === 403 && /only available via Cline product surfaces|not available/i.test(t)) {
      return { success: false, statusCode: resp.status, message: '该模型已被 Cline 官方锁定（仅 Cline 产品界面可用），请改用 poolside/laguna-s-2.1:free' }
    }
    if (resp.status === 403 && /cline-pass/i.test(t)) {
      return { success: false, statusCode: resp.status, message: '该模型需要付费订阅 cline-pass 才能使用' }
    }
    return { success: false, statusCode: resp.status, message: `HTTP ${resp.status}: ${t}` }
  } catch (err) {
    return { success: false, message: (err as Error).message || '测试失败' }
  }
}

// ===== 一键授权（WorkOS 设备码流程，与原项目 cline_oauth.py 一致） =====
//
// 流程（逆向自 cline2api/auth.go 和 cline_oauth.py）：
//   1. POST api.workos.com/user_management/authorize/device（表单 client_id）
//      → 返回 device_code + user_code + 授权链接
//   2. 用户在浏览器打开链接，用 Google/GitHub/邮箱登录授权（即注册的 Cline 账号）
//   3. 轮询 POST api.workos.com/user_management/authenticate
//      → 授权成功后拿 WorkOS access_token + refresh_token
//   4. POST api.cline.bot/api/v1/auth/register（{accessToken, refreshToken}）
//      → 返回值 data.refreshToken 即 Cline 账号的"长期钥匙"
//   5. 把 refreshToken 追加进该提供商的 apiKeys（启用），完成接入

export const CLINE_WORKOS_CLIENT_ID = 'client_01K3A541FN8TA3EPPHTD2325AR'
const CLINE_WORKOS_DEVICE = 'https://api.workos.com/user_management/authorize/device'
const CLINE_WORKOS_AUTH = 'https://api.workos.com/user_management/authenticate'
const CLINE_REGISTER = 'https://api.cline.bot/api/v1/auth/register'
const CLINE_DEVICE_TTL_SEC = 900 // 设备码 15 分钟有效，到期自清理

const clineDeviceKey = (providerId: string) => 'cline:device:' + providerId

interface ClineDeviceState {
  device_code: string
  user_code: string
  verification_uri: string
  interval: number
  expires_at: number
}

export interface StartClineOAuthResult {
  success: boolean
  message: string
  device?: { user_code: string; verification_uri: string; interval: number; expires_at: number }
}

/** 发起 Cline 一键授权，生成 WorkOS 设备码与授权链接。 */
export async function startClineOAuth(env: Env, providerId: string): Promise<StartClineOAuthResult> {
  try {
    const body = new URLSearchParams({ client_id: CLINE_WORKOS_CLIENT_ID })
    const res = await fetch(CLINE_WORKOS_DEVICE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) {
      return { success: false, message: `申请设备码失败 HTTP ${res.status}: ${(await res.text()).substring(0, 200)}` }
    }
    const data = (await res.json()) as {
      device_code?: string
      user_code?: string
      verification_uri_complete?: string
      verification_uri?: string
      interval?: number
      expires_in?: number
    }
    if (!data.device_code || !data.user_code) {
      return { success: false, message: 'WorkOS 设备码接口返回格式异常' }
    }
    const state: ClineDeviceState = {
      device_code: data.device_code,
      user_code: data.user_code,
      verification_uri: data.verification_uri_complete || data.verification_uri || '',
      interval: Math.max(data.interval || 5, 5),
      expires_at: Date.now() + (data.expires_in || 300) * 1000,
    }
    await env.KV.put(clineDeviceKey(providerId), JSON.stringify(state), { expirationTtl: CLINE_DEVICE_TTL_SEC })
    return {
      success: true,
      message: '设备码已生成',
      device: {
        user_code: state.user_code,
        verification_uri: state.verification_uri,
        interval: state.interval,
        expires_at: state.expires_at,
      },
    }
  } catch (err) {
    return { success: false, message: `申请设备码异常: ${(err as Error).message || '未知错误'}` }
  }
}

export type ClineOAuthPollResult =
  | { status: 'pending'; message: string }
  | { status: 'success'; message: string; refreshToken: string }
  | { status: 'failed'; message: string }
  | { status: 'error'; message: string }

/** 轮询 WorkOS 授权结果；授权成功后调 register 换 Cline refreshToken 并存入账号池。 */
export async function pollClineOAuth(env: Env, provider: Provider): Promise<ClineOAuthPollResult> {
  const raw = await env.KV.get(clineDeviceKey(provider.id))
  if (!raw) return { status: 'error', message: '没有进行中的登录流程，请重新发起' }
  let state: ClineDeviceState
  try { state = JSON.parse(raw) as ClineDeviceState } catch {
    await env.KV.delete(clineDeviceKey(provider.id))
    return { status: 'error', message: '设备码数据异常，请重新发起' }
  }
  if (Date.now() > state.expires_at) {
    await env.KV.delete(clineDeviceKey(provider.id))
    return { status: 'failed', message: '设备码已过期，请重新发起' }
  }

  try {
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: state.device_code,
      client_id: CLINE_WORKOS_CLIENT_ID,
    })
    const res = await fetch(CLINE_WORKOS_AUTH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    })

    if (!res.ok) {
      const errorData = (await res.json().catch(() => ({ error: 'unknown' }))) as { error?: string; error_description?: string }
      switch (errorData.error) {
        case 'authorization_pending':
          return { status: 'pending', message: '等待用户授权…' }
        case 'slow_down':
          return { status: 'pending', message: '轮询过快，请稍候重试' }
        case 'expired_token':
          await env.KV.delete(clineDeviceKey(provider.id))
          return { status: 'failed', message: '设备码已过期，请重新发起' }
        case 'access_denied':
          await env.KV.delete(clineDeviceKey(provider.id))
          return { status: 'failed', message: '用户拒绝了授权' }
        default:
          return { status: 'error', message: `轮询异常: ${errorData.error_description || errorData.error || res.status}` }
      }
    }

    const workos = (await res.json()) as { access_token?: string; refresh_token?: string }
    if (!workos.access_token) return { status: 'error', message: '轮询接口返回异常：缺少 access_token' }

    // 用 WorkOS token 在 Cline 注册，换 Cline refreshToken
    const regRes = await fetch(CLINE_REGISTER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: workos.access_token, refreshToken: workos.refresh_token || '' }),
      signal: AbortSignal.timeout(20000),
    })
    const regData = (await regRes.json().catch(() => ({}))) as { data?: { refreshToken?: string } }
    const clineRefreshToken = regData?.data?.refreshToken
    if (!clineRefreshToken) {
      return { status: 'error', message: 'Cline 注册失败，未获取到 refreshToken，请重试（可能需要稍后清理重发）' }
    }

    // 存入账号池（enabled 去重追加）
    const apiKeys = [...(provider.apiKeys || [])]
    if (!apiKeys.some((k) => k.key === clineRefreshToken)) {
      apiKeys.push({ key: clineRefreshToken, enabled: true })
      await updateProvider(env, provider.id, { apiKeys })
    }

    await env.KV.delete(clineDeviceKey(provider.id))
    return { status: 'success', message: '授权成功，已添加 Cline 账号', refreshToken: clineRefreshToken }
  } catch (err) {
    return { status: 'error', message: `轮询异常: ${(err as Error).message || '未知错误'}` }
  }
}