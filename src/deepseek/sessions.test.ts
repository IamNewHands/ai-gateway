/**
 * deepseek/sessions.test.ts — 会话生命周期后台维护（T5）。
 *
 * 全部离线：假 fetch 顶替 chat.deepseek.com（抽屉是「活的真相」：delete 后真的消失），
 * 内存 KV 顶替持久层；时间与随机数全部注入，于是抖动、补跑窗口、标记去重都能稳定断言。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { Env } from '../types'
import { BizError, DeepseekClient } from './client'
import { writeDeepseekPool, type DeepseekTokenRecord } from './pool'
import { webHeaders } from './proxy'
import {
  DEEPSEEK_CLEANUP_DEFAULT_FLOOR,
  DEEPSEEK_CLEANUP_DEFAULT_INTERVAL_MS,
  DEEPSEEK_CLEANUP_DEFAULT_PROBABILITY,
  DEEPSEEK_CLEANUP_MARKER_KEY,
  DEEPSEEK_MAX_SESSION_PAGES,
  DEEPSEEK_PURGE_MARKER_KEY,
  deepseekSessionCapRegistry,
  enforceSessionCap,
  lastPurgeSlotMs,
  listSessions,
  nextCatchUpDelayMs,
  nextCleanupDelayMs,
  nextPurgeAtMs,
  nextPurgeJitterMs,
  nextPurgeSlotMs,
  parseDurationMs,
  purgeCatchUpNeeded,
  resetDeepseekSessionCapRegistryForTest,
  resolveCleanupConfig,
  resolvePurgeConfig,
  resolveSessionCap,
  runSessionCleanup,
  runSessionPurge,
  selectCleanupVictims,
  type DeepseekSessionInfo,
} from './sessions'

// ===== 测试替身 =====

function mockKV() {
  const map = new Map<string, string>()
  return {
    map,
    get: async (k: string) => map.get(k) ?? null,
    put: async (k: string, v: string) => {
      map.set(k, v)
    },
  }
}

const mockEnv = (kv: ReturnType<typeof mockKV>) => ({ KV: kv } as unknown as Env)

const rec = (id: string, state: DeepseekTokenRecord['state'] = 'ready'): DeepseekTokenRecord => ({
  id,
  token: `tok-${id}`,
  headerDeviceId: `dev-${id}`,
  userAgent: 'UA',
  state,
  addedAt: 1,
})

const envelope = (bizData: unknown, bizCode = 0, code = 0) =>
  JSON.stringify({ code, msg: '', data: { biz_code: bizCode, biz_msg: '', biz_data: bizData } })
const json = (body: string) => new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })

interface FakeSession {
  id: string
  pinned: boolean
  updatedAt: number
}

interface FakeUpstreamInit {
  /** 旧 → 新（与上游真实抽屉相反，抽屉返回时反转为新 → 旧）。 */
  sessions?: FakeSession[]
  pageSize?: number
  /** delete_all 回 biz 5（禁言）。 */
  failDeleteAll?: boolean
  /** 这些 token 的 fetch_page 回非 JSON 500。 */
  failListTokens?: string[]
  /** 这些 token 的 fetch_page 回 code 40003（鉴权失效）。 */
  authFailTokens?: string[]
  /** 永远 has_more=true（测分页上限）。 */
  alwaysHasMore?: boolean
}

/** 假上游：fetch_page 游标抽屉 + delete / delete_all 记账。 */
function fakeUpstream(init: FakeUpstreamInit = {}) {
  const live = [...(init.sessions ?? [])]
  const state = {
    pageQueries: [] as string[],
    listCalls: 0,
    deleted: [] as string[],
    deleteAllCalls: 0,
  }
  const fetch = async (input: string, init2: RequestInit): Promise<Response> => {
    const url = new URL(input)
    const headers = (init2.headers ?? {}) as Record<string, string>
    const token = String(headers.Authorization ?? '').replace('Bearer ', '')

    if (url.pathname === '/api/v0/chat_session/fetch_page') {
      state.listCalls++
      if (!token) throw new Error('fake upstream: fetch_page without token')
      if (init.authFailTokens?.includes(token)) return json(envelope(null, 0, 40003))
      if (init.failListTokens?.includes(token)) return new Response('upstream down', { status: 500 })
      state.pageQueries.push(url.search)
      if (init.alwaysHasMore) {
        // 永远 has_more 且每页同一条（Go 的 bounded-walk 测试同形）
        const one = [...live].reverse().slice(0, 1)
        return json(envelope({ chat_sessions: one.map((s) => ({ id: s.id, pinned: s.pinned, updated_at: s.updatedAt })), has_more: true }))
      }
      const hasCursor = url.searchParams.has('lte_cursor.pinned')
      const olderThan = hasCursor ? Number(url.searchParams.get('lte_cursor.updated_at')) : -1
      // 抽屉新 → 旧，游标只返回严格更老的会话。
      let page = [...live].reverse().filter((s) => (olderThan < 0 ? true : s.updatedAt < olderThan))
      const size = init.pageSize ?? 100
      const hasMore = page.length > size
      page = page.slice(0, size)
      return json(
        envelope({
          chat_sessions: page.map((s) => ({ id: s.id, pinned: s.pinned, updated_at: s.updatedAt })),
          has_more: hasMore,
        }),
      )
    }

    if (url.pathname === '/api/v0/chat_session/delete') {
      const body = JSON.parse(String(init2.body)) as { chat_session_id: string }
      state.deleted.push(body.chat_session_id)
      const idx = live.findIndex((s) => s.id === body.chat_session_id)
      if (idx >= 0) live.splice(idx, 1)
      return json(envelope(null))
    }

    if (url.pathname === '/api/v0/chat_session/delete_all') {
      state.deleteAllCalls++
      if (init.failDeleteAll) return json(envelope({ mute_until: null }, 5))
      live.length = 0
      return json(envelope(null))
    }

    throw new Error(`fake upstream: unexpected call ${url.pathname}`)
  }
  return { state, live, fetch }
}

/** 顺序取用的随机数（用尽后返回 0）。 */
function seqRandom(values: number[]): () => number {
  let i = 0
  return () => (i < values.length ? values[i++] : 0)
}

function recordingSleep() {
  const sleeps: number[] = []
  return { sleeps, sleep: async (ms: number) => void sleeps.push(ms) }
}

function logSink() {
  const lines: string[] = []
  return { lines, log: (m: string) => void lines.push(m) }
}

const sess = (id: string, updatedAt: number, pinned = false): FakeSession => ({ id, pinned, updatedAt })

/** 8 条未置顶会话：o1 最老（updatedAt 100）… o8 最新。 */
const eightOldestFirst = (): FakeSession[] => Array.from({ length: 8 }, (_, i) => sess(`o${i + 1}`, 100 * (i + 1)))

beforeEach(() => {
  resetDeepseekSessionCapRegistryForTest()
  deepseekSessionCapRegistry.clear()
})

// ===== 配置解析 =====

describe('env 配置（DS_* → DEEPSEEK_*）', () => {
  it('parseDurationMs 支持 90m / 3600（秒）/ 1h30m / 1.5h / 0，非法返回 null', () => {
    expect(parseDurationMs('90m')).toBe(90 * 60 * 1000)
    expect(parseDurationMs('3600')).toBe(3600 * 1000)
    expect(parseDurationMs('1h30m')).toBe(90 * 60 * 1000)
    expect(parseDurationMs('1.5h')).toBe(90 * 60 * 1000)
    expect(parseDurationMs('500ms')).toBe(500)
    expect(parseDurationMs('0')).toBe(0)
    expect(parseDurationMs('abc')).toBeNull()
    expect(parseDurationMs('10x')).toBeNull()
    expect(parseDurationMs('')).toBeNull()
  })

  it('清理配置默认值 = 1h / floor 5 / p 0.5 / gap 1–6s', () => {
    const cfg = resolveCleanupConfig(mockEnv(mockKV()))
    expect(cfg).toMatchObject({
      intervalMs: DEEPSEEK_CLEANUP_DEFAULT_INTERVAL_MS,
      floor: DEEPSEEK_CLEANUP_DEFAULT_FLOOR,
      probability: DEEPSEEK_CLEANUP_DEFAULT_PROBABILITY,
      gapMinMs: 1000,
      gapMaxMs: 6000,
    })
  })

  it('DEEPSEEK_CLEANUP_INTERVAL: 90m / 0（关闭）/ 非法→默认+warn', () => {
    const env = mockEnv(mockKV()) as unknown as Record<string, unknown>
    env.DEEPSEEK_CLEANUP_INTERVAL = '90m'
    expect(resolveCleanupConfig(env as unknown as Env).intervalMs).toBe(5400000)

    env.DEEPSEEK_CLEANUP_INTERVAL = '3600'
    expect(resolveCleanupConfig(env as unknown as Env).intervalMs).toBe(3600000)

    env.DEEPSEEK_CLEANUP_INTERVAL = '0'
    expect(resolveCleanupConfig(env as unknown as Env).intervalMs).toBe(0)

    env.DEEPSEEK_CLEANUP_INTERVAL = 'nonsense'
    const sink = logSink()
    expect(resolveCleanupConfig(env as unknown as Env, { log: sink.log }).intervalMs).toBe(DEEPSEEK_CLEANUP_DEFAULT_INTERVAL_MS)
    expect(sink.lines.join('\n')).toContain('DEEPSEEK_CLEANUP_INTERVAL')
  })

  it('DEEPSEEK_CLEANUP_FLOOR: 3 → 3；0/非法 → 默认 5', () => {
    const env = mockEnv(mockKV()) as unknown as Record<string, unknown>
    env.DEEPSEEK_CLEANUP_FLOOR = '3'
    expect(resolveCleanupConfig(env as unknown as Env).floor).toBe(3)
    env.DEEPSEEK_CLEANUP_FLOOR = '0'
    expect(resolveCleanupConfig(env as unknown as Env).floor).toBe(DEEPSEEK_CLEANUP_DEFAULT_FLOOR)
    env.DEEPSEEK_CLEANUP_FLOOR = 'many'
    expect(resolveCleanupConfig(env as unknown as Env, { log: () => undefined }).floor).toBe(DEEPSEEK_CLEANUP_DEFAULT_FLOOR)
  })

  it('显式 opts 覆盖 env', () => {
    const env = mockEnv(mockKV()) as unknown as Record<string, unknown>
    env.DEEPSEEK_CLEANUP_INTERVAL = '90m'
    env.DEEPSEEK_CLEANUP_FLOOR = '9'
    const cfg = resolveCleanupConfig(env as unknown as Env, { intervalMs: 60000, floor: 2, probability: 1, gapMinMs: 1, gapMaxMs: 2 })
    expect(cfg).toMatchObject({ intervalMs: 60000, floor: 2, probability: 1, gapMinMs: 1, gapMaxMs: 2 })
  })

  it('清空配置默认 = 周日 04:00 ±30m；DEEPSEEK_PURGE=0 / WEEKDAY=-1 关闭', () => {
    const defaulted = resolvePurgeConfig(mockEnv(mockKV()))
    expect(defaulted).toMatchObject({ weekday: 6, hour: 4, jitterMs: 30 * 60 * 1000, utcOffsetMinutes: 0 })

    const env = mockEnv(mockKV()) as unknown as Record<string, unknown>
    env.DEEPSEEK_PURGE = '0'
    expect(resolvePurgeConfig(env as unknown as Env).weekday).toBe(-1)

    env.DEEPSEEK_PURGE = '1'
    env.DEEPSEEK_PURGE_WEEKDAY = '3'
    env.DEEPSEEK_PURGE_HOUR = '7'
    expect(resolvePurgeConfig(env as unknown as Env)).toMatchObject({ weekday: 3, hour: 7 })

    env.DEEPSEEK_PURGE_WEEKDAY = '-1'
    expect(resolvePurgeConfig(env as unknown as Env).weekday).toBe(-1)

    env.DEEPSEEK_PURGE_WEEKDAY = '9'
    env.DEEPSEEK_PURGE_HOUR = '99'
    const sink = logSink()
    expect(resolvePurgeConfig(env as unknown as Env, { log: sink.log })).toMatchObject({ weekday: 6, hour: 4 })
    expect(sink.lines.join('\n')).toContain('DEEPSEEK_PURGE_WEEKDAY')
    expect(sink.lines.join('\n')).toContain('DEEPSEEK_PURGE_HOUR')
  })

  it('DEEPSEEK_SESSION_CAP: 未设/0 = 关闭；正整数 = 上限；非法 = 关闭 + warn', () => {
    const env = mockEnv(mockKV()) as unknown as Record<string, unknown>
    expect(resolveSessionCap(env as unknown as Env)).toBe(0)
    env.DEEPSEEK_SESSION_CAP = '3'
    expect(resolveSessionCap(env as unknown as Env)).toBe(3)
    env.DEEPSEEK_SESSION_CAP = '0'
    expect(resolveSessionCap(env as unknown as Env)).toBe(0)
    env.DEEPSEEK_SESSION_CAP = '-1'
    const sink = logSink()
    expect(resolveSessionCap(env as unknown as Env, sink.log)).toBe(0)
    expect(sink.lines.join('\n')).toContain('DEEPSEEK_SESSION_CAP')
  })
})

// ===== 时间计算 =====

describe('抖动与每周窗口（now/random 全注入）', () => {
  it('nextCleanupDelayMs 落在 [base/2, base*1.5]，且随随机数变化', () => {
    const base = 3600_000
    const seen = new Set<number>()
    for (let i = 0; i < 64; i++) {
      const r = i / 64
      const d = nextCleanupDelayMs(base, () => r)
      expect(d).toBeGreaterThanOrEqual(base / 2)
      expect(d).toBeLessThanOrEqual(base * 1.5)
      seen.add(d)
    }
    expect(seen.size).toBeGreaterThan(8)
    expect(nextCleanupDelayMs(base, () => 0)).toBe(base / 2)
  })

  it('nextPurgeJitterMs 落在 ±jitter', () => {
    const j = 30 * 60 * 1000
    expect(nextPurgeJitterMs(j, () => 0)).toBe(-j)
    for (const r of [0.25, 0.5, 0.75, 0.999]) {
      const v = nextPurgeJitterMs(j, () => r)
      expect(v).toBeGreaterThanOrEqual(-j)
      expect(v).toBeLessThanOrEqual(j)
    }
    expect(nextPurgeJitterMs(0, () => 0)).toBe(0)
  })

  it('nextPurgeSlotMs: 周日 04:00，跨周界正确', () => {
    const cfg = { weekday: 6, hour: 4, jitterMs: 0, utcOffsetMinutes: 0 }
    const sunday4 = Date.UTC(2026, 8, 20, 4, 0, 0)
    // 周三 12:00 → 本周日 04:00
    expect(nextPurgeSlotMs(Date.UTC(2026, 8, 16, 12), cfg)).toBe(sunday4)
    // 周日 01:00 → 当天 04:00
    expect(nextPurgeSlotMs(Date.UTC(2026, 8, 20, 1), cfg)).toBe(sunday4)
    // 周日 07:00 → 下周日
    expect(nextPurgeSlotMs(Date.UTC(2026, 8, 20, 7), cfg)).toBe(Date.UTC(2026, 8, 27, 4))
    // 正好 04:00 → 下一周（严格 > now）
    expect(nextPurgeSlotMs(sunday4, cfg)).toBe(Date.UTC(2026, 8, 27, 4))
    // 跨年：2026-12-31（周四）→ 2027-01-03（周日）
    expect(nextPurgeSlotMs(Date.UTC(2026, 11, 31, 12), cfg)).toBe(Date.UTC(2027, 0, 3, 4))
  })

  it('lastPurgeSlotMs: 最近一个 ≤ now 的窗口', () => {
    const cfg = { weekday: 6, hour: 4, jitterMs: 0, utcOffsetMinutes: 0 }
    expect(lastPurgeSlotMs(Date.UTC(2026, 8, 20, 12), cfg)).toBe(Date.UTC(2026, 8, 20, 4))
    expect(lastPurgeSlotMs(Date.UTC(2026, 8, 20, 3), cfg)).toBe(Date.UTC(2026, 8, 13, 4))
    expect(lastPurgeSlotMs(Date.UTC(2026, 8, 21, 10), cfg)).toBe(Date.UTC(2026, 8, 20, 4))
  })

  it('nextPurgeAtMs: 严格 > now、落在窗口 ±30m、且确实抖动', () => {
    const cfg = { weekday: 6, hour: 4, jitterMs: 30 * 60 * 1000, utcOffsetMinutes: 0 }
    const now = Date.UTC(2026, 8, 16, 12)
    const slot = Date.UTC(2026, 8, 20, 4)
    const seen = new Set<number>()
    for (let i = 0; i < 32; i++) {
      const at = nextPurgeAtMs(now, cfg, () => i / 32)
      expect(at).toBeGreaterThan(now)
      expect(Math.abs(at - slot)).toBeLessThanOrEqual(30 * 60 * 1000)
      seen.add(at)
    }
    expect(seen.size).toBeGreaterThan(8)
    // random()=0 → 窗口 - 30m
    expect(nextPurgeAtMs(now, cfg, () => 0)).toBe(slot - 30 * 60 * 1000)
  })

  it('utcOffsetMinutes 让窗口按指定时区落地（北京 +480）', () => {
    const cfg = { weekday: 6, hour: 4, jitterMs: 0, utcOffsetMinutes: 480 }
    // 北京周日 04:00 = UTC 周六 20:00
    expect(nextPurgeSlotMs(Date.UTC(2026, 8, 16, 12), cfg)).toBe(Date.UTC(2026, 8, 19, 20))
  })

  it('purgeCatchUpNeeded: 24h 内错过的窗口要补，且已被记录过的窗口不再补', () => {
    const cfg = { weekday: 6, hour: 4, jitterMs: 0, utcOffsetMinutes: 0, catchUpWindowMs: 24 * 3600 * 1000 }
    const sundayNoon = Date.UTC(2026, 8, 20, 12)
    expect(purgeCatchUpNeeded(sundayNoon, cfg, null)).toBe(true)
    // 这个窗口已经跑过 → 不补
    expect(purgeCatchUpNeeded(sundayNoon, cfg, Date.UTC(2026, 8, 20, 5))).toBe(false)
    // 窗口还没到 → 不补
    expect(purgeCatchUpNeeded(Date.UTC(2026, 8, 20, 3), cfg, null)).toBe(false)
    // 超过 24h → 交给上一个实例
    expect(purgeCatchUpNeeded(Date.UTC(2026, 8, 21, 10), cfg, null)).toBe(false)
    // 关闭 → 永不补
    expect(purgeCatchUpNeeded(sundayNoon, { ...cfg, weekday: -1 }, null)).toBe(false)
  })

  it('nextCatchUpDelayMs: 落在配置区间且非 0（不会一启动就打）', () => {
    const cfg = { catchUpDelayMinMs: 2000, catchUpDelayMaxMs: 12000 }
    const seen = new Set<number>()
    for (let i = 0; i < 32; i++) {
      const d = nextCatchUpDelayMs(cfg, () => i / 32)
      expect(d).toBeGreaterThanOrEqual(2000)
      expect(d).toBeLessThanOrEqual(12000)
      seen.add(d)
    }
    expect(seen.size).toBeGreaterThan(8)
    expect(nextCatchUpDelayMs({ catchUpDelayMinMs: 1, catchUpDelayMaxMs: 2 }, () => 0)).toBe(1)
    expect(nextCatchUpDelayMs({ catchUpDelayMinMs: 5, catchUpDelayMaxMs: 1 }, () => 0)).toBe(5)
  })
})

// ===== listSessions =====

describe('listSessions（fetch_page 抽屉）', () => {
  const clientFor = (up: ReturnType<typeof fakeUpstream>) =>
    new DeepseekClient({
      account: { password: '' },
      fetch: up.fetch,
      wire: { replaceHeaders: true, headers: webHeaders(rec('a')) },
    })

  it('单页：保持新 → 旧顺序，pinned 解析正确，首页无参数', async () => {
    const up = fakeUpstream({
      sessions: [sess('old', 100), sess('mid', 200, true), sess('new', 300)],
    })
    const sessions = await listSessions(clientFor(up), 'tok-a')
    expect(sessions.map((s) => s.id)).toEqual(['new', 'mid', 'old'])
    expect(sessions[1].pinned).toBe(true)
    expect(up.state.pageQueries).toEqual([''])
  })

  it('多页：游标带上页最老条目的 (pinned, updated_at)，全部收集', async () => {
    const up = fakeUpstream({ sessions: eightOldestFirst().slice(3), pageSize: 2 }) // o4..o8
    const sessions = await listSessions(clientFor(up), 'tok-a')
    expect(sessions.map((s) => s.id)).toEqual(['o8', 'o7', 'o6', 'o5', 'o4'])
    expect(up.state.pageQueries.length).toBe(3)
    expect(up.state.pageQueries[0]).toBe('')
    expect(decodeURIComponent(up.state.pageQueries[1])).toContain('lte_cursor.pinned=false&lte_cursor.updated_at=700')
    expect(decodeURIComponent(up.state.pageQueries[2])).toContain('lte_cursor.updated_at=500')
  })

  it('上游一直说 has_more 时，走查被 50 页上限截断', async () => {
    const up = fakeUpstream({ sessions: [sess('s', 1)], alwaysHasMore: true })
    const sessions = await listSessions(clientFor(up), 'tok-a')
    expect(up.state.listCalls).toBe(DEEPSEEK_MAX_SESSION_PAGES)
    expect(sessions.length).toBe(DEEPSEEK_MAX_SESSION_PAGES)
  })

  it('字段容错：chat_session_id / is_pinned / 字符串 updated_at、以及 biz_data 直接是数组', async () => {
    const tolerant = new DeepseekClient({
      account: { password: '' },
      fetch: async () =>
        json(
          envelope({
            sessions: [
              { chat_session_id: 'a', is_pinned: true, updated_at: '123' },
              'garbage',
              { id: '' },
              { session_id: 'b', pinned: 0, update_time: 456 },
            ],
            has_more: false,
          }),
        ),
      wire: { replaceHeaders: true, headers: webHeaders(rec('a')) },
    })
    expect(await listSessions(tolerant, 'tok-a')).toEqual([
      { id: 'a', pinned: true, updatedAt: 123 },
      { id: 'b', pinned: false, updatedAt: 456 },
    ])

    const nested = new DeepseekClient({
      account: { password: '' },
      fetch: async () => json(envelope({ data: { chat_sessions: [{ id: 'x', pinned: false, updated_at: 1 }] } })),
      wire: { replaceHeaders: true, headers: webHeaders(rec('a')) },
    })
    expect(await listSessions(nested, 'tok-a')).toEqual([{ id: 'x', pinned: false, updatedAt: 1 }])

    const bareArray = new DeepseekClient({
      account: { password: '' },
      fetch: async () => json(envelope([{ id: 'y', pinned: true, updated_at: 2 }])),
      wire: { replaceHeaders: true, headers: webHeaders(rec('a')) },
    })
    expect(await listSessions(bareArray, 'tok-a')).toEqual([{ id: 'y', pinned: true, updatedAt: 2 }])
  })

  it('biz_data 是 null → 空列表（不是错误）；是标量 → 报错', async () => {
    const nullPage = new DeepseekClient({
      account: { password: '' },
      fetch: async () => json(envelope(null)),
      wire: { replaceHeaders: true, headers: webHeaders(rec('a')) },
    })
    expect(await listSessions(nullPage, 'tok-a')).toEqual([])

    const scalar = new DeepseekClient({
      account: { password: '' },
      fetch: async () => json(envelope('not an object')),
      wire: { replaceHeaders: true, headers: webHeaders(rec('a')) },
    })
    await expect(listSessions(scalar, 'tok-a')).rejects.toThrow(/bad fetch_page biz_data/)
  })

  it('上游业务错误（biz 5 禁言）原样抛出 BizError', async () => {
    const muted = new DeepseekClient({
      account: { password: '' },
      fetch: async () => json(envelope(null, 5)),
      wire: { replaceHeaders: true, headers: webHeaders(rec('a')) },
    })
    await expect(listSessions(muted, 'tok-a')).rejects.toBeInstanceOf(BizError)
  })
})

// ===== 选受害者 =====

describe('selectCleanupVictims', () => {
  const list = (): DeepseekSessionInfo[] => [
    { id: 'n3', pinned: false, updatedAt: 300 },
    { id: 'n2', pinned: false, updatedAt: 200 },
    { id: 'pin', pinned: true, updatedAt: 150 },
    { id: 'n1', pinned: false, updatedAt: 100 },
  ]

  it('未置顶数 ≤ floor → 不删', () => {
    expect(selectCleanupVictims(list(), 3, 3)).toEqual([])
    expect(selectCleanupVictims(list(), 5, 3)).toEqual([])
  })

  it('只从最老的超额部分里选，置顶永不入选', () => {
    const victims = selectCleanupVictims(list(), 1, 3)
    expect(victims.map((s) => s.id)).toEqual(['n1', 'n2'])
  })
})

// ===== 人类节奏清理 =====

describe('runSessionCleanup', () => {
  it('删除数量在 1–3 之间，且只删最老的未置顶会话', async () => {
    const up = fakeUpstream({ sessions: eightOldestFirst() })
    const { sleeps, sleep } = recordingSleep()
    const res = await runSessionCleanup(mockEnv(mockKV()), {
      tokens: [rec('a')],
      fetch: up.fetch,
      schedule: false,
      probability: 1,
      random: seqRandom([0, 0.99, 0.5, 0.5]), // 唤醒抖动 / batch=3 / 两个删除间隔
      sleep,
    })
    expect(res.ran).toBe(true)
    expect(res.outcomes[0].deleted).toEqual(['o1', 'o2', 'o3'])
    expect(res.outcomes[0].remaining).toBe(5)
    expect(res.deleted).toBe(3)
    expect(sleeps.length).toBe(2)
  })

  it('random()=0 时一次只删最老的一个', async () => {
    const up = fakeUpstream({ sessions: eightOldestFirst() })
    const res = await runSessionCleanup(mockEnv(mockKV()), {
      tokens: [rec('a')],
      fetch: up.fetch,
      schedule: false,
      probability: 1,
      random: () => 0,
    })
    expect(up.state.deleted).toEqual(['o1'])
    expect(res.outcomes[0]).toMatchObject({ listed: true, remaining: 7 })
  })

  it('未置顶数 ≤ floor（默认 5）时一个都不删', async () => {
    const up = fakeUpstream({ sessions: eightOldestFirst().slice(0, 5) })
    const res = await runSessionCleanup(mockEnv(mockKV()), {
      tokens: [rec('a')],
      fetch: up.fetch,
      schedule: false,
      probability: 1,
      random: () => 0,
    })
    expect(up.state.deleted).toEqual([])
    expect(res.outcomes[0]).toMatchObject({ listed: true, deleted: [] })
  })

  it('置顶会话永不被清理', async () => {
    // o1/o2 置顶（最老），floor 5 → 只能动未置顶的最老者 o3
    const sessions = eightOldestFirst().map((s) => (s.id === 'o1' || s.id === 'o2' ? { ...s, pinned: true } : s))
    const up = fakeUpstream({ sessions })
    const res = await runSessionCleanup(mockEnv(mockKV()), {
      tokens: [rec('a')],
      fetch: up.fetch,
      schedule: false,
      probability: 1,
      random: () => 0,
    })
    expect(res.outcomes[0].deleted).toEqual(['o3'])
    expect(up.state.deleted.some((id) => id === 'o1' || id === 'o2')).toBe(false)
  })

  it('概率掷骰：p=0.5 时随机数 ≥ 0.5 就跳过该 token', async () => {
    const up = fakeUpstream({ sessions: eightOldestFirst() })
    const res = await runSessionCleanup(mockEnv(mockKV()), {
      tokens: [rec('a')],
      fetch: up.fetch,
      schedule: false,
      probability: 0.5,
      random: seqRandom([0, 0.9]), // 唤醒抖动 / episode 掷骰
    })
    expect(res.outcomes[0].skipped).toBe(true)
    expect(up.state.listCalls).toBe(0)

    const up2 = fakeUpstream({ sessions: eightOldestFirst() })
    const res2 = await runSessionCleanup(mockEnv(mockKV()), {
      tokens: [rec('a')],
      fetch: up2.fetch,
      schedule: false,
      probability: 0.5,
      random: seqRandom([0, 0.4, 0]),
    })
    expect(res2.outcomes[0].skipped).toBe(false)
    expect(res2.deleted).toBe(1)
  })

  it('删除之间有 1–6s 抖动间隔（sleep 可注入）', async () => {
    const up = fakeUpstream({ sessions: eightOldestFirst() })
    const { sleeps, sleep } = recordingSleep()
    await runSessionCleanup(mockEnv(mockKV()), {
      tokens: [rec('a')],
      fetch: up.fetch,
      schedule: false,
      probability: 1,
      random: seqRandom([0, 0.99, 0.5, 0.99]), // 3 个删除 → 2 个间隔
      sleep,
    })
    expect(sleeps.length).toBe(2)
    for (const ms of sleeps) {
      expect(ms).toBeGreaterThanOrEqual(1000)
      expect(ms).toBeLessThanOrEqual(6000)
    }
  })

  it('一个账号列会话失败不影响其他账号（只记日志）', async () => {
    const up = fakeUpstream({ sessions: eightOldestFirst(), failListTokens: ['tok-bad'] })
    const sink = logSink()
    const res = await runSessionCleanup(mockEnv(mockKV()), {
      tokens: [rec('bad'), rec('good')],
      fetch: up.fetch,
      schedule: false,
      probability: 1,
      random: () => 0,
      log: sink.log,
    })
    const bad = res.outcomes.find((o) => o.tokenId === 'bad')!
    const good = res.outcomes.find((o) => o.tokenId === 'good')!
    expect(bad.error).toBeTruthy()
    expect(bad.deleted).toEqual([])
    expect(good.deleted.length).toBe(1)
    expect(sink.lines.join('\n')).toContain('session list failed')
  })

  it('鉴权失效：标记该 token 为 expired，其他 token 照常清理', async () => {
    const kv = mockKV()
    const env = mockEnv(kv)
    await writeDeepseekPool(env, [rec('dead'), rec('good')])
    const up = fakeUpstream({ sessions: eightOldestFirst(), authFailTokens: ['tok-dead'] })
    const res = await runSessionCleanup(env, {
      fetch: up.fetch,
      schedule: false,
      probability: 1,
      random: () => 0,
    })
    expect(res.outcomes.find((o) => o.tokenId === 'dead')!.error).toBeTruthy()
    expect(res.outcomes.find((o) => o.tokenId === 'good')!.deleted.length).toBe(1)
    const pool = JSON.parse(kv.map.get('deepseek:pool')!) as { tokens: DeepseekTokenRecord[] }
    expect(pool.tokens.find((t) => t.id === 'dead')!.state).toBe('expired')
    expect(pool.tokens.find((t) => t.id === 'good')!.state).toBe('ready')
  })

  it('token 状态不是 ready 的直接跳过', async () => {
    const up = fakeUpstream({ sessions: eightOldestFirst() })
    const res = await runSessionCleanup(mockEnv(mockKV()), {
      tokens: [rec('a', 'expired')],
      fetch: up.fetch,
      schedule: false,
      probability: 1,
      random: () => 0,
    })
    expect(res.outcomes).toEqual([])
    expect(up.state.listCalls).toBe(0)
  })

  it('interval=0（DEEPSEEK_CLEANUP_INTERVAL=0）→ 关闭，不发起任何请求', async () => {
    const env = mockEnv(mockKV()) as unknown as Record<string, unknown>
    env.DEEPSEEK_CLEANUP_INTERVAL = '0'
    const up = fakeUpstream({ sessions: eightOldestFirst() })
    const res = await runSessionCleanup(env as unknown as Env, { tokens: [rec('a')], fetch: up.fetch })
    expect(res).toMatchObject({ enabled: false, ran: false, reason: 'disabled', nextFireAt: null })
    expect(up.state.listCalls).toBe(0)
  })

  it('空池是合法状态：跑完但没有任何 outcome', async () => {
    const res = await runSessionCleanup(mockEnv(mockKV()), { tokens: [], schedule: false })
    expect(res).toMatchObject({ enabled: true, ran: true, reason: 'ran' })
    expect(res.outcomes).toEqual([])
  })

  it('抖动唤醒写进 KV：未到期直接 not-due，到期后再跑', async () => {
    const kv = mockKV()
    const env = mockEnv(kv)
    const up = fakeUpstream({ sessions: eightOldestFirst().slice(0, 3) }) // ≤ floor，不会删
    let now = Date.UTC(2026, 8, 16, 0)
    const base = { tokens: [rec('a')], fetch: up.fetch, now: () => now, random: () => 0 }

    const first = await runSessionCleanup(env, base)
    expect(first.ran).toBe(true)
    expect(first.nextFireAt).toBe(now + DEEPSEEK_CLEANUP_DEFAULT_INTERVAL_MS / 2) // base/2（±50% 下界）
    expect(Number(kv.map.get(DEEPSEEK_CLEANUP_MARKER_KEY))).toBe(first.nextFireAt)
    expect(up.state.listCalls).toBe(1)

    now = first.nextFireAt! - 1
    const early = await runSessionCleanup(env, base)
    expect(early).toMatchObject({ ran: false, reason: 'not-due', nextFireAt: first.nextFireAt })
    expect(up.state.listCalls).toBe(1) // 没有上游请求

    now = first.nextFireAt!
    const third = await runSessionCleanup(env, base)
    expect(third.ran).toBe(true)
    expect(up.state.listCalls).toBe(2)

    // force 绕过标记
    now = third.nextFireAt! - 1
    const forced = await runSessionCleanup(env, { ...base, force: true })
    expect(forced.ran).toBe(true)
    expect(up.state.listCalls).toBe(3)
  })

  it('默认从 KV 池读 token（无 opts.tokens 时）', async () => {
    const kv = mockKV()
    const env = mockEnv(kv)
    await writeDeepseekPool(env, [rec('a')])
    const up = fakeUpstream({ sessions: eightOldestFirst() })
    const res = await runSessionCleanup(env, { fetch: up.fetch, schedule: false, probability: 1, random: () => 0 })
    expect(res.outcomes.map((o) => o.tokenId)).toEqual(['a'])
    expect(up.state.deleted).toEqual(['o1'])
  })
})

// ===== 每周清空 =====

describe('runSessionPurge', () => {
  const sundayNoon = Date.UTC(2026, 8, 20, 12)

  it('force：每个健康 token 一次 delete_all，记录 before → after', async () => {
    const kv = mockKV()
    const env = mockEnv(kv)
    const up = fakeUpstream({ sessions: eightOldestFirst() })
    const sink = logSink()
    const res = await runSessionPurge(env, {
      tokens: [rec('a')],
      fetch: up.fetch,
      force: true,
      now: () => sundayNoon,
      random: () => 0,
      log: sink.log,
    })
    expect(res).toMatchObject({ enabled: true, ran: true, reason: 'ran', purged: 1, failed: 0 })
    expect(up.state.deleteAllCalls).toBe(1)
    expect(res.outcomes[0]).toMatchObject({ before: 8, after: 0, ok: true })
    expect(sink.lines.join('\n')).toContain('cleared (8 → 0 sessions)')
    expect(Number(kv.map.get(DEEPSEEK_PURGE_MARKER_KEY))).toBe(sundayNoon)
  })

  it('多个 token 各清一次；失效 token 跳过', async () => {
    const up = fakeUpstream({ sessions: eightOldestFirst() })
    const res = await runSessionPurge(mockEnv(mockKV()), {
      tokens: [rec('a'), rec('b'), rec('c', 'expired')],
      fetch: up.fetch,
      force: true,
      now: () => sundayNoon,
      random: () => 0,
    })
    expect(res.purged).toBe(2)
    expect(up.state.deleteAllCalls).toBe(2)
  })

  it('失败（biz 5 禁言）只打一次，不风暴重试，并记日志', async () => {
    const up = fakeUpstream({ sessions: eightOldestFirst(), failDeleteAll: true })
    const sink = logSink()
    const res = await runSessionPurge(mockEnv(mockKV()), {
      tokens: [rec('a')],
      fetch: up.fetch,
      force: true,
      now: () => sundayNoon,
      random: () => 0,
      log: sink.log,
    })
    expect(up.state.deleteAllCalls).toBe(1)
    expect(res).toMatchObject({ purged: 0, failed: 1 })
    expect(res.outcomes[0].ok).toBe(false)
    expect(res.outcomes[0].before).toBe(8)
    expect(res.outcomes[0].after).toBe(-1)
    expect(sink.lines.join('\n')).toContain('will retry next week')
  })

  it('鉴权失效：delete_all 失败时把 token 标成 expired', async () => {
    const kv = mockKV()
    const env = mockEnv(kv)
    await writeDeepseekPool(env, [rec('a')])
    const up = fakeUpstream({ sessions: eightOldestFirst() })
    const authFail = async () => json(envelope(null, 0, 40003))
    const res = await runSessionPurge(env, {
      tokens: [rec('a')],
      fetch: async (input, init) =>
        new URL(input).pathname.endsWith('delete_all') ? authFail() : up.fetch(input, init),
      force: true,
      now: () => sundayNoon,
      random: () => 0,
    })
    expect(res.failed).toBe(1)
    const pool = JSON.parse(kv.map.get('deepseek:pool')!) as { tokens: DeepseekTokenRecord[] }
    expect(pool.tokens[0].state).toBe('expired')
  })

  it('DEEPSEEK_PURGE=0 / WEEKDAY=-1 → 关闭，不发请求', async () => {
    const env = mockEnv(mockKV()) as unknown as Record<string, unknown>
    env.DEEPSEEK_PURGE = '0'
    const up = fakeUpstream({ sessions: eightOldestFirst() })
    const res = await runSessionPurge(env as unknown as Env, { tokens: [rec('a')], fetch: up.fetch, force: true })
    expect(res).toMatchObject({ enabled: false, ran: false, reason: 'disabled', nextFireAt: null })
    expect(up.state.listCalls).toBe(0)
    expect(up.state.deleteAllCalls).toBe(0)

    env.DEEPSEEK_PURGE = '1'
    env.DEEPSEEK_PURGE_WEEKDAY = '-1'
    const res2 = await runSessionPurge(env as unknown as Env, { tokens: [rec('a')], fetch: up.fetch, force: true })
    expect(res2.reason).toBe('disabled')
  })

  it('启动补跑：24h 内错过的窗口抖动 2–12s 后补跑一次', async () => {
    const kv = mockKV()
    const env = mockEnv(kv)
    const up = fakeUpstream({ sessions: eightOldestFirst() })
    const { sleeps, sleep } = recordingSleep()
    const res = await runSessionPurge(env, {
      tokens: [rec('a')],
      fetch: up.fetch,
      now: () => sundayNoon,
      random: () => 0,
      sleep,
    })
    expect(res).toMatchObject({ ran: true, reason: 'catch-up', purged: 1 })
    expect(sleeps).toEqual([2000]) // [2s, 12s] 的下界，且绝不 0
    expect(up.state.deleteAllCalls).toBe(1)

    // 「补跑一次」：同一个错过的窗口再调用不得再补跑
    const again = await runSessionPurge(env, {
      tokens: [rec('a')],
      fetch: up.fetch,
      now: () => sundayNoon,
      random: () => 0,
      sleep,
    })
    expect(again).toMatchObject({ ran: false, reason: 'not-due' })
    expect(up.state.deleteAllCalls).toBe(1)
    expect(sleeps.length).toBe(1)
  })

  it('不在窗口内（周三）→ not-due，并给出下一次触发时刻', async () => {
    const up = fakeUpstream({ sessions: eightOldestFirst() })
    const now = Date.UTC(2026, 8, 16, 12) // 周三
    const res = await runSessionPurge(mockEnv(mockKV()), {
      tokens: [rec('a')],
      fetch: up.fetch,
      now: () => now,
      random: () => 0,
    })
    expect(res).toMatchObject({ ran: false, reason: 'not-due', purged: 0 })
    const slot = Date.UTC(2026, 8, 20, 4)
    expect(res.nextFireAt).toBe(slot - 30 * 60 * 1000) // random()=0 → 窗口 - 30m
    expect(up.state.listCalls).toBe(0)
    expect(up.state.deleteAllCalls).toBe(0)
  })

  it('allowCatchUp=false → 即使刚错过窗口也不补跑', async () => {
    const up = fakeUpstream({ sessions: eightOldestFirst() })
    const res = await runSessionPurge(mockEnv(mockKV()), {
      tokens: [rec('a')],
      fetch: up.fetch,
      now: () => sundayNoon,
      random: () => 0,
      allowCatchUp: false,
    })
    expect(res).toMatchObject({ ran: false, reason: 'not-due' })
    expect(up.state.deleteAllCalls).toBe(0)
  })

  it('utcOffsetMinutes=480 时窗口按北京时间判定', async () => {
    const up = fakeUpstream({ sessions: eightOldestFirst() })
    // UTC 周六 22:00 = 北京周日 06:00，窗口（北京周日 04:00 = UTC 周六 20:00）已过 2h → 补跑
    const now = Date.UTC(2026, 8, 19, 22)
    const { sleeps, sleep } = recordingSleep()
    const res = await runSessionPurge(mockEnv(mockKV()), {
      tokens: [rec('a')],
      fetch: up.fetch,
      now: () => now,
      random: () => 0,
      utcOffsetMinutes: 480,
      sleep,
    })
    expect(res.reason).toBe('catch-up')
    expect(sleeps).toEqual([2000])
    expect(up.state.deleteAllCalls).toBe(1)
  })
})

// ===== DEEPSEEK_SESSION_CAP =====

describe('enforceSessionCap', () => {
  it('超过上限时同步删掉最老的，其余保留（真上游调用）', async () => {
    const up = fakeUpstream()
    const client = new DeepseekClient({
      account: { password: '' },
      fetch: up.fetch,
      wire: { replaceHeaders: true, headers: webHeaders(rec('a')) },
    })
    const env = mockEnv(mockKV())
    const first = await enforceSessionCap(env, client, rec('a'), 's1', { cap: 2 })
    const second = await enforceSessionCap(env, client, rec('a'), 's2', { cap: 2 })
    const third = await enforceSessionCap(env, client, rec('a'), 's3', { cap: 2 })
    expect(first.evicted).toEqual([])
    expect(second.evicted).toEqual([])
    expect(third.evicted).toEqual(['s1'])
    expect(up.state.deleted).toEqual(['s1'])
    expect(deepseekSessionCapRegistry.recorded('a')).toEqual(['s2', 's3'])
  })

  it('cap=0（未设）→ 什么都不做、也不记账', async () => {
    const up = fakeUpstream()
    const client = new DeepseekClient({
      account: { password: '' },
      fetch: up.fetch,
      wire: { replaceHeaders: true, headers: webHeaders(rec('a')) },
    })
    const res = await enforceSessionCap(mockEnv(mockKV()), client, rec('a'), 's1')
    expect(res).toEqual({ cap: 0, evicted: [], errors: [] })
    expect(deepseekSessionCapRegistry.recorded('a')).toEqual([])
    expect(up.state.deleted).toEqual([])
  })

  it('cap 来自 DEEPSEEK_SESSION_CAP', async () => {
    const env = mockEnv(mockKV()) as unknown as Record<string, unknown>
    env.DEEPSEEK_SESSION_CAP = '1'
    const client = { fetchSessionPage: async () => ({}) as never, deleteSession: async () => undefined, deleteAllSessions: async () => undefined }
    await enforceSessionCap(env as unknown as Env, client, rec('a'), 's1')
    const res = await enforceSessionCap(env as unknown as Env, client, rec('a'), 's2')
    expect(res).toMatchObject({ cap: 1, evicted: ['s1'] })
  })

  it('淘汰删除失败只记 errors，不抛出；鉴权失效则标记 token', async () => {
    const kv = mockKV()
    const env = mockEnv(kv)
    await writeDeepseekPool(env, [rec('a')])
    const client = {
      fetchSessionPage: async () => ({}) as never,
      deleteSession: async () => {
        throw new BizError({ code: 40003, msg: 'expired' })
      },
      deleteAllSessions: async () => undefined,
    }
    const sink = logSink()
    await enforceSessionCap(env, client, rec('a'), 's1', { cap: 1, log: sink.log })
    const res = await enforceSessionCap(env, client, rec('a'), 's2', { cap: 1, log: sink.log })
    expect(res.evicted).toEqual(['s1'])
    expect(res.errors.length).toBe(1)
    const pool = JSON.parse(kv.map.get('deepseek:pool')!) as { tokens: DeepseekTokenRecord[] }
    expect(pool.tokens[0].state).toBe('expired')
  })

  it('周清空后注册表重置（否则淘汰会对着幽灵 id 删）', async () => {
    const up = fakeUpstream({ sessions: eightOldestFirst() })
    const client = new DeepseekClient({
      account: { password: '' },
      fetch: up.fetch,
      wire: { replaceHeaders: true, headers: webHeaders(rec('a')) },
    })
    const env = mockEnv(mockKV())
    await enforceSessionCap(env, client, rec('a'), 's1', { cap: 5 })
    expect(deepseekSessionCapRegistry.recorded('a')).toEqual(['s1'])

    await runSessionPurge(env, { tokens: [rec('a')], fetch: up.fetch, force: true, now: () => Date.UTC(2026, 8, 20, 12), random: () => 0 })
    expect(deepseekSessionCapRegistry.recorded('a')).toEqual([])
  })
})
