import type { Provider } from '../types'
import { KUKU_QUERY_BASE, KUKU_TARGET } from './constants'

export interface KukuCredentials {
  cookie: string
  bdstoken: string
  uinfo: string
  uk: number
}

export type KukuFetch = typeof fetch

interface ExportedCookie {
  name?: unknown
  value?: unknown
}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36'

export function normalizeKukuCookie(raw: string): string {
  const credential = raw.trim()
  if (!credential) throw new Error('Kuku provider has no enabled Cookie credential')

  if (!credential.startsWith('{') && !credential.startsWith('[')) return credential

  let parsed: unknown
  try {
    parsed = JSON.parse(credential)
  } catch {
    return credential
  }

  const cookies = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { cookies?: unknown }).cookies)
      ? (parsed as { cookies: unknown[] }).cookies
      : []
  const parts = cookies.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const { name, value } = entry as ExportedCookie
    if (typeof name !== 'string' || typeof value !== 'string' || !name.trim() || !value.trim()) return []
    return [`${name.trim()}=${value.trim()}`]
  })
  if (parts.length === 0) {
    throw new Error('Kuku credential JSON contains no valid cookies')
  }
  return parts.join('; ')
}

export function getKukuCookie(provider: Provider): string {
  const cookie = provider.apiKeys.find((entry) => entry.enabled && entry.key.trim())?.key.trim()
  if (!cookie) throw new Error('Kuku provider has no enabled Cookie credential')
  return normalizeKukuCookie(cookie)
}

export function buildKukuHeaders(cookie: string, sse = false): Headers {
  return new Headers({
    Cookie: cookie,
    'Content-Type': 'application/json',
    Referer: `${KUKU_TARGET}/genflowpro`,
    Origin: KUKU_TARGET,
    Accept: sse ? 'text/event-stream' : 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'User-Agent': USER_AGENT,
  })
}

export function buildKukuQuery(credentials?: Pick<KukuCredentials, 'bdstoken' | 'uinfo' | 'uk'>): string {
  const query = new URLSearchParams(KUKU_QUERY_BASE)
  if (credentials) {
    query.set('bdstoken', credentials.bdstoken)
    query.set('uinfo', credentials.uinfo)
    query.set('uk', String(credentials.uk))
  }
  return query.toString()
}

async function responseExcerpt(response: Response): Promise<string> {
  const text = await response.text().catch(() => '')
  return text.slice(0, 240).replace(/\s+/g, ' ')
}

export async function refreshKukuCredentials(
  provider: Provider,
  fetchImpl: KukuFetch = fetch,
  signal?: AbortSignal,
): Promise<KukuCredentials> {
  const cookie = getKukuCookie(provider)
  const response = await fetchImpl(
    `${KUKU_TARGET}/api/genflowpro/common/userreport?${buildKukuQuery()}`,
    { method: 'GET', headers: buildKukuHeaders(cookie), signal },
  )
  if (!response.ok) {
    throw new Error(`Kuku userreport failed with HTTP ${response.status}: ${await responseExcerpt(response)}`)
  }

  const payload = await response.json().catch(() => null) as {
    errno?: number
    data?: { bdstoken?: unknown; uinfo?: unknown; uk?: unknown }
  } | null
  if (!payload || payload.errno !== 0 || !payload.data) {
    throw new Error(`Kuku userreport returned an invalid response (errno=${payload?.errno ?? 'unknown'})`)
  }

  const { bdstoken, uinfo, uk } = payload.data
  if (typeof bdstoken !== 'string' || !bdstoken || typeof uinfo !== 'string' || !uinfo || !Number.isFinite(Number(uk))) {
    throw new Error('Kuku userreport response is missing bdstoken, uinfo, or uk')
  }
  return { cookie, bdstoken, uinfo, uk: Number(uk) }
}
