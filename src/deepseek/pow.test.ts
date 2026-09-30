/**
 * deepseek/pow.test.ts — HashV1 / PoW 一致性测试。
 *
 * 证据来源：simple-chat `app/internal/pow/pow_test.go`（MIT）。golden vector 由该仓库
 * 以「第二份独立实现交叉确认」的方式产出；其中一组来自 2026-09-19 对生产上游的真实
 * 探测（salt 6c3a962c828dd81d7d69 / expire_at 1780227446451 / difficulty 144000 /
 * 正解 86022）。移植时逐条保留，作为协议一致性的唯一权威依据。
 */

import { describe, it, expect } from 'vitest'
import {
  hashV1,
  buildPrefix,
  solvePow,
  buildPowHeader,
  solveAndBuildHeader,
  DEFAULT_DIFFICULTY,
  type PowChallenge,
} from './pow'

const enc = (s: string) => new TextEncoder().encode(s)
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

describe('hashV1 golden vectors', () => {
  const cases: Array<[string, string]> = [
    ['', 'e594808bc5b7151ac160c6d39a02e0a8e261ed588578403099e3561dc40c26b3'],
    ['testsalt_1700000000_42', 'd4a2ea58c89e40887c933484868380c6f803eaa8dc53a3b9df8e431b921a4f09'],
    ['testsalt_1700000000_100000', 'abea2f35796b65486e9be1b36f7878c66cab021e96faa473fdf4decd31f9ba30'],
    ['abc123salt_1700000000_12345', '74b3b7452745b70e85eb32ee7f0a9ec0381d42dd5137b695da915e104fc390e1'],
    // 生产上游真实挑战（answer 86022）的前像。
    ['6c3a962c828dd81d7d69_1780227446451_86022', '34d4c336676aa2e83c3308148e12ba8bc5e77ccb2fc12eeea1046e20c4c64eec'],
  ]

  for (const [input, want] of cases) {
    it(`hashV1(${JSON.stringify(input)}) matches the Go implementation`, () => {
      expect(hex(hashV1(enc(input)))).toBe(want)
    })
  }
})

describe('hashV1 block boundaries', () => {
  it('is deterministic and length-sensitive for multi-block input', () => {
    const a = hashV1(new Uint8Array(300))
    const b = hashV1(new Uint8Array(300))
    expect(hex(a)).toBe(hex(b))
    expect(hex(hashV1(new Uint8Array(301)))).not.toBe(hex(a))
  })

  it('handles an exact-rate-block input (136 bytes) without a stray extra block', () => {
    // 136 字节正好一个整块：尾部长度 0，pad 必须落在新块首字节。
    const want = hex(hashV1(enc('a'.repeat(136))))
    expect(want).toHaveLength(64)
    expect(want).not.toBe(hex(hashV1(enc('a'.repeat(135)))))
  })
})

describe('buildPrefix', () => {
  it('renders salt_expireAt_', () => {
    expect(buildPrefix('testsalt', 1700000000)).toBe('testsalt_1700000000_')
  })
})

describe('solvePow', () => {
  it('finds the golden answers', () => {
    const cases = [
      { salt: 'testsalt', expire: 1700000000, answer: 42, diff: 1000 },
      { salt: 'testsalt', expire: 1700000000, answer: 500, diff: 2000 },
      { salt: 'abc123salt', expire: 1700000000, answer: 12345, diff: 20000 },
    ]
    for (const c of cases) {
      const target = hex(hashV1(enc(buildPrefix(c.salt, c.expire) + String(c.answer))))
      expect(solvePow(target, c.salt, c.expire, c.diff)).toBe(c.answer)
    }
  })

  it('solves the real production challenge (difficulty 144000 → answer 86022)', () => {
    const got = solvePow(
      '34d4c336676aa2e83c3308148e12ba8bc5e77ccb2fc12eeea1046e20c4c64eec',
      '6c3a962c828dd81d7d69',
      1780227446451,
      DEFAULT_DIFFICULTY,
    )
    expect(got).toBe(86022)
  })

  it('rejects a malformed challenge', () => {
    expect(() => solvePow('zz', 'salt', 1, 100)).toThrow(/64 hex chars/)
    expect(() => solvePow('zzzz', 'salt', 1, 100)).toThrow(/64 hex chars/)
  })

  it('reports no solution when difficulty is 0 or too small', () => {
    const target = hex(hashV1(enc('salt_1700000000_99')))
    expect(() => solvePow(target, 'salt', 1700000000, 0)).toThrow(/no solution/)
    expect(() => solvePow(target, 'salt', 1700000000, 99)).toThrow(/no solution/)
    // 100 个候选里包含正解 99（上限是开区间，故 99 在内）。
    expect(solvePow(target, 'salt', 1700000000, 100)).toBe(99)
  })

  it('honours the abort signal', () => {
    const controller = new AbortController()
    controller.abort()
    const target = hex(hashV1(enc('salt_1700000000_7')))
    expect(() => solvePow(target, 'salt', 1700000000, 144000, { signal: controller.signal })).toThrow(/aborted/)
  })
})

describe('buildPowHeader', () => {
  const challenge: PowChallenge = {
    algorithm: 'HashV1',
    challenge: '6100',
    salt: 'salt',
    expire_at: 1712345678,
    difficulty: 2000,
    signature: 'sig',
    target_path: '/api/v0/chat/completion',
  }

  it('base64-encodes exactly the six protocol fields', () => {
    const header = buildPowHeader(challenge, 777)
    const parsed = JSON.parse(new TextDecoder().decode(
      Uint8Array.from(atob(header), (c) => c.charCodeAt(0)),
    ))
    expect(Object.keys(parsed)).toEqual([
      'algorithm', 'challenge', 'salt', 'answer', 'signature', 'target_path',
    ])
    expect(parsed.answer).toBe(777)
    expect(parsed).not.toHaveProperty('difficulty')
    expect(parsed).not.toHaveProperty('expire_at')
  })
})

describe('solveAndBuildHeader', () => {
  it('runs end to end and recovers the answer', () => {
    const target = hex(hashV1(enc('salt_1712345678_777')))
    const header = solveAndBuildHeader({
      algorithm: 'HashV1',
      challenge: target,
      salt: 'salt',
      expire_at: 1712345678,
      difficulty: 2000,
      signature: 'sig',
      target_path: '/api/v0/chat/completion',
    })
    const parsed = JSON.parse(new TextDecoder().decode(
      Uint8Array.from(atob(header), (c) => c.charCodeAt(0)),
    ))
    expect(parsed.answer).toBe(777)
  })

  it('accepts the android-app algorithm name DeepSeekHashV1', () => {
    const target = hex(hashV1(enc('testsalt_1700000000_42')))
    const header = solveAndBuildHeader({
      algorithm: 'DeepSeekHashV1',
      challenge: target,
      salt: 'testsalt',
      expire_at: 1700000000,
      difficulty: DEFAULT_DIFFICULTY,
      signature: 'sig',
      target_path: '/api/v0/chat/completion',
    })
    expect(header.length).toBeGreaterThan(0)
  })

  it('rejects an unknown algorithm', () => {
    expect(() => solveAndBuildHeader({
      algorithm: 'SHA256',
      challenge: '00'.repeat(32),
      salt: 'salt',
      expire_at: 1,
      difficulty: 1,
      signature: 'sig',
      target_path: '/x',
    })).toThrow(/unsupported algorithm/)
  })
})
