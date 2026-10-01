/**
 * deepseek-probe/worker.ts — 一次性探测 Worker：**Cloudflare 边缘出口能不能跑通
 * chat.deepseek.com 的 API 通路**。
 *
 * 为什么需要它：本机 Node 已验证「浏览器 token + web 指纹 → session/PoW/completion」
 * 全通；但托管目标是 Cloudflare Workers，边缘出口 IP 与 TLS 栈都不同，必须实测。
 * 这一步**不需要登录**（登录已被上游硬卡，见 DEEPSEEK-APP-PORT.md），只需要一个
 * 浏览器里取的 token —— 所以探针不内置任何凭据，token 由调用方每次传入。
 *
 * 部署（在 ai-gateway 仓库根目录，普通终端执行；沙箱内跑不了 wrangler）：
 *   node ..\node_modules\wrangler\wrangler-dist\cli.js deploy --temporary
 * 或（已登录 Cloudflare 时）：
 *   npx wrangler deploy --temporary --config probe\wrangler.toml
 *
 * 调用：
 *   POST <url>/probe  {"token":"…","headerDeviceId":"…","userAgent":"…"}
 *
 * 复用 src/deepseek 的移植产物（wrangler 会打包 TS，无需手抄一份 PoW）。
 */

import { BizError, DeepseekClient, HttpStatusError } from '../src/deepseek/client'

interface ProbeConfig {
  token?: string
  headerDeviceId?: string
  userAgent?: string
  prompt?: string
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…(+${s.length - n})` : s
}

/**
 * 把异常转成**结构化**字段回给调用方，不回 `err.message` / `cause.message`（CodeQL
 * js/stack-trace-exposure #79：catch 到的错误文本直接进 HTTP 响应 = 内部细节外泄）。
 *
 * 判定能力不受损：本探针要回答的是「被 40003/风控拒了，还是连接层不通」——
 * 前者是数字 `bizCode`，后者是 `cause.code`（ENOTFOUND / ECONNRESET…），都在这里。
 * 完整 message / stack 只写 console（wrangler tail / CF 面板可见），不出 HTTP。
 */
export function describeError(err: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = { errorName: err instanceof Error ? err.name : typeof err }
  if (err instanceof BizError) {
    out.bizCode = err.bizCode
    out.code = err.code
    out.httpStatus = err.httpStatus
  } else if (err instanceof HttpStatusError) {
    out.httpStatus = err.status
  }
  // 连接层错误码（DNS/TLS/连接重置）：只取枚举式的 code，不取自由文本
  const causeCode = (err as { cause?: { code?: unknown } })?.cause?.code
  if (typeof causeCode === 'string' || typeof causeCode === 'number') out.causeCode = causeCode
  return out
}

/** 完整错误详情只进 Worker 日志（服务端可见），供 operator 用 wrangler tail 定位。 */
function logError(scope: string, err: unknown): void {
  const cause = (err as { cause?: unknown })?.cause
  console.error(
    `[probe] ${scope} failed:`,
    err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    cause instanceof Error ? `cause ${cause.name}: ${cause.message}` : cause ? `cause ${String(cause)}` : '',
  )
}

async function runProbe(cfg: ProbeConfig, cf: unknown): Promise<Record<string, unknown>> {
  const token = (cfg.token ?? '').trim()
  if (!token) throw new Error('missing token')

  const client = new DeepseekClient({
    account: { password: '' },
    wire: {
      replaceHeaders: true,
      headers: {
        Accept: '*/*',
        'Content-Type': 'application/json',
        'User-Agent': cfg.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        'x-client-platform': 'web',
        'x-client-version': '2.5.0',
        'x-client-locale': 'zh_CN',
        'x-client-timezone-offset': '28800',
        'x-client-bundle-id': 'com.deepseek.chat',
        'x-device-model': '',
        'x-device-id': cfg.headerDeviceId || '',
      },
    },
  })

  const report: Record<string, unknown> = { edge: cf ?? null, stages: [] as unknown[] }
  const stages = report.stages as Array<Record<string, unknown>>

  const stage = async (name: string, fn: () => Promise<Record<string, unknown>>) => {
    const t0 = Date.now()
    try {
      const out = await fn()
      stages.push({ stage: name, ok: true, ms: Date.now() - t0, ...out })
      return out
    } catch (err) {
      logError(name, err)
      stages.push({
        stage: name,
        ok: false,
        ms: Date.now() - t0,
        ...describeError(err),
      })
      throw err
    }
  }

  await stage('users/current', async () => {
    const env = await client.usersCurrent(token)
    return { bizCode: env.data?.biz_code ?? 0, body: clip(JSON.stringify(env.data?.biz_data ?? {}), 300) }
  })

  const session = await stage('chat_session/create', async () => {
    const id = await client.createSession(token)
    return { sessionId: id }
  })

  await stage('chat/completion (+pow)', async () => {
    const resp = await client.completion(token, {
      sessionId: String(session.sessionId),
      prompt: cfg.prompt || '只回复两个字：你好',
      thinkingDisabled: true,
    })
    const contentType = resp.headers.get('Content-Type') ?? ''
    const reader = resp.body?.getReader()
    let raw = ''
    if (reader) {
      const decoder = new TextDecoder()
      const deadline = Date.now() + 60_000
      for (;;) {
        if (Date.now() > deadline) break
        const { value, done } = await reader.read()
        if (done) break
        raw += decoder.decode(value, { stream: true })
        if (raw.includes('event: done') || raw.length > 20_000) break
      }
      await reader.cancel().catch(() => undefined)
    }
    return { contentType, bytes: raw.length, head: clip(raw, 800) }
  })

  report.ok = true
  return report
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const cf = (request as unknown as { cf?: unknown }).cf ?? null

    if (request.method !== 'POST' || url.pathname !== '/probe') {
      return json({
        usage: 'POST /probe {"token":"…","headerDeviceId":"…","userAgent":"…"}',
        edge: cf,
        clientIp: request.headers.get('cf-connecting-ip') ?? null,
      })
    }

    try {
      const cfg = (await request.json()) as ProbeConfig
      const report = await runProbe(cfg, cf)
      return json(report)
    } catch (err) {
      logError('fetch', err)
      return json({ ok: false, edge: cf, ...describeError(err) }, 502)
    }
  },
}
