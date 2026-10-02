import { describe, expect, it, beforeEach } from 'vitest'
import type { Env } from '../types'
import {
  CLINE_ACCOUNT_STATE_PREFIX,
  CLINE_ACCOUNT_STATE_WRITE_GAP_MS,
  __resetClineAccountStateForTests,
  classifyClineCooldownKind,
  clearClineAccountState,
  describeClineAccountState,
  formatRemaining,
  isClineFreeLimitError,
  maskClineToken,
  readClineAccountStates,
  recordClineAccountState,
  rekeyClineAccountState,
} from './account-state'
import type { ClineAccountState } from './account-state'

/** 计数型内存 KV：暴露 map 与 put 次数（写配额是本次改动的核心约束，必须能断言）。 */
function makeEnv() {
  const map = new Map<string, string>()
  let puts = 0
  const kv = {
    get: async (k: string) => map.get(k) ?? null,
    put: async (k: string, v: string) => { puts++; map.set(k, v) },
    delete: async (k: string) => { map.delete(k) },
    list: async () => ({ keys: [] }),
  }
  return { env: { KV: kv } as unknown as Env, map, putCount: () => puts }
}

const entry = (over: Partial<ClineAccountState> = {}): ClineAccountState => ({
  index: 0,
  masked: '****aaaa',
  kind: 'quota_empty',
  until: 1_000_000,
  at: 900_000,
  model: 'cline-free/deepseek-v4.1-flash',
  reason: 'Daily free limit reached',
  ...over,
})

beforeEach(() => { __resetClineAccountStateForTests() })

describe('免费额度耗尽的判据（对齐官方 cline-pass-errors）', () => {
  it('429 + Daily free limit 文案 → 认定为额度耗尽，而不是普通限流', () => {
    const text = 'Daily free model limit reached on model z-ai/glm-5.3-flash. Try again in 23h 59m'
    expect(isClineFreeLimitError(429, text)).toBe(true)
    expect(classifyClineCooldownKind(429, text)).toBe('quota_empty')
  })

  it('普通 429、成功响应、空文案都不算额度耗尽', () => {
    expect(isClineFreeLimitError(429, 'Rate limit exceeded, slow down.')).toBe(false)
    expect(classifyClineCooldownKind(429, 'Rate limit exceeded, slow down.')).toBe('rate_limited')
    // 成功响应体里出现同样措辞也不能被读成耗尽（必须带错误状态码）
    expect(isClineFreeLimitError(200, 'Daily free limit reached')).toBe(false)
    expect(isClineFreeLimitError(429, '')).toBe(false)
  })

  it('quota exceeded / free tier limit 变体同样命中（大小写不敏感）', () => {
    expect(isClineFreeLimitError(500, 'quota exceeded for this account')).toBe(true)
    expect(isClineFreeLimitError(429, 'FREE TIER LIMIT reached')).toBe(true)
  })
})

describe('maskClineToken / formatRemaining：面板口径', () => {
  it('掩码只留末 4 位，不泄露完整 token', () => {
    const full = 'rt-abcdefghijklmnop-9f2c'
    const masked = maskClineToken(full)
    expect(masked).toBe('****9f2c')
    expect(full.includes(masked)).toBe(false)
    expect(maskClineToken('ab')).toBe('****')
    expect(maskClineToken('')).toBe('****')
  })

  it('剩余时长按 秒/分/时 三档紧凑显示', () => {
    expect(formatRemaining(0)).toBe('0s')
    expect(formatRemaining(-5)).toBe('0s')
    expect(formatRemaining(45_000)).toBe('45s')
    expect(formatRemaining(8 * 60_000)).toBe('8m')
    expect(formatRemaining(11 * 3600_000 + 59 * 60_000)).toBe('11h59m')
  })
})

describe('describeClineAccountState：面板文案的唯一真源', () => {
  it('冷却未到期 → 生效，标签含原因与剩余时间', () => {
    const v = describeClineAccountState(entry({ until: 1_000_000 }), 952_000)
    expect(v.active).toBe(true)
    expect(v.label).toBe('额度耗尽 · 冷却 48s')
    expect(v.remainingMs).toBe(48_000)
    // tooltip 必须点明 until 是网关禁入窗口，不是上游额度恢复时刻——否则用户会把它读成"额度啥时候回来"
    expect(v.detail).toContain('不代表上游额度已恢复')
    expect(v.detail).toContain('cline-free/deepseek-v4.1-flash')
    expect(v.detail).toContain('Daily free limit reached')
  })

  it('冷却已到期 → 不生效且不给标签（面板不该显示任何徽章）', () => {
    const v = describeClineAccountState(entry({ until: 1_000_000 }), 1_000_000)
    expect(v.active).toBe(false)
    expect(v.label).toBe('')
    expect(v.remainingMs).toBe(0)
  })

  it('账号级冷却的 tooltip 说「整个账号」，模型级冷却才写模型', () => {
    const acct = describeClineAccountState(entry({ kind: 'auth', model: null }), 0)
    expect(acct.label).toContain('凭据失效')
    expect(acct.detail).toContain('范围：整个账号')
    const model = describeClineAccountState(entry({ kind: 'plan_exhausted', model: 'cline-pass/glm-5.3' }), 0)
    expect(model.label).toContain('余额/权益不足')
    expect(model.detail).toContain('模型：cline-pass/glm-5.3')
  })
})

describe('KV 留档：写、读、节流、清', () => {
  it('写入后能读回，且键按提供商隔离', async () => {
    const { env, map } = makeEnv()
    await recordClineAccountState(env, 'cline', entry())
    expect(map.has(CLINE_ACCOUNT_STATE_PREFIX + 'cline')).toBe(true)
    const states = await readClineAccountStates(env, 'cline')
    expect(states).toHaveLength(1)
    expect(states[0].kind).toBe('quota_empty')
    expect(states[0].masked).toBe('****aaaa')
    // 另一个提供商互不影响
    expect(await readClineAccountStates(env, 'other')).toEqual([])
  })

  it('同账号同原因 30 秒内重复触发只落一次盘（KV 写配额是全功能共享的）', async () => {
    const { env, putCount } = makeEnv()
    await recordClineAccountState(env, 'cline', { ...entry(), until: 1_000_000 })
    expect(putCount()).toBe(1)
    // 同一原因、until 往后推：仍属重复，跳过落盘（内存冷却照旧生效，面板最多滞后 30 秒）
    await recordClineAccountState(env, 'cline', { ...entry(), until: 1_060_000 })
    expect(putCount()).toBe(1)
    // 原因变了 → 必须落盘，否则面板会把"额度耗尽"一直显示成"限流"
    await recordClineAccountState(env, 'cline', { ...entry(), kind: 'rate_limited' })
    expect(putCount()).toBe(2)
  })

  it('节流窗口用毫秒常量表达，改动会连带改到测试口径', () => {
    expect(CLINE_ACCOUNT_STATE_WRITE_GAP_MS).toBe(30_000)
  })

  it('并发/乱序下 until 只许写长：旧写不能把已记录的冷却改短', async () => {
    const { env } = makeEnv()
    await recordClineAccountState(env, 'cline', { ...entry(), kind: 'plan_exhausted', until: 9_000_000 })
    __resetClineAccountStateForTests() // 模拟另一个 isolate：节流表为空，但 KV 里有更晚的记录
    await recordClineAccountState(env, 'cline', { ...entry(), kind: 'plan_exhausted', until: 1_000_000 })
    const states = await readClineAccountStates(env, 'cline')
    expect(states[0].until).toBe(9_000_000)
  })

  it('多账号各占一行，按 index 覆盖而不是追加', async () => {
    const { env, map } = makeEnv()
    await recordClineAccountState(env, 'cline', entry({ index: 0, masked: '****aaaa' }))
    __resetClineAccountStateForTests()
    await recordClineAccountState(env, 'cline', entry({ index: 1, masked: '****bbbb' }))
    __resetClineAccountStateForTests()
    await recordClineAccountState(env, 'cline', { ...entry({ index: 1, masked: '****bbbb' }), kind: 'auth' })
    const raw = JSON.parse(map.get(CLINE_ACCOUNT_STATE_PREFIX + 'cline')!) as { states: ClineAccountState[] }
    expect(raw.states).toHaveLength(2)
    expect(raw.states.map((s) => s.kind)).toEqual(['quota_empty', 'auth'])
  })

  it('清除：账号恢复成功后该行不再留档，且不误删其他账号', async () => {
    const { env, putCount } = makeEnv()
    await recordClineAccountState(env, 'cline', entry({ index: 0 }))
    __resetClineAccountStateForTests()
    await recordClineAccountState(env, 'cline', entry({ index: 1, masked: '****bbbb' }))
    const before = putCount()
    await clearClineAccountState(env, 'cline', 0)
    const states = await readClineAccountStates(env, 'cline')
    expect(states.map((s) => s.index)).toEqual([1])
    expect(putCount()).toBe(before + 1)
    // 没有该账号的记录时不产生无谓写（KV 写是要花钱的）
    await clearClineAccountState(env, 'cline', 0)
    expect(putCount()).toBe(before + 1)
  })

  it('清除会重置节流：清完立刻再次冷却必须落盘（否则会显示成"正常"）', async () => {
    const { env, putCount } = makeEnv()
    await recordClineAccountState(env, 'cline', entry({ index: 0 }))
    await clearClineAccountState(env, 'cline', 0)
    const before = putCount()
    await recordClineAccountState(env, 'cline', entry({ index: 0 }))
    expect(putCount()).toBe(before + 1)
  })

  it('同账号轮换凭据：改写留档掩码，冷却不被误判成"不是这个账号"', async () => {
    const { env, map } = makeEnv()
    await recordClineAccountState(env, 'cline', entry({ index: 0, masked: '****aaaa', kind: 'quota_empty' }))
    await rekeyClineAccountState(env, 'cline', 0, '****bbbb')
    const states = await readClineAccountStates(env, 'cline')
    expect(states[0].masked).toBe('****bbbb')
    // 冷却本身（原因/截止）不能被改写动作弄丢
    expect(states[0].kind).toBe('quota_empty')
    expect(states[0].until).toBe(1_000_000)
    // 掩码已相同 → 不产生无谓写
    const before = map.get(CLINE_ACCOUNT_STATE_PREFIX + 'cline')
    await rekeyClineAccountState(env, 'cline', 0, '****bbbb')
    expect(map.get(CLINE_ACCOUNT_STATE_PREFIX + 'cline')).toBe(before)
    // 该 index 没有留档 → 静默返回，不凭空新建记录
    await rekeyClineAccountState(env, 'cline', 7, '****zzzz')
    expect((await readClineAccountStates(env, 'cline')).map((s) => s.index)).toEqual([0])
  })

  it('脏数据/坏 JSON/超范围 kind 一律丢弃，不猜', async () => {
    const { env, map } = makeEnv()
    map.set(CLINE_ACCOUNT_STATE_PREFIX + 'cline', 'not-json')
    expect(await readClineAccountStates(env, 'cline')).toEqual([])
    map.set(CLINE_ACCOUNT_STATE_PREFIX + 'cline', JSON.stringify({ states: [{ kind: 'made_up', until: 1, at: 1 }] }))
    expect(await readClineAccountStates(env, 'cline')).toEqual([])
    map.set(CLINE_ACCOUNT_STATE_PREFIX + 'cline', JSON.stringify({ states: [{ kind: 'auth', until: 'soon', at: 1 }] }))
    expect(await readClineAccountStates(env, 'cline')).toEqual([])
    // 缺 KV 绑定（本地/测试环境）时不抛也不写
    await expect(recordClineAccountState(undefined, 'cline', entry())).resolves.toBeUndefined()
    expect(await readClineAccountStates(undefined, 'cline')).toEqual([])
  })

  it('KV 抛错时不把异常带给请求（留档失败不该影响业务）', async () => {
    const env = {
      KV: {
        get: async () => { throw new Error('kv down') },
        put: async () => { throw new Error('kv down') },
      },
    } as unknown as Env
    await expect(recordClineAccountState(env, 'cline', entry())).resolves.toBeUndefined()
    await expect(clearClineAccountState(env, 'cline', 0)).resolves.toBeUndefined()
    expect(await readClineAccountStates(env, 'cline')).toEqual([])
  })
})
