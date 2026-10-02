import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv, Provider } from '../types'
import { probeClineAccount, testClineChat, isClineModelGone, __resetClineCatalogCacheForTests } from './proxy'
import { handleClineAccountCheck, handleClineAccountLabel, handleClineAccountStates, normalizeApiKeyLabel, handleTestKeyNew } from '../admin'
import { getProvider, setProviders } from '../storage'
import { maskClineToken } from './account-state'
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
const RT_ROTATED = 'rt-rotated-cccccccccccc'

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

// ===== 账号运行状态（额度耗尽 / 冷却 / 已禁用）在面板上的显示 =====
//
// 为什么要有这一组：`kst-` 徽章只回答「这条 token 能不能换 accessToken」。一个 token 完全有效、
// 但免费额度已耗尽被冷却 12 小时的账号，在旧面板上与健康账号长得一模一样——正是用户报的问题
// （2026-10-02）。这组用例钉住的是「留档 → 行字段 → 面板徽章」整条链路，而不是其中任意一段。
describe('Cline 面板：账号冷却 / 额度耗尽 / 已禁用 的状态显示', () => {
  function makeEnvWithMap() {
    const map = new Map<string, string>()
    const kv = {
      get: async (k: string) => map.get(k) ?? null,
      put: async (k: string, v: string) => { map.set(k, v) },
      delete: async (k: string) => { map.delete(k) },
      list: async () => ({ keys: [] }),
    }
    return { env: { KV: kv } as unknown as AppEnv, map }
  }

  /** 探测成功且**不轮换** token（轮换会改掩码，让留档按设计失配——那是另一个用例）。 */
  function installNoRotate(email = 'a@example.com') {
    globalThis.fetch = (async (url: string) => {
      const u = String(url)
      if (u.includes('/auth/refresh')) return jsonResp({ data: { accessToken: 'at-1', refreshToken: RT_A, userInfo: { email } } })
      throw new Error('unexpected url ' + u)
    }) as typeof fetch
  }

  const seedState = (map: Map<string, string>, state: Record<string, unknown>) => {
    map.set('cline:acctstate:cline', JSON.stringify({ states: [state] }))
  }

  it('KV 里有未到期留档 → 行字段带上冷却分类/文案/原因，summary 点数', async () => {
    const { env, map } = makeEnvWithMap()
    await setProviders(env as never, [clineProvider([{ key: RT_A, enabled: true }])])
    installNoRotate()
    seedState(map, {
      index: 0, masked: '****aaaa', kind: 'quota_empty',
      until: Date.now() + 60_000, at: Date.now(), model: null,
      reason: 'Daily free limit reached on model deepseek/deepseek-v4-flash. Try again in 23h 59m',
    })

    const res = await mountCheck(env).request('/admin/api/providers/cline/cline-accounts/check', { method: 'POST' }, env as never)
    const body = await res.json() as { success: boolean; data: { accounts: Array<Record<string, unknown>>; summary: string } }
    const row = body.data.accounts[0]
    expect(row.cooling).toBe(true)
    expect(row.stateKind).toBe('quota_empty')
    expect(String(row.stateLabel)).toContain('额度耗尽')
    // 冷却是网关禁入窗口，不是额度恢复时刻——tooltip 必须说清，否则用户会拿它当"额度啥时候回来"
    expect(String(row.stateTitle)).toContain('不代表上游额度已恢复')
    // 上游原文要留给用户看（官方 429 文案里有重置倒计时）
    expect(String(row.stateTitle)).toContain('Try again in 23h 59m')
    expect(body.data.summary).toContain('冷却中 1')
    expect(body.data.summary).toContain('额度耗尽 1')
  })

  it('留档掩码与当前 token 不符（这行换过号）→ 不认这条记录，宁可不显示也不硬套', async () => {
    const { env, map } = makeEnvWithMap()
    await setProviders(env as never, [clineProvider([{ key: RT_B, enabled: true }])])
    globalThis.fetch = (async (url: string) => {
      const u = String(url)
      if (u.includes('/auth/refresh')) return jsonResp({ data: { accessToken: 'at-1', refreshToken: RT_B } })
      throw new Error('unexpected url ' + u)
    }) as typeof fetch
    seedState(map, { index: 0, masked: '****aaaa', kind: 'quota_empty', until: Date.now() + 60_000, at: Date.now(), model: null, reason: 'x' })

    const res = await mountCheck(env).request('/admin/api/providers/cline/cline-accounts/check', { method: 'POST' }, env as never)
    const row = ((await res.json()) as { data: { accounts: Array<Record<string, unknown>> } }).data.accounts[0]
    expect(row.cooling).toBe(false)
    expect(row.stateLabel).toBe('')
  })

  it('探测时上游轮换了 refreshToken → 冷却状态跟着新凭据走，不显示成健康', async () => {
    const { env, map } = makeEnvWithMap()
    await setProviders(env as never, [clineProvider([{ key: RT_A, enabled: true }])])
    // 探测会轮换出 RT_ROTATED：同一个账号换了钥匙，冷却事实必须保留（否则面板谎报正常）
    globalThis.fetch = (async (url: string) => {
      const u = String(url)
      if (u.includes('/auth/refresh')) return jsonResp({ data: { accessToken: 'at-1', refreshToken: RT_ROTATED, userInfo: { email: 'a@example.com' } } })
      throw new Error('unexpected url ' + u)
    }) as typeof fetch
    seedState(map, { index: 0, masked: '****aaaa', kind: 'quota_empty', until: Date.now() + 600_000, at: Date.now(), model: null, reason: 'Daily free limit reached' })

    const res = await mountCheck(env).request('/admin/api/providers/cline/cline-accounts/check', { method: 'POST' }, env as never)
    const row = ((await res.json()) as { data: { accounts: Array<Record<string, unknown>> } }).data.accounts[0]
    expect(row.cooling).toBe(true)
    expect(row.stateKind).toBe('quota_empty')
    // 留档被改写为新掩码：下次读（不探测）也认得出这个账号
    const stored = JSON.parse(map.get('cline:acctstate:cline')!) as { states: Array<Record<string, unknown>> }
    expect(stored.states[0].masked).toBe(maskClineToken(RT_ROTATED))
    // 且提供商里的 token 也已落库为新值
    const saved = await getProvider(env as never, 'cline')
    expect(saved!.apiKeys![0].key).toBe(RT_ROTATED)
  })

  it('有禁用行时下标不错位：留档只落在它真正对应的那一行（池下标 ≠ apiKeys 下标）', async () => {
    const { env, map } = makeEnvWithMap()
    const RT_C = 'rt-cccccccccccccccccccc'
    // 第 1 行禁用：池里只有第 0、2 行，池下标 1 ↔ apiKeys 下标 2
    await setProviders(env as never, [clineProvider([
      { key: RT_A, enabled: true },
      { key: RT_B, enabled: false },
      { key: RT_C, enabled: true },
    ])])
    installNoRotate()
    seedState(map, {
      index: 2, masked: '****cccc', kind: 'quota_empty',
      until: Date.now() + 600_000, at: Date.now(), model: null, reason: 'Daily free limit reached',
    })

    const res = await mountCheck(env).request('/admin/api/providers/cline/cline-accounts/check', { method: 'POST' }, env as never)
    const accs = ((await res.json()) as { data: { accounts: Array<Record<string, unknown>> } }).data.accounts
    expect(accs[2].cooling).toBe(true)
    // 被禁用的中间那行不能被误标成冷却（它的掩码对不上，判据必须拦住）
    expect(accs[1].cooling).toBe(false)
    expect(accs[0].cooling).toBe(false)
    // 面板汇总只算 1 个冷却
    expect(((await (await mountCheck(env).request('/admin/api/providers/cline/cline-accounts/check', { method: 'POST' }, env as never)).json()) as { data: { summary: string } }).data.summary).toContain('冷却中 1')
  })

  it('留档已到期 → 不显示冷却（冷却一到期就必须自己消失，不靠定时清理）', async () => {
    const { env, map } = makeEnvWithMap()
    await setProviders(env as never, [clineProvider([{ key: RT_A, enabled: true }])])
    installNoRotate()
    seedState(map, { index: 0, masked: '****aaaa', kind: 'auth', until: Date.now() - 1, at: Date.now() - 600_000, model: null, reason: '旧记录' })

    const res = await mountCheck(env).request('/admin/api/providers/cline/cline-accounts/check', { method: 'POST' }, env as never)
    const row = ((await res.json()) as { data: { accounts: Array<Record<string, unknown>> } }).data.accounts[0]
    expect(row.cooling).toBe(false)
    expect(row.enabled).toBe(true)
  })

  it('面板初始渲染：每行都有运行状态徽章，已禁用的密钥当场标出「已禁用」', async () => {
    const env = makeEnv()
    await setProviders(env as never, [clineProvider([
      { key: RT_A, enabled: true },
      { key: RT_B, enabled: false },
    ])])
    const app = new Hono<AppEnv>()
    app.get('/admin', (c) => renderAdminPage(c))
    const html = await (await app.request('/admin', {}, env as never)).text()
    const start = html.indexOf('id="dt-cline"')
    const panel = html.slice(start, html.indexOf('</article>', start))
    expect(panel).toContain('id="krun-cline-0"')
    expect(panel).toContain('id="krun-cline-1"')
    // 启用开关是本地事实，不必等检测：禁用的那行直接显示徽章
    const disabledRow = panel.slice(panel.indexOf('data-kidx="1"'), panel.indexOf('data-kidx="1"') + 2500)
    expect(disabledRow).toContain('已禁用')
    // 启用的那行初始不显示任何状态（冷却状态要等检测，不能猜）
    const enabledRow = panel.slice(panel.indexOf('data-kidx="0"'), panel.indexOf('data-kidx="0"') + 2500)
    expect(enabledRow).toContain('id="krun-cline-0"')
    expect(enabledRow).toContain('display:none')
  })

  // 只读留档端点：面板展开卡片就能看到「额度耗尽被冷却」，不需要先点「检测全部账号」。
  // 关键约束是**不打上游**——把"看一眼状态"变成一次有副作用的探测是不能接受的代价。
  it('GET cline-account-states：只读 KV，返回冷却状态且完全不发上游请求', async () => {
    const { env, map } = makeEnvWithMap()
    await setProviders(env as never, [clineProvider([{ key: RT_A, enabled: true }])])
    seedState(map, {
      index: 0, masked: '****aaaa', kind: 'plan_exhausted',
      until: Date.now() + 12 * 3600_000, at: Date.now(), model: 'cline-pass/glm-5.3',
      reason: 'insufficient_credits',
    })
    // 任何上游请求都会让这条断言变红：只读端点必须一个都不发
    globalThis.fetch = (async (url: string) => { throw new Error('不应发起上游请求：' + url) }) as typeof fetch

    const app = new Hono<AppEnv>()
    app.get('/admin/api/providers/:id/cline-account-states', handleClineAccountStates)
    const res = await app.request('/admin/api/providers/cline/cline-account-states', {}, env as never)
    const body = await res.json() as { success: boolean; data: { accounts: Array<Record<string, unknown>> } }
    expect(body.success).toBe(true)
    const row = body.data.accounts[0]
    expect(row.cooling).toBe(true)
    expect(row.stateKind).toBe('plan_exhausted')
    expect(String(row.stateLabel)).toContain('余额/权益不足')
    expect(String(row.stateTitle)).toContain('cline-pass/glm-5.3')
    expect(row.enabled).toBe(true)
  })

  it('GET cline-account-states：非 Cline 提供商拒绝；掩码不符的留档被丢弃', async () => {
    const { env, map } = makeEnvWithMap()
    await setProviders(env as never, [
      clineProvider([{ key: RT_B, enabled: true }]),
      { id: 'deepseek', name: 'ds', baseUrl: 'https://api.deepseek.com', apiKeys: [], models: [], enabled: true, createdAt: 'a', updatedAt: 'a' } as Provider,
    ])
    // 留档讲的是 RT_A（****aaaa），而当前这行是 RT_B → 必须丢弃而不是硬套
    seedState(map, { index: 0, masked: '****aaaa', kind: 'quota_empty', until: Date.now() + 60_000, at: Date.now(), model: null, reason: 'x' })
    globalThis.fetch = (async (url: string) => { throw new Error('不应发起上游请求：' + url) }) as typeof fetch

    const app = new Hono<AppEnv>()
    app.get('/admin/api/providers/:id/cline-account-states', handleClineAccountStates)
    const ok = await app.request('/admin/api/providers/cline/cline-account-states', {}, env as never)
    const okRow = ((await ok.json()) as { data: { accounts: Array<Record<string, unknown>> } }).data.accounts[0]
    expect(okRow.cooling).toBe(false)

    const bad = await app.request('/admin/api/providers/deepseek/cline-account-states', {}, env as never)
    expect(bad.status).toBe(400)
    const missing = await app.request('/admin/api/providers/nope/cline-account-states', {}, env as never)
    expect(missing.status).toBe(404)
  })
})
