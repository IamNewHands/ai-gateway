/**
 * deepseek/bytes.test.ts — 编码工具的边界（padding / 非 ASCII / 非法输入）。
 */

import { describe, it, expect } from 'vitest'
import { base64Decode, base64Encode, bytesEqual, fromHex, fromUtf8, toHex, utf8 } from './bytes'

describe('hex', () => {
  it('round-trips', () => {
    const b = Uint8Array.from([0, 1, 15, 16, 127, 128, 255])
    expect(toHex(b)).toBe('00010f107f80ff')
    expect(Array.from(fromHex('00010f107f80ff'))).toEqual(Array.from(b))
  })

  it('rejects malformed input', () => {
    expect(() => fromHex('abc')).toThrow(/even length/)
    expect(() => fromHex('zz')).toThrow(/invalid hex/)
  })
})

describe('base64', () => {
  it('matches the canonical vectors including both padding widths', () => {
    expect(base64Encode(utf8(''))).toBe('')
    expect(base64Encode(utf8('f'))).toBe('Zg==')
    expect(base64Encode(utf8('fo'))).toBe('Zm8=')
    expect(base64Encode(utf8('foo'))).toBe('Zm9v')
    expect(base64Encode(utf8('foob'))).toBe('Zm9vYg==')
    expect(base64Encode(utf8('fooba'))).toBe('Zm9vYmE=')
    expect(base64Encode(utf8('foobar'))).toBe('Zm9vYmFy')
  })

  it('round-trips binary and non-ASCII bytes', () => {
    const raw = Uint8Array.from({ length: 256 }, (_, i) => i)
    expect(Array.from(base64Decode(base64Encode(raw)))).toEqual(Array.from(raw))
    const cn = utf8('设备指纹')
    expect(fromUtf8(base64Decode(base64Encode(cn)))).toBe('设备指纹')
  })

  it('rejects invalid base64', () => {
    expect(() => base64Decode('!!!!')).toThrow(/invalid base64/)
  })
})

describe('bytesEqual', () => {
  it('compares by content and length', () => {
    expect(bytesEqual(fromHex('00ff'), fromHex('00ff'))).toBe(true)
    expect(bytesEqual(fromHex('00ff'), fromHex('00fe'))).toBe(false)
    expect(bytesEqual(fromHex('00ff'), fromHex('00'))).toBe(false)
  })
})
