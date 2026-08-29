/**
 * Gemini 推理中转 Worker
 *
 * 目的：解决部分地区直连 Google Gemini 推理端点（cloudcode-pa.googleapis.com）
 * 被拒（HTTP 400 User location is not supported）的问题。
 *
 * 本 Worker 部署在 Cloudflare 数据中心，负责把「/v1internal/*」的推理请求
 * （generateContent / streamGenerateContent / countTokens）转发到 Google，
 * 并如实流式回传 SSE / JSON 响应，供 AI Gateway 的 geminiBaseUrl 字段引用。
 *
 * 用法：
 *   geminiBaseUrl 填「本 Worker 部署后的地址」（不含末尾斜杠），
 *   例如 https://gemini-relay.你的用户名.workers.dev
 *
 * 注意：AI Gateway 会往 geminiBaseUrl 后面拼接 /v1internal/xxx 路径，
 *      因此本 Worker 必须「原样透传路径」到 Google，不能自行重写。
 */

/** 目标上游：Gemini CLI 官方推理端点 */
const UPSTREAM_HOST = 'cloudcode-pa.googleapis.com'

/** 部署入口 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    // 兜底校验：仅允许把 /v1internal/ 路径转发给上游，杜绝任意跳转/SSRF
    if (!url.pathname.startsWith('/v1internal/')) {
      return new Response('Not Found', { status: 404 })
    }

    const upstreamUrl = `https://${UPSTREAM_HOST}` + url.pathname + url.search

    // 组装转发请求：带上 Authorization / x-goog-api-key 等认证头，去掉 Worker 自身可能带的 Host
    const headers = new Headers(request.headers)
    headers.set('Host', UPSTREAM_HOST)
    headers.delete('cf-connecting-ip')
    headers.delete('cf-ipcountry')

    const upstreamReq = new Request(upstreamUrl, {
      method: request.method,
      headers,
      body: (request.method === 'GET' || request.method === 'HEAD') ? undefined : request.body,
      redirect: 'manual',
    })

    let resp: Response
    try {
      resp = await fetch(upstreamReq)
    } catch (e) {
      return new Response(
        JSON.stringify({ error: { code: 502, message: 'relay upstream fetch failed', detail: String(e) } }),
        { status: 502, headers: { 'content-type': 'application/json' } }
      )
    }

    if (resp.status >= 500) {
      // 上游 5xx 直接透传错误体（保持 Google 原始错误 JSON 结构）
      return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers: stripHeaders(resp.headers, ['content-encoding', 'content-length', 'transfer-encoding']),
      })
    }

    // 正常（含流式 SSE 与非流式 JSON）响应：原样透传 body 与核心响应头
    const outHeaders = new Headers(resp.headers)
    // Cloudflare 会自动处理 chunked，这里移除会导致流式异常的受限头
    outHeaders.delete('content-encoding')
    outHeaders.delete('content-length')
    outHeaders.delete('transfer-encoding')

    // 保证 SSE 流能正确按 text/event-stream 透传
    const ctype = resp.headers.get('content-type') || 'application/json'
    outHeaders.set('content-type', ctype)

    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers: outHeaders,
    })
  },
}

/** 拷贝响应头（排除会破坏流式透传的受限/长度相关头） */
function stripHeaders(src: Headers, excluded: string[]): Headers {
  const h = new Headers()
  src.forEach((v, k) => {
    if (!excluded.includes(k.toLowerCase())) h.set(k, v)
  })
  return h
}

/** 绑定类型占位（当前未使用任何 binding；用 env 字段声明 Wrangler 类型提示） */
export interface Env {}