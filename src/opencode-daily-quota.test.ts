import { describe, it, expect, beforeEach } from 'vitest'
import {
  __resetOpenCodeKeyHealthForTests,
  OPENCODE_DAILY_QUOTA_RETRY_AFTER_MS,
  proxyOpenCodeRequest,
} from './opencode'

/**
 * 429 的两种语义必须分开（2026-11-16 实测）：
 * - 短时限流：Retry-After 小，重试有意义；
 * - 日配额耗尽：Retry-After ≈ 38000s（resetAt 恒为当日 23:59:59Z），13 个免费模型共享同一配额池，
 *   重试、换 key、60s 熔断全是白等，唯一有用的信息是「几点重置」。
 */

const enc = new TextEncoder()
const BASE = 'https://opencode.ai/zen/v1'
const MIRROR = 'https://mirror.example.com/zen/v1'

interface RecordedCall {
  url: string
  authorization: string
}

function makeFetcher(handler: (call: RecordedCall, index: number) => Response) {
  const calls: RecordedCall[] = []
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    const call: RecordedCall = {
      url: String(url),
      authorization: headers.get('Authorization') ?? '',
    }
    calls.push(call)
    return handler(call, calls.length - 1)
  }) as unknown as typeof fetch
  return { fetcher, calls }
}

function quota429(retryAfterSeconds: number): Response {
  return new Response(JSON.stringify({
    type: 'error',
    error: {
      type: 'FreeUsageLimitError',
      message: 'Free usage limit reached. Free models work in OpenCode',
    },
  }), {
    status: 429,
    headers: {
      'Content-Type': 'application/json',
      'Retry-After': String(retryAfterSeconds),
    },
  })
}

function sseResponse(frames: string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const f of frames) c.enqueue(enc.encode(f))
        c.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  )
}

const DONE_FRAMES = [
  'data: {"id":"c1","model":"big-pickle","choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: [DONE]\n',
]

const FREE_BODY = JSON.stringify({ model: 'big-pickle', stream: true, messages: [{ role: 'user', content: 'hi' }] })

function call(overrides: Record<string, unknown>) {
  return proxyOpenCodeRequest({
    baseUrl: BASE,
    apiKeys: [{ key: 'key-aaaa', enabled: true }, { key: 'key-bbbb', enabled: true }],
    mirrorUrls: [],
    method: 'POST',
    subPath: 'chat/completions',
    body: FREE_BODY,
    ...overrides,
  } as Parameters<typeof proxyOpenCodeRequest>[0])
}

beforeEach(() => {
  __resetOpenCodeKeyHealthForTests()
})

describe('429 日配额耗尽：跳过重试 / 换 key / 熔断', () => {
  it('Retry-After 超过阈值 → 只打一次上游，不重试不换 key', async () => {
    const { fetcher, calls } = makeFetcher(() => quota429(38000))
    const res = await call({ fetcher })
    expect(calls.length).toBe(1)
    expect(res.status).toBe(429)
  })

  it('把重置时刻透出：Retry-After 头 + X-OpenCode-Quota-Reset + 错误体 quota 字段', async () => {
    const { fetcher } = makeFetcher(() => quota429(38000))
    const res = await call({ fetcher })
    const retryAfter = Number(res.headers.get('Retry-After'))
    expect(retryAfter).toBeGreaterThan(37000)
    const resetIso = res.headers.get('X-OpenCode-Quota-Reset')
    expect(resetIso).toBeTruthy()
    expect(Date.parse(resetIso as string)).toBeGreaterThan(Date.now())
    const payload = await res.json() as {
      error: { message: string, type: string }
      quota: { exhausted: boolean, resetAt: string, retryAfterSeconds: number }
    }
    expect(payload.quota.exhausted).toBe(true)
    expect(payload.quota.resetAt).toBe(resetIso)
    expect(payload.quota.retryAfterSeconds).toBe(retryAfter)
    // 上游原文必须保留，否则日志里认不出是 FreeUsageLimitError
    expect(payload.error.message).toContain('Free usage limit reached')
    expect(payload.error.message).toContain('日配额')
    expect(payload.error.type).toBe('FreeUsageLimitError')
  })

  it('日配额生效期间下一次请求不再打官方通道（连探测都不做）', async () => {
    const first = makeFetcher(() => quota429(38000))
    await call({ fetcher: first.fetcher })
    expect(first.calls.length).toBe(1)

    const second = makeFetcher(() => sseResponse(DONE_FRAMES))
    const res = await call({ fetcher: second.fetcher })
    expect(second.calls.length).toBe(0)
    expect(res.status).toBe(429)
    expect(res.headers.get('X-OpenCode-Quota-Reset')).toBeTruthy()
  })

  it('日配额期间仍然优先走镜像（镜像成功就正常返回）', async () => {
    const first = makeFetcher(() => quota429(38000))
    await call({ fetcher: first.fetcher })

    const second = makeFetcher(() => sseResponse(DONE_FRAMES))
    const res = await call({ fetcher: second.fetcher, mirrorUrls: [MIRROR] })
    expect(res.status).toBe(200)
    expect(second.calls.length).toBe(1)
    expect(second.calls[0].url).toContain('mirror.example.com')
  })

  it('镜像回日配额 429 也透出重置时刻（官方无失败时）', async () => {
    const { fetcher, calls } = makeFetcher(() => quota429(38000))
    const res = await call({ fetcher, apiKeys: [], mirrorUrls: [MIRROR] })
    expect(calls.length).toBe(1)
    expect(res.status).toBe(429)
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(37000)
  })
})

describe('429 短时限流：保持原有重试语义', () => {
  // 短时限流路径带真实 sleep（每个 key 1200+2400ms，key 间隔 800ms），故放宽超时
  it('Retry-After 小于阈值 → 仍然对同一 key 重试', async () => {
    const { fetcher, calls } = makeFetcher(() => quota429(5))
    const res = await call({ fetcher })
    // 2 个 key 各「首次 + 2 次限流重试」= 6 次；说明日配额短路没有误伤短时限流
    expect(calls.length).toBe(6)
    expect(res.status).toBe(429)
    expect(res.headers.get('X-OpenCode-Quota-Reset')).toBeNull()
  }, 20000)

  it('阈值常量与实测日配额同量级（300s）', () => {
    expect(OPENCODE_DAILY_QUOTA_RETRY_AFTER_MS).toBe(300000)
  })
})
