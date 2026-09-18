/**
 * workbuddy-upstream.ts — WorkBuddy/CodeBuddy 上游协议适配纯函数（移植自 Sliverkiss/workbuddy2api）。
 *
 * 本模块只放无依赖的纯函数，供 proxy.ts / oauth-pool.ts 复用与单元测试：
 *   1. classifyWorkbuddyUpstreamError — 错误分类（对齐 workbuddy2api internal/upstream/client.go Classify），
 *      驱动账号池冷却策略：
 *        hard_credit   余额/权益耗尽（402 或 body 关键词）→ 长冷却到次日 04:00（等签到恢复）
 *        soft_rate     429 限流 → 短冷却
 *        session_dead  401/12153 offline session 失效 → 永久禁用
 *        not_found     404 上游偶发 → 短冷却，不累计错误计数（防雪崩）
 *        server        5xx 上游故障 → 累计错误计数
 *        client        其他 4xx（如 400 参数错）→ 不处罚账号，仅换号（客户端的锅不能连坐账号）
 *   2. reasoning_effort 降级（对齐 workbuddy2api internal/upstream/payload.go normalizeReasoningEffort）：
 *      按模型声明的 supportedEfforts 把请求档位降级为 ≤请求档位的最高支持档；
 *      支持档全部高于请求档时取最低支持档；模型未声明能力时保持「删除该字段」的既有行为（零回归）。
 *   3. nextDay4AMMs — 下一个 CST 04:00（epoch ms，与运行环境时区无关），硬冷却目标时刻
 *      （对齐 workbuddy2api CooldownUntilTomorrow4AM）。
 */

// ===== 错误分类 =====

import { injectConversationHeaders, type ChatMeta } from './workbuddy-session-ids'

/** 上游错误分类（对齐 workbuddy2api ErrKind）。 */
export type WorkbuddyErrorKind =
  | 'hard_credit'      // 余额/权益耗尽 → 长冷却（次日 04:00）
  | 'soft_rate'        // 429 限流 → 短冷却
  | 'model_rate'       // 429 code 6004 → 模型级限流（切模型立即可用）
  | 'model_blocked'   // 400/404 code 11102「该后端无此模型」→ 模型级避让（指数退避，成功即解除）
  | 'session_dead'    // session 失效 → 连续 3 次才永久禁用
  | 'account_fault'    // 账号级授权/配额故障（11140 / 14017）→ 换号并冷却或禁用
  | 'not_found'        // 404 上游偶发 → 短冷却，不累计错误
  | 'server'           // 5xx → 累计错误计数
  | 'waf_block'        // 403 + 无业务信封（APISIX WAF 拦截页/空体）→ 软冷却 + 抖动退避，不禁用
  | 'prompt_too_long'  // 11115「prompt is too long」→ 请求级错误（非账号问题）：不罚号、不轮转，透传原文
  | 'bad_params'       // 400 Unmarshal 11101 → 客户端参数错，不罚号，仅换号
  | 'content_blocked'  // 400 审核拦截 → 不罚号
  | 'client'           // 其他 4xx → 不处罚，仅换号

/**
 * 余额不足关键词（小写比较 + 原文比较双通道，对齐 workbuddy2api hardMarkers）。
 * 另保留本仓既有的 '1005'（CodeBuddy plan 权益业务码）与 'plan' 宽匹配，
 * 避免收窄既有检测面（既有实现对响应体含 'plan' 即长冷却）。
 */
const HARD_MARKERS = [
  // 单数 + 复数双形态都收（对齐 workbuddy2api 0f49e290：上游可能以 `credits exhausted`
  // 复数返回，漏判复数会让坏号只换号不硬冷却、反复刷计费失败）。
  'insufficient credit', 'no credit', 'credit exhausted', 'credits exhausted', 'out of credit',
  'quota exceeded', 'quota exhaust', 'payment required', 'credit not enough',
  'not enough credit',
  '积分不足', '额度不足', '余额不足', '积分用完', '额度用尽', '没有积分',
  // 本仓既有检测（保持行为兼容）：
  '1005', 'plan',
]

/** session 失效关键词（对齐 workbuddy2api sessionDeadMarkers）。 */
const SESSION_DEAD_MARKERS = ['Offline user session not found', '12153']

/**
 * 账号级授权/配额故障关键词（大小写不敏感子串匹配，对齐 workbuddy2api accountFaultMarkers）。
 *
 * 定位：这类错误由**账号本身状态**决定，不是请求格式、不是临时限流、也不是内容误报——
 * 继续换号重试只会反复刷上游风控/配额检查，必须对该账号施加冷却或禁用。
 *
 *  - `request illegal`（业务码 11140，HTTP 403）→ 上游 auth/auth_forbidden 账号级授权封禁。
 *    实测报文：`{"error":{"data":{"code":11140,"msg":"request illegal"}}}`。**需重新 OAuth
 *    登录才能恢复**，软冷却到期也不会自愈 → 调用方应硬禁用（不再参与选号）。
 *  - `trial not activated` / `trial version is not yet activated`（业务码 14017，常带 HTTP 429）
 *    → 上游 quota/quota_not_activated，register 未完成的试用未激活账号。补完 register 后
 *    **可能自愈** → 调用方应软冷却而非禁用。
 *
 * 为什么 11140 **不能按业务码判定**：该 code 也承载模型级限流文案
 * （"The model provider is rate-limiting requests."），那种场景必须保持 soft_rate
 * （模型级限流切模型即可用，与账号授权封禁语义相反）。故这里只收 msg 关键词
 * `request illegal`（auth_forbidden 的真实文案），不做 `/11140/` 数字匹配。
 * 14017 文案唯一（无软限流歧义），可安全收录。
 *
 * 判定位置（对齐源实现 Classify 顺序）：**必须在 isModelRateLimit / status===429 之前**。
 * 14017 常带 429 状态码，若落到 status===429 兜底会被误归 soft_rate——"限流"可指数退避
 * 等自愈，而账号级故障等不来，语义不符。
 */
const ACCOUNT_FAULT_MARKERS = [
  'request illegal',
  'trial not activated',
  'trial version is not yet activated',
]

/**
 * 判定错误文本是否表示「11140 账号级授权封禁」（需重登，不可自愈）。
 * 用于调用方区分 11140（硬禁用）与 14017（软冷却）两条不同策略。
 * 大小写不敏感，与 CLASSIFY 的 marker 匹配同口径。
 */
export function isAccountBanned(bodyText: string): boolean {
  return bodyText.toLowerCase().includes('request illegal')
}

/** 内容策略拦截关键词（对齐 workbuddy2api contentBlockedMarkers）。 */
const CONTENT_BLOCKED_MARKERS = [
  'blocked by security policy',
  'unapproved channel',
  'illegal api invocation',
]

/**
 * 审核分类词（按优先级扫描上游文案，大小写不敏感）。
 * 只收录可直接展示给调用方的分类标签，**不收录错误码**（如 11128）。
 */
const CONTENT_BLOCKED_KEYWORDS = [
  '色情', 'porn', 'nsfw', 'adult',
  '暴力', 'violence',
  '政治', 'politics',
  '赌博', 'gambling',
  '毒品', 'drug',
  '违禁词',
]

/** 抽不到分类词时的兜底标签。 */
export const CONTENT_BLOCKED_FALLBACK_KEYWORD = '违禁词'

/**
 * 从审核文案抽出分类关键词（对齐 workbuddy2api contentBlockedKeyword）：
 * 优先取信封 `msg` 字段，抽不到则回「违禁词」。
 */
export function contentBlockedKeyword(bodyText: string): string {
  let text = bodyText
  try {
    const env = JSON.parse(bodyText) as { msg?: unknown }
    if (typeof env?.msg === 'string' && env.msg.trim() !== '') text = env.msg
  } catch { /* 非 JSON：用原文扫描 */ }
  const lower = text.toLowerCase()
  for (const kw of CONTENT_BLOCKED_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) return kw
  }
  return CONTENT_BLOCKED_FALLBACK_KEYWORD
}

/**
 * 把上游内容拦截改写成**网关防火墙口径**的客户端文案
 * （对齐 workbuddy2api ContentBlockedClientMessage）。
 *
 * 为什么必须改写而非透传上游报文：上游 400 报文里含业务 code（如 11128）与
 * 账号/冷却语义。直接透传会：
 *  1. 把上游内部错误码暴露给终端用户（信息泄漏）；
 *  2. 让用户误以为是网关/账号故障而反复重试（实为内容问题，换号无用）。
 * 这里只回"内容命中防火墙规则[分类词]"，既说明原因又不泄漏内部细节。
 */
export function contentBlockedClientMessage(bodyText: string): string {
  return `触发网站风控违禁词，无法调用模型：内容命中网关内容防火墙规则[${contentBlockedKeyword(bodyText)}]，已被拦截。请修改内容后重试。`
}

/**
 * 内容拦截的**终态**错误：池化转发核心抛出它，由外层入口转为 HTTP 400。
 *
 * 为什么用异常而非返回值：内容拦截是"本请求的终态"（不轮转、不再换号），
 * 而池化核心的返回契约是"成功的上游响应 + 是否原始流式 + 命中的账号"——
 * 用异常表达"这个请求到此为止"最贴合语义，也避免为它扩展返回联合类型
 * 而波及所有调用点。
 */
export class ContentBlockedError extends Error {
  /** 已改写为防火墙口径的客户端文案（不含上游 code/账号） */
  readonly clientMessage: string
  constructor(bodyText: string) {
    super('content blocked by upstream')
    this.name = 'ContentBlockedError'
    this.clientMessage = contentBlockedClientMessage(bodyText)
  }
}

/**
 * 上游客户端错误（4xx，如 400 参数错/超限/畸形 JSON，对齐 bad_params / client）。
 *
 * 为什么不轮转：此类错误由「请求体本身」引起（参数错、超长、格式不支持等），
 * 换池内任何其他账号都会撞同一错误——盲目轮转只会浪费请求、加重风控，
 * 且在池耗尽后退化抛出误导性的 503「OAuth 账号池无可用账号」。
 * 抛出此异常表示「本请求属于客户端问题，终态返回，不罚账号」，由外层入口直接透传 4xx 与上游信息。
 */
export class WorkbuddyClientError extends Error {
  readonly status: number
  readonly upstreamText: string
  /**
   * 错误分类（可选）：`prompt_too_long` 时错误体走**原文透传**（不套固定前缀），
   * 见 formatWorkbuddyClientErrorMessage。
   */
  readonly kind?: WorkbuddyErrorKind
  constructor(status: number, upstreamText: string, kind?: WorkbuddyErrorKind) {
    super(`upstream client error ${status}: ${upstreamText || 'bad request'}`)
    this.name = 'WorkbuddyClientError'
    this.status = status
    this.upstreamText = upstreamText
    this.kind = kind
  }
}

/**
 * 提取并格式化上游 4xx 客户端错误的提示文案（优先提取业务 msg/message/code）。
 *
 * `prompt_too_long` 例外（移植 workbuddy2api f41c496 的 error-passthrough 语义）：
 * 11115 的原文（真实 token 数/上限值/requestId）是最有价值的排查信息，必须**逐字透传**，
 * 不能被固定前缀包一层。故该 kind 下直接用上游原文，仅在空 body 时给可读兜底短文案。
 */
export function formatWorkbuddyClientErrorMessage(
  status: number,
  upstreamText: string,
  kind?: WorkbuddyErrorKind
): { message: string; code?: unknown } {
  if (kind === 'prompt_too_long') {
    const raw = (upstreamText || '').trim()
    return {
      message: raw || PROMPT_TOO_LONG_FALLBACK_MESSAGE,
      code: extractUpstreamCode(upstreamText),
    }
  }
  let msg = upstreamText || 'INVALID_REQUEST'
  let code: unknown = undefined
  try {
    const parsed = JSON.parse(upstreamText)
    if (parsed && typeof parsed === 'object') {
      if (parsed.error && typeof parsed.error === 'object') {
        const pe = parsed.error as Record<string, unknown>
        if (typeof pe.message === 'string' && pe.message.trim() !== '') msg = pe.message.trim()
        if (pe.code !== undefined) code = pe.code
      } else if (typeof parsed.msg === 'string' && parsed.msg.trim() !== '') {
        msg = parsed.msg.trim()
        if (parsed.code !== undefined) code = parsed.code
      } else if (typeof parsed.message === 'string' && parsed.message.trim() !== '') {
        msg = parsed.message.trim()
        if (parsed.code !== undefined) code = parsed.code
      }
    }
  } catch { /* 非 JSON 则直接使用原文 */ }
  return { message: `上游请求参数错误 (HTTP ${status})：${msg}`, code }
}

/** 11115 空 body 时的可读兜底文案（不编造上游原文，只给分类语义）。 */
export const PROMPT_TOO_LONG_FALLBACK_MESSAGE =
  'prompt is too long：上下文超出上游模型上限（上游未返回明细，请缩减输入后重试）'

/** 从上游错误体里取业务 code（error.code → 顶层 code），取不到返回 undefined。 */
function extractUpstreamCode(upstreamText: string): unknown {
  try {
    const parsed = JSON.parse(upstreamText)
    if (parsed && typeof parsed === 'object') {
      const p = parsed as Record<string, unknown>
      if (p['error'] && typeof p['error'] === 'object') {
        const pe = p['error'] as Record<string, unknown>
        if (pe['code'] !== undefined) return pe['code']
      }
      if (p['code'] !== undefined) return p['code']
    }
  } catch { /* 非 JSON */ }
  return undefined
}

/**
 * 判断是否为模型级 429 限流（业务 code 6004，对齐 workbuddy2api IsModelRateLimit）。
 * 用于区分"账号级软限流"与"该模型用量限流"（其他模型依然可用）。
 */
export function isModelRateLimit(bodyText: string): boolean {
  return /"code"\s*:\s*"?6004"?/.test(bodyText)
}

/**
 * 从 429 6004 body 解析限流重置时间（对齐 workbuddy2api ParseRateReset，含 f044e5c）。
 * 上游 CN 域文案为「将在 … 重置」，global 域为英文形态 "usage will reset at YYYY-MM-DD HH:mm:ss UTC+8"。
 * 先试中文再试英文；英文正则锚定完整时间戳格式，避免匹配 "reset at the end of the day"
 * 之类的自然语言。成功返回 epoch ms 墙钟时刻，解析失败或非 6004 返回 null。
 */
export function parseSoftRateReset(bodyText: string): number | null {
  if (!isModelRateLimit(bodyText)) return null
  const m =
    bodyText.match(/将在\s*([\d\-:\s]+)(?:\s*UTC\+8)?\s*重置/) ??
    bodyText.match(/reset\s+at\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})(?:\s*UTC\+8)?/i)
  if (!m || !m[1]) return null
  const ts = m[1].trim().replace(/\s*UTC\+8$/, '')
  const parts = ts.split(/\s+/)
  if (parts.length !== 2) return null
  const [d, t] = parts
  const iso = `${d}T${t}+08:00`
  const ms = new Date(iso).getTime()
  return Number.isNaN(ms) ? null : ms
}

/**
 * 按 HTTP 状态码 + 响应体判定错误类别（对齐 workbuddy2api Classify 的判定顺序）：
 * 11102 模型不存在（400/404）→ 402 → session 死亡关键词 → **账号级故障（11140/14017）**
 * → 6004 模型限流 → **429 软限流** → 余额关键词 → 404 → 5xx → WAF 403（无业务信封）
 * → 内容策略拦截 → 11101 参数错 → 其他 4xx。
 * 非 429 场景下关键词优先于状态码：上游偶发把业务错误包在 5xx 里时，按真实原因分类。
 *
 * 判定顺序的语义依据（对齐源实现 client.go Classify 的注释）：
 *  - **11102 最先判**：它是「模型在后端不存在」的确定性答复，语义比计费/限流都具体。
 *    必须早于余额关键词层——本仓 HARD_MARKERS 含宽匹配 `plan`/`1005`，若 11102 答复的
 *    msg 里混入 `plan` 字样（如 "service info not found in current plan"）会先被判成
 *    hard_credit，坏号被硬冷却 12h 而非只做模型级避让（源实现把 IsModelBlocked 放在
 *    首位正是为此）；
 *  - 402 是真正的计费余额耗尽状态码，最严、最不可自愈（只能等签到恢复）；
 *  - session_dead 是需要人工重登的终态，且其 marker（12153 等）比限流层的大范围子串更具体；
 *  - **account_fault 必须先于 429**：14017 常带 HTTP 429，若落到 `status === 429`
 *    会被误归 soft_rate——限流可指数退避等自愈，账号级故障等不来，语义完全不符。
 *    11140 的"模型级限流"变体（rate-limiting 文案）因 marker 不含 `request illegal`
 *    而天然不命中本层，会继续落到 model_rate / soft_rate，行为不受影响；
 *  - **429 必须先于余额关键词层**（移植 workbuddy2api 145220d，fork-scan-absorb T-3）：
 *    429 响应体高频携带 "quota exceeded"/"额度不足" 等跨计费/限流两界的措辞，
 *    若余额关键词先判会把限流误归 hard_credit → 调用方硬冷却到次日 04:00，白扔号约 12h
 *    （见 proxy.ts 的 `case 'hard_credit'`）。状态码是比关键词更权威的信号：上游既然给了
 *    429 就按限流语义处理（宁可短冷却自愈，不可长冷却弃号）。真正的余额耗尽由 402 捕获，
 *    非 429 状态码携带的 quota 措辞仍走下方余额关键词层，历史语义不变；
 *  - 6004 模型级限流（本仓额外细分，源实现由调用方分流）判在 429 之前：更具体的业务码优先。
 */
export function classifyWorkbuddyUpstreamError(status: number, bodyText: string): WorkbuddyErrorKind {
  const lower = bodyText.toLowerCase()
  // 11115「prompt is too long」：请求级错误（移植 workbuddy2api 5f26ce3 promptTooLongRule）。
  // 上下文超限是**请求的问题不是账号的问题**——同一 body 换任何账号发都会超限，与 WAF
  // fail-fast 同哲学（确定与账号无关的错误不轮转，白扔健康号配额）。只认请求级状态码
  // 400/404/413（429 属限流语义、5xx 属服务端故障，均优先）；marker 双通道：code 字段
  // 形态（`"code":11115` / `"code":"11115"`，空格容差）与 msg 文案。判在 404/5xx/WAF/
  // 内容策略/通用 4xx 兜底之前——请求级语义最具体。11115 恰好撞在 requestId 上不算。
  if ((status === 400 || status === 404 || status === 413) &&
    (/"code"\s*:\s*"?11115"?/.test(bodyText) || lower.includes('prompt is too long'))) {
    return 'prompt_too_long'
  }
  // 11102「该后端无此模型」/ "service info not found"：确定性"模型在后端不存在"（移植
  // workbuddy2api IsModelBlocked）。只认 code==11102 或窄短语，且仅 400/404——
  // 避免 11102 恰好撞在 body 的 requestId 字段（整段文本）被误判。
  if ((status === 400 || status === 404) &&
    (/"code"\s*:\s*"?11102"?/.test(bodyText) || lower.includes('service info not found'))) {
    return 'model_blocked'
  }
  if (status === 402) return 'hard_credit'
  for (const m of SESSION_DEAD_MARKERS) {
    if (bodyText.includes(m)) return 'session_dead'
  }
  for (const m of ACCOUNT_FAULT_MARKERS) {
    if (lower.includes(m) || bodyText.includes(m)) return 'account_fault'
  }
  if (isModelRateLimit(bodyText)) return 'model_rate'
  // 429 先于余额关键词层（移植 145220d）：见上方顺序依据。
  if (status === 429) return 'soft_rate'
  for (const m of HARD_MARKERS) {
    if (lower.includes(m.toLowerCase()) || bodyText.includes(m)) return 'hard_credit'
  }
  if (status === 404) return 'not_found'
  if (status >= 500) return 'server'
  // WAF 403（无业务信封的拦截形态）：判在内容策略/参数错误/通用 4xx 之前——这些层只认带文案
  // 的 body，WAF 空体/HTML 永远不会命中它们的 marker，但落 client 兜底的代价是「只换号不罚」。
  // 带业务信封的 403（11140 request illegal 等）已被上方 account_fault 捕获，走不到本层。
  if (isWafBlocked(status, bodyText)) return 'waf_block'
  if (status >= 400) {
    for (const m of CONTENT_BLOCKED_MARKERS) {
      if (lower.includes(m)) return 'content_blocked'
    }
    if (bodyText.includes('Unmarshal chat params failed') || /"code"\s*:\s*"?11101"?/.test(bodyText)) {
      return 'bad_params'
    }
    return 'client'
  }
  return 'client'
}

// ===== 轮转退避（对齐 workbuddy2api 64eb4aa backoff.go） =====

/**
 * 轮转退避的单一事实来源（移植 workbuddy2api internal/server/backoff.go）：
 * java 指数基数/封顶/抖动比例一处定义，proxy 轮转循环与 WAF 软冷却共享。
 *
 * 语义对齐源实现：轮转换号前歇一下，让上游频控窗口滑过；正常单号请求（首轮成功）
 * 不经过退避，零开销。测试用 `__setBackoffBaseForTests` 可把基数置 0 跳过等待。
 */

/** 轮转退避基数（对齐 workbuddy2api rotateBackoffBase = 500ms，官方 intl CLI 形态）。 */
export const ROTATE_BACKOFF_BASE_MS = 500
/** 轮转退避封顶（对齐源实现 8s；轮转默认 3 次，实际等待序列 500ms/1s）。 */
export const ROTATE_BACKOFF_CAP_MS = 8000
/** 抖动比例（±25%，对齐源实现 jitterFraction）。 */
export const ROTATE_BACKOFF_JITTER = 0.25
/** 超出该位数视为「秒口径」的 epoch（对齐源实现：≥12 位才当作毫秒）。 */
export const ROTATE_EPOCH_MS_DIGITS = 12

/** 测试可替换的基数（对齐源实现 TestMain 置 0 加速测试）。 */
let rotateBackoffBaseMs = ROTATE_BACKOFF_BASE_MS
export function __setBackoffBaseForTests(ms: number): void { rotateBackoffBaseMs = ms }

/**
 * 给时长施加 ±ROTATE_BACKOFF_JITTER 的均匀抖动（对齐源实现 jitterDur）。
 * d<=0 原样返回（零等待不抖动）。
 */
export function jitterDurMs(ms: number): number {
  if (ms <= 0) return ms
  const f = 1 + (Math.random() * 2 - 1) * ROTATE_BACKOFF_JITTER
  const out = ms * f
  return out < 0 ? 0 : out
}

/**
 * 第 n 次轮转（0 基：首次失败换号前 n=0）前应等待的退避时长：
 * base·2^n 封顶 ROTATE_BACKOFF_CAP_MS，再施加 ±25% 抖动（对齐源实现 backoffAfter）。
 * base 置 0（测试）时恒 0。
 */
export function rotateBackoffAfterMs(n: number): number {
  const base = rotateBackoffBaseMs
  if (base <= 0) return 0
  let d = base
  for (let k = 0; k < n && d < ROTATE_BACKOFF_CAP_MS; k++) {
    d *= 2
    if (d <= 0) return jitterDurMs(ROTATE_BACKOFF_CAP_MS) // 翻倍溢出：直接按封顶
  }
  if (d > ROTATE_BACKOFF_CAP_MS) d = ROTATE_BACKOFF_CAP_MS
  return jitterDurMs(d)
}

/** 可取消的等待：aborted 时立即返回 false（客户端断连/优雅停机不必等退避睡醒）。 */
export function isAbortCancelled(signal?: AbortSignal | { aborted?: boolean }): boolean {
  return !!(signal && (signal as { aborted?: boolean }).aborted)
}

// ===== Retry-After 头族解析（对齐 workbuddy2api 76fafa6 ParseRetryAfter） =====

/**
 * 限流/拦截响应头候选人（对齐源实现 retryAfterHeaderCandidates）：
 * retry-after（秒，RFC 7231）/ retry-after-ms（毫秒）/ x-ratelimit-reset（epoch 秒或毫秒）。
 * 大小写不敏感（fetch 的 Headers.get 已归一为小写）。
 */
export const RETRY_AFTER_HEADER_CANDIDATES = ['retry-after', 'retry-after-ms', 'x-ratelimit-reset']

/** 解析结果上限（超过视为上游异常值丢弃，回落本地计算）。与 soft_rate_max 默认 2h 同量级。 */
export const RETRY_AFTER_SANITY_MS = 2 * 60 * 60 * 1000

/** 纯数字判定（前置快筛）。 */
export function isAllDigits(s: string): boolean {
  if (s === '') return false
  for (const r of s) if (r < '0' || r > '9') return false
  return true
}

/**
 * 按头名口径把纯数字串折算成时长（ms）。
 * x-ratelimit-reset 是 epoch 时刻而非时长：秒口径（10 位）与毫秒口径（≥12 位）都按
 * 「now + 该时刻的剩余量」折算，已在过去则返回非正（调用方按不合法丢弃）。
 */
export function parseRetryNumberMs(v: string, headerName: string, nowMs: number = Date.now()): number {
  if (v.length > 16) return 0 // 防 int64 溢出（对齐源实现）
  let n = 0
  for (const r of v) {
    n = n * 10 + (r.charCodeAt(0) - 48)
    if (n > Number.MAX_SAFE_INTEGER) return 0
  }
  switch (headerName) {
    case 'retry-after':
      return n * 1000
    case 'retry-after-ms':
      return n
    default: { // x-ratelimit-reset：epoch → 剩余量
      let sec = n
      if (v.length >= ROTATE_EPOCH_MS_DIGITS) sec = Math.floor(n / 1000) // ≥12 位当作毫秒
      const remain = (sec * 1000) - nowMs
      return remain
    }
  }
}

/**
 * 从响应头解析上游明示的等待时长（对齐源实现 ParseRetryAfter）。
 * 依次尝试 retry-after（秒）→ retry-after-ms（毫秒）→ x-ratelimit-reset（epoch）。
 * 任一头缺失/非法/非正/超上限则尝试下一头；全部不可用返回 null（调用方回落既有计算值）。
 */
export function parseRetryAfterMs(headers: Headers, nowMs: number = Date.now()): number | null {
  for (const name of RETRY_AFTER_HEADER_CANDIDATES) {
    const v = (headers.get(name) || '').trim()
    if (v === '') continue
    if (!isAllDigits(v)) continue // 非纯数字（如 HTTP-Date）不解析，宁缺毋滥
    const ms = parseRetryNumberMs(v, name, nowMs)
    if (ms <= 0 || ms > RETRY_AFTER_SANITY_MS) continue
    return ms
  }
  return null
}

// ===== WAF 403 判定（对齐 workbuddy2api 76fafa6 IsWafBlocked） =====

/**
 * body 是否携带上游业务信封形态（JSON 且含 `"code":` 或 `"msg":` 字段）。
 * WAF 403 判定用「无业务信封」区分 APISIX WAF 拦截页（HTML/空体/纯文本）与上游业务层 403
 * （带 code/msg 信封，正常走既有分类）。畸形 JSON 但含字段名仍按业务保守处理（宁漏 WAF 不误罚）。
 */
export function hasBusinessEnvelope(bodyText: string): boolean {
  return bodyText.includes('"code":') || bodyText.includes('"msg":')
}

/**
 * 403 响应是否为 WAF 拦截形态（对齐源实现 IsWafBlocked）：
 * HTTP 403 且 body 无业务信封（HTML 拦截页、空体、纯文本均命中）。
 * 带业务信封的 403（11140 request illegal / 11128 等）仍走既有分类链，不受影响。
 */
export function isWafBlocked(status: number, bodyText: string): boolean {
  return status === 403 && !hasBusinessEnvelope(bodyText)
}

// ===== reasoning_effort 降级 =====

/** reasoning_effort 档位从低到高（对齐 workbuddy2api effortRank）。 */
export const EFFORT_RANK: Record<string, number> = {
  off: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
}

/** 捕获到的请求 reasoning_effort（sanitizeUpstreamBody 删除前抢救，含字段名以便按原字段恢复）。 */
export interface CapturedReasoningEffort {
  /** 请求中实际使用的字段名（snake / camel 双兼容） */
  key: 'reasoning_effort' | 'reasoningEffort'
  value: string
}

/**
 * 在 sanitizeUpstreamBody 删除字段之前捕获 reasoning_effort。
 * 仅接受非空字符串值；其余形态（对象/数字）一律忽略（保持删除）。
 */
export function captureWorkbuddyReasoningEffort(body: Record<string, unknown>): CapturedReasoningEffort | null {
  const snake = body['reasoning_effort']
  if (typeof snake === 'string' && snake.trim() !== '') {
    return { key: 'reasoning_effort', value: snake }
  }
  const camel = body['reasoningEffort']
  if (typeof camel === 'string' && camel.trim() !== '') {
    return { key: 'reasoningEffort', value: camel }
  }
  return null
}

/**
 * 按模型 supportedEfforts 处理已捕获的 reasoning_effort（对齐 workbuddy2api normalizeReasoningEffort）。
 *
 *   - supported 未声明/为空 → 不恢复（字段保持 sanitize 删除后的状态 = 既有行为，零回归）
 *   - 请求档位不在 EFFORT_RANK 表内（如 'ultra'） → 不恢复
 *   - 请求档位在支持列表内 → 按原字段名原样恢复（透传）
 *   - 请求档位不支持 → 降级为 ≤请求档位的最高支持档；支持档全部更高 → 取最低支持档（偏离最小）
 *
 * @param body      已被 sanitizeUpstreamBody 处理过的请求体（字段已删）
 * @param captured  captureWorkbuddyReasoningEffort 的抢救结果；null 时本函数为 no-op
 * @param supported 该模型支持的档位列表；undefined/空数组表示能力未知
 */
export function applyWorkbuddyReasoningEffort(
  body: Record<string, unknown>,
  captured: CapturedReasoningEffort | null,
  supported: string[] | undefined
): void {
  if (!captured || !supported || supported.length === 0) return
  const reqStr = captured.value.trim().toLowerCase()
  const reqIdx = EFFORT_RANK[reqStr]
  if (reqIdx === undefined) return

  // 在 ≤请求档位的支持档里选最高档
  let best = ''
  let bestIdx = -1
  for (const s of supported) {
    const idx = EFFORT_RANK[String(s).trim().toLowerCase()]
    if (idx !== undefined && idx <= reqIdx && idx > bestIdx) {
      best = String(s)
      bestIdx = idx
    }
  }
  if (best !== '') {
    body[captured.key] = best
    return
  }
  // 支持档全部高于请求档：取最低支持档（偏离最小）
  let lowest = ''
  let lowestIdx = Number.MAX_SAFE_INTEGER
  for (const s of supported) {
    const idx = EFFORT_RANK[String(s).trim().toLowerCase()]
    if (idx !== undefined && idx < lowestIdx) {
      lowest = String(s)
      lowestIdx = idx
    }
  }
  if (lowest !== '') {
    body[captured.key] = lowest
  }
}

// ===== 硬冷却时刻 =====

/** 中国标准时间固定偏移（+08:00）。中国无夏令时，固定 +8 即可，不依赖运行环境 tzdata。 */
export const CST_OFFSET_MS = 8 * 60 * 60 * 1000

/**
 * 下一个 04:00（**CST / Asia/Shanghai**）的 epoch ms —— 硬冷却目标时刻。
 *
 * 对齐 workbuddy2api `pool/cooldown.go:173-178` `nextDay4AM`：
 *  - now 在 CST 当天 04:00 之前（00:00~03:59:59）→ 返回**当天** 04:00；
 *  - 04:00 整及之后 → 返回**次日** 04:00。
 *
 * 为什么是「当天 04:00」而非恒次日：04:00 前触发的硬冷却（余额耗尽）等的是
 * 当天 09:00 签到恢复；恒返回次日会白冷约一天（源实现明确修过这个 bug，
 * 见 workbuddy2api `pool_test.go:586-590` 的边界用例）。
 *
 * 时区为什么必须显式固定为 CST：Cloudflare Workers 运行时本地时区恒为 **UTC**，
 * 若用 `new Date(y, m, d, 4)` 这类本地时区构造，得到的是 UTC 04:00 = **北京 12:00**，
 * 与「等北京 09:00 签到恢复」的语义错位 3 小时；`getHours() < 4` 判的也会是 UTC 小时
 * （北京 12:00 会被误判为"已过 04:00"）。故这里统一用「epoch 平移 + getUTC* / Date.UTC」
 * 的纯算术路径，结果与运行环境时区无关。
 *
 * Date.UTC 对日/月溢出自动进位（月末→下月 1 号、年末→下年 1 号），
 * 天然覆盖跨日/跨月/跨年（对齐 Go `time.Date` 行为）。
 */
export function nextDay4AMMs(from: number = Date.now()): number {
  // 把 epoch 平移到「CST 墙钟」，再用 getUTC* 读出 CST 视角的年月日时
  const cst = new Date(from + CST_OFFSET_MS)
  const y = cst.getUTCFullYear()
  const mo = cst.getUTCMonth()
  const d = cst.getUTCDate()
  const hour = cst.getUTCHours()
  // CST 当天 04:00 尚未到（hour < 4）→ 取当天；已到/已过 → 取次日
  const dayOffset = hour < 4 ? 0 : 1
  // Date.UTC 给出「UTC 墙钟」的 04:00，再平移回真实 epoch（CST 04:00 = UTC 前一日 20:00）
  return Date.UTC(y, mo, d + dayOffset, 4, 0, 0, 0) - CST_OFFSET_MS
}

// ===== 出站请求体 stream_options 补全 =====

/**
 * 未显式携带有效 stream_options 时补 { include_usage: true }（移植 workbuddy2api payload.go D7）。
 *
 * 背景：WorkBuddy 上游强制流式；官方 CLI 流式必发 stream_options.include_usage=true，
 * 上游据此在**末帧**返回 usage 用量。网关侧的成本账本（recordOauthModelCost）依赖
 * usage.credit 折算每千 token 单价，若出站不带该字段则末帧无 usage → 账本永不写入 →
 * 成本优先分层选号（tier 0 免费优先）静默失效。
 *
 * 语义：
 *  - body 已有 stream_options **对象**（含显式 include_usage:false）→ 原样保留，不覆盖
 *    （尊重调用方意图，与 workbuddy2api 的 `if !has` 判断一致）；
 *  - 键不存在 → 注入 { include_usage: true }（与 workbuddy2api 逐字一致）；
 *  - 键存在但值为 null / 非对象标量 / 数组 → 注入标准对象。
 *
 * 与源实现的**唯一刻意差异**：Go 版只判 `if _, has := obj["stream_options"]; !has`，
 * 因此 `"stream_options": null` 与 `"stream_options": "x"` 会原样透传。这两种值上游均
 * 无法解析（Go 侧结构体指针收到 null 视作缺省、收到标量则 400 code=11101），
 * 网关侧则等价于"没给有效值"。这里收窄为注入标准对象：既不改变正常客户端行为，
 * 又让畸形值不再导致账本静默失效。该差异有测试锁定（workbuddy-upstream.test.ts）。
 */
export function ensureWorkbuddyStreamOptions(body: Record<string, unknown>): void {
  const existing = body['stream_options']
  // 已有有效对象（含 include_usage:false）→ 不覆盖，尊重调用方意图
  if (existing !== null && typeof existing === 'object' && !Array.isArray(existing)) return
  // 键不存在 / null / 非对象标量 / 数组 → 注入标准对象
  body['stream_options'] = { include_usage: true }
}

// ===== 出站请求体 max_tokens 安全护栏 =====

/** 客户端未显式提供 max_tokens / max_completion_tokens 时的默认护栏上限（对齐 Cline CLINE_MAX_TOKENS = 32768）。 */
export const WORKBUDDY_DEFAULT_MAX_TOKENS = 32768

/**
 * 为出站 WorkBuddy 请求体翻译 `max_completion_tokens` 并注入默认 max_tokens 护栏。
 *
 * 规则（对齐 workbuddy2api payload.go translateMaxCompletionTokens，移植 edb9e97 / PR #116）：
 *  - **别名一律删除**：上游（CN /v2 与 global /console 是同一套 API）只认 `max_tokens`，
 *    OpenAI 新别名 `max_completion_tokens` 会被忽略后回落上游默认输出上限（实测 32000），
 *    长回答被截。删掉别名同时减小 body 体积与排障噪音；
 *  - 显式 `max_tokens` 为非正数/无效值（0/null/负数/非数字）→ 注入 WORKBUDDY_DEFAULT_MAX_TOKENS
 *    （本仓安全护栏，源实现无此层：0/null 走上游默认）；
 *  - 别名存在且为**正安全整数** → 回写整数形态的 `max_tokens`（避免小数尾巴/科学计数法进上游 body）；
 *  - 别名存在但非正/非整数/非数字（0/null/负数/浮尾/字符串等非法值）→ 不翻译，回落护栏默认值。
 *
 * 为什么必须翻译而不是"透传别名 + 注入护栏"：本仓此前见 `max_completion_tokens > 0` 即
 * 直接 return，出站 body 既无 `max_tokens` 也无兜底值——DSH 之类只发别名的客户端（实测
 * `max_completion_tokens=128000`）在上游侧等于**没设上限**，实测被截到 32000。
 */
export function ensureWorkbuddyMaxTokens(body: Record<string, unknown>, defaultTokens = WORKBUDDY_DEFAULT_MAX_TOKENS): void {
  const alias = body['max_completion_tokens']
  // 别名一律删除（上游只认 max_tokens；留着只会误导排障）
  if (alias !== undefined) delete body['max_completion_tokens']
  const mt = body['max_tokens']
  const hasValidMt = typeof mt === 'number' && Number.isFinite(mt) && mt > 0
  if (hasValidMt) return
  // 别名为正安全整数 → 翻译回写（Number.isSafeInteger 同时挡掉 1e21 这类会写成科学计数法的值）
  if (typeof alias === 'number' && Number.isSafeInteger(alias) && alias > 0) {
    body['max_tokens'] = alias
    return
  }
  body['max_tokens'] = defaultTokens
}


// ===== DeepSeek 思维链注入与历史消息回填 =====

/** 模型名是否以 deepseek 开头（忽略大小写与首尾空格，对齐 workbuddy2api isDeepSeekModel）。 */
export function isDeepSeekModel(model: string): boolean {
  return model.trim().toLowerCase().startsWith('deepseek')
}

/** 缺省思维链 effort 档位（对齐 workbuddy2api defaultDeepSeekEffort）。 */
export const DEFAULT_DEEPSEEK_EFFORT = 'high'

/**
 * 为 DeepSeek 系模型出站请求注入 thinking:{type:"enabled"} 与默认 effort。
 * 对齐官方客户端 codebuddy.js 逆向与 workbuddy2api thinking.go injectThinking：
 *  - 非 deepseek 模型零改动；
 *  - thinking.type 为 disabled 时显式尊重，删除 reasoning_effort 与 reasoningEffort；
 *  - 显式 enabled 缺 effort 补默认档；
 *  - 无 thinking 或 type 为空：注入 { type: 'enabled' } 并补默认档（已有 effort 则保留不覆盖）。
 */
export function injectDeepSeekThinking(body: Record<string, unknown>): void {
  const model = typeof body['model'] === 'string' ? body['model'] : ''
  if (!isDeepSeekModel(model)) return

  const th = body['thinking']
  if (th && typeof th === 'object' && !Array.isArray(th)) {
    const thObj = th as Record<string, unknown>
    const typ = typeof thObj['type'] === 'string' ? thObj['type'].trim().toLowerCase() : ''
    if (typ === 'disabled') {
      delete body['reasoning_effort']
      delete body['reasoningEffort']
      return
    }
    ensureDeepSeekEffort(body)
    return
  }

  // 无 thinking 或非法非对象值
  body['thinking'] = { type: 'enabled' }
  ensureDeepSeekEffort(body)
}

function ensureDeepSeekEffort(body: Record<string, unknown>): void {
  if (body['reasoning_effort'] !== undefined || body['reasoningEffort'] !== undefined) {
    return
  }
  body['reasoning_effort'] = DEFAULT_DEEPSEEK_EFFORT
}

/**
 * DeepSeek 多轮一致性回填（对齐 workbuddy2api thinking.go backfillReasoningContent，含 3b048ec）：
 * 官方客户端规则 requiresReasoningContentOnAssistantMessages：上游要求所有 assistant 消息
 * 都带 reasoning_content（string，无则补空串 ""），否则直接以 HTTP 400 拒绝请求。
 *
 * 门控（对齐官方 ReasoningContentBackfillRule：thinkingEnabled || hasTrace）：
 *  - 非 deepseek 模型 → 零改动；
 *  - deepseek + enabled（含注入后默认形态）→ 每条 assistant 保证 reasoning_content 是 string：
 *    已有 string 原样保留；reasoning 是 string 则复制；两者皆无 → 补空串 ""。
 *    第三方客户端丢推理回传（零痕迹）形态下官方本就补，旧实现只认 hasTrace 半边是缺陷；
 *  - deepseek + disabled + 无痕迹 → 零改动（两个半边都不亮）；
 *  - deepseek + disabled + 有痕迹 → 照补（hasTrace 半边，多轮一致性不因关思维链而丢）。
 *
 * thinkingEnabled 读**注入后**请求体 thinking.type === 'enabled'——调用管线中
 * injectDeepSeekThinking 恒先行（proxy.ts 全部调用点顺序已满足）。
 */
export function backfillReasoningContent(body: Record<string, unknown>): void {
  const model = typeof body['model'] === 'string' ? body['model'] : ''
  if (!isDeepSeekModel(model)) return

  const msgs = body['messages']
  if (!Array.isArray(msgs) || msgs.length === 0) return

  const th = body['thinking']
  const thinkingEnabled =
    !!(th && typeof th === 'object' && !Array.isArray(th) &&
      typeof (th as Record<string, unknown>)['type'] === 'string' &&
      ((th as Record<string, unknown>)['type'] as string).trim().toLowerCase() === 'enabled')

  // 第一遍：检测是否有任何 reasoning 痕迹
  let hasTrace = false
  for (const item of msgs) {
    if (!item || typeof item !== 'object') continue
    const m = item as Record<string, unknown>
    if (typeof m['reasoning'] === 'string' && m['reasoning'].trim() !== '') {
      hasTrace = true
      break
    }
    if (m['reasoning_content'] !== undefined) {
      hasTrace = true
      break
    }
  }
  if (!thinkingEnabled && !hasTrace) return

  // 第二遍：为所有 assistant 补齐 reasoning_content 字段。
  // 跳过条件只认 string（官方 "string"!==typeof 才动手）：null/数字不再被当
  // 「已有」跳过，归一化为 ""。
  for (const item of msgs) {
    if (!item || typeof item !== 'object') continue
    const m = item as Record<string, unknown>
    if (m['role'] !== 'assistant') continue
    if (typeof m['reasoning_content'] === 'string') continue // 已有 string → 不覆盖
    if (typeof m['reasoning'] === 'string') {
      m['reasoning_content'] = m['reasoning']
    } else {
      m['reasoning_content'] = ''
    }
  }
}

// ===== 指纹脱敏（移植 workbuddy2api internal/upstream/sanitize.go） =====

/**
 * 特征预检串（任一命中才进入净化，普通请求零改动）。
 * 对齐 workbuddy2api sanitizeFeatures。
 */
const SANITIZE_FEATURES = [
  'x-anthropic-billing-header',
  'cc_entrypoint=',
  'You are Claude Code',
  'Main branch (',
  'You are a coding agent running in the Codex CLI',
  'github.com/anthropics/',
  '11128',
]

/** 剥离层：header 键名即触发（与值无关），整段删除。 */
const SANITIZE_HDR_RE = /x-anthropic-billing-header:[^;\n]*;?\s*/gi
/**
 * 兜底层：**裸键名**（无冒号无值）同样是指纹（对齐 workbuddy2api sanitizeBareHdrRe）。
 *
 * 2026-09-13 实验 F4 证实：assistant 消息里用反引号引用裸键名即触发 11-128，而剥离层
 * SANITIZE_HDR_RE 要求冒号、对裸串无效。键值形态被整段删除后，残留的裸键名做最小缩写
 * （header→hdr）：破坏逐字匹配、语义不变、保留可读性。大小写不敏感，覆盖 X-Anthropic-… 变体。
 *
 * 与 SANITIZE_HDR_RE 的分工：本正则不要求冒号，是它的**超集**，但两者替换语义不同
 * （整段删除 vs 最小缩写），不可合并。检测与改写都必须覆盖它，否则「混合大小写 + 无冒号」
 * 形态（引号/示例文本里的 X-Anthropic-Billing-Header）既不检测也不改写 → 带指纹出站 → 400/11-128。
 */
const SANITIZE_BARE_HDR_RE = /x-anthropic-billing-header/gi
/** 剥离层：尾随裸键值（cc_xxx=...;）循环清理。 */
const SANITIZE_KV_RE = /\bcc_[a-z0-9_]+=[^;\n]*;?\s*/gi

/**
 * 改写层：全模板句逐字替换（每句只改一个词，语义不变）。
 * 对齐 workbuddy2api sanitizeRewrites。
 *
 * 关键点（源实现有回归测试锁定）：
 *  1. **身份句匹配串不带结尾标点**（只到 `…for Claude`）：CLI 版以句号收尾、桌面版
 *     （claude-desktop-3p / Agent SDK）以逗号接后继内容。带句号的整句只匹配前者，
 *     桌面版会漏网 → 指纹原样发上游 → **400 code=11128**。替换串同样不带标点，
 *     让原有标点原样保留。
 *  2. **用连字符打断 `11128` 而非零宽空格**：源实现明确"零宽空格无效，实测上游会归一化"。
 *     本仓旧实现用 `\u200B` 插入零宽空格——这是**无效做法**，本次修正。
 *  3. 反馈句需**整句**同时出现才被拦（只留链接或只留半边均不拦）。
 */
const SANITIZE_REWRITES: Array<[string, string]> = [
  [
    "You are Claude Code, Anthropic's official CLI for Claude",
    "You are Claude Code, Anthropic's official CLI tool for Claude",
  ],
  [
    'Main branch (you will usually use this for PRs)',
    'Default branch (you will usually use this for PRs)',
  ],
  [
    'You are a coding agent running in the Codex CLI, a terminal-based coding assistant.',
    'You are a coding agent running in the Codex CLI tool, a terminal-based coding assistant.',
  ],
  [
    'To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues',
    'To provide feedback, users should report the issue at https://github.com/anthropics/claude-code/issues',
  ],
  // 上游反探测：请求体里出现裸数字 11128 即整单拦截（与上下文无关）。
  // 插入连字符保留可读性与指代（零宽空格无效）。
  ['11128', '11-128'],
]

/**
 * 指纹字面量的**当前字节形态快照**（移植 workbuddy2api `231a076`，
 * 对齐源 `TestSanitizeLiteralByteExact`）。
 *
 * 为什么需要：这些字面量（特征串 / 改写对 / 3 条正则）全部是实验逆向出的上游内容
 * 审核**逐字精确匹配黑名单**，没有任何契约可引用——改错一个字节就会漏拦（400 code=11-128）
 * 或误伤正常内容。快照把当前字节形态硬编码进测试：任何未来未同步的改动先红在测试上，
 * 强制走「逐字节验证」流程（grep 全部出现点 + 真实账号上游实测 + 全族回归）。
 *
 * 本函数只把既有常量暴露给测试，**不改变任何行为**。
 */
export function sanitizeLiteralsSnapshot(): {
  features: readonly string[]
  rewrites: ReadonlyArray<readonly [string, string]>
  hdrRe: string
  kvRe: string
  bareHdrRe: string
} {
  return {
    features: SANITIZE_FEATURES,
    rewrites: SANITIZE_REWRITES,
    hdrRe: SANITIZE_HDR_RE.source,
    kvRe: SANITIZE_KV_RE.source,
    bareHdrRe: SANITIZE_BARE_HDR_RE.source,
  }
}

/** 是否命中任一特征（快速路径）。 */
function hasSanitizeFingerprint(text: string): boolean {
  for (const f of SANITIZE_FEATURES) {
    if (text.includes(f)) return true
  }
  // header 键名有大小写变体，快速路径漏掉时再落正则兜底。裸键名（无冒号）是
  // SANITIZE_HDR_RE 的超集形态，故只需这一个正则即可覆盖两种形态（对齐源
  // hasFingerprint 的注释：无需再单独匹配要求冒号的那个）。
  SANITIZE_BARE_HDR_RE.lastIndex = 0
  return SANITIZE_BARE_HDR_RE.test(text)
}

/**
 * 单段文本净化（对齐 workbuddy2api sanitizeText）。
 * 顺序：**先改写、后剥离、最后兜底缩写裸键名、最后 trim**。
 */
export function sanitizeFingerprintText(text: string): string {
  if (!hasSanitizeFingerprint(text)) return text
  for (const [from, to] of SANITIZE_REWRITES) {
    text = text.split(from).join(to)
  }
  SANITIZE_HDR_RE.lastIndex = 0
  if (SANITIZE_HDR_RE.test(text)) {
    SANITIZE_HDR_RE.lastIndex = 0
    text = text.replace(SANITIZE_HDR_RE, '')
  }
  if (text.includes('cc_')) {
    let prev = ''
    while (prev !== text) {
      prev = text
      SANITIZE_KV_RE.lastIndex = 0
      text = text.replace(SANITIZE_KV_RE, '')
    }
  }
  // 兜底：键值形态已在上面整段删除，这里只剩裸键名（引用/示例文本形态）→ 最小缩写。
  SANITIZE_BARE_HDR_RE.lastIndex = 0
  text = text.replace(SANITIZE_BARE_HDR_RE, 'x-anthropic-billing-hdr')
  return text.trim()
}

/**
 * 净化 content（兼容字符串与多模态数组）：只动 text part，image 等 part 不动。
 * 返回是否发生变化。
 */
function sanitizeContentValue(v: unknown): { value: unknown; changed: boolean } {
  if (typeof v === 'string') {
    const s = sanitizeFingerprintText(v)
    return { value: s, changed: s !== v }
  }
  if (Array.isArray(v)) {
    let changed = false
    for (const p of v) {
      if (!p || typeof p !== 'object' || Array.isArray(p)) continue
      const part = p as Record<string, unknown>
      const text = part['text']
      if (typeof text !== 'string') continue
      const s = sanitizeFingerprintText(text)
      if (s !== text) {
        part['text'] = s
        changed = true
      }
    }
    return { value: v, changed }
  }
  return { value: v, changed: false }
}

/**
 * 净化 assistant.tool_calls[].function.arguments。
 *
 * arguments 是**字符串化的 JSON**（不是对象），故按文本走 sanitizeFingerprintText 即可。
 * 这块长期是盲区：工具调用消息的 content 通常是 null，若在 content 缺失时直接跳过整条消息，
 * tool_calls 里写进的被拦字符串（文件名/命令/写入内容）会原样漏出。
 */
function sanitizeToolCallsValue(v: unknown): boolean {
  if (!Array.isArray(v)) return false
  let changed = false
  for (const c of v) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) continue
    const fn = (c as Record<string, unknown>)['function']
    if (!fn || typeof fn !== 'object' || Array.isArray(fn)) continue
    const args = (fn as Record<string, unknown>)['arguments']
    if (typeof args !== 'string') continue
    const s = sanitizeFingerprintText(args)
    if (s !== args) {
      ;(fn as Record<string, unknown>)['arguments'] = s
      changed = true
    }
  }
  return changed
}

/**
 * tool 结果块重排（移植 workbuddy2api `155af65`，对齐源 `repackToolResultBlocks`）。
 *
 * 把插在 `assistant.tool_calls` 与其 tool 结果之间的**非 tool 消息**挪到整组之后，
 * 保证同一批 tool_call 的结果在 wire 上连续。
 *
 * 背景：Codex 的 `image_resize_notice` 会把一条 developer/system 消息插在 tool 输出
 * 后面；并行调用时它插在两份 tool 结果中间：
 *
 *     assistant tool_calls=[c00 c01] | tool c00 | developer <notice> | tool c01
 *
 * OpenAI 兼容协议要求 tool 结果紧跟 assistant，中间插任何消息都算配对断裂，上游判
 * 11148（tool_call_sequence_broken）并顶死整条会话。这里**只调顺序、不改内容**：
 *
 *     assistant tool_calls=[c00 c01] | tool c00 | tool c01 | developer <notice>
 *
 * 结果顺序保持不变（同批 tool_call 的原相对顺序 = 结果顺序）。下一组
 * `assistant.tool_calls` 是新的组头，绝不当作插入物吞掉（否则它自己那批结果永远得不到
 * 重排）。无插入消息时返回原数组 + false（零改动零分配）。
 */
export function repackToolResultBlocks(messages: unknown[]): { messages: unknown[]; changed: boolean } {
  if (messages.length < 3) return { messages, changed: false }
  const out: unknown[] = []
  let changed = false
  let i = 0
  while (i < messages.length) {
    const m = messages[i]
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      out.push(m)
      i++
      continue
    }
    const msg = m as Record<string, unknown>
    if (msg['role'] !== 'assistant') {
      out.push(m)
      i++
      continue
    }
    const tcs = msg['tool_calls']
    if (!Array.isArray(tcs) || tcs.length === 0) {
      out.push(m)
      i++
      continue
    }
    const want = new Set<string>()
    for (const tci of tcs) {
      if (tci && typeof tci === 'object' && !Array.isArray(tci)) {
        const id = (tci as Record<string, unknown>)['id']
        if (typeof id === 'string' && id !== '') want.add(id)
      }
    }
    // 收集紧随其后（允许被其他消息打断）的同批 tool 结果，按原相对顺序
    out.push(m)
    i++
    const results: unknown[] = []
    const between: unknown[] = []
    let sawNonTool = false
    while (i < messages.length) {
      const mm = messages[i]
      if (!mm || typeof mm !== 'object' || Array.isArray(mm)) break
      const row = mm as Record<string, unknown>
      const role = typeof row['role'] === 'string' ? (row['role'] as string) : ''
      if (role === 'tool') {
        const id = typeof row['tool_call_id'] === 'string' ? (row['tool_call_id'] as string) : ''
        if (!want.has(id)) break
        results.push(mm)
        if (sawNonTool) changed = true
        i++
        continue
      }
      // assistant 后还没有任何结果：交由 cleanupOrphanToolCalls 处理
      if (results.length === 0) break
      // 下一组 assistant.tool_calls 是新的组头，绝不能当插入物吞掉
      if (role === 'assistant') {
        const next = row['tool_calls']
        if (Array.isArray(next) && next.length > 0) break
      }
      // 同批结果尚未收齐时，中间消息视为插入物，暂存待后移
      between.push(mm)
      sawNonTool = true
      i++
    }
    out.push(...results, ...between)
  }
  if (!changed) return { messages, changed: false }
  return { messages: out, changed: true }
}

/**
 * 剔除无法配对的 tool_call 与 tool 结果（移植 workbuddy2api `155af65`，对齐源
 * `cleanupOrphanToolCalls`）。
 *
 * 背景：OpenAI 兼容协议要求带 `tool_calls` 的 assistant 消息，其每个 tool_call id 都要
 * 有对应的 `role:'tool'` 结果；反之 role:'tool' 也必须能对应到前置调用。不完整配对会让
 * 上游对之后**每条**消息都返 400（11148 tool calls and tool results do not match），
 * 整条会话报废。宁可丢一轮工具上下文，也要让会话自愈。
 *
 * 关键：调用侧与结果侧**共用同一份 keepCalls 按 id 对称裁剪**。历史实现是「批内每个 id
 * 都齐才整批保留，否则删掉整个 tool_calls 键」，那会留下无主结果——批 [c1,c2] 只回了 c1
 * 时调用侧整批被删、而 tool{c1} 仍按 id 命中保留，出站变成「无 tool_calls 的 assistant +
 * 孤儿 tool」，照样 11148。
 *
 * 返回清理后的数组与是否发生删除；无任何工具流量时原数组原样返回。
 */
export function cleanupOrphanToolCalls(messages: unknown[]): { messages: unknown[]; changed: boolean } {
  if (messages.length === 0) return { messages, changed: false }
  const callIDs = new Set<string>()
  const resultIDs = new Set<string>()
  let hasTraffic = false
  for (const m of messages) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) continue
    const msg = m as Record<string, unknown>
    const role = msg['role']
    if (role === 'tool') {
      const id = msg['tool_call_id']
      if (typeof id === 'string' && id !== '') {
        resultIDs.add(id)
        hasTraffic = true
      }
    } else if (role === 'assistant') {
      const tcs = msg['tool_calls']
      if (Array.isArray(tcs)) {
        for (const tci of tcs) {
          if (!tci || typeof tci !== 'object' || Array.isArray(tci)) continue
          const id = (tci as Record<string, unknown>)['id']
          if (typeof id === 'string' && id !== '') {
            callIDs.add(id)
            hasTraffic = true
          }
        }
      }
    }
  }
  if (!hasTraffic) return { messages, changed: false }
  // keepCalls：调用 id 双侧齐全（调用存在且结果存在）。重复 id 与乱序均按集合处理。
  const keepCalls = new Set<string>()
  for (const id of callIDs) if (resultIDs.has(id)) keepCalls.add(id)

  let changed = false
  // 1) assistant.tool_calls：按 keepCalls 对称裁剪，只留有结果的调用；过滤后为空则删键。
  for (const m of messages) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) continue
    const msg = m as Record<string, unknown>
    if (msg['role'] !== 'assistant') continue
    const tcs = msg['tool_calls']
    if (!Array.isArray(tcs) || tcs.length === 0) continue
    const keptCalls = tcs.filter((tci) => {
      if (!tci || typeof tci !== 'object' || Array.isArray(tci)) return false
      const id = (tci as Record<string, unknown>)['id']
      return typeof id === 'string' && keepCalls.has(id)
    })
    if (keptCalls.length === tcs.length) continue // 整批齐全：零改动
    changed = true
    if (keptCalls.length === 0) {
      delete msg['tool_calls']
      continue
    }
    msg['tool_calls'] = keptCalls
  }
  // 2) role:tool 结果：只有对应 tool_call 被保留才保留；孤儿结果整条删除。
  const kept = messages.filter((m) => {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return true
    const msg = m as Record<string, unknown>
    if (msg['role'] !== 'tool') return true
    const id = msg['tool_call_id']
    return typeof id === 'string' && keepCalls.has(id)
  })
  if (kept.length !== messages.length) changed = true
  if (!changed) return { messages, changed: false }
  return { messages: kept, changed: true }
}

/**
 * 出站请求体的**指纹脱敏**（移植 workbuddy2api sanitizeMessages）+ tool 配对修复
 * （移植 `155af65`：先 repack 再 cleanup，两侧同口径）。
 *
 * 遍历 messages：对每条消息的 `content` 与 `tool_calls` **各自独立**判断
 * （content 可以为 null——工具调用轮；早期实现遇 null 就 continue，导致 tool_calls
 * 完全不被净化）。
 *
 * 不在脱敏范围：name / tool_call_id / 顶层其他字段 / image part。
 */
export function sanitizeWorkbuddyMessages(body: Record<string, unknown>): void {
  const messages = body['messages']
  if (!Array.isArray(messages)) return
  for (const m of messages) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) continue
    const msg = m as Record<string, unknown>
    if ('content' in msg) {
      const { value, changed } = sanitizeContentValue(msg['content'])
      if (changed) msg['content'] = value
    }
    if ('tool_calls' in msg) {
      sanitizeToolCallsValue(msg['tool_calls'])
    }
  }
  // tool 配对两步（见 repackToolResultBlocks / cleanupOrphanToolCalls）：先重排再清理。
  // 插在结果中间的非 tool 消息（Codex image_resize_notice）同样判配对断裂，先 repack
  // 挪后，再 cleanup 删孤儿，两侧同口径。无改动时两步都返回原数组，回写等于零操作。
  const repacked = repackToolResultBlocks(messages)
  const cleaned = cleanupOrphanToolCalls(repacked.messages)
  if (repacked.changed || cleaned.changed) body['messages'] = cleaned.messages
}

// ===== global 兜底 system 注入 =====

/** global 兜底 system 提示词（对齐 workbuddy2api ensureConsoleSystem）。 */
export const GLOBAL_FALLBACK_SYSTEM = 'You are a helpful assistant.'

/**
 * global（国际版）请求的兜底 system 注入（移植 workbuddy2api payload.go:158-182
 * ensureConsoleSystem，吸收 PR #45，防 console 域上游 code 11-128）。
 *
 * 语义：**首条消息非 system** 时，在 messages 最前补一条 fallback system。
 *  - 首条已是 system → 不注入（即便后面还有别的 system 也不重复）；
 *  - messages 缺失/空/非法 → 不改动；
 *  - 非 global 请求不调用（CN 现状不动）。
 *
 * 与本仓既有实现的差异（本次修正）：旧实现判的是 `!msgs.some(m => m.role === 'system')`
 * ——即"**任意位置**没有 system 才注入"。当 system 出现在中间（如 `[user, system, user]`）
 * 时旧实现不注入，而上游是按**首条**是否 system 判定的，该形态仍会撞 code 11-128。
 * 这里改为与源头一致的"首条判定"。
 */
export function ensureGlobalFallbackSystem(body: Record<string, unknown>): void {
  const msgs = body['messages']
  if (!Array.isArray(msgs) || msgs.length === 0) return
  const first = msgs[0]
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    const role = (first as Record<string, unknown>)['role']
    if (typeof role === 'string' && role.trim().toLowerCase() === 'system') return
  }
  msgs.unshift({ role: 'system', content: GLOBAL_FALLBACK_SYSTEM })
}

// ===== 系统提示词体系（移植 workbuddy2api internal/prompt） =====

/** 降级中性提示词（对齐源实现 prompt.Degraded）：passthrough 模式遇内容拦截误报时换用。 */
export const WORKBUDDY_DEGRADED_PROMPT =
  "You are a helpful assistant. Respond in the user's language, follow the user's instructions, and be direct and concise."

/**
 * 用网关自有提示词替换 messages 里的 system/developer（对齐源实现 prompt.Rewrite）：
 *   - 删除所有 role 为 system/developer 的消息；
 *   - 在头部插入一条 {role:'system', content:systemPrompt}；
 *   - 其余字段与 user/assistant/tool 消息逐字不动。
 *
 * 用途（两处）：
 *   - custom 模式：用配置的自有提示词整体替换客户端 system/developer，从源头消除
 *     system 来源的指纹误报（用户/assistant 消息内的指纹串另由 sanitize 清洗，两层叠加）；
 *   - passthrough 降级重试：被内容拦截且判定为指纹误报时，换 WORKBUDDY_DEGRADED_PROMPT
 *     同请求重试一次（不改用户指令合法性语义）。
 *
 * 调用于 ensureGlobalFallbackSystem **之后**：若已注入兜底 system 会被一并替换为自有提示词
 * （语义一致，避免出现两条 system）。
 */
export function rewriteWorkbuddySystemPrompt(body: Record<string, unknown>, systemPrompt: string): void {
  if (!systemPrompt) return
  const msgs = body['messages']
  if (Array.isArray(msgs)) {
    const kept: unknown[] = []
    for (const m of msgs) {
      if (!m || typeof m !== 'object' || Array.isArray(m)) {
        kept.push(m)
        continue
      }
      const role = (m as Record<string, unknown>)['role']
      if (role === 'system' || role === 'developer') continue
      kept.push(m)
    }
    body['messages'] = [{ role: 'system', content: systemPrompt }, ...kept]
  } else {
    body['messages'] = [{ role: 'system', content: systemPrompt }]
  }
}

/**
 * 在「开头连续 system/developer 块」之后插入一条网关自有 system 提示词（移植
 * workbuddy2api `ff64ecd`，对齐源 `prompt.Append`；见 51bc469 / 9288f55）。
 *
 * 与 `rewriteWorkbuddySystemPrompt`（整体替换）并列的第三种模式：
 *  - 开头连续块 = 从 `messages[0]` 起 role 为 `system`/`developer` 的消息（精确匹配，
 *    与 Rewrite 的删除口径一致）；遇第一条非 system/developer 消息（含非对象消息、
 *    无 role 消息）即停；
 *  - 插入点 = 连续块末尾之后（块长 0 时即 messages 最前）；
 *  - 所有既有消息（含开头块、中途 system、user/assistant/tool）**逐字不动**——
 *    客户端项目规范/工具约定与网关提示词并用。
 *
 * 边界必须同时匹配 `system` 与 `developer`：归一（developer→system）在下游
 * `sanitizeUpstreamBody` 里做，本函数执行时开头块里的 developer 还是 developer。
 * 网关消息的角色用 `system` 而非 `developer`——上游 role 白名单不含 developer，
 * 插 developer 等于制造一次必然归一与多余 11-128 风险窗口。
 *
 * 守卫与 Rewrite 逐条一致：空 prompt → 原样返回；无 messages 字段 → 置为单条网关
 * system，其余字段原样保留。
 */
export function appendWorkbuddySystemPrompt(body: Record<string, unknown>, systemPrompt: string): void {
  if (!systemPrompt) return
  const msgs = body['messages']
  if (!Array.isArray(msgs)) {
    body['messages'] = [{ role: 'system', content: systemPrompt }]
    return
  }
  let insertAt = 0
  for (const m of msgs) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) break
    const role = (m as Record<string, unknown>)['role']
    if (role !== 'system' && role !== 'developer') break
    insertAt++
  }
  // 已有消息逐字不动：只在插入点拼接，不重排、不改写任何元素
  body['messages'] = [
    ...msgs.slice(0, insertAt),
    { role: 'system', content: systemPrompt },
    ...msgs.slice(insertAt),
  ]
}

// ===== global 模型目录动态探测解析（移植 workbuddy2api global_models.go） =====

/**
 * `/v3/config` 模型目录端点（CN/global 双域通用，路径不含 base）。
 *
 * 为什么必须有它：官方客户端的模型目录是**两级取数**——企业端点（CN `/console/...`、
 * global `/v2/...`）只给一部分，`/v3/config` 给全量。只探企业端点会丢掉 `/v3/config`
 * 独有的模型（上游实测：`deepseek-v4.1-flash`/`gpt-6-astra`/`hy4-preview-f`/
 * `kimi-k2.8-preview`）。
 *
 * UA 门禁（上游实测）：`/v3/config` 只放行三段式 CLI UA。Bearer + web UA → `400 code 12403`。
 * 本仓 `injectWorkbuddyChatHeaders` 已注入三段式 UA（`buildWorkbuddyUserAgent`），故可直接复用。
 */
export const WORKBUDDY_V3_CONFIG_PATH = '/v3/config'

/** global 模型目录探测路径候选（对齐 workbuddy2api globalModelsProbePaths）：
 *  /v2 家族优先（PR #20 实测 /v2/enterprises/personal/models 200 含完整模型表），
 *  /console 作 fallback（同域旧路径）。
 *
 *  v3-config-merge 后本家族降为**补缺路**：`/v3/config` 为主路，二者并发探测后并集合并
 *  （`gpt-5.3-codex` 等家族独有模型经此进并集）。 */
export const WORKBUDDY_GLOBAL_MODELS_PROBE_PATHS = [
  '/v2/enterprises/personal/models',
  '/console/enterprises/personal/models',
]

/** CN 企业端点路径（对齐 workbuddy2api cnModelsPath，与 pages.ts `_modelsUrl` 同路径）。
 *
 *  修正历史误判：本仓 `admin.ts` 曾注释「CN 域 /console/…/models 实测 404，无公开端点」，
 *  但上游长期用同一 URL 做 CN 动态源且可用——该「404」结论很可能是当初未带 WorkBuddy
 *  三段式 UA / `CommonHeaders` 探测所致。 */
export const WORKBUDDY_CN_MODELS_PATH = '/console/enterprises/personal/models'

/** 非对话模型 id 前缀（嵌入 / 补全 / 代码专用）：选中会撞 `code=11102`。 */
export const WORKBUDDY_NON_CHAT_ID_PREFIXES = ['nes-', 'completion-', 'codewise-'] as const

/** 非对话模型输出上限阈值（`maxOutputTokens <= 256` 视为 tiny 输出非对话模型）。 */
export const WORKBUDDY_NON_CHAT_MAX_OUTPUT_TOKENS = 256

/** 图片生成模型标签（非本网关用途）。 */
export const WORKBUDDY_NON_CHAT_TAG = 'text-to-image'

/**
 * 判定是否非对话模型（应从模型目录中过滤掉）。
 * 来源：workbuddy2api `nonChatModel`（harness buddy.ts:547-555）。三类规则：
 *  1. id 前缀 `nes-` / `completion-` / `codewise-`（嵌入/补全/代码专用）；
 *  2. `maxOutputTokens > 0 && <= 256`（tiny 输出）；
 *  3. `tags` 含 `text-to-image`（图片生成）。
 *
 * 为什么必须过滤：`/v3/config` 返回**全量** models，含大量非对话条目。不过滤就会把它们
 * 塞进管理后台的可勾选清单，用户选中后每次调用都撞 `11102`（该后端无此模型）。
 */
export function isWorkbuddyNonChatModel(
  id: string,
  maxOutputTokens?: number,
  tags?: string[],
): boolean {
  const lower = (id || '').trim().toLowerCase()
  for (const p of WORKBUDDY_NON_CHAT_ID_PREFIXES) {
    if (lower.startsWith(p)) return true
  }
  if (typeof maxOutputTokens === 'number' && maxOutputTokens > 0 &&
    maxOutputTokens <= WORKBUDDY_NON_CHAT_MAX_OUTPUT_TOKENS) {
    return true
  }
  if (Array.isArray(tags)) {
    for (const t of tags) {
      if (t === WORKBUDDY_NON_CHAT_TAG) return true
    }
  }
  return false
}

/** 解析出的单条 global 模型条目（id/展示名 + reasoning 档位桶，仅元数据无倍率）。 */
export interface WorkbuddyGlobalModelEntry {
  id: string
  displayName?: string
  supportedEfforts?: string[]
  defaultEffort?: string
  /** 积分倍率原文（对齐源实现 ModelInfo.Credits，如 "x0.05"），仅展示不参与选号。 */
  credits?: string
  /** 中文描述（对齐源实现 descriptionZh）。 */
  descriptionZh?: string
  /** 模型标签（对齐源实现 tags，含 badge:限时免费 等）。 */
  tags?: string[]
  /** 最大输出 tokens（对齐源实现 maxOutputTokens）——`nonChatModel` 过滤依据之一。 */
  maxOutputTokens?: number
}

/**
 * 合并两路模型目录（v3-config-merge 口径）：**primary 为主、secondary 补缺**。
 *
 * 规则（对齐 workbuddy2api `mergeGlobalCatalog` / `mergeModelInfos`）：
 *  - 去重 key = 模型 id；
 *  - 同 id **以 primary 条目为准**（credits 等字段权威在主路）；
 *  - secondary 只补 primary 缺失的 id（如 `gpt-5.3-codex` 只在企业端点）；
 *  - **输出顺序稳定**：primary 原序在前、secondary 补充项按原序在后——不依赖 map 迭代序。
 */
export function mergeWorkbuddyModelCatalogs(
  primary: WorkbuddyGlobalModelEntry[],
  secondary: WorkbuddyGlobalModelEntry[],
): WorkbuddyGlobalModelEntry[] {
  const seen = new Set<string>()
  const out: WorkbuddyGlobalModelEntry[] = []
  for (const e of primary || []) {
    if (!e || !e.id || seen.has(e.id)) continue
    seen.add(e.id)
    out.push(e)
  }
  for (const e of secondary || []) {
    if (!e || !e.id || seen.has(e.id)) continue
    seen.add(e.id)
    out.push(e)
  }
  return out
}


/**
 * 解析 global 模型目录响应（对齐 workbuddy2api parseGlobalModelNames）：
 *  - 窄表形态：data 为字符串数组 → 每项即模型 id；
 *  - 对象形态：data.models[].id/.name（id 优先），disabled 剔除，附带解析
 *    reasoning.supportedEfforts（数组优先）/ effort（单档视作单元素表）/ defaultEffort。
 * 解析失败 / 空名单 → 返回 null（调用方回落静态清单，等价"该端点没给全"）。
 *
 * opts.filterNonChat：按 `isWorkbuddyNonChatModel` 剔除非对话条目。`/v3/config` 返回**全量**
 * models（含图片/补全模型），主路必须开过滤；企业端点家族已自带 `agents[cli]` 白名单，
 * 开过滤也不改变结果（幂等），但为保持解析口径单一，两条路都开。
 */
export function parseWorkbuddyGlobalModels(
  raw: string,
  opts?: { filterNonChat?: boolean },
): WorkbuddyGlobalModelEntry[] | null {
  let env: { code?: unknown; data?: unknown }
  try {
    env = JSON.parse(raw) as { code?: unknown; data?: unknown }
  } catch {
    return null
  }
  if (env?.code !== 0 || env.data === undefined) return null
  const trimmed = typeof env.data === 'string' ? env.data.trim() : ''

  // 窄表形态：data 为字符串数组。两种承载：
  //  - data 直接是 JSON 数组（`"data":["a","b"]` → 解析后为 Array）；
  //  - data 是字符串化的数组（`"data":"[\"a\",\"b\"]"` → 解析后为以 "[" 开头的字符串）。
  //  两种情况都判断（对齐 Go 侧对 json.RawMessage 起首字符 `[` 的判定）。
  let narrowArr: unknown = null
  if (Array.isArray(env.data)) {
    narrowArr = env.data
  } else if (typeof env.data === 'string' && trimmed.startsWith('[')) {
    try { narrowArr = JSON.parse(env.data) } catch { /* 落到对象形态 */ }
  }
  if (Array.isArray(narrowArr)) {
    const out: WorkbuddyGlobalModelEntry[] = []
    for (const id of narrowArr) {
      const s = typeof id === 'string' ? id.trim() : ''
      if (s === '') continue
      // 窄表无 maxOutputTokens/tags 元数据，只按 id 前缀过滤
      if (opts?.filterNonChat && isWorkbuddyNonChatModel(s)) continue
      out.push({ id: s })
    }
    return out.length > 0 ? out : null
  }

  // 对象形态：data.models[]
  const obj = env.data as { models?: unknown }
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.models)) return null
  const out: WorkbuddyGlobalModelEntry[] = []
  for (const m of obj.models) {
    if (!m || typeof m !== 'object') continue
    const rec = m as Record<string, unknown>
    const id = typeof rec['id'] === 'string' && rec['id'].trim() !== ''
      ? rec['id'].trim()
      : (typeof rec['name'] === 'string' ? rec['name'].trim() : '')
    if (id === '') continue
    if (rec['disabled'] === true) continue
    // maxOutputTokens 需在过滤前取出（nonChatModel 的第二条规则依赖它）
    const maxOut = typeof rec['maxOutputTokens'] === 'number' ? rec['maxOutputTokens'] : undefined
    const tags = Array.isArray(rec['tags'])
      ? rec['tags'].filter((t): t is string => typeof t === 'string' && t.trim() !== '')
      : undefined
    if (opts?.filterNonChat && isWorkbuddyNonChatModel(id, maxOut, tags)) continue
    const entry: WorkbuddyGlobalModelEntry = { id }
    const name = typeof rec['name'] === 'string' ? rec['name'].trim() : ''
    if (name !== '' && name !== id) entry.displayName = name
    // 积分倍率 / 中文描述 / 标签（对齐源实现 ModelInfo.Credits/DescriptionZh/Tags，
    // 仅展示透出，不参与选号）。
    if (typeof rec['credits'] === 'string' && rec['credits'].trim() !== '') entry.credits = rec['credits'].trim()
    if (typeof rec['descriptionZh'] === 'string' && rec['descriptionZh'].trim() !== '') entry.descriptionZh = rec['descriptionZh'].trim()
    if (tags && tags.length > 0) entry.tags = tags
    if (maxOut !== undefined) entry.maxOutputTokens = maxOut
    const rz = rec['reasoning']
    if (rz && typeof rz === 'object') {
      const r = rz as Record<string, unknown>
      if (Array.isArray(r['supportedEfforts'])) {
        entry.supportedEfforts = r['supportedEfforts'].filter((x): x is string => typeof x === 'string')
        if (entry.supportedEfforts.length === 0) delete entry.supportedEfforts
      } else if (typeof r['effort'] === 'string' && r['effort'].trim() !== '') {
        entry.supportedEfforts = [r['effort'].trim()]
      }
      if (typeof r['defaultEffort'] === 'string' && r['defaultEffort'].trim() !== '') {
        entry.defaultEffort = r['defaultEffort'].trim()
      }
    }
    out.push(entry)
  }
  return out.length > 0 ? out : null
}

// ===== 协议归属头与身份头注入 =====

/**
 * WorkBuddy 客户端版本段（出站 UA 的 `WorkBuddy/<ver>` 与 X-IDE-Version）。
 * 取 ai-gateway 自身**实测点亮成功**的脚本常量（scripts/workbuddy/school_open_day_2026.py:134
 * 与 task_runner.py:233 的 `DESKTOP_UA`），而非 workbuddy2api 的 5.5.4——
 * 前者是本仓已验证可用的形态。
 */
export const WORKBUDDY_CLIENT_VERSION = '5.5.6'

/** 出站 UA 中 `CLI/<ver>` 段的版本（对齐官方内置 CLI 与实测脚本）。 */
export const WORKBUDDY_CLI_VERSION = '2.137.1'

/**
 * 组装官方桌面端形态的出站 UA（三段式）：
 *   `WorkBuddy/<clientVersion> <platform>/<clientVersion> CLI/<cliVersion>`
 *
 * 平台段（第二段）品牌**按 realm 切换**（对齐 workbuddy2api headers.go:65-71）：
 *  - CN → `WorkBuddy`（与第一段同值）
 *  - global → `WorkBuddy AI`（官方国际版 productName）
 *
 * 为什么必须按 realm 切：workbuddy2api 注释明确记载「global 账号送错平台段
 * （`WorkBuddy` 非 `WorkBuddy AI`）可能触发上游 403 code 11140 "request illegal" 风控」
 * （headers.go:62-63）。而 403/11140 已被本仓分类为 account_fault → 硬禁用，
 * 即送错 UA 的代价是**账号被永久禁用**，故这不是可选优化。
 *
 * 官方客户端无任何 UA 随机化，故这里保持确定性（同账号同版本恒同值）。
 */
export function buildWorkbuddyUserAgent(realm: 'cn' | 'global'): string {
  const platform = realm === 'global' ? 'WorkBuddy AI' : 'WorkBuddy'
  return `WorkBuddy/${WORKBUDDY_CLIENT_VERSION} ${platform}/${WORKBUDDY_CLIENT_VERSION} CLI/${WORKBUDDY_CLI_VERSION}`
}

/**
 * 按 realm 返回 Accept-Language（对齐 workbuddy2api headers.go:146-151）：
 * global → `en-US`；cn → `zh-CN`。
 *
 * 官方客户端按账号域发对应语言标识，对齐避免上游风控按语言缺失/错配误判。
 */
export function workbuddyAcceptLanguage(realm: 'cn' | 'global'): string {
  return realm === 'global' ? 'en-US' : 'zh-CN'
}

/**
 * WorkBuddy **chat 路径**的 Accept 头（对齐 workbuddy2api headers.go:191-192 的 D6 分流）。
 *
 * 源实现的 Accept 分流按**路径**而非按客户端意图：
 *  - CommonHeaders（refresh / models / billing 等非 chat 路径）→ `application/json`
 *  - ChatHeaders（所有 chat/completions 调用）→ `application/json, text/event-stream`
 *
 * 为什么 chat 恒发 event-stream 形式：WorkBuddy 上游被强制 `stream:true`
 * （网关侧再按客户端意图聚合或透传），因此**上游必然以 SSE 应答**，
 * Accept 必须声明能接受 event-stream，否则与实际上游行为不符。
 * 注意这与「客户端是否要流式」无关——那是网关侧聚合决策，不影响出站 Accept。
 *
 * 本仓现状缺陷：`buildOauthHeaders` 对 chat 路径也发 `application/json`（非 chat 形态），
 * 与"上游必回 SSE"的事实不符，故在 chat 专用的头注入函数里覆盖。
 */
export function workbuddyChatAccept(): string {
  return 'application/json, text/event-stream'
}

/**
 * 账号稳定的机器/会话 ID 派生（对齐 workbuddy2api deriveAccountStableID：固定盐
 * `wb2a:` + purpose + `:` + uid，跨账号维度稳定——区别于进程级随机盐）。
 *
 * 机器/会话 ID 不是密钥，无需密码学强度；目标仅是：同 uid 恒同值、异 uid 互异、
 * purpose 盐隔离（machine 与 session 永不相等）。用确定性 FNV-1a 同步哈希拼接 36 hex，
 * 保持 injectWorkbuddyChatHeaders 的同步签名（Web Crypto 的 subtle.digest 是异步的，
 * 会让头部注入函数连锁异步化，无此必要）。
 */
export function deriveAccountStableID(purpose: 'machine' | 'session', uid: string): string {
  const base = `wb2a:${purpose}:${uid}`
  let out = ''
  for (let i = 0; i < 5; i++) {
    // FNV-1a 32-bit：输入逐字节 + 混合号种子，保证同输入跨次恒定、不同输入充分发散
    let h = (0x811c9dc5 ^ i) >>> 0
    for (let j = 0; j < base.length; j++) {
      h ^= base.charCodeAt(j)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    out += (h >>> 0).toString(16).padStart(8, '0')
  }
  return out.slice(0, 36)
}

/**
 * 解码 WorkBuddy access_token (JWT) 的 uid / enterpriseId / nickname / domain（不验签）。
 */
export function parseJwtClaims(token: string): { uid: string; enterpriseId: string; nickname: string; domain: string } {
  let claims: Record<string, unknown> | null = null
  try {
    const parts = token.split('.')
    if (parts.length >= 2) {
      let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
      while (b64.length % 4) b64 += '='
      claims = JSON.parse(atob(b64))
    }
  } catch { claims = null }
  const out = { uid: '', enterpriseId: '', nickname: '', domain: '' }
  if (!claims || typeof claims !== 'object') return out
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = claims![k]
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim()
    }
    return ''
  }
  out.uid = pick('uid', 'user_id', 'userId', 'sub', 'UserID')
  out.enterpriseId = pick('enterprise_id', 'enterpriseId', 'tenant_id', 'tenantId', 'TenantID', 'EnterpriseID')
  out.nickname = pick('nickname', 'name', 'username', 'nick', 'ScreenName')
  out.domain = pick('domain', 'Domain', 'org', 'tenantDomain')
  return out
}

/**
 * 注入 WorkBuddy/CodeBuddy 官方出站协议头（对齐 workbuddy2api internal/upstream/headers.go）：
 * 1. 归属头（白名单头组）：X-Agent-Purpose="conversation", X-IDE-Name="WorkBuddy", X-IDE-Type="WorkBuddy",
 *    X-IDE-Version=<clientVersion>, X-Product="WorkBuddy"
 * 2. 身份标识头：X-User-Id（空则 X-No-User-Id: 1）, X-Enterprise-Id（空则 X-No-Enterprise-Id: 1）
 * 3. 动态领域头：X-Domain（Global 默认为 workbuddy.ai，CN 有则填，无则 X-No-Department-Info: 1）
 * 4. 设备风控头：X-Device-Token（accountTokenState.device_token || cfg.deviceToken）
 * 5. 风控闸门头：X-CodeBuddy-Request: 1（官方客户端所有 API 必带，对齐 D1）
 * 6. 出站 UA 三段式（平台段按 realm 切，global 送错会触发 403/11140）
 * 7. Accept-Language 按 realm 切（cn zh-CN / global en-US，对齐 D5）
 * 8. Accept 分流：仅 chat 路径（opts.chatPath 非 false）覆盖为 event-stream 形式（对齐 D6）
 * 9. 会话头族（opts.chatMeta 提供时注入，对齐 workbuddy2api injectConversationHeaders）
 * 10. 安全红线：绝不在 chat 请求携带 X-Refresh-Token
 *
 * opts.chatPath：本函数虽名 ChatHeaders，但在本仓也被带任意 subPath 的转发路径调用；
 * 仅当确为 chat/completions 时才覆盖 Accept（非 chat 路径保持 buildOauthHeaders 的
 * application/json），避免给 models 等路径发错误的 Accept。缺省 true（绝大多数调用是 chat）。
 * opts.chatMeta：会话头族元数据（轮转循环外生成一次，循环内复用）。
 */
export function injectWorkbuddyChatHeaders(
  headers: Record<string, string>,
  token: string,
  realm: 'cn' | 'global',
  accountTokenState?: { uid?: string; enterprise_id?: string; domain?: string; device_token?: string },
  cfg?: { deviceToken?: string; extraHeaders?: Record<string, string> },
  opts?: { chatPath?: boolean; chatMeta?: ChatMeta }
): void {
  headers['X-Agent-Purpose'] = 'conversation'
  headers['X-IDE-Name'] = 'WorkBuddy'
  headers['X-IDE-Type'] = 'WorkBuddy'
  headers['X-IDE-Version'] = WORKBUDDY_CLIENT_VERSION
  headers['X-Product'] = 'WorkBuddy'

  // 风控闸门头（D1）：官方客户端所有 API 请求必带，缺失可能被上游误判为非官方客户端。
  headers['X-CodeBuddy-Request'] = '1'
  // 出站 UA：三段式 + 平台段按 realm 切（global 送错平台段可触发 403 code 11140）
  headers['User-Agent'] = buildWorkbuddyUserAgent(realm)
  // Accept-Language 按 realm 切（D5）
  headers['Accept-Language'] = workbuddyAcceptLanguage(realm)
  // XMLHttpRequest 标识：官方桌面端所有 API 请求均带（对齐 workbuddy2api CommonHeaders）
  headers['X-Requested-With'] = 'XMLHttpRequest'
  // Accept 分流（D6）：chat 路径声明可接受 event-stream（上游被强制流式，必回 SSE）
  if (opts?.chatPath !== false) {
    headers['Accept'] = workbuddyChatAccept()
  }

  const claims = parseJwtClaims(token)
  const uid = accountTokenState?.uid || claims.uid
  if (uid) {
    headers['X-User-Id'] = uid
    delete headers['X-No-User-Id']
    // 账号稳定的机器/会话 ID 头（对齐 workbuddy2api 3b87c14e / X-Machine-ID / X-Session-ID）：
    // 同账号跨重启/跨请求恒同值，供上游把全部出站请求归一为同一"机器指纹"。
    // 缺失或每次漂移（随机/空）会被全球域风控判定为可疑客户端形态，放大限流（见 429 排查）。
    // 仅在 uid 存在时注入；uid 缺失无稳定指纹源头，不注入也不 panic。
    headers['X-Machine-ID'] = deriveAccountStableID('machine', uid)
    headers['X-Session-ID'] = deriveAccountStableID('session', uid)
  } else {
    headers['X-No-User-Id'] = '1'
    delete headers['X-Machine-ID']
    delete headers['X-Session-ID']
  }

  const entId = accountTokenState?.enterprise_id || claims.enterpriseId
  // global 账号统一声明无企业（对齐 workbuddy2api injectGlobalChatHeaders）：
  // 官方国际版客户端发 X-No-Enterprise-Id=1，且不回退到登录会话的 X-Enterprise-Id。
  if (realm === 'global') {
    headers['X-No-Enterprise-Id'] = '1'
    delete headers['X-Enterprise-Id']
    delete headers['X-Tenant-Id']
  } else if (entId) {
    headers['X-Enterprise-Id'] = entId
    delete headers['X-No-Enterprise-Id']
  } else {
    headers['X-No-Enterprise-Id'] = '1'
  }

  // X-Domain：global 固定 www.workbuddy.ai（不回退登录会话原值）；CN 有则透传，无则声明缺失。
  let domain = realm === 'global' ? 'workbuddy.ai' : (accountTokenState?.domain || claims.domain)
  if (domain) {
    headers['X-Domain'] = domain
    delete headers['X-No-Department-Info']
  } else {
    headers['X-No-Department-Info'] = '1'
  }

  const devToken = accountTokenState?.device_token || cfg?.deviceToken
  if (devToken) {
    headers['X-Device-Token'] = devToken
  }

  // 会话头族（issue #35）：聚合主键 + 消息级 ID + B3 链路族。
  // 仅在 chat 路径注入（非 chat 请求无"对话轮"语义）。
  if (opts?.chatMeta && opts.chatPath !== false) {
    injectConversationHeaders(headers, opts.chatMeta)
  }

  delete headers['X-Refresh-Token']
}

