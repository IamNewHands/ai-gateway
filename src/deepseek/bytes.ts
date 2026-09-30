/**
 * deepseek/bytes.ts — 字节/编码小工具（纯函数，Workers 与 Node 通用）。
 *
 * 不用 atob/btoa：那两个在 Workers 与 Node 里都存在，但对二进制串的处理依赖
 * latin1 语义，容易在非 ASCII 路径上悄悄错；这里手写以保持可测、可移植。
 */

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const B64_LOOKUP: Record<string, number> = (() => {
  const m: Record<string, number> = {}
  for (let i = 0; i < B64_ALPHABET.length; i++) m[B64_ALPHABET[i]] = i
  return m
})()

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

export function fromUtf8(b: Uint8Array): string {
  return new TextDecoder().decode(b)
}

export function toHex(b: Uint8Array): string {
  let out = ''
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, '0')
  return out
}

/** 解析十六进制字符串；长度奇数或含非十六进制字符时抛错。 */
export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('bytes: hex string must have even length')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) throw new Error('bytes: invalid hex string')
    out[i] = byte
  }
  return out
}

export function base64Encode(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0
    out += B64_ALPHABET[b0 >> 2]
    out += B64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)]
    out += i + 1 < bytes.length ? B64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : '='
    out += i + 2 < bytes.length ? B64_ALPHABET[b2 & 0x3f] : '='
  }
  return out
}

export function base64Decode(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let acc = 0
  let bits = 0
  let o = 0
  for (let i = 0; i < clean.length; i++) {
    const v = B64_LOOKUP[clean[i]]
    if (v === undefined) throw new Error('bytes: invalid base64 string')
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (acc >> bits) & 0xff
    }
  }
  return out.subarray(0, o)
}

/** 等长比较（常量时间），用于签名/挑战比对。 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}
