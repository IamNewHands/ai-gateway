/**
 * deepseek/proxy.test.ts — provider 入口的端到端（含上游）行为。
 *
 * 用假 fetch 顶替 chat.deepseek.com：真固件当补全响应，PoW 挑战现场构造成可解，
 * 于是「OpenAI 请求进 → OpenAI 响应出」这条链在没有网络的情况下被完整覆盖。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { Env, Provider } from '../types'
import { hashV1 } from './pow'
import { resetDeepseekRotatorForTest, writeDeepseekPool, type DeepseekTokenRecord } from './pool'
import { DEEPSEEK_APP_PROVIDER_ID, isDeepseekAppProvider, proxyDeepseekChatRequest } from './proxy'
import { drainStream } from './stream'

const fs = (await import('node:fs' as string)) as {
  readFileSync: (path: string, encoding: string) => string
}
const fixture = (name: string) => fs.readFileSync(`src/deepseek/__fixtures__/${name}`, 'utf8')

const encoder = new TextEncoder()
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

function mockKV() {
  const map = new Map<string, string>()
  return {
    map,
    get: async (k: string) => map.get(k) ?? null,
    put: async (k: string, v: string) => {
      map.set(k, v)
    },
  }
}

const provider = {
  id: DEEPSEEK_APP_PROVIDER_ID,
  name: 'DeepSeek App',
  baseUrl: 'https://chat.deepseek.com',
  apiKeys: [],
  models: [{ id: 'deepseek-flash', enabled: true }],
  enabled: true,
  createdAt: '',
  updatedAt: '',
} as unknown as Provider

const tokenRecord = (id: string, token = `tok-${id}`): DeepseekTokenRecord => ({
  id,
  token,
  headerDeviceId: `dev-${id}`,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0',
  state: 'ready',
  addedAt: 1,
})

/** 造一个可解的 PoW 挑战（answer 42，难度 1000 —— 解算毫秒级）。 */
function solvableChallenge() {
  const salt = 'testsalt'
  const expireAt = 1700000000
  const answer = 42
  const challenge = hex(hashV1(encoder.encode(`testsalt_${expireAt}_${answer}`)))
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

const envelope = (bizData: unknown, bizCode = 0, bizMsg = '') =>
  JSON.stringify({ code: 0, msg: '', data: { biz_code: bizCode, biz_msg: bizMsg, biz_data: bizData } })

const json = (body: string) => new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })

interface UpstreamScript {
  /** 每次 create_session 调用的行为；按顺序取用。 */
  createSession?: Array<{ ok: boolean; msg?: string }>
  /** completion 返回的 SSE 全文（默认 plain 固件）。 */
  completionSse?: string
  /** 观察到的请求。 */
  seen?: Array<{ path: string; headers: Record<string, string>; body: string }>
}

/** 假上游 fetch。 */
function makeFetch(script: UpstreamScript = {}) {
  const seen = script.seen ?? []
  let sessionCall = 0
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname
    const headers: Record<string, string> = {}
    const h = init.headers as Record<string, string> | undefined
    if (h) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v)
    seen.push({ path, headers, body: String(init.body ?? '') })

    if (path === '/api/v0/chat_session/create') {
      // 注意：`arr?.[i++]` 在 arr 为 undefined 时会短路，自增不执行 —— 先取值再自增
      const plan = (script.createSession ?? [])[sessionCall] ?? { ok: true }
      sessionCall++
      if (!plan.ok) {
        return json(JSON.stringify({ code: plan.msg?.includes('token') ? 40003 : 1, msg: plan.msg ?? 'error', data: { biz_code: 0, biz_msg: '', biz_data: null } }))
      }
      return json(envelope({ chat_session: { id: `sess-${sessionCall}` } }))
    }
    if (path === '/api/v0/chat/create_pow_challenge') {
      return json(envelope({ challenge: solvableChallenge() }))
    }
    if (path === '/api/v0/chat/completion') {
      return new Response(script.completionSse ?? fixture('completion-plain.sse.txt'), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
      })
    }
    return new Response('not found', { status: 404 })
  }
  return { fetchImpl, seen }
}

beforeEach(() => resetDeepseekRotatorForTest())

describe('provider detection', () => {
  it('matches by id and by upstream host, and rejects others', () => {
    expect(isDeepseekAppProvider({ id: DEEPSEEK_APP_PROVIDER_ID, baseUrl: '' } as never)).toBe(true)
    expect(isDeepseekAppProvider({ id: 'x', baseUrl: 'https://chat.deepseek.com' } as never)).toBe(true)
    expect(isDeepseekAppProvider({ id: 'trae', baseUrl: 'https://x' } as never)).toBe(false)
    expect(isDeepseekAppProvider(undefined)).toBe(false)
  })

  /**
   * 域名判定必须是 hostname 精确比对（CodeQL js/incomplete-url-substring-sanitization）：
   * 子串写法会把「别人家的域名里带 chat.deepseek.com」也认成自家上游。
   */
  it('域名判定拒绝子串伪装的 baseUrl', () => {
    for (const evil of [
      'https://chat.deepseek.com.evil.com/v1',
      'https://evil.com/?u=chat.deepseek.com',
      'https://evil.com/chat.deepseek.com',
      'https://notchat.deepseek.com.evil.com',
    ]) {
      expect(isDeepseekAppProvider({ id: 'x', baseUrl: evil } as never), evil).toBe(false)
    }
    // 合法形态仍要命中：带路径 / 端口 / 大小写 / 尾部斜杠
    expect(isDeepseekAppProvider({ id: 'x', baseUrl: 'https://chat.deepseek.com/api/v0' } as never)).toBe(true)
    expect(isDeepseekAppProvider({ id: 'x', baseUrl: 'https://CHAT.DeepSeek.com:443' } as never)).toBe(true)
    // 无法解析的 baseUrl 不猜
    expect(isDeepseekAppProvider({ id: 'x', baseUrl: 'chat.deepseek.com' } as never)).toBe(false)
    expect(isDeepseekAppProvider({ id: 'x', baseUrl: '' } as never)).toBe(false)
  })
})

describe('streaming path', () => {
  it('turns an upstream SSE into OpenAI SSE with a real stop and usage', async () => {
    const { fetchImpl, seen } = makeFetch()
    const body = {
      model: 'deepseek-flash',
      stream: true,
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: '你好' },
      ],
    }
    const resp = await proxyDeepseekChatRequest(
      { KV: mockKV() } as unknown as Env,
      provider,
      body,
      { fetch: fetchImpl, tokens: [tokenRecord('a')], persist: false, newId: () => 'chatcmpl-fixed' },
    )

    expect(resp.status).toBe(200)
    expect(resp.headers.get('Content-Type')).toContain('text/event-stream')
    const out = await drainStream(resp.body as ReadableStream<Uint8Array>)
    expect(out).toContain('"id":"chatcmpl-fixed"')
    expect(out).toContain('"content":"你好"')
    expect(out).toContain('"finish_reason":"stop"')
    expect(out.endsWith('data: [DONE]\n\n')).toBe(true)

    // 上游请求线上形态：web 指纹 + 注入 token + PoW 头 + 合并后的 prompt
    const create = seen.find((s) => s.path.endsWith('/chat_session/create'))!
    expect(create.headers['authorization']).toBe('Bearer tok-a')
    expect(create.headers['x-client-platform']).toBe('web')
    expect(create.headers['x-device-id']).toBe('dev-a')
    expect(create.headers['user-agent']).toContain('Chrome/140')

    const completion = seen.find((s) => s.path.endsWith('/chat/completion'))!
    expect(completion.headers['x-ds-pow-response']).toBeTruthy()
    const payload = JSON.parse(completion.body)
    expect(payload.chat_session_id).toBe('sess-1')
    expect(payload.thinking_enabled).toBe(true) // 缺省开思考
    expect(payload.search_enabled).toBe(false) // 缺省关搜索
    expect(payload.prompt).toBe('user: be brief\n\n---\n\n你好\n')
  })

  it('honours the thinking/search switches per request', async () => {
    const { fetchImpl, seen } = makeFetch()
    await proxyDeepseekChatRequest({ KV: mockKV() } as unknown as Env, provider, {
      model: 'deepseek-flash',
      stream: true,
      thinking: { type: 'disabled' },
      search: { type: 'enabled' },
      messages: [{ role: 'user', content: 'hi' }],
    }, { fetch: fetchImpl, tokens: [tokenRecord('a')], persist: false })
    const payload = JSON.parse(seen.find((s) => s.path.endsWith('/chat/completion'))!.body)
    expect(payload.thinking_enabled).toBe(false)
    expect(payload.search_enabled).toBe(true)
  })

  /**
   * provider 级「默认关思考」（面板开关）：翻译这类轻量任务的快路径。
   * 断言两件事：默认确实关掉上游 thinking_enabled；客户端显式要思考时能开回来。
   */
  it('provider 默认关思考时，上游收到 thinking_enabled:false', async () => {
    const offProvider = { ...provider, deepseekThinkingOff: true } as unknown as Provider
    const { fetchImpl, seen } = makeFetch()
    await proxyDeepseekChatRequest({ KV: mockKV() } as unknown as Env, offProvider, {
      model: 'deepseek-flash',
      stream: true,
      messages: [{ role: 'user', content: 'translate this' }],
    }, { fetch: fetchImpl, tokens: [tokenRecord('a')], persist: false })
    const payload = JSON.parse(seen.find((s) => s.path.endsWith('/chat/completion'))!.body)
    expect(payload.thinking_enabled).toBe(false)
  })

  it('provider 默认关思考，但客户端显式 thinking=enabled 时仍开思考', async () => {
    const offProvider = { ...provider, deepseekThinkingOff: true } as unknown as Provider
    const { fetchImpl, seen } = makeFetch()
    await proxyDeepseekChatRequest({ KV: mockKV() } as unknown as Env, offProvider, {
      model: 'deepseek-flash',
      stream: true,
      thinking: { type: 'enabled' },
      messages: [{ role: 'user', content: 'solve this' }],
    }, { fetch: fetchImpl, tokens: [tokenRecord('a')], persist: false })
    const payload = JSON.parse(seen.find((s) => s.path.endsWith('/chat/completion'))!.body)
    expect(payload.thinking_enabled).toBe(true)
  })

  /**
   * 关思考时上游偶尔仍推 THINK 片段（thinking fixture 里有）：必须丢弃，
   * 否则客户端会收到 reasoning_content，「关思考」看起来没生效。
   */
  it('关思考时抑制残留的 reasoning_content 增量', async () => {
    const { fetchImpl } = makeFetch({ completionSse: fixture('completion-thinking.sse.txt') })
    const resp = await proxyDeepseekChatRequest({ KV: mockKV() } as unknown as Env, provider, {
      model: 'deepseek-flash',
      stream: true,
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: 'hi' }],
    }, { fetch: fetchImpl, tokens: [tokenRecord('a')], persist: false })
    const out = await drainStream(resp.body as ReadableStream<Uint8Array>)
    expect(out).not.toContain('reasoning_content')
    // 正文与收尾照常（不能因为丢弃思考就把回答也丢了）
    expect(out).toContain('"finish_reason":"stop"')
    expect(out.endsWith('data: [DONE]\n\n')).toBe(true)
  })

  it('默认（思考开）时 reasoning_content 照常下发，不被误抑制', async () => {
    const { fetchImpl } = makeFetch({ completionSse: fixture('completion-thinking.sse.txt') })
    const resp = await proxyDeepseekChatRequest({ KV: mockKV() } as unknown as Env, provider, {
      model: 'deepseek-flash',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }, { fetch: fetchImpl, tokens: [tokenRecord('a')], persist: false })
    const out = await drainStream(resp.body as ReadableStream<Uint8Array>)
    expect(out).toContain('reasoning_content')
  })
})

describe('non-stream path', () => {
  it('aggregates the upstream stream into one OpenAI completion', async () => {
    const { fetchImpl } = makeFetch()
    const resp = await proxyDeepseekChatRequest({ KV: mockKV() } as unknown as Env, provider, {
      model: 'deepseek-flash',
      stream: false,
      messages: [{ role: 'user', content: '你好' }],
    }, { fetch: fetchImpl, tokens: [tokenRecord('a')], persist: false, newId: () => 'chatcmpl-ns' })

    expect(resp.status).toBe(200)
    const body = await resp.json() as Record<string, any>
    expect(body.object).toBe('chat.completion')
    expect(body.choices[0].message.content).toBe('你好')
    expect(body.choices[0].finish_reason).toBe('stop')
    expect(body.usage.total_tokens).toBe(38)
  })

  it('surfaces search citations on the message', async () => {
    const { fetchImpl } = makeFetch({ completionSse: fixture('completion-search.sse.txt') })
    const resp = await proxyDeepseekChatRequest({ KV: mockKV() } as unknown as Env, provider, {
      model: 'deepseek-flash',
      stream: false,
      messages: [{ role: 'user', content: 'news' }],
    }, { fetch: fetchImpl, tokens: [tokenRecord('a')], persist: false })
    const body = await resp.json() as Record<string, any>
    expect(Array.isArray(body.choices[0].message.citations)).toBe(true)
    expect(body.choices[0].message.citations.length).toBeGreaterThan(0)
  })

  /** 非流式路径同样要在关思考时丢掉 reasoning_content（与流式同一口径）。 */
  it('关思考时非流式响应不含 reasoning_content，且正文完整', async () => {
    const { fetchImpl } = makeFetch({ completionSse: fixture('completion-thinking.sse.txt') })
    const resp = await proxyDeepseekChatRequest({ KV: mockKV() } as unknown as Env, provider, {
      model: 'deepseek-flash',
      stream: false,
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: 'hi' }],
    }, { fetch: fetchImpl, tokens: [tokenRecord('a')], persist: false })
    const body = await resp.json() as Record<string, any>
    expect(body.choices[0].message.reasoning_content).toBeUndefined()
    expect(body.choices[0].finish_reason).toBe('stop')
    expect(typeof body.choices[0].message.content).toBe('string')
  })
})

describe('token pool behaviour', () => {
  it('marks a dead token expired and retries on the next one', async () => {
    const kv = mockKV()
    const env = { KV: kv } as unknown as Env
    // 真把 token 写进 KV：这样失效标记的回写路径也被覆盖（deps.tokens 只用于跳过读）
    await writeDeepseekPool(env, [tokenRecord('a'), tokenRecord('b')])
    const { fetchImpl } = makeFetch({ createSession: [{ ok: false, msg: 'invalid token' }, { ok: true }] })
    const attempts: string[] = []

    const resp = await proxyDeepseekChatRequest(env, provider, {
      model: 'deepseek-flash',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      fetch: fetchImpl,
      onAttempt: (rec) => attempts.push(rec.id),
    })

    expect(resp.status).toBe(200)
    expect(attempts).toEqual(['a', 'b'])
    // 失效标记写回 KV，面板可见
    const stored = JSON.parse(kv.map.get('deepseek:pool') ?? '{"tokens":[]}') as { tokens: DeepseekTokenRecord[] }
    expect(stored.tokens.find((t) => t.id === 'a')?.state).toBe('expired')
    expect(stored.tokens.find((t) => t.id === 'b')?.state).toBe('ready')
  })

  it('answers 503 no_token on an empty pool and never calls upstream', async () => {
    const { fetchImpl, seen } = makeFetch()
    const resp = await proxyDeepseekChatRequest({ KV: mockKV() } as unknown as Env, provider, {
      model: 'deepseek-flash',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }, { fetch: fetchImpl, tokens: [] })
    expect(resp.status).toBe(503)
    const body = await resp.json() as Record<string, any>
    expect(body.error.code).toBe('no_token')
    expect(seen).toHaveLength(0)
  })

  it('answers 503 exhausted when every token is dead', async () => {
    const { fetchImpl } = makeFetch({ createSession: [{ ok: false, msg: 'invalid token' }, { ok: false, msg: 'invalid token' }] })
    const resp = await proxyDeepseekChatRequest({ KV: mockKV() } as unknown as Env, provider, {
      model: 'deepseek-flash',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }, { fetch: fetchImpl, tokens: [tokenRecord('a'), tokenRecord('b')], persist: false })
    expect(resp.status).toBe(503)
    expect((await resp.json() as Record<string, any>).error.code).toBe('exhausted')
  })
})

describe('request validation', () => {
  it('rejects an empty message list with 400', async () => {
    const resp = await proxyDeepseekChatRequest({ KV: mockKV() } as unknown as Env, provider, {
      model: 'deepseek-flash',
      messages: [],
    }, { tokens: [tokenRecord('a')] })
    expect(resp.status).toBe(400)
    expect((await resp.json() as Record<string, any>).error.message).toContain('messages must not be empty')
  })

  it('rejects a malformed thinking switch with 400', async () => {
    const resp = await proxyDeepseekChatRequest({ KV: mockKV() } as unknown as Env, provider, {
      model: 'deepseek-flash',
      thinking: { type: 'banana' },
      messages: [{ role: 'user', content: 'hi' }],
    }, { tokens: [tokenRecord('a')] })
    expect(resp.status).toBe(400)
    expect((await resp.json() as Record<string, any>).error.message).toContain('thinking.type')
  })
})
