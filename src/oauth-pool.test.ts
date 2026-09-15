import { describe, it, expect, beforeEach } from 'vitest'
import {
  pickOauthAccount,
  readOauthPool,
  isOauthAccountHealthy,
  noteOauthSessionDead,
  clearOauthSessionDead,
  clearOauthAccountModelCooldown,
  recordOauthModelCost,
  cooldownOauthAccount,
  cooldownOauthAccountSoftForModel,
  listModelCooldowns,
  hasModelCooldown,
  __resetOauthPoolRuntimeForTests,
  __resetOauthModelCostsForTests,
  type OAuthPool,
} from './oauth-pool'
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

/**
 * 带 get/put 的 KV mock（供需要真实读写的用例使用，如 cooldown* 系列）。
 * 注意：readOauthPool 有 1s 内存缓存，同一 provider 的多次写会命中缓存，
 * 故断言前需经 readOauthPool 读回（它返回缓存里的同一对象引用）。
 */
function makeRealKV(provider: string, seedAccounts?: OAuthPool) {
  const store = new Map<string, string>()
  if (seedAccounts) store.set(poolKey(provider), JSON.stringify(seedAccounts))
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v) },
    delete: async (k: string) => { store.delete(k) },
  }
  return { env: { KV: kv } as unknown as Env, store, kv }
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

describe('6004 模型级限流隔离（对齐 workbuddy2api issue #31 / modelCooldowns 多模型表）', () => {
  it('多模型独立：A 触发后 B 再触发，A 的记录不被覆盖', async () => {
    const pid = PROVIDER + '-mc1'
    const kv = makeRealKV(pid, [makeAccount('u1')])
    const until = Date.now() + 60000

    await cooldownOauthAccountSoftForModel(kv.env, pid, 'u1', 'model-A', until, '6004 model rate limit')
    await cooldownOauthAccountSoftForModel(kv.env, pid, 'u1', 'model-B', until, '6004 model rate limit')

    const st = (await readOauthPool(kv.env, pid))[0].state
    // 关键：两条记录同时存在（旧单槽实现只能留一条，A 会被 B 覆盖）
    expect(st.softRateModels?.['model-A']?.until).toBe(until)
    expect(st.softRateModels?.['model-B']?.until).toBe(until)
  })

  it('6004 只写模型表，不写账号级 until（否则其他模型也被拦，豁免形同虚设）', async () => {
    const pid = PROVIDER + '-mc2'
    const kv = makeRealKV(pid, [makeAccount('u1')])

    await cooldownOauthAccountSoftForModel(kv.env, pid, 'u1', 'model-A', Date.now() + 60000, '6004')

    const acc = (await readOauthPool(kv.env, pid))[0]
    expect(acc.state.until).toBe(0)
    // 账号级无冷却 → 账号整体仍健康
    expect(isOauthAccountHealthy(acc, Date.now())).toBe(true)
  })

  it('受限模型不可选，其他模型可选（豁免生效）', async () => {
    const pid = PROVIDER + '-mc3'
    const kv = makeRealKV(pid, [makeAccount('u1')])
    await cooldownOauthAccountSoftForModel(kv.env, pid, 'u1', 'model-A', Date.now() + 60000, '6004')

    const acc = (await readOauthPool(kv.env, pid))[0]
    expect(isOauthAccountHealthy(acc, Date.now(), 'model-A')).toBe(false)
    expect(isOauthAccountHealthy(acc, Date.now(), 'model-B')).toBe(true)
    // 未带模型参数 → 账号级健康（模型维度无从判定，不因此拦号）
    expect(isOauthAccountHealthy(acc, Date.now())).toBe(true)
  })

  it('模型冷却到期后自动放行，且过期条目被惰性清理', async () => {
    const pid = PROVIDER + '-mc4'
    const kv = makeRealKV(pid, [makeAccount('u1')])
    const until = Date.now() + 50000
    await cooldownOauthAccountSoftForModel(kv.env, pid, 'u1', 'model-A', until, '6004')

    const acc = (await readOauthPool(kv.env, pid))[0]
    const after = until + 1
    expect(isOauthAccountHealthy(acc, after, 'model-A')).toBe(true)
    // 惰性清理：查询过期条目后应从表里删除
    expect(acc.state.softRateModels?.['model-A']).toBeUndefined()
  })

  it('账号级冷却入口清空模型表（防豁免泄漏到账号级限流）', async () => {
    const pid = PROVIDER + '-mc5'
    const kv = makeRealKV(pid, [makeAccount('u1')])
    await cooldownOauthAccountSoftForModel(kv.env, pid, 'u1', 'model-A', Date.now() + 60000, '6004')
    // 随后账号级软冷却（如 429 非 6004）
    await cooldownOauthAccount(kv.env, pid, 'u1', 60000, '429 rate limit')

    const acc = (await readOauthPool(kv.env, pid))[0]
    expect(acc.state.softRateModels).toBeUndefined()
    // 账号级冷却生效：任何模型都被拦
    expect(isOauthAccountHealthy(acc, Date.now(), 'model-A')).toBe(false)
    expect(isOauthAccountHealthy(acc, Date.now(), 'model-B')).toBe(false)
  })

  it('账号级冷却优先于模型级豁免（全账号不可用时查模型无意义）', () => {
    const now = Date.now()
    const acc = makeAccount('acc-priority', {
      state: {
        credits: 100,
        disabled: false,
        until: now + 60000, // 账号级冷却中
        errCount: 0,
        softRateModels: { 'model-A': { until: now + 30000, resetAt: now + 30000, reason: '6004' } },
      },
    })
    // 账号级冷却生效 → 即便请求的是"未被模型级限额"的 model-B 也应不可选
    expect(isOauthAccountHealthy(acc, now, 'model-B')).toBe(false)
    expect(isOauthAccountHealthy(acc, now, 'model-A')).toBe(false)
  })

  it('向后兼容：旧单槽数据（softRateModel/softRateResetAt）被迁移进表', () => {
    const now = Date.now()
    const acc = makeAccount('acc-legacy', {
      state: {
        credits: 100,
        disabled: false,
        until: 0,
        errCount: 0,
        softRateModel: 'deepseek-v4-flash',
        softRateResetAt: now + 60000,
      },
    })
    expect(isOauthAccountHealthy(acc, now, 'deepseek-v4-flash')).toBe(false)
    expect(isOauthAccountHealthy(acc, now, 'glm-5.2')).toBe(true)
    // 迁移后表里有记录
    expect(acc.state.softRateModels?.['deepseek-v4-flash']?.until).toBe(now + 60000)
  })

  it('向后兼容：旧单槽数据已过期 → 不迁移、不拦号', () => {
    const now = Date.now()
    const acc = makeAccount('acc-legacy-expired', {
      state: {
        credits: 100,
        disabled: false,
        until: 0,
        errCount: 0,
        softRateModel: 'deepseek-v4-flash',
        softRateResetAt: now - 1000,
      },
    })
    expect(isOauthAccountHealthy(acc, now, 'deepseek-v4-flash')).toBe(true)
    expect(acc.state.softRateModels).toBeUndefined()
  })

  it('重置时间已过 → 1ms 极短冷却但仍记模型表（对齐源实现，不退化成账号级）', async () => {
    const pid = PROVIDER + '-mc6'
    const kv = makeRealKV(pid, [makeAccount('u1')])
    const past = Date.now() - 1000
    await cooldownOauthAccountSoftForModel(kv.env, pid, 'u1', 'model-A', past, '6004 stale')

    const acc = (await readOauthPool(kv.env, pid))[0]
    // 仍写模型表（源实现 hasReset 只看是否零值，不看是否已过期）
    expect(acc.state.softRateModels?.['model-A']).toBeDefined()
    // resetAt 保留上游原始墙钟（台账呈现真实恢复时刻）
    expect(acc.state.softRateModels?.['model-A']?.resetAt).toBe(past)
    // 但冷却极短 → 立即恢复可用
    expect(isOauthAccountHealthy(acc, Date.now() + 10, 'model-A')).toBe(true)
    // 不写账号级 until
    expect(acc.state.until).toBe(0)
  })

  it('无模型名 → 退回账号级软冷却（无法做模型豁免）', async () => {
    const pid2 = PROVIDER + '-mc7'
    const kv2 = makeRealKV(pid2, [makeAccount('u1')])
    await cooldownOauthAccountSoftForModel(kv2.env, pid2, 'u1', '', Date.now() + 60000, '6004 no model')
    const acc2 = (await readOauthPool(kv2.env, pid2))[0]
    expect(acc2.state.softRateModels).toBeUndefined()
    expect(acc2.state.until).toBeGreaterThan(Date.now())
  })

  it('clearOauthAccountModelCooldown 只清指定模型、不碰账号级冷却（BlockModelClear）', async () => {
    const pid = PROVIDER + '-mc8'
    const kv = makeRealKV(pid, [makeAccount('u1')])
    const now = Date.now()
    await cooldownOauthAccountSoftForModel(kv.env, pid, 'u1', 'model-A', now + 600000, '11102 block')
    await cooldownOauthAccountSoftForModel(kv.env, pid, 'u1', 'model-B', now + 600000, '6004')
    // 清除前：两个模型都在独立冷却，账号级 until 未被写
    let acc = (await readOauthPool(kv.env, pid))[0]
    expect(acc.state.softRateModels?.['model-A']).toBeDefined()
    expect(acc.state.until).toBe(0)
    // 清除 model-B（6004 冷却）→ 只清 B，A 保留
    await clearOauthAccountModelCooldown(kv.env, pid, 'u1', 'model-B')
    acc = (await readOauthPool(kv.env, pid))[0]
    expect(acc.state.softRateModels?.['model-B']).toBeUndefined()
    expect(acc.state.softRateModels?.['model-A']).toBeDefined()
    // 全部清空 → softRateModels 置为 undefined
    await clearOauthAccountModelCooldown(kv.env, pid, 'u1', 'model-A')
    acc = (await readOauthPool(kv.env, pid))[0]
    expect(acc.state.softRateModels).toBeUndefined()
    // 幂等：无记录时不报错
    await expect(clearOauthAccountModelCooldown(kv.env, pid, 'u1', 'model-A')).resolves.toBeUndefined()
  })

  it('clearOauthAccountModelCooldown 空模型名/账号不存在 → no-op', async () => {
    const pid = PROVIDER + '-mc9'
    const kv = makeRealKV(pid, [makeAccount('u1')])
    await expect(clearOauthAccountModelCooldown(kv.env, pid, 'u1', '')).resolves.toBeUndefined()
    await expect(clearOauthAccountModelCooldown(kv.env, pid, 'ghost', 'model-A')).resolves.toBeUndefined()
  })

  it('listModelCooldowns 只透出未过期条目且按模型名排序', () => {
    const now = Date.now()
    const st = {
      credits: 0, disabled: false, until: 0, errCount: 0,
      softRateModels: {
        'z-model': { until: now + 1000, resetAt: now + 1000, reason: 'a' },
        'a-model': { until: now + 2000, resetAt: now + 2000, reason: 'b' },
        'expired': { until: now - 1, resetAt: now - 1, reason: 'c' },
      },
    }
    expect(listModelCooldowns(st, now).map((x) => x.model)).toEqual(['a-model', 'z-model'])
  })

  it('hasModelCooldown 报告是否处于模型级冷却形态', () => {
    const now = Date.now()
    expect(hasModelCooldown({ credits: 0, disabled: false, until: 0, errCount: 0 }, now)).toBe(false)
    expect(hasModelCooldown({
      credits: 0, disabled: false, until: 0, errCount: 0,
      softRateModels: { m: { until: now + 1000, resetAt: now + 1000 } },
    }, now)).toBe(true)
    expect(hasModelCooldown({
      credits: 0, disabled: false, until: 0, errCount: 0,
      softRateModels: { m: { until: now - 1, resetAt: now - 1 } },
    }, now)).toBe(false)
  })
})

describe('12153 Session Dead 3 次防抖测试（对齐 workbuddy2api sessionDeadThreshold）', () => {
  it('前 1~2 次 12153 只施加短冷却不永久杀号，第 3 次才禁用', async () => {
    const pid = PROVIDER + '-sd'
    const kv = makeKV(pid, [makeAccount('u1')])
    // 第一次
    const dis1 = await noteOauthSessionDead(kv.env, pid, 'u1')
    expect(dis1).toBe(false)
    let pool = await readOauthPool(kv.env, pid)
    expect(pool[0].state.disabled).toBe(false)
    expect(pool[0].state.sessionDeadFails).toBe(1)
    expect(pool[0].state.until).toBeGreaterThan(Date.now())

    // 第二次
    const dis2 = await noteOauthSessionDead(kv.env, pid, 'u1')
    expect(dis2).toBe(false)
    pool = await readOauthPool(kv.env, pid)
    expect(pool[0].state.disabled).toBe(false)
    expect(pool[0].state.sessionDeadFails).toBe(2)

    // 第三次
    const dis3 = await noteOauthSessionDead(kv.env, pid, 'u1')
    expect(dis3).toBe(true)
    pool = await readOauthPool(kv.env, pid)
    expect(pool[0].state.disabled).toBe(true)
    expect(pool[0].state.sessionDeadFails).toBe(0)
  })

  it('clearOauthSessionDead 可清空计数', async () => {
    const pid = PROVIDER + '-sd2'
    const kv = makeKV(pid, [makeAccount('u1')])
    await noteOauthSessionDead(kv.env, pid, 'u1')
    let pool = await readOauthPool(kv.env, pid)
    expect(pool[0].state.sessionDeadFails).toBe(1)

    await clearOauthSessionDead(kv.env, pid, 'u1')
    pool = await readOauthPool(kv.env, pid)
    expect(pool[0].state.sessionDeadFails).toBe(0)
  })
})

describe('成本优先分层挑号测试（对齐 workbuddy2api pick.go costTier）', () => {
  beforeEach(() => {
    __resetOauthModelCostsForTests()
    __resetOauthPoolRuntimeForTests()
  })

  it('实测免费账号优先被挑中（Tier 0 优于 Tier 2 收费号）', async () => {
    const pid = PROVIDER + '-cost1'
    const kv = makeKV(pid, [
      makeAccount('free-acc', { state: { credits: 10, disabled: false, until: 0, errCount: 0 } }),
      makeAccount('paid-acc', { state: { credits: 1000, disabled: false, until: 0, errCount: 0 } }),
    ])
    // 记录 free-acc 为 0 扣费，paid-acc 为 2.0 credit / 1000 tokens
    recordOauthModelCost(pid, 'free-acc', 'deepseek-v4-flash', 0, 1000)
    recordOauthModelCost(pid, 'paid-acc', 'deepseek-v4-flash', 2.0, 1000)

    // 即使 paid-acc 的 credits 远高于 free-acc，因 free-acc 属于 Tier 0，恒优先选择 free-acc
    const picked = await pickOauthAccount(kv.env, pid, new Set(), undefined, {
      reqModel: 'deepseek-v4-flash',
      rng: RNG_ZERO,
    })
    expect(picked).not.toBeNull()
    expect(picked!.uid).toBe('free-acc')
  })
})
