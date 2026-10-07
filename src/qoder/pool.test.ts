/**
 * pool.test.ts — Qoder 池状态机里「签到成功却仍被跳过」的那条路径。
 *
 * 线上现象（2026-10-02 用户反馈）：账号卡片显示「积分=400 已禁用（鉴权失败：{"code":"10605",…}）」，
 * 但同一账号当天签到成功。原因是两件事叠在一起：
 *   1. c7b79c8 之前，上游排队满（10605 / isQueued）被误判成鉴权故障 → 旧代码写下
 *      `disabled: true` + reason「鉴权失败：<原始 JSON>」（该文案只有旧代码写得出来，
 *      新代码是「鉴权失败（会话已失效，需重新登录）：…」）；
 *   2. reenableQoderIfCredits 当时带 `&& !st.disabled` 守卫 → 签到成功也不解冻。
 * 结果：token 明明有效、积分明明恢复了，转发却永远跳过这个账号，400 积分一直用不上。
 *
 * 这里钉住「成功签到 = token 有效的直接反证 → 冷却与禁用都必须清掉」，同时守住反向边界：
 * 没有积分（remain <= 0）时**不能**顺手解冻，否则只会让它立刻被挑中再撞一次额度耗尽。
 */
import { describe, it, expect } from 'vitest'
import {
  cooldownQoderAccount,
  disableQoderAccount,
  isRealQoderNickname,
  listQoderPoolStatus,
  noteQoderError,
  pickQoderAccount,
  reenableQoderIfCredits,
  resolveQoderPreferUid,
  setQoderPoolAccountNickname,
  soonestQoderExpiryAt,
  writeQoderPool,
  type QoderPoolAccount,
} from './pool'
import { CREDIT_EXPIRY_WINDOW_MS, formatCstWallClock } from '../credit-expiry'
import { QODER_PACK_ADDON, QODER_PACK_BASE } from './billing'
import type { Env, PackageInfo, Provider } from '../types'

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

/** 一个健康账号（token 未过期、有 refresh_token）。 */
function account(over: Partial<QoderPoolAccount> = {}): QoderPoolAccount {
  return {
    uid: 'u1',
    nickname: 'u1',
    token: { access_token: 'dt-test', refresh_token: 'drt-test', expires_at: Date.now() + 86400000, updated_at: 0 },
    enabled: true,
    state: { credits: 0, disabled: false, until: 0, errCount: 0 },
    updatedAt: 0,
    realm: 'global',
    ...over,
  }
}

describe('reenableQoderIfCredits：成功签到必须同时清掉 disabled（历史误判残留）', () => {
  it('历史误判留下的 disabled + 旧文案 reason：签到恢复积分后一并清除', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-unfreeze-1'
    await writeQoderPool(env, pid, [account()])
    // 复刻线上 KV 里的残留状态：旧代码（c7b79c8 之前）把 10605 排队写成了永久禁用
    await disableQoderAccount(env, pid, 'u1', '鉴权失败：{"code":"10605","message":"{\\"isQueued\\":true}"}')

    let st = await listQoderPoolStatus(env, pid)
    expect(st[0].disabled).toBe(true)
    expect(st[0].reason).toContain('10605')
    // 被禁用 → 挑号永远跳过它（用户看到的「400 积分用不上」）
    expect(await pickQoderAccount(env, pid, new Set())).toBeNull()

    await reenableQoderIfCredits(env, pid, 'u1', 400)

    st = await listQoderPoolStatus(env, pid)
    expect(st[0].credits).toBe(400)
    expect(st[0].disabled).toBe(false)
    expect(st[0].reason).toBe('')
    expect(st[0].cooling).toBe(false)
    // 解冻后立刻可被挑中——这才是「积分恢复」的实际含义
    const picked = await pickQoderAccount(env, pid, new Set())
    expect(picked?.uid).toBe('u1')
  })

  it('冷却中的账号：签到恢复积分后清冷却 + errCount，不只是清 disabled', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-unfreeze-2'
    await writeQoderPool(env, pid, [account()])
    await cooldownQoderAccount(env, pid, 'u1', 12 * 60 * 60 * 1000, '额度耗尽（402）')
    await noteQoderError(env, pid, 'u1', { planMs: 1000, softMs: 1000, errThreshold: 5, errMs: 1000 })

    await reenableQoderIfCredits(env, pid, 'u1', 100)

    const st = (await listQoderPoolStatus(env, pid))[0]
    expect(st.cooling).toBe(false)
    expect(st.until).toBe(0)
    expect(st.errCount).toBe(0)
    expect(st.credits).toBe(100)
  })

  it('remain <= 0 不解冻（否则会立刻被挑中再撞一次额度耗尽）', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-unfreeze-3'
    await writeQoderPool(env, pid, [account()])
    await disableQoderAccount(env, pid, 'u1', 'token 刷新失败（需重新登录）')

    await reenableQoderIfCredits(env, pid, 'u1', 0)

    const st = (await listQoderPoolStatus(env, pid))[0]
    expect(st.disabled).toBe(true)
    expect(st.reason).toBe('token 刷新失败（需重新登录）')
    expect(st.credits).toBe(0)
  })

  it('uid 不在池里：静默返回，不抛（签到路径不能被池状态写坏打挂）', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-unfreeze-4'
    await writeQoderPool(env, pid, [account()])
    await expect(reenableQoderIfCredits(env, pid, 'nobody', 100)).resolves.toBeUndefined()
    expect((await listQoderPoolStatus(env, pid)).length).toBe(1)
  })
})

// ===== 到期优先（2026-10-02，与 workbuddy / trae 池同口径） =====
const DAY = 24 * 60 * 60 * 1000

/** 构造一个额度包：expireInMs=null → 长期（expireAt 空串）。 */
function pkg(expireInMs: number | null, over: Partial<PackageInfo> = {}): PackageInfo {
  return {
    name: over.name ?? QODER_PACK_BASE,
    expireAt: expireInMs === null ? '' : formatCstWallClock(Date.now() + expireInMs),
    size: over.size ?? 100,
    used: over.used ?? 0,
    unit: 'credits',
  }
}

/** 带额度包明细的账号。 */
function accountWithPacks(uid: string, credits: number, packs: PackageInfo[]): QoderPoolAccount {
  return account({ uid, state: { credits, disabled: false, until: 0, errCount: 0, packages: packs } })
}

describe('soonestQoderExpiryAt：窗口内最早到期且仍有剩余', () => {
  const st = (packages: PackageInfo[]) => ({ credits: 100, disabled: false, until: 0, errCount: 0, packages })

  it('取窗口内最早到期的那一个（多个包时不是第一个）', () => {
    const now = Date.now()
    const got = soonestQoderExpiryAt(st([pkg(3 * DAY, { name: 'late' }), pkg(1 * DAY, { name: 'soon' })]), now)
    expect(got).not.toBeNull()
    // 与「1 天后到期」的包同一时刻（秒级取整误差内）
    expect(Math.abs(got! - (now + 1 * DAY))).toBeLessThan(1000)
  })

  it('窗口边界含等号：正好 7 天内算窗口内，8 天外不算', () => {
    const now = Date.now()
    expect(soonestQoderExpiryAt(st([pkg(CREDIT_EXPIRY_WINDOW_MS - 60_000)]), now)).not.toBeNull()
    expect(soonestQoderExpiryAt(st([pkg(8 * DAY)]), now)).toBeNull()
  })

  it('长期（空串）/ 已用尽 / 已过期 / 无数据 → null（回落积分高低）', () => {
    const now = Date.now()
    expect(soonestQoderExpiryAt(st([pkg(null)]), now)).toBeNull()
    expect(soonestQoderExpiryAt(st([pkg(1 * DAY, { size: 100, used: 100 })]), now)).toBeNull()
    expect(soonestQoderExpiryAt(st([pkg(-1 * DAY)]), now)).toBeNull()
    expect(soonestQoderExpiryAt(st([]), now)).toBeNull()
    expect(soonestQoderExpiryAt(undefined, now)).toBeNull()
  })
})

describe('pickQoderAccount 两段式：7 天内到期的积分优先，窗口内没有才比积分', () => {
  it('积分只有 10 但 2 天后到期 → 优先于积分 5000 且 20 天后到期的账号', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-pick-1'
    await writeQoderPool(env, pid, [
      accountWithPacks('rich', 5000, [pkg(20 * DAY)]),
      accountWithPacks('soon', 10, [pkg(2 * DAY, { name: QODER_PACK_ADDON })]),
    ])
    expect((await pickQoderAccount(env, pid, new Set()))?.uid).toBe('soon')
  })

  it('攒了多笔签到（每笔各自到期）→ 只要**最早那笔**进窗口就被优先挑中（整桶看最后一笔会漏掉它）', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-pick-grants'
    // 6 笔签到：最早那笔 2 天后作废，其余都在 30 天后（旧实现把整桶标成"最后一笔"的 36 天后
    // → 整个账号永远进不了 7 天窗口 → 最早那 100 分作废也不会被优先消耗）
    const packs = [2, 32, 33, 34, 35, 36].map((d, i) => pkg(d * DAY, { name: `签到额度 10-0${i + 1}` }))
    await writeQoderPool(env, pid, [
      accountWithPacks('hoarder', 600, packs),
      accountWithPacks('other', 5000, [pkg(20 * DAY)]),
    ])
    expect((await pickQoderAccount(env, pid, new Set()))?.uid).toBe('hoarder')
  })

  it('都在窗口外 → 回落「剩余积分最多者」（原自动策略完全不变）', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-pick-2'
    await writeQoderPool(env, pid, [
      accountWithPacks('rich', 5000, [pkg(20 * DAY)]),
      accountWithPacks('soon', 10, [pkg(30 * DAY)]),
    ])
    expect((await pickQoderAccount(env, pid, new Set()))?.uid).toBe('rich')
  })

  it('未探测过额度包（老 KV 数据）→ 回落积分高低，不因缺数据而挑不出号', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-pick-3'
    await writeQoderPool(env, pid, [
      account({ uid: 'rich', state: { credits: 5000, disabled: false, until: 0, errCount: 0 } }),
      account({ uid: 'poor', state: { credits: 10, disabled: false, until: 0, errCount: 0 } }),
    ])
    expect((await pickQoderAccount(env, pid, new Set()))?.uid).toBe('rich')
  })

  it('同到期比积分高低；tried 里的账号不参与（轮换时不会反复回到同一个号）', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-pick-4'
    await writeQoderPool(env, pid, [
      accountWithPacks('low', 10, [pkg(2 * DAY)]),
      accountWithPacks('high', 900, [pkg(2 * DAY)]),
    ])
    expect((await pickQoderAccount(env, pid, new Set()))?.uid).toBe('high')
    expect((await pickQoderAccount(env, pid, new Set(['high'])))?.uid).toBe('low')
  })

  it('冷却中 / 已禁用的账号即使积分马上过期也不被挑中（健康过滤在最前）', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-pick-5'
    await writeQoderPool(env, pid, [
      accountWithPacks('rich', 5000, [pkg(20 * DAY)]),
      accountWithPacks('soon', 10, [pkg(1 * DAY)]),
    ])
    await cooldownQoderAccount(env, pid, 'soon', 60_000, '限流（429）')
    expect((await pickQoderAccount(env, pid, new Set()))?.uid).toBe('rich')
  })

  it('面板手工指定的 preferUid 压过到期优先（账号固定是用户的明确意图）', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-pick-6'
    await writeQoderPool(env, pid, [
      accountWithPacks('rich', 5000, [pkg(20 * DAY)]),
      accountWithPacks('soon', 10, [pkg(1 * DAY)]),
    ])
    expect((await pickQoderAccount(env, pid, new Set(), 'rich'))?.uid).toBe('rich')
  })

  it('签到回写：额度包与探测时刻落进池状态，且立刻参与到期优先判定', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-pick-e2e'
    await writeQoderPool(env, pid, [account({ uid: 'a' })])
    const packs = [pkg(2 * DAY, { name: QODER_PACK_ADDON, size: 100, used: 0 }), pkg(20 * DAY)]
    await reenableQoderIfCredits(env, pid, 'a', 100, packs)

    const st = (await listQoderPoolStatus(env, pid))[0]
    expect(st.packages).toEqual(packs)
    expect(st.packagesAt).toBeTypeOf('number')
    expect(soonestQoderExpiryAt(
      { credits: 100, disabled: false, until: 0, errCount: 0, packages: st.packages as PackageInfo[] },
      Date.now()
    )).not.toBeNull()
  })

  it('不传 packages（额度拉取失败）→ 保留池里已存的明细，不擦成空', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-pick-7'
    await writeQoderPool(env, pid, [accountWithPacks('a', 100, [pkg(2 * DAY)])])
    await reenableQoderIfCredits(env, pid, 'a', 50)
    const st = (await listQoderPoolStatus(env, pid))[0]
    expect(st.credits).toBe(50)
    expect((st.packages as PackageInfo[]).length).toBe(1)
  })
})

/**
 * 首选账号的两级来源：客户端请求头（按次）> 面板指定（provider 级，preferOauthUid）。
 *
 * 为什么单测这一段：优先级只有两个调用点（OpenAI / Anthropic 两条转发路径），各写一遍
 * `header || provider.preferOauthUid` 很容易演变成「一条路径认面板设置、另一条不认」——
 * 那种错在页面上完全看不出来（面板显示已指定，实际请求仍走别的账号）。
 */
describe('resolveQoderPreferUid：请求头优先，面板指定兜底', () => {
  const providerWith = (uid?: string) => ({ id: 'qoder', preferOauthUid: uid }) as unknown as Provider

  it('请求头有值 → 用请求头（本次请求级意图更具体）', () => {
    expect(resolveQoderPreferUid('from-header', providerWith('from-panel'))).toBe('from-header')
  })

  it('请求头缺省/空白 → 回落面板指定（客户端把变量留空是很常见的调用方式）', () => {
    for (const header of [undefined, null, '', '   ', '\t']) {
      expect(resolveQoderPreferUid(header, providerWith('from-panel'))).toBe('from-panel')
    }
  })

  it('两者都没有/都空白 → undefined（交给到期优先的自动挑选）', () => {
    expect(resolveQoderPreferUid(undefined, providerWith(undefined))).toBeUndefined()
    expect(resolveQoderPreferUid('  ', providerWith('  '))).toBeUndefined()
    expect(resolveQoderPreferUid('', {} as Provider)).toBeUndefined()
  })

  it('返回值已 trim：带空格的面板设置不会因为精确匹配失败而静默失效', () => {
    expect(resolveQoderPreferUid('', providerWith(' u1 '))).toBe('u1')
    expect(resolveQoderPreferUid(' u2 ', providerWith(undefined))).toBe('u2')
  })
})

/**
 * 昵称字段的脏数据治理（2026-10-07 用户报「qoder 只显示 01a0fb50-… 一长串 id，
 * 能不能像 workbuddy 那样显示昵称」的根因）。
 *
 * 根因不是「上游没给名字」这一条：旧签到路径 `base.nickname = account.nickname || account.uid`
 * 会把 uid 当昵称回写进池，于是 `nickname === uid`，面板的
 * `a.nickname ? 昵称 : 'uid=' + uid` 永远走「有昵称」那一支，显示成一长串 UUID。
 * 这里钉住两件事：不再写入 uid 冒充的昵称；已存的脏值在对外状态里按「无昵称」透出。
 */
describe('isRealQoderNickname / setQoderPoolAccountNickname：uid 不得冒充昵称', () => {
  const UID = '01a0fb50-84b9-7848-a8d1-240c89950b79'

  it('isRealQoderNickname：空、纯空白、等于 uid 都判为「没有昵称」', () => {
    expect(isRealQoderNickname('Shiro', UID)).toBe(true)
    expect(isRealQoderNickname(undefined, UID)).toBe(false)
    expect(isRealQoderNickname(null, UID)).toBe(false)
    expect(isRealQoderNickname('', UID)).toBe(false)
    expect(isRealQoderNickname('   ', UID)).toBe(false)
    expect(isRealQoderNickname(UID, UID)).toBe(false)
    // 带空白但内容是真名 → 仍算有昵称（由调用方 trim）
    expect(isRealQoderNickname('  Shiro  ', UID)).toBe(true)
  })

  it('回写真昵称：落进池并被对外状态读到', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-nick-1'
    await writeQoderPool(env, pid, [account({ uid: UID, nickname: undefined })])
    await setQoderPoolAccountNickname(env, pid, UID, 'Shiro')
    expect((await listQoderPoolStatus(env, pid))[0].nickname).toBe('Shiro')
  })

  it('uid 当昵称传入 → 拒绝写入（否则面板永远显示 UUID）', async () => {
    const { env, store } = makeEnv()
    const pid = 'qoder-nick-2'
    await writeQoderPool(env, pid, [account({ uid: UID, nickname: undefined })])
    await setQoderPoolAccountNickname(env, pid, UID, UID)
    // 两层都要挡住：写盘时不落脏值，读出来也按「无昵称」透出
    const raw = JSON.parse(store.get('qoder:pool:' + pid)!) as Array<{ nickname?: string }>
    expect(raw[0].nickname).toBeUndefined()
    expect((await listQoderPoolStatus(env, pid))[0].nickname).toBe('')
  })

  it('空串 / 纯空白 → 拒绝写入（不能把已有真昵称擦成空）', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-nick-3'
    await writeQoderPool(env, pid, [account({ uid: UID, nickname: 'Shiro' })])
    await setQoderPoolAccountNickname(env, pid, UID, '   ')
    expect((await listQoderPoolStatus(env, pid))[0].nickname).toBe('Shiro')
  })

  it('历史脏数据（nickname === uid）在对外状态里按「无昵称」透出，让面板走 uid= 分支', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-nick-4'
    await writeQoderPool(env, pid, [account({ uid: UID, nickname: UID })])
    const st = (await listQoderPoolStatus(env, pid))[0]
    expect(st.nickname).toBe('')
    expect(st.uid).toBe(UID)
  })

  it('传入真昵称时顺带 trim（上游/表单可能带空白，带空白的名字会让首选账号下拉框看起来有空行）', async () => {
    const { env } = makeEnv()
    const pid = 'qoder-nick-5'
    await writeQoderPool(env, pid, [account({ uid: UID, nickname: undefined })])
    await setQoderPoolAccountNickname(env, pid, UID, '  Shiro  ')
    expect((await listQoderPoolStatus(env, pid))[0].nickname).toBe('Shiro')
  })
})
