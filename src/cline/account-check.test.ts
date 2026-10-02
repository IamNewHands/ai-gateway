import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv, Provider } from '../types'
import { probeClineAccount, testClineChat, isClineModelGone, __resetClineCatalogCacheForTests } from './proxy'
import { handleClineAccountCheck, handleClineAccountLabel, normalizeApiKeyLabel, handleTestKeyNew } from '../admin'
import { getProvider, setProviders } from '../storage'
import { renderAdminPage } from '../pages'

/** 内存 KV */
function makeEnv() {
  const map = new Map<string, string>()
  const kv = {
    get: async (k: string) => map.get(k) ?? null,
    put: async (k: string, v: string) => { map.set(k, v) },
    delete: async (k: string) => { map.delete(k) },
    list: async () => ({ keys: [] }),
  }
  return { KV: kv } as unknown as AppEnv
}

function clineProvider(apiKeys: Provider['apiKeys']): Provider {
  return {
    id: 'cline',
    name: 'Cline',
    baseUrl: 'https://api.cline.bot/api/v1',
    apiType: 'openai',
    apiKeys,
    models: [],
    enabled: true,
    createdAt: 'a',
    updatedAt: 'a',
  }
}

const RT_A = 'rt-aaaaaaaaaaaaaaaaaaaa'
const RT_B = 'rt-bbbbbbbbbbbbbbbbbbbb'

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

let realFetch: typeof globalThis.fetch

beforeEach(() => { realFetch = globalThis.fetch })
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks() })

function mountCheck(env: AppEnv) {
  const app = new Hono<AppEnv>()
  app.post('/admin/api/providers/:id/cline-accounts/check', handleClineAccountCheck)
  app.post('/admin/api/providers/:id/cline-accounts/label', handleClineAccountLabel)
  return app
}

describe('probeClineAccount：refreshToken 有效性 + 账号关联', () => {
  it('有效 token：取回 email，并回报上游轮换出的新 token', async () => {
    globalThis.fetch = (async () => jsonResp({
      data: { accessToken: 'at-1', refreshToken: 'rt-rotated-1', userInfo: { email: 'a@example.com' } },
    })) as typeof fetch

    const p = await probeClineAccount(RT_A)
    expect(p.valid).toBe(true)
    expect(p.email).toBe('a@example.com')
    expect(p.rotatedTo).toBe('rt-rotated-1')
    expect(p.message).toContain('a@example.com')
  })

  it('有效但上游没给 email：仍算有效，只是关联不到账号', async () => {
    globalThis.fetch = (async () => jsonResp({ data: { accessToken: 'at-1', refreshToken: RT_A } })) as typeof fetch
    const p = await probeClineAccount(RT_A)
    expect(p.valid).toBe(true)
    expect(p.email).toBe('')
    expect(p.rotatedTo).toBe('')
    expect(p.message).toContain('未返回账号')
  })

  it('上游 401：无效，并截断错误体', async () => {
    globalThis.fetch = (async () => new Response('{"error":"invalid_grant"}', { status: 401 })) as typeof fetch
    const p = await probeClineAccount(RT_A)
    expect(p.valid).toBe(false)
    expect(p.statusCode).toBe(401)
    expect(p.message).toContain('invalid_grant')
  })

  it('连接层失败：文案与 token 失效区分开（不诱导用户换号）', async () => {
    globalThis.fetch = (async () => { throw new Error('ECONNRESET') }) as typeof fetch
    const p = await probeClineAccount(RT_A)
    expect(p.valid).toBe(false)
    expect(p.statusCode).toBe(0)
    expect(p.message).toContain('连接 Cline 失败')
  })

  it('空/过短 token：不打上游', async () => {
    const spy = vi.fn()
    globalThis.fetch = spy as unknown as typeof fetch
    const p = await probeClineAccount('   ')
    expect(p.valid).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('POST /admin/api/providers/:id/cline-accounts/check', () => {
  it('逐个探测并自动把 email 写进 label，轮换出的 token 立即落库', async () => {
    const env = makeEnv()
    await setProviders(env as never, [clineProvider([{ key: RT_A, enabled: true }, { key: RT_B, enabled: false }])])
    globalThis.fetch = (async (_url: string, init: any) => {
      const body = JSON.parse(String(init.body))
      if (body.refreshToken === RT_A) {
        return jsonResp({ data: { accessToken: 'at-a', refreshToken: 'rt-a-rotated', userInfo: { email: 'a@example.com' } } })
      }
      return new Response('{"error":"invalid_grant"}', { status: 401 })
    }) as typeof fetch

    const app = mountCheck(env)
    const res = await app.request('/admin/api/providers/cline/cline-accounts/check', { method: 'POST' }, env as never)
    const j: any = await res.json()
    expect(j.success).toBe(true)
    const rows = j.data.accounts
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ index: 0, valid: true, email: 'a@example.com', label: 'a@example.com', labelSource: 'auto', enabled: true })
    expect(rows[1]).toMatchObject({ index: 1, valid: false, labelSource: 'none', enabled: false })
    // 绝不回传完整 refreshToken
    expect(JSON.stringify(j)).not.toContain(RT_A)
    expect(JSON.stringify(j)).not.toContain(RT_B)
    expect(rows[0].masked).toBe('****ated')

    const saved = await getProvider(env as never, 'cline')
    expect(saved!.apiKeys[0].key).toBe('rt-a-rotated')
    expect(saved!.apiKeys[0].label).toBe('a@example.com')
    expect(saved!.apiKeys[1].key).toBe(RT_B)
    expect(saved!.apiKeys[1].label).toBeUndefined()
  })

  it('手工填过的账号名不被自动关联覆盖', async () => {
    const env = makeEnv()
    await setProviders(env as never, [clineProvider([{ key: RT_A, enabled: true, label: '我的小号' }])])
    globalThis.fetch = (async () => jsonResp({ data: { accessToken: 'at', refreshToken: RT_A, userInfo: { email: 'a@example.com' } } })) as typeof fetch

    const app = mountCheck(env)
    const res = await app.request('/admin/api/providers/cline/cline-accounts/check', { method: 'POST' }, env as never)
    const j: any = await res.json()
    expect(j.data.accounts[0].label).toBe('我的小号')
    expect(j.data.accounts[0].labelSource).toBe('manual')
    const saved = await getProvider(env as never, 'cline')
    expect(saved!.apiKeys[0].label).toBe('我的小号')
  })

  it('非 Cline 提供商：拒绝', async () => {
    const env = makeEnv()
    await setProviders(env as never, [{
      id: 'deepseek', name: 'ds', baseUrl: 'https://api.deepseek.com', apiKeys: [{ key: 'sk-x', enabled: true }],
      models: [], enabled: true, createdAt: 'a', updatedAt: 'a',
    } as Provider])
    const app = mountCheck(env)
    const res = await app.request('/admin/api/providers/deepseek/cline-accounts/check', { method: 'POST' }, env as never)
    expect((await res.json() as any).success).toBe(false)
  })
})

describe('POST /admin/api/providers/:id/cline-accounts/label（手工维护口子）', () => {
  it('写入、清空、超长截断', async () => {
    const env = makeEnv()
    await setProviders(env as never, [clineProvider([{ key: RT_A, enabled: true }])])
    const app = mountCheck(env)

    let res = await app.request('/admin/api/providers/cline/cline-accounts/label', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index: 0, label: '  备用号 A  ' }),
    }, env as never)
    expect((await res.json() as any).data.label).toBe('备用号 A')
    expect((await getProvider(env as never, 'cline'))!.apiKeys[0].label).toBe('备用号 A')

    res = await app.request('/admin/api/providers/cline/cline-accounts/label', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index: 0, label: '   ' }),
    }, env as never)
    expect((await res.json() as any).data.label).toBe('')
    expect((await getProvider(env as never, 'cline'))!.apiKeys[0].label).toBeUndefined()
  })

  it('index 越界 / 非法：400 且不写库', async () => {
    const env = makeEnv()
    await setProviders(env as never, [clineProvider([{ key: RT_A, enabled: true }])])
    const app = mountCheck(env)
    const bad = await app.request('/admin/api/providers/cline/cline-accounts/label', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index: 5, label: 'x' }),
    }, env as never)
    expect(bad.status).toBe(400)
    const bad2 = await app.request('/admin/api/providers/cline/cline-accounts/label', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index: -1, label: 'x' }),
    }, env as never)
    expect(bad2.status).toBe(400)
    expect((await getProvider(env as never, 'cline'))!.apiKeys[0].label).toBeUndefined()
  })

  it('normalizeApiKeyLabel：非字符串/超长/空', () => {
    expect(normalizeApiKeyLabel(123)).toBeUndefined()
    expect(normalizeApiKeyLabel('  ')).toBeUndefined()
    expect(normalizeApiKeyLabel('x'.repeat(200))).toHaveLength(120)
  })
})

describe('单行「测试 Key」：只判 refreshToken 有效性，不拉模型列表', () => {
  it('返回 email，且不回任何模型列表（此前会顺手改写模型网格）', async () => {
    const env = makeEnv()
    await setProviders(env as never, [clineProvider([{ key: RT_A, enabled: true }])])
    globalThis.fetch = (async () => jsonResp({ data: { accessToken: 'at-1', refreshToken: RT_A, userInfo: { email: 'a@example.com' } } })) as typeof fetch

    const app = new Hono<AppEnv>()
    app.post('/admin/api/test-key', handleTestKeyNew)
    const res = await app.request('/admin/api/test-key', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://api.cline.bot/api/v1', apiKey: RT_A, providerId: 'cline', intent: 'diagnose' }),
    }, env as never)
    const j: any = await res.json()
    expect(j.data.success).toBe(true)
    expect(j.data.email).toBe('a@example.com')
    expect(j.data.data).toBeUndefined()
    expect(JSON.stringify(j)).not.toContain('"id"')
  })
})

describe('模型测试：上游报「模型不存在」时点明是上游下架，不是账号问题', () => {
  beforeEach(() => { __resetClineCatalogCacheForTests() })
  afterEach(() => { __resetClineCatalogCacheForTests() })

  function installFetch(catalogFree: string[]): void {
    globalThis.fetch = (async (url: string) => {
      const u = String(url)
      if (u.includes('/auth/refresh')) {
        return jsonResp({ data: { accessToken: 'at-1', refreshToken: RT_A } })
      }
      if (u.includes('recommended-models')) {
        return jsonResp({ free: catalogFree.map((id) => ({ id })), recommended: [], clinePass: [] })
      }
      if (u.includes('/models')) return jsonResp({ data: [] })
      if (u.includes('/chat/completions')) {
        return new Response('{"error":"model not found","success":false}', { status: 404 })
      }
      throw new Error('unexpected url ' + u)
    }) as typeof fetch
  }

  it('目录里已没有该模型 → 直说「上游已下架」并指引重新获取模型', async () => {
    installFetch(['cline-free/other-model'])
    const r = await testClineChat([RT_A], 'cline-free/gemini-3.8-flash')
    expect(r.success).toBe(false)
    expect(r.message).toContain('上游已下架')
    expect(r.message).toContain('cline-free/gemini-3.8-flash')
    expect(r.message).toMatch(/获取模型/)
    // 上游原文必须留在消息里，便于继续排查
    expect(r.message).toContain('model not found')
  })

  it('目录里还列着 → 说明是上游目录与推理端点不一致（别去换号）', async () => {
    installFetch(['cline-free/gemini-3.8-flash'])
    const r = await testClineChat([RT_A], 'cline-free/gemini-3.8-flash')
    expect(r.success).toBe(false)
    expect(r.message).toContain('目录与推理端点不一致')
    expect(r.message).not.toContain('账号')
  })

  it('isClineModelGone：只认 400/404 + 模型不存在类文案（对齐 cline2api modelGoneRe）', () => {
    expect(isClineModelGone(404, '{"error":"model not found","success":false}')).toBe(true)
    expect(isClineModelGone(400, '{"msg":"invalid model"}')).toBe(true)
    expect(isClineModelGone(404, 'Model does not exist')).toBe(true)
    // 403/402/429/500 与普通 404 文案都不算模型下架
    expect(isClineModelGone(403, 'model not found')).toBe(false)
    expect(isClineModelGone(500, 'model not found')).toBe(false)
    expect(isClineModelGone(404, '{"error":"route not found"}')).toBe(false)
  })
})

describe('Cline 面板：账号行 + 检测按钮', () => {
  async function renderHtml(env: AppEnv) {
    const app = new Hono<AppEnv>()
    app.get('/admin', (c) => renderAdminPage(c))
    const res = await app.request('/admin', {}, env as never)
    return await res.text()
  }

  it('Cline：每行有状态徽章 + 账号输入框，顶部有「检测全部账号」', async () => {
    const env = makeEnv()
    await setProviders(env as never, [clineProvider([{ key: RT_A, enabled: true, label: 'a@example.com' }])])
    const html = await renderHtml(env)
    const start = html.indexOf('id="dt-cline"')
    expect(start).toBeGreaterThan(-1)
    const panel = html.slice(start, html.indexOf('</article>', start))
    expect(panel).toContain('id="kst-cline-0"')
    expect(panel).toContain('id="klbl-cline-0"')
    expect(panel).toContain('value="a@example.com"')
    expect(panel).toContain('检测全部账号')
    expect(panel).toContain('onblur="clineSaveLabel(\'cline\',0)"')
  })

  it('Cline：token 与账号信息同处一行，窄窗口才折行（不再挤成两行）', async () => {
    const env = makeEnv()
    await setProviders(env as never, [clineProvider([{ key: RT_A, enabled: true }])])
    const html = await renderHtml(env)
    const start = html.indexOf('id="dt-cline"')
    const panel = html.slice(start, html.indexOf('</article>', start))
    // 每行只能有一个 [data-kidx]，否则 getKeys 会把同一个 token 收集两次
    expect((panel.match(/data-kidx="0"/g) || []).length).toBe(1)
    // 一个 .cline-key-row 里同时含 token 输入框、徽章与账号输入框
    const rowStart = panel.indexOf('class="fc mb-3 field-row cline-key-row"')
    expect(rowStart).toBeGreaterThan(-1)
    const row = panel.slice(rowStart, panel.indexOf('</div>', panel.indexOf('id="ktr-cline-0"')))
    expect(row).toContain('class="cline-tok"')
    expect(row).toContain('id="kst-cline-0"')
    expect(row).toContain('class="cline-lbl"')
    // 行内结果区（跑「测试」时就地显示，不再写到面板顶部）
    expect(row).toContain('id="ktr-cline-0"')
    // 不要再回到两行结构（上一版的 cline-acct-row 独立块）
    expect(panel).not.toContain('cline-acct-row')
    expect(panel).not.toContain('class="cline-key-row" data-kidx="0"><div')
  })

  it('非 Cline 提供商：不注入账号行', async () => {
    const env = makeEnv()
    await setProviders(env as never, [{
      id: 'deepseek', name: 'ds', baseUrl: 'https://api.deepseek.com',
      apiKeys: [{ key: 'sk-x', enabled: true }], models: [], enabled: true, createdAt: 'a', updatedAt: 'a',
    } as Provider])
    const html = await renderHtml(env)
    expect(html).not.toContain('id="kst-deepseek-0"')
    expect(html).not.toContain('检测全部账号')
  })
})
