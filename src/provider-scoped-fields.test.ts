import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv, Provider } from './types'
import { renderAdminPage } from './pages'
import { setProviders } from './storage'

/** 内存 KV */
function makeEnv() {
  const map = new Map<string, string>()
  const kv = {
    get: async (k: string) => map.get(k) ?? null,
    put: async (k: string, v: string) => { map.set(k, v) },
    delete: async (k: string) => { map.delete(k) },
  }
  return { KV: kv } as unknown as AppEnv['Bindings']
}

function baseProvider(id: string, extra: Partial<Provider> = {}): Provider {
  return {
    id, name: id, baseUrl: 'https://example.com/v1', apiType: 'openai',
    apiKeys: [], models: [{ id: 'm1', enabled: true }], enabled: true,
    createdAt: 'a', updatedAt: 'a', ...extra,
  }
}

async function render(providers: Provider[]): Promise<string> {
  const app = new Hono<AppEnv>()
  app.get('/admin', (c) => renderAdminPage(c))
  const env = makeEnv()
  // 经 setProviders 播种，保证 storage 内存缓存与 KV 一致（renderAdminPage 走带缓存的 getProviders）
  await setProviders(env as never, providers)
  const res = await app.request('/admin', {}, env as never)
  return await res.text()
}

/** 取出某提供商详情面板片段（<div class="pd" id="dt-<id>"> ... </article>） */
function panel(html: string, id: string): string {
  const start = html.indexOf(`id="dt-${id}"`)
  expect(start, `panel dt-${id} not found`).toBeGreaterThan(-1)
  const end = html.indexOf('</article>', start)
  return html.slice(start, end)
}

describe('提供商详情面板：仅相关提供商显示专属配置', () => {
  it('普通 OpenAI 提供商：不显示工具桥 / Gemini 中转 / effort 下拉，显示模型策略', async () => {
    const html = await render([baseProvider('deepseek')])
    const p = panel(html, 'deepseek')
    expect(p).toContain('id="atb-fs-deepseek"')
    expect(p).toMatch(/id="atb-fs-deepseek"[^>]*class="[^"]*\bhd\b"|class="[^"]*\bhd\b"[^>]*id="atb-fs-deepseek"/)
    expect(p).not.toContain('gbu-row-deepseek')
    expect(p).toMatch(/class="eff-dd hd"/)
    // 模型策略（未配置模型透传）对所有提供商有效，必须保留且可见（不带 hd）
    expect(p).toContain('id="aum-deepseek"')
    expect(p).toMatch(/class="form-group" id="aum-fs-deepseek"/)
    expect(p).not.toMatch(/class="form-group hd" id="aum-fs-deepseek"/)
  })

  it('CNB 提供商：显示工具桥', async () => {
    const html = await render([baseProvider('cnb', { baseUrl: 'https://cnb.cool' })])
    const p = panel(html, 'cnb')
    expect(p).toContain('id="atb-cnb"')
  })

  it('非 CNB 提供商：隐藏工具桥', async () => {
    const html = await render([baseProvider('openrouter', { baseUrl: 'https://openrouter.ai/api/v1' })])
    const p = panel(html, 'openrouter')
    expect(p).toContain('id="atb-fs-openrouter"')
    expect(p).toMatch(/id="atb-fs-openrouter"[^>]*class="form-group hd"|class="form-group hd"[^>]*id="atb-fs-openrouter"/)
  })

  it('Gemini(OAuth) 提供商：显示 Gemini 中转地址；普通提供商不显示', async () => {
    const gem = baseProvider('gem', {
      authType: 'oauth-device',
      oauth: { flowType: 'gemini', deviceCodeUrl: '', deviceTokenUrl: '', refreshTokenUrl: '', clientId: '' },
    })
    const html = await render([gem, baseProvider('deepseek')])
    expect(panel(html, 'gem')).toContain('gbu-row-gem')
    expect(panel(html, 'deepseek')).not.toContain('gbu-row-deepseek')
  })

  it('effort 下拉只对 WorkBuddy 提供商可见（browser 流 / workbuddy* id）', async () => {
    const wb = baseProvider('workbuddy', {
      authType: 'oauth-device',
      oauth: { flowType: 'browser', deviceCodeUrl: 'x', deviceTokenUrl: 'y', refreshTokenUrl: 'z', clientId: '' },
    })
    const html = await render([wb, baseProvider('deepseek')])
    const wbPanel = panel(html, 'workbuddy')
    const dsPanel = panel(html, 'deepseek')
    // WorkBuddy：effort 下拉可见
    expect(wbPanel).toMatch(/class="eff-dd"/)
    // 其他提供商：effort 下拉带 hd（CSS 隐藏，但仍保留在 DOM 中以便保存时保留已存档位）
    expect(dsPanel).toMatch(/class="eff-dd hd"/)
    expect(dsPanel).not.toMatch(/class="eff-dd"/)
  })

  it('非 WorkBuddy 提供商的已存 effortPolicy 在保存时仍可被读回（DOM 未被删除）', async () => {
    const ds = baseProvider('deepseek', {
      oauth: { flowType: 'device', deviceCodeUrl: 'a', deviceTokenUrl: 'b', refreshTokenUrl: 'c', clientId: 'cid', effortPolicy: { m1: ['low', 'high'] } },
    })
    const html = await render([ds])
    const p = panel(html, 'deepseek')
    expect(p).toMatch(/class="eff-dd hd"/)
    // 已存档位仍在 DOM 里，collectEffortPolicyEdit 可读到
    expect(p).toContain('value="low" checked')
    expect(p).toContain('value="high" checked')
  })
})
