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
import { qoderModelMeta, normalizeQoderReasoningEffort, QODER_DEFAULT_MAX_INPUT_TOKENS } from './model-meta'
import {
  proEligibility,
  proClaim,
  performQoderCheckin,
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
  listQoderPoolStatus,
  setQoderCampaignCode,
  blockQoderCampaign,
  isQoderCampaignBlocked,
  readQoderPool,
  writeQoderPool,
  type QoderPoolAccount,
} from './pool'
import { markQoderAccountClassified } from './proxy'
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
    expect(r).toEqual({ ok: true, eligible: true })
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

  it('404/403/410 → 查询成功但不可领取（不是查询失败）', async () => {
    // 端点不存在/活动下线时，账号侧正确结论就是「没得领」；报成失败会让批量汇总
    // 每次都多一条假告警（hub 明确注释了这一点）。
    for (const status of [404, 403, 410]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status })))
      expect(await proEligibility('t', 'cn', 'u')).toEqual({ ok: true, eligible: false })
    }
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
