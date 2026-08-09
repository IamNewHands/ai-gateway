import type { Context } from 'hono'
import type { AppEnv, Env } from '../types'
import { ANALYTICS_BLOBS, ANALYTICS_DOUBLES } from './types'
import type { AnalyticsQueryResult } from './types'

export type AnalyticsRange = '24h' | '7d' | '30d' | '90d'
export type AnalyticsDimension = 'token' | 'channel' | 'model' | 'provider' | 'route'
export type UsageLogDimension = 'route' | 'token' | 'channel' | 'model' | 'provider' | 'requestId' | 'traceId' | 'clientIp' | 'userAgent' | 'country' | 'region' | 'city' | 'colo' | 'result' | 'errorCode' | 'errorSummary'

const RANGE_SQL: Record<AnalyticsRange, { lookback: string; bucket: string }> = {
  '24h': { lookback: "INTERVAL '24' HOUR", bucket: "INTERVAL '1' HOUR" },
  '7d': { lookback: "INTERVAL '7' DAY", bucket: "INTERVAL '1' DAY" },
  '30d': { lookback: "INTERVAL '30' DAY", bucket: "INTERVAL '1' DAY" },
  '90d': { lookback: "INTERVAL '90' DAY", bucket: "INTERVAL '1' DAY" },
}

const DIMENSION_FIELDS: Record<AnalyticsDimension, string> = {
  token: ANALYTICS_BLOBS.tokenName,
  channel: ANALYTICS_BLOBS.providerId,
  model: ANALYTICS_BLOBS.requestedModel,
  provider: ANALYTICS_BLOBS.providerType,
  route: ANALYTICS_BLOBS.route,
}

const FILTER_FIELDS: Record<UsageLogDimension, string> = {
  route: ANALYTICS_BLOBS.route,
  token: ANALYTICS_BLOBS.tokenName,
  channel: ANALYTICS_BLOBS.providerId,
  model: ANALYTICS_BLOBS.requestedModel,
  provider: ANALYTICS_BLOBS.providerType,
  requestId: ANALYTICS_BLOBS.requestId,
  traceId: ANALYTICS_BLOBS.traceId,
  clientIp: ANALYTICS_BLOBS.clientIp,
  userAgent: ANALYTICS_BLOBS.userAgent,
  country: ANALYTICS_BLOBS.country,
  region: ANALYTICS_BLOBS.region,
  city: ANALYTICS_BLOBS.city,
  colo: ANALYTICS_BLOBS.colo,
  result: ANALYTICS_BLOBS.result,
  errorCode: ANALYTICS_BLOBS.errorCode,
  errorSummary: ANALYTICS_BLOBS.errorSummary,
}

const getRange = (value?: string): AnalyticsRange => value && value in RANGE_SQL ? value as AnalyticsRange : '24h'
const getDataset = (env: Env): string => env.USAGE_ANALYTICS_DATASET && /^[A-Za-z_][A-Za-z0-9_]*$/.test(env.USAGE_ANALYTICS_DATASET) ? env.USAGE_ANALYTICS_DATASET : 'ai_gateway_usage'
const escapeSql = (value: string): string => value.replace(/'/g, "''")
// LIKE 通配符转义：用户输入当作字面量，防止注入 %/_ 扩大匹配面。
const escapeLike = (value: string): string => value.replace(/[\\%_]/g, '\\$&')
// Analytics Engine SQL 不支持除零保护函数；与原项目一致直接用采样总量作除数，空结果由响应归一化为 0。
const AVG_LATENCY_SQL = `sum(${ANALYTICS_DOUBLES.latencyMs} * _sample_interval) / sum(_sample_interval)`

export class AnalyticsQueryError extends Error {
  public readonly statusCode: number
  public constructor(message: string, statusCode = 502) {
    super(message)
    this.statusCode = statusCode
  }
}

const queryAnalytics = async (c: Context<AppEnv>, sql: string): Promise<AnalyticsQueryResult> => {
  if (!c.env.CF_ACCOUNT_ID || !c.env.CF_API_TOKEN) {
    throw new AnalyticsQueryError('Analytics Engine 查询凭据未配置，请设置 CF_ACCOUNT_ID 和 CF_API_TOKEN', 503)
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(c.env.CF_ACCOUNT_ID)}/analytics_engine/sql`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${c.env.CF_API_TOKEN}`,
        'Content-Type': 'text/plain;charset=UTF-8',
      },
      body: sql,
      signal: controller.signal,
    })
    if (!response.ok) {
      const text = await response.text()
      throw new AnalyticsQueryError(text || `Analytics Engine 返回 HTTP ${response.status}`, response.status)
    }
    const payload = await response.json() as {
      data?: Array<Record<string, unknown>>
      result?: Array<Record<string, unknown>>
      meta?: Array<{ name?: string; type?: string }>
      errors?: Array<{ message?: string }>
    }
    const data = payload.data || payload.result
    if (!data) {
      throw new AnalyticsQueryError(payload.errors?.[0]?.message || 'Analytics Engine 响应缺少数据', 502)
    }
    return { data, meta: payload.meta }
  } catch (error) {
    if (error instanceof AnalyticsQueryError) throw error
    throw new AnalyticsQueryError(error instanceof Error && error.name === 'AbortError' ? 'Analytics Engine 查询超时' : 'Analytics Engine 查询失败', 504)
  } finally {
    clearTimeout(timeout)
  }
}

export const queryUsageOverview = async (c: Context<AppEnv>, rangeValue?: string): Promise<Record<string, number>> => {
  const range = RANGE_SQL[getRange(rangeValue)]
  const sql = `SELECT sum(_sample_interval) AS requests, sum(${ANALYTICS_DOUBLES.successFlag} * _sample_interval) AS successes, sum(${ANALYTICS_DOUBLES.promptTokens} * _sample_interval) AS prompt_tokens, sum(${ANALYTICS_DOUBLES.completionTokens} * _sample_interval) AS completion_tokens, sum(${ANALYTICS_DOUBLES.cachedTokens} * _sample_interval) AS cached_tokens, sum(${ANALYTICS_DOUBLES.totalTokens} * _sample_interval) AS total_tokens, ${AVG_LATENCY_SQL} AS avg_latency_ms FROM ${getDataset(c.env)} WHERE timestamp >= NOW() - ${range.lookback}`
  const row = (await queryAnalytics(c, sql)).data[0] || {}
  const requests = Number(row.requests || 0)
  const successes = Number(row.successes || 0)
  return { requests, successes, failures: Math.max(0, requests - successes), successRate: requests ? successes / requests * 100 : 0, promptTokens: Number(row.prompt_tokens || 0), completionTokens: Number(row.completion_tokens || 0), cachedTokens: Number(row.cached_tokens || 0), totalTokens: Number(row.total_tokens || 0), avgLatencyMs: Number(row.avg_latency_ms || 0) }
}

export const queryUsageTrend = async (c: Context<AppEnv>, rangeValue?: string): Promise<Array<Record<string, unknown>>> => {
  const range = RANGE_SQL[getRange(rangeValue)]
  const sql = `SELECT toStartOfInterval(timestamp, ${range.bucket}) AS bucket, sum(_sample_interval) AS requests, sum(${ANALYTICS_DOUBLES.successFlag} * _sample_interval) AS successes, sum(${ANALYTICS_DOUBLES.promptTokens} * _sample_interval) AS prompt_tokens, sum(${ANALYTICS_DOUBLES.completionTokens} * _sample_interval) AS completion_tokens, ${AVG_LATENCY_SQL} AS avg_latency_ms FROM ${getDataset(c.env)} WHERE timestamp >= NOW() - ${range.lookback} GROUP BY bucket ORDER BY bucket ASC`
  return (await queryAnalytics(c, sql)).data
}

export const queryUsageBreakdown = async (c: Context<AppEnv>, rangeValue: string | undefined, dimensionValue: string | undefined): Promise<Array<Record<string, unknown>>> => {
  const range = RANGE_SQL[getRange(rangeValue)]
  const dimension = dimensionValue && dimensionValue in DIMENSION_FIELDS ? dimensionValue as AnalyticsDimension : 'model'
  const field = DIMENSION_FIELDS[dimension]
  const identitySelect = dimension === 'channel'
    ? `${field} AS label, ${ANALYTICS_BLOBS.providerName} AS name`
    : `${field} AS label`
  const groupFields = dimension === 'channel' ? `${field}, ${ANALYTICS_BLOBS.providerName}` : field
  const sql = `SELECT ${identitySelect}, sum(_sample_interval) AS requests, sum(${ANALYTICS_DOUBLES.successFlag} * _sample_interval) AS successes, sum(${ANALYTICS_DOUBLES.promptTokens} * _sample_interval) AS prompt_tokens, sum(${ANALYTICS_DOUBLES.completionTokens} * _sample_interval) AS completion_tokens, ${AVG_LATENCY_SQL} AS avg_latency_ms FROM ${getDataset(c.env)} WHERE timestamp >= NOW() - ${range.lookback} GROUP BY ${groupFields} ORDER BY requests DESC LIMIT 12`
  return (await queryAnalytics(c, sql)).data
}

const buildTimeWhere = (start?: string, end?: string): string => {
  const clauses: string[] = []
  if (start) { const date = new Date(start); if (!Number.isNaN(date.getTime())) clauses.push(`timestamp >= toDateTime('${escapeSql(date.toISOString().slice(0, 19).replace('T', ' '))}')`) }
  if (end) { const date = new Date(end); if (!Number.isNaN(date.getTime())) clauses.push(`timestamp < toDateTime('${escapeSql(date.toISOString().slice(0, 19).replace('T', ' '))}')`) }
  return clauses.length ? clauses.join(' AND ') : "timestamp >= NOW() - INTERVAL '24' HOUR"
}

export const queryUsageLogs = async (c: Context<AppEnv>, params: { start?: string; end?: string; dimension?: string; keyword?: string; result?: string; page?: string }): Promise<{ records: Array<Record<string, unknown>>; page: number; pageSize: number }> => {
  const field = params.dimension && params.dimension in FILTER_FIELDS ? FILTER_FIELDS[params.dimension as UsageLogDimension] : ''
  const filters = [buildTimeWhere(params.start, params.end)]
  // P7：关键词走前缀匹配（'kw%'）而非前导通配符（'%kw%'）。
  // 前导通配符无法利用块级 min/max 索引，日志量大时退化为全表扫描；前缀匹配可大幅缩小扫描范围。
  if (field && params.keyword) filters.push(`${field} ILIKE '${escapeSql(escapeLike(params.keyword.slice(0, 100)))}%'`)
  const result = params.result === 'success' || params.result === 'failure' ? params.result : 'all'
  if (result !== 'all') filters.push(`${ANALYTICS_BLOBS.result} = '${result}'`)
  const page = Math.min(1000, Math.max(1, Number(params.page || 1) || 1))
  const sql = `SELECT timestamp, ${Object.values(ANALYTICS_BLOBS).join(', ')}, ${Object.values(ANALYTICS_DOUBLES).join(', ')} FROM ${getDataset(c.env)} WHERE ${filters.join(' AND ')} ORDER BY timestamp DESC LIMIT 50 OFFSET ${(page - 1) * 50}`
  return { records: (await queryAnalytics(c, sql)).data, page, pageSize: 50 }
}