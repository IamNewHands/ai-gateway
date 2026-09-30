/**
 * deepseek/stream.ts — 上游补全流 → OpenAI SSE 响应体（含 idle 看门狗）。
 *
 * 分工：`sse.ts` 负责「上游字节 → text/reasoning/usage/citations 语义」，
 * 这里只负责「语义 → OpenAI SSE 帧 + 流生命周期」。所有收尾都是**诚实**的：
 *  - 明确收到上游 close/FINISHED → `finish_reason: "stop"` + usage + citations；
 *  - 上游流被截断 → `upstream_interrupted` 错误帧（**不**补一个假的 stop）；
 *  - 上游 hint 错误（如 `parallel_chat_limit`）→ 带类型名的错误帧；
 *  - 内容过滤 → `content_filter` 错误帧；
 *  - 静默超时 → `upstream_idle_timeout` 错误帧并主动断开（对齐 Go 版 180s 空闲窗口）。
 */

import {
  DEEPSEEK_SSE_DONE,
  DEEPSEEK_UPSTREAM_INTERRUPTED,
  DeepseekSSEInterpreter,
  openAIDeepseekChunk,
  openAIDeepseekError,
  type DeepseekInterpreterState,
} from './sse'

/** 上游静默多久算死（与 Go 版 `StreamIdleTimeout` 一致）。 */
export const DEEPSEEK_STREAM_IDLE_TIMEOUT_MS = 180_000

export interface DeepseekStreamOptions {
  id: string
  model: string
  /** 静默窗口（ms）。默认 180s。 */
  idleTimeoutMs?: number
  /** 流结束（正常或异常）后的回调，用于日志/用量统计。 */
  onFinish?: (info: { state: DeepseekInterpreterState; ok: boolean; reason: string }) => void
}

class IdleTimeoutError extends Error {
  constructor(ms: number) {
    super(`upstream idle for ${ms}ms`)
    this.name = 'IdleTimeoutError'
  }
}

/** 给一次读取套上静默窗口。 */
async function readWithIdle<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new IdleTimeoutError(ms)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 把上游 SSE 体转成 OpenAI SSE 体。返回的流永不抛错给调用方：上游的任何异常都会
 * 变成一条错误帧后正常结束，这样客户端至少能拿到结构化失败而不是半个响应。
 */
export function deepseekSSEToOpenAIStream(
  upstream: ReadableStream<Uint8Array>,
  opts: DeepseekStreamOptions,
): ReadableStream<Uint8Array> {
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEEPSEEK_STREAM_IDLE_TIMEOUT_MS
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  const interpreter = new DeepseekSSEInterpreter()
  const pending: string[] = []
  let roleSent = false
  let finished = false

  interpreter.onDelta((d) => {
    if (!roleSent) {
      roleSent = true
      pending.push(
        openAIDeepseekChunk({
          id: opts.id,
          model: opts.model,
          role: 'assistant',
          reasoning: d.reasoning,
          content: d.text,
        }),
      )
      return
    }
    if (d.reasoning) pending.push(openAIDeepseekChunk({ id: opts.id, model: opts.model, reasoning: d.reasoning }))
    else if (d.text) pending.push(openAIDeepseekChunk({ id: opts.id, model: opts.model, content: d.text }))
  })

  const reader = upstream.getReader()

  const finalize = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    if (finished) return
    finished = true
    const state = interpreter.snapshot()
    const emit = (s: string) => controller.enqueue(encoder.encode(s))

    if (state.contentFilter) {
      emit(openAIDeepseekError(`upstream rejected the prompt (content_filter): ${state.contentFilter}`, 'invalid_request_error', 'content_filter'))
      opts.onFinish?.({ state, ok: false, reason: 'content_filter' })
    } else if (state.error) {
      const type = state.error.isParallelLimit ? 'parallel_chat_limit' : 'upstream_error'
      emit(openAIDeepseekError(state.error.content, type, state.error.finishReason || type))
      opts.onFinish?.({ state, ok: false, reason: type })
    } else if (state.finished) {
      emit(
        openAIDeepseekChunk({
          id: opts.id,
          model: opts.model,
          finishReason: 'stop',
          citations: state.searchResults.length > 0 ? state.searchResults : undefined,
          usage: {
            prompt_tokens: state.totalTokens,
            completion_tokens: state.totalTokens,
            total_tokens: state.totalTokens,
          },
        }),
      )
      opts.onFinish?.({ state, ok: true, reason: 'stop' })
    } else {
      // 上游没给 close/FINISHED：这是截断，不能谎报 stop。
      emit(
        openAIDeepseekError(
          'upstream stream ended without a completion signal',
          DEEPSEEK_UPSTREAM_INTERRUPTED,
          'truncated',
        ),
      )
      opts.onFinish?.({ state, ok: false, reason: DEEPSEEK_UPSTREAM_INTERRUPTED })
    }
    emit(DEEPSEEK_SSE_DONE)
    controller.close()
    reader.cancel().catch(() => undefined)
  }

  let upstreamSettled = false

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        // 关键约束：pull **必须**在返回前 enqueue 至少一块或 close。返回时既不产出
        // 也不结束，底层不会再次调用 pull（实测会直接卡死消费者），所以这里用循环
        // 一直读到有东西可发或上游结算为止。
        for (;;) {
          if (pending.length > 0) {
            for (const chunk of pending.splice(0)) controller.enqueue(encoder.encode(chunk))
            if (upstreamSettled) finalize(controller)
            return
          }
          if (upstreamSettled) {
            finalize(controller)
            return
          }

          const { value, done } = await readWithIdle(reader.read(), idleTimeoutMs)
          if (done) {
            interpreter.flush()
            upstreamSettled = true
            continue
          }
          interpreter.feed(decoder.decode(value, { stream: true }))
          const state = interpreter.snapshot()
          if (state.finished || state.error || state.contentFilter) upstreamSettled = true
        }
      } catch (err) {
        const isIdle = err instanceof IdleTimeoutError
        const state = interpreter.snapshot()
        controller.enqueue(
          encoder.encode(
            openAIDeepseekError(
              isIdle ? `upstream sent no data for ${idleTimeoutMs}ms` : String((err as Error).message ?? err),
              isIdle ? 'upstream_idle_timeout' : 'upstream_error',
              isIdle ? 'idle_timeout' : 'stream_error',
            ),
          ),
        )
        controller.enqueue(encoder.encode(DEEPSEEK_SSE_DONE))
        finished = true
        opts.onFinish?.({ state, ok: false, reason: isIdle ? 'idle_timeout' : 'stream_error' })
        controller.close()
        reader.cancel().catch(() => undefined)
      }
    },
    cancel() {
      reader.cancel().catch(() => undefined)
    },
  })
}

/** 测试/调试便利：把字符串当成上游流。 */
export function stringToStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })
}

/** 把 OpenAI SSE 体读成字符串（测试用）。 */
export async function drainStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let out = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
  }
  return out
}
