/**
 * proxy.test.ts — ZCode 模块单元测试
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { isZcodeProvider, isZcodeAnthropic, buildZcodeHeaders, ZCODE_MODELS, ZCODE_PROVIDER_ID, zcodePreset, fetchZcodeModels } from './proxy'
import type { Provider } from '../types'

describe('ZCode 提供商判断', () => {
  it('isZcodeProvider 精确匹配', () => {
    expect(isZcodeProvider(ZCODE_PROVIDER_ID)).toBe(true)
    expect(isZcodeProvider('zcode')).toBe(true)
    expect(isZcodeProvider('trae')).toBe(false)
    expect(isZcodeProvider('opencode')).toBe(false)
    expect(isZcodeProvider('')).toBe(false)
  })

  it('isZcodeAnthropic 判断 Anthropic 协议', () => {
    const openaiProv: Provider = {
      id: 'zcode', name: 'ZCode', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      apiType: 'openai', apiKeys: [], models: [], enabled: true,
      createdAt: '', updatedAt: '',
    }
    expect(isZcodeAnthropic(openaiProv)).toBe(false)

    const anthropicProv: Provider = {
      ...openaiProv,
      apiType: 'anthropic',
      baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    }
    expect(isZcodeAnthropic(anthropicProv)).toBe(true)
  })

  it('非 zcode 的 provider 返回 false', () => {
    const traeProv: Provider = {
      id: 'trae', name: 'Trae', baseUrl: 'https://trae-api-cn.mchost.guru',
      apiType: 'openai', apiKeys: [], models: [], enabled: true,
      createdAt: '', updatedAt: '',
    }
    expect(isZcodeAnthropic(traeProv)).toBe(false)
  })
})

describe('ZCode 身份头构造', () => {
  it('buildZcodeHeaders 返回正确的身份头', () => {
    const headers = buildZcodeHeaders()
    expect(headers).toHaveProperty('User-Agent')
    expect(headers['User-Agent']).toMatch(/^ZCode\//)
    expect(headers).toHaveProperty('X-Title', 'Z Code')
    expect(headers).toHaveProperty('HTTP-Referer', 'https://zcode.z.ai')
    expect(headers).toHaveProperty('X-ZCode-Proxy', 'ai-gateway')
  })
})

describe('ZCode 模型清单', () => {
  it('ZCODE_MODELS 包含主要 GLM 模型', () => {
    expect(ZCODE_MODELS.length).toBeGreaterThan(0)
    expect(ZCODE_MODELS).toContain('glm-5.3')
    expect(ZCODE_MODELS).toContain('glm-5.2')
    expect(ZCODE_MODELS).toContain('glm-4.7')
    expect(ZCODE_MODELS).toContain('codegeex-4')
  })

  it('模型 ID 不重复', () => {
    const unique = new Set(ZCODE_MODELS)
    expect(unique.size).toBe(ZCODE_MODELS.length)
  })
})

describe('ZCode 预设模板', () => {
  it('bigmodel 预设使用 Coding Plan 端点', () => {
    const preset = zcodePreset('bigmodel')
    expect(preset.id).toBe('zcode')
    expect(preset.baseUrl).toContain('open.bigmodel.cn')
    expect(preset.baseUrl).toContain('/api/coding/paas/v4')
    expect(preset.apiType).toBe('openai')
    expect(preset.models.length).toBeGreaterThan(0)
  })

  it('zai 预设使用 Z.AI 端点', () => {
    const preset = zcodePreset('zai')
    expect(preset.id).toBe('zcode')
    expect(preset.baseUrl).toContain('api.z.ai')
    expect(preset.baseUrl).toContain('/api/coding/paas/v4')
    expect(preset.apiType).toBe('openai')
    expect(preset.models.length).toBeGreaterThan(0)
  })

  it('默认预设为 bigmodel', () => {
    const preset = zcodePreset()
    expect(preset.baseUrl).toContain('open.bigmodel.cn')
  })
})

// ===== fetchZcodeModels 动态拉取 =====

/** 构造最小 KV mock */
function makeKv(store: Map<string, string> = new Map()) {
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v) },
    delete: async (k: string) => { store.delete(k) },
  }
}

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'zcode',
    name: 'ZCode',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    apiType: 'openai',
    authType: 'api-key',
    apiKeys: [{ key: 'test-key', enabled: true }],
    models: [],
    enabled: true,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  }
}

function makeEnv(kvStore?: Map<string, string>) {
  return { KV: makeKv(kvStore) } as unknown as import('../types').Env
}

describe('fetchZcodeModels 动态模型拉取', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('上游返回标准 OpenAI 格式 → 动态拉取并写缓存', async () => {
    const store = new Map<string, string>()
    const mockResp = new Response(JSON.stringify({ data: [{ id: 'glm-5.3' }, { id: 'glm-5.2' }] }), { status: 200 })
    globalThis.fetch = vi.fn(async () => mockResp) as typeof fetch

    const r = await fetchZcodeModels(makeEnv(store), makeProvider())
    expect(r.ok).toBe(true)
    expect(r.from).toBe('dynamic')
    expect(r.models.map(m => m.id)).toEqual(['glm-5.3', 'glm-5.2'])
    // 缓存已写入
    expect(store.get('zcode:models:zcode')).toBeTruthy()
  })

  it('命中成功缓存 → 不请求上游，from=cache', async () => {
    const store = new Map<string, string>()
    store.set('zcode:models:zcode', JSON.stringify({ models: ['glm-5.3'], fetchedAt: Date.now() }))
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const r = await fetchZcodeModels(makeEnv(store), makeProvider())
    expect(r.ok).toBe(true)
    expect(r.from).toBe('cache')
    expect(r.models).toEqual([{ id: 'glm-5.3' }])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('上游失败 → 回退静态清单并写负缓存', async () => {
    const store = new Map<string, string>()
    globalThis.fetch = vi.fn(async () => new Response('{"error":{"message":"unauthorized"}}', { status: 401 })) as typeof fetch

    const r = await fetchZcodeModels(makeEnv(store), makeProvider())
    expect(r.ok).toBe(false)
    expect(r.from).toBe('static')
    expect(r.models.map(m => m.id)).toEqual(ZCODE_MODELS)
    // 负缓存已写入
    expect(store.get('zcode:models:zcode')).toBeTruthy()
  })

  it('命中失败负缓存 → 直接回退静态，不请求上游', async () => {
    const store = new Map<string, string>()
    store.set('zcode:models:zcode', JSON.stringify({ failAt: Date.now() }))
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const r = await fetchZcodeModels(makeEnv(store), makeProvider())
    expect(r.from).toBe('static')
    expect(r.models.map(m => m.id)).toEqual(ZCODE_MODELS)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('无启用 Key → 不请求上游，回退静态', async () => {
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const r = await fetchZcodeModels(makeEnv(), makeProvider({ apiKeys: [] }))
    expect(r.ok).toBe(false)
    expect(r.from).toBe('static')
    expect(r.models.map(m => m.id)).toEqual(ZCODE_MODELS)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('上游返回裸数组格式也能解析', async () => {
    const mockResp = new Response(JSON.stringify([{ id: 'glm-5.3' }, { id: 'glm-5.2' }]), { status: 200 })
    globalThis.fetch = vi.fn(async () => mockResp) as typeof fetch

    const r = await fetchZcodeModels(makeEnv(), makeProvider())
    expect(r.ok).toBe(true)
    expect(r.from).toBe('dynamic')
    expect(r.models.length).toBe(2)
  })
})