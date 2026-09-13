import { describe, it, expect } from 'vitest'
import {
  extractLastUserPrompt,
  buildNativeTaskPayload,
  classifyTraeError,
} from './upstream'
import {
  workStreamToOpenAIStream,
  aggregateWorkSse,
} from './sse'
import {
  isTraeWorkHealthy,
  pickTraeWorkAccount,
  setTraeWorkCredits,
  cooldownTraeWorkAccount,
  noteTraeWorkError,
  noteTraeWorkSuccess,
  reenableTraeIfCredits,
} from './pool'
import { isWorkModel } from './constants'
import { proxyTraeChatRequest } from './proxy'
import type { TraeAccount, TraeAccountState } from './types'

describe('Trae Work: 常量与模型判定 (isWorkModel)', () => {
  it('带有 -work 或 -agent 后缀或 official 判定为 Work 模型', () => {
    expect(isWorkModel('claude-3-7-sonnet-work')).toBe(true)
    expect(isWorkModel('gpt-4o-agent')).toBe(true)
    expect(isWorkModel('DeepSeek-V4-Flash-Official')).toBe(true)
    expect(isWorkModel('work')).toBe(true)
  })

  it('普通模型判定为非 Work 模型', () => {
    expect(isWorkModel('claude-3-7-sonnet')).toBe(false)
    expect(isWorkModel('deepseek-v3')).toBe(false)
    expect(isWorkModel('glm-5.3')).toBe(false)
  })
})

describe('Trae Work: 错误归类 (classifyTraeError)', () => {
  it('将 4008 与 1005 正确归类为 plan_limit', () => {
    expect(classifyTraeError(4008, 'insufficient credits')).toBe('plan_limit')
    expect(classifyTraeError(200, '{"code":4008,"msg":"exceeded the quota"}')).toBe('plan_limit')
    expect(classifyTraeError(1005, 'quota exhausted')).toBe('plan_limit')
    expect(classifyTraeError(400, '{"code":1005,"msg":"plan limit"}')).toBe('plan_limit')
  })

  it('将 429 归类为 soft_rate', () => {
    expect(classifyTraeError(429, 'too many requests')).toBe('soft_rate')
  })

  it('将 401 归类为 session_dead', () => {
    expect(classifyTraeError(401, 'token expired')).toBe('session_dead')
    expect(classifyTraeError(401, 'unauthorized')).toBe('session_dead')
  })
})

describe('Trae Work: 提示词提取 (extractLastUserPrompt)', () => {
  it('从 messages 提取最后一条 user 消息纯文本', () => {
    const messages = [
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
      { role: 'user', content: 'Explain quantum computing' },
    ]
    expect(extractLastUserPrompt(messages)).toBe('Explain quantum computing')
  })

  it('从复合 content 数组中提取 text', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'First part. ' },
          { type: 'text', text: 'Second part.' },
        ],
      },
    ]
    expect(extractLastUserPrompt(messages)).toBe('First part. Second part.')
  })

  it('无 user 消息时返回降级文本', () => {
    const messages = [{ role: 'system', content: 'system only' }]
    expect(extractLastUserPrompt(messages)).toBe('你好')
  })
})

describe('Trae Work: 载荷构造 (buildNativeTaskPayload)', () => {
  const account: TraeAccount = {
    uid: 'test_uid',
    accessToken: 'token_123',
    refreshToken: 'ref_123',
    expiresAt: Date.now() + 3600_000,
    deviceId: 'device_abc',
  }

  it('生成合法原生 Work task 请求结构并剥离工作后缀', () => {
    const payload = buildNativeTaskPayload(account, 'claude-3-7-sonnet', 'Write a quicksort in Rust', 'conv_1', 'sess_1')

    expect(payload.conversation_id).toBe('conv_1')
    expect(payload.session_id).toBe('sess_1')
    expect(payload.user_id).toBe('test_uid')
    expect(payload.device_id).toBe('device_abc')
    expect(payload.model_name).toBe('claude-3-7-sonnet__dev')
    expect(payload.config_name).toBe('claude-3-7-sonnet')
    expect(payload.agent_type).toBe('solo_work_lite')
    expect(payload.mode_type).toBe(1)
    expect(payload.user_input?.messages[0].content).toBe('Write a quicksort in Rust')
  })

  it('若模型未指定则回退到默认并追加 __dev', () => {
    const payload = buildNativeTaskPayload(account, '', 'Test prompt')
    expect(payload.model_name).toContain('__dev')
  })
})

describe('Trae Work: 流式与非流式 SSE 协议转换 (sse.ts)', () => {
  it('workStreamToOpenAIStream 能够正确流式输出思考过程与最终输出并去重', async () => {
    const workEvents = [
      'event: plan_item\ndata: {"status": "start", "plan_title": "Thinking about rust implementation"}\n\n',
      'event: output\ndata: {"text": "Here is"}\n\n',
      'event: output\ndata: {"text": "Here is the code"}\n\n',
      'event: token_usage\ndata: {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30}\n\n',
      'data: [DONE]\n\n',
    ].join('')

    const upstreamStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(workEvents))
        controller.close()
      },
    })

    const transformedStream = workStreamToOpenAIStream(upstreamStream, 'claude-3-7-sonnet-work')
    const reader = transformedStream.getReader()
    const decoder = new TextDecoder()
    let aggregated = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      aggregated += decoder.decode(value)
    }

    expect(aggregated).toContain('[DONE]')
    expect(aggregated).toContain('chat.completion.chunk')
    // 思考过程输出在 reasoning_content 中
    expect(aggregated).toContain('reasoning_content')
    expect(aggregated).toContain('Thinking about rust implementation')
    // 正文输出在 content 中
    expect(aggregated).toContain('Here is')
    expect(aggregated).toContain('the code')
  })

  it('aggregateWorkSse 能够将 Work 流聚合为完整 Chat Completion 响应', () => {
    const workEvents = [
      'event: plan_item\ndata: {"status": "start", "plan_title": "Step 1: Plan"}\n\n',
      'event: output\ndata: {"text": "Hello world!"}\n\n',
      'event: token_usage\ndata: {"prompt_tokens": 15, "completion_tokens": 25, "total_tokens": 40}\n\n',
    ].join('')

    const result = aggregateWorkSse(workEvents, 'claude-3-7-sonnet')
    expect(result.err).toBeNull()
    expect(result.resp).not.toBeNull()
    expect(result.resp?.choices[0].message.role).toBe('assistant')
    expect(result.resp?.choices[0].message.content).toBe('Hello world!')
    expect(result.resp?.choices[0].message.reasoning_content).toBe('Step 1: Plan')
    expect(result.resp?.choices[0].finish_reason).toBe('stop')
    expect(result.resp?.usage?.total_tokens).toBe(40)
  })
})

describe('Trae Work: 账号池与状态机调度 (pool.ts)', () => {
  const fakeEnv = {
    KV: {
      data: new Map<string, string>(),
      async get(key: string) {
        return this.data.get(key) || null
      },
      async put(key: string, val: string) {
        this.data.set(key, val)
      },
      async delete(key: string) {
        this.data.delete(key)
      },
    },
  } as any

  const accountA: TraeAccount = {
    uid: 'user_a',
    accessToken: 'token_a',
    refreshToken: 'ref_a',
    expiresAt: Date.now() + 3600_000,
  }

  const accountB: TraeAccount = {
    uid: 'user_b',
    accessToken: 'token_b',
    refreshToken: 'ref_b',
    expiresAt: Date.now() + 3600_000,
  }

  it('isTraeWorkHealthy 正确判定 Work 通道健康状况', () => {
    const now = Date.now()
    const healthyState: TraeAccountState = {
      credits: 10,
      workCredits: 50,
      disabled: false,
      until: 0,
      errCount: 0,
      workUntil: 0,
    }
    expect(isTraeWorkHealthy(healthyState, now)).toBe(true)

    // 冷却中不可用
    const coolingState: TraeAccountState = {
      credits: 10,
      workCredits: 50,
      disabled: false,
      until: 0,
      errCount: 0,
      workUntil: now + 60_000,
    }
    expect(isTraeWorkHealthy(coolingState, now)).toBe(false)

    // 禁用不可用
    const disabledState: TraeAccountState = {
      credits: 10,
      workCredits: 50,
      disabled: true,
      until: 0,
      errCount: 0,
    }
    expect(isTraeWorkHealthy(disabledState, now)).toBe(false)
  })

  it('pickTraeWorkAccount 优先挑选 Work 积分最高的账号', async () => {
    // 设置 A 账号 20 分，B 账号 100 分
    await setTraeWorkCredits(fakeEnv, 'p1', 'user_a', 20)
    await setTraeWorkCredits(fakeEnv, 'p1', 'user_b', 100)

    const picked = await pickTraeWorkAccount(fakeEnv, 'p1', [accountA, accountB])
    expect(picked).not.toBeNull()
    expect(picked?.uid).toBe('user_b')

    // 排除 B 账号时，选择 A
    const pickedA = await pickTraeWorkAccount(fakeEnv, 'p1', [accountA, accountB], new Set(['user_b']))
    expect(pickedA?.uid).toBe('user_a')
  })

  it('cooldownTraeWorkAccount 与 noteTraeWorkError 状态演进', async () => {
    // 触发单次错误，未达 2 次阈值时暂不冷却
    await noteTraeWorkError(fakeEnv, 'p1', 'user_a', 2, 60_000)
    let picked = await pickTraeWorkAccount(fakeEnv, 'p1', [accountA])
    expect(picked?.uid).toBe('user_a')

    // 触发第 2 次错误，达到阈值，进入冷却
    await noteTraeWorkError(fakeEnv, 'p1', 'user_a', 2, 60_000)
    picked = await pickTraeWorkAccount(fakeEnv, 'p1', [accountA])
    expect(picked).toBeNull() // 已冷却，无法选取

    // 重新通过 reenable 恢复
    await reenableTraeIfCredits(fakeEnv, 'p1', 'user_a', 0, 50)
    picked = await pickTraeWorkAccount(fakeEnv, 'p1', [accountA])
    expect(picked?.uid).toBe('user_a')
  })

  it('reenableTraeIfCredits 能够同时唤醒 SOLO 与 Work 冷却账号', async () => {
    // 主动将账号冷却
    await cooldownTraeWorkAccount(fakeEnv, 'p1', 'user_a', 3600, 'plan_limit')
    let picked = await pickTraeWorkAccount(fakeEnv, 'p1', [accountA])
    expect(picked).toBeNull()

    // 充值或探测发现有余额，唤醒
    await reenableTraeIfCredits(fakeEnv, 'p1', 'user_a', 10, 50)
    picked = await pickTraeWorkAccount(fakeEnv, 'p1', [accountA])
    expect(picked?.uid).toBe('user_a')
  })
})

describe('Trae Work: 容灾降级与请求路由端到端 (proxyTraeChatRequest)', () => {
  const accountJson = JSON.stringify({
    uid: 'user_dual_credits',
    token: 'token_dual',
    refreshToken: 'ref_dual',
    expiresAt: Date.now() + 3600_000,
  })

  const testProvider: any = {
    id: 'trae-test-prov',
    name: 'TRAE Dual Provider',
    type: 'trae',
    apiKeys: [{ key: accountJson, enabled: true }],
  }

  it('显式请求 Work 专属模型时直通 Work 通道', async () => {
    const originalFetch = globalThis.fetch
    let hitWorkEndpoint = false

    globalThis.fetch = async (input: any, init?: any) => {
      const url = String(input)
      if (url.includes('/api/agent/v3/create_agent_task')) {
        hitWorkEndpoint = true
        const bodyText = 'event: output\ndata: {"text": "Hello from Work Agent"}\n\n'
        return new Response(bodyText, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      }
      return new Response('not found', { status: 404 })
    }

    try {
      const mockEnv: any = {
        KV: {
          data: new Map<string, string>(),
          async get(key: string) { return this.data.get(key) || null },
          async put(key: string, val: string) { this.data.set(key, val) },
          async delete(key: string) { this.data.delete(key) },
        },
      }

      // 给账号初始化 Work 积分
      await setTraeWorkCredits(mockEnv, testProvider.id, 'user_dual_credits', 80)

      const reqBody = {
        model: 'claude-3-7-sonnet-work',
        messages: [{ role: 'user', content: 'Say hi' }],
        stream: false,
      }

      const resp = await proxyTraeChatRequest(mockEnv, testProvider, reqBody)
      expect(hitWorkEndpoint).toBe(true)
      expect(resp.status).toBe(200)

      const json = await resp.json() as any
      expect(json.choices[0].message.content).toBe('Hello from Work Agent')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('SOLO 通道 4008 额度耗尽时，无缝自动降级到 Work 通道成功响应', async () => {
    const originalFetch = globalThis.fetch
    let soloCallCount = 0
    let workCallCount = 0

    globalThis.fetch = async (input: any, init?: any) => {
      const url = String(input)
      if (url.includes('/api/agent/v3/create_agent_task')) {
        workCallCount++
        const bodyText = 'event: output\ndata: {"text": "Answered via Work Failover"}\n\n'
        return new Response(bodyText, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      }
      if (url.includes('/api/agent/v3/llm_utils_chat') || url.includes('/chat')) {
        soloCallCount++
        // 模拟上游 SOLO 通道报 4008 积分耗尽
        return new Response(JSON.stringify({
          code: 4008,
          message: 'You have exceeded the quota. Please contact administrator or switch to Work.',
        }), { status: 400, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('not found', { status: 404 })
    }

    try {
      const mockEnv: any = {
        KV: {
          data: new Map<string, string>(),
          async get(key: string) { return this.data.get(key) || null },
          async put(key: string, val: string) { this.data.set(key, val) },
          async delete(key: string) { this.data.delete(key) },
        },
      }

      // 给账号初始化 Work 积分
      await setTraeWorkCredits(mockEnv, testProvider.id, 'user_dual_credits', 50)

      // 请求标准 SOLO 模型
      const reqBody = {
        model: 'glm-5.2',
        messages: [{ role: 'user', content: 'What is 1+1?' }],
        stream: false,
      }

      const resp = await proxyTraeChatRequest(mockEnv, testProvider, reqBody)
      // 验证 SOLO 通道被调用并失败
      expect(soloCallCount).toBeGreaterThan(0)
      // 核心断言：自动降级到了 Work 通道！
      expect(workCallCount).toBe(1)
      expect(resp.status).toBe(200)

      const json = await resp.json() as any
      expect(json.choices[0].message.content).toBe('Answered via Work Failover')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
