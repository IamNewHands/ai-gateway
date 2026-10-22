// String.raw keeps client-side escaping intact in the SSR template.
export const AGENTROUTER_UI_JS = String.raw`
/* AGENTROUTER_UI_BEGIN */
function agentRouterMessage(code) {
  var messages = {
    SESSION_EXPIRED: '后台登录已过期，请重新登录',
    REQUEST_TOO_LARGE: '账号数据超过大小限制',
    INVALID_ACCOUNT: '账号数据格式错误',
    INVALID_EMAIL: '请输入有效的绑定邮箱',
    INVALID_NAME: '备注过长',
    INVALID_ENABLED: '自动签到开关格式错误',
    INVALID_PASSWORD: '密码格式错误或过长',
    PASSWORD_REQUIRED: '请输入 AgentRouter 站内密码',
    EMAIL_IMMUTABLE: '邮箱不可修改，请添加另一个账号',
    ACCOUNT_EXISTS: '此邮箱已配置，请编辑已有账号',
    ACCOUNT_LIMIT: '最多保存 20 个账号',
    ACCOUNT_NOT_FOUND: '账号已删除，请刷新状态',
    CREDENTIAL_KEY_MISSING: '网关管理员密码未配置，无法保存凭据',
    CREDENTIALS_LOCKED: '凭据无法解密，请编辑并重新填写站内密码',
    LOGIN_FAILED: '登录被拒绝，请检查邮箱和站内密码',
    REQUEST_TIMEOUT: 'AgentRouter 请求超时，下次定时任务会重试',
    NETWORK_ERROR: '无法连接 AgentRouter，下次定时任务会重试',
    UPSTREAM_AUTH: 'AgentRouter 登录态无效，请重新签到',
    UPSTREAM_BLOCKED: 'AgentRouter 返回风控页面，尚未完成签到',
    UPSTREAM_RATE_LIMIT: 'AgentRouter 暂时限流，下次定时任务会重试',
    UNSAFE_REDIRECT: '接口跨站跳转已被拒绝',
    UPSTREAM_REDIRECT: 'AgentRouter 接口发生跳转，未完成核验',
    INVALID_RESPONSE: 'AgentRouter 返回了非预期数据',
    RESPONSE_TOO_LARGE: 'AgentRouter 响应超出大小限制',
    USER_ID_MISSING: '登录成功但未返回用户 ID，签到未确认',
    SESSION_MISSING: '登录成功但未返回 Cookie，签到未确认',
    INVALID_LOGS: '无法读取签到日志，签到未确认',
    CHECKIN_NOT_CONFIRMED: '登录成功，但未找到今天的签到成功日志',
    QUOTA_UNAVAILABLE: '余额读取失败',
    RESULT_STORAGE_FAILED: '签到结果保存失败，请刷新后重试'
  }
  if (messages[code]) return messages[code]
  if (/^UPSTREAM_HTTP_\d+$/.test(code || '')) return 'AgentRouter 返回 HTTP ' + code.slice(14)
  return '请求失败，请稍后重试'
}
function agentRouterMoney(value) {
  return typeof value === 'number' && Number.isFinite(value) ? '$' + value.toFixed(2) : '未知'
}
function agentRouterTime(at) {
  return typeof at === 'number' && at > 0 ? new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '未运行'
}
function agentRouterBadge(account) {
  if (!account.enabled) return ['bd-off', '已暂停']
  if (account.checkedInToday) return ['bd-on', '今日已签']
  if (!account.credentialsReady) return ['bd-danger', '需更新密码']
  var result = account.result
  if (!result) return ['bd-off', '待首次签到']
  if (result.status === 'fail') return ['bd-danger', '签到失败']
  if (result.status === 'unverified') return ['bd-warn', '签到未确认']
  return ['bd-off', '今日待签']
}
function agentRouterState(block, text, failed) {
  var state = block.querySelector('.agentrouter-state')
  if (!state) return
  state.textContent = text
  state.classList.toggle('c-d', !!failed)
}
function agentRouterRender(block, accounts) {
  block._arAccounts = accounts
  var checkinAll = block.querySelector('[data-ar-action="checkin-all"]')
  if (checkinAll) checkinAll.disabled = !accounts.some(function(account) { return account.enabled && account.credentialsReady })
  var list = block.querySelector('.agentrouter-list')
  if (!list) return
  if (!accounts.length) {
    list.innerHTML = '<p class="mu agentrouter-empty">暂无签到账号</p>'
    return
  }
  list.innerHTML = accounts.map(function(account) {
    var result = account.result || {}
    var badge = agentRouterBadge(account)
    var note = !account.credentialsReady ? agentRouterMessage('CREDENTIALS_LOCKED') :
      result.errorCode ? agentRouterMessage(result.errorCode) :
      account.checkedInToday ? '今天的签到日志已确认' : ''
    if (result.warningCode) note += (note ? '；' : '') + agentRouterMessage(result.warningCode)
    var id = escapeHtml(account.id)
    return '<article class="agentrouter-row">' +
      '<div class="agentrouter-account"><strong>' + escapeHtml(account.name) + '</strong>' +
      '<span>' + escapeHtml(account.email) + '</span>' +
      '<small title="北京时间">' + escapeHtml(agentRouterTime(result.updatedAt)) + '</small></div>' +
      '<div class="agentrouter-outcome"><span class="bd ' + badge[0] + '">' + badge[1] + '</span>' +
      (note ? '<small>' + escapeHtml(note) + '</small>' : '') + '</div>' +
      '<div class="agentrouter-quota"><b>' + agentRouterMoney(result.quota) + '</b><small>余额 USD</small>' +
      '<small title="北京时间">数据 ' + escapeHtml(agentRouterTime(result.quotaAt)) + '</small></div>' +
      '<div class="agentrouter-actions"><label class="tg" title="每日自动签到"><input type="checkbox" data-ar-toggle="' + id + '" aria-label="每日自动签到 ' + escapeHtml(account.email) + '"' + (account.enabled ? ' checked' : '') + '><span class="sl"></span></label>' +
      '<button type="button" class="icon-btn" data-ar-action="checkin" data-ar-id="' + id + '" title="立即签到" aria-label="立即签到"' + (!account.enabled || !account.credentialsReady ? ' disabled' : '') + '><i class="fas fa-calendar-check" aria-hidden="true"></i></button>' +
      '<button type="button" class="icon-btn" data-ar-action="edit" data-ar-id="' + id + '" title="编辑账号" aria-label="编辑账号"><i class="fas fa-pen" aria-hidden="true"></i></button>' +
      '<button type="button" class="icon-btn c-d" data-ar-action="delete" data-ar-id="' + id + '" title="删除签到账号" aria-label="删除签到账号"><i class="fas fa-trash" aria-hidden="true"></i></button></div></article>'
  }).join('')
}
async function agentRouterFetch(path, options) {
  var response = await fetch('/admin/api/agentrouter' + path, options)
  var data
  try { data = await response.json() } catch(e) { throw new Error('INVALID_RESPONSE') }
  if (!response.ok || !data.success) {
    if (response.status === 401) throw new Error('SESSION_EXPIRED')
    if (response.status === 413) throw new Error('REQUEST_TOO_LARGE')
    throw new Error(data.code || 'REQUEST_FAILED')
  }
  return data.data
}
async function agentRouterLoad(block) {
  if (!block) return false
  if (block._arLoading) return block._arLoading
  var list = block.querySelector('.agentrouter-list')
  if (list && !block._arAccounts) list.innerHTML = '<p class="mu agentrouter-empty">读取中...</p>'
  block._arLoading = (async function() {
    try {
      var accounts = await agentRouterFetch('/accounts')
      if (!Array.isArray(accounts)) throw new Error('INVALID_RESPONSE')
      agentRouterRender(block, accounts)
      agentRouterState(block, '', false)
      return true
    } catch(e) {
      agentRouterState(block, agentRouterMessage(e.message), true)
      if (list && !block._arAccounts) list.innerHTML = ''
      return false
    } finally { block._arLoading = null }
  })()
  return block._arLoading
}
function agentRouterRefreshVisible() {
  return Promise.all(Array.from(document.querySelectorAll('.pd.open [data-agentrouter]')).map(async function(block) {
    // Wait for any pre-mutation read before requesting the saved state.
    if (block._arLoading) await block._arLoading
    return agentRouterLoad(block)
  })).then(function(results) { return results.every(Boolean) })
}
function agentRouterEdit(block, account) {
  var editor = block.querySelector('.agentrouter-editor')
  var form = block.querySelector('.agentrouter-form')
  if (!editor || !form) return
  block._arEditId = account ? account.id : ''
  form.elements.email.value = account ? account.email : ''
  form.elements.email.readOnly = !!account
  form.elements.name.value = account ? account.name : ''
  form.elements.password.value = ''
  form.elements.password.required = !account || !account.credentialsReady
  form.elements.password.placeholder = account && account.credentialsReady ? '留空保留已保存的密码' : ''
  form.elements.enabled.checked = !account || account.enabled
  editor.classList.remove('hd')
  ;(account ? form.elements.password : form.elements.email).focus()
}
function agentRouterCancel(block) {
  var editor = block.querySelector('.agentrouter-editor')
  var form = block.querySelector('.agentrouter-form')
  if (form) {
    form.elements.password.value = ''
    form.reset()
  }
  if (editor) editor.classList.add('hd')
  block._arEditId = ''
}
function agentRouterBusy(block, busy) {
  block._arBusy = busy
  // The fieldset disables new rows too without changing their own disabled state.
  block.disabled = busy
  block.setAttribute('aria-busy', String(busy))
}
async function agentRouterSave(block) {
  if (block._arBusy) return
  var form = block.querySelector('.agentrouter-form')
  if (!form || !form.reportValidity()) return
  var id = block._arEditId
  var payload = {
    email: form.elements.email.value.trim(),
    name: form.elements.name.value.trim(),
    password: form.elements.password.value,
    enabled: form.elements.enabled.checked
  }
  agentRouterBusy(block, true)
  try {
    await agentRouterFetch('/accounts' + (id ? '/' + encodeURIComponent(id) : ''), {
      method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    })
    agentRouterCancel(block)
    var refreshed = await agentRouterRefreshVisible()
    agentRouterState(block, refreshed ? '账号已保存' : '账号已保存，但状态读取失败，请刷新状态', !refreshed)
  } catch(e) {
    agentRouterState(block, agentRouterMessage(e.message), true)
  } finally {
    payload.password = ''
    form.elements.password.value = ''
    agentRouterBusy(block, false)
  }
}
async function agentRouterAction(block, action, id) {
  if (!block || block._arBusy) return
  var account = (block._arAccounts || []).find(function(a) { return a.id === id })
  if (action === 'add') { agentRouterEdit(block, null); return }
  if (action === 'edit') { if (account) agentRouterEdit(block, account); return }
  if (action === 'cancel') { agentRouterCancel(block); return }
  if (action === 'refresh') { await agentRouterLoad(block); return }
  if (action === 'delete') {
    if (!account || !(await cM('删除签到账号 ' + escapeHtml(account.email) + '？邮箱和已保存密码将被移除。'))) return
  }
  agentRouterBusy(block, true)
  agentRouterState(block, action === 'delete' ? '删除中...' : '签到中...', false)
  try {
    if (action === 'delete') {
      await agentRouterFetch('/accounts/' + encodeURIComponent(id), { method: 'DELETE' })
      if (block._arEditId === id) agentRouterCancel(block)
      var refreshed = await agentRouterRefreshVisible()
      agentRouterState(block, refreshed ? '签到账号已删除' : '账号已删除，但状态读取失败，请刷新状态', !refreshed)
    } else if (action === 'checkin' || action === 'checkin-all') {
      var summary = await agentRouterFetch('/checkin' + (id ? '/' + encodeURIComponent(id) : ''), { method: 'POST' })
      var refreshed = await agentRouterRefreshVisible()
      var text = '签到完成：成功 ' + summary.ok + ' / 已签 ' + summary.already + ' / 未确认或失败 ' + summary.fail + ' / 暂停 ' + summary.skipped
      if (!refreshed) text += '；状态读取失败，请刷新状态'
      agentRouterState(block, text, summary.fail > 0 || !refreshed)
    }
  } catch(e) {
    agentRouterState(block, agentRouterMessage(e.message), true)
  } finally { agentRouterBusy(block, false) }
}
function agentRouterBind(block) {
  if (block._arBound) return
  block._arBound = true
  block.addEventListener('click', function(event) {
    var button = event.target.closest('[data-ar-action]')
    if (button && block.contains(button)) {
      void agentRouterAction(block, button.getAttribute('data-ar-action'), button.getAttribute('data-ar-id') || '')
    }
  })
  block.addEventListener('submit', function(event) {
    if (event.target.matches('.agentrouter-form')) { event.preventDefault(); void agentRouterSave(block) }
  })
  block.addEventListener('change', async function(event) {
    var toggle = event.target
    if (!toggle.matches('[data-ar-toggle]') || block._arBusy) return
    var id = toggle.getAttribute('data-ar-toggle')
    var enabled = toggle.checked
    agentRouterBusy(block, true)
    try {
      await agentRouterFetch('/accounts/' + encodeURIComponent(id), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: enabled })
      })
      var refreshed = await agentRouterRefreshVisible()
      var text = enabled ? '每日自动签到已启用' : '每日自动签到已暂停'
      if (!refreshed) text += '，但状态读取失败，请刷新状态'
      agentRouterState(block, text, !refreshed)
    } catch(e) {
      toggle.checked = !enabled
      agentRouterState(block, agentRouterMessage(e.message), true)
    } finally { agentRouterBusy(block, false) }
  })
}
function agentRouterOnCardOpen(root) {
  if (!root) return
  root.querySelectorAll('[data-agentrouter]').forEach(function(block) {
    agentRouterBind(block)
    void agentRouterLoad(block)
  })
}
document.querySelectorAll('[data-agentrouter]').forEach(agentRouterBind)
/* AGENTROUTER_UI_END */
`
