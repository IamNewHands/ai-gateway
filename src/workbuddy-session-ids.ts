/**
 * workbuddy-session-ids.ts — WorkBuddy 出站**会话头族** ID 的解析与生成
 * （移植 workbuddy2api internal/session/ids.go + headers.go 的 injectConversationHeaders）。
 *
 * 背景（workbuddy2api issue #35）：官方 CodeBuddy 客户端出站携带一组会话头
 * （X-Conversation-ID / X-Conversation-Request-ID / X-Request-ID / X-B3-*），
 * 上游后台按 `X-Conversation-Request-ID`（**对话轮级**）聚合请求：一次用户发送内的
 * 所有 tool call / 重试 / 换号复用同一个 ID，用量明细里聚成一条。
 *
 * 网关此前**一个都不发**，上游按 HTTP 请求逐条记账 → 同一对话几十上百条独立记录，
 * 既无法统计单轮真实成本，也无法与成本账本（recordOauthModelCost）对齐。
 *
 * 头族分四层（对齐 headers.go:236-275 的注释）：
 *  - `X-Conversation-ID`：会话级，多轮稳定（body 的 conversationId）。**空则不发**——
 *    透传客户端原值优先，客户端没给就不伪造，避免误导后台建错会话；
 *  - `X-Conversation-Request-ID`：**对话轮级聚合主键，必发**。一次 user send 内的所有
 *    tool call / 重试 / 换号 / 降级复用同一个 → 后台按它聚合成一条；
 *  - `X-Conversation-Message-ID` = `X-Request-ID`：消息级，每条独立（32 位 hex）；
 *  - `X-Root-Request-ID` = conversationRequestID；`X-Trace-ID`：入站透传或回落聚合主键；
 *  - `X-B3-TraceId` / `X-B3-SpanId` / `X-B3-Sampled`：链路族。B3 规范只认 16/32 hex，
 *    入站 conversationRequestID 非法时 TraceId 回落 messageID（恒 32 hex）。
 */

/** 生成 32 位小写 hex 的消息级 ID（对齐 workbuddy2api NewMessageID：UUID v4 去横线形态）。 */
export function newMessageId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/** B3 规范合法性：TraceId 必须是 16 或 32 位 hex（对齐 workbuddy2api validTraceID）。 */
export function isValidB3TraceId(s: string): boolean {
  if (s.length !== 16 && s.length !== 32) return false
  return /^[0-9a-fA-F]+$/.test(s)
}

/**
 * 从请求体提取**会话头族**的 conversationId（对齐 workbuddy2api ResolveConversationID）。
 *
 * 识别顺序（snake 优先于 camel）：`metadata.conversation_id` → `metadata.conversationId`
 * → 顶层 `conversation_id` → 顶层 `conversationId`。
 *
 * 与「会话粘性键」的差异：**只认 conversationId，绝不回落 `user_id`**——
 * X-Conversation-ID 的语义是"对话 ID"，回落 user_id 会把同一用户的所有对话并成一个，
 * 污染后台按对话聚合的判据。缺失返回 ''（不伪造）。
 */
export function resolveConversationId(body: Record<string, unknown> | null | undefined): string {
  if (!body || typeof body !== 'object') return ''
  const meta = body['metadata']
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    const m = meta as Record<string, unknown>
    const snake = m['conversation_id']
    if (typeof snake === 'string' && snake !== '') return snake
    const camel = m['conversationId']
    if (typeof camel === 'string' && camel !== '') return camel
  }
  const snake = body['conversation_id']
  if (typeof snake === 'string' && snake !== '') return snake
  const camel = body['conversationId']
  if (typeof camel === 'string' && camel !== '') return camel
  return ''
}

/**
 * 从消息 content 提取文本（对齐 workbuddy2api contentText）：
 *  - 字符串 → 原样返回；
 *  - 数组（多模态 parts）→ 拼接各 part 的 `text` 字段；
 *  - 其他（null / 未知形态 / 纯图片）→ ''。
 */
export function contentText(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) {
    let out = ''
    for (const part of raw) {
      if (part && typeof part === 'object' && !Array.isArray(part)) {
        const t = (part as Record<string, unknown>)['text']
        if (typeof t === 'string') out += t
      }
    }
    return out
  }
  return ''
}

/**
 * 派生「对话轮级」聚合键（对齐 workbuddy2api TurnKey）：body 里**最后一条**
 * `role === 'user'` 消息的 `"u<序号>:<文本>"`。
 *
 * 为什么需要它：无会话键的客户端（OpenAI 兼容协议——dsh / Codex / Cherry Studio 等
 * 请求体里既无 conversationId 也无 metadata 键）会让会话键恒为空，聚合主键便只能
 * 逐请求新生成，多轮在上游用量明细里仍是一条请求一条记录。本函数给这类客户端一个
 * **不依赖客户端配合**的轮级键：一次用户发送内的所有上游调用（tool call 多轮 /
 * 换号重试 / 降级重发）body 里最后一条 user 消息恒定 → 同键；用户发下一条消息 → 换键。
 *
 * 为什么不取第一条：首条在整个会话内不变，会把一次会话的所有轮并进同一个聚合键
 * （跨对话轮混并）。取最后一条才对齐官方 X-Conversation-Request-ID 的「对话轮」语义。
 * 序号一并入键：两次不同轮里内容相同的提问（"继续"）不会被并成一轮。
 *
 * 最后一条 user 无文本（纯图片）→ ''，**不继续往前找**（往前找会让键随 step 漂移）。
 */
export function turnKey(body: Record<string, unknown> | null | undefined): string {
  if (!body || typeof body !== 'object') return ''
  const msgs = body['messages']
  if (!Array.isArray(msgs) || msgs.length === 0) return ''
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (!m || typeof m !== 'object' || Array.isArray(m)) continue
    const rec = m as Record<string, unknown>
    if (rec['role'] !== 'user') continue
    const text = contentText(rec['content'])
    if (text === '') return ''
    return `u${i}:${text}`
  }
  return ''
}

/**
 * 轮级派生盐：惰性初始化（首次调用时生成）。
 * 严禁在模块顶层（全局作用域）直接调用 newMessageId() / crypto.getRandomValues()，
 * 否则触发 Cloudflare Workers 10021 校验错误（Disallowed operation called within global scope）。
 */
let turnSalt: string | null = null

function getTurnSalt(): string {
  if (!turnSalt) turnSalt = newMessageId()
  return turnSalt
}

/** 仅供测试：清空轮级派生盐（供验证惰性初始化）。 */
export function __resetTurnSaltForTests(): void {
  turnSalt = null
}

/**
 * 会话级聚合主键缓存：会话键 → conversationRequestID。
 *
 * 语义（对齐 workbuddy2api ids.go:60-82 RequestIDForKey）：
 *  - 同 key：首次生成并缓存，此后恒返回同值（一次 user send / 同会话多轮聚合）；
 *  - 异 key：各自独立；
 *  - 空 key：每次生成新值（无会话则无"会话内稳定"语义）。
 *
 * 注意 Workers 的多 isolate 现实：模块级 Map 不跨 isolate 共享，故同一会话在
 * 不同 isolate 上可能得到不同 ID。这比"完全不发"仍好得多（isolate 内多轮已聚合），
 * 且不引入外部存储成本。若要严格全局一致需落 Durable Object。
 */
const requestIds = new Map<string, string>()

/** 仅供测试：清空会话级 ID 缓存。 */
export function __resetSessionIdsForTests(): void {
  requestIds.clear()
}

/** 返回会话键的稳定 conversationRequestID（32 hex）。 */
export function requestIdForKey(key: string): string {
  if (!key) return newMessageId()
  const hit = requestIds.get(key)
  if (hit) return hit
  const id = newMessageId()
  requestIds.set(key, id)
  return id
}

/**
 * 轮级聚合 ID（对齐 workbuddy2api TurnRequestID）：`sha256(盐|轮键)` 前 16 字节 hex。
 *
 * 纯派生、无缓存、无 TTL —— 与会话级的 requestIdForKey 相反：会话键数量有限
 * （与粘性会话同源）可以常驻缓存，而轮级键每个对话轮新增一条，缓存必须有界，
 * 派生式天然有界。空键返回新随机值（无轮可聚合时保持"每请求独立"行为）。
 *
 * 注意：本函数**同步返回 Promise**（WebCrypto 的 digest 是异步的），
 * 调用方需 await。为保持 API 简洁，空键分支也返回 Promise。
 */
export async function turnRequestId(turnKeyValue: string): Promise<string> {
  if (!turnKeyValue) return newMessageId()
  const data = new TextEncoder().encode(`${getTurnSalt()}|${turnKeyValue}`)
  const digest = await crypto.subtle.digest('SHA-256', data)
  const bytes = new Uint8Array(digest).slice(0, 16)
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/**
 * 从请求体提取**会话粘性键**（对齐 workbuddy2api session.ExtractKey，含 `ebd7921`、`8058019`）。
 *
 * 识别顺序（snake 优先于 camel，前四项为**对话维度**）：
 *  1. `metadata.conversation_id`
 *  2. `metadata.conversationId`
 *  3. 顶层 `conversation_id`
 *  4. 顶层 `conversationId`
 *  5. 顶层 `prompt_cache_key`（`8058019` 新增，置于最后，绝不抢占 conversation 维度优先级）：
 *     pi-ai 系客户端把会话 ID 放在这个 OpenAI 前缀缓存字段里，语义就是「同一会话复用
 *     同一前缀」，与粘性诉求同源。纳入后这类客户端无需改配置即可命中粘性。
 *
 * `metadata.user_id` **不再**作为粘性键（移植 `ebd7921`）：user 维度粒度过粗——一个
 * user 的全部并行对话会被钉到同一账号（粘性范围远大于上游 prompt cache 的对话级边界），
 * 且它原本排在顶层 `conversation_id` **之前**，会抢占真正的对话键。剔除后只发 user_id
 * 的客户端回落加权轮换（与无标识客户端同路径），旧 user_id 绑定靠粘性 TTL 自然过期。
 * 这也与 `resolveConversationId`（绝不回落 user_id）的口径重新统一。
 *
 * 解析失败 / 空 body → ''（绝不抛错）。
 */
export function extractSessionKey(body: Record<string, unknown> | null | undefined): string {
  if (!body || typeof body !== 'object') return ''
  const meta = body['metadata']
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    const m = meta as Record<string, unknown>
    for (const k of ['conversation_id', 'conversationId']) {
      const v = m[k]
      if (typeof v === 'string' && v !== '') return v
    }
  }
  for (const k of ['conversation_id', 'conversationId']) {
    const v = body[k]
    if (typeof v === 'string' && v !== '') return v
  }
  const pck = body['prompt_cache_key']
  if (typeof pck === 'string' && pck !== '') return pck
  return ''
}

/**
 * 为**无会话标识**的客户端派生会话级稳定粘性键（对齐 workbuddy2api `8058019`+`10eefa8`
 * StickyFallbackKey）。
 *
 * 背景：OpenAI 兼容协议本身没有会话 ID 字段——dsh / Codex / Cherry Studio 等客户端的
 * 请求体里既无 conversationId 也无 metadata，extractSessionKey 恒返回 '' → 粘性路由
 * 永不参与 → 同一会话的连续请求逐请求换号，上游 prompt cache 被打散。本函数给这类
 * 客户端一个不依赖其配合的键：body 里**首条** role==='user' 消息文本的 sha256 前 16
 * 字节 hex（前缀 `fb:`）。
 *
 * 为什么取首条：会话内历史不断追加，但首条 user 消息恒定 → 同会话恒同键；开新会话
 * 自然换键。与 turnKey 取**最后一条**（**轮级**，供会话头族按对话轮聚合）不可混用。
 *
 * 抑制条件（`10eefa8`，P1-anti-monopoly 契约在 fallback 路径的延伸）：body 携带
 * `metadata.user_id` 或顶层 `user_id` 时**恒返回 ''**——extractSessionKey 有意剔除
 * user_id 作粘性键，若 fallback 不设闸，只发 user_id 的请求会借首条 prompt 重新获得
 * 粘性，多个并行对话因首条 prompt 相同被钉到同一账号。判定口径与 extractSessionKey
 * 一致（字段存在且为非空字符串才算标识；非字符串/空串不抑制）。
 *
 * 无 body / 无 messages / 无 user 消息 / 首条 user 消息无文本（纯图片）→ ''。
 * **WebCrypto 的 digest 是异步的** → 本函数同步返回 Promise，调用方需 await。
 */
export async function stickyFallbackKey(body: Record<string, unknown> | null | undefined): Promise<string> {
  if (hasUserID(body)) return ''
  if (!body || typeof body !== 'object') return ''
  const msgs = body['messages']
  if (!Array.isArray(msgs) || msgs.length === 0) return ''
  for (const m of msgs) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) continue
    const rec = m as Record<string, unknown>
    if (rec['role'] !== 'user') continue
    // 首条 user 消息无文本（纯图片/多模态无文字等）→ 不继续往后找：往后找会让键随
    // 会话推进而漂移（一旦某轮该位置带上文本），破坏「同会话恒同键」。
    const text = contentText(rec['content']).trim()
    if (text === '') return ''
    const data = new TextEncoder().encode(text)
    const digest = await crypto.subtle.digest('SHA-256', data)
    const bytes = new Uint8Array(digest).slice(0, 16)
    let out = ''
    for (const b of bytes) out += b.toString(16).padStart(2, '0')
    return `fb:${out}`
  }
  return ''
}

/**
 * 报告 body 是否携带 user 维度标识（`metadata.user_id` 或顶层 `user_id`）。
 * 只判「字段存在且为非空字符串」，与 extractSessionKey 的口径一致。
 */
function hasUserID(body: Record<string, unknown> | null | undefined): boolean {
  if (!body || typeof body !== 'object') return false
  const meta = body['metadata']
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    const v = (meta as Record<string, unknown>)['user_id']
    if (typeof v === 'string' && v !== '') return true
  }
  const top = body['user_id']
  return typeof top === 'string' && top !== ''
}

/** 会话头族元数据（对齐 workbuddy2api upstream.ChatMeta）。 */
export interface ChatMeta {
  /** X-Conversation-ID：body 提取的入站值，空则不发（透传优先，不伪造） */
  conversationId: string
  /** X-Conversation-Request-ID / X-Root-Request-ID：聚合主键，必发 */
  conversationRequestId: string
  /** X-Trace-ID：入站透传值，空则回落 conversationRequestId */
  traceId?: string
}

/**
 * 在**轮转循环外**生成会话头族元数据（对齐 workbuddy2api handler.go:475-485 的三级回退）。
 *
 * conversationRequestId 三级回退：
 *  1. 入站 `X-Conversation-Request-ID` 头透传优先（客户端已有自己的对话轮 ID 则以客户端为准）；
 *  2. 会话键非空 → `requestIdForKey(sessKey)`（会话级稳定）；
 *  3. 否则 → `turnRequestId(turnKey)`（轮级派生；无 user 消息时退化为请求级随机 ID）。
 *
 * 调用方须在**改写 body 之前**取 turnKey（改写会动 messages 内容）。
 */
export async function buildChatMeta(opts: {
  body: Record<string, unknown> | null | undefined
  /** 会话粘性键（session.ExtractKey 的等价物）；无则空串 */
  sessionKey?: string
  /** 入站 X-Conversation-Request-ID 头值 */
  inboundConversationRequestId?: string
  /** 入站 X-Trace-ID 头值 */
  inboundTraceId?: string
}): Promise<ChatMeta> {
  const conversationId = resolveConversationId(opts.body)
  let conversationRequestId = ''
  if (opts.inboundConversationRequestId) {
    conversationRequestId = opts.inboundConversationRequestId
  } else if (opts.sessionKey) {
    conversationRequestId = requestIdForKey(opts.sessionKey)
  } else {
    // 无会话键客户端：轮级兜底（同轮内 tool call 多轮 / 换号重试 / 降级重发共享同键）
    conversationRequestId = await turnRequestId(turnKey(opts.body))
  }
  return {
    conversationId,
    conversationRequestId,
    traceId: opts.inboundTraceId || undefined,
  }
}

/**
 * 注入会话头族（对齐 workbuddy2api headers.go:248-275 injectConversationHeaders）。
 *
 * 头名与取值：
 *  | 头 | 值 | 说明 |
 *  |---|---|---|
 *  | X-Conversation-ID | meta.conversationId | 仅非空才发 |
 *  | X-Conversation-Request-ID | conversationRequestId | 必发（空则本级补 32 hex） |
 *  | X-Conversation-Message-ID | messageId | 每次调用新生成 |
 *  | X-Request-ID | messageId | 同上 |
 *  | X-Root-Request-ID | conversationRequestId | 根请求追踪 |
 *  | X-Trace-ID | meta.traceId ?? conversationRequestId | 入站透传优先 |
 *  | X-B3-TraceId | conversationRequestId（非法则回落 messageId） | 16/32 hex |
 *  | X-B3-SpanId | messageId 前 16 位 | 恒 16 hex |
 *  | X-B3-Sampled | "1" | 常量 |
 *
 * 注意：messageID / X-Request-ID / X-B3-SpanId **每次出站都新生成**
 * （与调用次数绑定），而 conversationRequestId 在整个轮转 + 重试周期内恒定。
 */
export function injectConversationHeaders(headers: Record<string, string>, meta: ChatMeta): void {
  const convReqId = meta.conversationRequestId || newMessageId()
  const messageId = newMessageId()

  if (meta.conversationId) headers['X-Conversation-ID'] = meta.conversationId
  headers['X-Conversation-Request-ID'] = convReqId
  headers['X-Conversation-Message-ID'] = messageId
  headers['X-Request-ID'] = messageId
  headers['X-Root-Request-ID'] = convReqId

  const traceId = meta.traceId || convReqId
  headers['X-Trace-ID'] = traceId

  // B3 规范只认 16/32 hex TraceId：非法入站值回落恒 32 hex 的 messageId
  const b3Trace = isValidB3TraceId(convReqId) ? convReqId : messageId
  headers['X-B3-TraceId'] = b3Trace
  headers['X-B3-SpanId'] = messageId.slice(0, 16)
  headers['X-B3-Sampled'] = '1'
}
