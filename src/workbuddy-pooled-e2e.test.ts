import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { handleProxy } from './proxy'
import { writeOauthPool, __resetOauthPoolRuntimeForTests } from './oauth-pool'
import { OAUTH_POOL_KV_PREFIX } from './oauth'
import { __resetStickyCacheForTests, STICKY_KV_PREFIX } from './workbuddy-sticky'
import { __resetSessionIdsForTests } from './workbuddy-session-ids'
import { __resetInFlightForTests, inFlightOf, inFlightSnapshot } from './workbuddy-inflight'
import { clearCache } from './storage'
import type { AppEnv, Env, OAuthTokenState, Provider } from './types'

/**
 * WorkBuddy 池化代理的**端到端集成测试**（经 handleProxy → forwardProxy → 池化核心）。
 *
 * 覆盖本次移植的两项行为（单元测试无法证明它们真的接进了请求路径）：
 *  1. **会话粘性**：同一会话的多轮请求应打到同一账号（而非每次重新随机挑号）；
 *  2. **会话头族**：出站请求应携带 X-Conversation-Request-ID 等头，且同一会话多轮
 *     复用同一聚合主键（上游后台按对话轮聚合）。
 *
 * 以及 stream_options / 协议头是否真的出现在出站请求上。
 */

const PID = 'workbuddy-e2e'

function makeJwt(uid: string): string {
  const b64url = (o: unknown) => {
    const b64 = btoa(JSON.stringify(o))
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  // iss 含 codebuddy.cn → detectTokenRealm 判为 cn（走 CN base）
  return `${b64url({ alg: 'HS256' })}.${b64url({ iss: 'https://www.codebuddy.cn', uid })}.sig`
}

function makeToken(uid: string): OAuthTokenState {
  return {
    access_token: makeJwt(uid),
    refresh_token: `rt-${uid}`,
    expires_at: Date.now() + 2 * 60 * 60 * 1000,
    updated_at: Date.now(),
  } as OAuthTokenState
}

function makeProvider(overrides?: Partial<Provider>): Provider {
  return {
    id: PID,
    name: 'WorkBuddy E2E',
    authType: 'oauth-device',
    baseUrl: 'https://copilot.tencent.com/v2',
    apiKeys: [],
    models: [{ id: 'deepseek-v4-flash', enabled: true }],
    enabled: true,
    oauth: {
      flowType: 'browser',
      deviceCodeUrl: 'https://copilot.tencent.com/v2/plugin/auth/state',
      deviceTokenUrl: 'https://copilot.tencent.com/v2/plugin/auth/token',
      refreshTokenUrl: 'https://copilot.tencent.com/v2/plugin/auth/token/refresh',
      tokenHeader: 'Authorization',
      tokenHeaderPrefix: 'Bearer ',
      extraHeaders: { Origin: 'https://www.codebuddy.cn', Referer: 'https://www.codebuddy.cn/' },
    },
    ...overrides,
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
  const env = { KV: kv, GATEWAY_KV: kv, RATE_LIMIT_KV: kv, SESSION_KV: kv } as unknown as Env
  const app = makeApp(env)
  return { env, store, app }
}

/** 构造一个最小 SSE 成功响应（含 usage.credit，供成本账本路径）。 */
function sseResponse(): Response {
  const body = [
    'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-flash","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}',
    '',
    'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-flash","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15,"credit":1}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n')
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

/** 记录每次出站请求的 url 与 headers。 */
interface Call { url: string; headers: Record<string, string>; body: string }

function installFetchMock(calls: Call[]) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
    const h: Record<string, string> = {}
    const raw = (init?.headers || {}) as Record<string, string>
    for (const k of Object.keys(raw)) h[k.toLowerCase()] = String(raw[k])
    calls.push({ url: u, headers: h, body: typeof init?.body === 'string' ? init.body : '' })
    return sseResponse()
  })
}

/** 用真实 Hono app 承载 handleProxy（Context 需 get/json/req/executionCtx 等完整能力）。 */
function makeApp(env: Env) {
  const app = new Hono<AppEnv>()
  app.post('/v1/chat/completions', (c) => handleProxy(c))
  return {
    async post(bodyObj: Record<string, unknown>, headers: Record<string, string> = {}) {
      const req = new Request('https://gw.test/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(bodyObj),
      })
      return app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext)
    },
  }
}

describe('WorkBuddy 池化代理端到端（粘性 + 会话头族 + 协议头）', () => {
  let calls: Call[]

  beforeEach(() => {
    __resetOauthPoolRuntimeForTests()
    __resetStickyCacheForTests()
    __resetSessionIdsForTests()
    __resetInFlightForTests()
    // storage 的 providers/proxyKeys 缓存有 10s TTL 且是模块级 —— 跨测试串扰会让
    // 本测试读到上一个测试的 provider 配置（如 maxInFlight 不同）。每次清空。
    clearCache()
    calls = []
    vi.stubGlobal('fetch', installFetchMock(calls))
  })

  afterEach(() => { vi.unstubAllGlobals() })

  async function seedPool(env: Env, uids: string[], credits: Record<string, number> = {}) {
    await writeOauthPool(env, PID, uids.map((uid) => ({
      uid,
      nickname: uid,
      token: makeToken(uid),
      enabled: true,
      state: { credits: credits[uid] ?? 100, disabled: false, until: 0, errCount: 0 },
      updatedAt: Date.now(),
    })))
  }

  it('出站携带 stream_options.include_usage（P0-1：成本账本依赖末帧 usage）', async () => {
    const { env, app } = makeEnv([makeProvider()])
    await seedPool(env, ['u1'])

    const res = await app.post({
      model: `${PID}/deepseek-v4-flash`,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    })
    expect(res.status).toBe(200)

    expect(calls.length).toBeGreaterThan(0)
    const body = JSON.parse(calls[0].body)
    expect(body.stream_options).toEqual({ include_usage: true })
    expect(body.stream).toBe(true)
  })

  it('出站携带协议头：X-CodeBuddy-Request / Accept-Language / UA / Accept（P0-4）', async () => {
    const { env, app } = makeEnv([makeProvider()])
    await seedPool(env, ['u1'])

    await app.post({
      model: `${PID}/deepseek-v4-flash`,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    })

    const h = calls[0].headers
    expect(h['x-codebuddy-request']).toBe('1')
    expect(h['accept-language']).toBe('zh-CN')
    expect(h['x-requested-with']).toBe('XMLHttpRequest')
    expect(h['user-agent']).toMatch(/^WorkBuddy\/.+ WorkBuddy\/.+ CLI\/.+$/)
    expect(h['accept']).toBe('application/json, text/event-stream')
    expect(h['x-ide-name']).toBe('WorkBuddy')
    expect(h['x-product']).toBe('WorkBuddy')
  })

  it('出站携带会话头族（P0-6）：聚合主键 + 消息级 ID + B3', async () => {
    const { env, app } = makeEnv([makeProvider()])
    await seedPool(env, ['u1'])

    await app.post({
      model: `${PID}/deepseek-v4-flash`,
      conversationId: 'conv-abc',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    })

    const h = calls[0].headers
    expect(h['x-conversation-id']).toBe('conv-abc')
    expect(h['x-conversation-request-id']).toMatch(/^[0-9a-f]{32}$/)
    expect(h['x-root-request-id']).toBe(h['x-conversation-request-id'])
    expect(h['x-conversation-message-id']).toMatch(/^[0-9a-f]{32}$/)
    expect(h['x-request-id']).toBe(h['x-conversation-message-id'])
    expect(h['x-b3-traceid']).toBe(h['x-conversation-request-id'])
    expect(h['x-b3-spanid']).toBe(h['x-conversation-message-id'].slice(0, 16))
    expect(h['x-b3-sampled']).toBe('1')
  })

  it('同一会话多轮 → 会话头族聚合主键恒定（上游按对话轮聚合）', async () => {
    const { env, app } = makeEnv([makeProvider()])
    await seedPool(env, ['u1'])

    const base = {
      model: `${PID}/deepseek-v4-flash`,
      conversationId: 'conv-multi',
      stream: false,
    }
    await app.post({ ...base, messages: [{ role: 'user', content: 'q1' }] })
    await app.post({ ...base, messages: [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ] })

    expect(calls.length).toBeGreaterThanOrEqual(2)
    const c1 = calls[0].headers['x-conversation-request-id']
    const c2 = calls[1].headers['x-conversation-request-id']
    // 同一 conversationId（会话键）→ 聚合主键恒定
    expect(c2).toBe(c1)
    // 但消息级 ID 每轮不同
    expect(calls[1].headers['x-conversation-message-id']).not.toBe(calls[0].headers['x-conversation-message-id'])
  })

  it('会话粘性：同一会话多轮打到同一账号（而非每次重新随机挑号）', async () => {
    const { env, store, app } = makeEnv([makeProvider()])
    // 3 个账号，credits 相同 → 无粘性时三因子加权会随机分散
    await seedPool(env, ['ua', 'ub', 'uc'])

    const base = {
      model: `${PID}/deepseek-v4-flash`,
      conversationId: 'conv-sticky',
      stream: false,
    }
    for (let i = 0; i < 4; i++) {
      await app.post({ ...base, messages: [{ role: 'user', content: `turn-${i}` }] })
    }

    expect(calls.length).toBe(4)
    // 4 轮全部打到同一账号（从 X-User-Id 看）
    const uids = calls.map((c) => c.headers['x-user-id'])
    expect(new Set(uids).size).toBe(1)

    // KV 里应存在该会话的粘性绑定
    const stickyRaw = store.get(STICKY_KV_PREFIX + PID)
    expect(stickyRaw).toBeTruthy()
    const sticky = JSON.parse(stickyRaw!)
    expect(sticky['conv-sticky']?.uid).toBe(uids[0])
  })

  it('不同会话可分散到不同账号（粘性不破坏负载分散）', async () => {
    const { env, app } = makeEnv([makeProvider()])
    await seedPool(env, ['ua', 'ub', 'uc', 'ud', 'ue'])

    // 20 个不同会话 → 期望不止一个账号被用到
    for (let i = 0; i < 20; i++) {
      await app.post({
        model: `${PID}/deepseek-v4-flash`,
        conversationId: `conv-${i}`,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      })
    }

    const uids = new Set(calls.map((c) => c.headers['x-user-id']))
    expect(uids.size).toBeGreaterThan(1)
  })

  it('无 conversationId 的客户端：按最后一条 user 消息派生轮级聚合键（同轮恒定）', async () => {
    const { env, app } = makeEnv([makeProvider()])
    await seedPool(env, ['u1'])

    // 同一轮内两次调用（模拟 tool call 多轮）：messages 前缀相同、末条 user 相同
    const msgs = [{ role: 'user', content: 'same-turn' }]
    await app.post({ model: `${PID}/deepseek-v4-flash`, messages: msgs, stream: false })
    await app.post({
      model: `${PID}/deepseek-v4-flash`,
      messages: [...msgs, { role: 'assistant', content: 'x' }, { role: 'tool', content: 'y' }],
      stream: false,
    })

    expect(calls[1].headers['x-conversation-request-id']).toBe(calls[0].headers['x-conversation-request-id'])
  })

  it('入站 X-Conversation-Request-ID 头优先透传', async () => {
    const { env, app } = makeEnv([makeProvider()])
    await seedPool(env, ['u1'])

    await app.post(
      {
        model: `${PID}/deepseek-v4-flash`,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      },
      { 'X-Conversation-Request-ID': 'inbound-xyz' },
    )

    expect(calls[0].headers['x-conversation-request-id']).toBe('inbound-xyz')
  })

  it('粘性号被 6004 模型级限额后重分配（不钉在不可用号上）', async () => {
    const { env, store, app } = makeEnv([makeProvider()])
    await seedPool(env, ['ua', 'ub'])

    // ua 被当前模型限额：必须经 writeOauthPool 写回（它同步更新 readOauthPool 的 1s 内存缓存，
    // 直接改 KV 会被缓存遮蔽 —— 这也是生产路径的一致性保证）。
    const { readOauthPool } = await import('./oauth-pool')
    const pool = await readOauthPool(env, PID)
    const ua = pool.find((a) => a.uid === 'ua')!
    ua.state.softRateModels = { 'deepseek-v4-flash': { until: Date.now() + 60000, resetAt: Date.now() + 60000, reason: '6004' } }
    await writeOauthPool(env, PID, pool)

    // 预置：会话绑定到 ua（写 KV + 清内存缓存，保证被读到）
    store.set(STICKY_KV_PREFIX + PID, JSON.stringify({ 'conv-limited': { uid: 'ua', lastActive: Date.now() } }))
    __resetStickyCacheForTests()
    __resetOauthPoolRuntimeForTests()

    await app.post({
      model: `${PID}/deepseek-v4-flash`,
      conversationId: 'conv-limited',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    })

    // 不应打到被限额的 ua，应重分配到 ub
    expect(calls[0].headers['x-user-id']).toBe('ub')
    // 粘性已重绑到 ub
    const sticky = JSON.parse(store.get(STICKY_KV_PREFIX + PID)!)
    expect(sticky['conv-limited']?.uid).toBe('ub')
  })

  it('在途租约：成功请求后名额被释放（不泄漏，否则该号永久被判满）', async () => {
    const { env, app } = makeEnv([makeProvider()])
    await seedPool(env, ['u1'])

    // 连发 6 次（远超默认 maxInFlight=3）：若名额泄漏，第 4 次起会因"唯一账号被判满"而 503
    for (let i = 0; i < 6; i++) {
      const res = await app.post({
        model: `${PID}/deepseek-v4-flash`,
        conversationId: `conv-inflight-${i}`,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      })
      expect(res.status).toBe(200)
    }

    // 全部完成后在途计数归零
    expect(inFlightOf(PID, 'u1')).toBe(0)
    expect(inFlightSnapshot().length).toBe(0)
  })

  it('在途租约：失败轮转路径也释放名额（错误分类分支不泄漏）', async () => {
    const { env, app } = makeEnv([makeProvider()])
    await seedPool(env, ['u1'])

    // 让上游返回 5xx（走 server 分类分支 → continue），随后恢复 200
    let call = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      call++
      if (call === 1) return new Response('boom', { status: 500 })
      return sseResponse()
    }))

    const res = await app.post({
      model: `${PID}/deepseek-v4-flash`,
      conversationId: 'conv-fail-path',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    })
    expect(res.status).toBe(200)
    // 名额已释放
    expect(inFlightOf(PID, 'u1')).toBe(0)
  })

  it('内容拦截：立即 400 返回防火墙文案，**不轮转换号**', async () => {
    const { env, app } = makeEnv([makeProvider()])
    // 3 个账号：若发生轮转，会打到多个账号
    await seedPool(env, ['ua', 'ub', 'uc'])

    let n = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      n++
      // 上游返回内容拦截（400 + 审核文案）
      return new Response(
        JSON.stringify({ error: { data: { code: 11128, msg: 'blocked by security policy 色情' } } }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      )
    }))

    const res = await app.post({
      model: `${PID}/deepseek-v4-flash`,
      messages: [{ role: 'user', content: 'bad content' }],
      stream: false,
    })

    // 回 400（而非 503 no_healthy_account）
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { message: string; type: string } }
    expect(body.error.type).toBe('content_blocked')
    // 防火墙口径文案：含分类词，不含上游业务码
    expect(body.error.message).toContain('色情')
    expect(body.error.message).toContain('内容防火墙规则')
    expect(body.error.message).not.toContain('11128')

    // **关键**：未轮转换号——passthrough 默认只对**同一账号**做 1 次中性提示词降级重试
    //（先撞一次 content_blocked → 换 Degraded 提示词重试），仍被拦才回内容墙；不跨账号轮转。
    expect(n).toBe(2)
  })

  it('内容拦截：custom 模式已替换自有提示词，不做降级重试（只打 1 次上游，不轮转）', async () => {
    const { env, app } = makeEnv([makeProvider({ promptMode: 'custom', promptText: '[GW] 自有提示词' })])
    // 3 个账号：若发生轮转，会打到多个账号
    await seedPool(env, ['ua', 'ub', 'uc'])

    let n = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      n++
      return new Response(
        JSON.stringify({ error: { data: { code: 11128, msg: 'blocked by security policy 色情' } } }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      )
    }))

    const res = await app.post({
      model: `${PID}/deepseek-v4-flash`,
      messages: [{ role: 'user', content: 'bad content' }],
      stream: false,
    })
    expect(res.status).toBe(400)
    // custom 模式被拦 → 直接回内容墙（不降级重试），故只打 1 次上游
    expect(n).toBe(1)
  })

  it('内容拦截不罚账号（账号仍可用，后续正常请求成功）', async () => {
    const { env, app } = makeEnv([makeProvider()])
    await seedPool(env, ['ua'])

    // 第一次：内容拦截
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { data: { code: 11128, msg: 'blocked by security policy' } } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )))
    const r1 = await app.post({
      model: `${PID}/deepseek-v4-flash`,
      messages: [{ role: 'user', content: 'bad' }],
      stream: false,
    })
    expect(r1.status).toBe(400)

    // 第二次：正常请求应成功（账号未被禁用/冷却）
    vi.stubGlobal('fetch', installFetchMock(calls))
    const r2 = await app.post({
      model: `${PID}/deepseek-v4-flash`,
      messages: [{ role: 'user', content: 'good' }],
      stream: false,
    })
    expect(r2.status).toBe(200)
    expect(calls.length).toBeGreaterThan(0)
  })

  it('上游 400 客户端/参数错误不轮转、不罚账号，直接返回 400 invalid_request_error（避免误报 503）', async () => {
    const { env, app } = makeEnv([makeProvider()])
    // 放入两个可用账号
    await seedPool(env, ['u1', 'u2'])

    let n = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      n++
      return new Response(
        JSON.stringify({ code: 11101, msg: 'Unmarshal chat params failed with error: unexpected EOF' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      )
    }))

    const r1 = await app.post({
      model: `${PID}/deepseek-v4-flash`,
      messages: [{ role: 'user', content: 'bad params' }],
      stream: false,
    })

    // 必须直接返回 400（不是 503 OAuth 账号池无可用账号）
    expect(r1.status).toBe(400)
    const errBody = await r1.json() as { error: { message: string; type: string; code?: unknown } }
    expect(errBody.error.type).toBe('invalid_request_error')
    expect(errBody.error.message).toContain('Unmarshal chat params failed')
    expect(errBody.error.code).toBe(11101)

    // 核心断言：必须只调用了 1 次上游，没有盲目在 u1 和 u2 之间轮换
    expect(n).toBe(1)

    // 随后正常请求应成功（账号未被冷却/禁用）
    vi.stubGlobal('fetch', installFetchMock(calls))
    const r2 = await app.post({
      model: `${PID}/deepseek-v4-flash`,
      messages: [{ role: 'user', content: 'good' }],
      stream: false,
    })
    expect(r2.status).toBe(200)
  })

  it('在途租约：账号池全部被判满时返回 503（租约确实在生效）', async () => {    // 用自定义 maxInFlight=1 的 provider 简化观察。
    // 注意：storage.getProviders 有 10s 模块级缓存，同一测试内不可多次 makeEnv 换 provider
    // （会读到上一个 provider 配置），故这里一次性构造。
    const p = makeProvider()
    p.oauth!.maxInFlight = 1
    const { env, app } = makeEnv([p])
    await seedPool(env, ['u1'])

    let release: (() => void) | null = null
    const gate = new Promise<void>((r) => { release = r })
    let n = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      n++
      // 仅第一个请求阻塞（占住唯一名额）；第二个请求不会走到 fetch（被租约拦在 503）
      if (n === 1) await gate
      return sseResponse()
    }))

    // 第一个请求占住唯一名额
    const first = app.post({
      model: `${PID}/deepseek-v4-flash`,
      conversationId: 'conv-block-1',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    })
    // 等它进入 fetch（占住名额）
    await new Promise((r) => setTimeout(r, 20))
    expect(inFlightOf(PID, 'u1')).toBe(1)

    // 第二个请求：唯一账号已满 → 503（且不会发起上游调用）
    const second = await app.post({
      model: `${PID}/deepseek-v4-flash`,
      conversationId: 'conv-block-2',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    })
    expect(second.status).toBe(503)
    expect(n).toBe(1)

    // 放行第一个，确认恢复正常
    release!()
    expect((await first).status).toBe(200)
    expect(inFlightOf(PID, 'u1')).toBe(0)
  })

  // ===== 上游 error 帧透传（移植 workbuddy2api 5755fe3 error-passthrough）=====
  //
  // 缺陷现场：聚合路径只读 id/model/created/usage/choices，带 error 的帧被静默跳过，
  // 结果是 **200 + 空内容** —— 客户端既拿不到错误也拿不到内容。
  // 流式路径更早的缺陷是 normalizeWorkbuddyFrame 白名单把 error 整键剥掉，
  // 帧被替换成语义为空的 chunk。以下测试锁死修复后的行为。

  /** 构造一个 200 状态但流内带 error 帧的 SSE 响应（上游常见形态）。 */
  function sseErrorResponse(errorFrame: Record<string, unknown>): Response {
    const body = [
      `data: ${JSON.stringify(errorFrame)}`,
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }

  it('非流式：流内 6004 错误帧 → 429 + 上游 code/msg/requestId（不再产出 200 空内容）', async () => {
    const { env, app } = makeEnv([makeProvider()])
    await seedPool(env, ['u1'])

    vi.stubGlobal('fetch', vi.fn(async () => sseErrorResponse({
      error: { code: 6004, msg: 'The model provider is rate-limiting requests.', requestId: 'req-rl-42' },
    })))

    const res = await app.post({
      model: `${PID}/deepseek-v4-flash`,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    })

    // 关键：**不是** 200
    expect(res.status).toBe(429)
    const body = await res.json() as { error: { message: string; type: string; code?: unknown; request_id?: unknown } }
    expect(body.error.type).toBe('rate_limit_exceeded')
    expect(body.error.code).toBe(6004)
    expect(body.error.message).toBe('The model provider is rate-limiting requests.')
    expect(body.error.request_id).toBe('req-rl-42')
  })

  it('非流式：非 6004 错误帧（11102 无此模型）→ 502 + 上游 code', async () => {
    const { env, app } = makeEnv([makeProvider()])
    await seedPool(env, ['u1'])

    vi.stubGlobal('fetch', vi.fn(async () => sseErrorResponse({
      error: { code: 11102, msg: 'service info not found' },
    })))

    const res = await app.post({
      model: `${PID}/deepseek-v4-flash`,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    })
    expect(res.status).toBe(502)
    const body = await res.json() as { error: { code?: unknown; type: string } }
    expect(body.error.type).toBe('upstream_error')
    expect(body.error.code).toBe(11102)
  })

  it('非流式：错误文案经网关脱敏（内网地址被剥离，不透传裸上游文本）', async () => {
    const { env, app } = makeEnv([makeProvider()])
    await seedPool(env, ['u1'])

    vi.stubGlobal('fetch', vi.fn(async () => sseErrorResponse({
      error: { code: 500, msg: 'upstream failed, see http://10.0.0.5/admin/diag for details', requestId: 'req-x' },
    })))

    const res = await app.post({
      model: `${PID}/deepseek-v4-flash`,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    })
    const body = await res.json() as { error: { message: string } }
    // 内网地址被 sanitizeUpstreamError 剥离
    expect(body.error.message).not.toContain('10.0.0.5')
    expect(body.error.message).toContain('upstream failed')
  })

  it('流式：错误帧原样透传（code/msg/requestId 可见，且不被白名单剥成空 chunk）', async () => {
    const { env, app } = makeEnv([makeProvider()])
    await seedPool(env, ['u1'])

    vi.stubGlobal('fetch', vi.fn(async () => sseErrorResponse({
      error: { code: 6004, msg: 'The model provider is rate-limiting requests.', requestId: 'req-stream-1' },
    })))

    const res = await app.post({
      model: `${PID}/deepseek-v4-flash`,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('"code":6004')
    expect(text).toContain('rate-limiting requests')
    expect(text).toContain('req-stream-1')
    // 没有被替换成空 chunk 壳
    expect(text).not.toContain('"id":"chatcmpl-wb2api"')
  })

  // ===== gateway_hint：错误附加说明字段（移植 76bb543 / a749016 / fa7b5d9）=====

  it('非流式：6004 错误体附加 error.gateway_hint，message/code/request_id 一字不改', async () => {
    const { env, app } = makeEnv([makeProvider()])
    await seedPool(env, ['u1'])

    vi.stubGlobal('fetch', vi.fn(async () => sseErrorResponse({
      error: { code: 6004, msg: 'The model provider is rate-limiting requests.', requestId: 'req-hint-1' },
    })))

    const res = await app.post({
      model: `${PID}/deepseek-v4-flash`,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    })
    expect(res.status).toBe(429)
    const body = await res.json() as { error: { message: string; type: string; code?: unknown; request_id?: unknown; gateway_hint?: unknown } }
    expect(body.error.gateway_hint).toBe('rate limited by upstream; retry after reset')
    // hint 只做并列补充：既有字段与文案原样
    expect(body.error.message).toBe('The model provider is rate-limiting requests.')
    expect(body.error.code).toBe(6004)
    expect(body.error.request_id).toBe('req-hint-1')
    expect(body.error.type).toBe('rate_limit_exceeded')
  })

  it('非流式：11102（无此模型）错误体附加换模型 hint', async () => {
    const { env, app } = makeEnv([makeProvider()])
    await seedPool(env, ['u1'])

    vi.stubGlobal('fetch', vi.fn(async () => sseErrorResponse({
      error: { code: 11102, msg: 'service info not found' },
    })))

    const res = await app.post({
      model: `${PID}/deepseek-v4-flash`,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    })
    expect(res.status).toBe(502)
    const body = await res.json() as { error: { message: string; gateway_hint?: unknown } }
    expect(body.error.gateway_hint).toBe('upstream has no such model on this backend; switch model or retry on another account')
    expect(body.error.message).toBe('service info not found')
  })

  it('非流式：未覆盖形态（500）不带 gateway_hint 字段（不编造）', async () => {
    const { env, app } = makeEnv([makeProvider()])
    await seedPool(env, ['u1'])

    vi.stubGlobal('fetch', vi.fn(async () => sseErrorResponse({
      error: { code: 500, msg: 'internal upstream failure' },
    })))

    const res = await app.post({
      model: `${PID}/deepseek-v4-flash`,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    })
    expect(res.status).toBe(502)
    const body = await res.json() as { error: Record<string, unknown> }
    // 字段**缺席**（不是空串）
    expect('gateway_hint' in body.error).toBe(false)
    expect(body.error.message).toBe('internal upstream failure')
  })

  it('流式：错误帧透出时附加 gateway_hint，且 message/code/requestId 原文不变', async () => {
    const { env, app } = makeEnv([makeProvider()])
    await seedPool(env, ['u1'])

    vi.stubGlobal('fetch', vi.fn(async () => sseErrorResponse({
      error: { code: 6004, msg: 'The model provider is rate-limiting requests.', requestId: 'req-stream-hint' },
    })))

    const res = await app.post({
      model: `${PID}/deepseek-v4-flash`,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('"gateway_hint":"rate limited by upstream; retry after reset"')
    // 原文不动
    expect(text).toContain('rate-limiting requests')
    expect(text).toContain('"code":6004')
    expect(text).toContain('req-stream-hint')
  })

  it('P0-1（移植 145220d）：429 带 quota 措辞 → 短冷却，不再误判硬冷却到次日 04:00', async () => {
    const { env, store, app } = makeEnv([makeProvider()])
    await seedPool(env, ['u1'])

    // 上游 429 + 跨「计费/限流」两界的措辞（旧顺序：余额关键词先判 → hard_credit → 白扔号约 12h）
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"quota exceeded"}}', {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    })))

    await app.post({
      model: `${PID}/deepseek-v4-flash`,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    })

    const pool = JSON.parse(store.get(OAUTH_POOL_KV_PREFIX + PID)!) as Array<{ uid: string; state: { reason?: string; until?: number } }>
    const st = pool.find((a) => a.uid === 'u1')!.state
    // hard_credit 分支写 reason='余额不足' + until≈次日 04:00；soft_rate 分支写 '429 rate limit'
    expect(st.reason).toBe('429 rate limit')
    expect((st.until || 0) - Date.now()).toBeLessThanOrEqual(60 * 60 * 1000)
  })

  it('P0-3（移植 edb9e97）：出站把 max_completion_tokens 翻译成 max_tokens（DSH 只发别名）', async () => {
    const { env, app } = makeEnv([makeProvider()])
    await seedPool(env, ['u1'])

    await app.post({
      model: `${PID}/deepseek-v4-flash`,
      messages: [{ role: 'user', content: 'hi' }],
      // DSH 实测发的别名；上游只认 max_tokens，不翻译会回落默认 ~32000 截断长回答
      max_completion_tokens: 128000,
      stream: false,
    })

    const body = JSON.parse(calls[0].body)
    expect(body.max_tokens).toBe(128000)
    expect(body.max_completion_tokens).toBeUndefined()
  })

  it('P0-2（移植 0a86854）：非流式上游 200 空流 → 502 + code=upstream_parse（不再产出假成功 200）', async () => {
    const { env, app } = makeEnv([makeProvider()])
    await seedPool(env, ['u1'])

    // 200 + 只有 [DONE]（0 有效数据帧）
    vi.stubGlobal('fetch', vi.fn(async () => new Response('data: [DONE]\n\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })))

    const res = await app.post({
      model: `${PID}/deepseek-v4-flash`,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    })

    expect(res.status).toBe(502)
    const body = await res.json() as { error: { message: string; code: string } }
    expect(body.error.code).toBe('upstream_parse')
    expect(body.error.message).toContain('empty upstream stream')
  })

  it('P0-2（移植 0a86854）：流式上游 200 空流 → 补 error 帧 + [DONE]（客户端能知道失败）', async () => {
    const { env, app } = makeEnv([makeProvider()])
    await seedPool(env, ['u1'])

    // 完全空体：0 帧，连 [DONE] 都没有
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })))

    const res = await app.post({
      model: `${PID}/deepseek-v4-flash`,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })

    // HTTP 头早已发出（wire 仍 200），失败靠帧内 error 表达
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('"code":"upstream_parse"')
    expect(text).toContain('empty upstream stream')
    expect(text).toContain('data: [DONE]')
  })

  it('P0-2 反例：只有 [DONE] 的流式空流同样补帧（不被当成正常收尾）', async () => {
    const { env, app } = makeEnv([makeProvider()])
    await seedPool(env, ['u1'])

    vi.stubGlobal('fetch', vi.fn(async () => new Response('data: [DONE]\n\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })))

    const res = await app.post({
      model: `${PID}/deepseek-v4-flash`,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })

    const text = await res.text()
    // 上游那个 [DONE] 被扣留，补的是 error 帧 + 恰好一个 [DONE]
    expect(text).toContain('upstream_parse')
    expect(text.match(/data: \[DONE\]/g)?.length).toBe(1)
  })

  it('P1-1（移植 5c2db2f）：两个缺 index 的 tool_call 不被并进同一槽（参数不串联、name 不覆盖）', async () => {
    const { env, app } = makeEnv([makeProvider()])
    await seedPool(env, ['u1'])

    const body = [
      'data: {"id":"x1","choices":[{"index":0,"delta":{"tool_calls":[{"id":"call_a","type":"function","function":{"name":"f1","arguments":"{\\"a\\":1}"}}]}}]}',
      '',
      'data: {"id":"x1","choices":[{"index":0,"delta":{"tool_calls":[{"id":"call_b","type":"function","function":{"name":"f2","arguments":"{\\"b\\":2}"}}]}}]}',
      '',
      'data: {"id":"x1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })))

    const res = await app.post({
      model: `${PID}/deepseek-v4-flash`,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    })
    expect(res.status).toBe(200)
    const json = await res.json() as { choices: { message: { tool_calls: { function: { name: string; arguments: string } }[] } }[] }
    const callsOut = json.choices[0].message.tool_calls
    expect(callsOut).toHaveLength(2)
    expect(callsOut.map(c => c.function.name).sort()).toEqual(['f1', 'f2'])
    expect(callsOut.map(c => c.function.arguments).sort()).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('P1-1 对照：合规 index 流不受影响，缺 index 的补位不覆盖既有槽', async () => {
    const { env, app } = makeEnv([makeProvider()])
    await seedPool(env, ['u1'])

    const body = [
      'data: {"id":"x1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"f1","arguments":"{\\"a\\":1}"}}]}}]}',
      '',
      'data: {"id":"x1","choices":[{"index":0,"delta":{"tool_calls":[{"id":"call_b","type":"function","function":{"name":"f2","arguments":"{\\"b\\":2}"}}]}}]}',
      '',
      'data: {"id":"x1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })))

    const res = await app.post({
      model: `${PID}/deepseek-v4-flash`,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    })
    const json = await res.json() as { choices: { message: { tool_calls: { index: number; function: { name: string; arguments: string } }[] } }[] }
    const callsOut = json.choices[0].message.tool_calls
    expect(callsOut).toHaveLength(2)
    expect(new Set(callsOut.map(c => c.index)).size).toBe(2)
    expect(callsOut.find(c => c.index === 0)?.function.arguments).toBe('{"a":1}')
  })

  it('P1-2（移植 65b2f33）：EOF 截断（无 [DONE]）的残缺 tool_call 参数被丢弃，不交给客户端', async () => {
    const { env, app } = makeEnv([makeProvider()])
    await seedPool(env, ['u1'])

    // 无 [DONE] 收尾（连接中断），arguments 只剩半截 JSON
    const body = [
      'data: {"id":"x1","choices":[{"index":0,"delta":{"role":"assistant","content":"","tool_calls":[{"id":"call_a","type":"function","function":{"name":"bash","arguments":"{\\"cmd\\":"},"index":0}]}}]}',
      '',
      'data: {"id":"x1","choices":[{"index":0,"delta":{"tool_calls":[{"function":{"arguments":"\\"ls\\""},"index":0}]}}]}',
      '',
    ].join('\n')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })))

    const res = await app.post({
      model: `${PID}/deepseek-v4-flash`,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    })
    expect(res.status).toBe(200)
    const json = await res.json() as { choices: { message: { tool_calls?: unknown } }[] }
    expect(json.choices[0].message.tool_calls).toBeUndefined()
  })

  it('P1-2 对照：正常 [DONE] 收尾的完整 tool_call 不被误伤', async () => {
    const { env, app } = makeEnv([makeProvider()])
    await seedPool(env, ['u1'])

    const body = [
      'data: {"id":"x1","choices":[{"index":0,"delta":{"tool_calls":[{"id":"call_a","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":\\"北京\\"}"},"index":0}]}}]}',
      '',
      'data: {"id":"x1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })))

    const res = await app.post({
      model: `${PID}/deepseek-v4-flash`,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    })
    const json = await res.json() as { choices: { message: { tool_calls: { function: { arguments: string } }[] } }[] }
    expect(json.choices[0].message.tool_calls).toHaveLength(1)
    expect(json.choices[0].message.tool_calls[0].function.arguments).toBe('{"city":"北京"}')
  })

  it('P1-4（移植 11b75d4 + 6701631）：非 delta message 帧透出正文/推理/工具调用，且重复快照不重复追加', async () => {
    const { env, app } = makeEnv([makeProvider()])
    await seedPool(env, ['u1'])

    const frame = 'data: {"id":"x1","choices":[{"index":0,"message":{"role":"assistant","content":"abc","reasoning_content":"think","tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":\\"北京\\"}"}}]}}]}'
    const body = [
      frame, '',
      frame, '',
      frame, '',
      'data: {"id":"x1","choices":[{"index":0,"message":{},"finish_reason":"tool_calls"}],"usage":{"total_tokens":11}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })))

    const res = await app.post({
      model: `${PID}/deepseek-v4-flash`,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    })
    const json = await res.json() as {
      choices: { message: { role: string; content: string; reasoning_content?: string; tool_calls?: { function: { name: string; arguments: string } }[] } }[]
    }
    const msg = json.choices[0].message
    // 逐帧重复的完整快照只采一次（此前 latch 不生效会得到 abcabcabc）
    expect(msg.content).toBe('abc')
    expect(msg.role).toBe('assistant')
    expect(msg.reasoning_content).toBe('think')
    expect(msg.tool_calls).toHaveLength(1)
    expect(msg.tool_calls![0].function.name).toBe('get_weather')
  })

  it('P1-6（移植 213e362）：非流式 usage 缺 total_tokens 时按 prompt+completion 合成', async () => {
    const { env, app } = makeEnv([makeProvider()])
    await seedPool(env, ['u1'])

    const body = [
      'data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"}}]}',
      '',
      'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })))

    const res = await app.post({
      model: `${PID}/deepseek-v4-flash`,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    })
    const json = await res.json() as { usage: { prompt_tokens: number; completion_tokens: number; total_tokens?: number } }
    expect(json.usage.total_tokens).toBe(15)
  })

  it('P1-6 反例：已有 total_tokens 不覆盖；缺单边不臆造', async () => {
    const { env, app } = makeEnv([makeProvider()])
    await seedPool(env, ['u1'])

    const body = [
      'data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"}}]}',
      '',
      'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":100}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })))

    const res = await app.post({
      model: `${PID}/deepseek-v4-flash`,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    })
    const json = await res.json() as { usage: { total_tokens?: number } }
    expect(json.usage.total_tokens).toBe(100)
  })
})
