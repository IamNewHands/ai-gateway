import { KV_KEYS } from './config'
import type { Env, Provider, ProxyKey, Session } from './types'

// ===== 内存缓存（P1：降低热路径 KV 读放大）=====
// 每个 isolate 内缓存 KV 原始文本 + 10s TTL；写路径同步刷新缓存。
// 多 isolate 部署时，其它实例最多滞后一个 TTL（10s），对网关场景可接受。
const CACHE_TTL_MS = 10_000

/**
 * 解析 provider.baseUrl 中的占位符：
 * - {CF_ACCOUNT_ID} → env.CF_ACCOUNT_ID（Cloudflare Workers AI 的 URL 需要 Account ID）
 * 未配置对应环境变量时返回 null，调用方应给出明确错误提示。
 */
export function resolveProviderBaseUrl(env: Env, baseUrl: string): string | null {
  if (!baseUrl.includes('{CF_ACCOUNT_ID}')) return baseUrl
  if (!env.CF_ACCOUNT_ID) return null
  return baseUrl.replace(/\{CF_ACCOUNT_ID\}/g, env.CF_ACCOUNT_ID)
}

interface RawCacheEntry { text: string; at: number }
const providersCache = new Map<string, RawCacheEntry>()
const proxyKeysCache = new Map<string, RawCacheEntry>()

function rawCacheGet(cache: Map<string, RawCacheEntry>, key: string): string | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    cache.delete(key)
    return undefined
  }
  return entry.text
}
function rawCacheSet(cache: Map<string, RawCacheEntry>, key: string, text: string): void {
  cache.set(key, { text, at: Date.now() })
}

/** 安全 JSON.parse：KV 数据损坏 / 结构不符时回退默认值，避免连锁 500（R7） */
function safeParseArray<T>(text: string | null | undefined, fallback: T[]): T[] {
  if (!text) return fallback
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? (parsed as T[]) : fallback
  } catch {
    return fallback
  }
}

// ===== 提供商 CRUD =====

export async function getProviders(env: Env): Promise<Provider[]> {
  const cached = rawCacheGet(providersCache, KV_KEYS.PROVIDERS)
  if (cached !== undefined) return safeParseArray<Provider>(cached, [])
  return getProvidersFresh(env)
}

/** 绕过内存缓存直读 KV 并刷新本地缓存（写路径用，避免基于过期缓存读-改-写丢更新）。 */
export async function getProvidersFresh(env: Env): Promise<Provider[]> {
  const data = await env.KV.get(KV_KEYS.PROVIDERS)
  const providers = safeParseArray<Provider>(data, [])
  rawCacheSet(providersCache, KV_KEYS.PROVIDERS, JSON.stringify(providers))
  return providers
}

export async function getProvider(env: Env, id: string): Promise<Provider | null> {
  const providers = await getProviders(env)
  return providers.find((p) => p.id === id) ?? null
}

export async function setProviders(env: Env, providers: Provider[]): Promise<void> {
  const text = JSON.stringify(providers)
  await env.KV.put(KV_KEYS.PROVIDERS, text)
  rawCacheSet(providersCache, KV_KEYS.PROVIDERS, text)
}

export async function addProvider(env: Env, provider: Provider): Promise<void> {
  const providers = await getProvidersFresh(env)
  providers.push(provider)
  await setProviders(env, providers)
}

export async function updateProvider(env: Env, id: string, updates: Partial<Provider>): Promise<Provider | null> {
  const providers = await getProvidersFresh(env)
  const index = providers.findIndex((p) => p.id === id)
  if (index === -1) return null
  providers[index] = { ...providers[index], ...updates, updatedAt: new Date().toISOString() }
  await setProviders(env, providers)
  return providers[index]
}

export async function deleteProvider(env: Env, id: string): Promise<boolean> {
  const providers = await getProvidersFresh(env)
  const filtered = providers.filter((p) => p.id !== id)
  if (filtered.length === providers.length) return false
  await setProviders(env, filtered)
  return true
}

// ===== 登录失败限速（S8c）=====
const LOGIN_ATTEMPT_TTL = 5 * 60 // 窗口 5 分钟
const LOGIN_ATTEMPT_MAX = 5 // 窗口内最多失败次数
const loginRateKey = (ip: string) => `${KV_KEYS.LOGIN_RATE}${ip}`

/**
 * 记录一次登录失败，返回是否应拒绝（true = 已超过阈值，锁 5 分钟）。
 * 计数存 KV，键带 TTL 自动过期，窗口内累计失败 ≥5 次即锁定该 IP。
 */
export async function recordLoginFailure(env: Env, ip: string): Promise<boolean> {
  const key = loginRateKey(ip)
  const raw = await env.KV.get(key)
  const count = raw ? (parseInt(raw, 10) || 0) : 0
  const next = count + 1
  await env.KV.put(key, String(next), { expirationTtl: LOGIN_ATTEMPT_TTL })
  return next >= LOGIN_ATTEMPT_MAX
}

/** 登录成功 / 明确拒绝前，清掉该 IP 的历史失败计数 */
export async function resetLoginFailures(env: Env, ip: string): Promise<void> {
  await env.KV.delete(loginRateKey(ip))
}

/** 查询某 IP 当前失败计数（用于锁定提示文案） */
export async function getLoginFailureCount(env: Env, ip: string): Promise<number> {
  const raw = await env.KV.get(loginRateKey(ip))
  return raw ? (parseInt(raw, 10) || 0) : 0
}

// ===== Session 管理 =====

export async function createSession(env: Env, username: string, ttlSeconds: number): Promise<string> {
  const sessionId = crypto.randomUUID()
  const session: Session = {
    username,
    expiresAt: Date.now() + ttlSeconds * 1000,
  }
  await env.KV.put(KV_KEYS.SESSION_PREFIX + sessionId, JSON.stringify(session), {
    expirationTtl: ttlSeconds,
  })
  return sessionId
}

export async function getSession(env: Env, sessionId: string): Promise<Session | null> {
  const data = await env.KV.get(KV_KEYS.SESSION_PREFIX + sessionId)
  if (!data) return null
  let session: Session | null = null
  try {
    session = JSON.parse(data) as Session
  } catch {
    return null
  }
  if (!session || typeof session.expiresAt !== 'number' || session.expiresAt < Date.now()) {
    await deleteSession(env, sessionId)
    return null
  }
  return session
}

export async function deleteSession(env: Env, sessionId: string): Promise<void> {
  await env.KV.delete(KV_KEYS.SESSION_PREFIX + sessionId)
}

// ===== 转发 Key =====

export async function getProxyKeys(env: Env): Promise<ProxyKey[]> {
  const cached = rawCacheGet(proxyKeysCache, KV_KEYS.PROXY_KEYS)
  if (cached !== undefined) return safeParseArray<ProxyKey>(cached, [])
  const data = await env.KV.get(KV_KEYS.PROXY_KEYS)
  if (data !== null) rawCacheSet(proxyKeysCache, KV_KEYS.PROXY_KEYS, data)
  return safeParseArray<ProxyKey>(data, [])
}

export async function setProxyKeys(env: Env, keys: ProxyKey[]): Promise<void> {
  const text = JSON.stringify(keys)
  await env.KV.put(KV_KEYS.PROXY_KEYS, text)
  rawCacheSet(proxyKeysCache, KV_KEYS.PROXY_KEYS, text)
}

export async function addProxyKey(env: Env, key: ProxyKey): Promise<void> {
  const keys = await getProxyKeys(env)
  keys.push(key)
  await setProxyKeys(env, keys)
}

export async function deleteProxyKey(env: Env, id: string): Promise<boolean> {
  const keys = await getProxyKeys(env)
  const filtered = keys.filter((k) => k.id !== id)
  if (filtered.length === keys.length) return false
  await setProxyKeys(env, filtered)
  return true
}

export async function updateProxyKey(env: Env, id: string, updates: Partial<ProxyKey>): Promise<ProxyKey | null> {
  const keys = await getProxyKeys(env)
  const idx = keys.findIndex(k => k.id === id)
  if (idx === -1) return null
  keys[idx] = { ...keys[idx], ...updates }
  await setProxyKeys(env, keys)
  return keys[idx]
}

export async function getValidProxyKey(env: Env, key: string): Promise<ProxyKey | null> {
  const keys = await getProxyKeys(env)
  const found = keys.find((k) => {
    if (k.key !== key || !k.enabled) return false
    if (k.expiresAt) {
      const now = Date.now()
      const expires = new Date(k.expiresAt).getTime()
      if (now >= expires) return false
    }
    return true
  })
  return found || null
}

// ===== 初始数据填充 =====

import { DEFAULT_PROVIDERS, PROXY_KEY_PREFIX } from './config'

export async function seedInitialData(env: Env): Promise<void> {
  const providers = await getProviders(env)

  // 升级迁移：补全新默认 provider（cloudflare-ai / openrouter）。
  // 用 KV 标记保证只补齐一次——用户之后手动删除的默认 provider 不会被自动加回。
  const migrationDone = await env.KV.get(KV_KEYS.DEFAULT_PROVIDERS_MIGRATION)
  if (!migrationDone) {
    const opencodeMigrated = await env.KV.get(KV_KEYS.OPENCODE_MIGRATION) === '1'
    const existingIds = new Set(providers.map((p) => p.id))
    // 全新部署补全部默认 provider；老部署（opencode 已迁移过）只补本次新增的两个。
    const missing = DEFAULT_PROVIDERS.filter((d) => {
      if (existingIds.has(d.id)) return false
      return !(opencodeMigrated && d.id === 'opencode')
    })
    if (missing.length > 0) {
      await setProviders(env, [
        ...providers,
        ...missing.map((p) => ({
          ...p,
          apiKeys: p.apiKeys.map((k) => ({ ...k })),
          models: p.models.map((m) => ({ ...m })),
        })),
      ])
    }
    await env.KV.put(KV_KEYS.DEFAULT_PROVIDERS_MIGRATION, '1')
  }

  // 仅首次运行时创建测试转发 Key（以补齐前的原始 providers 判断，避免补齐后误判为非首次）
  if (providers.length === 0) {
    const keys = await getProxyKeys(env)
    if (keys.length === 0) {
      const testKey = {
        id: crypto.randomUUID(),
        key: `${PROXY_KEY_PREFIX}${crypto.randomUUID().replace(/-/g, '').substring(0, 16)}`,
        name: '测试 Key',
        enabled: true,
        createdAt: new Date().toISOString(),
      }
      await addProxyKey(env, testKey)
    }
  }
}
