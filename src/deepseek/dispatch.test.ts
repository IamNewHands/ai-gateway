/**
 * deepseek/dispatch.test.ts — T6.1b：把 deepseek-app 接进另外两个分发点。
 *
 * 覆盖的是**完整分发链**（真实 Hono 路由 → handleAnthropicMessages / handleResponses /
 * handleProxy → proxy.ts 内的 deepseek 分支 → 假上游），而不是直接调
 * proxyDeepseekChatRequest —— 直接调证明不了分支真的被接上（provider 入口本身已被
 * proxy.test.ts 覆盖）。
 *
 * 假上游抄自 proxy.test.ts 的 makeFetch：真固件当补全响应，PoW 挑战现场构造成可解，
 * 于是全程没有网络。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import { handleProxy, handleAnthropicMessages, handleResponses } from '../proxy'
import { clearCache } from '../storage'
import { hashV1 } from './pow'
import { resetDeepseekRotatorForTest, writeDeepseekPool, type DeepseekTokenRecord } from './pool'
import { drainStream } from './stream'
import type { AppEnv, Env, Provider } from '../types'

const fs = (await import('node:fs' as string)) as { readFileSync: (p: string, e: string) => string }
const fixture = (name: string) => fs.readFileSync(`src/deepseek/__fixtures__/${name}`, 'utf8')

const PROVIDER_ID = 'deepseek-app'
const MODEL = 'deepseek-flash'
const encoder = new TextEncoder()
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

const tokenRecord = (id: string): DeepseekTokenRecord => ({
  id,
  token: `tok-${id}`,
  headerDeviceId: `dev-${id}`,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0',
  state: 'ready',
  addedAt: 1,
})

/** 造一个可解的 PoW 挑战（answer 42，难度 1000 —— 解算毫秒级）。 */
function solvableChallenge() {
  const salt = 'testsalt'
  const expireAt = 1700000000
  const challenge = hex(hashV1(encoder.encode(`testsalt_${expireAt}_42`)))
  return {
    algorithm: 'DeepSeekHashV1',
    challenge,
    salt,
    expire_at: expireAt,
    difficulty: 1000,
    signature: 'sig',
    target_path: '/api/v0/chat/completion',
  }
}

const envelope = (bizData: unknown) =>
  JSON.stringify({ code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: bizData } })

const json = (body: string) => new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })

/** 假 chat.deepseek.com：记录出站请求，按路径回放。 */
function makeUpstream(completionSse?: string) {
  const seen: Array<{ path: string; body: string }> = []
  let sessionCall = 0
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname
    seen.push({ path, body: String(init.body ?? '') })
    if (path === '/api/v0/chat_session/create') {
      sessionCall++
      return json(envelope({ chat_session: { id: `sess-${sessionCall}` } }))
    }
    if (path === '/api/v0/chat/create_pow_challenge') {
      return json(envelope({ challenge: solvableChallenge() }))
    }
    if (path === '/api/v0/chat/completion') {
      return new Response(completionSse ?? fixture('completion-plain.sse.txt'), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
      })
    }
    return new Response('not found', { status: 404 })
  }
  return { fetchImpl, seen }
}

function deepseekProvider(overrides?: Partial<Provider>): Provider {
  return {
    id: PROVIDER_ID,
    name: 'DeepSeek App',
    baseUrl: 'https://chat.deepseek.com',
    apiType: 'openai',
    apiKeys: [],
    models: [{ id: MODEL, enabled: true }],
    enabled: true,
    ...overrides,
  } as unknown as Provider
}

/** 真实 Hono app + 内存 KV（providers / deepseek 池都落在这份 KV 上）。 */
function makeHarness(providers: Provider[]) {
  const store = new Map<string, string>()
  store.set('providers', JSON.stringify(providers))
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v) },
    delete: async (k: string) => { store.delete(k) },
    list: async () => ({ keys: [], list_complete: true, cursor: '' }),
  }
  const env = {
    KV: kv,
    GATEWAY_KV: kv,
    RATE_LIMIT_KV: kv,
    SESSION_KV: kv,
    USAGE_ANALYTICS: { writeDataPoint: () => {} },
    USAGE_ANALYTICS_DATASET: 'ai_gateway_usage',
  } as unknown as Env
  const app = new Hono<AppEnv>()
  app.post('/v1/chat/completions', (c) => handleProxy(c))
  app.post('/v1/messages', (c) => handleAnthropicMessages(c))
  app.post('/v1/responses', (c) => handleResponses(c))
  return {
    env,
    /** 把 token 注入 deepseek 池（池是 KV 整表读写，覆盖写即可）。 */
    async seedPool(tokens: DeepseekTokenRecord[] = [tokenRecord('a')]) {
      await writeDeepseekPool(env, tokens)
    },
    async post(path: string, bodyObj: Record<string, unknown>) {
      const req = new Request(`https://gw.test${path}`, {
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

const anthropicRequest = (extra: Record<string, unknown> = {}) => ({
  model: `${PROVIDER_ID}/${MODEL}`,
  max_tokens: 64,
  messages: [{ role: 'user', content: '你好' }],
  ...extra,
})

let seen: Array<{ path: string; body: string }>

beforeEach(async () => {
  resetDeepseekRotatorForTest()
  clearCache() // getProvider 有模块级缓存，不清会串用例
  const upstream = makeUpstream()
  seen = upstream.seen
  vi.stubGlobal('fetch', upstream.fetchImpl)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Anthropic /v1/messages 分发点（deepseek-app）', () => {
  it('流式：上游 OpenAI SSE 被转成 Anthropic SSE', async () => {
    const h = makeHarness([deepseekProvider()])
    await h.seedPool()

    const resp = await h.post('/v1/messages', anthropicRequest({ stream: true }))
    expect(resp.status).toBe(200)
    expect(resp.headers.get('Content-Type')).toContain('text/event-stream')

    const out = await drainStream(resp.body as ReadableStream<Uint8Array>)
    expect(out).toContain('event: message_start')
    expect(out).toContain('event: content_block_delta')
    expect(out).toContain('你好')
    expect(out).toContain('event: message_stop')

    // 真的是走了 deepseek 私有协议上游，而不是某个 OpenAI 兼容端点
    expect(seen.some((s) => s.path === '/api/v0/chat/completion')).toBe(true)
  })

  it('非流式：同一份上游 SSE 被聚合成 Anthropic JSON message', async () => {
    const h = makeHarness([deepseekProvider()])
    await h.seedPool()

    const resp = await h.post('/v1/messages', anthropicRequest({ stream: false }))
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as Record<string, any>
    expect(body.type).toBe('message')
    expect(body.role).toBe('assistant')
    expect(body.stop_reason).toBe('end_turn')
    expect(body.content[0].text).toBe('你好')
    expect(body.usage.input_tokens).toBe(38)
  })

  it('Anthropic thinking:{type:"disabled"} 还原成上游 thinking_enabled=false', async () => {
    const h = makeHarness([deepseekProvider()])
    await h.seedPool()

    const resp = await h.post('/v1/messages', anthropicRequest({ stream: false, thinking: { type: 'disabled' } }))
    expect(resp.status).toBe(200)
    const payload = JSON.parse(seen.find((s) => s.path === '/api/v0/chat/completion')!.body) as Record<string, unknown>
    expect(payload['thinking_enabled']).toBe(false)
  })
})

describe('Responses /v1/responses 分发点（deepseek-app）', () => {
  it('非流式：返回 Responses JSON，正文来自上游补全', async () => {
    const h = makeHarness([deepseekProvider()])
    await h.seedPool()

    const resp = await h.post('/v1/responses', {
      model: `${PROVIDER_ID}/${MODEL}`,
      input: '你好',
      stream: false,
    })
    expect(resp.status).toBe(200)
    const body = (await resp.json()) as Record<string, any>
    expect(body.object).toBe('response')
    expect(body.status).toBe('completed')
    const message = (body.output as Array<Record<string, any>>).find((o) => o.type === 'message')!
    expect(message.content[0].text).toBe('你好')
    expect(seen.some((s) => s.path === '/api/v0/chat/completion')).toBe(true)
  })

  it('reasoning.effort="none" 会传到上游：handleResponsesSpecial 内部会删 thinking，由薄包装补回', async () => {
    const h = makeHarness([deepseekProvider()])
    await h.seedPool()

    const resp = await h.post('/v1/responses', {
      model: `${PROVIDER_ID}/${MODEL}`,
      input: '你好',
      stream: false,
      reasoning: { effort: 'none' },
    })
    expect(resp.status).toBe(200)
    const payload = JSON.parse(seen.find((s) => s.path === '/api/v0/chat/completion')!.body) as Record<string, unknown>
    // 不补回的话这里会是 true：客户端明确说「不要思考」，却仍收到思考增量
    expect(payload['thinking_enabled']).toBe(false)
  })

  it('未表态 reasoning 时保持上游缺省（思考开）', async () => {
    const h = makeHarness([deepseekProvider()])
    await h.seedPool()

    const resp = await h.post('/v1/responses', {
      model: `${PROVIDER_ID}/${MODEL}`,
      input: '你好',
      stream: false,
    })
    expect(resp.status).toBe(200)
    const payload = JSON.parse(seen.find((s) => s.path === '/api/v0/chat/completion')!.body) as Record<string, unknown>
    expect(payload['thinking_enabled']).toBe(true)
  })

  it('流式：返回 Responses SSE 并以 response.completed 收尾', async () => {    const h = makeHarness([deepseekProvider()])
    await h.seedPool()

    const resp = await h.post('/v1/responses', {
      model: `${PROVIDER_ID}/${MODEL}`,
      input: '你好',
      stream: true,
    })
    expect(resp.status).toBe(200)
    expect(resp.headers.get('Content-Type')).toContain('text/event-stream')
    const out = await drainStream(resp.body as ReadableStream<Uint8Array>)
    expect(out).toContain('response.output_text.delta')
    expect(out).toContain('你好')
    expect(out).toContain('response.completed')
  })
})

describe('chat/completions + apiType=anthropic 的 501 守卫（有意保留）', () => {
  it('仍显式 501，而不是悄悄回一个 OpenAI 体', async () => {
    const h = makeHarness([deepseekProvider({ apiType: 'anthropic' })])
    await h.seedPool()

    const resp = await h.post('/v1/chat/completions', {
      model: `${PROVIDER_ID}/${MODEL}`,
      messages: [{ role: 'user', content: '你好' }],
    })
    expect(resp.status).toBe(501)
    const body = (await resp.json()) as Record<string, any>
    expect(body.error.code).toBe('anthropic_not_wired')
    // 守卫在调用上游之前拦下：没有任何出站请求
    expect(seen).toHaveLength(0)
  })
})
