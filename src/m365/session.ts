/**
 * M365 会话绑定与内容键复用（移植自 M365-Copilot2API internal/web/session_resolver.go）。
 *
 * 核心：把"客户端上下文"（消息历史）与"云端对话"（conversationId/sessionId）绑定。
 * - 显式指定 X-M365-Session-Id：最高优先级
 * - 内容键匹配：历史严格是客户端消息的前缀时复用会话，只发增量（类似 DeepSeek 上下文缓存）
 * - suffix 匹配：历史被客户端截断但仍高度相似时复用
 *
 * 存储：KV（每 provider 一个 JSON 列表），TTL 默认 2 小时。
 */
import type { Env } from '../types'
import type { OaiMsgLite } from './tools'
import { contentToString } from './tools'

export interface SessionBinding {
  sessionId: string
  conversationId: string
  accountId: string
  createdAt: number
  lastUsedAt: number
  ipFingerprint?: string
  userField?: string
  contextFinger?: string
  contextHistory?: OaiMsgLite[]
  /**
   * 会话归属租户（调用方 API Key 的不可逆哈希，由网关 auth 中间件计算并透传）。
   * 所有读/匹配/复用/删除都按 tenant 作用域，杜绝跨 Key 读取/续聊/删除他人的云端对话。
   * 旧记录（无此字段）视为无主，永不匹配任何带 key 的调用方。
   */
  tenant?: string
}

export interface ResolveResult {
  sessionId: string
  conversationId: string
  accountId: string
  matchedBy: string
  isNew: boolean
  /** 复用命中时云端对话已包含的消息条数（增量发送起点） */
  historyLen: number
}

const M365_SESSION_PREFIX = 'm365:sessions:'
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000
const MAX_SESSIONS = 1000

/** 会话签名/绑定 TTL（环境变量 M365_SESSION_TTL_HOURS，默认 2 小时） */
export function sessionTtlMs(env: Env): number {
  return hoursToMs(env.M365_SESSION_TTL_HOURS)
}

/** 上下文内容复用 TTL（环境变量 M365_CONTEXT_TTL_HOURS，默认 2 小时） */
export function contextTtlMs(env: Env): number {
  return hoursToMs(env.M365_CONTEXT_TTL_HOURS)
}

function hoursToMs(raw: string | undefined): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL_MS
  return n * 60 * 60 * 1000
}

function kvKey(providerId: string): string {
  return M365_SESSION_PREFIX + providerId
}

export function contextFingerprint(messages: OaiMsgLite[]): string {
  if (!messages || messages.length === 0) return ''
  const parts: string[] = []
  const limit = Math.min(messages.length, 3)
  for (let i = messages.length - limit; i < messages.length; i++) {
    const m = messages[i]
    parts.push(`${m.role}:${contentToString(m.content)}`)
  }
  const data = parts.join('||')
  return sha256Hex(data)
}

function sha256Hex(s: string): string {
  return sha256HexSync(s)
}

/** 同步 SHA-256（Workers 环境用 crypto.subtle 需 async，这里退化为简易 hash 也可，但保持一致用 subtle 的同步包装）
 *  实际上 crypto.subtle 是异步的；为简单可靠，采用同步哈希（FNV/混合）即可——指纹只用于会话匹配，不涉及安全。 */
function sha256HexSync(s: string): string {
  // 简单 64 位 FNV-1a 双哈希 → hex，用于上下文指纹（非安全用途）
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < s.length; i++) {
    h1 = (h1 ^ s.charCodeAt(i)) >>> 0
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 = (h2 ^ s.charCodeAt(i)) >>> 0
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0
  }
  const p1 = (h1 >>> 0).toString(16).padStart(8, '0')
  const p2 = (h2 >>> 0).toString(16).padStart(8, '0')
  return p1 + p2
}

async function readAll(env: Env, providerId: string): Promise<SessionBinding[]> {
  try {
    const raw = await env.KV.get(kvKey(providerId))
    if (!raw) return []
    const list = JSON.parse(raw) as SessionBinding[]
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

async function writeAll(env: Env, providerId: string, list: SessionBinding[]): Promise<void> {
  try {
    await env.KV.put(kvKey(providerId), JSON.stringify(list), { expirationTtl: Math.floor((sessionTtlMs(env) * 2) / 1000) })
  } catch { /* KV 写入失败不影响主流程 */ }
}

function clientIPFingerprint(c: ContextLike): string {
  const ip = c.ip || ''
  const ua = c.userAgent || ''
  return sha256Hex(ip + '|' + ua)
}

export interface ContextLike {
  ip?: string
  userAgent?: string
  user?: string
  explicitSessionId?: string
  /**
   * 租户标识：调用方 API Key 的不可逆哈希（由网关 auth 中间件计算并透传）。
   * 传入后所有会话匹配都限制在该租户内；缺省为 ''（不匹配任何带 tenant 的记录）。
   */
  tenant?: string
}

/** 比较两个工具调用：name 与 arguments 一致即视为等价，忽略 id（客户端重放时 id 会重新生成） */
function toolCallEqual(x: unknown, y: unknown): boolean {
  if (!x || typeof x !== 'object' || !y || typeof y !== 'object') return false
  const a = x as Record<string, unknown>
  const b = y as Record<string, unknown>
  const xf = (a['function'] || {}) as Record<string, unknown>
  const yf = (b['function'] || {}) as Record<string, unknown>
  const xn = typeof xf['name'] === 'string' ? xf['name'] : ''
  const yn = typeof yf['name'] === 'string' ? yf['name'] : ''
  if (xn !== yn) return false
  const xa = xf['arguments'] === undefined ? '' : String(xf['arguments'])
  const ya = yf['arguments'] === undefined ? '' : String(yf['arguments'])
  return xa === ya
}

function messagesEqual(a: OaiMsgLite, b: OaiMsgLite): boolean {
  if (a.role !== b.role) return false
  if (contentToString(a.content) !== contentToString(b.content)) return false
  const ta = Array.isArray(a.tool_calls) ? a.tool_calls : undefined
  const tb = Array.isArray(b.tool_calls) ? b.tool_calls : undefined
  if ((ta === undefined) !== (tb === undefined)) return false
  if (ta === undefined) return true
  if (ta.length !== tb!.length) return false
  for (let i = 0; i < ta.length; i++) {
    if (toolCallEqual(ta[i], tb![i])) continue
    return false
  }
  return true
}

/**
 * 校验历史是否结束在"消息原子边界"（同原版 buildAtoms 约束）：
 * 带 tool_calls 的 assistant 与其后的 tool 结果是一个不可分割的原子往返，
 * 不能从中间切开续传。若历史结束在未闭合的 tool_calls 之后，返回 false。
 */
function atomicBoundaryOk(hist: OaiMsgLite[]): boolean {
  const n = hist.length
  if (n === 0) return true
  // 最后一条为带 tool_calls 的 assistant：其后还需 tool 结果才能闭合，
  // 在此结束说明切在往返中间 → 非原子边界
  const last = hist[n - 1]
  if (last.role === 'assistant' && last.tool_calls && last.tool_calls.length > 0) return false
  // 其余位置：tool_calls 之后必须紧跟 role=tool，保证往返不被切断
  for (let i = 0; i < n - 1; i++) {
    const a = hist[i]
    if (a.role === 'assistant' && a.tool_calls && a.tool_calls.length > 0) {
      if (hist[i + 1].role !== 'tool') return false
    }
  }
  return true
}

function contextPrefixLen(hist: OaiMsgLite[], msgs: OaiMsgLite[]): number {
  if (hist.length === 0 || msgs.length < hist.length) return 0
  for (let i = 0; i < hist.length; i++) {
    if (!messagesEqual(hist[i], msgs[i])) return 0
  }
  // 前缀虽匹配，但若切在工具往返中间，则不视为可复用前缀，避免云端状态错乱
  if (!atomicBoundaryOk(hist)) return 0
  return hist.length
}

function suffixMatchLen(hist: OaiMsgLite[], msgs: OaiMsgLite[]): number {
  const maxN = Math.min(hist.length, msgs.length)
  let n = 0
  for (let i = 1; i <= maxN; i++) {
    if (messagesEqual(hist[hist.length - i], msgs[msgs.length - i])) n = i
    else break
  }
  return n
}

function cloneMessages(msgs: OaiMsgLite[]): OaiMsgLite[] {
  return msgs.map((m) => ({ ...m, content: Array.isArray(m.content) ? [...m.content] : m.content, tool_calls: m.tool_calls ? [...m.tool_calls] : m.tool_calls }))
}

function evict(list: SessionBinding[], ttlMs: number): SessionBinding[] {
  const now = Date.now()
  let out = list.filter((s) => now - s.lastUsedAt <= ttlMs)
  if (out.length > MAX_SESSIONS) {
    out = [...out].sort((a, b) => b.lastUsedAt - a.lastUsedAt).slice(0, MAX_SESSIONS)
  }
  return out
}

/**
 * 解析会话绑定：显式 ID > 内容前缀 > suffix。
 * messages 为客户端当前全量消息列表。
 */
export async function resolveSession(env: Env, providerId: string, msgs: OaiMsgLite[], ctx: ContextLike): Promise<ResolveResult> {
  let list = await readAll(env, providerId)
  list = evict(list, sessionTtlMs(env))

  const explicitID = ctx.explicitSessionId || ''
  if (explicitID) {
    const s = list.find((x) => x.sessionId === explicitID && x.tenant === ctx.tenant)
    if (s) {
      s.lastUsedAt = Date.now()
      await writeAll(env, providerId, list)
      return { sessionId: s.sessionId, conversationId: s.conversationId, accountId: s.accountId, matchedBy: 'explicit', isNew: false, historyLen: s.contextHistory?.length || 0 }
    }
  }

  if (msgs && msgs.length > 0) {
    const ipFinger = clientIPFingerprint(ctx)
    // 内容前缀匹配（仅限本租户）
    let best: { id: string; n: number; recent: number } | null = null
    for (const s of list) {
      if (s.tenant !== ctx.tenant) continue
      if (!s.ipFingerprint || s.ipFingerprint !== ipFinger) continue
      if (Date.now() - s.lastUsedAt > contextTtlMs(env)) continue
      if (!s.contextHistory || s.contextHistory.length === 0) continue
      const n = contextPrefixLen(s.contextHistory, msgs)
      if (n >= 1 && (!best || n > best.n || (n === best.n && s.lastUsedAt > best.recent))) {
        best = { id: s.sessionId, n, recent: s.lastUsedAt }
      }
    }
    if (best) {
      const s = list.find((x) => x.sessionId === best!.id)!
      s.lastUsedAt = Date.now()
      await writeAll(env, providerId, list)
      return { sessionId: s.sessionId, conversationId: s.conversationId, accountId: s.accountId, matchedBy: `context_prefix_${best.n}`, isNew: false, historyLen: best.n }
    }
    // suffix 匹配（客户端本地截断历史时仍可复用；仅限本租户）
    let bestS: { id: string; n: number; recent: number } | null = null
    for (const s of list) {
      if (s.tenant !== ctx.tenant) continue
      if (!s.ipFingerprint || s.ipFingerprint !== ipFinger) continue
      if (Date.now() - s.lastUsedAt > contextTtlMs(env)) continue
      if (!s.contextHistory || s.contextHistory.length < 2) continue
      const n = suffixMatchLen(s.contextHistory, msgs)
      if (n >= 2 && (!bestS || n > bestS.n || (n === bestS.n && s.lastUsedAt > bestS.recent))) {
        bestS = { id: s.sessionId, n, recent: s.lastUsedAt }
      }
    }
    if (bestS) {
      const s = list.find((x) => x.sessionId === bestS!.id)!
      s.lastUsedAt = Date.now()
      await writeAll(env, providerId, list)
      return { sessionId: s.sessionId, conversationId: s.conversationId, accountId: s.accountId, matchedBy: `context_suffix_${bestS.n}`, isNew: false, historyLen: bestS.n }
    }
  }

  return { sessionId: '', conversationId: '', accountId: '', matchedBy: 'new', isNew: true, historyLen: 0 }
}

/**
 * 绑定会话：对话完成后把（sessionId/conversationId/accountId + 消息历史）写入 KV。
 * assistantText 为本次助手回复全文（含推理），用于更新历史供下次匹配。
 */
export async function bindSession(env: Env, providerId: string, sessionId: string, conversationId: string, accountId: string, msgs: OaiMsgLite[], assistantText: string, ctx: ContextLike): Promise<void> {
  let list = await readAll(env, providerId)
  list = evict(list, sessionTtlMs(env))

  const now = Date.now()
  const history = cloneMessages(msgs)
  if (assistantText.trim() !== '') {
    history.push({ role: 'assistant', content: assistantText })
  }
  const ipFinger = clientIPFingerprint(ctx)
  // 客户端显式指定会话 ID 时，以它为持久化 sessionId（同原版 Bind：explicitID 优先），
  // 否则复用命中/新建会话用云端返回的 sessionId。
  const explicitID = ctx.explicitSessionId || ''
  const persistId = explicitID || sessionId

  const existing = list.find((s) =>
    (s.sessionId === persistId && s.tenant === ctx.tenant) ||
    (s.conversationId === conversationId && persistId === '' && s.tenant === ctx.tenant)
  )
  if (existing) {
    existing.conversationId = conversationId
    existing.accountId = accountId
    existing.lastUsedAt = now
    existing.userField = ctx.user
    existing.ipFingerprint = ipFinger
    existing.contextFinger = contextFingerprint(history)
    existing.contextHistory = history
    existing.tenant = ctx.tenant
  } else {
    list.push({
      sessionId: persistId || crypto.randomUUID(),
      conversationId,
      accountId,
      createdAt: now,
      lastUsedAt: now,
      userField: ctx.user,
      ipFingerprint: ipFinger,
      contextFinger: contextFingerprint(history),
      contextHistory: history,
      tenant: ctx.tenant,
    })
  }
  await writeAll(env, providerId, list)
}

/** 列出某 provider 的所有会话（管理后台用） */
export async function listSessions(env: Env, providerId: string): Promise<SessionBinding[]> {
  return evict(await readAll(env, providerId), sessionTtlMs(env))
}

/** 删除某 provider 的会话（仅限本租户，防止跨 Key 删除他人会话） */
export async function deleteSession(env: Env, providerId: string, sessionId: string, tenant?: string): Promise<boolean> {
  let list = await readAll(env, providerId)
  const before = list.length
  list = list.filter((s) => s.sessionId !== sessionId || (tenant !== undefined && s.tenant !== tenant))
  if (list.length === before) return false
  await writeAll(env, providerId, list)
  return true
}

/**
 * 按云端对话 ID 级联解绑会话（同原版 UnbindByConversation）。
 * 云端对话被清理后调用，避免残留死绑定被后续复用导致串号。
 */
export async function unbindByConversation(env: Env, providerId: string, conversationId: string): Promise<void> {
  if (!conversationId) return
  let list = await readAll(env, providerId)
  const before = list.length
  list = list.filter((s) => s.conversationId !== conversationId)
  if (list.length !== before) await writeAll(env, providerId, list)
}

/** 清理过期会话（Cron 用） */
export async function cleanupSessions(env: Env, providerId: string): Promise<number> {
  let list = await readAll(env, providerId)
  const before = list.length
  list = evict(list, sessionTtlMs(env))
  if (list.length !== before) await writeAll(env, providerId, list)
  return before - list.length
}