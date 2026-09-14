import type { Provider } from '../types'
import { refreshKukuCredentials, type KukuFetch } from './credentials'

export interface KukuProbeResult {
  ok: boolean
  stage: 'configuration' | 'userreport'
  status?: number
  message: string
  elapsedMs: number
}

export async function probeKukuNetwork(
  provider: Provider,
  fetchImpl: KukuFetch = fetch,
  signal?: AbortSignal,
): Promise<KukuProbeResult> {
  const startedAt = Date.now()
  try {
    await refreshKukuCredentials(provider, fetchImpl, signal)
    return {
      ok: true,
      stage: 'userreport',
      message: 'Worker fetch reached Kuku and refreshed the derived credentials',
      elapsedMs: Date.now() - startedAt,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const statusMatch = message.match(/HTTP (\d{3})/)
    return {
      ok: false,
      stage: message.includes('no enabled Cookie') ? 'configuration' : 'userreport',
      status: statusMatch ? Number(statusMatch[1]) : undefined,
      message,
      elapsedMs: Date.now() - startedAt,
    }
  }
}
