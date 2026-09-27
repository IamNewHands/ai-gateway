import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { handleProxy } from '../proxy'
import { clearCache } from '../storage'
import type { AppEnv, Env, Provider } from '../types'

/**
 * Analytics 归属回归测试。
 *
 * 背景（2026-09-27 实测发现）：analytics context 在 handleProxy 里、调用 forwardProxy
 * **之前**创建，而 provider 是 forwardProxy 内部才 getProvider 解析出来的，导致写进
 * Analytics Engine 的 providerId/providerName/providerType/upstreamModel 全是空串。
 * 后果：管理端「渠道 / 提供商」维度所有流量挤进一个空标签桶，按渠道查不到任何提供商
 * （外部表现为"统计里不含某提供商的用量"，实际是归属丢失而非没写）。
 *
 * 这里用真实 Hono app + mock fetch 跑完整链路（handleProxy → forwardProxy → trae 分支），
 * 断言落到 writeDataPoint 的 blobs 携带真实渠道身份与上游模型。
 */

const SOLO_SSE = [
  'event: output',
  'data: {"response":"hi"}',
  '',
  'event: token_usage',
  'data: {"prompt_tokens":19635,"completion_tokens":47,"total_tokens":19682,"reasoning_tokens":45,"cache_read_input_tokens":19584,"cache_creation_input_tokens":0}',
  '',
  'event: done',
  'data: {"finish_reason":"stop"}',
  '',
  '',
].join('\n')

function traeProvider(overrides?: Partial<Provider>): Provider {
  return {
    id: 'trae',
    name: 'TRAE 测试',
    baseUrl: 'https://trae-api-cn.mchost.guru',
    apiType: 'openai',
    apiKeys: [{
      key: JSON.stringify({
        uid: 'u_attr',
        token: 'tok_attr',
        refreshToken: 'ref_attr',
        expiresAt: Date.now() + 3600_000,
      }),
      enabled: true,
    }],
    models: [{ id: 'deepseek-v4.1-flash', enabled: true }],
    enabled: true,
    ...overrides,
  } as unknown as Provider
}

/** 普通 OpenAI 兼容提供商（证明归属逻辑不是 trae 专属分支）。 */
function plainProvider(): Provider {
  return {
    id: 'plain',
    name: '普通上游',
    baseUrl: 'https://plain.example.com/v1',
    apiType: 'openai',
    apiKeys: [{ key: 'sk-test', enabled: true }],
    models: [{ id: 'gpt-test', enabled: true }],
    enabled: true,
  } as unknown as Provider
}

function makeHarness(providers: Provider[]) {
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
    KV: kv,
    GATEWAY_KV: kv,
    RATE_LIMIT_KV: kv,
    SESSION_KV: kv,
    USAGE_ANALYTICS: { writeDataPoint: (dp: any) => { points.push(dp) } },
    USAGE_ANALYTICS_DATASET: 'ai_gateway_usage',
  } as unknown as Env
  const app = new Hono<AppEnv>()
  app.post('/v1/chat/completions', (c) => handleProxy(c))
  return {
    points,
    async post(bodyObj: Record<string, unknown>) {
      const req = new Request('https://gw.test/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyObj),
      })
      return app.fetch(req, env, {
        waitUntil: () => {},
        passThroughOnException: () => {},
      } as unknown as ExecutionContext)
    },
  }
}

/** blob 下标 → 名称（与 ANALYTICS_BLOBS 顺序一致）。 */
const BLOB = {
  route: 0, tokenName: 1, providerId: 2, providerName: 3, providerType: 4,
  requestedModel: 5, upstreamModel: 6, result: 7, streamMode: 8,
} as const
const DOUBLE = {
  promptTokens: 0, completionTokens: 1, cachedTokens: 2, totalTokens: 3,
} as const

describe('analytics 归属：渠道身份与上游模型必须落到数据点', () => {
  const originalFetch = globalThis.fetch
  // getProvider 走模块级 raw cache，跨用例会串上一个用例的 provider 列表
  // （前一个用例的 'plain' 被缓存后，本用例读到旧表 → 404）。每个用例前清空。
  beforeEach(() => { clearCache() })
  afterEach(() => { globalThis.fetch = originalFetch })

  it('trae 流式请求：providerId/Name/Type 与 upstreamModel 非空，usage 三口径落库', async () => {
    globalThis.fetch = vi.fn(async (url: any) => {
      if (String(url).includes('/api/agent/v3/llm_utils_chat')) {
        return new Response(SOLO_SSE, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      }
      return new Response('not found', { status: 404 })
    }) as any

    const h = makeHarness([traeProvider()])
    const resp = await h.post({
      model: 'trae/deepseek-v4.1-flash',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })
    expect(resp.status).toBe(200)
    await resp.text() // 消费流，触发探针 flush 回调

    expect(h.points.length).toBe(1)
    const blobs = h.points[0].blobs
    const doubles = h.points[0].doubles
    // 归属：修复前这三项都是 ''
    expect(blobs[BLOB.providerId]).toBe('trae')
    expect(blobs[BLOB.providerName]).toBe('TRAE 测试')
    expect(blobs[BLOB.providerType]).toBe('openai')
    expect(blobs[BLOB.upstreamModel]).toBe('deepseek-v4.1-flash')
    // 请求维度仍照常记录
    expect(blobs[BLOB.requestedModel]).toBe('trae/deepseek-v4.1-flash')
    expect(blobs[BLOB.result]).toBe('success')
    expect(blobs[BLOB.streamMode]).toBe('stream')
    // usage：prompt / completion / cached / total
    expect(doubles[DOUBLE.promptTokens]).toBe(19635)
    expect(doubles[DOUBLE.completionTokens]).toBe(47)
    expect(doubles[DOUBLE.cachedTokens]).toBe(19584)
    expect(doubles[DOUBLE.totalTokens]).toBe(19682)
  })

  it('普通 OpenAI 提供商同样带归属（不是 trae 专属分支）', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      id: 'c1',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as any

    const h = makeHarness([plainProvider()])
    const resp = await h.post({
      model: 'plain/gpt-test',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    })
    expect(resp.status).toBe(200)
    await resp.text()

    expect(h.points.length).toBe(1)
    const blobs = h.points[0].blobs
    expect(blobs[BLOB.providerId]).toBe('plain')
    expect(blobs[BLOB.providerName]).toBe('普通上游')
    expect(blobs[BLOB.upstreamModel]).toBe('gpt-test')
    expect(h.points[0].doubles[DOUBLE.promptTokens]).toBe(11)
    expect(h.points[0].doubles[DOUBLE.totalTokens]).toBe(14)
  })

  it('提供商不存在时：仍写一条失败事件，且归属字段保持空（不编造渠道）', async () => {
    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 404 })) as any
    const h = makeHarness([plainProvider()])
    const resp = await h.post({
      model: 'ghost/gpt-test',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    })
    expect(resp.status).toBe(404)
    // 未解析出 provider → 不写归属，但不能编造
    for (const p of h.points) {
      expect(p.blobs[BLOB.providerId]).toBe('')
    }
  })
})
