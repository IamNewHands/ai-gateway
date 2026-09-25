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
 * 模型分档（2026-09-24 实测 https://api.cline.bot/api/v1/ai/cline/recommended-models）：
 *   free 档（走官方免费额度，不需 credits）：cline-free/gemini-3.8-flash、
 *     stealth/space-bunny-alpha、cline-free/mimo-v2.6-flash、
 *     cline-free/deepseek-v4.1-flash、cline-free/muse-spark-1.3-contributor；
 *   cline-pass/* 需付费订阅；其余（如 z-ai/glm-5.3-flash）走 credits 计费档，
 *     余额不足返回 402 insufficient_credits。
 *
 * ⚠️ 免费判定必须用「free 列表成员」而非前缀：stealth/space-bunny-alpha 是免费模型
 *    但没有 cline-free/ 前缀，前缀判定会把它当计费档 → 402。
 */

import type { Env, Provider } from '../types'
import { updateProvider, getProviders } from '../storage'
import { streamFetchWithTimeout } from '../opencode'
// 通用 tool 配对工具（纯函数、与提供商无关）：Cline 出站历史同样需要清孤儿 tool 结果。
// 复用而非复制，避免两份实现漂移（owner 仍在 workbuddy-upstream.ts）。
import { cleanupOrphanToolCalls } from '../workbuddy-upstream'

export const CLINE_PROVIDER_ID = 'cline'
export const CLINE_API_BASE = 'https://api.cline.bot/api/v1'

/** 默认模型：Cline 官方免费额度通道（对齐上游 cline2api-workers 1.1.8 的 DEFAULT_MODEL）。 */
export const DEFAULT_MODEL = 'cline-free/deepseek-v4.1-flash'

/**
 * 静态兜底模型表（2026-09-24 实测）。
 * 动态目录拉取成功时以动态结果为准；本表仅在拉取失败时兜底，并供后台「获取模型」预填。
 */
export const CLINE_MODELS: Array<{ id: string; provider: string; cost: string }> = [
  { id: 'cline-free/deepseek-v4.1-flash', provider: 'cline-free', cost: 'free' },
  { id: 'cline-free/gemini-3.8-flash', provider: 'cline-free', cost: 'free' },
  { id: 'cline-free/mimo-v2.6-flash', provider: 'cline-free', cost: 'free' },
  { id: 'cline-free/muse-spark-1.3-contributor', provider: 'cline-free', cost: 'free' },
  { id: 'stealth/space-bunny-alpha', provider: 'stealth', cost: 'free' },
  { id: 'cline-pass/glm-5.3', provider: 'zai', cost: 'pass' },
  { id: 'cline-pass/deepseek-v4.1-flash', provider: 'deepseek', cost: 'pass' },
  { id: 'cline-pass/qwen3.8-max', provider: 'qwen', cost: 'pass' },
]

/**
 * Cline 官方免费白名单（移植 cline2api-workers worker.js `refreshModels` 的 FREE_WHITELIST）。
 * 这些 ID 在 `/v1/models` 里没有 `:free` 后缀，但走官方免费额度，必须显式识别。
 */
export const CLINE_FREE_WHITELIST: readonly string[] = [
  'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-v4-flash-0731',
  'z-ai/glm-5.3-flash',
  'z-ai/glm-5.2:free',
  'xiaomi/mimo-v2.5',
  'minimax/minimax-m3',
  'poolside/laguna-s-2.1',
  'cline-free/deepseek-v4.1-flash',
  'cline-free/muse-spark-1.3-contributor',
  'cline-free/solar-pro4',
]

/** 免费链末位兜底（对齐上游 freeModelLastResort）。 */
export const CLINE_FREE_LAST_RESORT = 'cline-free/deepseek-v4.1-flash'

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
 * 余额/权益耗尽（402 insufficient_credits）的模型级冷却默认时长。
 *
 * 402 的语义是「该模型走 credits 计费档，而当前账号余额不足」——**不代表账号不能跑免费模型**，
 * 所以只冷却「账号 × 该模型」这一格，由免费链换模型；整体冷却账号会把后续免费模型一起打死。
 * 时长给足 12h（余额耗尽不会自愈，除非充值或次日探活复活），但下一次请求若该模型仍被点名，
 * 免费链会直接跳过它，不再空转打上游。
 */
const CLINE_COOLDOWN_PLAN_MS = 12 * 3600 * 1000
/**
 * 上游对输出 token 的硬下限（移植 luawei1/cline2api 1184f91）。
 *
 * Cline 免费模型经 OpenRouter 转发时（如 meta/muse-spark），max_output_tokens < 16
 * 会被上游直接 400，且错误会被免费模型回退链吞掉。故非免费通道把 < 16 兜到默认值。
 */
const CLINE_MIN_UPSTREAM_MAX_TOKENS = 16

/**
 * max_tokens「护栏默认」与 effort 默认档（推理空转防御）。
 *
 * 实测（2026-09 一份 108 轮 cline/z-ai 会话）：正常轮次 reasoning 中位仅 ~1.5k 字符、
 * 重的工具轮 ~10k–55k；真正病态的轮次是「推理退化空转」——吐 ~3.2 万条 reasoning 里
 * 95% 是空白/换行、几乎不产出正文，最后以 length 截断。而 OpenAI 兼容推理模型把
 * reasoning 与最终答案共用一个 max_tokens 总预算，空转会一次性烧光它。
 *
 * 因此把原来无脑兜底 128000 换成「护栏语义」，并按通道分档（2026-09-24 移植）：
 *   - **免费档**（官方免费额度通道）：**剥离 max_tokens / max_completion_tokens**。
 *     上游风控「免费模型请求体带 max_tokens 一律 500 empty response content」
 *     （移植 cline2api-workers v1.1.8 `43a2930`）。已知代价：上游按自己节奏生成，
 *     客户端无法提前截断——这是上游明示的取舍。
 *   - **非免费档**：保留客户端值；低于上游硬下限 `CLINE_MIN_UPSTREAM_MAX_TOKENS` 的
 *     兜到 CLINE_MAX_TOKENS（移植 luawei1/cline2api `1184f91`，防 OpenRouter 转发 400）。
 *   - 客户端没带时同样兜 CLINE_MAX_TOKENS，避免空转烧光几十万预算。
 * 空转的兜底见 isRunawayReasoningCutoff + proxyNonStreamChat 的重试/冷却。
 *
 * 2026-09-05 复盘：昨天只把空转兜底挂在非流式路径（proxyNonStreamChat），而 DSH 等
 * 客户端走的是流式透传（streamSSE 直通），退化照样直播到 UI（思考一屏一屏的换行/空格），
 * 预算也照样被烧光直到 length 截断。本次给流式加同等防护：
 *   - isDegenerateReasoningDeltas：流式早期退化检测（阈值按 342 个真实 reasoning 步校准）；
 *   - proxyStreamChat：探测期缓冲 → 退化则取消上游 + 冷却 + 换号重试；健康才放行，
 *     放行后继续滚动监控，退化中途出现则抑制后续 reasoning delta（不再往 UI 直播垃圾）。
 */
export const CLINE_MAX_TOKENS = 32768          // 客户端未指定 max_tokens 时的护栏默认（原 128000 过激进）
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

// ===== 推理退化检测（流式防护，2026-09-05，v2 校准） =====

// v1 用「空白碎片 delta 占比 / 换行率」判别（换行率 ≥0.3 即判退化），会误杀大量正常思考：
// cline/z-ai 上游（glm）常把每个思考 token 单独成行/每个 token 后跟换行发出，使"换行率"
// 虚高（实测正常思考到 0.2–0.3），内容却是连贯技术推理，被 v1 当成退化拦截，
// 导致同轮 3 次重试全被掐 → 客户端收到 502 upstream_runaway，正常会话反而做不了。
//
// 用日志两批真实 reasoning 步校准「空白占比」（空白字符 ÷ 总字符）：
//   真退化（空白/乱码洪泛，烧光预算）：0.59–0.96（T5/S34、T12/S39、T12/S34、T5/S30…）
//   一词一行但连贯的思考（本次被误杀对象）：0.21–0.45（T18/S3/S6/S7…）
//   正常散文/中文思考：0.15–0.25
// 判别：空白占比 ≥0.55 且总字符 ≥250 → 退化。语言无关（英文/中文/乱码一致）。
const DEGENERATE_MIN_DELTAS = 1        // 按字符占比判别，条数门槛放宽
const DEGENERATE_MIN_CHARS = 250       // 太少字符无法稳定估计，且短垃圾自限不烧预算
const DEGENERATE_MAX_WS_RATIO = 0.55   // 空白占比低于此判定（正常思考 ≤0.45，留裕量）
const PROBE_MAX_DELTAS = 24            // 流式探测窗口：缓冲满这个数量即做放行/拦截判定
const RING_SIZE = 32                   // 放行后的滚动监控窗口

/**
 * 判定一组 reasoning delta 是否为「推理退化空转」。
 *
 * 不能看"换行多/碎片多"——正常思考也常被上游拆成一词一行。真正病态是「攒了很多字符却几乎
 * 都是空白/换行」：乱码洪泛、单字符碎片铺满。用整体空白占比区分（语言无关，≥0.55 判退化；
 * 正常连贯思考含一词一行 ≤0.45，不会误伤）。
 * @param deltas 按到达顺序排列的 reasoning 文本片段
 */
export function isDegenerateReasoningDeltas(deltas: string[]): boolean {
  if (deltas.length < DEGENERATE_MIN_DELTAS) return false
  let chars = 0
  let ws = 0
  for (const t of deltas) {
    chars += t.length
    ws += (t.match(/\s/g) || []).length
  }
  if (chars < DEGENERATE_MIN_CHARS) return false
  return ws / chars >= DEGENERATE_MAX_WS_RATIO
}

/**
 * 判定单条 reasoning delta 是否为「纯排版噪声」：整条内容仅由空白组成。
 *
 * 背景（2026-09-06、2026-09-10 会话日志确认）：glm 上游既会发送 token 与独立
 * "\n" 交替的分片，也会发送独立 "\n\n" 或把双换行粘在短句尾部。纯空白分片
 * 不携带语义，直接拼入思考流会造成大量空白行，因此单换行、双换行和空格均不转发。
 *
 * 注意：这里只影响直播转发，不影响退化判定。原始分片仍会计入 probeDeltas/ring，
 * 纯空白洪泛（≥250 字符、空白占比 ≥0.55）仍会被判定为退化并拦截。
 */
export function isWhitespaceOnlyReasoningDelta(t: unknown): boolean {
  if (typeof t !== 'string' || t === '') return false
  return /^\s+$/.test(t)
}

/**
 * 归一化单条 reasoning delta，让思考流在 UI 里可读（只影响转发直播，不影响退化判定）。
 *
 * 背景（2026-09-06 log4 确认）：独立 "\n" 空白 delta 被过滤后，glm 还有第二形态——
 * 换行粘在标点 token 尾部（".\n" ",\n" "—\n\n" "...\n\n\n"），每个分句强制换行，
 * 渲染出来一行一个短句，长思考没法看。策略：
 *   - 尾部换行 ≥2 个 → 压成一个段落分隔 "\n\n"（保留结构）；
 *   - 尾部单个换行   → 折叠成一个空格（分句连排成段）；
 *   - 其余内容原样返回。
 * 仅用于转发路径；probeDeltas/ring 的退化检测始终使用上游原始 delta。
 */
export function normalizeReasoningDeltaForUI(t: unknown): string {
  if (typeof t !== 'string' || t === '') return typeof t === 'string' ? t : ''
  const m = /\n[\n\t ]*$/.exec(t)
  if (!m) return t
  const head = t.slice(0, t.length - m[0].length)
  // Cline 的轮换推理供应商可能把每个短句甚至 token 以双换行结尾。
  // 在单条 delta 内无法可靠区分语义段落与供应商排版，因此正文尾部的
  // 任意数量换行统一折叠成一个空格；纯空白 delta 由调用方直接抑制。
  return head ? head + ' ' : ' '
}

/**
 * 就地改写 SSE 帧内的 reasoning delta 为 UI 归一化版本（探测缓冲与续流共用）。
 *
 * 字段覆盖（2026-09-06 实测 Novita 池帧结构确认）：cline 免费通道的 glm 由多个
 * 推理商（Parasail/Novita/…）轮换托管，delta 字段不统一——有的发 reasoning_content，
 * 有的发 reasoning + reasoning_details 双字段。DSH 的思考流读的是
 * reasoning_details[].text（与 DSH replayState.blocks 结构逐字段一致），漏改它
 * 等于所有归一化白做（log6 实测三连换行原样穿透的根因）。三处同步改写。
 */
function patchReasoningDeltaForUI(clone: Record<string, unknown>): void {
  const choice = ((clone.choices as Array<Record<string, unknown>>) || [])[0] as Record<string, unknown> | undefined
  if (!choice) return
  const delta = (choice.delta || choice.message) as Record<string, unknown> | undefined
  if (!delta) return
  if (delta.reasoning_content !== undefined) delta.reasoning_content = normalizeReasoningDeltaForUI(delta.reasoning_content)
  if (delta.reasoning !== undefined) delta.reasoning = normalizeReasoningDeltaForUI(delta.reasoning)
  const details = delta.reasoning_details as Array<Record<string, unknown>> | undefined
  if (Array.isArray(details)) {
    for (const item of details) {
      if (item && item.type === 'reasoning.text' && typeof item.text === 'string') {
        item.text = normalizeReasoningDeltaForUI(item.text)
      }
    }
  }
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

/**
 * 账号当前是否可用：软冷却与「账号 × 模型」冷却都不命中才算可用。
 * @param model 有模型上下文时额外检查模型级冷却；不传则只判账号级。
 */
function isAccountAvailable(acc: Account, model: string | undefined, now: number): boolean {
  if (acc.cooldownUntil > now) return false
  if (model) {
    const until = acc.modelCooldowns.get(model)
    if (until && until > now) return false
  }
  return true
}

/** 池中是否还有账号能跑该模型（不改状态，供免费链跳过与降级判定）。 */
function hasAvailableAccount(pool: Pool, model?: string): boolean {
  const now = Date.now()
  return pool.accounts.some((acc) => isAccountAvailable(acc, model, now))
}

/**
 * 池中是否还有账号可用（**忽略模型级冷却**）。
 * 用于区分「账号池整体不可用（应立刻回错）」与「只是该模型在部分账号上冷却（可换模型）」。
 */
function hasAnyUsableAccount(pool: Pool): boolean {
  const now = Date.now()
  return pool.accounts.some((acc) => acc.cooldownUntil <= now)
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

/** 轮询选一个可用账号，取到 accessToken。（item7 支持模型级冷却） */
async function getAccessToken(pool: Pool, model?: string): Promise<string> {
  if (pool.accounts.length === 0) throw new Error('未配置 Cline RefreshToken')
  const now = Date.now()
  for (let attempt = 0; attempt < pool.accounts.length; attempt++) {
    const acc = pool.accounts[attempt % pool.accounts.length]
    if (!isAccountAvailable(acc, model, now)) continue
    pool.current = acc
    try {
      return await getAccountToken(acc, pool)
    } catch {
      continue // 刷新失败也切下个号
    }
  }
  // 兜底：优先挑一个软冷却已到期的账号强制复活一次（保留原「不空转」语义）；
  // 若全都还在软冷却，则挑一个「该模型未冷却」的账号复活——**不能挑该模型已冷却的账号**，
  // 否则会把「该模型余额耗尽 → 改走免费链」的判定绕过去，又去打一次必然 402 的上游。
  const acc =
    pool.accounts.find((a) => a.cooldownUntil <= now) ??
    pool.accounts.find((a) => !model || (a.modelCooldowns.get(model) ?? 0) <= now)
  if (!acc) throw new Error('该模型在所有账号上均处于冷却中')
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
    // 余额/权益耗尽（402）：该模型走 credits 计费档，而当前账号余额不足。
    // 只做**模型级**冷却（账号仍可跑免费模型），换号重试可能命中有余额的账号；
    // 全账号都不可用时立刻回 402，由调用方沿免费链换模型（移植 luawei1 169fd9d 语义）。
    if (resp.status === 402) {
      const text = await resp.clone().text().catch(() => '')
      applyCooldown(cooldownFromResponse(resp, text, CLINE_COOLDOWN_PLAN_MS))
      if (!hasAvailableAccount(pool, model)) return planExhaustedResponse(text)
      await sleep(500 + Math.floor(Math.random() * 500))
      continue
    }
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

/**
 * 清洗出站消息历史里的畸形 tool_calls（移植 luawei1/cline2api `49fdb8a` 步骤①②）。
 *
 * 背景：上游偶发输出 `function.name` 为空的 tool call（GLM 流式分片丢失 / 工具调用以
 * 文本形式泄漏），客户端执行后把残缺记录回放进下一轮历史，导致上游**恒定 400**
 * `tool_calls[N].function.name must be a non-empty string`，毒化整个会话。
 *
 *   ① 丢弃 `function.name` 为空的 tool_call；
 *   ② 过滤后 `tool_calls` 为空则移除该字段；
 *   ③ 孤儿 tool 结果（无对应合法 tool_call）整条删除 —— 复用已导出的
 *      `cleanupOrphanToolCalls`，不重复实现。
 *
 * **顺序要紧**：先做①②再做③。反过来的话，被①②丢掉的空名 tool_call 所对应的
 * tool 结果会因为「调用当时还在」而被保留，变成新的孤儿。
 *
 * @param messages 客户端原始 messages（非数组时原样返回）
 */
export function sanitizeClineMessages(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages
  for (const m of messages) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) continue
    const msg = m as Record<string, unknown>
    if (msg['role'] !== 'assistant') continue
    const tcs = msg['tool_calls']
    if (!Array.isArray(tcs)) continue
    const kept = tcs.filter((tc) => {
      if (!tc || typeof tc !== 'object' || Array.isArray(tc)) return false
      const fn = (tc as Record<string, unknown>)['function']
      if (!fn || typeof fn !== 'object' || Array.isArray(fn)) return false
      const name = (fn as Record<string, unknown>)['name']
      return typeof name === 'string' && name !== ''
    })
    if (kept.length === tcs.length) continue // 无空名：零改动
    if (kept.length === 0) delete msg['tool_calls'] // ② 全空名 → 删键
    else msg['tool_calls'] = kept
  }
  // ③ 再清孤儿 tool 结果（② 删掉调用后，其结果在这里被一并清掉）
  return cleanupOrphanToolCalls(messages).messages
}

export function buildUpstreamBody(
  forwardBody: Record<string, unknown>,
  isStream: boolean,
  sessionId: string,
  freeSet?: Set<string>
): Record<string, unknown> {
  const model = (forwardBody.model as string) || DEFAULT_MODEL
  const body: Record<string, unknown> = {
    model,
    session_id: sessionId,
    reasoning_effort: String(forwardBody.reasoning_effort || forwardBody.reasoningEffort || CLINE_DEFAULT_REASONING_EFFORT),
    messages: sanitizeClineMessages(forwardBody.messages) as unknown[],
  }
  // max_tokens 分档（见 CLINE_MAX_TOKENS 文档）：免费档剥离，非免费档保留并兜下限。
  // 免费判定用 free 列表成员（不是前缀）——stealth/space-bunny-alpha 无 cline-free/ 前缀。
  if (!isFreeClineModel(model, freeSet)) {
    const rawMax = forwardBody.max_tokens ?? forwardBody.max_completion_tokens
    const parsed = rawMax != null && rawMax !== '' ? Math.floor(Number(rawMax)) || 0 : 0
    body.max_tokens = parsed >= CLINE_MIN_UPSTREAM_MAX_TOKENS ? parsed : CLINE_MAX_TOKENS
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
}

/**
 * 单次流式尝试的探测阶段 + 后台续流。
 *
 * 关键约束：探测一旦判定「健康放行」，必须【立刻】把 SSE Response 返回给路由，
 * Cloudflare 才会向客户端下发响应头并开始直播；续读上游放在后台任务里写进同一个流。
 * 否则 pump 会等上游整轮结束才返回 → 客户端看不到任何输出（卡住直到超时）。
 *
 * 流程：
 *   1. 探测期：缓冲前 PROBE_MAX_DELTAS 条 reasoning delta，用 isDegenerateReasoningDeltas 判定；
 *      退化/空转 → 取消上游，返回 outcome 供调用方冷却换号重试。
 *   2. 健康 → 建流、把缓冲帧写入、立刻返回 healthy Response，同时后台任务接管剩余上游帧。
 *   3. 后台续流阶段：32 条滚动窗口持续监控，退化中途出现则抑制后续 reasoning delta，
 *      全程未产出正文时发 upstream_runaway 错误帧，并回调 onRunaway 让调用方冷却账号。
 */
/** @internal 流式尝试的探测 + 后台续流（导出供测试验证流式语义）。 */
export async function pumpStreamAttempt(
  resp: Response,
  onRunaway?: () => void
): Promise<StreamAttemptOutcome> {  const reader = resp.body!.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const sseHeaders = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' }
  const newStream = () => {
    const ts = new TransformStream<Uint8Array, Uint8Array>()
    return { ts, writer: ts.writable.getWriter() }
  }

  // 后台续流阶段共享的滚动状态
  const state = {
    ring: [] as string[],
    suppress: false,
    contentChars: 0,
    hasToolCalls: false,
  }
  let buf = ''
  const probeDeltas: string[] = []   // 探测期收集的 reasoning delta
  const buffered: string[] = []      // 探测期缓冲的原始帧，放行时一次性写回

  /** 把单行 SSE 帧路由到 writer（供后台续流用），含退化监控 + 抑制 + 空转报错。 */
  const routeToStream = async (line: string, w: WritableStreamDefaultWriter<Uint8Array>): Promise<void> => {
    if (!line.startsWith('data:')) {
      if (line !== '') await w.write(encoder.encode(line + '\n'))
      return
    }
    const payload = line.slice(5).trim()
    if (payload === '' || payload === '[DONE]') {
      await w.write(encoder.encode(line + '\n\n'))
      return
    }
    let obj: Record<string, unknown> | null = null
    try { obj = unwrapData(JSON.parse(payload)) as Record<string, unknown> } catch { obj = null }
    const facts = inspectFrame(obj)
    state.contentChars += facts.contentChars
    if (facts.hasToolCalls) state.hasToolCalls = true
    const isReasoning = facts.reasoningDelta !== null
    if (isReasoning) {
      state.ring.push(facts.reasoningDelta as string)
      // 按字符数约束窗口（需 ≥DEGENERATE_MIN_CHARS 才能做退化判定，故窗口要够大）
      let ringChars = 0
      for (let i = state.ring.length - 1; i >= 0; i--) {
        ringChars += state.ring[i].length
        if (ringChars >= DEGENERATE_MIN_CHARS * 2) {
          state.ring = state.ring.slice(i)
          break
        }
      }
      if (isDegenerateReasoningDeltas(state.ring)) state.suppress = true
      if (state.suppress) return // 抑制垃圾 reasoning，不再直播到 UI
      // 单词间独立 "\n" 空白 delta：零信息量排版噪声，不再往 UI 直播（段落级 "\n\n" 保留）。
      // 仅跳过转发；ring 上面已计入，退化判定不受影响。
      // 带 finish_reason 的帧不在此跳过——下方空转报错分支依赖它到达客户端。
      if (!facts.finishReason && isWhitespaceOnlyReasoningDelta(facts.reasoningDelta)) return
    }
    // UI 归一化：粘在标点尾部的换行折叠（".\n"→". "，"…\n\n\n"→"…\n\n"）。
    // 只改写转发帧；facts/probeDeltas/ring 里留的是原始 delta，退化判定不受影响。
    if (isReasoning && obj) patchReasoningDeltaForUI(obj)
    if (facts.finishReason && state.suppress && state.contentChars === 0 && !state.hasToolCalls) {
      onRunaway?.()
      const errMsg = { error: { message: 'Cline 推理退化空转：全程未产出正文，已抑制垃圾 reasoning', type: 'upstream_runaway' } }
      await w.write(encoder.encode('data: ' + JSON.stringify(errMsg) + '\n\n'))
    }
    await w.write(encoder.encode('data: ' + JSON.stringify(obj ?? payload) + '\n\n'))
  }

  /** 健康放行：立即返回 Response，缓冲帧与后续上游帧都在后台任务里写入（reader 挂上后再写，避免背压死锁）。 */
  const flushHealthy = (continuationBuf: string): StreamAttemptOutcome => {
    const { ts, writer: w } = newStream()
    const initial = buffered.slice()
    buffered.length = 0
    state.ring = probeDeltas.slice(-RING_SIZE)
    void (async () => {
      // 先写探测期缓冲的帧
      for (const f of initial) await w.write(encoder.encode(f))
      let cbuf = continuationBuf
      // 排空探测期已读入但尚未处理的整行
      let ci: number
      while ((ci = cbuf.indexOf('\n')) >= 0) {
        const line = cbuf.slice(0, ci)
        cbuf = cbuf.slice(ci + 1)
        await routeToStream(line, w)
      }
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          cbuf += decoder.decode(value, { stream: true })
          let idx: number
          while ((idx = cbuf.indexOf('\n')) >= 0) {
            const line = cbuf.slice(0, idx)
            cbuf = cbuf.slice(idx + 1)
            await routeToStream(line, w)
          }
        }
      } catch {
        // 上游流异常（网络重置/断连等）：不再静默截断。给客户端发一帧错误后再收尾，
        // 让 DSH 等客户端按可重试错误快速处理，而不是对着一个没有 finish_reason 的
        // 半截流干等超时。帧格式与上方 upstream_runaway 错误帧一致。
        const errMsg = { error: { message: 'Cline 上游流中途断开，连接异常终止', type: 'upstream_interrupted' } }
        await w.write(encoder.encode('data: ' + JSON.stringify(errMsg) + '\n\n')).catch(() => {})
      }
      await w.close().catch(() => {})
    })()
    return { kind: 'healthy', response: new Response(ts.readable, { status: 200, headers: sseHeaders }) }
  }

  /** 探测期累计 reasoning 的空白占比（随时可算，无需等满 250 字符）。 */
  const probeWsRatio = () => {
    let chars = 0
    let ws = 0
    for (const t of probeDeltas) {
      chars += t.length
      ws += (t.match(/\s/g) || []).length
    }
    return { chars, ratio: chars ? ws / chars : 0 }
  }

  // ---- 探测阶段：读行直到能做出放行/拦截判定 ----
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)

        if (!line.startsWith('data:')) {
          if (line !== '') buffered.push(line + '\n')
          continue
        }
        const payload = line.slice(5).trim()
        if (payload === '' || payload === '[DONE]') {
          buffered.push(line + '\n\n')
          continue
        }
        let obj: Record<string, unknown> | null = null
        try { obj = unwrapData(JSON.parse(payload)) as Record<string, unknown> } catch { obj = null }
        const facts = inspectFrame(obj)
        state.contentChars += facts.contentChars
        if (facts.hasToolCalls) state.hasToolCalls = true
        const isReasoning = facts.reasoningDelta !== null
        if (isReasoning) probeDeltas.push(facts.reasoningDelta as string)
        // 纯空白 "\n" 排版噪声：照常计入 probeDeltas（退化判定依赖空白占比），
        // 但不写入放行缓冲，放行后不会直播到 UI。
        const noiseFrame = isReasoning && isWhitespaceOnlyReasoningDelta(facts.reasoningDelta)
        // 探测缓冲帧同样做 UI 归一化（粘在标点尾部的换行折叠），与续流路径行为一致。
        if (isReasoning && obj) patchReasoningDeltaForUI(obj)
        const frame = 'data: ' + JSON.stringify(obj ?? payload) + '\n\n'
        const { chars: pChars, ratio: pRatio } = probeWsRatio()

        // 模型已开始产出正文或工具调用 → 正常回答，健康放行
        if (facts.contentChars > 0 || state.hasToolCalls) {
          if (!noiseFrame) buffered.push(frame)
          return flushHealthy(buf)
        }
        // 已缓冲足够 reasoning 且空白占绝对主导（≥0.55 持续）→ 退化空转，拦截重试
        if (pChars >= DEGENERATE_MIN_CHARS && pRatio >= DEGENERATE_MAX_WS_RATIO) {
          await reader.cancel().catch(() => {})
          return { kind: 'degenerate' }
        }
        // 窗口满且空白未占主导 → 是正常（可能一词一行）的思考，健康放行
        if (probeDeltas.length >= PROBE_MAX_DELTAS && pRatio < DEGENERATE_MAX_WS_RATIO) {
          if (!noiseFrame) buffered.push(frame)
          return flushHealthy(buf)
        }
        // 探测期内上游已结束：空白主导→退化；length 无产出→空响应；否则放行缓冲内容
        if (facts.finishReason) {
          if (pRatio >= DEGENERATE_MAX_WS_RATIO && pChars >= DEGENERATE_MIN_CHARS) {
            await reader.cancel().catch(() => {})
            return { kind: 'degenerate' }
          }
          if (facts.finishReason === 'length' && state.contentChars === 0 && !state.hasToolCalls) {
            await reader.cancel().catch(() => {})
            return { kind: 'empty' }
          }
          if (!noiseFrame) buffered.push(frame)
          return flushHealthy(buf)
        }
        if (!noiseFrame) buffered.push(frame)
      }
    }
  } catch {
    /* 探测期读上游异常：下方按空流处理 */
  }

  // 探测阶段上游流自然结束
  const { chars: tailChars, ratio: tailRatio } = probeWsRatio()
  if (tailChars >= DEGENERATE_MIN_CHARS && tailRatio >= DEGENERATE_MAX_WS_RATIO) {
    await reader.cancel().catch(() => {})
    return { kind: 'degenerate' }
  }
  if (buffered.length === 0) {
    await reader.cancel().catch(() => {})
    return { kind: 'empty' }
  }
  return flushHealthy(buf)
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
      // 402 余额耗尽是我们自己合成的响应（已带明确 message 与 type），原样透传不二次包装
      if (resp.headers.get('X-Cline-Plan-Exhausted')) return resp
      const errText = await resp.text().catch(() => '')
      return jsonResponse(
        { error: { message: `Cline 上游 HTTP ${resp.status}: ${errText.slice(0, 300)}`, type: 'upstream_error' } },
        resp.status || 502
      )
    }
    const outcome = await pumpStreamAttempt(resp, () => applyModelCooldown(pool, model, CLINE_COOLDOWN_RUNAWAY_MS))
    if (outcome.kind === 'healthy') return outcome.response!
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

/**
 * 402 余额耗尽、且该模型在全部账号上都不可用时的响应。
 *
 * 状态码保留 402（上层与客户端能按「余额」语义识别、可与 429 区分），
 * `type` 用 `upstream_plan_exhausted` 与普通上游错误区分。
 * 该响应同时是免费链的「换下一个模型」信号（见 proxyClineChatRequest）。
 */
function planExhaustedResponse(upstreamText = ''): Response {
  const detail = upstreamText ? ` 上游原文：${upstreamText.slice(0, 200)}` : ''
  return new Response(
    JSON.stringify({
      error: {
        message:
          'Cline 余额/权益耗尽（402 insufficient_credits）：该模型走 credits 计费档而账号余额不足。' +
          '请改用免费档模型（cline-free/* 或 stealth/space-bunny-alpha），或充值后重试。' +
          detail,
        type: 'upstream_plan_exhausted',
      },
    }),
    {
      status: 402,
      // 标记：调用方原样透传，不再被包装成 "Cline 上游 HTTP 402: {...}"
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Cline-Plan-Exhausted': '1' },
    }
  )
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
      // 402 余额耗尽是我们自己合成的响应（已带明确 message 与 type），原样透传不二次包装
      if (resp.headers.get('X-Cline-Plan-Exhausted')) return resp
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
  const requested = String(forwardBody.model || DEFAULT_MODEL)
  const { models, freeSet } = await getClineCatalog()
  const chain = clineModelFallbackChain(requested, models)
  let last: Response | null = null

  for (let i = 0; i < chain.length; i++) {
    const model = chain[i]
    const isLast = i === chain.length - 1
    // 该模型在所有账号上都冷却中（含 402 余额耗尽的模型级冷却）→ 直接换下一个模型，不打上游
    if (!hasAvailableAccount(pool, model)) continue
    // 上游恒定强制流式（item4）：免费通道非流式返回 500 "empty response content"，
    // 统一以流式取数，客户端要非流式时再聚合成 chat.completion。
    const body = buildUpstreamBody({ ...forwardBody, model }, true, sessionId, freeSet)
    try {
      const resp = wantStream
        ? await proxyStreamChat(pool, body, sessionId)
        : await proxyNonStreamChat(pool, body, sessionId)
      // 402/429 = 「该模型在当前账号池上不可用」→ 沿免费链换模型（移植 169fd9d）。
      // 其余错误（400/403/5xx）原样透传：不把参数错误伪装成「换个模型就好了」。
      if ((resp.status === 402 || resp.status === 429) && !isLast) {
        last = resp
        continue
      }
      if (model !== requested) {
        console.log(`[cline-fallback] model ${requested} unavailable on all accounts, served via ${model}`)
      }
      return resp
    } catch (err) {
      return jsonResponse({ error: { message: (err as Error).message || 'Cline 转发失败', type: 'api_error' } }, 500)
    }
  }
  return last ?? jsonResponse({ error: { message: 'Cline 全部候选模型均不可用', type: 'upstream_unavailable' } }, 502)
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
// 2026-09-24 扩为三源合并（移植 cline2api-workers worker.js refreshModels）：
//   ① recommended-models 的 free / recommended / clinePass
//   ② /v1/models 的 `:free` 后缀
//   ③ /v1/models 命中 CLINE_FREE_WHITELIST 的 ID
// ②③ 是必需的：`stealth/space-bunny-alpha` 这类免费模型**只在 /v1/models 里出现**，
// 且没有 cline-free/ 前缀，只靠①会把它判成计费档 → 402。
// 有意未纳入：recommended-models 的 clineCloud 组（Cline Cloud 独立档，上游 workers 版也不读）。

const CLINE_RECOMMENDED_URL = 'https://api.cline.bot/api/v1/ai/cline/recommended-models'
const CLINE_MODELS_URL = 'https://api.cline.bot/api/v1/models'
/** 目录缓存 TTL（对齐上游 workers 版 MODELS_TTL = 10 分钟）。 */
const CLINE_CATALOG_TTL_MS = 10 * 60 * 1000

export interface RemoteClineModel { id: string; cost: 'free' | 'pass' }

/** 拉取 `/v1/models`（免鉴权），只保留免费档：`:free` 后缀或命中 FREE_WHITELIST。 */
async function fetchClineModelsEndpoint(): Promise<RemoteClineModel[]> {
  const resp = await fetch(CLINE_MODELS_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (cline2api)' },
    signal: AbortSignal.timeout(10000),
  })
  if (!resp.ok) throw new Error(`/v1/models HTTP ${resp.status}`)
  const data = (await resp.json()) as { data?: Array<{ id?: string; batch?: boolean }> }
  const list = Array.isArray(data?.data) ? data.data : []
  const out: RemoteClineModel[] = []
  for (const m of list) {
    const id = m?.id
    if (!id) continue
    // batch 变体不是对话模型，剔除（对齐上游）
    if (m.batch || id.endsWith(':batch')) continue
    if (id.includes(':free') || CLINE_FREE_WHITELIST.includes(id)) out.push({ id, cost: 'free' })
  }
  return out
}

/**
 * 拉取 Cline 官方推荐/免费/订阅模型清单（免认证），按 free 优先去重。
 * `/v1/models` 失败**不致命**（主清单已拿到时静默跳过），保证后台「获取模型」不因单源故障全灭。
 */
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
  // 补 /v1/models 的免费档（stealth/* 等无前缀免费模型只在这里出现）
  try {
    for (const m of await fetchClineModelsEndpoint()) {
      if (seen.has(m.id)) continue
      seen.add(m.id)
      out.push(m)
    }
  } catch { /* 非致命：主清单已拿到 */ }
  return out
}

/** 静态兜底目录（动态拉取失败时使用）。 */
function staticClineCatalog(): RemoteClineModel[] {
  return CLINE_MODELS.map((m) => ({ id: m.id, cost: m.cost === 'free' ? 'free' : 'pass' }) as RemoteClineModel)
}

let clineCatalogCache: { models: RemoteClineModel[]; freeSet: Set<string>; at: number } | null = null

/**
 * 取 Cline 模型目录与 free 集合（10 分钟缓存）。**请求路径的 free 判定唯一真源。**
 * 拉取失败回落静态表——请求路径不能因目录不可用而整体失败。
 */
export async function getClineCatalog(): Promise<{ models: RemoteClineModel[]; freeSet: Set<string> }> {
  const now = Date.now()
  if (clineCatalogCache && now - clineCatalogCache.at < CLINE_CATALOG_TTL_MS) {
    return { models: clineCatalogCache.models, freeSet: clineCatalogCache.freeSet }
  }
  let models: RemoteClineModel[]
  try {
    models = await fetchClineRecommendedModels()
    if (models.length === 0) models = staticClineCatalog()
  } catch {
    models = staticClineCatalog()
  }
  const freeSet = new Set(models.filter((m) => m.cost === 'free').map((m) => m.id))
  clineCatalogCache = { models, freeSet, at: now }
  return { models, freeSet }
}

/** 供测试清空目录缓存。 */
export function __resetClineCatalogCacheForTests(): void { clineCatalogCache = null }

/**
 * 判定模型是否走官方免费额度（决定 max_tokens 剥离与降级链成员资格）。
 *
 * **必须用 free 列表成员判定，不能用前缀**：`stealth/space-bunny-alpha` 是免费模型但
 * 没有 `cline-free/` 前缀，前缀判定会把它当计费档 → 送 max_tokens → 上游 500。
 * 目录尚未取到时回落「前缀 + 白名单」启发式，宁可保守也不能漏判。
 */
export function isFreeClineModel(id: string, freeSet?: Set<string>): boolean {
  if (freeSet && freeSet.size > 0) return freeSet.has(id)
  return id.startsWith('cline-free/') || CLINE_FREE_WHITELIST.includes(id)
}

/**
 * 免费模型降级链（移植 luawei1/cline2api `modelFallbackChain`，169fd9d）：
 * 点名模型优先，其后是默认免费档与目录内全部免费模型，末位兜底 CLINE_FREE_LAST_RESORT。
 *
 * 上游语义：**只有 429/402 才降级**（模型级不可用）；400/403/5xx 等原样透传，
 * 避免把参数错误伪装成「换模型就好了」。
 */
export function clineModelFallbackChain(requested: string, models: RemoteClineModel[]): string[] {
  const chain: string[] = []
  const push = (id: string) => { if (id && !chain.includes(id)) chain.push(id) }
  push(requested)
  push(DEFAULT_MODEL)
  for (const m of models) if (m.cost === 'free') push(m.id)
  push(CLINE_FREE_LAST_RESORT)
  return chain
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