import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv, McpServer } from './types'
import { handleMcpJsonRpc, handleMcpHealth } from './mcp-gateway'

// mock storage.getMcps（mcp-gateway 只依赖这一个 storage 导出）
// vi.mock 会被提升到文件顶部，故用 vi.hoisted 声明 mock 引用
const { getMcpsMock } = vi.hoisted(() => ({ getMcpsMock: vi.fn() }))
vi.mock('./storage', () => ({ getMcps: getMcpsMock }))

/** 构造一个最小化 HTTP 响应替身，供 fetchMock 返回 */
function mkResp(data: unknown, ok = true, status = 200) {
  const text = typeof data === 'string' ? data : JSON.stringify(data)
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'ERR',
    text: async () => text,
  }
}

function makeApp() {
  const app = new Hono<AppEnv>()
  app.post('/v1/mcp', handleMcpJsonRpc)
  app.get('/v1/mcp/health', handleMcpHealth)
  return app
}

const fetchMock = vi.fn()
const env = {} as AppEnv

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  getMcpsMock.mockReset()
  fetchMock.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('tools/call 前缀路由（P0.1 回归：mcp 名含 `-`）', () => {
  it('mcp 名含 `-` 时仍能正确路由并还原工具名', async () => {
    const mcp: McpServer = {
      id: 'm1',
      name: 'my-tools',
      url: 'https://mcp.example.com',
      httpHeaders: {},
      enabled: true,
      createdAt: '',
      updatedAt: '',
    }
    getMcpsMock.mockResolvedValue([mcp])
    fetchMock.mockResolvedValue(mkResp({ jsonrpc: '2.0', result: { content: [] } }))

    const app = makeApp()
    const res = await app.request('/v1/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'my-tools-getUser', arguments: { id: 1 } },
      }),
    }, env)

    expect(res.status).toBe(200)
    const body = (await res.json() as any)
    expect(body.result).toEqual({ content: [] })
    // 上游收到的工具名应为去掉前缀后的原始名
    const callArgs = fetchMock.mock.calls[0]
    expect(callArgs[0]).toBe(mcp.url)
    const sent = JSON.parse(callArgs[1].body)
    expect(sent.params.name).toBe('getUser')
  })

  it('多个 MCP 前缀重叠时按最长前缀路由', async () => {
    const a: McpServer = { id: 'a', name: 'a', url: 'https://a.example.com', httpHeaders: {}, enabled: true, createdAt: '', updatedAt: '' }
    const ab: McpServer = { id: 'ab', name: 'a-b', url: 'https://ab.example.com', httpHeaders: {}, enabled: true, createdAt: '', updatedAt: '' }
    getMcpsMock.mockResolvedValue([a, ab])
    fetchMock.mockResolvedValue(mkResp({ jsonrpc: '2.0', result: { content: [] } }))

    const app = makeApp()
    const res = await app.request('/v1/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'a-b-x' } }),
    }, env)

    const callArgs = fetchMock.mock.calls[0]
    expect(callArgs[0]).toBe('https://ab.example.com')
    expect(JSON.parse(callArgs[1].body).params.name).toBe('x')
    expect(res.status).toBe(200)
  })

  it('无法路由到任何 MCP 时返回错误', async () => {
    getMcpsMock.mockResolvedValue([])
    const app = makeApp()
    const res = await app.request('/v1/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'no-such-tool' } }),
    }, env)

    expect(res.status).toBe(400)
    const body = (await res.json() as any)
    expect(body.error.code).toBe(-32602)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('tools/list 聚合', () => {
  it('单个 MCP 失败跳过，其余正常聚合并加前缀', async () => {
    const good: McpServer = { id: 'g', name: 'github', url: 'https://g.example', httpHeaders: {}, enabled: true, createdAt: '', updatedAt: '' }
    const bad: McpServer = { id: 'b', name: 'notion', url: 'https://b.example', httpHeaders: {}, enabled: true, createdAt: '', updatedAt: '' }
    getMcpsMock.mockResolvedValue([good, bad])
    fetchMock
      .mockResolvedValueOnce(mkResp({ jsonrpc: '2.0', result: { tools: [{ name: 'list_repos', description: '' }] } }))
      .mockResolvedValueOnce(mkResp('boom', false, 400))

    const app = makeApp()
    const res = await app.request('/v1/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }, env)

    expect(res.status).toBe(200)
    const body = (await res.json() as any)
    expect(body.result.tools).toEqual([expect.objectContaining({ name: 'github-list_repos' })])
  })

  it('全部 MCP 失败返回 502', async () => {
    const bad: McpServer = { id: 'b', name: 'notion', url: 'https://b.example', httpHeaders: {}, enabled: true, createdAt: '', updatedAt: '' }
    getMcpsMock.mockResolvedValue([bad])
    fetchMock.mockResolvedValue(mkResp('down', false, 400))

    const app = makeApp()
    const res = await app.request('/v1/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }, env)

    expect(res.status).toBe(502)
    const body = (await res.json() as any)
    expect(body.error.code).toBe(-32603)
  })

  it('30s 内相同配置命中缓存，不重复打上游', async () => {
    const good: McpServer = { id: 'c', name: 'cache-mcp', url: 'https://c.example', httpHeaders: {}, enabled: true, createdAt: '', updatedAt: '' }
    getMcpsMock.mockResolvedValue([good])
    fetchMock.mockResolvedValue(mkResp({ jsonrpc: '2.0', result: { tools: [{ name: 't' }] } }))

    const app = makeApp()
    const call = () =>
      app.request('/v1/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }, env)

    const r1 = await call()
    const r2 = await call()
    expect((await r1.json() as any).result.tools).toEqual([{ name: 'cache-mcp-t' }])
    expect((await r2.json() as any).result.tools).toEqual([{ name: 'cache-mcp-t' }])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('tools/call 响应归一化（P0.2）', () => {
  it('上游返回 SSE 时归一化为 JSON-RPC 响应', async () => {
    const mcp: McpServer = { id: 's', name: 'sse-mcp', url: 'https://s.example', httpHeaders: {}, enabled: true, createdAt: '', updatedAt: '' }
    getMcpsMock.mockResolvedValue([mcp])
    const sse = `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'hi' }] } })}\n\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: {} })}\n\n`
    // fetchMcpTools 之外的 tools/call 走的是文本（parseMcpResponseText 拼接所有 data: 行）
    fetchMock.mockResolvedValue(mkResp(sse))

    const app = makeApp()
    const res = await app.request('/v1/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'sse-mcp-do', arguments: {} } }),
    }, env)

    expect(res.status).toBe(200)
    const body = (await res.json() as any)
    // 最后一条 data: 行的 result 生效（parseMcpResponseText 按 data: 行拼接）
    expect(body.result).toEqual({})
  })
})

describe('/v1/mcp/health 排障端点', () => {
  it('汇总各 MCP 可达性与工具数，禁用项标记 disabled', async () => {
    const ok: McpServer = { id: 'o', name: 'ok-mcp', url: 'https://ok.example', httpHeaders: {}, enabled: true, createdAt: '', updatedAt: '' }
    const off: McpServer = { id: 'f', name: 'off-mcp', url: 'https://off.example', httpHeaders: {}, enabled: false, createdAt: '', updatedAt: '' }
    getMcpsMock.mockResolvedValue([ok, off])
    fetchMock.mockResolvedValue(mkResp({ jsonrpc: '2.0', result: { tools: [{ name: 'a' }, { name: 'b' }] } }))

    const app = makeApp()
    const res = await app.request('/v1/mcp/health', {}, env)

    expect(res.status).toBe(200)
    const body = (await res.json() as any)
    expect(body.total).toBe(2)
    expect(body.enabled).toBe(1)
    expect(body.healthyCount).toBe(1)
    expect(body.servers.find((s: { name: string }) => s.name === 'ok-mcp')).toMatchObject({ status: 'ok', tools: 2 })
    expect(body.servers.find((s: { name: string }) => s.name === 'off-mcp')).toMatchObject({ status: 'disabled' })
  })
})