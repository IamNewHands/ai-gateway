/**
 * 移植回归（M365-Copilot2API 窗口 `442205e..aba646d` 第 2 批）：
 *
 * 1. §3.1 SSRF 判定对齐入站/出站：`isSafeDownloadURL` 与 `isPrivateOrLocalHostname`
 *    共用同一套私网判定，覆盖 IPv6 全形态 / CGNAT / link-local / 0.0.0.0。
 *    注意：客户端入站 URL 本就由 multimodal.ts 拦截；本项真正的缺口在**重定向跳转**
 *    （重定向目标不经过入站校验）。
 * 2. §3.2 非 designer 图床下载不再 `redirect: 'follow'`：逐跳校验 + 跳数上限。
 * 3. §3.3 Responses 历史/别名带租户归属：跨租户读取按不存在处理，旧条目（legacy）放行。
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { isPrivateOrLocalHostname } from './multimodal'
import { isSafeDownloadURL } from './chathub'
import { fetchImageCDNResponse } from './images'
import { mayReuseConvCache } from './durable'
import {
  saveResponseHistory,
  getResponseHistory,
  saveResponseAlias,
  getResponseAlias,
  consumeResponseCallId,
} from '../storage'
import type { Env } from '../types'

// ===== 1. SSRF：入站/出站共用判定 =====

describe('isPrivateOrLocalHostname / isSafeDownloadURL', () => {
  // 源 `internal/chathub/ssrf.go` 的 ipUnsafe 语义：IPv6 全拒 + CGNAT + link-local + 未指定 + 组播
  const unsafe = [
    'https://[::1]/x',
    'https://[::ffff:127.0.0.1]/x',
    'https://[::]/x',
    'https://[fd00::1]/x',
    'https://[fe80::1]/x',
    'https://169.254.169.253/x',
    'https://169.254.169.254/x',
    'https://100.64.0.1/x',
    'https://100.127.255.254/x',
    'https://0.0.0.0/x',
    'https://224.0.0.1/x',
    'https://127.0.0.1/x',
    'https://10.1.2.3/x',
    'https://192.168.1.1/x',
    'https://172.20.0.1/x',
    'https://localhost/x',
    'https://foo.local/x',
    'https://foo.internal/x',
  ]

  it('私网 / 本机 / 非公网字面量全部拒绝', () => {
    for (const url of unsafe) {
      expect(isSafeDownloadURL(url), url).toBe(false)
    }
  })

  it('公共 DNS 域名与公网 IPv4 仍放行（不误伤正常附件/图床）', () => {
    for (const url of [
      'https://cdn.example.com/a.png',
      'https://images.unsplash.com/photo-1.jpg',
      'https://8.8.8.8/a.png',
      'https://100.128.0.1/a.png', // CGNAT 边界之外
    ]) {
      expect(isSafeDownloadURL(url), url).toBe(true)
    }
  })

  it('非 https 与带 userinfo 的 URL 拒绝', () => {
    expect(isSafeDownloadURL('http://cdn.example.com/a.png')).toBe(false)
    expect(isSafeDownloadURL('https://user:pass@cdn.example.com/a.png')).toBe(false)
    expect(isSafeDownloadURL('not a url')).toBe(false)
  })

  it('CGNAT 边界与 IPv4 映射形态按字面量判定', () => {
    expect(isPrivateOrLocalHostname('100.63.255.255')).toBe(false)
    expect(isPrivateOrLocalHostname('100.64.0.0')).toBe(true)
    expect(isPrivateOrLocalHostname('100.127.255.255')).toBe(true)
    expect(isPrivateOrLocalHostname('100.128.0.0')).toBe(false)
    expect(isPrivateOrLocalHostname('10.0.0.1')).toBe(true)
    expect(isPrivateOrLocalHostname('999.1.1.1')).toBe(true)
    // 所有 IPv6 字面量（含映射/压缩/ULA/link-local）一律拒绝
    expect(isPrivateOrLocalHostname('::ffff:8.8.8.8')).toBe(true)
    expect(isPrivateOrLocalHostname('2001:4860:4860::8888')).toBe(true)
  })
})

// ===== 2. 图床重定向：不再 follow =====

afterEach(() => {
  vi.unstubAllGlobals()
})

function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } })
}

describe('fetchImageCDNResponse（非 designer 图床下载）', () => {
  it('拒绝重定向到不安全地址，且不会真的请求该地址', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      calls.push(String(input))
      return redirectTo('https://[::1]/secret.png')
    }))

    await expect(fetchImageCDNResponse('https://cdn.example.com/a.png')).rejects.toThrow(/unsafe address/)
    expect(calls).toEqual(['https://cdn.example.com/a.png'])
  })

  it('重定向到公共 CDN 域名正常跟随并返回响应', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      if (String(input) === 'https://cdn.example.com/a.png') return redirectTo('https://cdn2.example.com/b.png')
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'image/png' } })
    }))

    const resp = await fetchImageCDNResponse('https://cdn.example.com/a.png')
    expect(resp.status).toBe(200)
    expect(resp.headers.get('Content-Type')).toBe('image/png')
  })

  it('相对 Location 按当前 URL 解析后继续校验', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      calls.push(String(input))
      if (calls.length === 1) return redirectTo('/b.png')
      return new Response('ok', { status: 200 })
    }))

    const resp = await fetchImageCDNResponse('https://cdn.example.com/a.png')
    expect(resp.status).toBe(200)
    expect(calls).toEqual(['https://cdn.example.com/a.png', 'https://cdn.example.com/b.png'])
  })

  it('重定向链无限时按跳数上限终止（此前 follow 无上限）', async () => {
    let hop = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      hop += 1
      return redirectTo(`https://cdn${hop}.example.com/next.png`)
    }))

    await expect(fetchImageCDNResponse('https://cdn.example.com/a.png')).rejects.toThrow(/redirect limit exceeded/)
    expect(hop).toBe(6) // 初始 1 次 + 最多 5 跳
  })

  it('首跳即不安全地址直接拒绝', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchImageCDNResponse('https://100.64.0.1/x.png')).rejects.toThrow(/unsafe address/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ===== 3. Responses 历史/别名的租户归属 =====

class MemoryKV {
  readonly store = new Map<string, { value: string; ttl?: number }>()
  async get(key: string): Promise<string | null> {
    return this.store.get(key)?.value ?? null
  }
  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, { value, ttl: opts?.expirationTtl })
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key)
  }
  seed(key: string, value: string): void {
    this.store.set(key, { value })
  }
}

function envWithKv(kv: MemoryKV): Env {
  return { KV: kv } as unknown as Env
}

describe('Responses 历史/别名的租户归属', () => {
  it('历史：同租户可读，跨租户按不存在处理', async () => {
    const env = envWithKv(new MemoryKV())
    await saveResponseHistory(env, 'chatcmpl-1759000000000', [{ role: 'user', content: 'secret' }], 'tenantA')
    expect(await getResponseHistory(env, 'chatcmpl-1759000000000', 'tenantA')).toEqual([{ role: 'user', content: 'secret' }])
    expect(await getResponseHistory(env, 'chatcmpl-1759000000000', 'tenantB')).toBeNull()
    expect(await getResponseHistory(env, 'chatcmpl-1759000000000')).toBeNull()
  })

  it('历史：v1 裸数组（legacy）仍可读，不被新格式破坏', async () => {
    const kv = new MemoryKV()
    const env = envWithKv(kv)
    kv.seed('proxy:responses:resp_legacy', JSON.stringify([{ role: 'user', content: 'old' }]))
    expect(await getResponseHistory(env, 'resp_legacy', 'tenantA')).toEqual([{ role: 'user', content: 'old' }])
  })

  it('历史：写入的是带租户归属的信封，不是裸数组', async () => {
    const kv = new MemoryKV()
    await saveResponseHistory(envWithKv(kv), 'resp_1', [{ role: 'user', content: 'x' }], 'tenantA')
    const raw = JSON.parse(kv.store.get('proxy:responses:resp_1')!.value)
    expect(raw).toEqual({ v: 2, t: 'tenantA', m: [{ role: 'user', content: 'x' }] })
  })

  it('别名：跨租户读取返回 null（不泄漏 response.id 是否存在）', async () => {
    const env = envWithKv(new MemoryKV())
    await saveResponseAlias(env, 'resp_1', { sourceResponseId: 'resp_1', createdAt: 1, consumedCallIds: [] }, 'tenantA')
    expect(await getResponseAlias(env, 'resp_1', 'tenantA')).toMatchObject({ sourceResponseId: 'resp_1', tenant: 'tenantA' })
    expect(await getResponseAlias(env, 'resp_1', 'tenantB')).toBeNull()
  })

  it('别名：legacy 条目（无 tenant 字段）仍可读，避免部署后旧别名立即失效', async () => {
    const kv = new MemoryKV()
    const env = envWithKv(kv)
    kv.seed('proxy:resp-alias:resp_old', JSON.stringify({ sourceResponseId: 'resp_old', createdAt: 1, consumedCallIds: ['c1'] }))
    expect(await getResponseAlias(env, 'resp_old', 'tenantA')).toMatchObject({ sourceResponseId: 'resp_old', consumedCallIds: ['c1'] })
  })

  it('call_id 消费：跨租户不写入他人消费表，本租户一次性语义不受影响', async () => {
    const env = envWithKv(new MemoryKV())
    await saveResponseAlias(env, 'resp_1', { sourceResponseId: 'resp_1', createdAt: 1, consumedCallIds: [] }, 'tenantA')
    // 他人租户既读不到别名，也消费不到（放行，但不会污染 tenantA 的消费表）
    expect(await consumeResponseCallId(env, 'resp_1', 'call_x', 'tenantB')).toBe(true)
    const after = await getResponseAlias(env, 'resp_1', 'tenantA')
    expect(after?.consumedCallIds).toEqual([])
    // 本租户一次性语义不变
    expect(await consumeResponseCallId(env, 'resp_1', 'call_a', 'tenantA')).toBe(true)
    expect(await consumeResponseCallId(env, 'resp_1', 'call_a', 'tenantA')).toBe(false)
  })
})

// ===== 4. convCache 复用门禁（§2.3 判定翻转后确认的目标侧真实缺陷） =====

describe('mayReuseConvCache（显式会话边界不参与复用）', () => {
  it('无显式 session id 的新会话：仍走原版第三层复用（行为不变）', () => {
    expect(mayReuseConvCache(true, 'gpt-4', 'hash', undefined)).toBe(true)
    expect(mayReuseConvCache(true, 'gpt-4', 'hash', '')).toBe(true)
  })

  it('客户端显式声明了 session id：跳过复用（修复串会话）', () => {
    expect(mayReuseConvCache(true, 'gpt-4', 'hash', 'session-1')).toBe(false)
  })

  it('非新会话（已由前缀/后缀命中绑定）：不走复用层', () => {
    expect(mayReuseConvCache(false, 'gpt-4', 'hash', undefined)).toBe(false)
  })

  it('缺 model 或缺 sysHash：不走复用（保持原有前置条件）', () => {
    expect(mayReuseConvCache(true, '', 'hash', undefined)).toBe(false)
    expect(mayReuseConvCache(true, 'gpt-4', '', undefined)).toBe(false)
  })
})
