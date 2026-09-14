import { describe, it, expect, vi, afterEach } from 'vitest'
import { withSSEKeepAlive } from './opencode'

/**
 * P2-4 空闲监控断流：验证 withSSEKeepAlive 在上游长时间无数据时主动结束流（idle 兜底）。
 *
 * 池化的 WorkBuddy SSE 路径经 passthroughResponse 以 keepAliveMs=0 + idle 兜底包裹，
 * 本测试直接锁定 withSSEKeepAlive 的「上游挂死 → 超过 idleTimeoutMs 触发流关闭」机制，
 * 这是该项能力生效的核心（proxy.ts passthroughResponse 的 idle guard 复用同函数）。
 */

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('withSSEKeepAlive idle 兜底（P2-4 空闲监控断流）', () => {
  it('上游发出首帧后永久挂起：超过 idleTimeoutMs 主动结束流', async () => {
    vi.useFakeTimers()

    // 上游源：只发一帧后永久挂起（不 close）—— 模拟真实上游长思考/挂死
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: ping\n\n'))
      },
      cancel() { /* ignore */ },
    })

    // keepAliveMs=0（不注入心跳，对齐 passthroughResponse 的 idle guard）
    const guarded = withSSEKeepAlive(source, 0, 180_000)
    const reader = guarded.getReader()
    const enc = new TextDecoder()

    // 首帧应能读到
    const first = await reader.read()
    expect(first.done).toBe(false)
    expect(enc.decode(first.value)).toContain('ping')

    // 持续推进空闲定时器：超过 idleTimeoutMs（180s）→ 流应被主动 close。
    let closed: boolean | null = null
    const readUntilClose = (async () => {
      while (true) {
        const { done, value } = await reader.read()
        if (done) { closed = true; return 'eof' }
        if (!value) continue
      }
    })()

    // 先推进一段（未到阈值），确认流仍开着
    await vi.advanceTimersByTimeAsync(179_000)
    await Promise.resolve()
    expect(closed).toBeNull()

    // 越过阈值 → idle 触发流关闭
    await vi.advanceTimersByTimeAsync(2_000)
    const result = await readUntilClose
    expect(result).toBe('eof')
    expect(closed).toBe(true)
  })
})