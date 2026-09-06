/**
 * quota.ts — Gemini（Antigravity 链路）账号额度查询。
 *
 * 移植自 Antigravity-Manager src-tauri/src/modules/quota.rs：
 *   端点 1（按模型 5h 窗口）：POST {base}/v1internal:fetchAvailableModels
 *     body {"project": <pid>} → models{ quotaInfo: { remainingFraction(0-1), resetTime } }
 *   端点 2（5h + 周窗口分组摘要）：POST {base}/v1internal:retrieveUserQuotaSummary
 *     body {"project": <pid>} → groups[{ displayName, buckets[{ bucketId, window,
 *     remainingFraction, resetTime }] }]，bucketId 如 gemini-5h / gemini-weekly / 3p-5h / 3p-weekly
 *   端点 3（订阅档位）：POST {base}/v1internal:loadCodeAssist
 *     body {"metadata":{"ideType":"ANTIGRAVITY"}} → paidTier/currentTier name
 *
 * 端点回退：Sandbox → Daily → Prod（对个人账号更宽容、规避 Prod 429）。
 * 额度端点 UA 与 Antigravity-Manager 一致（vscode/1.X.X (Antigravity/<ver>)）。
 */
import type { Env, Provider } from '../types'
import { getOauthAccessToken, readOauthToken, GEMINI_FALLBACK_PROJECT_ID } from '../oauth'
import { GEMINI_FALLBACK_BASE_URLS, GEMINI_NATIVE_OAUTH_USER_AGENT } from './proxy'
import { isGeminiProvider } from './proxy'
import { KV_KEYS } from '../config'

/** 端点回退顺序（Sandbox → Daily → Prod），与推理转发一致 */
const QUOTA_BASE_URLS = GEMINI_FALLBACK_BASE_URLS

/** 与 Antigravity-Manager NATIVE_OAUTH_USER_AGENT 对齐（版本跟随 proxy.ts 的 GEMINI_CLIENT_VERSION） */
const QUOTA_USER_AGENT = GEMINI_NATIVE_OAUTH_USER_AGENT

/** 额度缓存 TTL（秒）：额度本身按分钟级变化，5 分钟足够且省配额 */
const QUOTA_CACHE_TTL_SEC = 300

export interface GeminiQuotaBucket {
  bucketId: string
  window: string
  /** 剩余比例 0-100 */
  remainingPercent: number
  resetTime: string
  displayName?: string
  description?: string
}

export interface GeminiQuotaGroup {
  displayName: string
  description?: string
  buckets: GeminiQuotaBucket[]
}

export interface GeminiModelQuota {
  name: string
  /** 剩余百分比 0-100 */
  percentage: number
  resetTime: string
  displayName?: string
}

export interface GeminiQuotaSnapshot {
  providerId: string
  email?: string
  projectId?: string
  subscriptionTier?: string
  /** retrieveUserQuotaSummary 分组摘要（5h + weekly 双窗口） */
  groups: GeminiQuotaGroup[]
  /** fetchAvailableModels 按模型剩余比例 */
  models: GeminiModelQuota[]
  fetchedAt: number
  /** 摘要端点失败时部分数据仍可用，标记哪些环节失败 */
  warnings: string[]
}

const quotaCacheKey = (providerId: string) => `gemini:quota:${providerId}`

/** 带端点回退的 POST（JSON in/out）。全部端点失败返回 null（附错误信息）。 */
async function postWithFallback(
  path: string,
  token: string,
  payload: Record<string, unknown>
): Promise<{ data: Record<string, unknown> | null; error?: string }> {
  let lastErr = ''
  for (const base of QUOTA_BASE_URLS) {
    try {
      const res = await fetch(`${base}/v1internal:${path}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': QUOTA_USER_AGENT,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        lastErr = `${base} → HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`
        // 4xx（除 429）各端点行为一致，无需再回退
        if (res.status >= 400 && res.status < 500 && res.status !== 429) break
        continue
      }
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null
      if (data) return { data }
      lastErr = `${base} → 响应不是 JSON`
    } catch (e) {
      lastErr = `${base} → ${(e as Error).message || String(e)}`
    }
  }
  return { data: null, error: lastErr }
}

/** loadCodeAssist 解析订阅档位（paidTier 优先 → currentTier），best-effort。 */
async function fetchSubscriptionTier(token: string, projectId?: string): Promise<string | undefined> {
  const payload: Record<string, unknown> = { metadata: { ideType: 'ANTIGRAVITY' } }
  if (projectId) payload.project = projectId
  const { data } = await postWithFallback('loadCodeAssist', token, payload)
  if (!data) return undefined
  const tierName = (t: unknown): string | undefined => {
    if (!t || typeof t !== 'object') return undefined
    const rec = t as Record<string, unknown>
    const name = typeof rec.name === 'string' ? rec.name : undefined
    const id = typeof rec.id === 'string' ? rec.id : undefined
    return name || id
  }
  const ineligible = Array.isArray(data.ineligibleTiers) && data.ineligibleTiers.length > 0
  const tier = tierName(data.paidTier) || (ineligible ? undefined : tierName(data.currentTier))
  if (!tier && ineligible) {
    // INELIGIBLE 账号回退 allowedTiers 默认档
    const allowed = Array.isArray(data.allowedTiers) ? data.allowedTiers : []
    const def = allowed.find((t) => (t as Record<string, unknown>)?.is_default === true || (t as Record<string, unknown>)?.isDefault === true)
    const t = tierName(def)
    return t ? `${t} (Restricted)` : undefined
  }
  return tier
}

/** retrieveUserQuotaSummary：5h + weekly 分组摘要（最关键数据，失败记入 warnings） */
async function fetchQuotaGroups(token: string, projectId?: string): Promise<{ groups: GeminiQuotaGroup[]; error?: string }> {
  const payload: Record<string, unknown> = projectId ? { project: projectId } : {}
  const { data, error } = await postWithFallback('retrieveUserQuotaSummary', token, payload)
  if (!data) return { groups: [], error: error || '无响应' }
  const rawGroups = Array.isArray(data.groups) ? data.groups : []
  const groups: GeminiQuotaGroup[] = rawGroups.map((g) => {
    const rec = (g || {}) as Record<string, any>
    const buckets = (Array.isArray(rec.buckets) ? rec.buckets : []).map((b) => {
      const bk = (b || {}) as Record<string, any>
      const frac = typeof bk.remainingFraction === 'number' ? bk.remainingFraction : 0
      return {
        bucketId: String(bk.bucketId || ''),
        window: String(bk.window || ''),
        remainingPercent: Math.round(frac * 100),
        resetTime: String(bk.resetTime || ''),
        displayName: typeof bk.displayName === 'string' ? bk.displayName : undefined,
        description: typeof bk.description === 'string' ? bk.description : undefined,
      }
    })
    return {
      displayName: String(rec.displayName || '配额分组'),
      description: typeof rec.description === 'string' ? rec.description : undefined,
      buckets,
    }
  })
  return { groups }
}

/** fetchAvailableModels：按模型 5h 窗口剩余比例 */
async function fetchModelQuotas(token: string, projectId?: string): Promise<{ models: GeminiModelQuota[]; error?: string }> {
  const payload: Record<string, unknown> = projectId ? { project: projectId } : {}
  const { data, error } = await postWithFallback('fetchAvailableModels', token, payload)
  if (!data) return { models: [], error: error || '无响应' }
  const rawModels = (data.models && typeof data.models === 'object') ? data.models as Record<string, any> : {}
  const models: GeminiModelQuota[] = []
  for (const [name, info] of Object.entries(rawModels)) {
    // 只保留关心模型（对齐 Antigravity-Manager，排除内部 chat 模型）
    if (!(name.startsWith('gemini') || name.startsWith('claude') || name.startsWith('gpt') || name.startsWith('image') || name.startsWith('imagen'))) continue
    const qi = info?.quotaInfo
    if (!qi) continue
    const frac = typeof qi.remainingFraction === 'number' ? qi.remainingFraction : 0
    models.push({
      name,
      percentage: Math.round(frac * 100),
      resetTime: String(qi.resetTime || ''),
      displayName: typeof info.displayName === 'string' ? info.displayName : undefined,
    })
  }
  models.sort((a, b) => a.name.localeCompare(b.name))
  return { models }
}

/**
 * 拉取 Gemini 账号额度（subscriptionTier + 5h/weekly 分组 + 按模型剩余）。
 * 任一子端点失败不影响其余数据（warnings 记录失败环节）。
 */
export async function fetchGeminiQuota(env: Env, provider: Provider, force = false): Promise<GeminiQuotaSnapshot> {
  const base: GeminiQuotaSnapshot = {
    providerId: provider.id,
    email: undefined,
    projectId: undefined,
    groups: [],
    models: [],
    fetchedAt: Date.now(),
    warnings: [],
  }

  // 读缓存（force 时跳过）
  if (!force) {
    try {
      const raw = await env.KV.get(quotaCacheKey(provider.id))
      if (raw) return JSON.parse(raw) as GeminiQuotaSnapshot
    } catch { /* 缓存损坏按无缓存处理 */ }
  }

  const tokenState = await readOauthToken(env, provider.id)
  if (!tokenState) {
    base.warnings.push('未登录（无 OAuth token），请先完成 Gemini 授权')
    return base
  }
  // 临近过期走自动刷新拿可用 token
  let token = tokenState.access_token
  if (!token || tokenState.expires_at - Date.now() < 60_000) {
    token = (await getOauthAccessToken(env, provider.id, provider.oauth!)) || ''
  }
  if (!token) {
    base.warnings.push('token 已过期且刷新失败，请重新授权')
    return base
  }

  const projectId = tokenState.projectId || GEMINI_FALLBACK_PROJECT_ID
  base.email = tokenState.email
  base.projectId = projectId

  // 订阅档位 + 分组摘要 + 按模型额度（三个请求互相独立、互不阻塞）
  const tierPromise = fetchSubscriptionTier(token, projectId)
  const groupsPromise = fetchQuotaGroups(token, projectId)
  const modelsPromise = fetchModelQuotas(token, projectId)
  const [tier, groupsRes, modelsRes] = await Promise.all([tierPromise, groupsPromise, modelsPromise])

  base.subscriptionTier = tier
  base.groups = groupsRes.groups
  if (groupsRes.error) base.warnings.push(`额度摘要拉取失败：${groupsRes.error}`)
  base.models = modelsRes.models
  if (modelsRes.error) base.warnings.push(`模型额度拉取失败：${modelsRes.error}`)

  // 写缓存（无任何数据时不缓存，便于立即重试）
  const hasData = base.groups.length > 0 || base.models.length > 0
  if (hasData) {
    try {
      await env.KV.put(quotaCacheKey(provider.id), JSON.stringify(base), { expirationTtl: QUOTA_CACHE_TTL_SEC })
    } catch { /* ignore */ }
  }
  return base
}

export { quotaCacheKey }
