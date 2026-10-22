import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const jobs = vi.hoisted(() => ({
  workbuddy: vi.fn(), trae: vi.fn(), agentrouter: vi.fn(), logs: vi.fn(),
  oauth: vi.fn(), traeRefresh: vi.fn(), clineHealth: vi.fn(),
  cleanup: vi.fn(), m365Health: vi.fn(), dsCleanup: vi.fn(), dsPurge: vi.fn(),
}))

vi.mock('./checkin', async (importOriginal) => ({
  ...await importOriginal<typeof import('./checkin')>(), runAllCheckins: jobs.workbuddy,
}))
vi.mock('./trae/admin', async (importOriginal) => ({
  ...await importOriginal<typeof import('./trae/admin')>(), runTraeCheckins: jobs.trae, refreshTraeTokens: jobs.traeRefresh,
}))
vi.mock('./agentrouter', async (importOriginal) => ({
  ...await importOriginal<typeof import('./agentrouter')>(), runAgentRouterCheckins: jobs.agentrouter,
}))
vi.mock('./admin', async (importOriginal) => ({
  ...await importOriginal<typeof import('./admin')>(), writeLog: jobs.logs,
}))
vi.mock('./oauth', async (importOriginal) => ({
  ...await importOriginal<typeof import('./oauth')>(), refreshAllOauthTokens: jobs.oauth,
}))
vi.mock('./cline/proxy', async (importOriginal) => ({
  ...await importOriginal<typeof import('./cline/proxy')>(), healthCheckClineAll: jobs.clineHealth,
}))
vi.mock('./m365/auto-cleanup', () => ({ autoCleanupAll: jobs.cleanup, healthCheckM365All: jobs.m365Health }))
vi.mock('./deepseek/sessions', async (importOriginal) => ({
  ...await importOriginal<typeof import('./deepseek/sessions')>(), runSessionCleanup: jobs.dsCleanup, runSessionPurge: jobs.dsPurge,
}))

import gateway from './index'
import { clearCache } from './storage'
import type { Env } from './types'

// Scheduled dependencies are mocked; only getProviders' text read reaches this fake.
const env = { KV: { get: async () => '[]' } } as unknown as Env
const ctx: ExecutionContext = {
  waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {}, tracing: {} as Tracing,
}
const event = (cron: string) => ({
  cron, scheduledTime: Date.now(), noRetry: vi.fn(),
  // Workers modules receive a ScheduledController; the legacy handler type includes DOM event fields.
}) as unknown as ScheduledEvent

beforeEach(() => {
  clearCache()
  vi.resetAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  jobs.workbuddy.mockResolvedValue({ total: 0, success: 0, already: 0, fail: 0, skipped: 0, results: [] })
  jobs.trae.mockResolvedValue({ total: 0, ok: 0, already: 0, fail: 0, results: [] })
  jobs.agentrouter.mockResolvedValue({ total: 1, ok: 1, already: 0, fail: 0, skipped: 0, results: [] })
  jobs.oauth.mockResolvedValue({ ok: 0, fail: 0 })
  jobs.traeRefresh.mockResolvedValue({ ok: 0, fail: 0 })
  jobs.clineHealth.mockResolvedValue({ providers: 0, accounts: 0, ok: 0, failed: 0, errors: 0 })
  jobs.cleanup.mockResolvedValue({ total: 0, providers: 0, errors: 0 })
  jobs.m365Health.mockResolvedValue({ providers: 0, accounts: 0, ok: 0, recovered: 0, failed: 0, errors: 0 })
  jobs.dsCleanup.mockResolvedValue({ reason: 'not-due', ran: false, deleted: 0, outcomes: [] })
  jobs.dsPurge.mockResolvedValue({ reason: 'not-due', ran: false, purged: 0, failed: 0 })
})
afterEach(() => { vi.restoreAllMocks() })

describe('AgentRouter default.scheduled integration', () => {
  it.each(['5 2,14 * * *', '0 1,13 * * *'])('runs exactly once for daily cron %s without forcing a second login', async (cron) => {
    await gateway.scheduled(event(cron), env, ctx)
    expect(jobs.agentrouter).toHaveBeenCalledExactlyOnceWith(env)
    expect(jobs.workbuddy).toHaveBeenCalledOnce()
    expect(jobs.trae).toHaveBeenCalledOnce()
    expect(jobs.logs).toHaveBeenCalledWith(env, 'info', '[agentrouter-checkin] cron', expect.any(String))
    expect(jobs.oauth).not.toHaveBeenCalled()
  })

  it.each(['0 */2 * * *', '0 * * * *', '0 20 * * *', '30 15 * * *', '*/5 * * * *'])(
    'does not run AgentRouter on unrelated cron %s', async (cron) => {
      await gateway.scheduled(event(cron), env, ctx)
      expect(jobs.agentrouter).not.toHaveBeenCalled()
    },
  )

  it('still runs AgentRouter after both other check-in families throw', async () => {
    jobs.workbuddy.mockRejectedValueOnce(new Error('workbuddy unavailable'))
    jobs.trae.mockRejectedValueOnce(new Error('trae unavailable'))
    await expect(gateway.scheduled(event('5 2,14 * * *'), env, ctx)).resolves.toBeUndefined()
    expect(jobs.agentrouter).toHaveBeenCalledOnce()
  })

  it('AgentRouter failure does not turn the other daily jobs into failures', async () => {
    jobs.agentrouter.mockRejectedValueOnce(new Error('storage failed'))
    await expect(gateway.scheduled(event('5 2,14 * * *'), env, ctx)).resolves.toBeUndefined()
    expect(jobs.workbuddy).toHaveBeenCalledOnce()
    expect(jobs.trae).toHaveBeenCalledOnce()
    expect(console.error).toHaveBeenCalledWith('[agentrouter-checkin] daily job failed')
  })

  it('records a warning for unconfirmed/failed accounts, and nothing for an empty pool', async () => {
    jobs.agentrouter.mockResolvedValueOnce({ total: 1, ok: 0, already: 0, fail: 1, skipped: 0, results: [] })
    await gateway.scheduled(event('5 2,14 * * *'), env, ctx)
    expect(jobs.logs).toHaveBeenCalledWith(env, 'warn', '[agentrouter-checkin] cron', expect.any(String))
    jobs.logs.mockClear()
    jobs.agentrouter.mockResolvedValueOnce({ total: 0, ok: 0, already: 0, fail: 0, skipped: 0, results: [] })
    await gateway.scheduled(event('5 2,14 * * *'), env, ctx)
    expect(jobs.logs).not.toHaveBeenCalled()
  })
})
