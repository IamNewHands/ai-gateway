/**
 * remote.test.ts — TRAE Remote 传输客户端。
 *
 * 本文件覆盖三类「判错就会静默换模型 / 静默失败」的边界：
 *  1. **基址补全**：少了 `/api/remote/v1` 会 404，而 404 在本仓被分类成 `not_found`
 *     （短冷却换号）—— 排查时会一路怀疑账号，真因却是 URL。
 *  2. **模型绑定**：上游解析出的模型族与请求不符时必须**抛错**，绝不能静默用别的模型回答
 *     （用户偏好：不许网关偷偷换模型）。
 *  3. **首事件死线**：心跳不算「已产出」，否则一次卡死的会话会耗掉整个流超时。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  boundRemoteModelName,
  buildRemoteCommonParams,
  createRemoteSession,
  enrichMaxModeConfig,
  maxModeFields,
  maxModeRequested,
  normalizeRemoteEventName,
  normalizeTraeRemoteBase,
  remoteAgentType,
  remoteHeaders,
  remoteModelFamily,
  remoteModelSessionId,
  resolveRemoteMode,
  resolveRemoteModelConfig,
  streamRemoteEvents,
  RemoteFirstEventError,
  RemoteFirstEventTimeout,
  RemoteStreamIncomplete,
} from './remote'
import { flattenTraeQuery } from './payload'
import type { CreateRemoteSessionOptions } from './remote'
import type { TraeAccount, TraeRemoteEvent, TraeRemoteModelConfig } from './types'

const ACCOUNT: TraeAccount = {
  accessToken: 'tok-abc',
  refreshToken: 'ref-abc',
  expiresAt: 0,
  uid: 'user-1',
  deviceId: 'dev-1',
}

/** 造一个 Remote 模型目录条目（镜像 remote.ts 的 buildRemoteModelConfig 字段映射）。 */
function model(name: string, extra: Record<string, any> = {}): TraeRemoteModelConfig {
  const raw = { name, config_name: name, model_name: name, config_source: 1, ...extra }
  return {
    name,
    displayName: String(extra['display_name'] ?? extra['display_model_name'] ?? '').trim() || undefined,
    configSource: 1,
    multimodal: false,
    maxMode: Boolean(extra['max_mode']),
    reasoningEffortConfig: extra['reasoning_effort_config'],
    raw,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('normalizeTraeRemoteBase：补全 /api/remote/v1', () => {
  it('已知 Trae 主机只有 host 时补上规范路径', () => {
    expect(normalizeTraeRemoteBase('https://trae-api-cn.mchost.guru'))
      .toBe('https://trae-api-cn.mchost.guru/api/remote/v1')
    expect(normalizeTraeRemoteBase('https://core-normal.trae.cn'))
      .toBe('https://core-normal.trae.cn/api/remote/v1')
    expect(normalizeTraeRemoteBase('https://x.trae.ai'))
      .toBe('https://x.trae.ai/api/remote/v1')
  })

  it('已含 /api/remote/ → 原样保留（不重复追加）', () => {
    const url = 'https://trae-api-cn.mchost.guru/api/remote/v1'
    expect(normalizeTraeRemoteBase(url)).toBe(url)
  })

  it('自定义主机原样保留（不猜路径）', () => {
    expect(normalizeTraeRemoteBase('https://my-proxy.example.com/relay'))
      .toBe('https://my-proxy.example.com/relay')
  })

  it('空值 → 内置默认', () => {
    expect(normalizeTraeRemoteBase('')).toBe('https://trae-api-cn.mchost.guru/api/remote/v1')
    expect(normalizeTraeRemoteBase(null)).toBe('https://trae-api-cn.mchost.guru/api/remote/v1')
  })

  it('去掉尾部斜杠', () => {
    expect(normalizeTraeRemoteBase('https://trae-api-cn.mchost.guru/'))
      .toBe('https://trae-api-cn.mchost.guru/api/remote/v1')
  })
})

describe('resolveRemoteMode：模型名 → 模式/策略', () => {
  it('具名模型 → code + manual（manual 必须解析 custom_model）', () => {
    expect(resolveRemoteMode('DeepSeek-V4-Pro')).toEqual({
      mode: 'code', strategy: 'manual', modelName: 'DeepSeek-V4-Pro',
    })
  })

  it('work / auto-work / solo-work → work 模式 + auto', () => {
    for (const name of ['work', 'auto-work', 'solo-work']) {
      expect(resolveRemoteMode(name).mode).toBe('work')
      expect(resolveRemoteMode(name).strategy).toBe('auto')
    }
  })

  it('空 / auto → code + auto', () => {
    expect(resolveRemoteMode('').strategy).toBe('auto')
    expect(resolveRemoteMode('auto').strategy).toBe('auto')
  })
})

describe('remoteAgentType：executor 档位', () => {
  it('默认具名模型 → solo_agent_remote', () => {
    expect(remoteAgentType('DeepSeek-V4-Pro')).toBe('solo_agent_remote')
  })

  it('work 模式 → solo_work_remote', () => {
    expect(remoteAgentType('work')).toBe('solo_work_remote')
  })

  it('显式覆盖优先（含 lite 别名）', () => {
    expect(remoteAgentType('DeepSeek-V4-Pro', 'solo_work_remote')).toBe('solo_work_remote')
    expect(remoteAgentType('work', 'solo_agent_remote')).toBe('solo_agent_remote')
    expect(remoteAgentType('x', 'work')).toBe('solo_work_remote')
    expect(remoteAgentType('x', 'agent')).toBe('solo_agent_remote')
  })
})

describe('remoteHeaders：web 身份（不得复用 soloHeaders 的 IDE 身份）', () => {
  it('带 Cloud-IDE-JWT 授权 + 浏览器 UA + web 客户端类型', () => {
    const h = remoteHeaders(ACCOUNT, true)
    expect(h['Authorization']).toBe('Cloud-IDE-JWT tok-abc')
    expect(h['X-Trae-Client-Type']).toBe('web')
    expect(h['User-Agent']).toContain('Chrome/149')
    expect(h['Accept']).toBe('text/event-stream')
    expect(h['Origin']).toBe('https://solo.trae.cn')
  })

  it('非流式 → Accept: application/json', () => {
    expect(remoteHeaders(ACCOUNT, false)['Accept']).toBe('application/json')
  })

  it('Work 档位用 lite 客户端身份', () => {
    expect(remoteHeaders(ACCOUNT, true, { agentType: 'solo_work_remote' })['X-Trae-Client-Type']).toBe('lite')
  })

  it('国际站基址 → en / US / solo.trae.ai', () => {
    const h = remoteHeaders(ACCOUNT, true, { baseUrl: 'https://x.trae.ai/api/remote/v1' })
    expect(h['X-Preferenced-Language']).toBe('en')
    expect(h['x-user-region']).toBe('US')
    expect(h['Origin']).toBe('https://solo.trae.ai')
  })
})

describe('remoteModelFamily / boundRemoteModelName：模型绑定校验', () => {
  it('族名归一：去 trae/ 前缀、去 __suffix、下划线转横线、去 -official', () => {
    expect(remoteModelFamily('trae/DeepSeek-V4-Pro')).toBe('deepseek-v4-pro')
    expect(remoteModelFamily('DeepSeek-V4-Pro__dev')).toBe('deepseek-v4-pro')
    expect(remoteModelFamily('deepseek_v4_pro')).toBe('deepseek-v4-pro')
    expect(remoteModelFamily('DeepSeek-V4-Flash-Official')).toBe('deepseek-v4-flash')
    expect(remoteModelFamily('DeepSeek-V4-Flash-20260101')).toBe('deepseek-v4-flash')
  })

  it('同族 → 返回上游 config id', () => {
    expect(boundRemoteModelName('DeepSeek-V4-Pro', model('DeepSeek-V4-Pro'))).toBe('DeepSeek-V4-Pro')
  })

  it('大小写/后缀差异仍视为同族', () => {
    expect(boundRemoteModelName('deepseek-v4-pro', model('DeepSeek-V4-Pro-20260101')))
      .toBe('DeepSeek-V4-Pro-20260101')
  })

  it('**族不符必须抛错**——绝不静默换模型（用户硬约束）', () => {
    expect(() => boundRemoteModelName('DeepSeek-V4-Pro', model('kimi-k3')))
      .toThrow(/binding mismatch/)
  })

  it('目录里没有该模型 → resolveRemoteModelConfig 返回 null（调用方据此报错）', () => {
    const models = { 'kimi-k3': model('kimi-k3') }
    expect(resolveRemoteModelConfig(models, 'DeepSeek-V4-Pro')).toBeNull()
  })
})

describe('resolveRemoteModelConfig：查找顺序', () => {
  const models = {
    'DeepSeek-V4-Pro': model('DeepSeek-V4-Pro'),
    'kimi-k3': model('kimi-k3', { display_name: 'Kimi K3' }),
  }

  it('精确 config_name 优先', () => {
    expect(resolveRemoteModelConfig(models, 'DeepSeek-V4-Pro')?.name).toBe('DeepSeek-V4-Pro')
  })

  it('大小写不敏感', () => {
    expect(resolveRemoteModelConfig(models, 'deepseek-v4-pro')?.name).toBe('DeepSeek-V4-Pro')
  })

  it('display_name 精确命中', () => {
    expect(resolveRemoteModelConfig(models, 'Kimi K3')?.name).toBe('kimi-k3')
  })
})

describe('max mode：三重前提', () => {
  it('Work 档位一律不开（Work 没有 1M 配置）', () => {
    expect(maxModeRequested('m', model('m', { max_mode: true }), { agentType: 'solo_work_remote', enabled: true })).toBe(false)
  })

  it('未显式要求 → 不开', () => {
    expect(maxModeRequested('m', model('m', { max_mode: true }), { agentType: 'solo_agent_remote', enabled: false })).toBe(false)
  })

  it('上游账号没标记 max_mode → 不开（不凭空造 1M 上限）', () => {
    expect(maxModeRequested('m', model('m'), { agentType: 'solo_agent_remote', enabled: true })).toBe(false)
  })

  it('三条全中 → 开', () => {
    expect(maxModeRequested('m', model('m', { max_mode: true }), { agentType: 'solo_agent_remote', enabled: true })).toBe(true)
  })

  it('enrichMaxModeConfig 补全验证 1M 会话所需的字段', () => {
    const enriched = enrichMaxModeConfig(model('m', { max_mode: true, context_window_tokens: { max: 1_000_000 } }))
    expect(enriched['max_mode']).toBe(true)
    expect(enriched['context_window_size']).toEqual({ default: 200_000, max: [1_000_000] })
    expect(enriched['prompt_max_tokens']).toBe(936_000)
    expect(enriched['max_tokens']).toBe(64_000)
    expect(enriched['features']['context_windows']['enable']).toBe(true)
  })

  it('maxModeFields 输出线上字段', () => {
    const enriched = enrichMaxModeConfig(model('m', { max_mode: true, context_window_tokens: { max: 1_000_000 } }))
    const fields = maxModeFields(enriched)
    expect(fields['model_selection_strategy']).toBe('max')
    expect(fields['mode_type']).toBe(1)
    expect(fields['context_window_size']).toBe(1_000_000)
  })
})

describe('normalizeRemoteEventName：事件名归一', () => {
  it('camelCase → snake_case', () => {
    expect(normalizeRemoteEventName('planItem')).toBe('plan_item')
    expect(normalizeRemoteEventName('PlanItem')).toBe('plan_item')
  })

  it('已知别名折到规范名', () => {
    expect(normalizeRemoteEventName('ResponseDone')).toBe('done')
    expect(normalizeRemoteEventName('response_done')).toBe('done')
    expect(normalizeRemoteEventName('streamDone')).toBe('done')
    expect(normalizeRemoteEventName('modelConfig')).toBe('model_config')
    expect(normalizeRemoteEventName('tokenUsage')).toBe('token_usage')
  })

  it('未知名原样小写归一（不丢事件）', () => {
    expect(normalizeRemoteEventName('some-new-event')).toBe('some_new_event')
  })
})

describe('remoteModelSessionId：稳定会话 id', () => {
  it('同账号 + 同模型 + 同变体 → 恒定（上游据此复用远端 workspace）', async () => {
    const a = await remoteModelSessionId('u1', 'DeepSeek-V4-Pro')
    const b = await remoteModelSessionId('u1', 'DeepSeek-V4-Pro')
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('换账号 / 换模型 / 换变体 → 不同 id', async () => {
    const base = await remoteModelSessionId('u1', 'm')
    expect(await remoteModelSessionId('u2', 'm')).not.toBe(base)
    expect(await remoteModelSessionId('u1', 'm2')).not.toBe(base)
    expect(await remoteModelSessionId('u1', 'm', 'max')).not.toBe(base)
  })

  it('显式指定 → 直接用它', async () => {
    expect(await remoteModelSessionId('u1', 'm', '', 'fixed-id')).toBe('fixed-id')
  })
})

describe('buildRemoteCommonParams：设备指纹确定性', () => {
  it('同账号两次调用产出完全相同的参数（随机设备 id 会让风控抖动）', async () => {
    const a = await buildRemoteCommonParams({ account: ACCOUNT, mode: 'code' })
    const b = await buildRemoteCommonParams({ account: ACCOUNT, mode: 'code' })
    expect(a).toBe(b)
  })

  it('账号上已绑定 deviceId 时优先用它', async () => {
    const params = JSON.parse(await buildRemoteCommonParams({ account: ACCOUNT, mode: 'work' }))
    expect(params['device_id']).toBe('dev-1')
  })

  it('缺失 deviceId 时按 uid 派生 16 位数字（确定性）', async () => {
    const p1 = JSON.parse(await buildRemoteCommonParams({ account: { ...ACCOUNT, deviceId: undefined }, mode: 'code' }))
    const p2 = JSON.parse(await buildRemoteCommonParams({ account: { ...ACCOUNT, deviceId: undefined }, mode: 'code' }))
    expect(p1['device_id']).toBe(p2['device_id'])
  })

  it('**不下发** webId / bizUserId / userUniqueId（2026-10-09 实测非阻塞）', async () => {
    const params = JSON.parse(await buildRemoteCommonParams({ account: ACCOUNT, mode: 'code' }))
    expect('web_id' in params).toBe(false)
    expect('biz_user_id' in params).toBe(false)
    expect('user_unique_id' in params).toBe(false)
  })

  it('Work 模式带上桌面客户端元数据 + biz_session_id', async () => {
    const params = JSON.parse(await buildRemoteCommonParams({ account: ACCOUNT, mode: 'work', sessionId: 'sess-1' }))
    expect(params['platform']).toBe('electron')
    expect(params['os_name']).toBe('linux')
    expect(params['build_version']).toBe('2.3.79946')
    expect(params['biz_session_id']).toBe('sess-1')
  })

  it('code 模式不带 Work 元数据', async () => {
    const params = JSON.parse(await buildRemoteCommonParams({ account: ACCOUNT, mode: 'code' }))
    expect('platform' in params).toBe(false)
    expect(params['solo_chat_mode']).toBe('code')
  })
})

describe('flattenTraeQuery：扁平 query 构造', () => {
  it('输出 [{"type":"text","data":{"content":…}}] 形态', () => {
    const out = JSON.parse(flattenTraeQuery([{ role: 'user', content: '你好' }]))
    expect(Array.isArray(out)).toBe(true)
    expect(out[0].type).toBe('text')
    expect(out[0].data.content).toBe('你好')
  })

  it('角色用文本前缀表达（上游 web 端原生格式）', () => {
    const out = JSON.parse(flattenTraeQuery([
      { role: 'system', content: 'S' },
      { role: 'user', content: 'U' },
    ]))
    expect(out[0].data.content).toContain('[System]\nS')
    expect(out[0].data.content).toContain('U')
  })

  it('developer 归一化为 [System]（与 SOLO 侧 developer→system 同口径）', () => {
    const out = JSON.parse(flattenTraeQuery([{ role: 'developer', content: 'D' }]))
    expect(out[0].data.content).toBe('[System]\nD')
  })

  it('tool 结果序列化为 [Client Tool Result: …] 并标注状态', () => {
    const out = JSON.parse(flattenTraeQuery([
      { role: 'tool', tool_call_id: 'c1', name: 'read', content: '{"ok":true}' },
    ]))
    expect(out[0].data.content).toContain('[Client Tool Result: c1 read status=succeeded]')
  })

  it('失败态 tool 结果标注 status=failed', () => {
    const out = JSON.parse(flattenTraeQuery([
      { role: 'tool', tool_call_id: 'c1', name: 'read', content: '{"error":"boom"}' },
    ]))
    expect(out[0].data.content).toContain('status=failed')
  })

  it('assistant 的 tool_calls 序列化为「已处理，勿重复」的历史', () => {
    const out = JSON.parse(flattenTraeQuery([
      { role: 'assistant', content: 'x', tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{}' } }] },
    ]))
    expect(out[0].data.content).toContain('do not repeat')
  })

  it('数组 content 里的 reasoning 块被丢弃（不把思考链回灌上游）', () => {
    const out = JSON.parse(flattenTraeQuery([
      { role: 'user', content: [{ type: 'text', text: 'A' }, { type: 'reasoning', text: 'SECRET' }] },
    ]))
    expect(out[0].data.content).toContain('A')
    expect(out[0].data.content).not.toContain('SECRET')
  })

  it('非数组 messages → 空文本但仍返回合法 JSON', () => {
    const out = JSON.parse(flattenTraeQuery(null))
    expect(out[0].data.content).toBe('')
  })
})

// ===== 网络层（fetch mock） =====

/** 造一个 Remote 建会话成功响应。 */
function sessionResponse(sessionId = 'sess-1', messageId = 'msg-1'): Response {
  return new Response(JSON.stringify({ code: 0, data: { chat_session_id: sessionId, message_id: messageId } }), { status: 200 })
}

describe('createRemoteSession：建会话', () => {
  it('manual 策略带完整 custom_model + agent_type/agent_id + 思考档位', async () => {
    const models = { 'DeepSeek-V4-Pro': model('DeepSeek-V4-Pro', {
      reasoning_effort_config: { support_thinking: true, options: ['light', 'high', 'extra_high'] },
    }) }
    let captured: any = null
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      captured = JSON.parse(init.body)
      return sessionResponse()
    }))

    const trace: NonNullable<CreateRemoteSessionOptions['trace']> = {}
    const result = await createRemoteSession(ACCOUNT, 'DeepSeek-V4-Pro', [{ role: 'user', content: 'hi' }], {
      models,
      requestBody: { reasoning_effort: 'medium' },
      trace,
    })

    expect(result.sessionId).toBe('sess-1')
    expect(result.messageId).toBe('msg-1')
    expect(result.reasoningEffort).toBe('high')
    expect(trace.reasoningEffortApplied).toBe('high')

    const im = captured.initial_message
    // agent_type 与 agent_id 必须都发：少发 agent_id 上游会静默解析到默认档
    expect(im.agent_type).toBe('solo_agent_remote')
    expect(im.agent_id).toBe('solo_agent_remote')
    expect(im.model_selection_strategy).toBe('manual')
    expect(im.custom_model.reasoning_effort).toBe('high')
    expect(captured.env).toBe('remote')
    expect(captured.origin).toBe('web')
  })

  it('模型不在目录里 → 抛错，**不**静默用默认模型', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sessionResponse()))
    await expect(
      createRemoteSession(ACCOUNT, 'DeepSeek-V4-Pro', [], { models: { 'kimi-k3': model('kimi-k3') } })
    ).rejects.toThrow(/not available for the bound account/)
  })

  it('auto 策略不带 custom_model（上游自己挑）', async () => {
    let captured: any = null
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      captured = JSON.parse(init.body)
      return sessionResponse()
    }))
    await createRemoteSession(ACCOUNT, 'auto', [{ role: 'user', content: 'hi' }], {})
    expect('custom_model' in captured.initial_message).toBe(false)
    expect(captured.initial_message.model_selection_strategy).toBe('auto')
  })

  it('HTTP 401 → kind=session_dead（账号级，调用方据此禁用）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })))
    await expect(createRemoteSession(ACCOUNT, 'auto', [], {})).rejects.toMatchObject({ kind: 'session_dead' })
  })

  it('缺 id → 抛错（不能拿半个响应继续读流）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 })))
    await expect(createRemoteSession(ACCOUNT, 'auto', [], {})).rejects.toThrow(/missing ids/)
  })

  it('无 accessToken → 直接抛错', async () => {
    await expect(createRemoteSession({ ...ACCOUNT, accessToken: '' }, 'auto', [], {})).rejects.toThrow(/No Cloud-IDE-JWT/)
  })

  it('网络异常 → kind=transport（不罚号）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom') }))
    await expect(createRemoteSession(ACCOUNT, 'auto', [], {})).rejects.toMatchObject({ kind: 'transport' })
  })
})

/** 把事件列表包成 fetch 的 SSE 响应。 */
function sseResponse(events: Array<[string, unknown]>): Response {
  const text = events
    .map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('')
  return new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

/** 收齐事件流。 */
async function collect(gen: AsyncGenerator<TraeRemoteEvent>): Promise<TraeRemoteEvent[]> {
  const out: TraeRemoteEvent[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

describe('streamRemoteEvents：事件流', () => {
  it('解析事件名与 payload，透传 heartbeat', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      ['heartbeat', {}],
      ['plan_item', { id: 'p1', content: 'hi' }],
      ['done', { finish_reason: 'stop' }],
    ])))
    const events = await collect(streamRemoteEvents(ACCOUNT, 's', 'm'))
    expect(events.map((e) => e.event)).toEqual(['heartbeat', 'plan_item', 'done'])
    expect(events[1].data['content']).toBe('hi')
  })

  it('首事件前收到 error → RemoteFirstEventError（可换号重试）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      ['error', { code: 500, message: 'executor failed' }],
    ])))
    await expect(collect(streamRemoteEvents(ACCOUNT, 's', 'm')))
      .rejects.toBeInstanceOf(RemoteFirstEventError)
  })

  it('模型产出后的 error 不当作首事件失败（已经出过内容，不能重试）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      ['plan_item', { id: 'p1', content: 'partial' }],
      ['error', { code: 500, message: 'late failure' }],
    ])))
    const seen: string[] = []
    let thrown: unknown = null
    try {
      for await (const ev of streamRemoteEvents(ACCOUNT, 's', 'm')) seen.push(ev.event)
    } catch (e) {
      thrown = e
    }
    // error 事件照常产出（不当作首事件失败被拦下）
    expect(seen).toEqual(['plan_item', 'error'])
    // 但始终没有 done，末尾仍按「不完整」定责——**不是**首事件失败（那会允许重试，
    // 而这里已经有产出，重试会重复计费）。
    expect(thrown).toBeInstanceOf(RemoteStreamIncomplete)
    expect(thrown).not.toBeInstanceOf(RemoteFirstEventError)
  })

  it('没有 done 就结束 → RemoteStreamIncomplete（半句话不得当完整回答）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      ['plan_item', { id: 'p1', content: 'partial' }],
    ])))
    await expect(collect(streamRemoteEvents(ACCOUNT, 's', 'm')))
      .rejects.toBeInstanceOf(RemoteStreamIncomplete)
  })

  it('只有心跳、没有模型事件 → 首事件超时（心跳不解除死线）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      ['heartbeat', {}], ['heartbeat', {}],
    ])))
    await expect(collect(streamRemoteEvents(ACCOUNT, 's', 'm', { firstEventTimeoutMs: 1 })))
      .rejects.toBeInstanceOf(RemoteFirstEventTimeout)
  })

  it('[DONE] 行当作 done 事件', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('data: [DONE]\n\n', { status: 200 })))
    const events = await collect(streamRemoteEvents(ACCOUNT, 's', 'm'))
    expect(events[0].event).toBe('done')
  })

  it('SSE 注释行（: keep-alive）被忽略', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      ': keep-alive\nevent: done\ndata: {}\n\n', { status: 200 }
    )))
    const events = await collect(streamRemoteEvents(ACCOUNT, 's', 'm'))
    expect(events.map((e) => e.event)).toEqual(['done'])
  })

  it('HTTP 401 → kind=session_dead', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })))
    await expect(collect(streamRemoteEvents(ACCOUNT, 's', 'm'))).rejects.toMatchObject({ kind: 'session_dead' })
  })
})
