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
  constructor(status: number, upstreamText: string) {
    super(`upstream client error ${status}: ${upstreamText || 'bad request'}`)
    this.name = 'WorkbuddyClientError'
    this.status = status
    this.upstreamText = upstreamText
  }
}

/**
 * 提取并格式化上游 4xx 客户端错误的提示文案（优先提取业务 msg/message/code）。
 */
export function formatWorkbuddyClientErrorMessage(status: number, upstreamText: string): { message: string; code?: unknown } {
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

/**
 * 判断是否为模型级 429 限流（业务 code 6004，对齐 workbuddy2api IsModelRateLimit）。
 * 用于区分"账号级软限流"与"该模型用量限流"（其他模型依然可用）。
 */
export function isModelRateLimit(bodyText: string): boolean {
  return /"code"\s*:\s*"?6004"?/.test(bodyText)
}

/**
 * 从 429 6004 body 解析「将在 … 重置」时间（上游 UTC+8 文案，对齐 workbuddy2api ParseSoftRateReset）。
 * 成功返回 epoch ms 墙钟时刻，解析失败或非 6004 返回 null。
 */
export function parseSoftRateReset(bodyText: string): number | null {
  if (!isModelRateLimit(bodyText)) return null
  const m = bodyText.match(/将在\s*([\d\-:\s]+)(?:\s*UTC\+8)?\s*重置/)
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
 * 402 → 余额关键词 → session 死亡关键词 → **账号级故障（11140/14017）** → 6004 模型限流
 * → 429 软限流 → 404 → 5xx → 内容策略拦截 → 11101 参数错 → 其他 4xx。
 * 关键词优先于状态码：上游偶发把业务错误包在 5xx 里时，按真实原因分类。
 *
 * 判定顺序的语义依据（对齐源实现 client.go:235-256 的注释）：
 *  - 402 / 余额关键词最严、最不可自愈（只能等签到恢复），必须最先判；
 *  - session_dead 是需要人工重登的终态，且其 marker（12153 等）比限流层的大范围子串更具体；
 *  - **account_fault 必须先于 429 兜底**：14017 常带 HTTP 429，若落到 `status === 429`
 *    会被误归 soft_rate——限流可指数退避等自愈，账号级故障等不来，语义完全不符。
 *    11140 的"模型级限流"变体（rate-limiting 文案）因 marker 不含 `request illegal`
 *    而天然不命中本层，会继续落到 model_rate / soft_rate，行为不受影响。
 */
export function classifyWorkbuddyUpstreamError(status: number, bodyText: string): WorkbuddyErrorKind {
  if (status === 402) return 'hard_credit'
  const lower = bodyText.toLowerCase()
  for (const m of HARD_MARKERS) {
    if (lower.includes(m.toLowerCase()) || bodyText.includes(m)) return 'hard_credit'
  }
  for (const m of SESSION_DEAD_MARKERS) {
    if (bodyText.includes(m)) return 'session_dead'
  }
  for (const m of ACCOUNT_FAULT_MARKERS) {
    if (lower.includes(m) || bodyText.includes(m)) return 'account_fault'
  }
  if (isModelRateLimit(bodyText)) return 'model_rate'
  // 11102「该后端无此模型」/ "service info not found"：确定性"模型在后端不存在"（移植
  // workbuddy2api IsModelBlocked）。只认 code==11102 或窄短语，且仅 400/404——
  // 避免 11102 恰好撞在 body 的 requestId 字段（整段文本）被误判。
  if ((status === 400 || status === 404) &&
    (/"code"\s*:\s*"?11102"?/.test(bodyText) || lower.includes('service info not found'))) {
    return 'model_blocked'
  }
  if (status === 429) return 'soft_rate'
  if (status === 404) return 'not_found'
  if (status >= 500) return 'server'
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
 * 为出站 WorkBuddy 请求体注入默认 max_tokens 护栏（防上游失控或死循环无限消耗算力/额度）。
 * 规则：
 *  - 若客户端已显式提供有效数字 max_tokens 或 max_completion_tokens（> 0）→ 原样保留，尊重调用方意图；
 *  - 若未提供或为非正数/无效值 → 注入 WORKBUDDY_DEFAULT_MAX_TOKENS。
 */
export function ensureWorkbuddyMaxTokens(body: Record<string, unknown>, defaultTokens = WORKBUDDY_DEFAULT_MAX_TOKENS): void {
  const mt = body['max_tokens']
  const mct = body['max_completion_tokens']
  const hasValidMt = typeof mt === 'number' && Number.isFinite(mt) && mt > 0
  const hasValidMct = typeof mct === 'number' && Number.isFinite(mct) && mct > 0
  if (hasValidMt || hasValidMct) return
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
 * DeepSeek 多轮一致性回填（对齐 workbuddy2api thinking.go backfillReasoningContent）：
 * 官方客户端规则 requiresReasoningContentOnAssistantMessages：
 * 若会话内任一 assistant 消息含有 reasoning 痕迹（非空 reasoning 字符串或已有 reasoning_content），
 * 上游要求后续请求中所有 assistant 消息都带 reasoning_content（string，无则补空串 ""），
 * 否则直接以 HTTP 400 拒绝请求。
 */
export function backfillReasoningContent(body: Record<string, unknown>): void {
  const model = typeof body['model'] === 'string' ? body['model'] : ''
  if (!isDeepSeekModel(model)) return

  const msgs = body['messages']
  if (!Array.isArray(msgs) || msgs.length === 0) return

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
  if (!hasTrace) return

  // 第二遍：为所有 assistant 补齐 reasoning_content 字段
  for (const item of msgs) {
    if (!item || typeof item !== 'object') continue
    const m = item as Record<string, unknown>
    if (m['role'] !== 'assistant') continue
    if (m['reasoning_content'] !== undefined) continue // 已有不覆盖
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

/** 是否命中任一特征（快速路径）。 */
function hasSanitizeFingerprint(text: string): boolean {
  for (const f of SANITIZE_FEATURES) {
    if (text.includes(f)) return true
  }
  // header 键名有大小写变体，快速路径漏掉时再落正则兜底
  SANITIZE_HDR_RE.lastIndex = 0
  return SANITIZE_HDR_RE.test(text)
}

/**
 * 单段文本净化（对齐 workbuddy2api sanitizeText）。
 * 顺序：**先改写、后剥离、最后 trim**。
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
 * 出站请求体的**指纹脱敏**（移植 workbuddy2api sanitizeMessages）。
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

// ===== global 模型目录动态探测解析（移植 workbuddy2api global_models.go） =====

/** global 模型目录探测路径候选（对齐 workbuddy2api globalModelsProbePaths）：
 *  /v2 家族优先（PR #20 实测 /v2/enterprises/personal/models 200 含完整模型表），
 *  /console 作 fallback（同域旧路径）。 */
export const WORKBUDDY_GLOBAL_MODELS_PROBE_PATHS = [
  '/v2/enterprises/personal/models',
  '/console/enterprises/personal/models',
]

/** 解析出的单条 global 模型条目（id/展示名 + reasoning 档位桶，仅元数据无倍率）。 */
export interface WorkbuddyGlobalModelEntry {
  id: string
  displayName?: string
  supportedEfforts?: string[]
  defaultEffort?: string
}

/**
 * 解析 global 模型目录响应（对齐 workbuddy2api parseGlobalModelNames）：
 *  - 窄表形态：data 为字符串数组 → 每项即模型 id；
 *  - 对象形态：data.models[].id/.name（id 优先），disabled 剔除，附带解析
 *    reasoning.supportedEfforts（数组优先）/ effort（单档视作单元素表）/ defaultEffort。
 * 解析失败 / 空名单 → 返回 null（调用方回落静态清单，等价"该端点没给全"）。
 */
export function parseWorkbuddyGlobalModels(raw: string): WorkbuddyGlobalModelEntry[] | null {
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
      if (s !== '') out.push({ id: s })
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
    const entry: WorkbuddyGlobalModelEntry = { id }
    const name = typeof rec['name'] === 'string' ? rec['name'].trim() : ''
    if (name !== '' && name !== id) entry.displayName = name
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

