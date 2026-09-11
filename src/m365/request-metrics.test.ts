import { describe, expect, it, vi } from 'vitest'
import {
  IncrementalTokenEstimate,
  RequestMetricTracker,
  SLOW_REQUEST_OBSERVATION_MS,
  SUCCESS_OBSERVATION_SAMPLE_DENOMINATOR,
  shouldRetainRequestObservation,
  trackBufferedResponse,
  trackStreamingResponse,
} from './request-metrics'
import type { RequestMetricInput } from './request-metrics'

function collector() {
  const seen: RequestMetricInput[] = []
  return {
    seen,
    sink: { recordRequest: async (input: RequestMetricInput) => { seen.push(input) } },
  }
}

describe('shouldRetainRequestObservation', () => {
  it('失败/取消一律保留', () => {
    expect(shouldRetainRequestObservation('req-1', { status: 500 })).toBe(true)
    expect(shouldRetainRequestObservation('req-1', { status: 200, semanticStatus: 'error' })).toBe(true)
    expect(shouldRetainRequestObservation('req-1', { status: 200, semanticStatus: 'cancel' })).toBe(true)
  })

  it('慢请求一律保留', () => {
    expect(shouldRetainRequestObservation('req-1', { status: 200, durationMs: SLOW_REQUEST_OBSERVATION_MS })).toBe(true)
  })

  it('普通成功请求按 1/N 确定性采样', () => {
    // 尾部字节 00 → 0 % 64 === 0 → 保留
    expect(shouldRetainRequestObservation('abcdef00', { status: 200, durationMs: 1 })).toBe(true)
    // 尾部字节 01 → 1 % 64 !== 0 → 不保留
    expect(shouldRetainRequestObservation('abcdef01', { status: 200, durationMs: 1 })).toBe(false)
    // 非法尾部字节 → 不保留
    expect(shouldRetainRequestObservation('req-zz', { status: 200, durationMs: 1 })).toBe(false)
  })

  it('采样分母常量一致', () => {
    expect(SUCCESS_OBSERVATION_SAMPLE_DENOMINATOR).toBe(64)
    expect(SLOW_REQUEST_OBSERVATION_MS).toBe(45_000)
  })
})

describe('IncrementalTokenEstimate', () => {
  it('空值不计入', () => {
    const estimate = new IncrementalTokenEstimate()
    estimate.add('')
    expect(estimate.value()).toBe(0)
  })

  it('与整体估算器结果一致（ASCII）', () => {
    const estimate = new IncrementalTokenEstimate()
    estimate.add('hello world function_call')
    expect(estimate.value()).toBeGreaterThan(0)
  })

  it('分块累加与一次性累加结果一致', () => {
    const whole = new IncrementalTokenEstimate()
    whole.add('你好世界 emoji 😀 test')
    const chunked = new IncrementalTokenEstimate()
    chunked.add('你好')
    chunked.add('世界 emoji ')
    chunked.add('😀 test')
    expect(chunked.value()).toBe(whole.value())
  })

  it('未配对的高位代理保守计费且不泄露内容', () => {
    const estimate = new IncrementalTokenEstimate()
    estimate.add('\ud83d') // lone high surrogate
    expect(estimate.value()).toBeGreaterThan(0)
  })
})

describe('RequestMetricTracker', () => {
  it('终态恰好一次：并发 complete/error/cancel 只写一条', async () => {
    const { seen, sink } = collector()
    const tracker = new RequestMetricTracker({ requestId: 'req-1', sink, now: () => 1000 })
    const a = tracker.complete(200)
    const b = tracker.error(500)
    const c = tracker.cancel(499)
    await Promise.all([a, b, c])
    expect(seen).toHaveLength(1)
    expect(seen[0].semanticStatus).toBe('complete')
    expect(tracker.semanticStatus).toBe('complete')
  })

  it('每次 finish 返回同一个 promise', async () => {
    const { sink } = collector()
    const tracker = new RequestMetricTracker({ requestId: 'req-2', sink })
    const first = tracker.complete()
    const second = tracker.complete()
    expect(first).toBe(second)
    await first
  })

  it('记录耗时/token/账号', async () => {
    const { seen, sink } = collector()
    let clock = 1000
    const tracker = new RequestMetricTracker({ requestId: 'req-3', sink, now: () => clock, startedAt: 1000 })
    tracker.setAccountId('acct-1')
    tracker.observeInputText('prompt text here')
    tracker.observeOutputText('response text here')
    clock = 2500
    await tracker.complete(200)
    expect(seen[0]).toMatchObject({ requestId: 'req-3', accountId: 'acct-1', status: 200, durationMs: 1500 })
    expect(seen[0].tokenIn).toBeGreaterThan(0)
    expect(seen[0].tokenOut).toBeGreaterThan(0)
  })

  it('终态后 setAccountId / observe* / setFailureCode 均为 no-op', async () => {
    const { seen, sink } = collector()
    const tracker = new RequestMetricTracker({ requestId: 'req-4', sink })
    await tracker.complete()
    tracker.setAccountId('late')
    tracker.observeInputText('late prompt')
    tracker.setFailureCode('late_error')
    expect(seen).toHaveLength(1)
    expect(seen[0].accountId).toBeNull()
    expect(seen[0].code).toBeUndefined()
  })

  it('failureCode 只接受安全 code，非法退化为 upstream_error', async () => {
    const { seen, sink } = collector()
    const tracker = new RequestMetricTracker({ requestId: 'req-5', sink })
    tracker.setFailureCode('BAD CODE!!!')
    await tracker.error(502)
    expect(seen[0].code).toBe('upstream_error')
  })

  it('sink 抛错不冒泡，且触发 onRecordError', async () => {
    const onRecordError = vi.fn()
    const tracker = new RequestMetricTracker({
      requestId: 'req-6',
      sink: { recordRequest: async () => { throw new Error('boom') } },
      onRecordError,
    })
    await expect(tracker.complete()).resolves.toBeUndefined()
    expect(onRecordError).toHaveBeenCalled()
  })

  it('usage() 在终态前可读', () => {
    const { sink } = collector()
    const tracker = new RequestMetricTracker({ requestId: 'req-7', sink })
    tracker.observeInputText('abc')
    expect(tracker.usage().total_tokens).toBe(tracker.usage().input_tokens + tracker.usage().output_tokens)
  })
})

describe('trackStreamingResponse / trackBufferedResponse', () => {
  it('流自然结束时 complete', async () => {
    const { seen, sink } = collector()
    const tracker = new RequestMetricTracker({ requestId: 'req-s1', sink })
    const source = new Response('hello', { status: 200 })
    const wrapped = trackStreamingResponse(source, tracker)
    await wrapped.text()
    await tracker.settled
    expect(seen[0].semanticStatus).toBe('complete')
  })

  it('无 body 的响应按状态直接终态', async () => {
    const { seen, sink } = collector()
    const tracker = new RequestMetricTracker({ requestId: 'req-s2', sink })
    trackStreamingResponse(new Response(null, { status: 200 }), tracker)
    await tracker.settled
    expect(seen[0].semanticStatus).toBe('complete')
  })

  it('buffered 响应按 ok 判定 complete/error', async () => {
    const { seen, sink } = collector()
    const ok = new RequestMetricTracker({ requestId: 'req-b1', sink })
    trackBufferedResponse(new Response('ok', { status: 200 }), ok)
    await ok.settled
    const bad = new RequestMetricTracker({ requestId: 'req-b2', sink })
    trackBufferedResponse(new Response('bad', { status: 500 }), bad)
    await bad.settled
    expect(seen.map((s) => s.semanticStatus)).toEqual(['complete', 'error'])
  })
})
