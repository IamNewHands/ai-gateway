import { Context } from 'hono'
import { getMcps } from './storage'
import { isSafeHttpUrl } from './admin'
import type { AppEnv, Env, McpServer } from './types'

/**
 * MCP 聚合网关（从 aihub 移植）。
 * 对外暴露统一 JSON-RPC 端点（/v1/mcp）：
 * - initialize / notifications/initialized：握手
 * - tools/list：并发聚合所有已启用 MCP Server 的工具，工具名加 `{mcp名(空格转下划线)}-{工具名}` 前缀做命名空间隔离
 * - tools/call：按前缀反解路由到目标 MCP Server，支持 SSE 响应，默认仅请求上游一次
 */

// ===== 极简并发限制器（p-limit 替代，避免新增依赖） =====
async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const worker = async () => {
    while (cursor < items.length) {
      const idx = cursor++
      results[idx] = await fn(items[idx])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

const MCP_JSONRPC_VERSION = '2.0'
const MCP_READ_FETCH_ATTEMPTS = 5
const MCP_RETRY_DELAY_MS = 1000
const MCP_FETCH_CONCURRENCY = 6
const MCP_FETCH_TIMEOUT_MS = 30_000

// tools/list 聚合结果的内存快照缓存：降低重复连接对上游的读放大。
// 与 storage.ts 的内存缓存同策略——多 isolate 下各实例独立，至多滞后一个 TTL（30s），对网关场景可接受。
const MCPS_TOOLS_CACHE_TTL_MS = 30_000
const mcpsToolsCache = new Map<string, { at: number; json: string }>()

/** 配置指纹：任一 mcp 的 name/url/enabled/httpHeaders 变化都会使缓存失效 */
function mcpsFingerprint(mcps: McpServer[]): string {
  return JSON.stringify(mcps.map((m) => ({ n: m.name, u: m.url, e: m.enabled, h: m.httpHeaders })))
}

const isRetryableStatus = (status: number) => status === 408 || status === 429 || status >= 500

/** 工具名前缀：mcp 名称的空格转下划线，与工具名用 `-` 分隔（与 aihub 一致） */
const mcpToolPrefix = (mcp: McpServer) => mcp.name.replaceAll(' ', '_')

/** JSON-RPC 错误响应 */
function rpcError(id: unknown, jsonrpc: unknown, code: number, message: string) {
  return { id: id ?? null, jsonrpc: jsonrpc ?? MCP_JSONRPC_VERSION, error: { code, message } }
}

/** 请求单个 MCP 的 HTTP 头（附加配置头 + Content-Type/Accept） */
function buildMcpHeaders(mcp: McpServer): Headers {
  const headers = new Headers()
  for (const [k, v] of Object.entries(mcp.httpHeaders || {})) {
    if (v !== undefined && v !== null) headers.set(k, String(v))
  }
  headers.set('Content-Type', 'application/json; charset=UTF-8')
  headers.set('Accept', 'application/json, text/event-stream')
  return headers
}

/**
 * 解析上游响应：普通 JSON 直接返回；SSE 场景下提取 JSON-RPC 负载。
 * - 单条 data: 或单条 JSON 拆多行 → 拼接后整体可解析即返回拼接结果；
 * - 存在多条独立 data:（如事件流 + 结果）→ 取最后一条能独立解析的 data:。
 */
function parseMcpResponseText(rawText: string): string {
  if (!rawText.includes('data:')) return rawText
  const lines = rawText
    .split('\n')
    .filter((l) => l.trim().startsWith('data:'))
    .map((l) => l.slice(l.indexOf('data:') + 5).trim())
  if (lines.length === 0) return rawText

  const joined = lines.join('')
  try {
    JSON.parse(joined)
    return joined
  } catch {
    /* 多行独立 JSON，走下面的逐条回退 */
  }
  // 从后往前取最后一条能独立解析的 data
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      JSON.parse(lines[i])
      return lines[i]
    } catch {
      /* 继续找更早的 data: 行 */
    }
  }
  return joined
}

/** 拉取单个 MCP 的 tools 列表（失败重试，返回错误信息供聚合方决定跳过/报错） */
async function fetchMcpTools(mcp: McpServer): Promise<{ mcp: McpServer; tools: Array<Record<string, unknown>>; error?: string }> {
  const headers = buildMcpHeaders(mcp)
  let lastError: string | null = null

  for (let i = 1; i <= MCP_READ_FETCH_ATTEMPTS; i++) {
    let shouldRetry = true
    try {
      const resp = await fetch(mcp.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: MCP_JSONRPC_VERSION, id: 1, method: 'tools/list' }),
        signal: AbortSignal.timeout(MCP_FETCH_TIMEOUT_MS),
      })
      if (resp.ok) {
        const rawJSON = parseMcpResponseText(await resp.text())
        const parsed = JSON.parse(rawJSON) as { result?: { tools?: unknown } }
        const tools = Array.isArray(parsed.result?.tools) ? (parsed.result.tools as Array<Record<string, unknown>>) : []
        return { mcp, tools }
      }
      shouldRetry = isRetryableStatus(resp.status)
      lastError = `HTTP ${resp.status}: ${(await resp.text()).substring(0, 200)}`
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
    if (!shouldRetry || i === MCP_READ_FETCH_ATTEMPTS) break
    await new Promise((r) => setTimeout(r, MCP_RETRY_DELAY_MS))
  }

  return { mcp, tools: [], error: lastError || '未知错误' }
}

/** 聚合拉取所有已启用 MCP 的工具（命名空间前缀 + 失败信息），供 tools/list 与 /v1/mcp/health 复用 */
async function fetchAllTools(
  env: Env
): Promise<{ tools: Array<Record<string, unknown>>; failed: Array<{ name: string; error: string }> }> {
  const mcps = (await getMcps(env)).filter((m) => m.enabled)
  if (mcps.length === 0) return { tools: [], failed: [] }
  const results = await mapWithLimit(mcps, MCP_FETCH_CONCURRENCY, fetchMcpTools)
  const failed = results.filter((r) => r.error).map((r) => ({ name: r.mcp.name, error: r.error as string }))
  const tools = results.flatMap((r) =>
    r.error ? [] : r.tools.map((t) => ({ ...t, name: `${mcpToolPrefix(r.mcp)}-${t.name}` }))
  )
  return { tools, failed }
}

/**
 * MCP JSON-RPC 统一端点。挂载于 /v1/mcp（proxyKeyAuthMiddleware 保护）。
 * 客户端示例（Claude Desktop / Cline / 任意 MCP 客户端）：
 *   POST https://<host>/v1/mcp  Authorization: Bearer <转发Key>
 */
export async function handleMcpJsonRpc(c: Context<AppEnv>): Promise<Response> {
  let body: { id?: unknown; jsonrpc?: string; method?: string; params?: Record<string, unknown> }
  try {
    body = await c.req.json()
  } catch {
    return c.json(rpcError(null, MCP_JSONRPC_VERSION, -32700, 'Parse error'), 400)
  }

  const id = body?.id ?? null
  const jsonrpc = body?.jsonrpc ?? MCP_JSONRPC_VERSION
  const method = body?.method

  if (typeof method !== 'string' || method === '') {
    return c.json(rpcError(id, jsonrpc, -32600, 'Invalid Request: missing method'), 400)
  }

  switch (method) {
    case 'initialize': {
      const protocolVersion = (body.params?.protocolVersion as string) || '2025-03-26'
      return c.json({
        id,
        jsonrpc,
        result: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'ai-gateway-mcp', version: '1.0.0' },
        },
      })
    }

    case 'notifications/initialized':
      // 通知类无返回值，返回 202 空响应
      return c.body(null, 202)

    case 'tools/list': {
      const mcps = (await getMcps(c.env)).filter((m) => m.enabled)
      if (mcps.length === 0) {
        return c.json({ id, jsonrpc, result: { tools: [] } })
      }

      // 30s 内相同配置直接命中缓存，避免每次客户端连接都实时打上游
      const fp = mcpsFingerprint(mcps)
      const now = Date.now()
      const cached = mcpsToolsCache.get(fp)
      if (cached && now - cached.at <= MCPS_TOOLS_CACHE_TTL_MS) {
        return c.json(JSON.parse(cached.json) as Record<string, unknown>)
      }

      const { tools, failed } = await fetchAllTools(c.env)

      // 单个 MCP 失败跳过（其余正常聚合）；全部失败才报错
      if (tools.length === 0 && failed.length > 0) {
        return c.json(
          rpcError(id, jsonrpc, -32603, `所有 MCP 拉取工具失败: ${failed.map((f) => `${f.name}(${f.error})`).join('; ')}`),
          502
        )
      }

      const payload = { id, jsonrpc, result: { tools } } as Record<string, unknown>
      mcpsToolsCache.set(fp, { at: now, json: JSON.stringify(payload) })
      return c.json(payload)
    }

    case 'tools/call': {
      const params = body.params || {}
      const name = typeof params.name === 'string' ? params.name : ''
      if (name === '') {
        return c.json(rpcError(id, jsonrpc, -32602, 'Invalid params: missing tool name'), 400)
      }

      // 最长前缀回查目标 MCP（而非按 `-` 拆分字符串）：MCP 客户端会原样回传 tools/list
      // 下发的 "{mcp名}-{工具名}"，这里只需在已配置 MCP 中定位前缀所指的来源，
      // 从而兼容 mcp 名 / 工具名里同时含 `-` 的情况。
      const mcps = (await getMcps(c.env)).filter((m) => m.enabled)
      let matched: { mcp: McpServer; toolName: string } | null = null
      let matchedPrefixLen = -1
      for (const m of mcps) {
        const prefix = `${mcpToolPrefix(m)}-`
        if (name.startsWith(prefix) && prefix.length > matchedPrefixLen) {
          matched = { mcp: m, toolName: name.slice(prefix.length) }
          matchedPrefixLen = prefix.length
        }
      }
      if (!matched) {
        return c.json(rpcError(id, jsonrpc, -32602, `无法路由到任何已启用 MCP，工具名 "${name}" 缺少正确的 "{mcp名}-{工具名}" 前缀`), 400)
      }
      const { mcp, toolName } = matched

      const headers = buildMcpHeaders(mcp)
      // 路由到目标 MCP 时，params.name 还原为原始工具名
      const upstreamBody = { ...body, params: { ...params, name: toolName } }
      let lastError: { status: number; data: string }

      try {
        const resp = await fetch(mcp.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(upstreamBody),
          signal: AbortSignal.timeout(MCP_FETCH_TIMEOUT_MS),
        })
        if (resp.ok) {
          // 归一化上游响应（JSON 或 SSE）：始终返回 JSON-RPC，避免客户端拿到裸 SSE 解析失败
          const raw = parseMcpResponseText(await resp.text())
          try {
            return c.json(JSON.parse(raw) as Record<string, unknown>)
          } catch {
            // 上游返回了无法归一化的内容，原样透传避免丢数据
            return new Response(raw, { status: resp.status, statusText: resp.statusText })
          }
        }
        lastError = { status: resp.status, data: (await resp.text()).substring(0, 500) }
      } catch (err) {
        lastError = { status: 500, data: err instanceof Error ? err.message : String(err) }
      }

      return c.json(
        rpcError(id, jsonrpc, -32603, `调用 MCP "${mcp.name}" 工具 "${toolName}" 失败: ${lastError.data || '未知错误'}`),
        (lastError.status || 502) as Parameters<typeof c.json>[1]
      )
    }

    default:
      return c.json(rpcError(id, jsonrpc, -32601, `Method not found: ${method}`), 404)
  }
}

/** 逐个实时探测每个已配置 MCP 的可达性与工具数（不缓存）。已禁用的不参与探测。 */
export async function probeMcpServers(env: Env): Promise<
  Array<{ name: string; url: string; enabled: boolean; status: 'ok' | 'error' | 'disabled'; error: string | null; tools: number }>
> {
  const all = await getMcps(env)
  return Promise.all(
    all.map(async (m) => {
      if (!m.enabled) return { name: m.name, url: m.url, enabled: false, status: 'disabled' as const, error: null, tools: 0 }
      const r = await fetchMcpTools(m) // 内部自带超时与重试
      return {
        name: m.name,
        url: m.url,
        enabled: true,
        status: (r.error ? 'error' : 'ok') as 'ok' | 'error',
        error: r.error ?? null,
        tools: r.error ? 0 : r.tools.length,
      }
    })
  )
}

/**
 * GET /v1/mcp/health —— 排障端点：返回每个已配置 MCP 的可达性与工具数，便于定位"哪个上游挂了"。
 */
export async function handleMcpHealth(c: Context<AppEnv>): Promise<Response> {
  const servers = await probeMcpServers(c.env)
  const active = servers.filter((s) => s.status === 'ok')
  const enabledCount = servers.filter((s) => s.enabled).length
  return c.json({
    healthy: enabledCount > 0 && active.length === enabledCount,
    total: servers.length,
    enabled: enabledCount,
    healthyCount: active.length,
    servers,
  })
}
