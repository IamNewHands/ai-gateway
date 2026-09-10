import { describe, it, expect } from 'vitest'
import {
  base64url,
  decodeBase64url,
  randomToken,
  sha256,
  passwordRecord,
  verifyPassword,
  encryptJSON,
  decryptJSON,
  encryptCompactionCapsule,
  decryptCompactionCapsule,
} from './crypto'

describe('Web Crypto Utilities', () => {
  it('base64url 编解码一致性', () => {
    const raw = new Uint8Array([0, 1, 2, 255, 254, 128, 64])
    const encoded = base64url(raw)
    expect(encoded).not.toContain('+')
    expect(encoded).not.toContain('/')
    expect(encoded).not.toContain('=')
    const decoded = decodeBase64url(encoded)
    expect(decoded).toEqual(raw)
  })

  it('sha256 计算哈希并返回 base64url 字符串', async () => {
    const hash = await sha256('hello world')
    expect(typeof hash).toBe('string')
    expect(hash.length).toBeGreaterThan(10)
  })

  it('passwordRecord 与 verifyPassword 正确验证密码', async () => {
    const record = await passwordRecord('my-secure-password')
    expect(record).toMatch(/^pbkdf2-sha256\$100000\$/)
    expect(await verifyPassword(record, 'my-secure-password')).toBe(true)
    expect(await verifyPassword(record, 'wrong-password')).toBe(false)
  })

  it('AES-GCM encryptJSON 与 decryptJSON 加解密对象', async () => {
    const key = randomToken(32)
    const data = { foo: 'bar', numbers: [1, 2, 3], nested: { valid: true } }
    const cipher = await encryptJSON(data, key)
    expect(typeof cipher).toBe('string')
    const decrypted = await decryptJSON<typeof data>(cipher, key)
    expect(decrypted).toEqual(data)
  })

  it('compaction capsule 加密与多 key 轮转解密', async () => {
    const key1 = randomToken(32)
    const key2 = randomToken(32)
    const payload = { sessionKey: 'responses_123', version: 1 }
    const encrypted = await encryptCompactionCapsule(payload, key2)

    // key 列表中包含正确 key2 时成功解密
    const decrypted = await decryptCompactionCapsule<typeof payload>(encrypted, [key1, key2])
    expect(decrypted).toEqual(payload)

    // 不包含有效 key 时抛出异常
    await expect(decryptCompactionCapsule(encrypted, [key1])).rejects.toThrow('INVALID_COMPACTION_CAPSULE')
  })
})
