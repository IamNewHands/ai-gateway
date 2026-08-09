import { Context } from 'hono'
import { forwardProxy } from './proxy'
import { writeLog } from './admin'
import type { Env } from './types'

/**
 * WS 首帧摘要：只记录 model/消息数量/内容长度等结构信息，
 * 不落盘用户 prompt、system prompt、工具定义的全文。
 */
function summarizeWsFrame(text: string): string {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const model = typeof parsed['model'] === 'string' ? parsed['model'] : '(?)'
      const msgs = Array.isArray(parsed['messages']) ? (parsed['messages'] as unknown[]).length : '?'
      const tools = Array.isArray(parsed['tools']) ? (parsed['tools'] as unknown[]).length : undefined
      const stream = parsed['stream']
      return `model=${model}, messages=${msgs}${typeof tools === 'number' ? `, tools=${tools}` : ''}, stream=${stream}`
    }
  } catch { /* 非 JSON，走兜底 */ }
  return `len=${text.length}（非标准 JSON）`
}

/**
 * 处理 /v1/* 的 WebSocket 升级请求（Trae 等客户端自定义模型直连网关时走 WS 传输）。
 *
 * 背景：客户端发起 WS 握手（GET + Upgrade: websocket，无 body）。此前 handleProxy 用
 * `c.req.json()` 读取无 body 请求会抛 "Unexpected end of JSON input" → 网关返回 500 →
 * Cloudflare 对非 101 响应中断握手 → 客户端报 "unexpected EOF during handshake"。
 * 本处理器改为：
 *   1. 接受 WS 握手（101 Switching Protocols）
 *   2. 读取客户端首条文本消息，解析为 OpenAI chat/completions 请求体
 *      （兼容两种格式：直接 body，或 { method, path, headers, body } 信封）
 *   3. 复用 HTTP 转发核心逻辑 forwardProxy 请求上游
 *   4. 将上游响应体（SSE 流或 JSON）分块以 WS 文本帧回推
 *   5. 流结束后关闭连接
 */
export async function handleProxyWebSocket(c: Context<{ Bindings: Env }>) {
  const upgrade = (c.req.header('Upgrade') || '').toLowerCase()
  if (upgrade !== 'websocket' && !c.req.header('Sec-WebSocket-Key')) {
    return c.json({ error: { message: '需要 WebSocket 升级请求', type: 'invalid_request_error' } }, 400)
  }

  const [client, server] = Object.values(new WebSocketPair())
  server.accept()

  // busy：已有请求在转发中，忽略后续消息；done：已结束（错误已回推或流已收尾），禁止再发
  let busy = false
  let done = false

  const closeWith = (code: number, reason: string) => {
    try { server.close(code, reason) } catch { /* already closed */ }
  }
  const sendError = (message: string) => {
    if (done) return
    done = true
    try {
      server.send(JSON.stringify({
        error: { message: message.substring(0, 2000), type: 'proxy_error' },
      }))
    } catch { /* ignore */ }
    closeWith(1011, 'proxy_error')
  }

  server.addEventListener('message', async (event) => {
    if (busy || done) return

    const raw = (event as MessageEvent).data
    const text = typeof raw === 'string' ? raw
      : raw instanceof ArrayBuffer ? new TextDecoder().decode(raw)
      : null
    if (text === null) return

    let body: Record<string, unknown> | null = null
    try {
      const parsed = JSON.parse(text)
      // 信封格式（含 method/path/headers/body）时提取 body；直接 OpenAI body 时原样使用
      body = parsed && typeof parsed === 'object'
        && !Array.isArray(parsed)
        && typeof parsed.body === 'object' && parsed.body !== null
        && !('messages' in parsed)
        ? parsed.body as Record<string, unknown>
        : parsed as Record<string, unknown>
    } catch (err) {
      sendError(`请求体不是合法 JSON: ${String(err).substring(0, 200)}`)
      return
    }

    if (!body || typeof body !== 'object' || typeof body['model'] !== 'string') {
      sendError('请求体缺少 model 字段')
      return
    }

    busy = true
    const model = body['model']

    try {
      // 日志：记录 WS 桥接请求（只记结构摘要，绝不落盘客户端全文，避免 prompt/密钥泄漏）
      try {
        c.executionCtx.waitUntil(writeLog(c.env, 'request',
          `[WS桥接] ${model} → 上游`,
          `首帧摘要: ${summarizeWsFrame(text)}`
        ))
      } catch { /* log failure must not break */ }
      console.log(`[ws-bridge] model=${model} first_frame=${summarizeWsFrame(text).substring(0, 500)}`)

      // 复用 HTTP 转发核心（强制 POST，与正常 chat/completions 调用一致）
      const response = await forwardProxy(c, body, 'POST')

      // 把上游响应体分块以 WS 文本帧回推；SSE 流逐块转发，JSON 一次转发
      if (!response.body) {
        sendError(`上游无响应体 (HTTP ${response.status})`)
        return
      }

      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
      try {
        while (true) {
          const { done: streamDone, value } = await reader.read()
          if (streamDone) break
          if (value) {
            try { server.send(value) } catch { break }
          }
        }
      } finally {
        try { reader.cancel() } catch { /* ignore */ }
      }
      done = true
      closeWith(1000, 'done')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[ws-bridge] forward failed:', err)
      sendError(`转发失败: ${message}`)
    }
  })

  server.addEventListener('close', () => {
    /* 客户端主动断开，无需额外处理 */
  })

  return new Response(null, { status: 101, webSocket: client })
}
