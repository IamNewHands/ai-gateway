/**
 * 会话候选键提取（移植自 M365-2api session-resolver.ts:53-96, 184-266，2026-09-06）。
 * 扩展 A 的显式会话识别链：在 X-M365-Session-Id / m365_session_id 之外，
 * 接纳 prompt_cache_key、九种常见 header、metadata.*、URL query 与"会话根指纹"。
 * 纯函数、零副作用；根指纹先经 normalizeInstructionText 剥离 IDE（Cline/Cursor/Roo）
 * 注入的动态日期时间噪声，否则跨轮指纹必然失配。
 */
import { contentToString, type OaiMsgLite } from './tools'

/** 剥离 IDE agent 注入的动态 current date/time 噪声，保留确定性指令文本 */
export function normalizeInstructionText(text: string): string {
  return text
    .replace(/(?:current\s*(?:time|date)|today(?:'s)?\s*date)[:\s]+[^\n]+/gi, '')
    .replace(/\b\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, '')
    .trim()
}

/**
 * 会话根指纹：system/developer 指令 + 首条 user 消息在多轮对话中自 turn 1 到 turn N 不变，
 * 可作稳定的候选会话键（同 C rootConversationFingerprint）。
 */
export function rootConversationFingerprint(messages: OaiMsgLite[] | unknown): string {
  if (!Array.isArray(messages) || messages.length === 0) return ''
  const parts: string[] = []
  let foundUser = false
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue
    const m = msg as OaiMsgLite
    const role = String(m.role || '').toLowerCase()
    if (role === 'system' || role === 'developer') {
      const text = normalizeInstructionText(contentToString(m.content).trim())
      if (text) parts.push(`${role}:${text}`)
    } else if (role === 'user') {
      parts.push(`user:${contentToString(m.content).trim()}`)
      foundUser = true
      break
    } else {
      break
    }
  }
  if (!foundUser && parts.length === 0) {
    const first = messages[0] as OaiMsgLite | undefined
    if (first && typeof first === 'object') {
      const role = String(first.role || 'unknown').toLowerCase()
      return `${role}:${contentToString(first.content).trim()}`
    }
  }
  return parts.join('||')
}

/** 边界归一化：仅接受非空字符串（≤1024），非字符串不抛错直接忽略（A 风格：宽松收集，后续仍有校验） */
export function optionalSessionIdentifier(value: unknown): string {
  if (typeof value !== 'string') return ''
  const candidate = value.trim()
  if (candidate === '' || candidate.length > 1024) return ''
  return candidate
}

/**
 * 请求体侧的显式会话候选链（header/query 由调用点配合 Request 使用 stableSessionCandidate）。
 * 顺序即优先级：body 显式字段 → metadata.* → 根指纹（可被 user 前缀隔离）。
 */
export function stableSessionCandidateBody(body: Record<string, unknown>): string {
  const bodyCandidates: unknown[] = [
    body['m365_session_id'],
    body['session_id'],
    body['session_key'],
    body['conversation_id'],
    body['chat_id'],
    body['prompt_cache_key'],
  ]
  const metadata = body['metadata']
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const meta = metadata as Record<string, unknown>
    bodyCandidates.push(meta['session_id'], meta['conversation_id'], meta['chat_id'], meta['thread_id'], meta['user_id'], meta['prompt_cache_key'])
  }
  for (const c of bodyCandidates) {
    const id = optionalSessionIdentifier(c)
    if (id) return id
  }
  const rootFp = rootConversationFingerprint(body['messages'])
  if (rootFp) {
    const user = optionalSessionIdentifier(body['user'])
    return user ? `${user}::${rootFp}` : rootFp
  }
  return ''
}

/**
 * 仅取"客户端真实显式"的会话 ID（body 显式字段 + metadata），**不含**内容推导的根指纹。
 * 用途：作为互斥租约/DO 分片键时，必须只用客户端明确提供的稳定 id——内容推导的根指纹
 * （system+首条 user）对并发新会话不具区分度：DSH 等客户端首条 user 是通用 openviking/
 * system 注入，不同会话根指纹趋同，若把它当租约键，两个并行新会话会命中同一 DO/同一条
 * m365_sessions 行而互相 lease_conflict（log7 复现的正是该形态）。
 * 会话复用仍由 resolveSession 的 KV 内容前缀/suffix 匹配负责（见 session.ts），
 * 因此去掉根指纹回退不会丢失同一会话的后续粘性——只在"无真实显式 id"时交给内容匹配。
 */
export function explicitSessionIdFromBody(body: Record<string, unknown>): string {
  const bodyCandidates: unknown[] = [
    body['m365_session_id'],
    body['session_id'],
    body['session_key'],
    body['conversation_id'],
    body['chat_id'],
    body['prompt_cache_key'],
  ]
  const metadata = body['metadata']
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const meta = metadata as Record<string, unknown>
    bodyCandidates.push(meta['session_id'], meta['conversation_id'], meta['chat_id'], meta['thread_id'], meta['user_id'], meta['prompt_cache_key'])
  }
  for (const c of bodyCandidates) {
    const id = optionalSessionIdentifier(c)
    if (id) return id
  }
  return ''
}

/** 请求头侧候选链（顺序即优先级；调用点在 A 自有 header 之后拼接） */
export const SESSION_CANDIDATE_HEADERS = [
  'X-Session-Key',
  'X-Session-Id',
  'Session-Id',
  'X-Conversation-Id',
  'Conversation-Id',
  'X-Chat-Id',
  'Chat-Id',
  'X-Prompt-Cache-Key',
  'Prompt-Cache-Key',
] as const

/** URL query 候选链 */
export const SESSION_CANDIDATE_QUERY = [
  'session_key',
  'session_id',
  'conversation_id',
  'chat_id',
  'prompt_cache_key',
] as const

/** 从 Request（header + url query）收集显式会话候选；A 自有 header 优先级最高由调用点保证 */
export function sessionCandidateFromRequest(request: Request): string {
  for (const h of SESSION_CANDIDATE_HEADERS) {
    const id = optionalSessionIdentifier(request.headers.get(h))
    if (id) return id
  }
  try {
    const url = new URL(request.url)
    for (const q of SESSION_CANDIDATE_QUERY) {
      const id = optionalSessionIdentifier(url.searchParams.get(q))
      if (id) return id
    }
  } catch { /* ignore malformed url */ }
  return ''
}
