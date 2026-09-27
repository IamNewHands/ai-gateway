/**
 * chatWithHandlers 端到端回归：引用标记剥离必须在**所有外发通道**生效。
 *
 * 这些用例直接驱动真实的 chatWithHandlers（假 WebSocket + 假 fetch 拨号），
 * 覆盖单测覆盖不到、且实现时真实出过 bug 的三条路径：
 * 1. writeAtCursor 无基线 → 走 emitSnapshot 时的**重复剥离**（会把正文吞掉）
 * 2. finalizeText 用 final 补尾部 → final 带标记时经 onDelta **绕过**剥离器
 * 3. onEvent 推理事件 → 直接外发未剥离文本
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { chatWithHandlers } from './chathub'
import type { ChatHubAccount } from './chathub'

const RS = '\x1e'
const OPEN = '\uE200cite\uE202'
const CLOSE = '\uE201'
const mark = (id: string) => OPEN + id + CLOSE

/** 假出站 WebSocket：记录 send、可注入 message/close 事件 */
class FakeWS {
  listeners = new Map<string, ((ev: Record<string, unknown>) => void)[]>()
  sent: string[] = []
  accepted = false
  closed = false

  accept(): void { this.accepted = true }
  addEventListener(type: string, cb: (ev: Record<string, unknown>) => void): void {
    const arr = this.listeners.get(type) ?? []
    arr.push(cb)
    this.listeners.set(type, arr)
  }
  send(data: string): void { this.sent.push(data) }
  close(): void { this.closed = true }
  emit(type: string, ev: Record<string, unknown>): void {
    for (const cb of this.listeners.get(type) ?? []) cb(ev)
  }
  message(text: string): void { this.emit('message', { data: text }) }
}

let ws: FakeWS

beforeEach(() => {
  ws = new FakeWS()
  // 拨号：返回 101 + webSocket；握手后由测试注入帧
  vi.stubGlobal('fetch', vi.fn(async () => ({
    status: 101,
    webSocket: ws,
    headers: new Headers(),
    text: async () => '',
  })))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const ACCOUNT: ChatHubAccount = { accessToken: 'tok', oid: 'oid-1', tid: 'tid-1' }

/**
 * 跑一次对话：等握手完成后注入 update/complete 帧。
 * 返回 { text, reasoning, deltas, events }，deltas 是实际流式外发的片段。
 */
async function run(frames: string[]): Promise<{
  text: string
  reasoning: string
  deltas: string[]
  reasoningEvents: string[]
}> {
  const deltas: string[] = []
  const reasoningEvents: string[] = []

  const promise = chatWithHandlers(
    ACCOUNT,
    { text: 'hi', started: true },
    { timeoutMs: 5000, readTimeoutMs: 5000 },
    (d) => deltas.push(d),
    (ev) => { if (ev.kind === 'reasoning' && ev.text) reasoningEvents.push(ev.text) },
  )

  // 等握手请求发出（dialAndHandshake 先发 SignalR 握手）
  for (let i = 0; i < 50 && ws.sent.length === 0; i++) await new Promise((r) => setTimeout(r, 5))
  ws.message(`{}${RS}`)          // 握手响应
  for (let i = 0; i < 50 && ws.sent.length < 2; i++) await new Promise((r) => setTimeout(r, 5))
  for (const f of frames) ws.message(f)

  const res = await promise
  return { text: res.text, reasoning: res.reasoning, deltas, reasoningEvents }
}

const updateFrame = (messages: unknown[]): string =>
  JSON.stringify({ type: 1, target: 'update', arguments: [{ messages }] }) + RS

const chatMsg = (text: string) => ({ author: 'bot', messageType: 'Chat', text })

describe('chatWithHandlers 端到端：引用标记不得出现在任何外发通道', () => {
  it('普通快照正文里的标记被剥离（不泄漏给 onDelta）', async () => {
    const out = await run([
      updateFrame([chatMsg(`答案是 42。${mark('turn1search2')} 更多内容。`)]),
      JSON.stringify({ type: 3 }) + RS,
    ])
    expect(out.text).toBe('答案是 42。 更多内容。')
    expect(out.deltas.join('')).not.toContain('\uE200')
    expect(out.deltas.join('')).not.toContain('\uE201')
    expect(out.deltas.join('')).toBe('答案是 42。 更多内容。')
  })

  it('标记跨两个 writeAtCursor 增量片到达 → 不泄漏、正文不丢', async () => {
    // writeAtCursor 是纯增量通道（HAR 05），半标记跨片是这里的真实形态
    const out = await run([
      JSON.stringify({ type: 1, target: 'update', arguments: [{ writeAtCursor: `hello ${OPEN}turn0` }] }) + RS,
      JSON.stringify({ type: 1, target: 'update', arguments: [{ writeAtCursor: `search1${CLOSE} world` }] }) + RS,
      JSON.stringify({ type: 3 }) + RS,
    ])
    const all = out.deltas.join('')
    expect(all).not.toContain('\uE200')
    expect(all).not.toContain('\uE201')
    expect(all).toBe('hello  world')
  })

  it('累计快照（每帧都是全文）不因跨帧状态而重复正文', async () => {
    // 快照语义：第二帧是第一帧的完整超集，剥离后必须仍能前缀对齐
    const out = await run([
      updateFrame([chatMsg(`hello ${OPEN}turn0`)]),
      updateFrame([chatMsg(`hello ${OPEN}turn0search1${CLOSE} world`)]),
      JSON.stringify({ type: 3 }) + RS,
    ])
    const all = out.deltas.join('')
    expect(all).not.toContain('\uE200')
    expect(all).toBe('hello  world')
    expect(out.text).toBe('hello  world')
  })

  it('writeAtCursor 首片无基线 → 走 emitSnapshot 也不重复剥离（回归：正文被吞）', async () => {
    // 首片 writeAtCursor 带标记；实现若先剥离再调 emitSnapshot，会二次剥离并吞掉正文
    const out = await run([
      JSON.stringify({ type: 1, target: 'update', arguments: [{ writeAtCursor: `开头${mark('turn1search1')}结尾` }] }) + RS,
      JSON.stringify({ type: 3 }) + RS,
    ])
    const all = out.deltas.join('')
    expect(all).toBe('开头结尾')
    expect(out.text).toBe('开头结尾')
  })

  it('writeAtCursor 多片（有基线）剥离标记且不吞正文', async () => {
    const out = await run([
      JSON.stringify({ type: 1, target: 'update', arguments: [{ writeAtCursor: 'AAA' }] }) + RS,
      JSON.stringify({ type: 1, target: 'update', arguments: [{ writeAtCursor: `BBB${mark('turn1search3')}CCC` }] }) + RS,
      JSON.stringify({ type: 3 }) + RS,
    ])
    expect(out.deltas.join('')).toBe('AAABBBCCC')
    expect(out.text).toBe('AAABBBCCC')
  })

  it('final 消息带标记时，补发的尾部也不泄漏（finalizeText 路径）', async () => {
    // 流式只给前半，final 更长且带标记 → finalizeText 会把尾部经 onDelta 补发
    const out = await run([
      updateFrame([chatMsg('前半')]),
      JSON.stringify({ type: 2, item: { result: { value: 'Success', message: `前半后半${mark('turn1file1')}` } } }) + RS,
      JSON.stringify({ type: 3 }) + RS,
    ])
    expect(out.text).toBe('前半后半')
    expect(out.deltas.join('')).toBe('前半后半')
    expect(out.deltas.join('')).not.toContain('\uE200')
  })

  it('推理事件经 onEvent 外发时已剥离（回归：绕过剥离器）', async () => {
    const out = await run([
      updateFrame([{ author: 'bot', contentOrigin: 'ChainOfThoughtSummary', text: `推理${mark('turn1search4')}内容` }]),
      updateFrame([chatMsg('答案')]),
      JSON.stringify({ type: 3 }) + RS,
    ])
    expect(out.reasoningEvents.join('')).not.toContain('\uE200')
    expect(out.reasoningEvents.join('')).toBe('推理内容')
    expect(out.reasoning).toBe('推理内容')
  })

  it('type=7 干净关闭路径同样剥离', async () => {
    // type=7 要求已有 finalText 或工具事件才算正常完成
    const out = await run([
      updateFrame([chatMsg('答案')]),
      JSON.stringify({ type: 2, item: { result: { value: 'Success', message: `答案${mark('turn1search5')}` } } }) + RS,
      JSON.stringify({ type: 7 }) + RS,
    ])
    expect(out.text).toBe('答案')
    expect(out.deltas.join('')).not.toContain('\uE200')
  })

  it('上游把标记截断（未闭合）时丢弃残段，不吐半个控制字符', async () => {
    const out = await run([
      updateFrame([chatMsg('正文')]),
      updateFrame([chatMsg(`${OPEN}turn9`)]),
      JSON.stringify({ type: 3 }) + RS,
    ])
    expect(out.deltas.join('')).toBe('正文')
    expect(out.text).toBe('正文')
  })
})
