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
  isAlreadyCheckin,
  hasCheckinIdempotentCode,
  BillingError,
  billingMeterPaths,
  billingCall,
  fetchWorkbuddyCredits,
  withinNightWindow,
  runWorkbuddyNightCat,
  NIGHT_WINDOW_START_HOUR,
  NIGHT_WINDOW_END_HOUR,
} from './workbuddy-billing'

describe('夜猫子任务 black_cat（移植 task_runner.py black_cat 分支）', () => {
  /** 构造某 CST 时刻的 epoch ms。 */
  const cst = (y: number, mo: number, d: number, h: number, mi = 0) =>
    Date.UTC(y, mo, d, h - 8, mi) // CST = UTC+8

  describe('withinNightWindow（CST 23:00–08:00）', () => {
    it('窗口内：23:00 / 23:59 / 00:00 / 03:00 / 07:59', () => {
      expect(withinNightWindow(cst(2026, 0, 15, 23, 0))).toBe(true)
      expect(withinNightWindow(cst(2026, 0, 15, 23, 59))).toBe(true)
      expect(withinNightWindow(cst(2026, 0, 16, 0, 0))).toBe(true)
      expect(withinNightWindow(cst(2026, 0, 16, 3, 0))).toBe(true)
      expect(withinNightWindow(cst(2026, 0, 16, 7, 59))).toBe(true)
    })

    it('窗口外：08:00 / 12:00 / 22:59', () => {
      expect(withinNightWindow(cst(2026, 0, 16, 8, 0))).toBe(false)
      expect(withinNightWindow(cst(2026, 0, 16, 12, 0))).toBe(false)
      expect(withinNightWindow(cst(2026, 0, 15, 22, 59))).toBe(false)
    })

    it('边界：起始 23:00 含、结束 08:00 不含', () => {
      expect(withinNightWindow(cst(2026, 0, 15, NIGHT_WINDOW_START_HOUR - 1, 59))).toBe(false)
      expect(withinNightWindow(cst(2026, 0, 15, NIGHT_WINDOW_START_HOUR, 0))).toBe(true)
      expect(withinNightWindow(cst(2026, 0, 16, NIGHT_WINDOW_END_HOUR - 1, 59))).toBe(true)
      expect(withinNightWindow(cst(2026, 0, 16, NIGHT_WINDOW_END_HOUR, 0))).toBe(false)
    })

    it('时区无关性：UTC 表示的同一时刻得到相同判定', () => {
      // CST 2026-01-15 23:30 == UTC 2026-01-15 15:30
      expect(withinNightWindow(Date.UTC(2026, 0, 15, 15, 30))).toBe(true)
      // CST 2026-01-16 12:00 == UTC 2026-01-16 04:00
      expect(withinNightWindow(Date.UTC(2026, 0, 16, 4, 0))).toBe(false)
    })

    it('回归防护：结果按 CST 小时判定，而非 UTC 小时', () => {
      // CST 01:00 = UTC 前一天 17:00。若实现误用本地(UTC)小时，17 点会被判为非窗口。
      expect(withinNightWindow(cst(2026, 0, 16, 1, 0))).toBe(true)
    })
  })

  describe('runWorkbuddyNightCat', () => {
    const originalFetch = globalThis.fetch
    afterEach(() => { globalThis.fetch = originalFetch })

    it('非窗口期 → skipped 且**不发任何上游请求**', async () => {
      const calls: string[] = []
      globalThis.fetch = vi.fn(async (url: string) => {
        calls.push(url)
        return new Response(JSON.stringify({ code: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }) as unknown as typeof fetch

      const r = await runWorkbuddyNightCat('tok', 'cn', 'u1', { from: cst(2026, 0, 16, 12, 0) })
      expect(r.state).toBe('skipped')
      expect(calls.length).toBe(0)
    })

    it('窗口内 → 发 1 条（cap=1），mode=night + glm-5.2', async () => {
      const bodies: string[] = []
      globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(typeof init?.body === 'string' ? init.body : '')
        return new Response(JSON.stringify({ code: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }) as unknown as typeof fetch

      const r = await runWorkbuddyNightCat('tok', 'cn', 'u1', { from: cst(2026, 0, 16, 1, 0) })
      expect(r.state).toBe('reported')
      // cap=1：只发 1 条
      expect(bodies.length).toBe(1)
      const ev = JSON.parse(bodies[0])[0]
      expect(ev.mode).toBe('night')
      expect(ev.requestModelId).toBe('glm-5.2')
      expect(ev.requestModelName).toBe('GLM-5.2')
      expect(ev.eventCode).toBe('chat_request_send')
      expect(ev.userId).toBe('u1')
    })

    it('上游失败 → error', async () => {
      globalThis.fetch = vi.fn(async () => new Response('boom', { status: 500 })) as unknown as typeof fetch
      const r = await runWorkbuddyNightCat('tok', 'cn', 'u1', { from: cst(2026, 0, 16, 1, 0) })
      expect(r.state).toBe('error')
    })
  })

  describe('buildChatRequestEvent mode/model 覆盖（向后兼容）', () => {
    it('缺省为 craft + deepseek-v4-flash', () => {
      const ev = buildChatRequestEvent('u1', 'c', 'r')
      expect(ev.mode).toBe('craft')
      expect(ev.requestModelId).toBe('deepseek-v4-flash')
      expect(ev.requestModelName).toBe('DeepSeek V4 Flash')
    })

    it('显式覆盖生效', () => {
      const ev = buildChatRequestEvent('u1', 'c', 'r', { mode: 'night', modelId: 'glm-5.2', modelName: 'GLM-5.2' })
      expect(ev.mode).toBe('night')
      expect(ev.requestModelId).toBe('glm-5.2')
    })
  })
})

describe('billingMeterPaths / billingCall 路径 fallback（移植 workbuddy2api billingMeterPaths）', () => {
  it('CN → 只有带 /v2 的形态（零回归）', () => {
    expect(billingMeterPaths('get-user-resource', 'cn')).toEqual(['/v2/billing/meter/get-user-resource'])
    expect(billingMeterPaths('daily-checkin', 'cn')).toEqual(['/v2/billing/meter/daily-checkin'])
  })

  it('global → 无 /v2 前缀优先，带 /v2 作 fallback（源实现 R9：国际版无 /v2）', () => {
    expect(billingMeterPaths('get-user-resource', 'global')).toEqual([
      '/billing/meter/get-user-resource',
      '/v2/billing/meter/get-user-resource',
    ])
    expect(billingMeterPaths('daily-checkin', 'global')).toEqual([
      '/billing/meter/daily-checkin',
      '/v2/billing/meter/daily-checkin',
    ])
  })
})

describe('billingCall 多路径 fallback 语义（仅 404 换下一条）', () => {
  const originalFetch = globalThis.fetch
  beforeEach(() => { vi.restoreAllMocks() })
  afterEach(() => { globalThis.fetch = originalFetch })

  it('首条 404 → 自动换第二条并成功', async () => {
    const seen: string[] = []
    globalThis.fetch = vi.fn(async (url: string) => {
      seen.push(url)
      if (url.includes('/billing/meter/') && !url.includes('/v2/')) {
        return new Response('not found', { status: 404 })
      }
      return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { ok: true } }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const paths = billingMeterPaths('get-user-resource', 'global')
    const data = await billingCall('tok', paths[0], 'global', { paths })
    expect(data).toEqual({ ok: true })
    expect(seen.length).toBe(2)
    expect(seen[0]).toContain('workbuddy.ai/billing/meter/get-user-resource')
    expect(seen[1]).toContain('workbuddy.ai/v2/billing/meter/get-user-resource')
  })

  it('首条 500 → **不** fallback，直接抛出（不掩盖真实故障）', async () => {
    const seen: string[] = []
    globalThis.fetch = vi.fn(async (url: string) => {
      seen.push(url)
      return new Response('boom', { status: 500 })
    }) as unknown as typeof fetch

    const paths = billingMeterPaths('get-user-resource', 'global')
    await expect(billingCall('tok', paths[0], 'global', { paths })).rejects.toThrow()
    expect(seen.length).toBe(1)
  })

  it('全部候选 404 → 抛出（含最后一次错误）', async () => {
    const seen: string[] = []
    globalThis.fetch = vi.fn(async (url: string) => {
      seen.push(url)
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    const paths = billingMeterPaths('daily-checkin', 'global')
    await expect(billingCall('tok', paths[0], 'global', { paths })).rejects.toThrow()
    expect(seen.length).toBe(2)
  })

  it('未传 paths 时只用单条（既有调用零回归）', async () => {
    const seen: string[] = []
    globalThis.fetch = vi.fn(async (url: string) => {
      seen.push(url)
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    await expect(billingCall('tok', '/v2/billing/meter/x', 'cn')).rejects.toThrow()
    expect(seen.length).toBe(1)
  })
})

describe('fetchWorkbuddyCredits：X-Device-Token 注入（对齐 workbuddy2api BillingHeaders）', () => {
  const originalFetch = globalThis.fetch
  beforeEach(() => { vi.restoreAllMocks() })
  afterEach(() => { globalThis.fetch = originalFetch })

  function captureHeaders() {
    const seen: Array<Record<string, string>> = []
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const h: Record<string, string> = {}
      const raw = (init?.headers || {}) as Record<string, string>
      for (const k of Object.keys(raw)) h[k.toLowerCase()] = String(raw[k])
      seen.push(h)
      return new Response(JSON.stringify({
        code: 0, msg: 'ok',
        data: { Response: { Data: { Accounts: [], TotalDosage: 0 } } },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch
    return seen
  }

  it('传 deviceToken 时注入 X-Device-Token', async () => {
    const seen = captureHeaders()
    await fetchWorkbuddyCredits('tok', 'cn', 'u1', 'e1', 'dt-abc')
    expect(seen[0]['x-device-token']).toBe('dt-abc')
    expect(seen[0]['x-user-id']).toBe('u1')
    expect(seen[0]['x-enterprise-id']).toBe('e1')
    expect(seen[0]['x-tenant-id']).toBe('e1')
  })

  it('不传 deviceToken 时不注入该头（优雅降级）', async () => {
    const seen = captureHeaders()
    await fetchWorkbuddyCredits('tok', 'cn', 'u1', 'e1')
    expect(seen[0]['x-device-token']).toBeUndefined()
  })
})

describe('签到幂等三段式判定（移植 workbuddy2api cmd/signin/main.go）', () => {
  describe('hasCheckinIdempotentCode 边界匹配', () => {
    it('识别裸码与两种拼写（code=10001 / "code":10001）', () => {
      expect(hasCheckinIdempotentCode('code=10001 msg=今天已签到')).toBe(true)
      expect(hasCheckinIdempotentCode('{"code":10001}')).toBe(true)
      expect(hasCheckinIdempotentCode('14001')).toBe(true)
    })

    it('前后是词内字符时不命中（防 12001 / 2010001 / 1_10001 误判）', () => {
      // 源实现 isAlreadyCode 的核心防护（workbuddy2api main_test.go:36-37）
      expect(hasCheckinIdempotentCode('12001')).toBe(false)
      expect(hasCheckinIdempotentCode('2010001')).toBe(false)
      expect(hasCheckinIdempotentCode('1_10001')).toBe(false)
      expect(hasCheckinIdempotentCode('a10001')).toBe(false)
      expect(hasCheckinIdempotentCode('10001a')).toBe(false)
    })

    it('前后是分隔符时命中', () => {
      expect(hasCheckinIdempotentCode('(10001)')).toBe(true)
      expect(hasCheckinIdempotentCode('code:10001,')).toBe(true)
      expect(hasCheckinIdempotentCode('"code": 10001')).toBe(true)
    })

    it('无码返回 false', () => {
      expect(hasCheckinIdempotentCode('ok')).toBe(false)
      expect(hasCheckinIdempotentCode('')).toBe(false)
    })
  })

  describe('isAlreadyCheckin 结构化业务错误走全量判定', () => {
    it('业务码 10001 → 幂等', () => {
      expect(isAlreadyCheckin(new BillingError('code=10001 msg=今天已签到', { code: 10001, status: 200 }))).toBe(true)
    })

    it('业务码 14001 → 幂等', () => {
      expect(isAlreadyCheckin(new BillingError('code=14001', { code: 14001, status: 200 }))).toBe(true)
    })

    it('中文文案命中（今天已签到 / 今日已签到 / 已签到）', () => {
      for (const m of ['今天已签到', '今日已签到', '已签到']) {
        expect(isAlreadyCheckin(new BillingError(`code=9999 msg=${m}`, { code: 9999, status: 200 }))).toBe(true)
      }
    })

    it('英文 already / inactive 对结构化业务错误生效', () => {
      expect(isAlreadyCheckin(new BillingError('code=9999 msg=already checked in', { code: 9999, status: 200 }))).toBe(true)
      expect(isAlreadyCheckin(new BillingError('code=9999 msg=inactive session', { code: 9999, status: 200 }))).toBe(true)
    })

    it('global 无签到体系类文案（未开启/未开放/已过期）→ 幂等兜底', () => {
      for (const m of ['未开启', '未开放', '已过期']) {
        expect(isAlreadyCheckin(new BillingError(`code=9999 msg=功能${m}`, { code: 9999, status: 200 }))).toBe(true)
      }
    })

    it('真实业务失败（余额/参数错）→ 不幂等', () => {
      expect(isAlreadyCheckin(new BillingError('code=11101 msg=Unmarshal chat params failed', { code: 11101, status: 400 }))).toBe(false)
      expect(isAlreadyCheckin(new BillingError('code=10086 msg=余额不足', { code: 10086, status: 200 }))).toBe(false)
    })
  })

  describe('isAlreadyCheckin 裸错误只认中文子集（关键防护）', () => {
    it('传输层 already（address already in use）→ **不**幂等', () => {
      // 这是本次移植要修的真实缺陷：旧实现用 low.includes('already') 宽匹配，
      // 会把端口占用/连接复用类网络文案误判为"今日已签到"。
      expect(isAlreadyCheckin(new Error('connect EADDRINUSE: address already in use 127.0.0.1:8787'))).toBe(false)
    })

    it('传输层 inactive（proxy session inactive）→ **不**幂等', () => {
      expect(isAlreadyCheckin(new Error('proxy error: session inactive'))).toBe(false)
    })

    it('超时/DNS/解析失败 → 不幂等', () => {
      expect(isAlreadyCheckin(new Error('The operation was aborted due to timeout'))).toBe(false)
      expect(isAlreadyCheckin(new Error('getaddrinfo ENOTFOUND copilot.tencent.com'))).toBe(false)
      expect(isAlreadyCheckin(new Error('parse failed /v2/billing/meter/daily-checkin: <html>'))).toBe(false)
    })

    it('裸错误含中文幂等文案 → 幂等（上游纯文本回复）', () => {
      expect(isAlreadyCheckin(new Error('今天已签到'))).toBe(true)
      expect(isAlreadyCheckin(new Error('功能未开启'))).toBe(true)
      expect(isAlreadyCheckin(new Error('活动已过期'))).toBe(true)
    })

    it('null / undefined / 非 Error → false', () => {
      expect(isAlreadyCheckin(null)).toBe(false)
      expect(isAlreadyCheckin(undefined)).toBe(false)
      expect(isAlreadyCheckin('')).toBe(false)
    })
  })
})

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
