import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  fetchIntlCountries,
  detectUserRegion,
  submitUserRegion,
  activateGlobalRegister,
  claimGlobalTrial,
  completeGlobalRegionFlow,
  GLOBAL_BASE,
  INTL_REGION_CODES,
  TRIAL_ALREADY_CODE,
  type RegionCountry,
} from './workbuddy-billing'

/**
 * 国际版注册激活 / 地区完善 / trial 加油包测试
 * （移植 workbuddy2api internal/upstream/trial.go + scripts/global_region.py）。
 */

const originalFetch = globalThis.fetch

interface Call { url: string; method: string; headers: Record<string, string>; body: string }

function mockFetch(handler: (call: Call) => Response) {
  const calls: Call[] = []
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
    const h: Record<string, string> = {}
    const raw = (init?.headers || {}) as Record<string, string>
    for (const k of Object.keys(raw)) h[k.toLowerCase()] = String(raw[k])
    const call: Call = { url: u, method: init?.method || 'GET', headers: h, body: typeof init?.body === 'string' ? init.body : '' }
    calls.push(call)
    return handler(call)
  }) as unknown as typeof fetch
  return calls
}

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => { vi.restoreAllMocks() })
afterEach(() => { globalThis.fetch = originalFetch })

describe('claimGlobalTrial（trial 加油包，仅 global）', () => {
  it('code=0 → 成功新领', async () => {
    const calls = mockFetch(() => jsonResp({ code: 0, msg: 'ok' }))
    const r = await claimGlobalTrial('tok')
    expect(r).toEqual({ ok: true, already: false, msg: 'ok' })
    expect(calls[0].url).toBe(GLOBAL_BASE + '/billing/ide/trial')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].headers['authorization']).toBe('Bearer tok')
    // 浏览器 UA（global web 域实测要求）
    expect(calls[0].headers['user-agent']).toContain('Mozilla/5.0')
  })

  it('幂等：HTTP 200 + code=14051 → already（视为正常，非错误）', async () => {
    mockFetch(() => jsonResp({ code: TRIAL_ALREADY_CODE, msg: '已领取过' }))
    const r = await claimGlobalTrial('tok')
    expect(r.ok).toBe(true)
    expect(r.already).toBe(true)
  })

  it('幂等：HTTP 4xx + body 含 14051 → already（两种拼写都覆盖）', async () => {
    // 源实现 trialAlreadyMarkers: "code=14051" 与 `"code":14051`
    mockFetch(() => new Response('{"error":{"code":14051}}', { status: 409 }))
    const r = await claimGlobalTrial('tok')
    expect(r.ok).toBe(true)
    expect(r.already).toBe(true)
  })

  it('其他业务错误 → ok=false', async () => {
    mockFetch(() => jsonResp({ code: 11101, msg: 'bad params' }))
    const r = await claimGlobalTrial('tok')
    expect(r.ok).toBe(false)
    expect(r.already).toBe(false)
  })

  it('HTTP 4xx 且非 JSON → 报 http 状态（不误判为幂等）', async () => {
    mockFetch(() => new Response('<html>forbidden</html>', { status: 403 }))
    const r = await claimGlobalTrial('tok')
    expect(r.ok).toBe(false)
    expect(r.msg).toContain('http 403')
  })

  it('网络异常 → ok=false（不抛错）', async () => {
    mockFetch(() => { throw new Error('network down') })
    const r = await claimGlobalTrial('tok')
    expect(r.ok).toBe(false)
    expect(r.msg).toContain('network down')
  })
})

describe('fetchIntlCountries（地区列表）', () => {
  it('解析嵌套 JSON 字符串并按国际版白名单过滤', async () => {
    // 上游 data 是 JSON **字符串**（需二次解析）
    const inner = JSON.stringify({
      code: 0,
      data: { list: [
        { EnName: 'Singapore', Name: '新加坡', IOS2: 'SG', IOS3: 'SGP', Code: '65' },
        { EnName: 'China', Name: '中国', IOS2: 'CN', IOS3: 'CHN', Code: '86' },
        { EnName: 'Hong Kong', Name: '香港', IOS2: 'HK', IOS3: 'HKG', Code: '852' },
      ] },
    })
    mockFetch(() => jsonResp({ code: 0, msg: 'ok', data: inner }))

    const r = await fetchIntlCountries(true)
    expect(r.ok).toBe(true)
    // CN 被白名单过滤掉
    expect(r.list.map((c) => c.IOS2)).toEqual(['HK', 'SG'])
  })

  it('intlOnly=false 返回全量', async () => {
    const inner = JSON.stringify({ code: 0, data: { list: [
      { EnName: 'China', Name: '中国', IOS2: 'CN', IOS3: 'CHN', Code: '86' },
    ] } })
    mockFetch(() => jsonResp({ code: 0, msg: 'ok', data: inner }))
    const r = await fetchIntlCountries(false)
    expect(r.list.length).toBe(1)
  })

  it('白名单顺序按 INTL_REGION_CODES（web 展示顺序）', async () => {
    const inner = JSON.stringify({ code: 0, data: { list: [
      { EnName: 'Thailand', Name: '泰国', IOS2: 'TH', IOS3: 'THA', Code: '66' },
      { EnName: 'Hong Kong', Name: '香港', IOS2: 'HK', IOS3: 'HKG', Code: '852' },
      { EnName: 'Singapore', Name: '新加坡', IOS2: 'SG', IOS3: 'SGP', Code: '65' },
    ] } })
    mockFetch(() => jsonResp({ code: 0, msg: 'ok', data: inner }))
    const r = await fetchIntlCountries(true)
    expect(r.list.map((c) => c.IOS2)).toEqual(['HK', 'SG', 'TH'])
    expect(INTL_REGION_CODES.slice(0, 3)).toEqual(['HK', 'MO', 'SG'])
  })

  it('外层 code != 0 → ok=false', async () => {
    mockFetch(() => jsonResp({ code: 500, msg: 'boom' }))
    const r = await fetchIntlCountries()
    expect(r.ok).toBe(false)
    expect(r.msg).toBe('boom')
  })

  it('网络异常 → ok=false（不抛错）', async () => {
    mockFetch(() => { throw new Error('timeout') })
    const r = await fetchIntlCountries()
    expect(r.ok).toBe(false)
  })
})

describe('detectUserRegion（检测当前地区）', () => {
  it('解析嵌套 data 的 IOS2/enName', async () => {
    const inner = JSON.stringify({ code: 0, data: { IOS2: 'SG', enName: 'Singapore' } })
    mockFetch(() => jsonResp({ code: 0, msg: 'ok', data: inner }))
    const r = await detectUserRegion('tok')
    expect(r).toEqual({ ok: true, ios2: 'SG', enName: 'Singapore', msg: 'ok' })
  })

  it('失败 → ok=false', async () => {
    mockFetch(() => jsonResp({ code: 1, msg: 'nope' }))
    const r = await detectUserRegion('tok')
    expect(r.ok).toBe(false)
  })
})

describe('submitUserRegion（提交地区）', () => {
  const sg: RegionCountry = { EnName: 'Singapore', Name: '新加坡', IOS2: 'SG', IOS3: 'SGP', Code: '65' }

  it('构造 attributes 三字段并提交', async () => {
    const calls = mockFetch(() => jsonResp({ code: 0 }))
    const r = await submitUserRegion('tok', sg)
    expect(r.ok).toBe(true)
    expect(calls[0].url).toBe(GLOBAL_BASE + '/console/login/account')
    const body = JSON.parse(calls[0].body)
    expect(body.attributes).toEqual({
      countryCode: ['65'],
      countryFullName: ['Singapore'],
      countryName: ['SG'],
    })
  })

  it('业务失败 → ok=false 含 msg', async () => {
    mockFetch(() => jsonResp({ code: 400, msg: 'invalid' }))
    const r = await submitUserRegion('tok', sg)
    expect(r.ok).toBe(false)
    expect(r.msg).toBe('invalid')
  })
})

describe('activateGlobalRegister（注册激活，三态）', () => {
  it('code=200 → 已激活', async () => {
    const calls = mockFetch(() => jsonResp({ code: 200 }))
    const r = await activateGlobalRegister('tok', 'u1')
    expect(r).toEqual({ ok: true, needsRegion: false, msg: 'register success' })
    // 携带 X-User-Id（与官方 web 对齐）
    expect(calls[0].headers['x-user-id']).toBe('u1')
    expect(calls[0].url).toContain('userId=u1')
  })

  it('code=500 → needsRegion=true', async () => {
    mockFetch(() => jsonResp({ code: 500, msg: 'error' }))
    const r = await activateGlobalRegister('tok', 'u1')
    expect(r.ok).toBe(false)
    expect(r.needsRegion).toBe(true)
  })

  it('msg 含 "region required" → needsRegion=true（即便 code 非 500）', async () => {
    mockFetch(() => jsonResp({ code: 400, msg: 'Region Required for this account' }))
    const r = await activateGlobalRegister('tok', 'u1')
    expect(r.needsRegion).toBe(true)
  })

  it('其他失败 → needsRegion=false（不盲目提交地区）', async () => {
    mockFetch(() => jsonResp({ code: 401, msg: 'unauthorized' }))
    const r = await activateGlobalRegister('tok', 'u1')
    expect(r.ok).toBe(false)
    expect(r.needsRegion).toBe(false)
  })

  it('uid 做 URL 编码', async () => {
    const calls = mockFetch(() => jsonResp({ code: 200 }))
    await activateGlobalRegister('tok', 'u/1 x')
    expect(calls[0].url).toContain('userId=u%2F1%20x')
  })
})

describe('completeGlobalRegionFlow（整体完善流程）', () => {
  const sg: RegionCountry = { EnName: 'Singapore', Name: '新加坡', IOS2: 'SG', IOS3: 'SGP', Code: '65' }

  it('已激活 → 直接成功，不提交地区', async () => {
    const calls = mockFetch(() => jsonResp({ code: 200 }))
    const r = await completeGlobalRegionFlow('tok', 'u1', sg)
    expect(r.ok).toBe(true)
    expect(calls.length).toBe(1)
  })

  it('需补地区 → 提交后重新 register 验证成功', async () => {
    let n = 0
    const calls = mockFetch(() => {
      n++
      if (n === 1) return jsonResp({ code: 500, msg: 'region required' })
      if (n === 2) return jsonResp({ code: 0 })          // submit region
      return jsonResp({ code: 200 })                     // 重新 register 成功
    })
    const r = await completeGlobalRegionFlow('tok', 'u1', sg)
    expect(r.ok).toBe(true)
    expect(r.msg).toContain('地区已完善')
    expect(calls.length).toBe(3)
  })

  it('需补地区但未提供选择 → 失败（需人工选择）', async () => {
    mockFetch(() => jsonResp({ code: 500, msg: 'region required' }))
    const r = await completeGlobalRegionFlow('tok', 'u1')
    expect(r.ok).toBe(false)
    expect(r.msg).toContain('未提供选择')
  })

  it('提交地区失败 → 失败含原因', async () => {
    let n = 0
    mockFetch(() => {
      n++
      if (n === 1) return jsonResp({ code: 500, msg: 'region required' })
      return jsonResp({ code: 400, msg: 'invalid country' })
    })
    const r = await completeGlobalRegionFlow('tok', 'u1', sg)
    expect(r.ok).toBe(false)
    expect(r.msg).toContain('提交地区失败')
  })

  it('提交后 register 仍失败 → 失败含 needs_region 状态', async () => {
    let n = 0
    mockFetch(() => {
      n++
      if (n === 1) return jsonResp({ code: 500, msg: 'region required' })
      if (n === 2) return jsonResp({ code: 0 })
      return jsonResp({ code: 500, msg: 'region required' })
    })
    const r = await completeGlobalRegionFlow('tok', 'u1', sg)
    expect(r.ok).toBe(false)
    expect(r.msg).toContain('needs_region=true')
  })

  it('非"需补地区"的 register 失败 → 不提交地区', async () => {
    const calls = mockFetch(() => jsonResp({ code: 401, msg: 'unauthorized' }))
    const r = await completeGlobalRegionFlow('tok', 'u1', sg)
    expect(r.ok).toBe(false)
    expect(r.msg).toContain('register 失败')
    expect(calls.length).toBe(1)
  })
})
