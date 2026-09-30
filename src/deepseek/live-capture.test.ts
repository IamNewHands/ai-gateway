/**
 * deepseek/live-capture.test.ts — 从真实上游抓 SSE 固件，供离线回归测试。
 *
 * 为什么固件而不是每次打真上游：SSE→OpenAI 的翻译逻辑要反复改，每次改都打真上游
 * 既慢又会消耗 token/触发风控。抓一份真实样本落盘，之后所有 `sse.ts` 的测试都跑
 * 固件；固件失效（上游改协议）时再重抓。
 *
 *   $env:DS_LIVE_PROBE='1'; $env:DS_LIVE_CAPTURE='1'
 *   npx vitest run --pool=threads -t "capture" src/deepseek/live-capture.test.ts
 *
 * 依赖 `.secrets/deepseek-web-session.json`（浏览器抓的 token）；不做登录。
 */

import { describe, it, expect } from 'vitest'
import { DeepseekClient, type CompletionRequest } from './client'

const nodeEnv: Record<string, string | undefined> =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}

interface WebSession {
  token: string
  headerDeviceId: string
  userAgent: string
}

async function loadJsonFile<T>(path: string): Promise<T | null> {
  try {
    const fs = (await import('node:fs' as string)) as {
      readFileSync: (p: string, enc: string) => string
      mkdirSync: (p: string, o: { recursive: boolean }) => void
      writeFileSync: (p: string, data: string) => void
    }
    return JSON.parse(fs.readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

async function writeFixture(name: string, content: string): Promise<number> {
  const fs = (await import('node:fs' as string)) as {
    mkdirSync: (p: string, o: { recursive: boolean }) => void
    writeFileSync: (p: string, data: string) => void
  }
  // vitest 的 cwd 是仓库根；不用 import.meta.url（workers-types 下没有该属性）
  const dir = 'src/deepseek/__fixtures__/'
  fs.mkdirSync(dir, { recursive: true })
  const file = `${dir}${name}`
  fs.writeFileSync(file, content)
  return content.length
}

const session = await loadJsonFile<WebSession>('.secrets/deepseek-web-session.json')
const enabled =
  nodeEnv.DS_LIVE_PROBE === '1' && nodeEnv.DS_LIVE_CAPTURE === '1' && session !== null

interface Variant {
  file: string
  label: string
  request: Omit<CompletionRequest, 'sessionId'>
}

const VARIANTS: Variant[] = [
  {
    file: 'completion-plain.sse.txt',
    label: 'thinking off, 普通回答',
    request: { prompt: '只回复两个字：你好', thinkingDisabled: true },
  },
  {
    file: 'completion-thinking.sse.txt',
    label: 'thinking on, 触发思考',
    request: { prompt: '9.11 和 9.9 哪个大？只给结论和一句话理由。', thinkingDisabled: false },
  },
  {
    file: 'completion-search.sse.txt',
    label: 'search on, 触发联网',
    request: { prompt: '今天有什么科技新闻？一句话概括。', thinkingDisabled: true, searchEnabled: true },
  },
]

describe.runIf(enabled)('capture real upstream SSE fixtures', () => {
  for (const variant of VARIANTS) {
    it(
      `captures ${variant.file}`,
      async () => {
        const s = session as WebSession
        const client = new DeepseekClient({
          account: { password: '' },
          wire: {
            replaceHeaders: true,
            headers: {
              Accept: '*/*',
              'Content-Type': 'application/json',
              'User-Agent': s.userAgent,
              'x-client-platform': 'web',
              'x-client-version': '2.5.0',
              'x-client-locale': 'zh_CN',
              'x-client-timezone-offset': '28800',
              'x-client-bundle-id': 'com.deepseek.chat',
              'x-device-model': '',
              'x-device-id': s.headerDeviceId,
            },
          },
        })

        const sessionId = await client.createSession(s.token)
        const resp = await client.completion(s.token, { sessionId, ...variant.request })
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
            if (raw.length > 400_000) break
          }
          await reader.cancel().catch(() => undefined)
        }

        const bytes = await writeFixture(variant.file, raw)
        // eslint-disable-next-line no-console
        console.log(`[capture] ${variant.file} (${variant.label}) → ${bytes} bytes`)
        expect(bytes).toBeGreaterThan(0)
      },
      180_000,
    )
  }
})
