import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { AGENTROUTER_UI_JS } from './agentrouter-ui'
import { SHARED_JS } from './shared.js'
import { renderAdminPage } from './pages'
import { setProviders } from './storage'
import type { AgentRouterAccountView } from './agentrouter'
import type { AppEnv, Provider } from './types'

const ACCOUNT: AgentRouterAccountView = {
  id: 'a'.repeat(43), name: 'Main', email: 'main@example.com',
  enabled: true, hasPassword: true, credentialsReady: true, checkedInToday: false, result: null,
}

function provider(id: string, baseUrl = 'https://agentrouter.org/v1'): Provider {
  return { id, name: id, baseUrl, apiType: 'openai', apiKeys: [], models: [], enabled: true, createdAt: 'a', updatedAt: 'a' }
}

async function render(providers: Provider[]) {
  const store = new Map<string, string>()
  const env = { KV: {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => { store.set(key, value) },
  } } as unknown as AppEnv['Bindings']
  await setProviders(env, providers)
  const app = new Hono<AppEnv>()
  app.get('/admin', renderAdminPage)
  return (await app.request('/admin', {}, env)).text()
}

function executableScripts(html: string) {
  return Array.from(html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script[^>]*>/gi))
    .filter((match) => !/\bsrc=/i.test(match[1]) && !/\btype=["']text\/plain/i.test(match[1]))
    .map((match) => match[2]).join('\n')
}

class Classes {
  private values = new Set<string>()
  add(value: string) { this.values.add(value) }
  remove(value: string) { this.values.delete(value) }
  contains(value: string) { return this.values.has(value) }
  toggle(value: string, enabled: boolean) { if (enabled) this.add(value); else this.remove(value) }
}

function input() {
  return { value: '', checked: false, disabled: false, readOnly: false, required: false, placeholder: '', focus: vi.fn() }
}
type Control = ReturnType<typeof input> & { action?: string; getAttribute?: (name: string) => string | null }
interface ChangeEvent {
  target: Control & { matches: (selector: string) => boolean; getAttribute: (name: string) => string | null }
}

class Block {
  disabled = false
  attributes: Record<string, string> = {}
  _arBusy?: boolean
  _arAccounts?: AgentRouterAccountView[]
  _arEditId?: string
  _arLoading?: Promise<boolean> | null
  _arBound?: boolean
  listeners = new Map<string, ((event: ChangeEvent) => Promise<void>)[]>()
  state = { textContent: '', classList: new Classes() }
  editor = { classList: new Classes() }
  toolbar: Control[] = [{ ...input(), action: 'add' }, { ...input(), action: 'checkin-all', disabled: true }]
  rows: Control[] = []
  form = {
    elements: { email: input(), password: input(), name: input(), enabled: input() },
    reportValidity: vi.fn(() => true),
    reset: () => {
      for (const field of Object.values(this.form.elements)) { field.value = ''; field.checked = false }
    },
  }
  private html = ''
  list: { innerHTML: string }
  constructor() {
    this.editor.classList.add('hd')
    const owner = this
    this.list = {
      get innerHTML() { return owner.html },
      set innerHTML(value: string) { owner.setList(value) },
    }
  }
  setList(value: string) {
    this.html = value
    this.rows = Array.from(value.matchAll(/<button\b([^>]*)>/g)).map((match) => ({
      ...input(), disabled: /\bdisabled\b/.test(match[1]),
      action: match[1].match(/data-ar-action="([^"]*)"/)?.[1],
    }))
  }
  querySelector(selector: string) {
    if (selector === '.agentrouter-list') return this.list
    if (selector === '.agentrouter-state') return this.state
    if (selector === '.agentrouter-editor') return this.editor
    if (selector === '.agentrouter-form') return this.form
    if (selector === '[data-ar-action="checkin-all"]') return this.toolbar[1]
    return null
  }
  querySelectorAll(selector: string) {
    return selector === 'button, input' ? [...this.toolbar, ...this.rows, ...Object.values(this.form.elements)] : []
  }
  setAttribute(name: string, value: string) { this.attributes[name] = value }
  addEventListener(name: string, handler: (event: ChangeEvent) => Promise<void>) {
    this.listeners.set(name, [...this.listeners.get(name) || [], handler])
  }
}

interface UiApi {
  render: (block: Block, accounts: AgentRouterAccountView[]) => void
  load: (block: Block) => Promise<boolean>
  refresh: () => Promise<boolean>
  edit: (block: Block, account: AgentRouterAccountView | null) => void
  cancel: (block: Block) => void
  save: (block: Block) => Promise<void>
  busy: (block: Block, busy: boolean) => void
  action: (block: Block, action: string, id?: string) => Promise<void>
  bind: (block: Block) => void
  open: (root: { querySelectorAll: () => Block[] }) => void
  badge: (account: AgentRouterAccountView) => [string, string]
  money: (value: number | null) => string
}

function client() {
  const blocks = [new Block(), new Block()]
  const requests: { path: string; init: RequestInit }[] = []
  let accounts = [{ ...ACCOUNT }]
  let mode: 'ok' | 'save-fail' | 'read-fail' | 'expired' = 'ok'
  let checked = false
  const fetchMock = vi.fn(async (path: string, init: RequestInit = {}) => {
    requests.push({ path, init })
    if (mode === 'expired') return Response.json({ success: false }, { status: 401 })
    if (!init.method) {
      if (mode === 'read-fail') return Response.json({ success: false }, { status: 503 })
      return Response.json({ success: true, data: accounts })
    }
    if (mode === 'save-fail') return Response.json({ success: false, code: 'INVALID_PASSWORD' }, { status: 400 })
    if (path.endsWith('/checkin')) return Response.json({
      success: true, data: { total: 1, ok: 0, already: 0, fail: 1, skipped: 0 },
    })
    if (init.method === 'DELETE') { accounts = []; return Response.json({ success: true }) }
    const payload = JSON.parse(String(init.body)) as Partial<AgentRouterAccountView>
    accounts = [{ ...accounts[0], ...payload }]
    // A persisted password never belongs in the read response.
    delete (accounts[0] as AgentRouterAccountView & { password?: string }).password
    return Response.json({ success: true, data: { id: ACCOUNT.id } })
  })
  const confirm = vi.fn(async () => checked)
  const source = AGENTROUTER_UI_JS.match(/\/\* AGENTROUTER_UI_BEGIN \*\/([\s\S]*?)\/\* AGENTROUTER_UI_END \*\//)![1]
  const escape = SHARED_JS.slice(SHARED_JS.indexOf('function escapeHtml'), SHARED_JS.indexOf('function escapeJsString'))
  const factory = new Function('document', 'fetch', 'cM', escape + source + `
    return {render:agentRouterRender,load:agentRouterLoad,refresh:agentRouterRefreshVisible,
      edit:agentRouterEdit,cancel:agentRouterCancel,save:agentRouterSave,busy:agentRouterBusy,
      action:agentRouterAction,bind:agentRouterBind,open:agentRouterOnCardOpen,
      badge:agentRouterBadge,money:agentRouterMoney}
  `)
  const api = factory({ querySelectorAll: () => blocks }, fetchMock, confirm) as UiApi
  return {
    api, blocks, requests, fetchMock, confirm,
    mode: (value: typeof mode) => { mode = value },
    confirmDelete: (value: boolean) => { checked = value },
  }
}

describe('AgentRouter SSR entry and inline-script safety', () => {
  it('renders in both provider cards with unique field IDs and no independent menu', async () => {
    const html = await render([provider('agentrouter'), provider('agentrouter-responses')])
    expect(html).toContain('data-agentrouter="agentrouter"')
    expect(html).toContain('data-agentrouter="agentrouter-responses"')
    expect(html).toContain('id="ar-email-agentrouter"')
    expect(html).toContain('id="ar-email-agentrouter-responses"')
    expect(html).not.toContain('href="#agentrouter"')
    expect(() => new Function(executableScripts(html))).not.toThrow()
    expect(html).toMatch(/type="password"[^>]+name="password"[^>]+autocomplete="new-password"/)
  })

  it('matches exact site hosts and leaves unrelated providers alone', async () => {
    const html = await render([
      provider('custom-router'), provider('responses-router', 'https://ps.air-outer.com/v1'),
      provider('other', 'https://example.com/v1'),
      provider('lookalike', 'https://agentrouter.org.evil.example/v1'),
    ])
    expect(html).toContain('data-agentrouter="custom-router"')
    expect(html).toContain('data-agentrouter="responses-router"')
    expect(html).not.toContain('data-agentrouter="other"')
    expect(html).not.toContain('data-agentrouter="lookalike"')
    expect(await render([])).not.toContain('data-agentrouter="')
  })

  it('both user-open and restored-open paths load through the same entry point', async () => {
    const js = executableScripts(await render([provider('agentrouter')]))
    expect(js.slice(js.indexOf('function tog('), js.indexOf('function m365Render('))).toContain('agentRouterOnCardOpen(d)')
    expect(js.slice(js.indexOf('function restoreAdminState('), js.indexOf('let adminSubmitting'))).toContain('agentRouterOnCardOpen(d)')
    const { api, blocks, fetchMock } = client()
    api.open({ querySelectorAll: () => blocks })
    await api.refresh()
    expect(fetchMock).toHaveBeenCalled()
    for (const block of blocks) expect(block._arAccounts).toHaveLength(1)
  })
})

describe('AgentRouter client control behavior', () => {
  it('preserves disabled controls across busy state and list replacement', () => {
    const { api, blocks } = client()
    const block = blocks[0]
    api.render(block, [ACCOUNT])
    api.busy(block, true)
    expect(block.disabled).toBe(true)
    expect(block.attributes['aria-busy']).toBe('true')
    api.render(block, [{ ...ACCOUNT, enabled: false }])
    api.busy(block, false)
    expect(block.disabled).toBe(false)
    expect(block.rows.find((control) => control.action === 'checkin')?.disabled).toBe(true)
    expect(block.toolbar[1].disabled).toBe(true)
    api.render(block, [{ ...ACCOUNT, credentialsReady: false }])
    expect(block.rows.find((control) => control.action === 'checkin')?.disabled).toBe(true)
  })

  it('creates via POST, preserves password spacing, clears the field, and updates both cards', async () => {
    const { api, blocks, requests } = client()
    const block = blocks[0]
    api.edit(block, null)
    const password = '  p#ass+"word"  '
    block.form.elements.email.value = ' main@example.com '
    block.form.elements.name.value = ' Main '
    block.form.elements.password.value = password
    await api.save(block)
    const mutation = requests.find((request) => request.init.method === 'POST')!
    expect(mutation.path).toBe('/admin/api/agentrouter/accounts')
    expect(JSON.parse(String(mutation.init.body))).toMatchObject({ email: ACCOUNT.email, password, name: 'Main', enabled: true })
    expect(block.form.elements.password.value).toBe('')
    expect(block.editor.classList.contains('hd')).toBe(true)
    expect(block._arBusy).toBe(false)
    for (const card of blocks) {
      expect(card._arAccounts).toHaveLength(1)
      expect(card.list.innerHTML).not.toContain(password)
    }
    expect(block.state.textContent).toBe('账号已保存')
  })

  it('edit uses PUT with optional password; locked credentials require replacement', async () => {
    const { api, blocks, requests } = client()
    const block = blocks[0]
    api.edit(block, ACCOUNT)
    expect(block.form.elements.email.readOnly).toBe(true)
    expect(block.form.elements.password.required).toBe(false)
    await api.save(block)
    const mutation = requests.find((request) => request.init.method === 'PUT')!
    expect(mutation.path).toBe('/admin/api/agentrouter/accounts/' + ACCOUNT.id)
    expect(JSON.parse(String(mutation.init.body)).password).toBe('')
    api.edit(block, { ...ACCOUNT, credentialsReady: false })
    expect(block.form.elements.password.required).toBe(true)
  })

  it('save failure leaves the editor open, clears the password, and exposes the error', async () => {
    const { api, blocks, mode } = client()
    const block = blocks[0]
    api.edit(block, null)
    block.form.elements.password.value = 'not-a-real-secret'
    mode('save-fail')
    await api.save(block)
    expect(block.form.elements.password.value).toBe('')
    expect(block.editor.classList.contains('hd')).toBe(false)
    expect(block.state.textContent).toContain('密码格式错误')
    expect(block.state.classList.contains('c-d')).toBe(true)
    expect(block.disabled).toBe(false)
  })

  it('cancel clears credentials without making a request', () => {
    const { api, blocks, fetchMock } = client()
    api.edit(blocks[0], null)
    blocks[0].form.elements.password.value = 'temporary-test-password'
    api.cancel(blocks[0])
    expect(blocks[0].form.elements.password.value).toBe('')
    expect(blocks[0].editor.classList.contains('hd')).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('toggle persists only the enabled field and refreshes every visible card', async () => {
    const { api, blocks, requests } = client()
    const block = blocks[0]
    const toggle = {
      ...input(), checked: false, matches: () => true,
      getAttribute: () => ACCOUNT.id,
    }
    await block.listeners.get('change')![0]({ target: toggle })
    const mutation = requests.find((request) => request.init.method === 'PUT')!
    expect(JSON.parse(String(mutation.init.body))).toEqual({ enabled: false })
    for (const card of blocks) {
      expect(card._arAccounts?.[0].enabled).toBe(false)
      expect(card.toolbar[1].disabled).toBe(true)
    }
    expect(block.disabled).toBe(false)
  })

  it('failed toggle restores the checkbox and names the failure', async () => {
    const { blocks, mode } = client()
    mode('save-fail')
    const toggle = { ...input(), checked: false, matches: () => true, getAttribute: () => ACCOUNT.id }
    await blocks[0].listeners.get('change')![0]({ target: toggle })
    expect(toggle.checked).toBe(true)
    expect(blocks[0].state.classList.contains('c-d')).toBe(true)
  })

  it('delete requires confirmation, removes the shared account, and cancels its open editor', async () => {
    const { api, blocks, requests, confirmDelete } = client()
    api.render(blocks[0], [ACCOUNT])
    await api.action(blocks[0], 'delete', ACCOUNT.id)
    expect(requests).toEqual([])
    confirmDelete(true)
    api.edit(blocks[0], ACCOUNT)
    await api.action(blocks[0], 'delete', ACCOUNT.id)
    expect(requests.find((request) => request.init.method === 'DELETE')?.path).toBe('/admin/api/agentrouter/accounts/' + ACCOUNT.id)
    for (const card of blocks) expect(card._arAccounts).toEqual([])
    expect(blocks[0].editor.classList.contains('hd')).toBe(true)
  })

  it('renders failures as unconfirmed and never turns null balances into zero', async () => {
    const { api, blocks } = client()
    await api.action(blocks[0], 'checkin-all')
    expect(blocks[0].state.textContent).toContain('未确认或失败 1')
    expect(blocks[0].state.classList.contains('c-d')).toBe(true)
    expect(api.money(null)).toBe('未知')
    expect(api.money(0)).toBe('$0.00')
    expect(api.badge(ACCOUNT)[1]).toBe('待首次签到')
    expect(api.badge({ ...ACCOUNT, checkedInToday: true })[1]).toBe('今日已签')
  })

  it('failed reads preserve the prior list and show a session/read error instead of success', async () => {
    const { api, blocks, mode } = client()
    api.render(blocks[0], [ACCOUNT])
    const previous = blocks[0].list.innerHTML
    mode('expired')
    expect(await api.load(blocks[0])).toBe(false)
    expect(blocks[0].state.textContent).toContain('登录已过期')
    expect(blocks[0].list.innerHTML).toBe(previous)
    mode('read-fail')
    api.edit(blocks[0], ACCOUNT)
    await api.save(blocks[0])
    expect(blocks[0].state.textContent).toContain('账号已保存，但状态读取失败')
    expect(blocks[0].state.classList.contains('c-d')).toBe(true)
  })

  it('escapes account names/email and status details before rendering', () => {
    const { api, blocks } = client()
    api.render(blocks[0], [{ ...ACCOUNT, name: '<img src=x onerror=alert(1)>', email: 'x"<tag>@example.com' }])
    expect(blocks[0].list.innerHTML).not.toContain('<img')
    expect(blocks[0].list.innerHTML).toContain('&lt;img')
    expect(blocks[0].list.innerHTML).toContain('x&quot;&lt;tag&gt;')
  })
})
