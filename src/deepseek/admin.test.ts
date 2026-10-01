/**
 * deepseek/admin.test.ts — 管理接口：注入/判活/删除/池状态。
 *
 * 走真实 Hono 路由段 + 内存 KV，fetch 用 stub 顶替上游（判活打的是 users/current）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv, Provider } from '../types'
import { setProviders } from '../storage'
import { readDeepseekPool, resetDeepseekRotatorForTest, parkDeepseekToken } from './pool'
import {
  handleDeepseekTokenAdd,
  handleDeepseekTokenRemove,
  handleDeepseekTokenUnpark,
  handleDeepseekTokenVerify,
  handleDeepseekTokensList,
} from './admin'

const PROVIDER_ID = 'deepseek-app'
const VALID_TOKEN = 'x'.repeat(64)

function makeEnv() {
  const map = new Map<string, string>()
  const kv = {
    get: async (k: string) => map.get(k) ?? null,
    put: async (k: string, v: string) => {
      map.set(k, v)
    },
    delete: async (k: string) => {
      map.delete(k)
    },
  }
  return { KV: kv } as unknown as AppEnv['Bindings']
}

function provider(id = PROVIDER_ID): Provider {
  return {
    id,
    name: 'DeepSeek App',
    baseUrl: 'https://chat.deepseek.com',
    apiType: 'openai',
    apiKeys: [],
    models: [{ id: 'deepseek-flash', enabled: true }],
    enabled: true,
    createdAt: 'a',
    updatedAt: 'a',
  }
}

function buildApp() {
  const app = new Hono<AppEnv>()
  app.get('/admin/api/deepseek/:id/tokens', handleDeepseekTokensList)
  app.post('/admin/api/deepseek/:id/tokens', handleDeepseekTokenAdd)
  app.post('/admin/api/deepseek/:id/tokens/verify', handleDeepseekTokenVerify)
  app.post('/admin/api/deepseek/:id/tokens/remove', handleDeepseekTokenRemove)
  app.post('/admin/api/deepseek/:id/tokens/unpark', handleDeepseekTokenUnpark)
  return app
}

const envelope = (bizData: unknown, code = 0, msg = '', bizCode = 0) =>
  JSON.stringify({ code, msg, data: { biz_code: bizCode, biz_msg: bizCode ? msg : '', biz_data: bizData } })

/** 判活命中 users/current：默认返回可用账号。 */
function stubUpstream(handler: () => Response) {
  vi.stubGlobal('fetch', async () => handler())
}

const usableAccount = () =>
  new Response(
    envelope({ id: 'u-1', token: VALID_TOKEN, mobile_number: '131******48', is_mainland: true, chat: { is_muted: 0 } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )

const expiredAccount = () =>
  new Response(envelope(null, 40003, 'Authorization Failed (invalid token)'), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

async function seed(env: AppEnv['Bindings'], providers: Provider[]) {
  await setProviders(env as never, providers)
}

beforeEach(() => {
  resetDeepseekRotatorForTest()
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetDeepseekRotatorForTest()
})

const post = (app: Hono<AppEnv>, path: string, env: AppEnv['Bindings'], body?: unknown) =>
  app.request(path, body === undefined ? { method: 'POST' } : { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }, env as never)

describe('token list', () => {
  it('reports an empty pool with the how-to and a notice', async () => {
    const env = makeEnv()
    await seed(env, [provider()])
    const res = await buildApp().request(`/admin/api/deepseek/${PROVIDER_ID}/tokens`, {}, env as never)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, any>
    expect(body.success).toBe(true)
    expect(body.data.summary.total).toBe(0)
    expect(body.data.howto).toContain('chat.deepseek.com')
    expect(body.data.notice).toContain('池是空的')
  })

  it('404s for an unknown provider', async () => {
    const env = makeEnv()
    await seed(env, [provider()])
    const res = await buildApp().request('/admin/api/deepseek/nope/tokens', {}, env as never)
    expect(res.status).toBe(404)
  })
})

describe('token add', () => {
  it('rejects a missing or implausibly short token with the how-to', async () => {
    const env = makeEnv()
    await seed(env, [provider()])
    const app = buildApp()

    const missing = await post(app, `/admin/api/deepseek/${PROVIDER_ID}/tokens`, env, {})
    expect(missing.status).toBe(400)
    expect(((await missing.json()) as Record<string, any>).message).toContain('userToken')

    const short = await post(app, `/admin/api/deepseek/${PROVIDER_ID}/tokens`, env, { token: 'abc' })
    expect(short.status).toBe(400)
    expect(((await short.json()) as Record<string, any>).message).toContain('64 字符')
  })

  it('accepts the raw localStorage wrapper and verifies before storing', async () => {
    const env = makeEnv()
    await seed(env, [provider()])
    stubUpstream(usableAccount)

    const res = await post(buildApp(), `/admin/api/deepseek/${PROVIDER_ID}/tokens`, env, {
      token: JSON.stringify({ value: VALID_TOKEN, __version: '1' }),
      headerDeviceId: 'dev-uuid',
      label: '主号',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, any>
    expect(body.success).toBe(true)
    expect(body.data.verified).toBe(true)
    expect(body.data.state).toBe('ready')

    const stored = await readDeepseekPool(env as never)
    expect(stored).toHaveLength(1)
    expect(stored[0].token).toBe(VALID_TOKEN)
    expect(stored[0].label).toBe('主号')
    expect(stored[0].state).toBe('ready')
  })

  it('stores a failing token as expired and says so (no silent degradation)', async () => {
    const env = makeEnv()
    await seed(env, [provider()])
    stubUpstream(expiredAccount)

    const res = await post(buildApp(), `/admin/api/deepseek/${PROVIDER_ID}/tokens`, env, {
      token: VALID_TOKEN,
      headerDeviceId: 'dev-uuid',
    })
    const body = (await res.json()) as Record<string, any>
    expect(body.success).toBe(false)
    expect(body.message).toContain('判活失败')

    const stored = await readDeepseekPool(env as never)
    expect(stored[0].state).toBe('expired')
    expect(stored[0].lastError).toContain('invalid token')
  })

  it('409s a duplicate token', async () => {
    const env = makeEnv()
    await seed(env, [provider()])
    stubUpstream(usableAccount)
    const app = buildApp()
    await post(app, `/admin/api/deepseek/${PROVIDER_ID}/tokens`, env, { token: VALID_TOKEN, headerDeviceId: 'd' })
    const dup = await post(app, `/admin/api/deepseek/${PROVIDER_ID}/tokens`, env, { token: VALID_TOKEN, headerDeviceId: 'd' })
    expect(dup.status).toBe(409)
    expect(((await dup.json()) as Record<string, any>).message).toContain('已经在池里')
  })

  it('never echoes the full token in the list view', async () => {
    const env = makeEnv()
    await seed(env, [provider()])
    stubUpstream(usableAccount)
    const app = buildApp()
    await post(app, `/admin/api/deepseek/${PROVIDER_ID}/tokens`, env, { token: VALID_TOKEN, headerDeviceId: 'd' })

    const res = await app.request(`/admin/api/deepseek/${PROVIDER_ID}/tokens`, {}, env as never)
    const text = await res.text()
    expect(text).not.toContain(VALID_TOKEN)
    expect(text).toContain(VALID_TOKEN.slice(-6))
  })
})

describe('verify / remove', () => {
  it('re-verifies an existing token and flips it to expired when it died', async () => {
    const env = makeEnv()
    await seed(env, [provider()])
    stubUpstream(usableAccount)
    const app = buildApp()
    await post(app, `/admin/api/deepseek/${PROVIDER_ID}/tokens`, env, { token: VALID_TOKEN, headerDeviceId: 'd' })
    const id = (await readDeepseekPool(env as never))[0].id

    stubUpstream(expiredAccount)
    const res = await post(app, `/admin/api/deepseek/${PROVIDER_ID}/tokens/verify`, env, { tokenId: id })
    const body = (await res.json()) as Record<string, any>
    expect(body.success).toBe(false)
    expect(body.data.state).toBe('expired')
    expect((await readDeepseekPool(env as never))[0].state).toBe('expired')
  })

  it('validates ids and reports misses', async () => {
    const env = makeEnv()
    await seed(env, [provider()])
    const app = buildApp()
    expect((await post(app, `/admin/api/deepseek/${PROVIDER_ID}/tokens/verify`, env, {})).status).toBe(400)
    expect((await post(app, `/admin/api/deepseek/${PROVIDER_ID}/tokens/verify`, env, { tokenId: 'nope' })).status).toBe(404)
    expect((await post(app, `/admin/api/deepseek/${PROVIDER_ID}/tokens/remove`, env, {})).status).toBe(400)
    expect((await post(app, `/admin/api/deepseek/${PROVIDER_ID}/tokens/remove`, env, { tokenId: 'nope' })).status).toBe(404)
  })

  it('removes a token and leaves the pool empty', async () => {
    const env = makeEnv()
    await seed(env, [provider()])
    stubUpstream(usableAccount)
    const app = buildApp()
    await post(app, `/admin/api/deepseek/${PROVIDER_ID}/tokens`, env, { token: VALID_TOKEN, headerDeviceId: 'd' })
    const id = (await readDeepseekPool(env as never))[0].id

    const res = await post(app, `/admin/api/deepseek/${PROVIDER_ID}/tokens/remove`, env, { tokenId: id })
    expect(res.status).toBe(200)
    expect(await readDeepseekPool(env as never)).toHaveLength(0)
  })
})

/**
 * 处罚 park 在管理面上的可见性与人工解除。
 *
 * 为什么需要「解除停用」这个入口：封禁是**永久** park，只有人工能解除。没有它时
 * 唯一出路是删掉再重新注入（要回浏览器重取凭据），对一个「账号可能已经解封」的
 * 场景代价过高。
 */
describe('处罚 park 的面板可见性与人工解除', () => {
  async function seedParked(park: { kind: 'banned' | 'muted' | 'risk'; until?: number; reason: string }) {
    const env = makeEnv()
    await seed(env, [provider()])
    stubUpstream(usableAccount)
    await post(buildApp(), `/admin/api/deepseek/${PROVIDER_ID}/tokens`, env, { token: VALID_TOKEN, headerDeviceId: 'd' })
    const id = (await readDeepseekPool(env as never))[0].id
    await parkDeepseekToken(env as never, id, { ...park, at: Date.now() })
    return { env, id }
  }

  it('列表把 park 的 token 标出来，并给出对应 notice 与 summary.parked', async () => {
    const { env } = await seedParked({ kind: 'banned', reason: 'USER_IS_BANNED' })
    const res = await buildApp().request(`/admin/api/deepseek/${PROVIDER_ID}/tokens`, {}, env as never)
    const body = (await res.json()) as Record<string, any>

    expect(body.data.summary.parked).toBe(1)
    // 全池被停用时必须明说「当前无可用账号」，否则用户只看到随机失败
    expect(body.data.notice).toContain('全部被上游处罚停用')
    expect(body.data.tokens[0].parked).toBe(true)
    expect(body.data.tokens[0].park.kind).toBe('banned')
    expect(body.data.tokens[0].park.reason).toBe('USER_IS_BANNED')
  })

  it('部分被 park 时 notice 说明「到期会自动恢复」', async () => {
    const env = makeEnv()
    await seed(env, [provider()])
    stubUpstream(usableAccount)
    const app = buildApp()
    await post(app, `/admin/api/deepseek/${PROVIDER_ID}/tokens`, env, { token: VALID_TOKEN, headerDeviceId: 'd1' })
    await post(app, `/admin/api/deepseek/${PROVIDER_ID}/tokens`, env, { token: 'y'.repeat(64), headerDeviceId: 'd2' })
    const list = await readDeepseekPool(env as never)
    await parkDeepseekToken(env as never, list[0].id, {
      kind: 'muted', until: Date.now() + 3600_000, reason: 'muted', at: Date.now(),
    })

    const res = await app.request(`/admin/api/deepseek/${PROVIDER_ID}/tokens`, {}, env as never)
    const body = (await res.json()) as Record<string, any>
    expect(body.data.summary.parked).toBe(1)
    expect(body.data.summary.ready).toBe(1)
    expect(body.data.notice).toContain('到期会自动恢复')
  })

  it('已过期的 park 不算 parked（自然解禁后界面立刻恢复）', async () => {
    const { env } = await seedParked({ kind: 'muted', until: Date.now() - 1000, reason: 'stale' })
    const res = await buildApp().request(`/admin/api/deepseek/${PROVIDER_ID}/tokens`, {}, env as never)
    const body = (await res.json()) as Record<string, any>
    expect(body.data.summary.parked).toBe(0)
    expect(body.data.tokens[0].parked).toBe(false)
    expect(body.data.notice).toBe('')
  })

  it('unpark 清掉处罚并回报原处罚种类（建议复核）', async () => {
    const { env, id } = await seedParked({ kind: 'banned', reason: 'USER_IS_BANNED' })
    const res = await post(buildApp(), `/admin/api/deepseek/${PROVIDER_ID}/tokens/unpark`, env, { tokenId: id })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, any>
    expect(body.success).toBe(true)
    expect(body.data.releasedKind).toBe('banned')
    expect(body.message).toContain('判活')

    expect((await readDeepseekPool(env as never))[0].park).toBeUndefined()
  })

  it('unpark 幂等：本来没 park 也成功，且明确告知', async () => {
    const env = makeEnv()
    await seed(env, [provider()])
    stubUpstream(usableAccount)
    await post(buildApp(), `/admin/api/deepseek/${PROVIDER_ID}/tokens`, env, { token: VALID_TOKEN, headerDeviceId: 'd' })
    const id = (await readDeepseekPool(env as never))[0].id

    const res = await post(buildApp(), `/admin/api/deepseek/${PROVIDER_ID}/tokens/unpark`, env, { tokenId: id })
    const body = (await res.json()) as Record<string, any>
    expect(body.success).toBe(true)
    expect(body.data.releasedKind).toBeNull()
    expect(body.message).toContain('本来就没有')
  })

  it('unpark 校验参数：缺 tokenId 400，未知 id 404', async () => {
    const env = makeEnv()
    await seed(env, [provider()])
    const app = buildApp()
    expect((await post(app, `/admin/api/deepseek/${PROVIDER_ID}/tokens/unpark`, env, {})).status).toBe(400)
    expect((await post(app, `/admin/api/deepseek/${PROVIDER_ID}/tokens/unpark`, env, { tokenId: 'nope' })).status).toBe(404)
  })
})
