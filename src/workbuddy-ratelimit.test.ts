import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  ACTIVITY_REPORT_GAP_MS,
  ACTIVITY_ACCOUNT_DELAY_MS,
  cstDay,
  adoptTriedToday,
  markAdoptTried,
  ADOPT_TRIED_KV_PREFIX,
  reportWorkbuddyChatActivity,
  runWorkbuddyCatTravel,
} from './workbuddy-billing'
import type { Env } from './types'

/**
 * P1-9 防风控与防抖测试
 * （移植 workbuddy2api activityReportGap / activityAccountDelay / adoptTriedToday）。
 */

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

/** 记录调用并返回成功响应。 */
function mockOk() {
  const calls: Array<{ url: string; body: string }> = []
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
    calls.push({ url: u, body: typeof init?.body === 'string' ? init.body : '' })
    return new Response(JSON.stringify({ code: 0, msg: 'ok', data: {} }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return calls
}

describe('reportWorkbuddyChatActivity 条间间隔（对齐 activityReportGap = 1.5s）', () => {
  it('缺省间隔常量与源实现一致', () => {
    expect(ACTIVITY_REPORT_GAP_MS).toBe(1500)
    expect(ACTIVITY_ACCOUNT_DELAY_MS).toBe(800)
  })

  it('5 条上报之间有 4 次间隔（末条后不等）', async () => {
    mockOk()
    const waits: number[] = []
    await reportWorkbuddyChatActivity('tok', 'cn', 'u1', {
      count: 5,
      delay: async (ms) => { waits.push(ms) },
    })
    // i=1..4 各等一次；i=5 不等
    expect(waits).toEqual([1500, 1500, 1500, 1500])
  })

  it('count=1 时无间隔', async () => {
    mockOk()
    const waits: number[] = []
    await reportWorkbuddyChatActivity('tok', 'cn', 'u1', {
      count: 1,
      delay: async (ms) => { waits.push(ms) },
    })
    expect(waits).toEqual([])
  })

  it('gapMs=0（交互式端点）→ 完全不等（避免用户等待 6s+）', async () => {
    const calls = mockOk()
    const waits: number[] = []
    await reportWorkbuddyChatActivity('tok', 'cn', 'u1', {
      count: 5,
      gapMs: 0,
      delay: async (ms) => { waits.push(ms) },
    })
    expect(waits).toEqual([])
    // 但仍发满 5 条
    expect(calls.length).toBe(5)
  })

  it('自定义 gapMs 生效', async () => {
    mockOk()
    const waits: number[] = []
    await reportWorkbuddyChatActivity('tok', 'cn', 'u1', {
      count: 3,
      gapMs: 100,
      delay: async (ms) => { waits.push(ms) },
    })
    expect(waits).toEqual([100, 100])
  })

  it('上报失败时立即返回（不再续发，也不等待）', async () => {
    let n = 0
    globalThis.fetch = vi.fn(async () => {
      n++
      if (n === 2) return new Response('boom', { status: 500 })
      return new Response(JSON.stringify({ code: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch
    const waits: number[] = []
    const r = await reportWorkbuddyChatActivity('tok', 'cn', 'u1', {
      count: 5,
      delay: async (ms) => { waits.push(ms) },
    })
    // 第 2 条失败 → 只等了第 1→2 条之间的 1 次
    expect(waits).toEqual([1500])
    expect(r.reported).toBe(1)
    expect(r.success).toBe(true) // 已成功 1 条
  })

  it('5 条共用同一 conversationId，requestId 各条独立（源实现语义）', async () => {
    const calls = mockOk()
    await reportWorkbuddyChatActivity('tok', 'cn', 'u1', { count: 3, delay: async () => {} })
    const evs = calls.map((c) => JSON.parse(c.body)[0])
    const cids = new Set(evs.map((e) => e.conversationId))
    const rids = new Set(evs.map((e) => e.requestId))
    expect(cids.size).toBe(1)
    expect(rids.size).toBe(3)
  })
})

describe('cstDay（CST 自然日）', () => {
  it('按 CST 计算，而非 UTC', () => {
    // UTC 2026-01-15 20:00 == CST 2026-01-16 04:00 → 应返回 01-16
    expect(cstDay(Date.UTC(2026, 0, 15, 20, 0))).toBe('2026-01-16')
    // UTC 2026-01-15 15:59 == CST 2026-01-15 23:59 → 应返回 01-15
    expect(cstDay(Date.UTC(2026, 0, 15, 15, 59))).toBe('2026-01-15')
  })

  it('跨日边界：CST 00:00 属于新的一天', () => {
    // UTC 2026-01-15 16:00 == CST 2026-01-16 00:00
    expect(cstDay(Date.UTC(2026, 0, 15, 16, 0))).toBe('2026-01-16')
    expect(cstDay(Date.UTC(2026, 0, 15, 15, 59, 59))).toBe('2026-01-15')
  })

  it('格式为 YYYY-MM-DD（补零）', () => {
    expect(cstDay(Date.UTC(2026, 8, 5, 4, 0))).toBe('2026-09-05')
  })
})

describe('adoptTriedToday / markAdoptTried（领养当日防抖）', () => {
  function makeEnv() {
    const store = new Map<string, string>()
    const kv = {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => { store.set(k, v) },
      delete: async (k: string) => { store.delete(k) },
    }
    return { env: { KV: kv } as unknown as Env, store }
  }

  it('未标记 → false；标记后同日 → true', async () => {
    const { env } = makeEnv()
    const at = Date.UTC(2026, 0, 15, 4, 0)
    expect(await adoptTriedToday(env, 'p1', 'u1', at)).toBe(false)
    await markAdoptTried(env, 'p1', 'u1', at)
    expect(await adoptTriedToday(env, 'p1', 'u1', at)).toBe(true)
  })

  it('跨 CST 自然日 → 自动失效（false）', async () => {
    const { env } = makeEnv()
    const day1 = Date.UTC(2026, 0, 15, 4, 0)
    const day2 = Date.UTC(2026, 0, 16, 4, 0)
    await markAdoptTried(env, 'p1', 'u1', day1)
    expect(await adoptTriedToday(env, 'p1', 'u1', day2)).toBe(false)
  })

  it('不同 uid / provider 互不影响', async () => {
    const { env } = makeEnv()
    const at = Date.UTC(2026, 0, 15, 4, 0)
    await markAdoptTried(env, 'p1', 'u1', at)
    expect(await adoptTriedToday(env, 'p1', 'u2', at)).toBe(false)
    expect(await adoptTriedToday(env, 'p2', 'u1', at)).toBe(false)
  })

  it('KV key 前缀符合预期', async () => {
    const { env, store } = makeEnv()
    await markAdoptTried(env, 'p1', 'u1')
    expect(Array.from(store.keys())[0]).toBe(`${ADOPT_TRIED_KV_PREFIX}p1:u1`)
  })

  it('KV 不可读 → adoptTriedToday 返回 false（宁可多试一次，不漏领养）', async () => {
    const env = { KV: { get: async () => { throw new Error('kv down') } } } as unknown as Env
    expect(await adoptTriedToday(env, 'p1', 'u1')).toBe(false)
  })

  it('KV 写失败不抛错（退化为无防抖）', async () => {
    const env = { KV: { put: async () => { throw new Error('kv down') } } } as unknown as Env
    await expect(markAdoptTried(env, 'p1', 'u1')).resolves.toBeUndefined()
  })
})

describe('runWorkbuddyCatTravel 领养防抖接线', () => {
  function makeEnv() {
    const store = new Map<string, string>()
    const kv = {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => { store.set(k, v) },
      delete: async (k: string) => { store.delete(k) },
    }
    return { env: { KV: kv } as unknown as Env, store }
  }

  /** buddy/info 返回无猫；buddy/first 返回门槛未达 400。 */
  function mockNoBuddyIncomplete() {
    const calls: string[] = []
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
      calls.push(u)
      if (u.includes('/buddy/info')) {
        return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (u.includes('/buddy/agreement')) {
        return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (u.includes('/buddy/first')) {
        return new Response(JSON.stringify({ code: 400, msg: 'first_buddy task not completed yet' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch
    return calls
  }

  it('门槛未达 → 记当日已试；同日再次调用直接跳过（不发 buddy/first）', async () => {
    const { env } = makeEnv()
    const at = Date.UTC(2026, 0, 15, 4, 0)

    // 第一次：走到 buddy/first，门槛未达 → 记防抖
    let calls = mockNoBuddyIncomplete()
    const r1 = await runWorkbuddyCatTravel('tok', 'cn', 'u1', { env, providerId: 'p1', now: at })
    expect(r1.state).toBe('no_buddy')
    expect(calls.some((u) => u.includes('/buddy/first'))).toBe(true)

    // 第二次同日：被防抖拦住，不应再打 buddy/first
    calls = mockNoBuddyIncomplete()
    const r2 = await runWorkbuddyCatTravel('tok', 'cn', 'u1', { env, providerId: 'p1', now: at })
    expect(r2.state).toBe('adopt_deferred')
    expect(calls.some((u) => u.includes('/buddy/first'))).toBe(false)
    // 仍会查有无猫（状态可能已变）
    expect(calls.some((u) => u.includes('/buddy/info'))).toBe(true)
  })

  it('forceAdopt 豁免防抖（对话量刚补满，就地闭环）', async () => {
    const { env } = makeEnv()
    const at = Date.UTC(2026, 0, 15, 4, 0)
    await markAdoptTried(env, 'p1', 'u1', at)

    const calls = mockNoBuddyIncomplete()
    const r = await runWorkbuddyCatTravel('tok', 'cn', 'u1', { env, providerId: 'p1', now: at, forceAdopt: true })
    expect(r.state).toBe('no_buddy')
    expect(calls.some((u) => u.includes('/buddy/first'))).toBe(true)
  })

  it('未传 env/providerId → 不启用防抖（既有调用方行为不变）', async () => {
    const at = Date.UTC(2026, 0, 15, 4, 0)
    const calls1 = mockNoBuddyIncomplete()
    await runWorkbuddyCatTravel('tok', 'cn', 'u1', { now: at })
    expect(calls1.some((u) => u.includes('/buddy/first'))).toBe(true)

    // 第二次仍会尝试（无防抖）
    const calls2 = mockNoBuddyIncomplete()
    await runWorkbuddyCatTravel('tok', 'cn', 'u1', { now: at })
    expect(calls2.some((u) => u.includes('/buddy/first'))).toBe(true)
  })

  it('跨日后防抖失效 → 重新尝试领养', async () => {
    const { env } = makeEnv()
    const day1 = Date.UTC(2026, 0, 15, 4, 0)
    const day2 = Date.UTC(2026, 0, 16, 4, 0)

    mockNoBuddyIncomplete()
    await runWorkbuddyCatTravel('tok', 'cn', 'u1', { env, providerId: 'p1', now: day1 })

    const calls = mockNoBuddyIncomplete()
    await runWorkbuddyCatTravel('tok', 'cn', 'u1', { env, providerId: 'p1', now: day2 })
    expect(calls.some((u) => u.includes('/buddy/first'))).toBe(true)
  })

  it('其他失败原因不记防抖（下轮可重试）', async () => {
    const { env } = makeEnv()
    const at = Date.UTC(2026, 0, 15, 4, 0)
    // buddy/first 返回 500（非门槛未达）
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
      if (u.includes('/buddy/first')) return new Response('boom', { status: 500 })
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch

    await runWorkbuddyCatTravel('tok', 'cn', 'u1', { env, providerId: 'p1', now: at })
    // 未被记为防抖 → 同日再试仍会打 buddy/first
    expect(await adoptTriedToday(env, 'p1', 'u1', at)).toBe(false)
  })
})
