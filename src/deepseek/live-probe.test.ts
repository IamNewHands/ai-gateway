/**
 * deepseek/live-probe.test.ts — 对生产上游的**真实**探测（协议正确性 + 出口可达性）。
 *
 * 默认跳过：只有 `DS_LIVE_PROBE=1` **且** `.secrets/deepseek.json` 存在时才跑，
 * 因此 `npm test` 全量跑永远是离线的。
 *
 *   $env:DS_LIVE_PROBE='1'; npx vitest run --pool=threads src/deepseek/live-probe.test.ts
 *
 * 为什么要探测：上游是 chat.deepseek.com 的私有 App 接口 + WAF + 设备风控，代码
 * 写对了不代表能从当前出口 IP 打通。本机探测与「Cloudflare 边缘出口探测」是两件事，
 * 分开做才能把「协议错」和「IP 被拒」区分开。
 *
 * 凭据读取走非字面量动态 import：本仓库 tsconfig 只装 workers-types（没有 @types/node），
 * 直接 `import 'node:fs'` 会让 tsc 报错；动态非字面量说明符让 TS 不解析、运行时照常可用。
 */

import { describe, it, expect } from 'vitest'
import { DEFAULT_BASE_URL, DeepseekClient, buildLoginBody, type Envelope } from './client'

interface ProbeAccount {
  mobile?: string
  email?: string
  password: string
}

const nodeEnv: Record<string, string | undefined> =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}

const PROBE_CREDENTIALS_PATH = '.secrets/deepseek.json'

async function loadProbeAccount(): Promise<ProbeAccount | null> {
  try {
    const fs = (await import('node:fs' as string)) as {
      readFileSync: (path: string, encoding: string) => string
    }
    const parsed = JSON.parse(fs.readFileSync(PROBE_CREDENTIALS_PATH, 'utf8')) as ProbeAccount
    if (!parsed.password || (!parsed.mobile && !parsed.email)) return null
    return parsed
  } catch {
    return null
  }
}

const account = await loadProbeAccount()
const enabled = nodeEnv.DS_LIVE_PROBE === '1' && account !== null

/** 打印一小段上游原文，便于人工判断协议形态（不打印凭据）。 */
function truncate(s: string, n = 1200): string {
  return s.length > n ? `${s.slice(0, n)}…(+${s.length - n} chars)` : s
}

describe.runIf(enabled)('live upstream probe (chat.deepseek.com)', () => {
  it(
    'logs in, creates a session, solves PoW and streams a completion',
    async () => {
      const client = new DeepseekClient({ account: account as ProbeAccount })
      const report: Record<string, unknown> = {}

      // ---- 1. 设备指纹（本地计算，无需网络）----
      const profile = await client.profile()
      report.deviceIdShape = profile.deviceId.length
      report.deviceIdIsUuid = /^[0-9a-f]{8}-/.test(profile.deviceId)
      report.rangersId = profile.rangersId

      // ---- 2. 登录 ----
      const loginStarted = Date.now()
      let token = ''
      try {
        token = await client.login()
      } catch (err) {
        // 失败时把上游原文捞出来：错误归因只能靠一手响应体。
        const headers: Record<string, string> = {
          ...(await client.baseHeaders()),
          'Content-Type': 'application/json',
        }
        const raw = await fetch(`${DEFAULT_BASE_URL}/api/v0/users/login`, {
          method: 'POST',
          headers,
          body: JSON.stringify(buildLoginBody(account as ProbeAccount, profile)),
        })
        report.loginFailure = {
          status: raw.status,
          contentType: raw.headers.get('Content-Type'),
          body: truncate(await raw.text(), 2000),
          sentHeaders: Object.keys(headers).join(','),
        }
        // eslint-disable-next-line no-console
        console.log('[live-probe report]', JSON.stringify(report, null, 2))
        throw err
      }
      report.loginMs = Date.now() - loginStarted
      report.tokenLength = token.length
      expect(token.length).toBeGreaterThan(0)

      // ---- 3. token 存活探测（顺带看账号状态原文）----
      const current = await client.usersCurrent(token)
      report.usersCurrent = truncate(JSON.stringify(current.data?.biz_data ?? {}), 600)

      // ---- 4. 建会话 ----
      const sessionId = await client.createSession(token)
      report.sessionId = sessionId
      expect(sessionId.length).toBeGreaterThan(0)

      // ---- 5. 补全（PoW 在 completion 内部解算）----
      const completionStarted = Date.now()
      const resp = await client.completion(token, {
        sessionId,
        prompt: '只回复两个字：你好',
        thinkingDisabled: true,
      })
      report.completionHeadersMs = Date.now() - completionStarted
      report.contentType = resp.headers.get('Content-Type')

      const reader = resp.body?.getReader()
      let raw = ''
      if (reader) {
        const decoder = new TextDecoder()
        const deadline = Date.now() + 120_000
        for (;;) {
          if (Date.now() > deadline) break
          const { value, done } = await reader.read()
          if (done) break
          raw += decoder.decode(value, { stream: true })
          if (raw.includes('event: done') || raw.includes('"type":"done"')) break
          if (raw.length > 200_000) break
        }
        await reader.cancel().catch(() => undefined)
      }
      report.streamMs = Date.now() - completionStarted
      report.streamBytes = raw.length
      report.streamHead = truncate(raw, 1500)

      // 记录失败时最有用的现场：把报告打进测试输出，而不是只靠断言。
      console.log('[live-probe report]', JSON.stringify(report, null, 2))

      expect(raw.length).toBeGreaterThan(0)
    },
    240_000,
  )
})

describe.runIf(!enabled)('live upstream probe (skipped)', () => {
  it('explains how to enable it', () => {
    const why = nodeEnv.DS_LIVE_PROBE !== '1'
      ? 'DS_LIVE_PROBE is not "1"'
      : `no account at ${PROBE_CREDENTIALS_PATH}`
    console.log(`[live-probe] skipped: ${why}`)
    expect(true).toBe(true)
  })
})

/**
 * 指纹变体矩阵（回应 2026-09-30 的首轮结果）：
 * App 2.5.3 完整指纹 + 铸造 device_id → biz 11 RISK_DEVICE_DETECTED；
 * 而 ds2api 用极简头 + 字面量 device_id 在生产上跑得好。这里逐个试，定位到底是
 * 「头」还是「device_id」在触发风控。每轮之间 3s，单账号串行（对齐 ds2api 的
 * OPS 节奏建议），最多 4 次登录尝试。
 */
const DS2API_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'accept-charset': 'UTF-8',
  'User-Agent': 'DeepSeek/2.0.4 Android/35',
  'x-client-platform': 'android',
  'x-client-version': '2.0.4',
  'x-client-locale': 'zh_CN',
}

/** 参考实现（ds2api）登录体里的 device_id 字面量。 */
const DS2API_DEVICE_ID = 'deepseek_to_api'

interface WireVariant {
  name: string
  wire: {
    loginDeviceId?: string
    headers?: Record<string, string>
    replaceHeaders?: boolean
  }
}

const WIRE_VARIANTS: WireVariant[] = [
  {
    name: 'ds2api 极简头 + deepseek_to_api',
    wire: { replaceHeaders: true, headers: DS2API_HEADERS, loginDeviceId: DS2API_DEVICE_ID },
  },
  {
    name: 'ds2api 极简头 + 铸造 device_id',
    wire: { replaceHeaders: true, headers: DS2API_HEADERS },
  },
  {
    name: 'App 2.5.3 头 + deepseek_to_api',
    wire: { loginDeviceId: DS2API_DEVICE_ID },
  },
  {
    name: 'App 2.5.3 头(zh_CN/2.0.4) + 铸造 device_id',
    wire: {
      headers: {
        'User-Agent': 'DeepSeek/2.0.4 Android/35',
        'x-client-version': '2.0.4',
        'x-client-locale': 'zh_CN',
      },
    },
  },
]

describe.runIf(enabled)('live upstream wire variants', () => {
  it(
    'finds a wire profile the risk engine accepts',
    async () => {
      const results: Array<Record<string, unknown>> = []
      let anyOk = false

      for (const variant of WIRE_VARIANTS) {
        const client = new DeepseekClient({ account: account as ProbeAccount, wire: variant.wire })
        const entry: Record<string, unknown> = { variant: variant.name }
        let stage = 'login'
        try {
          const token = await client.login()
          stage = 'create_session'
          const sessionId = await client.createSession(token)
          stage = 'completion'
          const resp = await client.completion(token, {
            sessionId,
            prompt: '只回复两个字：你好',
            thinkingDisabled: true,
          })
          const reader = resp.body?.getReader()
          let raw = ''
          if (reader) {
            const decoder = new TextDecoder()
            const deadline = Date.now() + 90_000
            for (;;) {
              if (Date.now() > deadline) break
              const { value, done } = await reader.read()
              if (done) break
              raw += decoder.decode(value, { stream: true })
              if (raw.includes('event: done') || raw.length > 20_000) break
            }
            await reader.cancel().catch(() => undefined)
          }
          entry.ok = true
          entry.streamBytes = raw.length
          entry.streamHead = truncate(raw, 400)
          anyOk = true
        } catch (err) {
          entry.ok = false
          entry.stage = stage
          entry.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
        }
        results.push(entry)
        console.log('[wire-variant]', JSON.stringify(entry))
        if (anyOk) break // 已找到可用组合；继续试只浪费登录次数
        await new Promise((r) => setTimeout(r, 3000))
      }

      console.log('[wire-variant summary]', JSON.stringify(results, null, 2))
      expect(anyOk).toBe(true)
    },
    300_000,
  )
})

/** 让 Envelope 类型在本文件被引用（便于后续扩展断言）。 */
export type { Envelope }
