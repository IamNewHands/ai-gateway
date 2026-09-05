import { describe, it, expect } from 'vitest'
import { socketReader, DEFAULT_MAX_QUEUED_SOCKET_CHARS, DEFAULT_MAX_FRAME_CHARS } from './chathub'

/** 最小假 WS：收集监听器、记录 close 调用（避免引入全局 WebSocket polyfill） */
class FakeSocket {
  listeners = new Map<string, ((ev: Record<string, unknown>) => void)[]>()
  closes: Array<{ code?: number; reason?: string }> = []

  addEventListener(type: string, cb: (ev: Record<string, unknown>) => void): void {
    const arr = this.listeners.get(type) ?? []
    arr.push(cb)
    this.listeners.set(type, arr)
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason })
  }

  message(data: string | ArrayBuffer): void {
    for (const cb of this.listeners.get('message') ?? []) cb({ data })
  }

  closeEvent(code = 1000, reason = ''): void {
    for (const cb of this.listeners.get('close') ?? []) cb({ code, reason })
  }

  errorEvent(): void {
    for (const cb of this.listeners.get('error') ?? []) cb({})
  }
}

const makeReader = (limits?: Parameters<typeof socketReader>[1]) => {
  const fake = new FakeSocket()
  const reader = socketReader(fake as unknown as WebSocket, limits)
  return { fake, ...reader }
}

describe('socketReader（B socketReader 有界读取器移植）', () => {
  it('上限常量对齐 B（队列 2M 字符、单帧 1.5M 字符）', () => {
    expect(DEFAULT_MAX_QUEUED_SOCKET_CHARS).toBe(2_000_000)
    expect(DEFAULT_MAX_FRAME_CHARS).toBe(1_500_000)
  })

  it('正常帧按 FIFO 入队并被 next 依序读取', async () => {
    const { fake, next } = makeReader()
    fake.message('a')
    fake.message('bb')
    const r1 = await next()
    expect(r1.msg).toBe('a')
    const r2 = await next()
    expect(r2.msg).toBe('bb')
  })

  it('有等待者时直接交付不占队列', async () => {
    const { fake, next } = makeReader()
    const p = next()
    fake.message('direct')
    const r = await p
    expect(r.msg).toBe('direct')
  })

  it('单帧超过上限 → WS_FRAME_TOO_LARGE + 主动 close(1009)，文本在解码后拒绝', async () => {
    const { fake, next } = makeReader({ maxFrameChars: 10 })
    fake.message('x'.repeat(11))
    const r = await next()
    expect(r.err?.message).toContain('WS_FRAME_TOO_LARGE')
    expect(fake.closes).toEqual([{ code: 1009, reason: 'frame too large' }])
  })

  it('二进制帧超过上限在解码前拒绝', async () => {
    const { fake, next } = makeReader({ maxFrameChars: 10 })
    const buf = new TextEncoder().encode('x'.repeat(11)).buffer as ArrayBuffer
    fake.message(buf)
    const r = await next()
    expect(r.err?.message).toContain('WS_FRAME_TOO_LARGE')
    expect(r.err?.message).toContain('bytes')
    expect(fake.closes).toEqual([{ code: 1009, reason: 'frame too large' }])
  })

  it('首终因保留：超限错误先于 close 事件的泛化错误送达', async () => {
    const { fake, next } = makeReader({ maxFrameChars: 10 })
    fake.message('x'.repeat(11))
    fake.closeEvent(1009, 'frame too large') // 我们自己的 close 触发的 close 事件
    const r1 = await next()
    expect(r1.err?.message).toContain('WS_FRAME_TOO_LARGE')
    const r2 = await next()
    expect(r2.err?.message).toContain('ws closed')
  })

  it('队列积压超过上限 → WS_BUFFER_TOO_LARGE + close(1009)，积压清空', async () => {
    const { fake, next } = makeReader({ maxQueuedChars: 100 })
    fake.message('x'.repeat(60))
    fake.message('x'.repeat(60)) // 120 > 100 → 超限
    const r = await next()
    expect(r.err?.message).toContain('WS_BUFFER_TOO_LARGE')
    expect(fake.closes).toEqual([{ code: 1009, reason: 'buffer too large' }])
    // 积压被清空：下一个读到 close 错误（close 事件随后触发）或 already closed
    fake.closeEvent(1009, 'buffer too large')
    const r2 = await next()
    expect(r2.err?.message).toContain('ws closed')
  })

  it('消费后释放配额：满队列→读→再 push 成功', async () => {
    const { fake, next } = makeReader({ maxQueuedChars: 100 })
    fake.message('x'.repeat(90))
    fake.message('y'.repeat(90)) // 超限，清空
    await next() // 取出 buffer 错误
    fake.closeEvent(1009) // 清理 close 状态
    // 重新建一个（closed 后 push 被丢弃）——本用例改用未 close 的场景
    const { fake: fake2, next: next2 } = makeReader({ maxQueuedChars: 100 })
    fake2.message('x'.repeat(60))
    expect((await next2()).msg).toBe('x'.repeat(60)) // 消费释放 60
    fake2.message('y'.repeat(50)) // 50 < 100 → 成功入队
    expect((await next2()).msg).toBe('y'.repeat(50))
    expect(fake2.closes).toEqual([])
  })

  it('closed 后 next 返回 already closed，push 被丢弃', async () => {
    const { fake, next } = makeReader()
    fake.closeEvent(1000, 'normal')
    const r = await next()
    expect(r.err?.message).toBe('ws closed: code=1000 reason=normal')
    const r2 = await next()
    expect(r2.err?.message).toBe('ws already closed')
  })

  it('error 事件兜底 ws error，close 事件随后补充', async () => {
    const { fake, next } = makeReader()
    fake.errorEvent()
    fake.closeEvent(1006, 'abnormal')
    expect((await next()).err?.message).toBe('ws error')
    expect((await next()).err?.message).toContain('ws closed: code=1006')
  })
})
