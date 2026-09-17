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
  growthClientToken,
  pickWorkbuddyRedeemTier,
  isRedeemAlreadyClaimed,
  isRedeemNotEnoughDays,
  isLotteryNoChance,
  isLotteryDisabled,
  fetchWorkbuddyRewardState,
  redeemWorkbuddyGrowth,
  fetchWorkbuddyLotteryChances,
  drawWorkbuddyLottery,
  runWorkbuddyGrowthRewards,
  cstDay,
  cstYesterday,
  fetchWorkbuddyHeatmap,
  heatmapDayScore,
  fetchWorkbuddyMakeupCards,
  useMakeupCard,
  claimWorkbuddyGift,
  claimWorkbuddyCompensation,
  makeupWorkbuddyYesterday,
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

/**
 * 连登奖励兑换 + 连登抽奖（移植 workbuddy2api 91418c5 growth_reward.go）。
 *
 * 关键行为：里程碑挑档（高→低）、client_token 每次新生成、正常态静默
 * （409 已领 / 403 天数不足 / 400 无次数 / 400 抽奖未开启）、KV 日键幂等、global 门控跳过。
 */
describe('连登奖励兑换 + 连登抽奖（growth_reward）', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => { vi.restoreAllMocks() })
  afterEach(() => { globalThis.fetch = originalFetch })

  /** 内存 KV，供幂等闸测试。 */
  function makeEnv() {
    const store = new Map<string, string>()
    const kv = {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => { store.set(k, v) },
      delete: async (k: string) => { store.delete(k) },
      list: async () => ({ keys: [], list_complete: true, cursor: '' }),
    }
    return { env: { KV: kv, GATEWAY_KV: kv, RATE_LIMIT_KV: kv, SESSION_KV: kv } as any, store }
  }

  it('growthClientToken 形态为 `<prefix>-<32hex>`，且每次调用不同', () => {
    const a = growthClientToken('draw')
    const b = growthClientToken('draw')
    expect(a).toMatch(/^draw-[0-9a-f]{32}$/)
    expect(a).not.toBe(b)
  })

  it('pickWorkbuddyRedeemTier：从高到低挑已达标且未领的最高档', () => {
    // 连登 20 天：28d 未达标、14d 可领 → 挑 14d
    expect(pickWorkbuddyRedeemTier({ days: 20, redemption: {} })).toBe('14d')
    // 连登 30 天 → 挑 28d
    expect(pickWorkbuddyRedeemTier({ days: 30, redemption: {} })).toBe('28d')
    // 连登 7 天 → 挑 7d
    expect(pickWorkbuddyRedeemTier({ days: 7, redemption: {} })).toBe('7d')
    // 连登 6 天 → 无档可领
    expect(pickWorkbuddyRedeemTier({ days: 6, redemption: {} })).toBeNull()
  })

  it('pickWorkbuddyRedeemTier：已领档位被跳过，回落到下一档', () => {
    const st = { days: 30, redemption: { tier_28d_status: 'claimed' } }
    expect(pickWorkbuddyRedeemTier(st)).toBe('14d')
    const all = { days: 30, redemption: { tier_28d_status: 'claimed', tier_14d_status: 'claimed', tier_7d_status: 'claimed' } }
    expect(pickWorkbuddyRedeemTier(all)).toBeNull()
  })

  it('pickWorkbuddyRedeemTier：优先用上游 tiers[].days 门槛（缺失才回落常量表）', () => {
    // 上游声明 7d 档实际要 10 天 → 连登 8 天不该领
    const st = { days: 8, redemption: { tiers: [{ tier: '7d', days: 10 }] } }
    expect(pickWorkbuddyRedeemTier(st)).toBeNull()
    const st2 = { days: 10, redemption: { tiers: [{ tier: '7d', days: 10 }] } }
    expect(pickWorkbuddyRedeemTier(st2)).toBe('7d')
  })

  it('正常态判定：409 duplicate / 403 天数不足 / 400 无次数 / 400 disabled', () => {
    expect(isRedeemAlreadyClaimed('http 409 /activity/growth/redeem: {"code":409,"msg":"duplicate"}')).toBe(true)
    expect(isRedeemAlreadyClaimed('http 409 /x: {"msg":"该奖励已领取"}')).toBe(true)
    expect(isRedeemAlreadyClaimed('http 403 /x: 连续登录天数不足')).toBe(false)

    expect(isRedeemNotEnoughDays('http 403 /x: {"msg":"连续登录天数不足"}')).toBe(true)
    expect(isRedeemNotEnoughDays('http 409 /x: duplicate')).toBe(false)

    expect(isLotteryNoChance('http 400 /x: insufficient lottery chance balance')).toBe(true)
    expect(isLotteryNoChance('http 400 /x: lottery disabled')).toBe(false)

    expect(isLotteryDisabled('http 400 /x: lottery disabled')).toBe(true)
    expect(isLotteryDisabled('http 400 /x: insufficient lottery chance balance')).toBe(false)
  })

  it('正常态判定：状态码不匹配时不误判（防宽匹配）', () => {
    // 500 里出现 duplicate 文案不该当幂等正常态
    expect(isRedeemAlreadyClaimed('http 500 /x: duplicate')).toBe(false)
    expect(isRedeemNotEnoughDays('http 500 /x: 连续登录天数不足')).toBe(false)
    expect(isLotteryNoChance('http 500 /x: insufficient lottery chance balance')).toBe(false)
  })

  it('fetchWorkbuddyRewardState 解析 streak.days 与 redemption_status', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 0, msg: 'ok',
      data: {
        streak: { days: 14 },
        redemption_status: { tier_7d_status: 'claimed', tier_14d_status: 'available', tier_28d_status: 'locked' },
      },
    }), { status: 200 }))

    const st = await fetchWorkbuddyRewardState('tok', 'cn', { uid: 'u1' })
    expect(st!.days).toBe(14)
    expect(st!.redemption.tier_7d_status).toBe('claimed')
    expect(st!.redemption.tier_14d_status).toBe('available')
  })

  it('fetchWorkbuddyRewardState：网络/解析失败返回 null', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }))
    expect(await fetchWorkbuddyRewardState('tok', 'cn')).toBeNull()
  })

  it('redeemWorkbuddyGrowth 成功：解析回执四类奖励', async () => {
    let sentBody = ''
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: any) => {
      sentBody = init.body
      return new Response(JSON.stringify({
        code: 0, msg: 'ok',
        data: { credit_granted: 100, energy_granted: 5, cards_granted: 1, chances_granted: 2, cards_overflow: 0 },
      }), { status: 200 })
    })

    const out = await redeemWorkbuddyGrowth('tok', 'cn', '7d', { uid: 'u1' })
    expect(out.success).toBe(true)
    expect(out.result!.credit_granted).toBe(100)
    expect(out.result!.chances_granted).toBe(2)
    // client_token 形态 + tier 正确
    const body = JSON.parse(sentBody)
    expect(body.tier).toBe('7d')
    expect(body.client_token).toMatch(/^redeem-7d-[0-9a-f]{32}$/)
  })

  it('redeemWorkbuddyGrowth 每次调用用新 client_token（复用会被幂等吞掉）', async () => {
    const tokens: string[] = []
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init: any) => {
      tokens.push(JSON.parse(init.body).client_token)
      return new Response(JSON.stringify({ code: 0, msg: 'ok', data: {} }), { status: 200 })
    })
    await redeemWorkbuddyGrowth('tok', 'cn', '7d')
    await redeemWorkbuddyGrowth('tok', 'cn', '7d')
    expect(tokens[0]).not.toBe(tokens[1])
  })

  it('redeemWorkbuddyGrowth 正常态：409 已领 / 403 天数不足 → normal 标记且 success=false', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 409, msg: 'duplicate' }), { status: 409 }))
    const already = await redeemWorkbuddyGrowth('tok', 'cn', '7d')
    expect(already.success).toBe(false)
    expect(already.normal).toBe('already_claimed')

    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 403, msg: '连续登录天数不足' }), { status: 403 }))
    const notEnough = await redeemWorkbuddyGrowth('tok', 'cn', '28d')
    expect(notEnough.success).toBe(false)
    expect(notEnough.normal).toBe('not_enough_days')
  })

  it('redeemWorkbuddyGrowth 非正常态失败：不带 normal 标记（便于上层区分真错误）', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('kaboom', { status: 500 }))
    const out = await redeemWorkbuddyGrowth('tok', 'cn', '7d')
    expect(out.success).toBe(false)
    expect(out.normal).toBeUndefined()
    expect(out.message).toContain('兑换失败')
  })

  it('fetchWorkbuddyLotteryChances 读 data.balance', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 0, msg: 'ok', data: { balance: 3 } }), { status: 200 }))
    expect(await fetchWorkbuddyLotteryChances('tok', 'cn')).toBe(3)
  })

  it('drawWorkbuddyLottery 成功解析奖品；正常态 no_chance/disabled', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 0, msg: 'ok',
      data: { prize_code: 'P1', prize_name: '50 积分', prize_type: 'credit', credit_amount: 50 },
    }), { status: 200 }))
    const win = await drawWorkbuddyLottery('tok', 'cn')
    expect(win.success).toBe(true)
    expect(win.result!.prize_name).toBe('50 积分')
    expect(win.result!.credit_amount).toBe(50)

    globalThis.fetch = vi.fn().mockResolvedValue(new Response('insufficient lottery chance balance', { status: 400 }))
    const none = await drawWorkbuddyLottery('tok', 'cn')
    expect(none.success).toBe(false)
    expect(none.normal).toBe('no_chance')

    globalThis.fetch = vi.fn().mockResolvedValue(new Response('lottery disabled', { status: 400 }))
    const off = await drawWorkbuddyLottery('tok', 'cn')
    expect(off.normal).toBe('disabled')
  })

  it('runWorkbuddyGrowthRewards 全链：挑档 → 兑换 → 用送出的次数抽奖', async () => {
    const calls: string[] = []
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      calls.push(url)
      if (url.includes('/activity/growth/streak')) {
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { streak: { days: 20 }, redemption_status: {} } }), { status: 200 })
      }
      if (url.includes('/activity/growth/redeem')) {
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { credit_granted: 200, chances_granted: 1 } }), { status: 200 })
      }
      if (url.includes('/activity/growth/lottery/draw')) {
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { prize_name: '10 积分', credit_amount: 10 } }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 0, msg: 'ok', data: {} }), { status: 200 })
    })

    const { env } = makeEnv()
    const res = await runWorkbuddyGrowthRewards('tok', 'cn', 'u1', { env, providerId: 'wb' })
    expect(res.acted).toBe(true)
    expect(res.tier).toBe('14d')
    expect(res.credit).toBe(200)
    expect(res.chances).toBe(1)
    expect(res.prize).toBe('10 积分')
    expect(res.prizeCredit).toBe(10)
    // 未查 chances 端点（兑换已带回 chances=1）
    expect(calls.some((u) => u.includes('lottery/chances'))).toBe(false)
  })

  it('runWorkbuddyGrowthRewards 无 chances 时查余额，余额 0 则不抽奖', async () => {
    let drawCalled = false
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/activity/growth/streak')) {
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { streak: { days: 7 }, redemption_status: {} } }), { status: 200 })
      }
      if (url.includes('/activity/growth/redeem')) {
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { credit_granted: 50, chances_granted: 0 } }), { status: 200 })
      }
      if (url.includes('lottery/chances')) {
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { balance: 0 } }), { status: 200 })
      }
      if (url.includes('lottery/draw')) { drawCalled = true }
      return new Response(JSON.stringify({ code: 0, msg: 'ok', data: {} }), { status: 200 })
    })

    const res = await runWorkbuddyGrowthRewards('tok', 'cn', 'u1')
    expect(res.acted).toBe(true)
    expect(res.credit).toBe(50)
    expect(drawCalled).toBe(false)
  })

  it('runWorkbuddyGrowthRewards 无可领档位 → acted=false', async () => {
    // 注意：必须每次返回**新的** Response 实例。Response body 只能消费一次，
    // 而本函数现在会先打礼包/补偿（243c7f2 移植）再读 streak，共 4 次请求；
    // 沿用 mockResolvedValue 复用同一个 Response 会让后续请求读空 body。
    const body = JSON.stringify({ code: 0, msg: 'ok', data: { streak: { days: 3 }, redemption_status: {} } })
    globalThis.fetch = vi.fn().mockImplementation(async () => new Response(body, { status: 200 }))
    const res = await runWorkbuddyGrowthRewards('tok', 'cn', 'u1')
    expect(res.acted).toBe(false)
    expect(res.message).toContain('无可领档位')
  })

  it('runWorkbuddyGrowthRewards global 门控：整链跳过（不发任何请求）', async () => {
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy
    const res = await runWorkbuddyGrowthRewards('tok', 'global', 'u1')
    expect(res.acted).toBe(false)
    expect(res.message).toContain('global')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('KV 日键幂等：同日二次调用直接跳过（不打上游）', async () => {
    const { env } = makeEnv()
    const fetchSpy = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/activity/growth/streak')) {
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { streak: { days: 7 }, redemption_status: {} } }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { credit_granted: 10 } }), { status: 200 })
    })
    globalThis.fetch = fetchSpy

    const first = await runWorkbuddyGrowthRewards('tok', 'cn', 'u1', { env, providerId: 'wb' })
    expect(first.acted).toBe(true)
    const callsAfterFirst = fetchSpy.mock.calls.length

    const second = await runWorkbuddyGrowthRewards('tok', 'cn', 'u1', { env, providerId: 'wb' })
    expect(second.acted).toBe(false)
    expect(second.message).toContain('防抖')
    // 第二次没有再打上游
    expect(fetchSpy.mock.calls.length).toBe(callsAfterFirst)
  })

  it('KV 日键跨日失效：次日可再领', async () => {
    const { env } = makeEnv()
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/activity/growth/streak')) {
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { streak: { days: 7 }, redemption_status: {} } }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { credit_granted: 10 } }), { status: 200 })
    })
    const day1 = Date.UTC(2026, 8, 15, 4, 0) // CST 2026-09-15 12:00
    const day2 = Date.UTC(2026, 8, 16, 4, 0) // CST 2026-09-16 12:00
    expect((await runWorkbuddyGrowthRewards('tok', 'cn', 'u1', { env, providerId: 'wb', now: day1 })).acted).toBe(true)
    expect((await runWorkbuddyGrowthRewards('tok', 'cn', 'u1', { env, providerId: 'wb', now: day1 })).acted).toBe(false)
    // 次日：KV 里存的是 day1，与 day2 不等 → 可再领
    expect((await runWorkbuddyGrowthRewards('tok', 'cn', 'u1', { env, providerId: 'wb', now: day2 })).acted).toBe(true)
  })

  it('天数不足（403）也记当日已试：同日不再反复探测上游', async () => {
    const { env } = makeEnv()
    const fetchSpy = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/activity/growth/streak')) {
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { streak: { days: 7 }, redemption_status: {} } }), { status: 200 })
      }
      if (url.includes('/activity/growth/redeem')) {
        return new Response(JSON.stringify({ code: 403, msg: '连续登录天数不足' }), { status: 403 })
      }
      return new Response(JSON.stringify({ code: 0, msg: 'ok', data: {} }), { status: 200 })
    })
    globalThis.fetch = fetchSpy

    const first = await runWorkbuddyGrowthRewards('tok', 'cn', 'u1', { env, providerId: 'wb' })
    expect(first.acted).toBe(false)
    const n = fetchSpy.mock.calls.length
    const second = await runWorkbuddyGrowthRewards('tok', 'cn', 'u1', { env, providerId: 'wb' })
    expect(second.acted).toBe(false)
    expect(fetchSpy.mock.calls.length).toBe(n)
  })

  it('不同账号的幂等闸互不影响（key 含 uid）', async () => {
    const { env } = makeEnv()
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/activity/growth/streak')) {
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { streak: { days: 7 }, redemption_status: {} } }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { credit_granted: 10 } }), { status: 200 })
    })
    expect((await runWorkbuddyGrowthRewards('tok', 'cn', 'ua', { env, providerId: 'wb' })).acted).toBe(true)
    // 另一账号不受 ua 的闸影响
    expect((await runWorkbuddyGrowthRewards('tok', 'cn', 'ub', { env, providerId: 'wb' })).acted).toBe(true)
  })

  it('uid 缺失 → 跳过（幂等键与身份头都依赖 uid）', async () => {
    const res = await runWorkbuddyGrowthRewards('tok', 'cn', '')
    expect(res.acted).toBe(false)
    expect(res.message).toContain('uid')
  })

  it('streak 读不到 → acted=false（不误判为已领）', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('down', { status: 500 }))
    const res = await runWorkbuddyGrowthRewards('tok', 'cn', 'u1')
    expect(res.acted).toBe(false)
    expect(res.message).toContain('无法获取')
  })
})

/**
 * 连登管家三动作（移植 workbuddy2api 243c7f2 growth_bonus.go）：
 * 补签卡保连登 + 新手礼包 + 活动补偿领取。
 *
 * 关键行为：三个端点 URL/方法/请求体正确；补签日期用 **CST 前一日**（非本地日期减一天）；
 * 三者失败**不影响** `base.success` 语义（runWorkbuddyGrowthRewards 的 acted/消息）；
 * 礼包与补偿在 growth 之前、补签在 streak 读取之后并重读 state。
 */
describe('连登管家三动作（补签卡 / 新手礼包 / 活动补偿，growth_bonus）', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => { vi.restoreAllMocks() })
  afterEach(() => { globalThis.fetch = originalFetch })

  /** 内存 KV，供幂等闸测试。 */
  function makeEnv() {
    const store = new Map<string, string>()
    const kv = {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => { store.set(k, v) },
      delete: async (k: string) => { store.delete(k) },
      list: async () => ({ keys: [], list_complete: true, cursor: '' }),
    }
    return { env: { KV: kv, GATEWAY_KV: kv, RATE_LIMIT_KV: kv, SESSION_KV: kv } as any, store }
  }

  /** 构造某 CST 时刻的 epoch ms（CST = UTC+8）。 */
  const cstAt = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo, d, h - 8, mi)

  // ---- 补签日期：CST 前一日（不是本地日期减一天） ----

  it('cstYesterday：跨时区时刻仍取 CST 前一日（而非 UTC 前一日）', () => {
    // CST 2026-09-16 00:30 == UTC 2026-09-15 16:30。
    // 「本地(UTC)日期减一天」会得到 2026-09-14（错）；CST 前一日应为 2026-09-15。
    const at = Date.UTC(2026, 8, 15, 16, 30)
    expect(cstDay(at)).toBe('2026-09-16')
    expect(cstYesterday(at)).toBe('2026-09-15')
    // 直接反证：按 UTC 日减一天得到的错误值
    const wrongLocal = new Date(at - 86400000)
    expect(`${wrongLocal.getUTCFullYear()}-${String(wrongLocal.getUTCMonth() + 1).padStart(2, '0')}-${String(wrongLocal.getUTCDate()).padStart(2, '0')}`).toBe('2026-09-14')
  })

  it('cstYesterday：CST 23:30 与次日 00:30 都归到各自 CST 日的前一天', () => {
    expect(cstYesterday(cstAt(2026, 8, 16, 23, 30))).toBe('2026-09-15')
    expect(cstYesterday(cstAt(2026, 8, 17, 0, 30))).toBe('2026-09-16')
    // 月末/跨月边界
    expect(cstYesterday(cstAt(2026, 9, 1, 0, 5))).toBe('2026-09-30')
    // 跨年边界
    expect(cstYesterday(cstAt(2027, 0, 1, 7, 0))).toBe('2026-12-31')
  })

  // ---- 三个端点的 URL / 方法 / 请求体 ----

  it('fetchWorkbuddyHeatmap：GET /activity/growth/heatmap，解析 cells 并截断 date 前 10 位', async () => {
    const calls: Array<{ url: string; method?: string }> = []
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init: any) => {
      calls.push({ url, method: init?.method })
      return new Response(JSON.stringify({
        code: 0, msg: 'ok',
        data: { cells: [{ date: '2026-09-15T00:00:00+08:00', score: 0 }, { date: '2026-09-14', score: 12 }] },
      }), { status: 200 })
    }) as unknown as typeof fetch

    const cells = await fetchWorkbuddyHeatmap('tok', 'cn', { uid: 'u1' })
    expect(calls[0].url).toBe('https://copilot.tencent.com/activity/growth/heatmap')
    expect(calls[0].method).toBe('GET')
    expect(cells).toEqual([{ date: '2026-09-15', score: 0 }, { date: '2026-09-14', score: 12 }])
    expect(heatmapDayScore(cells!, '2026-09-15')).toBe(0)
    // 无该日格 → undefined（区别于 score 0：无判据不得当漏签）
    expect(heatmapDayScore(cells!, '2026-09-13')).toBeUndefined()
  })

  it('fetchWorkbuddyHeatmap：失败返回 null（只读判据失败静默）', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('down', { status: 500 })) as unknown as typeof fetch
    expect(await fetchWorkbuddyHeatmap('tok', 'cn')).toBeNull()
  })

  it('fetchWorkbuddyMakeupCards：读 streak 响应体的 makeup_cards.balance/max', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 0, msg: 'ok', data: { streak: { days: 5 }, makeup_cards: { balance: 2, max: 3 } },
    }), { status: 200 })) as unknown as typeof fetch

    const cards = await fetchWorkbuddyMakeupCards('tok', 'cn', { uid: 'u1' })
    expect(cards).toEqual({ balance: 2, max: 3 })
  })

  it('fetchWorkbuddyMakeupCards：makeup_cards 缺失 → balance 0（不误判有卡）', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 0, msg: 'ok', data: { streak: { days: 5 } },
    }), { status: 200 })) as unknown as typeof fetch
    expect(await fetchWorkbuddyMakeupCards('tok', 'cn')).toEqual({ balance: 0, max: 0 })
  })

  it('fetchWorkbuddyRewardState 同时解析 makeup_cards（与 streak 同响应体，免二次请求）', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 0, msg: 'ok',
      data: {
        streak: { days: 5 },
        redemption_status: { tier_7d_status: 'locked' },
        makeup_cards: { balance: 2, max: 3 },
      },
    }), { status: 200 })) as unknown as typeof fetch

    const st = await fetchWorkbuddyRewardState('tok', 'cn', { uid: 'u1' })
    expect(st!.days).toBe(5)
    expect(st!.makeupCards).toEqual({ balance: 2, max: 3 })
  })

  it('fetchWorkbuddyRewardState：上游未给 makeup_cards → makeupCards 缺省（不误判有卡）', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 0, msg: 'ok', data: { streak: { days: 5 }, redemption_status: {} },
    }), { status: 200 })) as unknown as typeof fetch
    const st = await fetchWorkbuddyRewardState('tok', 'cn')
    expect(st!.makeupCards).toBeUndefined()
  })

  it('makeupWorkbuddyYesterday：传入 cards（已读到的余额）→ 不再单独 GET streak', async () => {
    const calls: string[] = []
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      calls.push(url)
      if (url.includes('/activity/growth/heatmap')) {
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { cells: [{ date: '2026-09-15', score: 0 }] } }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 0, msg: 'ok', data: {} }), { status: 200 })
    }) as unknown as typeof fetch

    const at = Date.UTC(2026, 8, 15, 16, 30)
    const used = await makeupWorkbuddyYesterday('tok', 'cn', { now: at, cards: { balance: 1, max: 3 } })
    expect(used).toBe('2026-09-15')
    // 复用调用方读到的余额：streak 一次都不打（与源实现"同响应体零加请求"一致）
    expect(calls.some((u) => u.includes('/activity/growth/streak'))).toBe(false)
    expect(calls.some((u) => u.includes('makeup-cards/use'))).toBe(true)
  })

  it('makeupWorkbuddyYesterday：cards=null（上游未给该段）→ 视为无卡，不补签', async () => {
    const calls: string[] = []
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      calls.push(url)
      if (url.includes('/activity/growth/heatmap')) {
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { cells: [{ date: '2026-09-15', score: 0 }] } }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 0, msg: 'ok', data: {} }), { status: 200 })
    }) as unknown as typeof fetch

    const at = Date.UTC(2026, 8, 15, 16, 30)
    expect(await makeupWorkbuddyYesterday('tok', 'cn', { now: at, cards: null })).toBeNull()
    expect(calls.some((u) => u.includes('/activity/growth/streak'))).toBe(false)
    expect(calls.some((u) => u.includes('makeup-cards/use'))).toBe(false)
  })

  it('useMakeupCard：POST /activity/growth/makeup-cards/use，体为 {"target_date":"..."}', async () => {
    const calls: Array<{ url: string; method?: string; body: string }> = []
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init: any) => {
      calls.push({ url, method: init?.method, body: init?.body })
      return new Response(JSON.stringify({ code: 0, msg: 'ok', data: {} }), { status: 200 })
    }) as unknown as typeof fetch

    await useMakeupCard('tok', 'cn', '2026-09-15', { uid: 'u1' })
    expect(calls[0].url).toBe('https://copilot.tencent.com/activity/growth/makeup-cards/use')
    expect(calls[0].method).toBe('POST')
    expect(JSON.parse(calls[0].body)).toEqual({ target_date: '2026-09-15' })
  })

  it('claimWorkbuddyGift：POST /billing/meter/claim-gift，解析 data.credit', async () => {
    const calls: Array<{ url: string; method?: string; body: string }> = []
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init: any) => {
      calls.push({ url, method: init?.method, body: init?.body })
      return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { credit: 500 } }), { status: 200 })
    }) as unknown as typeof fetch

    const out = await claimWorkbuddyGift('tok', 'cn', { uid: 'u1' })
    // CN 路径为 `/billing/meter/claim-gift`（**无 /v2 前缀**）：源实现 claim-gift 走 billingBase + 原路径，
    // 不经过 billingMeterPaths（后者只作用于 get-user-resource / daily-checkin）。
    // 与源实现 243c7f2 测试桩的 `case "/billing/meter/claim-gift"` 逐字一致。
    expect(calls[0].url).toBe('https://www.codebuddy.cn/billing/meter/claim-gift')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].body).toBe('{}')
    expect(out).toEqual({ success: true, credit: 500, message: '已领取' })
  })

  it('claimWorkbuddyCompensation：POST /billing/meter/claim-compensation，解析 data.credit', async () => {
    const calls: Array<{ url: string; method?: string; body: string }> = []
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init: any) => {
      calls.push({ url, method: init?.method, body: init?.body })
      return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { credit: 300 } }), { status: 200 })
    }) as unknown as typeof fetch

    const out = await claimWorkbuddyCompensation('tok', 'cn', { uid: 'u1' })
    // 同 claim-gift：CN 路径无 /v2 前缀（对齐源实现 billingJSON + claimCompensationPath）
    expect(calls[0].url).toBe('https://www.codebuddy.cn/billing/meter/claim-compensation')
    expect(calls[0].method).toBe('POST')
    expect(out).toEqual({ success: true, credit: 300, message: '已领取' })
  })

  it('礼包/补偿业务错误（已领 / 未开启）→ success=false，不抛异常', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 400, msg: 'already claimed' }), { status: 400 })) as unknown as typeof fetch
    const gift = await claimWorkbuddyGift('tok', 'cn')
    expect(gift.success).toBe(false)
    expect(gift.credit).toBe(0)

    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 400, msg: 'not opened' }), { status: 400 })) as unknown as typeof fetch
    const comp = await claimWorkbuddyCompensation('tok', 'cn')
    expect(comp.success).toBe(false)
    expect(comp.credit).toBe(0)
  })

  it('回执缺 credit 字段不视为失败（credit 记 0，对齐源实现忽略解析错误）', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 0, msg: 'ok', data: {} }), { status: 200 })) as unknown as typeof fetch
    expect(await claimWorkbuddyGift('tok', 'cn')).toEqual({ success: true, credit: 0, message: '已领取' })
  })

  // ---- makeupWorkbuddyYesterday：判据链 + 补签日期 ----

  it('makeupWorkbuddyYesterday：昨日漏签且有卡 → 补昨日（CST 前一日）并返回该日', async () => {
    const calls: Array<{ url: string; method?: string; body: string }> = []
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init: any) => {
      calls.push({ url, method: init?.method, body: init?.body || '' })
      if (url.includes('/activity/growth/heatmap')) {
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { cells: [{ date: '2026-09-15', score: 0 }] } }), { status: 200 })
      }
      if (url.includes('/activity/growth/streak')) {
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { streak: { days: 5 }, makeup_cards: { balance: 1, max: 3 } } }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 0, msg: 'ok', data: {} }), { status: 200 })
    }) as unknown as typeof fetch

    // now = CST 2026-09-16 00:30 → 昨日 = 2026-09-15（若误用本地日期减一天会得 09-14）
    const at = Date.UTC(2026, 8, 15, 16, 30)
    const used = await makeupWorkbuddyYesterday('tok', 'cn', { uid: 'u1', now: at })
    expect(used).toBe('2026-09-15')

    const useCall = calls.find((c) => c.url.includes('makeup-cards/use'))!
    expect(useCall.method).toBe('POST')
    expect(JSON.parse(useCall.body)).toEqual({ target_date: '2026-09-15' })
  })

  it('makeupWorkbuddyYesterday：昨日无漏签（score>0）→ 不补签、不发写请求', async () => {
    const calls: string[] = []
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      calls.push(url)
      if (url.includes('/activity/growth/heatmap')) {
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { cells: [{ date: '2026-09-15', score: 8 }] } }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 0, msg: 'ok', data: {} }), { status: 200 })
    }) as unknown as typeof fetch

    const at = Date.UTC(2026, 8, 15, 16, 30)
    expect(await makeupWorkbuddyYesterday('tok', 'cn', { now: at })).toBeNull()
    expect(calls.some((u) => u.includes('makeup-cards/use'))).toBe(false)
    // 连补签卡余额都不必查（判据已否）
    expect(calls.some((u) => u.includes('/activity/growth/streak'))).toBe(false)
  })

  it('makeupWorkbuddyYesterday：昨日无该日格 → 不补签（无判据，不误当漏签）', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 0, msg: 'ok', data: { cells: [{ date: '2026-09-14', score: 0 }] },
    }), { status: 200 })) as unknown as typeof fetch
    const at = Date.UTC(2026, 8, 15, 16, 30)
    expect(await makeupWorkbuddyYesterday('tok', 'cn', { now: at })).toBeNull()
  })

  it('makeupWorkbuddyYesterday：无补签卡（balance 0）→ 不补签', async () => {
    const calls: string[] = []
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      calls.push(url)
      if (url.includes('/activity/growth/heatmap')) {
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { cells: [{ date: '2026-09-15', score: 0 }] } }), { status: 200 })
      }
      if (url.includes('/activity/growth/streak')) {
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { makeup_cards: { balance: 0, max: 3 } } }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 0, msg: 'ok', data: {} }), { status: 200 })
    }) as unknown as typeof fetch

    const at = Date.UTC(2026, 8, 15, 16, 30)
    expect(await makeupWorkbuddyYesterday('tok', 'cn', { now: at })).toBeNull()
    expect(calls.some((u) => u.includes('makeup-cards/use'))).toBe(false)
  })

  it('makeupWorkbuddyYesterday：heatmap 查询失败 → 静默 null（不写上游）', async () => {
    const calls: string[] = []
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      calls.push(url)
      return new Response('down', { status: 500 })
    }) as unknown as typeof fetch
    expect(await makeupWorkbuddyYesterday('tok', 'cn', { now: Date.now() })).toBeNull()
    expect(calls.some((u) => u.includes('makeup-cards/use'))).toBe(false)
  })

  it('makeupWorkbuddyYesterday：补签接口业务错误（400 已补过）→ 静默 null，不抛', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/activity/growth/heatmap')) {
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { cells: [{ date: '2026-09-15', score: 0 }] } }), { status: 200 })
      }
      if (url.includes('/activity/growth/streak')) {
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { makeup_cards: { balance: 1 } } }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 400, msg: 'already made up' }), { status: 400 })
    }) as unknown as typeof fetch
    const at = Date.UTC(2026, 8, 15, 16, 30)
    expect(await makeupWorkbuddyYesterday('tok', 'cn', { now: at })).toBeNull()
  })

  // ---- 接进 runWorkbuddyGrowthRewards：顺序 + 状态更新 + 失败不污染 ----

  it('全链：礼包/补偿在 growth 之前领取，补签在 streak 读取之后并重读 state 挑档', async () => {
    const order: string[] = []
    let streakReads = 0
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('claim-gift')) { order.push('gift'); return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { credit: 500 } }), { status: 200 }) }
      if (url.includes('claim-compensation')) { order.push('compensation'); return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { credit: 300 } }), { status: 200 }) }
      if (url.includes('/activity/growth/heatmap')) {
        order.push('heatmap')
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { cells: [{ date: '2026-09-15', score: 0 }] } }), { status: 200 })
      }
      if (url.includes('/activity/growth/streak')) {
        order.push('streak')
        streakReads++
        // 第一次读（opts.state 未传）：连登 5 天，有补签卡；重读：恢复到 7 天
        const days = streakReads === 1 ? 5 : 7
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { streak: { days }, redemption_status: {}, makeup_cards: { balance: 1, max: 3 } } }), { status: 200 })
      }
      if (url.includes('makeup-cards/use')) { order.push('makeup-use'); return new Response(JSON.stringify({ code: 0, msg: 'ok', data: {} }), { status: 200 }) }
      if (url.includes('/activity/growth/redeem')) { order.push('redeem'); return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { credit_granted: 100, chances_granted: 0 } }), { status: 200 }) }
      if (url.includes('lottery/chances')) return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { balance: 0 } }), { status: 200 })
      return new Response(JSON.stringify({ code: 0, msg: 'ok', data: {} }), { status: 200 })
    }) as unknown as typeof fetch

    // now = CST 2026-09-16 12:00 → 昨日 = 2026-09-15
    const at = Date.UTC(2026, 8, 16, 4, 0)
    const res = await runWorkbuddyGrowthRewards('tok', 'cn', 'u1', { now: at })

    // 顺序：礼包/补偿 → streak（带 makeup_cards）→ heatmap → 补签 → 重读 streak → redeem。
    // streak 只读两次：首次拿天数+卡余额，补签成功后重读吃恢复后的天数；
    // 补签的卡余额复用首次读取的 makeup_cards（不为同一端点多打一遍）。
    expect(order).toEqual(['gift', 'compensation', 'streak', 'heatmap', 'makeup-use', 'streak', 'redeem'])
    expect(streakReads).toBe(2)

    // 状态更新：礼包/补偿到账、补签日期、且**补签后恢复到 7d 被吃到**（否则 5 天无可领档）
    expect(res.acted).toBe(true)
    expect(res.tier).toBe('7d')
    expect(res.giftCredit).toBe(500)
    expect(res.compensationCredit).toBe(300)
    expect(res.makeupDate).toBe('2026-09-15')
    expect(res.message).toContain('新手礼包 +500 积分')
    expect(res.message).toContain('活动补偿 +300 积分')
    expect(res.message).toContain('补签 2026-09-15')
  })

  it('复用调用方传入的 state：补签未触发时不重读 streak（只读一次）', async () => {
    let streakReads = 0
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/activity/growth/streak')) {
        streakReads++
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { streak: { days: 20 }, redemption_status: {}, makeup_cards: { balance: 0 } } }), { status: 200 })
      }
      if (url.includes('/activity/growth/heatmap')) {
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { cells: [{ date: '2026-09-15', score: 5 }] } }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { credit_granted: 10 } }), { status: 200 })
    }) as unknown as typeof fetch

    const at = Date.UTC(2026, 8, 16, 4, 0)
    const state = { days: 20, redemption: {} }
    const res = await runWorkbuddyGrowthRewards('tok', 'cn', 'u1', { state, now: at })
    expect(res.acted).toBe(true)
    expect(res.tier).toBe('14d')
    expect(streakReads).toBe(0) // 用传入 state；补签未触发 → 不重读
  })

  it('失败路径：礼包/补偿/补签全失败（400/500）→ base 语义不变，redeem 照常成功', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('claim-gift')) return new Response(JSON.stringify({ code: 400, msg: 'already claimed' }), { status: 400 })
      if (url.includes('claim-compensation')) return new Response('kaboom', { status: 500 })
      if (url.includes('/activity/growth/heatmap')) return new Response('down', { status: 500 })
      if (url.includes('/activity/growth/streak')) {
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { streak: { days: 20 }, redemption_status: {} } }), { status: 200 })
      }
      if (url.includes('/activity/growth/redeem')) {
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { credit_granted: 200, chances_granted: 0 } }), { status: 200 })
      }
      if (url.includes('lottery/chances')) return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { balance: 0 } }), { status: 200 })
      return new Response(JSON.stringify({ code: 0, msg: 'ok', data: {} }), { status: 200 })
    }) as unknown as typeof fetch

    const res = await runWorkbuddyGrowthRewards('tok', 'cn', 'u1')
    expect(res.acted).toBe(true)
    expect(res.tier).toBe('14d')
    expect(res.credit).toBe(200)
    // 失败动作不落字段、不进消息（不污染成功结果）
    expect(res.giftCredit).toBeUndefined()
    expect(res.compensationCredit).toBeUndefined()
    expect(res.makeupDate).toBeUndefined()
    expect(res.message).not.toContain('新手礼包')
    expect(res.message).not.toContain('活动补偿')
  })

  it('失败路径：streak 读不到时三个动作也不冒泡（acted=false 且消息仍是既有语义）', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('claim-gift') || url.includes('claim-compensation')) {
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { credit: 100 } }), { status: 200 })
      }
      return new Response('down', { status: 500 })
    }) as unknown as typeof fetch

    const res = await runWorkbuddyGrowthRewards('tok', 'cn', 'u1')
    expect(res.acted).toBe(false)
    expect(res.message).toContain('无法获取')
  })

  it('无档可领但礼包到账 → acted=true 且带 giftCredit（动作不被吞掉）', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('claim-gift')) return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { credit: 500 } }), { status: 200 })
      if (url.includes('claim-compensation')) return new Response(JSON.stringify({ code: 400, msg: 'not opened' }), { status: 400 })
      if (url.includes('/activity/growth/streak')) {
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { streak: { days: 3 }, redemption_status: {} } }), { status: 200 })
      }
      if (url.includes('/activity/growth/heatmap')) {
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { cells: [] } }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 0, msg: 'ok', data: {} }), { status: 200 })
    }) as unknown as typeof fetch

    const res = await runWorkbuddyGrowthRewards('tok', 'cn', 'u1')
    expect(res.acted).toBe(true)
    expect(res.giftCredit).toBe(500)
    expect(res.compensationCredit).toBeUndefined()
    expect(res.message).toContain('新手礼包 +500 积分')
    expect(res.message).toContain('无可领档位')
  })

  it('无档可领且补签成功 → acted=true 且带 makeupDate（补签动作不被吞掉）', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('claim-gift') || url.includes('claim-compensation')) {
        return new Response(JSON.stringify({ code: 400, msg: 'already claimed' }), { status: 400 })
      }
      if (url.includes('/activity/growth/streak')) {
        // 补签后仍不足 7 天（3 → 4）→ 无可领档，但补签本身是有效动作
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { streak: { days: 4 }, redemption_status: {}, makeup_cards: { balance: 1, max: 3 } } }), { status: 200 })
      }
      if (url.includes('/activity/growth/heatmap')) {
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { cells: [{ date: '2026-09-15', score: 0 }] } }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 0, msg: 'ok', data: {} }), { status: 200 })
    }) as unknown as typeof fetch

    const at = Date.UTC(2026, 8, 16, 4, 0)
    const res = await runWorkbuddyGrowthRewards('tok', 'cn', 'u1', { now: at })
    expect(res.acted).toBe(true)
    expect(res.makeupDate).toBe('2026-09-15')
    expect(res.giftCredit).toBeUndefined()
    expect(res.message).toContain('补签 2026-09-15')
    expect(res.message).toContain('无可领档位')
  })

  it('KV 日键幂等：同日二次调用不发任何三动作请求（闸在动作之前）', async () => {
    const { env } = makeEnv()
    const calls: string[] = []
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      calls.push(url)
      if (url.includes('/activity/growth/streak')) {
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { streak: { days: 7 }, redemption_status: {} } }), { status: 200 })
      }
      if (url.includes('/activity/growth/heatmap')) {
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { cells: [] } }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { credit_granted: 10 } }), { status: 200 })
    }) as unknown as typeof fetch

    expect((await runWorkbuddyGrowthRewards('tok', 'cn', 'u1', { env, providerId: 'wb' })).acted).toBe(true)
    const n = calls.length
    expect(calls.some((u) => u.includes('claim-gift'))).toBe(true)

    const second = await runWorkbuddyGrowthRewards('tok', 'cn', 'u1', { env, providerId: 'wb' })
    expect(second.acted).toBe(false)
    expect(second.message).toContain('防抖')
    expect(calls.length).toBe(n) // 二次调用零请求：礼包/补偿也没重发
  })

  it('global 门控：整链跳过，三动作零请求', async () => {
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const res = await runWorkbuddyGrowthRewards('tok', 'global', 'u1')
    expect(res.acted).toBe(false)
    expect(res.message).toContain('global')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
