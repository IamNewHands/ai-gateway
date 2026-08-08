import type { Context } from 'hono'
import type { AppEnv, Env, ApiResponse } from '../types'
import { AnalyticsQueryError, queryUsageBreakdown, queryUsageLogs, queryUsageOverview, queryUsageTrend } from './query'

const respondError = (c: Context<AppEnv>, error: unknown): Response => {
  const status = error instanceof AnalyticsQueryError ? error.statusCode : 500
  const message = error instanceof Error ? error.message : 'Analytics 查询失败'
  return c.json<ApiResponse>({ success: false, message }, status as 400 | 401 | 403 | 404 | 500 | 502 | 503 | 504)
}

export const handleAnalyticsOverview = async (c: Context<AppEnv>): Promise<Response> => {
  try { return c.json<ApiResponse>({ success: true, data: await queryUsageOverview(c, c.req.query('range')) }) } catch (error) { return respondError(c, error) }
}

export const handleAnalyticsTrend = async (c: Context<AppEnv>): Promise<Response> => {
  try { return c.json<ApiResponse>({ success: true, data: await queryUsageTrend(c, c.req.query('range')) }) } catch (error) { return respondError(c, error) }
}

export const handleAnalyticsBreakdown = async (c: Context<AppEnv>): Promise<Response> => {
  try { return c.json<ApiResponse>({ success: true, data: await queryUsageBreakdown(c, c.req.query('range'), c.req.query('dimension')) }) } catch (error) { return respondError(c, error) }
}

export const handleUsageLogs = async (c: Context<AppEnv>): Promise<Response> => {
  try {
    return c.json<ApiResponse>({ success: true, data: await queryUsageLogs(c, {
      start: c.req.query('start'),
      end: c.req.query('end'),
      dimension: c.req.query('dimension'),
      keyword: c.req.query('keyword'),
      result: c.req.query('result'),
      page: c.req.query('page'),
    }) })
  } catch (error) { return respondError(c, error) }
}