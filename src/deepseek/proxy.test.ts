/**
 * deepseek/proxy.test.ts — provider 入口的端到端（含上游）行为。
 *
 * 用假 fetch 顶替 chat.deepseek.com：真固件当补全响应，PoW 挑战现场构造成可解，
 * 于是「OpenAI 请求进 → OpenAI 响应出」这条链在没有网络的情况下被完整覆盖。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { Env, Provider } from '../types'
import { hashV1 } from './pow'
import {
  isDeepseekTokenParked,
  readDeepseekPool,
  resetDeepseekRotatorForTest,
  writeDeepseekPool,
  type DeepseekTokenRecord,
} from './pool'
import {
  DEEPSEEK_MUTE_RETRY_AFTER_FALLBACK_S,
  DEEPSEEK_APP_PROVIDER_ID,
  banErrorResponse,
  isDeepseekAppProvider,
  pickDominantPark,
  proxyDeepseekChatRequest,
} from './proxy'
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
  /** create_session 返回信封里的 biz_code（用于测处罚：10 封禁 / 5 禁言 / 11 风险）。 */
  createSessionBizCode?: number
  /** 每次 completion 调用的行为；按顺序取用（`bizCode` 非 0 时回 JSON 信封而非 SSE）。 */
  completion?: Array<{ bizCode?: number; bizMsg?: string; muteUntil?: string; sse?: string }>
  /** 观察到的请求。 */
  seen?: Array<{ path: string; headers: Record<string, string>; body: string }>
}

/** 假上游 fetch。 */
function makeFetch(script: UpstreamScript = {}) {
  const seen = script.seen ?? []
  let sessionCall = 0
  let completionCall = 0
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
      if (script.createSessionBizCode) {
        return json(JSON.stringify({
          code: 0,
          msg: '',
          data: { biz_code: script.createSessionBizCode, biz_msg: 'upstream refusal', biz_data: null },
        }))
      }
      return json(envelope({ chat_session: { id: `sess-${sessionCall}` } }))
    }
    if (path === '/api/v0/chat/create_pow_challenge') {
      return json(envelope({ challenge: solvableChallenge() }))
    }
    if (path === '/api/v0/chat/completion') {
      const plan = (script.completion ?? [])[completionCall]
      completionCall++
      if (plan?.bizCode) {
        // 上游会用 HTTP 200 + JSON 信封报错（不是 SSE）
        return json(JSON.stringify({
          code: 0,
          msg: '',
          data: {
            biz_code: plan.bizCode,
            biz_msg: plan.bizMsg ?? 'refused',
            biz_data: plan.muteUntil ? { mute_until: plan.muteUntil } : null,
          },
        }))
      }
      return new Response(plan?.sse ?? script.completionSse ?? fixture('completion-plain.sse.txt'), {
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

/**
 * 超长 prompt 前置校验（移植自 Go 版 `DefaultMaxPromptChars` / `prompt_guard_test.go`）。
 * 关键契约：超限必须回 **400 context_length_exceeded**，且**不打上游**——
 * 否则客户端拿到的是归因错误的 502「上游出错」，而真因是自己的请求太长。
 */
describe('超长 prompt 前置校验', () => {
  const hugeBody = () => ({
    model: 'deepseek-flash',
    stream: false,
    messages: [{ role: 'user', content: 'x'.repeat(2_000_001) }],
  })

  it('超过 200 万字符 → 400 context_length_exceeded，且零出站请求', async () => {
    const { fetchImpl, seen } = makeFetch()
    const resp = await proxyDeepseekChatRequest({ KV: mockKV() } as unknown as Env, provider, hugeBody(), {
      fetch: fetchImpl,
      tokens: [tokenRecord('a')],
    })
    expect(resp.status).toBe(400)
    const body = (await resp.json()) as Record<string, any>
    expect(body.error.code).toBe('context_length_exceeded')
    expect(body.error.message).toContain('too long')
    // 关键：一条出站请求都没有（不是打上游失败，是本地就拒了）
    expect(seen).toHaveLength(0)
  })

  it('恰好在上限内不触发（边界不误伤）', async () => {
    const { fetchImpl } = makeFetch()
    // prompt 会被摊平成 "user: <content>\n"，所以留出前缀余量
    const resp = await proxyDeepseekChatRequest({ KV: mockKV() } as unknown as Env, provider, {
      model: 'deepseek-flash',
      stream: false,
      messages: [{ role: 'user', content: 'x'.repeat(2_000_000 - 20) }],
    }, { fetch: fetchImpl, tokens: [tokenRecord('a')], persist: false })
    expect(resp.status).toBe(200)
  })

  /** 超长判定与池状态无关：这是请求本身的问题，空池也应是 400 而不是 503。 */
  it('空池 + 超长 prompt 仍报 400（请求问题优先于池问题）', async () => {
    const resp = await proxyDeepseekChatRequest({ KV: mockKV() } as unknown as Env, provider, hugeBody(), {
      tokens: [],
    })
    expect(resp.status).toBe(400)
    expect((await resp.json() as Record<string, any>).error.code).toBe('context_length_exceeded')
  })
})

/**
 * 上游处罚 → park。这是本次移植里风险最高的一项：不 park 的话被禁言的账号会在
 * 下一次请求里继续打上游，上游会**续期窗口甚至升级处罚**（Go 版实测 6h 禁言 → 3 天封禁）。
 */
describe('上游处罚 park', () => {
  const streamBody = { model: 'deepseek-flash', stream: true, messages: [{ role: 'user', content: 'hi' }] }

  it('biz 5 禁言 → park 该 token 并在面板可见（带 mute_until 窗口）', async () => {
    const kv = mockKV()
    const env = { KV: kv } as unknown as Env
    await writeDeepseekPool(env, [tokenRecord('a'), tokenRecord('b')])
    const until = new Date(Date.now() + 3600_000)
    const { fetchImpl, seen } = makeFetch({
      completion: [
        { bizCode: 5, bizMsg: 'user is muted', muteUntil: until.toISOString() },
        { sse: fixture('completion-plain.sse.txt') },
      ],
    })

    const resp = await proxyDeepseekChatRequest(env, provider, streamBody, { fetch: fetchImpl })
    // 换到 b 之后成功：请求本身不该因为一条 token 被禁言而失败
    expect(resp.status).toBe(200)

    const stored = (await readDeepseekPool(env)).find((t) => t.id === 'a')!
    expect(stored.park?.kind).toBe('muted')
    expect(isDeepseekTokenParked(stored)).toBe(true)
    // 窗口来自上游的 mute_until，不是兜底值
    expect(Math.abs((stored.park!.until ?? 0) - until.getTime())).toBeLessThan(2000)
    // 确认真的打了两次 completion（a 失败 → b 成功）
    expect(seen.filter((s) => s.path.endsWith('/chat/completion'))).toHaveLength(2)
  })

  it('biz 5 无 mute_until → 兜底 6h 窗口（保守下限，不猜上游时长）', async () => {
    const env = { KV: mockKV() } as unknown as Env
    await writeDeepseekPool(env, [tokenRecord('a'), tokenRecord('b')])
    const before = Date.now()
    const { fetchImpl } = makeFetch({ completion: [{ bizCode: 5, bizMsg: 'muted' }, { sse: fixture('completion-plain.sse.txt') }] })

    await proxyDeepseekChatRequest(env, provider, streamBody, { fetch: fetchImpl })
    const park = (await readDeepseekPool(env)).find((t) => t.id === 'a')!.park!
    const sixHours = 6 * 60 * 60 * 1000
    expect(park.until! - before).toBeGreaterThanOrEqual(sixHours - 2000)
    expect(park.until! - before).toBeLessThanOrEqual(sixHours + 2000)
  })

  it('biz 10 封禁 → 永久 park（无 until）', async () => {
    const env = { KV: mockKV() } as unknown as Env
    await writeDeepseekPool(env, [tokenRecord('a'), tokenRecord('b')])
    const { fetchImpl } = makeFetch({ completion: [{ bizCode: 10, bizMsg: 'USER_IS_BANNED' }, { sse: fixture('completion-plain.sse.txt') }] })

    await proxyDeepseekChatRequest(env, provider, streamBody, { fetch: fetchImpl })
    const park = (await readDeepseekPool(env)).find((t) => t.id === 'a')!.park!
    expect(park.kind).toBe('banned')
    expect(park.until).toBeUndefined()
    // 永久：很久以后仍被 park
    expect(isDeepseekTokenParked({ ...tokenRecord('a'), park }, Date.now() + 1e12)).toBe(true)
  })

  it('biz 11 设备风险 → 10min 冷却 park', async () => {
    const env = { KV: mockKV() } as unknown as Env
    await writeDeepseekPool(env, [tokenRecord('a'), tokenRecord('b')])
    const before = Date.now()
    const { fetchImpl } = makeFetch({ completion: [{ bizCode: 11, bizMsg: 'RISK_DEVICE_DETECTED' }, { sse: fixture('completion-plain.sse.txt') }] })

    await proxyDeepseekChatRequest(env, provider, streamBody, { fetch: fetchImpl })
    const park = (await readDeepseekPool(env)).find((t) => t.id === 'a')!.park!
    expect(park.kind).toBe('risk')
    expect(park.until! - before).toBeGreaterThan(9 * 60 * 1000)
    expect(park.until! - before).toBeLessThanOrEqual(10 * 60 * 1000 + 2000)
  })

  /**
   * 处罚优先于鉴权判定。biz 5/10/11 常带「login」类文案，若先走 isAuthFailure
   * 就会把账号标成 expired 而**不 park**，下一次请求又打上去——处罚形同虚设。
   */
  it('处罚不会被误判成 token 失效（否则只标 expired 而不 park）', async () => {
    const env = { KV: mockKV() } as unknown as Env
    await writeDeepseekPool(env, [tokenRecord('a'), tokenRecord('b')])
    const { fetchImpl } = makeFetch({
      completion: [{ bizCode: 5, bizMsg: 'please login again, user is muted' }, { sse: fixture('completion-plain.sse.txt') }],
    })

    await proxyDeepseekChatRequest(env, provider, streamBody, { fetch: fetchImpl })
    const stored = (await readDeepseekPool(env)).find((t) => t.id === 'a')!
    expect(stored.state).toBe('ready') // 没被标失效
    expect(stored.park?.kind).toBe('muted') // 而是被 park
  })

  it('create_session 阶段遇到处罚同样 park', async () => {
    const env = { KV: mockKV() } as unknown as Env
    await writeDeepseekPool(env, [tokenRecord('a'), tokenRecord('b')])
    const { fetchImpl } = makeFetch({ createSessionBizCode: 10 })

    const resp = await proxyDeepseekChatRequest(env, provider, streamBody, { fetch: fetchImpl, newId: () => 'x' })
    // 两条都被封 → 回 account_banned
    expect(resp.status).toBe(502)
    expect((await resp.json() as Record<string, any>).error.code).toBe('account_banned')
    for (const t of await readDeepseekPool(env)) expect(t.park?.kind).toBe('banned')
  })

  it('全部被 park → 429 account_muted 且带 Retry-After（指向真实恢复时刻）', async () => {
    const env = { KV: mockKV() } as unknown as Env
    const until = new Date(Date.now() + 3600_000)
    await writeDeepseekPool(env, [tokenRecord('a'), tokenRecord('b')])
    const { fetchImpl } = makeFetch({
      completion: [
        { bizCode: 5, bizMsg: 'muted', muteUntil: until.toISOString() },
        { bizCode: 5, bizMsg: 'muted', muteUntil: until.toISOString() },
      ],
    })

    const resp = await proxyDeepseekChatRequest(env, provider, streamBody, { fetch: fetchImpl })
    expect(resp.status).toBe(429)
    const body = (await resp.json()) as Record<string, any>
    expect(body.error.code).toBe('account_muted')
    const retryAfter = Number(resp.headers.get('Retry-After'))
    expect(retryAfter).toBeGreaterThan(3000)
    expect(retryAfter).toBeLessThanOrEqual(3600)
  })

  it('全部被封禁 → 502 account_banned（永久问题，客户端不该重试）', async () => {
    const env = { KV: mockKV() } as unknown as Env
    await writeDeepseekPool(env, [tokenRecord('a')])
    const { fetchImpl } = makeFetch({ completion: [{ bizCode: 10, bizMsg: 'USER_IS_BANNED' }] })

    const resp = await proxyDeepseekChatRequest(env, provider, streamBody, { fetch: fetchImpl })
    expect(resp.status).toBe(502)
    expect((await resp.json() as Record<string, any>).error.code).toBe('account_banned')
    expect(resp.headers.get('Retry-After')).toBeNull()
  })

  it('全部设备风险 → 503 upstream_unavailable（账号被冷却，网关继续服务）', async () => {
    const env = { KV: mockKV() } as unknown as Env
    await writeDeepseekPool(env, [tokenRecord('a')])
    const { fetchImpl } = makeFetch({ completion: [{ bizCode: 11, bizMsg: 'RISK_DEVICE_DETECTED' }] })

    const resp = await proxyDeepseekChatRequest(env, provider, streamBody, { fetch: fetchImpl })
    expect(resp.status).toBe(503)
    expect((await resp.json() as Record<string, any>).error.code).toBe('upstream_unavailable')
  })

  /** 被 park 的 token 在后续请求里完全不再被选中：这才是 park 的意义。 */
  it('已 park 的 token 在下一个请求里零出站流量', async () => {
    const env = { KV: mockKV() } as unknown as Env
    await writeDeepseekPool(env, [tokenRecord('a')])
    const first = makeFetch({ completion: [{ bizCode: 10, bizMsg: 'USER_IS_BANNED' }] })
    await proxyDeepseekChatRequest(env, provider, streamBody, { fetch: first.fetchImpl })
    expect(first.seen.filter((s) => s.path.endsWith('/chat/completion'))).toHaveLength(1)

    // 第二次请求：账号已被 park，应该一条上游请求都不发
    const second = makeFetch()
    const resp = await proxyDeepseekChatRequest(env, provider, streamBody, { fetch: second.fetchImpl })
    expect(second.seen).toHaveLength(0)
    expect(resp.status).toBe(502)
    expect((await resp.json() as Record<string, any>).error.code).toBe('account_banned')
  })

  /** 持久化关闭时不写 KV，但内存里的处罚判定仍然生效（测试注入路径）。 */
  it('persist:false 时不回写 KV（测试注入的 tokens 不被静默改写）', async () => {
    const kv = mockKV()
    const env = { KV: kv } as unknown as Env
    const { fetchImpl } = makeFetch({ completion: [{ bizCode: 10, bizMsg: 'USER_IS_BANNED' }] })
    await proxyDeepseekChatRequest(env, provider, streamBody, {
      fetch: fetchImpl,
      tokens: [tokenRecord('a')],
      persist: false,
    })
    expect(kv.map.has('deepseek:pool')).toBe(false)
  })
})

describe('处罚错误形状（纯函数）', () => {
  it('pickDominantPark：全为封禁时报封禁（永久问题优先让用户知道）', () => {
    const now = 1000
    const banned = { kind: 'banned' as const, reason: 'r', at: now }
    expect(pickDominantPark([{ ...tokenRecord('a'), park: banned }], now)?.kind).toBe('banned')
  })

  it('pickDominantPark：混合时报最快恢复的那条（Retry-After 要指向真实恢复时刻）', () => {
    const now = 1000
    const picked = pickDominantPark(
      [
        { ...tokenRecord('a'), park: { kind: 'banned' as const, reason: 'r', at: now } },
        { ...tokenRecord('b'), park: { kind: 'muted' as const, until: now + 9999, reason: 'r', at: now } },
        { ...tokenRecord('c'), park: { kind: 'risk' as const, until: now + 100, reason: 'r', at: now } },
      ],
      now,
    )
    expect(picked?.kind).toBe('risk')
  })

  it('pickDominantPark：没有 park 时返回 null', () => {
    expect(pickDominantPark([tokenRecord('a')])).toBeNull()
    // 已过期的 park 不算
    expect(pickDominantPark([{ ...tokenRecord('a'), park: { kind: 'muted', until: 1, reason: 'r', at: 1 } }], 9999)).toBeNull()
  })

  it('banErrorResponse：禁言给 Retry-After，封禁/风险不给', () => {
    const now = 1_000_000
    const muted = banErrorResponse({ kind: 'muted', park: { kind: 'muted', until: now + 500_000, reason: 'r', at: now } }, now)
    expect(muted.status).toBe(429)
    expect(Number(muted.headers.get('Retry-After'))).toBe(500)

    // 窗口已过期/缺失 → 保守兜底
    const stale = banErrorResponse({ kind: 'muted', park: { kind: 'muted', until: now - 1, reason: 'r', at: now } }, now)
    expect(Number(stale.headers.get('Retry-After'))).toBe(DEEPSEEK_MUTE_RETRY_AFTER_FALLBACK_S)

    // 超过一天的窗口按一天报（对客户端没有更细的指导意义）
    const huge = banErrorResponse({ kind: 'muted', park: { kind: 'muted', until: now + 10 * 24 * 3600_000, reason: 'r', at: now } }, now)
    expect(Number(huge.headers.get('Retry-After'))).toBe(24 * 60 * 60)

    const banned = banErrorResponse({ kind: 'banned', park: { kind: 'banned', reason: 'r', at: now } }, now)
    expect(banned.status).toBe(502)
    expect(banned.headers.get('Retry-After')).toBeNull()

    const risk = banErrorResponse({ kind: 'risk', park: { kind: 'risk', until: now + 1000, reason: 'r', at: now } }, now)
    expect(risk.status).toBe(503)
    expect(risk.headers.get('Retry-After')).toBeNull()
  })
})

/**
 * 图片理解（T3 接线）：`image_url` → 上传 → `ref_file_ids`。
 * 之前这条线没接，发图会被**静默丢弃**（客户端以为带了图）。
 */
describe('图片理解接线', () => {
  const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

  /** 假上游 + 文件上传/状态查询。 */
  function makeImageFetch(readyStatus = 'SUCCESS') {
    const uploaded: string[] = []
    const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
      const path = new URL(url).pathname
      if (path === '/api/v0/chat_session/create') return json(envelope({ chat_session: { id: 'sess-1' } }))
      if (path === '/api/v0/chat/create_pow_challenge') return json(envelope({ challenge: solvableChallenge() }))
      if (path === '/api/v0/file/upload_file') {
        uploaded.push(String(init.body))
        return json(envelope({ id: `file-${uploaded.length}` }))
      }
      if (path === '/api/v0/file/fetch_files') {
        return json(envelope({ files: [{ id: `file-${uploaded.length}`, status: readyStatus }] }))
      }
      if (path === '/api/v0/chat/completion') {
        return new Response(fixture('completion-plain.sse.txt'), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
        })
      }
      return new Response('not found', { status: 404 })
    }
    return { fetchImpl, uploaded }
  }

  it('data URL 图片被上传，file id 进 ref_file_ids', async () => {
    const { fetchImpl, uploaded } = makeImageFetch()
    let completionBody = ''
    const spy = async (url: string, init: RequestInit) => {
      if (new URL(url).pathname === '/api/v0/chat/completion') completionBody = String(init.body)
      return fetchImpl(url, init)
    }

    const resp = await proxyDeepseekChatRequest({ KV: mockKV() } as unknown as Env, provider, {
      model: 'deepseek-flash',
      stream: false,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '这是什么' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${pngB64}` } },
        ],
      }],
    }, { fetch: spy, tokens: [tokenRecord('a')], persist: false })

    expect(resp.status).toBe(200)
    expect(uploaded).toHaveLength(1)
    const payload = JSON.parse(completionBody) as Record<string, unknown>
    expect(payload.ref_file_ids).toEqual(['file-1'])
    // 图片字节不进 prompt（走 ref_file_ids），文本仍在
    expect(String(payload.prompt)).toContain('这是什么')
    expect(String(payload.prompt)).not.toContain('data:image')
  })

  it('多张图按顺序上传，file id 顺序对应', async () => {
    const { fetchImpl } = makeImageFetch()
    let completionBody = ''
    const spy = async (url: string, init: RequestInit) => {
      if (new URL(url).pathname === '/api/v0/chat/completion') completionBody = String(init.body)
      return fetchImpl(url, init)
    }

    await proxyDeepseekChatRequest({ KV: mockKV() } as unknown as Env, provider, {
      model: 'deepseek-flash',
      stream: false,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${pngB64}` } },
          { type: 'image_url', image_url: { url: `data:image/gif;base64,${pngB64}` } },
        ],
      }],
    }, { fetch: spy, tokens: [tokenRecord('a')], persist: false })

    expect((JSON.parse(completionBody) as Record<string, unknown>).ref_file_ids).toEqual(['file-1', 'file-2'])
  })

  it('无图请求仍然发 ref_file_ids: []（线上形态不变）', async () => {
    const { fetchImpl, uploaded } = makeImageFetch()
    let completionBody = ''
    const spy = async (url: string, init: RequestInit) => {
      if (new URL(url).pathname === '/api/v0/chat/completion') completionBody = String(init.body)
      return fetchImpl(url, init)
    }

    await proxyDeepseekChatRequest({ KV: mockKV() } as unknown as Env, provider, {
      model: 'deepseek-flash',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    }, { fetch: spy, tokens: [tokenRecord('a')], persist: false })

    expect(uploaded).toHaveLength(0)
    expect((JSON.parse(completionBody) as Record<string, unknown>).ref_file_ids).toEqual([])
  })

  it('图片抓取失败 → 400 image_fetch_failed，且不打上游', async () => {
    const { fetchImpl, uploaded } = makeImageFetch()
    const seen: string[] = []
    const spy = async (url: string, init: RequestInit) => {
      seen.push(new URL(url).pathname)
      return fetchImpl(url, init)
    }

    const resp = await proxyDeepseekChatRequest({ KV: mockKV() } as unknown as Env, provider, {
      model: 'deepseek-flash',
      stream: false,
      messages: [{
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'https://img.test/x.png' } }],
      }],
    }, {
      fetch: spy,
      imageFetch: async () => new Response('nope', { status: 500 }),
      tokens: [tokenRecord('a')],
      persist: false,
    })

    expect(resp.status).toBe(400)
    expect((await resp.json() as Record<string, any>).error.code).toBe('image_fetch_failed')
    expect(uploaded).toHaveLength(0)
    expect(seen).toHaveLength(0)
  })

  it('上传失败 → 502 upload_failed，且**不**标 token 失效（账号没问题）', async () => {
    const kv = mockKV()
    const env = { KV: kv } as unknown as Env
    await writeDeepseekPool(env, [tokenRecord('a')])
    const fetchImpl = async (url: string): Promise<Response> => {
      const path = new URL(url).pathname
      if (path === '/api/v0/chat/create_pow_challenge') return json(envelope({ challenge: solvableChallenge() }))
      if (path === '/api/v0/file/upload_file') return new Response('boom', { status: 500 })
      return new Response('not found', { status: 404 })
    }

    const resp = await proxyDeepseekChatRequest(env, provider, {
      model: 'deepseek-flash',
      stream: false,
      messages: [{
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${pngB64}` } }],
      }],
    }, { fetch: fetchImpl })

    expect(resp.status).toBe(502)
    expect((await resp.json() as Record<string, any>).error.code).toBe('upload_failed')
    // token 没被标失效：图片上传失败不是账号的错
    expect((await readDeepseekPool(env))[0].state).toBe('ready')
  })
})

/**
 * 非流式路径的 parallel_chat_limit 重试。
 * 该错误以**流内 hint** 到达（不是抛错），非流式此时还没回任何字节，所以能换号重试；
 * 不重试就会把一个「换个账号就好」的情况报成 502。
 */
describe('parallel_chat_limit 非流式重试', () => {
  const parallelSse = [
    'event: hint',
    'data: {"type":"error","content":"another generation is running","clear_response":true,"finish_reason":"parallel_chat_limit"}',
    '',
    'event: close',
    '',
  ].join('\n')

  it('非流式遇到 parallel_chat_limit 会换下一条 token 重试并成功', async () => {
    const env = { KV: mockKV() } as unknown as Env
    await writeDeepseekPool(env, [tokenRecord('a'), tokenRecord('b')])
    const { fetchImpl, seen } = makeFetch({
      completion: [{ sse: parallelSse }, { sse: fixture('completion-plain.sse.txt') }],
    })
    const attempts: string[] = []

    const resp = await proxyDeepseekChatRequest(env, provider, {
      model: 'deepseek-flash',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    }, { fetch: fetchImpl, onAttempt: (rec) => attempts.push(rec.id) })

    expect(resp.status).toBe(200)
    expect(attempts).toEqual(['a', 'b'])
    expect((await resp.json() as Record<string, any>).choices[0].message.content).toBe('你好')
    expect(seen.filter((s) => s.path.endsWith('/chat/completion'))).toHaveLength(2)
  })

  it('只有一条 token 时不再重试，直接报上游错误（不空转）', async () => {
    const env = { KV: mockKV() } as unknown as Env
    await writeDeepseekPool(env, [tokenRecord('a')])
    const { fetchImpl, seen } = makeFetch({ completion: [{ sse: parallelSse }] })

    const resp = await proxyDeepseekChatRequest(env, provider, {
      model: 'deepseek-flash',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    }, { fetch: fetchImpl })

    expect(resp.status).toBe(502)
    expect(seen.filter((s) => s.path.endsWith('/chat/completion'))).toHaveLength(1)
  })
})
