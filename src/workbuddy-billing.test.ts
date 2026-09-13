import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  buildChatRequestEvent,
  reportWorkbuddyChatActivity,
  fetchWorkbuddyStreak,
  fetchWorkbuddyBuddyInfo,
  agreeWorkbuddyBuddyAgreement,
  adoptWorkbuddyFirstBuddy,
  fetchWorkbuddyTravelStatus,
  departWorkbuddyTravel,
  claimWorkbuddyTravelReward,
  runWorkbuddyCatTravel,
} from './workbuddy-billing'

describe('WorkBuddy 生态增值与自动化（workbuddy-billing.ts P2）', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('buildChatRequestEvent 生成全字段事件形状', () => {
    const ev = buildChatRequestEvent('u123', 'cid-1', 'rid-1')
    expect(ev.eventCode).toBe('chat_request_send')
    expect(ev.userId).toBe('u123')
    expect(ev.conversationId).toBe('cid-1')
    expect(ev.requestId).toBe('rid-1')
    expect(ev.mode).toBe('craft')
    expect(ev.requestModelId).toBe('deepseek-v4-flash')
    expect(typeof ev.timestamp).toBe('number')
  })

  it('reportWorkbuddyChatActivity 发起连续活跃上报', async () => {
    const fetchCalls: { url: string; headers: HeadersInit; body: string }[] = []
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init: any) => {
      fetchCalls.push({ url, headers: init.headers, body: init.body })
      return new Response(JSON.stringify({ code: 0, msg: 'ok', data: {} }), { status: 200 })
    })

    const res = await reportWorkbuddyChatActivity('test-token', 'cn', 'u123', {
      enterpriseId: 'e123',
      deviceToken: 'dt-123',
      count: 2,
    })

    expect(res.success).toBe(true)
    expect(res.reported).toBe(2)
    expect(fetchCalls.length).toBe(2)
    expect(fetchCalls[0].url).toBe('https://www.codebuddy.cn/v2/report')
    const headers = fetchCalls[0].headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer test-token')
    expect(headers['X-User-Id']).toBe('u123')
    expect(headers['X-Enterprise-Id']).toBe('e123')
    expect(headers['X-Device-Token']).toBe('dt-123')

    const body = JSON.parse(fetchCalls[0].body)
    expect(Array.isArray(body)).toBe(true)
    expect(body[0].eventCode).toBe('chat_request_send')
    expect(body[0].userId).toBe('u123')
  })

  it('fetchWorkbuddyStreak 查询连登天数', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 0, msg: 'ok', data: { streak: { days: 7 } } }), { status: 200 })
    )

    const days = await fetchWorkbuddyStreak('test-token', 'cn', { uid: 'u123' })
    expect(days).toBe(7)
  })

  it('fetchWorkbuddyBuddyInfo 查询猫档案（有猫 / 无猫）', async () => {
    // 有猫
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 0, msg: 'ok', data: { buddy: { id: 101, name: '招财猫' } } }), { status: 200 })
    )
    const buddy = await fetchWorkbuddyBuddyInfo('test-token', 'cn')
    expect(buddy).toEqual({ id: 101, name: '招财猫' })

    // 无猫 (buddy: null)
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 0, msg: 'ok', data: { buddy: null } }), { status: 200 })
    )
    const noBuddy = await fetchWorkbuddyBuddyInfo('test-token', 'cn')
    expect(noBuddy).toBeNull()
  })

  it('agreeWorkbuddyBuddyAgreement 与 adoptWorkbuddyFirstBuddy', async () => {
    let agreementCalled = false
    let adoptCalled = false

    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/activity/growth/buddy/agreement')) {
        agreementCalled = true
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: {} }), { status: 200 })
      }
      if (url.includes('/activity/growth/buddy/first')) {
        adoptCalled = true
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: {} }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 0, msg: 'ok', data: {} }), { status: 200 })
    })

    await agreeWorkbuddyBuddyAgreement('test-token', 'cn')
    expect(agreementCalled).toBe(true)

    const adoptRes = await adoptWorkbuddyFirstBuddy('test-token', 'cn')
    expect(adoptCalled).toBe(true)
    expect(adoptRes.success).toBe(true)
  })

  it('runWorkbuddyCatTravel：无猫自动领养（+300 积分）', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/activity/growth/buddy/info')) {
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { buddy: null } }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 0, msg: 'ok', data: {} }), { status: 200 })
    })

    const res = await runWorkbuddyCatTravel('test-token', 'cn', 'u123')
    expect(res.state).toBe('adopted')
    expect(res.reward).toBe(300)
  })

  it('runWorkbuddyCatTravel：有猫且到站自动领奖', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/activity/growth/buddy/info')) {
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { buddy: { id: 101, name: '小白' } } }), { status: 200 })
      }
      if (url.includes('/activity/growth/buddy/travel/status')) {
        return new Response(JSON.stringify({
          code: 0,
          msg: 'ok',
          data: { state: 'arrived', record_id: 888, reward_credit: 250 },
        }), { status: 200 })
      }
      if (url.includes('/activity/growth/buddy/travel/claim')) {
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { reward_credit: 250 } }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 0, msg: 'ok', data: {} }), { status: 200 })
    })

    const res = await runWorkbuddyCatTravel('test-token', 'cn', 'u123')
    expect(res.state).toBe('claimed')
    expect(res.reward).toBe(250)
    expect(res.buddyName).toBe('小白')
  })

  it('runWorkbuddyCatTravel：有猫空闲且未达上限自动派出', async () => {
    let departCalled = false
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/activity/growth/buddy/info')) {
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { buddy: { id: 101, name: '花花' } } }), { status: 200 })
      }
      if (url.includes('/activity/growth/buddy/travel/status')) {
        return new Response(JSON.stringify({
          code: 0,
          msg: 'ok',
          data: { state: 'idle', daily_limit_reached: false },
        }), { status: 200 })
      }
      if (url.includes('/activity/growth/buddy/travel/depart')) {
        departCalled = true
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: {} }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 0, msg: 'ok', data: {} }), { status: 200 })
    })

    const res = await runWorkbuddyCatTravel('test-token', 'cn', 'u123')
    expect(res.state).toBe('departed')
    expect(departCalled).toBe(true)
  })

  it('runWorkbuddyCatTravel：有猫在途中返回在途', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/activity/growth/buddy/info')) {
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { buddy: { id: 101, name: '花花' } } }), { status: 200 })
      }
      if (url.includes('/activity/growth/buddy/travel/status')) {
        return new Response(JSON.stringify({
          code: 0,
          msg: 'ok',
          data: { state: 'traveling', daily_limit_reached: false },
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 0, msg: 'ok', data: {} }), { status: 200 })
    })

    const res = await runWorkbuddyCatTravel('test-token', 'cn', 'u123')
    expect(res.state).toBe('traveling')
  })
})
