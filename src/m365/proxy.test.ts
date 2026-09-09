import { describe, expect, it, vi } from 'vitest'
import type { Env, Provider } from '../types'
import { proxyM365ChatRequest } from './proxy'

function createProvider(): Provider {
  return {
    id: 'm365-provider',
    name: 'M365',
    baseUrl: '',
    apiKey: '',
    models: [],
    oauth: { flowType: 'm365-pkce' },
  } as unknown as Provider
}

function createEnv() {
  let forwardedInit: RequestInit | undefined
  const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    forwardedInit = init
    return new Response('ok', { status: 200 })
  })
  const idFromName = vi.fn((name: string) => ({ name }))
  const get = vi.fn(() => ({ fetch }))
  return {
    env: { M365_SESSION: { idFromName, get } } as unknown as Env,
    fetch,
    idFromName,
    get,
    forwardedInit: () => forwardedInit,
  }
}

describe('proxyM365ChatRequest model boundary', () => {
  it('rejects an unsupported model before addressing the Durable Object', async () => {
    const { env, idFromName, get, fetch } = createEnv()
    const body = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
      stream: false,
    }

    const response = await proxyM365ChatRequest(env, createProvider(), body)
    const payload = await response.json() as { error: { type: string; code: string } }

    expect(response.status).toBe(400)
    expect(payload.error).toEqual(expect.objectContaining({
      type: 'invalid_request_error',
      code: 'UNSUPPORTED_MODEL',
    }))
    expect(idFromName).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('normalizes a supported alias before forwarding to the Durable Object', async () => {
    const { env, fetch, idFromName, get, forwardedInit } = createEnv()
    const body = {
      model: ' GPT-5.6 ',
      messages: [{ role: 'user', content: 'hello' }],
      stream: false,
    }

    const response = await proxyM365ChatRequest(env, createProvider(), body, {
      explicitSessionId: 'session-1',
      tenant: 'tenant-1',
    })

    expect(response.status).toBe(200)
    expect(body.model).toBe('gpt-5.6-sol')
    expect(idFromName).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(1)

    const init = forwardedInit()
    expect(init).toBeDefined()
    const payload = JSON.parse(String(init?.body)) as {
      model: string
      body: { model: string }
      explicitSessionId?: string
      tenant?: string
    }
    expect(payload).toEqual(expect.objectContaining({
      model: 'gpt-5.6-sol',
      explicitSessionId: 'session-1',
      tenant: 'tenant-1',
      body: expect.objectContaining({ model: 'gpt-5.6-sol' }),
    }))
  })
})
