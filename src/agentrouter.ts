import type { Context } from 'hono'
import { KV_KEYS } from './config'
import { decryptJSON, encryptJSON, sha256 } from './m365/crypto'
import { readStrictJSONLimited } from './request-body'
import type { ApiResponse, Env } from './types'

const ORIGIN = 'https://agentrouter.org'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
const MAX_ACCOUNTS = 20
const CHECKIN_CONCURRENCY = 3
const REQUEST_BYTES = 16 * 1024
const RESPONSE_BYTES = 256 * 1024
const REQUEST_TIMEOUT_MS = 20_000
const ACCOUNT_TIMEOUT_MS = 60_000
const QUOTA_PER_DOLLAR = 500_000
const ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u

interface Account {
  version: 1
  id: string
  name: string
  email: string
  enabled: boolean
  encryptedPassword: string
  createdAt: number
  updatedAt: number
}

export interface AgentRouterResult {
  accountId: string
  status: 'ok' | 'already' | 'unverified' | 'fail' | 'disabled'
  checkedInDate: string | null
  checkedInAt: number | null
  updatedAt: number
  quota: number | null
  usedQuota: number | null
  totalQuota: number | null
  quotaAt: number | null
  errorCode: string | null
  warningCode: string | null
}

export interface AgentRouterAccountView {
  id: string
  name: string
  email: string
  enabled: boolean
  hasPassword: boolean
  credentialsReady: boolean
  checkedInToday: boolean
  result: AgentRouterResult | null
}

export interface AgentRouterSummary {
  total: number
  ok: number
  already: number
  fail: number
  skipped: number
  results: AgentRouterResult[]
}

class AgentRouterError extends Error {
  constructor(readonly code: string, readonly transient = false) {
    super(code)
    this.name = 'AgentRouterError'
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function number(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

export function agentRouterDate(now: number): string {
  return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function accountKey(id: string): string {
  if (!ID_PATTERN.test(id)) throw new AgentRouterError('INVALID_ACCOUNT_ID')
  return KV_KEYS.AGENTROUTER_ACCOUNT_PREFIX + id
}

// Reuse the existing server secret. Rotating ADMIN_PASSWORD requires re-entering
// site passwords; neither plaintext passwords nor session Cookies leave this module.
async function credentialKey(env: Env): Promise<string> {
  if (!env.ADMIN_PASSWORD) throw new AgentRouterError('CREDENTIAL_KEY_MISSING')
  return sha256('ai-gateway:agentrouter:credentials:v1:' + env.ADMIN_PASSWORD)
}

function parseAccount(raw: string, id: string): Account {
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new AgentRouterError('ACCOUNT_DATA_INVALID') }
  if (!object(value) || value.version !== 1 || value.id !== id ||
    typeof value.email !== 'string' || typeof value.name !== 'string' ||
    typeof value.enabled !== 'boolean' || typeof value.encryptedPassword !== 'string' ||
    typeof value.createdAt !== 'number' || typeof value.updatedAt !== 'number') {
    throw new AgentRouterError('ACCOUNT_DATA_INVALID')
  }
  return {
    version: 1, id, name: value.name, email: value.email, enabled: value.enabled,
    encryptedPassword: value.encryptedPassword, createdAt: value.createdAt, updatedAt: value.updatedAt,
  }
}

async function getAccount(env: Env, id: string): Promise<Account | null> {
  const raw = await env.KV.get(accountKey(id))
  return raw ? parseAccount(raw, id) : null
}

async function listAccounts(env: Env): Promise<Account[]> {
  const accounts: Account[] = []
  let cursor: string | undefined
  do {
    const page = await env.KV.list({ prefix: KV_KEYS.AGENTROUTER_ACCOUNT_PREFIX, cursor, limit: 100 })
    for (const key of page.keys) {
      const id = key.name.slice(KV_KEYS.AGENTROUTER_ACCOUNT_PREFIX.length)
      const account = await getAccount(env, id)
      if (account) accounts.push(account)
    }
    if (page.list_complete) break
    if (!page.cursor || page.cursor === cursor) throw new AgentRouterError('ACCOUNT_LIST_FAILED')
    cursor = page.cursor
  } while (true)
  return accounts.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

async function passwordOf(account: Account, key: string): Promise<string> {
  try {
    const value = await decryptJSON<unknown>(account.encryptedPassword, key)
    if (object(value) && value.email === account.email && typeof value.password === 'string' && value.password) {
      return value.password
    }
  } catch { /* The encrypted record may belong to an old admin secret. */ }
  throw new AgentRouterError('CREDENTIALS_LOCKED')
}

function parseResult(raw: string | null, id: string): AgentRouterResult | null {
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (!object(value) || value.accountId !== id ||
      !['ok', 'already', 'unverified', 'fail', 'disabled'].includes(String(value.status)) ||
      typeof value.updatedAt !== 'number') return null
    const text = (v: unknown) => typeof v === 'string' ? v : null
    return {
      accountId: id, status: value.status as AgentRouterResult['status'],
      checkedInDate: text(value.checkedInDate), checkedInAt: number(value.checkedInAt),
      updatedAt: value.updatedAt, quota: number(value.quota), usedQuota: number(value.usedQuota),
      totalQuota: number(value.totalQuota), quotaAt: number(value.quotaAt),
      errorCode: text(value.errorCode), warningCode: text(value.warningCode),
    }
  } catch { return null }
}

async function confirmedToday(env: Env, id: string, now: number): Promise<boolean> {
  const date = agentRouterDate(now)
  const raw = await env.KV.get(KV_KEYS.AGENTROUTER_DAY_PREFIX + id + ':' + date)
  if (!raw) return false
  try {
    const value: unknown = JSON.parse(raw)
    return object(value) && value.accountId === id && value.date === date &&
      typeof value.checkedInAt === 'number' && agentRouterDate(value.checkedInAt) === date &&
      value.checkedInAt <= now + 5_000
  } catch { return false }
}

export async function readAgentRouterAccounts(env: Env, now = Date.now()): Promise<AgentRouterAccountView[]> {
  const accounts = await listAccounts(env)
  let key: string | null = null
  try { key = await credentialKey(env) } catch { /* Read-only views still work without the key. */ }
  const views: AgentRouterAccountView[] = []
  for (const account of accounts) {
    let credentialsReady = false
    if (key) {
      try { await passwordOf(account, key); credentialsReady = true } catch { /* Show a locked state. */ }
    }
    views.push({
      id: account.id, name: account.name, email: account.email, enabled: account.enabled,
      hasPassword: Boolean(account.encryptedPassword), credentialsReady,
      checkedInToday: await confirmedToday(env, account.id, now),
      result: parseResult(await env.KV.get(KV_KEYS.AGENTROUTER_RESULT_PREFIX + account.id), account.id),
    })
  }
  return views
}

export async function saveAgentRouterAccount(env: Env, input: unknown, id?: string): Promise<string> {
  if (!object(input)) throw new AgentRouterError('INVALID_ACCOUNT')
  const existing = id ? await getAccount(env, id) : null
  if (id && !existing) throw new AgentRouterError('ACCOUNT_NOT_FOUND')
  if (input.email !== undefined && typeof input.email !== 'string') throw new AgentRouterError('INVALID_EMAIL')
  const email = (typeof input.email === 'string' ? input.email : existing?.email || '').trim().toLowerCase()
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw new AgentRouterError('INVALID_EMAIL')
  if (existing && email !== existing.email) throw new AgentRouterError('EMAIL_IMMUTABLE')
  const accountId = id || await sha256(email)
  const previous = existing || await getAccount(env, accountId)
  if (!id && previous) throw new AgentRouterError('ACCOUNT_EXISTS')
  if (!previous && (await listAccounts(env)).length >= MAX_ACCOUNTS) throw new AgentRouterError('ACCOUNT_LIMIT')
  if (input.name !== undefined && typeof input.name !== 'string') throw new AgentRouterError('INVALID_NAME')
  const name = (typeof input.name === 'string' ? input.name : previous?.name || '').trim() || email
  if (name.length > 254) throw new AgentRouterError('INVALID_NAME')
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new AgentRouterError('INVALID_ENABLED')
  if (input.password !== undefined && typeof input.password !== 'string') throw new AgentRouterError('INVALID_PASSWORD')
  // Do not trim passwords: spaces and "#" can be valid credential characters.
  const password = typeof input.password === 'string' ? input.password : ''
  if (password.length > 1024) throw new AgentRouterError('INVALID_PASSWORD')
  if (!previous && !password) throw new AgentRouterError('PASSWORD_REQUIRED')
  const encryptedPassword = password
    ? await encryptJSON({ email, password }, await credentialKey(env))
    : previous!.encryptedPassword
  const now = Date.now()
  const account: Account = {
    version: 1, id: accountId, email, name,
    enabled: typeof input.enabled === 'boolean' ? input.enabled : previous?.enabled ?? true,
    encryptedPassword, createdAt: previous?.createdAt ?? now, updatedAt: now,
  }
  await env.KV.put(accountKey(accountId), JSON.stringify(account))
  return accountId
}

export async function deleteAgentRouterAccount(env: Env, id: string): Promise<void> {
  if (!await getAccount(env, id)) throw new AgentRouterError('ACCOUNT_NOT_FOUND')
  await env.KV.delete(accountKey(id))
  await env.KV.delete(KV_KEYS.AGENTROUTER_RESULT_PREFIX + id)
  // Success markers contain no credentials and expire after three days. Keeping
  // them also prevents a same-day delete/re-add from causing another login.
}

type CookieJar = Map<string, string>

function mergeCookies(jar: CookieJar, headers: Headers): void {
  const compatible = headers as Headers & { getSetCookie?: () => string[]; getAll?: (name: string) => string[] }
  const lines = typeof compatible.getSetCookie === 'function' ? compatible.getSetCookie()
    : typeof compatible.getAll === 'function' ? compatible.getAll('Set-Cookie')
      : (headers.get('set-cookie') || '').split(/,(?=\s*[^;,\s]+=)/u)
  for (const line of lines) {
    const parts = line.split(';')
    const pair = parts[0].trim()
    const separator = pair.indexOf('=')
    if (separator < 1) continue
    const name = pair.slice(0, separator).trim()
    const value = pair.slice(separator + 1).trim()
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/iu.test(name) || /[\x00-\x20\x7f;,]/u.test(value)) continue
    const domain = parts.find((part) => /^\s*domain=/iu.test(part))?.split('=').slice(1).join('=').trim().replace(/^\./u, '').toLowerCase()
    if (domain && domain !== 'agentrouter.org') continue
    const maxAge = parts.find((part) => /^\s*max-age=/iu.test(part))?.split('=').slice(1).join('=').trim()
    const expires = parts.find((part) => /^\s*expires=/iu.test(part))?.split('=').slice(1).join('=').trim()
    if (!value || (maxAge !== undefined && Number(maxAge) <= 0) ||
      (maxAge === undefined && expires && Date.parse(expires) <= Date.now())) jar.delete(name)
    else jar.set(name, value)
  }
  if (jar.size > 32 || cookieHeader(jar).length > 8192) throw new AgentRouterError('COOKIE_LIMIT')
}

function cookieHeader(jar: CookieJar): string {
  return Array.from(jar, ([name, value]) => name + '=' + value).join('; ')
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

async function boundedJSON(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  const length = response.headers.get('content-length')
  if (length && Number(length) > RESPONSE_BYTES) {
    await cancelBody(response)
    throw new AgentRouterError('RESPONSE_TOO_LARGE')
  }
  if (!response.body) throw new AgentRouterError('INVALID_RESPONSE')
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })
  let size = 0
  const fragments: string[] = []
  const onAbort = () => { void reader.cancel().catch(() => undefined) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    for (;;) {
      if (signal.aborted) throw new AgentRouterError('REQUEST_TIMEOUT', true)
      const chunk = await reader.read()
      if (signal.aborted) throw new AgentRouterError('REQUEST_TIMEOUT', true)
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new AgentRouterError('RESPONSE_TOO_LARGE')
      }
      fragments.push(decoder.decode(chunk.value, { stream: true }))
    }
    fragments.push(decoder.decode())
    const value: unknown = JSON.parse(fragments.join(''))
    if (!object(value)) throw new AgentRouterError('INVALID_RESPONSE')
    return value
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    if (error instanceof AgentRouterError) throw error
    throw new AgentRouterError(signal.aborted ? 'REQUEST_TIMEOUT' : 'INVALID_RESPONSE', signal.aborted)
  } finally {
    signal.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }
}

async function requestJSON(
  path: string, jar: CookieJar, deadline: number,
  options: { login?: { email: string; password: string }; uid?: string } = {},
): Promise<Record<string, unknown>> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new AgentRouterError('REQUEST_TIMEOUT', true)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.min(remaining, REQUEST_TIMEOUT_MS))
  let url = new URL(path, ORIGIN)
  try {
    for (let hop = 0; hop <= 2; hop++) {
      const headers: Record<string, string> = {
        'User-Agent': UA, Accept: 'application/json, text/plain, */*',
        Origin: ORIGIN, Referer: ORIGIN + '/login',
      }
      if (jar.size) headers.Cookie = cookieHeader(jar)
      if (options.uid) headers['New-API-User'] = options.uid
      if (options.login) headers['Content-Type'] = 'application/json'
      let response: Response
      try {
        response = await fetch(url.href, {
          method: options.login ? 'POST' : 'GET', headers, redirect: 'manual', signal: controller.signal,
          ...(options.login ? { body: JSON.stringify({ username: options.login.email, password: options.login.password }) } : {}),
        })
      } catch {
        throw new AgentRouterError(controller.signal.aborted ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR', true)
      }
      try { mergeCookies(jar, response.headers) } catch (error) {
        await cancelBody(response)
        throw error
      }
      if (response.status >= 300 && response.status < 400) {
        await cancelBody(response)
        const location = response.headers.get('location')
        if (options.login || !location) throw new AgentRouterError('UPSTREAM_REDIRECT')
        let next: URL
        try { next = new URL(location, url) } catch { throw new AgentRouterError('UPSTREAM_REDIRECT') }
        if (next.origin !== ORIGIN || next.username || next.password) throw new AgentRouterError('UNSAFE_REDIRECT')
        url = next
        continue
      }
      if (!response.ok) {
        await cancelBody(response)
        throw new AgentRouterError(
          response.status === 401 ? 'UPSTREAM_AUTH' : response.status === 403 ? 'UPSTREAM_BLOCKED'
            : response.status === 429 ? 'UPSTREAM_RATE_LIMIT' : 'UPSTREAM_HTTP_' + response.status,
          [502, 503, 504].includes(response.status),
        )
      }
      if ((response.headers.get('content-type') || '').toLowerCase().includes('text/html')) {
        await cancelBody(response)
        throw new AgentRouterError('UPSTREAM_BLOCKED')
      }
      return await boundedJSON(response, controller.signal)
    }
    throw new AgentRouterError('UPSTREAM_REDIRECT')
  } finally { clearTimeout(timer) }
}

function emptyResult(id: string, status: AgentRouterResult['status'], errorCode: string | null = null): AgentRouterResult {
  return {
    accountId: id, status, checkedInDate: null, checkedInAt: null, updatedAt: Date.now(),
    quota: null, usedQuota: null, totalQuota: null, quotaAt: null, errorCode, warningCode: null,
  }
}

function fillQuota(result: AgentRouterResult, data: Record<string, unknown>): boolean {
  const dollars = (value: unknown) => {
    const n = number(value)
    return n === null ? null : n / QUOTA_PER_DOLLAR
  }
  const quota = dollars(data.quota)
  const usedQuota = dollars(data.used_quota)
  const totalQuota = dollars(data.total_quota) ??
    (quota !== null && usedQuota !== null ? quota + usedQuota : null)
  if (quota === null && usedQuota === null && totalQuota === null) return false
  result.quota = quota
  result.usedQuota = usedQuota
  result.totalQuota = totalQuota
  result.quotaAt = Date.now()
  return true
}

// Login has a check-in side effect. A successful login or a generic type=4
// system log alone is not proof of today's reward.
async function checkinAccount(account: Account, key: string): Promise<AgentRouterResult> {
  const result = emptyResult(account.id, 'fail')
  const start = Date.now()
  const deadline = start + ACCOUNT_TIMEOUT_MS
  const jar: CookieJar = new Map()
  try {
    const password = await passwordOf(account, key)
    let login: Record<string, unknown> | undefined
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        login = await requestJSON('/api/user/login', jar, deadline, { login: { email: account.email, password } })
        break
      } catch (error) {
        if (!(error instanceof AgentRouterError) || !error.transient || attempt === 1) throw error
        await new Promise<void>((resolve) => setTimeout(resolve, 1_000))
      }
    }
    if (!login || login.success !== true) throw new AgentRouterError('LOGIN_FAILED')
    const data = object(login.data) ? login.data : {}
    fillQuota(result, data)
    const uidNumber = number(data.id)
    if (uidNumber === null || !Number.isSafeInteger(uidNumber) || uidNumber <= 0) throw new AgentRouterError('USER_ID_MISSING')
    if (!jar.size) throw new AgentRouterError('SESSION_MISSING')
    const uid = String(uidNumber)
    let checkedInAt: number | null = null
    try {
      const logs = await requestJSON('/api/log/self?p=1&page_size=20', jar, deadline, { uid })
      if (logs.success !== true || !object(logs.data) || !Array.isArray(logs.data.items)) throw new AgentRouterError('INVALID_LOGS')
      const now = Date.now()
      for (const item of logs.data.items) {
        if (!object(item) || number(item.type) !== 4 || typeof item.content !== 'string') continue
        if (!item.content.includes('\u7b7e\u5230\u6210\u529f') ||
          /(?:\u672a|\u6ca1\u6709|\u5c1a\u672a)\u7b7e\u5230\u6210\u529f|\u7b7e\u5230\u5931\u8d25/u.test(item.content)) continue
        const seconds = number(item.created_at)
        if (seconds === null || !Number.isSafeInteger(seconds)) continue
        const at = seconds * 1000
        if (at <= now + 5_000 && agentRouterDate(at) === agentRouterDate(now) &&
          (checkedInAt === null || at > checkedInAt)) checkedInAt = at
      }
      if (checkedInAt === null) result.errorCode = 'CHECKIN_NOT_CONFIRMED'
    } catch (error) {
      result.errorCode = error instanceof AgentRouterError ? error.code : 'LOG_VERIFY_FAILED'
    }
    if (checkedInAt !== null) {
      result.checkedInAt = checkedInAt
      result.checkedInDate = agentRouterDate(checkedInAt)
      result.status = data.checked_in === true && checkedInAt >= start - 2_000 ? 'ok' : 'already'
      result.errorCode = null
    } else result.status = 'unverified'
    try {
      const self = await requestJSON('/api/user/self', jar, deadline, { uid })
      if (self.success !== true || !object(self.data)) throw new AgentRouterError('QUOTA_UNAVAILABLE')
      if (!fillQuota(result, self.data)) result.warningCode = 'QUOTA_UNAVAILABLE'
    } catch {
      // The quota lookup is optional and cannot erase confirmed check-in evidence.
      result.warningCode = 'QUOTA_UNAVAILABLE'
    }
  } catch (error) {
    result.errorCode = error instanceof AgentRouterError ? error.code : 'CHECKIN_FAILED'
    if (result.errorCode === 'USER_ID_MISSING' || result.errorCode === 'SESSION_MISSING') result.status = 'unverified'
  }
  result.updatedAt = Date.now()
  return result
}

export async function runAgentRouterCheckins(
  env: Env, options: { accountId?: string; force?: boolean } = {},
): Promise<AgentRouterSummary> {
  const accounts = options.accountId ? [await getAccount(env, options.accountId)] : await listAccounts(env)
  if (options.accountId && !accounts[0]) throw new AgentRouterError('ACCOUNT_NOT_FOUND')
  const selected = accounts.filter((account): account is Account => account !== null)
  const results: AgentRouterResult[] = new Array(selected.length)
  const run = async (account: Account): Promise<AgentRouterResult> => {
    let result: AgentRouterResult
    try {
      if (!account.enabled) return emptyResult(account.id, 'disabled')
      if (!options.force && await confirmedToday(env, account.id, Date.now())) {
        return { ...emptyResult(account.id, 'already'), checkedInDate: agentRouterDate(Date.now()) }
      }
      result = await checkinAccount(account, await credentialKey(env))
    } catch (error) {
      result = emptyResult(account.id, 'fail', error instanceof AgentRouterError ? error.code : 'CHECKIN_FAILED')
    }
    try {
      if (result.checkedInDate && result.checkedInAt !== null) {
        await env.KV.put(KV_KEYS.AGENTROUTER_DAY_PREFIX + account.id + ':' + result.checkedInDate, JSON.stringify({
          accountId: account.id, date: result.checkedInDate, checkedInAt: result.checkedInAt,
        }), { expirationTtl: 3 * 86400 })
      }
      await env.KV.put(KV_KEYS.AGENTROUTER_RESULT_PREFIX + account.id, JSON.stringify(result), { expirationTtl: 14 * 86400 })
      return result
    } catch {
      return { ...result, errorCode: 'RESULT_STORAGE_FAILED', status: 'fail' }
    }
  }
  let cursor = 0
  // Keep a full account set within the scheduled runtime budget when upstream stalls.
  const worker = async () => {
    while (cursor < selected.length) {
      const index = cursor++
      results[index] = await run(selected[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(CHECKIN_CONCURRENCY, selected.length) }, worker))
  return {
    total: results.length, ok: results.filter((r) => r.status === 'ok').length,
    already: results.filter((r) => r.status === 'already').length,
    fail: results.filter((r) => r.status === 'fail' || r.status === 'unverified').length,
    skipped: results.filter((r) => r.status === 'disabled').length, results,
  }
}

function failure(c: Context<{ Bindings: Env }>, error: unknown): Response {
  const code = error instanceof AgentRouterError ? error.code : 'AGENTROUTER_STORAGE_FAILED'
  const status = code === 'ACCOUNT_NOT_FOUND' ? 404 : code === 'ACCOUNT_EXISTS' ? 409 :
    /^(INVALID_|EMAIL_|PASSWORD_|ACCOUNT_LIMIT)/u.test(code) ? 400 : 503
  return c.json<ApiResponse & { code: string }>({ success: false, code, message: code }, status)
}

export async function handleAgentRouterAccounts(c: Context<{ Bindings: Env }>) {
  c.header('Cache-Control', 'no-store')
  try {
    return c.json<ApiResponse<AgentRouterAccountView[]>>({ success: true, data: await readAgentRouterAccounts(c.env) })
  } catch (error) { return failure(c, error) }
}

export async function handleAgentRouterAccountSave(c: Context<{ Bindings: Env }>) {
  c.header('Cache-Control', 'no-store')
  const body = await readStrictJSONLimited<unknown>(c.req.raw, REQUEST_BYTES)
  try {
    const id = await saveAgentRouterAccount(c.env, body, c.req.param('id'))
    return c.json<ApiResponse<{ id: string }>>({ success: true, data: { id } })
  } catch (error) { return failure(c, error) }
}

export async function handleAgentRouterAccountDelete(c: Context<{ Bindings: Env }>) {
  c.header('Cache-Control', 'no-store')
  try {
    await deleteAgentRouterAccount(c.env, c.req.param('id') || '')
    return c.json<ApiResponse>({ success: true })
  } catch (error) { return failure(c, error) }
}

export async function handleAgentRouterCheckin(c: Context<{ Bindings: Env }>) {
  c.header('Cache-Control', 'no-store')
  try {
    const summary = await runAgentRouterCheckins(c.env, { accountId: c.req.param('id'), force: true })
    return c.json<ApiResponse<AgentRouterSummary>>({ success: true, data: summary })
  } catch (error) { return failure(c, error) }
}
