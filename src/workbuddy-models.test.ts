import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  probeWorkbuddyModelCatalog,
  probeWorkbuddyModelCatalogForProvider,
  getCachedWorkbuddyCatalog,
  getCachedWorkbuddyEfforts,
  __resetWorkbuddyCatalogCacheForTests,
  WORKBUDDY_MODELS,
  WORKBUDDY_GLOBAL_MODELS,
} from './workbuddy-models'
import {
  WORKBUDDY_V3_CONFIG_PATH,
  WORKBUDDY_CN_MODELS_PATH,
  WORKBUDDY_GLOBAL_MODELS_PROBE_PATHS,
  isWorkbuddyNonChatModel,
  mergeWorkbuddyModelCatalogs,
  parseWorkbuddyGlobalModels,
} from './workbuddy-upstream'
import type { Env, Provider } from './types'

/**
 * WorkBuddy 模型目录双域并集探测测试
 * （移植 workbuddy2api 0adc345 v3-config-merge：/v3/config 主 + 企业端点补缺）。
 *
 * 核心行为：
 *  1. 主路 `/v3/config` 独有模型必须进目录（上游实测丢了 4 个）；
 *  2. 企业端点独有模型（如 gpt-5.3-codex）作为补缺进目录；
 *  3. 同 id 以**主路字段为准**（credits 等）；
 *  4. 单路失败 → 降级为另一路 + warnings；
 *  5. 两路全失败 → 静态兜底 + `stale: true`（**不返回空列表**）；
 *  6. CN 与 global 对称（CN 也探测，不再只回过期静态清单）；
 *  7. `nonChatModel` 过滤（`/v3/config` 全量返回，必须挡掉图片/补全模型）。
 */

const PID = 'workbuddy-models-test'

/** 构造一个 CN realm 的 JWT（iss 含 codebuddy.cn）。 */
function makeJwt(uid: string, iss = 'https://www.codebuddy.cn'): string {
  const b64url = (o: unknown) => {
    const b64 = btoa(JSON.stringify(o))
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  return `${b64url({ alg: 'HS256' })}.${b64url({ iss, uid })}.sig`
}

/** 最小 Env：KV 里放一个 token，供 readOauthToken 使用。 */
function makeEnv(token: string): { env: Env; store: Map<string, string> } {
  const store = new Map<string, string>()
  store.set(`oauth:token:${PID}`, JSON.stringify({
    access_token: token,
    refresh_token: 'rt',
    expires_at: Date.now() + 3600_000,
    updated_at: Date.now(),
    uid: 'u1',
  }))
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v) },
    delete: async (k: string) => { store.delete(k) },
    list: async () => ({ keys: [], list_complete: true, cursor: '' }),
  }
  return { env: { KV: kv, GATEWAY_KV: kv, RATE_LIMIT_KV: kv, SESSION_KV: kv } as unknown as Env, store }
}

function makeProvider(overrides?: Partial<Provider>): Provider {
  return {
    id: PID,
    name: 'WorkBuddy Models',
    authType: 'oauth-device',
    baseUrl: 'https://copilot.tencent.com/v2',
    apiKeys: [],
    models: [],
    enabled: true,
    oauth: {
      flowType: 'browser',
      deviceCodeUrl: 'https://copilot.tencent.com/v2/plugin/auth/state',
      deviceTokenUrl: 'https://copilot.tencent.com/v2/plugin/auth/token',
      refreshTokenUrl: 'https://copilot.tencent.com/v2/plugin/auth/token/refresh',
      tokenHeader: 'Authorization',
      tokenHeaderPrefix: 'Bearer ',
      extraHeaders: { Origin: 'https://www.codebuddy.cn' },
      globalBaseUrl: 'https://www.workbuddy.ai/v2',
      globalOrigin: 'https://www.workbuddy.ai',
    },
    ...overrides,
  } as unknown as Provider
}

/** 构造 v3/config 或企业端点的成功响应体。 */
function catalogBody(models: Array<Record<string, unknown>>): string {
  return JSON.stringify({ code: 0, data: { models } })
}

/** 按 URL 路由的 fetch mock，记录请求。 */
function routeFetch(handlers: Record<string, () => Response>): { fn: ReturnType<typeof vi.fn>; calls: string[] } {
  const calls: string[] = []
  const fn = vi.fn(async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
    calls.push(u)
    for (const [frag, make] of Object.entries(handlers)) {
      if (u.includes(frag)) return make()
    }
    return new Response('not found', { status: 404 })
  })
  return { fn, calls }
}

describe('WorkBuddy 模型目录双域并集探测（0adc345 v3-config-merge）', () => {
  beforeEach(() => {
    __resetWorkbuddyCatalogCacheForTests()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('CN：/v3/config 为主路，独有模型进目录（不再只回过期静态清单）', async () => {
    const { env } = makeEnv(makeJwt('u1'))
    // /v3/config 给全量；企业端点给子集（两者有交集）
    const { fn, calls } = routeFetch({
      [WORKBUDDY_V3_CONFIG_PATH]: () => new Response(catalogBody([
        { id: 'glm-5.2', credits: 'x0.05' },
        { id: 'hy3' },
        { id: 'v3-only-model' },
      ]), { status: 200 }),
      [WORKBUDDY_CN_MODELS_PATH]: () => new Response(catalogBody([
        { id: 'glm-5.2' },
        { id: 'cn-enterprise-only' },
      ]), { status: 200 }),
    })
    vi.stubGlobal('fetch', fn)

    const result = await probeWorkbuddyModelCatalog(env, makeProvider(), 'cn', makeJwt('u1'))

    expect(result.stale).toBe(false)
    const ids = result.entries.map((e) => e.id)
    // 主路原序在前
    expect(ids[0]).toBe('glm-5.2')
    expect(ids).toContain('hy3')
    // 主路独有
    expect(ids).toContain('v3-only-model')
    // 企业端点独有（补缺）
    expect(ids).toContain('cn-enterprise-only')
    // 两路都被调用（并发）
    expect(calls.some((u) => u.includes(WORKBUDDY_V3_CONFIG_PATH))).toBe(true)
    expect(calls.some((u) => u.includes(WORKBUDDY_CN_MODELS_PATH))).toBe(true)
  })

  it('同 id 以主路字段为准（credits 以 v3 为准）', async () => {
    const { env } = makeEnv(makeJwt('u1'))
    const { fn } = routeFetch({
      [WORKBUDDY_V3_CONFIG_PATH]: () => new Response(catalogBody([
        { id: 'glm-5.2', credits: 'x0.05', descriptionZh: '来自v3' },
      ]), { status: 200 }),
      [WORKBUDDY_CN_MODELS_PATH]: () => new Response(catalogBody([
        { id: 'glm-5.2', credits: 'x9.99', descriptionZh: '来自企业端点' },
      ]), { status: 200 }),
    })
    vi.stubGlobal('fetch', fn)

    const result = await probeWorkbuddyModelCatalog(env, makeProvider(), 'cn', makeJwt('u1'))
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].credits).toBe('x0.05')
    expect(result.entries[0].descriptionZh).toBe('来自v3')
  })

  it('单路失败（v3 挂）→ 降级为企业端点结果 + warnings，不 stale', async () => {
    const { env } = makeEnv(makeJwt('u1'))
    const { fn } = routeFetch({
      [WORKBUDDY_V3_CONFIG_PATH]: () => new Response('boom', { status: 500 }),
      [WORKBUDDY_CN_MODELS_PATH]: () => new Response(catalogBody([{ id: 'only-enterprise' }]), { status: 200 }),
    })
    vi.stubGlobal('fetch', fn)

    const result = await probeWorkbuddyModelCatalog(env, makeProvider(), 'cn', makeJwt('u1'))
    expect(result.stale).toBe(false)
    expect(result.entries.map((e) => e.id)).toEqual(['only-enterprise'])
    expect(result.warnings.join(' ')).toContain('v3/config')
  })

  it('单路失败（企业端点挂）→ 降级为 v3 结果 + warnings，不 stale', async () => {
    const { env } = makeEnv(makeJwt('u1'))
    const { fn } = routeFetch({
      [WORKBUDDY_V3_CONFIG_PATH]: () => new Response(catalogBody([{ id: 'only-v3' }]), { status: 200 }),
      [WORKBUDDY_CN_MODELS_PATH]: () => new Response('nope', { status: 404 }),
    })
    vi.stubGlobal('fetch', fn)

    const result = await probeWorkbuddyModelCatalog(env, makeProvider(), 'cn', makeJwt('u1'))
    expect(result.stale).toBe(false)
    expect(result.entries.map((e) => e.id)).toEqual(['only-v3'])
    expect(result.warnings.join(' ')).toContain('企业端点')
  })

  it('两路全失败 → 静态兜底 + stale:true（**不返回空列表**，后台按钮不能变空）', async () => {
    const { env } = makeEnv(makeJwt('u1'))
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })))

    const result = await probeWorkbuddyModelCatalog(env, makeProvider(), 'cn', makeJwt('u1'))
    expect(result.stale).toBe(true)
    expect(result.entries.length).toBeGreaterThan(0)
    expect(result.entries.map((e) => e.id)).toEqual(WORKBUDDY_MODELS)
  })

  it('global 两路全失败 → 静态兜底为 global 清单（不是 CN 清单）', async () => {
    const { env } = makeEnv(makeJwt('u1', 'https://www.workbuddy.ai'))
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })))

    const result = await probeWorkbuddyModelCatalog(env, makeProvider(), 'global', makeJwt('u1', 'https://www.workbuddy.ai'))
    expect(result.stale).toBe(true)
    expect(result.entries.map((e) => e.id)).toEqual(WORKBUDDY_GLOBAL_MODELS)
  })

  it('global：企业端点家族 /v2 优先，/v2 挂才试 /console', async () => {
    const { env } = makeEnv(makeJwt('u1', 'https://www.workbuddy.ai'))
    const { fn, calls } = routeFetch({
      [WORKBUDDY_V3_CONFIG_PATH]: () => new Response(catalogBody([{ id: 'v3-model' }]), { status: 200 }),
      [WORKBUDDY_GLOBAL_MODELS_PROBE_PATHS[0]]: () => new Response('nope', { status: 500 }),
      [WORKBUDDY_GLOBAL_MODELS_PROBE_PATHS[1]]: () => new Response(catalogBody([{ id: 'console-model' }]), { status: 200 }),
    })
    vi.stubGlobal('fetch', fn)

    const result = await probeWorkbuddyModelCatalog(env, makeProvider(), 'global', makeJwt('u1', 'https://www.workbuddy.ai'))
    const ids = result.entries.map((e) => e.id)
    expect(ids).toContain('v3-model')
    expect(ids).toContain('console-model')
    // /v2 挂后确实回落到了 /console
    expect(calls.some((u) => u.includes(WORKBUDDY_GLOBAL_MODELS_PROBE_PATHS[1]))).toBe(true)
  })

  it('nonChatModel 过滤：v3 全量里的图片/补全模型被挡在目录外', async () => {
    const { env } = makeEnv(makeJwt('u1'))
    const { fn } = routeFetch({
      [WORKBUDDY_V3_CONFIG_PATH]: () => new Response(catalogBody([
        { id: 'glm-5.2' },
        { id: 'nes-embedding-1' },
        { id: 'completion-fast' },
        { id: 'codewise-x' },
        { id: 'tiny-model', maxOutputTokens: 128 },
        { id: 'image-model', tags: ['text-to-image'] },
      ]), { status: 200 }),
      [WORKBUDDY_CN_MODELS_PATH]: () => new Response('nope', { status: 404 }),
    })
    vi.stubGlobal('fetch', fn)

    const result = await probeWorkbuddyModelCatalog(env, makeProvider(), 'cn', makeJwt('u1'))
    const ids = result.entries.map((e) => e.id)
    expect(ids).toEqual(['glm-5.2'])
    expect(ids).not.toContain('nes-embedding-1')
    expect(ids).not.toContain('completion-fast')
    expect(ids).not.toContain('codewise-x')
    expect(ids).not.toContain('tiny-model')
    expect(ids).not.toContain('image-model')
  })

  it('探测结果写入缓存：同 realm 二次探测命中缓存（不再打上游）', async () => {
    const { env } = makeEnv(makeJwt('u1'))
    const { fn, calls } = routeFetch({
      [WORKBUDDY_V3_CONFIG_PATH]: () => new Response(catalogBody([{ id: 'cached-model' }]), { status: 200 }),
      [WORKBUDDY_CN_MODELS_PATH]: () => new Response('nope', { status: 404 }),
    })
    vi.stubGlobal('fetch', fn)

    await probeWorkbuddyModelCatalog(env, makeProvider(), 'cn', makeJwt('u1'))
    const afterFirst = calls.length
    await probeWorkbuddyModelCatalog(env, makeProvider(), 'cn', makeJwt('u1'))
    expect(calls.length).toBe(afterFirst)
  })

  it('CN 与 global 缓存分桶：同 providerId 不互相污染', async () => {
    const { env } = makeEnv(makeJwt('u1'))
    const cnJwt = makeJwt('u1')
    const globalJwt = makeJwt('u1', 'https://www.workbuddy.ai')
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
      if (u.includes('workbuddy.ai')) return new Response(catalogBody([{ id: 'global-model' }]), { status: 200 })
      return new Response(catalogBody([{ id: 'cn-model' }]), { status: 200 })
    }))

    const cn = await probeWorkbuddyModelCatalog(env, makeProvider(), 'cn', cnJwt)
    const gl = await probeWorkbuddyModelCatalog(env, makeProvider(), 'global', globalJwt)
    expect(cn.entries.map((e) => e.id)).toEqual(['cn-model'])
    expect(gl.entries.map((e) => e.id)).toEqual(['global-model'])
    expect(getCachedWorkbuddyCatalog(PID, 'cn')!.entries.map((e) => e.id)).toEqual(['cn-model'])
    expect(getCachedWorkbuddyCatalog(PID, 'global')!.entries.map((e) => e.id)).toEqual(['global-model'])
  })

  it('无 token → 静态兜底 + stale（probeWorkbuddyModelCatalogForProvider）', async () => {
    const store = new Map<string, string>()
    const kv = {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => { store.set(k, v) },
      delete: async (k: string) => { store.delete(k) },
      list: async () => ({ keys: [], list_complete: true, cursor: '' }),
    }
    const env = { KV: kv, GATEWAY_KV: kv, RATE_LIMIT_KV: kv, SESSION_KV: kv } as unknown as Env
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const result = await probeWorkbuddyModelCatalogForProvider(env, makeProvider(), 'cn')
    expect(result.stale).toBe(true)
    expect(result.entries.map((e) => e.id)).toEqual(WORKBUDDY_MODELS)
    // 无 token 不该打上游
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('出站请求带三段式 CLI UA（/v3/config 的 UA 门禁）', async () => {
    const { env } = makeEnv(makeJwt('u1'))
    const seen: Array<Record<string, string>> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const h: Record<string, string> = {}
      for (const [k, v] of Object.entries((init?.headers || {}) as Record<string, string>)) h[k.toLowerCase()] = String(v)
      seen.push(h)
      return new Response(catalogBody([{ id: 'm1' }]), { status: 200 })
    }))

    await probeWorkbuddyModelCatalog(env, makeProvider(), 'cn', makeJwt('u1'))
    expect(seen.length).toBeGreaterThan(0)
    const ua = seen[0]['user-agent'] || ''
    // 三段式：WorkBuddy/<ver> <platform>/<ver> CLI/<ver>
    expect(ua).toMatch(/WorkBuddy\/[\d.]+ .+\/[\d.]+ CLI\/[\d.]+/)
    expect(seen[0]['x-codebuddy-request']).toBe('1')
  })

  it('getCachedWorkbuddyEfforts 返回探测到的档位；未命中返回 null（退回运营者手填）', async () => {
    const { env } = makeEnv(makeJwt('u1'))
    const { fn } = routeFetch({
      [WORKBUDDY_V3_CONFIG_PATH]: () => new Response(catalogBody([
        { id: 'with-effort', reasoning: { supportedEfforts: ['low', 'high'], defaultEffort: 'high' } },
        { id: 'no-effort' },
      ]), { status: 200 }),
      [WORKBUDDY_CN_MODELS_PATH]: () => new Response('nope', { status: 404 }),
    })
    vi.stubGlobal('fetch', fn)

    await probeWorkbuddyModelCatalog(env, makeProvider(), 'cn', makeJwt('u1'))
    expect(getCachedWorkbuddyEfforts(PID, 'cn', 'with-effort')).toEqual(['low', 'high'])
    // 无档位声明 → null（不是空数组）
    expect(getCachedWorkbuddyEfforts(PID, 'cn', 'no-effort')).toBeNull()
    // 未探测的模型 → null
    expect(getCachedWorkbuddyEfforts(PID, 'cn', 'unknown')).toBeNull()
  })

  it('stale 缓存不提供 effort 档位（避免用静态兜底编造能力）', async () => {
    const { env } = makeEnv(makeJwt('u1'))
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })))
    await probeWorkbuddyModelCatalog(env, makeProvider(), 'cn', makeJwt('u1'))
    expect(getCachedWorkbuddyEfforts(PID, 'cn', WORKBUDDY_MODELS[0])).toBeNull()
  })

  it('缓存过期（超 5min 负缓存）→ 重新探测', async () => {
    const { env } = makeEnv(makeJwt('u1'))
    const { fn, calls } = routeFetch({
      [WORKBUDDY_V3_CONFIG_PATH]: () => new Response(catalogBody([{ id: 'm1' }]), { status: 200 }),
      [WORKBUDDY_CN_MODELS_PATH]: () => new Response('nope', { status: 404 }),
    })
    vi.stubGlobal('fetch', fn)
    await probeWorkbuddyModelCatalog(env, makeProvider(), 'cn', makeJwt('u1'))
    const n = calls.length
    // 越过 1h 成功缓存窗口
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 60 * 60 * 1000)
    await probeWorkbuddyModelCatalog(env, makeProvider(), 'cn', makeJwt('u1'))
    vi.restoreAllMocks()
    expect(calls.length).toBeGreaterThan(n)
  })
})

describe('isWorkbuddyNonChatModel 边界', () => {
  it('三类规则各自命中', () => {
    expect(isWorkbuddyNonChatModel('nes-embed')).toBe(true)
    expect(isWorkbuddyNonChatModel('completion-x')).toBe(true)
    expect(isWorkbuddyNonChatModel('codewise-y')).toBe(true)
    expect(isWorkbuddyNonChatModel('m', 256)).toBe(true)
    expect(isWorkbuddyNonChatModel('m', 128)).toBe(true)
    expect(isWorkbuddyNonChatModel('m', undefined, ['text-to-image'])).toBe(true)
  })

  it('正常对话模型不误伤', () => {
    expect(isWorkbuddyNonChatModel('glm-5.2')).toBe(false)
    expect(isWorkbuddyNonChatModel('deepseek-v4-flash')).toBe(false)
    // 257 已超阈值
    expect(isWorkbuddyNonChatModel('m', 257)).toBe(false)
    // maxOutputTokens 缺失/0/负数不触发（0 表示未知，不是 tiny）
    expect(isWorkbuddyNonChatModel('m', 0)).toBe(false)
    expect(isWorkbuddyNonChatModel('m', -1)).toBe(false)
    expect(isWorkbuddyNonChatModel('m', undefined)).toBe(false)
    expect(isWorkbuddyNonChatModel('m', undefined, ['badge:限时免费'])).toBe(false)
  })

  it('前缀匹配大小写不敏感、容忍首尾空白', () => {
    expect(isWorkbuddyNonChatModel('  NES-Embed  ')).toBe(true)
    expect(isWorkbuddyNonChatModel('Completion-X')).toBe(true)
  })

  it('窄表形态下也能按 id 前缀过滤', () => {
    const raw = JSON.stringify({ code: 0, data: ['glm-5.2', 'nes-embed', 'hy3'] })
    const filtered = parseWorkbuddyGlobalModels(raw, { filterNonChat: true })
    expect(filtered!.map((e) => e.id)).toEqual(['glm-5.2', 'hy3'])
    // 不开过滤则原样返回
    expect(parseWorkbuddyGlobalModels(raw)!.map((e) => e.id)).toEqual(['glm-5.2', 'nes-embed', 'hy3'])
  })

  it('maxOutputTokens 被解析进条目（供后续过滤/展示）', () => {
    const raw = JSON.stringify({ code: 0, data: { models: [{ id: 'm', maxOutputTokens: 4096 }] } })
    expect(parseWorkbuddyGlobalModels(raw)![0].maxOutputTokens).toBe(4096)
  })
})

describe('mergeWorkbuddyModelCatalogs 合并语义', () => {
  it('主路原序在前、补缺项按原序在后（输出稳定）', () => {
    const merged = mergeWorkbuddyModelCatalogs(
      [{ id: 'a' }, { id: 'b' }],
      [{ id: 'c' }, { id: 'a' }],
    )
    expect(merged.map((e) => e.id)).toEqual(['a', 'b', 'c'])
  })

  it('同 id 保留主路条目（字段权威）', () => {
    const merged = mergeWorkbuddyModelCatalogs(
      [{ id: 'a', credits: 'x1' }],
      [{ id: 'a', credits: 'x2' }],
    )
    expect(merged).toHaveLength(1)
    expect(merged[0].credits).toBe('x1')
  })

  it('空输入与空 id 不抛错', () => {
    expect(mergeWorkbuddyModelCatalogs([], [])).toEqual([])
    expect(mergeWorkbuddyModelCatalogs([{ id: '' }], [{ id: 'a' }]).map((e) => e.id)).toEqual(['a'])
    expect(mergeWorkbuddyModelCatalogs(null as never, [{ id: 'a' }]).map((e) => e.id)).toEqual(['a'])
  })
})

describe('静态兜底清单（P1 校正）', () => {
  it('CN 清单已更新到当前世代（不再是 glm-4.5/deepseek-v3 那批）', () => {
    // 旧清单的过期项不应再出现
    expect(WORKBUDDY_MODELS).not.toContain('glm-4.5')
    expect(WORKBUDDY_MODELS).not.toContain('glm-4.6')
    expect(WORKBUDDY_MODELS).not.toContain('deepseek-v3')
    expect(WORKBUDDY_MODELS).not.toContain('qwen-3')
    expect(WORKBUDDY_MODELS).not.toContain('doubao-1.5-pro')
    // 当前世代代表项
    expect(WORKBUDDY_MODELS).toContain('glm-5.2')
    expect(WORKBUDDY_MODELS).toContain('hy3')
    expect(WORKBUDDY_MODELS).toContain('deepseek-v4-pro')
    expect(WORKBUDDY_MODELS).toContain('deepseek-v4-flash')
  })

  it('global 清单补齐 hy4-preview', () => {
    expect(WORKBUDDY_GLOBAL_MODELS).toContain('hy4-preview')
    expect(WORKBUDDY_GLOBAL_MODELS).toContain('hy4-preview-f')
  })

  it('两份清单互不相同（CN 与 global 模型集不同）', () => {
    const overlap = WORKBUDDY_MODELS.filter((m) => WORKBUDDY_GLOBAL_MODELS.includes(m))
    // 允许少量同名（如 hy3），但不应整体相同
    expect(WORKBUDDY_MODELS.length).not.toBe(WORKBUDDY_GLOBAL_MODELS.length)
    expect(overlap.length).toBeLessThan(WORKBUDDY_MODELS.length)
  })

  it('静态清单不含 nonChat 条目', () => {
    for (const id of [...WORKBUDDY_MODELS, ...WORKBUDDY_GLOBAL_MODELS]) {
      expect(isWorkbuddyNonChatModel(id)).toBe(false)
    }
  })
})
