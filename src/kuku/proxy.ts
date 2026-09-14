import type { Provider } from '../types'
import { buildKukuSendBody, buildKukuStreamBody, buildKukuPrompt, type KukuSessionRef } from './body'
import { KUKU_CHANNEL, KUKU_TARGET, resolveKukuModel } from './constants'
import { buildKukuHeaders, buildKukuQuery, refreshKukuCredentials, type KukuCredentials, type KukuFetch } from './credentials'
import { KukuSSEParser, openAIChunk, openAICompletion } from './stream'

type ChatBody = Record<string, unknown>

interface PreparedRequest {
  model: string
  streamResponse: Response
}

function jsonError(message: string, status: number, type = 'invalid_request_error'): Response {
  return Response.json({ error: { message, type } }, { status })
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function excerpt(response: Response): Promise<string> {
  return (await response.text().catch(() => '')).slice(0, 240).replace(/\s+/g, ' ')
}

async function requireOk(response: Response, stage: string): Promise<Response> {
  if (!response.ok) {
    throw new Error(`Kuku ${stage} failed with HTTP ${response.status}: ${await excerpt(response)}`)
  }
  return response
}

function resolveThinkMode(provider: Provider): number {
  const value = provider.kukuThinkMode ?? 3
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > 10) {
    throw new Error('Kuku think mode must be an integer between 0 and 10')
  }
  return value
}

function validateBody(body: ChatBody): void {
  if (body.tools !== undefined || body.tool_choice !== undefined) {
    throw new Error('Kuku does not support tools or tool_choice yet')
  }
  if (body.functions !== undefined || body.function_call !== undefined) {
    throw new Error('Kuku does not support functions or function_call yet')
  }
}

export function isKukuProvider(provider: Pick<Provider, 'type'>): boolean {
  return provider.type === 'kuku'
}

async function createSession(
  provider: Provider,
  body: ChatBody,
  fetchImpl: KukuFetch,
  signal?: AbortSignal,
): Promise<PreparedRequest> {
  validateBody(body)
  const model = resolveKukuModel(body.model)
  const prompt = buildKukuPrompt(body.messages)
  const thinkMode = resolveThinkMode(provider)
  const credentials = await refreshKukuCredentials(provider, fetchImpl, signal)
  const clientSessionId = crypto.randomUUID()
  const query = buildKukuQuery(credentials)

  const sendResponse = await requireOk(await fetchImpl(
    `${KUKU_TARGET}/wenchain/genflowpro/sendmsg?${query}`,
    {
      method: 'POST',
      headers: buildKukuHeaders(credentials.cookie),
      body: JSON.stringify(buildKukuSendBody(prompt, model, thinkMode, clientSessionId, credentials)),
      signal,
    },
  ), 'sendmsg')
  const sendPayload = await sendResponse.json().catch(() => null) as {
    status?: { code?: number }
    data?: { session_id?: unknown; reply_id?: unknown }
  } | null
  if (sendPayload?.status?.code !== 0
    || typeof sendPayload.data?.session_id !== 'string'
    || typeof sendPayload.data?.reply_id !== 'string') {
    throw new Error('Kuku sendmsg returned an invalid session response')
  }

  const session: KukuSessionRef = {
    sessionId: sendPayload.data.session_id,
    replyId: sendPayload.data.reply_id,
    clientSessionId,
  }

  await requireOk(await fetchImpl(
    `${KUKU_TARGET}/wenchain/genflow/idallochstr?${query}`,
    {
      method: 'POST',
      headers: buildKukuHeaders(credentials.cookie),
      body: JSON.stringify({ channel: KUKU_CHANNEL, gen_type: 2 }),
      signal,
    },
  ), 'idallochstr')

  await fetchImpl(
    `${KUKU_TARGET}/api/genflowpro/workspace/sessionswitch?${query}`,
    {
      method: 'POST',
      headers: buildKukuHeaders(credentials.cookie),
      body: JSON.stringify({ session_id: session.sessionId, op: 1, full_access_enabled: 0 }),
      signal,
    },
  ).catch(() => undefined)

  const streamResponse = await requireOk(await fetchImpl(
    `${KUKU_TARGET}/wenchain/genflowpro/sse/getchatcontent?${query}`,
    {
      method: 'POST',
      headers: buildKukuHeaders(credentials.cookie, true),
      body: JSON.stringify(buildKukuStreamBody(prompt, model, thinkMode, session)),
      signal,
    },
  ), 'getchatcontent')

  if (!streamResponse.body) throw new Error('Kuku getchatcontent returned an empty stream')
  return { model, streamResponse }
}

function parseEvents(parser: KukuSSEParser, text: string, flush = false): { text: string; done: boolean } {
  let content = ''
  let done = false
  for (const event of parser.push(text, flush)) {
    if (event.type === 'delta') content += event.text || ''
    if (event.type === 'done') done = true
    if (event.type === 'error') throw new Error(`Kuku upstream ERROR event: ${event.error || 'unknown error'}`)
  }
  return { text: content, done }
}

async function collectResponse(response: Response): Promise<string> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const parser = new KukuSSEParser()
  let content = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    content += parseEvents(parser, decoder.decode(value, { stream: true })).text
  }
  content += parseEvents(parser, decoder.decode(), true).text
  return content
}

function streamingResponse(response: Response, model: string): Response {
  const id = `chatcmpl-${crypto.randomUUID()}`
  const output = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      const encoder = new TextEncoder()
      const parser = new KukuSSEParser()
      let ended = false
      try {
        while (!ended) {
          const { done, value } = await reader.read()
          if (done) break
          for (const event of parser.push(decoder.decode(value, { stream: true }))) {
            if (event.type === 'delta' && event.text) controller.enqueue(encoder.encode(openAIChunk(id, model, event.text)))
            if (event.type === 'done') ended = true
            if (event.type === 'error') throw new Error(`Kuku upstream ERROR event: ${event.error || 'unknown error'}`)
          }
        }
        if (!ended) {
          for (const event of parser.push(decoder.decode(), true)) {
            if (event.type === 'delta' && event.text) controller.enqueue(encoder.encode(openAIChunk(id, model, event.text)))
            if (event.type === 'error') throw new Error(`Kuku upstream ERROR event: ${event.error || 'unknown error'}`)
          }
        }
        controller.enqueue(encoder.encode(openAIChunk(id, model, '', 'stop')))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      } catch (error) {
        controller.error(new Error(safeMessage(error)))
      } finally {
        reader.releaseLock()
      }
    },
  })
  return new Response(output, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  })
}

export async function proxyKukuChatRequest(
  provider: Provider,
  body: ChatBody,
  fetchImpl: KukuFetch = fetch,
  signal?: AbortSignal,
): Promise<Response> {
  try {
    const prepared = await createSession(provider, body, fetchImpl, signal)
    if (body.stream === true) return streamingResponse(prepared.streamResponse, prepared.model)
    const content = await collectResponse(prepared.streamResponse)
    return Response.json(openAICompletion(`chatcmpl-${crypto.randomUUID()}`, prepared.model, content))
  } catch (error) {
    const message = safeMessage(error)
    const clientError = /requires at least one message|only supports text|does not support|Unsupported Kuku model|think mode|Invalid message/.test(message)
    return jsonError(message, clientError ? 400 : 502, clientError ? 'invalid_request_error' : 'upstream_error')
  }
}

export async function testKukuModel(
  provider: Provider,
  model: string,
  fetchImpl: KukuFetch = fetch,
): Promise<{ success: boolean; statusCode: number; message: string }> {
  const response = await proxyKukuChatRequest(provider, {
    model,
    messages: [{ role: 'user', content: 'hi' }],
    stream: false,
  }, fetchImpl)
  const message = response.ok ? '' : await response.clone().text().catch(() => `HTTP ${response.status}`)
  return { success: response.ok, statusCode: response.status, message }
}
