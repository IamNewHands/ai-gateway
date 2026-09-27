import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { handleProxyWebSocket } from '../ws'
import { clearCache } from '../storage'
import type { AppEnv, Env, Provider } from '../types'

/**
 * WS 桥接的 analytics 回归测试。
 *
 * 背景：ws.ts 直接调 forwardProxy，绕过了 handleProxy 的 finalizeProxyResponse，
 * 因此 WS 桥接的流量此前一条都不进 Analytics Engine（与 /v1/messages、/v1/responses
 * 属同一类缺口）。这里用最小 WebSocketPair polyfill 跑真实 handleProxyWebSocket，
 * 断言 usage 与渠道归属都落到 writeDataPoint。
 */

/** 最小 WebSocketPair：server 侧收集 send 内容并支持手动派发 message 事件。 */
function installWebSocketPair() {
  const sent: string[] = []
  const listeners: Record<string, Array<(ev: any) => void>> = {}
  const server = {
    accept() { /* no-op */ },
    send(data: string) { sent.push(data) },
    close() { /* no-op */ },
    addEventListener(type: string, fn: (ev: any) => void) {
      (listeners[type] ||= []).push(fn)
    },
  }
  const client = {}
  ;(globalThis as any).WebSocketPair = function () { return { 0: client, 1: server } }
  return {
    sent,
    async dispatchMessage(data: string) {
      for (const fn of listeners['message'] || []) {
        await fn({ data })
      }
    },
  }
}

/** Response status 101 在 Node 下不可构造（RangeError），这里放行 101 专供本测试。 */
function installStatus101Response() {
  const RealResponse = globalThis.Response
  const Patched = function (body?: any, init?: any) {
    if (init && init.status === 101) {
      const headers = new Headers(init.headers || {})
      const r = new RealResponse(null, { status: 200, headers })
      Object.defineProperty(r, 'status', { value: 101 })
      return r
    }
    return new RealResponse(body, init)
  } as unknown as typeof Response
  Patched.json = RealResponse.json.bind(RealResponse)
  Patched.redirect = RealResponse.redirect.bind(RealResponse)
  Patched.error = RealResponse.error.bind(RealResponse)
  globalThis.Response = Patched
  return () => { globalThis.Response = RealResponse }
}

const SOLO_SSE = [
  'event: output',
  'data: {"response":"hi"}',
  '',
  'event: token_usage',
  'data: {"prompt_tokens":19635,"completion_tokens":47,"total_tokens":19682,"cache_read_input_tokens":19584}',
  '',
  'event: done',
  'data: {"finish_reason":"stop"}',
  '',
  '',
].join('\n')

function traeProvider(): Provider {
  return {
    id: 'trae',
    name: 'TRAE WS',
    baseUrl: 'https://trae-api-cn.mchost.guru',
    apiType: 'openai',
    apiKeys: [{
      key: JSON.stringify({
        uid: 'u_ws', token: 'tok_ws', refreshToken: 'ref_ws',
        expiresAt: Date.now() + 3600_000,
      }),
      enabled: true,
    }],
    models: [{ id: 'deepseek-v4.1-flash', enabled: true }],
    enabled: true,
  } as unknown as Provider
}

function makeEnv(providers: Provider[]) {
  const store = new Map<string, string>()
  store.set('providers', JSON.stringify(providers))
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v) },
    delete: async (k: string) => { store.delete(k) },
    list: async () => ({ keys: [], list_complete: true, cursor: '' }),
  }
  const points: any[] = []
  const env = {
    KV: kv, GATEWAY_KV: kv, RATE_LIMIT_KV: kv, SESSION_KV: kv,
    USAGE_ANALYTICS: { writeDataPoint: (dp: any) => { points.push(dp) } },
    USAGE_ANALYTICS_DATASET: 'ai_gateway_usage',
  } as unknown as Env
  const app = new Hono<AppEnv>()
  app.get('/v1/chat/completions', (c) => handleProxyWebSocket(c))
  return {
    points,
    async connect() {
      const req = new Request('https://gw.test/v1/chat/completions', {
        method: 'GET',
        headers: { Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' },
      })
      return app.fetch(req, env, {
        waitUntil: () => {}, passThroughOnException: () => {},
      } as unknown as ExecutionContext)
    },
  }
}

describe('WS 桥接 analytics：usage 与渠道归属必须落到数据点', () => {
  const originalFetch = globalThis.fetch
  let restoreResponse: () => void

  beforeEach(() => {
    clearCache()
    restoreResponse = installStatus101Response()
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    restoreResponse()
    delete (globalThis as any).WebSocketPair
  })

  it('WS 流式请求写一条数据点，含 usage 与 trae 归属', async () => {
    globalThis.fetch = vi.fn(async (url: any) => {
      if (String(url).includes('/api/agent/v3/llm_utils_chat')) {
        return new Response(SOLO_SSE, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      }
      return new Response('not found', { status: 404 })
    }) as any

    const ws = installWebSocketPair()
    const h = makeEnv([traeProvider()])
    const resp = await h.connect()
    expect(resp.status).toBe(101)

    await ws.dispatchMessage(JSON.stringify({
      model: 'trae/deepseek-v4.1-flash',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }))

    // 客户端确实收到了转写后的 SSE（证明链路真的跑通，不是空跑）
    const forwarded = ws.sent.join('')
    expect(forwarded).toContain('chat.completion.chunk')

    expect(h.points.length).toBe(1)
    const blobs = h.points[0].blobs
    const doubles = h.points[0].doubles
    expect(blobs[2]).toBe('trae')                    // providerId
    expect(blobs[3]).toBe('TRAE WS')                 // providerName
    expect(blobs[5]).toBe('trae/deepseek-v4.1-flash') // requestedModel
    expect(blobs[6]).toBe('deepseek-v4.1-flash')     // upstreamModel
    expect(blobs[7]).toBe('success')
    expect(doubles[0]).toBe(19635)                   // promptTokens
    expect(doubles[1]).toBe(47)                      // completionTokens
    expect(doubles[2]).toBe(19584)                   // cachedTokens
    expect(doubles[3]).toBe(19682)                   // totalTokens
  })

  it('上游无响应体时写 failure（不静默丢事件）', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 200 })) as any

    const ws = installWebSocketPair()
    const h = makeEnv([traeProvider()])
    await h.connect()
    await ws.dispatchMessage(JSON.stringify({
      model: 'trae/deepseek-v4.1-flash',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }))

    expect(h.points.length).toBe(1)
    expect(h.points[0].blobs[7]).toBe('failure')
  })
})
