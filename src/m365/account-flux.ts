/**
 * M365 账号级并发闸门（每账号最大在途对话数，默认 1 = 同账号全局串行；同原版 account_concurrency.go）。
 *
 * Cloudflare Worker 无进程内共享内存，而 M365 对话跑在按会话分片的 M365Session DO 上，
 * 每个会话各自不知其它会话并发 → 需要"跨会话共享的账号级计数器"。
 * 方案：每个 provider 建一个 `AccountFlux` Durable Object（idFromName(providerId)），
 * 在其单线程内存里维护 `inflight[oid]`，提供原子 acquire/release（DO 单线程天然原子）。
 *
 * 语义：Acquire 一次即占一个并发位；联盟请求在上限内各自 DO；已达上限则返回 busy，
 * 由调用方（M365Session）短暂轮询等待或切下一健康账号（对应原版 select 阻塞等价效果）。
 *
 * 风控对齐（移植自 M365-Gateway）：同一账号两次调用之间强制最小间隔（默认 1s），
 * 避免并发轰击同一账号触发微软风控；默认并发上限下调为 1，实现"同账号全局串行"。
 */
import type { Env } from '../types'

const DEFAULT_CONCURRENCY = 1
/** 同一账号两次调用之间的最小间隔（毫秒，默认 1s，同原版 UPSTREAM_MIN_INTERVAL_MS） */
const DEFAULT_MIN_INTERVAL_MS = 1_000
const WARMUP_PATH = '/warmup'

interface AcquireBody { oid: string; n?: number }
interface ReleaseBody { oid: string; n?: number }

function concurrencyLimit(env: Env): number {
  const raw = (env as unknown as Record<string, unknown>)['M365_ACCOUNT_DEFAULT_CONCURRENCY']
  const n = typeof raw === 'string' ? parseInt(raw, 10) : NaN
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_CONCURRENCY
}

/** 同账号最小调用间隔（毫秒）；显式设 0 可关闭该节流 */
function minIntervalMs(env: Env): number {
  const raw = (env as unknown as Record<string, unknown>)['M365_ACCOUNT_MIN_INTERVAL_MS']
  const n = typeof raw === 'string' ? parseInt(raw, 10) : NaN
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_MIN_INTERVAL_MS
}

/** AccountFlux Durable Object：每 provider 一个实例，维护各账号在途并发数 */
export class AccountFlux {
  private env: Env
  private inflight = new Map<string, number>()
  /** 每个账号上一次释放并发位（即上一次调用结束）的时间戳，用于最小间隔节流 */
  private lastReleaseAt = new Map<string, number>()
  /** 会话级账号分摊的轮转游标（持久化在 DO，跨会话共享，实现均匀分摊） */
  private spreadCursor = 0
  private limit: number

  constructor(_ctx: DurableObjectState, env: Env) {
    this.env = env
    this.limit = concurrencyLimit(env)
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (this._warm(pathsOf(url))) {
      // 显式唤醒时兜底初始化 limit（避免首次触发的默认值偏差）
      if (this.limit <= 0) this.limit = concurrencyLimit(this.env)
      return json({ ok: true })
    }
    if (url.pathname === '/snapshot') {
      return json({ limit: this.limit, inflight: Object.fromEntries(this.inflight) })
    }
    if (request.method === 'POST' && url.pathname === '/spread-cursor') {
      // 返回当前游标并自增（DO 单线程保证原子），调用方对健康账号数取模得到选中下标
      const current = this.spreadCursor
      this.spreadCursor = (this.spreadCursor + 1) % 1_000_000
      return json({ cursor: current })
    }
    if (request.method === 'POST' && url.pathname === '/acquire') {
      const b = (await request.json().catch(() => ({}))) as AcquireBody
      const oid = b.oid || ''
      const n = typeof b.n === 'number' && b.n > 0 ? b.n : 1
      if (!oid) return json({ granted: false, reason: 'no-oid' })
      const cur = this.inflight.get(oid) || 0
      if (cur + n > this.limit) return json({ granted: false, busy: true })
      // 最小间隔节流：距上次调用结束不足 minInterval 时返回等待提示，由调用方短暂退避后重试
      const interval = minIntervalMs(this.env)
      const last = this.lastReleaseAt.get(oid) || 0
      const since = Date.now() - last
      if (interval > 0 && last > 0 && since < interval) {
        return json({ granted: false, throttled: true, waitHintMs: interval - since })
      }
      this.inflight.set(oid, cur + n)
      return json({ granted: true, inflight: cur + n })
    }
    if (request.method === 'POST' && url.pathname === '/release') {
      const b = (await request.json().catch(() => ({}))) as ReleaseBody
      const oid = b.oid || ''
      const n = typeof b.n === 'number' && b.n > 0 ? b.n : 1
      if (oid) {
        const cur = this.inflight.get(oid) || 0
        const next = Math.max(0, cur - n)
        if (next === 0) this.inflight.delete(oid)
        else this.inflight.set(oid, next)
        // 记录释放时刻（仅在完全空闲时刷新），用于下一次 acquire 的最小间隔判定
        if (next === 0) this.lastReleaseAt.set(oid, Date.now())
      }
      return json({ ok: true })
    }
    return json({ error: 'not found' }, 404)
  }

  private _warm(paths: string[]): boolean {
    return paths.includes(WARMUP_PATH)
  }
}

function pathsOf(url: URL): string[] {
  return [url.pathname]
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

function fluxStub(env: Env, providerId: string): DurableObjectStub {
  const ns = (env as unknown as Record<string, unknown>)['M365_FLUX'] as DurableObjectNamespace | undefined
  if (!ns) throw new Error('M365_FLUX binding not configured')
  return ns.get(ns.idFromName(providerId))
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 取下一个账号分摊轮转游标（跨会话共享，DO 单线程保证原子自增）。
 * 调用方对"健康账号数"取模即得选中下标，实现会话级多账号的均匀分摊。
 * 取不到时返回 0（退化为选第一个健康账号）。
 */
export async function nextSpreadCursor(env: Env, providerId: string): Promise<number> {
  try {
    const resp = await fluxStub(env, providerId).fetch('https://flux.local/spread-cursor', { method: 'POST' })
    const j = (await resp.json().catch(() => ({}))) as { cursor?: number }
    return typeof j.cursor === 'number' && j.cursor >= 0 ? j.cursor : 0
  } catch {
    return 0
  }
}

/** 单次 acquire（不等待），返回是否占用成功 */
export async function acquireOnce(env: Env, providerId: string, oid: string, n = 1): Promise<{ granted: boolean; busy: boolean; throttled: boolean; waitHintMs: number }> {
  try {
    const resp = await fluxStub(env, providerId).fetch('https://flux.local/acquire', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oid, n }),
    })
    const j = (await resp.json().catch(() => ({}))) as { granted?: boolean; busy?: boolean; throttled?: boolean; waitHintMs?: number }
    return {
      granted: !!j.granted,
      busy: !!j.busy,
      throttled: !!j.throttled,
      waitHintMs: typeof j.waitHintMs === 'number' && j.waitHintMs > 0 ? j.waitHintMs : 0,
    }
  } catch {
    return { granted: false, busy: false, throttled: false, waitHintMs: 0 }
  }
}

/**
 * 带有限等待的 acquire：并发闸门占位，满则轮询等待直到成功或超时。
 * 返回 true 表示已占用（调用方务必在 finally 中 release）。
 * 默认等待上限对齐 M365-Gateway 的排队窗口（120s），可用 waitMs 覆盖。
 */
export async function acquireSlot(env: Env, providerId: string, oid: string, opts?: { n?: number; waitMs?: number }): Promise<boolean> {
  const n = opts?.n ?? 1
  const waitMs = opts?.waitMs ?? 120_000
  const step = 250
  let waited = 0
  for (;;) {
    const { granted, waitHintMs } = await acquireOnce(env, providerId, oid, n)
    if (granted) return true
    if (waited >= waitMs) return false
    // 最小间隔节流时按服务端建议退避，避免无谓热轮询
    const delay = waitHintMs > 0 ? Math.min(waitHintMs, waitMs - waited) : step
    await sleep(delay)
    waited += delay
  }
}

/** 释放并发位 */
export async function releaseSlot(env: Env, providerId: string, oid: string, n = 1): Promise<void> {
  try {
    await fluxStub(env, providerId).fetch('https://flux.local/release', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oid, n }),
    })
  } catch { /* 释放失败不影响主流程 */ }
}

/** 并发快照（管理/排查用） */
export async function fluxSnapshot(env: Env, providerId: string): Promise<{ limit: number; inflight: Record<string, number> }> {
  try {
    const resp = await fluxStub(env, providerId).fetch('https://flux.local/snapshot')
    return (await resp.json()) as { limit: number; inflight: Record<string, number> }
  } catch {
    return { limit: concurrencyLimit(env), inflight: {} }
  }
}