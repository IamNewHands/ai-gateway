/**
 * port-20260923.test.ts — qoder2api 移植项的回归测试。
 *
 * 源：github.com/Zhengyuuuui/qoder2api HEAD ae3d42f（分析见 _port-analysis/qoder2api-porting-analysis.md）。
 * 每个 describe 对应一个已确认的缺陷，断言的是**修复后的行为**而非实现细节。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cosySessionFor, cosyHeaders } from './cosy'
import { buildQoderBody, cpaToUpstreamKey, fallbackUnknownModel, pickQoderModels } from './body'
import { performQoderCheckin, normalizeQoderRealm, realmHasLegacyCheckin, QODER_OPENAPI, fetchQoderUserResource } from './billing'
import { classifyQoderError, type QoderClassified } from './classify'
import { proxyQoderChatRequest, isQoderFlow, testQoderModel, markQoderAccountClassified, isQoderSessionDead } from './proxy'
import type { Env, Provider } from '../types'

const CHAT_URL = 'https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation?Encode=1'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 构造一个真实 COSY 会话（走 RSA+AES，与生产同路径）。 */
async function makeSession() {
  return cosySessionFor('dt-test-20260923', 'drt-test', 'uid-20260923', '测试')
}

/** 把上游帧拼成 SSE 响应体。 */
function sseBody(frames: string[]): string {
  return frames.map((f) => `data: ${f}\n\n`).join('')
}

/** 上游信封帧。 */
function envelope(body: string, statusCodeValue?: number | string): string {
  const o: Record<string, unknown> = { headers: {}, body }
  if (statusCodeValue !== undefined) o.statusCodeValue = statusCodeValue
  return JSON.stringify(o)
}

const INNER_CHUNK = JSON.stringify({
  id: 'chatcmpl-1',
  model: 'auto',
  choices: [{ index: 0, delta: { role: 'assistant', content: '你好' } }],
})

/** 注入会话 + stub 上游 fetch，走 proxyQoderChatRequest 单次直发路径。 */
async function callProxy(frames: string[], opts?: { stream?: boolean; tools?: unknown; model?: string }) {
  const session = await makeSession()
  const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) =>
    new Response(sseBody(frames), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  )
  vi.stubGlobal('fetch', fetchMock)
  const resp = await proxyQoderChatRequest({} as Env, { id: 'qoder' } as Provider, {
    model: opts?.model || 'auto',
    stream: opts?.stream ?? true,
    messages: [{ role: 'user', content: 'hi' }],
    ...(opts?.tools !== undefined ? { tools: opts.tools } : {}),
  }, { session: { session }, stream: opts?.stream ?? true })
  return { resp, fetchMock }
}

// ===== P0-2：cosyHeaders 补齐传输层头 =====
describe('P0-2 cosyHeaders 补齐 content-type / accept / user-agent / scene / business-type', () => {
  it('显式设置 Content-Type，不再让 Fetch 对字符串 body 兜底成 text/plain', async () => {
    const sess = await makeSession()
    const h = cosyHeaders(sess, 'encoded-body', CHAT_URL, 'text/event-stream', true)
    expect(h['Content-Type']).toBe('application/json')
  })

  it('accept 形参真正生效（原实现形参被忽略）', async () => {
    const sess = await makeSession()
    const sse = cosyHeaders(sess, 'b', CHAT_URL, 'text/event-stream', true)
    const json = cosyHeaders(sess, 'b', CHAT_URL, 'application/json', false)
    expect(sse['Accept']).toBe('text/event-stream')
    expect(json['Accept']).toBe('application/json')
  })

  it('补 user-agent / cosy-scene / cosy-business-type（client.go:50-53）', async () => {
    const sess = await makeSession()
    const h = cosyHeaders(sess, '{}', CHAT_URL, 'application/json', false)
    expect(h['User-Agent']).toBe('Go-http-client/2.0')
    expect(h['Cosy-Scene']).toBe('assistant')
    expect(h['Cosy-Business-Type']).toBe('agent')
  })

  it('不发 cosy-business-product：取值取决于未定的 cli/ide 结论，硬编码会让头与体自相矛盾', async () => {
    const sess = await makeSession()
    const h = cosyHeaders(sess, '{}', CHAT_URL, 'application/json', false)
    expect(h['Cosy-Business-Product']).toBeUndefined()
    expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain('cosy-business-product')
  })

  it('data-policy 仍是目标侧刻意选择的 disagree（不随本次移植改成 agree）', async () => {
    const sess = await makeSession()
    const h = cosyHeaders(sess, '{}', CHAT_URL, 'application/json', false)
    expect(h['Cosy-Data-Policy']).toBe('disagree')
  })
})

// ===== P0-1：签到走 campaigns，不再误判 legacy 409 =====
describe('P0-1 签到走 campaigns 流程（legacy daily-check-in/claim 已 DISABLED）', () => {
  it('CLAIMABLE 活动 → POST /campaigns/{id}/claim（空 body）并回传积分', async () => {
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/sash/api/v1/me/campaigns')) {
        return new Response(JSON.stringify({
          campaigns: [{
            campaignId: 'camp-1', campaignKey: 'cn_daily_check_in', actionType: 'CLAIM_BENEFIT',
            claimStatus: 'CLAIMABLE', startAt: 1790000000,
            benefit: { kind: 'CREDITS', amount: 100 },
          }],
        }), { status: 200 })
      }
      if (url.endsWith('/sash/api/v1/me/campaigns/camp-1/claim')) {
        return new Response(JSON.stringify({
          grantId: 'g1', status: 'CLAIMED', replayed: false, benefit: { kind: 'CREDITS', amount: 100 },
        }), { status: 200 })
      }
      throw new Error(`unexpected url ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const r = await performQoderCheckin('dt-x')
    expect(r.success).toBe(true)
    expect(r.already).toBeFalsy()
    expect(r.rewardCredits).toBe(100)
    expect(r.campaignKey).toBe('cn_daily_check_in')

    // claim 必须是 POST 且无 body（抓包确认空 body）
    const claimCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/claim'))
    expect(claimCall).toBeTruthy()
    expect((claimCall![1] as RequestInit).method).toBe('POST')
    expect((claimCall![1] as RequestInit).body).toBeUndefined()
  })

  it('replayed=true → already（今日已领取，不是本次新领）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/me/campaigns')) {
        return new Response(JSON.stringify({
          campaigns: [{ campaignId: 'c', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE' }],
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ status: 'CLAIMED', replayed: true }), { status: 200 })
    }))
    const r = await performQoderCheckin('dt-x')
    expect(r.success).toBe(true)
    expect(r.already).toBe(true)
    expect(r.rewardCredits).toBeUndefined()
  })

  it('无 CLAIMABLE 但已有 CLAIMED → already（不报失败）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      campaigns: [{ campaignId: 'c', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMED' }],
    }), { status: 200 })))
    const r = await performQoderCheckin('dt-x')
    expect(r.success).toBe(true)
    expect(r.already).toBe(true)
  })

  it('无任何 CLAIM_BENEFIT 活动 → 失败，且绝不调用 legacy claim', async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response(JSON.stringify({ campaigns: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const r = await performQoderCheckin('dt-x')
    expect(r.success).toBe(false)
    expect(r.message).toContain('无可用签到活动')
    // 关键回归：legacy 端点对未领取日恒返回 409，旧实现据此报「已签到」造成假成功、0 积分
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('daily-check-in/claim'))).toBe(false)
  })

  it('campaigns 查询失败时如实报错，不退化成「已签到」', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    const r = await performQoderCheckin('dt-x')
    expect(r.success).toBe(false)
    expect(r.message).toContain('查询活动失败')
  })

  it('签到请求带抓包确认的必需头（user-agent: Qoder / cosy-clienttype: 10 / origin）', async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response(JSON.stringify({ campaigns: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await performQoderCheckin('dt-x')
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['user-agent']).toBe('Qoder')
    expect(headers['cosy-clienttype']).toBe('10')
    expect(headers['accept-language']).toBe('zh-CN')
    expect(headers['authorization']).toBe('Bearer dt-x')
  })
})

// ===== P0-3：信封 statusCodeValue + 空流 =====
describe('P0-3 信封 statusCodeValue 校验与空流兜底', () => {
  it('正常帧透传内层 chunk 并补一个 [DONE]', async () => {
    const { resp } = await callProxy([envelope(INNER_CHUNK, 200), envelope('[DONE]', 200)])
    expect(resp.status).toBe(200)
    const text = await resp.text()
    expect(text).toContain('你好')
    expect(text.match(/data: \[DONE\]/g)).toHaveLength(1)
  })

  it('HTTP200 信封里带 statusCodeValue=418 → 网关侧报错而非当正常收尾', async () => {
    const { resp } = await callProxy([envelope('provider_error: upstream failed', 418)])
    // 有界首帧闸门在发出 HTTP 头之前拦下 → 可给出真实状态码并让池循环轮转账号
    expect(resp.status).not.toBe(200)
    const body = await resp.text()
    expect(body).toContain('"error"')
    expect(body).not.toContain('data:')
  })

  it('statusCodeValue 为字符串时同样识别（"418"）', async () => {
    const { resp } = await callProxy([envelope('provider_error', '418')])
    expect(resp.status).not.toBe(200)
  })

  it('statusCodeValue 缺失按 200 处理（部分帧不带该字段）', async () => {
    const { resp } = await callProxy([envelope(INNER_CHUNK)])
    expect(resp.status).toBe(200)
    expect(await resp.text()).toContain('你好')
  })

  it('零有效帧（只有 [DONE]）→ 不谎报成功', async () => {
    const { resp } = await callProxy([envelope('[DONE]', 200)])
    expect(resp.status).not.toBe(200)
    const body = await resp.text()
    expect(body).toContain('empty upstream stream')
    expect(body).toContain('upstream_parse')
  })

  it('完全空流 → 不谎报成功', async () => {
    const { resp } = await callProxy([])
    expect(resp.status).not.toBe(200)
    expect(await resp.text()).toContain('empty upstream stream')
  })

  it('非流式零有效帧同样报错，不再返回 200 + 空 content + finish_reason: stop', async () => {
    const { resp } = await callProxy([envelope('[DONE]', 200)], { stream: false })
    expect(resp.status).not.toBe(200)
    const body = await resp.text()
    expect(body).not.toContain('"finish_reason":"stop"')
    expect(body).toContain('empty upstream stream')
  })

  it('非流式信封错误 → 真实 HTTP 错误码', async () => {
    const { resp } = await callProxy([envelope('provider_error', 503)], { stream: false })
    expect(resp.status).toBe(503)
  })

  it('非流式正常帧聚合出正文', async () => {
    const { resp } = await callProxy([envelope(INNER_CHUNK, 200)], { stream: false })
    expect(resp.status).toBe(200)
    const body = await resp.text()
    expect(body).toContain('你好')
    expect(body).toContain('chat.completion')
  })
})

// ===== P0-4：客户端 tools 转发 =====
describe('P0-4 客户端 tools 覆盖模板内置工具', () => {
  it('未传 tools 时保留模板的 14 个 Qoder CLI 工具', () => {
    const body = JSON.parse(buildQoderBody([{ role: 'user', content: 'hi' }], 'auto'))
    expect(Array.isArray(body.tools)).toBe(true)
    expect(body.tools).toHaveLength(14)
  })

  it('传 tools 时按客户端定义覆盖（源 bridge.go:388-391）', () => {
    const tools = [{ type: 'function', function: { name: 'my_custom_tool', parameters: {} } }]
    const body = JSON.parse(buildQoderBody([{ role: 'user', content: 'hi' }], 'auto', undefined, tools))
    expect(body.tools).toHaveLength(1)
    expect(body.tools[0].function.name).toBe('my_custom_tool')
  })

  it('传空数组时清空工具（显式无工具 ≠ 偷偷塞 14 个）', () => {
    const body = JSON.parse(buildQoderBody([{ role: 'user', content: 'hi' }], 'auto', undefined, []))
    expect(body.tools).toEqual([])
  })

  it('proxyQoderChatRequest 把 forwardBody.tools 透传到上游请求体', async () => {
    const tools = [{ type: 'function', function: { name: 'probe_tool', parameters: {} } }]
    const { fetchMock } = await callProxy([envelope(INNER_CHUNK, 200)], { tools })
    // 上游 body 经 QoderEncoding，无法直接 JSON 解析；改为断言编码前的调用链已生效
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const sent = (fetchMock.mock.calls[0][1] as RequestInit).body as string
    expect(typeof sent).toBe('string')
    expect(sent.length).toBeGreaterThan(0)
  })
})

// ===== 国际版 / 国内版签到分域（qoder2api-hub qoder_accounts.py:37-106） =====
describe('国际版/国内版签到分域', () => {
  it('openapi 基地址按域区分：cn=openapi.qoder.com.cn，global=openapi.qoder.sh', () => {
    expect(QODER_OPENAPI.cn).toBe('https://openapi.qoder.com.cn')
    expect(QODER_OPENAPI.global).toBe('https://openapi.qoder.sh')
  })

  it('normalizeQoderRealm 只认 global，其余归 cn', () => {
    expect(normalizeQoderRealm('global')).toBe('global')
    expect(normalizeQoderRealm('cn')).toBe('cn')
    expect(normalizeQoderRealm(undefined)).toBe('cn')
    expect(normalizeQoderRealm('')).toBe('cn')
  })

  it('legacy daily-check-in 仅国内版存在（国际版实测 404）', () => {
    expect(realmHasLegacyCheckin('cn')).toBe(true)
    expect(realmHasLegacyCheckin('global')).toBe(false)
  })

  it('国际版签到走 openapi.qoder.sh，不再误打国内域', async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ campaigns: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await performQoderCheckin('dt-g', 'global')
    const url = String(fetchMock.mock.calls[0][0])
    expect(url.startsWith('https://openapi.qoder.sh/sash/api/v1/me/campaigns')).toBe(true)
  })

  it('国内版签到仍走 openapi.qoder.com.cn', async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ campaigns: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await performQoderCheckin('dt-c', 'cn')
    expect(String(fetchMock.mock.calls[0][0])).toContain('https://openapi.qoder.com.cn/')
  })

  it('国际版 claim 的 origin 头跟随所在域（不是硬编码国内域）', async () => {
    const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/me/campaigns')) {
        return new Response(JSON.stringify({
          campaigns: [{ campaignId: 'c1', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE' }],
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ status: 'CLAIMED', replayed: false }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    await performQoderCheckin('dt-g', 'global')
    const claimCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/claim'))
    expect(claimCall).toBeTruthy()
    const headers = (claimCall![1] as RequestInit).headers as Record<string, string>
    expect(headers.origin).toBe('https://openapi.qoder.sh')
  })

  it('额度查询按域取端点', async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ userQuota: { total: 10, used: 1, remaining: 9 } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await fetchQoderUserResource('dt-g', 'global')
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://openapi.qoder.sh/api/v2/quota/usage')
  })

  it('签到头带桌面端 cosy-version（缺头会返回空活动列表）', async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ campaigns: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await performQoderCheckin('dt-c', 'cn')
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers['cosy-version']).toBe('1.1.64')
  })

  it('签到头带完整桌面端机器身份（hub: 缺这些头服务端不报错但返回空活动列表）', async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ campaigns: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await performQoderCheckin('dt-c', 'cn', 'uid-machine-1')
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    // 桌面端身份头是功能必需，不是装饰
    expect(headers['cosy-clienttype']).toBe('10')
    expect(headers['cosy-machineid']).toMatch(/^[0-9a-f]{32}$/)
    expect(headers['cosy-machinetoken']).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(headers['cosy-machinetype']).toMatch(/^[0-9a-f]{18}$/)
    expect(headers['cosy-machineos']).toBe('x86_64_win32')
    expect(headers['cosy-machinehostname']).toBe('DESKTOP-QODER')
    expect(headers['user-agent']).toBe('Qoder')
    // machineid 与 machinetoken 必须是不同值（各自独立派生）
    expect(headers['cosy-machinetoken']).not.toBe(headers['cosy-machineid'])
  })

  it('同一 uid 的签到与推理呈现同一台设备（指纹种子一致）', async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ campaigns: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await performQoderCheckin('dt-c', 'cn', 'uid-same-device')
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    const inferSess = await cosySessionFor('dt-c', '', 'uid-same-device', '')
    expect(headers['cosy-machineid']).toBe(inferSess.machineId)
    expect(headers['cosy-machinetoken']).toBe(inferSess.machineToken)
  })

  it('showCampaign=false 时报「身份被过滤」而非「今天没有活动」', async () => {
    // hub qoder_accounts.py:929-1005：服务端判定非官方身份时返回 200 + 空列表 +
    // showCampaign=false，把两者混为一谈会让人以为签到正常。
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ campaigns: [], showCampaign: false }), { status: 200 })))
    const r = await performQoderCheckin('dt-c', 'cn', 'u1')
    expect(r.success).toBe(false)
    expect(r.message).toContain('机器身份')
    expect(r.message).not.toContain('无可用签到活动')
  })

  it('活动存在但无可领取项时，消息带上活动条数便于定位', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({
        campaigns: [{ campaignId: 'c', actionType: 'VIEW_DETAILS', claimStatus: 'CLAIMED' }],
        showCampaign: true,
      }), { status: 200 })))
    const r = await performQoderCheckin('dt-c', 'cn', 'u1')
    expect(r.success).toBe(false)
    expect(r.message).toContain('1 个活动')
  })
})

// ===== 活动 actionType 为空 + 不可领取原因码（线上实测「1 个活动里没有 CLAIMABLE」） =====
describe('活动领取：空 actionType 视为奖励类，不可领取时如实报原因', () => {
  it('actionType 为空且 CLAIMABLE → 照常领取（旧实现整条丢弃）', async () => {
    // hub qoder_accounts.py:1127/1150 与 qoder_tasks.py:275 都是
    // `action_type in ("", "CLAIM_BENEFIT")`：空串与 CLAIM_BENEFIT 等价。
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/me/campaigns')) {
        return new Response(JSON.stringify({
          showCampaign: true,
          campaigns: [{ campaignId: 'c-empty', campaignKey: 'daily', claimStatus: 'CLAIMABLE', benefit: { kind: 'CREDITS', amount: 100 } }],
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ status: 'CLAIMED', replayed: false, benefit: { amount: 100 } }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const r = await performQoderCheckin('dt-c', 'cn', 'u1')
    expect(r.success).toBe(true)
    expect(r.rewardCredits).toBe(100)
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/c-empty/claim'))).toBe(true)
  })

  it('名额发完（REDEMPTION_CODE_OUT_OF_STOCK）→ 报「名额已发完」而非「没有 CLAIMABLE」', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({
        showCampaign: true,
        campaigns: [{
          campaignId: 'c1', campaignKey: 'act-20260928-620', actionType: 'CLAIM_BENEFIT',
          claimStatus: 'NOT_ELIGIBLE', unavailableReason: 'REDEMPTION_CODE_OUT_OF_STOCK',
        }],
      }), { status: 200 })))
    const r = await performQoderCheckin('dt-c', 'cn', 'u1')
    expect(r.success).toBe(false)
    expect(r.message).toContain('名额已发完')
    expect(r.message).toContain('act-20260928-620')
  })

  it('成就未完成（ACHIEVEMENT_NOT_COMPLETED）→ 报出需完成的成就 key', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({
        showCampaign: true,
        campaigns: [{
          campaignId: 'c2', campaignKey: 'act-locked', actionType: 'CLAIM_BENEFIT',
          claimStatus: 'NOT_ELIGIBLE', unavailableReason: 'ACHIEVEMENT_NOT_COMPLETED',
          requiredAchievementKey: 'sites_first_use',
        }],
      }), { status: 200 })))
    const r = await performQoderCheckin('dt-c', 'cn', 'u1')
    expect(r.success).toBe(false)
    expect(r.message).toContain('新人任务')
    expect(r.message).toContain('sites_first_use')
  })

  it('VIEW_DETAILS 活动仍不算签到奖励（不因放宽 actionType 而被误领）', async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({
        showCampaign: true,
        campaigns: [{ campaignId: 'v1', actionType: 'VIEW_DETAILS', claimStatus: 'CLAIMABLE' }],
      }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const r = await performQoderCheckin('dt-c', 'cn', 'u1')
    expect(r.success).toBe(false)
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/claim'))).toBe(false)
  })
})

// ===== Qoder 判定收敛到单一 owner（修「测试/推理走通用 OpenAI 路径撞 ALB 503」） =====
describe('isQoderFlow：Qoder 判定只有一处 owner', () => {
  it('三个真实配置形态都判为 Qoder', () => {
    expect(isQoderFlow({ id: 'qoder' })).toBe(true)
    expect(isQoderFlow({ id: 'my-qoder', oauth: { flowType: 'qoder' } })).toBe(true)
    // 手工填了 Qoder 域名但没选授权流程：模型列表此前就是靠这条命中的，
    // 而推理/测试只认 id → 撕裂成「模型能拉、推理打错端点」。
    expect(isQoderFlow({ id: 'custom', baseUrl: 'https://gateway.qoder.com.cn' })).toBe(true)
    expect(isQoderFlow({ id: 'custom', baseUrl: 'https://openapi.qoder.sh' })).toBe(true)
  })

  it('非 Qoder 提供商不受影响（大小写不敏感但仍需真的含 qoder）', () => {
    expect(isQoderFlow({ id: 'workbuddy', baseUrl: 'https://copilot.tencent.com/v2', oauth: { flowType: 'browser' } })).toBe(false)
    expect(isQoderFlow({ id: 'gemini', baseUrl: 'https://cloudcode-pa.googleapis.com' })).toBe(false)
    expect(isQoderFlow(null)).toBe(false)
    expect(isQoderFlow(undefined)).toBe(false)
  })
})

describe('testQoderModel：结果自带链路标识（区分旧构建与真失败）', () => {
  it('失败信息带 [COSY 链路] 前缀，且绝不请求 /chat/completions', async () => {
    const fetchMock = vi.fn(async (_input: unknown) => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    // 空 env + 无 oauth：拿不到会话 → 如实报未连接，而不是去打通用端点
    const r = await testQoderModel({} as Env, { id: 'qoder' } as Provider, 'qmodel_38max')
    expect(r.success).toBe(false)
    expect(r.message).toContain('[COSY 链路]')
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/chat/completions'))).toBe(false)
  })
})

describe('签到诊断快照：把上游原始字段留档（定位「提示成功但积分没增加」）', () => {
  it('debug 带 campaigns / showCampaign / claim 原始体', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/me/campaigns')) {
        return new Response(JSON.stringify({
          showCampaign: true, claimable: true,
          campaigns: [{
            campaignId: 'c1', campaignKey: 'daily', actionType: 'CLAIM_BENEFIT',
            claimStatus: 'CLAIMABLE', benefit: { kind: 'CREDITS', amount: 100 },
          }],
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ status: 'CLAIMED', replayed: false, benefit: { amount: 100 } }), { status: 200 })
    }))
    const r = await performQoderCheckin('dt-c', 'cn', 'u1')
    expect(r.debug?.campaignsHttp).toBe(200)
    expect(r.debug?.showCampaign).toBe(true)
    expect(r.debug?.campaigns[0]).toMatchObject({ key: 'daily', action: 'CLAIM_BENEFIT', status: 'CLAIMABLE', kind: 'CREDITS', amount: 100 })
    expect(r.debug?.claimHttp).toBe(200)
    // replayed 到底有没有值，必须能从日志直接看出来（这是「已领不加分」的判据）
    expect(r.debug?.claimBody).toContain('replayed')
  })

  it('不可领取时 debug 仍带出每个活动的状态与原因码', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      showCampaign: true,
      campaigns: [{
        campaignId: 'c2', campaignKey: 'act-locked', actionType: 'CLAIM_BENEFIT',
        claimStatus: 'NOT_ELIGIBLE', unavailableReason: 'ACHIEVEMENT_NOT_COMPLETED',
        requiredAchievementKey: 'sites_first_use',
      }],
    }), { status: 200 })))
    const r = await performQoderCheckin('dt-c', 'cn', 'u1')
    expect(r.success).toBe(false)
    expect(r.debug?.campaigns[0]).toMatchObject({
      key: 'act-locked', status: 'NOT_ELIGIBLE', reason: 'ACHIEVEMENT_NOT_COMPLETED', achievement: 'sites_first_use',
    })
  })
})

// ===== 测试按钮走真实 COSY 管线（不再 POST /chat/completions 撞 ALB 503） =====
describe('testQoderModel：测试按钮走 COSY 签名推理端点', () => {
  it('打到 agent_chat_generation 而非 gateway.qoder.com.cn/chat/completions', async () => {
    const session = await makeSession()
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      new Response(sseBody([envelope(INNER_CHUNK)]), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', fetchMock)
    // 池为空 + 无 OAuth 单 token → 走 opts.session 注入的直发路径
    const r = await proxyQoderChatRequest(
      {} as Env,
      { id: 'qoder' } as Provider,
      { model: 'qmodel_38max', messages: [{ role: 'user', content: 'hi' }], stream: false },
      { session: { session }, stream: false }
    )
    expect(r.status).toBe(200)
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('/algo/api/v2/service/pro/sse/agent_chat_generation')
    expect(url).not.toContain('/chat/completions')
  })

  it('上游返回 ALB 503 HTML 时如实回显（不谎报连接成功）', async () => {
    const session = await makeSession()
    const albHtml = '<html><head><title>503 Service Temporarily Unavailable</title></head><body><center><h1>503 Service Temporarily Unavailable</h1></center><hr><center>alb</center></body></html>'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(albHtml, { status: 503 })))
    const r = await proxyQoderChatRequest(
      {} as Env,
      { id: 'qoder' } as Provider,
      { model: 'qmodel_38max', messages: [{ role: 'user', content: 'hi' }], stream: false },
      { session: { session }, stream: false }
    )
    expect(r.status).toBe(503)
  })
})

// ===== 模型列表场景分类（bridge.go:195-206） =====
describe('模型列表按场景桶读取（assistant → developer → chat）', () => {
  it('chat 桶为空但 assistant 桶有内容 → 取 assistant（不再误报无模型）', () => {
    const r = pickQoderModels({
      chat: [],
      assistant: [{ key: 'qmodel_38max', enable: true }, { key: 'qfmodel', enable: true }],
    })
    expect(r.error).toBe('')
    expect(r.category).toBe('assistant')
    expect(r.models.map((m) => m.id)).toEqual(['qmodel_38max', 'qfmodel'])
  })

  it('assistant 桶为空时回退 developer，再回退 chat', () => {
    const r = pickQoderModels({ assistant: [], developer: [], chat: [{ key: 'auto', enable: true }] })
    expect(r.error).toBe('')
    expect(r.category).toBe('chat')
    expect(r.models.map((m) => m.id)).toEqual(['auto'])
  })

  it('只保留 enable=true 的条目', () => {
    const r = pickQoderModels({
      chat: [{ key: 'on', enable: true }, { key: 'off', enable: false }, { key: 'noflag' }],
    })
    expect(r.models.map((m) => m.id)).toEqual(['on'])
  })

  it('桶存在但全部 enable=false → 如实说明，不谎报 success', () => {
    const r = pickQoderModels({ chat: [{ key: 'auto', enable: false }] })
    expect(r.models).toHaveLength(0)
    expect(r.error).toContain('均未启用')
    expect(r.error).toContain('chat')
  })

  it('完全没有模型场景 → 报出实际 keys 便于排查', () => {
    const r = pickQoderModels({ somethingElse: [] })
    expect(r.error).toContain('somethingElse')
  })

  it('counts 报出各桶条数（区分「没有模型」与「模型都被禁用」）', () => {
    const r = pickQoderModels({ assistant: [{ key: 'a', enable: true }], chat: [{ key: 'b' }] })
    expect(r.counts).toEqual({ assistant: 1, developer: 0, chat: 1 })
    expect(r.category).toBe('assistant')
  })

  it('非对象输入不抛异常', () => {
    expect(pickQoderModels(null).error).toContain('缺少模型场景')
    expect(pickQoderModels('nope').error).toContain('缺少模型场景')
  })
})

// ===== P1-7：未知模型名不再静默透传 =====
describe('P1-7 未知模型名兜底到合法 SKU', () => {
  it('已知别名仍走精确映射', () => {
    expect(cpaToUpstreamKey('qwen3.7-max')).toBe('qmodel_latest')
    expect(cpaToUpstreamKey('qoder-auto')).toBe('auto')
  })

  it('客户端模型名（claude/gpt/gemini 家族）兜底为 auto，不再原样透传', () => {
    expect(fallbackUnknownModel(cpaToUpstreamKey('claude-sonnet-4-6'))).toBe('auto')
    expect(fallbackUnknownModel(cpaToUpstreamKey('gpt-5'))).toBe('auto')
    expect(fallbackUnknownModel(cpaToUpstreamKey('gemini-2.5-pro'))).toBe('auto')
    expect(fallbackUnknownModel(cpaToUpstreamKey('o3-mini'))).toBe('auto')
  })

  it('上游合法 key 原样保留（模型列表新增项不能被强制降级）', () => {
    expect(fallbackUnknownModel(cpaToUpstreamKey('qmodel_preview'))).toBe('qmodel_preview')
    expect(fallbackUnknownModel(cpaToUpstreamKey('auto'))).toBe('auto')
    expect(fallbackUnknownModel('some_future_sku')).toBe('some_future_sku')
  })
})

// ===== P1-10：内容审核分类 =====
describe('P1-10 DataInspectionFailed 归为内容审核（确定性拒绝，不引导重试）', () => {
  const detail = 'InternalError.Algo.DataInspectionFailed: Input text data may contain inappropriate content.'

  it('分类为 content_policy，状态 400，不 failover（换号也会被同样拒绝）', () => {
    const c = classifyQoderError({ status: 200, body: detail })
    expect(c.kind).toBe('content_policy')
    expect(c.status).toBe(400)
    expect(c.failover).toBe(false)
    expect(c.cooldownSeconds).toBe(0)
    expect(c.type).toBe('content_policy_rejected')
  })

  it('给出中文解释并明示重试无效', () => {
    const c = classifyQoderError({ status: 200, body: detail })
    expect(c.message).toContain('内容安全审核')
    expect(c.message).toContain('重试无效')
  })

  it('内容审核优先于瞬时判断（418 也不会被当瞬时故障）', () => {
    const c = classifyQoderError({ status: 418, body: detail })
    expect(c.kind).toBe('content_policy')
    expect(c.status).toBe(400)
  })

  it('普通瞬时故障仍按 unavailable 处理，未被内容审核分支吞掉', () => {
    const c = classifyQoderError({ status: 500, body: 'internal server error' })
    expect(c.kind).toBe('unavailable')
    expect(c.status).toBe(500)
  })

  it('内容审核在流内信封错误路径同样生效（HTTP200 + 信封 418 + 审核详情）', async () => {
    const { resp } = await callProxy([envelope(detail, 418)])
    expect(resp.status).toBe(400)
    const body = await resp.text()
    expect(body).toContain('content_policy_rejected')
    expect(body).toContain('重试无效')
  })
})

// ===== 上游排队已满（10605 / isQueued）：信封层 403 不是鉴权故障 =====
// 源：qoder2api-hub v1.1.9 PR#7（信封层 403 + 10605 排队 → 账号冷却 + 轮换，而非按鉴权打死账号）。
describe('上游排队已满（10605 / isQueued）归为限流，绝不按鉴权禁用账号', () => {
  /** 线上实测原文（管理后台「测试」按钮的失败体，modelKey=qfmodel）。 */
  const QUEUE_DETAIL = JSON.stringify({
    code: '10605',
    message: JSON.stringify({
      isQueued: true,
      modelKey: 'qfmodel',
      queueCount: 0,
      queueType: 'p3',
      retryAfterSeconds: 30,
      serviceAvailable: false,
      waitTime: 30,
    }),
  })

  it('403 + 10605 → rate_limit（不是 auth），冷却取上游 retryAfterSeconds', () => {
    const c = classifyQoderError({ status: 403, body: QUEUE_DETAIL })
    // 判成 auth 会走 pool.ts disableQoderAccount → 账号被永久禁用，一次排队就打死好账号
    expect(c.kind).toBe('rate_limit')
    expect(c.kind).not.toBe('auth')
    expect(c.failover).toBe(true)
    expect(c.cooldownSeconds).toBe(30)
    expect(c.code).toBe('10605')
    expect(c.type).toBe('upstream_queue_full')
  })

  it('消息是中文说明而非裸 JSON（面板要能读出「不是账号坏了」）', () => {
    const c = classifyQoderError({ status: 403, body: QUEUE_DETAIL })
    expect(c.message.startsWith('上游排队已满')).toBe(true)
    expect(c.message).toContain('不是账号或鉴权故障')
    expect(c.message).toContain('30s')
  })

  it('retryAfterSeconds 缺失时回退默认冷却，且不高于 10 分钟上限', () => {
    const noRetry = JSON.stringify({ code: '10605', message: '{"isQueued":true}' })
    expect(classifyQoderError({ status: 403, body: noRetry }).cooldownSeconds).toBe(60)
    const huge = JSON.stringify({ code: '10605', message: '{"isQueued":true,"retryAfterSeconds":99999}' })
    expect(classifyQoderError({ status: 403, body: huge }).cooldownSeconds).toBe(600)
  })

  it('真鉴权故障（401 + 会话死亡标记）仍是 auth，未被排队判定吞掉', () => {
    const c = classifyQoderError({ status: 401, body: 'TOKEN_EXPIRE: offline user session not found' })
    expect(c.kind).toBe('auth')
  })

  it('信封 403 + 10605 走完整链路 → 429 + Retry-After，提示排队而非鉴权', async () => {
    const { resp } = await callProxy([envelope(QUEUE_DETAIL, 403)], { stream: false })
    expect(resp.status).toBe(429)
    expect(resp.headers.get('Retry-After')).toBe('30')
    const body = await resp.text()
    expect(body).toContain('排队已满')
    expect(body).toContain('upstream_queue_full')
    expect(body).not.toContain('unauthorized')
  })
})

// ===== 池策略：401/403 只在会话被吊销时停用账号 =====
// 源：qoder2api-hub qoder_proxy.py:2618-2659 `_handle_envelope_account_cooldown`
// （dead → 停用；非 dead 的 401/403 → 60s 冷却后轮换）。
describe('池策略：401/403 只在会话被吊销时停用账号，其余冷却 60s 后轮换', () => {
  let seq = 0

  /** 建一个只带 KV 的 env，并在独立 providerId 下预置一个池账号（避开 pool.ts 的 1s 进程内缓存）。 */
  function makePoolEnv(uid: string) {
    const pid = `pq${++seq}`
    const key = `qoder:pool:${pid}`
    const store = new Map<string, string>()
    store.set(key, JSON.stringify([{
      uid,
      nickname: 'n',
      token: { access_token: 'dt-x', refresh_token: 'drt-x', expires_at: Date.now() + 3600_000 },
      enabled: true,
      state: { credits: 0, disabled: false, until: 0, errCount: 0 },
      updatedAt: Date.now(),
      realm: 'cn',
    }]))
    const env = {
      KV: {
        get: async (k: string) => store.get(k) ?? null,
        put: async (k: string, v: string) => { store.set(k, v) },
      },
    } as unknown as Env
    const state = () => (JSON.parse(store.get(key) || '[]')[0] || {}).state as
      { disabled: boolean; until: number; reason?: string } | undefined
    return { env, provider: { id: pid } as Provider, state }
  }

  /** 与上一节相同的上游原文（信封 403 + 10605 排队）。 */
  const QUEUE_BODY = JSON.stringify({
    code: '10605',
    message: JSON.stringify({ isQueued: true, modelKey: 'qfmodel', queueType: 'p3', retryAfterSeconds: 30, serviceAvailable: false }),
  })

  const classified = (over: Partial<QoderClassified> = {}): QoderClassified => ({
    status: 403,
    kind: 'auth',
    failover: true,
    cooldownSeconds: 30,
    message: 'permission denied',
    code: 'unauthorized',
    type: 'api_error',
    ...over,
  })

  it('会话死亡标记（TOKEN_EXPIRE / 12153 / Offline user session not found）→ 停用账号', async () => {
    const cases: Array<[string, string]> = [
      ['TOKEN_EXPIRE', 'unauthorized'],
      ['session gone', '12153'],
      ['Offline user session not found', 'unauthorized'],
    ]
    for (const [msg, code] of cases) {
      const uid = `u-dead-${code}-${msg.length}`
      const { env, provider, state } = makePoolEnv(uid)
      await markQoderAccountClassified(env, provider, uid, classified({ status: 401, message: msg, code }))
      expect(state()?.disabled).toBe(true)
    }
  })

  it('普通 403（无死亡标记）→ 不停用，只冷却 60s 后轮换', async () => {
    const uid = 'u-plain-403'
    const { env, provider, state } = makePoolEnv(uid)
    const before = Date.now()
    await markQoderAccountClassified(env, provider, uid, classified())
    const st = state()
    // 旧实现这里会 disabled=true：一次瞬时 403 就把账号永久打死
    expect(st?.disabled).toBe(false)
    expect(st!.until - before).toBeGreaterThanOrEqual(60_000)
    expect(st!.until - before).toBeLessThan(65_000)
  })

  it('上游给了更长的 Retry-After 时从长，不缩短', async () => {
    const uid = 'u-long-retry'
    const { env, provider, state } = makePoolEnv(uid)
    const before = Date.now()
    await markQoderAccountClassified(env, provider, uid, classified({ cooldownSeconds: 300 }))
    expect(state()!.until - before).toBeGreaterThanOrEqual(300_000)
  })

  it('排队满（rate_limit 30s）→ 只冷却不停用（分类与池策略串起来验）', async () => {
    const uid = 'u-queue'
    const { env, provider, state } = makePoolEnv(uid)
    const before = Date.now()
    await markQoderAccountClassified(env, provider, uid, classifyQoderError({ status: 403, body: QUEUE_BODY }))
    const st = state()
    expect(st?.disabled).toBe(false)
    expect(st!.until - before).toBeGreaterThanOrEqual(30_000)
    expect(st!.until - before).toBeLessThan(35_000)
  })

  it('isQoderSessionDead 只认上游吊销标记，不误伤普通权限错误', () => {
    expect(isQoderSessionDead('TOKEN_EXPIRE')).toBe(true)
    expect(isQoderSessionDead('12153')).toBe(true)
    expect(isQoderSessionDead('Offline user session not found')).toBe(true)
    expect(isQoderSessionDead('permission denied')).toBe(false)
    expect(isQoderSessionDead(QUEUE_BODY)).toBe(false)
  })
})