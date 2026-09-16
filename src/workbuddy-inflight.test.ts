import { describe, it, expect, beforeEach } from 'vitest'
import {
  DEFAULT_MAX_IN_FLIGHT,
  acquireInFlight,
  releaseInFlight,
  isInFlightFull,
  inFlightOf,
  inFlightSnapshot,
  resolveMaxInFlight,
  resolveMaxInFlightGlobal,
  __resetInFlightForTests,
} from './workbuddy-inflight'

/**
 * 在途租约测试（移植 workbuddy2api internal/pool/pool.go Acquire/Release + pick.go inFlightFull）。
 */

const PID = 'wb-inflight'

describe('acquireInFlight / releaseInFlight', () => {
  beforeEach(() => { __resetInFlightForTests() })

  it('默认上限 3：第 4 次 acquire 失败', () => {
    expect(acquireInFlight(PID, 'u1')).toBe(true)
    expect(acquireInFlight(PID, 'u1')).toBe(true)
    expect(acquireInFlight(PID, 'u1')).toBe(true)
    expect(acquireInFlight(PID, 'u1')).toBe(false)
    expect(inFlightOf(PID, 'u1')).toBe(3)
  })

  it('释放后可再次占用', () => {
    for (let i = 0; i < 3; i++) expect(acquireInFlight(PID, 'u1')).toBe(true)
    expect(acquireInFlight(PID, 'u1')).toBe(false)
    releaseInFlight(PID, 'u1')
    expect(acquireInFlight(PID, 'u1')).toBe(true)
  })

  it('不同账号独立计数', () => {
    for (let i = 0; i < 3; i++) acquireInFlight(PID, 'u1')
    expect(acquireInFlight(PID, 'u1')).toBe(false)
    // u2 未受影响
    expect(acquireInFlight(PID, 'u2')).toBe(true)
  })

  it('不同 provider 独立计数', () => {
    for (let i = 0; i < 3; i++) acquireInFlight('p1', 'u1')
    expect(acquireInFlight('p1', 'u1')).toBe(false)
    expect(acquireInFlight('p2', 'u1')).toBe(true)
  })

  it('自定义上限生效', () => {
    expect(acquireInFlight(PID, 'u1', 1)).toBe(true)
    expect(acquireInFlight(PID, 'u1', 1)).toBe(false)
  })

  it('maxInFlight <= 0 不限：acquire 恒成功但仍计数（供观测）', () => {
    for (let i = 0; i < 10; i++) expect(acquireInFlight(PID, 'u1', 0)).toBe(true)
    expect(inFlightOf(PID, 'u1')).toBe(10)
    expect(acquireInFlight(PID, 'u1', -1)).toBe(true)
  })

  it('release 幂等：已为 0 时不扣成负数', () => {
    releaseInFlight(PID, 'u1')
    releaseInFlight(PID, 'u1')
    expect(inFlightOf(PID, 'u1')).toBe(0)
    // 未 acquire 过的 uid 也安全
    expect(() => releaseInFlight(PID, 'never')).not.toThrow()
  })

  it('release 到 0 后计数条目被清理（防 Map 无限增长）', () => {
    acquireInFlight(PID, 'u1')
    expect(inFlightSnapshot().length).toBe(1)
    releaseInFlight(PID, 'u1')
    expect(inFlightSnapshot().length).toBe(0)
  })

  it('计数不因多次 acquire/release 漂移', () => {
    for (let round = 0; round < 5; round++) {
      acquireInFlight(PID, 'u1')
      acquireInFlight(PID, 'u1')
      releaseInFlight(PID, 'u1')
      releaseInFlight(PID, 'u1')
    }
    expect(inFlightOf(PID, 'u1')).toBe(0)
  })
})

describe('isInFlightFull', () => {
  beforeEach(() => { __resetInFlightForTests() })

  it('达到上限 → true；未达 → false', () => {
    expect(isInFlightFull(PID, 'u1')).toBe(false)
    acquireInFlight(PID, 'u1')
    acquireInFlight(PID, 'u1')
    expect(isInFlightFull(PID, 'u1')).toBe(false)
    acquireInFlight(PID, 'u1')
    expect(isInFlightFull(PID, 'u1')).toBe(true)
  })

  it('maxInFlight <= 0 → 恒 false（不限）', () => {
    for (let i = 0; i < 100; i++) acquireInFlight(PID, 'u1', 0)
    expect(isInFlightFull(PID, 'u1', 0)).toBe(false)
    expect(isInFlightFull(PID, 'u1', -5)).toBe(false)
  })

  it('未占用过的账号 → false', () => {
    expect(isInFlightFull(PID, 'unknown')).toBe(false)
  })
})

describe('resolveMaxInFlight', () => {
  it('未配置 → 默认 3（对齐 workbuddy2api pool.max_in_flight 默认值）', () => {
    expect(resolveMaxInFlight({})).toBe(DEFAULT_MAX_IN_FLIGHT)
    expect(resolveMaxInFlight({ oauth: {} })).toBe(DEFAULT_MAX_IN_FLIGHT)
    expect(resolveMaxInFlight({ oauth: { maxInFlight: undefined } })).toBe(DEFAULT_MAX_IN_FLIGHT)
  })

  it('配置值优先', () => {
    expect(resolveMaxInFlight({ oauth: { maxInFlight: 1 } })).toBe(1)
    expect(resolveMaxInFlight({ oauth: { maxInFlight: 10 } })).toBe(10)
  })

  it('0 / 负数 → 原样返回（表示不限，由 acquire/isFull 解释）', () => {
    expect(resolveMaxInFlight({ oauth: { maxInFlight: 0 } })).toBe(0)
    expect(resolveMaxInFlight({ oauth: { maxInFlight: -1 } })).toBe(-1)
  })

  it('非法值（NaN / Infinity / 非数字）→ 回退默认', () => {
    expect(resolveMaxInFlight({ oauth: { maxInFlight: NaN } })).toBe(DEFAULT_MAX_IN_FLIGHT)
    expect(resolveMaxInFlight({ oauth: { maxInFlight: Infinity } })).toBe(DEFAULT_MAX_IN_FLIGHT)
    expect(resolveMaxInFlight({ oauth: { maxInFlight: '3' as unknown as number } })).toBe(DEFAULT_MAX_IN_FLIGHT)
  })
})

describe('resolveMaxInFlightGlobal（对齐 workbuddy2api 2680f4c）', () => {
  it('未配置 → 0（回落 maxInFlight，不分档）', () => {
    expect(resolveMaxInFlightGlobal({})).toBe(0)
    expect(resolveMaxInFlightGlobal({ oauth: {} })).toBe(0)
    expect(resolveMaxInFlightGlobal({ oauth: { maxInFlightGlobal: undefined } })).toBe(0)
  })

  it('配置正数 → 原样返回', () => {
    expect(resolveMaxInFlightGlobal({ oauth: { maxInFlightGlobal: 2 } })).toBe(2)
  })

  it('0 / 负数 / 非法 → 回落 0', () => {
    expect(resolveMaxInFlightGlobal({ oauth: { maxInFlightGlobal: 0 } })).toBe(0)
    expect(resolveMaxInFlightGlobal({ oauth: { maxInFlightGlobal: -1 } })).toBe(0)
    expect(resolveMaxInFlightGlobal({ oauth: { maxInFlightGlobal: NaN } })).toBe(0)
  })
})

describe('realm 分档在途（对齐 workbuddy2api 2680f4c global/CN 分档）', () => {
  beforeEach(() => { __resetInFlightForTests() })

  it('global 档 2 + CN 档 3：global 第 3 次被拒、cn 第 3 次成功', () => {
    // global 档 2：前两次成功、第三次被拒
    expect(acquireInFlight(PID, 'g1', 3, 'global', 2)).toBe(true)
    expect(acquireInFlight(PID, 'g1', 3, 'global', 2)).toBe(true)
    expect(acquireInFlight(PID, 'g1', 3, 'global', 2)).toBe(false)
    // cn 档 3（未分档回落 maxInFlight）：第三次仍成功
    expect(acquireInFlight(PID, 'cn1', 3, 'cn', 2)).toBe(true)
    expect(acquireInFlight(PID, 'cn1', 3, 'cn', 2)).toBe(true)
    expect(acquireInFlight(PID, 'cn1', 3, 'cn', 2)).toBe(true)
    expect(acquireInFlight(PID, 'cn1', 3, 'cn', 2)).toBe(false)
  })

  it('maxInFlightGlobal 未配置（0）→ global 与 cn 同为 maxInFlight 档（零回归）', () => {
    for (let i = 0; i < 3; i++) expect(acquireInFlight(PID, 'g1', 3, 'global', 0)).toBe(true)
    expect(acquireInFlight(PID, 'g1', 3, 'global', 0)).toBe(false)
  })

  it('isInFlightFull 按 realm 分档判定', () => {
    acquireInFlight(PID, 'g1', 3, 'global', 2)
    acquireInFlight(PID, 'g1', 3, 'global', 2)
    expect(isInFlightFull(PID, 'g1', 3, 'global', 2)).toBe(true)
    // 同 uid 按 cn 档看：只有 2 在途 < 3，未满
    expect(isInFlightFull(PID, 'g1', 3, 'cn', 2)).toBe(false)
  })
})
