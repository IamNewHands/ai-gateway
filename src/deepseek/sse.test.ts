/**
 * deepseek/sse.test.ts — 上游 SSE 解释器与 OpenAI 翻译的回归测试。
 *
 * 三份固件是 2026-09-30 从真实上游抓的完整流（thinking off / thinking on / search on）。
 * 其余用例是照着 `simple-chat/internal/sse/sse.go` 的分支构造的边界：跨块切行、裸增量
 * 结转、BATCH、hint 错误、content_filter、噪声路径、断流。
 */

import { describe, it, expect } from 'vitest'
import {
  DEEPSEEK_SSE_DONE,
  DeepseekSSEInterpreter,
  aggregateDeepseekSse,
  isNoisePath,
  openAIDeepseekChunk,
  openAIDeepseekError,
  type DeepseekDelta,
} from './sse'

const fs = (await import('node:fs' as string)) as {
  readFileSync: (path: string, encoding: string) => string
}

// vitest 的 cwd 是仓库根；不用 import.meta.url（workers-types 下没有该属性）
const FIXTURE_DIR = 'src/deepseek/__fixtures__/'

function fixture(name: string): string {
  return fs.readFileSync(`${FIXTURE_DIR}${name}`, 'utf8')
}

/** 用一个解释器跑完一段文本，返回状态与增量序列。 */
function run(raw: string) {
  const it = new DeepseekSSEInterpreter()
  const deltas: DeepseekDelta[] = []
  it.onDelta((d) => deltas.push(d))
  it.feed(raw)
  it.flush()
  return { state: it.snapshot(), deltas }
}

describe('real upstream fixtures', () => {
  it('plain (thinking off): single RESPONSE fragment, usage, clean finish', () => {
    const { state, deltas } = run(fixture('completion-plain.sse.txt'))
    expect(state.text).toBe('你好')
    expect(state.reasoning).toBe('')
    expect(state.totalTokens).toBe(38)
    expect(state.finished).toBe(true)
    expect(state.error).toBeNull()
    expect(state.searchResults).toEqual([])
    expect(deltas.map((d) => d.text).join('')).toBe('你好')
    expect(deltas.every((d) => d.reasoning === undefined)).toBe(true)
  })

  it('thinking on: THINK text goes to reasoning, RESPONSE to content, never mixed', () => {
    const { state, deltas } = run(fixture('completion-thinking.sse.txt'))
    expect(state.finished).toBe(true)
    expect(state.reasoning.length).toBeGreaterThan(0)
    expect(state.text.length).toBeGreaterThan(0)
    // 每条增量只带一个字段
    for (const d of deltas) {
      expect(Boolean(d.text) && Boolean(d.reasoning)).toBe(false)
    }
    // 累积量必须等于增量之和（没有丢字或重复计）
    expect(deltas.filter((d) => d.reasoning).map((d) => d.reasoning).join('')).toBe(state.reasoning)
    expect(deltas.filter((d) => d.text).map((d) => d.text).join('')).toBe(state.text)
  })

  it('search on: structured hits are collected and finish stays clean', () => {
    const { state } = run(fixture('completion-search.sse.txt'))
    expect(state.finished).toBe(true)
    expect(state.searchResults.length).toBeGreaterThan(0)
    const first = state.searchResults[0]
    expect(typeof first.url).toBe('string')
    expect(first.url.length).toBeGreaterThan(0)
    expect(typeof first.cite_index).toBe('number')
  })
})

describe('line buffering', () => {
  it('reassembles lines split at arbitrary byte boundaries', () => {
    const raw = fixture('completion-plain.sse.txt')
    const it = new DeepseekSSEInterpreter()
    let text = ''
    it.onDelta((d) => {
      text += d.text ?? ''
    })
    for (let i = 0; i < raw.length; i += 7) it.feed(raw.slice(i, i + 7))
    it.flush()
    expect(text).toBe('你好')
    expect(it.snapshot().finished).toBe(true)
  })

  it('tolerates CRLF line endings', () => {
    const raw = fixture('completion-plain.sse.txt').replace(/\n/g, '\r\n')
    expect(run(raw).state.text).toBe('你好')
  })
})

describe('patch semantics', () => {
  it('routes a bare delta (no p/o) to the current fragment kind', () => {
    const raw = [
      'data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"A"}]}}}',
      '',
      'data: {"v":"B"}',
      '',
      'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
      '',
    ].join('\n')
    const { state } = run(raw)
    expect(state.text).toBe('AB')
    expect(state.finished).toBe(true)
  })

  it('routes nested BATCH items and ignores BATCH noise', () => {
    const raw = [
      'data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":123},{"p":"quasi_status","v":"FINISHED"}]}',
      '',
    ].join('\n')
    const { state } = run(raw)
    expect(state.totalTokens).toBe(123)
    // quasi_status 是噪声：不得被当成正文，也不得提前结束
    expect(state.text).toBe('')
    expect(state.finished).toBe(false)
  })

  it('switches kind when a THINK fragment is appended', () => {
    const raw = [
      'data: {"v":{"response":{"fragments":[{"type":"THINK","content":"想"}]}}}',
      '',
      'data: {"v":"一"}',
      '',
      'data: {"p":"response/fragments","o":"APPEND","v":[{"type":"RESPONSE","content":"答"}]}',
      '',
      'data: {"v":"案"}',
      '',
      'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
      '',
    ].join('\n')
    const { state } = run(raw)
    expect(state.reasoning).toBe('想一')
    expect(state.text).toBe('答案')
  })

  it('accepts response/thinking_content and response/content paths', () => {
    const raw = [
      'data: {"p":"response/thinking_content","o":"APPEND","v":"沉思"}',
      '',
      'data: {"p":"response/content","o":"APPEND","v":"正文"}',
      '',
    ].join('\n')
    const { state } = run(raw)
    expect(state.reasoning).toBe('沉思')
    expect(state.text).toBe('正文')
  })

  it('treats [DONE] as a clean finish', () => {
    const { state } = run('data: [DONE]\n\n')
    expect(state.finished).toBe(true)
    expect(state.error).toBeNull()
  })

  it('filters noise paths', () => {
    for (const p of [
      'response/search_status',
      'response/fragments/-1/status',
      'response/fragments/-2/status',
      'response/quasi_status',
      'response/elapsed_secs',
      'response/token_usage',
      'response/has_pending_fragment',
      'response/conversation_mode',
    ]) {
      expect(isNoisePath(p)).toBe(true)
    }
    expect(isNoisePath('response/fragments/-1/content')).toBe(false)

    const raw = [
      'data: {"p":"response/quasi_status","o":"SET","v":"FINISHED"}',
      '',
      'data: {"p":"response/elapsed_secs","o":"SET","v":1.5}',
      '',
      'data: {"p":"response/fragments/-1/status","o":"SET","v":"FINISHED"}',
      '',
    ].join('\n')
    const { state } = run(raw)
    expect(state.text).toBe('')
    expect(state.finished).toBe(false)
  })
})

describe('error paths', () => {
  it('surfaces event: hint errors and flags the parallel limit', () => {
    const raw = [
      'event: hint',
      'data: {"type":"error","content":"another generation is running","clear_response":true,"finish_reason":"parallel_chat_limit"}',
      '',
    ].join('\n')
    const { state } = run(raw)
    expect(state.finished).toBe(true)
    expect(state.error?.isParallelLimit).toBe(true)
    expect(state.error?.content).toContain('another generation')
    expect(state.error?.clearResponse).toBe(true)
  })

  it('maps a content_filter code to the typed content-filter state', () => {
    const { state } = run('data: {"code":"content_filter"}\n\n')
    expect(state.contentFilter).toBe('content_filter')
    expect(state.error).toBeNull()
  })

  it('reports a generic data-level error', () => {
    const { state } = run('data: {"error":"boom"}\n\n')
    expect(state.error?.content).toContain('boom')
  })

  it('never fakes a stop when the stream is cut off', () => {
    const raw = [
      'data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"半句"}]}}}',
      '',
    ].join('\n')
    const { response, truncated } = aggregateDeepseekSse(raw, { id: 'x', model: 'deepseek-flash' })
    expect(truncated).toBe(true)
    // 断流时明确标 length，而不是谎报 stop
    expect(response.choices[0].finish_reason).toBe('length')
  })
})

describe('openai translation', () => {
  it('emits reasoning_content chunks and a final chunk with citations + usage', () => {
    const reasoning = openAIDeepseekChunk({ id: 'c1', model: 'deepseek-flash', reasoning: '想', role: 'assistant' })
    const content = openAIDeepseekChunk({ id: 'c1', model: 'deepseek-flash', content: '答' })
    const final = openAIDeepseekChunk({
      id: 'c1',
      model: 'deepseek-flash',
      finishReason: 'stop',
      citations: [{ url: 'https://x', title: 't', snippet: 's', cite_index: 1 }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    })

    const parse = (s: string) => JSON.parse(s.replace(/^data: /, '').trim())
    const r = parse(reasoning)
    expect(r.object).toBe('chat.completion.chunk')
    expect(r.choices[0].delta).toEqual({ role: 'assistant', reasoning_content: '想' })
    expect(r.choices[0].finish_reason).toBeNull()
    expect(parse(content).choices[0].delta).toEqual({ content: '答' })

    const f = parse(final)
    expect(f.choices[0].finish_reason).toBe('stop')
    expect(f.usage.total_tokens).toBe(30)
    expect(f.citations).toHaveLength(1)
    expect(f.citations[0].url).toBe('https://x')
  })

  it('has OpenAI-shaped error and done frames', () => {
    const err = JSON.parse(openAIDeepseekError('cut', 'upstream_interrupted', 'truncated').replace(/^data: /, '').trim())
    expect(err.error.type).toBe('upstream_interrupted')
    expect(err.error.code).toBe('truncated')
    expect(DEEPSEEK_SSE_DONE).toBe('data: [DONE]\n\n')
  })

  it('aggregates a search fixture into a non-stream response with citations', () => {
    const { response, truncated } = aggregateDeepseekSse(fixture('completion-search.sse.txt'), {
      id: 'x',
      model: 'deepseek-flash',
    })
    expect(truncated).toBe(false)
    expect(response.choices[0].finish_reason).toBe('stop')
    expect(response.choices[0].message.citations?.length).toBeGreaterThan(0)
    expect(response.usage.total_tokens).toBeGreaterThan(0)
  })
})
