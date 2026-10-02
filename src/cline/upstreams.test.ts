import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import type { Env, Provider } from '../types'
import {
  parseClineUpstreamList,
  classifyClineUpstreamError,
  parseClineRoutingMeta,
  clineRoutingFromFrame,
  judgeClinePinVerify,
  mergeClineTraffic,
  recordClineTraffic,
  readClineTraffic,
  __resetClineTrafficForTests,
  __resetClinePinLogForTests,
  CLINE_TRAFFIC_MIN_GAP_MS,
  probeClineProviderUpstream,
  validateClineProviderUpstream,
  verifyClineProviderUpstream,
  readClineUpstreamCache,
  CLINE_PROBE_UPSTREAM,
  MIN_GAP_MS,
} from './proxy'
import type { ClineTrafficSample } from './proxy'
import { handleClineUpstreams, handleClineUpstreamProbe, handleClineUpstreamValidate, handleClineUpstreamVerify, normalizeClinePinByModel } from '../admin'
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

// ===== 「钉住是否真的生效」：读回上游实际路由（2026-10-06） =====
// 为什么需要：出站偏好是网关自己拼的，[cline-pin] 日志只能证明**我们发出去了**；规划器管道会
// 静默丢弃顶层 provider.only（照常 200 出流、不报错、routing 里也看不出你钉过）。唯一硬证据是
// 响应里的 provider_metadata.gateway.routing.finalProvider。
describe('parseClineRoutingMeta：从响应帧里读上游实际路由', () => {
  it('实测形态：provider_metadata.gateway.routing 里的 finalProvider + fallbacksAvailable', () => {
    const t = 'data: {"id":"c1","provider_metadata":{"gateway":{"routing":{"finalProvider":"alibaba","fallbacksAvailable":[]}}}}\n\n'
    expect(parseClineRoutingMeta(t)).toEqual({ finalProvider: 'alibaba', fallbacksAvailable: [] })
  })

  it('resolvedProvider 是同一段的另一个字段名，作为兜底', () => {
    const t = 'data: {"provider_metadata":{"gateway":{"routing":{"resolvedProvider":"baseten"}}}}'
    expect(parseClineRoutingMeta(t).finalProvider).toBe('baseten')
  })

  it('元数据在后面某一帧才出现也能读到（不只看第一帧）', () => {
    const t = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
      'data: {"provider_metadata":{"gateway":{"routing":{"finalProvider":"gmicloud"}}}}\n\n' +
      'data: [DONE]\n\n'
    expect(parseClineRoutingMeta(t).finalProvider).toBe('gmicloud')
  })

  it('只认 gateway.routing 段：别处同名字段不算（逐层走对象，不做跨对象正则）', () => {
    const t = 'data: {"finalProvider":"wrong","provider_metadata":{"gateway":{"routing":{"finalProvider":"alibaba"}}}}'
    expect(parseClineRoutingMeta(t).finalProvider).toBe('alibaba')
  })

  it('非流式（整段一个 JSON，无 data: 前缀）也能读出来', () => {
    const t = '{"provider_metadata":{"gateway":{"routing":{"finalProvider":"novita","fallbacksAvailable":["wafer"]}}}}'
    expect(parseClineRoutingMeta(t)).toEqual({ finalProvider: 'novita', fallbacksAvailable: ['wafer'] })
  })

  it('没有路由信息 → 两个字段都是 null（**不猜**，由判定层给 unknown）', () => {
    expect(parseClineRoutingMeta('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'))
      .toEqual({ finalProvider: null, fallbacksAvailable: null })
    expect(parseClineRoutingMeta('')).toEqual({ finalProvider: null, fallbacksAvailable: null })
    expect(parseClineRoutingMeta('data: not-json\n\n')).toEqual({ finalProvider: null, fallbacksAvailable: null })
  })
})

describe('judgeClinePinVerify：钉住是否生效的判定矩阵', () => {
  const S = (only: string[], order: string[]) => ({ only, order })

  it('没配钉住 → unpinned（无事可验，不假装失败也不假装成功）', () => {
    expect(judgeClinePinVerify(S([], []), 'alibaba', []).verdict).toBe('unpinned')
  })

  it('读不到路由信息 → unknown，**绝不判成 ok**（否则"没验证"会伪装成"已验证"）', () => {
    const r = judgeClinePinVerify(S(['alibaba'], []), null, null)
    expect(r.verdict).toBe('unknown')
    expect(r.note).toContain('不等于')
  })

  it('白名单（strict/排除）：实际落在 only 内 → ok；落在外面 → mismatch', () => {
    expect(judgeClinePinVerify(S(['alibaba'], []), 'alibaba', []).verdict).toBe('ok')
    expect(judgeClinePinVerify(S(['alibaba'], []), 'baseten', []).verdict).toBe('mismatch')
    // 多选白名单：落在其中任一个都算生效
    expect(judgeClinePinVerify(S(['alibaba', 'novita'], []), 'novita', []).verdict).toBe('ok')
  })

  it('strict 生效时回退被清空（源项目实测口径），结论文案里带出来', () => {
    expect(judgeClinePinVerify(S(['alibaba'], []), 'alibaba', []).note).toContain('回退已清空')
    expect(judgeClinePinVerify(S(['alibaba'], []), 'alibaba', ['baseten']).note).toContain('仍可回退')
  })

  it('优先模式：走首位/在序列内 → ok；走序列外 → fallback（**允许兜底，不算失败**）', () => {
    expect(judgeClinePinVerify(S([], ['alibaba', 'novita']), 'alibaba', ['baseten']).verdict).toBe('ok')
    expect(judgeClinePinVerify(S([], ['alibaba', 'novita']), 'novita', ['baseten']).verdict).toBe('ok')
    const fb = judgeClinePinVerify(S([], ['alibaba', 'novita']), 'baseten', ['alibaba'])
    expect(fb.verdict).toBe('fallback')
    expect(fb.note).toContain('非失败')
  })
})

/** 一条带上游路由元数据的真实形态流。 */
const ROUTING_OK =
  'data: {"id":"c1","provider_metadata":{"gateway":{"routing":{"finalProvider":"alibaba","fallbacksAvailable":[]}}}}\n\n' +
  'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
  'data: [DONE]\n\n'

describe('verifyClineProviderUpstream：发一次真实请求读回实际渠道', () => {
  it('已保存 strict 钉 alibaba → 实际也是 alibaba，判定生效', async () => {
    const { env } = makeEnv()
    const provider = clineProvider({ clinePinByModel: { M: { upstreams: ['alibaba'], pinMode: 'strict' } } })
    const seen: Array<Record<string, unknown>> = []
    installFetch((body) => { seen.push(body); return sseResp(ROUTING_OK) })

    const r = await verifyClineProviderUpstream(env, provider, 'M')
    expect(r.verdict).toBe('ok')
    expect(r.finalProvider).toBe('alibaba')
    expect(r.fallbacksAvailable).toEqual([])
    expect(r.sent.only).toEqual(['alibaba'])
    expect(r.expected).toEqual({ upstreams: ['alibaba'], exclude: [], pinMode: 'strict' })
    // 自证"我们确实发了什么"：真正那次 chat 请求体里带着偏好
    // （seen 里还有目录请求，按 messages 认 chat 那次）
    const chatBody = seen.find((b) => Array.isArray(b.messages))!
    expect((chatBody.providerOptions as { gateway: { only: string[] } }).gateway.only).toEqual(['alibaba'])
  })

  it('实际走了别的渠道 → mismatch（这才是"没生效"的证据）', async () => {
    const { env } = makeEnv()
    const provider = clineProvider({ clinePinByModel: { M: { upstreams: ['alibaba'] } } })
    installFetch(() => sseResp('data: {"provider_metadata":{"gateway":{"routing":{"finalProvider":"baseten"}}}}\n\n'))
    const r = await verifyClineProviderUpstream(env, provider, 'M')
    expect(r.verdict).toBe('mismatch')
    expect(r.note).toContain('baseten')
  })

  it('exclude 换算出的白名单参与判定，且结论落留档（重载面板不必重验）', async () => {
    const { env, map } = makeEnv()
    map.set('cline:upstreams:cline', JSON.stringify({
      probes: {
        M: {
          model: 'M', ok: true, pipeline: 'planner', upstreams: ['alibaba', 'baseten', 'novita'],
          status: 200, note: '', ms: 1, probedAt: 1,
        },
      },
      checks: {}, updatedAt: 1,
    }))
    const provider = clineProvider({ clinePinByModel: { M: { exclude: ['baseten'] } } })
    installFetch(() => sseResp('data: {"provider_metadata":{"gateway":{"routing":{"finalProvider":"novita"}}}}\n\n'))

    const r = await verifyClineProviderUpstream(env, provider, 'M')
    expect(r.sent.only).toEqual(['alibaba', 'novita'])
    expect(r.verdict).toBe('ok')
    const cache = await readClineUpstreamCache(env, 'cline')
    expect(cache.verifies?.M.verdict).toBe('ok')
    expect(cache.verifies?.M.finalProvider).toBe('novita')
  })

  it('请求失败 → unknown（不判成失败也不判成生效）', async () => {
    const { env } = makeEnv()
    const provider = clineProvider({ clinePinByModel: { M: { upstreams: ['alibaba'] } } })
    installFetch(() => { throw new Error('boom') })
    const r = await verifyClineProviderUpstream(env, provider, 'M')
    expect(r.verdict).toBe('unknown')
    expect(r.note).toContain('无法判定')
  })
})

describe('面板端点：POST cline-upstreams/verify', () => {
  function mountVerify() {
    const app = new Hono()
    app.post('/admin/api/providers/:id/cline-upstreams/verify', handleClineUpstreamVerify)
    return app
  }
  const post = (app: Hono, path: string, body: unknown, env: unknown) =>
    app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env as never)

  it('缺 model 400；没有启用账号 400；非 cline 提供商 400', async () => {
    const { env } = makeEnv()
    await setProviders(env, [clineProvider()])
    const app = mountVerify()

    const noModel = await post(app, '/admin/api/providers/cline/cline-upstreams/verify', {}, env)
    expect(noModel.status).toBe(400)

    await setProviders(env, [clineProvider({ apiKeys: [{ key: RT_A, enabled: false }] })])
    const noKey = await post(app, '/admin/api/providers/cline/cline-upstreams/verify', { model: 'M' }, env)
    expect(noKey.status).toBe(400)
    expect((await noKey.json() as { message: string }).message).toContain('没有启用的 Cline 账号')

    await setProviders(env, [clineProvider({ id: 'deepseek' })])
    const bad = await post(app, '/admin/api/providers/deepseek/cline-upstreams/verify', { model: 'M' }, env)
    expect(bad.status).toBe(400)
    expect((await bad.json() as { message: string }).message).toContain('仅支持 Cline')
  })

  it('正常时回结论（面板据此渲染"生效/未生效"）', async () => {
    const { env } = makeEnv()
    await setProviders(env, [clineProvider({ clinePinByModel: { M: { upstreams: ['alibaba'] } } })])
    installFetch(() => sseResp(ROUTING_OK))
    const app = mountVerify()

    const ok = await post(app, '/admin/api/providers/cline/cline-upstreams/verify', { model: 'M' }, env)
    expect(ok.status).toBe(200)
    const d = await ok.json() as { success: boolean; data: { verdict: string; finalProvider: string } }
    expect(d.success).toBe(true)
    expect(d.data.verdict).toBe('ok')
    expect(d.data.finalProvider).toBe('alibaba')
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

// ===== 真实流量的路由结果留档（2026-10-06）=====
//
// 手动「验证钉住」是**抽样一次**；真实流量里每条响应帧都带 finalProvider，那才是全量证据。
// 这一组钉住三件事：① 逐帧摘取不重复解析 JSON；② 并发/丢更新下**旧写不许把"最近一次观测"回退**；
// ③ 异常必须另落 append-only 的系统日志——聚合键是快视图（可能丢更新、会被限流合并），日志才是真值。
describe('clineRoutingFromFrame：从已解析的帧对象摘路由元数据（热路径零重复解析）', () => {
  it('实测形态：provider_metadata.gateway.routing.finalProvider', () => {
    const obj = { id: 'c1', provider_metadata: { gateway: { routing: { finalProvider: 'alibaba', fallbacksAvailable: [] } } } }
    expect(clineRoutingFromFrame(obj)).toEqual({ finalProvider: 'alibaba', fallbacksAvailable: [] })
  })

  it('信封多一层（data 包装）也读得到：不写死层级，换管道不会静默读不到', () => {
    const obj = { data: { provider_metadata: { gateway: { routing: { resolvedProvider: 'baseten' } } } } }
    expect(clineRoutingFromFrame(obj).finalProvider).toBe('baseten')
  })

  it('没有路由段 → 两个 null（不猜；由判定层给 unknown）', () => {
    expect(clineRoutingFromFrame({ choices: [{ delta: { content: 'hi' } }] }))
      .toEqual({ finalProvider: null, fallbacksAvailable: null })
    expect(clineRoutingFromFrame(null)).toEqual({ finalProvider: null, fallbacksAvailable: null })
  })

  it('与文本版同口径：同一帧两条路径得出同样结论（否则手动验证与流量画像会互相矛盾）', () => {
    const text = 'data: {"provider_metadata":{"gateway":{"routing":{"finalProvider":"novita","fallbacksAvailable":["wafer"]}}}}\n\n'
    const frame = JSON.parse(text.slice(5).trim())
    expect(clineRoutingFromFrame(frame)).toEqual(parseClineRoutingMeta(text))
  })
})

/** 一次观测的构造器（merge 是纯函数，用例直接喂结构而不是走 KV）。 */
const SAMPLE = (at: number, finalProvider: string, verdict: ClineTrafficSample['verdict'] = 'ok'): ClineTrafficSample =>
  ({ at, finalProvider, fallbacksAvailable: [], verdict, note: 'note-' + at, ok: true })

/** in-isolate 聚合桶的替身（结构必须与 ClineTrafficBucket 一致，否则 merge 的签名会挡住）。 */
function delta(over: Record<string, unknown> = {}) {
  return {
    providerId: 'cline', model: 'M', from: 1000, requests: 1, routed: 1,
    providers: { alibaba: 1 }, verdicts: { ok: 1 }, last: SAMPLE(1000, 'alibaba'),
    anomalies: [] as ClineTrafficSample[], sent: { only: ['alibaba'], order: [], sort: null },
    ...over,
  }
}

describe('mergeClineTraffic：并发写下的合并语义', () => {
  it('首次（无旧值）→ 直接成为留档', () => {
    const r = mergeClineTraffic(null, delta())
    expect(r.requests).toBe(1)
    expect(r.routed).toBe(1)
    expect(r.providers).toEqual({ alibaba: 1 })
    // to 缺省时用 from：updatedAt 不能是 0（面板用它判"留档时间"）
    expect(r.updatedAt).toBe(1000)
  })

  it('计数与渠道次数相加（近似统计：读到的旧值偏旧总数就偏小，这是已知取舍）', () => {
    const prev = mergeClineTraffic(null, delta())
    const r = mergeClineTraffic(prev, delta({
      providers: { novita: 2 }, verdicts: { mismatch: 2 }, requests: 2, routed: 2, last: SAMPLE(2000, 'novita', 'mismatch'),
    }))
    expect(r.requests).toBe(3)
    expect(r.providers).toEqual({ alibaba: 1, novita: 2 })
    expect(r.verdicts).toEqual({ ok: 1, mismatch: 2 })
    expect(r.from).toBe(1000)
    expect(r.last!.at).toBe(2000)
  })

  it('**旧写不许回退 last**：并发下带着旧快照的写入不能把"最近一次观测"改早', () => {
    const prev = mergeClineTraffic(null, delta({
      last: SAMPLE(5000, 'novita'), from: 5000, sent: { only: ['novita'], order: [], sort: null },
    }))
    const stale = delta({ last: SAMPLE(3000, 'alibaba'), sent: { only: ['alibaba'], order: [], sort: null } })
    const r = mergeClineTraffic(prev, stale)
    expect(r.last!.at).toBe(5000)
    expect(r.last!.finalProvider).toBe('novita')
    // sent 跟着 last 走：不能用旧请求的下发口径去解释新结论，否则面板会自相矛盾
    expect(r.sent.only).toEqual(['novita'])
    // 但计数照加：丢的是"新"不是"量"
    expect(r.requests).toBe(2)
  })

  it('anomalies：同一 (at, 渠道) 去重、新→旧排序、封顶 5 条', () => {
    const many = (n: number, base = 1000) =>
      Array.from({ length: n }, (_, i) => SAMPLE(base + i, 'baseten', 'mismatch'))
    let r = mergeClineTraffic(null, delta({ anomalies: many(3) }))
    r = mergeClineTraffic(r, delta({ anomalies: [SAMPLE(1002, 'baseten', 'mismatch')] }))
    expect(r.anomalies.filter((a) => a.at === 1002)).toHaveLength(1)
    expect(r.anomalies.map((a) => a.at)).toEqual([1002, 1001, 1000])
    r = mergeClineTraffic(r, delta({ anomalies: many(10, 2000) }))
    expect(r.anomalies).toHaveLength(5)
    expect(r.anomalies[0].at).toBe(2009)
  })

  it('readClineTraffic 对损坏/缺字段的留档做兜底（不抛、不把 undefined 喂给面板）', async () => {
    const { env, map } = makeEnv()
    map.set('cline:traffic:cline:M', 'not-json')
    expect(await readClineTraffic(env, 'cline', 'M')).toBeNull()
    map.set('cline:traffic:cline:M', JSON.stringify({ model: 'M', requests: 3 }))
    const r = await readClineTraffic(env, 'cline', 'M')
    expect(r).toMatchObject({ requests: 3, routed: 0, providers: {}, anomalies: [], last: null })
    expect(await readClineTraffic(env, 'cline', 'N')).toBeNull()
  })
})

const trafficKeys = (map: Map<string, string>) => [...map.keys()].filter((k) => k.startsWith('cline:traffic:'))
const logEntries = (map: Map<string, string>) =>
  [...map.entries()].filter(([k]) => k.startsWith('log:')).map(([, v]) => JSON.parse(v) as { type: string; message: string })

describe('recordClineTraffic：限流合并 + 落盘 + 异常落日志', () => {
  // 白名单含 alibaba + novita：这两条是"正常流量"，异常用例显式喂 baseten
  const CTX = (env: Env, model = 'M') =>
    ({ env, providerId: 'cline', model, sent: { only: ['alibaba', 'novita'], order: [], sort: null } })

  it('首条立即落盘；窗口内的连发合并进桶（不写 KV），窗口过后一次写清', async () => {
    __resetClineTrafficForTests()
    const { env, map } = makeEnv()
    const t0 = 1_700_000_000_000
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0)
    try {
      await recordClineTraffic(CTX(env), { finalProvider: 'alibaba', fallbacksAvailable: [] }, true)
      expect(trafficKeys(map)).toHaveLength(1)

      // 5 秒窗口内的连发不落盘：KV 写配额是所有功能共享的，写爆了连提供商配置都存不进去
      now.mockReturnValue(t0 + 1000)
      await recordClineTraffic(CTX(env), { finalProvider: 'novita', fallbacksAvailable: [] }, true)
      expect(trafficKeys(map)).toHaveLength(1)

      now.mockReturnValue(t0 + CLINE_TRAFFIC_MIN_GAP_MS + 1)
      await recordClineTraffic(CTX(env), { finalProvider: 'novita', fallbacksAvailable: [] }, true)
      // 同一个模型只占一个键（面板读取 = 1 次 KV.get/模型，不是 list 全量扫）
      expect(trafficKeys(map)).toHaveLength(1)

      const rec = await readClineTraffic(env, 'cline', 'M')
      expect(rec!.requests).toBe(3)
      expect(rec!.routed).toBe(3)
      expect(rec!.providers).toEqual({ alibaba: 1, novita: 2 })
      expect(rec!.verdicts).toEqual({ ok: 3 })
      expect(rec!.last!.finalProvider).toBe('novita')
    } finally { now.mockRestore() }
  })

  it('读不到路由元数据 → routed=0 且判定 unknown（**不许记成生效**）', async () => {
    __resetClineTrafficForTests()
    const { env } = makeEnv()
    await recordClineTraffic(CTX(env), null, true)
    const rec = await readClineTraffic(env, 'cline', 'M')
    expect(rec!.requests).toBe(1)
    expect(rec!.routed).toBe(0)
    expect(rec!.providers).toEqual({})
    expect(rec!.verdicts).toEqual({ unknown: 1 })
    expect(rec!.last!.verdict).toBe('unknown')
  })

  it('没配钉住 → unpinned（真实流量照记，只是"无事可验"）', async () => {
    __resetClineTrafficForTests()
    const { env } = makeEnv()
    const ctx = { ...CTX(env), sent: { only: [], order: [], sort: null } }
    await recordClineTraffic(ctx, { finalProvider: 'alibaba', fallbacksAvailable: [] }, true)
    const rec = await readClineTraffic(env, 'cline', 'M')
    expect(rec!.verdicts).toEqual({ unpinned: 1 })
    expect(rec!.providers).toEqual({ alibaba: 1 })
  })

  it('每个模型一条留档：不同模型的观测不互相污染', async () => {
    __resetClineTrafficForTests()
    const { env, map } = makeEnv()
    await recordClineTraffic(CTX(env, 'M'), { finalProvider: 'alibaba', fallbacksAvailable: [] }, true)
    __resetClineTrafficForTests() // 只清聚合桶，不清已落盘的 KV
    await recordClineTraffic(CTX(env, 'N'), { finalProvider: 'novita', fallbacksAvailable: [] }, true)
    expect(trafficKeys(map).sort()).toEqual(['cline:traffic:cline:M', 'cline:traffic:cline:N'])
    expect((await readClineTraffic(env, 'cline', 'M'))!.providers).toEqual({ alibaba: 1 })
    expect((await readClineTraffic(env, 'cline', 'N'))!.providers).toEqual({ novita: 1 })
  })

  it('异常（实际渠道违反白名单）→ 落 **warn** 级 [cline-route] 系统日志，5 分钟内不重复', async () => {
    __resetClineTrafficForTests()
    __resetClinePinLogForTests()
    const { env, map } = makeEnv()
    const t0 = 1_700_000_000_000
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0)
    try {
      await recordClineTraffic(CTX(env), { finalProvider: 'baseten', fallbacksAvailable: [] }, true)
      now.mockReturnValue(t0 + CLINE_TRAFFIC_MIN_GAP_MS + 1)
      await recordClineTraffic(CTX(env), { finalProvider: 'baseten', fallbacksAvailable: [] }, true)

      const route = logEntries(map).filter((l) => l.message.includes('[cline-route]'))
      // 结论完全相同，重复落盘没有信息量——持续失效时每 5 秒一条会把面板刷满
      expect(route).toHaveLength(1)
      // 异常是告警：走 warn（info 出口留给正常路径的 [cline-pin]）
      expect(route[0].type).toBe('warn')
      expect(route[0].message).toContain('钉住没生效')
      expect(route[0].message).toContain('baseten')

      // 聚合键里两条异常都在：日志与快视图各司其职，不能因为去重就把计数也吞掉
      const rec = await readClineTraffic(env, 'cline', 'M')
      expect(rec!.verdicts).toEqual({ mismatch: 2 })
      expect(rec!.anomalies).toHaveLength(2)
    } finally { now.mockRestore() }
  })

  it('正常流量不写系统日志（否则日志出口会被正常请求灌满）', async () => {
    __resetClineTrafficForTests()
    __resetClinePinLogForTests()
    const { env, map } = makeEnv()
    await recordClineTraffic(CTX(env), { finalProvider: 'alibaba', fallbacksAvailable: [] }, true)
    expect(logEntries(map).filter((l) => l.message.includes('[cline-route]'))).toHaveLength(0)
  })
})

describe('面板端点：GET cline-upstreams 带回真实流量留档', () => {
  it('已留档的模型直接回传（打开面板就看到流量画像，不必再打上游）', async () => {
    const { env, map } = makeEnv()
    await setProviders(env, [clineProvider({ clinePinByModel: { M: { upstreams: ['alibaba'] } } })])
    map.set('cline:traffic:cline:M', JSON.stringify({
      model: 'M', requests: 7, routed: 7, providers: { alibaba: 5, baseten: 2 },
      verdicts: { ok: 5, mismatch: 2 },
      last: SAMPLE(9, 'baseten', 'mismatch'),
      anomalies: [SAMPLE(9, 'baseten', 'mismatch')],
      sent: { only: ['alibaba'], order: [], sort: null }, from: 1, updatedAt: 9,
    }))
    const app = new Hono()
    app.get('/admin/api/providers/:id/cline-upstreams', handleClineUpstreams)

    const res = await app.request('/admin/api/providers/cline/cline-upstreams', {}, env as never)
    expect(res.status).toBe(200)
    const d = await res.json() as {
      data: { traffic: Record<string, { requests: number; providers: Record<string, number>; anomalies: unknown[] }> }
    }
    expect(d.data.traffic.M.requests).toBe(7)
    expect(d.data.traffic.M.providers).toEqual({ alibaba: 5, baseten: 2 })
    expect(d.data.traffic.M.anomalies).toHaveLength(1)
    // 没有留档的模型不出现在 traffic 里（面板据此决定要不要渲染那一行）
    expect(d.data.traffic['cline-free/deepseek-v4.1-flash']).toBeUndefined()
  })
})
