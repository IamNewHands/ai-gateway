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
 *   3. nextDay4AMMs — 次日 04:00（本地时区）epoch ms，硬冷却目标时刻（对齐 workbuddy2api CooldownUntilTomorrow4AM）。
 */

// ===== 错误分类 =====

/** 上游错误分类（对齐 workbuddy2api ErrKind）。 */
export type WorkbuddyErrorKind =
  | 'hard_credit'   // 余额/权益耗尽 → 长冷却（次日 04:00）
  | 'soft_rate'     // 429 限流 → 短冷却
  | 'session_dead'  // session 失效 → 永久禁用
  | 'not_found'     // 404 上游偶发 → 短冷却，不累计错误
  | 'server'        // 5xx → 累计错误计数
  | 'client'        // 其他 4xx → 不处罚，仅换号

/**
 * 余额不足关键词（小写比较 + 原文比较双通道，对齐 workbuddy2api hardMarkers）。
 * 另保留本仓既有的 '1005'（CodeBuddy plan 权益业务码）与 'plan' 宽匹配，
 * 避免收窄既有检测面（既有实现对响应体含 'plan' 即长冷却）。
 */
const HARD_MARKERS = [
  'insufficient credit', 'no credit', 'credit exhausted', 'out of credit',
  'quota exceeded', 'quota exhaust', 'payment required', 'credit not enough',
  'not enough credit',
  '积分不足', '额度不足', '余额不足', '积分用完', '额度用尽', '没有积分',
  // 本仓既有检测（保持行为兼容）：
  '1005', 'plan',
]

/** session 失效关键词（对齐 workbuddy2api sessionDeadMarkers）。 */
const SESSION_DEAD_MARKERS = ['Offline user session not found', '12153']

/**
 * 按 HTTP 状态码 + 响应体判定错误类别（对齐 workbuddy2api Classify 的判定顺序）：
 * 402 → 余额关键词 → session 死亡关键词 → 429 → 404 → 5xx → 其他 4xx。
 * 关键词优先于状态码：上游偶发把业务错误包在 5xx 里时，按真实原因分类。
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
  if (status === 429) return 'soft_rate'
  if (status === 404) return 'not_found'
  if (status >= 500) return 'server'
  if (status >= 400) return 'client'
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

/**
 * 次日 04:00（本地时区，Workers 上为 UTC）的 epoch ms。
 * Date 构造器对日溢出自动进位（月末→下月 1 号、年末→下年 1 号），
 * 天然覆盖跨日/跨月/跨年（对齐 workbuddy2api nextDay4AM 的 time.Date 行为）。
 */
export function nextDay4AMMs(from: number = Date.now()): number {
  const d = new Date(from)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 4, 0, 0, 0).getTime()
}
