import { describe, it, expect } from 'vitest'
import { handleOAuthPoolExport } from './admin'
import { writeOauthPool } from './oauth-pool'
import type { AppEnv, Env, OAuthTokenState, Provider } from './types'

function makeMockEnv() {
  const store = new Map<string, string>()
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v) },
    delete: async (k: string) => { store.delete(k) },
  }
  const env = {
    KV: kv,
    GATEWAY_KV: kv,
    RATE_LIMIT_KV: kv,
    SESSION_KV: kv,
  } as unknown as Env
  return { env, store }
}

describe('handleOAuthPoolExport', () => {
  it('应成功导出账号池全部凭证并兼容脚本格式', async () => {
    const { env } = makeMockEnv()
    const pid = 'workbuddy'

    // 存储 provider 配置
    const provider: Provider = {
      id: pid,
      name: 'WorkBuddy',
      authType: 'oauth-device',
      apiKeys: [],
      models: [],
      enabled: true,
      oauth: { flowType: 'browser' },
    }
    await env.KV.put('providers', JSON.stringify([provider]))

    // 写入测试账号池
    const t1: OAuthTokenState = {
      access_token: 'test_tok_1',
      refresh_token: 'ref_tok_1',
      expires_at: 1789000000,
      updated_at: 1789000000,
      domain: 'copilot.tencent.com',
    }
    const t2: OAuthTokenState = {
      access_token: 'test_tok_2',
      refresh_token: 'ref_tok_2',
      expires_at: 1789000000,
      updated_at: 1789000000,
      domain: 'copilot.tencent.com',
    }
    await writeOauthPool(env, pid, [
      { uid: 'u1', nickname: 'Nick1', token: t1, enabled: true, state: { credits: 100, disabled: false, until: 0, errCount: 0 }, updatedAt: 1789000000 },
      { uid: 'u2', nickname: 'Nick2', token: t2, enabled: true, state: { credits: 200, disabled: false, until: 0, errCount: 0 }, updatedAt: 1789000000 },
    ])

    const mockContext = {
      req: {
        param: (k: string) => (k === 'id' ? pid : undefined),
        query: (k: string) => undefined,
      },
      env,
      json: (data: any, status?: number) => ({ status: status || 200, json: () => data, data }),
    } as unknown as Parameters<typeof handleOAuthPoolExport>[0]

    const res = await handleOAuthPoolExport(mockContext)
    const json = (res as any).data
    expect(json.success).toBe(true)
    expect(json.data.length).toBe(2)
    expect(json.data[0].uid).toBe('u1')
    expect(json.data[0].access_token).toBe('test_tok_1')
    expect(json.data[0].auth.accessToken).toBe('test_tok_1')
    expect(json.data[0].account.uid).toBe('u1')
  })

  it('支持根据 uid 过滤单个账号导出', async () => {
    const { env } = makeMockEnv()
    const pid = 'workbuddy'

    const provider: Provider = {
      id: pid,
      name: 'WorkBuddy',
      authType: 'oauth-device',
      apiKeys: [],
      models: [],
      enabled: true,
      oauth: { flowType: 'browser' },
    }
    await env.KV.put('providers', JSON.stringify([provider]))

    await writeOauthPool(env, pid, [
      { uid: 'u1', token: { access_token: 'tok1', expires_at: 0, updated_at: 0 }, enabled: true, state: { credits: 0, disabled: false, until: 0, errCount: 0 }, updatedAt: 0 },
      { uid: 'u2', token: { access_token: 'tok2', expires_at: 0, updated_at: 0 }, enabled: true, state: { credits: 0, disabled: false, until: 0, errCount: 0 }, updatedAt: 0 },
    ])

    const mockContext = {
      req: {
        param: (k: string) => (k === 'id' ? pid : undefined),
        query: (k: string) => (k === 'uid' ? 'u2' : undefined),
      },
      env,
      json: (data: any, status?: number) => ({ status: status || 200, json: () => data, data }),
    } as unknown as Parameters<typeof handleOAuthPoolExport>[0]

    const res = await handleOAuthPoolExport(mockContext)
    const json = (res as any).data
    expect(json.success).toBe(true)
    expect(json.data.length).toBe(1)
    expect(json.data[0].uid).toBe('u2')
    expect(json.data[0].access_token).toBe('tok2')
  })

  it('带 download=1 参数时返回 Attachment 下载响应', async () => {
    const { env } = makeMockEnv()
    const pid = 'workbuddy'

    const provider: Provider = {
      id: pid,
      name: 'WorkBuddy',
      authType: 'oauth-device',
      apiKeys: [],
      models: [],
      enabled: true,
      oauth: { flowType: 'browser' },
    }
    await env.KV.put('providers', JSON.stringify([provider]))

    await writeOauthPool(env, pid, [
      { uid: 'u1', token: { access_token: 'tok1', expires_at: 0, updated_at: 0 }, enabled: true, state: { credits: 0, disabled: false, until: 0, errCount: 0 }, updatedAt: 0 },
    ])

    const mockContext = {
      req: {
        param: (k: string) => (k === 'id' ? pid : undefined),
        query: (k: string) => (k === 'download' ? '1' : undefined),
      },
      env,
      json: (data: any) => ({ data }),
    } as unknown as Parameters<typeof handleOAuthPoolExport>[0]

    const res = await handleOAuthPoolExport(mockContext)
    expect(res).toBeInstanceOf(Response)
    const resp = res as Response
    expect(resp.headers.get('Content-Disposition')).toContain('attachment; filename=')
    const body = await resp.json()
    expect(Array.isArray(body)).toBe(true)
  })
})
