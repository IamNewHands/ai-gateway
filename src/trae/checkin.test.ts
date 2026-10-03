import { describe, it, expect, vi, afterEach } from 'vitest'
import { isAlreadyTraeCheckin } from './upstream'
import { checkinTraeAccount } from './admin'
import type { Env, Provider } from '../types'
import type { TraeAccount } from './types'

const dummyProvider: Provider = {
  id: 'trae-test',
  name: 'Trae Test',
  authType: 'oauth-device',
  baseUrl: 'https://api.trae.ai',
  apiKeys: [],
  models: [],
  enabled: true,
} as unknown as Provider

const dummyAccount: TraeAccount = {
  uid: 'u_test_1',
  nickname: 'TestUser',
  accessToken: 'tok_test',
  refreshToken: 'ref_test',
  expiresAt: Date.now() + 3600000,
  deviceId: 'dev_test_123',
}

function makeMockEnv() {
  const store = new Map<string, string>()
  const kv = {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v) }),
    delete: vi.fn(async (k: string) => { store.delete(k) }),
  }
  return { KV: kv } as unknown as Env
}

describe('isAlreadyTraeCheckin 幂等错误判定规则', () => {
  it('传输层/网络层错误直接排除，绝不误判为已签到', () => {
    const err = new Error('request failed: fetch failed')
    ;(err as any).kind = 'transport'
    expect(isAlreadyTraeCheckin(err)).toBe(false)
  })

  it('HTTP 非 200 响应直接排除，即使 body 包含 already 等词', () => {
    const err = new Error('upstream server_error (http 500): request already running')
    ;(err as any).status = 500
    expect(isAlreadyTraeCheckin(err)).toBe(false)
  })

  it('英文短词 already 在裸错误中文案中不误判（如 address already in use）', () => {
    expect(isAlreadyTraeCheckin(new Error('bind EADDRINUSE: address already in use'))).toBe(false)
    expect(isAlreadyTraeCheckin(new Error('session already closed'))).toBe(false)
  })

  it('泛词「今日」不误判（如今日限流、今日服务维护）', () => {
    expect(isAlreadyTraeCheckin(new Error('今日请求频次超限'))).toBe(false)
    expect(isAlreadyTraeCheckin(new Error('今日服务正在升级维护中'))).toBe(false)
  })

  it('业务码 9095 命中幂等判定', () => {
    expect(isAlreadyTraeCheckin(new Error('code=9095 msg=今日已签到'))).toBe(true)
  })

  it('中文专属签到文案命中幂等判定', () => {
    expect(isAlreadyTraeCheckin(new Error('用户今天已签到'))).toBe(true)
    expect(isAlreadyTraeCheckin(new Error('今日已签到，请明日再来'))).toBe(true)
    expect(isAlreadyTraeCheckin(new Error('已经签到'))).toBe(true)
    expect(isAlreadyTraeCheckin(new Error('请勿重复签到'))).toBe(true)
  })

  it('null/undefined 返回 false', () => {
    expect(isAlreadyTraeCheckin(null)).toBe(false)
    expect(isAlreadyTraeCheckin(undefined)).toBe(false)
  })
})

describe('checkinTraeAccount 端到端行为', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('状态探测已签到（checkedIn: true）→ 直接返回今日已签到，不调用 claim', async () => {
    let claimCalled = false
    globalThis.fetch = vi.fn(async (input: any) => {
      const url = String(input)
      if (url.includes('/status')) {
        return new Response(JSON.stringify({ code: 0, checked_in: true, enable: true, credits: 100 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.includes('/claim')) {
        claimCalled = true
        return new Response(JSON.stringify({ code: 0 }), { status: 200 })
      }
      return new Response(JSON.stringify({ user_entitlement_pack_list: [] }), { status: 200 })
    }) as any

    const res = await checkinTraeAccount(makeMockEnv(), dummyProvider, dummyAccount)
    expect(res.success).toBe(true)
    expect(res.checkedIn).toBe(true)
    expect(res.message).toBe('今日已签到')
    expect(claimCalled).toBe(false)
  })

  it('未签到且 claim 成功（后置 status 为 true）→ 报「签到成功」', async () => {
    let statusCallCount = 0
    globalThis.fetch = vi.fn(async (input: any) => {
      const url = String(input)
      if (url.includes('/status')) {
        statusCallCount++
        return new Response(JSON.stringify({
          code: 0,
          checked_in: statusCallCount > 1, // 第一次 false，后置校验为 true
          enable: true,
          credits: 100,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('/claim')) {
        return new Response(JSON.stringify({ code: 0, msg: 'ok' }), { status: 200 })
      }
      return new Response(JSON.stringify({ user_entitlement_pack_list: [] }), { status: 200 })
    }) as any

    const res = await checkinTraeAccount(makeMockEnv(), dummyProvider, dummyAccount)
    expect(res.success).toBe(true)
    expect(res.checkedIn).toBe(true)
    expect(res.message).toBe('签到成功')
  })

  it('claim 遇到 9095（设备今日已签）且后置 status 为 true → 报「今日已签到」', async () => {
    let statusCallCount = 0
    globalThis.fetch = vi.fn(async (input: any) => {
      const url = String(input)
      if (url.includes('/status')) {
        statusCallCount++
        return new Response(JSON.stringify({
          code: 0,
          checked_in: statusCallCount > 1,
          enable: true,
          credits: 100,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('/claim')) {
        // 返回 9095
        return new Response(JSON.stringify({ code: 9095, msg: 'already checked in on device' }), { status: 200 })
      }
      return new Response(JSON.stringify({ user_entitlement_pack_list: [] }), { status: 200 })
    }) as any

    const res = await checkinTraeAccount(makeMockEnv(), dummyProvider, dummyAccount)
    expect(res.success).toBe(true)
    expect(res.checkedIn).toBe(true)
    expect(res.message).toBe('今日已签到')
  })

  it('claim 抛出 HTTP 500 且 body 包含 "already" → 绝不误报成功，如实报失败', async () => {
    globalThis.fetch = vi.fn(async (input: any) => {
      const url = String(input)
      if (url.includes('/status')) {
        return new Response(JSON.stringify({ code: 0, checked_in: false, enable: true, credits: 100 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.includes('/claim')) {
        return new Response('internal error: transaction already aborted', { status: 500 })
      }
      return new Response(JSON.stringify({ user_entitlement_pack_list: [] }), { status: 200 })
    }) as any

    const res = await checkinTraeAccount(makeMockEnv(), dummyProvider, dummyAccount)
    expect(res.success).toBe(false)
    expect(res.checkedIn).toBe(false)
    expect(res.message).toContain('签到失败')
    expect(res.message).not.toBe('今日已签到')
  })

  it('claim 抛出网络传输层错误 → 绝不误报成功，如实报失败', async () => {
    globalThis.fetch = vi.fn(async (input: any) => {
      const url = String(input)
      if (url.includes('/status')) {
        return new Response(JSON.stringify({ code: 0, checked_in: false, enable: true, credits: 100 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.includes('/claim')) {
        throw new TypeError('Failed to fetch: connection reset')
      }
      return new Response(JSON.stringify({ user_entitlement_pack_list: [] }), { status: 200 })
    }) as any

    const res = await checkinTraeAccount(makeMockEnv(), dummyProvider, dummyAccount)
    expect(res.success).toBe(false)
    expect(res.checkedIn).toBe(false)
    expect(res.message).toContain('签到失败')
  })

  it('claim 错误文案含已签到，但后置 status 查出来 checked_in 仍为 false → 不误报成功', async () => {
    globalThis.fetch = vi.fn(async (input: any) => {
      const url = String(input)
      if (url.includes('/status')) {
        // 恒为 false
        return new Response(JSON.stringify({ code: 0, checked_in: false, enable: true, credits: 100 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.includes('/claim')) {
        // 返回包含已签到但可能是模拟/伪造的业务错误
        return new Response(JSON.stringify({ code: 12345, msg: '今天已签到(但服务端状态其实未改)' }), { status: 200 })
      }
      return new Response(JSON.stringify({ user_entitlement_pack_list: [] }), { status: 200 })
    }) as any

    const res = await checkinTraeAccount(makeMockEnv(), dummyProvider, dummyAccount)
    expect(res.success).toBe(false)
    expect(res.checkedIn).toBe(false)
    expect(res.message).toContain('签到失败')
  })

  it('claim 错误文案含已签到，且后置 status 确认为 checked_in=true → 确认「今日已签到」', async () => {
    let statusCallCount = 0
    globalThis.fetch = vi.fn(async (input: any) => {
      const url = String(input)
      if (url.includes('/status')) {
        statusCallCount++
        return new Response(JSON.stringify({
          code: 0,
          checked_in: statusCallCount > 1, // 第一次前置为 false，后置为 true
          enable: true,
          credits: 100,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('/claim')) {
        return new Response(JSON.stringify({ code: 12345, msg: '用户今天已签到' }), { status: 200 })
      }
      return new Response(JSON.stringify({ user_entitlement_pack_list: [] }), { status: 200 })
    }) as any

    const res = await checkinTraeAccount(makeMockEnv(), dummyProvider, dummyAccount)
    expect(res.success).toBe(true)
    expect(res.checkedIn).toBe(true)
    expect(res.message).toBe('今日已签到')
  })
})
