import { countPromptTokenClasses } from './models'

const MAX_METRIC_TOKENS = 1_000_000_000
const MAX_ACCOUNT_ID_LENGTH = 256
export const SLOW_REQUEST_OBSERVATION_MS = 45_000
export const SUCCESS_OBSERVATION_SAMPLE_DENOMINATOR = 64

export type RequestSemanticStatus = 'complete' | 'error' | 'cancel'

export interface RequestMetricInput {
  /** 内部生成的不透明 ID，用于让计数幂等。*/
  requestId: string
  /** 本次请求最终选中的账号；路由未开始时为空。*/
  accountId?: string | null
  /** 暴露给客户端的 HTTP 状态；SSE 错误可能仍为 200。*/
  status: number
  /** 协议级终态，与 HTTP 状态无关。*/
  semanticStatus?: RequestSemanticStatus
  /** 隐私安全的网关错误码，绝不使用上游消息。*/
  code?: string
  /** 到真实终态事件的端到端耗时，而非构造响应的时间。*/
  durationMs?: number
  tokenIn?: number
  tokenOut?: number
}

/**
 * 保留每一个失败/取消与慢请求，外加普通成功请求的确定性 1/N 采样
 * （移植自 M365-Gateway request-metrics.ts shouldRetainRequestObservation）。
 * 精确聚合计数在每次模型请求时都会更新；本判定只控制有界的明细环。
 * 采样避免正常流量过早耗尽 Workers 免费版 SQLite 行写入额度。
 */
export function shouldRetainRequestObservation(
  requestId: string,
  input: Pick<RequestMetricInput, 'status' | 'semanticStatus' | 'durationMs'>,
): boolean {
  if (input.status >= 400 || input.semanticStatus === 'error' || input.semanticStatus === 'cancel') return true
  if ((input.durationMs ?? 0) >= SLOW_REQUEST_OBSERVATION_MS) return true
  const compact = requestId.replaceAll('-', '')
  const tailByte = compact.slice(-2)
  if (!/^[0-9a-f]{2}$/iu.test(tailByte)) return false
  return Number.parseInt(tailByte, 16) % SUCCESS_OBSERVATION_SAMPLE_DENOMINATOR === 0
}

export interface RequestMetricSink {
  recordRequest(input: RequestMetricInput): Promise<unknown>
}

export interface RequestMetricTrackerOptions {
  /** 内部生成的不透明请求 ID。绝不要从 URL 派生。*/
  requestId: string
  sink: RequestMetricSink
  /** 请求处理实际开始的时间。*/
  startedAt?: number
  /** 可注入的时钟，便于确定性测试。*/
  now?: () => number
  /** 初始账号；后续重试可能替换它。*/
  accountId?: string | null
  /** 派发终态写入而不让响应等待存储。*/
  waitUntil?: (promise: Promise<void>) => void
  /** 常量回调，刻意不接收任何异常细节。*/
  onRecordError?: () => void
}

export interface RequestMetricTerminal {
  semanticStatus: RequestSemanticStatus
  /** 暴露给客户端的 HTTP 状态；SSE 失败通常仍为 HTTP 200。*/
  httpStatus: number
}

function boundedInteger(value: unknown, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.min(maximum, Math.trunc(value)))
}

function normalizedAccountId(value: string | null | undefined): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, MAX_ACCOUNT_ID_LENGTH)
}

function isHighSurrogate(value: string): boolean {
  if (!value) return false
  const code = value.charCodeAt(0)
  return code >= 0xd800 && code <= 0xdbff
}

/**
 * 网关保守提示词估算器的增量形式（移植自 M365-Gateway
 * request-metrics.ts IncrementalTokenEstimate）。只存储分类计数器与至多一个
 * UTF-16 高位代理，因此提示词、响应、凭据、邮件与工具结果文本都无法进入指标。
 */
export class IncrementalTokenEstimate {
  private asciiWordCharacters = 0
  private asciiSyntaxCharacters = 0
  private nonAsciiCharacters = 0
  private emojiCharacters = 0
  private pendingHighSurrogate = ''

  add(value: string): void {
    if (!value) return
    let input = this.pendingHighSurrogate + value
    this.pendingHighSurrogate = ''
    const last = input.at(-1) ?? ''
    if (isHighSurrogate(last)) {
      this.pendingHighSurrogate = last
      input = input.slice(0, -1)
    }
    const counts = countPromptTokenClasses(input)
    this.asciiWordCharacters += counts.asciiWordCharacters
    this.asciiSyntaxCharacters += counts.asciiSyntaxCharacters
    this.nonAsciiCharacters += counts.nonAsciiCharacters
    this.emojiCharacters += counts.emojiCharacters
  }

  value(): number {
    // 未配对的高位代理保守计费，但绝不保留在持久化指标记录中。
    const trailing = this.pendingHighSurrogate ? 1 : 0
    return Math.min(
      MAX_METRIC_TOKENS,
      Math.ceil(this.asciiWordCharacters / 4)
        + Math.ceil(this.asciiSyntaxCharacters / 2)
        + this.nonAsciiCharacters
        + this.emojiCharacters * 2
        + trailing,
    )
  }
}

/**
 * 每个逻辑 API 请求一个生命周期（移植自 M365-Gateway
 * request-metrics.ts RequestMetricTracker）。一次重试可能多次调用
 * `setAccountId`；只有第一次终态转换时快照最终选择。此后每次
 * complete/error/cancel 都是 no-op 并返回同一个持久化 promise。
 */
export class RequestMetricTracker {
  private readonly inputEstimate = new IncrementalTokenEstimate()
  private readonly outputEstimate = new IncrementalTokenEstimate()
  private readonly requestId: string
  private readonly sink: RequestMetricSink
  private readonly waitUntil: ((promise: Promise<void>) => void) | undefined
  private readonly onRecordError: (() => void) | undefined
  private readonly now: () => number
  private readonly startedAt: number
  private accountId: string
  private terminalPromise: Promise<void> | undefined
  private terminalValue: RequestSemanticStatus | undefined
  private failureCode = ''

  constructor(options: RequestMetricTrackerOptions) {
    this.requestId = options.requestId
    this.sink = options.sink
    this.waitUntil = options.waitUntil
    this.onRecordError = options.onRecordError
    this.now = options.now ?? Date.now
    const now = boundedInteger(this.now(), Number.MAX_SAFE_INTEGER)
    this.startedAt = options.startedAt == null
      ? now
      : boundedInteger(options.startedAt, Number.MAX_SAFE_INTEGER)
    this.accountId = normalizedAccountId(options.accountId)
  }

  /** 最近一次成功的路由选择生效，直到请求终结。*/
  setAccountId(accountId: string | null | undefined): void {
    if (this.terminalPromise) return
    this.accountId = normalizedAccountId(accountId)
  }

  observeInputText(value: string): void {
    if (!this.terminalPromise) this.inputEstimate.add(value)
  }

  observeOutputText(value: string): void {
    if (!this.terminalPromise) this.outputEstimate.add(value)
  }

  setFailureCode(value: string | null | undefined): void {
    if (this.terminalPromise || typeof value !== 'string') return
    const normalized = value.trim().toLowerCase()
    this.failureCode = /^[a-z][a-z0-9_]{0,63}$/u.test(normalized) ? normalized : 'upstream_error'
  }

  usage(): { input_tokens: number; output_tokens: number; total_tokens: number } {
    const input = this.inputEstimate.value()
    const output = this.outputEstimate.value()
    return { input_tokens: input, output_tokens: output, total_tokens: input + output }
  }

  get semanticStatus(): RequestSemanticStatus | undefined {
    return this.terminalValue
  }

  get settled(): Promise<void> | undefined {
    return this.terminalPromise
  }

  complete(httpStatus = 200): Promise<void> {
    return this.finish({ semanticStatus: 'complete', httpStatus })
  }

  error(httpStatus = 500): Promise<void> {
    return this.finish({ semanticStatus: 'error', httpStatus })
  }

  cancel(httpStatus = 499): Promise<void> {
    return this.finish({ semanticStatus: 'cancel', httpStatus })
  }

  finish(terminal: RequestMetricTerminal): Promise<void> {
    if (this.terminalPromise) return this.terminalPromise

    // 在创建/派发 promise 之前先设置终态标记：这正是并发
    // complete/error/cancel 恰好一次的原因。
    this.terminalValue = terminal.semanticStatus
    const endedAt = boundedInteger(this.now(), Number.MAX_SAFE_INTEGER)
    const metric: RequestMetricInput = {
      requestId: this.requestId,
      accountId: this.accountId || null,
      status: boundedInteger(terminal.httpStatus, 999),
      semanticStatus: terminal.semanticStatus,
      ...(this.failureCode ? { code: this.failureCode } : {}),
      durationMs: Math.max(0, endedAt - this.startedAt),
      tokenIn: this.inputEstimate.value(),
      tokenOut: this.outputEstimate.value(),
    }
    const persisted = Promise.resolve()
      .then(() => this.sink.recordRequest(metric))
      .then(() => undefined)
      .catch(() => {
        // 指标绝不能破坏或泄露用户请求的细节；回调同样刻意不含细节。
        try { this.onRecordError?.() } catch { /* 仅诊断 */ }
      })
    this.terminalPromise = persisted
    try { this.waitUntil?.(persisted) } catch {
      try { this.onRecordError?.() } catch { /* 仅诊断 */ }
    }
    return persisted
  }
}

/**
 * 包装一个流式响应而不在构造时标记完成（移植自 M365-Gateway
 * request-metrics.ts trackStreamingResponse）。自然 EOF、源失败与下游取消
 * 三者不同。若某协议先发出带内 SSE 错误再干净关闭，其 pump 必须在关闭前
 * 调用 `tracker.error(response.status)`；EOF 兜底会被终态幂等门安全忽略。
 */
export function trackStreamingResponse(response: Response, tracker: RequestMetricTracker): Response {
  if (!response.body) {
    void (response.ok ? tracker.complete(response.status) : tracker.error(response.status))
    return response
  }

  const reader = response.body.getReader()
  const monitored = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) {
          void tracker.complete(response.status)
          controller.close()
          return
        }
        controller.enqueue(next.value)
      } catch (cause) {
        void tracker.error(response.status)
        controller.error(cause)
      }
    },
    async cancel(reason) {
      void tracker.cancel(response.status)
      try { await reader.cancel(reason) } catch { /* 源已消失 */ }
    },
  })
  return new Response(monitored, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

/** 完成一个响应体已在内存中完全生成的响应。*/
export function trackBufferedResponse(response: Response, tracker: RequestMetricTracker): Response {
  void (response.ok ? tracker.complete(response.status) : tracker.error(response.status))
  return response
}
