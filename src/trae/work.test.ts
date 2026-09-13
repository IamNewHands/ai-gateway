import { describe, it, expect } from 'vitest'
import {
  extractLastUserPrompt,
  buildNativeTaskPayload,
  classifyTraeError,
  extractCreditsFromChunk,
  probeTraeCredits,
  fetchUserEntUsageDetails,
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

describe('Trae Work: 积分块提取器 (extractCreditsFromChunk)', () => {
  it('从标准 SSE 块中提取 cn_credits_remain_info', () => {
    const chunk = 'data: {"cn_credits_remain_info":{"ide_credits":3487.3464,"work_credits":50.0}}\n\n'
    const snap = extractCreditsFromChunk(chunk)
    expect(snap).not.toBeNull()
    expect(snap?.ideCredits).toBe(3487.3464)
    expect(snap?.workCredits).toBe(50)
  })

  it('提取为 0 的 workCredits 并保留高精度 ideCredits', () => {
    const chunk = 'data: {"cn_credits_remain_info":{"ide_credits":3047.4284,"work_credits":0}}\n\n'
    const snap = extractCreditsFromChunk(chunk)
    expect(snap).not.toBeNull()
    expect(snap?.ideCredits).toBe(3047.4284)
    expect(snap?.workCredits).toBe(0)
  })

  it('从转义 JSON 字符串中精准提取', () => {
    const chunk = 'event: message\ndata: "{\\"cn_credits_remain_info\\":{\\"ide_credits\\":120.5,\\"work_credits\\":88.2}}"\n\n'
    const snap = extractCreditsFromChunk(chunk)
    expect(snap).not.toBeNull()
    expect(snap?.ideCredits).toBe(120.5)
    expect(snap?.workCredits).toBe(88.2)
  })

  it('无积分信息时返回 null', () => {
    const chunk = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'
    expect(extractCreditsFromChunk(chunk)).toBeNull()
  })
})

describe('Trae Work: 权益包分类 (fetchUserEntUsageDetails)', () => {
  const testAccount: TraeAccount = {
    uid: 'u_ent_1',
    accessToken: 'tok_ent',
    refreshToken: 'ref_ent',
    expiresAt: Date.now() + 10000,
    deviceId: 'dev_ent',
  }

  it('正确识别包含中文工作台与 Agent 的专属包', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({
        user_entitlement_pack_list: [
          {
            entitlement_base_info: { name: '通用日常包', quota: { credits_limit: 3000 } },
            usage: { credits_amount: 100.5 },
          },
          {
            entitlement_base_info: { name: 'Work工作台专属包', quota: { credits_limit: 500 } },
            usage: { credits_amount: 50 },
          },
          {
            entitlement_base_info: { name: '高级Agent特权', quota: { credits_limit: 200 } },
            usage: { credits_amount: 10 },
          },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    try {
      const res = await fetchUserEntUsageDetails(testAccount)
      // 通用包: 3000 - 100.5 = 2899.5
      expect(res.ideCredits).toBe(2899.5)
      // Work 包: (500 - 50) + (200 - 10) = 450 + 190 = 640
      expect(res.workCredits).toBe(640)
      expect(res.total).toBe(2899.5 + 640)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('Trae Work: 双通道实时探针 (probeTraeCredits)', () => {
  const testAccount: TraeAccount = {
    uid: 'u_probe_1',
    accessToken: 'tok_probe',
    refreshToken: 'ref_probe',
    expiresAt: Date.now() + 10000,
    deviceId: 'dev_probe',
  }

  it('优先在 api5-normal.mchost.guru 节点通过 Work 探针获取双通道积分', async () => {
    const originalFetch = globalThis.fetch
    let requestedHost = ''
    let requestedAppId = ''

    globalThis.fetch = async (input: any, init?: any) => {
      requestedHost = String(input)
      requestedAppId = (init?.headers as any)?.['X-App-Id'] || ''
      const body = 'data: {"cn_credits_remain_info":{"ide_credits":3487.3464,"work_credits":100.0}}\n\n'
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }

    try {
      const snap = await probeTraeCredits(testAccount)
      expect(requestedHost).toContain('api5-normal.mchost.guru')
      expect(requestedAppId).toBe('6eefa01c-1036-4c7e-9ca5-d891f63bfcd8')
      expect(snap).not.toBeNull()
      expect(snap?.ideCredits).toBe(3487.3464)
      expect(snap?.workCredits).toBe(100)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('首选节点网络异常时，平滑回退至备选节点探测', async () => {
    const originalFetch = globalThis.fetch
    let callCount = 0

    globalThis.fetch = async (input: any) => {
      callCount++
      const url = String(input)
      if (url.includes('api5-normal.mchost.guru')) {
        throw new Error('Connection timeout')
      }
      if (url.includes('trae-api-cn.mchost.guru')) {
        const body = 'data: {"cn_credits_remain_info":{"ide_credits":2500.0,"work_credits":60.0}}\n\n'
        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      }
      return new Response('not found', { status: 404 })
    }

    try {
      const snap = await probeTraeCredits(testAccount)
      expect(callCount).toBeGreaterThanOrEqual(2)
      expect(snap).not.toBeNull()
      expect(snap?.ideCredits).toBe(2500)
      expect(snap?.workCredits).toBe(60)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('当 Work 探针返回 4008 额度耗尽时，判定 workCredits 为 0 并拉取通用积分', async () => {
    const originalFetch = globalThis.fetch

    globalThis.fetch = async (input: any) => {
      const url = String(input)
      if (url.includes('/api/agent/v3/llm_utils_chat')) {
        return new Response(JSON.stringify({ code: 4008, message: 'Work quota exhausted' }), { status: 400 })
      }
      if (url.includes('/trae/api/v2/pay/ide_user_ent_usage')) {
        return new Response(JSON.stringify({
          user_entitlement_pack_list: [
            {
              entitlement_base_info: { name: 'SOLO通用包', quota: { credits_limit: 3487.3464 } },
              usage: { credits_amount: 0 },
            },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('not found', { status: 404 })
    }

    try {
      const snap = await probeTraeCredits(testAccount)
      expect(snap).not.toBeNull()
      expect(snap?.workCredits).toBe(0)
      expect(snap?.ideCredits).toBe(3487.3464)
      expect(snap?.status).toBe(400)
      expect(snap?.info).toContain('Work 专属额度用尽')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('fetchUserEntUsageDetails 能够精准提取各包明细与类型', async () => {
    const originalFetch = globalThis.fetch

    globalThis.fetch = async (input: any) => {
      const url = String(input)
      if (url.includes('/trae/api/v2/pay/ide_user_ent_usage')) {
        return new Response(JSON.stringify({
          user_entitlement_pack_list: [
            {
              entitlement_base_info: { name: '每日签到包', quota: { credits_limit: 3000 } },
              usage: { credits_amount: 100 },
              pack_type: 1,
            },
            {
              entitlement_base_info: { name: 'Trae Work 专属包', quota: { credits_limit: 2000 } },
              usage: { credits_amount: 50 },
              biz_type: 'work',
            },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('not found', { status: 404 })
    }

    try {
      const details = await fetchUserEntUsageDetails(testAccount)
      expect(details.ideCredits).toBe(2900)
      expect(details.workCredits).toBe(1950)
      expect(details.total).toBe(4850)
      expect(details.packs.length).toBe(2)
      expect(details.packs[0].name).toBe('每日签到包')
      expect(details.packs[0].rem).toBe(2900)
      expect(details.packs[0].isWork).toBe(false)
      expect(details.packs[1].name).toBe('Trae Work 专属包')
      expect(details.packs[1].rem).toBe(1950)
      expect(details.packs[1].isWork).toBe(true)
      expect(details.packs[1].bizType).toBe('work')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
