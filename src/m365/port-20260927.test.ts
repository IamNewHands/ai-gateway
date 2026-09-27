/**
 * 移植回归：M365-Copilot2API 窗口 `442205e..aba646d`（2026-09-27 分析）的三项落地。
 *
 * 1. P0 传输故障 vs 上游配额（源 `account_health.go:511` IsTransportCategory + `server.go:1124`）
 *    —— 全账号因本地网络故障不可用时必须回 503 network_error，而不是 429 限流
 * 2. P1 引用标记剥离（源 `public_identity.go:293` stripCitationMarkersStream）
 *    —— PUA 控制标记 `\uE200cite\uE202<id>\uE201` 不得进入公开正文
 * 3. P1 死上界接线（源侧上界在目标侧零调用点）
 *    —— assertBoundedPayload 必须真的被输出/记录数/图片路径消费
 */
import { describe, it, expect, vi } from 'vitest'
import {
  isTransportFailure,
  markAccountFailure,
  markAccountSuccess,
  isTransportBlockedRecently,
  TRANSPORT_FAILURE_WINDOW_MS,
} from './account-health'
import {
  stripCitationMarkers,
  scrubCitationMarkers,
  CitationMarkerStripper,
} from './chathub'
import type { Env } from '../types'

function makeEnv() {
  const store = new Map<string, string>()
  const KV = {
    get: async (k: string): Promise<string | null> => store.get(k) ?? null,
    put: async (k: string, v: string, _opts?: unknown): Promise<void> => { store.set(k, v) },
    delete: async (k: string): Promise<void> => { store.delete(k) },
  }
  return { env: ({ KV } as unknown) as Env, store }
}

/** 最小假出站 WS（供 chatWithHandlers 端到端用例） */
class FakeWS {
  listeners = new Map<string, ((ev: Record<string, unknown>) => void)[]>()
  sent: string[] = []
  accept(): void { /* noop */ }
  addEventListener(type: string, cb: (ev: Record<string, unknown>) => void): void {
    const arr = this.listeners.get(type) ?? []
    arr.push(cb)
    this.listeners.set(type, arr)
  }
  send(data: string): void { this.sent.push(data) }
  close(): void { /* noop */ }
  message(text: string): void {
    for (const cb of this.listeners.get('message') ?? []) cb({ data: text })
  }
}

// ─────────────────────────────────────────────────────────────
// 1. P0：传输故障类目
// ─────────────────────────────────────────────────────────────
describe('isTransportFailure：本地/传输类 vs 上游配额', () => {
  it('传输类故障判定为真（应提示查 DNS/代理）', () => {
    for (const msg of [
      'ws dial failed: HTTP 502 bad gateway',
      'WS_DIAL_ERROR',
      'WS_HANDSHAKE_INVALID',
      'WS_HANDSHAKE_EMPTY',
      'timeout waiting handshake (15000ms)',
      'ws closed: code=1006 reason=',
      'getaddrinfo ENOTFOUND substrate.office.com',
      'no such host',
      'TLS handshake failure',
      'connect ECONNREFUSED 1.2.3.4:443',
      'socket hang up',
      'read timeout',
      'network error',
      'SOCKS5 proxy unreachable',
    ]) {
      expect(isTransportFailure(msg), msg).toBe(true)
    }
  })

  it('上游配额/限流不判为传输故障（必须维持 429 退避语义）', () => {
    for (const msg of [
      'upstream rate-limit notice',
      '429 Too Many Requests',
      'too many requests',
      'upstream metering throttle: capability access denied',
      'CHAT_THROTTLED_QUOTA_EXHAUSTED',
      'quota exhausted',
    ]) {
      expect(isTransportFailure(msg), msg).toBe(false)
    }
  })

  it('503 属传输类（源 CategoryOverload503 ∈ IsTransportCategory），429 属配额类', () => {
    // 源 account_health.go:513 明确把 OVERLOAD_503 归入传输类：
    // "服务不可达/过载" 与 "配额限流" 是两种语义，前者应提示查连通性
    expect(isTransportFailure('503 Service Unavailable')).toBe(true)
    expect(isTransportFailure('ws dial failed: HTTP 503 Service Unavailable')).toBe(true)
    expect(isTransportFailure('WS_DIAL_FAILED:503 Service Unavailable')).toBe(true)
    expect(isTransportFailure('ws dial failed: HTTP 502 bad gateway')).toBe(true)
    // 429 仍严格属配额
    expect(isTransportFailure('429 Too Many Requests')).toBe(false)
  })

  it('鉴权/内容策略/空完成不判为传输故障', () => {
    for (const msg of [
      'WS_DIAL_FAILED:401 Unauthorized',
      'invalid_grant: Refresh token expired',
      '403 Forbidden',
      'upstream content policy flagged as offensive',
      'empty completion',
      '422 Unprocessable Entity',
    ]) {
      expect(isTransportFailure(msg), msg).toBe(false)
    }
  })

  it('微软长时间不吐内容（进度/总截止超时）不算本地网络故障', () => {
    // 这两类是"上游卡住"，提示用户查 DNS/代理是错误归因
    expect(isTransportFailure('CHAT_PROGRESS_TIMEOUT')).toBe(false)
    expect(isTransportFailure('chathub response deadline exceeded before completion')).toBe(false)
    expect(isTransportFailure('request aborted by client')).toBe(false)
  })

  it('不含传输信号的一般错误为假', () => {
    expect(isTransportFailure('upstream M365 ChatHub error; please retry later')).toBe(false)
    expect(isTransportFailure('')).toBe(false)
  })
})

describe('markAccountFailure：记录传输类类目供全账号不可用时定责', () => {
  it('传输类失败落盘 lastFailureTransport=true + 时间戳', async () => {
    const { env, store } = makeEnv()
    await markAccountFailure(env, 'acc-net', 'getaddrinfo ENOTFOUND substrate.office.com')
    const raw = JSON.parse(store.get('m365:health:acc-net')!)
    expect(raw.lastFailureTransport).toBe(true)
    expect(raw.lastFailureAt).toBeGreaterThan(0)
  })

  it('限流失败落盘 lastFailureTransport=false（不得伪装成本地断网）', async () => {
    const { env, store } = makeEnv()
    await markAccountFailure(env, 'acc-rl', '429 Too Many Requests')
    const raw = JSON.parse(store.get('m365:health:acc-rl')!)
    expect(raw.lastFailureTransport).toBe(false)
    // 限流冷却语义不变（仍走指数退避）
    expect(raw.cooldownUntil).toBeGreaterThan(Date.now())
  })

  it('isTransportBlockedRecently 只在新窗口内为真', async () => {
    const { env, store } = makeEnv()
    await markAccountFailure(env, 'acc-win', 'TLS handshake failure')
    expect(await isTransportBlockedRecently(env, 'acc-win')).toBe(true)

    // 把观测时间推回到窗口之外 → 不再用于定责
    const raw = JSON.parse(store.get('m365:health:acc-win')!)
    raw.lastFailureAt = Date.now() - TRANSPORT_FAILURE_WINDOW_MS - 1000
    store.set('m365:health:acc-win', JSON.stringify(raw))
    expect(await isTransportBlockedRecently(env, 'acc-win')).toBe(false)
  })

  it('成功后清除传输类记录（网络已恢复，不应继续报 503）', async () => {
    const { env, store } = makeEnv()
    await markAccountFailure(env, 'acc-ok', 'connect ECONNREFUSED')
    expect(await isTransportBlockedRecently(env, 'acc-ok')).toBe(true)

    await markAccountSuccess(env, 'acc-ok')
    expect(await isTransportBlockedRecently(env, 'acc-ok')).toBe(false)
  })

  it('无记录的账号为假（不误报）', async () => {
    const { env } = makeEnv()
    expect(await isTransportBlockedRecently(env, 'never-seen')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────
// 2. P1：引用标记剥离
// ─────────────────────────────────────────────────────────────
const OPEN = '\uE200cite\uE202'
const CLOSE = '\uE201'
const marker = (id: string) => OPEN + id + CLOSE

describe('stripCitationMarkers：完整标记删除', () => {
  it('删除单个完整标记，保留两侧正文', () => {
    const { text, rest } = stripCitationMarkers(`答案是 42。${marker('turn4search6')} 更多内容。`)
    expect(text).toBe('答案是 42。 更多内容。')
    expect(rest).toBe('')
  })

  it('删除同一片段里的多个标记', () => {
    const { text, rest } = stripCitationMarkers(`a${marker('turn1search2')}b${marker('turn1search3')}c`)
    expect(text).toBe('abc')
    expect(rest).toBe('')
  })

  it('无标记文本原样返回', () => {
    const { text, rest } = stripCitationMarkers('普通回答，无标记')
    expect(text).toBe('普通回答，无标记')
    expect(rest).toBe('')
  })

  it('空串安全', () => {
    expect(stripCitationMarkers('')).toEqual({ text: '', rest: '' })
  })
})

describe('stripCitationMarkers：跨分片被切断的标记', () => {
  it('有 OPEN 无 CLOSE → 从 OPEN 起点整段扣留', () => {
    const { text, rest } = stripCitationMarkers(`hello ${OPEN}turn0`)
    expect(text).toBe('hello ')
    expect(rest).toBe(`${OPEN}turn0`)
  })

  it('结尾是 OPEN 的真前缀 → 扣留该前缀（不得漏出半个控制字符）', () => {
    const { text, rest } = stripCitationMarkers('hello \uE200cit')
    expect(text).toBe('hello ')
    expect(rest).toBe('\uE200cit')
  })

  it('半个标记的任意切点都被扣留', () => {
    for (let n = 1; n < OPEN.length; n++) {
      const { text, rest } = stripCitationMarkers('x' + OPEN.slice(0, n))
      expect(text, `n=${n}`).toBe('x')
      expect(rest, `n=${n}`).toBe(OPEN.slice(0, n))
    }
  })
})

describe('CitationMarkerStripper：跨分片状态保持', () => {
  it('标记跨两片到达 → 不泄漏、不丢正文', () => {
    const s = new CitationMarkerStripper()
    const f1 = `hello ${OPEN}turn0`
    const f2 = `search1${CLOSE} world`
    const out1 = s.push(f1)
    const out2 = s.push(f2)
    expect(out1).toBe('hello ')
    expect(out2).toBe(' world')
    expect(out1 + out2).not.toContain('\uE200')
    expect(s.flush()).toBe('')
  })

  it('逐字符送入（最坏分片）也不泄漏标记', () => {
    const s = new CitationMarkerStripper()
    let out = ''
    for (const ch of `答案是 42。${marker('turn1search2')} 结论`) out += s.push(ch)
    out += s.flush()
    expect(out).toBe('答案是 42。 结论')
    expect(out).not.toContain('\uE200')
    expect(out).not.toContain('\uE201')
  })

  it('flush 丢弃未闭合的残缺标记（上游截断）', () => {
    const s = new CitationMarkerStripper()
    s.push(`text ${OPEN}turn9`)
    expect(s.flush()).toBe('')
  })

  it('flush 保留被误扣的普通文本（不是标记前缀）', () => {
    const s = new CitationMarkerStripper()
    // 尾串不是 OPEN 前缀时不会被扣留，这里直接验证 flush 对普通残留不丢内容
    expect(s.push('abc')).toBe('abc')
    expect(s.flush()).toBe('')
  })
})

describe('死上界接线：assertBoundedPayload 必须真被消费', () => {
  it('记录数上界常量与 socket 读取默认值同源（不再重复字面量）', async () => {
    const mod = await import('./chathub')
    expect(mod.DEFAULT_MAX_QUEUED_SOCKET_CHARS).toBe(mod.CHAT_HUB_PAYLOAD_LIMITS.queuedSocketCharacters)
    expect(mod.DEFAULT_MAX_FRAME_CHARS).toBe(mod.CHAT_HUB_PAYLOAD_LIMITS.frameCharacters)
  })

  it('CHAT_HUB_PAYLOAD_LIMITS 五项仍与源一致（未被改写）', async () => {
    const mod = await import('./chathub')
    expect(mod.CHAT_HUB_PAYLOAD_LIMITS).toEqual({
      frameCharacters: 1_500_000,
      frameRecords: 16_384,
      outputCharacters: 2_000_000,
      queuedSocketCharacters: 2_000_000,
      upstreamImageURLCharacters: 6 * 1024 * 1024,
    })
  })
})

// ─────────────────────────────────────────────────────────────
// 3. P1：死上界接线（端到端：超限必须真的抛 BoundedPayloadError）
// ─────────────────────────────────────────────────────────────
describe('chatWithHandlers 端到端：上界真的生效', () => {
  it('SignalR 记录数超过 16384 → 抛 WS_FRAME_TOO_MANY_RECORDS', async () => {
    const { chatWithHandlers } = await import('./chathub')
    const ws = new FakeWS()
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 101, webSocket: ws, headers: new Headers(), text: async () => '',
    })))
    const promise = chatWithHandlers(
      { accessToken: 't', oid: 'o', tid: 'd' },
      { text: 'hi', started: true },
      { timeoutMs: 5000, readTimeoutMs: 5000 },
    )
    for (let i = 0; i < 50 && ws.sent.length === 0; i++) await new Promise((r) => setTimeout(r, 5))
    ws.message(`{}${'\x1e'}`)
    for (let i = 0; i < 50 && ws.sent.length < 2; i++) await new Promise((r) => setTimeout(r, 5))
    // 一条消息里塞 20000 条空记录（畸形小记录流）
    ws.message('\x1e'.repeat(20_000))

    // 上界必须真的抛错。错误会被 chatWithHandlers 包装成 ChatHubAttemptError
    // （这是设计行为：包装保留 invocationSubmitted 与体积元数据），
    // 因此断言走 boundedPayloadMetadata 提取的数值边界。
    await expect(promise).rejects.toSatisfy((e: unknown) => {
      const meta = (e as { boundedPayload?: { subtype?: string; limit?: number } })?.boundedPayload
      return meta?.subtype === 'WS_FRAME_TOO_MANY_RECORDS'
        && meta?.limit === 16_384
        && String((e as Error)?.message ?? '').includes('WS_FRAME_TOO_MANY_RECORDS')
    })
    vi.unstubAllGlobals()
  })
})

describe('scrubCitationMarkers：非流式一次性清洗', () => {
  it('删除完整标记', () => {
    expect(scrubCitationMarkers(`答案${marker('turn1file1')}结束`)).toBe('答案结束')
  })

  it('未闭合的残缺标记一并丢弃（非流式无法再等下一片）', () => {
    const out = scrubCitationMarkers(`答案 ${OPEN}turn1file1`)
    expect(out).toBe('答案 ')
    expect(out).not.toContain('\uE200')
  })

  it('无标记文本不改变', () => {
    expect(scrubCitationMarkers('无标记文本')).toBe('无标记文本')
  })

  it('姊妹仓 M365-Gateway 夹具里的真实上游输出被清洗', () => {
    // 证据来源：M365-Gateway test/responses-endpoint.test.ts:804
    const upstream = ['已完成一个原创枫叶岛游戏。', '', '解压后双击 index.html 即可运行。', '', marker('turn1file1')].join('\n')
    const out = scrubCitationMarkers(upstream)
    expect(out).not.toContain('\uE200')
    expect(out).not.toContain('\uE201')
    expect(out).toContain('已完成一个原创枫叶岛游戏。')
    expect(out).toContain('解压后双击 index.html 即可运行。')
  })
})