import type { Context } from 'hono'
import type { AppEnv, Env, ProxyKey, Provider } from '../types'

export interface UsageMetrics {
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  totalTokens: number
}

export interface AnalyticsContext {
  route: string
  tokenHash: string
  tokenName: string
  providerId: string
  providerName: string
  providerType: string
  requestedModel: string
  upstreamModel: string
  streamMode: 'sync' | 'stream'
  requestId: string
  traceId: string
  clientIp: string
  userAgent: string
  country: string
  region: string
  city: string
  colo: string
  startedAt: number
  retryCount: number
}

export interface AnalyticsEventOptions {
  context: AnalyticsContext
  result: 'success' | 'failure'
  usage?: UsageMetrics
  upstreamStatus?: number
  errorCode?: string
  errorSummary?: string
}

export interface AnalyticsQueryResult {
  data: Array<Record<string, unknown>>
  meta?: Array<{ name?: string; type?: string }>
}

export const ANALYTICS_BLOBS = {
  route: 'blob1',
  tokenName: 'blob2',
  providerId: 'blob3',
  providerName: 'blob4',
  providerType: 'blob5',
  requestedModel: 'blob6',
  upstreamModel: 'blob7',
  result: 'blob8',
  streamMode: 'blob9',
  errorCode: 'blob10',
  statusFamily: 'blob11',
  requestId: 'blob12',
  traceId: 'blob13',
  clientIp: 'blob14',
  userAgent: 'blob15',
  country: 'blob16',
  region: 'blob17',
  city: 'blob18',
  colo: 'blob19',
  errorSummary: 'blob20',
} as const

export const ANALYTICS_DOUBLES = {
  promptTokens: 'double1',
  completionTokens: 'double2',
  cachedTokens: 'double3',
  totalTokens: 'double4',
  latencyMs: 'double5',
  retryCount: 'double6',
  upstreamStatus: 'double7',
  successFlag: 'double8',
} as const

export const createAnalyticsContext = (
  c: Context<AppEnv>,
  proxyKey: ProxyKey | null,
  proxyKeyHash: string,
  route: string,
  requestedModel: string,
  streamMode: 'sync' | 'stream',
  provider?: Provider,
  upstreamModel = '',
): AnalyticsContext => {
  const requestId = c.req.header('x-request-id') || c.req.header('cf-ray') || crypto.randomUUID()
  const traceId = c.req.header('traceparent') || c.req.header('x-b3-traceid') || c.req.header('x-trace-id') || requestId
  const cf = c.req.raw.cf as Record<string, unknown> | undefined

  return {
    route,
    tokenHash: proxyKeyHash.slice(0, 32),
    tokenName: proxyKey?.name || 'unknown',
    providerId: provider?.id || '',
    providerName: provider?.name || '',
    providerType: provider?.apiType || '',
    requestedModel,
    upstreamModel,
    streamMode,
    requestId,
    traceId,
    clientIp: c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || c.req.header('x-forwarded-for') || '',
    userAgent: c.req.header('user-agent') || '',
    country: typeof cf?.country === 'string' ? cf.country : '',
    region: typeof cf?.region === 'string' ? cf.region : '',
    city: typeof cf?.city === 'string' ? cf.city : '',
    colo: typeof cf?.colo === 'string' ? cf.colo : '',
    startedAt: Date.now(),
    retryCount: 0,
  }
}

export const getStatusFamily = (status: number): string => {
  if (status >= 200 && status < 300) return '2xx'
  if (status >= 400 && status < 500) return '4xx'
  if (status >= 500) return '5xx'
  return status > 0 ? 'other' : 'network'
}

export const normalizeChatUsage = (value: unknown): UsageMetrics | null => {
  if (!value || typeof value !== 'object') return null
  const usage = (value as { usage?: Record<string, unknown> }).usage
  if (!usage) return null
  const promptTokens = Number(usage.prompt_tokens || 0)
  const completionTokens = Number(usage.completion_tokens || 0)
  const cachedDetails = usage.prompt_tokens_details
  const cachedTokens = cachedDetails && typeof cachedDetails === 'object'
    ? Number((cachedDetails as { cached_tokens?: unknown }).cached_tokens || 0)
    : 0
  return {
    promptTokens,
    completionTokens,
    cachedTokens,
    totalTokens: Number(usage.total_tokens || promptTokens + completionTokens),
  }
}

export const normalizeResponsesUsage = (value: unknown): UsageMetrics | null => {
  if (!value || typeof value !== 'object') return null
  const usage = (value as { usage?: Record<string, unknown> }).usage
  if (!usage) return null
  const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0)
  const completionTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? 0)
  const details = usage.input_tokens_details || usage.prompt_tokens_details
  const cachedTokens = details && typeof details === 'object'
    ? Number((details as { cached_tokens?: unknown }).cached_tokens || 0)
    : 0
  return {
    promptTokens: inputTokens,
    completionTokens,
    cachedTokens,
    totalTokens: Number(usage.total_tokens || inputTokens + completionTokens),
  }
}

export const normalizeAnthropicUsage = (value: unknown): UsageMetrics | null => {
  if (!value || typeof value !== 'object') return null
  const usage = (value as { usage?: Record<string, unknown> }).usage
  if (!usage) return null
  const promptTokens = Number(usage.input_tokens || 0)
  const completionTokens = Number(usage.output_tokens || 0)
  const cachedTokens = Number(usage.cache_read_input_tokens || 0)
  return {
    promptTokens,
    completionTokens,
    cachedTokens,
    totalTokens: promptTokens + completionTokens + cachedTokens,
  }
}

export const summarizeError = (value: unknown): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return (text || '未知错误')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer ***')
    .replace(/sk[-_][A-Za-z0-9_-]{8,}/gi, 'sk_***')
    .replace(/\s+/g, ' ')
    .slice(0, 200)
}