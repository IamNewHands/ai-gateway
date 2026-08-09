import type { Context } from 'hono'
import type { AppEnv, Env } from '../types'
import type { AnalyticsContext, AnalyticsEventOptions, UsageMetrics } from './types'
import { getStatusFamily } from './types'

const EMPTY_USAGE: UsageMetrics = {
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  totalTokens: 0,
}

/** 观察分支行缓冲上限：异常响应出现超长单行时截断，防止内存无界增长（P3/R9） */
const MAX_SSE_BUFFER = 64 * 1024

const getDatasetName = (env: Env): string => {
  const configured = env.USAGE_ANALYTICS_DATASET
  return configured && /^[A-Za-z_][A-Za-z0-9_]*$/.test(configured) ? configured : 'ai_gateway_usage'
}

export const writeAnalyticsEvent = (
  c: Context<AppEnv>,
  options: AnalyticsEventOptions,
): void => {
  const dataset = c.env.USAGE_ANALYTICS
  if (!dataset) return

  const usage = options.usage || EMPTY_USAGE
  const status = options.upstreamStatus || 0
  const context = options.context
  const latencyMs = Math.max(0, Date.now() - context.startedAt)

  try {
    // 只写入最终客户端请求事件，避免内部 Key fallback 把一次请求重复算入总量。
    dataset.writeDataPoint({
      indexes: [context.tokenHash],
      blobs: [
        context.route,
        context.tokenName,
        context.providerId,
        context.providerName,
        context.providerType,
        context.requestedModel,
        context.upstreamModel,
        options.result,
        context.streamMode,
        options.errorCode || '',
        getStatusFamily(status),
        context.requestId,
        context.traceId,
        context.clientIp,
        context.userAgent,
        context.country,
        context.region,
        context.city,
        context.colo,
        (options.errorSummary || '')
          .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer ***')
          .replace(/sk[-_][A-Za-z0-9_-]{8,}/gi, 'sk_***')
          .replace(/\s+/g, ' ')
          .slice(0, 200),
      ],
      doubles: [
        usage.promptTokens,
        usage.completionTokens,
        usage.cachedTokens,
        usage.totalTokens,
        latencyMs,
        context.retryCount,
        status,
        options.result === 'success' ? 1 : 0,
      ],
    })
  } catch (error) {
    // 观测写入失败不能阻断模型代理，否则监控故障会扩大为业务故障。
    console.error(`[analytics] 写入数据集 ${getDatasetName(c.env)} 失败`, error)
  }
}

export const observeStreamUsage = async (
  stream: ReadableStream<Uint8Array>,
  providerType: string,
  onUsage: (usage: UsageMetrics) => void,
): Promise<void> => {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      // 超长单行（异常响应无换行）防止 buffer 无界增长：只保留尾段
      if (buffer.length > MAX_SSE_BUFFER) {
        const lastNl = buffer.lastIndexOf('\n')
        buffer = lastNl >= 0 ? buffer.slice(lastNl + 1) : buffer.slice(-MAX_SSE_BUFFER)
      }
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      for (const line of lines) {
        const raw = line.replace(/^data:\s*/, '').trim()
        if (!raw || raw === '[DONE]') continue
        try {
          const parsed: unknown = JSON.parse(raw)
          const usage = providerType === 'anthropic'
            ? normalizeStreamMessageUsage(parsed)
            : normalizeStreamUsage(parsed)
          if (usage) onUsage(usage)
        } catch {
          // SSE 允许包含非 JSON 注释行，解析失败时跳过而不影响客户端流。
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

const normalizeStreamUsage = (value: unknown): UsageMetrics | null => {
  if (!value || typeof value !== 'object') return null
  const record = value as { usage?: unknown; response?: unknown }
  const usage = record.usage || (record.response && typeof record.response === 'object'
    ? (record.response as { usage?: unknown }).usage
    : undefined)
  if (!usage || typeof usage !== 'object') return null
  const item = usage as Record<string, unknown>
  const promptTokens = Number(item.prompt_tokens ?? item.input_tokens ?? 0)
  const completionTokens = Number(item.completion_tokens ?? item.output_tokens ?? 0)
  const cachedTokens = Number(
    (item.prompt_tokens_details as { cached_tokens?: unknown } | undefined)?.cached_tokens
      ?? (item.input_tokens_details as { cached_tokens?: unknown } | undefined)?.cached_tokens
      ?? 0,
  )
  return {
    promptTokens: promptTokens,
    completionTokens,
    cachedTokens,
    totalTokens: Number(item.total_tokens || promptTokens + completionTokens),
  }
}

const normalizeStreamMessageUsage = (value: unknown): UsageMetrics | null => {
  if (!value || typeof value !== 'object') return null
  const record = value as {
    message?: { usage?: Record<string, unknown> }
    usage?: Record<string, unknown>
  }
  const usage = record.message?.usage || record.usage
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