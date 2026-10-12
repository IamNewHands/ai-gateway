import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  billingCall,
  BillingError,
  fetchIntlCountries,
  detectUserRegion,
  submitUserRegion,
  activateGlobalRegister,
  claimGlobalTrial,
  reportWorkbuddyChatActivity,
  growthCall,
  isCloudflareEdgeError,
  describeHttpFailure,
  TRANSIENT_RETRY_MAX,
  __setTransientRetryDelayForTests,
} from './workbuddy-billing'

/**
 * 瞬时失败重试 + 失败原因整形
 * （Cloudflare 边缘拦截页 / WAF 403 / 5xx 的恢复与可读化）。
 *
 * 实测故障：`www.workbuddy.ai` 在 Cloudflare 之后，而本 Worker 开了 Smart Placement。
 * 子请求落到某边缘节点、该节点把目标域名解析成 CF 自己的 anycast IP 时，CF 防环回守卫
 * 直接回自己的纯文本错误页 `error code: 1002` —— 请求从未到达腾讯。故障与边缘节点相关，
 * 故表现为间歇（register / trial / /v2/report 同时 403，重跑即成功）。
 */

/** Cloudflare 边缘拦截页原文（实测形态：纯文本，无业务信封）。 */
const CF_EDGE_PAGE = 'error code: 1002'

const originalFetch = globalThis.fetch

interface Call { url: string; method: string; body: string }

/** 按调用序号决定响应的 fetch mock（记录全部调用）。 */
function mockSequence(handler: (call: Call, n: number) => Response) {
  const calls: Call[] = []
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
    const call: Call = {
      url: u,
      method: init?.method || 'GET',
      body: typeof init?.body === 'string' ? init.body : '',
    }
    calls.push(call)
    return handler(call, calls.length)
  }) as unknown as typeof fetch
  return calls
}

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  vi.restoreAllMocks()
  // 跳过真实退避（否则「用满重试额度」的用例各空等约 600ms）
  __setTransientRetryDelayForTests(async () => {})
})
afterEach(() => {
  globalThis.fetch = originalFetch
  __setTransientRetryDelayForTests(null)
})

// ===== 判据纯函数 =====

describe('isCloudflareEdgeError / describeHttpFailure（失败原因整形）', () => {
  it('识别 CF 边缘错误页（纯文本 error code: 1002 / HTML 标题形态）', () => {
    expect(isCloudflareEdgeError('error code: 1002')).toBe(true)
    expect(isCloudflareEdgeError('  error code: 1002  ')).toBe(true)
    expect(isCloudflareEdgeError('<html><title>Error 1002</title></html>')).toBe(true)
    expect(isCloudflareEdgeError('error code: 1002 is not valid JSON')).toBe(true)
  })

  it('不误判业务文案（无 CF 机器标记）', () => {
    expect(isCloudflareEdgeError('{"code":11140,"msg":"request illegal"}')).toBe(false)
    expect(isCloudflareEdgeError('Forbidden')).toBe(false)
    expect(isCloudflareEdgeError('error code: 500')).toBe(false) // 只认 CF 1xxx 族
    expect(isCloudflareEdgeError('')).toBe(false)
  })

  it('CF 边缘页 → 明确指出「子请求未到达上游」并保留状态码', () => {
    const msg = describeHttpFailure(403, CF_EDGE_PAGE, '/billing/ide/trial')
    expect(msg).toContain('http 403')
    expect(msg).toContain('/billing/ide/trial')
    expect(msg).toContain('Cloudflare 边缘拦截页')
    expect(msg).toContain('error code: 1002')
    expect(msg).toContain('未到达上游')
  })

  it('非 CF 形态 → **逐字保持**原有拼写（幂等/文案匹配依赖该文本）', () => {
    expect(describeHttpFailure(403, '连续登录天数不足', '/x'))
      .toBe('http 403 /x: 连续登录天数不足')
    // 无 path 形态（claimGlobalTrial 此前不带 path）
    expect(describeHttpFailure(403, 'Forbidden')).toBe('http 403: Forbidden')
    // 超长 body 截断到 200 字
    expect(describeHttpFailure(500, 'x'.repeat(500), '/y').length).toBe('http 500 /y: '.length + 200)
  })

  it('空响应体 → 显式标注，不产出悬空冒号', () => {
    expect(describeHttpFailure(502, '', '/z')).toBe('http 502 /z（空响应体）')
  })
})

// ===== A：瞬时重试 =====

describe('瞬时重试：CF 边缘拦截页 / 5xx 原样重发', () => {
  it('register 首次撞 CF 边缘页 → 重试后成功（这就是「再点一次就好」的自动化）', async () => {
    const calls = mockSequence((_c, n) => {
      if (n === 1) return new Response(CF_EDGE_PAGE, { status: 403 })
      return jsonResp({ code: 200, msg: 'register success' })
    })
    const r = await activateGlobalRegister('tok', 'u1')
    expect(r).toEqual({ ok: true, needsRegion: false, msg: 'register success' })
    expect(calls.length).toBe(2)
  })

  it('register 持续撞 CF 边缘页 → 用满重试额度后失败，且原因是可读的 CF 文案', async () => {
    const calls = mockSequence(() => new Response(CF_EDGE_PAGE, { status: 403 }))
    const r = await activateGlobalRegister('tok', 'u1')
    expect(r.ok).toBe(false)
    expect(r.needsRegion).toBe(false)
    expect(calls.length).toBe(TRANSIENT_RETRY_MAX + 1)
    expect(r.msg).toContain('http 403')
    expect(r.msg).toContain('Cloudflare 边缘拦截页')
    // 关键回归：不再把 HTTP 403 退化成 JSON 语法错
    expect(r.msg).not.toContain('is not valid JSON')
    expect(r.msg).not.toContain('Unexpected token')
  })

  it('trial 首次撞 CF 边缘页 → 重试后领到（不是「trial 失败」）', async () => {
    const calls = mockSequence((_c, n) => {
      if (n === 1) return new Response(CF_EDGE_PAGE, { status: 403 })
      return jsonResp({ code: 0, msg: 'ok' })
    })
    const r = await claimGlobalTrial('tok')
    expect(r).toEqual({ ok: true, already: false, msg: 'ok' })
    expect(calls.length).toBe(2)
  })

  it('活跃上报第 1 条撞 5xx → 该条重试成功，5 条全部发满（不再整轮放弃）', async () => {
    const calls = mockSequence((_c, n) => {
      if (n === 1) return new Response('boom', { status: 500 })
      return jsonResp({ code: 0, msg: 'OK' })
    })
    const r = await reportWorkbuddyChatActivity('tok', 'global', 'u1', {
      count: 5, delay: async () => {},
    })
    expect(r.success).toBe(true)
    expect(r.reported).toBe(5)
    expect(r.message).toContain('成功上报 5 条')
    // 第 1 条重试 1 次 + 其余 4 条各 1 次
    expect(calls.length).toBe(6)
  })

  it('活跃上报持续 5xx → 第 1 条用满重试后停止（不续发剩余条目）', async () => {
    const calls = mockSequence(() => new Response('boom', { status: 500 }))
    const r = await reportWorkbuddyChatActivity('tok', 'global', 'u1', {
      count: 5, delay: async () => {},
    })
    expect(r.success).toBe(false)
    expect(r.reported).toBe(0)
    expect(r.message).toContain('第 1/5 条上报失败')
    expect(calls.length).toBe(TRANSIENT_RETRY_MAX + 1)
  })

  it('网络层抛错（超时/连接失败）→ 重试后仍失败则抛出原错误', async () => {
    let n = 0
    globalThis.fetch = vi.fn(async () => {
      n++
      throw new Error('network down')
    }) as unknown as typeof fetch
    await expect(billingCall('tok', '/v2/report', 'global', { body: [] })).rejects.toThrow('network down')
    expect(n).toBe(TRANSIENT_RETRY_MAX + 1)
  })

  it('网络层抖动 → 重试恢复（原错误不落地）', async () => {
    let n = 0
    globalThis.fetch = vi.fn(async () => {
      n++
      if (n === 1) throw new Error('ECONNRESET')
      return jsonResp({ code: 0, msg: 'ok', data: { v: 1 } })
    }) as unknown as typeof fetch
    await expect(billingCall('tok', '/v2/report', 'global', { body: [] })).resolves.toEqual({ v: 1 })
    expect(n).toBe(2)
  })
})

describe('瞬时重试：明确**不**重试的形态（避免重复副作用 / 破坏路径 fallback）', () => {
  it('带业务信封的 4xx → 不重试（真实业务回复，重发会重复副作用）', async () => {
    const calls = mockSequence(() => jsonResp({ code: 11101, msg: 'bad params' }, 400))
    await expect(billingCall('tok', '/x', 'global', { body: {} })).rejects.toThrow()
    expect(calls.length).toBe(1)
  })

  it('404 → 不重试（billingCall 依赖它做路径 fallback）', async () => {
    const calls = mockSequence(() => new Response('not found', { status: 404 }))
    const paths = ['/billing/meter/a', '/billing/meter/b']
    await expect(billingCall('tok', paths[0], 'global', { paths })).rejects.toThrow()
    expect(calls.length).toBe(2) // 每条候选各一次，无重试
  })

  it('403 带业务信封（11140 request illegal）→ 不重试，按业务错误抛出', async () => {
    const calls = mockSequence(() => jsonResp({ code: 11140, msg: 'request illegal' }, 403))
    await expect(billingCall('tok', '/x', 'global', { body: {} })).rejects.toThrow()
    expect(calls.length).toBe(1)
  })

  it('404 不重试但 5xx 会重试：路径 fallback 仍只在 404 时发生', async () => {
    const calls = mockSequence((_c, n) => {
      if (n <= TRANSIENT_RETRY_MAX + 1) return new Response('boom', { status: 500 })
      return jsonResp({ code: 0, msg: 'ok', data: { ok: true } })
    })
    const paths = ['/billing/meter/a', '/billing/meter/b']
    // 首条候选 5xx 用满重试后抛错 → 不换候选（沿用既有「不掩盖真实故障」语义）
    await expect(billingCall('tok', paths[0], 'global', { paths })).rejects.toThrow()
    expect(calls.every((c) => c.url.includes('/billing/meter/a'))).toBe(true)
    expect(calls.length).toBe(TRANSIENT_RETRY_MAX + 1)
  })
})

// ===== B：失败原因保真（4 个 global web 端点 + growth/billing 出口） =====

describe('失败原因保真：CF 纯文本页不再退化成 JSON 语法错', () => {
  it('fetchIntlCountries：CF 403 → msg 报 http 403 + 边缘拦截', async () => {
    const calls = mockSequence(() => new Response(CF_EDGE_PAGE, { status: 403 }))
    const r = await fetchIntlCountries()
    expect(r.ok).toBe(false)
    expect(r.msg).toContain('http 403')
    expect(r.msg).toContain('Cloudflare 边缘拦截页')
    expect(r.msg).not.toContain('Unexpected token')
    expect(calls.length).toBe(TRANSIENT_RETRY_MAX + 1)
  })

  it('detectUserRegion：CF 403 → msg 报 http 403（不再 JSON 语法错）', async () => {
    mockSequence(() => new Response(CF_EDGE_PAGE, { status: 403 }))
    const r = await detectUserRegion('tok')
    expect(r.ok).toBe(false)
    expect(r.msg).toContain('http 403')
    expect(r.msg).not.toContain('Unexpected token')
  })

  it('submitUserRegion：CF 403 → msg 报 http 403（不再 JSON 语法错）', async () => {
    mockSequence(() => new Response(CF_EDGE_PAGE, { status: 403 }))
    const r = await submitUserRegion('tok', { EnName: 'Singapore', Name: '新加坡', IOS2: 'SG', IOS3: 'SGP', Code: '65' })
    expect(r.ok).toBe(false)
    expect(r.msg).toContain('http 403')
    expect(r.msg).not.toContain('Unexpected token')
  })

  it('claimGlobalTrial：CF 403 → msg 报 http 403 + 边缘拦截（此前只有裸文本）', async () => {
    mockSequence(() => new Response(CF_EDGE_PAGE, { status: 403 }))
    const r = await claimGlobalTrial('tok')
    expect(r.ok).toBe(false)
    expect(r.already).toBe(false)
    expect(r.msg).toContain('http 403')
    expect(r.msg).toContain('Cloudflare 边缘拦截页')
  })

  it('growthCall：CF 403 → 抛出可读原因（含边缘拦截标注）', async () => {
    mockSequence(() => new Response(CF_EDGE_PAGE, { status: 403 }))
    await expect(growthCall('tok', '/activity/growth/streak', 'global', { method: 'GET' }))
      .rejects.toThrow(/http 403.*Cloudflare 边缘拦截页/s)
  })

  it('billingCall：CF 403 → BillingError 带 status=403 且消息可读', async () => {
    mockSequence(() => new Response(CF_EDGE_PAGE, { status: 403 }))
    try {
      await billingCall('tok', '/v2/report', 'global', { body: [] })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(BillingError)
      expect((e as BillingError).status).toBe(403)
      expect((e as BillingError).message).toContain('Cloudflare 边缘拦截页')
    }
  })

  it('HTTP 非 2xx 但 body 是合法业务信封 → **业务语义优先**（register code=500 仍判需补地区）', async () => {
    mockSequence(() => jsonResp({ code: 500, msg: 'region required' }, 500))
    const r = await activateGlobalRegister('tok', 'u1')
    expect(r.needsRegion).toBe(true)
  })
})
