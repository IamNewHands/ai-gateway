/**
 * deepseek/stream.test.ts — 流包装与收尾诚实性测试（固件驱动 + 合成异常路径）。
 */

import { describe, it, expect } from 'vitest'
import { deepseekSSEToOpenAIStream, drainStream, stringToStream } from './stream'

const fs = (await import('node:fs' as string)) as {
  readFileSync: (path: string, encoding: string) => string
}

const fixture = (name: string) => fs.readFileSync(`src/deepseek/__fixtures__/${name}`, 'utf8')

interface Frame {
  id?: string
  object?: string
  choices?: Array<{ index: number; delta: Record<string, unknown>; finish_reason: string | null }>
  usage?: { total_tokens: number }
  citations?: Array<{ url: string }>
  error?: { message: string; type: string; code: string }
}

/** 把 OpenAI SSE 文本拆成帧数组（尾部空行忽略）。 */
function frames(text: string): Frame[] {
  return text
    .split('\n\n')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('data: ') && s !== 'data: [DONE]')
    .map((s) => JSON.parse(s.slice(6)) as Frame)
}

async function run(raw: string, opts: Partial<{ idleTimeoutMs: number; model: string }> = {}) {
  const out = await drainStream(
    deepseekSSEToOpenAIStream(stringToStream(raw), {
      id: 'chatcmpl-test',
      model: opts.model ?? 'deepseek-flash',
      idleTimeoutMs: opts.idleTimeoutMs,
    }),
  )
  return { text: out, frames: frames(out), hasDone: out.endsWith('data: [DONE]\n\n') }
}

describe('fixture-driven streaming', () => {
  it('plain: role chunk → content → finish(stop) + usage + [DONE]', async () => {
    const { text, frames: f, hasDone } = await run(fixture('completion-plain.sse.txt'))
    expect(hasDone).toBe(true)

    const first = f[0]
    expect(first.object).toBe('chat.completion.chunk')
    expect(first.choices?.[0].delta.role).toBe('assistant')
    expect(first.choices?.[0].delta.content).toBe('你好')

    const content = f
      .map((x) => x.choices?.[0].delta.content)
      .filter((c): c is string => typeof c === 'string')
      .join('')
    expect(content).toBe('你好')

    const last = f[f.length - 1]
    expect(last.choices?.[0].finish_reason).toBe('stop')
    expect(last.usage?.total_tokens).toBe(38)
    // 每帧都必须是 chat.completion.chunk
    expect(f.every((x) => x.object === 'chat.completion.chunk')).toBe(true)
    expect(text).not.toContain('upstream_interrupted')
  })

  it('thinking: reasoning_content arrives before content and never mixes', async () => {
    const { frames: f } = await run(fixture('completion-thinking.sse.txt'))
    const reasoningIdx = f.findIndex((x) => typeof x.choices?.[0].delta.reasoning_content === 'string')
    const contentIdx = f.findIndex((x) => typeof x.choices?.[0].delta.content === 'string')
    expect(reasoningIdx).toBeGreaterThanOrEqual(0)
    expect(contentIdx).toBeGreaterThan(reasoningIdx)

    for (const x of f) {
      const d = x.choices?.[0].delta ?? {}
      expect(Boolean(d.reasoning_content) && Boolean(d.content)).toBe(false)
    }
    expect(f[f.length - 1].choices?.[0].finish_reason).toBe('stop')
  })

  it('search: citations ride the final chunk', async () => {
    const { frames: f } = await run(fixture('completion-search.sse.txt'))
    const last = f[f.length - 1]
    expect(last.choices?.[0].finish_reason).toBe('stop')
    expect(Array.isArray(last.citations)).toBe(true)
    expect((last.citations ?? []).length).toBeGreaterThan(0)
    expect(typeof last.citations?.[0].url).toBe('string')
  })
})

describe('honest termination', () => {
  it('truncated upstream yields upstream_interrupted and no fake stop', async () => {
    const raw = 'data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"半句"}]}}}\n\n'
    const { text, frames: f } = await run(raw)
    const last = f[f.length - 1]
    expect(last.error?.type).toBe('upstream_interrupted')
    expect(text).toContain('data: [DONE]')
    // 不得出现 finish_reason: stop
    expect(f.some((x) => x.choices?.[0].finish_reason === 'stop')).toBe(false)
  })

  it('maps event: hint parallel_chat_limit to a typed error frame', async () => {
    const raw = [
      'event: hint',
      'data: {"type":"error","content":"another generation is running","finish_reason":"parallel_chat_limit"}',
      '',
    ].join('\n')
    const { frames: f, text } = await run(raw)
    expect(f[0].error?.type).toBe('parallel_chat_limit')
    expect(text).toContain('data: [DONE]')
  })

  it('maps content_filter to invalid_request_error / content_filter', async () => {
    const { frames: f } = await run('data: {"code":"content_filter"}\n\n')
    expect(f[0].error?.type).toBe('invalid_request_error')
    expect(f[0].error?.code).toBe('content_filter')
  })

  it('reports an idle upstream instead of hanging', async () => {
    // 一个永不产出的流：只 enqueue 一段不含换行的半行，然后保持打开
    const encoder = new TextEncoder()
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"v":"半'))
      },
    })
    const info: Array<{ ok: boolean; reason: string }> = []
    const out = await drainStream(
      deepseekSSEToOpenAIStream(upstream, {
        id: 'c',
        model: 'deepseek-flash',
        idleTimeoutMs: 60,
        onFinish: (i) => info.push({ ok: i.ok, reason: i.reason }),
      }),
    )
    expect(out).toContain('upstream_idle_timeout')
    expect(out).toContain('data: [DONE]')
    expect(info).toEqual([{ ok: false, reason: 'idle_timeout' }])
  })

  it('invokes onFinish exactly once with the terminal reason', async () => {
    const calls: string[] = []
    await drainStream(
      deepseekSSEToOpenAIStream(stringToStream(fixture('completion-plain.sse.txt')), {
        id: 'c',
        model: 'deepseek-flash',
        onFinish: (i) => calls.push(i.reason),
      }),
    )
    expect(calls).toEqual(['stop'])
  })
})

describe('robustness', () => {
  it('handles upstream chunks split mid-line and mid-multibyte-character', async () => {
    const raw = fixture('completion-plain.sse.txt')
    const bytes = new TextEncoder().encode(raw)
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        // 每次 3 字节，必然切在 UTF-8 字符或行中间
        for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3))
        controller.close()
      },
    })
    const out = await drainStream(deepseekSSEToOpenAIStream(upstream, { id: 'c', model: 'deepseek-flash' }))
    const content = frames(out)
      .map((x) => x.choices?.[0].delta.content)
      .filter((c): c is string => typeof c === 'string')
      .join('')
    expect(content).toBe('你好')
    expect(out).toContain('"finish_reason":"stop"')
  })
})
