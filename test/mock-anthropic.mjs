/**
 * mock-anthropic.mjs — 本地测试用的 mock Anthropic 上游服务器
 *
 * 模拟 api.anthropic.com 的 POST /v1/messages 端点：
 * - 校验 x-api-key / anthropic-version 认证头
 * - 回显收到的请求体到 stdout（方便核对网关是否真的把请求转成了 Anthropic 原生格式）
 * - 支持非流式（Anthropic JSON）与流式（Anthropic named-event SSE）两种响应
 *
 * 用法：node test/mock-anthropic.mjs [port]
 */
import http from 'node:http'

const port = Number(process.argv[2] || 8788)

const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    // 记录请求（认证头 + 请求体），用于断言网关转换结果
    const xApiKey = req.headers['x-api-key'] || ''
    const anthropicVersion = req.headers['anthropic-version'] || ''
    const auth = req.headers['authorization'] || ''
    console.log(`[MOCK] ${req.method} ${req.url}`)
    console.log(`[MOCK] x-api-key=${xApiKey} anthropic-version=${anthropicVersion} authorization=${auth ? 'PRESENT' : '(none)'}`)
    console.log(`[MOCK] body=${raw}`)

    if (req.url !== '/v1/messages' || req.method !== 'POST') {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'not found' } }))
      return
    }

    // 认证头校验：应使用 Anthropic 的 x-api-key，而不是 Authorization Bearer
    if (!xApiKey) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'x-api-key required' } }))
      return
    }

    let body = {}
    try { body = JSON.parse(raw || '{}') } catch {}

    const stream = body['stream'] === true
    const model = body['model'] || 'mock-model'
    const maxTokens = body['max_tokens'] ?? 128
    const msgCount = Array.isArray(body['messages']) ? body['messages'].length : 0
    const hasSystem = typeof body['system'] === 'string' && body['system'].length > 0

    res.writeHead(200, {
      'Content-Type': stream ? 'text/event-stream' : 'application/json',
      'Cache-Control': 'no-store',
    })

    if (stream) {
      const blockId = 'blk_mock_01'
      const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 }
      const events = [
        ['message_start', { type: 'message_start', message: { id: 'msg_mock_01', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好，这是 mock 的流式响应。' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
        ['message_stop', { type: 'message_stop' }],
      ]
      for (const [evt, data] of events) {
        res.write(`event: ${evt}\n`)
        res.write(`data: ${JSON.stringify(data)}\n\n`)
      }
      res.end()
    } else {
      const payload = {
        id: 'msg_mock_01',
        type: 'message',
        role: 'assistant',
        model,
        content: [{ type: 'text', text: '你好，这是 mock 的非流式响应。' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 },
      }
      console.log(`[MOCK] REPLY stream=${stream} max_tokens=${maxTokens} messages=${msgCount} system=${hasSystem} → ${JSON.stringify(payload)}`)
      res.end(JSON.stringify(payload))
    }
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[MOCK] Anthropic mock listening on http://127.0.0.1:${port}`)
})
