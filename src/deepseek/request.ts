/**
 * deepseek/request.ts — OpenAI 请求 → 上游补全参数。
 *
 * 移植自 simple-chat `internal/openai/openai.go`（MIT）的请求侧规则，并沿用其
 * 测试里的精确期望值（`openai_test.go` / `strip_test.go` 的金字案例逐条转写）。
 *
 * 上游没有 system 角色、没有工具调用，所以网关的净化是**静默改写**而不是报错：
 *  - `system` 消息**合并不丢弃**：按出现顺序拼接后塞进**第一条 user 消息**前面，
 *    分隔符是 `"\n\n---\n\n"`；整段对话没有 user 时，新建一条只含 system 文本的
 *    前导 user 消息（纯 system 对话是合法输入）。
 *  - 工具调用残留（`tool_calls` / 空的 assistant/tool 消息）被丢弃——上游不认；
 *    客户端不会因此 400，只是这些消息消失。
 *  - junk 内容片段类型（audio 等）在解析期被丢掉并计数。
 *  - 采样参数 `temperature` / `top_p` / `max_tokens` 原样透传（上游会容忍但多半忽略，
 *    见 simple-chat 的 docs-upstream-params.md：保留是为了客户端兼容，不是因为有实测效果）。
 *
 * 与 Go 版的差异（有意为之）：**不在这里校验模型名**。模型白名单由 ai-gateway 的
 * provider 配置统一校验（其他 provider 也如此），这里只用 `enforceModel` 选项支持测试。
 */

/** `system` 合并块与首个 user 内容之间的分隔符（与 Go 版逐字节一致）。 */
export const SYSTEM_MERGE_SEPARATOR = '\n\n---\n\n'

/**
 * 摊平后 prompt 的字符上限（移植自 Go 版 `DefaultMaxPromptChars = 2_000_000`）。
 *
 * 为什么需要前置校验：上游对超长 prompt 的拒绝方式不明确（多半是流内错误或连接断开），
 * 于是客户端会拿到一个**归因错误**的 502「上游出错」，而真正的原因是自己的请求太长。
 * 在本地按 400 `context_length_exceeded` 拒绝，客户端才知道要改的是请求。
 */
export const DEEPSEEK_MAX_PROMPT_CHARS = 2_000_000

export class DeepseekRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeepseekRequestError'
  }
  /** 归因用的错误码（面板/客户端据此分支；默认 `bad_request`）。 */
  code = 'bad_request'
}

/** 超长 prompt 的专用错误：与「请求格式错」区分开，客户端才能正确归因。 */
export class DeepseekPromptTooLongError extends DeepseekRequestError {
  constructor(actual: number, limit: number) {
    super(`prompt is too long: ${actual} characters exceeds the ${limit}-character limit`)
    this.name = 'DeepseekPromptTooLongError'
    this.code = 'context_length_exceeded'
  }
}

export interface DeepseekContentPart {
  type: 'text' | 'image_url'
  text?: string
  imageUrl?: string
}

export interface DeepseekMessage {
  role: string
  content: string
  contentParts: DeepseekContentPart[]
  /** 解析期丢弃的 junk 内容片段数（例如 audio）。 */
  junkParts: number
  /** 是否带了被忽略的 `name` 字段。 */
  hasName: boolean
}

export interface ParsedDeepseekRequest {
  model: string
  messages: DeepseekMessage[]
  stream: boolean
  temperature: number
  topP: number
  /** `max_tokens` 与 `max_completion_tokens` 中的较大值（后者是 OpenAI 现行名）。 */
  maxTokens: number
  /** 深度思考开关；缺省 **true**（上游默认开思考）。 */
  thinkingEnabled: boolean
  /** 联网搜索开关；缺省 **false**（搜索会拖慢响应）。 */
  searchEnabled: boolean
  /** 本次请求被静默改写/丢弃的内容（调试用，客户端不可见）。 */
  stripped: string[]
}

export interface ParseOptions {
  /** 仅测试用：给定时期望模型名必须完全匹配。生产由 provider 配置校验。 */
  enforceModel?: string
  /**
   * provider 级「默认关思考」（见 Provider.deepseekThinkingOff）。
   * 客户端显式声明优先于它；未表态时才生效。
   */
  thinkingDefaultOff?: boolean
}

const JUNK_FIELDS = [
  'tools',
  'tool_choice',
  'functions',
  'function_call',
  'parallel_tool_calls',
  'logprobs',
  'top_logprobs',
  'logit_bias',
  'user',
  'store',
  'metadata',
  'service_tier',
  'response_format',
  'seed',
  'stop',
  'n',
  'stream_options',
  'presence_penalty',
  'frequency_penalty',
  'prediction',
] as const

/** 字段是否「实际带了值」：缺失、null、空数组、0 都算没带。 */
function junkPresent(v: unknown): boolean {
  if (v === undefined || v === null) return false
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') return v.trim() !== '' && v.trim() !== '0'
  return true
}

/** 解析单条消息：content 允许是字符串或 OpenAI 多模态数组。 */
function parseMessage(raw: unknown): DeepseekMessage {
  if (raw === null || typeof raw !== 'object') {
    return { role: '', content: '', contentParts: [], junkParts: 0, hasName: false }
  }
  const rec = raw as Record<string, unknown>
  const msg: DeepseekMessage = {
    role: typeof rec.role === 'string' ? rec.role : '',
    content: '',
    contentParts: [],
    junkParts: 0,
    hasName: junkPresent(rec.name),
  }
  const content = rec.content
  if (content === undefined || content === null) return msg
  if (typeof content === 'string') {
    msg.content = content
    return msg
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part === null || typeof part !== 'object') {
        msg.junkParts++
        continue
      }
      const p = part as Record<string, unknown>
      if (p.type === 'image_url' && p.image_url !== null && typeof p.image_url === 'object') {
        const url = (p.image_url as Record<string, unknown>).url
        msg.contentParts.push({ type: 'image_url', imageUrl: typeof url === 'string' ? url : '' })
        continue
      }
      if (p.type === 'text') {
        msg.contentParts.push({ type: 'text', text: typeof p.text === 'string' ? p.text : '' })
        continue
      }
      msg.junkParts++
    }
    return msg
  }
  throw new DeepseekRequestError('content must be a string or an array of content parts')
}

/** system 消息里真正有内容的部分：纯字符串优先，否则拼接 text 片段。 */
function systemText(m: DeepseekMessage): string {
  if (m.content !== '') return m.content
  return m.contentParts
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text as string)
    .join('\n')
}

/** 把合并后的 system 文本塞进第一条 user 消息；没有 user 就新建前导 user。 */
function mergeSystemBlocks(out: DeepseekMessage[], system: string): DeepseekMessage[] {
  for (let i = 0; i < out.length; i++) {
    if (out[i].role !== 'user') continue
    if (out[i].content !== '') {
      out[i] = { ...out[i], content: system + SYSTEM_MERGE_SEPARATOR + out[i].content }
    } else if (out[i].contentParts.length > 0) {
      out[i] = { ...out[i], content: system + SYSTEM_MERGE_SEPARATOR }
    } else {
      out[i] = { ...out[i], content: system }
    }
    return out
  }
  return [{ role: 'user', content: system, contentParts: [], junkParts: 0, hasName: false }, ...out]
}

/**
 * 消息级净化：合并 system、丢弃被剥空的 assistant/tool、统计 junk。
 * 返回存活消息与追加的 strip 报告条目。
 */
export function sanitizeMessages(
  msgs: DeepseekMessage[],
  stripped: string[],
): { messages: DeepseekMessage[]; stripped: string[] } {
  const systemBlocks: string[] = []
  let emptyToolCount = 0
  let junkPartCount = 0
  let nameCount = 0
  const out: DeepseekMessage[] = []

  for (const m of msgs) {
    if (m.role === 'system') {
      const text = systemText(m)
      if (text !== '') systemBlocks.push(text)
      continue
    }
    if ((m.role === 'assistant' || m.role === 'tool') && m.content === '' && m.contentParts.length === 0) {
      // 只剩 tool_calls 的 assistant 载体、或空的 tool 结果：剥离后什么都不剩，连消息一起丢。
      // 注意：user 消息即使内容为空也保留——它仍是轮次边界。
      emptyToolCount++
      continue
    }
    junkPartCount += m.junkParts
    if (m.hasName) nameCount++
    out.push(m)
  }

  let result = out
  const extra = [...stripped]
  if (systemBlocks.length > 0) {
    result = mergeSystemBlocks(out, systemBlocks.join('\n\n'))
    extra.push(`system_messages=${systemBlocks.length}`)
  }
  if (emptyToolCount > 0) extra.push(`tool_messages=${emptyToolCount}`)
  if (junkPartCount > 0) extra.push(`junk_content_parts=${junkPartCount}`)
  if (nameCount > 0) extra.push(`message_names=${nameCount}`)
  return { messages: result, stripped: extra }
}

/** `thinking` 开关：缺省 true（上游默认开思考），非法值报错。 */
export function parseThinkingSwitch(raw: unknown): boolean {
  if (raw === undefined || raw === null) return true
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DeepseekRequestError('invalid "thinking" field: expected {"type": "enabled"|"disabled"}')
  }
  const type = (raw as Record<string, unknown>).type
  if (typeof type !== 'string') {
    throw new DeepseekRequestError('invalid "thinking" field: expected {"type": "enabled"|"disabled"}')
  }
  if (type === 'enabled') return true
  if (type === 'disabled') return false
  throw new DeepseekRequestError(`invalid "thinking.type" "${type}": expected "enabled" or "disabled"`)
}

/** `search` 开关：缺省 false，非法值报错。 */
export function parseSearchSwitch(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DeepseekRequestError('invalid "search" field: expected {"type": "enabled"|"disabled"}')
  }
  const type = (raw as Record<string, unknown>).type
  if (typeof type !== 'string') {
    throw new DeepseekRequestError('invalid "search" field: expected {"type": "enabled"|"disabled"}')
  }
  if (type === 'enabled') return true
  if (type === 'disabled') return false
  throw new DeepseekRequestError(`invalid "search.type" "${type}": expected "enabled" or "disabled"`)
}

/**
 * 客户端是否显式要求「不要思考」。
 *
 * 上游的 thinking 是二值的（`thinking:{type:"enabled"|"disabled"}`，缺省开），而不同客户端用
 * **不同措辞**表达「关」：Anthropic 的 `thinking:{type:...}` 与 Responses 的 `reasoning.effort`
 * 在本仓都会被折成 `reasoning_effort`（见 `src/formats.ts`），所以两种写法都要认。
 *
 * `minimal` 也按「关」处理：上游没有中间档，取最省思考的一侧（与 Anthropic 分支同一取舍）。
 * 该函数同时被 `/v1/messages` 与 `/v1/responses` 两条分发点使用，避免两处口径漂移。
 */
export function isDeepseekReasoningOff(body: Record<string, unknown>): boolean {
  const direct = typeof body['reasoning_effort'] === 'string' ? body['reasoning_effort'] : ''
  const reasoning = body['reasoning']
  const nested =
    reasoning !== null && typeof reasoning === 'object'
      ? String((reasoning as Record<string, unknown>).effort ?? '')
      : ''
  return [direct, nested].some((v) =>
    ['none', 'off', 'disabled', 'minimal'].includes(String(v).trim().toLowerCase()),
  )
}

/** 客户端 `thinking` 字段的显式取值：'enabled' / 'disabled' / null（未表态或非法）。 */
function thinkingField(body: Record<string, unknown>): 'enabled' | 'disabled' | null {
  const thinking = body['thinking']
  if (thinking === null || typeof thinking !== 'object' || Array.isArray(thinking)) return null
  const type = (thinking as Record<string, unknown>).type
  return type === 'enabled' || type === 'disabled' ? type : null
}

/** 客户端是否**显式**要求思考（用于「显式声明 > provider 默认」的优先级判定）。 */
export function isDeepseekReasoningExplicitlyOn(body: Record<string, unknown>): boolean {
  if (thinkingField(body) === 'enabled') return true
  const direct = typeof body['reasoning_effort'] === 'string' ? body['reasoning_effort'] : ''
  const reasoning = body['reasoning']
  const nested =
    reasoning !== null && typeof reasoning === 'object'
      ? String((reasoning as Record<string, unknown>).effort ?? '')
      : ''
  // 非「关」的档位（low/medium/high/…）都是显式要求思考。
  return [direct, nested].some((v) => {
    const s = String(v).trim().toLowerCase()
    return s !== '' && !['none', 'off', 'disabled', 'minimal'].includes(s)
  })
}

/**
 * 解析「本次是否思考」，按 **客户端显式声明 > provider 默认 > 内置默认(开)** 排序。
 *
 * 为什么要 provider 默认：上游 `thinking_enabled` 缺省是开，思考期首字节明显更慢。
 * 轻量任务（翻译/改写/分类）希望整条 provider 默认走快路径，而不是要求每个客户端
 * 各自发 `thinking:{type:"disabled"}`。
 *
 * 为什么客户端显式「开」必须压过 provider 默认：否则用户勾了默认关思考后，
 * 就再也没法在个别请求上开思考——一个只能单向覆盖的开关等于把功能锁死。
 *
 * 注意：`thinking` 字段的合法性由 `parseDeepseekRequest` 里的 `parseThinkingSwitch`
 * 负责报错，这里只做优先级判定，不重复校验。
 */
export function resolveDeepseekThinking(
  body: Record<string, unknown>,
  providerDefaultOff: boolean | undefined,
): boolean {
  // 客户端显式关：thinking.type=disabled，或 reasoning_effort/reasoning.effort ∈ {none,off,disabled,minimal}
  if (thinkingField(body) === 'disabled' || isDeepseekReasoningOff(body)) return false
  // 客户端显式开：thinking.type=enabled，或非 none 的 reasoning 档位
  if (isDeepseekReasoningExplicitlyOn(body)) return true
  // 客户端未表态：provider 默认关思考则关，否则沿用上游内置默认（开）。
  return providerDefaultOff !== true
}

/** 解析并净化 `/v1/chat/completions` 请求体。 */export function parseDeepseekRequest(
  body: unknown,
  options: ParseOptions = {},
): ParsedDeepseekRequest {
  let raw: Record<string, unknown>
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new DeepseekRequestError('invalid JSON body: expected an object')
      }
      raw = parsed as Record<string, unknown>
    } catch (err) {
      if (err instanceof DeepseekRequestError) throw err
      throw new DeepseekRequestError(`invalid JSON body: ${(err as Error).message}`)
    }
  } else if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    raw = body as Record<string, unknown>
  } else {
    throw new DeepseekRequestError('invalid JSON body: expected an object')
  }

  const model = typeof raw.model === 'string' ? raw.model : ''
  if (options.enforceModel !== undefined && model !== options.enforceModel) {
    throw new DeepseekRequestError(
      `unknown model "${model}": this proxy serves "${options.enforceModel}" only`,
    )
  }

  const stripped = JUNK_FIELDS.filter((f) => junkPresent(raw[f])).map((f) => String(f))

  if (raw.messages !== undefined && !Array.isArray(raw.messages)) {
    throw new DeepseekRequestError('invalid messages: expected an array')
  }
  const parsedMessages = Array.isArray(raw.messages) ? raw.messages.map(parseMessage) : []
  const sanitized = sanitizeMessages(parsedMessages, stripped)

  if (sanitized.messages.length === 0) {
    if (sanitized.stripped.length > 0) {
      throw new DeepseekRequestError(
        'messages must not be empty (all messages were removed by sanitization: tool calls are not supported and system messages had no usable content)',
      )
    }
    throw new DeepseekRequestError('messages must not be empty')
  }

  const maxTokens = Math.max(
    typeof raw.max_tokens === 'number' ? raw.max_tokens : 0,
    typeof raw.max_completion_tokens === 'number' ? raw.max_completion_tokens : 0,
  )

  // thinking 字段本身必须先校验合法性（非法值报错，与 Go 版一致），
  // 再按优先级解析最终取值——校验与取值分开，避免非法值被默认值悄悄掩盖。
  parseThinkingSwitch(raw.thinking)

  return {
    model,
    messages: sanitized.messages,
    stream: raw.stream === true,
    temperature: typeof raw.temperature === 'number' ? raw.temperature : 0,
    topP: typeof raw.top_p === 'number' ? raw.top_p : 0,
    maxTokens,
    thinkingEnabled: resolveDeepseekThinking(raw, options.thinkingDefaultOff),
    searchEnabled: parseSearchSwitch(raw.search),
    stripped: sanitized.stripped,
  }
}

/**
 * 把消息数组摊平成上游要的**单一 prompt**：逐条 `role: content` 加换行。
 * system 与其它角色一样被标记，不做特殊注入。图片片段跳过（它们走 ref_file_ids）。
 */
export function flattenMessages(msgs: DeepseekMessage[]): string {
  let out = ''
  for (const m of msgs) {
    out += `${m.role}: `
    if (m.content !== '') out += m.content
    for (const p of m.contentParts) {
      if (p.type === 'text' && p.text) {
        if (!out.endsWith(': ')) out += '\n'
        out += p.text
      }
    }
    out += '\n'
  }
  return out
}

/**
 * 超长 prompt 前置校验：超限抛 `DeepseekPromptTooLongError`（→ 400 `context_length_exceeded`）。
 *
 * 计数口径与 Go 版一致：**JS 字符串长度**（UTF-16 code unit），不是字节数也不是码点数。
 * 这不是「精确的 token 预算」，而是一条远高于正常用量的护栏——它的职责是拦住病态请求，
 * 让客户端拿到可归因的 400，而不是把上游的模糊失败原样转成 502。
 */
export function assertPromptLength(prompt: string, limit = DEEPSEEK_MAX_PROMPT_CHARS): void {
  if (limit > 0 && prompt.length > limit) throw new DeepseekPromptTooLongError(prompt.length, limit)
}
