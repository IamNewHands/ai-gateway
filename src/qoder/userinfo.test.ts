/**
 * userinfo.test.ts — Qoder 账号昵称的唯一来源（面板「uid=…（昵称）」/ 首选账号下拉框的数据）。
 *
 * 为什么值得单独测：Qoder 的**设备授权响应与 token 刷新响应都不带任何名字**
 * （只有 token / refresh_token / user_id），`dt-` token 也不是 JWT、解不出 claims，
 * 所以 `/api/v1/userinfo` 是拿到昵称的唯一途径。它一旦解析错字段名或走错域，
 * 表现是「昵称一直空着」，而这条路径**不报错**——面板只是安静地退回 36 位 UUID，
 * 没人会从日志里发现（2026-10-07 用户报的正是这个现象）。
 *
 * 两份参考实现交叉确认了端点与字段名：
 *   - qoder2api-hub qoder_accounts.py:1729-1743（`ui.get("name")` → nickname，`ui.get("id")` → uid）
 *   - qoder2api account/oauth.go:221-233（同端点、同 `Bearer` 明文鉴权，无 COSY 签名）
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchQoderUserInfo } from './billing'

/** 复刻上游响应结构（字段名取自参考实现；id 用线上真实账号的 uid 形态）。 */
const USERINFO_JSON = {
  id: '01a0fb50-84b9-7848-a8d1-240c89950b79',
  name: 'Shiro',
  user_type: 'personal_professional_trial',
  organization_id: 'org-1',
  organization_name: '个人版',
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn(async (input: unknown, init?: RequestInit) => handler(String(input), init))
  vi.stubGlobal('fetch', mock)
  return mock
}

afterEach(() => { vi.unstubAllGlobals() })

describe('fetchQoderUserInfo：解析昵称/uid/用户类型', () => {
  it('按参考实现的字段名解析出 name / id / user_type / organization_*', async () => {
    stubFetch(() => new Response(JSON.stringify(USERINFO_JSON), { status: 200 }))
    const ui = await fetchQoderUserInfo('dt-test', 'cn')
    expect(ui).toEqual({
      uid: '01a0fb50-84b9-7848-a8d1-240c89950b79',
      name: 'Shiro',
      userType: 'personal_professional_trial',
      organizationId: 'org-1',
      organizationName: '个人版',
    })
  })

  it('域名按账号域取：cn → openapi.qoder.com.cn，global → openapi.qoder.sh', async () => {
    const urls: string[] = []
    stubFetch((url) => { urls.push(url); return new Response('{}', { status: 200 }) })
    await fetchQoderUserInfo('dt-a', 'cn')
    await fetchQoderUserInfo('dt-b', 'global')
    expect(urls[0]).toBe('https://openapi.qoder.com.cn/api/v1/userinfo')
    expect(urls[1]).toBe('https://openapi.qoder.sh/api/v1/userinfo')
  })

  it('用明文 Bearer 鉴权、GET、不签名（COSY 签名只用于推理链路）', async () => {
    let seen: { method?: string; headers?: Record<string, string> } = {}
    stubFetch((_url, init) => {
      const h: Record<string, string> = {}
      for (const k of Object.keys((init?.headers || {}) as Record<string, string>)) {
        h[k.toLowerCase()] = String((init!.headers as Record<string, string>)[k])
      }
      seen = { method: init?.method, headers: h }
      return new Response(JSON.stringify(USERINFO_JSON), { status: 200 })
    })
    await fetchQoderUserInfo('dt-secret', 'cn')
    expect(seen.method).toBe('GET')
    expect(seen.headers!.authorization).toBe('Bearer dt-secret')
    expect(seen.headers!.accept).toBe('application/json')
  })

  it('名字字段缺失/非字符串 → name 为空串，不编造也不抛', async () => {
    stubFetch(() => new Response(JSON.stringify({ id: 'u1', name: 123 }), { status: 200 }))
    const ui = await fetchQoderUserInfo('dt-test', 'cn')
    expect(ui!.name).toBe('')
    expect(ui!.uid).toBe('u1')
  })

  it('名字两端空白 → trim（带空白的昵称会让首选账号下拉框出现看起来空白的行）', async () => {
    stubFetch(() => new Response(JSON.stringify({ id: 'u1', name: '  Shiro  ' }), { status: 200 }))
    expect((await fetchQoderUserInfo('dt-test', 'cn'))!.name).toBe('Shiro')
  })
})

describe('fetchQoderUserInfo：这是纯展示增强，任何失败都必须退化而不是打断签到', () => {
  it('HTTP 非 2xx（如 token 失效 401）→ null，不抛', async () => {
    stubFetch(() => new Response('{"message":"unauthorized"}', { status: 401 }))
    await expect(fetchQoderUserInfo('dt-bad', 'cn')).resolves.toBeNull()
  })

  it('响应不是 JSON → null（上游换了错误页也不该让签到挂掉）', async () => {
    stubFetch(() => new Response('<html>502 Bad Gateway</html>', { status: 200 }))
    await expect(fetchQoderUserInfo('dt-bad', 'cn')).resolves.toBeNull()
  })

  it('网络异常 → null，不抛', async () => {
    stubFetch(() => { throw new Error('network down') })
    await expect(fetchQoderUserInfo('dt-bad', 'cn')).resolves.toBeNull()
  })

  it('空 token → 直接返回 null 且不发请求（避免必然 401 的无用上游调用）', async () => {
    const mock = stubFetch(() => new Response('{}', { status: 200 }))
    await expect(fetchQoderUserInfo('', 'cn')).resolves.toBeNull()
    expect(mock).not.toHaveBeenCalled()
  })
})
