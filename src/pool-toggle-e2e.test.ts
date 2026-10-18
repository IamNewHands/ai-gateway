/**
 * pool-toggle-e2e.test.ts — 面板「禁用/启用」按钮的端到端接线（WorkBuddy 国内/国际 + Qoder + TRAE）。
 *
 * 背景（2026-10-18 用户报）：账号被判死后只能「移除 + 重新登录」，用户要能自己把单个账号
 * 停用/放回。关键语义是**人工停用与自动判死分开**：
 *   - 人工停用写顶层 enabled=false（任何自动路径都不写它）→ 签到成功也不会被偷偷放回来；
 *   - 自动判死写 state.disabled → 签到/额度探测成功即可解冻；
 *   - 「启用」顺带清自动禁用与冷却，否则面板仍显示「已禁用」，按钮看起来没生效。
 */
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv, Provider } from './types'
import { setProviders, updateProvider } from './storage'
import { handleOAuthPoolToggle } from './admin'
import { handleTraeAccountToggle } from './trae/admin'
import { readOauthPool } from './oauth-pool'
import { writeQoderPool, readQoderPool, type QoderPoolAccount } from './qoder/pool'
import {
  disableTraeAccount,
  getTraeAccounts,
  readTraePool,
  reenableTraeIfCredits,
  saveTraeAccount,
} from './trae/pool'
import type { TraeAccount } from './trae/types'
import { OAUTH_POOL_KV_PREFIX } from './oauth'

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

/** WorkBuddy 池账号（token 内容与断言无关，只占位）。 */
function wbAccount(uid: string, state: Record<string, unknown> = {}) {
  return {
    uid,
    token: { access_token: 'at-' + uid, refresh_token: 'rt-' + uid, expires_at: 0, updated_at: 0 },
    enabled: true,
    state: { credits: 100, disabled: false, until: 0, errCount: 0, ...state },
    updatedAt: 0,
  }
}

function oauthProvider(id: string, over: Record<string, unknown> = {}): Provider {
  return {
    id,
    name: id,
    authType: 'oauth-device',
    baseUrl: 'https://example.test',
    // flowType 'browser' = WorkBuddy 的 oauth 池（与 prefer-e2e 里的 wb provider 同形）
    oauth: { flowType: 'browser' },
    apiKeys: [],
    models: [],
    enabled: true,
    ...over,
  } as unknown as Provider
}

function qoderPoolAccount(uid: string): QoderPoolAccount {
  return {
    uid,
    nickname: uid,
    token: { access_token: 'dt-' + uid, refresh_token: 'drt-' + uid, expires_at: Date.now() + 86400000, updated_at: 0 },
    enabled: true,
    state: { credits: 100, disabled: false, until: 0, errCount: 0 },
    updatedAt: 0,
    realm: 'cn',
  }
}

function traeAccount(uid: string): TraeAccount {
  return {
    uid,
    nickname: uid,
    accessToken: 'at-' + uid,
    refreshToken: 'rt-' + uid,
    expiresAt: Math.floor(Date.now() / 1000) + 86400,
  }
}

function makeApp() {
  const app = new Hono<AppEnv>()
  app.post('/admin/api/oauth/:id/pool/toggle', handleOAuthPoolToggle)
  app.post('/admin/api/trae/:id/account/toggle', handleTraeAccountToggle)
  return app
}

async function call(app: Hono<AppEnv>, path: string, init: RequestInit, env: AppEnv['Bindings']) {
  const res = await app.request(path, init, env as never)
  return { status: res.status, body: (await res.json()) as { success: boolean; message?: string } }
}

const post = (payload: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
})

describe('池账号人工禁用/启用：WorkBuddy 与 Qoder 共用一个端点', () => {
  it('WorkBuddy：禁用写 enabled=false，启用清掉自动禁用与冷却', async () => {
    const { env, store } = makeEnv()
    store.set(OAUTH_POOL_KV_PREFIX + 'wb', JSON.stringify([wbAccount('u1')]))
    await setProviders(env, [oauthProvider('wb')])
    const app = makeApp()

    let r = await call(app, '/admin/api/oauth/wb/pool/toggle', post({ uid: 'u1', enabled: false }), env)
    expect(r.status).toBe(200)
    expect(r.body.success).toBe(true)
    let pool = await readOauthPool(env, 'wb')
    expect(pool[0].enabled).toBe(false)
    // 自动路径绝不碰 enabled：签到解冻只能清 state.disabled
    expect(pool[0].state.disabled).toBe(false)

    // 先制造「自动判死」再启用：两个标记都要被清掉
    pool[0].state = { ...pool[0].state, disabled: true, reason: 'session dead (401/403)', until: Date.now() + 60000, errCount: 3 }
    r = await call(app, '/admin/api/oauth/wb/pool/toggle', post({ uid: 'u1', enabled: true }), env)
    expect(r.status).toBe(200)
    pool = await readOauthPool(env, 'wb')
    expect(pool[0].enabled).toBe(true)
    expect(pool[0].state.disabled).toBe(false)
    expect(pool[0].state.reason).toBe('')
    expect(pool[0].state.until).toBe(0)
    expect(pool[0].state.errCount).toBe(0)
  })

  it('Qoder：同一个端点按 isQoderFlow 分流到 Qoder 池', async () => {
    const { env } = makeEnv()
    await writeQoderPool(env, 'qoder', [qoderPoolAccount('q1')])
    await setProviders(env, [oauthProvider('qoder', { oauth: { flowType: 'qoder' } })])
    const app = makeApp()

    const r = await call(app, '/admin/api/oauth/qoder/pool/toggle', post({ uid: 'q1', enabled: false }), env)
    expect(r.status).toBe(200)
    const pool = await readQoderPool(env, 'qoder')
    expect(pool[0].enabled).toBe(false)
  })

  it('缺少 uid / enabled 参数 → 400；账号不存在 → 404', async () => {
    const { env, store } = makeEnv()
    store.set(OAUTH_POOL_KV_PREFIX + 'wb', JSON.stringify([wbAccount('u1')]))
    await setProviders(env, [oauthProvider('wb')])
    const app = makeApp()

    // 空 body：缺 uid
    let r = await call(app, '/admin/api/oauth/wb/pool/toggle', post({}), env)
    expect(r.status).toBe(400)
    // 有 uid 没 enabled：不得默认启用（失败安全）
    r = await call(app, '/admin/api/oauth/wb/pool/toggle', post({ uid: 'u1' }), env)
    expect(r.status).toBe(400)
    r = await call(app, '/admin/api/oauth/wb/pool/toggle', post({ uid: 'u1', enabled: false }), env)
    expect(r.status).toBe(200)

    const { env: env2 } = makeEnv()
    await setProviders(env2, [oauthProvider('wb')])
    const app2 = makeApp()
    const miss = await call(app2, '/admin/api/oauth/wb/pool/toggle', post({ uid: 'ghost', enabled: false }), env2)
    expect(miss.status).toBe(404)
  })
})

describe('TRAE：人工禁用写在 apiKeys 行 enabled=false，与自动判死正交', () => {
  it('端点禁用后 getTraeAccounts 不再返回该账号；启用清掉池里的自动禁用', async () => {
    const { env } = makeEnv()
    await setProviders(env, [oauthProvider('trae')])
    await saveTraeAccount(env, 'trae', traeAccount('user_a'))
    const app = makeApp()

    let r = await call(app, '/admin/api/trae/trae/account/toggle', post({ uid: 'user_a', enabled: false }), env)
    expect(r.status).toBe(200)
    let p = await updateProvider(env, 'trae', {})
    expect(p?.apiKeys?.[0].enabled).toBe(false)
    expect(getTraeAccounts(p as unknown as Provider)).toHaveLength(0)

    await disableTraeAccount(env, 'trae', 'user_a', 'session dead (401/403)')
    expect((await readTraePool(env, 'trae'))['user_a'].disabled).toBe(true)

    r = await call(app, '/admin/api/trae/trae/account/toggle', post({ uid: 'user_a', enabled: true }), env)
    expect(r.status).toBe(200)
    p = await updateProvider(env, 'trae', {})
    expect(p?.apiKeys?.[0].enabled).toBe(true)
    expect(getTraeAccounts(p as unknown as Provider).map((a) => a.uid)).toEqual(['user_a'])
    expect((await readTraePool(env, 'trae'))['user_a'].disabled).toBe(false)
  })

  it('reenableTraeIfCredits：unfreeze=false（批量积分刷新）不解冻，true（签到）解冻', async () => {
    const { env } = makeEnv()
    await setProviders(env, [oauthProvider('trae')])
    await saveTraeAccount(env, 'trae', traeAccount('user_a'))
    await disableTraeAccount(env, 'trae', 'user_a', 'session dead (401/403)')

    await reenableTraeIfCredits(env, 'trae', 'user_a', 10, 10, false)
    let st = (await readTraePool(env, 'trae'))['user_a']
    expect(st.disabled).toBe(true)
    expect(st.credits).toBe(10) // 积分照写，只是不解冻

    await reenableTraeIfCredits(env, 'trae', 'user_a', 20, 20, true)
    st = (await readTraePool(env, 'trae'))['user_a']
    expect(st.disabled).toBe(false)
    expect(st.reason).toBe('')
    expect(st.credits).toBe(20)
    expect(st.workCredits).toBe(20)
  })
})
