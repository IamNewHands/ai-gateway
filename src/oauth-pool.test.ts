import { describe, it, expect, beforeEach } from 'vitest'
import { pickOauthAccount, readOauthPool, __resetOauthPoolRuntimeForTests, type OAuthPool } from './oauth-pool'
import type { Env, OAuthTokenState } from './types'
import { OAUTH_POOL_KV_PREFIX } from './oauth'

const PROVIDER = 'wb-prefer-test'
const poolKey = (p: string) => OAUTH_POOL_KV_PREFIX + p

/** rng 恒返 0：加权随机退化为「短名单内权重最高者」，保证断言确定性。 */
const RNG_ZERO = () => 0

function makeToken(uid: string, nicknameToUid = uid): OAuthTokenState {
  const payload = btoa(JSON.stringify({ uid }))
  return {
    access_token: `h.${payload}.s`,
    refresh_token: `r-${uid}`,
    token_type: 'Bearer',
    scope: 'all',
    // nickname 无独立字段时用 access_token 占位，测试不依赖
    nickname_to: nicknameToUid,
    expires_at: 0,
  } as unknown as OAuthTokenState
}

function makeAccount(uid: string, over: Partial<OAuthPool[number]> = {}): OAuthPool[number] {
  return {
    uid,
    token: makeToken(uid),
    enabled: true,
    state: { credits: 0, disabled: false, until: 0, errCount: 0 },
    updatedAt: Date.now(),
    ...over,
  }
}

/** 写入一个池（绕过缓存），返回匹配最健康账号的顺序。 */
function makeKV(provider: string, seedAccounts?: OAuthPool) {
  const store = new Map<string, string>()
  if (seedAccounts) store.set(poolKey(provider), JSON.stringify(seedAccounts))
  return {
    env: { KV: store } as unknown as Env,
    store,
  }
}

describe('手工指定首选账号 pickOauthAccount(preferUid)', () => {
  let kv: ReturnType<typeof makeKV>

  beforeEach(() => {
    __resetOauthPoolRuntimeForTests()
    const now = Date.now()
    kv = makeKV(PROVIDER, [
      // credits 最高的是 low，用于验证“首选覆盖积分排序”
      makeAccount('high', { state: { credits: 999, disabled: false, until: 0, errCount: 0 } }),
      makeAccount('low', { state: { credits: 1, disabled: false, until: 0, errCount: 0 } }),
      makeAccount('cold', { state: { credits: 500, disabled: false, until: now + 60000, errCount: 0 } }),
      makeAccount('off', { state: { credits: 999, disabled: true, until: 0, errCount: 0 } }),
    ])
  })

  it('指定首选 uid（low）时，即使积分不是最高也优先选它', async () => {
    const acc = await pickOauthAccount(kv.env, PROVIDER, new Set(), 'low', { rng: RNG_ZERO })
    expect(acc).toBeTruthy()
    expect(acc!.uid).toBe('low')
  })

  it('不指定 preferUid 时选加权权重最高的健康账号（rng=0 即积分最高者）', async () => {
    const acc = await pickOauthAccount(kv.env, PROVIDER, new Set(), undefined, { rng: RNG_ZERO })
    expect(acc!.uid).toBe('high')
  })

  it('首选账号被禁用/冷却时不采用，回退到自动挑选', async () => {
    // off 被禁用：首选无效 → 回退权重最高健康账号
    const acc = await pickOauthAccount(kv.env, PROVIDER, new Set(), 'off', { rng: RNG_ZERO })
    expect(acc!.uid).toBe('high')
    // cold 冷却中：同样回退（重置防惊群运行态，隔离本用例内两次挑选互不干扰）
    __resetOauthPoolRuntimeForTests()
    const acc2 = await pickOauthAccount(kv.env, PROVIDER, new Set(), 'cold', { rng: RNG_ZERO })
    expect(acc2!.uid).toBe('high')
  })

  it('首选账号已在 tried 集合中，则跳过并回退自动挑选', async () => {
    const acc = await pickOauthAccount(kv.env, PROVIDER, new Set(['low']), 'low', { rng: RNG_ZERO })
    expect(acc!.uid).toBe('high')
  })

  it('首选 uid 不存在于池内时回退自动挑选', async () => {
    const acc = await pickOauthAccount(kv.env, PROVIDER, new Set(), 'ghost-uid', { rng: RNG_ZERO })
    expect(acc!.uid).toBe('high')
  })

  it('池内无账号时返回 null', async () => {
    const empty = makeKV(PROVIDER + '-empty')
    const acc = await pickOauthAccount(empty.env, PROVIDER + '-empty', new Set(), 'low', { rng: RNG_ZERO })
    expect(acc).toBeNull()
  })

  it('不污染池缓存：preferUid 不写到 KV（仅做读侧选择）', async () => {
    await pickOauthAccount(kv.env, PROVIDER, new Set(), 'low', { rng: RNG_ZERO })
    const pool = await readOauthPool(kv.env, PROVIDER)
    expect(pool.map((a) => a.uid)).toEqual(['high', 'low', 'cold', 'off'])
  })
})

describe('三因子加权挑选（credits 比例×10 + 闲置补偿 + 成功率×3）', () => {
  beforeEach(() => __resetOauthPoolRuntimeForTests())

  it('成功率因子：累计成功高的账号胜出（积分相同、从未使用，运行态缺失回退 KV 快照）', async () => {
    const pid = PROVIDER + '-sr'
    const kv2 = makeKV(pid, [
      makeAccount('good', { state: { credits: 100, disabled: false, until: 0, errCount: 0, successCount: 10, errTotal: 0 } }),
      makeAccount('bad', { state: { credits: 100, disabled: false, until: 0, errCount: 0, successCount: 0, errTotal: 10 } }),
    ])
    // 权重：good = 1+10+5+3 = 19；bad = 1+10+5+0 = 16；rng=0 → good
    const acc = await pickOauthAccount(kv2.env, pid, new Set(), undefined, { rng: RNG_ZERO })
    expect(acc!.uid).toBe('good')
  })

  it('credits 全 0 时仍按闲置 + 成功率加权（不退化均匀随机）', async () => {
    const pid = PROVIDER + '-zeroc'
    const kv2 = makeKV(pid, [
      makeAccount('good', { state: { credits: 0, disabled: false, until: 0, errCount: 0, successCount: 10, errTotal: 0 } }),
      makeAccount('bad', { state: { credits: 0, disabled: false, until: 0, errCount: 0, successCount: 0, errTotal: 10 } }),
    ])
    const acc = await pickOauthAccount(kv2.env, pid, new Set(), undefined, { rng: RNG_ZERO })
    expect(acc!.uid).toBe('good')
  })

  it('随机抽签可命中短名单内低权重账号（rng 趋近 1 时取最后一个候选）', async () => {
    const pid = PROVIDER + '-rng1'
    const kv2 = makeKV(pid, [
      makeAccount('high', { state: { credits: 999, disabled: false, until: 0, errCount: 0 } }),
      makeAccount('low', { state: { credits: 1, disabled: false, until: 0, errCount: 0 } }),
    ])
    // rng = 0.999999：r 落在 low 的权重区间（约最后 28%）
    const acc = await pickOauthAccount(kv2.env, pid, new Set(), undefined, { rng: () => 0.999999 })
    expect(acc!.uid).toBe('low')
  })
})

describe('防惊群（100ms 窗口，对齐 workbuddy2api minPickGap）', () => {
  beforeEach(() => __resetOauthPoolRuntimeForTests())

  it('同一账号被选中后 100ms 内不再被选中，改选其他候选', async () => {
    const kv2 = makeKV(PROVIDER + '-herd', [
      makeAccount('high', { state: { credits: 999, disabled: false, until: 0, errCount: 0 } }),
      makeAccount('low', { state: { credits: 1, disabled: false, until: 0, errCount: 0 } }),
    ])
    const first = await pickOauthAccount(kv2.env, PROVIDER + '-herd', new Set(), undefined, { rng: RNG_ZERO })
    expect(first!.uid).toBe('high')
    // 紧接着第二次挑选：high 处于防惊群窗口内 → 落到 low
    const second = await pickOauthAccount(kv2.env, PROVIDER + '-herd', new Set(), undefined, { rng: RNG_ZERO })
    expect(second!.uid).toBe('low')
  })

  it('lastUsed 只写运行态内存，不产生 KV 写（池 JSON 不变）', async () => {
    const pid = PROVIDER + '-nokv'
    const kv2 = makeKV(pid, [
      makeAccount('a', { state: { credits: 10, disabled: false, until: 0, errCount: 0 } }),
    ])
    const before = kv2.store.get(poolKey(pid))
    await pickOauthAccount(kv2.env, pid, new Set(), undefined, { rng: RNG_ZERO })
    expect(kv2.store.get(poolKey(pid))).toBe(before)
  })
})

describe('全冷却兜底（allowCoolingFallback，对齐 workbuddy2api pickEarliestExpiryLocked）', () => {
  beforeEach(() => __resetOauthPoolRuntimeForTests())

  it('无健康账号时选冷却最早到期的账号顶班', async () => {
    const pid = PROVIDER + '-fb1'
    const now = Date.now()
    const kv2 = makeKV(pid, [
      makeAccount('a', { state: { credits: 10, disabled: false, until: now + 5000, errCount: 0, reason: '429 rate limit' } }),
      makeAccount('b', { state: { credits: 10, disabled: false, until: now + 1000, errCount: 0, reason: 'upstream 404' } }),
    ])
    const acc = await pickOauthAccount(kv2.env, pid, new Set(), undefined, { allowCoolingFallback: true, rng: RNG_ZERO })
    expect(acc).toBeTruthy()
    expect(acc!.uid).toBe('b')
  })

  it('兜底排除禁用与余额耗尽（硬冷却）账号——调了必 402，等签到恢复', async () => {
    const pid = PROVIDER + '-fb2'
    const now = Date.now()
    const kv2 = makeKV(pid, [
      makeAccount('dis', { state: { credits: 10, disabled: true, until: now + 1000, errCount: 0 } }),
      makeAccount('hard', { enabled: true, state: { credits: 10, disabled: false, until: now + 1000, errCount: 0, reason: '余额不足' } }),
      makeAccount('soft', { state: { credits: 10, disabled: false, until: now + 2000, errCount: 0, reason: '429 rate limit' } }),
    ])
    const acc = await pickOauthAccount(kv2.env, pid, new Set(), undefined, { allowCoolingFallback: true, rng: RNG_ZERO })
    expect(acc).toBeTruthy()
    expect(acc!.uid).toBe('soft')
  })

  it('兜底尊重 tried 集合：失败轮转时换下一个最早到期者', async () => {
    const pid = PROVIDER + '-fb3'
    const now = Date.now()
    const kv2 = makeKV(pid, [
      makeAccount('a', { state: { credits: 10, disabled: false, until: now + 5000, errCount: 0, reason: '429 rate limit' } }),
      makeAccount('b', { state: { credits: 10, disabled: false, until: now + 1000, errCount: 0, reason: 'upstream 404' } }),
    ])
    const first = await pickOauthAccount(kv2.env, pid, new Set(), undefined, { allowCoolingFallback: true })
    expect(first!.uid).toBe('b')
    const second = await pickOauthAccount(kv2.env, pid, new Set(['b']), undefined, { allowCoolingFallback: true })
    expect(second!.uid).toBe('a')
  })

  it('未开启兜底时返回 null（既有行为不变）', async () => {
    const pid = PROVIDER + '-fb4'
    const now = Date.now()
    const kv2 = makeKV(pid, [
      makeAccount('a', { state: { credits: 10, disabled: false, until: now + 5000, errCount: 0, reason: '429 rate limit' } }),
    ])
    const acc = await pickOauthAccount(kv2.env, pid, new Set(), undefined, { rng: RNG_ZERO })
    expect(acc).toBeNull()
  })

  it('有健康账号时兜底不介入（正常加权挑选）', async () => {
    const pid = PROVIDER + '-fb5'
    const now = Date.now()
    const kv2 = makeKV(pid, [
      makeAccount('healthy', { state: { credits: 100, disabled: false, until: 0, errCount: 0 } }),
      makeAccount('cold', { state: { credits: 10, disabled: false, until: now + 1000, errCount: 0, reason: 'upstream 404' } }),
    ])
    const acc = await pickOauthAccount(kv2.env, pid, new Set(), undefined, { allowCoolingFallback: true, rng: RNG_ZERO })
    expect(acc!.uid).toBe('healthy')
  })
})
