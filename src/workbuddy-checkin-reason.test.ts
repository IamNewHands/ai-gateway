import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { performCheckin, checkinOneAccount } from './checkin'
import { BillingError } from './workbuddy-billing'
import { writeOauthPool, readOauthPool, __resetOauthPoolRuntimeForTests } from './oauth-pool'
import { clearCache } from './storage'
import type { Env, OAuthTokenState, Provider } from './types'

const PID = 'wb-checkin-reason-test'

function makeJwt(iss: string, uid: string): string {
  const b64url = (o: unknown) => {
    const b64 = btoa(JSON.stringify(o))
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  return `${b64url({ alg: 'HS256' })}.${b64url({ iss, uid })}.sig`
}

const CN_JWT = makeJwt('https://www.codebuddy.cn', 'cn-user-reason')

function makeToken(accessToken: string): OAuthTokenState {
  return {
    access_token: accessToken,
    refresh_token: 'rt',
    expires_at: Date.now() + 2 * 60 * 60 * 1000,
    updated_at: Date.now(),
  } as OAuthTokenState
}

function makeProvider(): Provider {
  return {
    id: PID,
    name: 'WB Reason Wire',
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
      maxInFlight: 3,
    },
  } as unknown as Provider
}

function makeEnv(providers: Provider[]) {
  const store = new Map<string, string>()
  store.set('providers', JSON.stringify(providers))
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v) },
    delete: async (k: string) => { store.delete(k) },
    list: async () => ({ keys: [], list_complete: true, cursor: '' }),
  }
  return { env: { KV: kv, GATEWAY_KV: kv, RATE_LIMIT_KV: kv, SESSION_KV: kv } as unknown as Env, store }
}

describe('WorkBuddy performCheckin: already 标记传递', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('全新签到成功 → already 为 undefined，带 reward 数据', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      msg: 'ok',
      data: { credit: 50 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as any

    const res = await performCheckin('valid_tok', 'cn')
    expect(res.success).toBe(true)
    expect(res.message).toBe('签到成功')
    expect(res.already).toBeFalsy()
    expect(res.reward).toEqual({ credit: 50 })
  })

  it('业务码 10001（今天已签到）→ success=true 且 explicitly 标明 already=true', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      code: 10001,
      msg: '今天已签到',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as any

    const res = await performCheckin('valid_tok', 'cn')
    expect(res.success).toBe(true)
    expect(res.already).toBe(true)
    expect(res.message).toBe('今日已签到')
    expect(res.reward).toBeUndefined()
  })

  it('中文专属文案已签到 → success=true 且 already=true', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      code: 14001,
      msg: '今日已签到',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as any

    const res = await performCheckin('valid_tok', 'cn')
    expect(res.success).toBe(true)
    expect(res.already).toBe(true)
    expect(res.message).toBe('今日已签到')
  })

  it('普通失败（如 500）→ success=false, already=false', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      code: 9999,
      msg: 'database error',
    }), { status: 500, headers: { 'Content-Type': 'application/json' } })) as any

    const res = await performCheckin('valid_tok', 'cn')
    expect(res.success).toBe(false)
    expect(res.already).toBeFalsy()
  })
})

describe('WorkBuddy checkinOneAccount / checkinOauthPoolAccount: reason 归类已签', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    clearCache()
    __resetOauthPoolRuntimeForTests()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    clearCache()
    __resetOauthPoolRuntimeForTests()
  })

  it('状态探测未签到，但 claim 报已签到 → reason 归为 already（而非 ok），不计入 checkinCredit', async () => {
    const provider = makeProvider()
    const { env } = makeEnv([provider])
    await writeOauthPool(env, PID, [{
      uid: 'u1',
      nickname: 'U1',
      token: makeToken(CN_JWT),
      enabled: true,
      state: { credits: 100, disabled: false, until: 0, errCount: 0 },
      updatedAt: Date.now(),
    }])

    globalThis.fetch = vi.fn(async (input: any) => {
      const url = String(input)
      if (url.includes('/billing/meter/checkin-activity-status') || url.includes('/billing/meter/checkin-status')) {
        // 状态探测返回今日未签到
        return new Response(JSON.stringify({
          code: 0,
          msg: 'ok',
          data: { today_checked_in: false, active: true },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('/billing/meter/daily-checkin')) {
        // 实际 claim 报业务码 10001「今天已签到」
        return new Response(JSON.stringify({
          code: 10001,
          msg: '今天已签到',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      // 额度查询等其余请求
      return new Response(JSON.stringify({ code: 0, msg: 'ok', data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as any

    const result = await checkinOneAccount(env, provider, { interactive: true })
    expect(result.success).toBe(true)
    // 汇总理由必须是 already，不能假报 ok
    expect(result.reason).toBe('already')
    expect(result.message).toContain('已签 1')
    expect(result.accounts).toBeDefined()
    expect(result.accounts![0].reason).toBe('already')
    expect(result.accounts![0].checkinCredit).toBeUndefined()
  })

  it('全新签到成功 → reason 归为 ok，记入本次成功', async () => {
    const provider = makeProvider()
    const { env } = makeEnv([provider])
    await writeOauthPool(env, PID, [{
      uid: 'u2',
      nickname: 'U2',
      token: makeToken(CN_JWT),
      enabled: true,
      state: { credits: 100, disabled: false, until: 0, errCount: 0 },
      updatedAt: Date.now(),
    }])

    globalThis.fetch = vi.fn(async (input: any) => {
      const url = String(input)
      if (url.includes('/billing/meter/checkin-activity-status') || url.includes('/billing/meter/checkin-status')) {
        return new Response(JSON.stringify({
          code: 0,
          msg: 'ok',
          data: { today_checked_in: false, active: true },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('/billing/meter/daily-checkin')) {
        return new Response(JSON.stringify({
          code: 0,
          msg: 'ok',
          data: { credit: 100 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ code: 0, msg: 'ok', data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as any

    const result = await checkinOneAccount(env, provider, { interactive: true })
    expect(result.success).toBe(true)
    expect(result.reason).toBe('ok')
    expect(result.message).toContain('成功 1')
    expect(result.accounts![0].reason).toBe('ok')
  })

  it('池内历史乱码昵称（å¦¹）→ 用 JWT 解出的 妹 覆盖并回写（部署后无需重新登录）', async () => {
    const provider = makeProvider()
    const { env } = makeEnv([provider])
    // UTF-8 安全的 JWT 构造：btoa 直接吃中文会抛 InvalidCharacterError
    const bytes = new TextEncoder().encode(JSON.stringify({ iss: 'https://www.codebuddy.cn', uid: 'cn-user-nick', nickname: '妹' }))
    let bin = ''
    for (const b of bytes) bin += String.fromCharCode(b)
    const jwt = `eyJhbGciOiJIUzI1NiJ9.${btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.sig`

    await writeOauthPool(env, PID, [{
      uid: 'cn-user-nick',
      nickname: 'å¦¹', // 历史版本按 Latin-1 写坏的存储值
      token: makeToken(jwt),
      enabled: true,
      state: { credits: 100, disabled: false, until: 0, errCount: 0 },
      updatedAt: Date.now(),
    }])

    globalThis.fetch = vi.fn(async (input: any) => {
      const url = String(input)
      if (url.includes('/billing/meter/checkin-activity-status') || url.includes('/billing/meter/checkin-status')) {
        return new Response(JSON.stringify({
          code: 0,
          msg: 'ok',
          data: { today_checked_in: false, active: true },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('/billing/meter/daily-checkin')) {
        return new Response(JSON.stringify({ code: 10001, msg: '今天已签到' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ code: 0, msg: 'ok', data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as any

    const result = await checkinOneAccount(env, provider, { interactive: true })
    // 签到结果里的昵称来自刚解出的 JWT，而不是池内旧值
    expect(result.accounts![0].nickname).toBe('妹')
    // 关键：回写判定必须生效（旧实现 base.nickname 沿用乱码旧值 → 恒相等 → 永不修复）
    const pool = await readOauthPool(env, PID)
    expect(pool[0].nickname).toBe('妹')
  })
})
