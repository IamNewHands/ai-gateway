import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { AGENTROUTER_UI_JS } from './agentrouter-ui'
import { SHARED_JS } from './shared.js'
import { renderAdminPage } from './pages'
import { setProviders } from './storage'
import type { AgentRouterAccountView, AgentRouterResult, AgentRouterSummary } from './agentrouter'
import type { AppEnv, Provider } from './types'

const ACCOUNT: AgentRouterAccountView = {
  id: 'a'.repeat(43), name: 'Main', email: 'main@example.com',
  enabled: true, hasPassword: true, credentialsReady: true, checkedInToday: false, result: null,
}
const RESULT: AgentRouterResult = {
  accountId: ACCOUNT.id, status: 'ok', checkedInDate: '2026-10-22', checkedInAt: 1_792_634_700_000,
  updatedAt: 1_792_634_701_000, quota: 0, usedQuota: 0, totalQuota: 0, quotaAt: 1_792_634_701_000,
  errorCode: null, warningCode: null,
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
  target: Control & { matches: (selector: string) => boolean; getAttribute: (name: string) => string | null; closest?: (selector: string) => Control | null }
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
      getAttribute: (name: string) => match[1].match(new RegExp(name + '="([^"]*)"'))?.[1] ?? null,
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
  contains(control: Control) { return this.toolbar.includes(control) || this.rows.includes(control) }
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
  let accounts: AgentRouterAccountView[] = [{ ...ACCOUNT }]
  let summary: AgentRouterSummary = { total: 1, ok: 0, already: 0, fail: 1, skipped: 0, results: [] }
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
    if (/\/checkin(?:\/[^/]+)?$/.test(path)) return Response.json({ success: true, data: summary })
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
    setAccounts: (value: AgentRouterAccountView[]) => { accounts = value },
    setSummary: (value: AgentRouterSummary) => { summary = value },
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
    const buttons = Array.from(html.matchAll(/<button[^>]*data-ar-action="checkin-all"[^>]*>([\s\S]*?)<\/button>/g))
    expect(buttons).toHaveLength(2)
    for (const button of buttons) expect(button[1]).toContain('全部手工签到')
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
  it('clicks the visible per-account button through its icon, blocks repeats, and refreshes both cards', async () => {
    const { api, blocks, requests, setAccounts, setSummary } = client()
    const block = blocks[0]
    setAccounts([{ ...ACCOUNT, checkedInToday: true, result: RESULT }])
    setSummary({ total: 1, ok: 1, already: 0, fail: 0, skipped: 0, results: [RESULT] })
    api.render(block, [ACCOUNT])
    const button = block.rows.find((control) => control.action === 'checkin')!
    expect(button.disabled).toBe(false)
    expect(button.getAttribute?.('aria-label')).toBe('手工签到 ' + ACCOUNT.email)
    const markup = block.list.innerHTML.match(/<button[^>]*data-ar-action="checkin"[^>]*>([\s\S]*?)<\/button>/)!
    expect(markup[1]).toContain('手工签到')
    const target = { ...input(), matches: () => false, getAttribute: () => null, closest: () => button }
    const click = block.listeners.get('click')![0]
    void click({ target })
    void click({ target })
    expect(block._arBusy).toBe(true)
    expect(block.disabled).toBe(true)
    expect(block.state.textContent).toContain('手工签到中（同时更新余额）')
    expect(requests.filter((request) => request.init.method === 'POST')).toHaveLength(1)
    await vi.waitFor(() => expect(block._arBusy).toBe(false))
    expect(requests.find((request) => request.init.method === 'POST')?.path).toBe('/admin/api/agentrouter/checkin/' + ACCOUNT.id)
    expect(block.attributes['aria-busy']).toBe('false')
    expect(block.disabled).toBe(false)
    expect(block.state.textContent).toContain('手工签到完成：成功 1')
    expect(block.state.classList.contains('c-d')).toBe(false)
    for (const card of blocks) {
      expect(card._arAccounts?.[0].checkedInToday).toBe(true)
      expect(card.list.innerHTML).toContain('<b>$0.00</b>')
    }
  })

  it.each([
    { name: 'a failed balance lookup', override: { warningCode: 'QUOTA_UNAVAILABLE' } },
    { name: 'an old failed check-in', override: { status: 'fail', errorCode: 'CHECKIN_FAILED' } },
    { name: 'an old missing identity', override: { status: 'unverified', errorCode: 'USER_ID_MISSING' } },
    { name: 'an old missing session', override: { status: 'unverified', errorCode: 'SESSION_MISSING' } },
    { name: 'a missing snapshot time', override: { quotaAt: null } },
    { name: 'a missing balance', override: { quota: null } },
    { name: 'a negative balance', override: { quota: -1 } },
    { name: 'a non-finite balance', override: { quota: Infinity } },
  ] satisfies { name: string; override: Partial<AgentRouterResult> }[])('shows unknown instead of login zero for $name without losing the daily badge', ({ override }) => {
    const { api, blocks } = client()
    api.render(blocks[0], [{ ...ACCOUNT, checkedInToday: true, result: { ...RESULT, ...override } }])
    const html = blocks[0].list.innerHTML
    expect(html).toContain('<b>未知</b>')
    expect(html).not.toContain('$0.00')
    expect(html).toContain('尚无有效余额数据')
    expect(html).toContain('今日已签')
    if (override.warningCode === 'QUOTA_UNAVAILABLE') expect(html).toContain('可点击手工签到重试')
  })

  it('keeps a valid self balance visible when check-in logs remain unconfirmed', () => {
    const { api, blocks } = client()
    api.render(blocks[0], [{ ...ACCOUNT, result: { ...RESULT, status: 'unverified', errorCode: 'CHECKIN_NOT_CONFIRMED' } }])
    expect(blocks[0].list.innerHTML).toContain('<b>$0.00</b>')
    expect(blocks[0].list.innerHTML).toContain('签到未确认')
    expect(blocks[0].list.innerHTML).not.toContain('尚无有效余额数据')
  })

  it('reports partial balance failures for bulk manual check-in and preserves confirmed results in both cards', async () => {
    const { api, blocks, requests, setAccounts, setSummary } = client()
    const failedQuota: AgentRouterResult = { ...RESULT, quota: null, usedQuota: null, totalQuota: null, quotaAt: null, warningCode: 'QUOTA_UNAVAILABLE' }
    const second = { ...ACCOUNT, id: 'b'.repeat(43), email: 'second@example.com', checkedInToday: true }
    const validQuota: AgentRouterResult = { ...RESULT, accountId: second.id, quota: 3 }
    setAccounts([{ ...ACCOUNT, checkedInToday: true, result: failedQuota }, { ...second, result: validQuota }])
    setSummary({ total: 2, ok: 2, already: 0, fail: 0, skipped: 0, results: [failedQuota, validQuota] })
    await api.action(blocks[0], 'checkin-all')
    expect(requests.find((request) => request.init.method === 'POST')?.path).toBe('/admin/api/agentrouter/checkin')
    expect(blocks[0].state.textContent).toContain('成功 2')
    expect(blocks[0].state.textContent).toContain('本次余额读取失败 1')
    expect(blocks[0].state.classList.contains('c-d')).toBe(true)
    expect(blocks[0]._arBusy).toBe(false)
    for (const card of blocks) {
      expect(card._arAccounts?.every((account) => account.checkedInToday)).toBe(true)
      expect(card.list.innerHTML).toContain('<b>未知</b>')
      expect(card.list.innerHTML).toContain('<b>$3.00</b>')
    }
  })

  it.each(['checkin', 'checkin-all'])('invalidates only failed quota in cached cards when %s succeeds but status refresh fails', async (action) => {
    const { api, blocks, mode, setSummary, setAccounts } = client()
    const failedQuota: AgentRouterResult = { ...RESULT, quota: null, usedQuota: null, totalQuota: null, quotaAt: null, warningCode: 'QUOTA_UNAVAILABLE' }
    const second: AgentRouterAccountView = { ...ACCOUNT, id: 'b'.repeat(43), email: 'second@example.com', checkedInToday: true, result: { ...RESULT, accountId: 'b'.repeat(43), quota: 3 } }
    const previous = [{ ...ACCOUNT, checkedInToday: true, result: RESULT }, second]
    for (const card of blocks) api.render(card, previous)
    setSummary({ total: 1, ok: 1, already: 0, fail: 0, skipped: 0, results: [failedQuota] })
    mode('read-fail')
    await api.action(blocks[0], action, action === 'checkin' ? ACCOUNT.id : undefined)
    expect(blocks[0].state.textContent).toContain('本次余额读取失败 1')
    expect(blocks[0].state.textContent).toContain('状态读取失败，请刷新状态')
    expect(blocks[0].state.classList.contains('c-d')).toBe(true)
    expect(blocks[0]._arBusy).toBe(false)
    for (const card of blocks) {
      expect(card._arAccounts?.[0]).toMatchObject({ id: ACCOUNT.id, email: ACCOUNT.email, credentialsReady: true, checkedInToday: true, result: failedQuota })
      expect(card._arAccounts?.[1]).toBe(second)
      expect(card.list.innerHTML).toContain('<b>未知</b>')
      expect(card.list.innerHTML).not.toContain('$0.00')
      expect(card.list.innerHTML).toContain('<b>$3.00</b>')
      expect(card.list.innerHTML).toContain('今日已签')
    }
    mode('ok')
    const recoveredQuota = { ...RESULT, updatedAt: RESULT.updatedAt + 60_000, quotaAt: RESULT.quotaAt! + 60_000 }
    setAccounts([{ ...previous[0], result: recoveredQuota }, second])
    expect(await api.refresh()).toBe(true)
    for (const card of blocks) expect(card.list.innerHTML).toContain('<b>$0.00</b>')
  })

  it.each(['checkin', 'checkin-all'].flatMap((action) => [
    { name: 'older', returnedResult: { ...RESULT, updatedAt: RESULT.updatedAt - 60_000 } },
    { name: 'equal-time', returnedResult: RESULT },
    { name: 'missing', returnedResult: null },
    { name: 'unusable-time', returnedResult: { ...RESULT, updatedAt: Number.NaN } },
  ].map((snapshot) => ({ ...snapshot, action }))))('keeps the completed $action failure over a $name previous snapshot from a successful read', async ({ action, returnedResult }) => {
    const { api, blocks, setAccounts, setSummary } = client()
    const failedQuota: AgentRouterResult = { ...RESULT, quota: null, usedQuota: null, totalQuota: null, quotaAt: null, warningCode: 'QUOTA_UNAVAILABLE' }
    const second: AgentRouterAccountView = { ...ACCOUNT, id: 'b'.repeat(43), email: 'second@example.com', checkedInToday: true, result: { ...RESULT, accountId: 'b'.repeat(43), quota: 3 } }
    for (const card of blocks) api.render(card, [{ ...ACCOUNT, checkedInToday: true, result: RESULT }, second])
    setAccounts([{ ...ACCOUNT, checkedInToday: true, result: returnedResult }, second])
    setSummary({ total: 1, ok: 1, already: 0, fail: 0, skipped: 0, results: [failedQuota] })
    await api.action(blocks[0], action, action === 'checkin' ? ACCOUNT.id : undefined)
    expect(blocks[0].state.textContent).toContain('余额读取失败 1')
    expect(blocks[0].state.textContent).not.toContain('状态读取失败')
    expect(blocks[0]._arBusy).toBe(false)
    for (const card of blocks) {
      expect(card._arAccounts?.[0]).toMatchObject({ id: ACCOUNT.id, email: ACCOUNT.email, credentialsReady: true, checkedInToday: true, result: failedQuota })
      expect(card._arAccounts?.[1]).toEqual(second)
      expect(card.list.innerHTML).toContain('<b>未知</b>')
      expect(card.list.innerHTML).not.toContain('$0.00')
      expect(card.list.innerHTML).toContain('<b>$3.00</b>')
    }
    // A second successful GET must not forget the already-known failure either.
    expect(await api.refresh()).toBe(true)
    for (const card of blocks) expect(card._arAccounts?.[0].result).toEqual(failedQuota)
  })

  it.each(['checkin', 'checkin-all'].flatMap((action) => [0, 2].map((quota) => ({ action, quota }))))('retains a demonstrably newer self snapshot ($quota USD) after $action reports an earlier quota failure', async ({ action, quota }) => {
    const { api, blocks, setAccounts, setSummary } = client()
    const failedQuota: AgentRouterResult = { ...RESULT, quota: null, usedQuota: null, totalQuota: null, quotaAt: null, warningCode: 'QUOTA_UNAVAILABLE' }
    const newerQuota: AgentRouterResult = { ...RESULT, quota, usedQuota: 0, totalQuota: quota, updatedAt: RESULT.updatedAt + 60_000, quotaAt: RESULT.updatedAt + 60_000 }
    const account = { ...ACCOUNT, checkedInToday: true, result: newerQuota }
    for (const card of blocks) api.render(card, [{ ...ACCOUNT, checkedInToday: true, result: failedQuota }])
    setAccounts([account])
    setSummary({ total: 1, ok: 1, already: 0, fail: 0, skipped: 0, results: [failedQuota] })
    await api.action(blocks[0], action, action === 'checkin' ? ACCOUNT.id : undefined)
    expect(blocks[0].state.textContent).toContain('余额读取失败 1')
    expect(blocks[0].state.textContent).not.toContain('显示未知')
    for (const card of blocks) {
      expect(card._arAccounts?.[0]).toEqual(account)
      expect(card.list.innerHTML).toContain('<b>$' + quota.toFixed(2) + '</b>')
      expect(card.list.innerHTML).not.toContain('<b>未知</b>')
    }
    expect(await api.refresh()).toBe(true)
    for (const card of blocks) expect(card._arAccounts?.[0].result).toEqual(newerQuota)
  })

  it.each(['checkin', 'checkin-all'].flatMap((action) => [0, 2].flatMap((quota) =>
    ['read-fail', 'old-failure', 'old-zero'].map((read) => ({ action, quota, read }))
  )))('keeps a newer successful $action balance ($quota USD) across $read and later stale reads', async ({ action, quota, read }) => {
    const { api, blocks, mode, setAccounts, setSummary } = client()
    const oldFailure: AgentRouterResult = { ...RESULT, quota: null, usedQuota: null, totalQuota: null, quotaAt: null, warningCode: 'QUOTA_UNAVAILABLE' }
    const recovered: AgentRouterResult = { ...RESULT, quota, usedQuota: 0, totalQuota: quota, updatedAt: RESULT.updatedAt + 60_000, quotaAt: RESULT.updatedAt + 60_000 }
    const second: AgentRouterAccountView = { ...ACCOUNT, id: 'b'.repeat(43), email: 'second@example.com', checkedInToday: true, result: { ...RESULT, accountId: 'b'.repeat(43), quota: 3 } }
    for (const card of blocks) api.render(card, [{ ...ACCOUNT, checkedInToday: true, result: oldFailure }, second])
    setAccounts([{ ...ACCOUNT, checkedInToday: true, result: read === 'old-zero' ? RESULT : oldFailure }, second])
    if (read === 'read-fail') mode('read-fail')
    setSummary({ total: 1, ok: 1, already: 0, fail: 0, skipped: 0, results: [recovered] })
    await api.action(blocks[0], action, action === 'checkin' ? ACCOUNT.id : undefined)
    expect(blocks[0].state.textContent).toContain('手工签到完成：成功 1')
    expect(blocks[0].state.textContent).not.toContain('余额读取失败')
    expect(blocks[0].state.classList.contains('c-d')).toBe(read === 'read-fail')
    expect(blocks[0]._arBusy).toBe(false)
    for (const card of blocks) {
      expect(card._arAccounts?.[0]).toMatchObject({ checkedInToday: true, credentialsReady: true, result: recovered })
      expect(card.list.innerHTML).toContain('<b>$' + quota.toFixed(2) + '</b>')
      expect(card.list.innerHTML).toContain('<b>$3.00</b>')
      expect(card.list.innerHTML).not.toContain('余额读取失败')
    }
    mode('ok')
    expect(await api.refresh()).toBe(true)
    for (const card of blocks) expect(card._arAccounts?.[0].result).toEqual(recovered)
  })

  it('prefers the direct check-in result on equal timestamps and ignores skipped results', async () => {
    const { api, blocks, setAccounts, setSummary } = client()
    const cachedFailure = { ...RESULT, quota: null, usedQuota: null, totalQuota: null, quotaAt: null, warningCode: 'QUOTA_UNAVAILABLE' }
    const confirmed = { ...ACCOUNT, checkedInToday: true, result: RESULT }
    for (const card of blocks) api.render(card, [{ ...confirmed, result: cachedFailure }])
    setAccounts([{ ...confirmed, name: 'Updated account name', enabled: false, result: cachedFailure }])
    setSummary({ total: 1, ok: 1, already: 0, fail: 0, skipped: 0, results: [RESULT] })
    await api.action(blocks[0], 'checkin', ACCOUNT.id)
    for (const card of blocks) expect(card._arAccounts?.[0]).toMatchObject({ name: 'Updated account name', enabled: false, checkedInToday: true, result: RESULT })
    setSummary({ total: 1, ok: 0, already: 0, fail: 0, skipped: 1, results: [{ ...RESULT, status: 'disabled', quota: null, updatedAt: RESULT.updatedAt + 60_000 }] })
    await api.action(blocks[0], 'checkin-all')
    for (const card of blocks) expect(card._arAccounts?.[0].result).toEqual(RESULT)
    setAccounts([])
    expect(await api.refresh()).toBe(true)
    for (const card of blocks) expect(card._arAccounts).toEqual([])
  })

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
