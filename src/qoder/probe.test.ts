/**
 * probe.test.ts — 面板「刷新账号池」的额度探测。
 *
 * 为什么需要它：Qoder 的额度**只有签到会拉**，所以「额度包明细 / 到期天数」以及
 * 「7 天内到期优先消耗」的挑号依据，都可能停在最近一次签到时的数据。这个探测入口把
 * 数据刷新变成用户随时能点的动作。
 *
 * 两条最容易搞错、也最要紧的语义：
 *   1. 探测**只写额度与额度包，绝不解冻账号**——点一下刷新就把 429 冷却中的号放出来，
 *      等于绕过限流保护；禁用标记同理（留给签到，因为签到能证明 token 有效）。
 *   2. 探测**不能把签到包的到期时间擦成长期**（没有新 grant，必须用池里已存的值兜底），
 *      否则「到期优先」会静默失效。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv, Provider } from '../types'
import { handleOAuthStatus } from '../admin'
import { renderAdminPage } from '../pages'
import { setProviders } from '../storage'
import { cooldownQoderAccount, disableQoderAccount, listQoderPoolStatus, writeQoderPool, type QoderPoolAccount } from './pool'
import { probeQoderPoolQuota } from './probe'
import { QODER_PACK_ADDON } from './billing'
import { formatCstWallClock, parseCstWallClock } from '../credit-expiry'
import type { PackageInfo } from '../types'

const DAY_MS = 24 * 60 * 60 * 1000

/** 复刻线上真实响应（2026-10-02 实测结构）。 */
const QUOTA_JSON = {
  userType: 'personal_professional_trial',
  isQuotaExceeded: false,
  expiresAt: 1792146789293,
  userQuota: { total: 300, used: 0, remaining: 300, unit: 'credits' },
  addOnQuota: { total: 100, used: 0, remaining: 100, unit: 'credits' },
}

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
  return { env: { KV: kv } as unknown as AppEnv['Bindings'], store }
}

function qoderProvider(): Provider {
  return {
    id: 'qoder',
    name: 'QoderWork',
    baseUrl: 'https://gateway.qoder.com.cn',
    apiType: 'openai',
    apiKeys: [],
    models: [{ id: 'qfmodel', enabled: true }],
    enabled: true,
    createdAt: 'a',
    updatedAt: 'a',
    authType: 'oauth-device',
    oauth: { flowType: 'qoder' },
  } as unknown as Provider
}

function account(over: Partial<QoderPoolAccount> = {}): QoderPoolAccount {
  return {
    uid: 'u1',
    nickname: 'u1',
    token: { access_token: 'dt-test', refresh_token: 'drt-test', expires_at: Date.now() + 30 * DAY_MS, updated_at: 0 },
    enabled: true,
    state: { credits: 0, disabled: false, until: 0, errCount: 0 },
    updatedAt: 0,
    realm: 'global',
    ...over,
  }
}

/** 假 Context：handleOAuthStatus 只用到 param / query / json / env。 */
function statusCtx(env: AppEnv['Bindings'], query: Record<string, string> = {}) {
  const captured: { body: any; status: number } = { body: null, status: 200 }
  const c = {
    req: { param: () => 'qoder', query: (k: string) => query[k], raw: new Request('https://gw.test/admin') },
    env,
    json: (b: any, s?: number) => { captured.body = b; captured.status = s ?? 200; return b },
  } as unknown as Context<AppEnv>
  return { c, captured }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('probeQoderPoolQuota：只写额度，绝不解冻账号', () => {
  it('成功：额度与额度包落盘，返回每个账号的结果', async () => {
    const { env } = makeEnv()
    await writeQoderPool(env, 'qoder', [account()])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(QUOTA_JSON), { status: 200 })))

    const out = await probeQoderPoolQuota(env, qoderProvider())
    expect(out).toEqual([{ uid: 'u1', ok: true, credits: 400 }])

    const st = (await listQoderPoolStatus(env, 'qoder'))[0]
    expect(st.credits).toBe(400)
    const packs = st.packages as PackageInfo[]
    expect(packs.map((p) => p.name)).toEqual(['套餐额度', QODER_PACK_ADDON])
    // 套餐包的到期 = 上游 quota/usage 顶层的 expiresAt（ms），落成 CST 墙钟串后往返一致
    // （墙钟串是**秒级**格式，故按秒对齐比较）
    expect(parseCstWallClock(packs[0].expireAt)).toBe(Math.floor(QUOTA_JSON.expiresAt / 1000) * 1000)
    expect(st.packagesAt).toBeTypeOf('number')
  })

  it('冷却中的账号不会被探测解冻（点一下刷新不该绕过限流保护）', async () => {
    const { env } = makeEnv()
    await writeQoderPool(env, 'qoder', [account()])
    await cooldownQoderAccount(env, 'qoder', 'u1', 60_000, '限流（429）')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(QUOTA_JSON), { status: 200 })))

    await probeQoderPoolQuota(env, qoderProvider())

    const st = (await listQoderPoolStatus(env, 'qoder'))[0]
    expect(st.credits).toBe(400)      // 额度照常刷新
    expect(st.cooling).toBe(true)     // 冷却保留
    expect(st.reason).toBe('限流（429）')
  })

  it('已禁用的账号也不会被探测解冻（禁用只能由签到或人工清除）', async () => {
    const { env } = makeEnv()
    await writeQoderPool(env, 'qoder', [account()])
    await disableQoderAccount(env, 'qoder', 'u1', 'token 刷新失败（需重新登录）')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(QUOTA_JSON), { status: 200 })))

    await probeQoderPoolQuota(env, qoderProvider())

    const st = (await listQoderPoolStatus(env, 'qoder'))[0]
    expect(st.disabled).toBe(true)
    expect(st.reason).toBe('token 刷新失败（需重新登录）')
  })

  it('没有新 grant 时，签到包的到期时间沿用池里已存的值（不擦成长期）', async () => {
    const { env } = makeEnv()
    const prevExpiry = Date.now() + 3 * DAY_MS
    const prev: PackageInfo[] = [
      { name: QODER_PACK_ADDON, expireAt: formatCstWallClock(prevExpiry), size: 100, used: 0, unit: 'credits' },
    ]
    await writeQoderPool(env, 'qoder', [account({ state: { credits: 100, disabled: false, until: 0, errCount: 0, packages: prev } })])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(QUOTA_JSON), { status: 200 })))

    await probeQoderPoolQuota(env, qoderProvider())

    const packs = (await listQoderPoolStatus(env, 'qoder'))[0].packages as PackageInfo[]
    const addon = packs.find((p) => p.name === QODER_PACK_ADDON)!
    // 秒级取整误差内与原来的到期时刻一致
    expect(Math.abs(Date.parse(prev[0].expireAt) - Date.parse(addon.expireAt))).toBeLessThan(1000)
  })

  it('单个账号失败不影响其余账号，且失败原因如实带出', async () => {
    const { env } = makeEnv()
    await writeQoderPool(env, 'qoder', [
      account({ uid: 'bad', token: { access_token: 'dt-bad', refresh_token: 'r', expires_at: Date.now() + DAY_MS, updated_at: 0 } }),
      account({ uid: 'good', token: { access_token: 'dt-good', refresh_token: 'r', expires_at: Date.now() + DAY_MS, updated_at: 0 } }),
    ])
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      // 第一个账号 500，第二个正常：探测按账号串行，靠 Authorization 头区分是哪个号
      const auth = String((init?.headers as Record<string, string>)?.Authorization || '')
      return auth.includes('dt-bad')
        ? new Response('boom', { status: 500 })
        : new Response(JSON.stringify(QUOTA_JSON), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const out = await probeQoderPoolQuota(env, qoderProvider())
    expect(out.map((r) => r.ok)).toEqual([false, true])
    expect(out[0].error).toContain('quota/usage http 500')
    expect(out[1].credits).toBe(400)
  })

  it('没有 access token → 记失败，不请求上游', async () => {
    const { env } = makeEnv()
    await writeQoderPool(env, 'qoder', [account({ token: { access_token: '', refresh_token: '', expires_at: 0, updated_at: 0 } })])
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(QUOTA_JSON), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const out = await probeQoderPoolQuota(env, qoderProvider())
    expect(out).toEqual([{ uid: 'u1', ok: false, error: '无 access token' }])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('GET /admin/api/oauth/:id/status?credits=1：探测是显式开关', () => {  it('带 credits=1 → 探测并把结果放进响应', async () => {
    const { env } = makeEnv()
    await setProviders(env as never, [qoderProvider()])
    await writeQoderPool(env, 'qoder', [account()])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(QUOTA_JSON), { status: 200 })))

    const { c, captured } = statusCtx(env, { credits: '1' })
    await handleOAuthStatus(c)

    expect(captured.status).toBe(200)
    expect(captured.body.data.quotaProbe).toEqual([{ uid: 'u1', ok: true, credits: 400 }])
    expect(captured.body.data.pool[0].credits).toBe(400)
  })

  it('不带 credits → 一次上游请求都不发（脚本/探活调用不该被动付这个代价）', async () => {
    const { env } = makeEnv()
    await setProviders(env as never, [qoderProvider()])
    await writeQoderPool(env, 'qoder', [account()])
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(QUOTA_JSON), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const { c, captured } = statusCtx(env, {})
    await handleOAuthStatus(c)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(captured.body.data.quotaProbe).toBeUndefined()
    expect(captured.body.data.pool).toHaveLength(1)
  })
})

/**
 * 面板接线：按钮必须真的带上 credits=1，且**失败要显示出来**。
 * 只显示「已刷新」是最糟的结果——用户点刷新就是为了确认哪个号还能用，
 * 而某个号 token 失效时恰恰表现为探测失败。
 */
function inlineScripts(html: string): string[] {
  const out: string[] = []
  const re = /<script([^>]*)>([\s\S]*?)<\/script[^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || ''
    if (/\bsrc=/i.test(attrs)) continue
    const t = (attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i)?.[1] || '').toLowerCase()
    if (t && t !== 'text/javascript' && t !== 'application/javascript' && t !== 'module') continue
    out.push(m[2])
  }
  return out
}

async function renderPage(providers: Provider[]): Promise<string> {
  const app = new Hono<AppEnv>()
  app.get('/admin', (c) => renderAdminPage(c))
  const { env } = makeEnv()
  await setProviders(env as never, providers)
  return await (await app.request('/admin', {}, env as never)).text()
}

describe('面板接线：「刷新账号池」带 credits=1，探测摘要逐条带出失败原因', () => {
  it('按钮带上 credits=1', async () => {
    const js = inlineScripts(await renderPage([qoderProvider()])).join('\n')
    expect(js).toContain("'/status?credits=1'")
    expect(js).toContain('function qoderProbeSummary')
  })

  it('摘要：部分失败列出每个失败账号与原因；整段失败/无账号/旧后端都有明确文案', async () => {
    const js = inlineScripts(await renderPage([qoderProvider()])).join('\n')
    const m = js.match(/function qoderProbeSummary\(count, probe\) \{([\s\S]*?)\n\}/)
    expect(m, '未找到 qoderProbeSummary：额度探测摘要被删除或改名了？').not.toBeNull()
    // 抠出的是函数体（不含 function 头），所以按参数名包一层再执行
    const summary = new Function('count', 'probe', m![1]) as (c: number, p: unknown) => string

    expect(summary(2, [
      { uid: 'abcdefgh-1111', ok: true, credits: 400 },
      { uid: 'abcdefgh-2222', ok: false, error: 'quota/usage http 500' },
    ])).toBe('共 2 个账号 · 额度已刷新 1/2，失败 abcdefgh：quota/usage http 500')
    // 全部成功时不带失败段
    expect(summary(1, [{ uid: 'u', ok: true, credits: 400 }])).toBe('共 1 个账号 · 额度已刷新 1/1')
    // 整段探测挂掉 / 池内无账号 / 旧后端不返回 quotaProbe：三种都要说清楚，不假装成功
    expect(summary(1, { error: '网络错误' })).toContain('额度探测失败：网络错误')
    expect(summary(0, [])).toContain('池内无账号')
    expect(summary(1, undefined)).toBe('共 1 个账号')
  })
})
