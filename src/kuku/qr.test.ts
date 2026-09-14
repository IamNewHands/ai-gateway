import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env, Provider } from '../types'
import { startKukuQrLogin, pollKukuQrLogin } from './qr'

/** 简易内存 KV，模拟 env.KV get/put/delete */
function makeEnv(seed?: Record<string, string>): Env {
  const map = new Map(Object.entries(seed || {}))
  const kv = {
    get: async (key: string) => map.get(key) ?? null,
    put: async (key: string, value: string, opts?: { expirationTtl?: number }) => { map.set(key, value) },
    delete: async (key: string) => { map.delete(key) },
  }
  return { KV: kv } as unknown as Env
}

function kukuProvider(id: string): Provider {
  return {
    id, name: 'Kuku', baseUrl: 'https://kuku.baidu.com', apiType: 'openai',
    apiKeys: [{ key: 'BDUSS=old', enabled: true }], models: [],
    enabled: true, type: 'kuku', createdAt: 'a', updatedAt: 'a',
  }
}

describe('kuku QR login', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('startKukuQrLogin 获取二维码并写 KV 状态（补全 scheme）', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({
        errno: 0,
        imgurl: 'passport.baidu.com/v2/api/qrcode?sign=abc123&lp=pc',
        sign: 'abc123',
      }), { headers: { 'Set-Cookie': 'BAIDUID=xyz; Path=/; HttpOnly' } }),
    )

    const env = makeEnv()
    const result = await startKukuQrLogin(env, 'kuku')
    expect(result.success).toBe(true)
    expect(result.qr?.imgUrl).toBe('https://passport.baidu.com/v2/api/qrcode?sign=abc123&lp=pc')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // KV 状态已写（内含 sign）
    const stored = await env.KV.get('kuku:qr:kuku')
    expect(stored).toContain('"sign":"abc123"')
  })

  it('pollKukuQrLogin 未确认时返回 pending', async () => {
    const env = makeEnv()
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ errno: 0, imgurl: 'passport.baidu.com/v2/api/qrcode?sign=abc&lp=pc', sign: 'abc' })),
    )
    await startKukuQrLogin(env, 'kuku')
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('cb({"errno":0,"channel_v":"{\\"status\\":1}"})'),
    )
    const result = await pollKukuQrLogin(env, 'kuku')
    expect(result.status).toBe('pending')
  })

  it('pollKukuQrLogin 确认后兑换 Cookie 并写入已保存 provider', async () => {
    const env = makeEnv({ providers: JSON.stringify([kukuProvider('kuku')]) })
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ errno: 0, imgurl: 'passport.baidu.com/v2/api/qrcode?sign=abc&lp=pc', sign: 'abc' })),
    )
    await startKukuQrLogin(env, 'kuku')

    const fetchMock = vi.mocked(fetch)
    // unicast：确认登录，返回临时 BDUSS
    fetchMock.mockResolvedValueOnce(
      new Response('cb({"errno":0,"channel_v":"{\\"status\\":0,\\"v\\":\\"TEMPBDUSS\\"}"})'),
    )
    // qrbdusslogin：返回正式会话
    fetchMock.mockResolvedValueOnce(
      Response.json({
        errInfo: { no: '0' },
        data: { session: { bduss: 'FINALBDUSS', ptoken: 'PTOKENVAL', stoken: 'STOKENVAL' } },
      }),
    )

    const result = await pollKukuQrLogin(env, 'kuku')
    expect(result.status).toBe('success')
    const cookie = result.status === 'success' ? result.cookie : ''
    expect(cookie).toBe('BDUSS=FINALBDUSS; PTOKEN=PTOKENVAL; STOKEN=STOKENVAL')

    // provider.apiKeys 更新为最新 Cookie（旧 BDUSS=old 被移除）
    const providers = JSON.parse((await env.KV.get('providers')) || '[]') as Provider[]
    const p = providers.find((x) => x.id === 'kuku')!
    expect(p.apiKeys.map((k) => k.key)).toEqual([cookie])
    // 临时状态已删除
    expect(await env.KV.get('kuku:qr:kuku')).toBeNull()
  })

  it('pollKukuQrLogin 无进行中状态返回 error', async () => {
    const result = await pollKukuQrLogin(makeEnv(), 'kuku')
    expect(result.status).toBe('error')
  })

  it('pollKukuQrLogin 过期返回 failed', async () => {
    // 造一个已过期的状态
    const env = makeEnv({
      'kuku:qr:kuku': JSON.stringify({
        sign: 's', imgUrl: 'u', cookieJar: '', createdAt: Date.now() - 999999,
        expiresAt: Date.now() - 1000,
      }),
    })
    const result = await pollKukuQrLogin(env, 'kuku')
    expect(result.status).toBe('failed')
  })
})