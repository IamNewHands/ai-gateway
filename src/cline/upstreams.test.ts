import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import type { Env, Provider } from '../types'
import {
  parseClineUpstreamList,
  classifyClineUpstreamError,
  probeClineProviderUpstream,
  validateClineProviderUpstream,
  readClineUpstreamCache,
  CLINE_PROBE_UPSTREAM,
  MIN_GAP_MS,
} from './proxy'
import { handleClineUpstreams, handleClineUpstreamProbe, handleClineUpstreamValidate, normalizeClinePinByModel } from '../admin'
import { setProviders } from '../storage'

/** 内存 KV（暴露 map 以便断言留档写入）。 */
function makeEnv() {
  const map = new Map<string, string>()
  const kv = {
    get: async (k: string) => map.get(k) ?? null,
    put: async (k: string, v: string) => { map.set(k, v) },
    delete: async (k: string) => { map.delete(k) },
    list: async () => ({ keys: [] }),
  }
  return { env: { KV: kv } as unknown as Env, map }
}

function clineProvider(over?: Partial<Provider>): Provider {
  return {
    id: 'cline',
    name: 'Cline',
    baseUrl: 'https://api.cline.bot/api/v1',
    apiType: 'openai',
    apiKeys: [{ key: RT_A, enabled: true }],
    models: [{ id: 'cline-free/deepseek-v4.1-flash', enabled: true }],
    enabled: true,
    createdAt: 'a',
    updatedAt: 'a',
    ...over,
  }
}

const RT_A = 'rt-aaaaaaaaaaaaaaaaaaaa'

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function sseResp(body: string): Response {
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

/** 规划器管道（Vercel AI Gateway）在假渠道下的真实报错形态（2026-10-02 实测）。 */
const VERCEL_PROBE_ERR =
  'data: {"code":"stream_initialization_failed","message":"Failed to create stream: inference request failed: ' +
  'failed to generate stream from Vercel: request failed with status 400: {\\"error\\":{\\"message\\":\\"No available ' +
  'providers match the \'only\' filter: ' + CLINE_PROBE_UPSTREAM + '. Available providers are: alibaba, baseten, ' +
  'boundless, novita.\\"}}"}'

let realFetch: typeof globalThis.fetch
beforeEach(() => { realFetch = globalThis.fetch })
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks() })

/** 装一个假 fetch：/auth/refresh 正常，chat 走 handler。 */
function installFetch(chat: (body: Record<string, unknown>, url: string) => Response | Promise<Response>) {
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url)
    if (u.includes('/auth/refresh')) {
      return jsonResp({ data: { accessToken: 'at-1', refreshToken: RT_A, expiresAt: Date.now() + 3600_000 } })
    }
    let body: Record<string, unknown> = {}
    try { body = JSON.parse(String(init?.body || '{}')) } catch { /* 保持空 */ }
    return chat(body, u)
  }) as unknown as typeof fetch
}

describe('parseClineUpstreamList：两条管道的清单抽取', () => {
  it('规划器管道：Available providers are: 文本形式', () => {
    expect(parseClineUpstreamList('... Available providers are: alibaba, baseten, boundless, novita.')).toEqual([
      'alibaba', 'baseten', 'boundless', 'novita',
    ])
  })

  it('直连管道：available_providers JSON 形式，并归一大小写、去重', () => {
    const t = '{"error":{"message":"x","metadata":{"available_providers":["GMICloud","Novita","gmicloud"]}}}'
    expect(parseClineUpstreamList(t)).toEqual(['gmicloud', 'novita'])
  })

  it('噪声 token 被 slug 规则剔除（假渠道名、JSON 片段都不该进清单）', () => {
    const t = 'Available providers are: alibaba, ' + CLINE_PROBE_UPSTREAM + ', {"type":"invalid_request_error"}'
    expect(parseClineUpstreamList(t)).toEqual(['alibaba'])
  })

  it('没有清单时返回空数组（不编造）', () => {
    expect(parseClineUpstreamList('')).toEqual([])
    expect(parseClineUpstreamList('{"error":"boom"}')).toEqual([])
  })
})

describe('classifyClineUpstreamError：渠道状态分类', () => {
  it('推理耗尽导致空正文 = 渠道本身可用（对齐源项目口径）', () => {
    expect(classifyClineUpstreamError('upstream 500 empty response content')).toBe('ok')
  })

  it('限流算可用但暂忙，不算不可钉', () => {
    expect(classifyClineUpstreamError('HTTP 429 Too Many Requests')).toBe('limited')
    expect(classifyClineUpstreamError('temporarily rate-limited')).toBe('limited')
  })

  it('参数/路由类失败 = 不可钉', () => {
    expect(classifyClineUpstreamError('invalid_request_error')).toBe('bad')
    expect(classifyClineUpstreamError('No available providers match the only filter')).toBe('bad')
    expect(classifyClineUpstreamError('model not found')).toBe('bad')
  })

  it('认证问题与渠道无关，单独归类（面板提示换号而不是换渠道）', () => {
    expect(classifyClineUpstreamError('401 Unauthorized')).toBe('auth')
    expect(classifyClineUpstreamError('please re-authenticate')).toBe('auth')
  })

  it('认不出的错误不猜', () => {
    expect(classifyClineUpstreamError('something odd happened')).toBe('unknown')
  })
})

describe('probeClineProviderUpstream：假渠道枚举 + 留档', () => {
  it('规划器管道：拿到渠道清单、判出管道、并写入 KV 留档', async () => {
    const { env, map } = makeEnv()
    installFetch(() => sseResp(VERCEL_PROBE_ERR))

    const r = await probeClineProviderUpstream(env, clineProvider(), 'cline-free/deepseek-v4.1-flash')
    expect(r.ok).toBe(true)
    expect(r.pipeline).toBe('planner')
    expect(r.upstreams).toEqual(['alibaba', 'baseten', 'boundless', 'novita'])

    const cached = await readClineUpstreamCache(env, 'cline')
    expect(cached.probes['cline-free/deepseek-v4.1-flash'].upstreams).toHaveLength(4)
    expect(map.has('cline:upstreams:cline')).toBe(true)
  })

  it('直连管道：404 + available_providers 同样能枚举', async () => {
    const { env } = makeEnv()
    installFetch(() => jsonResp({
      error: { message: 'provider does not exist', metadata: { available_providers: ['GMICloud', 'novita'] } },
    }, 404))

    const r = await probeClineProviderUpstream(env, clineProvider(), 'cline-free/direct-ish')
    expect(r.pipeline).toBe('direct')
    expect(r.upstreams).toEqual(['gmicloud', 'novita'])
    expect(r.status).toBe(404)
  })

  it('假渠道被管道静默丢弃（照常出流）→ 如实报 ok:false，不编造清单', async () => {
    const { env } = makeEnv()
    installFetch(() => sseResp('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n'))

    const r = await probeClineProviderUpstream(env, clineProvider(), 'cline-free/deepseek-v4.1-flash')
    expect(r.ok).toBe(false)
    expect(r.upstreams).toEqual([])
    expect(r.pipeline).toBe('unknown')
  })

  it('上游连接失败 → ok:false 且 note 说明原因（面板能直接显示）', async () => {
    const { env } = makeEnv()
    installFetch(() => { throw new Error('ECONNRESET') })

    const r = await probeClineProviderUpstream(env, clineProvider(), 'cline-free/deepseek-v4.1-flash')
    expect(r.ok).toBe(false)
    expect(r.note).toContain('ECONNRESET')
  })
})

describe('validateClineProviderUpstream：逐渠道实测', () => {
  it('按渠道分类状态，且**串行**（免费通道并发 >1 会返回空响应）', async () => {
    const { env } = makeEnv()
    // 先探测出渠道清单
    installFetch(() => sseResp(VERCEL_PROBE_ERR))
    await probeClineProviderUpstream(env, clineProvider(), 'M')

    let inFlight = 0
    let maxInFlight = 0
    installFetch(async (body) => {
      const only = (body.providerOptions as { gateway?: { only?: string[] } })?.gateway?.only?.[0] || ''
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      if (only === 'alibaba') return sseResp('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')
      if (only === 'baseten') return jsonResp({ error: { message: 'HTTP 429 rate limited' } }, 429)
      return jsonResp({ error: { message: 'invalid_request_error: not allowed' } }, 400)
    })

    const t0 = Date.now()
    const { checks, total } = await validateClineProviderUpstream(env, clineProvider(), 'M')
    const elapsed = Date.now() - t0
    expect(total).toBe(4)
    const by = Object.fromEntries(checks.map((c) => [c.upstream, c.status]))
    expect(by['alibaba']).toBe('ok')
    expect(by['baseten']).toBe('limited')
    expect(by['boundless']).toBe('bad')
    // 不并行：顺序 for + await 天然如此，这条防的是以后有人「顺手」改成 Promise.all
    // ——免费通道并发 >1 会返回空响应，状态就全成噪声了。
    expect(maxInFlight).toBe(1)
    // 但只断言 maxInFlight 抓不到「没走共享队列」：没有 enqueue 时它照样是 1。
    // 走队列的可见后果是**每个渠道前等一个 MIN_GAP_MS**，所以钉住耗时下界——
    // 这也是面板那句「约 N 秒、期间其它 Cline 请求排队」的依据。
    expect(elapsed).toBeGreaterThanOrEqual(4 * MIN_GAP_MS * 0.75)

    // 校验结果也留档
    const cached = await readClineUpstreamCache(env, 'cline')
    expect(cached.checks['M']['alibaba'].status).toBe('ok')
  })

  it('没有渠道清单（未探测）→ total 0，不打上游', async () => {
    const { env } = makeEnv()
    const spy = vi.fn(async () => jsonResp({ data: { accessToken: 'at-1' } }))
    globalThis.fetch = spy as unknown as typeof fetch
    const { total, checks } = await validateClineProviderUpstream(env, clineProvider(), 'M')
    expect(total).toBe(0)
    expect(checks).toEqual([])
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('面板端点：GET 留档 / probe / validate', () => {
  function mount() {
    const app = new Hono()
    app.get('/admin/api/providers/:id/cline-upstreams', handleClineUpstreams)
    app.post('/admin/api/providers/:id/cline-upstreams/probe', handleClineUpstreamProbe)
    app.post('/admin/api/providers/:id/cline-upstreams/validate', handleClineUpstreamValidate)
    return app
  }

  it('GET 回模型、固定设置与留档；非 cline 提供商拒绝', async () => {
    const { env } = makeEnv()
    await setProviders(env, [clineProvider({ clinePinByModel: { M: { upstreams: ['alibaba'], pinMode: 'strict' } } })])
    const app = mount()

    const res = await app.request('/admin/api/providers/cline/cline-upstreams', {}, env as never)
    expect(res.status).toBe(200)
    const d = await res.json() as { success: boolean; data: { models: string[]; pins: Record<string, unknown> } }
    expect(d.success).toBe(true)
    expect(d.data.models).toContain('cline-free/deepseek-v4.1-flash')
    expect(d.data.pins['M']).toBeTruthy()

    await setProviders(env, [clineProvider({ id: 'deepseek' })])
    const bad = await app.request('/admin/api/providers/deepseek/cline-upstreams', {}, env as never)
    expect(bad.status).toBe(400)
    expect((await bad.json() as { message: string }).message).toContain('仅支持 Cline')
  })

  it('probe：缺 model 400；没有启用账号 400；正常时回渠道清单', async () => {
    const { env } = makeEnv()
    installFetch(() => sseResp(VERCEL_PROBE_ERR))
    await setProviders(env, [clineProvider()])
    const app = mount()

    const noModel = await app.request('/admin/api/providers/cline/cline-upstreams/probe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    }, env as never)
    expect(noModel.status).toBe(400)

    await setProviders(env, [clineProvider({ apiKeys: [{ key: RT_A, enabled: false }] })])
    const noKey = await app.request('/admin/api/providers/cline/cline-upstreams/probe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'M' }),
    }, env as never)
    expect(noKey.status).toBe(400)
    expect((await noKey.json() as { message: string }).message).toContain('没有启用的 Cline 账号')

    await setProviders(env, [clineProvider()])
    const ok = await app.request('/admin/api/providers/cline/cline-upstreams/probe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'M' }),
    }, env as never)
    expect(ok.status).toBe(200)
    const d = await ok.json() as { success: boolean; data: { upstreams: string[]; pipeline: string } }
    expect(d.success).toBe(true)
    expect(d.data.pipeline).toBe('planner')
    expect(d.data.upstreams).toContain('alibaba')
  })

  it('validate：未探测渠道时 400 提示先探测；探测后回逐渠道结果与汇总', async () => {
    const { env } = makeEnv()
    await setProviders(env, [clineProvider()])
    const app = mount()

    installFetch(() => sseResp(VERCEL_PROBE_ERR))
    const early = await app.request('/admin/api/providers/cline/cline-upstreams/validate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'M' }),
    }, env as never)
    expect(early.status).toBe(400)
    expect((await early.json() as { message: string }).message).toContain('先探测')

    await app.request('/admin/api/providers/cline/cline-upstreams/probe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'M' }),
    }, env as never)

    installFetch(() => sseResp('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'))
    const ok = await app.request('/admin/api/providers/cline/cline-upstreams/validate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'M' }),
    }, env as never)
    expect(ok.status).toBe(200)
    const d = await ok.json() as { success: boolean; data: { checks: unknown[]; total: number; summary: string } }
    expect(d.success).toBe(true)
    expect(d.data.total).toBe(4)
    expect(d.data.checks).toHaveLength(4)
    expect(d.data.summary).toContain('可用 4 / 共 4')
  })
})

// 保存归一是 exclude 的**唯一持久化入口**：漏掉 exclude 的归一/空配置判定，面板上排好的
// 排除项会被静默丢弃，而界面看起来「保存成功」。
describe('normalizeClinePinByModel：exclude 归一与空配置判定', () => {
  it('只排除、不钉渠道的配置必须落库（这是 exclude 的主要用法）', () => {
    expect(normalizeClinePinByModel({ M: { exclude: ['wafer'] } })).toEqual({ M: { exclude: ['wafer'] } })
  })

  it('exclude 去重/trim/丢空值；与 upstreams 同时存在时两者都留（裁决在注入侧）', () => {
    expect(normalizeClinePinByModel({ M: { upstreams: ['a'], exclude: [' wafer ', 'wafer', ''] } }))
      .toEqual({ M: { upstreams: ['a'], exclude: ['wafer'] } })
    expect(normalizeClinePinByModel({ M: { exclude: [7, null, {}] } })).toBeUndefined()
  })

  it('三项全空 / 非法输入 → undefined（不落空配置）', () => {
    expect(normalizeClinePinByModel({ M: {} })).toBeUndefined()
    expect(normalizeClinePinByModel({ M: { exclude: [] } })).toBeUndefined()
    expect(normalizeClinePinByModel({ M: 'nope' })).toBeUndefined()
    expect(normalizeClinePinByModel(null)).toBeUndefined()
    expect(normalizeClinePinByModel([])).toBeUndefined()
  })

  it('exclude + sort 的组合保留（排序与排除互不冲突）', () => {
    expect(normalizeClinePinByModel({ M: { exclude: ['wafer'], sort: 'cost' }, N: { sort: 'bogus' } }))
      .toEqual({ M: { exclude: ['wafer'], sort: 'cost' } })
  })
})
