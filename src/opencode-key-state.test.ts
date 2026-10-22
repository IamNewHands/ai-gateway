import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv, Env, Provider } from './types'
import {
  handleOpenCodeKeyCheck,
  handleOpenCodeKeyLabel,
  handleOpenCodeKeyStates,
} from './admin'
import {
  describeOpenCodeKeyState,
  maskOpenCodeKey,
  readOpenCodeKeyStates,
  recordOpenCodeKeyState,
} from './opencode-key-state'
import { getProvider, setProviders } from './storage'
import { renderAdminPage } from './pages'

/** 内存 KV */
function makeEnv() {
  const map = new Map<string, string>()
  const kv = {
    get: async (k: string) => map.get(k) ?? null,
    put: async (k: string, v: string) => { map.set(k, v) },
    delete: async (k: string) => { map.delete(k) },
    list: async () => ({ keys: [] }),
  }
  return { KV: kv } as unknown as Env & AppEnv
}

function openCodeProvider(apiKeys: Provider['apiKeys']): Provider {
  return {
    id: 'opencode',
    name: 'OpenCode',
    baseUrl: 'https://opencode.ai/zen/v1',
    apiType: 'openai',
    apiKeys,
    models: [],
    enabled: true,
    createdAt: 'a',
    updatedAt: 'a',
  }
}

const KEY_A = 'sk-opencode-aaaaaaaaaaaa'
const KEY_B = 'sk-opencode-bbbbbbbbbbbb'
const KEY_C = 'sk-opencode-cccccccccccc'

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const MODEL_LIST = { object: 'list', data: [{ id: 'big-pickle', object: 'model' }, { id: 'deepseek-v4.1-flash-free', object: 'model' }] }

/**
 * 模拟上游两条请求：GET /models（判 key 是否被拒）与 POST /chat/completions（判能否真转发）。
 * usableKeys 里的 key 两条都通，其余 GET 回 401。
 */
function mockUpstream(usableKeys: string[], onCall?: (method: string, key: string) => void) {
  return (async (url: string, init: any) => {
    const method = String(init?.method || 'GET')
    // createRequestHeaders 传的是 Headers 实例，必须用 Headers 读，直接取属性读到的是 undefined
    const auth = new Headers(init?.headers || {}).get('authorization') || ''
    const key = auth.replace(/^Bearer\s+/i, '')
    onCall?.(method, key)
    if (method === 'GET' && String(url).endsWith('/models')) {
      return usableKeys.includes(key) ? jsonResp(MODEL_LIST) : new Response('{"error":"invalid api key"}', { status: 401 })
    }
    if (!usableKeys.includes(key)) return new Response('{"error":"invalid api key"}', { status: 401 })
    return new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }) as unknown as typeof fetch
}

function mount(env: AppEnv) {
  void env
  const app = new Hono<AppEnv>()
  app.get('/admin/api/providers/:id/opencode-key-states', handleOpenCodeKeyStates)
  app.post('/admin/api/providers/:id/opencode-keys/check', handleOpenCodeKeyCheck)
  app.post('/admin/api/providers/:id/opencode-keys/label', handleOpenCodeKeyLabel)
  return app
}

let realFetch: typeof globalThis.fetch
beforeEach(() => { realFetch = globalThis.fetch })
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks() })

describe('maskOpenCodeKey / describeOpenCodeKeyState', () => {
  it('只露末 4 位，短 key 一律 ****', () => {
    expect(maskOpenCodeKey('sk-opencode-aaaaaaaaaaaa')).toBe('****aaaa')
    expect(maskOpenCodeKey('abc')).toBe('****')
    expect(maskOpenCodeKey('')).toBe('****')
  })

  it('可用：文案带耗时，tone=on，detail 含模型与 HTTP 码', () => {
    const view = describeOpenCodeKeyState({
      index: 0, masked: '****aaaa', status: 'usable', message: '连接成功',
      httpStatus: 200, latencyMs: 312, model: 'big-pickle', at: 1_000,
    }, 61_000)
    expect(view.label).toBe('可用 · 312ms')
    expect(view.tone).toBe('on')
    expect(view.detail).toContain('big-pickle')
    expect(view.detail).toContain('HTTP 200')
    expect(view.ageMs).toBe(60_000)
  })

  it('被拒 / 限流 / 网络错误各有独立文案与色调', () => {
    const base = { index: 0, masked: '****aaaa', message: 'x', httpStatus: 0, latencyMs: 0, model: null, at: 0 }
    expect(describeOpenCodeKeyState({ ...base, status: 'rejected', httpStatus: 401 }, 0).tone).toBe('danger')
    expect(describeOpenCodeKeyState({ ...base, status: 'rate_limited', httpStatus: 429 }, 0).label).toBe('限流')
    expect(describeOpenCodeKeyState({ ...base, status: 'transport_error' }, 0).label).toBe('网络错误')
    // 无效状态不会假装正常
    const bogus = describeOpenCodeKeyState({ ...base, status: 'whatever' as never }, 0)
    expect(bogus.tone).toBe('off')
  })
})

describe('KV 留档：读 / 写 / 脏值丢弃', () => {
  it('写入后能读回，按 index 覆盖而不是追加', async () => {
    const env = makeEnv()
    await recordOpenCodeKeyState(env, 'opencode', {
      index: 0, masked: '****aaaa', status: 'usable', message: 'ok', httpStatus: 200, latencyMs: 10, model: 'big-pickle', at: 1,
    })
    await recordOpenCodeKeyState(env, 'opencode', {
      index: 0, masked: '****aaaa', status: 'rejected', message: 'now rejected', httpStatus: 401, latencyMs: 20, model: null, at: 2,
    })
    const states = await readOpenCodeKeyStates(env, 'opencode')
    expect(states).toHaveLength(1)
    expect(states[0].status).toBe('rejected')
    expect(states[0].at).toBe(2)
  })

  it('脏值（未知状态 / 非数字时间）整条丢弃，不猜', async () => {
    const env = makeEnv()
    await env.KV!.put('opencode:keystate:opencode', JSON.stringify({
      states: [
        { index: 0, masked: '****aaaa', status: 'bogus', at: 1 },
        { index: 1, masked: '****bbbb', status: 'usable', at: 'yesterday' },
        { index: 2, masked: '****cccc', status: 'usable', at: 5 },
      ],
    }))
    const states = await readOpenCodeKeyStates(env, 'opencode')
    expect(states).toHaveLength(1)
    expect(states[0].index).toBe(2)
  })
})

describe('GET /opencode-key-states（只读，不打上游）', () => {
  it('无留档时每行都是「未检测」，且全程不发起任何上游请求', async () => {
    const env = makeEnv()
    await setProviders(env as never, [openCodeProvider([{ key: KEY_A, enabled: true, label: '主号' }])])
    const spy = vi.fn()
    globalThis.fetch = spy as unknown as typeof fetch

    const res = await mount(env).request('/admin/api/providers/opencode/opencode-key-states', {}, env as never)
    const j = await res.json() as any
    expect(j.success).toBe(true)
    expect(j.data.keys[0]).toMatchObject({
      index: 0, status: 'unchecked', tone: 'off', statusLabel: '', label: '主号', labelSource: 'manual', checkedAt: 0,
    })
    expect(spy).not.toHaveBeenCalled()
    // 绝不回传完整 Key
    expect(JSON.stringify(j)).not.toContain(KEY_A)
  })

  it('掩码不符（该行换过 Key）→ 旧结论作废，显示未检测', async () => {
    const env = makeEnv()
    await setProviders(env as never, [openCodeProvider([{ key: KEY_A, enabled: true }])])
    await recordOpenCodeKeyState(env, 'opencode', {
      index: 0, masked: '****zzzz', status: 'usable', message: 'ok', httpStatus: 200, latencyMs: 5, model: 'big-pickle', at: 1,
    })
    const j = await (await mount(env).request('/admin/api/providers/opencode/opencode-key-states', {}, env as never)).json() as any
    expect(j.data.keys[0].status).toBe('unchecked')
    expect(j.data.keys[0].checkedAt).toBe(0)
  })

  it('非 OpenCode 提供商：拒绝', async () => {
    const env = makeEnv()
    await setProviders(env as never, [{
      id: 'deepseek', name: 'ds', baseUrl: 'https://api.deepseek.com', apiType: 'openai',
      apiKeys: [{ key: 'sk-x', enabled: true }], models: [], enabled: true, createdAt: 'a', updatedAt: 'a',
    } as Provider])
    const j = await (await mount(env).request('/admin/api/providers/deepseek/opencode-key-states', {}, env as never)).json() as any
    expect(j.success).toBe(false)
  })
})

describe('POST /opencode-keys/check（逐个 Key 真实诊断 + 落档）', () => {
  it('可用与失效分别判定，结论落 KV，禁用行不烧请求', async () => {
    const env = makeEnv()
    await setProviders(env as never, [openCodeProvider([
      { key: KEY_A, enabled: true },
      { key: KEY_B, enabled: true },
      { key: KEY_C, enabled: false },
    ])])
    const calls: Array<{ method: string; key: string }> = []
    // KEY_A 可用，KEY_B 被 401 拒
    globalThis.fetch = mockUpstream([KEY_A], (method, key) => calls.push({ method, key }))

    const j = await (await mount(env).request('/admin/api/providers/opencode/opencode-keys/check', { method: 'POST' }, env as never)).json() as any
    expect(j.success).toBe(true)
    const rows = j.data.keys
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ index: 0, status: 'usable', tone: 'on' })
    expect(rows[0].model).toBe('big-pickle')
    expect(rows[1]).toMatchObject({ index: 1, status: 'rejected', tone: 'danger', httpStatus: 401 })
    // 禁用的 Key 不参与检测，也不该留下「可用」的假结论
    expect(rows[2]).toMatchObject({ index: 2, status: 'unchecked', enabled: false })
    expect(calls.every((c) => c.key !== KEY_C)).toBe(true)
    expect(j.data.summary).toContain('可用 1 / 共 3')
    expect(j.data.summary).toContain('被拒 1')
    expect(j.data.summary).toContain('已禁用 1')
    // 绝不回传完整 Key
    expect(JSON.stringify(j)).not.toContain(KEY_A)

    const states = await readOpenCodeKeyStates(env, 'opencode')
    expect(states.map((s) => [s.index, s.status])).toEqual([[0, 'usable'], [1, 'rejected']])
    expect(states[0].masked).toBe('****aaaa')
  })

  it('检查后再读只读端点：能读回同一份结论（跨 isolate 的一致性）', async () => {
    const env = makeEnv()
    await setProviders(env as never, [openCodeProvider([{ key: KEY_A, enabled: true }])])
    globalThis.fetch = mockUpstream([KEY_A])

    await mount(env).request('/admin/api/providers/opencode/opencode-keys/check', { method: 'POST' }, env as never)
    const j = await (await mount(env).request('/admin/api/providers/opencode/opencode-key-states', {}, env as never)).json() as any
    expect(j.data.keys[0].status).toBe('usable')
    expect(j.data.keys[0].statusLabel).toBe('可用' + (j.data.keys[0].latencyMs > 0 ? ' · ' + j.data.keys[0].latencyMs + 'ms' : ''))
    expect(j.data.keys[0].checkedAt).toBeGreaterThan(0)
  })

  it('全部 Key 都被禁用：直接拒绝，不发任何上游请求', async () => {
    const env = makeEnv()
    await setProviders(env as never, [openCodeProvider([{ key: KEY_A, enabled: false }])])
    const spy = vi.fn()
    globalThis.fetch = spy as unknown as typeof fetch
    const j = await (await mount(env).request('/admin/api/providers/opencode/opencode-keys/check', { method: 'POST' }, env as never)).json() as any
    expect(j.success).toBe(false)
    expect(j.message).toContain('没有启用的 Key')
    expect(spy).not.toHaveBeenCalled()
  })

  it('网络层失败：不许判成「可用」，也不许判成「Key 被拒」（不诱导用户换号）', async () => {
    const env = makeEnv()
    await setProviders(env as never, [openCodeProvider([{ key: KEY_A, enabled: true }])])
    globalThis.fetch = (async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch
    const j = await (await mount(env).request('/admin/api/providers/opencode/opencode-keys/check', { method: 'POST' }, env as never)).json() as any
    // 无镜像可切时，opencode 代理会把网络异常收敛成一条可诊断的 5xx 报文（既有行为），
    // 因此这里可能是 upstream_error；两种结论都不可能是 usable / rejected。
    expect(['upstream_error', 'transport_error']).toContain(j.data.keys[0].status)
    expect(['warn', 'danger']).toContain(j.data.keys[0].tone)
    expect(j.data.keys[0].status).not.toBe('usable')
    expect(j.data.keys[0].status).not.toBe('rejected')
  })
})

describe('POST /opencode-keys/label（账号名手工维护）', () => {
  it('写入 / 清空 / 越界 / 非 OpenCode 提供商', async () => {
    const env = makeEnv()
    await setProviders(env as never, [openCodeProvider([{ key: KEY_A, enabled: true }])])
    const app = mount(env)

    let res = await app.request('/admin/api/providers/opencode/opencode-keys/label', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index: 0, label: '  主号 A  ' }),
    }, env as never)
    expect((await res.json() as any).data.label).toBe('主号 A')
    expect((await getProvider(env as never, 'opencode'))!.apiKeys[0].label).toBe('主号 A')

    res = await app.request('/admin/api/providers/opencode/opencode-keys/label', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index: 0, label: '' }),
    }, env as never)
    expect((await res.json() as any).data.label).toBe('')
    expect((await getProvider(env as never, 'opencode'))!.apiKeys[0].label).toBeUndefined()

    res = await app.request('/admin/api/providers/opencode/opencode-keys/label', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index: 9, label: 'x' }),
    }, env as never)
    expect(res.status).toBe(400)

    await setProviders(env as never, [{
      id: 'deepseek', name: 'ds', baseUrl: 'https://api.deepseek.com', apiType: 'openai',
      apiKeys: [{ key: 'sk-x', enabled: true }], models: [], enabled: true, createdAt: 'a', updatedAt: 'a',
    } as Provider])
    res = await app.request('/admin/api/providers/deepseek/opencode-keys/label', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index: 0, label: 'x' }),
    }, env as never)
    expect(res.status).toBe(400)
  })
})

describe('面板渲染：OpenCode 每行有徽章 + 账号框，顶部有「检测全部 Key」', () => {
  async function renderHtml(env: AppEnv) {
    const app = new Hono<AppEnv>()
    app.get('/admin', (c) => renderAdminPage(c))
    return await (await app.request('/admin', {}, env as never)).text()
  }

  it('渲染出 okst- / oklbl- / okchk- 与按钮文案，且带客户端版本戳', async () => {
    const env = makeEnv()
    await setProviders(env as never, [openCodeProvider([
      { key: KEY_A, enabled: true, label: '主号' },
      { key: KEY_C, enabled: false },
    ])])
    const html = await renderHtml(env)
    const start = html.indexOf('id="dt-opencode"')
    expect(start).toBeGreaterThan(-1)
    const panel = html.slice(start, html.indexOf('</article>', start))
    expect(panel).toContain('id="okst-opencode-0"')
    expect(panel).toContain('id="oklbl-opencode-0"')
    expect(panel).toContain('value="主号"')
    expect(panel).toContain('id="okst-opencode-1"')
    // 禁用的行直接显示「已禁用」，不必等检测
    expect(panel).toContain('已禁用')
    expect(panel).toContain('检测全部 Key')
    expect(panel).toContain('id="okchk-opencode"')
    expect(panel).toContain('data-ok-ui=')
    // 每行独立的测试结果区，避免多行并发测试互相覆盖
    expect(panel).toContain('id="ktr-opencode-0"')
  })
})
