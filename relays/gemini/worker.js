/**
 * Gemini 通用推理中转 Worker（纯 JS 版，可直接粘贴到 Cloudflare 面板部署）
 *
 * 按路径前缀自动分流到两个 Google 端点：
 *   - /v1internal/*      → cloudcode-pa.googleapis.com       （Gemini OAuth CLI 链路）
 *   - /v1beta/openai/*、/v1beta/* → generativelanguage.googleapis.com（API Key 链路）
 *   - /chat/completions、/responses、/embeddings（裸 OpenAI 路径）也改写映射到 API Key 端点
 *
 * 部署后 GET /__relay_info 可查看回源出口 IP 与地区。
 */

// 上游路由：路径前缀 → 目标端点；rewriteTo 存在时把原路径改写为 OpenAI 兼容前缀
const UPSTREAM_ROUTES = [
  { prefix: '/v1internal/', host: 'cloudcode-pa.googleapis.com' },
  { prefix: '/v1beta/openai/', host: 'generativelanguage.googleapis.com' },
  { prefix: '/v1beta/', host: 'generativelanguage.googleapis.com' },
  // OpenAI 兼容裸路径兜底：网关拼 /chat/completions、/responses、/embeddings 时，
  // 改写映射到官方 OpenAI 兼容端点（/v1beta/openai/...）
  { prefix: '/chat/completions', host: 'generativelanguage.googleapis.com', rewriteTo: '/v1beta/openai/chat/completions' },
  { prefix: '/responses', host: 'generativelanguage.googleapis.com', rewriteTo: '/v1beta/openai/responses' },
  { prefix: '/embeddings', host: 'generativelanguage.googleapis.com', rewriteTo: '/v1beta/openai/embeddings' },
]

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    // 诊断端点：报告 Worker 回源出口 IP 与地区
    if (url.pathname === '/__relay_info') {
      return handleRelayInfo()
    }

    // 按路径前缀挑选目标上游
    const route = UPSTREAM_ROUTES.find((r) => url.pathname.startsWith(r.prefix))
    if (!route) {
      return new Response(
        JSON.stringify({ error: { code: 404, message: 'unknown relay path: ' + url.pathname } }),
        { status: 404, headers: { 'content-type': 'application/json' } }
      )
    }

    // 目标路径：默认原样透传；若配置了 rewriteTo 则替换（保留查询串）
    const upstreamPath = route.rewriteTo ?? url.pathname
    const upstreamUrl = 'https://' + route.host + upstreamPath + url.search

    // 组装转发请求：带上 Authorization / x-goog-api-key 等认证头，去掉 Worker 自身可能带来的头
    const headers = new Headers(request.headers)
    headers.set('Host', route.host)
    headers.delete('cf-connecting-ip')
    headers.delete('cf-ipcountry')
    headers.delete('cf-ray')

    const upstreamReq = new Request(upstreamUrl, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual',
    })

    let resp
    try {
      resp = await fetch(upstreamReq)
    } catch (e) {
      return new Response(
        JSON.stringify({ error: { code: 502, message: 'relay upstream fetch failed', detail: String(e) } }),
        { status: 502, headers: { 'content-type': 'application/json' } }
      )
    }

    // 透传响应：去掉会破坏流式/受限数据传输的头，保留 SSE 语义
    const outHeaders = new Headers(resp.headers)
    outHeaders.delete('content-encoding')
    outHeaders.delete('content-length')
    outHeaders.delete('transfer-encoding')
    const ctype = resp.headers.get('content-type') || 'application/json'
    outHeaders.set('content-type', ctype)

    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers: outHeaders,
    })
  },
}

// 诊断端点处理：查询本 Worker 回源 fetch 的出口 IP 与地区
async function handleRelayInfo() {
  const info = {}
  try {
    const r = await fetch('https://cloudflare.com/cdn-cgi/trace')
    const trace = await r.text()
    const parse = (k) => trace.match(new RegExp('^' + k + '=(.+)$', 'm'))?.[1] || ''
    info.ip = parse('ip')
    info.loc = parse('loc')
    info.colo = parse('colo')
    info.warp = parse('warp')
  } catch (e) {
    info.error = String(e)
  }
  return new Response(JSON.stringify(info, null, 2), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}