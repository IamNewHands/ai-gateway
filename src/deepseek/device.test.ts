/**
 * deepseek/device.test.ts — 设备身份铸造的一致性测试。
 *
 * 证据来源：simple-chat `internal/upstream/deviceid_test.go` + `region.go` 的构造常量。
 * 这里额外补了一条 Go 版没有的断言：**用字面量密钥解密铸造结果**，证明我们的
 * device_id 就是「AES-128-CBC/PKCS7(key=MD5("com.deepseek.chat"), IV=0)」的产物，
 * 而不是一段碰巧像 Base64 的数据。
 */

import { describe, it, expect } from 'vitest'
import { base64Decode, fromHex, utf8, fromUtf8 } from './bytes'
import {
  accountIdentity,
  channelOS,
  mintAppDeviceId,
  normalizeChannel,
  resolveDeviceId,
  resolveDeviceProfile,
  syntheticAndroidId,
  uuidV5,
} from './device'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('uuidV5', () => {
  it('matches the RFC 4122 appendix example (DNS namespace + "python.org")', async () => {
    const dnsNs = fromHex('6ba7b8109dad11d180b400c04fd430c8')
    expect(await uuidV5(dnsNs, 'python.org')).toBe('886313e1-3b8a-5372-9b90-0c9aee199e5d')
  })

  it('is stable and name-sensitive', async () => {
    const ns = fromHex('a5c3f7e12b4d4f6a8c910d3e5f7a9b2c')
    const a = await uuidV5(ns, 'simple-chat/rangers-id/13800000009')
    expect(await uuidV5(ns, 'simple-chat/rangers-id/13800000009')).toBe(a)
    expect(await uuidV5(ns, 'simple-chat/rangers-id/13800000007')).not.toBe(a)
    expect(a).toMatch(UUID_RE)
  })
})

describe('mintAppDeviceId', () => {
  it('is exactly AES-128-CBC/PKCS7(key=MD5("com.deepseek.chat"), IV=0) over "<androidId>_google"', async () => {
    const androidId = '0123456789abcdef'
    const minted = await mintAppDeviceId(androidId, 'google')

    // 独立解密：密钥用字面量（= MD5("com.deepseek.chat")），不引用模块内常量。
    const key = await crypto.subtle.importKey(
      'raw',
      fromHex('7614e48627b7380b17b386d382d1b2ef') as unknown as ArrayBufferView,
      { name: 'AES-CBC' },
      false,
      ['decrypt'],
    )
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-CBC', iv: new Uint8Array(16) },
      key,
      base64Decode(minted) as unknown as ArrayBufferView,
    )
    expect(fromUtf8(new Uint8Array(plain))).toBe('0123456789abcdef_google')
  })

  it('produces a non-UUID, base64-shaped id', async () => {
    const minted = await mintAppDeviceId(await syntheticAndroidId('13800000000'))
    expect(minted).not.toMatch(UUID_RE)
    expect(minted.length).toBeGreaterThan(20)
  })
})

describe('syntheticAndroidId', () => {
  it('is 16 lowercase hex chars and stable per identity', async () => {
    const id = await syntheticAndroidId('13800000009')
    expect(id).toMatch(/^[0-9a-f]{16}$/)
    expect(await syntheticAndroidId('13800000009')).toBe(id)
    expect(await syntheticAndroidId('13800000007')).not.toBe(id)
  })
})

describe('resolveDeviceId', () => {
  it('uses an explicit value verbatim', async () => {
    expect(await resolveDeviceId({ mobile: '13800000000', deviceId: 'harvested_smsdk_value' }))
      .toBe('harvested_smsdk_value')
    // web 频道的空白填充不应被当成显式值
    expect(await resolveDeviceId({ mobile: '13800000000', deviceId: '   ' }))
      .not.toBe('   ')
  })

  it('mints an app-format id when absent, without ever emitting a UUID', async () => {
    const got = await resolveDeviceId({ mobile: '13800000000' })
    expect(got).not.toMatch(UUID_RE)
    expect(got).not.toBe('')
    expect(got).not.toBe('simple_chat_client')
  })

  it('is stable across calls and distinct across accounts', async () => {
    const a = await resolveDeviceId({ mobile: '13800000009' })
    expect(await resolveDeviceId({ mobile: '13800000009' })).toBe(a)
    expect(await resolveDeviceId({ mobile: '13800000007' })).not.toBe(a)
  })

  it('handles email-only accounts', async () => {
    const a = await resolveDeviceId({ email: 'one@example.com' })
    const b = await resolveDeviceId({ email: 'two@example.com' })
    expect(a).not.toBe('')
    expect(b).not.toBe('')
    expect(a).not.toBe(b)
  })
})

describe('resolveDeviceProfile', () => {
  it('keeps android defaults: header device id equals the minted id', async () => {
    const p = await resolveDeviceProfile({ mobile: '13800000009' })
    expect(p.channel).toBe('')
    expect(p.headerDeviceId).toBe(p.deviceId)
    expect(p.rangersId).toMatch(UUID_RE)
    expect(channelOS(p.channel)).toBe('android')
  })

  it('separates the Shumei body device id from the header UUID on the web channel', async () => {
    const p = await resolveDeviceProfile({
      email: 'acct@example.com',
      channel: 'web',
      deviceId: 'B-harvested-shumei-id',
    })
    expect(p.channel).toBe('web')
    expect(p.deviceId).toBe('B-harvested-shumei-id')
    expect(p.headerDeviceId).toMatch(UUID_RE)
    expect(p.headerDeviceId).not.toBe(p.deviceId)
    expect(channelOS(p.channel)).toBe('web')
  })

  it('derives a per-account rangers id (never shared)', async () => {
    const a = await resolveDeviceProfile({ mobile: '13800000009' })
    const b = await resolveDeviceProfile({ mobile: '13800000007' })
    expect(a.rangersId).not.toBe(b.rangersId)
  })
})

describe('identity helpers', () => {
  it('prefers mobile over email and trims', () => {
    expect(accountIdentity({ mobile: ' 13800000009 ', email: 'x@y.z' })).toBe('13800000009')
    expect(accountIdentity({ email: 'x@y.z' })).toBe('x@y.z')
    expect(accountIdentity({})).toBe('')
  })

  it('normalizes channels and rejects unknown ones', () => {
    expect(normalizeChannel(undefined)).toBe('')
    expect(normalizeChannel('')).toBe('')
    expect(normalizeChannel('web')).toBe('web')
    expect(normalizeChannel(' web ')).toBe('web')
    expect(normalizeChannel('ios')).toBeNull()
  })
})
