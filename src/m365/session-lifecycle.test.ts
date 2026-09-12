import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptySessionSnapshot } from './session-state'
import type { SessionSnapshotV1 } from './session-state'

const {
  chatWithHandlersMock,
  bindSessionMock,
  listM365AccountsMock,
  refreshM365AccountIfNeededMock,
  isRetryableMock,
  isRateLimitedMock,
  confirmAndMarkRateLimitMock,
} = vi.hoisted(() => ({
  chatWithHandlersMock: vi.fn(),
  bindSessionMock: vi.fn(),
  listM365AccountsMock: vi.fn(),
  refreshM365AccountIfNeededMock: vi.fn(),
  isRetryableMock: vi.fn(),
  isRateLimitedMock: vi.fn(),
  confirmAndMarkRateLimitMock: vi.fn(),
}))

vi.mock('./chathub', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chathub')>()
  return { ...actual, chatWithHandlers: chatWithHandlersMock }
})

vi.mock('./session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./session')>()
  return {
    ...actual,
    resolveSession: vi.fn(async (_env, _providerId, _messages, ctx) => ({
      sessionId: ctx.explicitSessionId || 'session-1',
      conversationId: '',
      accountId: '',
      matchedBy: 'new',
      isNew: true,
      historyLen: 0,
    })),
    bindSession: bindSessionMock,
    convCacheLookup: vi.fn(async () => null),
    convCacheStore: vi.fn(async () => undefined),
  }
})

vi.mock('./oauth', () => ({
  listM365Accounts: listM365AccountsMock,
  refreshM365AccountIfNeeded: refreshM365AccountIfNeededMock,
}))

vi.mock('./account-health', () => ({
  markAccountSuccess: vi.fn(async () => undefined),
  markAccountFailure: vi.fn(async () => undefined),
  markAccountImageLimited: vi.fn(async () => undefined),
  accountCooldownSeconds: vi.fn(async () => 0),
  isAccountAvailable: vi.fn(async () => true),
  isRateLimited: isRateLimitedMock,
  isAuthFailure: vi.fn(() => false),
  isEmptyCompletion: vi.fn(() => false),
  isRetryable: isRetryableMock,
  confirmAndMarkRateLimit: confirmAndMarkRateLimitMock,
}))

vi.mock('./account-flux', () => ({
  acquireSlot: vi.fn(async () => true),
  releaseSlot: vi.fn(async () => undefined),
  fluxSnapshot: vi.fn(async () => ({ limit: 8, inflight: {} })),
}))

vi.mock('./conversation-manager', () => ({
  recordConversation: vi.fn(async () => undefined),
  shouldCleanup: vi.fn(async () => false),
  cleanupConversations: vi.fn(async () => []),
  getCleanupMode: vi.fn(async () => 'keep-all'),
  getCleanupConfig: vi.fn(async () => ({ keepN: 10, maxAgeHours: 24 })),
}))

vi.mock('../admin', () => ({
  writeLog: vi.fn(async () => undefined),
  isM365DebugSseEnabled: vi.fn(async () => false),
}))

import { M365Session } from './durable'

type LifecycleCall =
  | 'load'
  | 'acquire-lease'
  | 'supersede-lease'
  | 'heartbeat-lease'
  | 'migrate-lease-account'
  | 'upstream'
  | 'commit'
  | 'release-lease'

type LifecycleStore = {
  loadOrCreate: ReturnType<typeof vi.fn>
  acquireLease: ReturnType<typeof vi.fn>
  supersedeLease: ReturnType<typeof vi.fn>
  heartbeatLease: ReturnType<typeof vi.fn>
  migrateLeaseAccount: ReturnType<typeof vi.fn>
  commitWithLease: ReturnType<typeof vi.fn>
  releaseLease: ReturnType<typeof vi.fn>
}

function createEnv() {
  return {
    KV: {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      list: vi.fn(async () => ({ keys: [], list_complete: true })),
    },
  }
}

function createSession(store: LifecycleStore): M365Session {
  const sql = {
    exec: vi.fn(() => ({
      toArray: () => [],
      rowsWritten: 0,
    })),
  }
  const session = new M365Session({ storage: { sql } } as unknown as DurableObjectState, createEnv() as never)
  ;(session as unknown as { sessionStore: LifecycleStore }).sessionStore = store
  return session
}

function createStore(calls: LifecycleCall[], snapshot: SessionSnapshotV1 = createEmptySessionSnapshot('session-1')): LifecycleStore {
  return {
    loadOrCreate: vi.fn(() => {
      calls.push('load')
      return snapshot
    }),
    acquireLease: vi.fn(() => {
      calls.push('acquire-lease')
      return { ok: true, expiresAt: Date.now() + 60_000 }
    }),
    // 默认：租约仍被正当持有（未过期、心跳新鲜），拒绝抢占。
    // 需要验证抢占路径的用例自行 mockImplementation 覆盖。
    supersedeLease: vi.fn(() => {
      calls.push('supersede-lease')
      return { ok: false, reason: 'lease_conflict', expiresAt: Date.now() + 60_000 }
    }),
    heartbeatLease: vi.fn(() => {
      calls.push('heartbeat-lease')
      return { ok: true, expiresAt: Date.now() + 60_000 }
    }),
    migrateLeaseAccount: vi.fn(() => {
      calls.push('migrate-lease-account')
      return { ok: true }
    }),
    commitWithLease: vi.fn(({ expectedGeneration }) => {
      calls.push('commit')
      return { ok: true, generation: expectedGeneration + 1 }
    }),
    releaseLease: vi.fn(() => {
      calls.push('release-lease')
      return { ok: true }
    }),
  }
}

function request(
  stream = false,
  model: unknown = 'gpt-5.6',
  body: Record<string, unknown> = { messages: [{ role: 'user', content: 'hello' }] },
): Request {
  return new Request('https://m365-session.local/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      providerId: 'm365-provider',
      model,
      body,
      stream,
      explicitSessionId: 'session-1',
      tenant: 'tenant-1',
    }),
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.clearAllMocks()
  listM365AccountsMock.mockResolvedValue([{
    accessToken: 'access-token',
    oid: 'account-1',
    tid: 'tenant-1',
    expiresAt: Date.now() + 60_000,
  }])
  refreshM365AccountIfNeededMock.mockImplementation(async (_env, _providerId, accountId) => ({
    accessToken: accountId === 'account-2' ? 'token-2' : 'access-token',
    oid: accountId,
    tid: accountId === 'account-2' ? 'tenant-2' : 'tenant-1',
    expiresAt: Date.now() + 60_000,
  }))
  isRetryableMock.mockReturnValue(false)
  isRateLimitedMock.mockReturnValue(false)
  confirmAndMarkRateLimitMock.mockResolvedValue(undefined)
  bindSessionMock.mockResolvedValue(undefined)
  chatWithHandlersMock.mockImplementation(async () => {
    return {
      text: 'done',
      reasoning: '',
      conversationId: 'conversation-1',
      sessionId: 'session-1',
      events: [],
      images: [],
    }
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('M365Session SQL request lifecycle', () => {
  it('rejects unsupported models at the Durable Object boundary without executing upstream', async () => {
    const calls: LifecycleCall[] = []
    const store = createStore(calls)

    const response = await createSession(store).fetch(request(false, 'gpt-4o'))
    const payload = await response.json() as { error: { type: string; code: string } }

    expect(response.status).toBe(400)
    expect(payload.error).toEqual(expect.objectContaining({
      type: 'invalid_request_error',
      code: 'UNSUPPORTED_MODEL',
    }))
    expect(chatWithHandlersMock).not.toHaveBeenCalled()
    expect(store.loadOrCreate).not.toHaveBeenCalled()
    expect(store.acquireLease).not.toHaveBeenCalled()
    expect(store.commitWithLease).not.toHaveBeenCalled()
  })

  it('rejects non-string models at the Durable Object boundary without executing upstream', async () => {
    const calls: LifecycleCall[] = []
    const store = createStore(calls)

    const response = await createSession(store).fetch(request(false, 56))
    const payload = await response.json() as { error: { type: string; code: string } }

    expect(response.status).toBe(400)
    expect(payload.error).toEqual(expect.objectContaining({
      type: 'invalid_request_error',
      code: 'UNSUPPORTED_MODEL',
    }))
    expect(chatWithHandlersMock).not.toHaveBeenCalled()
    expect(store.loadOrCreate).not.toHaveBeenCalled()
    expect(store.acquireLease).not.toHaveBeenCalled()
    expect(store.commitWithLease).not.toHaveBeenCalled()
  })

  it('loads, leases, locks, executes, commits the expected generation, then releases on success', async () => {
    const calls: LifecycleCall[] = []
    const snapshot = createEmptySessionSnapshot('session-1')
    snapshot.generation = 7
    const store = createStore(calls, snapshot)
    chatWithHandlersMock.mockImplementation(async () => {
      calls.push('upstream')
      return {
        text: 'done',
        reasoning: '',
        conversationId: 'conversation-1',
        sessionId: 'session-1',
        events: [],
        images: [],
      }
    })

    const response = await createSession(store).fetch(request())

    expect(response.status).toBe(200)
    expect(calls).toEqual([
      'load',
      'acquire-lease',
      'upstream',
      'commit',
      'release-lease',
    ])
    expect(store.acquireLease).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      accountId: 'account-1',
      expectedGeneration: 7,
    }))
    expect(store.commitWithLease).toHaveBeenCalledWith(expect.objectContaining({
      snapshot: expect.objectContaining({ sessionId: 'session-1' }),
      expectedGeneration: 7,
      leaseToken: expect.any(String),
    }))
  })

  it('commits the canonical business state produced by the successful request', async () => {
    const calls: LifecycleCall[] = []
    const snapshot = createEmptySessionSnapshot('session-1')
    const store = createStore(calls, snapshot)

    const response = await createSession(store).fetch(request())

    expect(response.status).toBe(200)
    expect(store.commitWithLease).toHaveBeenCalledWith(expect.objectContaining({
      snapshot: expect.objectContaining({
        sessionId: 'session-1',
        protocolTail: expect.objectContaining({
          protocol: 'chat',
          items: expect.arrayContaining([
            expect.objectContaining({
              role: 'assistant',
              content: 'done',
            }),
          ]),
        }),
      }),
      expectedGeneration: 0,
      leaseToken: expect.any(String),
    }))
  })

  it('renews the session lease during a long request', async () => {
    vi.useFakeTimers()
    const calls: LifecycleCall[] = []
    const store = createStore(calls)
    const upstream = deferred<{
      text: string
      reasoning: string
      conversationId: string
      sessionId: string
      events: never[]
      images: never[]
    }>()
    chatWithHandlersMock.mockReturnValue(upstream.promise)

    const responsePromise = createSession(store).fetch(request())
    await vi.advanceTimersByTimeAsync(0)
    expect(store.acquireLease).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(200_000)

    const leaseToken = store.acquireLease.mock.calls[0]?.[0].token
    expect(store.heartbeatLease).toHaveBeenCalledWith('session-1', leaseToken, expect.any(Number), 60_000)

    upstream.resolve({
      text: 'done',
      reasoning: '',
      conversationId: 'conversation-1',
      sessionId: 'session-1',
      events: [],
      images: [],
    })
    const response = await responsePromise

    expect(response.status).toBe(200)
    expect(store.commitWithLease).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not commit after the session lease heartbeat fails', async () => {
    vi.useFakeTimers()
    const calls: LifecycleCall[] = []
    const store = createStore(calls)
    const upstream = deferred<{
      text: string
      reasoning: string
      conversationId: string
      sessionId: string
      events: never[]
      images: never[]
    }>()
    store.heartbeatLease.mockReturnValue({ ok: false, reason: 'lease_conflict' })
    chatWithHandlersMock.mockReturnValue(upstream.promise)

    const responsePromise = createSession(store).fetch(request())
    await vi.advanceTimersByTimeAsync(0)
    expect(store.acquireLease).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(200_000)
    upstream.resolve({
      text: 'must not commit',
      reasoning: '',
      conversationId: 'conversation-1',
      sessionId: 'session-1',
      events: [],
      images: [],
    })
    const response = await responsePromise

    expect(response.status).toBe(409)
    expect(store.commitWithLease).not.toHaveBeenCalled()
    expect(store.releaseLease).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses router profile and mapped tone for the initial tool routing call', async () => {
    const calls: LifecycleCall[] = []
    const store = createStore(calls)
    chatWithHandlersMock
      .mockResolvedValueOnce({ text: '{"calls":[]}', reasoning: '', conversationId: 'router-conversation', sessionId: 'router-session', events: [], images: [] })
      .mockResolvedValueOnce({ text: 'done', reasoning: '', conversationId: 'conversation-1', sessionId: 'session-1', events: [], images: [] })

    const response = await createSession(store).fetch(request(false, 'gpt-5.6', {
      messages: [{ role: 'user', content: 'use the tool if needed' }],
      tools: [{ type: 'function', function: { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } } }],
      tool_choice: 'auto',
      reasoning_effort: 'high',
    }))

    expect(response.status).toBe(200)
    expect(chatWithHandlersMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      tone: 'Gpt_5_6_Reasoning',
      messageProfile: 'router',
    }))
  })

  it('keeps router profile and mapped tone on router JSON repair', async () => {
    const calls: LifecycleCall[] = []
    const store = createStore(calls)
    chatWithHandlersMock
      .mockResolvedValueOnce({ text: 'not-json', reasoning: '', conversationId: 'router-conversation', sessionId: 'router-session', events: [], images: [] })
      .mockResolvedValueOnce({ text: '{"calls":[]}', reasoning: '', conversationId: 'repair-conversation', sessionId: 'repair-session', events: [], images: [] })
      .mockResolvedValueOnce({ text: 'done', reasoning: '', conversationId: 'conversation-1', sessionId: 'session-1', events: [], images: [] })

    const response = await createSession(store).fetch(request(false, 'gpt-5.6', {
      messages: [{ role: 'user', content: 'use the tool if needed' }],
      tools: [{ type: 'function', function: { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } } }],
      tool_choice: 'auto',
      reasoning_effort: 'high',
    }))

    expect(response.status).toBe(200)
    expect(chatWithHandlersMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      tone: 'Gpt_5_6_Reasoning',
      messageProfile: 'router',
    }))
  })

  it('keeps router profile and mapped tone on required-tool retry', async () => {
    const calls: LifecycleCall[] = []
    const store = createStore(calls)
    chatWithHandlersMock
      .mockResolvedValueOnce({ text: '{"calls":[]}', reasoning: '', conversationId: 'router-conversation', sessionId: 'router-session', events: [], images: [] })
      .mockResolvedValueOnce({ text: '{"calls":[{"name":"read","arguments":{}}]}', reasoning: '', conversationId: 'retry-conversation', sessionId: 'retry-session', events: [], images: [] })

    const response = await createSession(store).fetch(request(false, 'gpt-5.6', {
      messages: [{ role: 'user', content: 'use the tool' }],
      tools: [{ type: 'function', function: { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } } }],
      tool_choice: 'required',
      reasoning_effort: 'high',
    }))

    expect(response.status).toBe(200)
    expect(chatWithHandlersMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      tone: 'Gpt_5_6_Reasoning',
      messageProfile: 'router',
    }))
  })
  it('uses answer profile and mapped tone for a non-tool main answer', async () => {
    const calls: LifecycleCall[] = []
    const store = createStore(calls)

    const response = await createSession(store).fetch(request(false, 'gpt-5.6', {
      messages: [{ role: 'user', content: 'hello' }],
      reasoning_effort: 'high',
    }))

    expect(response.status).toBe(200)
    expect(chatWithHandlersMock).toHaveBeenCalledTimes(1)
    expect(chatWithHandlersMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      tone: 'Gpt_5_6_Reasoning',
      messageProfile: 'answer',
    }))
  })

  it('uses caller_tool profile and preserves tool settings for the non-streaming main answer', async () => {
    const calls: LifecycleCall[] = []
    const store = createStore(calls)
    chatWithHandlersMock
      .mockResolvedValueOnce({ text: '{"calls":[]}', reasoning: '', conversationId: 'router-conversation', sessionId: 'router-session', events: [], images: [] })
      .mockResolvedValueOnce({ text: 'done', reasoning: '', conversationId: 'conversation-1', sessionId: 'session-1', events: [], images: [] })

    const response = await createSession(store).fetch(request(false, 'gpt-5.6', {
      messages: [{ role: 'user', content: 'use the tool if needed' }],
      tools: [{ type: 'function', function: { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } } }],
      tool_choice: 'auto',
      reasoning_effort: 'high',
      m365_mcp_server_url: 'https://mcp.example.test',
    }))

    expect(response.status).toBe(200)
    expect(chatWithHandlersMock).toHaveBeenCalledTimes(2)
    expect(chatWithHandlersMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      tools: [expect.objectContaining({ function: expect.objectContaining({ name: 'read' }) })],
      toolChoice: 'auto',
      tone: 'Gpt_5_6_Reasoning',
      messageProfile: 'caller_tool',
      mcpServerUrl: 'https://mcp.example.test',
    }))
  })
  it('preserves caller tool settings and tone on non-streaming correction retry', async () => {
    const calls: LifecycleCall[] = []
    const store = createStore(calls)
    chatWithHandlersMock
      .mockResolvedValueOnce({ text: '{"calls":[]}', reasoning: '', conversationId: 'router-conversation', sessionId: 'router-session', events: [], images: [] })
      .mockResolvedValueOnce({ text: 'tools are not available', reasoning: '', conversationId: 'conversation-1', sessionId: 'session-1', events: [], images: [] })
      .mockResolvedValueOnce({ text: 'corrected', reasoning: '', conversationId: 'conversation-1', sessionId: 'session-1', events: [], images: [] })

    const response = await createSession(store).fetch(request(false, 'gpt-5.6', {
      messages: [{ role: 'user', content: 'use the tool' }],
      tools: [{ type: 'function', function: { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } } }],
      tool_choice: 'auto',
      reasoning_effort: 'high',
      m365_mcp_server_url: 'https://mcp.example.test',
    }))

    expect(response.status).toBe(200)
    expect(chatWithHandlersMock).toHaveBeenCalledTimes(3)
    expect(chatWithHandlersMock.mock.calls[2]?.[1]).toEqual(expect.objectContaining({
      tools: [expect.objectContaining({ function: expect.objectContaining({ name: 'read' }) })],
      toolChoice: 'auto',
      tone: 'Gpt_5_6_Reasoning',
      messageProfile: 'caller_tool',
      mcpServerUrl: 'https://mcp.example.test',
    }))
  })
  it('releases the SQL lease when upstream execution throws', async () => {
    const calls: LifecycleCall[] = []
    const store = createStore(calls)
    chatWithHandlersMock.mockImplementation(async () => {
      calls.push('upstream')
      throw new Error('upstream exploded')
    })

    await createSession(store).fetch(request())

    expect(calls).toContain('release-lease')
    expect(calls.indexOf('release-lease')).toBeGreaterThan(calls.indexOf('upstream'))
    expect(store.commitWithLease).not.toHaveBeenCalled()
  })

  it('does not execute upstream or commit after a generation conflict while acquiring the lease', async () => {
    const calls: LifecycleCall[] = []
    const store = createStore(calls)
    store.acquireLease.mockImplementation(() => {
      calls.push('acquire-lease')
      return { ok: false, reason: 'generation_conflict', generation: 1 }
    })

    const response = await createSession(store).fetch(request())

    expect(response.status).toBe(409)
    expect(chatWithHandlersMock).not.toHaveBeenCalled()
    expect(store.commitWithLease).not.toHaveBeenCalled()
    expect(store.releaseLease).not.toHaveBeenCalled()
  })

  it('does not execute upstream or commit after a session lease conflict', async () => {
    const calls: LifecycleCall[] = []
    const store = createStore(calls)
    store.acquireLease.mockImplementation(() => {
      calls.push('acquire-lease')
      return { ok: false, reason: 'lease_conflict', expiresAt: Date.now() + 60_000 }
    })

    const response = await createSession(store).fetch(request())

    expect(response.status).toBe(409)
    expect(chatWithHandlersMock).not.toHaveBeenCalled()
    expect(store.commitWithLease).not.toHaveBeenCalled()
    expect(store.releaseLease).not.toHaveBeenCalled()
    // 租约确实被正当持有：应经有界重试后尝试抢占，但抢占被拒绝（未过期且心跳新鲜）
    expect(store.supersedeLease).toHaveBeenCalledTimes(1)
    // 409 lease_conflict 应给出基于租约到期时间的 Retry-After，让客户端按它退避重试而非立刻硬失败
    expect(response.headers.get('Retry-After')).toBeTruthy()
  })

  it('steals an abandoned lease so a retry after a crashed owner can proceed', async () => {
    const calls: LifecycleCall[] = []
    const store = createStore(calls)
    // 首次获取冲突（孤儿租约），有界重试仍冲突，抢占成功 → 请求应继续执行
    store.acquireLease.mockImplementation(() => {
      calls.push('acquire-lease')
      return { ok: false, reason: 'lease_conflict', expiresAt: Date.now() + 60_000 }
    })
    store.supersedeLease.mockImplementation(() => {
      calls.push('supersede-lease')
      return { ok: true, expiresAt: Date.now() + 60_000 }
    })

    const response = await createSession(store).fetch(request())

    expect(store.supersedeLease).toHaveBeenCalledTimes(1)
    // 抢占成功后必须继续走完生命周期，而不是把 409 抛给客户端
    expect(response.status).not.toBe(409)
  })

  it('commits streamed assistant output before releasing the session lease', async () => {
    const calls: LifecycleCall[] = []
    const store = createStore(calls)
    chatWithHandlersMock.mockImplementation(async (_account, _input, _options, onDelta) => {
      calls.push('upstream')
      onDelta?.('streamed done')
      return {
        text: 'streamed done',
        reasoning: '',
        conversationId: 'conversation-1',
        sessionId: 'session-1',
        events: [],
        images: [],
      }
    })

    const response = await createSession(store).fetch(request(true))
    await response.text()

    expect(store.commitWithLease).toHaveBeenCalledWith(expect.objectContaining({
      snapshot: expect.objectContaining({
        protocolTail: expect.objectContaining({
          protocol: 'chat',
          items: expect.arrayContaining([
            expect.objectContaining({ role: 'assistant', content: 'streamed done' }),
          ]),
        }),
      }),
      expectedGeneration: 0,
      leaseToken: expect.any(String),
    }))
    expect(calls).toEqual([
      'load',
      'acquire-lease',
      'upstream',
      'commit',
      'release-lease',
    ])
  })

  it('preserves caller tool settings and tone on streaming correction retry', async () => {
    const calls: LifecycleCall[] = []
    const store = createStore(calls)
    chatWithHandlersMock
      .mockResolvedValueOnce({ text: '{"calls":[]}', reasoning: '', conversationId: 'router-conversation', sessionId: 'router-session', events: [], images: [] })
      .mockImplementationOnce(async (_account, _input, _options, onDelta) => {
        onDelta?.('tools are not available')
        return { text: 'tools are not available', reasoning: '', conversationId: 'conversation-1', sessionId: 'session-1', events: [], images: [] }
      })
      .mockResolvedValueOnce({ text: 'corrected', reasoning: '', conversationId: 'conversation-1', sessionId: 'session-1', events: [], images: [] })

    const response = await createSession(store).fetch(request(true, 'gpt-5.6', {
      messages: [{ role: 'user', content: 'use the tool' }],
      tools: [{ type: 'function', function: { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } } }],
      tool_choice: 'auto',
      reasoning_effort: 'high',
      m365_mcp_server_url: 'https://mcp.example.test',
    }))
    await response.text()

    expect(response.status).toBe(200)
    expect(chatWithHandlersMock).toHaveBeenCalledTimes(3)
    expect(chatWithHandlersMock.mock.calls[2]?.[1]).toEqual(expect.objectContaining({
      tools: [expect.objectContaining({ function: expect.objectContaining({ name: 'read' }) })],
      toolChoice: 'auto',
      tone: 'Gpt_5_6_Reasoning',
      messageProfile: 'caller_tool',
      mcpServerUrl: 'https://mcp.example.test',
    }))
  })

  it('releases the account lock and session lease when streamed upstream execution fails', async () => {
    vi.useFakeTimers()
    const calls: LifecycleCall[] = []
    const store = createStore(calls)
    chatWithHandlersMock.mockImplementation(async () => {
      calls.push('upstream')
      throw new Error('stream exploded')
    })

    const response = await createSession(store).fetch(request(true))
    await response.text()

    expect(store.commitWithLease).not.toHaveBeenCalled()
    expect(calls).toEqual([
      'load',
      'acquire-lease',
      'upstream',
      'release-lease',
    ])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('migrates the session lease to the actual account during non-streaming failover', async () => {
    const calls: LifecycleCall[] = []
    const store = createStore(calls)
    listM365AccountsMock.mockResolvedValue([
      { accessToken: 'token-1', oid: 'account-1', tid: 'tenant-1', expiresAt: Date.now() + 60_000 },
      { accessToken: 'token-2', oid: 'account-2', tid: 'tenant-2', expiresAt: Date.now() + 60_000 },
    ])
    isRetryableMock.mockReturnValue(true)
    chatWithHandlersMock
      .mockRejectedValueOnce(new Error('temporary upstream failure'))
      .mockResolvedValueOnce({
        text: 'done from account 2',
        reasoning: '',
        conversationId: 'conversation-2',
        sessionId: 'session-1',
        events: [],
        images: [],
      })

    const response = await createSession(store).fetch(request())

    const leaseToken = store.acquireLease.mock.calls[0]?.[0].token

    expect(response.status).toBe(200)
    expect(chatWithHandlersMock.mock.calls.map((call) => call[0].oid)).toEqual(['account-1', 'account-2'])
    // 切号时必须把租约的账号绑定一起迁走，否则会话会跑在租约未记录的账号上
    expect(store.migrateLeaseAccount).toHaveBeenCalledWith(
      'session-1',
      leaseToken,
      'account-1',
      'account-2',
    )
    expect(bindSessionMock).toHaveBeenCalledWith(
      expect.anything(),
      'm365-provider',
      'session-1',
      'conversation-2',
      'account-2',
      expect.anything(),
      'done from account 2',
      expect.anything(),
    )
  })

  it('fails hard when failover lease migration fails instead of running on an unbound account', async () => {
    const calls: LifecycleCall[] = []
    const store = createStore(calls)
    listM365AccountsMock.mockResolvedValue([
      { accessToken: 'token-1', oid: 'account-1', tid: 'tenant-1', expiresAt: Date.now() + 60_000 },
      { accessToken: 'token-2', oid: 'account-2', tid: 'tenant-2', expiresAt: Date.now() + 60_000 },
    ])
    isRetryableMock.mockReturnValue(true)
    store.migrateLeaseAccount.mockReturnValue({ ok: false, reason: 'lease_conflict' })
    chatWithHandlersMock.mockRejectedValueOnce(new Error('temporary upstream failure'))

    const response = await createSession(store).fetch(request())

    // 迁移失败 = 租约与账号不一致。必须硬失败：若继续跑，请求会落在租约未记录的账号上，
    // 破坏"已绑定会话不换号"的归属约束（不能被换号掩盖）。
    expect(response.status).toBe(409)
    expect(store.commitWithLease).not.toHaveBeenCalled()
    // 只尝试过 account-1；迁移失败后不再在 account-2 上执行上游
    expect(chatWithHandlersMock).toHaveBeenCalledTimes(1)
    expect(chatWithHandlersMock.mock.calls.map((call) => call[0].oid)).toEqual(['account-1'])
    expect(store.releaseLease).toHaveBeenCalledTimes(1)
  })

  it('does not fail over after the first streaming account has emitted partial output', async () => {
    const calls: LifecycleCall[] = []
    const store = createStore(calls)
    listM365AccountsMock.mockResolvedValue([
      { accessToken: 'token-1', oid: 'account-1', tid: 'tenant-1', expiresAt: Date.now() + 60_000 },
      { accessToken: 'token-2', oid: 'account-2', tid: 'tenant-2', expiresAt: Date.now() + 60_000 },
    ])
    isRetryableMock.mockReturnValue(true)
    chatWithHandlersMock.mockImplementationOnce(async (_account, _input, _options, onDelta) => {
      onDelta?.('partial from account 1')
      throw new Error('temporary failure after partial output')
    })

    const response = await createSession(store).fetch(request(true))
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(body).toContain('partial from account 1')
    expect(body).not.toContain('streamed from account 2')
    expect(chatWithHandlersMock.mock.calls.map((call) => call[0].oid)).toEqual(['account-1'])
    expect(store.commitWithLease).not.toHaveBeenCalled()
    expect(bindSessionMock).not.toHaveBeenCalled()
  })

  it('fails over a new streaming session and migrates the lease to the successful account', async () => {
    vi.useFakeTimers()
    const calls: LifecycleCall[] = []
    const store = createStore(calls)
    listM365AccountsMock.mockResolvedValue([
      { accessToken: 'token-1', oid: 'account-1', tid: 'tenant-1', expiresAt: Date.now() + 60_000 },
      { accessToken: 'token-2', oid: 'account-2', tid: 'tenant-2', expiresAt: Date.now() + 60_000 },
    ])
    isRetryableMock.mockReturnValue(true)
    chatWithHandlersMock
      .mockRejectedValueOnce(new Error('temporary streaming failure'))
      .mockImplementationOnce(async (_account, _input, _options, onDelta) => {
        onDelta?.('streamed from account 2')
        return {
          text: 'streamed from account 2',
          reasoning: '',
          conversationId: 'conversation-2',
          sessionId: 'session-1',
          events: [],
          images: [],
        }
      })

    const response = await createSession(store).fetch(request(true))
    const body = await response.text()

    const leaseToken = store.acquireLease.mock.calls[0]?.[0].token

    expect(response.status).toBe(200)
    expect(body).toContain('streamed from account 2')
    expect(chatWithHandlersMock.mock.calls.map((call) => call[0].oid)).toEqual(['account-1', 'account-2'])
    expect(store.migrateLeaseAccount).toHaveBeenCalledWith(
      'session-1',
      leaseToken,
      'account-1',
      'account-2',
    )
    expect(store.commitWithLease).toHaveBeenCalledTimes(1)
    expect(bindSessionMock).toHaveBeenCalledWith(
      expect.anything(),
      'm365-provider',
      'session-1',
      'conversation-2',
      'account-2',
      expect.anything(),
      'streamed from account 2',
      expect.anything(),
    )
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses the mapped tone and answer profile for the rate-limit confirmation probe', async () => {
    const calls: LifecycleCall[] = []
    const store = createStore(calls)
    const rateLimitError = new Error('upstream rate limited')
    isRateLimitedMock.mockImplementation((value) => value === rateLimitError)
    confirmAndMarkRateLimitMock.mockImplementation(async (_env, _accountId, _error, probe) => probe())
    chatWithHandlersMock
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce({
        text: 'OK',
        reasoning: '',
        conversationId: 'probe-conversation',
        sessionId: 'probe-session',
        events: [],
        images: [],
      })

    await createSession(store).fetch(request(false, 'gpt-5.6', {
      messages: [{ role: 'user', content: 'hello' }],
      reasoning_effort: 'high',
    }))

    expect(confirmAndMarkRateLimitMock).toHaveBeenCalledTimes(1)
    expect(chatWithHandlersMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      text: 'Reply with exactly: OK',
      started: true,
      tone: 'Gpt_5_6_Reasoning',
      messageProfile: 'answer',
    }))
  })
})
