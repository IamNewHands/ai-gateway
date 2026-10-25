import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  billingCall,
  BillingError,
  isGatewayAuthRejection,
  isGatewayAuthPage,
  describeHttpFailure,
  billingMeterPaths,
  __setTransientRetryDelayForTests,
} from './workbuddy-billing'
import { performCheckin } from './checkin'

/**
 * 计费域「网关鉴权拒绝 → 刷新 token → 重试一次」自愈
 * （2026-10-25 线上故障：WorkBuddy 国内版签到固定 401）。
 *
 * 实测形态（本机直接打上游复现，非推测）：
 *   - `www.codebuddy.cn/v2/billing/meter/daily-checkin` 回
 *     `<html><title>401 Authorization Required</title>… Powered by APISIX` —— 纯 HTML，无业务信封；
 *   - 同一条 token 的 JWT **签名有效**（拉 codebuddy.cn 的 JWKS 验过）、`exp` 还剩 22.9 天；
 *   - 同一条 token 打 `copilot.tencent.com/v2/report` 仍返回业务信封（code=10001），
 *     说明 token 未损坏，只是计费域的 Keycloak 会话被吊销；
 *   - Keycloak `userinfo` / `introspect` 均 401（`Authentication failed`）。
 *
 * 结论：网关 401 无法靠「等 expires_at 到期再刷新」自愈（旧实现的临期判定只看 expires_at），
 * 必须在真吃到 401 时就打一次 refresh。这些用例把该行为钉死。
 */

/** 上游 APISIX 网关鉴权拒绝页原文（实测逐字形态）。 */
const APISIX_401_PAGE = `<!DOCTYPE html>
<html>
<head><title>401 Authorization Required</title></head>
<body>
<center><h1>401 Authorization Required</h1></center>
<hr><center>openresty</center>
<p><em>Powered by <a href="https://apisix.apache.org/">APISIX</a>.</em></p>
</body>
</html>`

const originalFetch = globalThis.fetch

function htmlResp(body: string, status: number) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

interface Call { url: string; body: string; auth: string }

function mockSequence(handler: (call: Call, n: number) => Response) {
  const calls: Call[] = []
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
    const headers = (init?.headers || {}) as Record<string, string>
    const call: Call = {
      url: u,
      body: typeof init?.body === 'string' ? init.body : '',
      auth: headers.Authorization || headers.authorization || '',
    }
    calls.push(call)
    return handler(call, calls.length)
  }) as unknown as typeof fetch
  return calls
}

beforeEach(() => {
  vi.restoreAllMocks()
  __setTransientRetryDelayForTests(async () => {})
})
afterEach(() => {
  globalThis.fetch = originalFetch
  __setTransientRetryDelayForTests(null)
})

// ===== 判据纯函数 =====

describe('isGatewayAuthPage：识别 APISIX/openresty 鉴权拒绝页', () => {
  it('实测形态（openresty + APISIX + 401 Authorization Required）→ true', () => {
    expect(isGatewayAuthPage(APISIX_401_PAGE)).toBe(true)
  })

  it('单行压缩形态同样识别（上游可能不换行）', () => {
    expect(isGatewayAuthPage('<html><head><title>401 Authorization Required</title></head><body><center><h1>401 Authorization Required</h1></center><hr><center>openresty</center></body></html>')).toBe(true)
  })

  it('**反例**：业务 401 JSON（有信封）→ false，不得当成网关页', () => {
    expect(isGatewayAuthPage('{"code":12153,"msg":"Offline user session not found"}')).toBe(false)
  })

  it('**反例**：普通 HTML 错误页但无 APISIX/openresty 标记 → false', () => {
    expect(isGatewayAuthPage('<html><head><title>500 Internal Server Error</title></head></html>')).toBe(false)
  })

  it('**反例**：文案里提到 apisix 但状态不是 401 → false（避免误伤业务文案）', () => {
    expect(isGatewayAuthPage('your request was routed via apisix but quota exceeded')).toBe(false)
  })

  it('空串 → false', () => {
    expect(isGatewayAuthPage('')).toBe(false)
  })
})

describe('describeHttpFailure：网关 401 给出可执行文案', () => {
  it('APISIX 401 → 文案含「需重新登录」，不再只吐 HTML 原文', () => {
    const msg = describeHttpFailure(401, APISIX_401_PAGE, '/v2/billing/meter/daily-checkin')
    expect(msg).toContain('http 401')
    expect(msg).toContain('/v2/billing/meter/daily-checkin')
    expect(msg).toContain('需重新登录')
    expect(msg).toContain('APISIX')
    // 关键：不能再把整段 HTML 塞进面板
    expect(msg).not.toContain('<html>')
  })

  it('普通业务 4xx 文本保持原有逐字拼写（幂等文案匹配依赖它）', () => {
    expect(describeHttpFailure(400, '今天已签到', '/x')).toBe('http 400 /x: 今天已签到')
  })

  it('CF 边缘页仍优先识别（两套判据不互相覆盖）', () => {
    expect(describeHttpFailure(403, 'error code: 1002', '/y')).toContain('Cloudflare 边缘拦截页')
  })
})

describe('isGatewayAuthRejection：只有「无业务信封的 401/403」才算网关拒绝', () => {
  it('401 + code=null（HTML 页）→ true', () => {
    expect(isGatewayAuthRejection(new BillingError('x', { code: null, status: 401 }))).toBe(true)
  })

  it('403 + code=null（WAF 页）→ true', () => {
    expect(isGatewayAuthRejection(new BillingError('x', { code: null, status: 403 }))).toBe(true)
  })

  it('**反例**：401 但带业务码（会话死亡 12153）→ false，走既有 session_dead 策略', () => {
    expect(isGatewayAuthRejection(new BillingError('x', { code: 12153, status: 401 }))).toBe(false)
  })

  it('**反例**：403 + 业务码 10085（非法请求）→ false，刷新 token 无用', () => {
    expect(isGatewayAuthRejection(new BillingError('x', { code: 10085, status: 403 }))).toBe(false)
  })

  it('**反例**：5xx / 裸 Error → false', () => {
    expect(isGatewayAuthRejection(new BillingError('x', { code: null, status: 502 }))).toBe(false)
    expect(isGatewayAuthRejection(new Error('boom'))).toBe(false)
    expect(isGatewayAuthRejection(null)).toBe(false)
  })
})

// ===== billingCall 的刷新重试 =====

describe('billingCall：网关 401 → 刷新 token → 原地重试一次', () => {
  const PATH = '/v2/billing/meter/daily-checkin'

  it('首次 401（APISIX 页）→ 刷新拿到新 token → 用新 token 重试成功', async () => {
    const calls = mockSequence((call, n) => {
      if (n === 1) return htmlResp(APISIX_401_PAGE, 401)
      return jsonResp({ code: 0, msg: 'ok', data: { credit: 50 } })
    })
    let refreshCount = 0
    const data = await billingCall('old-token', PATH, 'cn', {
      onAuthRejected: async () => { refreshCount++; return 'new-token' },
    })
    expect(data).toEqual({ credit: 50 })
    expect(refreshCount).toBe(1)
    expect(calls.length).toBe(2)
    // 第二次请求必须带**新** token（否则重试等于白打）
    expect(calls[0].auth).toBe('Bearer old-token')
    expect(calls[1].auth).toBe('Bearer new-token')
  })

  it('刷新失败（返回 null）→ 抛原始鉴权错误，且文案已可读（不吞成网络错误）', async () => {
    mockSequence(() => htmlResp(APISIX_401_PAGE, 401))
    let refreshCount = 0
    await expect(billingCall('old-token', PATH, 'cn', {
      onAuthRejected: async () => { refreshCount++; return null },
    })).rejects.toMatchObject({ name: 'BillingError', status: 401 })
    expect(refreshCount).toBe(1)
  })

  it('刷新返回与旧 token 相同的值 → 不重试（避免打无意义的重复请求）', async () => {
    const calls = mockSequence(() => htmlResp(APISIX_401_PAGE, 401))
    await expect(billingCall('same-token', PATH, 'cn', {
      onAuthRejected: async () => 'same-token',
    })).rejects.toMatchObject({ status: 401 })
    expect(calls.length).toBe(1)
  })

  it('刷新后再 401 → **不再刷新第二次**（refresh 是凭据轮换，不能成风暴）', async () => {
    const calls = mockSequence(() => htmlResp(APISIX_401_PAGE, 401))
    let refreshCount = 0
    await expect(billingCall('old-token', PATH, 'cn', {
      onAuthRejected: async () => { refreshCount++; return 'new-token-' + refreshCount },
    })).rejects.toMatchObject({ status: 401 })
    expect(refreshCount).toBe(1)
    expect(calls.length).toBe(2)
  })

  it('钩子自身抛错 → 视为刷新失败，仍抛原始 401（钩子异常不得掩盖鉴权事实）', async () => {
    mockSequence(() => htmlResp(APISIX_401_PAGE, 401))
    await expect(billingCall('old-token', PATH, 'cn', {
      onAuthRejected: async () => { throw new Error('refresh endpoint exploded') },
    })).rejects.toMatchObject({ status: 401 })
  })

  it('不传钩子 → 行为完全不变（零回归：直接抛 401）', async () => {
    const calls = mockSequence(() => htmlResp(APISIX_401_PAGE, 401))
    await expect(billingCall('tok', PATH, 'cn')).rejects.toMatchObject({ status: 401 })
    expect(calls.length).toBe(1)
  })

  it('业务码 401（12153 会话死亡）→ **不触发**刷新（有专门策略，交给调用方）', async () => {
    const calls = mockSequence(() => jsonResp({ code: 12153, msg: 'Offline user session not found' }, 401))
    let refreshCount = 0
    await expect(billingCall('tok', PATH, 'cn', {
      onAuthRejected: async () => { refreshCount++; return 'new-token' },
    })).rejects.toMatchObject({ status: 401 })
    expect(refreshCount).toBe(0)
    expect(calls.length).toBe(1)
  })

  it('global 域：首条路径 401 刷新后重试成功，不再走 404 fallback（顺序正确）', async () => {
    const paths = billingMeterPaths('daily-checkin', 'global')
    const calls = mockSequence((call, n) => {
      if (n === 1) return htmlResp(APISIX_401_PAGE, 401)
      return jsonResp({ code: 0, msg: 'ok', data: {} })
    })
    await billingCall('old', paths[0], 'global', {
      paths,
      onAuthRejected: async () => 'new',
    })
    // 两条调用都在**第一条**候选路径上（刷新重试不应把请求挪到 fallback 路径）
    expect(calls.length).toBe(2)
    expect(calls[0].url).toContain('/billing/meter/daily-checkin')
    expect(calls[0].url).not.toContain('/v2/')
    expect(calls[1].url).toBe(calls[0].url)
  })

  it('404 仍按原语义换下一条候选（刷新逻辑不干扰路径 fallback）', async () => {
    const paths = billingMeterPaths('daily-checkin', 'global')
    const calls = mockSequence((call) => {
      if (!call.url.includes('/v2/')) return jsonResp({ error_msg: '404 Route Not Found' }, 404)
      return jsonResp({ code: 0, msg: 'ok', data: { ok: 1 } })
    })
    let refreshCount = 0
    const data = await billingCall('tok', paths[0], 'global', {
      paths,
      onAuthRejected: async () => { refreshCount++; return 'new' },
    })
    expect(data).toEqual({ ok: 1 })
    expect(refreshCount).toBe(0)
    expect(calls.length).toBe(2)
  })
})

// ===== performCheckin 接线 =====

describe('performCheckin：把自救钩子接到 daily-checkin', () => {
  it('首次 401 → 刷新 → 重试成功，结果为「签到成功」', async () => {
    mockSequence((call, n) => {
      if (n === 1) return htmlResp(APISIX_401_PAGE, 401)
      return jsonResp({ code: 0, msg: 'ok', data: { credit: 30 } })
    })
    let refreshCount = 0
    const res = await performCheckin('old', 'cn', undefined, {
      onAuthRejected: async () => { refreshCount++; return 'new' },
    })
    expect(res.success).toBe(true)
    expect(res.message).toBe('签到成功')
    expect(refreshCount).toBe(1)
  })

  it('刷新也救不回来 → success=false，文案含「需重新登录」', async () => {
    mockSequence(() => htmlResp(APISIX_401_PAGE, 401))
    const res = await performCheckin('old', 'cn', undefined, {
      onAuthRejected: async () => null,
    })
    expect(res.success).toBe(false)
    expect(res.message).toContain('需重新登录')
  })

  it('不传钩子 → 仍是旧行为（401 判失败，文案已可读）', async () => {
    mockSequence(() => htmlResp(APISIX_401_PAGE, 401))
    const res = await performCheckin('old', 'cn')
    expect(res.success).toBe(false)
    expect(res.message).toContain('需重新登录')
  })

  it('**回归**：业务码 10001 仍判「今日已签到」（幂等语义未被网关判据污染）', async () => {
    mockSequence(() => jsonResp({ code: 10001, msg: '今天已签到' }))
    let refreshCount = 0
    const res = await performCheckin('tok', 'cn', undefined, {
      onAuthRejected: async () => { refreshCount++; return 'new' },
    })
    expect(res.success).toBe(true)
    expect(res.already).toBe(true)
    expect(refreshCount).toBe(0)
  })
})
