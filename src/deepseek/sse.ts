/**
 * deepseek/sse.ts — 上游 JSON-patch SSE → OpenAI 流式/非流式。
 *
 * 解释器逐条移植自 simple-chat `internal/sse/sse.go`（MIT），并用真实上游固件
 * （`__fixtures__/*.sse.txt`，2026-09-30 抓取）验证。
 *
 * 上游流形态（**不是** OpenAI 风格）：
 *  - `data:` 行承载 JSON-patch 操作 `{p, o, v}`：`p` 是路径、`o` 是操作（`SET`/`BATCH`/…）、
 *    `v` 是值；**省略 p/o 表示沿用上一次**，这是最容易写错的一点。
 *  - 首个 data 负载带完整响应快照 `{v:{response:{status, fragments:[{type, content}]}}}`。
 *  - 增量文本以 *逐字* 的裸字符串到达（`{"v":"你"}`，或
 *    `{"p":"response/fragments/-1/content","v":"你"}`），归属哪个片段由**上一次的片段
 *    type** 决定（`THINK` 走 reasoning，其余走 content）。
 *  - `event: close` 或 `{"p":"response/status","v":"FINISHED"}` 表示正常收尾；
 *    `event: hint` 承载流内错误（含 `finish_reason: parallel_chat_limit`）。
 *  - 大量噪声路径（`quasi_status` / `fragments/-N/status` / `elapsed_secs` …）必须丢弃，
 *    否则会被误当成正文。
 *
 * 诚实收尾（对齐本仓库在 trae 上的教训）：**只有**明确收到 close/FINISHED 才报
 * `finish_reason: "stop"`；流提前断掉时报 `upstream_interrupted` 错误帧，不谎报 stop。
 */

/** 结构化联网搜索结果（上游 SEARCH 片段的 results 数组元素）。 */
export interface DeepseekSearchResult {
  url: string
  title: string
  snippet: string
  site_name?: string
  site_icon?: string
  cite_index: number
  published_at?: number
  query_indexes?: number[]
  provider?: string | null
}

/** 一条增量：text 与 reasoning 互斥。 */
export interface DeepseekDelta {
  text?: string
  reasoning?: string
}

/** 上游流内错误（`event: hint`）。 */
export interface DeepseekStreamError {
  type: string
  content: string
  clearResponse: boolean
  finishReason: string
  /** `parallel_chat_limit`：同一账号已有并发生成，换号重试即可。 */
  isParallelLimit: boolean
}

/** 上游以 data 负载声明的内容过滤（映射为干净的 400 content_filter）。 */
export class DeepseekContentFilterError extends Error {
  constructor(detail: string) {
    super(`upstream: content_filter: ${detail}`)
    this.name = 'DeepseekContentFilterError'
  }
}

export interface DeepseekInterpreterState {
  text: string
  reasoning: string
  totalTokens: number
  finished: boolean
  error: DeepseekStreamError | null
  contentFilter: string | null
  searchResults: DeepseekSearchResult[]
  searchQueries: string[]
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** 噪声路径：上游的状态/用量/时间戳，绝不能被当成正文。 */
export function isNoisePath(path: string): boolean {
  if (path === 'response/search_status') return true
  if (path.startsWith('response/fragments/') && path.endsWith('/status')) return true
  return ['quasi_status', 'elapsed_secs', 'token_usage', 'pending_fragment', 'conversation_mode'].some((n) =>
    path.includes(n),
  )
}

/**
 * 上游 SSE 解释器。`feed()` 可被任意切分的字节块调用（按行缓冲），
 * 每产生一条增量就回调一次 `onDelta`。
 */
export class DeepseekSSEInterpreter {
  private buffer = ''
  private lastPath = ''
  private lastOp = ''
  private lastKind = 'RESPONSE'
  private lastEvent = ''
  private readonly state: DeepseekInterpreterState = {
    text: '',
    reasoning: '',
    totalTokens: 0,
    finished: false,
    error: null,
    contentFilter: null,
    searchResults: [],
    searchQueries: [],
  }

  private onDeltaFn: ((d: DeepseekDelta) => void) | null = null

  onDelta(fn: (d: DeepseekDelta) => void): void {
    this.onDeltaFn = fn
  }

  /** 喂入一段原始 SSE 文本（UTF-8 解码后）。 */
  feed(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const idx = this.buffer.indexOf('\n')
      if (idx < 0) break
      const line = this.buffer.slice(0, idx).replace(/\r$/, '')
      this.buffer = this.buffer.slice(idx + 1)
      this.handleLine(line)
    }
  }

  /** 流结束后调用：吃掉残行（上游正常以 `event: close` 收尾，一般不剩）。 */
  flush(): void {
    if (this.buffer.trim()) {
      const rest = this.buffer
      this.buffer = ''
      this.handleLine(rest)
    }
  }

  snapshot(): DeepseekInterpreterState {
    return {
      ...this.state,
      searchResults: [...this.state.searchResults],
      searchQueries: [...this.state.searchQueries],
    }
  }

  private fire(d: DeepseekDelta): void {
    this.onDeltaFn?.(d)
  }

  private handleLine(line: string): void {
    if (this.state.finished) return
    if (!line.startsWith('data:')) {
      if (line.startsWith('event:')) {
        this.lastEvent = line.slice('event:'.length).trim()
        if (this.lastEvent === 'close') this.state.finished = true
      }
      return
    }
    const data = line.slice('data:'.length).trim()
    if (!data) return
    if (data === '[DONE]') {
      this.state.finished = true
      return
    }

    let op: { p?: unknown; o?: unknown; v?: unknown; error?: unknown; code?: unknown }
    try {
      const parsed = JSON.parse(data)
      if (!isRecord(parsed)) return
      op = parsed
    } catch {
      return // 非 JSON 负载（如 update_session 的 data）——忽略
    }

    // `event: hint` 自带错误负载形状，与通用 error/code 字段不同。
    if (this.lastEvent === 'hint') {
      const hint = op as { type?: unknown; content?: unknown; clear_response?: unknown; finish_reason?: unknown }
      if (hint.type === 'error') {
        const finishReason = asString(hint.finish_reason) ?? ''
        this.state.error = {
          type: 'error',
          content: asString(hint.content) ?? '',
          clearResponse: Boolean(hint.clear_response),
          finishReason,
          isParallelLimit: finishReason === 'parallel_chat_limit',
        }
        this.state.finished = true
      }
      return
    }

    const errorText = typeof op.error === 'string' ? op.error : ''
    const codeText = typeof op.code === 'string' ? op.code : ''
    if (op.error !== undefined || codeText.toLowerCase() === 'content_filter') {
      const detail = errorText || codeText || 'unknown error'
      if (codeText.toLowerCase() === 'content_filter' || errorText.includes('content_filter')) {
        this.state.contentFilter = detail
        return
      }
      this.state.error = {
        type: 'error',
        content: `stream error: ${detail}`,
        clearResponse: false,
        finishReason: '',
        isParallelLimit: false,
      }
      return
    }

    if (op.v === undefined) return
    this.apply(asString(op.p) ?? '', asString(op.o) ?? '', op.v)
  }

  /**
   * 派发一条 patch。path/op 为空表示「沿用上一次」——但 **BATCH 不向无 path 的负载
   * 结转**：线上裸 `{"v":"…"}` 增量是片段正文（搜索模式下紧跟 response BATCH 出现过），
   * 因此它和别的裸增量一样走「初始响应」处理。
   */
  private apply(path: string, op: string, v: unknown): void {
    if (path) this.lastPath = path
    if (op) this.lastOp = op
    if (!path && !op) {
      this.applyInitialResponse(v)
      return
    }
    if (this.lastOp === 'BATCH' && !path) {
      this.applyInitialResponse(v)
      return
    }
    if (this.lastOp === 'BATCH') {
      this.applyBatch(v)
      return
    }
    if (this.lastPath === 'response/status') {
      this.applyStatus(v)
      return
    }
    this.applyPathValue(this.lastPath, v)
  }

  /** 首个完整响应快照，或（p/o 缺失时的）裸字符串增量。 */
  private applyInitialResponse(v: unknown): void {
    const bare = asString(v)
    if (bare !== null) {
      this.emitFragment(this.lastKind, bare)
      return
    }
    if (!isRecord(v) || !isRecord(v.response)) return
    const response = v.response
    const fragments = Array.isArray(response.fragments) ? response.fragments : []
    for (const frag of fragments) {
      if (!isRecord(frag)) continue
      const type = asString(frag.type) ?? ''
      this.lastKind = type.toUpperCase()
      this.emitFragment(type, asString(frag.content) ?? '')
      if (/^(SEARCH|TOOL_SEARCH)$/i.test(type) && Array.isArray(frag.queries)) {
        for (const q of frag.queries) {
          if (isRecord(q)) {
            const query = asString(q.query)
            if (query) this.state.searchQueries.push(query)
          }
        }
      }
    }
    const usage = response.accumulated_token_usage
    if (typeof usage === 'number' && usage > 0) this.state.totalTokens = usage
    const status = asString(response.status) ?? ''
    if (status.toUpperCase() === 'FINISHED') this.state.finished = true
  }

  private emitFragment(kind: string, content: string): void {
    if (!content) return
    if (/^(THINK|THINKING)$/i.test(kind)) {
      this.state.reasoning += content
      this.fire({ reasoning: content })
      return
    }
    this.state.text += content
    this.fire({ text: content })
  }

  private applyBatch(v: unknown): void {
    if (!Array.isArray(v)) return
    for (const item of v) {
      if (!isRecord(item)) continue
      switch (item.p) {
        case 'accumulated_token_usage':
          if (typeof item.v === 'number') this.state.totalTokens = item.v
          break
        case 'fragments':
          this.applyPathValue('response/fragments', item.v)
          break
        case 'results':
          this.applyPathValue('response/fragments/-1/results', item.v)
          break
        default:
          break // quasi_status / has_pending_fragment 等噪声
      }
    }
  }

  private applyStatus(v: unknown): void {
    const s = asString(v)
    if (s && s.trim().toUpperCase() === 'FINISHED') this.state.finished = true
  }

  private applyPathValue(path: string, v: unknown): void {
    if (isNoisePath(path)) return

    if (path === 'response/fragments/-1/results') {
      if (!Array.isArray(v)) return
      for (const item of v) {
        if (!isRecord(item)) continue
        const url = asString(item.url)
        const title = asString(item.title)
        if (url === null && title === null) continue
        this.state.searchResults.push({
          url: url ?? '',
          title: title ?? '',
          snippet: asString(item.snippet) ?? '',
          site_name: asString(item.site_name) ?? undefined,
          site_icon: asString(item.site_icon) ?? undefined,
          cite_index: typeof item.cite_index === 'number' ? item.cite_index : 0,
          published_at: typeof item.published_at === 'number' ? item.published_at : undefined,
          query_indexes: Array.isArray(item.query_indexes)
            ? item.query_indexes.filter((n): n is number => typeof n === 'number')
            : undefined,
          provider: asString(item.provider),
        })
      }
      return
    }

    if (path === 'response/fragments/-1/content' || path === 'response/content') {
      const s = asString(v)
      if (s !== null) this.emitFragment(this.lastKind, s)
      return
    }

    if (path === 'response/thinking_content') {
      const s = asString(v)
      if (s !== null) {
        this.state.reasoning += s
        this.fire({ reasoning: s })
      }
      return
    }

    if (path === 'response/fragments') {
      if (Array.isArray(v)) {
        for (const frag of v) {
          if (!isRecord(frag)) continue
          const type = asString(frag.type) ?? ''
          this.lastKind = type.toUpperCase()
          this.emitFragment(type, asString(frag.content) ?? '')
        }
        return
      }
      const bare = asString(v)
      if (bare !== null) this.emitFragment(this.lastKind, bare)
      return
    }
    // 其余路径（含噪声）忽略：只有片段正文路径会影响输出。
  }
}

// ===== OpenAI 侧输出 =====

export interface OpenAIDeepseekChunkOptions {
  id: string
  model: string
  content?: string
  reasoning?: string
  role?: string
  finishReason?: string | null
  citations?: DeepseekSearchResult[]
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
  created?: number
}

/** 构造一条 OpenAI 流式 chunk（含可选 reasoning_content / citations / usage）。 */
export function openAIDeepseekChunk(o: OpenAIDeepseekChunkOptions): string {
  const delta: Record<string, unknown> = {}
  if (o.role) delta.role = o.role
  if (o.reasoning) delta.reasoning_content = o.reasoning
  if (o.content) delta.content = o.content
  const payload: Record<string, unknown> = {
    id: o.id,
    object: 'chat.completion.chunk',
    created: o.created ?? Math.floor(Date.now() / 1000),
    model: o.model,
    choices: [{ index: 0, delta, finish_reason: o.finishReason ?? null }],
  }
  if (o.usage) payload.usage = o.usage
  if (o.citations && o.citations.length > 0) payload.citations = o.citations
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** OpenAI 风格的错误帧（诚实收尾用，不谎报 finish_reason）。 */
export function openAIDeepseekError(message: string, type: string, code = ''): string {
  return `data: ${JSON.stringify({ error: { message, type, code } })}\n\n`
}

export const DEEPSEEK_SSE_DONE = 'data: [DONE]\n\n'

/** 上游流提前结束（未收到 close/FINISHED）时的错误类型名。 */
export const DEEPSEEK_UPSTREAM_INTERRUPTED = 'upstream_interrupted'

/** 非流式聚合结果。 */
export interface DeepseekCompletion {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: Array<{
    index: number
    message: { role: 'assistant'; content: string; reasoning_content?: string; citations?: DeepseekSearchResult[] }
    finish_reason: string
  }>
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

/**
 * 把上游 SSE 全文聚合为一条 OpenAI 非流式响应。
 * 全文断流（无 close/FINISHED）时 finish_reason 记 `length` 会误导，故这里返回
 * `truncated` 标记交给调用方决定（与 trae 的 sawDone/truncated 教训一致）。
 */
export function aggregateDeepseekSse(
  raw: string,
  opts: { id: string; model: string },
): { response: DeepseekCompletion; state: DeepseekInterpreterState; truncated: boolean } {
  const it = new DeepseekSSEInterpreter()
  it.feed(raw)
  it.flush()
  const state = it.snapshot()
  const truncated = !state.finished && !state.error && !state.contentFilter

  const message: DeepseekCompletion['choices'][0]['message'] = {
    role: 'assistant',
    content: state.text,
  }
  if (state.reasoning) message.reasoning_content = state.reasoning
  if (state.searchResults.length > 0) message.citations = state.searchResults

  return {
    response: {
      id: opts.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: opts.model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: state.finished ? 'stop' : truncated ? 'length' : 'stop',
        },
      ],
      usage: {
        prompt_tokens: state.totalTokens,
        completion_tokens: state.totalTokens,
        total_tokens: state.totalTokens,
      },
    },
    state,
    truncated,
  }
}
