import { Context } from 'hono'
import { getProviders, getProxyKeys } from './storage'
import { SITE_CONFIG, OPENCODE_DEFAULT_URL } from './config'
import type { Env, OAuthDeviceConfig } from './types'
import { CSS_CONTENT } from './pages.css'
import { SHARED_JS } from './shared.js'

// 前端页面模板：仅重构视觉与交互，保持后端路由、KV 结构和 API 契约不变。
const escapePageHtml = (value: unknown) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')

/**
 * 根据已保存的 OAuth 配置反推匹配的预置模板名称（用于编辑表单回显选中项）。
 * 预置模板本身不作为字段存储，但 deviceCodeUrl 是每个预置的唯一标识，
 * 据此即可稳定反推。返回 'workbuddy' | 'qoder' | ''（空 = 自定义/未匹配）。
 */
const detectOauthPreset = (oauth?: OAuthDeviceConfig): string => {
  if (oauth?.flowType === 'gemini') return 'gemini'
  const url = oauth?.deviceCodeUrl || ''
  if (!url) return ''
  if (url.includes('copilot.tencent.com/v2/plugin/auth/state')) return 'workbuddy'
  if (url.includes('qoder.com.cn/device/selectAccounts')) return 'qoder'
  return ''
}

const H = (title: string) => `
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <meta name="theme-color" content="oklch(98.5% 0.004 250)">
  <title>${title} — ${SITE_CONFIG.title}</title>
  <link rel="icon" href="${SITE_CONFIG.favicon}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&amp;family=JetBrains+Mono:wght@400;500;600&amp;family=Space+Grotesk:wght@500;600&amp;display=swap" rel="stylesheet">
  <link rel="stylesheet" href="${SITE_CONFIG.faCdn}">
  <style>${CSS_CONTENT}</style>
</head>`

// ===== 首页 =====

export async function renderHomePage(c: Context<{ Bindings: Env }>, isLoggedIn: boolean) {
  // 首页仅展示占位示例，不暴露真实部署域名，避免泄露隐私链接
  const apiBase = 'https://自定义的域名/v1'

  return c.html(`<!DOCTYPE html><html lang="zh-CN">
${H('首页')}
<body class="site-page home-page">
<header class="topbar">
  <div class="shell topbar__inner">
    <a class="brand" href="/" aria-label="AI Gateway 首页">
      <span class="brand__mark" aria-hidden="true"><i class="fas fa-cloud"></i></span>
      <span class="brand__name">${SITE_CONFIG.title}</span>
      <span class="brand__descriptor">API CONTROL PLANE</span>
    </a>
    <nav class="topbar__actions" aria-label="主导航">
      ${isLoggedIn
        ? `<a href="/admin" class="btn btn-p"><i class="fas fa-sliders-h" aria-hidden="true"></i>管理控制台</a><a href="/admin/logout" class="btn btn-gh"><i class="fas fa-sign-out-alt" aria-hidden="true"></i>退出</a>`
        : `<a href="/admin/login" class="btn btn-p"><i class="fas fa-sign-in-alt" aria-hidden="true"></i>管理员登录</a>`
      }
    </nav>
  </div>
</header>

<main>
  <section class="shell home-hero" aria-labelledby="home-title">
    <div class="home-hero__copy">
      <p class="eyebrow"><span aria-hidden="true"></span>UNIFIED AI GATEWAY</p>
      <h1 id="home-title">一个 API，调用已配置的所有模型。</h1>
      <p class="home-hero__lede">统一的 OpenAI / Anthropic 兼容入口。模型按提供商归档，转发 Key、启用状态和故障转移集中管理。</p>
      <div class="endpoint-box" aria-label="API 接入地址">
        <span class="endpoint-box__label">BASE URL</span>
        <code>${escapePageHtml(apiBase)}</code>
        <button class="icon-btn copy-control" type="button" data-copy="${escapePageHtml(apiBase)}" aria-label="复制 API 地址">
          <i class="far fa-copy" aria-hidden="true"></i><span>复制</span>
        </button>
      </div>
      <p id="copy-status" class="sr-status" aria-live="polite"></p>
    </div>

    <figure class="request-panel" aria-labelledby="request-caption">
      <figcaption id="request-caption">
        <span>POST /chat/completions</span>
        <span class="protocol-state"><i aria-hidden="true"></i>OPENAI COMPATIBLE</span>
      </figcaption>
      <pre><code><span class="syntax-command">curl</span> ${escapePageHtml(apiBase)}/chat/completions \\
  <span class="syntax-key">-H</span> <span class="syntax-string">"Authorization: Bearer sk_cf_••••"</span> \\
  <span class="syntax-key">-H</span> <span class="syntax-string">"Content-Type: application/json"</span> \\
  <span class="syntax-key">-d</span> <span class="syntax-string">'{
    "model": "opencode/deepseek-v4-flash-free",
    "messages": [{ "role": "user", "content": "Hello" }]
  }'</span></code></pre>
      <div class="request-panel__foot">
        <span>模型格式</span>
        <code>provider/model</code>
      </div>
    </figure>
  </section>
</main>

<footer class="site-footer">
  <div class="shell site-footer__inner">
    <span>© ${new Date().getFullYear()} ${SITE_CONFIG.title}</span>
    <span>Cloudflare Workers · Hono · KV</span>
  </div>
</footer>

<script>
(function () {
  var status = document.getElementById('copy-status')
  document.querySelectorAll('.copy-control').forEach(function (button) {
    button.addEventListener('click', async function () {
      var text = button.getAttribute('data-copy') || ''
      var icon = button.querySelector('i')
      var label = button.querySelector('span')
      try {
        await navigator.clipboard.writeText(text)
        button.setAttribute('data-state', 'success')
        if (icon) icon.className = 'fas fa-check'
        if (label) label.textContent = '已复制'
        if (status) status.textContent = '已复制 ' + text
        window.setTimeout(function () {
          button.removeAttribute('data-state')
          if (icon) icon.className = 'far fa-copy'
          if (label) label.textContent = '复制'
        }, 1800)
      } catch (error) {
        button.setAttribute('data-state', 'error')
        if (status) status.textContent = '复制失败，请手动选择文本。'
      }
    })
  })
})()
</script>
</body></html>`)
}

// ===== 登录页 =====

export async function renderLoginPage(c: Context<{ Bindings: Env }>) {
  return c.html(`<!DOCTYPE html><html lang="zh-CN">
${H('登录')}
<body class="site-page auth-page">
<header class="topbar topbar--auth">
  <div class="shell topbar__inner">
    <a class="brand" href="/" aria-label="AI Gateway 首页">
      <span class="brand__mark" aria-hidden="true"><i class="fas fa-cloud"></i></span>
      <span class="brand__name">${SITE_CONFIG.title}</span>
    </a>
    <a href="/" class="btn btn-gh"><i class="fas fa-arrow-left" aria-hidden="true"></i>返回首页</a>
  </div>
</header>

<main class="auth-shell">
  <section class="auth-context" aria-labelledby="auth-context-title">
    <p class="eyebrow"><span aria-hidden="true"></span>CONTROL PLANE ACCESS</p>
    <h1 id="auth-context-title">管理提供商、模型和转发密钥。</h1>
  </section>

  <section class="auth-form-wrap" aria-labelledby="login-title">
    <form class="auth-form" id="login-form" novalidate>
      <div class="auth-form__heading">
        <span class="auth-form__icon" aria-hidden="true"><i class="fas fa-lock"></i></span>
        <div><h2 id="login-title">管理员登录</h2><p>使用部署时配置的账号继续。</p></div>
      </div>

      <div id="er" class="al al-e hd" role="alert" aria-live="assertive">
        <i class="fas fa-exclamation-circle" aria-hidden="true"></i><span id="em"></span>
      </div>

      <div class="fg">
        <label for="u">用户名</label>
        <div class="input-wrap"><i class="far fa-user" aria-hidden="true"></i><input type="text" id="u" name="username" placeholder="admin" autocomplete="username" aria-required="true" aria-describedby="login-helper"></div>
      </div>
      <div class="fg">
        <label for="p">密码</label>
        <div class="input-wrap"><i class="fas fa-key" aria-hidden="true"></i><input type="password" id="p" name="password" placeholder="部署环境变量中的密码" autocomplete="current-password" aria-required="true" aria-describedby="login-helper"><button class="password-toggle" id="password-toggle" type="button" aria-label="显示密码"><i class="far fa-eye" aria-hidden="true"></i></button></div>
      </div>
      <p id="login-helper" class="form-helper">登录成功后将进入管理控制台。</p>
      <button class="btn btn-p btn-submit" id="login-button" type="submit"><span class="button-label"><i class="fas fa-sign-in-alt" aria-hidden="true"></i>登录管理控制台</span><span class="button-loading"><i class="fas fa-circle-notch fa-spin" aria-hidden="true"></i>正在验证</span></button>
    </form>
  </section>
</main>

<script>
(function () {
  var form = document.getElementById('login-form')
  var username = document.getElementById('u')
  var password = document.getElementById('p')
  var errorBox = document.getElementById('er')
  var errorMessage = document.getElementById('em')
  var submit = document.getElementById('login-button')
  var toggle = document.getElementById('password-toggle')

  function showError(message) {
    errorMessage.textContent = message
    errorBox.classList.remove('hd')
    username.setAttribute('aria-invalid', 'true')
    password.setAttribute('aria-invalid', 'true')
  }
  function clearError() {
    errorBox.classList.add('hd')
    username.removeAttribute('aria-invalid')
    password.removeAttribute('aria-invalid')
  }

  toggle.addEventListener('click', function () {
    var show = password.type === 'password'
    password.type = show ? 'text' : 'password'
    toggle.setAttribute('aria-label', show ? '隐藏密码' : '显示密码')
    toggle.querySelector('i').className = show ? 'far fa-eye-slash' : 'far fa-eye'
    password.focus({ preventScroll: true })
  })

  form.addEventListener('submit', async function (event) {
    event.preventDefault()
    clearError()
    var u = username.value.trim()
    var p = password.value
    if (!u || !p) {
      showError('请填写用户名和密码后再登录。')
      ;(!u ? username : password).focus()
      return
    }
    submit.disabled = true
    submit.setAttribute('data-state', 'loading')
    try {
      var response = await fetch('/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password: p })
      })
      var data = await response.json()
      if (data.success) {
        submit.setAttribute('data-state', 'success')
        window.location.href = '/admin'
        return
      }
      showError(data.message || '登录失败，请检查账号配置。')
    } catch (error) {
      showError('无法连接服务，请检查网络后重试。')
    }
    submit.disabled = false
    submit.removeAttribute('data-state')
  })
})()
</script>
</body></html>`)
}

// ===== 管理后台 =====

export async function renderAdminPage(c: Context<{ Bindings: Env }>) {
  const providers = await getProviders(c.env)
  const proxyKeys = await getProxyKeys(c.env)
  const enabledProvidersCount = providers.filter((provider) => provider.enabled).length
  const modelsCount = providers.reduce((total, provider) => total + provider.models.length, 0)
  const enabledModelsCount = providers.reduce((total, provider) => total + provider.models.filter((model) => model.enabled).length, 0)
  const enabledProxyKeysCount = proxyKeys.filter((key) => key.enabled).length

  // 全部已启用模型引用（providerId/modelId），供 Vision Bridge 识图模型勾选（可跨厂商）
  const allModelRefs = providers.flatMap((provider) => provider.models.filter((m) => m.enabled).map((m) => `${provider.id}/${m.id}`))
  // 主文本模型：单选框列表（留空 = 本提供商自身模型）
  const modelRadioHtml = (name: string, checked = '') => [
    `<label class="model-check"><input type="radio" name="${name}" value=""${!checked ? ' checked' : ''}><span>本提供商自身模型（共享识图，推荐）</span></label>`,
    ...allModelRefs.map((r) => `<label class="model-check"><input type="radio" name="${name}" value="${escapePageHtml(r)}"${checked === r ? ' checked' : ''}><span>${escapePageHtml(r)}</span></label>`),
  ].join('')
  // 识图模型：复选框列表（视觉模型链，可多选）
  const modelCheckboxHtml = (checked: string[] = []) => allModelRefs.length
    ? `<div class="model-check-list">${allModelRefs.map((r) => `<label class="model-check"><input type="checkbox" value="${escapePageHtml(r)}"${checked.includes(r) ? ' checked' : ''}><span>${escapePageHtml(r)}</span></label>`).join('')}</div>`
    : '<p class="form-helper">暂无已启用的模型，请先添加并启用模型。</p>'

  return c.html(`<!DOCTYPE html><html lang="zh-CN">
${H('管理')}
<body class="site-page admin-page">
<div class="admin-shell">
  <aside class="admin-rail" aria-label="控制台导航">
    <a class="brand admin-rail__brand" href="/">
      <span class="brand__mark" aria-hidden="true"><i class="fas fa-cloud"></i></span>
      <span><strong>${SITE_CONFIG.title}</strong><small>CONTROL PLANE</small></span>
    </a>
    <nav class="admin-nav">
      <a class="admin-nav__link is-active" href="#overview"><i class="fas fa-chart-pie" aria-hidden="true"></i><span>概览</span></a>
      <a class="admin-nav__link" href="#providers"><i class="fas fa-server" aria-hidden="true"></i><span>提供商</span><b>${providers.length}</b></a>
      <a class="admin-nav__link" href="#proxy-keys"><i class="fas fa-key" aria-hidden="true"></i><span>转发 Key</span><b>${proxyKeys.length}</b></a>
      <a class="admin-nav__link" href="#logs"><i class="fas fa-list-alt" aria-hidden="true"></i><span>日志</span></a>
<a class="admin-nav__link" href="#checkin"><i class="fas fa-calendar-check" aria-hidden="true"></i><span>签到</span><b>${providers.filter((p:any)=>p.authType==='oauth-device'&&p.oauth).length}</b></a>
    </nav>
    <div class="admin-rail__foot">
      <a href="/" class="admin-nav__link"><i class="fas fa-arrow-left" aria-hidden="true"></i><span>返回首页</span></a>
      <a href="/admin/logout" class="admin-nav__link"><i class="fas fa-sign-out-alt" aria-hidden="true"></i><span>退出登录</span></a>
    </div>
  </aside>

  <div class="admin-main">
    <header class="admin-topbar">
      <a class="brand" href="/"><span class="brand__mark" aria-hidden="true"><i class="fas fa-cloud"></i></span><span class="brand__name">${SITE_CONFIG.title}</span></a>
      <nav aria-label="移动端控制台导航"><a href="#overview">概览</a><a href="#providers">提供商</a><a href="#proxy-keys">Key</a><a href="#checkin">签到</a><a href="#logs">日志</a></nav>
      <a class="icon-btn" href="/admin/logout" aria-label="退出登录"><i class="fas fa-sign-out-alt" aria-hidden="true"></i></a>
    </header>

    <main class="admin-content">
      <div id="toast" class="hd toast" role="status" aria-live="polite"></div>

      <section id="overview" class="admin-overview" aria-labelledby="admin-title">
        <div class="admin-heading">
          <div><p class="eyebrow"><span aria-hidden="true"></span>GATEWAY STATUS</p><h1 id="admin-title">管理控制台</h1><p>配置提供商、模型与客户端访问凭据。变更将写入 Cloudflare KV。</p></div>
          <div class="admin-heading__actions"><a href="/" class="btn btn-s"><i class="fas fa-external-link-alt" aria-hidden="true"></i>查看模型目录</a><button class="btn btn-p" onclick="showAdd();location.hash='providers'"><i class="fas fa-plus" aria-hidden="true"></i>添加提供商</button></div>
        </div>
        <div class="admin-metrics" aria-label="配置统计">
          <div><span>${providers.length}</span><p>提供商</p><small>${enabledProvidersCount} 个已启用</small></div>
          <div><span>${modelsCount}</span><p>模型</p><small>${enabledModelsCount} 个可用</small></div>
          <div><span>${proxyKeys.length}</span><p>转发 Key</p><small>${enabledProxyKeysCount} 个可用</small></div>
          <div><span class="status-dot status-dot--online"><i aria-hidden="true"></i>已配置</span><p>存储</p><small>Cloudflare KV</small></div>
        </div>
      </section>

      <section id="providers" class="workspace-section" aria-labelledby="providers-title">
        <div class="section-heading section-heading--admin">
          <div><h2 id="providers-title">提供商</h2><p>管理上游地址、协议、API Key 和模型。</p></div>
          <button class="btn btn-p" onclick="showAdd()"><i class="fas fa-plus" aria-hidden="true"></i>添加提供商</button>
        </div>

        <div class="af-w">
          <div id="af" class="hd add-form-panel">
            <div class="panel-heading"><div><span class="panel-heading__mark"><i class="fas fa-plus" aria-hidden="true"></i></span><div><h3>添加新提供商</h3><p>先配置基本信息，再测试 Key 与模型连接。</p></div></div><button class="icon-btn" type="button" onclick="hideAdd()" aria-label="关闭添加表单"><i class="fas fa-times" aria-hidden="true"></i></button></div>
            <div class="fr">
              <div class="fg"><label for="anm">名称</label><input type="text" id="anm" placeholder="DeepSeek"></div>
              <div class="fg"><label for="aid">提供商 ID</label><input type="text" id="aid" placeholder="deepseek"><span class="form-helper">用于模型前缀，创建后不可修改。</span></div>
            </div>
            <div class="fg"><label for="apreset">厂商预设</label><select id="apreset" class="select-sm" onchange="applyProviderPreset(this.value)"><option value="">— 自定义 —</option><option value="deepseek">DeepSeek</option><option value="openai">OpenAI</option><option value="anthropic">Anthropic (Claude)</option><option value="zhipu">智谱 AI (GLM)</option><option value="qwen">通义千问 (DashScope)</option><option value="moonshot">月之暗面 (Kimi)</option><option value="baichuan">百川</option><option value="lingyi">零一万物 (Yi)</option><option value="stepfun">阶跃星辰 (StepFun)</option><option value="siliconflow">硅基流动 (SiliconFlow)</option><option value="volcengine">火山方舟 (豆包)</option><option value="qianfan">百度千帆 (文心)</option><option value="openrouter">OpenRouter</option><option value="together">Together AI</option><option value="groq">Groq</option><option value="deepinfra">DeepInfra</option><option value="mistral">Mistral AI</option><option value="xai">xAI (Grok)</option><option value="workbuddy">WorkBuddy (OAuth 登录)</option><option value="qoder">QoderWork (OAuth 登录)</option><option value="gemini">Gemini CLI (OAuth 登录)</option><option value="gemini-api">Gemini (官方 API Key)</option><option value="cline">Cline (白嫖模型)</option><option value="visionbridge">Vision Bridge (图片转写桥)</option></select><span class="form-helper">选择后自动填充名称/地址/格式，只需填 API Key 即可测试。</span></div>
            <div class="fg"><label for="aurl">API 地址</label><input type="url" id="aurl" placeholder="https://api.deepseek.com"></div>
            <div class="fg"><label for="afmt">API 格式</label><select id="afmt" class="select-sm"><option value="openai">OpenAI 兼容</option><option value="anthropic">Anthropic 兼容</option></select></div>
            <div class="fg"><label for="aat">认证方式</label><select id="aat" class="select-sm" onchange="toggleAuthType()"><option value="api-key">API Key</option><option value="oauth-device">OAuth 设备码登录</option></select></div>
            <div id="oauth-new" class="hd form-group">
              <fieldset class="form-group"><legend>OAuth 配置</legend>
                <div class="fg"><label>登录流程类型</label><select id="ao8" class="select-sm"><option value="device">设备码（RFC 8628）</option><option value="browser">浏览器登录（WorkBuddy）</option><option value="qoder">Qoder 设备授权（QoderWork）</option><option value="gemini">Gemini 授权码（Gemini CLI）</option></select></div>
                <div class="fg"><label>发起端点 (deviceCodeUrl)</label><input type="url" id="ao1" placeholder="https://.../auth/device/code"></div>
                <div class="fg"><label>轮询端点 (deviceTokenUrl)</label><input type="url" id="ao2" placeholder="https://.../auth/device/token"></div>
                <div class="fg"><label>Token 刷新端点 (refreshTokenUrl)</label><input type="url" id="ao3" placeholder="https://.../auth/oauth_token/refresh"></div>
                <div class="fg"><label>Client ID</label><input type="text" id="ao4" placeholder="OAuth client_id（gemini 模式可留空走环境变量）"></div>
                <div class="fg"><label>Client Secret（可选）</label><input type="text" id="ao14" placeholder="OAuth client_secret（未配置环境变量时粘贴官方凭据）"></div>
                <div class="fg"><label>Scope（可选）</label><input type="text" id="ao5" placeholder="如 user"></div>
                <div class="fg"><label>Token 注入头（默认 x-api-key）</label><input type="text" id="ao6" placeholder="x-api-key"></div>
                <div class="fg"><label>Token 注入前缀（可选，如 Bearer ）</label><input type="text" id="ao9" placeholder="如 Bearer （含尾空格）"></div>
                <div class="fg"><label>额外请求头（JSON，可选）</label><textarea id="ao7" rows="3" placeholder='{"x-app-name":"my-app","x-app-version":"1.0.0"}'></textarea></div>
                <div class="fg"><label>模型列表 URL（可选）</label><input type="url" id="ao10" placeholder="留空 = 用 baseUrl/models（OpenAI 标准）"><span class="form-helper">登录后从此地址动态拉取可用模型；WorkBuddy 等自定义 API 需填写。</span></div>
                <div class="fg"><label>Global 域配置（海外账户，可选）</label><span class="form-helper">Token 为 workbuddy.ai 域时使用以下端点，留空则不区分域。WorkBuddy 预设会自动填充。</span></div>
                <div class="fg"><label>Global 域 baseUrl</label><input type="url" id="ao11" placeholder="https://www.workbuddy.ai/v2"></div>
                <div class="fg"><label>Global 域模型 URL</label><input type="url" id="ao12" placeholder="https://www.workbuddy.ai/console/enterprises/personal/models"></div>
                <div class="fg"><label>Global 域 Origin</label><input type="url" id="ao13" placeholder="https://www.workbuddy.ai"></div>
                <div class="fg"><label>预置模板</label><select class="select-sm" onchange="applyOauthPreset(this.value)"><option value="">— 选择 —</option><option value="workbuddy">WorkBuddy（浏览器登录）</option><option value="qoder">QoderWork（Qoder 设备授权）</option><option value="gemini">Gemini（官方 OAuth）</option></select></div>
                <div class="fc mt-1 field-row"><button class="btn btn-p" onclick="createProv({afterCreate:function(id){location.href='/admin?connect='+encodeURIComponent(id)}})"><i class="fas fa-plug" aria-hidden="true"></i>创建并发起连接</button><span class="form-helper">先创建提供商，保存后自动弹出 OAuth 登录链接；登录成功会自动拉取模型。</span></div>
              </fieldset>
            </div>
            <fieldset class="form-group" id="akeys-fs"><legend id="akey-legend">上游 API Keys</legend><div id="akeys"><div class="fc mb-4 field-row"><input type="password" placeholder="sk-xxx" class="fx1 aki" aria-label="上游 API Key"><label class="tg" title="启用 Key"><input type="checkbox" checked class="ake" aria-label="启用 Key"><span class="sl"></span></label><button class="btn btn-gh btn-xs" onclick="testNewAKey(this)" title="测试 Key"><i class="fas fa-plug" aria-hidden="true"></i><span>测试</span></button><button class="icon-btn" onclick="this.parentElement.remove()" aria-label="移除 Key"><i class="fas fa-times" aria-hidden="true"></i></button></div></div><button class="btn btn-s btn-xs" onclick="addAKeyRow()"><i class="fas fa-plus" aria-hidden="true"></i>添加 Key</button><span id="akey-hint" class="form-helper"></span></fieldset>
            <fieldset class="form-group" id="amodels-fs"><legend>模型 ID</legend><div id="amodels"><div class="fc mb-4 field-row"><input type="text" placeholder="deepseek-chat" class="fx1 ami" aria-label="模型 ID"><label class="tg" title="启用模型"><input type="checkbox" checked class="ame" aria-label="启用模型"><span class="sl"></span></label><button class="btn btn-gh btn-xs" onclick="testNewMdl(this)" title="测试模型"><i class="fas fa-plug" aria-hidden="true"></i><span>测试</span></button><button class="icon-btn" onclick="this.parentElement.remove()" aria-label="移除模型"><i class="fas fa-times" aria-hidden="true"></i></button></div></div><button class="btn btn-s btn-xs" onclick="addMdlRow()"><i class="fas fa-plus" aria-hidden="true"></i>添加模型</button></fieldset>
            <fieldset class="form-group" id="avb-fs"><legend>识图模型配置（可选）</legend><span class="form-helper">让不支持图片的模型支持图片：请求含图时自动调用下方勾选的识图模型转写为文本。识图模型可从已维护的所有模型中选择（同厂商或跨厂商）。两种用法：①「主文本模型」留空 → 本提供商下所有模型自动共享识图能力；②「主文本模型」选了其它提供商/模型 → 本提供商作为图片转写桥，所有模型转发到该主文本模型。</span>
              <div class="fg"><label>主文本模型（留空 = 转发到本提供商自身模型）</label><div id="avb-primary">${modelRadioHtml('avb-primary')}</div></div>
              <div class="fg"><label>识图模型（视觉模型链，勾选后请求含图时按勾选顺序依次转写，全部失败按下方策略处理）</label><div id="avb-vision">${modelCheckboxHtml()}</div></div>
              <div class="fg"><label>视觉转写失败策略</label><select id="avb-fail" class="select-sm"><option value="error">error（返回错误）</option><option value="text_only">text_only（丢弃图片仅转发文本）</option></select></div>
            </fieldset>
            <div class="panel-actions"><label class="switch-label"><span>创建后立即启用</span><span class="tg"><input type="checkbox" checked id="aen"><span class="sl"></span></span></label><div><button class="btn btn-s" onclick="hideAdd()">取消</button><button class="btn btn-p" onclick="createProv()"><i class="fas fa-check" aria-hidden="true"></i>创建提供商</button></div></div>
            <div id="atestR" class="mt-1" aria-live="polite"></div>
          </div>
          <aside id="amc" class="hd mdl-list-panel"><div class="panel-heading"><div><span class="panel-heading__mark"><i class="fas fa-cube" aria-hidden="true"></i></span><div><h3>可用模型</h3><p>点击“+”添加到配置。</p></div></div></div><div id="amcl"></div></aside>
        </div>

        <div class="gp provider-list" id="plist">
          ${providers.length ? providers.map(p=>`
          <article class="pi" data-id="${escapePageHtml(p.id)}">
            <div class="ps" onclick="tog('${p.id}')" role="button" tabindex="0" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();tog('${p.id}')}" aria-controls="dt-${escapePageHtml(p.id)}">
              <div class="l"><i class="fas fa-chevron-right provider-chevron" aria-hidden="true" id="ch-${escapePageHtml(p.id)}"></i><span class="provider-avatar" aria-hidden="true">${escapePageHtml(p.name.charAt(0).toUpperCase() || 'A')}</span><div><h3>${escapePageHtml(p.name)}</h3><div class="pu"><code>${escapePageHtml(p.id)}</code><span>${(p.apiType||'openai')==='anthropic'?'Anthropic':'OpenAI'}</span><span>${p.apiKeys.length} Keys</span><span>${p.models.length} 模型</span></div></div></div>
              <div class="fc fx-s0" onclick="event.stopPropagation()"><label class="tg"><input type="checkbox" ${p.enabled?'checked':''} id="en-${escapePageHtml(p.id)}" onchange="togglePb('${p.id}',this.checked)" aria-label="启用 ${escapePageHtml(p.name)}"><span class="sl"></span></label><span class="bd ${p.enabled?'bd-on':'bd-off'}">${p.enabled?'已启用':'未启用'}</span></div>
            </div>
            <div class="pd" id="dt-${escapePageHtml(p.id)}">
              <div class="detail-heading"><div><h3>编辑 ${escapePageHtml(p.name)}</h3><p>保存后，新配置会用于后续转发请求。</p></div><span class="protocol-chip">${(p.apiType||'openai')==='anthropic'?'ANTHROPIC':'OPENAI'}</span></div>
              <div class="fr"><div class="fg"><label>名称</label><input type="text" id="nm-${escapePageHtml(p.id)}" value="${escapePageHtml(p.name)}"></div><div class="fg"><label>ID</label><input type="text" value="${escapePageHtml(p.id)}" disabled></div></div>
              <div class="fg"><label>API 地址</label><input type="url" id="url-${escapePageHtml(p.id)}" value="${escapePageHtml(p.baseUrl)}"></div>
              <div class="fg"><label>API 格式</label><select id="at-${escapePageHtml(p.id)}" class="select-sm"><option value="openai" ${(p.apiType||'openai')==='openai'?'selected':''}>OpenAI 兼容</option><option value="anthropic" ${p.apiType==='anthropic'?'selected':''}>Anthropic 兼容</option></select></div>
              <div class="fg"><label>认证方式</label><select id="auth-${escapePageHtml(p.id)}" class="select-sm" onchange="toggleAuthTypeEdit('${p.id}')"><option value="api-key" ${(p.authType||'api-key')==='api-key'?'selected':''}>API Key</option><option value="oauth-device" ${p.authType==='oauth-device'?'selected':''}>OAuth 设备码登录</option></select></div>
              <div id="oauth-edit-${escapePageHtml(p.id)}" class="${p.authType==='oauth-device'?'form-group':'hd form-group'}">
                <fieldset class="form-group"><legend>OAuth 配置</legend>
                  <div class="fg"><label>登录流程类型</label><select id="eao8-${escapePageHtml(p.id)}" class="select-sm"><option value="device" ${(p.oauth&&p.oauth.flowType)||'device'==='device'?'selected':''}>设备码（RFC 8628）</option><option value="browser" ${(p.oauth&&p.oauth.flowType)==='browser'?'selected':''}>浏览器登录（WorkBuddy）</option><option value="qoder" ${(p.oauth&&p.oauth.flowType)==='qoder'?'selected':''}>Qoder 设备授权（QoderWork）</option><option value="gemini" ${(p.oauth&&p.oauth.flowType)==='gemini'?'selected':''}>Gemini 授权码（Gemini CLI）</option></select></div>
                  <div class="fg"><label>发起端点</label><input type="url" id="eao1-${escapePageHtml(p.id)}" value="${escapePageHtml((p.oauth&&p.oauth.deviceCodeUrl)||'')}" placeholder="https://.../auth/device/code"></div>
                  <div class="fg"><label>轮询端点</label><input type="url" id="eao2-${escapePageHtml(p.id)}" value="${escapePageHtml((p.oauth&&p.oauth.deviceTokenUrl)||'')}" placeholder="https://.../auth/device/token"></div>
                  <div class="fg"><label>Token 刷新端点</label><input type="url" id="eao3-${escapePageHtml(p.id)}" value="${escapePageHtml((p.oauth&&p.oauth.refreshTokenUrl)||'')}" placeholder="https://.../auth/oauth_token/refresh"></div>
                  <div class="fg"><label>Client ID</label><input type="text" id="eao4-${escapePageHtml(p.id)}" value="${escapePageHtml((p.oauth&&p.oauth.clientId)||'')}" placeholder="OAuth client_id（gemini 模式可留空走环境变量）"></div>
                  <div class="fg"><label>Client Secret（可选）</label><input type="text" id="eao14-${escapePageHtml(p.id)}" value="${escapePageHtml((p.oauth&&p.oauth.clientSecret)||'')}" placeholder="OAuth client_secret（未配置环境变量时粘贴官方凭据）"></div>
                  <div class="fg"><label>Scope（可选）</label><input type="text" id="eao5-${escapePageHtml(p.id)}" value="${escapePageHtml((p.oauth&&p.oauth.scope)||'')}" placeholder="如 user"></div>
                  <div class="fg"><label>Token 注入头（默认 x-api-key）</label><input type="text" id="eao6-${escapePageHtml(p.id)}" value="${escapePageHtml((p.oauth&&p.oauth.tokenHeader)||'x-api-key')}" placeholder="x-api-key"></div>
                  <div class="fg"><label>Token 注入前缀（可选，如 Bearer ）</label><input type="text" id="eao9-${escapePageHtml(p.id)}" value="${escapePageHtml((p.oauth&&p.oauth.tokenHeaderPrefix)||'')}" placeholder="如 Bearer （含尾空格）"></div>
                  <div class="fg"><label>额外请求头（JSON，可选）</label><textarea id="eao7-${escapePageHtml(p.id)}" rows="3" placeholder='{"x-app-name":"my-app"}'>${escapePageHtml((p.oauth&&JSON.stringify(p.oauth.extraHeaders||{}))||'')}</textarea></div>
                  <div class="fg"><label>模型列表 URL（可选）</label><input type="url" id="eao10-${escapePageHtml(p.id)}" value="${escapePageHtml((p.oauth&&p.oauth.modelsUrl)||'')}" placeholder="留空 = 用 baseUrl/models（OpenAI 标准）"></div>
                  <div class="fg"><label>Global 域 baseUrl（海外账户，可选）</label><input type="url" id="eao11-${escapePageHtml(p.id)}" value="${escapePageHtml((p.oauth&&p.oauth.globalBaseUrl)||'')}" placeholder="https://www.workbuddy.ai/v2"></div>
                  <div class="fg"><label>Global 域模型 URL（可选）</label><input type="url" id="eao12-${escapePageHtml(p.id)}" value="${escapePageHtml((p.oauth&&p.oauth.globalModelsUrl)||'')}" placeholder="https://www.workbuddy.ai/console/enterprises/personal/models"></div>
                  <div class="fg"><label>Global 域 Origin（可选）</label><input type="url" id="eao13-${escapePageHtml(p.id)}" value="${escapePageHtml((p.oauth&&p.oauth.globalOrigin)||'')}" placeholder="https://www.workbuddy.ai"></div>
                  <div class="fg"><label>预置模板</label><select class="select-sm" onchange="applyOauthPresetEdit('${p.id}',this.value)"><option value="" ${detectOauthPreset(p.oauth)===''?'selected':''}>— 选择 —</option><option value="workbuddy" ${detectOauthPreset(p.oauth)==='workbuddy'?'selected':''}>WorkBuddy（浏览器登录）</option><option value="qoder" ${detectOauthPreset(p.oauth)==='qoder'?'selected':''}>QoderWork（Qoder 设备授权）</option><option value="gemini" ${detectOauthPreset(p.oauth)==='gemini'?'selected':''}>Gemini（官方 OAuth）</option></select></div>
                  <div class="fc mt-1 field-row"><button class="btn btn-s" onclick="oauthConnect('${p.id}')"><i class="fas fa-plug" aria-hidden="true"></i>发起连接</button><button class="btn btn-gh" onclick="fetchOauthModels('${p.id}')"><i class="fas fa-cloud-download-alt" aria-hidden="true"></i>获取模型</button><button class="btn btn-gh" onclick="oauthStatus('${p.id}')"><i class="fas fa-sync" aria-hidden="true"></i>状态</button><button class="btn btn-gh" onclick="oauthDisconnect('${p.id}')"><i class="fas fa-unlink" aria-hidden="true"></i>断开</button><span id="oauth-st-${escapePageHtml(p.id)}" class="oauth-status"></span></div>
                </fieldset>
              </div>
              <fieldset class="form-group ${p.authType==='oauth-device'?'hd':''}" id="keys-fs-${escapePageHtml(p.id)}"><legend id="key-legend-${escapePageHtml(p.id)}">${p.id==='cline'?'Cline RefreshTokens（每个账号一行）':'上游 API Keys'}</legend><div id="keys-${escapePageHtml(p.id)}">${p.apiKeys.map((k, ki)=>`<div class="fc mb-3 field-row" data-kidx="${ki}"><input type="password" value="${escapePageHtml(k.key)}" class="fx1" id="k-${escapePageHtml(p.id)}-${ki}" placeholder="API Key" aria-label="API Key"><label class="tg"><input type="checkbox" ${k.enabled?'checked':''} id="ken-${escapePageHtml(p.id)}-${ki}" aria-label="启用 Key"><span class="sl"></span></label><button class="btn btn-gh btn-xs" onclick="testKeyRow('${p.id}',${ki})" title="测试 Key"><i class="fas fa-plug" aria-hidden="true"></i><span>测试</span></button><button class="icon-btn" onclick="rmKeyRow('${p.id}',${ki})" aria-label="移除 Key"><i class="fas fa-times" aria-hidden="true"></i></button></div>`).join('')}</div><div class="fc mt-1 field-row"><input type="password" id="nk-${escapePageHtml(p.id)}" placeholder="${p.id==='cline'?'新的 RefreshToken（一个账号一行）':'新的 API Key'}" class="fx1"><button class="btn btn-s btn-xs" onclick="addKeyRow('${p.id}')"><i class="fas fa-plus" aria-hidden="true"></i>添加</button></div><span id="key-hint-${escapePageHtml(p.id)}" class="form-helper">${p.id==='cline'?'Cline 使用 Cline 账号的 refreshToken（长期钥匙）。每个账号一行，额度用完自动切换；留空禁用某个账号。':' '}</span></fieldset>
              <fieldset class="form-group" id="models-fs-${escapePageHtml(p.id)}"><legend>模型</legend><div id="ml-${escapePageHtml(p.id)}">${p.models.map((m,mi)=>`<div class="fc mb-3 field-row" data-idx="${mi}"><input type="text" value="${escapePageHtml(m.id)}" class="fx1" id="mid-${escapePageHtml(p.id)}-${mi}" placeholder="模型 ID"><label class="tg"><input type="checkbox" ${m.enabled?'checked':''} id="men-${escapePageHtml(p.id)}-${mi}" aria-label="启用模型"><span class="sl"></span></label><button class="btn btn-gh btn-xs" onclick="testMdl('${p.id}','${m.id}',${mi})" title="测试模型"><i class="fas fa-plug" aria-hidden="true"></i><span>测试</span></button><button class="icon-btn" onclick="rmMdl('${p.id}',${mi})" aria-label="移除模型"><i class="fas fa-times" aria-hidden="true"></i></button></div>`).join('')}</div><div class="fc mt-1 field-row"><input type="text" id="nmid-${escapePageHtml(p.id)}" placeholder="新的模型 ID" class="fx1"><button class="btn btn-s btn-xs" onclick="addMdl('${p.id}')"><i class="fas fa-plus" aria-hidden="true"></i>添加</button></div></fieldset>
              <fieldset class="form-group"><legend>识图模型配置（可选）</legend><span class="form-helper">勾选识图模型后，本提供商所有模型都自动支持图片：请求含图时先由识图模型转写为文本再按原模型转发（留空主文本模型）。若选了主文本模型，则本提供商作为图片转写桥，全部请求转发到该主文本模型。全部取消勾选即恢复普通转发。</span>
                <div class="fg"><label>主文本模型（留空 = 转发到本提供商自身模型）</label><div id="vb-primary-${escapePageHtml(p.id)}">${modelRadioHtml('vb-primary-' + escapePageHtml(p.id), (p.visionBridge&&p.visionBridge.primary)||'')}</div></div>
                <div class="fg"><label>识图模型（视觉模型链，勾选后请求含图时按勾选顺序依次转写，全部失败按下方策略处理）</label><div id="vb-vision-${escapePageHtml(p.id)}">${modelCheckboxHtml((p.visionBridge&&p.visionBridge.vision)||[])}</div></div>
                <div class="fg"><label>视觉转写失败策略</label><select id="vb-fail-${escapePageHtml(p.id)}" class="select-sm"><option value="error" ${!p.visionBridge||p.visionBridge.onVisionFailure==='error'?'selected':''}>error（返回错误）</option><option value="text_only" ${p.visionBridge&&p.visionBridge.onVisionFailure==='text_only'?'selected':''}>text_only（丢弃图片仅转发文本）</option></select></div>
              </fieldset>
              <div class="detail-actions"><div id="tr-${escapePageHtml(p.id)}" aria-live="polite"></div><div>${(p.id === 'opencode' || p.id === 'cline') ? '<button class="btn btn-s" onclick="fetchEditModels(\'' + p.id + '\')"><i class="fas fa-download" aria-hidden="true"></i>获取模型</button>' : ''}${p.id === 'cline' ? '<button class="btn btn-s" onclick="clineOAuthConnect(\'' + p.id + '\')"><i class="fas fa-sign-in-alt" aria-hidden="true"></i>一键授权获取 Token</button>' : ''}<button class="btn btn-d" onclick="del('${p.id}')"><i class="fas fa-trash" aria-hidden="true"></i>删除</button><button class="btn btn-p" onclick="save('${p.id}')"><i class="fas fa-save" aria-hidden="true"></i>保存更改</button></div></div>
            </div>
          </article>`).join('') : `<div class="empty-state"><i class="fas fa-server" aria-hidden="true"></i><h3>还没有提供商</h3><p>添加第一个上游提供商，配置 API 地址、Key 和模型。</p><button class="btn btn-p" onclick="showAdd()">添加提供商</button></div>`}
        </div>
      </section>

      <section id="proxy-keys" class="workspace-section" aria-labelledby="proxy-keys-title">
        <div class="section-heading section-heading--admin"><div><h2 id="proxy-keys-title">转发 Key</h2><p>客户端使用这些 Key 访问统一的 <code>/v1</code> 接口。</p></div><button class="btn btn-p" onclick="genKey()"><i class="fas fa-plus" aria-hidden="true"></i>生成转发 Key</button></div>
        <div class="key-list">
          ${proxyKeys.length===0?'<div class="empty-state"><i class="fas fa-key" aria-hidden="true"></i><h3>暂无转发 Key</h3><p>生成一个 Key 后，客户端才能访问网关。</p><button class="btn btn-p" onclick="genKey()">生成转发 Key</button></div>':''}
          ${proxyKeys.map(k=>`<article class="ki" data-id="${escapePageHtml(k.id)}"><div class="key-main"><span class="key-icon" aria-hidden="true"><i class="fas fa-key"></i></span><div><div class="kv"><span id="kv-${escapePageHtml(k.id)}" data-full="${escapePageHtml(k.key)}">${escapePageHtml(k.key.length>12?k.key.substring(0,8)+'••••'+k.key.substring(k.key.length-4):k.key)}</span><button class="icon-btn" onclick="toggleKeyVis('${k.id}')" title="显示或隐藏" aria-label="显示或隐藏 Key"><i class="far fa-eye" aria-hidden="true"></i></button><button class="icon-btn" onclick='copyText("${escapePageHtml(k.key)}",this)' title="复制" aria-label="复制 Key"><i class="far fa-copy" aria-hidden="true"></i></button></div><h3>${escapePageHtml(k.name)}</h3><p>创建于 ${new Date(k.createdAt).toLocaleDateString()} · ${k.expiresAt?'有效至 '+new Date(k.expiresAt).toLocaleDateString():'永久有效'} · <span class="bd ${k.allowedModels&&k.allowedModels.length>0?'bd-on':'bd-off'}">${k.allowedModels&&k.allowedModels.length>0?k.allowedModels.length+' 个模型':'全部模型'}</span></p></div></div><div class="key-actions"><label class="tg"><input type="checkbox" ${k.enabled?'checked':''} onchange="toggleProxyKey('${k.id}',this.checked)" aria-label="启用 ${escapePageHtml(k.name)}"><span class="sl"></span></label><span class="bd ${k.enabled?'bd-on':'bd-off'}">${k.enabled?'已启用':'已禁用'}</span><button class="btn btn-gh btn-xs" onclick="editKeyModels('${k.id}')" title="模型筛选"><i class="fas fa-filter" aria-hidden="true"></i>模型筛选</button><button class="btn btn-d btn-xs" onclick="rmKey('${k.id}')"><i class="fas fa-trash" aria-hidden="true"></i>删除</button></div></article>`).join('')}
        </div>
      </section>
      <section id="logs" class="workspace-section" aria-labelledby="logs-title">
        <div class="section-heading section-heading--admin"><div><h2 id="logs-title">系统日志</h2><p>记录 API 请求、错误等关键信息。</p></div><div><label class="tg"><input type="checkbox" id="log-switch" onchange="toggleLog(this.checked)"><span class="sl"></span></label><span id="log-status">已关闭</span><label class="tg" style="margin-left:8px" title="定时自动刷新日志，便于排查问题"><input type="checkbox" id="log-auto-on" onchange="logAutoToggle(this.checked)"><span class="sl"></span></label><input type="number" id="log-auto-sec" min="1" max="3600" value="5" style="width:58px;text-align:center;font-size:12px;padding:2px 4px;border-radius:6px;border:1px solid var(--border,#e2e8f0);background:var(--card,#fff);color:inherit;margin-left:6px" onchange="logAutoSecChange()"><span class="mu" style="font-size:12px;margin-left:4px">秒自动刷新</span><button class="btn btn-gh btn-xs" onclick="logPageChange(1)" style="margin-left:8px" title="刷新（回到第一页）"><i class="fas fa-sync-alt"></i></button><button class="btn btn-d btn-xs" onclick="clearLogs()" style="margin-left:4px">清除</button></div></div>
        <div id="log-list" class="key-list">
          <div class="empty-state"><i class="fas fa-list-alt" aria-hidden="true"></i><h3>暂无日志</h3><p>开启日志开关后，API 请求和错误会被记录。</p></div>
        </div>
      </section>
      <section id="checkin" class="workspace-section" aria-labelledby="checkin-title">
        <div class="section-heading section-heading--admin"><div><h2 id="checkin-title">WorkBuddy 签到</h2><p>每日签到领取免费积分。仅 CN 账号可签到，国际版自动跳过。定时任务每天 09:00/21:00 自动执行。</p></div><div><button class="btn btn-gh btn-xs" onclick="loadCheckin()" style="margin-left:8px"><i class="fas fa-sync-alt"></i></button><button class="btn btn-p btn-xs" onclick="triggerCheckin()"><i class="fas fa-calendar-check" aria-hidden="true"></i>全部签到</button></div></div>
        <div id="checkin-list" class="key-list">
          <div class="empty-state"><i class="fas fa-calendar-check" aria-hidden="true"></i><h3>暂无签到数据</h3><p>配置 WorkBuddy / QoderWork OAuth 提供商后，点击「全部签到」。</p></div>
        </div>
      </section>
    </main>

    <footer class="admin-footer"><span>${SITE_CONFIG.title} · Cloudflare Workers</span><a href="${SITE_CONFIG.authorUrl}" target="_blank" rel="noreferrer">查看源代码</a></footer>
  </div>
</div>

<div id="modal" class="modal-o hd" role="presentation" onclick="if(event.target===this)closeM()"><div class="modal" id="mc" role="dialog" aria-modal="true" aria-live="polite"></div></div>

<script>${SHARED_JS}
// 全部已启用模型引用（providerId/modelId），供 Vision Bridge 识图模型勾选
const VB_MODELS = ${JSON.stringify(allModelRefs).replace(/</g, '\\u003c')};
// copy
function copyText(t, el) {
  const i = el.tagName === 'I' ? el : (el.querySelector('i') || el.parentElement?.querySelector('i'))
  if (!i) { navigator.clipboard.writeText(t).catch(() => {}); return }
  const oc = i.className
  navigator.clipboard.writeText(t).then(() => {
    i.className = 'fas fa-check'
    el.setAttribute('data-state', 'success')
    setTimeout(() => {
      i.className = oc
      el.removeAttribute('data-state')
    }, 1800)
  }).catch(() => {
    el.setAttribute('data-state', 'error')
  })
}

// modal
function showM(h) { document.getElementById('mc').innerHTML = h; document.getElementById('modal').classList.remove('hd') }
function closeM() { document.getElementById('modal').classList.add('hd') }
function cM(msg) {
  return new Promise(r => {
    showM('<h3><i class="fas fa-question-circle c-p"></i> 确认</h3><p>' + msg + '</p><div class="fa"><button class="btn btn-s" onclick="closeM();r(false)">取消</button><button class="btn btn-p" onclick="closeM();r(true)">确定</button></div>')
    window.r = r
  })
}
function pM(msg, def) {
  return new Promise(r => {
    showM('<h3><i class="fas fa-pen c-p"></i> ' + msg + '</h3><div class="fg"><input type="text" id="pv" value="' + (def || '') + '" placeholder="请输入"></div><div class="fa"><button class="btn btn-s" id="pMc">取消</button><button class="btn btn-p" id="pMo">确定</button></div>')
    window.r = r
    const inp = document.getElementById('pv')
    if (inp) {
      inp.focus()
      inp.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { closeM(); r(inp.value.trim()) }
      })
    }
    document.getElementById('pMc').addEventListener('click', function() { closeM(); r(null) })
    document.getElementById('pMo').addEventListener('click', function() { closeM(); r(inp.value.trim()) })
  })
}
function aM(msg, t) {
  const i = t === 'success' ? 'fa-check-circle c-s' : 'fa-exclamation-circle c-d'
  showM('<h3><i class="fas ' + i + '"></i> ' + (t === 'success' ? '成功' : '提示') + '</h3><p>' + msg + '</p><div class="fa"><button class="btn btn-p" onclick="closeM()">确定</button></div>')
}

function toast(msg, t) {
  const el = document.getElementById('toast')
  const i = t === 'success' ? 'fa-check-circle' : 'fa-times-circle'
  const cls = t === 'success' ? 'al-s' : 'al-e'
  el.innerHTML = '<div class="al ' + cls + '"><i class="fas ' + i + '"></i> ' + escapeHtml(msg) + '</div>'
  el.classList.remove('hd')
  setTimeout(() => el.classList.add('hd'), 3000)
}

// providers
function tog(id) {
  const d = document.getElementById('dt-' + id), c = document.getElementById('ch-' + id)
  d.classList.toggle('open')
  c.style.transform = d.classList.contains('open') ? 'rotate(90deg)' : ''
}

function showAdd() { document.getElementById('af').classList.remove('hd') }
function hideAdd() { document.getElementById('af').classList.add('hd'); document.getElementById('amc').classList.add('hd') }

// aid 输入 opencode 时自动填充 API 地址
document.getElementById('aid').addEventListener('input', function() {
  if (this.value.trim() === 'opencode') {
    document.getElementById('aurl').value = '${OPENCODE_DEFAULT_URL}'
  }
})

// provider api keys (add form)
function addAKeyRow() {
  const c = document.getElementById('akeys')
  const d = document.createElement('div')
  d.className = 'fc mb-4 field-row'
  d.innerHTML = '<input type="text" placeholder="sk-xxx" class="fx1 aki"><label class="tg"><input type="checkbox" checked class="ake"><span class="sl"></span></label><button class="btn btn-gh btn-xs" onclick="testNewAKey(this)" title="测试"><i class="fas fa-plug"></i></button><button class="btn btn-gh btn-xs" onclick="this.parentElement.remove()"><i class="fas fa-times c-l"></i></button>'
  c.appendChild(d)
}

function renderModelGrid(models, editId, providerId) {
  if (providerId === 'opencode') {
    models = (models || []).filter(function(m) {
      return m && typeof m.id === 'string' && /^[A-Za-z0-9._:/-]+$/.test(m.id) && (m.id === 'big-pickle' || m.id.endsWith('-free'))
    })
  }
  if (!models || models.length === 0) return '<span class="mu">未返回模型列表</span>'
  var h = models.map(function(m) {
    var modelId = String(m.id || '')
    var safeId = escapeHtml(modelId)
    var addFn = editId
      ? "addMdlToEdit('" + editId + "','" + modelId + "')"
      : "addMdlToForm('" + modelId + "')"
    return '<div class="mdl-item">' +
      '<i class="fas fa-cube"></i>' +
			'<span class="fx1 cp ov" onclick="copyText(\\'' + modelId + '\\',this)">' + safeId + '</span>' +
      '<button class="btn btn-gh btn-xs mdl-add-btn" onclick="' + addFn + '" title="添加到表单">+</button></div>'
  }).join('')
  return '<div class="grid-2-gap6">' + h + '</div>'
}

function testNewAKey(btn) {
  const inp = btn.parentElement.querySelector('.aki'), k = inp.value.trim()
  const providerId = document.getElementById('aid').value.trim()
  if (!k && providerId !== 'opencode') { toast('请输入 API Key', 'error'); return }
  const url = document.getElementById('aurl').value.trim()
  if (!url) { toast('请先填写 API 地址', 'error'); return }
  const apiType = document.getElementById('afmt').value
  const tr = document.getElementById('atestR')
  showSpinner(tr)
  testKeyConnection(url, apiType, k, providerId).then(function(result) {
    if (result.success && result.data) {
      document.getElementById('amcl').innerHTML = renderModelGrid(result.data.data || [], null, providerId)
      document.getElementById('amc').classList.remove('hd')
    } else {
      document.getElementById('amc').classList.add('hd')
    }
    showResult(tr, result.success, result.success ? '' : 'HTTP ' + result.status)
  })
}

let mdlCount = 1
function addMdlRow() {
  const c = document.getElementById('amodels')
  const d = document.createElement('div')
  d.className = 'fc mb-4 field-row'
  d.innerHTML = '<input type="text" placeholder="deepseek-chat" class="fx1 ami"><label class="tg"><input type="checkbox" checked class="ame"><span class="sl"></span></label><button class="btn btn-gh btn-xs" onclick="testNewMdl(this)"><i class="fas fa-plug"></i></button><button class="btn btn-gh btn-xs" onclick="this.parentElement.remove()"><i class="fas fa-times c-l"></i></button>'
  c.appendChild(d)
}

function addMdlToForm(mid) {
  const c = document.getElementById('amodels')
  const d = document.createElement('div')
  d.className = 'fc mb-4 field-row'
  d.innerHTML = '<input type="text" value="' + escapeHtml(mid) + '" class="fx1 ami"><label class="tg"><input type="checkbox" checked class="ame"><span class="sl"></span></label><button class="btn btn-gh btn-xs" onclick="testNewMdl(this)"><i class="fas fa-plug"></i></button><button class="btn btn-gh btn-xs" onclick="this.parentElement.remove()"><i class="fas fa-times c-l"></i></button>'
  c.appendChild(d)
}

function testNewMdl(btn) {
  const inp = btn.parentElement.querySelector('.ami'), mid = inp.value.trim()
  if (!mid) { toast('请输入模型 ID', 'error'); return }
  const url = document.getElementById('aurl').value.trim()
    const akeys = document.querySelectorAll('#akeys .aki')
    const configuredKey = Array.from(akeys).map(function(inp) { return inp.value.trim() }).filter(Boolean)[0] || ''
    const apiType = document.getElementById('afmt').value
    const tr = document.getElementById('atestR')
    showSpinner(tr)
  const providerId = document.getElementById('aid').value.trim()
  const apiKey = configuredKey || (providerId === 'opencode' ? '' : 'dummy')
  testModelConnection(url, apiType, apiKey, mid, providerId).then(function(result) {
    showResult(tr, result.success, result.success ? '' : 'HTTP ' + result.status)
  })
}

async function createProv(opts) {
  const nm = document.getElementById('anm').value.trim(), id = document.getElementById('aid').value.trim()
  const url = document.getElementById('aurl').value.trim(), apiType = document.getElementById('afmt').value
  const authType = document.getElementById('aat').value
  const oauth = collectOauthNew()
  const aki = document.querySelectorAll('#akeys .aki')
  const keys = Array.from(aki).map((inp, i) => {
    const k = inp.value.trim()
    const en = inp.parentElement.querySelector('.ake')?.checked ?? true
    return k ? { key: k, enabled: en } : null
  }).filter(Boolean)
  const ami = document.querySelectorAll('#amodels .ami')
  const models = Array.from(ami).map(inp => {
    const mid = inp.value.trim()
    const en = inp.parentElement.querySelector('.ame')?.checked ?? true
    return mid ? { id: mid, enabled: en } : null
  }).filter(Boolean)
  const enabled = document.getElementById('aen').checked
  if (!nm || !id || !url) { toast('请填写名称、ID 和 API 地址', 'error'); return }
  if (authType === 'oauth-device') {
    const needsClientId = oauth.flowType !== 'browser'
    if (!oauth.deviceCodeUrl || !oauth.deviceTokenUrl || !oauth.refreshTokenUrl || (needsClientId && !oauth.clientId)) {
      toast('OAuth 模式下请填写完整的配置（三个端点' + (needsClientId ? ' + Client ID' : '') + '）', 'error'); return
    }
  }
  // 识图模型：勾选了识图模型即保存配置；选了主文本模型才是独立桥（type=vision-bridge），
  // 仅勾识图模型（primary 留空）= 本提供商共享识图，保持普通提供商身份
  const vb = collectVisionBridgeNew()
  const r = await fetch('/admin/api/providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, name: nm, baseUrl: url, apiType, authType, oauth: authType === 'oauth-device' ? oauth : undefined, apiKeys: keys, models, enabled, type: vb && vb.primary ? 'vision-bridge' : undefined, visionBridge: vb })
  })
  const d = await r.json()
  if (d.success) {
    if (opts && typeof opts.afterCreate === 'function') {
      toast('已创建，继续下一步…', 'success')
      opts.afterCreate(id)
    } else {
      toast('已创建', 'success'); location.reload()
    }
  } else toast(d.message || '创建失败', 'error')
}

function collectOauthNew() {
  const g = function(id) { return (document.getElementById(id) || {}).value?.trim() ?? '' }
  let extraHeaders
  try { extraHeaders = g('ao7') ? JSON.parse(g('ao7')) : undefined } catch { extraHeaders = undefined }
  return {
    flowType: g('ao8') || 'device',
    deviceCodeUrl: g('ao1'),
    deviceTokenUrl: g('ao2'),
    refreshTokenUrl: g('ao3'),
    clientId: g('ao4'),
    clientSecret: g('ao14') || undefined,
    scope: g('ao5') || undefined,
    tokenHeader: g('ao6') || 'x-api-key',
    tokenHeaderPrefix: g('ao9') || undefined,
    extraHeaders,
    modelsUrl: g('ao10') || undefined,
    globalBaseUrl: g('ao11') || undefined,
    globalModelsUrl: g('ao12') || undefined,
    globalOrigin: g('ao13') || undefined,
  }
}

/** 收集「新建提供商」表单的 Vision Bridge 配置；未勾选识图模型时返回 undefined */
function collectVisionBridgeNew() {
  const vision = checkedValues('avb-vision')
  if (vision.length === 0) return undefined
  const primary = checkedRadioValue('avb-primary')
  return { primary: primary || undefined, vision, onVisionFailure: (document.getElementById('avb-fail') || {}).value || 'error' }
}

/** 收集「编辑提供商」表单的 Vision Bridge 配置；未勾选识图模型则清除配置 */
function collectVisionBridgeEdit(id) {
  const vision = checkedValues('vb-vision-' + id)
  if (vision.length === 0) return undefined
  const primary = checkedRadioValue('vb-primary-' + id)
  return { primary: primary || undefined, vision, onVisionFailure: (document.getElementById('vb-fail-' + id) || {}).value || 'error' }
}

/** 取容器内全部勾选的复选框 value（识图模型链，按 DOM 顺序 = 勾选顺序） */
function checkedValues(id) {
  const root = document.getElementById(id)
  const out = []
  if (root) root.querySelectorAll('input[type="checkbox"]:checked').forEach(function (c) { out.push(c.value) })
  return out
}

/** 取容器内选中的单选框 value（主文本模型，空 = 本提供商自身模型） */
function checkedRadioValue(id) {
  const root = document.getElementById(id)
  if (!root) return ''
  const el = root.querySelector('input[type="radio"]:checked')
  return el ? el.value : ''
}

function collectOauthEdit(id) {
  const g = function(suffix) { return (document.getElementById('eao' + suffix + '-' + id) || {}).value?.trim() ?? '' }
  let extraHeaders
  try { extraHeaders = g('7') ? JSON.parse(g('7')) : undefined } catch { extraHeaders = undefined }
  return {
    flowType: g('8') || 'device',
    deviceCodeUrl: g('1'),
    deviceTokenUrl: g('2'),
    refreshTokenUrl: g('3'),
    clientId: g('4'),
    clientSecret: g('14') || undefined,
    scope: g('5') || undefined,
    tokenHeader: g('6') || 'x-api-key',
    tokenHeaderPrefix: g('9') || undefined,
    extraHeaders,
    modelsUrl: g('10') || undefined,
    globalBaseUrl: g('11') || undefined,
    globalModelsUrl: g('12') || undefined,
    globalOrigin: g('13') || undefined,
  }
}

// ===== 厂商预设：选择后自动填充名称/ID/URL/格式，用户只需填 Key =====
const PROVIDER_PRESETS = {
  deepseek:     { name: 'DeepSeek',           id: 'deepseek',     baseUrl: 'https://api.deepseek.com',                          apiType: 'openai' },
  openai:       { name: 'OpenAI',             id: 'openai',       baseUrl: 'https://api.openai.com/v1',                         apiType: 'openai' },
  anthropic:    { name: 'Anthropic',          id: 'anthropic',    baseUrl: 'https://api.anthropic.com',                         apiType: 'anthropic' },
  zhipu:        { name: '智谱 AI',             id: 'zhipu',        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',              apiType: 'openai' },
  qwen:         { name: '通义千问',            id: 'qwen',         baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiType: 'openai' },
  moonshot:     { name: 'Kimi',               id: 'moonshot',     baseUrl: 'https://api.moonshot.cn/v1',                        apiType: 'openai' },
  baichuan:     { name: '百川',               id: 'baichuan',     baseUrl: 'https://api.baichuan-ai.com/v1',                    apiType: 'openai' },
  lingyi:       { name: '零一万物',            id: 'lingyi',       baseUrl: 'https://api.lingyiwanwu.com/v1',                    apiType: 'openai' },
  stepfun:      { name: '阶跃星辰',            id: 'stepfun',      baseUrl: 'https://api.stepfun.com/v1',                        apiType: 'openai' },
  siliconflow:  { name: '硅基流动',            id: 'siliconflow',  baseUrl: 'https://api.siliconflow.cn/v1',                     apiType: 'openai' },
  volcengine:   { name: '火山方舟',            id: 'volcengine',   baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',          apiType: 'openai' },
  qianfan:      { name: '百度千帆',            id: 'qianfan',      baseUrl: 'https://qianfan.baidubce.com/v2',                   apiType: 'openai' },
  openrouter:   { name: 'OpenRouter',         id: 'openrouter',   baseUrl: 'https://openrouter.ai/api/v1',                      apiType: 'openai' },
  together:     { name: 'Together AI',        id: 'together',     baseUrl: 'https://api.together.xyz/v1',                       apiType: 'openai' },
  groq:         { name: 'Groq',               id: 'groq',         baseUrl: 'https://api.groq.com/openai/v1',                    apiType: 'openai' },
  deepinfra:    { name: 'DeepInfra',          id: 'deepinfra',    baseUrl: 'https://api.deepinfra.com/v1/openai',               apiType: 'openai' },
  mistral:      { name: 'Mistral AI',         id: 'mistral',      baseUrl: 'https://api.mistral.ai/v1',                         apiType: 'openai' },
  xai:          { name: 'xAI (Grok)',         id: 'xai',          baseUrl: 'https://api.x.ai/v1',                               apiType: 'openai' },
  workbuddy:    { name: 'WorkBuddy (OAuth)',  id: 'workbuddy',    baseUrl: 'https://copilot.tencent.com/v2',                    apiType: 'openai', authType: 'oauth-device', oauthPreset: 'workbuddy' },
  qoder:        { name: 'QoderWork (OAuth)',  id: 'qoder',        baseUrl: 'https://gateway.qoder.com.cn',                      apiType: 'openai', authType: 'oauth-device', oauthPreset: 'qoder' },
  gemini:       { name: 'Gemini CLI (OAuth)', id: 'gemini',       baseUrl: 'https://cloudcode-pa.googleapis.com',               apiType: 'openai', authType: 'oauth-device', oauthPreset: 'gemini' },
  'gemini-api':   { name: 'Gemini (官方 API Key)', id: 'gemini-api',  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiType: 'openai',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite', 'gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-3-flash-preview', 'gemini-3-pro-preview', 'gemini-3.5-flash'],
  },
  cline:        { name: 'Cline (白嫖模型)',    id: 'cline',        baseUrl: 'https://api.cline.bot/api/v1',                      apiType: 'openai',
    models: ['poolside/laguna-s-2.1:free', 'deepseek/deepseek-v4-flash', 'cline-free/glm-5.2', 'cline-pass/glm-5.2', 'cline-pass/deepseek-v4-flash', 'cline-pass/qwen3.7-max'],
  },
  visionbridge: { name: 'Vision Bridge (图片转写桥)', id: 'visionbridge', baseUrl: 'https://example.com/v1', apiType: 'openai' },
}
function applyProviderPreset(name) {
  const p = PROVIDER_PRESETS[name]
  if (!p) return
  document.getElementById('anm').value = p.name
  document.getElementById('aid').value = p.id
  document.getElementById('aurl').value = p.baseUrl
  document.getElementById('afmt').value = p.apiType
  if (p.authType === 'oauth-device') {
    document.getElementById('aat').value = 'oauth-device'
    toggleAuthType()
    if (p.oauthPreset) applyOauthPreset(p.oauthPreset)
  } else {
    document.getElementById('aat').value = 'api-key'
    toggleAuthType()
  }
  // Cline：默认填上实测可用模型，并提示 Key 处填 refreshToken
  if (p.id === 'cline') {
    applyClineKeyHint(true)
    if (p.models && p.models.length) fillPresetModels(p.models)
  } else if (p.id === 'visionbridge') {
    applyVisionBridgePreset()
  } else if (p.id === 'gemini-api') {
    // 官方纯 API Key 直连（OpenAI 兼容端点），无需 OAuth，直接填好模型
    applyClineKeyHint(false)
    if (p.models && p.models.length) fillPresetModels(p.models)
  } else {
    applyClineKeyHint(false)
  }
}
function applyVisionBridgePreset() {
  applyClineKeyHint(false)
  document.getElementById('avb-fail').value = 'error'
  const url = document.getElementById('aurl')
  if (url) url.value = 'https://example.com/v1'
  const hint = document.getElementById('akey-hint')
  if (hint) hint.textContent = '识图模型直接在下方勾选（可跨厂商，多选按顺序回退）。主文本模型留空时，本提供商下所有模型自动共享识图能力；本提供商 ID 下的模型 ID 为客户端选择时的名称。'
  var refs = (typeof VB_MODELS !== 'undefined' && VB_MODELS) || []
  var want = ['qwen/qwen3-vl-flash', 'openai/gpt-4o-mini']
  var first = 'deepseek/deepseek-chat'
  if (refs.indexOf(first) === -1 && refs.length > 0) first = refs[0]
  var primaryBox = document.getElementById('avb-primary')
  var vision = document.getElementById('avb-vision')
  if (primaryBox) {
    primaryBox.querySelectorAll('input[type="radio"]').forEach(function (rb) { rb.checked = rb.value === first })
  }
  if (vision) {
    vision.querySelectorAll('input[type="checkbox"]').forEach(function (cb) { cb.checked = want.indexOf(cb.value) !== -1 })
  }
}
function applyClineKeyHint(on) {
  const hint = document.getElementById('akey-hint')
  if (hint) hint.textContent = on ? 'Cline 使用 refreshToken（Cline 账号的长期钥匙）。每个 token 一行、一个账号；额度用完会自动切换，支持多账号。' : ''
  const legend = document.getElementById('akey-legend')
  if (legend) legend.textContent = on ? 'Cline RefreshTokens（每个账号一行）' : '上游 API Keys'
}

function toggleAuthType() {
  const v = document.getElementById('aat').value
  const isOauth = v === 'oauth-device'
  document.getElementById('oauth-new').classList.toggle('hd', !isOauth)
  document.getElementById('akeys-fs').classList.toggle('hd', isOauth)
  document.getElementById('amodels-fs').classList.toggle('hd', isOauth)
}
function toggleAuthTypeEdit(id) {
  const v = document.getElementById('auth-' + id).value
  const isOauth = v === 'oauth-device'
  document.getElementById('oauth-edit-' + id).classList.toggle('hd', !isOauth)
  const keysFs = document.getElementById('keys-fs-' + id)
  if (keysFs) keysFs.classList.toggle('hd', isOauth)
  const modelsFs = document.getElementById('models-fs-' + id)
  if (modelsFs) modelsFs.classList.toggle('hd', isOauth)
}

const OAUTH_PRESETS = {
  workbuddy: {
    flowType: 'browser',
    deviceCodeUrl: 'https://copilot.tencent.com/v2/plugin/auth/state?platform=CLI',
    deviceTokenUrl: 'https://copilot.tencent.com/v2/plugin/auth/token',
    refreshTokenUrl: 'https://copilot.tencent.com/v2/plugin/auth/token/refresh',
    clientId: '',
    tokenHeader: 'Authorization',
    tokenHeaderPrefix: 'Bearer ',
    extraHeaders: {
      'Origin': 'https://www.codebuddy.cn',
      'Referer': 'https://www.codebuddy.cn/',
      'User-Agent': 'CLI/2.63.2 CodeBuddy/2.63.2',
    },
    // chat 端点在 /v2/chat/completions，故 baseUrl 带 /v2，转发时拼 chat/completions 即可
    _baseUrl: 'https://copilot.tencent.com/v2',
    // 模型发现端点（非 OpenAI 标准 /models），登录后动态拉取真实可用模型
    _modelsUrl: 'https://copilot.tencent.com/console/enterprises/personal/models',
    // Global 域（海外账户，iss=workbuddy.ai）备选端点：copilot.tencent.com 的 APISIX 会 401 拒绝 Global token
    _globalBaseUrl: 'https://www.workbuddy.ai/v2',
    _globalModelsUrl: 'https://www.workbuddy.ai/console/enterprises/personal/models',
    _globalOrigin: 'https://www.workbuddy.ai',
  },
  qoder: {
    flowType: 'qoder',
    deviceCodeUrl: 'https://qoder.com.cn/device/selectAccounts',
    deviceTokenUrl: 'https://openapi.qoder.com.cn/api/v1/deviceToken/poll',
    refreshTokenUrl: 'https://openapi.qoder.com.cn/api/v1/deviceToken/refresh',
    clientId: '1c5e33e1-364d-4ce6-b02c-acaa81274a5c',
    scope: '',
    tokenHeader: 'Authorization',
    tokenHeaderPrefix: 'Bearer ',
    extraHeaders: {},
    // QoderWork 转发走 COSY 签名（qoder/proxy.ts），baseUrl 仅展示；模型发现也在网关
    _baseUrl: 'https://openapi.qoder.com.cn',
    _modelsUrl: 'https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1',
  },
  gemini: {
    flowType: 'gemini',
    // 官方 Gemini CLI 的 OAuth 客户端凭据不硬编码：在下方表单粘贴，
    // 或配置环境变量 GEMINI_OAUTH_CLIENT_ID / GEMINI_OAUTH_CLIENT_SECRET
    deviceCodeUrl: '',
    deviceTokenUrl: '',
    refreshTokenUrl: '',
    clientId: '',
    clientSecret: '',
    scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile',
    tokenHeader: 'Authorization',
    tokenHeaderPrefix: 'Bearer ',
    extraHeaders: {},
    // Gemini 交互：后台生成授权链接，用户在浏览器授权后把地址栏 URL 粘贴回后台
    _baseUrl: 'https://cloudcode-pa.googleapis.com',
    _redirectUri: 'http://127.0.0.1:8089/oauth2callback',
  },
}
function applyOauthPreset(name) {
  const p = OAUTH_PRESETS[name]
  if (!p) return
  document.getElementById('ao1').value = p.deviceCodeUrl
  document.getElementById('ao2').value = p.deviceTokenUrl
  document.getElementById('ao3').value = p.refreshTokenUrl
  document.getElementById('ao4').value = p.clientId
  const cs = document.getElementById('ao14'); if (cs) cs.value = p.clientSecret || ''
  document.getElementById('ao5').value = p.scope || ''
  document.getElementById('ao6').value = p.tokenHeader || 'x-api-key'
  document.getElementById('ao7').value = JSON.stringify(p.extraHeaders || {}, null, 2)
  const ft = document.getElementById('ao8'); if (ft) ft.value = p.flowType || 'device'
  const tp = document.getElementById('ao9'); if (tp) tp.value = p.tokenHeaderPrefix || ''
  const mu = document.getElementById('ao10'); if (mu) mu.value = p._modelsUrl || ''
  const gb = document.getElementById('ao11'); if (gb) gb.value = p._globalBaseUrl || ''
  const gm = document.getElementById('ao12'); if (gm) gm.value = p._globalModelsUrl || ''
  const go = document.getElementById('ao13'); if (go) go.value = p._globalOrigin || ''
  // 强制覆盖 baseUrl（不再仅在空时填）
  if (p._baseUrl) { const bu = document.getElementById('aurl'); if (bu) bu.value = p._baseUrl }
  document.getElementById('aat').value = 'oauth-device'
  toggleAuthType()
}
function applyOauthPresetEdit(id, name) {
  const p = OAUTH_PRESETS[name]
  if (!p) return
  document.getElementById('eao1-' + id).value = p.deviceCodeUrl
  document.getElementById('eao2-' + id).value = p.deviceTokenUrl
  document.getElementById('eao3-' + id).value = p.refreshTokenUrl
  document.getElementById('eao4-' + id).value = p.clientId
  const cs = document.getElementById('eao14-' + id); if (cs) cs.value = p.clientSecret || ''
  document.getElementById('eao5-' + id).value = p.scope || ''
  document.getElementById('eao6-' + id).value = p.tokenHeader || 'x-api-key'
  document.getElementById('eao7-' + id).value = JSON.stringify(p.extraHeaders || {}, null, 2)
  const ft = document.getElementById('eao8-' + id); if (ft) ft.value = p.flowType || 'device'
  const tp = document.getElementById('eao9-' + id); if (tp) tp.value = p.tokenHeaderPrefix || ''
  const mu = document.getElementById('eao10-' + id); if (mu) mu.value = p._modelsUrl || ''
  const gb = document.getElementById('eao11-' + id); if (gb) gb.value = p._globalBaseUrl || ''
  const gm = document.getElementById('eao12-' + id); if (gm) gm.value = p._globalModelsUrl || ''
  const go = document.getElementById('eao13-' + id); if (go) go.value = p._globalOrigin || ''
  // 强制覆盖 baseUrl
  if (p._baseUrl) { const bu = document.getElementById('url-' + id); if (bu) bu.value = p._baseUrl }
  document.getElementById('auth-' + id).value = 'oauth-device'
  toggleAuthTypeEdit(id)
}

// 预置模型填充 — 新建模式
function fillPresetModels(models) {
  const c = document.getElementById('amodels')
  if (!c) return
  c.innerHTML = ''
  models.forEach(function(mid) { addMdlToForm(mid) })
}
// 预置模型填充 — 编辑模式
function fillPresetModelsEdit(id, models) {
  const c = document.getElementById('ml-' + id)
  if (!c) return
  c.innerHTML = ''
  models.forEach(function(mid) {
    const d = document.createElement('div')
    d.className = 'fc mb-3 field-row'
    d.innerHTML = '<input type="text" value="' + escapeHtml(mid) + '" class="fx1" id="mid-' + id + '-' + Math.random().toString(36).substr(2,9) + '" placeholder="模型 ID"><label class="tg"><input type="checkbox" checked aria-label="启用模型"><span class="sl"></span></label><button class="btn btn-gh btn-xs" onclick="testMdl(\\'' + id + '\\',\\'' + escapeHtml(mid) + '\\')"><i class="fas fa-plug"></i></button><button class="btn btn-gh btn-xs" onclick="this.parentElement.remove()"><i class="fas fa-times c-l"></i></button>'
    c.appendChild(d)
  })
}

function oauthStatus(id) {
  const st = document.getElementById('oauth-st-' + id)
  st.textContent = '查询中…'
  return fetch('/admin/api/oauth/' + encodeURIComponent(id) + '/status').then(r => r.json()).then(d => {
    if (!d.success) { st.textContent = d.message || '查询失败'; return }
    st.textContent = d.data.connected ? ('已连接，到期 ' + (d.data.expiresAt ? new Date(d.data.expiresAt).toLocaleString() : '未知')) : '未连接'
  }).catch(() => { st.textContent = '查询失败' })
}

function oauthConnect(id) {
  const st = document.getElementById('oauth-st-' + id)
  const oauth = collectOauthEdit(id)
  // browser（WorkBuddy）与 qoder（QoderWork 设备授权）都是"跳转登录页授权"的交互：
  // 直接打开登录链接，用户确认后由后台轮询 token，无需输入授权码
  const isBrowser = oauth.flowType === 'browser' || oauth.flowType === 'qoder'
  // gemini（Gemini CLI）是"授权码"交互：后台生成授权链接，用户授权后把回调 URL 粘贴回来
  const isGemini = oauth.flowType === 'gemini'
  if (!isGemini && (!oauth.deviceCodeUrl || !oauth.deviceTokenUrl || !oauth.refreshTokenUrl)) {
    st.textContent = '请先填写 OAuth 端点并保存'
    return
  }
  if (isGemini) {
    // 凭据可从环境变量读取（GEMINI_OAUTH_CLIENT_ID / GEMINI_OAUTH_CLIENT_SECRET），
    // 表单留空时后端回退环境变量，故这里不强制
    if (!oauth.clientId && !oauth.clientSecret) {
      st.textContent = '请填写 Gemini Client ID / Client Secret，或配置环境变量 GEMINI_OAUTH_CLIENT_ID / GEMINI_OAUTH_CLIENT_SECRET'
      return
    }
  } else if (!isBrowser && !oauth.clientId) {
    st.textContent = '设备码模式需要 Client ID，请填写并保存'
    return
  }
  st.textContent = '发起中…'
  fetch('/admin/api/oauth/' + encodeURIComponent(id) + '/connect', { method: 'POST' }).then(r => r.json()).then(d => {
    if (!d.success) { st.textContent = d.message || '发起失败'; return }
    const dev = d.data
    const uri = (dev && dev.verification_uri) || ''
    if (isGemini) {
      // Gemini 授权码模式：打开授权链接，授权后把地址栏（含 ?code=...&state=...）粘贴回来
      st.textContent = '请在浏览器中完成授权后粘贴回调 URL'
      showM('<h3><i class="fas fa-sign-in-alt c-p" aria-hidden="true"></i> Gemini OAuth 授权</h3><p>1. 点击下方链接在浏览器中登录并授权（授权后页面会跳转到 localhost，地址栏里含 <code>?code=...</code>&nbsp;<code>state=...</code>）：</p><p><a href="' + escapeHtml(uri) + '" target="_blank" rel="noreferrer" style="word-break:break-all;font-size:1.05em">' + escapeHtml(uri) + '</a></p><p>2. 复制浏览器地址栏的完整回调 URL，粘贴到下方后提交：</p><p><input type="text" id="gemini-cb-url" placeholder="http://127.0.0.1:8089/oauth2callback?code=...&state=..." style="width:100%;box-sizing:border-box"></p><p class="oauth-status" id="gemini-cb-st"></p><div class="fa"><button class="btn btn-s" onclick="closeM()">取消</button><button class="btn btn-p" onclick="oauthSubmitGemini(' + JSON.stringify(id) + ')">提交授权</button></div>')
    } else if (isBrowser) {
      // 浏览器登录模式：显示登录链接，自动轮询
      st.textContent = '请在弹窗中打开登录链接完成授权'
      showM('<h3><i class="fas fa-sign-in-alt c-p" aria-hidden="true"></i> OAuth 浏览器登录</h3><p>点击下方链接在浏览器中完成登录：</p><p><a href="' + escapeHtml(uri) + '" target="_blank" rel="noreferrer" style="word-break:break-all;font-size:1.1em">' + escapeHtml(uri) + '</a></p><p class="oauth-status" id="oauth-poll-st">等待登录完成…</p><div class="fa"><button class="btn btn-s" onclick="closeM()">取消</button><button class="btn btn-p" onclick="oauthPoll(' + JSON.stringify(id) + ')">刷新状态</button></div>')
      // 自动轮询（每 3 秒）
      if (window._oauthPollTimer) clearInterval(window._oauthPollTimer)
      window._oauthPollTimer = setInterval(function() {
        const pollSt = document.getElementById('oauth-poll-st')
        if (!pollSt || pollSt.textContent.includes('成功')) { clearInterval(window._oauthPollTimer); return }
        oauthPoll(id)
      }, 3000)
    } else {
      // 设备码模式：显示授权码
      const code = (dev && dev.user_code) || ''
      st.textContent = '请在浏览器打开授权页面并输入授权码'
      showM('<h3><i class="fas fa-mobile-alt c-p" aria-hidden="true"></i> OAuth 授权</h3><p>打开以下链接并输入授权码：</p><p><code style="word-break:break-all">' + escapeHtml(uri) + '</code></p><p>授权码：<strong class="c-p" style="font-size:1.6em;letter-spacing:.2em">' + escapeHtml(code) + '</strong></p><p class="oauth-status" id="oauth-poll-st">等待授权…</p><div class="fa"><button class="btn btn-s" onclick="closeM()">取消</button><button class="btn btn-p" onclick="oauthPoll(' + JSON.stringify(id) + ')">刷新状态</button></div>')
    }
  }).catch(() => { st.textContent = '发起失败' })
}

function oauthPoll(id) {
  const pollSt = document.getElementById('oauth-poll-st')
  const st = document.getElementById('oauth-st-' + id)
  if (pollSt) pollSt.textContent = '轮询中…'
  return fetch('/admin/api/oauth/' + encodeURIComponent(id) + '/poll', { method: 'POST' }).then(r => r.json()).then(d => {
    if (d.success) {
      if (window._oauthPollTimer) { clearInterval(window._oauthPollTimer); window._oauthPollTimer = null }
      if (pollSt) { pollSt.textContent = '授权成功！正在拉取模型列表…'; setTimeout(closeM, 1200) }
      if (st) st.textContent = '已连接'
      // 登录成功后自动拉取上游真实模型列表（替代写死的预设模型）
      setTimeout(function() { fetchOauthModels(id) }, 1300)
      return true
    }
    if (pollSt) pollSt.textContent = d.message || '等待授权…'
    if (st) st.textContent = d.message || '等待授权…'
    return false
  }).catch(() => { if (pollSt) pollSt.textContent = '轮询失败，请重试' })
}

// Gemini 授权码模式：提交用户粘贴的回调 URL，后台换 token 并拉取模型
function oauthSubmitGemini(id) {
  const st = document.getElementById('gemini-cb-st')
  const mainSt = document.getElementById('oauth-st-' + id)
  const url = ((document.getElementById('gemini-cb-url') || {}).value || '').trim()
  if (!url) { if (st) st.textContent = '请先粘贴授权后的回调 URL'; return }
  if (st) st.textContent = '提交中…'
  return fetch('/admin/api/oauth/' + encodeURIComponent(id) + '/callback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callbackUrl: url }),
  }).then(r => r.json()).then(d => {
    if (d.success) {
      if (st) st.textContent = '授权成功！正在拉取模型列表…'
      if (mainSt) mainSt.textContent = '已连接'
      setTimeout(closeM, 1200)
      setTimeout(function() { fetchOauthModels(id) }, 1300)
    } else {
      if (st) st.textContent = d.message || '提交失败'
    }
  }).catch(() => { if (st) st.textContent = '提交失败，请重试' })
}

function oauthDisconnect(id) {
  const st = document.getElementById('oauth-st-' + id)
  return fetch('/admin/api/oauth/' + encodeURIComponent(id) + '/disconnect', { method: 'POST' }).then(r => r.json()).then(d => {
    st.textContent = d.success ? '已断开' : (d.message || '断开失败')
  }).catch(() => { st.textContent = '断开失败' })
}

// ===== Cline 一键授权（WorkOS 设备码流程，与原项目 cline_oauth.py 一致） =====
// 发起后弹出授权链接 + 设备码，浏览器登录授权后由后台轮询并自动把 refreshToken 存入账号池。
function clineOAuthConnect(id) {
  const st = document.getElementById('tr-' + id)
  if (st) st.textContent = '发起中…'
  return fetch('/admin/api/cline/oauth/' + encodeURIComponent(id) + '/connect', { method: 'POST' }).then(r => r.json()).then(d => {
    if (!d.success || !d.data) { if (st) showResult(st, false, d.message || '发起失败'); return }
    const dev = d.data
    const uri = dev.verification_uri || ''
    if (st) showResult(st, true, '请在弹窗中打开授权链接完成登录')
    showM('<h3><i class="fas fa-sign-in-alt c-p" aria-hidden="true"></i> Cline 一键授权</h3><p>用注册 Cline 的账号（Google / GitHub / 邮箱）登录并授权，授权成功后 RefreshToken 会自动加入上方账号列表：</p><p><a href="' + escapeHtml(uri) + '" target="_blank" rel="noreferrer" style="word-break:break-all;font-size:1.05em">' + escapeHtml(uri) + '</a></p><p>设备码：<strong class="c-p" style="font-size:1.4em;letter-spacing:.15em">' + escapeHtml(dev.user_code || '') + '</strong></p><p class="oauth-status" id="cline-oauth-poll-st">等待授权…</p><div class="fa"><button class="btn btn-s" onclick="closeM()">取消</button><button class="btn btn-p" onclick="clineOAuthPoll(' + JSON.stringify(id) + ')">刷新状态</button></div>')
    // 自动轮询（每 5 秒，WorkOS interval 默认 5s）
    if (window._clineOAuthTimer) clearInterval(window._clineOAuthTimer)
    window._clineOAuthTimer = setInterval(function() {
      const pollSt = document.getElementById('cline-oauth-poll-st')
      if (!pollSt || pollSt.textContent.includes('成功')) { clearInterval(window._clineOAuthTimer); return }
      clineOAuthPoll(id)
    }, 5000)
  }).catch(() => { if (st) showResult(st, false, '发起失败') })
}

function clineOAuthPoll(id) {
  const pollSt = document.getElementById('cline-oauth-poll-st')
  const st = document.getElementById('tr-' + id)
  if (pollSt) pollSt.textContent = '轮询中…'
  return fetch('/admin/api/cline/oauth/' + encodeURIComponent(id) + '/poll', { method: 'POST' }).then(r => r.json()).then(d => {
    if (d.success) {
      if (window._clineOAuthTimer) { clearInterval(window._clineOAuthTimer); window._clineOAuthTimer = null }
      if (pollSt) { pollSt.textContent = '授权成功！正在刷新账号列表…'; setTimeout(closeM, 1200) }
      if (st) showResult(st, true, '授权成功，RefreshToken 已加入账号池')
      setTimeout(function () { location.reload() }, 1400)
      return true
    }
    if (pollSt) pollSt.textContent = d.message || '等待授权…'
    if (st) st.textContent = d.message || '等待授权…'
    return false
  }).catch(() => { if (pollSt) pollSt.textContent = '轮询失败，请重试' })
}

// OAuth 提供商：用 KV 中的 token 拉取上游模型列表，动态填入编辑表单
async function fetchOauthModels(id) {
  const tr = document.getElementById('tr-' + id)
  if (tr) showSpinner(tr)
  const st = document.getElementById('oauth-st-' + id)
  try {
    const r = await fetch('/admin/api/oauth/' + encodeURIComponent(id) + '/models')
    const d = await r.json()
    if (d.success && d.data && d.data.data) {
      showEditModelsList(id, d.data.data || [])
      if (tr) showResult(tr, true, '已拉取 ' + (d.data.data.length || 0) + ' 个模型，点击 + 添加到下方')
      if (st) st.textContent = '已拉取 ' + (d.data.data.length || 0) + ' 个模型'
    } else {
      const msg = d.message || '拉取模型失败'
      // 拼接调试信息
      let debugInfo = ''
      if (d.data) {
        const dbg = d.data.debug || d.data
        const NL = String.fromCharCode(10)
        debugInfo = NL + NL + '--- 调试信息 ---' + NL
        if (dbg.realm) debugInfo += 'Token 域: ' + dbg.realm + NL
        if (dbg.tokenHeader) debugInfo += '认证头: ' + dbg.tokenHeader + (dbg.tokenHeaderPrefix ? ' ' + dbg.tokenHeaderPrefix + '<token>' : ' <token>') + NL
        debugInfo += '有 Cookie: ' + (dbg.hasCookies ? '是 (' + (dbg.cookiesPreview || '') + ')' : '否') + NL
        if (dbg.modelsUrl) debugInfo += '模型 URL: ' + dbg.modelsUrl + NL
        if (dbg.requestUrl) debugInfo += '请求 URL: ' + dbg.requestUrl + NL
        if (dbg.requestHeaders) debugInfo += '请求头: ' + JSON.stringify(dbg.requestHeaders, null, 2) + NL
        if (dbg.tokenExpiresAt) debugInfo += 'Token 过期: ' + dbg.tokenExpiresAt + NL
        if (d.data.allErrors) debugInfo += '所有错误: ' + JSON.stringify(d.data.allErrors) + NL
      }
      if (tr) showResult(tr, false, escapeHtml(msg + debugInfo))
      if (st) st.textContent = msg
    }
  } catch (e) {
    console.error('fetchOauthModels error:', e)
    if (tr) showResult(tr, false, '请求失败: ' + (e.message || '未知错误'))
    if (st) st.textContent = '拉取失败'
  }
}

// provider api keys (edit)
function getKeys(id) {
  const c = document.getElementById('keys-' + id)
  const items = c.querySelectorAll('[data-kidx]')
  return Array.from(items).map(item => {
    const idx = parseInt(item.dataset.kidx)
    const k = document.getElementById('k-' + id + '-' + idx).value.trim()
    const en = document.getElementById('ken-' + id + '-' + idx).checked
    return k ? { key: k, enabled: en } : null
  }).filter(Boolean)
}

function addKeyRow(id) {
  const inp = document.getElementById('nk-' + id), k = inp.value.trim()
  if (!k) { toast('请输入 API Key', 'error'); return }
  const c = document.getElementById('keys-' + id), cnt = c.querySelectorAll('[data-kidx]').length
  const d = document.createElement('div')
  d.className = 'fc mb-3 field-row'
  d.dataset.kidx = cnt
  d.innerHTML = '<input type="text" value="' + k + '" class="fx1" id="k-' + id + '-' + cnt + '" placeholder="API Key"><label class="tg"><input type="checkbox" checked id="ken-' + id + '-' + cnt + '"><span class="sl"></span></label><button class="btn btn-gh btn-xs" onclick="testKeyRow(\\'' + id + '\\',' + cnt + ')" title="测试"><i class="fas fa-plug"></i></button><button class="btn btn-gh btn-xs" onclick="rmKeyRow(\\'' + id + '\\',' + cnt + ')"><i class="fas fa-times c-l"></i></button>'
  c.appendChild(d)
  inp.value = ''
  inp.focus()
}

function rmKeyRow(id, idx) {
  const c = document.getElementById('keys-' + id)
  c.querySelectorAll('[data-kidx]').forEach(item => {
    if (parseInt(item.dataset.kidx) === idx) item.remove()
  })
}

async function testKeyRow(id, idx) {
  const k = document.getElementById('k-' + id + '-' + idx).value.trim()
  const url = document.getElementById('url-' + id).value.trim()
  if (!k) { toast('请输入 API Key', 'error'); return }
  const apiType = document.getElementById('at-' + id).value
  const tr = document.getElementById('tr-' + id)
  showSpinner(tr)
  const result = await testKeyConnection(url, apiType, k, id)
  showResult(tr, result.success, result.success ? '' : 'HTTP ' + result.status)
  if (result.success && result.data) {
    showEditModelsList(id, result.data.data || [])
  }
}

// opencode 编辑表单 — 获取模型（复用 testKeyConnection 逻辑）
async function fetchEditModels(id) {
  const url = document.getElementById('url-' + id).value.trim()
  const keys = getKeys(id)
  const apiKey = keys.length > 0 ? keys[0].key : ''
  const apiType = document.getElementById('at-' + id).value
  const tr = document.getElementById('tr-' + id)
  showSpinner(tr)
  const result = await testKeyConnection(url, apiType, apiKey, id)
  showResult(tr, result.success, result.success ? '' : escapeHtml(result.message || '获取模型失败'))
  if (result.success && result.data) {
    showEditModelsList(id, result.data.data || [])
  }
}

function showEditModelsList(id, models) {
  const cid = 'mel-' + id
  let el = document.getElementById(cid)
  if (!el) {
    el = document.createElement('div')
    el.id = cid
    el.className = 'fg'
    const pd = document.getElementById('dt-' + id)
    if (!pd) { console.error('showEditModelsList: dt-' + id + ' not found'); return }
    // 找到模型 fieldset 并插入到它前面
    const sections = pd.querySelectorAll('fieldset.form-group')
    let target = null
    for (var i = 0; i < sections.length; i++) {
      var lbl = sections[i].querySelector('legend')
      if (lbl && (lbl.textContent.trim() === '模型' || lbl.textContent.includes('模型'))) {
        target = sections[i]
        break
      }
    }
    if (target && target.parentNode === pd) {
      pd.insertBefore(el, target)
    } else {
      pd.appendChild(el)
    }
  }
  el.innerHTML = '<label>可用模型 <span class="mu">（点击 + 添加单个，或 <a href="javascript:void(0)" onclick="addAllModels(&apos;' + id + '&apos;)">一键全部添加</a>）</span></label>' + renderModelGrid(models, id, id)
}

// 一键添加所有拉取的模型
function addAllModels(id) {
  const grid = document.getElementById('mel-' + id)
  if (!grid) return
  const btns = grid.querySelectorAll('[onclick^="addMdlToEdit"]')
  const ids = []
  btns.forEach(function(btn) {
    const onclick = btn.getAttribute('onclick') || ''
    const match = onclick.match(/addMdlToEdit\('([^']+)','([^']+)'\)/)
    if (match) ids.push(match[2])
  })
  if (ids.length === 0) { toast('没有可添加的模型', 'error'); return }
  // 清除现有模型列表
  const ml = document.getElementById('ml-' + id)
  if (ml) ml.innerHTML = ''
  ids.forEach(function(mid) { addMdlToEdit(id, mid) })
  toast('已添加 ' + ids.length + ' 个模型，请点击保存', 'success')
}

function addMdlToEdit(id, mid) {
  document.getElementById('nmid-' + id).value = mid
  addMdl(id)
}

function getMdl(id) {
  const c = document.getElementById('ml-' + id), items = c.querySelectorAll('[data-idx]')
  return Array.from(items).map(item => {
    const idx = parseInt(item.dataset.idx), mid = document.getElementById('mid-' + id + '-' + idx).value.trim()
    const en = document.getElementById('men-' + id + '-' + idx).checked
    return mid ? { id: mid, enabled: en } : null
  }).filter(Boolean)
}

async function save(id) {
  const nm = document.getElementById('nm-' + id).value.trim(), url = document.getElementById('url-' + id).value.trim()
  const apiType = document.getElementById('at-' + id).value
  const authType = document.getElementById('auth-' + id).value
  const oauth = collectOauthEdit(id)
  const keys = getKeys(id)
  const models = getMdl(id), enabled = document.getElementById('en-' + id).checked
  if (authType === 'oauth-device') {
    const needsClientId = oauth.flowType !== 'browser'
    if (!oauth.deviceCodeUrl || !oauth.deviceTokenUrl || !oauth.refreshTokenUrl || (needsClientId && !oauth.clientId)) {
      toast('OAuth 模式下请填写完整的配置（三个端点' + (needsClientId ? ' + Client ID' : '') + '）', 'error'); return
    }
  }
  const vb = collectVisionBridgeEdit(id) || null
  const r = await fetch('/admin/api/providers/' + encodeURIComponent(id), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: nm, baseUrl: url, apiType, authType, oauth: authType === 'oauth-device' ? oauth : undefined, apiKeys: keys, models, enabled, type: vb && vb.primary ? 'vision-bridge' : null, visionBridge: vb })
  })
  const d = await r.json()
  if (d.success) { toast('已保存', 'success'); location.reload() }
  else toast(d.message || '保存失败', 'error')
}

async function del(id) {
  if (!(await cM('确定要删除此提供商？'))) return
  const r = await fetch('/admin/api/providers/' + encodeURIComponent(id), { method: 'DELETE' })
  const d = await r.json()
  if (d.success) { toast('已删除', 'success'); location.reload() }
  else toast(d.message || '删除失败', 'error')
}

// ===== 转发 Key 模型筛选 =====
async function editKeyModels(keyId) {
  // 获取所有提供商和模型
  const res = await fetch('/admin/api/providers')
  const d = await res.json()
  if (!d.success) { toast('获取模型列表失败', 'error'); return }
  const providers = d.data || []
  const allModels = []
  providers.forEach(function(p) {
    if (!p.enabled) return
    ;(p.models || []).forEach(function(m) {
      if (!m.enabled) return
      allModels.push({ id: p.id + '/' + m.id, label: p.name + ' / ' + m.id, group: p.name })
    })
  })
  if (allModels.length === 0) { toast('暂无可用模型，请先添加提供商和模型', 'error'); return }
  // 获取当前 Key 的 allowedModels
  const keyRes = await fetch('/admin/api/proxy-keys')
  const kd = await keyRes.json()
  const key = (kd.data || []).find(function(k) { return k.id === keyId })
  const allowed = (key && key.allowedModels) || []
  const isAll = allowed.length === 0
  // 按提供商分组
  const groups = {}
  allModels.forEach(function(m) {
    if (!groups[m.group]) groups[m.group] = []
    groups[m.group].push(m)
  })
  let html = '<h3><i class="fas fa-filter c-p" aria-hidden="true"></i> 模型筛选</h3><p>不勾选的模型将无法通过此 Key 访问。全部勾选 = 允许全部。</p>'
  html += '<div style="margin-bottom:8px"><button class="btn btn-gh btn-xs" onclick="keyModelsToggle(true)">全选</button> <button class="btn btn-gh btn-xs" onclick="keyModelsToggle(false)">全不选</button></div>'
  html += '<div class="mdl-list" style="max-height:50vh;overflow-y:auto">'
  Object.keys(groups).forEach(function(g) {
    html += '<div><strong>' + escapeHtml(g) + '</strong></div>'
    groups[g].forEach(function(m) {
      const checked = isAll || allowed.indexOf(m.id) !== -1 ? ' checked' : ''
      html += '<label class="mdl-chk"><input type="checkbox" value="' + escapeHtml(m.id) + '"' + checked + '> ' + escapeHtml(m.id) + '</label>'
    })
  })
  html += '</div>'
  html += '<div class="fa" style="margin-top:12px"><button class="btn btn-s" onclick="closeM()">取消</button><button class="btn btn-p" onclick="saveKeyModels(\\'' + keyId + '\\')">保存</button></div>'
  showM(html)
}
function keyModelsToggle(checked) {
  document.querySelectorAll('.mdl-chk input').forEach(function(el) { el.checked = checked })
}
async function saveKeyModels(keyId) {
  var checked = Array.from(document.querySelectorAll('.mdl-chk input:checked')).map(function(el) { return el.value })
  var all = Array.from(document.querySelectorAll('.mdl-chk input')).map(function(el) { return el.value })
  // 全部勾选 = 存空数组（= 全部允许）
  var allowedModels = checked.length === all.length ? [] : checked
  var res = await fetch('/admin/api/proxy-keys/' + encodeURIComponent(keyId), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ allowedModels: allowedModels })
  })
  var d = await res.json()
  if (d.success) { toast('已保存', 'success'); closeM(); setTimeout(function() { location.reload() }, 500) }
  else toast(d.message || '保存失败', 'error')
}

function addMdl(id) {
  const inp = document.getElementById('nmid-' + id), mid = inp.value.trim()
  if (!mid) { toast('请输入模型 ID', 'error'); return }
  const c = document.getElementById('ml-' + id), cnt = c.querySelectorAll('[data-idx]').length
  const d = document.createElement('div')
  d.className = 'fc mb-3 field-row'
  d.dataset.idx = cnt
  d.innerHTML = '<input type="text" value="' + escapeHtml(mid) + '" class="fx1" id="mid-' + escapeHtml(id) + '-' + cnt + '" placeholder="模型 ID"><label class="tg"><input type="checkbox" checked id="men-' + escapeHtml(id) + '-' + cnt + '"><span class="sl"></span></label><button class="btn btn-gh btn-xs" id="tm-' + escapeHtml(id) + '-' + cnt + '"><i class="fas fa-plug"></i></button><button class="btn btn-gh btn-xs" id="rm-' + escapeHtml(id) + '-' + cnt + '"><i class="fas fa-times c-l"></i></button>'
  c.appendChild(d)
  document.getElementById('tm-' + id + '-' + cnt).addEventListener('click', function() { testMdl(id, mid, cnt) })
  document.getElementById('rm-' + id + '-' + cnt).addEventListener('click', function() { rmMdl(id, cnt) })
  inp.value = ''
}

function rmMdl(id, idx) {
  const c = document.getElementById('ml-' + id)
  c.querySelectorAll('[data-idx]').forEach(item => {
    if (parseInt(item.dataset.idx) === idx) item.remove()
  })
}

async function testMdl(id, mid, idx) {
  const tr = document.getElementById('tr-' + id)
  showSpinner(tr)
  try {
    const r = await fetch('/admin/api/providers/' + encodeURIComponent(id) + '/test-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId: mid })
    })
    const d = await r.json()
    if (d.success && d.data) {
      showResult(tr, d.data.success, d.data.success ? '' : (d.data.message || '连接失败'))
    } else {
      showResult(tr, false, d.message || '测试失败')
    }
  } catch (e) { showResult(tr, false, '请求失败') }
}

// proxy keys
async function genKey() {
  const name = await pM('输入 Key 名称（可选）')
  if (name === null) return
  showM('<h3><i class="fas fa-key c-p"></i> 生成转发 Key</h3><div class="fg"><label>有效期</label><select id="exp"><option value="30d">30 天</option><option value="90d">90 天</option><option value="180d">180 天</option><option value="1y">1 年</option><option value="forever" selected>永久</option></select></div><div class="fa"><button class="btn btn-s" id="gKc">取消</button><button class="btn btn-p" id="gKo">生成</button></div>')
  document.getElementById('gKc').addEventListener('click', closeM)
  document.getElementById('gKo').addEventListener('click', function() { doGenKey(document.getElementById('exp').value, name) })
}

async function doGenKey(exp, name) {
  closeM()
  const nm = name || ''
  const r = await fetch('/admin/api/proxy-keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: nm, expiresIn: exp })
  })
  const d = await r.json()
  if (d.success && d.data) {
    showM('<h3><i class="fas fa-check-circle c-s"></i> 生成成功</h3><p>请妥善保存，切勿泄露：</p><div class="mk">' + d.data.key + '</div><div class="fa"><button class="btn btn-p" onclick="closeM();location.reload()">关闭</button></div>')
  } else toast(d.message || '生成失败', 'error')
}

async function rmKey(id) {
  if (!(await cM('确定要删除此 Key？'))) return
  const r = await fetch('/admin/api/proxy-keys/' + encodeURIComponent(id), { method: 'DELETE' })
  const d = await r.json()
  if (d.success) { toast('已删除', 'success'); location.reload() }
  else toast(d.message || '删除失败', 'error')
}

// proxy key list interactions
async function togglePb(id, checked) {
  const pi = document.querySelector('.pi[data-id="' + id + '"]')
  if (!pi) return
  const b = pi.querySelector('.ps .bd')
  if (b) { b.textContent = checked ? '已启用' : '未启用'; b.className = 'bd ' + (checked ? 'bd-on' : 'bd-off') }
  const r = await fetch('/admin/api/providers/' + encodeURIComponent(id), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: checked })
  })
  const d = await r.json()
  if (!d.success) toast(d.message || '操作失败', 'error')
}

function toggleKeyVis(id) {
  const el = document.getElementById('kv-' + id)
  const full = el.dataset.full
  if (el.textContent.includes('****')) {
    el.textContent = full
  } else {
    el.textContent = full.length > 12
      ? full.substring(0, 8) + '****' + full.substring(full.length - 4)
      : full
  }
}

async function toggleProxyKey(id, checked) {
  const r = await fetch('/admin/api/proxy-keys/' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: checked })
  })
  const d = await r.json()
  if (d.success) {
    const ki = document.querySelector('.ki[data-id="' + id + '"]')
    if (ki) {
      const b = ki.querySelector('.fc .bd')
      if (b) { b.textContent = checked ? '已启用' : '已禁用'; b.className = 'bd ' + (checked ? 'bd-on' : 'bd-off') }
    }
  } else toast(d.message || '操作失败', 'error')
}

// 中文说明：根据点击和 URL 锚点同步侧栏选中态，避免导航始终停留在“概览”。
const adminNavLinks = Array.from(document.querySelectorAll('.admin-nav a[href^="#"]'))
function setActiveAdminNav(hash) {
  const targetHash = adminNavLinks.some(function (link) { return link.getAttribute('href') === hash }) ? hash : '#overview'
  adminNavLinks.forEach(function (link) {
    const active = link.getAttribute('href') === targetHash
    link.classList.toggle('is-active', active)
    if (active) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  })
}
adminNavLinks.forEach(function (link) {
  link.addEventListener('click', function () { setActiveAdminNav(link.getAttribute('href') || '#overview') })
})
window.addEventListener('hashchange', function () { setActiveAdminNav(location.hash) })
setActiveAdminNav(location.hash)

// 签到状态：页面加载后总是加载一次（区块同屏展示，避免签到区默认停在静态占位）；进入 #checkin 时再刷新
function maybeLoadCheckin(hash) { if (hash === '#checkin') loadCheckin() }
window.addEventListener('hashchange', function () { maybeLoadCheckin(location.hash) })
adminNavLinks.forEach(function (link) {
  if (link.getAttribute('href') === '#checkin') {
    link.addEventListener('click', function () { setTimeout(loadCheckin, 50) })
  }
})
setTimeout(loadCheckin, 0)

// 通过 ?connect=id 进入时自动发起 OAuth 登录（"创建并发起连接"按钮创建后跳转过来）
;(function () {
  var cid = new URLSearchParams(location.search).get('connect')
  if (cid) {
    history.replaceState(null, '', '/admin')  // 清掉参数，避免刷新重复触发
    setTimeout(function () { oauthConnect(cid) }, 300)
  }
})()

// ===== 日志系统 =====
var logAutoRefreshTimer = null
var logAutoRefreshSec = 5
var logRefreshing = false
var logPage = 1
var logPageSize = 5
function persistLogAuto() {
  try { localStorage.setItem('kv-log-auto', JSON.stringify({ on: document.getElementById('log-auto-on').checked, sec: Math.max(1, parseInt(document.getElementById('log-auto-sec').value) || 5) })) } catch (e) { /* 忽略 */ }
}
function startLogAutoRefresh() {
  stopLogAutoRefresh()
  logAutoRefreshSec = Math.max(1, parseInt(document.getElementById('log-auto-sec').value) || 5)
  logAutoRefreshTimer = setInterval(function () {
    if (document.getElementById('log-switch').checked) refreshLogs()
  }, logAutoRefreshSec * 1000)
}
function stopLogAutoRefresh() {
  if (logAutoRefreshTimer) { clearInterval(logAutoRefreshTimer); logAutoRefreshTimer = null }
}
function logAutoToggle(on) {
  if (on) startLogAutoRefresh(); else stopLogAutoRefresh()
  persistLogAuto()
}
function logAutoSecChange() {
  if (document.getElementById('log-auto-on').checked) startLogAutoRefresh()
  persistLogAuto()
}
;(function initLogs() {
  fetch('/admin/api/logs/config').then(r => r.json()).then(d => {
    if (d.success) {
      document.getElementById('log-switch').checked = d.data.enabled
      document.getElementById('log-status').textContent = d.data.enabled ? '已开启' : '已关闭'
      if (d.data.enabled) refreshLogs()
    }
  })
  // 恢复上次的自动刷新设置
  try {
    const cfg = JSON.parse(localStorage.getItem('kv-log-auto') || 'null')
    if (cfg) {
      document.getElementById('log-auto-sec').value = cfg.sec || 5
      if (cfg.on) { document.getElementById('log-auto-on').checked = true; startLogAutoRefresh() }
    }
  } catch (e) { /* 忽略 */ }
})()

async function toggleLog(on) {
  const r = await fetch('/admin/api/logs/config', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({enabled:on}) })
  const d = await r.json()
  if (d.success) {
    document.getElementById('log-status').textContent = on ? '已开启' : '已关闭'
    if (on) { logPage = 1; refreshLogs() }
    else document.getElementById('log-list').innerHTML = '<div class="empty-state"><i class="fas fa-list-alt" aria-hidden="true"></i><h3>日志已关闭</h3><p>开启开关后开始记录。</p></div>'
  }
}

async function refreshLogs() {
  if (logRefreshing) return
  logRefreshing = true
  const el = document.getElementById('log-list')
  el.innerHTML = '<div class="empty-state"><i class="fas fa-spinner fa-pulse"></i><h3>加载中…</h3></div>'
  try {
    try {
      const r = await fetch('/admin/api/logs?limit=' + logPageSize + '&offset=' + ((logPage - 1) * logPageSize))
      const d = await r.json()
      if (!d.success || !d.data.logs || d.data.logs.length === 0) {
        // 当前页无数据：若不在第一页则回退一页重新加载（如日志被清除）
        if (logPage > 1) { logPage--; logRefreshing = false; refreshLogs(); return }
        el.innerHTML = '<div class="empty-state"><i class="fas fa-list-alt" aria-hidden="true"></i><h3>暂无日志</h3><p>开启开关后 API 请求会被记录。</p></div>'
        return
      }
      var html = ''
      d.data.logs.forEach(function(log) {
        var icon = log.type === 'error' ? '<i class="fas fa-times-circle c-l"></i>'
          : log.type === 'warn' ? '<i class="fas fa-exclamation-triangle c-o"></i>'
          : log.type === 'request' ? '<i class="fas fa-check-circle c-g"></i>'
          : '<i class="fas fa-info-circle c-p"></i>'
        var time = new Date(log.time).toLocaleString()
        html += '<article class="ki" style="font-size:12px;padding:6px 10px"><div><span style="margin-right:8px">' + icon + '</span><span class="mu" style="margin-right:8px">' + escapeHtml(time) + '</span><span class="bd bd-' + (log.type==='error'?'off':'on') + '">' + log.type + '</span></div><div style="margin-top:4px">' + escapeHtml(log.message) + '</div>' + (log.details ? '<details style="margin-top:4px"><summary>详情</summary><pre style="white-space:pre-wrap;font-size:11px;max-height:200px;overflow:auto">' + escapeHtml(log.details) + '</pre></details>' : '') + '</article>'
      })
      // 分页条
      var totalPages = Math.max(1, Math.ceil(d.data.total / logPageSize))
      var sizeOpts = [5, 10, 15, 20, 50, 100]
      var sizeHtml = '<select onchange="logPageSizeChange(this.value)" style="font-size:12px;padding:2px 4px;border-radius:6px;border:1px solid var(--border,#e2e8f0);background:var(--card,#fff);color:inherit">'
      for (var s = 0; s < sizeOpts.length; s++) {
        sizeHtml += '<option value="' + sizeOpts[s] + '"' + (sizeOpts[s] === logPageSize ? ' selected' : '') + '>' + sizeOpts[s] + ' 条/页</option>'
      }
      sizeHtml += '</select>'
      html += '<div style="padding:10px;display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap">'
      html += '<button class="btn btn-gh btn-xs" onclick="logPageChange(' + (logPage - 1) + ')" ' + (logPage <= 1 ? 'disabled' : '') + '><i class="fas fa-chevron-left"></i>上一页</button>'
      html += '<span class="mu" style="font-size:12px">第 ' + logPage + ' / ' + totalPages + ' 页 · 共 ' + d.data.total + ' 条</span>'
      html += '<button class="btn btn-gh btn-xs" onclick="logPageChange(' + (logPage + 1) + ')" ' + (logPage >= totalPages ? 'disabled' : '') + '>下一页<i class="fas fa-chevron-right"></i></button>'
      html += '<span class="mu" style="font-size:12px">' + sizeHtml + '</span>'
      html += '</div>'
      el.innerHTML = html
    } catch(e) {
      el.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-triangle c-l"></i><h3>加载失败</h3></div>'
    }
  } finally {
    logRefreshing = false
  }
}

function logPageChange(p) {
  if (p < 1) return
  logPage = p
  refreshLogs()
}

function logPageSizeChange(v) {
  v = parseInt(v) || 50
  if (v === logPageSize) return
  logPageSize = v
  logPage = 1  // 切换每页条数后回到第一页
  refreshLogs()
}

async function clearLogs() {
  if (!await cM('确定要清除所有日志吗？此操作不可撤销。')) return
  await fetch('/admin/api/logs', { method: 'DELETE' })
  document.getElementById('log-list').innerHTML = '<div class="empty-state"><i class="fas fa-list-alt" aria-hidden="true"></i><h3>暂无日志</h3><p>日志已清除。</p></div>'
  toast('日志已清除', 'success')
}

// ===== WorkBuddy 签到 =====
async function loadCheckin() {
  const el = document.getElementById('checkin-list')
  if (!el) return
  el.innerHTML = '<div class="empty-state"><i class="fas fa-spinner fa-pulse"></i><h3>加载中…</h3></div>'
  try {
    const r = await fetch('/admin/api/checkin/status')
    const d = await r.json()
    renderCheckinList(d)
  } catch(e) {
    el.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-triangle c-l"></i><h3>加载失败</h3></div>'
    return
  }
  // 后台静默刷新最新状态（签到状态+额度），完成后更新显示，不写日志
  refreshCheckinInBackground()
}

function renderCheckinList(d) {
  const el = document.getElementById('checkin-list')
  if (!el) return
  if (!d || !d.success || !d.data || d.data.length === 0) {
    el.innerHTML = '<div class="empty-state"><i class="fas fa-calendar-check" aria-hidden="true"></i><h3>暂无签到数据</h3><p>配置 WorkBuddy / QoderWork OAuth 提供商后，点击「全部签到」。</p></div>'
    return
  }
  var html = ''
  d.data.forEach(function(c) {
    var reason = c.reason || 'fail'
    var badge = reason === 'ok' ? '<span class="bd bd-on">签到成功</span>'
      : reason === 'already' ? '<span class="bd bd-on">今日已签</span>'
      : reason === 'skipped_global' ? '<span class="bd bd-off">国际版跳过</span>'
      : reason === 'skipped_no_token' ? '<span class="bd bd-off">未签到</span>'
      : '<span class="bd bd-off">失败</span>'
    var lastTime = c.lastCheckinAt ? new Date(c.lastCheckinAt).toLocaleString() : '—'
    var streak = (c.streakDays !== undefined && c.streakDays !== null) ? c.streakDays + ' 天' : '—'
    var credits = (c.totalCredits !== undefined && c.totalCredits !== null) ? c.totalCredits : '—'
    var realmBadge = c.realm === 'cn' ? '<span class="bd bd-on">CN</span>' : c.realm === 'global' ? '<span class="bd bd-off">Global</span>' : '<span class="bd bd-off">未知</span>'
    var payBadge = c.paymentType ? '<span class="bd bd-on">' + escapeHtml(c.paymentType) + '</span>' : ''
    var title = c.nickname ? escapeHtml(c.nickname) + ' <small style="color:var(--muted)">' + escapeHtml(c.name) + '</small>' : escapeHtml(c.name)
    var remain = (c.totalRemain !== undefined && c.totalRemain !== null) ? c.totalRemain : '—'
    var used = (c.totalUsed !== undefined && c.totalUsed !== null) ? c.totalUsed : '—'
    var size = (c.totalSize !== undefined && c.totalSize !== null) ? c.totalSize : '—'
    var packs = (c.packCount !== undefined && c.packCount !== null) ? c.packCount + ' 个包' : '—'
    var pct = (c.totalSize > 0 && c.totalUsed !== undefined && c.totalUsed !== null) ? Math.round(c.totalUsed / c.totalSize * 100) + '%' : ''
    var creditLine = '可用 ' + remain + ' · 已用 ' + used + (pct ? ' · ' + pct : '') + ' · 额度池 ' + size + ' · ' + packs
    var checkinLine = '连续签到：' + streak + ' · 总积分：' + credits + ' · 上次签到：' + escapeHtml(lastTime)
    html += '<article class="ki"><div class="key-main"><span class="key-icon" aria-hidden="true"><i class="fas fa-calendar-check"></i></span><div><div class="kv"><h3>' + title + '</h3>' + realmBadge + payBadge + badge + '</div><p>' + creditLine + '</p><p style="margin-top:2px">' + checkinLine + '</p>' + (c.message ? '<p class="mu" style="margin-top:2px">' + escapeHtml(c.message) + '</p>' : '') + '</div></div><div class="key-actions"><button class="btn btn-gh btn-xs" data-cid="' + escapeHtml(c.providerId) + '"><i class="fas fa-calendar-check" aria-hidden="true"></i>签到</button></div></article>'
  })
  el.innerHTML = html
  el.querySelectorAll('[data-cid]').forEach(function(btn) {
    btn.addEventListener('click', function() { triggerCheckin(btn.getAttribute('data-cid')) })
  })
}

async function refreshCheckinInBackground() {
  try {
    const r = await fetch('/admin/api/checkin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ silent: true }) })
    const d = await r.json()
    if (d.success && d.data && d.data.results) {
      renderCheckinList({ success: true, data: d.data.results })
    }
  } catch(e) { /* 静默刷新失败不提示 */ }
}

async function triggerCheckin(id) {
  toast('签到中…', 'info')
  try {
    const body = id ? JSON.stringify({ id: id }) : '{}'
    const r = await fetch('/admin/api/checkin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body })
    const d = await r.json()
    if (d.success) {
      var msg = id ? '签到完成' : '签到完成：成功 ' + (d.data.success||0) + ' / 已签 ' + (d.data.already||0) + ' / 失败 ' + (d.data.fail||0) + ' / 跳过 ' + (d.data.skipped||0)
      toast(msg, 'success')
      var results = id ? [d.data] : (d.data.results || [])
      renderCheckinList({ success: true, data: results })
    } else {
      toast(d.message || '签到失败', 'error')
    }
  } catch(e) {
    toast('签到请求失败', 'error')
  }
}
</script>
</body></html>`)
}