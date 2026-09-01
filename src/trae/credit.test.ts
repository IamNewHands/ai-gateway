import { describe, it, expect } from 'vitest'
import {
  extractRemainValue,
  lookaheadLimited,
  reconcileTurnCredit,
} from './credit'

describe('extractRemainValue：从 SSE 回合事件 data 中稳健提取"剩余额度"（不臆造字段名）', () => {
  it('对象 → 优先取常见余额字段（limit - used 聚合净值也可）', () => {
    expect(extractRemainValue({ remain: 100 })).toBe(100)
    expect(extractRemainValue({ remain_points: 55 })).toBe(55)
    expect(extractRemainValue({ remainPoint: 42 })).toBe(42)
  })
  it('net_value（部分包）→ 各包净值求和', () => {
    expect(extractRemainValue({ net_value: [{ net_value: 3 }, { net_value: 5 }] })).toBe(8)
  })
  it('quota/credits_limit - used 组合 → 净值', () => {
    expect(extractRemainValue({ user_entitlement_pack_list: [{ allowance: { quota: { credits_limit: 30 } }, usage: { credits_amount: 5 } }] })).toBe(25)
  })
  it('数值字符串归一', () => {
    expect(extractRemainValue({ remain: '120' })).toBe(120)
  })
  it('无法识别 → null', () => {
    expect(extractRemainValue('abc')).toBeNull()
    expect(extractRemainValue(null)).toBeNull()
    expect(extractRemainValue({ foo: 'bar' })).toBeNull()
    expect(extractRemainValue([1, 2, 3])).toBeNull()
  })
  it('零值（明确出现余额=0）→ 0 而非 null', () => {
    expect(extractRemainValue({ remain: 0 })).toBe(0)
  })
})

describe('lookaheadLimited：快照配对限定——差值过大时判定数据失真', () => {
  it('差值未超限 → 接受', () => {
    expect(lookaheadLimited(100, 98, 10)).toBe(true)
  })
  it('差值超限 → 拒绝（需回退）', () => {
    expect(lookaheadLimited(100, 50, 10)).toBe(false)
  })
})

describe('reconcileTurnCredit：回合级积分配对（快照差值）与异常回退', () => {
  it('前快照存在且本次扣减合理 → 用本次快照', () => {
    const r = reconcileTurnCredit({ prev: 100, now: 97, limit: 10 })
    expect(r.newCredits).toBe(97)
    expect(r.reverted).toBe(false)
  })
  it('prev 缺失 → 无法核对，用本次快照（可接受）', () => {
    const r = reconcileTurnCredit({ prev: null, now: 97, limit: 10 })
    expect(r.newCredits).toBe(97)
    expect(r.reverted).toBe(false)
  })
  it('本次快照缺失 → 回退上一快照', () => {
    const r = reconcileTurnCredit({ prev: 100, now: null, limit: 10 })
    expect(r.newCredits).toBe(100)
    expect(r.reverted).toBe(true)
  })
  it('本次为充值/变化超过阈值 → 回退到 prev 防误记余额跳变', () => {
    const r = reconcileTurnCredit({ prev: 100, now: 50, limit: 10 })
    expect(r.newCredits).toBe(100)
    expect(r.reverted).toBe(true)
  })
  it('两者皆 null → null（维持池现值不动）', () => {
    const r = reconcileTurnCredit({ prev: null, now: null, limit: 10 })
    expect(r.newCredits).toBeNull()
    expect(r.reverted).toBe(false)
  })
})