import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { handleProxy, testModelConnection } from './proxy'
import { handleTestKeyNew, handleTestModelNew } from './admin'
import {
  applyUpstreamHeaders,
  FORBIDDEN_UPSTREAM_HEADERS,
  normalizeUpstreamHeaders,
} from './upstream-user-agent'
import { clearCache } from './storage'
import { normalizeUpstreamUserAgent, setHeaderCaseInsensitive, UPSTREAM_USER_AGENT_MAX_BYTES } from './upstream-user-agent'
import type { AppEnv, Env, Provider } from './types'

/**
 * 提供商级出站 User-Agent 覆写（`Provider.upstreamUserAgent`）。
 *
 * 存在的理由：部分上游按客户端指纹鉴权——UA 不在白名单时**先于密钥校验**拒绝，
 * 换 key 无效。实测 agentrouter（`https://ps.air-outer.com/v1`）：不带 key 与带正确
 * key 的 401 响应逐字相同（`unauthorized_client_error`），而 `claude-cli/2.0.1
 * (external, cli)` 等 UA 直接 200。客户端侧改不动（DSH 会强制写回自己的 UA），
 * 所以覆写必须发生在网关。
 */

const PID = 'agentrouter'

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: PID,
    name: 'agentrouter',
    baseUrl: 'https://ps.air-outer.com/v1',
    apiType: 'openai',
    apiKeys: [{ key: 'sk-test-key', enabled: true }],
    models: [{ id: 'deepseek-v4-flash', enabled: true }],
    enabled: true,
    createdAt: 'a',
    updatedAt: 'a',
    ...overrides,
  } as Provider
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
  return { KV: kv, GATEWAY_KV: kv, RATE_LIMIT_KV: kv, SESSION_KV: kv } as unknown as Env
}

interface Call { url: string; headers: Record<string, string>; body: string }

function installFetchMock(calls: Call[]) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
    const raw = (init?.headers ?? {}) as Record<string, string>
    const headers: Record<string, string> = {}
    for (const k of Object.keys(raw)) headers[k.toLowerCase()] = String(raw[k])
    calls.push({ url: u, headers, body: typeof init?.body === 'string' ? init.body : '' })
    return new Response(JSON.stringify({
      id: 'c1',
      object: 'chat.completion',
      model: 'deepseek-v4-flash',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
}

async function postChat(env: Env, clientHeaders: Record<string, string> = {}) {
  const app = new Hono<AppEnv>()
  app.post('/v1/chat/completions', (c) => handleProxy(c))
  const req = new Request('https://gw.test/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...clientHeaders },
    body: JSON.stringify({ model: `${PID}/deepseek-v4-flash`, messages: [{ role: 'user', content: 'hi' }] }),
  })
  return app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext)
}

describe('upstream-user-agent：值校验', () => {
  it('常规 UA 原样通过（含空格与括号的注释形式）', () => {
    expect(normalizeUpstreamUserAgent('claude-cli/2.0.1 (external, cli)'))
      .toBe('claude-cli/2.0.1 (external, cli)')
  })

  it('首尾空白被裁掉', () => {
    expect(normalizeUpstreamUserAgent('  opencode/0.5.11  ')).toBe('opencode/0.5.11')
  })

  it('空串/纯空白返回空串（调用方据此清除配置）', () => {
    expect(normalizeUpstreamUserAgent('')).toBe('')
    expect(normalizeUpstreamUserAgent('   ')).toBe('')
  })

  it('含换行或控制字符 → 拒绝（防头注入）', () => {
    expect(normalizeUpstreamUserAgent('a\r\nX-Injected: 1')).toBeNull()
    expect(normalizeUpstreamUserAgent('a\nb')).toBeNull()
    expect(normalizeUpstreamUserAgent('a\u0000b')).toBeNull()
    expect(normalizeUpstreamUserAgent('a\u007fb')).toBeNull()
  })

  it('非 ASCII（中文/全角）→ 拒绝', () => {
    expect(normalizeUpstreamUserAgent('客户端/1.0')).toBeNull()
  })

  it('超过 512 字节 → 拒绝，等于上限 → 通过', () => {
    expect(normalizeUpstreamUserAgent('a'.repeat(UPSTREAM_USER_AGENT_MAX_BYTES))).toBe('a'.repeat(UPSTREAM_USER_AGENT_MAX_BYTES))
    expect(normalizeUpstreamUserAgent('a'.repeat(UPSTREAM_USER_AGENT_MAX_BYTES + 1))).toBeNull()
  })
})

describe('upstream-user-agent：大小写无关替换', () => {
  it('删除小写同名键后写入新值，其他头不动', () => {
    const headers: Record<string, string> = { 'user-agent': 'node', 'x-keep': 'v' }
    setHeaderCaseInsensitive(headers, 'User-Agent', 'claude-cli/2.0.1 (external, cli)')
    expect(headers['user-agent']).toBeUndefined()
    expect(headers['User-Agent']).toBe('claude-cli/2.0.1 (external, cli)')
    expect(headers['x-keep']).toBe('v')
  })

  it('多个大小写变体同时清除，最终只有一个键', () => {
    const headers: Record<string, string> = { 'user-agent': 'a', 'USER-AGENT': 'b' }
    setHeaderCaseInsensitive(headers, 'User-Agent', 'final')
    const uaKeys = Object.keys(headers).filter((k) => k.toLowerCase() === 'user-agent')
    expect(uaKeys).toEqual(['User-Agent'])
    expect(headers['User-Agent']).toBe('final')
  })
})

describe('upstream-user-agent：接入出站请求路径', () => {
  let calls: Call[]

  beforeEach(() => {
    calls = []
    clearCache()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('配置了 upstreamUserAgent → 出站 UA 被覆写，即使客户端透传了自己的 UA', async () => {
    vi.stubGlobal('fetch', installFetchMock(calls))
    const env = makeEnv([makeProvider({ upstreamUserAgent: 'claude-cli/2.0.1 (external, cli)' })])

    const res = await postChat(env, { 'user-agent': 'deepseek-harness/0.2.0-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)' })
    expect(res.status).toBe(200)

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://ps.air-outer.com/v1/chat/completions')
    expect(calls[0].headers['user-agent']).toBe('claude-cli/2.0.1 (external, cli)')
  })

  it('未配置 → 保持既有行为：客户端 user-agent 按白名单前缀透传', async () => {
    vi.stubGlobal('fetch', installFetchMock(calls))
    const env = makeEnv([makeProvider()])

    const res = await postChat(env, { 'user-agent': 'my-client/1.0' })
    expect(res.status).toBe(200)

    expect(calls[0].headers['user-agent']).toBe('my-client/1.0')
  })

  it('覆写只作用于该提供商：另一个 provider 的出站 UA 不受影响', async () => {
    vi.stubGlobal('fetch', installFetchMock(calls))
    const env = makeEnv([
      makeProvider({ upstreamUserAgent: 'claude-cli/2.0.1 (external, cli)' }),
      makeProvider({ id: 'plain', name: 'plain', baseUrl: 'https://plain.example/v1' }),
    ])

    const app = new Hono<AppEnv>()
    app.post('/v1/chat/completions', (c) => handleProxy(c))
    const req = new Request('https://gw.test/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'user-agent': 'my-client/1.0' },
      body: JSON.stringify({ model: 'plain/deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] }),
    })
    await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext)

    expect(calls[0].url).toBe('https://plain.example/v1/chat/completions')
    expect(calls[0].headers['user-agent']).toBe('my-client/1.0')
  })
})

describe('upstream-user-agent：后台「测试模型」与真实转发同口径', () => {
  let calls: Call[]

  beforeEach(() => {
    calls = []
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('传入 upstreamUserAgent → 测试请求带该 UA（否则后台会误报 401）', async () => {
    vi.stubGlobal('fetch', installFetchMock(calls))
    const result = await testModelConnection(
      'https://ps.air-outer.com/v1',
      'sk-test-key',
      'deepseek-v4-flash',
      'openai',
      'claude-cli/2.0.1 (external, cli)',
    )
    expect(result.success).toBe(true)
    expect(calls[0].headers['user-agent']).toBe('claude-cli/2.0.1 (external, cli)')
  })

  it('未传 → 不带自定义 UA（保持既有行为）', async () => {
    vi.stubGlobal('fetch', installFetchMock(calls))
    await testModelConnection('https://plain.example/v1', 'sk-test-key', 'deepseek-v4-flash', 'openai')
    expect(calls[0].headers['user-agent']).toBeUndefined()
  })
})

/**
 * 管理面探测（「获取模型」/「测试 Key」/「测试模型」）与转发是两套代码。
 * 漏掉这里的话，按 UA 鉴权的上游在后台永远显示 401，而实际转发却是通的——
 * 实测就是这么被发现的：provider 已配好 UA，`/v1/chat/completions` 正常，
 * 但后台「获取模型」与 Key 旁的「测试」双双 401 `unauthorized_client_error`。
 */
describe('upstream-user-agent：后台「获取模型 / 测试 Key」也走同一 UA', () => {
  let calls: Call[]

  function installProbeFetchMock() {
    return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
      const raw = (init?.headers ?? {}) as Record<string, string>
      const headers: Record<string, string> = {}
      for (const k of Object.keys(raw)) headers[k.toLowerCase()] = String(raw[k])
      calls.push({ url: u, headers, body: typeof init?.body === 'string' ? init.body : '' })
      if (u.endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-flash' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({
        id: 'c1',
        object: 'chat.completion',
        model: 'deepseek-v4-flash',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
  }

  function makeAdminApp() {
    const app = new Hono<AppEnv>()
    app.post('/admin/api/test-key', (c) => handleTestKeyNew(c))
    app.post('/admin/api/test-model', (c) => handleTestModelNew(c))
    return app
  }

  async function postAdmin(path: string, body: unknown, env: Env) {
    const req = new Request(`https://gw.test${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return makeAdminApp().fetch(req, env, {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext)
  }

  beforeEach(() => {
    calls = []
    clearCache()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('「获取模型」：用落库的 upstreamUserAgent 覆写 GET /models 的 UA', async () => {
    vi.stubGlobal('fetch', installProbeFetchMock())
    const env = makeEnv([makeProvider({ upstreamUserAgent: 'claude-cli/2.0.1 (external, cli)' })])

    const res = await postAdmin('/admin/api/test-key', {
      url: 'https://ps.air-outer.com/v1',
      apiKey: 'sk-test-key',
      apiType: 'openai',
      providerId: PID,
      intent: 'fetchModels',
    }, env)
    expect(res.status).toBe(200)
    const json = await res.json() as any
    expect(json.data.success).toBe(true)

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://ps.air-outer.com/v1/models')
    expect(calls[0].headers['user-agent']).toBe('claude-cli/2.0.1 (external, cli)')
  })

  it('「测试 Key」：同一 UA 也作用于单 key 探测（intent=diagnose 走同一端点）', async () => {
    vi.stubGlobal('fetch', installProbeFetchMock())
    const env = makeEnv([makeProvider({ upstreamUserAgent: 'claude-cli/2.0.1 (external, cli)' })])

    await postAdmin('/admin/api/test-key', {
      url: 'https://ps.air-outer.com/v1',
      apiKey: 'sk-test-key',
      apiType: 'openai',
      providerId: PID,
      intent: 'diagnose',
    }, env)

    expect(calls[0].headers['user-agent']).toBe('claude-cli/2.0.1 (external, cli)')
  })

  it('新建表单尚未保存：请求体里的 upstreamUserAgent 生效（无需先落库）', async () => {
    vi.stubGlobal('fetch', installProbeFetchMock())
    const env = makeEnv([])

    const res = await postAdmin('/admin/api/test-key', {
      url: 'https://ps.air-outer.com/v1',
      apiKey: 'sk-test-key',
      apiType: 'openai',
      upstreamUserAgent: 'claude-cli/2.0.1 (external, cli)',
    }, env)
    expect(res.status).toBe(200)
    expect(calls[0].headers['user-agent']).toBe('claude-cli/2.0.1 (external, cli)')
  })

  it('请求体的值优先于落库值（编辑未保存时以输入框为准）', async () => {
    vi.stubGlobal('fetch', installProbeFetchMock())
    const env = makeEnv([makeProvider({ upstreamUserAgent: 'stale/1.0' })])

    await postAdmin('/admin/api/test-key', {
      url: 'https://ps.air-outer.com/v1',
      apiKey: 'sk-test-key',
      apiType: 'openai',
      providerId: PID,
      upstreamUserAgent: 'claude-cli/2.0.1 (external, cli)',
    }, env)

    expect(calls[0].headers['user-agent']).toBe('claude-cli/2.0.1 (external, cli)')
  })

  it('非法 UA（含换行）→ 400，且不发出任何上游请求', async () => {
    vi.stubGlobal('fetch', installProbeFetchMock())
    const env = makeEnv([makeProvider()])

    const res = await postAdmin('/admin/api/test-key', {
      url: 'https://ps.air-outer.com/v1',
      apiKey: 'sk-test-key',
      apiType: 'openai',
      providerId: PID,
      upstreamUserAgent: 'a\r\nX-Injected: 1',
    }, env)
    expect(res.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('未配置 UA → 不带自定义 UA（保持既有行为，不回归普通上游）', async () => {
    vi.stubGlobal('fetch', installProbeFetchMock())
    const env = makeEnv([makeProvider()])

    await postAdmin('/admin/api/test-key', {
      url: 'https://ps.air-outer.com/v1',
      apiKey: 'sk-test-key',
      apiType: 'openai',
      providerId: PID,
    }, env)

    expect(calls[0].headers['user-agent']).toBeUndefined()
  })

  it('「测试模型」：POST chat/completions 同样带该 UA', async () => {
    vi.stubGlobal('fetch', installProbeFetchMock())
    const env = makeEnv([makeProvider({ upstreamUserAgent: 'claude-cli/2.0.1 (external, cli)' })])

    const res = await postAdmin('/admin/api/test-model', {
      url: 'https://ps.air-outer.com/v1',
      apiKey: 'sk-test-key',
      apiType: 'openai',
      model: 'deepseek-v4-flash',
      providerId: PID,
    }, env)
    expect(res.status).toBe(200)

    expect(calls[0].url).toBe('https://ps.air-outer.com/v1/chat/completions')
    expect(calls[0].headers['user-agent']).toBe('claude-cli/2.0.1 (external, cli)')
  })
})

describe('upstream-headers：请求头表校验', () => {
  it('常规表原样通过，保留书写大小写', () => {
    const r = normalizeUpstreamHeaders({ 'x-app': 'cli', 'X-Stainless-Lang': 'js' })
    expect(r).toEqual({ ok: true, value: { 'x-app': 'cli', 'X-Stainless-Lang': 'js' } })
  })

  it('undefined/null → 空表（= 不覆写）', () => {
    expect(normalizeUpstreamHeaders(undefined)).toEqual({ ok: true, value: {} })
    expect(normalizeUpstreamHeaders(null)).toEqual({ ok: true, value: {} })
  })

  it('空值跳过（界面上留空即「不覆写这个头」）', () => {
    const r = normalizeUpstreamHeaders({ 'x-app': '', 'x-keep': 'v' })
    expect(r.ok && r.value).toEqual({ 'x-keep': 'v' })
  })

  it('同名（大小写不同）只留最后一个，避免出站重复头', () => {
    const r = normalizeUpstreamHeaders({ 'x-app': 'a', 'X-App': 'b' })
    expect(r.ok && r.value).toEqual({ 'X-App': 'b' })
  })

  it('非对象 → 拒绝', () => {
    expect(normalizeUpstreamHeaders('x-app: cli').ok).toBe(false)
    expect(normalizeUpstreamHeaders(['x-app']).ok).toBe(false)
  })

  it('非法头名 → 拒绝（含空格、冒号、中文、空名）', () => {
    for (const name of ['x app', 'x:app', '客户端', '']) {
      expect(normalizeUpstreamHeaders({ [name]: 'v' }).ok).toBe(false)
    }
  })

  it('由运行时/凭据池管理的头 → 拒绝覆写', () => {
    for (const name of ['host', 'content-length', 'authorization', 'x-api-key', 'cookie', 'accept-encoding', 'connection']) {
      expect(normalizeUpstreamHeaders({ [name]: 'v' }).ok).toBe(false)
    }
    // accept-encoding 必须留在禁止表里：显式设置会关闭 Workers 的自动解压
    expect(FORBIDDEN_UPSTREAM_HEADERS.has('accept-encoding')).toBe(true)
  })

  it('值含换行 / 非 ASCII / 超长 → 拒绝', () => {
    expect(normalizeUpstreamHeaders({ 'x-a': 'a\r\nX-Injected: 1' }).ok).toBe(false)
    expect(normalizeUpstreamHeaders({ 'x-a': '客户端' }).ok).toBe(false)
    expect(normalizeUpstreamHeaders({ 'x-a': 'a'.repeat(UPSTREAM_USER_AGENT_MAX_BYTES + 1) }).ok).toBe(false)
  })
})

describe('upstream-headers：应用顺序', () => {
  it('先 UA 后表：表里也写了 user-agent 时以表为准', () => {
    const headers: Record<string, string> = {}
    applyUpstreamHeaders(headers, {
      upstreamUserAgent: 'claude-cli/2.0.1 (external, cli)',
      upstreamHeaders: { 'user-agent': 'from-table/1.0' },
    })
    const uaKeys = Object.keys(headers).filter((k) => k.toLowerCase() === 'user-agent')
    expect(uaKeys).toEqual(['user-agent'])
    expect(headers['user-agent']).toBe('from-table/1.0')
  })

  it('大小写无关替换掉透传来的同名头，其他头不动', () => {
    const headers: Record<string, string> = { 'x-app': 'old', 'x-keep': 'v' }
    applyUpstreamHeaders(headers, { upstreamHeaders: { 'X-App': 'cli' } })
    expect(headers['x-app']).toBeUndefined()
    expect(headers['X-App']).toBe('cli')
    expect(headers['x-keep']).toBe('v')
  })
})

describe('upstream-headers：转发与后台探测同口径', () => {
  let calls: Call[]

  const HEADERS = { 'x-app': 'cli', 'x-stainless-lang': 'js' }

  beforeEach(() => {
    calls = []
    clearCache()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('真实转发带上 provider.upstreamHeaders', async () => {
    vi.stubGlobal('fetch', installFetchMock(calls))
    const env = makeEnv([makeProvider({ upstreamHeaders: HEADERS })])

    const res = await postChat(env, { 'x-app': 'client-value' })
    expect(res.status).toBe(200)
    expect(calls[0].headers['x-app']).toBe('cli')
    expect(calls[0].headers['x-stainless-lang']).toBe('js')
  })

  it('「获取模型」探测带上落库的 upstreamHeaders', async () => {
    vi.stubGlobal('fetch', installFetchMock(calls))
    const env = makeEnv([makeProvider({ upstreamHeaders: HEADERS })])

    const app = new Hono<AppEnv>()
    app.post('/admin/api/test-key', (c) => handleTestKeyNew(c))
    const req = new Request('https://gw.test/admin/api/test-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://ps.air-outer.com/v1',
        apiKey: 'sk-test-key',
        apiType: 'openai',
        providerId: PID,
        intent: 'fetchModels',
      }),
    })
    await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext)

    expect(calls[0].url).toBe('https://ps.air-outer.com/v1/models')
    expect(calls[0].headers['x-app']).toBe('cli')
    expect(calls[0].headers['x-stainless-lang']).toBe('js')
  })

  it('新建表单未保存：请求体里的 upstreamHeaders 生效', async () => {
    vi.stubGlobal('fetch', installFetchMock(calls))
    const env = makeEnv([])

    const app = new Hono<AppEnv>()
    app.post('/admin/api/test-key', (c) => handleTestKeyNew(c))
    const req = new Request('https://gw.test/admin/api/test-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://ps.air-outer.com/v1',
        apiKey: 'sk-test-key',
        apiType: 'openai',
        upstreamHeaders: HEADERS,
      }),
    })
    await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext)

    expect(calls[0].headers['x-app']).toBe('cli')
  })

  it('非法头（host）→ 400 且不发出任何上游请求', async () => {
    vi.stubGlobal('fetch', installFetchMock(calls))
    const env = makeEnv([makeProvider()])

    const app = new Hono<AppEnv>()
    app.post('/admin/api/test-key', (c) => handleTestKeyNew(c))
    const req = new Request('https://gw.test/admin/api/test-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://ps.air-outer.com/v1',
        apiKey: 'sk-test-key',
        apiType: 'openai',
        providerId: PID,
        upstreamHeaders: { host: 'evil.example' },
      }),
    })
    const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext)

    expect(res.status).toBe(400)
    expect(calls).toHaveLength(0)
  })
})
