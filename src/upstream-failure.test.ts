import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { handleAnthropicMessages, handleProxy } from './proxy'
import { proxyOpenCodeRequest } from './opencode'
import { clearCache } from './storage'
import { withEmptyBodyDiagnosis, UPSTREAM_EMPTY_ERROR_TYPE, UPSTREAM_EMPTY_HEADER } from './upstream-failure'
import type { AppEnv, Env, Provider } from './types'

/**
 * 上游「静默失败」的两处修复：
 *  1. opencode 上游返回非 2xx 且响应体为空时，补可诊断 JSON（2026-10-21 DSH 报
 *     `404 status code (no body)` 就是空体原样透传）；
 *  2. `/v1/messages`（Anthropic 入口）缺少 opencode 分派，无 Key 的 opencode 会
 *     误报 500 `Provider "OpenCode" has no enabled API keys`——同一模型走
 *     `/v1/chat/completions` 却是 200。
 */

function sseStream(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(enc.encode(line))
      controller.close()
    },
  })
}

function openAiSse(model: string, content = 'hello'): Response {
  return new Response(sseStream([
    `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"${model}","choices":[{"index":0,"delta":{"role":"assistant","content":"${content}"},"finish_reason":null}]}\n\n`,
    `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"${model}","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`,
    'data: [DONE]\n\n',
  ]), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

describe('withEmptyBodyDiagnosis：空体才有诊断体，非空原样返回', () => {
  it('空体失败 → 换成 JSON 诊断体，状态码保持上游原值', async () => {
    const upstream = new Response('', { status: 404 })
    const out = await withEmptyBodyDiagnosis(upstream, {
      status: 404, model: 'deepseek-v4.1-flash-free', keysTried: 0, mirrors: 0, lane: 'mirror',
    })
    expect(out.status).toBe(404)
    expect(out.headers.get('Content-Type')).toContain('application/json')
    expect(out.headers.get(UPSTREAM_EMPTY_HEADER)).toBe('404')
    const payload = await out.json() as { error: Record<string, unknown> }
    expect(payload.error['type']).toBe(UPSTREAM_EMPTY_ERROR_TYPE)
    expect(payload.error['upstream_status']).toBe(404)
    expect(payload.error['model']).toBe('deepseek-v4.1-flash-free')
    expect(payload.error['keys_tried']).toBe(0)
    expect(payload.error['mirrors']).toBe(0)
    expect(String(payload.error['hint'])).toContain('镜像')
  })

  it('非空失败 → 原样返回，且原响应体未被消费', async () => {
    const upstream = new Response('{"error":{"message":"model is unavailable"}}', {
      status: 403, headers: { 'Content-Type': 'application/json' },
    })
    const out = await withEmptyBodyDiagnosis(upstream, { status: 403, model: 'm' })
    expect(out).toBe(upstream)
    expect(await out.text()).toBe('{"error":{"message":"model is unavailable"}}')
  })

  it('成功响应 → 直接返回（不触碰 body）', async () => {
    const upstream = new Response('{"ok":true}', { status: 200 })
    const out = await withEmptyBodyDiagnosis(upstream, { status: 200, model: 'm' })
    expect(out).toBe(upstream)
  })

  it('上游给了 Retry-After → 保留（限流信息不丢）', async () => {
    const upstream = new Response('', { status: 429, headers: { 'Retry-After': '7' } })
    const out = await withEmptyBodyDiagnosis(upstream, { status: 429, model: 'm' })
    expect(out.headers.get('Retry-After')).toBe('7')
  })
})

describe('opencode 出口：上游空体被补成可诊断体', () => {
  it('所有 key/镜像都 404 空体 → 返回 JSON 诊断而不是空体', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 404 })) as unknown as typeof fetch
    const res = await proxyOpenCodeRequest({
      baseUrl: 'https://opencode.ai/zen/v1',
      apiKeys: [{ key: 'k-1', enabled: true }],
      mirrorUrls: ['https://mirror.example/zen/v1'],
      method: 'POST',
      subPath: 'chat/completions',
      body: JSON.stringify({ model: 'deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'hi' }] }),
      fetcher,
    })
    expect(res.status).toBe(404)
    expect(res.headers.get(UPSTREAM_EMPTY_HEADER)).toBe('404')
    const payload = await res.json() as { error: Record<string, unknown> }
    expect(payload.error['type']).toBe(UPSTREAM_EMPTY_ERROR_TYPE)
    expect(payload.error['model']).toBe('deepseek-v4.1-flash-free')
  })

  it('上游有错误体 → 逐字保留，不改写成诊断体', async () => {
    const body = '{"error":{"type":"FreeTierError","message":"quota"}}'
    const fetcher = vi.fn(async () => new Response(body, { status: 403, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch
    const res = await proxyOpenCodeRequest({
      baseUrl: 'https://opencode.ai/zen/v1',
      apiKeys: [{ key: 'k-1', enabled: true }],
      mirrorUrls: [],
      method: 'POST',
      subPath: 'chat/completions',
      body: JSON.stringify({ model: 'big-pickle', messages: [{ role: 'user', content: 'hi' }] }),
      fetcher,
    })
    expect(res.headers.get(UPSTREAM_EMPTY_HEADER)).toBeNull()
    expect(await res.text()).toBe(body)
  })
})

describe('/v1/messages：opencode 无 Key 不再误报 configuration_error', () => {
  let env: Env

  function makeEnv(providers: Provider[]): Env {
    const store = new Map<string, string>()
    store.set('providers', JSON.stringify(providers))
    const kv = {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => { store.set(k, v) },
      delete: async (k: string) => { store.delete(k) },
      list: async () => ({ keys: [], list_complete: true, cursor: '' }),
    }
    return { KV: kv, GATEWAY_KV: kv, RATE_LIMIT_KV: kv, SESSION_KV: kv } as unknown as Env
  }

  function opencodeNoKeys(): Provider {
    return {
      id: 'opencode', name: 'OpenCode', baseUrl: 'https://opencode.ai/zen/v1', apiType: 'openai',
      apiKeys: [], models: [{ id: 'deepseek-v4.1-flash-free', enabled: true }], enabled: true,
      createdAt: 'a', updatedAt: 'a',
    } as Provider
  }

  beforeEach(() => {
    clearCache()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  async function postMessages(payload: Record<string, unknown>) {
    const app = new Hono<AppEnv>()
    app.post('/v1/messages', (c) => handleAnthropicMessages(c))
    const req = new Request('https://gw.test/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext)
  }

  it('opencode 无 Key（走 public 镜像）→ 不再 500 no enabled API keys', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => openAiSse('deepseek-v4.1-flash-free')))
    env = makeEnv([opencodeNoKeys()])
    ;(env as unknown as Record<string, unknown>).OPENCODE_MIRRORS_URL = 'https://mirror.example/zen/v1'

    const res = await postMessages({
      model: 'opencode/deepseek-v4.1-flash-free',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(res.status).toBe(200)
    const payload = await res.json() as Record<string, unknown>
    // Anthropic 形态（而非 OpenAI 的 object: chat.completion）
    expect(payload['type']).toBe('message')
    expect(String(JSON.stringify(payload))).toContain('hello')
  })

  it('非 opencode 提供商无 Key → 仍按原口径报 configuration_error', async () => {
    env = makeEnv([{
      id: 'plain', name: 'Plain', baseUrl: 'https://plain.example/v1', apiType: 'openai',
      apiKeys: [], models: [{ id: 'm1', enabled: true }], enabled: true, createdAt: 'a', updatedAt: 'a',
    } as Provider])

    const res = await postMessages({ model: 'plain/m1', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(500)
    const payload = await res.json() as { error: Record<string, unknown> }
    expect(payload.error['type']).toBe('configuration_error')
  })

  it('/v1/messages 也应用提供商级 UA 覆写（Anthropic 入口同口径）', async () => {
    const calls: Array<Record<string, string>> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const raw = (init?.headers ?? {}) as Record<string, string>
      const headers: Record<string, string> = {}
      for (const k of Object.keys(raw)) headers[k.toLowerCase()] = String(raw[k])
      calls.push(headers)
      return openAiSse('m1')
    }))
    env = makeEnv([{
      id: 'agentrouter', name: 'agentrouter', baseUrl: 'https://ps.air-outer.com/v1', apiType: 'openai',
      apiKeys: [{ key: 'sk-x', enabled: true }], models: [{ id: 'm1', enabled: true }], enabled: true,
      upstreamUserAgent: 'claude-cli/2.0.1 (external, cli)', createdAt: 'a', updatedAt: 'a',
    } as Provider])

    const res = await postMessages({ model: 'agentrouter/m1', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(200)
    expect(calls[0]['user-agent']).toBe('claude-cli/2.0.1 (external, cli)')
  })
})

describe('chat 入口回归：opencode 分派未受影响', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('/v1/chat/completions 仍走 opencode 专用路径并 200', async () => {
    const store = new Map<string, string>()
    store.set('providers', JSON.stringify([{
      id: 'opencode', name: 'OpenCode', baseUrl: 'https://opencode.ai/zen/v1', apiType: 'openai',
      apiKeys: [], models: [{ id: 'deepseek-v4.1-flash-free', enabled: true }], enabled: true,
      createdAt: 'a', updatedAt: 'a',
    }]))
    const kv = {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => { store.set(k, v) },
      delete: async (k: string) => { store.delete(k) },
      list: async () => ({ keys: [], list_complete: true, cursor: '' }),
    }
    const env = { KV: kv, GATEWAY_KV: kv, RATE_LIMIT_KV: kv, SESSION_KV: kv, OPENCODE_MIRRORS_URL: 'https://mirror.example/zen/v1' } as unknown as Env
    clearCache()

    vi.stubGlobal('fetch', vi.fn(async () => openAiSse('deepseek-v4.1-flash-free')))
    const app = new Hono<AppEnv>()
    app.post('/v1/chat/completions', (c) => handleProxy(c))
    const req = new Request('https://gw.test/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'hi' }] }),
    })
    const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext)
    expect(res.status).toBe(200)
  })
})



