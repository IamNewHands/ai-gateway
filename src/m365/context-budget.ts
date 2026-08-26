/**
 * M365 上下文预算（context budgeting）——移植自 M365-Copilot2API internal/web/context_budget.go + prompt.go。
 *
 * 语义：把 OpenAI messages 先切分为"原子"（contextAtom），按优先级固定
 *   - P0：system / developer 块
 *   - P1：末尾紧邻的 tool 往返（assistant.tool_calls + 其 tool 结果）
 *   - anchor：第一条 user 充当锚点
 * 其余原子一旦预算超限，从后往前贪心丢弃；若固定上下文（system+当前工具对+anchor）本身超预算，
 * 则显式返回 400 `context_length_exceeded`，而非静默截断。
 *
 * 预算 B = ContextWindow - MaxOutput - 512（B<=0 时回退 1024）。
 */
import type { Env } from '../types'
import type { OaiMsgLite } from './tools'
import { contentToString, flattenPromptMessages } from './tools'

/** 单条消息协议开销 token（同原版 messageProtocolTokens） */
const MESSAGE_PROTOCOL_TOKENS = 3
/** 请求级协议开销 token（同原版 requestProtocolTokens） */
const REQUEST_PROTOCOL_TOKENS = 2
/** 回复预热 token（同原版 replyPrimingTokens） */
const REPLY_PRIMING_TOKENS = 2

/** 未显式提供预算时的回退值（同原版 slidingWindow budget<=0 回退 1024） */
const DEFAULT_BUDGET = 1024
/** 默认上下文窗口（token），未配置 M365_CONTEXT_WINDOW_TOKENS 时使用 */
const DEFAULT_CONTEXT_WINDOW = 200000

export type AtomKind = 'SYSTEM' | 'USER' | 'ATOM_TOOL' | 'ASSIST' | 'ANCHOR'

export interface ContextAtom {
  kind: AtomKind
  msgs: OaiMsgLite[]
  tokens: number
  start: number
  end: number
}

/** 启发式估算 token 数（同原版 heuristicTokenCount / EstimateTokens：英文按 4 字符，中文按 1.5 字符） */
export function estimateBudgetTokens(text: string): number {
  if (!text) return 0
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length
  const other = text.length - cjk
  return Math.ceil(cjk / 1.5) + Math.ceil(other / 4)
}

/** 序列化后计数（非字符串内容整体 JSON 序列化） */
function serializedTokenCount(value: unknown, counter: (s: string) => number): number {
  if (value === undefined || value === null) return 0
  if (typeof value === 'string') return counter(value)
  try { return counter(JSON.stringify(value)) } catch { return 0 }
}

export function estimateMessageTokens(m: OaiMsgLite, counter: (s: string) => number = estimateBudgetTokens): number {
  let tokens = MESSAGE_PROTOCOL_TOKENS
  tokens += counter(String(m.role || ''))
  tokens += counter(typeof m.name === 'string' ? m.name : '')
  tokens += counter(m.tool_call_id || '')
  tokens += serializedTokenCount(m.content, counter)
  const calls = Array.isArray(m.tool_calls) ? (m.tool_calls as unknown[]) : []
  for (const call of calls) tokens += serializedTokenCount(call, counter)
  if (tokens < 1) tokens = 1
  return tokens
}

/** 把 messages 切成原子：system/developer 聚合、tool 往返聚合、user/anchor、assistant 单条 */
export function buildAtoms(messages: OaiMsgLite[]): ContextAtom[] {
  if (!messages || messages.length === 0) return []
  const atoms: ContextAtom[] = []
  let i = 0
  const n = messages.length
  const roleOf = (m: OaiMsgLite): string => String(m.role || '').toLowerCase().trim()
  while (i < n) {
    const m = messages[i]
    const role = roleOf(m)
    if (role === 'system' || role === 'developer') {
      const start = i
      const msgs: OaiMsgLite[] = []
      let total = 0
      while (i < n) {
        const r = roleOf(messages[i])
        if (r !== 'system' && r !== 'developer') break
        msgs.push(messages[i])
        total += estimateMessageTokens(messages[i])
        i++
      }
      atoms.push({ kind: 'SYSTEM', msgs, tokens: total, start, end: i })
      continue
    }
    if (role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const start = i
      const msgs: OaiMsgLite[] = [m]
      let total = estimateMessageTokens(m)
      i++
      while (i < n && roleOf(messages[i]) === 'tool') {
        msgs.push(messages[i])
        total += estimateMessageTokens(messages[i])
        i++
      }
      atoms.push({ kind: 'ATOM_TOOL', msgs, tokens: total, start, end: i })
      continue
    }
    if (role === 'tool') {
      const start = i
      const msgs: OaiMsgLite[] = []
      let total = 0
      while (i < n && roleOf(messages[i]) === 'tool') {
        msgs.push(messages[i])
        total += estimateMessageTokens(messages[i])
        i++
      }
      atoms.push({ kind: 'ATOM_TOOL', msgs, tokens: total, start, end: i })
      continue
    }
    // user / assistant / 未知：单条原子
    const kind: AtomKind = role === 'user' ? 'USER' : role === 'assistant' ? 'ASSIST' : 'USER'
    atoms.push({ kind, msgs: [m], tokens: estimateMessageTokens(m), start: i, end: i + 1 })
    i++
  }
  // 第一条 user 升格为 anchor
  for (let idx = 0; idx < atoms.length; idx++) {
    if (atoms[idx].kind === 'USER') { atoms[idx].kind = 'ANCHOR'; break }
  }
  return atoms
}

export interface SlidingWindowResult {
  messages: OaiMsgLite[]
  truncated: boolean
  /** 固定上下文超预算时设置，调用方应返回 400 context_length_exceeded（同原版显式报错） */
  error?: string
}

/**
 * 按预算裁剪消息（同原版 slidingWindow）。
 * @param budget B = ContextWindow - MaxOutput - 512；<=0 回退 1024。
 */
export function slidingWindow(messages: OaiMsgLite[], budget: number): SlidingWindowResult {
  if (budget <= 0) budget = DEFAULT_BUDGET
  const atoms = buildAtoms(messages)
  if (atoms.length === 0) return { messages, truncated: false }

  let total = 0
  for (const a of atoms) total += a.tokens
  total += REQUEST_PROTOCOL_TOKENS + REPLY_PRIMING_TOKENS
  if (total <= budget) return { messages, truncated: false }

  // P0：system 原子；anchor：第一条 user
  const p0Indices: number[] = []
  let anchorIdx = -1
  for (let idx = 0; idx < atoms.length; idx++) {
    const a = atoms[idx]
    if (a.kind === 'SYSTEM') p0Indices.push(idx)
    if (a.kind === 'ANCHOR' && anchorIdx === -1) anchorIdx = idx
  }

  // P1：末尾紧邻的 tool 往返原子（从后往前连续 tool/assistant-tool 段）
  const p1Indices: number[] = []
  {
    const tail: number[] = []
    for (let idx = atoms.length - 1; idx >= 0; idx--) {
      const a = atoms[idx]
      if (a.kind === 'ATOM_TOOL' || a.kind === 'ASSIST') {
        tail.unshift(idx)
      } else {
        break
      }
    }
    // 仅当确实是以 tool 往返结尾才保留 P1（同原版：末尾 tool 段）
    if (tail.length > 0 && atoms[tail[tail.length - 1]].kind === 'ATOM_TOOL') {
      p1Indices.push(...tail)
    }
  }

  let sumP0P1 = REQUEST_PROTOCOL_TOKENS + REPLY_PRIMING_TOKENS
  for (const idx of p0Indices) sumP0P1 += atoms[idx].tokens
  for (const idx of p1Indices) sumP0P1 += atoms[idx].tokens
  if (anchorIdx !== -1) sumP0P1 += atoms[anchorIdx].tokens

  if (sumP0P1 > budget) {
    return {
      messages: [],
      truncated: true,
      error: `context_length_exceeded: pinned context (system+current task+anchor) ${sumP0P1} tokens exceed budget ${budget}; reduce tool results or start a new session`,
    }
  }

  let remaining = budget - sumP0P1
  const selected = new Set<number>()
  for (const idx of p0Indices) selected.add(idx)
  for (const idx of p1Indices) selected.add(idx)
  if (anchorIdx !== -1) selected.add(anchorIdx)

  // 从后往前尽量保留，原子的 token 不超剩余预算则保留
  for (let idx = atoms.length - 1; idx >= 0; idx--) {
    if (selected.has(idx)) continue
    const tok = atoms[idx].tokens
    if (tok <= remaining) {
      selected.add(idx)
      remaining -= tok
    }
  }

  const out: OaiMsgLite[] = []
  for (let idx = 0; idx < atoms.length; idx++) {
    if (selected.has(idx)) out.push(...atoms[idx].msgs)
  }
  let truncated = selected.size < atoms.length
  if (out.length === 0 && atoms.length > 0) {
    out.push(...atoms[atoms.length - 1].msgs)
    truncated = true
  }
  return { messages: out, truncated }
}

/**
 * 先裁剪再扁平化为单文本 prompt（同原版 flattenPromptMessagesWithBudget）。
 * 裁剪抛错（固定上下文超预算）时返回 { error }，调用方应回 400 context_length_exceeded。
 */
export function flattenPromptMessagesWithBudget(
  messages: OaiMsgLite[],
  attachments: { type: 'image'; url: string }[] | undefined,
  budget: number,
): { prompt: string; attachments: { type: 'image'; url: string }[]; truncated: boolean; error?: string } {
  const { messages: truncatedMsgs, truncated, error } = slidingWindow(messages, budget)
  if (error) return { prompt: '', attachments: attachments || [], truncated: true, error }
  return { ...flattenPromptMessages(truncatedMsgs, attachments), truncated }
}

/**
 * 计算本次请求的上下文预算 B = ContextWindow - MaxOutput - 512。
 * @param body 对话 body，取 max_completion_tokens / max_tokens 作为 MaxOutput（缺省 0）。
 */
export function computeContextBudget(env: Env, body: Record<string, unknown>): number {
  const window = Number(env?.M365_CONTEXT_WINDOW_TOKENS)
  const contextWindow = Number.isFinite(window) && window > 0 ? window : DEFAULT_CONTEXT_WINDOW
  const rawMaxOutput =
    typeof body?.['max_completion_tokens'] === 'number' && body['max_completion_tokens'] > 0
      ? (body['max_completion_tokens'] as number)
      : typeof body?.['max_tokens'] === 'number' && body['max_tokens'] > 0
        ? (body['max_tokens'] as number)
        : 0
  const b = contextWindow - rawMaxOutput - 512
  return b > 0 ? b : DEFAULT_BUDGET
}