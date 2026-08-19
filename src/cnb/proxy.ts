/**
 * proxy.ts — CNB（cnb.cool）上游转发（移植自 lwjlwjlwjlwj/cnb2api，MIT）。
 *
 * 核心链路：
 *   1. GET https://cnb.cool/ 首页 → 提取 Set-Cookie 里的 csrfkey（32hex）+
 *      页面内嵌 window.csrftoken（40hex），二者配对使用（免登录、免费）。
 *   2. POST /ai/chat/completions 带 iCsrftoken 头 + csrfkey Cookie + Origin/Referer，
 *      上游强制 stream:true，返回 OpenAI 格式 SSE（delta.content + reasoning_content）。
 *   3. 凭证池（移植自 cnb2api）：免登录凭证是匿名单会话，单个并发受限，故维护
 *      多个独立会话凭证 round-robin 轮转（默认 min=2 / max=8 / ttl=30min，可用
 *      provider.cnbPool 覆盖）；过期/连续失败自动淘汰、低于 min 后台补证；
 *      内存 + KV 双缓存（冷启动复用），401/403 含 csrf 关键字自动换证重试。
 *
 * 工具桥（provider.toolBridge）：上游禁原生 tools（403 Agent calls not allowed），
 * 开启后把客户端 tools 转成 XYML 提示词注入（见 ./xyml.ts），模型文本流经 ToolSieve
 * 流式解析回标准 tool_calls 返回客户端。
 */

import type { Env, Provider } from '../types'
import { streamFetchWithTimeout } from '../opencode'
import {
  buildToolInstructions,
  renderToolCall,
  openAIToolCalls,
  randomId,
  scrubToolFragments,
  ToolSieve,
} from './xyml'

export const CNB_BASE_URL = 'https://cnb.cool'
export const CNB_CHAT_PATH = '/ai/chat/completions'

export const CNB_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro']

const CNB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const CSRF_MAX_ERR = 3

/** 是否是 CNB 提供商（id 固定或用 cnb.cool 域） */
export function isCnbProvider(provider: Provider): boolean {
  return Boolean(provider.id === 'cnb' || (provider.baseUrl && provider.baseUrl.includes('cnb.cool')))
}

// ===== CSRF 凭证池（移植自 cnb2api internal/auth 的池机制） =====

/**
 * CNB 免登录凭证是「匿名单会话」（csrfkey cookie + csrftoken 配对），单会话并发请求
 * 多了容易互相挤占/触发风控，故做成凭证池：
 * - 多个独立会话凭证 round-robin 轮转，天然支持并发；
 * - 凭证过期（ttl）/连续失败（errCnt ≥ 3）自动淘汰，低于 pool_min 时后台补证；
 * - 池整体持久化到 KV（冷启动复用），内存 + KV 双缓存。
 */
interface CnbCsrf {
  key: string
  token: string
  created: number
  errCnt: number
}

interface CnbPool {
  creds: CnbCsrf[]
  /** round-robin 游标 */
  idx: number
  /** 进行中的补证任务（防并发重复抓证） */
  refilling: Promise<void> | null
}

interface CnbPoolConfig {
  min: number
  max: number
  ttlMs: number
}

const POOL_DEFAULT_MIN = 2
const POOL_DEFAULT_MAX = 8
const POOL_DEFAULT_TTL_MINUTES = 30

const csrfPools = new Map<string, CnbPool>()

const kvKey = (providerId: string) => `cnb:csrf:${providerId}`

/** 池配置：provider.cnbPool 覆盖默认值（min=2 / max=8 / ttl=30min），min≤max 恒成立 */
function poolConfig(provider: Provider): CnbPoolConfig {
  const c = provider.cnbPool
  const min = Math.max(1, Math.floor(c?.min ?? POOL_DEFAULT_MIN))
  const max = Math.max(min, Math.floor(c?.max ?? POOL_DEFAULT_MAX))
  return { min, max, ttlMs: Math.max(60_000, (c?.ttlMinutes ?? POOL_DEFAULT_TTL_MINUTES) * 60_000) }
}

function csrfValid(cs: CnbCsrf, cfg: CnbPoolConfig): boolean {
  return Boolean(cs && cs.key && cs.token && Date.now() - cs.created < cfg.ttlMs && (cs.errCnt || 0) < CSRF_MAX_ERR)
}

function getMemPool(providerId: string): CnbPool {
  let p = csrfPools.get(providerId)
  if (!p) {
    p = { creds: [], idx: 0, refilling: null }
    csrfPools.set(providerId, p)
  }
  return p
}

/** 淘汰过期/超错凭证，返回淘汰数 */
function prunePool(pool: CnbPool, cfg: CnbPoolConfig): number {
  const before = pool.creds.length
  if (before === 0) return 0
  pool.creds = pool.creds.filter((c) => csrfValid(c, cfg))
  if (pool.idx >= pool.creds.length) pool.idx = 0
  return before - pool.creds.length
}

/** 冷启动从 KV 恢复池；兼容旧版单凭证格式（{key,token,...}） */
async function restorePool(env: Env, providerId: string, pool: CnbPool, cfg: CnbPoolConfig): Promise<void> {
  if (pool.creds.length) return
  try {
    const raw = await env.KV.get(kvKey(providerId))
    if (!raw) return
    const parsed = JSON.parse(raw) as { creds?: CnbCsrf[] } | CnbCsrf
    const list = Array.isArray(parsed && 'creds' in parsed && parsed.creds)
      ? (parsed as { creds: CnbCsrf[] }).creds
      : (parsed && 'key' in parsed && 'token' in parsed ? [parsed as CnbCsrf] : [])
    pool.creds = list.filter((c) => csrfValid(c, cfg)).slice(0, cfg.max)
    pool.idx = 0
  } catch { /* 损坏缓存：重新抓取 */ }
}

/** 持久化池到 KV（尽力而为，失败不影响主流程） */
function persistPool(env: Env, providerId: string, pool: CnbPool, cfg: CnbPoolConfig): void {
  try {
    void env.KV.put(kvKey(providerId), JSON.stringify({ creds: pool.creds.slice(0, cfg.max) }), {
      expirationTtl: Math.max(Math.floor(cfg.ttlMs / 1000), 3600),
    })
  } catch { /* KV 不可用时内存兜底 */ }
}

/**
 * 后台补证：并发抓取新会话凭证直到 target 个（不超过 max）。
 * refilling 单飞防并发重复抓取（多请求同时冷启动时只抓一份）。
 */
function ensureCredCount(env: Env, provider: Provider, pool: CnbPool, cfg: CnbPoolConfig, target: number): Promise<void> {
  if (pool.creds.length >= target || target > cfg.max) return Promise.resolve()
  if (pool.refilling) return pool.refilling
  pool.refilling = (async () => {
    try {
      while (pool.creds.length < target) {
        try {
          const cs = await fetchCsrfFresh()
          pool.creds.push(cs)
          persistPool(env, provider.id, pool, cfg)
        } catch {
          break // 抓证失败（网络/上游变更）：维持现有池，等下次请求再补
        }
      }
    } finally {
      pool.refilling = null
    }
  })()
  return pool.refilling
}

/** 用全新会话访问首页，提取 csrfkey(cookie) + csrftoken(html) 配对。 */
async function fetchCsrfFresh(): Promise<CnbCsrf> {
  const resp = await streamFetchWithTimeout(CNB_BASE_URL + '/', {
    method: 'GET',
    headers: {
      'User-Agent': CNB_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  })
  if (!resp.ok || !resp.body) {
    throw new Error(`cnb: fetch home failed (${resp.status})`)
  }
  const html = await resp.text()
  const tokenMatch = html.match(/window\.csrftoken="([0-9a-f]{32,64})"/)
  if (!tokenMatch) throw new Error('cnb: invalid csrf token — csrftoken not found in home page')
  const setCookie = resp.headers.get('set-cookie') || ''
  const keyMatch = setCookie.match(/(?:^|;)\s*csrfkey=([0-9a-f]{32,64})/i)
  if (!keyMatch) throw new Error('cnb: invalid csrf token — csrfkey cookie not found')
  return { key: keyMatch[1], token: tokenMatch[1], created: Date.now(), errCnt: 0 }
}

/** round-robin 取下一个有效凭证；池不足 min 时先补证 */
async function acquireCsrf(env: Env, provider: Provider): Promise<CnbCsrf> {
  const cfg = poolConfig(provider)
  const pool = getMemPool(provider.id)
  await restorePool(env, provider.id, pool, cfg)
  prunePool(pool, cfg)
  if (pool.creds.length < cfg.min) {
    await ensureCredCount(env, provider, pool, cfg, cfg.min)
    prunePool(pool, cfg)
  }
  if (pool.creds.length === 0) {
    // 兜底：补证失败时现抓一个（首次请求 + 上游异常时）
    const cs = await fetchCsrfFresh()
    pool.creds.push(cs)
    persistPool(env, provider.id, pool, cfg)
  }
  // round-robin 扫描：从游标起找第一个有效凭证
  const start = pool.idx % pool.creds.length
  for (let i = 0; i < pool.creds.length; i++) {
    const c = pool.creds[(start + i) % pool.creds.length]
    if (csrfValid(c, cfg)) {
      pool.idx = (start + i + 1) % pool.creds.length
      return c
    }
  }
  const cs = await fetchCsrfFresh()
  pool.creds.push(cs)
  persistPool(env, provider.id, pool, cfg)
  return cs
}

/** 上报凭证 CSRF 失败：错误计数+1，超限淘汰；池低于 min 时后台补证 */
async function reportCsrfError(env: Env, provider: Provider, cs: CnbCsrf): Promise<void> {
  const cfg = poolConfig(provider)
  const pool = getMemPool(provider.id)
  const found = pool.creds.find((c) => c.key === cs.key)
  if (found) {
    found.errCnt = (found.errCnt || 0) + 1
    if (found.errCnt >= CSRF_MAX_ERR) {
      pool.creds = pool.creds.filter((c) => c.key !== cs.key)
    }
    persistPool(env, provider.id, pool, cfg)
  }
  if (pool.creds.length < cfg.min) {
    await ensureCredCount(env, provider, pool, cfg, cfg.min)
  }
}

/** 判定 401/403 响应体是否 CSRF 校验失败（区别于业务拒绝，如 Agent calls not allowed）。 */
function isCsrfErrorBody(body: string): boolean {
  const lower = body.toLowerCase()
  return lower.includes('csrf') ||
    lower.includes('blocked by csrf') ||
    lower.includes('csrf 校验失败')
}

// ===== 请求体构造 =====

interface CnbMessage {
  role: string
  content: string
}

interface UpstreamBodyInput {
  model?: string
  messages?: Array<Record<string, unknown>>
  stream?: boolean
  temperature?: unknown
  top_p?: unknown
  enable_thinking?: unknown
  presence_penalty?: unknown
}

function stripModelPrefix(model: string): string {
  const i = model.indexOf('/')
  return i > 0 ? model.slice(i + 1) : model
}

/** content 兼容 string / 数组（text / thinking / toolCall / toolResult / image_url 忽略） */
function extractChatContent(content: unknown): string {
  if (content === null || content === undefined) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const p = part as Record<string, unknown>
      switch (p.type) {
        case 'text':
          if (typeof p.text === 'string' && p.text) parts.push(p.text)
          break
        case 'thinking':
          if (typeof p.thinking === 'string' && p.thinking) parts.push(p.thinking)
          break
        case 'toolCall': {
          const args = p.arguments !== undefined ? jsonSafe(p.arguments) : ''
          parts.push(`(assistant called tool ${p.name} with args ${args})`)
          break
        }
        default:
          if (typeof p.text === 'string' && p.text) parts.push(p.text)
      }
    }
    return parts.join('')
  }
  return String(content)
}

function jsonSafe(value: unknown): string {
  try { return JSON.stringify(value) } catch { return String(value ?? '') }
}

/**
 * 消息转换：OpenAI 标准消息（含 tool_calls / tool 角色）→ CNB 可接受的 user/assistant 文本序列。
 * bridge=true 时：assistant 的 tool_calls 渲染成 XYML 文本、tool 结果转 [Tool Result id=...]。
 */
function convertMessages(
  rawMessages: unknown,
  bridge: boolean,
): CnbMessage[] {
  const msgs = Array.isArray(rawMessages) ? rawMessages : []
  const converted: CnbMessage[] = []
  const appendUser = (content: string) => {
    const last = converted[converted.length - 1]
    if (last && last.role === 'user') {
      if (last.content !== '') last.content += '\n\n'
      last.content += content
    } else {
      converted.push({ role: 'user', content })
    }
  }
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue
    const msg = m as Record<string, unknown>
    const content = extractChatContent(msg.content)
    let role = String(msg.role || 'user')
    // 过滤失败的 assistant 占位
    if (role === 'assistant' && (content.includes('[assistant turn failed') || content.includes('turn failed before producing'))) {
      continue
    }
    // toolResult（OpenClaw 自定义角色）→ user
    if (role === 'toolResult') {
      appendUser('[工具执行结果] ' + (content || '(tool result)'))
      continue
    }
    // tool 角色 → user（携带 id 信息）
    if (role === 'tool') {
      const toolCallId = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : ''
      const name = typeof msg.name === 'string' ? msg.name : ''
      if (bridge) {
        const header = `[Tool Result id=${toolCallId || 'unknown'}${name ? ` name=${name}` : ''}]`
        appendUser(`${header}\n${content || '(tool result)'}`)
      } else {
        appendUser('[工具执行结果] ' + (content || '(tool result)'))
      }
      continue
    }
    // assistant 带 tool_calls：bridge 渲染 XYML，否则转说明文本
    if (role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      const blocks: string[] = []
      if (content.trim()) blocks.push(content)
      if (bridge) {
        for (const call of msg.tool_calls) {
          if (call && typeof call === 'object') {
            const fn = (call as Record<string, unknown>).function
            if (fn && typeof fn === 'object') {
              const fnObj = fn as Record<string, unknown>
              blocks.push(renderToolCall(fnObj.name, fnObj.arguments && typeof fnObj.arguments === 'string' ? safeParse(fnObj.arguments) : fnObj.arguments))
            }
          }
        }
      } else {
        for (const call of msg.tool_calls) {
          if (call && typeof call === 'object') {
            const fn = (call as Record<string, unknown>).function as Record<string, unknown> | undefined
            if (fn && typeof fn.name === 'string') {
              blocks.push(`(assistant called tool ${fn.name} with args ${typeof fn.arguments === 'string' ? fn.arguments : jsonSafe(fn.arguments)})`)
            }
          }
        }
      }
      converted.push({ role: 'assistant', content: blocks.join('\n') })
      continue
    }
    if (role === 'assistant' && content === '') role = 'assistant'
    if (role === 'user') {
      appendUser(content)
      continue
    }
    converted.push({ role, content })
  }
  // 清理空 user 消息与尾部空 user
  const cleaned: CnbMessage[] = []
  for (let i = 0; i < converted.length; i++) {
    const c = converted[i]
    if (c.role === 'user' && c.content === '') continue
    cleaned.push(c)
  }
  while (cleaned.length && cleaned[cleaned.length - 1].role === 'user' && cleaned[cleaned.length - 1].content === '') {
    cleaned.pop()
  }
  return cleaned
}

function safeParse(value: string): unknown {
  try { return JSON.parse(value) } catch { return value }
}

function buildUpstreamBody(input: UpstreamBodyInput, messages: CnbMessage[], tools: unknown, bridge: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: stripModelPrefix(String(input.model || CNB_MODELS[0])),
    stream: true, // 上游强制流式
    messages,
    // 强制 maxTokens 避免长上下文被截断（deepseek-v4 默认支持 65k 输出）
    maxTokens: 60000,
  }
  for (const key of ['temperature', 'top_p', 'enable_thinking', 'presence_penalty'] as const) {
    if (input[key] !== undefined && input[key] !== null) body[key] = input[key]
  }
  // 工具桥：注入 XYML 提示词、剥掉原生 tools（上游禁止）
  if (bridge && Array.isArray(tools) && tools.length) {
    let messages2 = messages
    const instructions = buildToolInstructions(tools)
    if (messages2.length && messages2[0].role === 'system') {
      messages2 = [
        { role: 'system', content: (messages2[0].content || '').trim() + '\n\n' + instructions },
        ...messages2.slice(1),
      ]
    } else {
      messages2 = [{ role: 'system', content: instructions }, ...messages2]
    }
    body.messages = messages2
  }
  return body
}

// ===== 上游请求 =====

async function chatOnce(
  provider: Provider,
  upBody: Record<string, unknown>,
  csrf: CnbCsrf,
): Promise<Response> {
  const resp = await streamFetchWithTimeout(CNB_BASE_URL + CNB_CHAT_PATH, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream, application/json, text/plain, */*',
      'User-Agent': CNB_UA,
      'Origin': CNB_BASE_URL,
      'Referer': CNB_BASE_URL + '/',
      'Csrftoken': csrf.token,
      'Cookie': `csrfkey=${csrf.key}`,
    },
    body: JSON.stringify(upBody),
  })
  // 凭证失效（401/403 且响应体含 csrf）：抛错由调用方上报（记错/淘汰）并换证重试
  if (resp.status === 401 || resp.status === 403) {
    const text = await resp.clone().text()
    if (isCsrfErrorBody(text)) {
      throw new CnbCsrfError(resp.status, text.slice(0, 500))
    }
  }
  return resp
}

class CnbCsrfError extends Error {
  status: number
  constructor(status: number, detail: string) {
    super(`cnb: csrf rejected (${status}): ${detail}`)
    this.status = status
  }
}

export async function proxyCnbChatRequest(
  env: Env,
  provider: Provider,
  clientBody: Record<string, unknown>,
  onFinish?: (diag: CnbStreamDiag) => void,
): Promise<Response> {
  const bridge = provider.toolBridge === true
  const tools = Array.isArray(clientBody.tools) ? clientBody.tools : []
  const messages = convertMessages(clientBody.messages, bridge)
  const upBody = buildUpstreamBody(clientBody as UpstreamBodyInput, messages, tools, bridge)
  const isStream = clientBody.stream === true

  // 凭证池重试：每次尝试换下一个 round-robin 凭证；CSRF 失败上报（记错/淘汰）后重试。
  // 重试上限 = clamp(poolMax, 3, 6)：池小少试、池大多试，避免单个请求串太久。
  const cfg = poolConfig(provider)
  const attempts = Math.min(6, Math.max(3, cfg.max))
  // 统一发上游请求（带凭证池重试）：首轮与自动续写轮共用同一套凭证/重试逻辑。
  const chat = async (body: Record<string, unknown>): Promise<Response> => {
    let lastResp: Response | null = null
    for (let attempt = 0; attempt < attempts; attempt++) {
      const csrf = await acquireCsrf(env, provider)
      try {
        const resp = await chatOnce(provider, body, csrf)
        lastResp = resp
        if (!resp.ok) return resp // 非 2xx（业务拒绝等）原样透传
        return resp
      } catch (err) {
        if (err instanceof CnbCsrfError && attempt < attempts - 1) {
          await reportCsrfError(env, provider, csrf)
          continue
        }
        if (lastResp && !lastResp.ok) return lastResp
        throw err
      }
    }
    if (lastResp && !lastResp.ok) return lastResp
    throw new Error('cnb: chat failed after retries')
  }

  const resp = await chat(upBody)
  if (isStream) return buildStreamResponse(resp, { bridge, tools, upBody, chat }, onFinish)
  return await buildNonStreamResponse(resp, { bridge, tools })
}

// ===== 流式响应 =====

interface BridgeOptions {
  bridge: boolean
  tools: unknown[]
  // 自动续写所需：首轮上游 body（复用来构造续写 messages）与「再发一次上游请求」的能力
  upBody?: Record<string, unknown>
  chat?: (body: Record<string, unknown>) => Promise<Response>
}

/** 每轮流式收尾的诊断快照，供上层写日志定位「内容未说完就停」的根因。 */
export interface CnbStreamDiag {
  cleanEnd: boolean            // true=收到上游 [DONE]；false=上游直接关流
  upstreamFinishReason: string | null  // 上游显式给出的 finish_reason（如 length）
  finalReason: string          // 网关最终下发给客户端的 finish_reason
  toolCalls: boolean           // 本轮是否发出过工具调用增量
  outChars: number             // 网关实际透传给客户端的正文总字符数
  rounds: number               // 自动续写轮数（0=未续写；>0=网关自动续写过 N 次）
}

/**
 * 读上游 SSE 流，逐 chunk 回调解码后的对象；done=true 表示流结束，
 * cleanEnd=true 表示正常收到 [DONE] 收尾；cleanEnd=false 表示上游直接关流
 * （未发 [DONE]），调用方可据此区分「完整结束」与「可能被截断」，避免把
 * 中途断流误报为完成（客户端误判后只能手工发「继续」续命）。
 */
async function readUpstreamSSE(
  body: ReadableStream<Uint8Array> | null,
  onChunk: (obj: UpstreamChunk | null, done: boolean, cleanEnd: boolean) => Promise<void> | void,
): Promise<void> {
  if (!body) return
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') {
          await onChunk(null, true, true)
          return
        }
        if (payload === '' ) continue
        try {
          const obj = JSON.parse(payload) as UpstreamChunk
          await onChunk(obj, false, true)
        } catch { /* 单块解析失败跳过 */ }
      }
    }
    // 上游 EOF（未发 [DONE]，部分上游以关流代替）：先消化 buf 里未换行的尾部残余，
    // 再触发收尾让 buildStreamResponse 正确 flush 并补发 finish/[DONE]，
    // 避免尾部 chunk 丢失、客户端拿到无 finish 的裸 EOF 而误判为截断/异常。
    if (buf.trim()) {
      const payload = buf.trim()
      if (payload !== '[DONE]' && payload.startsWith('{')) {
        try {
          const obj = JSON.parse(payload) as UpstreamChunk
          await onChunk(obj, false, true)
        } catch { /* ignore */ }
      }
    }
    await onChunk(null, true, false)
  } finally {
    try { await reader.cancel() } catch { /* ignore */ }
  }
}

interface UpstreamChunk {
  id?: string
  model?: string
  created?: number
  usage?: unknown
  choices?: Array<{
    delta?: { content?: string; reasoning_content?: string; tool_calls?: unknown[] }
    finish_reason?: string | null
  }>
}

function stdChunk(id: string, model: string, created: number, delta: Record<string, unknown>, finishReason: string | null): string {
  return 'data: ' + JSON.stringify({
    id, model, created, object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }) + '\n\n'
}

/**
 * 启发式判断「回答是否疑似没说完」。CNB 上游 deepseek-v4-flash 在内容未说完时
 * 常自报 finish_reason=stop（cleanEnd=true、无 length），客户端因此不自动续写。
 * 网关据此特征自动再发一轮「请继续」。只看结尾特征，避免误伤真正完整的小段回答：
 * - 未闭合代码块 / 内联代码 → 明显截断
 * - 以句号/问号/叹号等完整标点收尾 → 视为完整
 * - 以逗号/顿号/省略号/中文助词（的了着吗呢吧啊）收尾 → 半句，视为截断
 * - 其他不以标点收尾（列表中间、行尾、裸词）→ 保守视为疑似截断
 */
function looksTruncated(text: unknown): boolean {
  const t = String(text ?? '').trimEnd()
  if (!t) return false
  // 未闭合的围栏代码块（``` 数量为奇数）→ 明显没写完
  const fences = (t.match(/```/g) || []).length
  if (fences % 2 === 1) return true
  // 取最后一段（按空行切）作为结尾特征样本
  const lastBlock = t.split(/\n\s*\n/).filter((s) => s.trim()).pop() ?? ''
  const tail = lastBlock.trimEnd()
  if (!tail) return false
  // 未闭合内联代码（` 数量为奇数）
  if ((tail.match(/`/g) || []).length % 2 === 1) return true
  // 以常见完整结束标点收尾 → 视为完整
  if (/[。！？；：．.!?;:…]$/.test(tail)) return false
  // 短确认型回答白名单（是的/好的/可以等，不以标点收尾也视为完整，避免误触发续写）
  if (/^(是的|好的|可以|行|没问题|已完成|完成|收到|明白|ok|OK|可以了|好的好的|好|嗯|对|了解)$/.test(t.trim())) return false
  // 短文本：仅以明显半句助词/系词（的了着吗呢吧啊是）结尾才视为截断，其余视为完整
  if (tail.length < 12) return /[的了着吗呢吧啊是]$/.test(tail)
  // 长文本：以中文助词/半句词结尾（“它的作用是”“需要确认”“正在处理”等）→ 截断
  if (/[的了着吗呢吧啊是]$/.test(tail)) return true
  // 其他不以标点收尾的长文本 → 保守判定为「疑似没说完」
  return true
}

function buildStreamResponse(upstream: Response, opts: BridgeOptions, onFinish?: (diag: CnbStreamDiag) => void): Response {
  // 非 2xx（业务拒绝/上游错误）原样透传，不包 SSE
  if (!upstream.ok) return upstream
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()
  const encoder = new TextEncoder()
  let stdID = '', stdModel = CNB_MODELS[0], stdCreated = Math.floor(Date.now() / 1000), stdUsage: unknown = null
  let outChars = 0
  let emittedToolCalls = false
  // 上游显式给出的 finish_reason（如 length=输出上限/被截断，需透传而非一律伪报 stop）
  let upstreamFinishReason: string | null = null
  // 流是否正常收尾（收到 [DONE]）；false=上游直接关流（可能中途断流）
  let cleanEnd = true
  // bridge 模式下始终启用 ToolSieve：即使当前请求未携带 tools（多轮对话时客户端可能只在首轮传 tools，
  // 但历史仍让模型按 XYML 输出），也要拦截并剥离原始 XYML 标记，避免泄漏给客户端。
  const sieve = opts.bridge ? new ToolSieve(opts.tools) : null
  let toolIdx = 0
  // 已透传的纯正文（含 flush 降级内容），用于自动续写时让模型接着往下写
  let allText = ''
  // 自动续写上限：最多续写 3 次（共最多 4 轮），避免模型持续不自停而耗尽上游额度
  const MAX_CONTINUE_ROUNDS = 3
  // 续写提示：要求从中断处继续、不重复已写内容（网关内部请求，客户端不可见）
  const CONTINUE_PROMPT = '（网关自动续写）请直接接着上一段内容继续写，从中断处往下写，不要重复已经写过的内容。'

  const write = (s: string) => writer.write(encoder.encode(s))
  const done = (): Promise<void> => writer.close()
  const fail = (e: unknown): Promise<void> => writer.abort(e)

  // 把解析出的每个工具调用切成增量 tool_calls 块（名称 → 参数）
  const emitToolCallDeltas = (calls: Array<Record<string, unknown>>): void => {
    emittedToolCalls = true
    for (const call of calls) {
      const idx = toolIdx++
      const fn = (call.function && typeof call.function === 'object')
        ? call.function as Record<string, unknown>
        : {}
      const id = String(call.id || `call_${idx}`)
      const name = String(fn.name || '')
      const args = String(fn.arguments || '')
      // 名称增量块
      write(stdChunk(stdID || randomId(), stdModel, stdCreated, {
        tool_calls: [{ index: idx, id, type: 'function', function: { name, arguments: '' } }],
      }, null))
      // 参数增量块（可为空参数对象）
      write(stdChunk(stdID || randomId(), stdModel, stdCreated, {
        tool_calls: [{ index: idx, function: { arguments: args } }],
      }, null))
    }
  }

  // 写收尾 chunk + [DONE]，并上报诊断快照。rounds=实际完成的续写轮数。
  const finishRound = (rounds: number): void => {
    const finalReason = emittedToolCalls ? 'tool_calls'
      : (upstreamFinishReason ?? (cleanEnd ? 'stop' : 'length'))
    const final: Record<string, unknown> = {
      id: stdID || randomId(), model: stdModel, created: stdCreated,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: finalReason }],
    }
    if (stdUsage) final['usage'] = stdUsage
    write('data: ' + JSON.stringify(final) + '\n\n')
    write('data: [DONE]\n\n')
    if (onFinish) onFinish({ cleanEnd, upstreamFinishReason, finalReason, toolCalls: emittedToolCalls, outChars, rounds })
  }

  ;(async () => {
    try {
      let resp = upstream
      let rounds = 0
      while (true) {
        // 每轮独立判断收尾标志（续写轮重新累计）
        cleanEnd = true
        upstreamFinishReason = null
        await readUpstreamSSE(resp.body, (obj, isDone, clean) => {
          if (isDone) {
            cleanEnd = clean
            // 收尾：先 flush sieve 剩余内容 / 工具调用，再决定是否续写
            if (sieve) {
              for (const ev of sieve.flush()) {
                if (ev.type === 'tool_calls' && ev.calls) emitToolCallDeltas(openAIToolCalls(ev.calls))
                else if (ev.text) { allText += ev.text; outChars += ev.text.length; write(stdChunk(stdID || randomId(), stdModel, stdCreated, { content: ev.text }, null)) }
              }
            }
            return
          }
          if (!obj) return
          if (obj.id) stdID = obj.id
          if (obj.model) stdModel = obj.model
          if (obj.created) stdCreated = obj.created
          if (obj.usage) stdUsage = obj.usage
          const choices = obj.choices || []
          for (const choice of choices) {
            const delta = choice.delta || {}
            // 记录上游显式 finish_reason（如 length），供收尾时透传，避免一律伪报 stop
            if (choice.finish_reason) upstreamFinishReason = choice.finish_reason
            const content = delta.content || ''
            const reasoning = delta.reasoning_content || ''
            // 推理内容与正文分开透传（bridge 模式 reasoning 不进 sieve，避免误判工具标记），
            // 但仍清洗混入推理的 XYML 工具标记残片（模型思考时常把计划执行的搜索/取数工具
            // XML 草案混进 reasoning，若不清理会以脏标签形式展示给客户端）。
            if (reasoning) write(stdChunk(stdID, stdModel, stdCreated, { reasoning_content: scrubToolFragments(reasoning) }, null))
            if (content) {
              if (sieve) {
                for (const ev of sieve.processChunk(content)) {
                  if (ev.type === 'tool_calls' && ev.calls) emitToolCallDeltas(openAIToolCalls(ev.calls))
                  else if (ev.text) { allText += ev.text; outChars += ev.text.length; write(stdChunk(stdID, stdModel, stdCreated, { content: ev.text }, null)) }
                }
              } else {
                allText += content; outChars += content.length
                write(stdChunk(stdID, stdModel, stdCreated, { content }, null))
              }
            }
          }
        })

        // 是否需要自动续写：上游自报 stop（内容疑似没说完）、未发工具调用（工具轮交给客户端执行）、还有续写额度
        const finalReason = emittedToolCalls ? 'tool_calls'
          : (upstreamFinishReason ?? (cleanEnd ? 'stop' : 'length'))
        const shouldContinue = !emittedToolCalls && finalReason === 'stop'
          && rounds < MAX_CONTINUE_ROUNDS
          && !!opts.chat && !!opts.upBody && looksTruncated(allText)
        if (!shouldContinue) {
          finishRound(rounds)
          break
        }
        // 构造续写请求：原始上游 messages + 已输出正文 + 继续提示
        rounds++
        const upMsgs = (opts.upBody!.messages || []) as Array<Record<string, unknown>>
        const contBody: Record<string, unknown> = {
          ...opts.upBody!,
          messages: [...upMsgs, { role: 'assistant', content: allText }, { role: 'user', content: CONTINUE_PROMPT }],
        }
        try {
          resp = await opts.chat!(contBody)
        } catch {
          // 续写请求失败（凭证/网络等）：不中断已输出的主流，直接收尾
          finishRound(rounds - 1)
          break
        }
        if (!resp.ok || !resp.body) {
          finishRound(rounds - 1)
          break
        }
      }
    } catch (e) {
      await fail(e)
      return
    }
    await done()
  })()

  return new Response(readable, {
    status: upstream.status === 200 ? 200 : upstream.status,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  })
}

/** 非流式：聚合上游 SSE 为单次 chat.completion JSON（上游强制流式，客户端 stream=false 时用）。 */
async function buildNonStreamResponse(upstream: Response, opts: BridgeOptions): Promise<Response> {
  let content = ''
  let reasoning = ''
  let stdID = '', stdModel = '', stdCreated = Math.floor(Date.now() / 1000)
  let stdUsage: unknown = null
  let finish = 'stop'
  let sawUpstreamFinish = false
  let cleanEnd = true
  // bridge 模式下始终启用 ToolSieve（理由同 buildStreamResponse：避免无 tools 请求时 XYML 泄漏）
  const sieve = opts.bridge ? new ToolSieve(opts.tools) : null
  const toolCalls: Array<Record<string, unknown>> = []

  await readUpstreamSSE(upstream.body, (obj, isDone, clean) => {
    if (isDone) { cleanEnd = clean; return }
    if (!obj) return
    if (obj.id) stdID = obj.id
    if (obj.model) stdModel = obj.model
    if (obj.created) stdCreated = obj.created
    if (obj.usage) stdUsage = obj.usage
    for (const choice of obj.choices || []) {
      const delta = choice.delta || {}
      if (delta.reasoning_content) reasoning += delta.reasoning_content
      const c = delta.content || ''
      if (c) {
        if (sieve) {
          for (const ev of sieve.processChunk(c)) {
            if (ev.type === 'tool_calls' && ev.calls) toolCalls.push(...openAIToolCalls(ev.calls))
            else if (ev.text) content += ev.text
          }
        } else {
          content += c
        }
      }
      if (choice.finish_reason) { finish = choice.finish_reason; sawUpstreamFinish = true }
    }
  })
  if (sieve) {
    for (const ev of sieve.flush()) {
      if (ev.type === 'tool_calls' && ev.calls) toolCalls.push(...openAIToolCalls(ev.calls))
      else if (ev.text) content += ev.text
    }
  }

  const message: Record<string, unknown> = { role: 'assistant', content }
  if (reasoning) message['reasoning_content'] = scrubToolFragments(reasoning)
  if (toolCalls.length) {
    message['tool_calls'] = toolCalls
    finish = 'tool_calls'
  } else if (!sawUpstreamFinish && !cleanEnd) {
    // 上游无 finish_reason 且直接关流：视为中途被截断，报 length 而非伪报 stop
    finish = 'length'
  }
  const respObj: Record<string, unknown> = {
    id: stdID || `chatcmpl-cnb-${randomId()}`,
    object: 'chat.completion',
    created: stdCreated,
    model: stdModel,
    choices: [{ index: 0, message, finish_reason: finish }],
  }
  if (stdUsage) respObj['usage'] = stdUsage
  return new Response(JSON.stringify(respObj), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

/** 取一个池凭证并发一个最小 chat 请求，验证 CNB 完整链路（凭证池 + 模型连通性）。 */
export async function testCnbConnection(
  env: Env,
  provider: Provider,
  model?: string,
): Promise<{ success: boolean; statusCode?: number; message?: string; data?: unknown }> {
  try {
    const cfg = poolConfig(provider)
    const csrf = await acquireCsrf(env, provider)
    const modelName = model
      || (Array.isArray(provider.models) && provider.models[0]?.id)
      || 'deepseek-v4-flash'
    // 最小 chat 请求验证真实链路；stream:false 由网关聚合上游 SSE 后返回 JSON
    const resp = await proxyCnbChatRequest(env, provider, {
      model: modelName,
      messages: [{ role: 'user', content: 'ping' }],
      stream: false,
      max_tokens: 16,
    })
    if (!resp.ok) {
      let detail = ''
      try { detail = (await resp.text()).substring(0, 300) } catch { /* ignore */ }
      return {
        success: false,
        statusCode: resp.status,
        message: `chat 请求失败 HTTP ${resp.status}${detail ? `：${detail}` : ''}`,
      }
    }
    let content = ''
    let finishReason = ''
    let usage: unknown = null
    try {
      const data = await resp.json() as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; usage?: unknown }
      content = String(data?.choices?.[0]?.message?.content || '').trim()
      finishReason = String(data?.choices?.[0]?.finish_reason || '')
      usage = data?.usage ?? null
    } catch { /* 解析失败不影响结论 */ }
    return {
      success: true,
      statusCode: 200,
      message: `连接成功（${modelName} 已响应）${content ? `，回复：${content.substring(0, 80)}` : ''}`,
      data: {
        cnb: true,
        model: modelName,
        poolSize: getMemPool(provider.id).creds.length,
        poolMin: cfg.min,
        poolMax: cfg.max,
        ttlMinutes: cfg.ttlMs / 60000,
        csrfKeyLen: csrf.key.length,
        csrfTokenLen: csrf.token.length,
        reply: content.substring(0, 200),
        finishReason,
        usage,
      },
    }
  } catch (err) {
    const msg = (err as Error).message || String(err)
    return { success: false, message: `连接失败：${msg}` }
  }
}