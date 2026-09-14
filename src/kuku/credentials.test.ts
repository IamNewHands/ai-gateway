import { describe, expect, it, vi } from 'vitest'
import type { Provider } from '../types'
import { buildKukuQuery, getKukuCookie, normalizeKukuCookie, refreshKukuCredentials } from './credentials'
import { probeKukuNetwork } from './probe'

function provider(cookie = 'BDUSS=secret; STOKEN=value'): Provider {
  return {
    id: 'kuku',
    name: 'Kuku',
    baseUrl: 'https://kuku.baidu.com',
    type: 'kuku',
    apiKeys: cookie ? [{ key: cookie, enabled: true }] : [],
    models: [{ id: 'auto', enabled: true }],
    enabled: true,
    createdAt: '',
    updatedAt: '',
  }
}

describe('Kuku credentials', () => {
  it('selects the first enabled non-empty Cookie', () => {
    const item = provider()
    item.apiKeys.unshift({ key: 'disabled=value', enabled: false })
    expect(getKukuCookie(item)).toBe('BDUSS=secret; STOKEN=value')
  })

  it('keeps a raw Cookie string unchanged', () => {
    expect(normalizeKukuCookie('BDUSS=secret; STOKEN=value')).toBe('BDUSS=secret; STOKEN=value')
  })

  it('converts a kuku_cookies.json object to a Cookie header', () => {
    const exported = JSON.stringify({
      cookies: [
        { name: 'BDUSS', value: 'secret', domain: '.baidu.com' },
        { name: 'STOKEN', value: 'value' },
        { name: '', value: 'ignored' },
      ],
    })
    expect(normalizeKukuCookie(exported)).toBe('BDUSS=secret; STOKEN=value')
  })

  it('converts a direct exported cookie array', () => {
    const exported = JSON.stringify([
      { name: 'BDUSS', value: 'secret' },
      { name: 'STOKEN', value: 'value' },
    ])
    expect(normalizeKukuCookie(exported)).toBe('BDUSS=secret; STOKEN=value')
  })

  it('rejects parsed JSON without valid cookies', () => {
    expect(() => normalizeKukuCookie('{"cookies":[]}')).toThrow('contains no valid cookies')
    expect(() => normalizeKukuCookie('[]')).toThrow('contains no valid cookies')
  })

  it('encodes derived credentials in the query string', () => {
    const query = buildKukuQuery({ bdstoken: 'a+b', uinfo: 'x&y', uk: 42 })
    const parsed = new URLSearchParams(query)
    expect(parsed.get('bdstoken')).toBe('a+b')
    expect(parsed.get('uinfo')).toBe('x&y')
    expect(parsed.get('uk')).toBe('42')
  })

  it('refreshes credentials without exposing the Cookie in errors', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Cookie')).toBe('BDUSS=secret; STOKEN=value')
      return new Response(JSON.stringify({
        errno: 0,
        data: { bdstoken: 'token', uinfo: 'user', uk: 123 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    await expect(refreshKukuCredentials(provider(), fetchMock as typeof fetch)).resolves.toEqual({
      cookie: 'BDUSS=secret; STOKEN=value',
      bdstoken: 'token',
      uinfo: 'user',
      uk: 123,
    })
  })

  it('reports the probe stage when no Cookie is configured', async () => {
    const result = await probeKukuNetwork(provider(''))
    expect(result.ok).toBe(false)
    expect(result.stage).toBe('configuration')
  })

  it('reports HTTP failures without including the configured Cookie', async () => {
    const fetchMock = vi.fn(async () => new Response('blocked by upstream', { status: 403 }))
    const result = await probeKukuNetwork(provider(), fetchMock as typeof fetch)
    expect(result).toMatchObject({ ok: false, stage: 'userreport', status: 403 })
    expect(result.message).not.toContain('BDUSS=secret')
  })
})
