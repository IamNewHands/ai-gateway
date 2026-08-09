// 公共页脚渲染函数 — 主页与 /admin 页复用，保证两处页脚一致
export const SITE_REPO_URL = 'https://github.com/IamNewHands/ai-gateway'
export function renderSiteFooter(title: string): string {
  return `<footer class="site-footer">
  <div class="shell site-footer__inner">
    <span>© \${new Date().getFullYear()} <a class="site-footer__link" href="\${SITE_REPO_URL}" target="_blank" rel="noreferrer">\${title}</a></span>
    <span>Cloudflare Workers · Hono · KV</span>
  </div>
</footer>`
}

// 共享 JS 工具函数 — 注入到后台页面的 <script> 块中
export const SHARED_JS = `
// ── 工具函数 ──
function normalizeUrl(url) {
    return url.replace(/\\/$/, '')
  }
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
// JS 字符串字面量转义（内联 onclick 里单/双引号字符串）
function escapeJsString(value) {
  return String(value == null ? '' : value)
    .replace(/\\\\/g, '\\\\\\\\')
    .replace(/'/g, "\\\\'")
    .replace(/"/g, '\\\\"')
    .replace(/\\n/g, '\\\\n')
    .replace(/\\r/g, '\\\\r')
    .replace(/\\t/g, '\\\\t')
}
// JS 字符串 → 内联事件属性 双转义（先 JS 再 HTML，两个上下文都防住）
function escapeJsAttr(value) { return escapeHtml(escapeJsString(value)) }
function buildAuthHeaders(apiType, key) {
  return apiType === 'anthropic'
    ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    : { 'Authorization': 'Bearer ' + key }
}

// ── UI 函数 ──
function showSpinner(el) {
  el.innerHTML = '<span class="mu"><i class="fas fa-spinner fa-spin"></i> 测试中...</span>'
}
function showResult(el, success, msg) {
  el.innerHTML = success
    ? '<div class="al al-s"><i class="fas fa-check-circle"></i> 连接成功</div>'
    : '<div class="al al-e"><i class="fas fa-times-circle"></i> ' + escapeHtml(msg || '连接失败') + '</div>'
}

// ── API 请求函数 ──
async function testKeyConnection(url, apiType, key, providerId) {
  try {
    var r = await fetch('/admin/api/test-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url, apiKey: key, apiType: apiType, providerId: providerId })
    })
    var d = await r.json()
    if (d.success && d.data) {
      return { success: d.data.success, status: d.data.statusCode, data: d.data.data, message: d.data.message }
    }
    return { success: false, status: 0, data: null }
  } catch (e) {
    return { success: false, status: 0, data: null }
  }
}
async function testModelConnection(url, apiType, key, modelId, providerId) {
  try {
    var r = await fetch('/admin/api/test-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url, apiKey: key, apiType: apiType, model: modelId, providerId: providerId })
    })
    var d = await r.json()
    if (d.success && d.data) {
      return { success: d.data.success, status: d.data.statusCode }
    }
    return { success: false, status: 0 }
  } catch (e) {
    return { success: false, status: 0 }
  }
}

// 切换某个 API Key 输入框的明文/密文显示（btn 为触发的眼睛按钮）
function toggleKeyText(btn) {
  const row = btn.closest('.field-row')
  if (!row) return
  const inp = row.querySelector('input[type="password"], input[type="text"]')
  if (!inp) return
  const show = inp.type === 'password'
  inp.type = show ? 'text' : 'password'
  const ic = btn.querySelector('i')
  if (ic) ic.className = show ? 'fas fa-eye-slash' : 'fas fa-eye'
}
`