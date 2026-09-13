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
  | 'hard_credit'      // 余额/权益耗尽 → 长冷却（次日 04:00）
  | 'soft_rate'        // 429 限流 → 短冷却
  | 'model_rate'       // 429 code 6004 → 模型级限流（切模型立即可用）
  | 'session_dead'     // session 失效 → 连续 3 次才永久禁用
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
  'insufficient credit', 'no credit', 'credit exhausted', 'out of credit',
  'quota exceeded', 'quota exhaust', 'payment required', 'credit not enough',
  'not enough credit',
  '积分不足', '额度不足', '余额不足', '积分用完', '额度用尽', '没有积分',
  // 本仓既有检测（保持行为兼容）：
  '1005', 'plan',
]

/** session 失效关键词（对齐 workbuddy2api sessionDeadMarkers）。 */
const SESSION_DEAD_MARKERS = ['Offline user session not found', '12153']

/** 内容策略拦截关键词（对齐 workbuddy2api contentBlockedMarkers）。 */
const CONTENT_BLOCKED_MARKERS = [
  'blocked by security policy',
  'unapproved channel',
  'illegal api invocation',
]

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
 * 402 → 余额关键词 → session 死亡关键词 → 6004 模型限流 → 429 软限流 → 404 → 5xx → 内容策略拦截 → 11101 参数错 → 其他 4xx。
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
  if (isModelRateLimit(bodyText)) return 'model_rate'
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

/**
 * 次日 04:00（本地时区，Workers 上为 UTC）的 epoch ms。
 * Date 构造器对日溢出自动进位（月末→下月 1 号、年末→下年 1 号），
 * 天然覆盖跨日/跨月/跨年（对齐 workbuddy2api nextDay4AM 的 time.Date 行为）。
 */
export function nextDay4AMMs(from: number = Date.now()): number {
  const d = new Date(from)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 4, 0, 0, 0).getTime()
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

// ===== 协议归属头与身份头注入 =====

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
 * 1. 归属头（白名单头组）：X-Agent-Purpose="conversation", X-IDE-Name="WorkBuddy", X-IDE-Type="WorkBuddy", X-IDE-Version="2.63.2", X-Product="WorkBuddy"
 * 2. 身份标识头：X-User-Id（空则 X-No-User-Id: 1）, X-Enterprise-Id（空则 X-No-Enterprise-Id: 1）
 * 3. 动态领域头：X-Domain（Global 默认为 workbuddy.ai，CN 有则填，无则 X-No-Department-Info: 1）
 * 4. 设备风控头：X-Device-Token（accountTokenState.device_token || cfg.deviceToken）
 * 5. 安全红线：绝不在 chat 请求携带 X-Refresh-Token
 */
export function injectWorkbuddyChatHeaders(
  headers: Record<string, string>,
  token: string,
  realm: 'cn' | 'global',
  accountTokenState?: { uid?: string; enterprise_id?: string; domain?: string; device_token?: string },
  cfg?: { deviceToken?: string; extraHeaders?: Record<string, string> }
): void {
  headers['X-Agent-Purpose'] = 'conversation'
  headers['X-IDE-Name'] = 'WorkBuddy'
  headers['X-IDE-Type'] = 'WorkBuddy'
  headers['X-IDE-Version'] = '2.63.2'
  headers['X-Product'] = 'WorkBuddy'

  const claims = parseJwtClaims(token)
  const uid = accountTokenState?.uid || claims.uid
  if (uid) {
    headers['X-User-Id'] = uid
    delete headers['X-No-User-Id']
  } else {
    headers['X-No-User-Id'] = '1'
  }

  const entId = accountTokenState?.enterprise_id || claims.enterpriseId
  if (entId) {
    headers['X-Enterprise-Id'] = entId
    delete headers['X-No-Enterprise-Id']
  } else {
    headers['X-No-Enterprise-Id'] = '1'
  }

  let domain = accountTokenState?.domain || claims.domain
  if (!domain && realm === 'global') {
    domain = 'workbuddy.ai'
  }
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

  delete headers['X-Refresh-Token']
}

