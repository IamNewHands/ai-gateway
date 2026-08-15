import { Context } from 'hono'
import { getMcps } from './storage'
import { isSafeHttpUrl } from './admin'
import type { AppEnv, McpServer } from './types'

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

const isRetryableStatus = (status: number) => status === 408 || status === 429 || status >= 500

/** 工具名前缀：mcp 名称的空格转下划线，与工具名用 `-` 分隔（与 aihub 一致） */
const mcpToolPrefix = (mcp: McpServer) => mcp.name.replaceAll(' ', '_')

/** 从命名空间前缀反解 MCP 名称（下划线转回空格，与 get-tools 加前缀规则对称） */
const mcpNameFromPrefix = (prefix: string) => prefix.replaceAll('_', ' ')

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

/** 解析上游响应：普通 JSON 或 SSE（data: 行拼接） */
function parseMcpResponseText(rawText: string): string {
  if (!rawText.includes('data:')) return rawText
  return rawText
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .join('')
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

      const results = await mapWithLimit(mcps, MCP_FETCH_CONCURRENCY, fetchMcpTools)
      const failed = results.filter((r) => r.error)
      const allTools = results.flatMap((r) =>
        r.error
          ? []
          : r.tools.map((t) => ({ ...t, name: `${mcpToolPrefix(r.mcp)}-${t.name}` }))
      )

      // 单个 MCP 失败跳过（其余正常聚合）；全部失败才报错
      if (allTools.length === 0 && failed.length > 0) {
        return c.json(
          rpcError(id, jsonrpc, -32603, `所有 MCP 拉取工具失败: ${failed.map((f) => `${f.mcp.name}(${f.error})`).join('; ')}`),
          502
        )
      }
      return c.json({ id, jsonrpc, result: { tools: allTools } })
    }

    case 'tools/call': {
      const params = body.params || {}
      const name = typeof params.name === 'string' ? params.name : ''
      if (name === '') {
        return c.json(rpcError(id, jsonrpc, -32602, 'Invalid params: missing tool name'), 400)
      }

      // 按第一个 `-` 拆分命名空间前缀与工具名（与 get-tools 加前缀规则一致）
      const sep = name.indexOf('-')
      if (sep === -1) {
        return c.json(rpcError(id, jsonrpc, -32602, `工具名格式错误 "${name}"，应为 {mcp名}-{工具名}`), 400)
      }
      const prefix = name.substring(0, sep)
      const toolName = name.substring(sep + 1)
      const mcpName = mcpNameFromPrefix(prefix)

      const mcp = (await getMcps(c.env)).find((m) => m.name === mcpName)
      if (!mcp) {
        return c.json(rpcError(id, jsonrpc, -32602, `MCP "${mcpName}" 不存在或未配置`), 404)
      }
      if (!mcp.enabled) {
        return c.json(rpcError(id, jsonrpc, -32602, `MCP "${mcpName}" 已禁用`), 403)
      }

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
          // 透传上游响应（JSON 或 SSE）
          return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: resp.headers })
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
