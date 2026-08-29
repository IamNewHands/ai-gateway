/**
 * Gemini 通用推理中转 Worker
 *
 * 目的：解决部分地区直连 Google Gemini 推理端点时被拒
 * （HTTP 400 User location is not supported）的问题。
 *
 * 本 Worker 部署在 Cloudflare 数据中心（出口为美国），把推理请求转发到 Google，
 * 并如实流式回传 SSE/JSON 响应。一条中转同时支持两条链路，按路径自动分流：
 *
 *   1. /v1internal/*（Gemini OAuth CLI 授权码链路）
 *        → cloudcode-pa.googleapis.com
 *        → 供 AI Gateway 提供商（Gemini 授权码）的 geminiBaseUrl 字段引用
 *   2. /v1beta/openai/*（Google 官方 API Key 链路，OpenAI 兼容端点）
 *        → generativelanguage.googleapis.com
 *        → 供 AI Gateway 提供商（Gemini 官方 API Key）的 baseUrl 字段引用
 *
 * 用法（AI Gateway 管理面板）：
 *   - API Key 提供商：把 baseUrl 填成本 Worker 部署地址，例如
 *       https://gemini-relay.你的用户名.workers.dev
 *     网关会拼 /v1beta/openai/chat/completions 请求，本 Worker 原样透传到 Google。
 *   - Gemini 授权码提供商：把「Gemini 推理中转地址」填成同一个部署地址。
 *
 * 注意：网关会往填写的地址后面拼接真实路径，因此本 Worker 必须「原样透传路径 + 查询」，
 *      只改 Host，不能重写路径。
 */

/** 上游路由：路径前缀 → 目标端点 */
const UPSTREAM_ROUTES: Array<{ prefix: string; host: string }> = [
  { prefix: '/v1internal/', host: 'cloudcode-pa.googleapis.com' },
  { prefix: '/v1beta/openai/', host: 'generativelanguage.googleapis.com' },
  { prefix: '/v1beta/', host: 'generativelanguage.googleapis.com' },
]

/** 部署入口 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    // 诊断端点：报告 Worker 回源出口 IP 与地区（用于确认是否已规避地区限制）
    if (url.pathname === '/__relay_info') {
      return handleRelayInfo()
    }

    // 按路径前缀挑选目标上游
    const route = UPSTREAM_ROUTES.find((r) => url.pathname.startsWith(r.prefix))
    if (!route) {
      return new Response(JSON.stringify({ error: { code: 404, message: 'unknown relay path: ' + url.pathname } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    }

    const upstreamUrl = `https://${route.host}` + url.pathname + url.search

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

    let resp: Response
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

/** 绑定类型占位（当前未使用任何 binding） */
export interface Env {}

/**
 * 诊断端点处理：查询本 Worker 回源 fetch 的出口 IP 与地区。
 * cloudflare.com/cdn-cgi/trace 返回当前请求的 IP / 所在地区。
 */
async function handleRelayInfo(): Promise<Response> {
  const info: Record<string, string> = {}
  try {
    const r = await fetch('https://cloudflare.com/cdn-cgi/trace')
    const trace = await r.text()
    const parse = (k: string) => trace.match(new RegExp(`^${k}=(.+)$`, 'm'))?.[1] || ''
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