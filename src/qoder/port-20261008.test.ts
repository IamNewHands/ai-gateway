/**
 * port-20261008.test.ts — Qoder 第三轮移植项的回归测试。
 *
 * 源：`shuishuipingan/qoder2api-hub`（水位线 a6bab92 / v1.2.18）
 * 分析见 `_port-analysis/qoder2api-round3-porting-candidates.md`（19 项候选，本轮做 5 项）。
 *
 * 覆盖：
 *   P1 Pro 升级包（一次性 +1800）—— proEligibility / proClaim
 *   P2 兑换码（不可恢复资产）—— redemptionCode 字段 + 券类领取 + 同人去重
 *   P3 模型级冷却 —— 某模型 429 不再冻结整个账号
 *   P4 model_config 元数据 —— display_name / is_vl / is_reasoning / max_input_tokens
 *   P5 max_tokens / reasoning_effort —— 不再被静默丢弃
 *
 * 断言的是**行为**而非实现细节：改实现只要行为不变，这里就不该红。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildQoderBody, cpaToUpstreamKey } from './body'
import { qoderModelMeta, normalizeQoderReasoningEffort, QODER_DEFAULT_MAX_INPUT_TOKENS, qoderExclusiveRealm } from './model-meta'
import {
  proEligibility,
  proClaim,
  performQoderCheckin,
  qoderNextCheckinWindow,
  qoderDailyRoundOpen,
  QODER_PRO_REWARD_CREDIT,
  isQoderCouponKind,
  qoderCouponKindLabel,
} from './billing'
import {
  pickQoderAccount,
  cooldownQoderAccount,
  cooldownQoderAccountModel,
  clearQoderModelCooldown,
  isQoderAccountHealthy,
  qoderPoolServesModel,
  qoderAccountServesModel,
  qoderShortCooldownWait,
  listQoderPoolStatus,
  setQoderCampaignCode,
  blockQoderCampaign,
  isQoderCampaignBlocked,
  readQoderPool,
  writeQoderPool,
  type QoderPoolAccount,
} from './pool'
import { markQoderAccountClassified, proxyQoderChatRequest } from './proxy'
import { cosySessionFor } from './cosy'
import { isQoderTransientUpstream, isQoderTransientTransport } from './classify'
import type { Env, Provider } from '../types'

afterEach(() => { vi.unstubAllGlobals() })

/** 假 KV：只实现池读写用到的 get/put/delete。 */
function makeEnv() {
  const store = new Map<string, string>()
  const kv = {
    get: async (k: string, type?: string) => {
      const v = store.get(k)
      if (v === undefined) return null
      return type === 'json' ? JSON.parse(v) : v
    },
    put: async (k: string, v: string) => { store.set(k, v) },
    delete: async (k: string) => { store.delete(k) },
  }
  return { env: { KV: kv } as unknown as Env, store }
}

function account(over: Partial<QoderPoolAccount> = {}): QoderPoolAccount {
  return {
    uid: 'u1',
    nickname: 'u1',
    token: { access_token: 'dt-test', refresh_token: 'drt-test', expires_at: Date.now() + 86400000, updated_at: 0 },
    enabled: true,
    state: { credits: 100, disabled: false, until: 0, errCount: 0 },
    updatedAt: 0,
    realm: 'cn',
    ...over,
  }
}

// ===== P1：Pro 升级包 =====
describe('P1 Pro 升级包：资格查询与领取（hub qoder_accounts.py:1290-1323）', () => {
  it('资格查询用 Bearer + X-Machine-ID/X-Session-ID/X-Request-ID，且**不发** cosy-machine* 头', async () => {
    // 这是本项最容易做错的地方：hub 的 pro 端点走 headers()（无机器头），
    // 而签到走 desktop_headers()（带六个 cosy-machine*）。混用会把错误的身份形态发给上游。
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const h = (init?.headers || {}) as Record<string, string>
      expect(h['Authorization']).toBe('Bearer dt-pro')
      expect(h['X-Machine-ID']).toMatch(/^[0-9a-f]{32}$/)
      expect(h['X-Session-ID']).toMatch(/^[0-9a-f]{32}$/)
      expect(h['X-Request-ID']).toMatch(/^[0-9a-f]{32}-\d{6}$/)
      // 一个 cosy-machine* 都不能有
      expect(Object.keys(h).map((k) => k.toLowerCase()).filter((k) => k.startsWith('cosy-machine'))).toEqual([])
      return new Response(JSON.stringify({ eligible: true }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const r = await proEligibility('dt-pro', 'cn', 'uid-pro')
    expect(r.ok).toBe(true)
    expect(r.eligible).toBe(true)
    expect(r.httpStatus).toBe(200)
  })

  it('机器/会话 ID 按 uid 稳定派生（同一账号两次调用同值，不同账号不同值）', async () => {
    const seen: string[][] = []
    vi.stubGlobal('fetch', vi.fn(async (_i: unknown, init?: RequestInit) => {
      const h = (init?.headers || {}) as Record<string, string>
      seen.push([h['X-Machine-ID'], h['X-Session-ID']])
      return new Response(JSON.stringify({ eligible: false }), { status: 200 })
    }))
    await proEligibility('t', 'cn', 'uid-A')
    await proEligibility('t', 'cn', 'uid-A')
    await proEligibility('t', 'cn', 'uid-B')
    expect(seen[0]).toEqual(seen[1])            // 幂等：同账号同值
    expect(seen[0][0]).not.toBe(seen[2][0])     // 隔离：不同账号不同值
  })

  it('404/403/410 → 查询成功但不可领取，且**标出端点缺失**（不是「已领过」）', async () => {
    // 端点不存在/活动下线时，账号侧结论是「没得领」；但必须与「已领过」分开——
    // 2026-10-09 实测：国际版账号点「领 Pro 包」显示「已领过 1」，而它从没领到过。
    for (const status of [404, 403, 405, 410]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status })))
      const r = await proEligibility('t', 'cn', 'u')
      expect(r.ok).toBe(true)
      expect(r.eligible).toBe(false)
      expect(r.endpointMissing, `HTTP ${status} 应标记端点缺失`).toBe(true)
      expect(r.httpStatus).toBe(status)
    }
  })

  it('200 + eligible:false → 接口存在但不可领（**不**标记端点缺失）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ eligible: false }), { status: 200 })))
    const r = await proEligibility('t', 'cn', 'u')
    expect(r.ok).toBe(true)
    expect(r.eligible).toBe(false)
    expect(r.endpointMissing).toBeUndefined()
    expect(r.httpStatus).toBe(200)
  })

  it('claim 的 403/404/410 → endpointMissing（不报成「领取失败」）', async () => {
    for (const status of [404, 403, 410]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('nf', { status })))
      const r = await proClaim('t', 'cn', 'u')
      expect(r.ok, `HTTP ${status}`).toBe(true)
      expect(r.outcome).toBe('endpointMissing')
      expect(r.rewardCredits).toBeUndefined()
    }
  })

  it('三态 outcome 互斥且语义正确（claimed / already / endpointMissing / unavailable / failed）', async () => {
    // claimed：唯一会加积分的情形
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })))
    let r = await proClaim('t', 'cn', 'u')
    expect(r.outcome).toBe('claimed')
    expect(r.rewardCredits).toBe(1800)

    // already：409 → 已领过，不加积分
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ALREADY', { status: 409 })))
    r = await proClaim('t', 'cn', 'u')
    expect(r.outcome).toBe('already')
    expect(r.already).toBe(true)
    expect(r.rewardCredits).toBeUndefined()

    // failed：500
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    r = await proClaim('t', 'cn', 'u')
    expect(r.outcome).toBe('failed')
    expect(r.ok).toBe(false)
  })

  it('其他错误码 → 查询失败（不谎报「不可领取」）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    const r = await proEligibility('t', 'cn', 'u')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('500')
  })

  it('领取成功回传 +1800 兜底金额（上游不回传金额时）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_i: unknown, init?: RequestInit) => {
      expect(init?.method).toBe('POST')
      expect(String(init?.body)).toBe('{}')
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    }))
    const r = await proClaim('t', 'cn', 'u')
    expect(r.ok).toBe(true)
    expect(r.already).toBeUndefined()
    expect(r.rewardCredits).toBe(QODER_PRO_REWARD_CREDIT)
    expect(QODER_PRO_REWARD_CREDIT).toBe(1800)
  })

  it('409 或 body 含 ALREADY → 已领取过（ok=true, already=true，且**不给**积分）', async () => {
    // 区分 claimed_now 与 already 是源明确记载的历史缺陷：不区分会让批量汇总每次虚增 +1800。
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"message":"ALREADY_CLAIMED"}', { status: 409 })))
    const a = await proClaim('t', 'cn', 'u')
    expect(a.ok).toBe(true)
    expect(a.already).toBe(true)
    expect(a.rewardCredits).toBeUndefined()

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"message":"ALREADY"}', { status: 200 })))
    const b = await proClaim('t', 'cn', 'u')
    expect(b.ok).toBe(true)
    expect(b.already).toBe(true)
    expect(b.rewardCredits).toBeUndefined()
  })

  it('上游 success:false → 失败并带原因（不谎报成功）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false, message: '活动已结束' }), { status: 200 })))
    const r = await proClaim('t', 'cn', 'u')
    expect(r.ok).toBe(false)
    expect(r.message).toContain('活动已结束')
  })
})

// ===== P2：兑换码（不可恢复资产） =====
describe('P2 兑换码：券类活动领取 + 码持久化（hub qoder_accounts.py:1070-1074/1173）', () => {
  it('kind 判定：CREDITS/空 = 积分（不领券），其余 = 券类', () => {
    expect(isQoderCouponKind('CREDITS')).toBe(false)
    expect(isQoderCouponKind('')).toBe(false)      // 空 kind 与 CREDITS 并列（源同口径）
    expect(isQoderCouponKind(undefined)).toBe(false)
    expect(isQoderCouponKind('REDEMPTION_CODE')).toBe(true)
    expect(isQoderCouponKind('redemption_coupon')).toBe(true)
    expect(isQoderCouponKind('COUPON')).toBe(true)
    // 中文标签（源 _extra_campaign_rows 的映射）
    expect(qoderCouponKindLabel('REDEMPTION_CODE')).toBe('兑换码')
    expect(qoderCouponKindLabel('REDEMPTION_COUPON')).toBe('兑换券')
    expect(qoderCouponKindLabel('COUPON')).toBe('优惠券')
  })

  it('默认（includeCoupons 缺省）**不领**券类：与旧行为一致，每日签到只做积分', async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/campaigns')) {
        return new Response(JSON.stringify({
          campaigns: [
            { campaignId: 'daily', campaignKey: 'daily', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { kind: 'CREDITS', amount: 100 } },
            { campaignId: 'coupon', campaignKey: 'coupon', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { kind: 'REDEMPTION_CODE' } },
          ],
        }), { status: 200 })
      }
      // 只应对 daily 发一次 claim
      expect(url).toContain('/campaigns/daily/claim')
      return new Response(JSON.stringify({ status: 'CLAIMED', benefit: { amount: 100 } }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const r = await performQoderCheckin('dt-t', 'cn', 'u1')
    expect(r.success).toBe(true)
    expect(r.rewardCredits).toBe(100)
    // 券类没有被领取
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/coupon/claim'))).toHaveLength(0)
  })

  it('includeCoupons=true → 领券并把兑换码带出来（码只回一次，必须带出）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/campaigns')) {
        return new Response(JSON.stringify({
          campaigns: [
            { campaignId: 'daily', campaignKey: 'daily', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { kind: 'CREDITS', amount: 100 } },
            { campaignId: 'coupon-1', campaignKey: 'act-1', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { kind: 'REDEMPTION_CODE' } },
          ],
        }), { status: 200 })
      }
      if (url.includes('/coupon-1/claim')) {
        return new Response(JSON.stringify({ status: 'CLAIMED', redemptionCode: 'CODE-XYZ-123' }), { status: 200 })
      }
      return new Response(JSON.stringify({ status: 'CLAIMED', benefit: { amount: 100 } }), { status: 200 })
    }))
    const r = await performQoderCheckin('dt-t', 'cn', 'u1', undefined, undefined, { includeCoupons: true })
    expect(r.success).toBe(true)
    expect(r.couponCodes).toEqual([{ campaignId: 'coupon-1', campaign: 'act-1', code: 'CODE-XYZ-123' }])
    expect(r.message).toContain('CODE-XYZ-123')
  })

  it('CLAIMED 但无码 = 发放确认中（不谎报「已拿到码」）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/campaigns')) {
        return new Response(JSON.stringify({
          campaigns: [
            { campaignId: 'daily', campaignKey: 'daily', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { kind: 'CREDITS', amount: 100 } },
            { campaignId: 'c1', campaignKey: 'act-c', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { kind: 'REDEMPTION_CODE' } },
          ],
        }), { status: 200 })
      }
      if (url.includes('/c1/claim')) return new Response(JSON.stringify({ status: 'CLAIMED' }), { status: 200 })
      return new Response(JSON.stringify({ status: 'CLAIMED', benefit: { amount: 100 } }), { status: 200 })
    }))
    const r = await performQoderCheckin('dt-t', 'cn', 'u1', undefined, undefined, { includeCoupons: true })
    expect(r.couponCodes).toBeUndefined()
    expect(r.message).toContain('发放确认中')
  })

  it('SAME_PERSON_ALREADY_CLAIMED → blocked（不是失败），并回报该活动 id 供记冷却', async () => {
    // 服务端按人去重：账号没问题、请求合法，只是同设备其他号本轮已领。
    // 旧实现塌缩成「未知状态: BLOCKED」，用户无从知道「换号也没用、要等下一轮」。
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/campaigns')) {
        return new Response(JSON.stringify({
          campaigns: [
            { campaignId: 'daily', campaignKey: 'daily', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { kind: 'CREDITS', amount: 100 } },
            { campaignId: 'c2', campaignKey: 'act-2', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { kind: 'REDEMPTION_CODE' } },
          ],
        }), { status: 200 })
      }
      if (url.includes('/c2/claim')) {
        return new Response(JSON.stringify({ status: 'BLOCKED', failureCode: 'SAME_PERSON_ALREADY_CLAIMED' }), { status: 200 })
      }
      return new Response(JSON.stringify({ status: 'CLAIMED', benefit: { amount: 100 } }), { status: 200 })
    }))
    const r = await performQoderCheckin('dt-t', 'cn', 'u1', undefined, undefined, { includeCoupons: true })
    expect(r.couponBlocked).toEqual(['c2'])
    expect(r.message).toContain('同人已领取')
    // 不能被当成签到失败
    expect(r.success).toBe(true)
  })

  it('券类失败码补全：风控拦截/活动结束不再塌缩成「未知状态」', async () => {
    for (const [code, expectText] of [
      ['RISK_BLOCKED', '风控拦截'],
      ['CAMPAIGN_NOT_ACTIVE', '活动已结束'],
      ['RISK_DEPENDENCY_UNAVAILABLE', '风控服务不可用'],
      ['REDEMPTION_CODE_OUT_OF_STOCK', '名额已发完'],
    ] as const) {
      vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
        const url = String(input)
        if (url.endsWith('/campaigns')) {
          return new Response(JSON.stringify({
            campaigns: [
              { campaignId: 'daily', campaignKey: 'daily', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { kind: 'CREDITS', amount: 100 } },
              { campaignId: 'c3', campaignKey: 'act-3', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { kind: 'REDEMPTION_CODE' } },
            ],
          }), { status: 200 })
        }
        if (url.includes('/c3/claim')) {
          return new Response(JSON.stringify({ status: 'NOT_ELIGIBLE', failureCode: code }), { status: 200 })
        }
        return new Response(JSON.stringify({ status: 'CLAIMED', benefit: { amount: 100 } }), { status: 200 })
      }))
      const r = await performQoderCheckin('dt-t', 'cn', 'u1', undefined, undefined, { includeCoupons: true })
      expect(r.message, `失败码 ${code} 的文案`).toContain(expectText)
    }
  })

  it('券类 claim 的 HTTP 409 → 幂等命中（已领取），不是失败', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/campaigns')) {
        return new Response(JSON.stringify({
          campaigns: [
            { campaignId: 'daily', campaignKey: 'daily', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { kind: 'CREDITS', amount: 100 } },
            { campaignId: 'c4', campaignKey: 'act-4', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { kind: 'REDEMPTION_CODE' } },
          ],
        }), { status: 200 })
      }
      if (url.includes('/c4/claim')) return new Response('already claimed', { status: 409 })
      return new Response(JSON.stringify({ status: 'CLAIMED', benefit: { amount: 100 } }), { status: 200 })
    }))
    const r = await performQoderCheckin('dt-t', 'cn', 'u1', undefined, undefined, { includeCoupons: true })
    expect(r.message).toContain('已领取')
  })

  it('兑换码落池：只在拿到非空码时写，空值不覆盖已有码（码不可恢复）', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-codes-1'
    await writeQoderPool(env, pid, [account()])

    await setQoderCampaignCode(env, pid, 'u1', 'camp-1', 'CODE-A')
    let st = await listQoderPoolStatus(env, pid)
    expect(st[0].campaignCodes).toEqual({ 'camp-1': 'CODE-A' })

    // 空码不得覆盖（用空值擦掉已观测到的码 = 永久丢失资产）
    await setQoderCampaignCode(env, pid, 'u1', 'camp-1', '')
    await setQoderCampaignCode(env, pid, 'u1', 'camp-1', '   ')
    st = await listQoderPoolStatus(env, pid)
    expect(st[0].campaignCodes).toEqual({ 'camp-1': 'CODE-A' })

    // 新活动追加，不冲掉旧的
    await setQoderCampaignCode(env, pid, 'u1', 'camp-2', 'CODE-B')
    st = await listQoderPoolStatus(env, pid)
    expect(st[0].campaignCodes).toEqual({ 'camp-1': 'CODE-A', 'camp-2': 'CODE-B' })
  })

  it('同人去重冷却：默认 6 小时，到期后自动失效（不永久挡住下一轮）', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-block-1'
    await writeQoderPool(env, pid, [account()])
    const now = Date.now()
    expect(isQoderCampaignBlocked((await readQoderPool(env, pid))[0].state, 'c1', now)).toBe(false)

    await blockQoderCampaign(env, pid, 'u1', 'c1')
    const st = (await readQoderPool(env, pid))[0].state
    expect(isQoderCampaignBlocked(st, 'c1', now)).toBe(true)
    // 6h（源定值）——刚好过界一点就不该再算冷却
    expect(st?.campaignBlockedUntil?.c1).toBeGreaterThan(now + 6 * 3600 * 1000 - 5000)
    expect(isQoderCampaignBlocked(st, 'c1', now + 6 * 3600 * 1000 + 1000)).toBe(false)
    // 未记录的活动不受影响
    expect(isQoderCampaignBlocked(st, 'other', now)).toBe(false)
  })

  /**
   * 2026-10-09 实测缺陷：点「领兑换码」拿到的是**每日签到的报错**。
   *
   * 根因：券类领取原先写在「每日签到成功」那条路径的末尾，而每日签到有多条提前 return
   * （本轮未刷新 / 今日已领 / 名额发完 / 无活动）。10:00 前或今日已签到时，用户点「领兑换码」
   * 得到的全是签到的前置判定结论，券类那段代码根本没执行。
   *
   * 券类与每日签到是**互相独立**的两件事，必须用 couponsOnly 完全绕开签到判定。
   */
  it('couponsOnly：本轮未刷新（10:00 前）**仍然领券**，不被签到前置判定挡住', async () => {
    // 构造「只有 CLAIMED 的每日活动 + 一个 CLAIMABLE 的券」= 用户实测的 10:00 前形态
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/campaigns')) {
        return new Response(JSON.stringify({
          campaigns: [
            { campaignId: 'daily-old', campaignKey: 'act-20260930-660', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMED', benefit: { kind: 'CREDITS', amount: 100 } },
            { campaignId: 'coupon-9', campaignKey: 'coupon-9', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { kind: 'REDEMPTION_CODE' } },
          ],
        }), { status: 200 })
      }
      if (url.includes('/coupon-9/claim')) {
        return new Response(JSON.stringify({ status: 'CLAIMED', redemptionCode: 'CODE-10AM' }), { status: 200 })
      }
      throw new Error(`不该请求 ${url}：couponsOnly 不得触碰每日签到`)
    }))
    const r = await performQoderCheckin('dt-t', 'cn', 'u1', undefined, undefined, { couponsOnly: true })
    expect(r.success).toBe(true)
    expect(r.couponCodes).toEqual([{ campaignId: 'coupon-9', campaign: 'coupon-9', code: 'CODE-10AM' }])
    // 结果里不能出现「签到尚未刷新」这类与券无关的报错
    expect(r.message).not.toContain('尚未刷新')
    expect(r.message).toContain('CODE-10AM')
  })

  it('couponsOnly：没有券可领时给中性结论，不谎报失败也不报签到错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      campaigns: [
        { campaignId: 'daily-old', campaignKey: 'act-1', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMED', benefit: { kind: 'CREDITS', amount: 100 } },
      ],
    }), { status: 200 })))
    const r = await performQoderCheckin('dt-t', 'cn', 'u1', undefined, undefined, { couponsOnly: true })
    expect(r.success).toBe(true)
    expect(r.message).toContain('没有可领取的兑换码')
    expect(r.message).not.toContain('尚未刷新')
    expect(r.message).not.toContain('无可用签到活动')
  })

  it('couponsOnly：券类失败时如实报失败（不因「没有签到」而谎报成功）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/campaigns')) {
        return new Response(JSON.stringify({
          campaigns: [
            { campaignId: 'c-bad', campaignKey: 'c-bad', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { kind: 'REDEMPTION_CODE' } },
          ],
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ status: 'NOT_ELIGIBLE', failureCode: 'RISK_BLOCKED' }), { status: 200 })
    }))
    const r = await performQoderCheckin('dt-t', 'cn', 'u1', undefined, undefined, { couponsOnly: true })
    expect(r.success).toBe(false)
    expect(r.message).toContain('风控拦截')
  })

  it('includeCoupons（非 couponsOnly）：每日签到未刷新时**也**把券领了，且结果不被签到报错吞掉', async () => {
    // 这条钉住 withCoupons 的行为：签到本身没领到（未刷新）但券领到了 → 整体成功 + 带码，
    // 否则用户明明拿到码却看到「失败」。
    //
    // 必须注入 now（CST 10:00 之前）：轮次判定决定走「未刷新」还是「已领取」，
    // 不注入就会随运行时刻飘红 —— 这正是时间可注入是硬要求的原因。
    const beforeRound = Date.UTC(2026, 9, 9, 1, 0, 0) // 2026-10-09 09:00 CST
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/campaigns')) {
        return new Response(JSON.stringify({
          campaigns: [
            { campaignId: 'daily-old', campaignKey: 'act-old', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMED', benefit: { kind: 'CREDITS', amount: 100 } },
            { campaignId: 'c-ok', campaignKey: 'c-ok', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { kind: 'REDEMPTION_CODE' } },
          ],
        }), { status: 200 })
      }
      if (url.includes('/c-ok/claim')) {
        return new Response(JSON.stringify({ status: 'CLAIMED', redemptionCode: 'CODE-MIX' }), { status: 200 })
      }
      throw new Error(`不该请求 ${url}`)
    }))
    const r = await performQoderCheckin('dt-t', 'cn', 'u1', undefined, undefined, { includeCoupons: true, now: beforeRound })
    expect(r.success).toBe(true)                       // 券到手 → 整体成功
    expect(r.redemptionCode).toBe('CODE-MIX')
    expect(r.message).toContain('尚未刷新')            // 签到的真实状态仍如实保留
    expect(r.message).toContain('CODE-MIX')
  })
})

// ===== P3：模型级冷却 =====
describe('P3 模型级冷却：某模型 429 不再冻结整个账号（hub qoder_accounts.py:597/615）', () => {
  it('模型级冷却：该模型上被跳过，**其它模型照常可用**（旧实现会整个账号被冻结）', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-modelcd-1'
    await writeQoderPool(env, pid, [account({ state: { credits: 100, disabled: false, until: 0, errCount: 0 } })])

    await cooldownQoderAccountModel(env, pid, 'u1', 'qmodel', 60_000, '限流（429，仅模型 qmodel）')

    const acc = (await readQoderPool(env, pid))[0]
    // 账号级没被冻：健康判定不带 model 时仍为真
    expect(isQoderAccountHealthy(acc, Date.now())).toBe(true)
    // 带 model 时：被限流的模型跳过，其它模型可用
    expect(isQoderAccountHealthy(acc, Date.now(), 'qmodel')).toBe(false)
    expect(isQoderAccountHealthy(acc, Date.now(), 'dmodel')).toBe(true)

    // 挑号：qmodel 挑不到（只有这一个号），dmodel 挑得到
    expect(await pickQoderAccount(env, pid, new Set(), undefined, 'qmodel')).toBeNull()
    expect((await pickQoderAccount(env, pid, new Set(), undefined, 'dmodel'))?.uid).toBe('u1')
  })

  it('多号场景：一个号在 qmodel 上限流 → 挑号自动换到另一个健康号', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-modelcd-2'
    await writeQoderPool(env, pid, [
      account({ uid: 'a', state: { credits: 500, disabled: false, until: 0, errCount: 0 } }),
      account({ uid: 'b', state: { credits: 100, disabled: false, until: 0, errCount: 0 } }),
    ])
    await cooldownQoderAccountModel(env, pid, 'a', 'qmodel', 60_000, 'x')
    // a 积分更高，但 qmodel 上被限流 → 必须挑 b（否则整个账号被白冻，浪费一个健康号）
    const picked = await pickQoderAccount(env, pid, new Set(), undefined, 'qmodel')
    expect(picked?.uid).toBe('b')
    // 不带 model 时 a 仍是首选（积分高）
    expect((await pickQoderAccount(env, pid, new Set()))?.uid).toBe('a')
  })

  it('rate_limit 带 model → 只写模型级；不带 model → 仍写账号级（向后兼容）', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-modelcd-3'
    const provider = { id: pid, cooldown: {} } as unknown as Provider
    await writeQoderPool(env, pid, [account()])
    const classified = { status: 429, kind: 'rate_limit' as const, failover: true, cooldownSeconds: 60, message: '429', code: '429', type: 'api_error' }

    await markQoderAccountClassified(env, provider, 'u1', classified, 'qmodel')
    let acc = (await readQoderPool(env, pid))[0]
    expect(acc.state.until).toBe(0)                       // 账号级未被冻
    expect(acc.state.modelCooldowns?.qmodel).toBeGreaterThan(Date.now())
    expect(acc.state.reason).toContain('qmodel')

    await writeQoderPool(env, pid, [account()])
    await markQoderAccountClassified(env, provider, 'u1', classified)
    acc = (await readQoderPool(env, pid))[0]
    expect(acc.state.until).toBeGreaterThan(Date.now())   // 无 model → 账号级冷却（旧行为）
    expect(acc.state.modelCooldowns).toBeUndefined()
  })

  it('模型级冷却不影响 quota/auth 的账号级语义（只有 rate_limit 分流）', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-modelcd-4'
    const provider = { id: pid, cooldown: {} } as unknown as Provider
    await writeQoderPool(env, pid, [account()])
    await markQoderAccountClassified(env, provider, 'u1', {
      status: 429, kind: 'quota', failover: false, cooldownSeconds: 0, message: '额度耗尽', code: 'x', type: 'insufficient_quota',
    }, 'qmodel')
    const acc = (await readQoderPool(env, pid))[0]
    // 额度耗尽仍是**账号级**长冷却：它影响所有模型，不能降级成模型级
    expect(acc.state.until).toBeGreaterThan(Date.now())
    expect(acc.state.modelCooldowns).toBeUndefined()
  })

  it('成功后清该模型冷却（不必等自然到期）', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-modelcd-5'
    await writeQoderPool(env, pid, [account()])
    await cooldownQoderAccountModel(env, pid, 'u1', 'qmodel', 60_000, 'x')
    await cooldownQoderAccountModel(env, pid, 'u1', 'dmodel', 60_000, 'x')

    await clearQoderModelCooldown(env, pid, 'u1', 'qmodel')
    let acc = (await readQoderPool(env, pid))[0]
    expect(acc.state.modelCooldowns?.qmodel).toBeUndefined()
    expect(acc.state.modelCooldowns?.dmodel).toBeGreaterThan(Date.now())  // 别的模型不受影响

    // 不传 model → 全清
    await clearQoderModelCooldown(env, pid, 'u1')
    acc = (await readQoderPool(env, pid))[0]
    expect(acc.state.modelCooldowns).toEqual({})
  })

  it('面板状态只透出**仍在冷却中**的模型与剩余秒数（过期的条目不该显示）', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-modelcd-6'
    await writeQoderPool(env, pid, [account({
      state: { credits: 1, disabled: false, until: 0, errCount: 0, modelCooldowns: { qmodel: Date.now() + 30_000, stale: Date.now() - 1000 } },
    })])
    const st = await listQoderPoolStatus(env, pid)
    expect(Object.keys(st[0].modelCooldowns as object)).toEqual(['qmodel'])
    expect((st[0].modelCooldowns as Record<string, number>).qmodel).toBeGreaterThan(0)
    expect((st[0].modelCooldowns as Record<string, number>).qmodel).toBeLessThanOrEqual(30)
  })

  it('冷却中仍可被挑中吗：模型级与账号级冷却都要过（不是任一即可）', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-modelcd-7'
    await writeQoderPool(env, pid, [account()])
    await cooldownQoderAccount(env, pid, 'u1', 60_000, '账号级')
    // 账号级冷却 → 任何模型都挑不到（含未记录的模型）
    expect(await pickQoderAccount(env, pid, new Set(), undefined, 'dmodel')).toBeNull()
    expect(await pickQoderAccount(env, pid, new Set())).toBeNull()
  })
})

// ===== P4：model_config 元数据 =====
describe('P4 model_config 元数据：逐字段赋值（hub qoder_proxy.py:2341-2363）', () => {
  it('不再只改 key：display_name / is_vl / is_reasoning / max_input_tokens 都按模型填', () => {
    // 旧实现只有 base.model_config.key = modelKey，其余全是模板残留
    // （display_name 恒 "Lite"、is_vl/is_reasoning 恒 false、max_input_tokens 恒 180000）
    const body = JSON.parse(buildQoderBody([{ role: 'user', content: 'hi' }], 'dmodel', undefined, undefined, false, { realm: 'cn' }))
    const mc = body.model_config
    expect(mc.key).toBe('dmodel')
    expect(mc.display_name).toBe('DeepSeek-V4-Pro')
    expect(mc.is_vl).toBe(true)              // 模板是 false —— 这正是缺陷
    expect(mc.is_reasoning).toBe(true)
    expect(mc.max_input_tokens).toBe(96000)  // cn 的 dmodel 是 96k（不是模板的 180000）
  })

  it('chat_context.extra.modelConfig 副本与顶层同步（旧实现只改 key → 两处自相矛盾）', () => {
    const body = JSON.parse(buildQoderBody([{ role: 'user', content: 'hi' }], 'gm51model', undefined, undefined, false, { realm: 'cn' }))
    const emc = body.chat_context.extra.modelConfig
    expect(emc.key).toBe('gm51model')
    expect(emc.display_name).toBe('GLM-5.2')
    expect(emc.is_vl).toBe(true)
    expect(emc.is_reasoning).toBe(true)
    expect(emc.max_input_tokens).toBe(180000)
  })

  it('两区元数据确实不同，必须按 realm 取（混用会把另一区的值发给上游）', () => {
    // dmodel：intl 1M / cn 96k；dfmodel：intl is_reasoning=true / cn false
    const intl = JSON.parse(buildQoderBody([{ role: 'user', content: 'hi' }], 'dmodel', undefined, undefined, false, { realm: 'global' }))
    expect(intl.model_config.max_input_tokens).toBe(1000000)
    expect(qoderModelMeta('dmodel', 'global')?.maxInputTokens).toBe(1000000)
    expect(qoderModelMeta('dmodel', 'cn')?.maxInputTokens).toBe(96000)
    expect(qoderModelMeta('dfmodel', 'global')?.isReasoning).toBe(true)
    expect(qoderModelMeta('dfmodel', 'cn')?.isReasoning).toBe(false)
    // realm 缺省 = cn（既有调用方行为不变）
    const def = JSON.parse(buildQoderBody([{ role: 'user', content: 'hi' }], 'dmodel', undefined, undefined, false))
    expect(def.model_config.max_input_tokens).toBe(96000)
  })

  it('区域独占 key：intl 的 ultimate / cn 的 gm51model 只在各自表里', () => {
    expect(qoderModelMeta('ultimate', 'global')?.displayName).toBe('Ultimate')
    expect(qoderModelMeta('ultimate', 'cn')).toBeNull()
    expect(qoderModelMeta('gm51model', 'cn')?.displayName).toBe('GLM-5.2')
    expect(qoderModelMeta('gm51model', 'global')).toBeNull()
    expect(qoderModelMeta('q37fmodel', 'cn')?.displayName).toBe('Qwen3.7-Flash')
    expect(qoderModelMeta('q37fmodel', 'global')).toBeNull()
  })

  it('未知 key 的兜底最小：只写 display_name，**不编造**能力开关与上限', () => {
    // 把未知模型标成 is_vl:false 等于替上游宣称「它不支持图片」；模板本来就是 false，
    // 保持原样才是零信息变更。
    const body = JSON.parse(buildQoderBody([{ role: 'user', content: 'hi' }], 'qmodel_preview', undefined, undefined, false, { realm: 'cn' }))
    const mc = body.model_config
    expect(mc.key).toBe('qmodel_preview')
    expect(mc.display_name).toBe('qmodel_preview')   // 回退成 key（源 `or model_key` 同口径）
    expect(mc.is_vl).toBe(false)                     // 模板原值，未被改写
    expect(mc.is_reasoning).toBe(false)
    expect(mc.max_input_tokens).toBe(180000)         // 模板原值
    expect(QODER_DEFAULT_MAX_INPUT_TOKENS).toBe(180000)
  })

  it('模板里所有 key 都能在上游 SKU 表里找到（防止映射与表脱节）', () => {
    // MODEL_KEY_MAP 里的上游 key 若不在表里，会静默走「未知 key」兜底 → 元数据全丢
    const keys = ['auto', 'qmodel_preview', 'qmodel_latest', 'qmodel', 'q36fmodel', 'dmodel', 'dfmodel', 'gm51model', 'kmodel', 'mmodel']
    const known = keys.filter((k) => qoderModelMeta(k, 'cn') || qoderModelMeta(k, 'global'))
    // 已知落后项（源已把 qmodel_preview 归一成 qmodel_38max、q36fmodel 无对应 SKU）：
    // 这里只钉住「大部分 key 有元数据」，并显式记录这两个例外，避免以后误以为全覆盖。
    expect(known).toContain('dmodel')
    expect(known).toContain('gm51model')
    expect(qoderModelMeta('qmodel_preview', 'cn')).toBeNull()
    expect(qoderModelMeta('q36fmodel', 'cn')).toBeNull()
    expect(known.length).toBeGreaterThanOrEqual(8)
  })

  it('cpaToUpstreamKey 映射后的 key 能拿到元数据（端到端：客户端模型名 → 元数据）', () => {
    expect(qoderModelMeta(cpaToUpstreamKey('glm-5.2'), 'cn')?.displayName).toBe('GLM-5.2')
    expect(qoderModelMeta(cpaToUpstreamKey('deepseek-v4-pro'), 'cn')?.maxInputTokens).toBe(96000)
    expect(qoderModelMeta(cpaToUpstreamKey('qwen3.7-max'), 'cn')?.displayName).toBe('Qwen3.7-Max')
  })
})

// ===== P5：max_tokens / reasoning_effort =====
describe('P5 max_tokens / reasoning_effort：不再被静默丢弃（hub qoder_proxy.py:2381-2403）', () => {
  it('max_tokens 覆盖模板写死的 32768', () => {
    const body = JSON.parse(buildQoderBody([{ role: 'user', content: 'hi' }], 'auto', undefined, undefined, false, { maxTokens: 4096 }))
    expect(body.parameters.max_tokens).toBe(4096)
  })

  it('max_completion_tokens 是别名（两种写法等价）', () => {
    const a = JSON.parse(buildQoderBody([{ role: 'user', content: 'hi' }], 'auto', undefined, undefined, false, { maxTokens: 8192 }))
    expect(a.parameters.max_tokens).toBe(8192)
    // 缺省/无效值 → 保持模板值（不写畸形字段）
    for (const bad of [undefined, null, '', 0, -1, 'abc', NaN]) {
      const b = JSON.parse(buildQoderBody([{ role: 'user', content: 'hi' }], 'auto', undefined, undefined, false, { maxTokens: bad }))
      expect(b.parameters.max_tokens, `bad=${String(bad)}`).toBe(32768)
    }
    // 字符串数字接受（客户端常发字符串）
    const c = JSON.parse(buildQoderBody([{ role: 'user', content: 'hi' }], 'auto', undefined, undefined, false, { maxTokens: '2048' }))
    expect(c.parameters.max_tokens).toBe(2048)
  })

  it('缺省不传 maxTokens → 与旧行为逐字节一致（模板 32768，不加 reasoning_effort）', () => {
    const body = JSON.parse(buildQoderBody([{ role: 'user', content: 'hi' }], 'auto'))
    expect(body.parameters).toEqual({ max_tokens: 32768 })
  })

  it('档位归一：命中官方档位原样透传', () => {
    // cn 的 dmodel 官方支持 high/max（默认 max）
    expect(normalizeQoderReasoningEffort('high', qoderModelMeta('dmodel', 'cn'))).toBe('high')
    expect(normalizeQoderReasoningEffort('max', qoderModelMeta('dmodel', 'cn'))).toBe('max')
  })

  it('档位归一：不支持的档位吸附到最近合法档位（上游会静默忽略，客户端以为没生效）', () => {
    const cnD = qoderModelMeta('dmodel', 'cn')!   // 只支持 high/max
    // xhigh(5) 比 high(4) 更接近 max(6)？距离：|6-5|=1 vs |4-5|=1 → 同距，偏向默认档 max
    expect(normalizeQoderReasoningEffort('xhigh', cnD)).toBe('max')
    // low(2)：距 high(4)=2，距 max(6)=4 → high
    expect(normalizeQoderReasoningEffort('low', cnD)).toBe('high')
    // medium(3)：距 high=1，距 max=3 → high
    expect(normalizeQoderReasoningEffort('medium', cnD)).toBe('high')
    // minimal(1) → high
    expect(normalizeQoderReasoningEffort('minimal', cnD)).toBe('high')
  })

  it('关闭类取值统一映射为 none（官方通用关闭值）', () => {
    const cnD = qoderModelMeta('dmodel', 'cn')
    for (const off of ['none', 'off', 'disabled', 'disable', 'false', '0', 'no', 'OFF', ' None ']) {
      expect(normalizeQoderReasoningEffort(off, cnD), `off=${off}`).toBe('none')
    }
  })

  it('无 thinking_config 的模型（路由器 auto）→ 原样透传，不做猜测', () => {
    const autoCn = qoderModelMeta('auto', 'cn')
    expect(autoCn?.thinkingConfig).toBeUndefined()
    expect(normalizeQoderReasoningEffort('xhigh', autoCn)).toBe('xhigh')
    expect(normalizeQoderReasoningEffort('weird-level', autoCn)).toBe('weird-level')
  })

  it('有 thinking_config 但无档位表（仅开/关）→ 除 none 外不下发（避免发上游不认识的档位）', () => {
    // cn 的 qmodel：thinking_config 存在但 efforts 为空
    const cnQ = qoderModelMeta('qmodel', 'cn')!
    expect(cnQ.thinkingConfig?.efforts).toEqual([])
    expect(normalizeQoderReasoningEffort('high', cnQ)).toBeNull()
    expect(normalizeQoderReasoningEffort('xhigh', cnQ)).toBeNull()
    expect(normalizeQoderReasoningEffort('none', cnQ)).toBe('none')   // 只有 none 能关掉思考
  })

  it('空档位不下发；未知模型（表里没有）原样透传', () => {
    expect(normalizeQoderReasoningEffort('', qoderModelMeta('dmodel', 'cn'))).toBeNull()
    expect(normalizeQoderReasoningEffort(undefined, null)).toBeNull()
    // meta 为 null = 表里没有该模型 → 不猜测，原样透传
    expect(normalizeQoderReasoningEffort('high', null)).toBe('high')
  })

  it('端到端：reasoning_effort 写进 parameters（归一后的值）', () => {
    const body = JSON.parse(buildQoderBody([{ role: 'user', content: 'hi' }], 'dmodel', undefined, undefined, false, {
      realm: 'cn', reasoningEffort: 'xhigh',
    }))
    // cn dmodel 不支持 xhigh → 吸附到 max
    expect(body.parameters.reasoning_effort).toBe('max')
    // 支持 none 关闭
    const off = JSON.parse(buildQoderBody([{ role: 'user', content: 'hi' }], 'dmodel', undefined, undefined, false, {
      realm: 'cn', reasoningEffort: 'off',
    }))
    expect(off.parameters.reasoning_effort).toBe('none')
    // 只有开/关的模型传档位 → 不下发该字段（模板里本来也没有）
    const q = JSON.parse(buildQoderBody([{ role: 'user', content: 'hi' }], 'qmodel', undefined, undefined, false, {
      realm: 'cn', reasoningEffort: 'high',
    }))
    expect(q.parameters.reasoning_effort).toBeUndefined()
  })
})

// ===== Q-3：模型 → 独占区域（hub exclusive_realm，qoder_proxy.py:146-159） =====
describe('Q-3 模型区域路由：区域错配的账号被跳过，而不是拿一个必然的 403', () => {
  it('独占表按源逐条同构：国际 5 个 + 国内 2 个，其余共享', () => {
    for (const m of ['ultimate', 'performance', 'efficient', 'smodel', 'cmodel']) {
      expect(qoderExclusiveRealm(m), m).toBe('global')
    }
    for (const m of ['q37fmodel', 'gm51model']) {
      expect(qoderExclusiveRealm(m), m).toBe('cn')
    }
    // 两区共享 → 空串（不参与过滤）
    for (const m of ['qmodel', 'dmodel', 'dfmodel', 'auto', 'kmodel', 'mmodel', 'gmodel']) {
      expect(qoderExclusiveRealm(m), m).toBe('')
    }
    expect(qoderExclusiveRealm('')).toBe('')
    expect(qoderExclusiveRealm(undefined, null)).toBe('')
  })

  it('前缀匹配：官方带后缀变体（ultimate-1 等）也判独占', () => {
    expect(qoderExclusiveRealm('ultimate-1')).toBe('global')
    expect(qoderExclusiveRealm('performance-pro')).toBe('global')
    expect(qoderExclusiveRealm('gm51model-v2')).toBe('cn')
    // 大小写不敏感
    expect(qoderExclusiveRealm('GM51MODEL')).toBe('cn')
  })

  it('多候选：上游 key 与客户端原名任一命中即算（源对 (resolved, 原始) 各查一次）', () => {
    // glm-5.2 是客户端名（不在表里），gm51model 是上游 key（在表里）
    expect(qoderExclusiveRealm('glm-5.2')).toBe('')          // 单传客户端名：表里没有
    expect(qoderExclusiveRealm('glm-5.2', 'gm51model')).toBe('cn')  // 带上上游 key 即命中
    // 顺序无关
    expect(qoderExclusiveRealm('gm51model', 'glm-5.2')).toBe('cn')
  })

  it('**核心**：池内混区时，cn 独占模型绝不挑国际号（反之亦然）', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-realm-1'
    await writeQoderPool(env, pid, [
      account({ uid: 'intl', realm: 'global', state: { credits: 9999, disabled: false, until: 0, errCount: 0 } }),
      account({ uid: 'cn', realm: 'cn', state: { credits: 1, disabled: false, until: 0, errCount: 0 } }),
    ])
    // gm51model 是 CN 独占：即使国际号积分高得多，也必须挑 cn 号
    // （否则上游必 403，且该号被白冻 60 秒 —— 见 markQoderAccountClassified 的 auth 分支）
    const pickedCn = await pickQoderAccount(env, pid, new Set(), undefined, 'gm51model', 'cn')
    expect(pickedCn?.uid).toBe('cn')
    // 国际独占模型反过来挑国际号
    const pickedIntl = await pickQoderAccount(env, pid, new Set(), undefined, 'smodel', 'global')
    expect(pickedIntl?.uid).toBe('intl')
    // 共享模型：不受区域限制，回到「积分高者优先」
    expect((await pickQoderAccount(env, pid, new Set(), undefined, 'dmodel', ''))?.uid).toBe('intl')
  })

  it('全池区域都不匹配 → 挑号返回 null（调用方据此报「模型选错」而非「账号都不可用」）', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-realm-2'
    await writeQoderPool(env, pid, [
      account({ uid: 'intl1', realm: 'global' }),
      account({ uid: 'intl2', realm: 'global' }),
    ])
    // 池里只有国际号，要一个 CN 独占模型 → 挑不到
    expect(await pickQoderAccount(env, pid, new Set(), undefined, 'gm51model', 'cn')).toBeNull()
    // 且必须能与「全冷却」区分开：池子里**确实**没有 cn 账号
    const pool = await readQoderPool(env, pid)
    expect(qoderPoolServesModel(pool, 'cn')).toBe(false)
    expect(qoderPoolServesModel(pool, 'global')).toBe(true)
    expect(qoderPoolServesModel(pool, '')).toBe(true)
  })

  it('区域过滤对「用户固定账号」同样生效：固定的账号若区域错配也不能选', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-realm-3'
    await writeQoderPool(env, pid, [
      account({ uid: 'intl', realm: 'global' }),
      account({ uid: 'cn', realm: 'cn' }),
    ])
    // 用户把国际号设为首选，但请求的是 CN 独占模型 → 不能因为「用户指定了」就发出去
    const pinned = await pickQoderAccount(env, pid, new Set(), 'intl', 'gm51model', 'cn')
    expect(pinned?.uid).toBe('cn')
  })

  it('realm 缺省的账号按 cn 处理（既有部署不带该字段）', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-realm-4'
    const a = account({ uid: 'norealm' })
    delete (a as { realm?: string }).realm
    await writeQoderPool(env, pid, [a])
    // 缺省 cn → cn 独占模型可挑，国际独占模型挑不到
    expect((await pickQoderAccount(env, pid, new Set(), undefined, 'gm51model', 'cn'))?.uid).toBe('norealm')
    expect(await pickQoderAccount(env, pid, new Set(), undefined, 'smodel', 'global')).toBeNull()
  })

  it('禁用账号不计入「本区有号」：避免报成「模型选错」而实际是账号被禁', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-realm-5'
    await writeQoderPool(env, pid, [
      account({ uid: 'cn-off', realm: 'cn', enabled: false, state: { credits: 0, disabled: true, until: 0, errCount: 0 } }),
    ])
    const pool = await readQoderPool(env, pid)
    expect(qoderPoolServesModel(pool, 'cn')).toBe(false)
  })

  it('**回归**：不带 requiredRealm 时行为与改动前完全一致（既有调用方零影响）', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-realm-6'
    await writeQoderPool(env, pid, [
      account({ uid: 'intl', realm: 'global', state: { credits: 9999, disabled: false, until: 0, errCount: 0 } }),
      account({ uid: 'cn', realm: 'cn', state: { credits: 1, disabled: false, until: 0, errCount: 0 } }),
    ])
    // 不传区域 → 不做任何区域过滤，仍是积分高者优先
    expect((await pickQoderAccount(env, pid, new Set()))?.uid).toBe('intl')
    expect((await pickQoderAccount(env, pid, new Set(), undefined, 'gm51model'))?.uid).toBe('intl')
  })

  it('qoderAccountServesModel 直判：缺省账号按 cn，undefined 区域恒放行', () => {
    const intl = account({ realm: 'global' })
    const cn = account({ realm: 'cn' })
    expect(qoderAccountServesModel(intl, 'global')).toBe(true)
    expect(qoderAccountServesModel(intl, 'cn')).toBe(false)
    expect(qoderAccountServesModel(cn, 'cn')).toBe(true)
    expect(qoderAccountServesModel(cn, 'global')).toBe(false)
    // 空区域 = 共享模型，两个账号都放行
    expect(qoderAccountServesModel(intl, '')).toBe(true)
    expect(qoderAccountServesModel(cn, undefined)).toBe(true)
  })
})

// ===== 项 9：下一轮放量窗口（hub next_checkin_window，qoder_accounts.py:850） =====
describe('项 9 next_available_at：告诉用户是「今天」还是「明天」的 10:00', () => {
  it('CST 10:00 之前 → 指向**今天** 10:00', () => {
    // 2026-10-05 09:00 CST = 01:00Z
    const w = qoderNextCheckinWindow(Date.parse('2026-10-05T01:00:00Z'))
    expect(w.at).toBe(Date.parse('2026-10-05T02:00:00Z'))   // 10:00 CST
    expect(w.label).toBe('10-05 10:00（UTC+8）')
  })

  it('恰好 10:00 → 指向**明天** 10:00（今天的已放完）', () => {
    const w = qoderNextCheckinWindow(Date.parse('2026-10-05T02:00:00Z'))
    expect(w.at).toBe(Date.parse('2026-10-06T02:00:00Z'))
    expect(w.label).toBe('10-06 10:00（UTC+8）')
  })

  it('10:00 之后 → 指向明天；边界前后各差一分钟都判对', () => {
    // 09:59 CST → 今天
    expect(qoderNextCheckinWindow(Date.parse('2026-10-05T01:59:00Z')).label).toBe('10-05 10:00（UTC+8）')
    // 10:01 CST → 明天
    expect(qoderNextCheckinWindow(Date.parse('2026-10-05T02:01:00Z')).label).toBe('10-06 10:00（UTC+8）')
    // 23:00 CST → 明天
    expect(qoderNextCheckinWindow(Date.parse('2026-10-05T15:00:00Z')).label).toBe('10-06 10:00（UTC+8）')
    // 次日 00:30 CST（= 前一天 16:30Z）→ 今天（即 10-06）10:00，不是 10-07
    expect(qoderNextCheckinWindow(Date.parse('2026-10-05T16:30:00Z')).label).toBe('10-06 10:00（UTC+8）')
  })

  it('与 qoderDailyRoundOpen 的语义不矛盾：过了 10:00 时前者 true、后者指向明天', () => {
    const at = Date.parse('2026-10-05T05:00:00Z') // 13:00 CST
    expect(qoderDailyRoundOpen(at)).toBe(true)                  // 今天这轮已开
    expect(qoderNextCheckinWindow(at).label).toBe('10-06 10:00（UTC+8）') // 下次是明天
  })

  it('跨月/跨年边界（日期进位不能算错）', () => {
    // 2026-10-31 11:00 CST → 11-01
    expect(qoderNextCheckinWindow(Date.parse('2026-10-31T03:00:00Z')).label).toBe('11-01 10:00（UTC+8）')
    // 2026-12-31 11:00 CST → 次年 01-01
    expect(qoderNextCheckinWindow(Date.parse('2026-12-31T03:00:00Z')).label).toBe('01-01 10:00（UTC+8）')
    // 2026-02-28 11:00 CST → 02-29（2026 非闰年 → 03-01）
    expect(qoderNextCheckinWindow(Date.parse('2026-02-28T03:00:00Z')).label).toBe('03-01 10:00（UTC+8）')
  })

  it('**核心**：每条「没领到」的结局都带上下次窗口（含 10:00 前那条最容易漏的分支）', async () => {
    // 2026-10-09 09:00 CST：轮次未刷新 —— 正是用户点「领兑换码」拿到签到报错的场景
    const before = Date.UTC(2026, 9, 9, 1, 0, 0)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      campaigns: [{
        campaignId: 'c1', campaignKey: 'daily', actionType: 'CLAIM_BENEFIT',
        claimStatus: 'CLAIMED', benefit: { kind: 'CREDITS', amount: 100 },
      }],
    }), { status: 200 })))
    const r = await performQoderCheckin('dt-t', 'cn', 'u1', undefined, undefined, { now: before })
    expect(r.success).toBe(false)
    expect(r.message).toContain('尚未刷新')
    expect(r.nextAvailableLabel).toBe('10-09 10:00（UTC+8）')   // 今天，不是明天
    expect(r.nextAvailableAt).toBe(Math.floor(Date.parse('2026-10-09T02:00:00Z') / 1000))
  })

  it('无活动（列表为空）这类失败也带下次窗口', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ campaigns: [] }), { status: 200 })))
    const r = await performQoderCheckin('dt-t', 'cn', 'u1', undefined, undefined, { now: Date.UTC(2026, 9, 9, 5, 0, 0) })
    expect(r.success).toBe(false)
    expect(r.nextAvailableLabel).toBe('10-10 10:00（UTC+8）')   // 13:00 CST → 明天
  })

  it('领取成功也带下次窗口（面板常显，不必等到失败才知道）', async () => {
    // claim 与 campaigns 列表是两个不同 URL，必须分别 stub —— 只回一个 body 会让 claim 解析失败
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.endsWith('/sash/api/v1/me/campaigns')) {
        return new Response(JSON.stringify({
          campaigns: [{
            campaignId: 'c1', campaignKey: 'daily', actionType: 'CLAIM_BENEFIT',
            claimStatus: 'CLAIMABLE', benefit: { kind: 'CREDITS', amount: 100 },
          }],
        }), { status: 200 })
      }
      if (url.endsWith('/sash/api/v1/me/campaigns/c1/claim')) {
        return new Response(JSON.stringify({ status: 'CLAIMED', replayed: false, benefit: { kind: 'CREDITS', amount: 100 } }), { status: 200 })
      }
      throw new Error(`unexpected url ${url}`)
    }))
    const r = await performQoderCheckin('dt-t', 'cn', 'u1', undefined, undefined, { now: Date.UTC(2026, 9, 9, 5, 0, 0) })
    expect(r.success, JSON.stringify(r)).toBe(true)
    expect(r.nextAvailableLabel).toBe('10-10 10:00（UTC+8）')
  })
})

// ===== 之后做第 3 项：瞬时故障同账号重试 + 短冷却等待 =====
describe('瞬时故障：同账号重试，不再一次抖动就烧掉一个账号', () => {
  /** 构造一个可注入会话的直发调用（不经过池），记录等待时长。 */
  async function callDirect(
    fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
    opts?: { delay?: (ms: number) => Promise<void>; signal?: AbortSignal }
  ) {
    const session = await cosySessionFor('dt-transient', 'drt-t', 'uid-transient', 'T')
    vi.stubGlobal('fetch', vi.fn(fetchImpl))
    const waits: number[] = []
    const delay = opts?.delay || (async (ms: number) => { waits.push(ms) })
    const resp = await proxyQoderChatRequest({} as Env, { id: 'qoder' } as Provider, {
      model: 'auto', stream: false, messages: [{ role: 'user', content: 'hi' }],
    }, { session: { session }, stream: false, delay, signal: opts?.signal })
    return { resp, waits }
  }

  const okBody = JSON.stringify({
    id: 'c1', model: 'auto',
    choices: [{ index: 0, message: { role: 'assistant', content: '好' }, finish_reason: 'stop' }],
  })
  // 上游帧必须包在信封里（外层 {headers, body}），内层才是 OpenAI chunk；
  // 直接发裸 chunk 会被 readQoderFrame 判为非信封帧 → 零有效帧 → 502。
  const sseOk = `data: ${JSON.stringify({ headers: {}, body: okBody })}\n\ndata: ${JSON.stringify({ headers: {}, body: '[DONE]' })}\n\n`

  it('传输层抖动（SSL EOF）→ 原地重试并成功，**不换号**', async () => {
    let calls = 0
    const { resp, waits } = await callDirect(async () => {
      calls++
      if (calls === 1) throw new Error('SSL: UNEXPECTED_EOF_WHILE_READING')
      return new Response(sseOk, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    })
    expect(calls).toBe(2)              // 第一次抛错，第二次成功
    expect(resp.status).toBe(200)
    expect(waits).toEqual([1000])      // 退避 1s（第 1 次重试）
  })

  it('连续两次抖动 → 共 3 次尝试（1 + 2 次重试），退避 1s、2s', async () => {
    let calls = 0
    const { resp, waits } = await callDirect(async () => {
      calls++
      if (calls <= 2) throw new Error('connection reset by peer')
      return new Response(sseOk, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    })
    expect(calls).toBe(3)
    expect(resp.status).toBe(200)
    expect(waits).toEqual([1000, 2000])
  })

  it('三次都抖动 → 用尽重试后如实报错（不再无限重试）', async () => {
    let calls = 0
    const { resp, waits } = await callDirect(async () => {
      calls++
      throw new Error('fetch failed: network error')
    })
    expect(calls).toBe(3)              // 1 次原始 + 2 次重试
    expect(waits).toEqual([1000, 2000])
    expect(resp.status).toBe(502)      // 归类为不可用
  })

  it('瞬时 HTTP（503/418）→ 原地重试；**每次都重新签名**（date/requestId 参与签名，不能复用）', async () => {
    const auths: string[] = []
    let calls = 0
    const { resp } = await callDirect(async (_url, init) => {
      calls++
      auths.push(String((init?.headers as Record<string, string>)?.Authorization || ''))
      if (calls === 1) return new Response('upstream boom', { status: 503 })
      return new Response(sseOk, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    })
    expect(calls).toBe(2)
    expect(resp.status).toBe(200)
    // 两次都带 COSY Bearer；且**不是同一个串**（requestId 是随机 uuid）
    expect(auths[0]).toContain('Bearer COSY.')
    expect(auths[1]).toContain('Bearer COSY.')
    expect(auths[0]).not.toBe(auths[1])
  })

  it('**不该重试**：401/403/429 立即返回（各自有专门路径，重试只会加剧）', async () => {
    for (const status of [401, 403, 429]) {
      let calls = 0
      const { resp } = await callDirect(async () => {
        calls++
        return new Response(JSON.stringify({ error: { message: 'nope' } }), { status })
      })
      expect(calls, `HTTP ${status} 不应重试`).toBe(1)
      expect(resp.status).toBe(status === 429 ? 429 : (status === 401 ? 401 : 403))
    }
  })

  it('**不该重试**：客户端参数错（invalid_request_error）即使状态是 500', async () => {
    let calls = 0
    const { resp } = await callDirect(async () => {
      calls++
      return new Response(JSON.stringify({ error: { code: 'invalid_request_error', message: 'Range of max_tokens is invalid' } }), { status: 500 })
    })
    expect(calls).toBe(1)              // 命中 CLIENT_FAULT_MARKERS → 不重试
    expect(resp.status).toBeGreaterThanOrEqual(400)
  })

  it('**不该重试**：内容审核（确定性拒绝，重试必然再失败）', async () => {
    let calls = 0
    const { resp } = await callDirect(async () => {
      calls++
      return new Response(JSON.stringify({ error: { message: 'DataInspectionFailed: Input text data may contain inappropriate content.' } }), { status: 500 })
    })
    expect(calls).toBe(1)
    expect(resp.status).toBe(400)      // 内容审核归 400（让客户端改输入）
  })

  it('客户端已断开（AbortError）→ 不重试（否则白烧上游配额）', async () => {
    const ac = new AbortController()
    let calls = 0
    const { resp } = await callDirect(async () => {
      calls++
      ac.abort()
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    }, { signal: ac.signal })
    expect(calls).toBe(1)
    expect(resp.status).toBeGreaterThanOrEqual(400)
  })

  it('判定函数本身：瞬时/非瞬时的边界逐条对齐源', () => {
    // 瞬时：418 / 5xx / 4xx+provider_error
    expect(isQoderTransientUpstream(418, 'provider_error')).toBe(true)
    expect(isQoderTransientUpstream(500, '')).toBe(true)
    expect(isQoderTransientUpstream(502, 'bad gateway')).toBe(true)
    expect(isQoderTransientUpstream(504, '')).toBe(true)
    expect(isQoderTransientUpstream(400, 'provider_error: upstream failed')).toBe(true)
    // 非瞬时：凭证/频控
    for (const s of [401, 403, 429]) expect(isQoderTransientUpstream(s, 'provider_error'), `HTTP ${s}`).toBe(false)
    // 非瞬时：客户端确定性错误（即使 5xx）
    expect(isQoderTransientUpstream(500, 'invalid_parameter_error')).toBe(false)
    expect(isQoderTransientUpstream(500, 'DataInspectionFailed')).toBe(false)
    expect(isQoderTransientUpstream(500, 'permission_error')).toBe(false)
    // 非瞬时：普通 400（无 provider_error）
    expect(isQoderTransientUpstream(400, 'bad request')).toBe(false)
  })

  it('传输层判定：AbortError 不算瞬时（由调用方按「谁中止的」处理）', () => {
    expect(isQoderTransientTransport(new Error('SSL: UNEXPECTED_EOF_WHILE_READING'))).toBe(true)
    expect(isQoderTransientTransport(new Error('connection reset by peer'))).toBe(true)
    expect(isQoderTransientTransport(new Error('fetch failed: network error'))).toBe(true)
    expect(isQoderTransientTransport(new Error('operation timed out'))).toBe(true)
    expect(isQoderTransientTransport(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(false)
    expect(isQoderTransientTransport(new Error('some unrelated failure'))).toBe(false)
  })
})

describe('短冷却等待：全池只是短暂冷却时等待，而不是报「所有账号不可用」', () => {
  it('账号级短冷却（≤10s）→ 返回最短剩余；超过上限 → 不等', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-shortcool-1'
    await writeQoderPool(env, pid, [account({ uid: 'a' })])
    const now = Date.now()
    // 5s 冷却 → 在窗口内
    await cooldownQoderAccount(env, pid, 'a', 5000, '瞬时抖动')
    const pool = await readQoderPool(env, pid)
    const w = qoderShortCooldownWait(pool, new Set(), Date.now())
    expect(w).toBeGreaterThan(0)
    expect(w).toBeLessThanOrEqual(5000)
    // 60s 冷却 → 超过 10s 上限，不等
    await cooldownQoderAccount(env, pid, 'a', 60000, '长冷却')
    const pool2 = await readQoderPool(env, pid)
    expect(qoderShortCooldownWait(pool2, new Set(), Date.now())).toBe(0)
  })

  it('exclude 里的账号不算：等它也不会被本请求使用，纯属浪费', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-shortcool-2'
    await writeQoderPool(env, pid, [account({ uid: 'a' })])
    await cooldownQoderAccount(env, pid, 'a', 5000, '抖动')
    const pool = await readQoderPool(env, pid)
    expect(qoderShortCooldownWait(pool, new Set(), Date.now())).toBeGreaterThan(0)
    // 已试过该账号 → 不再为它等待
    expect(qoderShortCooldownWait(pool, new Set(['a']), Date.now())).toBe(0)
  })

  it('该模型正被上游频控（429 语义）→ 返回 0，不在这里等', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-shortcool-3'
    await writeQoderPool(env, pid, [account({ uid: 'a' })])
    await cooldownQoderAccount(env, pid, 'a', 5000, '抖动')
    await cooldownQoderAccountModel(env, pid, 'a', 'qmodel', 30000, '429')
    const pool = await readQoderPool(env, pid)
    // 不带 model：可等
    expect(qoderShortCooldownWait(pool, new Set(), Date.now())).toBeGreaterThan(0)
    // 带被频控的 model：交给 429 路径，不等待
    expect(qoderShortCooldownWait(pool, new Set(), Date.now(), { model: 'qmodel' })).toBe(0)
  })

  it('禁用账号不计入等待；区域过滤生效', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-shortcool-4'
    await writeQoderPool(env, pid, [
      account({ uid: 'off', enabled: false }),
      account({ uid: 'intl', realm: 'global' }),
    ])
    await cooldownQoderAccount(env, pid, 'off', 5000, 'x')
    await cooldownQoderAccount(env, pid, 'intl', 5000, 'x')
    const pool = await readQoderPool(env, pid)
    // 只有 intl 在冷却且未禁用：要 cn 区域 → 不等（intl 不服务 cn）
    expect(qoderShortCooldownWait(pool, new Set(), Date.now(), { realm: 'cn' })).toBe(0)
    // 要 global 区域 → 等 intl
    expect(qoderShortCooldownWait(pool, new Set(), Date.now(), { realm: 'global' })).toBeGreaterThan(0)
  })

  it('**端到端**：池内唯一账号处于短冷却 → 等待后续用同一账号成功，而不是返回 503', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-shortcool-e2e'
    // 该账号带真实 token（buildQoderAccountSession 会用它）
    const session = await cosySessionFor('dt-e2e', 'drt-e2e', 'uid-e2e', 'E')
    await writeQoderPool(env, pid, [account({
      uid: 'uid-e2e',
      token: { access_token: 'dt-e2e', refresh_token: 'drt-e2e', expires_at: Date.now() + 86400000, updated_at: 0 },
    })])
    // 冷却 9s：既在 10s 等待上限内，又留出足够宽的容差——用 3s 时，整机在高负载
    // （126 个测试文件并行）下卡顿几秒就会让冷却自然到期，用例随机失败。
    await cooldownQoderAccount(env, pid, 'uid-e2e', 9000, '瞬时抖动')
    // 上游正常；账号冷却在第一次 pick 时被跳过 → 等待 → 冷却到期 → 成功
    const body = JSON.stringify({
      id: 'c1', model: 'auto',
      choices: [{ index: 0, message: { role: 'assistant', content: '好' }, finish_reason: 'stop' }],
    })
    const frame = `data: ${JSON.stringify({ headers: {}, body })}\n\ndata: ${JSON.stringify({ headers: {}, body: '[DONE]' })}\n\n`
    vi.stubGlobal('fetch', vi.fn(async () => new Response(frame, {
      status: 200, headers: { 'Content-Type': 'text/event-stream' },
    })))
    const waits: number[] = []
    const resp = await proxyQoderChatRequest(env, {
      id: pid,
      // buildQoderAccountSession 需要 provider.oauth 才会构造会话；缺了它会被当成
      // 「token 刷新失败」→ 禁用账号（与本用例要验的短冷却等待无关，属测试装置缺失）。
      oauth: { flowType: 'qoder', loginRealm: 'cn' },
    } as unknown as Provider, {
      model: 'auto', stream: false, messages: [{ role: 'user', content: 'hi' }],
    }, {
      stream: false,
      // 等待时把冷却真正走完（否则 pick 仍然挑不到）：注入的 delay 里推进真实时钟不可行，
      // 故这里直接清掉冷却，模拟「等待期间冷却到期」。
      delay: async (ms) => {
        waits.push(ms)
        await clearQoderModelCooldown(env, pid, 'uid-e2e')
        const pool = await readQoderPool(env, pid)
        const acc = pool.find((a) => a.uid === 'uid-e2e')!
        acc.state = { ...acc.state, until: 0 }
        await writeQoderPool(env, pid, pool)
      },
    })
    expect(waits.length, '应当等待了短冷却').toBe(1)
    expect(waits[0]).toBeGreaterThan(0)
    expect(waits[0]).toBeLessThanOrEqual(9250)
    expect(resp.status, JSON.stringify(await resp.clone().json().catch(() => ({})))).toBe(200)
  })
})
