/**
 * probe.test.ts — 面板「刷新账号池」的额度探测。
 *
 * 为什么需要它：Qoder 的额度**只有签到会拉**，所以「额度包明细 / 到期天数」以及
 * 「7 天内到期优先消耗」的挑号依据，都可能停在最近一次签到时的数据。这个探测入口把
 * 数据刷新变成用户随时能点的动作。
 *
 * 两条最容易搞错、也最要紧的语义：
 *   1. 探测**只写额度、额度包明细与账本，绝不解冻账号**——点一下刷新就把 429 冷却中的号放出来，
 *      等于绕过限流保护；禁用标记同理（留给签到，因为签到能证明 token 有效）。
 *   2. 探测**不能把逐笔到期明细擦掉**：它没有新 grant，只能做结算（FIFO）与首次迁移，
 *      账本里已观测到的每笔到期时间必须原样保留，否则「到期优先」会静默失效。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv, Provider } from '../types'
import { handleOAuthStatus } from '../admin'
import { renderAdminPage } from '../pages'
import { setProviders } from '../storage'
import { cooldownQoderAccount, disableQoderAccount, listQoderPoolStatus, readQoderPool, writeQoderPool, type QoderPoolAccount } from './pool'
import { probeQoderPoolQuota } from './probe'
import { QODER_EXPIRE_UNKNOWN, QODER_PACK_ADDON, QODER_PACK_BASE, QODER_UNBOOKED_PACK_NAME } from './billing'
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
    // 首次迁移：还没有账本 → 上游那 100 分加购额度被记成**一笔**「未记账余额」
    expect(packs.map((p) => p.name)).toEqual([QODER_PACK_BASE, QODER_UNBOOKED_PACK_NAME])
    expect(packs[1]).toMatchObject({ size: 100, used: 0 })
    // 这次没有历史到期时间可用 → 明确标「到期未知」，不编造日期（编了就会驱动「到期优先」挑号）
    expect(packs[1].expireAt).toBe(QODER_EXPIRE_UNKNOWN)
    expect(parseCstWallClock(packs[1].expireAt)).toBeNull()
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
    // 首次迁移沿用旧聚合包的上界（那是一次真观测到的值，不能丢）
    const unbooked = packs.find((p) => p.name === QODER_UNBOOKED_PACK_NAME)!
    expect(unbooked).toBeDefined()
    // 秒级取整误差内与原来的到期时刻一致
    expect(Math.abs(Date.parse(unbooked.expireAt) - Date.parse(prev[0].expireAt))).toBeLessThan(1000)
  })

  it('已有账本：逐笔明细原样保留（不因一次刷新被合并/擦掉），并按上游剩余量 FIFO 结算', async () => {
    const { env } = makeEnv()
    const day1 = Date.now() - 2 * DAY_MS
    const day2 = Date.now() - DAY_MS
    const grants = [
      { at: day1, size: 100, used: 0, expireAt: day1 + 30 * DAY_MS },
      { at: day2, size: 100, used: 0, expireAt: day2 + 30 * DAY_MS },
    ]
    await writeQoderPool(env, 'qoder', [account({ state: { credits: 200, disabled: false, until: 0, errCount: 0, addonGrants: grants } })])
    // 上游说加购桶只剩 50：第一笔用完、第二笔用掉 50
    const quota = { ...QUOTA_JSON, addOnQuota: { total: 200, used: 150, remaining: 50, unit: 'credits' } }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(quota), { status: 200 })))

    await probeQoderPoolQuota(env, qoderProvider())

    const acc = (await readQoderPool(env, 'qoder'))[0]
    expect(acc.state.addonGrants).toHaveLength(1)
    expect(acc.state.addonGrants![0]).toMatchObject({ at: day2, size: 100, used: 50 })
    const packs = (await listQoderPoolStatus(env, 'qoder'))[0].packages as PackageInfo[]
    expect(packs.filter((p) => p.name.startsWith('签到额度 '))).toHaveLength(1)
    expect(packs.find((p) => p.name.startsWith('签到额度 '))).toMatchObject({ size: 100, used: 50 })
  })

  it('额度接口没数据/失败时，账本与明细原样保留（不让一次失败的探测把历史抹掉）', async () => {
    const { env } = makeEnv()
    const day1 = Date.now() - DAY_MS
    const grants = [{ at: day1, size: 100, used: 0, expireAt: day1 + 30 * DAY_MS }]
    await writeQoderPool(env, 'qoder', [account({ state: { credits: 100, disabled: false, until: 0, errCount: 0, addonGrants: grants } })])
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))

    const out = await probeQoderPoolQuota(env, qoderProvider())
    expect(out[0].ok).toBe(false)
    const acc = (await readQoderPool(env, 'qoder'))[0]
    expect(acc.state.addonGrants).toEqual(grants)
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

  /**
   * 昵称回填（2026-10-07）：用户要求 Qoder 账号行像 WorkBuddy 那样显示昵称。
   * 「刷新账号池」本来就是「每账号打一次上游」的动作，顺手补名字，用户不必等到下次签到。
   * 反向边界：已有真昵称不再白发请求；补名字**不能**顺手解冻账号（本探测的核心不变式）。
   */
  it('无昵称的账号：刷新时顺手从 userinfo 补名字，且不会因此解冻冷却/禁用状态', async () => {
    const { env } = makeEnv()
    await writeQoderPool(env, 'qoder', [account({ uid: 'u1', nickname: undefined })])
    await cooldownQoderAccount(env, 'qoder', 'u1', 60_000, '限流（429）')
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.includes('/api/v1/userinfo')) {
        return new Response(JSON.stringify({ id: 'u1', name: 'Shiro' }), { status: 200 })
      }
      return new Response(JSON.stringify(QUOTA_JSON), { status: 200 })
    }))

    await probeQoderPoolQuota(env, qoderProvider())

    const st = (await listQoderPoolStatus(env, 'qoder'))[0]
    expect(st.nickname).toBe('Shiro')
    expect(st.cooling).toBe(true)   // 补名字不动冷却——「只写额度」的例外只有 nickname 这一个展示字段
    expect(st.credits).toBe(400)
  })

  it('已有真昵称 → 不再请求 userinfo（刷新一次不该多发一次无用上游调用）', async () => {
    const { env } = makeEnv()
    await writeQoderPool(env, 'qoder', [account({ uid: 'u1', nickname: 'Shiro' })])
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      urls.push(String(input))
      return new Response(JSON.stringify(QUOTA_JSON), { status: 200 })
    }))

    await probeQoderPoolQuota(env, qoderProvider())
    expect(urls.some((u) => u.includes('/api/v1/userinfo'))).toBe(false)
  })

  it('历史脏数据（nickname === uid）→ 刷新时被真名覆盖（这正是用户看到的那一行）', async () => {
    const { env } = makeEnv()
    const UID = '01a0fb50-84b9-7848-a8d1-240c89950b79'
    await writeQoderPool(env, 'qoder', [account({ uid: UID, nickname: UID })])
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.includes('/api/v1/userinfo')) {
        return new Response(JSON.stringify({ id: UID, name: 'Shiro' }), { status: 200 })
      }
      return new Response(JSON.stringify(QUOTA_JSON), { status: 200 })
    }))

    await probeQoderPoolQuota(env, qoderProvider())
    expect((await listQoderPoolStatus(env, 'qoder'))[0].nickname).toBe('Shiro')
  })
})

/**
 * uid 归正（2026-10-07 用户批准）：uid 是池主键，「首选账号」/X-Qoder-Account 记的都是它；
 * 而兜底 uid（`dt-…` token 切片）会随 token 刷新变化，同一账号重新登录后就裂成两条。
 * 「刷新账号池」是用户随时能点、且本来就每账号打一次上游的动作，归正放在这里最自然。
 */
describe('probeQoderPoolQuota：顺手把兜底 uid 归正成上游权威 uid', () => {
  const REAL_UID = '01a0fb50-84b9-7848-a8d1-240c89950b79'
  const FALLBACK_UID = 'dt-OlN11abcdefghij'

  /** userinfo 按 Authorization 里的 access_token 精确分派（每个账号问自己的身份）。 */
  function userInfoStub(tokenToId: Record<string, string>, name = 'Shiro') {
    return vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/v1/userinfo')) {
        const auth = String(((init?.headers || {}) as Record<string, string>)['Authorization'] || '')
        const id = tokenToId[auth.replace(/^Bearer\s+/, '')]
        return new Response(JSON.stringify(id ? { id, name } : {}), { status: 200 })
      }
      return new Response(JSON.stringify(QUOTA_JSON), { status: 200 })
    })
  }

  /** 池账号 + 显式 token（userinfo 分派靠 token，不能沿用默认的 dt-test）。 */
  function fallbackAccount(token: string, over: Partial<QoderPoolAccount> = {}): QoderPoolAccount {
    return account({
      uid: FALLBACK_UID,
      nickname: undefined,
      token: { access_token: token, refresh_token: 'r', expires_at: Date.now() + DAY_MS, updated_at: 0 },
      ...over,
    })
  }

  it('兜底 uid → 换成 userinfo 的 id；摘要里的 uid 也同步（否则看起来像「刷新后账号没了」）', async () => {
    const { env } = makeEnv()
    await writeQoderPool(env, 'qoder', [fallbackAccount('dt-tok-1')])
    vi.stubGlobal('fetch', userInfoStub({ 'dt-tok-1': REAL_UID }))

    const out = await probeQoderPoolQuota(env, qoderProvider())

    const pool = await readQoderPool(env, 'qoder')
    expect(pool.map((a) => a.uid)).toEqual([REAL_UID])
    expect(pool[0].state.credits).toBe(400)   // 归正不丢额度
    expect(out).toEqual([{ uid: REAL_UID, ok: true, credits: 400 }])
  })

  it('归正时同步迁移面板首选账号，且响应里的 preferUid 就是新值（面板下拉不会弹回自动）', async () => {
    const { env } = makeEnv()
    await setProviders(env as never, [{ ...qoderProvider(), preferOauthUid: FALLBACK_UID } as unknown as Provider])
    await writeQoderPool(env, 'qoder', [fallbackAccount('dt-tok-2')])
    vi.stubGlobal('fetch', userInfoStub({ 'dt-tok-2': REAL_UID }))

    const { c, captured } = statusCtx(env, { credits: '1' })
    await handleOAuthStatus(c)

    expect(captured.body.data.pool.map((a: any) => a.uid)).toEqual([REAL_UID])
    expect(captured.body.data.preferUid).toBe(REAL_UID)
  })

  it('正常 uid 不动（不擅自给账号重新编号），且已有真昵称时不请求 userinfo', async () => {
    const { env } = makeEnv()
    await writeQoderPool(env, 'qoder', [account({ uid: REAL_UID, nickname: 'Shiro' })])
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      urls.push(String(input))
      return new Response(JSON.stringify(QUOTA_JSON), { status: 200 })
    }))

    await probeQoderPoolQuota(env, qoderProvider())

    expect((await readQoderPool(env, 'qoder'))[0].uid).toBe(REAL_UID)
    expect(urls.some((u) => u.includes('/api/v1/userinfo'))).toBe(false)
  })

  /**
   * 迭代安全：合并会把旧兜底那条从池数组里删掉，而探测正 `for...of` 迭代同一个数组。
   * 若在循环里就地删，后面那个账号会被跳过——表现是「点一下刷新，某个账号的额度没更新」，
   * 而且不报错。这里用一个三段池把这条钉死：无论删除发生在中间还是结尾，三个号都必须被探到。
   */
  it('中间发生合并也不会跳账号：三个账号都被探测到', async () => {
    const { env } = makeEnv()
    const third = '7f3c1c2e-0000-4444-8888-999999999999'
    await writeQoderPool(env, 'qoder', [
      fallbackAccount('dt-' + FALLBACK_UID),
      account({ uid: REAL_UID, nickname: 'Shiro', token: { access_token: 'dt-real', refresh_token: 'r', expires_at: Date.now() + DAY_MS, updated_at: 0 } }),
      account({ uid: third, nickname: 'Third', token: { access_token: 'dt-third', refresh_token: 'r', expires_at: Date.now() + DAY_MS, updated_at: 0 } }),
    ])
    vi.stubGlobal('fetch', userInfoStub({ ['dt-' + FALLBACK_UID]: REAL_UID }))

    const out = await probeQoderPoolQuota(env, qoderProvider())

    // 三个号都探到了（合并后前两条共用权威 uid，故按 uid 去重后是 2 个）
    expect(out).toHaveLength(3)
    expect(out.every((o) => o.ok)).toBe(true)
    expect(new Set(out.map((o) => o.uid))).toEqual(new Set([REAL_UID, third]))
    // 池里只剩两条（兜底那条已并入权威 uid 那条）
    expect((await readQoderPool(env, 'qoder')).map((a) => a.uid).sort()).toEqual([third, REAL_UID].sort())
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
