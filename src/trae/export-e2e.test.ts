/**
 * export-e2e.test.ts — 面板「导出账号 JSON」按钮的端到端接线。
 *
 * 用户要求（2026-11-19）：导出结构必须与 `trae-accounts-2026-11-19.json` 逐字一致，
 * 字段为 access_token / refresh_token / uid / nickname / domain / expiresAt / auth_raw。
 *
 * 三处**形态换算**是重点，存储形态与样例形态不同：
 *  1. expiresAt：存储是 Unix **秒**，样例顶层是 epoch **毫秒**、`auth_raw.auth.expiresAt` 是秒；
 *  2. domain：存储是 `'trae.cn'` 短标签，样例是 `https://api.trae.cn` 基址（优先用 apiHost）；
 *  3. auth_raw：存储里**没有**这个结构（serializeAccount 只写扁平 camelCase），必须反推合成。
 *
 * 另一条硬要求：导出必须覆盖**已禁用**账号。禁用账号仍是可恢复凭据，丢掉会让
 * 「导出 → 换机器导入」丢号；而 getTraeAccounts 只回 enabled 行，不能直接复用它。
 */
import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv, Provider } from '../types'
import { setProviders, updateProvider } from '../storage'
import { handleTraeExport } from './admin'
import { saveTraeAccount } from './pool'
import type { TraeAccount } from './types'

function makeEnv() {
  const store = new Map<string, string>()
  const kv = {
    get: async (k: string, type?: string) => {
      const v = store.get(k)
      if (v === undefined) return null
      return type === 'json' ? JSON.parse(v) : v
    },
    put: async (k: string, v: string) => { store.set(k, v) },
    delete: async (k: string) => { store.delete(k) },
    list: async () => ({ keys: [], list_complete: true, cursor: '' }),
  }
  return { env: { KV: kv } as unknown as AppEnv['Bindings'], store }
}

function traeProvider(id = 'trae', over: Record<string, unknown> = {}): Provider {
  return {
    id,
    name: id,
    authType: 'api-key',
    baseUrl: 'https://api.trae.ai',
    apiKeys: [],
    models: [],
    enabled: true,
    ...over,
  } as unknown as Provider
}

/** 存储形态的账号：expiresAt 是 Unix 秒，domain 是短标签，没有 auth_raw。 */
function storedAccount(uid: string, over: Partial<TraeAccount> = {}): TraeAccount {
  return {
    uid,
    nickname: 'nick-' + uid,
    accessToken: 'at-' + uid,
    refreshToken: 'rt-' + uid,
    expiresAt: 1796274658,
    domain: 'trae.cn',
    ...over,
  }
}

function makeApp() {
  const app = new Hono<AppEnv>()
  app.get('/admin/api/trae/:id/export', handleTraeExport)
  return app
}

async function getJson(app: Hono<AppEnv>, path: string, env: AppEnv['Bindings']) {
  const res = await app.request(path, { method: 'GET' }, env as never)
  const text = await res.text()
  return { status: res.status, headers: res.headers, text, body: JSON.parse(text) as any }
}

describe('TRAE 导出账号 JSON：字段形态与样例一致', () => {
  it('顶层 snake_case + auth_raw 嵌套；expiresAt 顶层毫秒、auth_raw 内秒', async () => {
    const { env } = makeEnv()
    await setProviders(env, [traeProvider()])
    await saveTraeAccount(env, 'trae', storedAccount('u1'))
    const app = makeApp()

    const r = await getJson(app, '/admin/api/trae/trae/export', env)
    expect(r.status).toBe(200)
    expect(r.body.success).toBe(true)
    expect(Array.isArray(r.body.data)).toBe(true)
    expect(r.body.data).toHaveLength(1)

    const one = r.body.data[0]
    expect(Object.keys(one).sort()).toEqual(
      ['access_token', 'auth_raw', 'domain', 'expiresAt', 'nickname', 'refresh_token', 'uid'].sort()
    )
    expect(one.access_token).toBe('at-u1')
    expect(one.refresh_token).toBe('rt-u1')
    expect(one.uid).toBe('u1')
    expect(one.nickname).toBe('nick-u1')

    // 单位换算：顶层毫秒 = 秒 * 1000；auth_raw 内仍是秒
    expect(one.expiresAt).toBe(1796274658 * 1000)
    expect(one.auth_raw.auth.expiresAt).toBe(1796274658)

    // 基址换算：短标签 'trae.cn' → api 基址
    expect(one.domain).toBe('https://api.trae.cn')
    expect(one.auth_raw.auth.host).toBe('https://api.trae.cn')
    expect(one.auth_raw.auth.userRegion).toBe('CN')

    // 凭据回填：auth_raw 里的 token 必须与顶层一致（导入方读哪层都能用）
    expect(one.auth_raw.auth.accessToken).toBe(one.access_token)
    expect(one.auth_raw.auth.refreshToken).toBe(one.refresh_token)
    expect(one.auth_raw.account.userId).toBe('u1')
    expect(one.auth_raw.account.username).toBe('nick-u1')
  })

  it('apiHost 优先于 domain 标签（登录落盘写的就是 apiHost）', async () => {
    const { env } = makeEnv()
    await setProviders(env, [traeProvider()])
    await saveTraeAccount(env, 'trae', storedAccount('u1', { apiHost: 'https://api.trae.com.cn', domain: 'trae.cn' }))
    const app = makeApp()

    const r = await getJson(app, '/admin/api/trae/trae/export', env)
    expect(r.body.data[0].domain).toBe('https://api.trae.com.cn')
    expect(r.body.data[0].auth_raw.auth.userRegion).toBe('CN')
  })

  it('国际站标签 → api.trae.ai 且 userRegion=US', async () => {
    const { env } = makeEnv()
    await setProviders(env, [traeProvider()])
    await saveTraeAccount(env, 'trae', storedAccount('u1', { domain: 'trae.ai' }))
    const app = makeApp()

    const r = await getJson(app, '/admin/api/trae/trae/export', env)
    expect(r.body.data[0].domain).toBe('https://api.trae.ai')
    expect(r.body.data[0].auth_raw.auth.userRegion).toBe('US')
  })
})

describe('TRAE 导出账号 JSON：覆盖面与失败路径', () => {
  it('**已禁用账号也要导出**（getTraeAccounts 只回启用行，不能复用）', async () => {
    const { env } = makeEnv()
    await setProviders(env, [traeProvider()])
    await saveTraeAccount(env, 'trae', storedAccount('u1'))
    await saveTraeAccount(env, 'trae', storedAccount('u2'))

    // 人工禁用第 2 个账号
    const p = await updateProvider(env, 'trae', {})
    const apiKeys = (p?.apiKeys || []).map((k, i) => (i === 1 ? { ...k, enabled: false } : k))
    await updateProvider(env, 'trae', { apiKeys })

    const app = makeApp()
    const r = await getJson(app, '/admin/api/trae/trae/export', env)
    expect(r.body.data.map((x: any) => x.uid)).toEqual(['u1', 'u2'])
  })

  it('损坏行跳过，不拖垮整份导出', async () => {
    const { env } = makeEnv()
    await setProviders(env, [traeProvider()])
    await saveTraeAccount(env, 'trae', storedAccount('u1'))
    const p = await updateProvider(env, 'trae', {})
    await updateProvider(env, 'trae', { apiKeys: [...(p?.apiKeys || []), { key: '{ not json', enabled: true }] })

    const app = makeApp()
    const r = await getJson(app, '/admin/api/trae/trae/export', env)
    expect(r.status).toBe(200)
    expect(r.body.data.map((x: any) => x.uid)).toEqual(['u1'])
  })

  it('?download=1 → 下发 JSON 附件（带 Content-Disposition）', async () => {
    const { env } = makeEnv()
    await setProviders(env, [traeProvider()])
    await saveTraeAccount(env, 'trae', storedAccount('u1'))
    const app = makeApp()

    const r = await getJson(app, '/admin/api/trae/trae/export?download=1', env)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type') || '').toContain('application/json')
    expect(r.headers.get('content-disposition') || '').toMatch(/^attachment; filename="trae-accounts-\d{4}-\d{2}-\d{2}\.json"$/)
    // 附件体是纯数组，不是 {success,data} 包装
    const parsed = JSON.parse(r.text)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed[0].uid).toBe('u1')
  })

  it('空账号池 → 404 且 success=false（不返回空数组假装成功）', async () => {
    const { env } = makeEnv()
    await setProviders(env, [traeProvider()])
    const app = makeApp()

    const r = await getJson(app, '/admin/api/trae/trae/export', env)
    expect(r.status).toBe(404)
    expect(r.body.success).toBe(false)
    expect(String(r.body.message || '')).toContain('账号池为空')
  })

  it('非 TRAE 提供商 → 400；提供商不存在 → 404', async () => {
    const { env } = makeEnv()
    await setProviders(env, [traeProvider('other', { baseUrl: 'https://example.test' })])
    const app = makeApp()

    const bad = await getJson(app, '/admin/api/trae/other/export', env)
    expect(bad.status).toBe(400)
    expect(bad.body.success).toBe(false)

    const missing = await getJson(app, '/admin/api/trae/ghost/export', env)
    expect(missing.status).toBe(404)
  })
})
