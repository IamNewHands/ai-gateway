import { describe, it, expect, vi, afterEach } from 'vitest'
import { Hono } from 'hono'
import { handleResponses, testModelConnection } from './proxy'
import { clearCache } from './storage'
import { validateProviderApiType } from './admin'
import type { AppEnv, Env, Provider } from './types'

/**
 * `provider.apiType === 'openai-responses'`：Responses 原生上游透传。
 *
 * 背景（2026-10-22）：agentrouter 的 gpt-6.1-sol 只实现 `/v1/responses`，对
 * `/v1/chat/completions` 回 `模型 xxx 不支持 /v1/chat/completions 接口，请改用
 * /v1/responses`。旧实现里 `/v1/responses` 入口一律先 `responsesToOpenAI()` 折回
 * chat 格式再发 `${baseUrl}/chat/completions`，因此这类模型经网关不可用。
 *
 * 本文件锁定四条不变量：
 *  1. 出站路径是 `/v1/responses`（不是 chat/completions）；
 *  2. 请求体逐字透传（instructions / input / text / reasoning 不被抹平），
 *     但网关内部 `__` 前缀字段必须被剥掉；
 *  3. 响应体（流式与 JSON）逐字回给客户端，不做格式转换；
 *  4. 该类型的 provider 收到 chat / messages 入口请求时显式 501，
 *     不落到通用 chat 转发（那会得到一个误导性的上游 400）。
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

function responsesOnlyProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'agentrouter',
    name: 'agentrouter',
    baseUrl: 'https://ps.air-outer.com/v1',
    apiType: 'openai-responses',
    apiKeys: [{ key: 'sk-test', enabled: true }],
    models: [{ id: 'gpt-6.1-sol', enabled: true }],
    enabled: true,
    upstreamUserAgent: 'claude-cli/2.0.1 (external, cli)',
    createdAt: 'a',
    updatedAt: 'a',
    ...overrides,
  } as Provider
}

/** 记录每次 fetch 的 url / headers / body，便于断言出站形态。 */
function recordFetch(responder: () => Response) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const raw = (init?.headers ?? {}) as Record<string, string>
    const headers: Record<string, string> = {}
    for (const k of Object.keys(raw)) headers[k.toLowerCase()] = String(raw[k])
    let body: Record<string, unknown> = {}
    try { body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> } catch { /* 非 JSON 体不关心 */ }
    calls.push({ url, headers, body })
    return responder()
  }))
  return calls
}

function postResponses(env: Env, payload: Record<string, unknown>, path = '/v1/responses') {
  const app = new Hono<AppEnv>()
  app.post('/v1/responses', (c) => handleResponses(c))
  // chat / messages 入口复用同一个 handler 不成立（各有独立 handler），
  // 这两条断言在下面的独立 describe 里用各自的 handler 发起。
  const req = new Request(`https://gw.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext)
}

describe('openai-responses：出站走 /v1/responses 且请求体逐字透传', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    clearCache()
  })

  it('非流式：发到 /v1/responses，Responses 专有字段原样到达上游', async () => {
    const calls = recordFetch(() => new Response(JSON.stringify({
      id: 'resp_1',
      object: 'response',
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const env = makeEnv([responsesOnlyProvider()])

    const res = await postResponses(env, {
      model: 'agentrouter/gpt-6.1-sol',
      // Responses 专有字段：折回 chat 时会被 responsesToOpenAI 抹平，透传必须保留
      instructions: 'You are a helpful assistant.',
      input: [{ role: 'user', content: 'hi' }],
      text: { verbosity: 'low' },
      reasoning: { effort: 'medium' },
      store: false,
      stream: false,
    })

    expect(res.status).toBe(200)
    // 1) 路径：必须命中 /v1/responses，而不是 chat/completions
    expect(calls[0].url).toBe('https://ps.air-outer.com/v1/responses')
    // 2) 请求体：Responses 专有字段逐字保留
    expect(calls[0].body['instructions']).toBe('You are a helpful assistant.')
    expect(calls[0].body['text']).toEqual({ verbosity: 'low' })
    expect(calls[0].body['reasoning']).toEqual({ effort: 'medium' })
    expect(calls[0].body['store']).toBe(false)
    // 3) model 剥掉 providerId 前缀
    expect(calls[0].body['model']).toBe('gpt-6.1-sol')
    // 4) 出站指纹头生效（agentrouter 按 UA 白名单鉴权）
    expect(calls[0].headers['user-agent']).toBe('claude-cli/2.0.1 (external, cli)')
    expect(calls[0].headers['authorization']).toBe('Bearer sk-test')
    // 5) 响应体逐字回传（不转成 chat.completion）
    const payload = await res.json() as Record<string, unknown>
    expect(payload['object']).toBe('response')
    expect(payload['id']).toBe('resp_1')
  })

  it('网关内部 __ 前缀字段被剥掉，不会发到上游', async () => {
    const calls = recordFetch(() => new Response(JSON.stringify({ id: 'resp_2', output: [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))
    const env = makeEnv([responsesOnlyProvider()])

    await postResponses(env, {
      model: 'agentrouter/gpt-6.1-sol',
      input: 'hi',
      __m365_tenant: 'leak',
      __responses_parallel_tool_calls: true,
    })

    expect(calls[0].body['__m365_tenant']).toBeUndefined()
    expect(calls[0].body['__responses_parallel_tool_calls']).toBeUndefined()
    expect(calls[0].body['input']).toBe('hi')
  })

  it('流式：Responses SSE 逐字透传，事件类型不被改写', async () => {
    const upstreamEvents = [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_3","status":"in_progress"}}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_3","status":"completed","output":[]}}\n\n',
    ]
    const calls = recordFetch(() => new Response(sseStream(upstreamEvents), {
      status: 200, headers: { 'Content-Type': 'text/event-stream' },
    }))
    const env = makeEnv([responsesOnlyProvider()])

    const res = await postResponses(env, {
      model: 'agentrouter/gpt-6.1-sol',
      input: 'hi',
      stream: true,
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/event-stream')
    expect(calls[0].url).toBe('https://ps.air-outer.com/v1/responses')
    expect(calls[0].body['stream']).toBe(true)

    const text = await res.text()
    // 原始 Responses 事件名与 payload 原样保留（不是 chat.completion.chunk）
    expect(text).toContain('response.created')
    expect(text).toContain('response.output_text.delta')
    expect(text).toContain('response.completed')
    expect(text).not.toContain('chat.completion')
    expect(text).toContain('hello')
  })

  it('多 Key：第一个 key 非 2xx 时自动换下一个', async () => {
    let call = 0
    const calls: Array<{ headers: Record<string, string> }> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const raw = (init?.headers ?? {}) as Record<string, string>
      const headers: Record<string, string> = {}
      for (const k of Object.keys(raw)) headers[k.toLowerCase()] = String(raw[k])
      calls.push({ headers })
      call++
      if (call === 1) return new Response('{"error":{"message":"bad key"}}', { status: 401 })
      return new Response(JSON.stringify({ id: 'resp_ok', output: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }))
    const env = makeEnv([responsesOnlyProvider({
      apiKeys: [{ key: 'sk-bad', enabled: true }, { key: 'sk-good', enabled: true }],
    })])

    const res = await postResponses(env, { model: 'agentrouter/gpt-6.1-sol', input: 'hi' })

    expect(res.status).toBe(200)
    expect(calls.length).toBe(2)
    expect(calls[0].headers['authorization']).toBe('Bearer sk-bad')
    expect(calls[1].headers['authorization']).toBe('Bearer sk-good')
  })

  it('全部 key 失败 → 返回 upstream_error，不伪装成成功', async () => {
    recordFetch(() => new Response('{"error":{"message":"模型 gpt-6.1-sol 不支持 /v1/chat/completions 接口"}}', {
      status: 400, headers: { 'Content-Type': 'application/json' },
    }))
    const env = makeEnv([responsesOnlyProvider()])

    const res = await postResponses(env, { model: 'agentrouter/gpt-6.1-sol', input: 'hi' })
    expect(res.status).toBe(400)
    const payload = await res.json() as { error: Record<string, unknown> }
    expect(payload.error['type']).toBe('upstream_error')
  })
})

describe('openai-responses：协议不匹配的入口显式 501', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    clearCache()
  })

  it('chat 入口 → 501 responses_upstream_only（不落到通用 chat 转发）', async () => {
    const calls = recordFetch(() => new Response('{}', { status: 200 }))
    const env = makeEnv([responsesOnlyProvider()])
    const { handleProxy } = await import('./proxy')
    const app = new Hono<AppEnv>()
    app.post('/v1/chat/completions', (c) => handleProxy(c))

    const res = await app.fetch(new Request('https://gw.test/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'agentrouter/gpt-6.1-sol', messages: [{ role: 'user', content: 'hi' }] }),
    }), env, { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext)

    expect(res.status).toBe(501)
    const payload = await res.json() as { error: Record<string, unknown> }
    expect(payload.error['code']).toBe('responses_upstream_only')
    // 关键：没有向上游发出任何请求
    expect(calls.length).toBe(0)
  })
})

describe('testModelConnection：按 apiType 选择探测端点', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('openai-responses → 探测 /v1/responses 且体用 input', async () => {
    const calls = recordFetch(() => new Response('{"id":"resp_probe"}', {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))
    const r = await testModelConnection(
      'https://ps.air-outer.com/v1',
      'sk-test',
      'gpt-6.1-sol',
      'openai-responses',
      'claude-cli/2.0.1 (external, cli)',
    )
    expect(r.success).toBe(true)
    expect(calls[0].url).toBe('https://ps.air-outer.com/v1/responses')
    expect(calls[0].body['input']).toBe('hi')
    expect(calls[0].body['messages']).toBeUndefined()
  })

  it('openai（缺省）→ 仍探测 chat/completions（既有行为不变）', async () => {
    const calls = recordFetch(() => new Response('{"id":"c1"}', {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))
    await testModelConnection('https://api.example.com/v1', 'sk-test', 'm1', 'openai')
    expect(calls[0].url).toBe('https://api.example.com/v1/chat/completions')
    expect(calls[0].body['messages']).toBeDefined()
  })
})

describe('validateProviderApiType：协议格式落库前校验', () => {
  it('三种合法值均通过（含缺省 undefined）', () => {
    expect(validateProviderApiType('openai')).toBeNull()
    expect(validateProviderApiType('anthropic')).toBeNull()
    expect(validateProviderApiType('openai-responses')).toBeNull()
    expect(validateProviderApiType(undefined)).toBeNull()
  })

  it('拼错的值被拒绝，且错误信息列出可选值', () => {
    for (const bad of ['responses', 'OPENAI', 'openai_responses', 'openai-responses-x']) {
      const err = validateProviderApiType(bad)
      expect(err).not.toBeNull()
      expect(err).toContain('openai-responses')
    }
  })

  it('前后空白被 trim（表单粘贴常带空格，不该因此被拒）', () => {
    expect(validateProviderApiType(' openai-responses ')).toBeNull()
  })
})
