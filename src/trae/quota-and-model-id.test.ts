import { describe, it, expect } from 'vitest'
import { parseSoloLine } from './sse'
import { fetchTraeModels, isTraeQuotaError } from './upstream'
import { mapTraeModel, proxyTraeChatRequest } from './proxy'
import { readTraePool } from './pool'

/**
 * 第 2 轮 P1/P2 回归用例（Trae2api-cn 移植，2026-10-11）。
 *
 *  P1-2 流内 error 漏判 4008 配额 → 账号不被 plan 冷却（HTTP 路径与聚合路径都判了，只有流式漏）
 *  P1-3 `parseSoloLine` 的 error `code` 只认 number → 字符串码退化成 0，1005/4008/4027 全失效
 *  P2-5 模型 id 大小写回映射（源 `_UPSTREAM_MODEL_CASE`）
 *  P2-6 上游模型目录空结果不得写负缓存（源 `get_models`：Not cached, so the next request retries）
 */

describe('parseSoloLine：error 帧的码与文案（P1-3）', () => {
  it('数字码原样保留', () => {
    const ev = parseSoloLine('error', JSON.stringify({ code: 4008, message: 'x' }))
    expect(ev?.errorCode).toBe(4008)
    expect(ev?.errorMessage).toBe('x')
  })

  it('数字字符串码归一为 number（否则 1005/4008/4027 三条判据同时失效）', () => {
    const ev = parseSoloLine('error', JSON.stringify({ code: '4008', message: 'requests have exceeded the quota' }))
    expect(ev?.errorCode).toBe(4008)
  })

  it('兼容 error_code / errorCode 键名与 msg/detail/reason 文案键名', () => {
    expect(parseSoloLine('error', JSON.stringify({ error_code: 1005, msg: 'plan limit' }))?.errorCode).toBe(1005)
    expect(parseSoloLine('error', JSON.stringify({ errorCode: '4027', detail: 'invalid_parameter_error' }))?.errorCode).toBe(4027)
    expect(parseSoloLine('error', JSON.stringify({ code: 1, reason: 'busy' }))?.errorMessage).toBe('busy')
    expect(parseSoloLine('error', JSON.stringify({ code: 1, error_code: 2 }))?.errorCode).toBe(1)
  })

  it('非数字码不编造（保持 0），非字符串文案不写入（避免 "[object Object]" 参与额度匹配）', () => {
    const ev = parseSoloLine('error', JSON.stringify({ code: 'plan_limit', message: { nested: 1 } }))
    expect(ev?.errorCode).toBe(0)
    expect(ev?.errorMessage).toBe('')
  })
})

describe('isTraeQuotaError：账号级额度耗尽判据（P1-2）', () => {
  it('4008（数字与字符串）命中', () => {
    expect(isTraeQuotaError(4008, '')).toBe(true)
    expect(isTraeQuotaError('4008', '')).toBe(true)
  })

  it('只有文案没有码时按三条英文原文命中（大小写不敏感）', () => {
    expect(isTraeQuotaError(0, 'Requests have exceeded the quota')).toBe(true)
    expect(isTraeQuotaError(0, 'quota exceeded')).toBe(true)
    expect(isTraeQuotaError(0, 'You have exceeded the quota for this plan')).toBe(true)
  })

  it('不误判：1005 归 plan 分支、模型忙/限流/空文案都不算额度耗尽', () => {
    expect(isTraeQuotaError(1005, 'plan limit')).toBe(false)
    expect(isTraeQuotaError(0, 'model is busy')).toBe(false)
    expect(isTraeQuotaError(429, 'too many requests')).toBe(false)
    expect(isTraeQuotaError(0, '')).toBe(false)
  })
})

describe('mapTraeModel：大小写不敏感回映射（P2-5）', () => {
  const known = new Set(['DeepSeek-V4.1-Flash', 'glm-5.2', 'DeepSeek-V4-Flash-Official'])

  it('小写 / 全大写请求回映射到上游 config_name', () => {
    expect(mapTraeModel('deepseek-v4.1-flash', known)).toBe('DeepSeek-V4.1-Flash')
    expect(mapTraeModel('DEEPSEEK-V4.1-FLASH', known)).toBe('DeepSeek-V4.1-Flash')
    expect(mapTraeModel('GLM-5.2', known)).toBe('glm-5.2')
  })

  it('精确匹配、__ 后缀剥离、auto/work 别名不受影响', () => {
    expect(mapTraeModel('glm-5.2', known)).toBe('glm-5.2')
    expect(mapTraeModel('DeepSeek-V4.1-Flash__dev', known)).toBe('DeepSeek-V4.1-Flash')
    expect(mapTraeModel('auto', known)).toBe('glm-5.2')
    expect(mapTraeModel('work', known)).toBe('DeepSeek-V4-Flash-Official')
  })

  it('未知模型仍抛错；仅大小写不同的重名不猜', () => {
    expect(() => mapTraeModel('no-such-model', known)).toThrow(/unknown model/)
    // 归一化也无法消歧（两个真实模型只差大小写）→ 报错而不是挑一个
    const ambiguous = new Set(['Alpha-Beta', 'alpha-beta'])
    expect(() => mapTraeModel('ALPHA-BETA', ambiguous)).toThrow(/unknown model/)
    // 但归一化能精确命中时不算歧义（ALPHA → Alpha 命中 'Alpha'）
    expect(mapTraeModel('ALPHA', new Set(['Alpha', 'beta']))).toBe('Alpha')
  })
})

describe('fetchTraeModels：空目录不是失败（P2-6）', () => {
  it('config_info_list 为空 → 返回 [] 而不是抛错（调用方据此不写负缓存）', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ config_info_list: [] }), { status: 200 })) as unknown as typeof fetch
    try {
      const models = await fetchTraeModels({ uid: 'u1', accessToken: 'tok' } as any)
      expect(models).toEqual([])
    } finally {
      globalThis.fetch = original
    }
  })

  it('有条目时仍按 config_name 归一（不回归）', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          config_info_list: [
            { config_name: 'DeepSeek-V4.1-Flash', display_config: { display_name: 'DeepSeek 4.1 Flash' }, max_input_tokens: 200000, max_output_tokens: 8192 },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch
    try {
      const models = await fetchTraeModels({ uid: 'u1', accessToken: 'tok' } as any)
      expect(models).toHaveLength(1)
      expect(models[0].id).toBe('DeepSeek-V4.1-Flash')
      expect(models[0].name).toBe('DeepSeek 4.1 Flash')
      expect(models[0].maxTokens).toBe(8192)
    } finally {
      globalThis.fetch = original
    }
  })
})

// ===== 端到端：流内 4008 必须走 plan 冷却，而不是普通错误计数 =====

const QUOTA_UID = 'u_quota'
const QUOTA_PID = 'trae-quota-4008'
const GENERIC_PID = 'trae-generic-err'

function makeEnv(): any {
  return {
    KV: {
      data: new Map<string, string>(),
      async get(key: string) { return this.data.get(key) || null },
      async put(key: string, val: string) { this.data.set(key, val) },
      async delete(key: string) { this.data.delete(key) },
    },
  }
}

function makeProvider(id: string): any {
  return {
    id,
    name: 'TRAE quota',
    type: 'trae',
    apiKeys: [{
      key: JSON.stringify({
        uid: QUOTA_UID,
        token: 'tok_quota',
        refreshToken: 'ref_quota',
        expiresAt: Date.now() + 3600_000,
      }),
      enabled: true,
    }],
  }
}

/** 轮询等待账号池落盘（applyStreamError 是 fire-and-forget 的 void 调用）。 */
async function waitForPool(env: any, pid: string, uid: string): Promise<any> {
  for (let i = 0; i < 40; i++) {
    const pool = await readTraePool(env, pid)
    if (pool[uid] && Object.keys(pool[uid]).length > 0) return pool
    await new Promise((r) => setTimeout(r, 5))
  }
  return await readTraePool(env, pid)
}

async function runSoloErrorStream(pid: string, errorEvent: Record<string, unknown>): Promise<any> {
  const original = globalThis.fetch
  const sse = `event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`
  globalThis.fetch = (async (input: any) => {
    const url = String(input)
    if (url.includes('/api/agent/v3/llm_utils_chat')) {
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }
    return new Response('nope', { status: 404 })
  }) as unknown as typeof fetch
  try {
    const env = makeEnv()
    const provider = makeProvider(pid)
    const resp = await proxyTraeChatRequest(env, provider, {
      model: 'glm-5.2',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })
    // 必须把流读干净：流内 error 是在读体过程中触发 applyStreamError 的
    await resp.text()
    return await waitForPool(env, pid, QUOTA_UID)
  } finally {
    globalThis.fetch = original
  }
}

describe('SOLO 流内 error → 账号冷却定责（P1-2 端到端）', () => {
  it('code 4008 → 按 plan 冷却、errCount 归零（不是普通错误计数）', async () => {
    const pool = await runSoloErrorStream(QUOTA_PID, {
      code: 4008,
      message: 'requests have exceeded the quota',
    })
    const st = pool[QUOTA_UID]
    expect(st).toBeDefined()
    expect(st.errCount).toBe(0)
    expect(st.until).toBeGreaterThan(Date.now())
    expect(String(st.reason)).toContain('4008')
  })

  it('字符串码 "4008" 同样命中（P1-3 与 P1-2 联动）', async () => {
    const pool = await runSoloErrorStream(`${QUOTA_PID}-str`, { code: '4008' })
    const st = pool[QUOTA_UID]
    expect(st.errCount).toBe(0)
    expect(st.until).toBeGreaterThan(Date.now())
    expect(String(st.reason)).toContain('4008')
  })

  it('对照组：普通业务错误仍走累计计数（证明上面两例不是"任何错误都冷却"）', async () => {
    const pool = await runSoloErrorStream(GENERIC_PID, { code: 5001, message: 'internal hiccup' })
    const st = pool[QUOTA_UID]
    expect(st).toBeDefined()
    expect(st.errCount).toBe(1)
    expect(st.until).toBeUndefined()
  })
})
