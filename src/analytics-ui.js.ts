// 观测页面沿用管理后台原生脚本，不引入图表依赖，避免增加 Worker 静态体积。
export const ANALYTICS_JS = `
let analyticsRange = '24h'
let analyticsLogPage = 1
// 详细日志每页条数：默认 5，用户选择后记忆在 localStorage
let analyticsLogPageSize = parseInt(localStorage.getItem('usageLogPageSize') || '5', 10) || 5
let analyticsLogRecords = []
let analyticsController = null
let modelRankingData = []  // 缓存模型排行数据，用于切换排序方式

function formatMetric(value) {
  const number = Number(value || 0)
  if (number >= 1000000000) return (number / 1000000000).toFixed(1) + 'B'
  if (number >= 1000000) return (number / 1000000).toFixed(1) + 'M'
  if (number >= 1000) return (number / 1000).toFixed(1) + 'K'
  return Math.round(number).toLocaleString('zh-CN')
}

function formatLatency(value) {
  const number = Number(value || 0)
  return number >= 1000 ? (number / 1000).toFixed(2) + 's' : Math.round(number) + 'ms'
}

async function fetchAnalytics(path, signal) {
  const response = await fetch(path, { signal: signal })
  const payload = await response.json().catch(function() { return { success: false, message: '响应格式错误' } })
  if (!response.ok || !payload.success) throw new Error(payload.message || 'Analytics 查询失败')
  return payload.data
}

function setAnalyticsLoading(loading) {
  const button = document.getElementById('analytics-refresh')
  if (button) {
    button.disabled = loading
    button.setAttribute('data-state', loading ? 'loading' : '')
  }
  document.querySelectorAll('.analytics-value').forEach(function(item) {
    item.classList.toggle('is-loading', loading)
  })
}

function showAnalyticsError(message) {
  const box = document.getElementById('analytics-error')
  if (!box) return
  box.innerHTML = '<i class="fas fa-exclamation-circle" aria-hidden="true"></i><span>' + escapeHtml(message) + '</span>'
  box.classList.remove('hd')
}

function renderOverview(data) {
  document.getElementById('metric-requests').textContent = formatMetric(data.requests)
  document.getElementById('metric-success').textContent = Number(data.successRate || 0).toFixed(1) + '%'
  document.getElementById('metric-input').textContent = formatMetric(data.promptTokens)
  document.getElementById('metric-output').textContent = formatMetric(data.completionTokens)
  document.getElementById('metric-latency').textContent = formatLatency(data.avgLatencyMs)
}

function renderRanking(rows, sortBy) {
  const target = document.getElementById('model-ranking')
  if (!target) return
  if (!Array.isArray(rows) || rows.length === 0) {
    target.innerHTML = '<div class="analytics-empty"><p>暂无模型调用数据</p></div>'
    return
  }
  // 按请求数或 Token 总量排序
  const sorted = [...rows].sort(function(a, b) {
    if (sortBy === 'tokens') {
      const aTokens = Number(a.prompt_tokens || 0) + Number(a.completion_tokens || 0)
      const bTokens = Number(b.prompt_tokens || 0) + Number(b.completion_tokens || 0)
      return bTokens - aTokens
    }
    return (Number(b.requests || 0) - Number(a.requests || 0))
  })
  const max = Math.max.apply(null, sorted.map(function(row) { return Number(row.requests || 0) }).concat([1]))
  target.innerHTML = sorted.map(function(row, index) {
    const successRate = Number(row.requests || 0) ? Number(row.successes || 0) / Number(row.requests) * 100 : 0
    const label = row.name ? String(row.name) + ' · ' + String(row.label || '') : String(row.label || 'unknown')
    const totalTokens = Number(row.prompt_tokens || 0) + Number(row.completion_tokens || 0)
    return '<div class="ranking-row"><span class="ranking-index">' + (index + 1) + '</span><div class="ranking-main"><div><code title="' + escapeHtml(label) + '">' + escapeHtml(label) + '</code><span>' + formatMetric(row.requests) + ' 次 · ' + successRate.toFixed(1) + '% · ' + formatMetric(totalTokens) + ' Token</span></div><span class="ranking-track"><i style="width:' + Math.max(2, Number(row.requests || 0) / max * 100).toFixed(1) + '%"></i></span></div></div>'
  }).join('')
}

function switchModelRanking(sortBy, button) {
  document.querySelectorAll('[data-rank-tab]').forEach(function(item) { item.classList.toggle('is-active', item === button); item.setAttribute('aria-selected', item === button ? 'true' : 'false') })
  renderRanking(modelRankingData, sortBy)
}

async function loadAnalytics() {
  if (analyticsController) analyticsController.abort()
  analyticsController = new AbortController()
  setAnalyticsLoading(true)
  document.getElementById('analytics-error').classList.add('hd')
  try {
    const results = await Promise.all([
      fetchAnalytics('/admin/api/analytics/overview?range=' + analyticsRange, analyticsController.signal),
      fetchAnalytics('/admin/api/analytics/breakdown?range=' + analyticsRange + '&dimension=model', analyticsController.signal)
    ])
    renderOverview(results[0])
    modelRankingData = results[1]
    renderRanking(results[1], 'requests')
  } catch (error) {
    if (error.name !== 'AbortError') showAnalyticsError(error.message || '统计加载失败')
  } finally { setAnalyticsLoading(false) }
}

function setAnalyticsRange(range, button) {
  analyticsRange = range
  document.querySelectorAll('[data-analytics-range]').forEach(function(item) { item.classList.toggle('is-active', item === button) })
  loadAnalytics()
}

function getLogField(record, key) { return record[key] == null ? '' : record[key] }
function logStatusClass(record) { return getLogField(record, 'blob8') === 'success' ? 'status-badge--on' : 'status-badge--off' }

// Analytics Engine 返回的 timestamp 为 UTC 字符串（如 "2026-08-13 04:00:00"），
// 直接 new Date 会被按本地时区解析导致显示偏差，这里强制按 UTC 解析后转为中国时区显示。
function formatLogTime(value) {
  const raw = String(value == null ? '' : value).trim()
  if (!raw) return '—'
  const normalized = /Z$|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : raw.replace(' ', 'T') + 'Z'
  const date = new Date(normalized)
  return Number.isNaN(date.getTime()) ? raw : date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
}

function renderLogRecords(records) {
  analyticsLogRecords = Array.isArray(records) ? records : []
  const table = document.getElementById('usage-log-body')
  const cards = document.getElementById('usage-log-cards')
  const empty = document.getElementById('usage-log-empty')
  if (!analyticsLogRecords.length) {
    table.innerHTML = ''; cards.innerHTML = ''; empty.classList.remove('hd'); return
  }
  empty.classList.add('hd')
  table.innerHTML = analyticsLogRecords.map(function(record, index) {
    const success = getLogField(record, 'blob8') === 'success'
    return '<tr><td><time>' + escapeHtml(formatLogTime(record.timestamp)) + '</time></td><td><span class="status-badge ' + logStatusClass(record) + '"><i></i>' + (success ? '成功' : '失败') + '</span></td><td><code title="' + escapeHtml(getLogField(record, 'blob6')) + '">' + escapeHtml(getLogField(record, 'blob6') || '—') + '</code></td><td>' + escapeHtml(getLogField(record, 'blob4') || getLogField(record, 'blob3') || '—') + '</td><td class="numeric">' + formatMetric(record.double1) + ' / ' + formatMetric(record.double2) + '</td><td class="numeric">' + formatLatency(record.double5) + '</td><td class="numeric">' + escapeHtml(record.double7 || '—') + '</td><td><button class="btn btn-gh btn-xs" type="button" onclick="showUsageLogDetail(' + index + ')">查看</button></td></tr>'
  }).join('')
  cards.innerHTML = analyticsLogRecords.map(function(record, index) {
    const success = getLogField(record, 'blob8') === 'success'
    return '<button class="log-card" type="button" onclick="showUsageLogDetail(' + index + ')"><span><span class="status-badge ' + logStatusClass(record) + '"><i></i>' + (success ? '成功' : '失败') + '</span><time>' + escapeHtml(formatLogTime(record.timestamp)) + '</time></span><code>' + escapeHtml(getLogField(record, 'blob6') || '未知模型') + '</code><small>' + escapeHtml(getLogField(record, 'blob4') || getLogField(record, 'blob3') || '未知渠道') + ' · 输入 ' + formatMetric(record.double1) + ' · 输出 ' + formatMetric(record.double2) + ' · ' + formatLatency(record.double5) + '</small></button>'
  }).join('')
}

function showUsageLogDetail(index) {
  const record = analyticsLogRecords[index]
  if (!record) return
  const fields = [
    ['时间', formatLogTime(record.timestamp)], ['结果', getLogField(record, 'blob8')], ['路由', getLogField(record, 'blob1')], ['渠道', getLogField(record, 'blob4') || getLogField(record, 'blob3')],
    ['Provider ID', getLogField(record, 'blob3')], ['Provider 类型', getLogField(record, 'blob5')], ['请求模型', getLogField(record, 'blob6')], ['上游模型', getLogField(record, 'blob7')],
    ['输入 Token', record.double1], ['输出 Token', record.double2], ['缓存 Token', record.double3], ['总 Token', record.double4], ['延迟', formatLatency(record.double5)], ['重试次数', record.double6], ['上游状态', record.double7],
    ['Request ID', getLogField(record, 'blob12')], ['Trace ID', getLogField(record, 'blob13')], ['客户端 IP', getLogField(record, 'blob14')], ['User-Agent', getLogField(record, 'blob15')], ['位置', [record.blob16, record.blob17, record.blob18].filter(Boolean).join(' / ')], ['Colo', getLogField(record, 'blob19')], ['错误代码', getLogField(record, 'blob10')], ['错误摘要', getLogField(record, 'blob20')]
  ]
  showM('<div class="log-detail-heading"><div><h3>请求详情</h3><p>Analytics Engine 观测事件</p></div><button class="icon-btn" type="button" onclick="closeM()" aria-label="关闭详情"><i class="fas fa-times"></i></button></div><dl class="log-detail-grid">' + fields.map(function(field) { return '<div><dt>' + escapeHtml(field[0]) + '</dt><dd>' + escapeHtml(field[1] == null || field[1] === '' ? '—' : field[1]) + '</dd></div>' }).join('') + '</dl>')
}

async function loadUsageLogs(resetPage) {
  if (resetPage) analyticsLogPage = 1
  const errorBox = document.getElementById('usage-log-error')
  errorBox.classList.add('hd')
  const params = new URLSearchParams({ page: String(analyticsLogPage), pageSize: String(analyticsLogPageSize), dimension: document.getElementById('log-dimension').value, keyword: document.getElementById('log-keyword').value.trim(), result: document.getElementById('log-result').value })
  const start = document.getElementById('log-start').value, end = document.getElementById('log-end').value
  if (start) params.set('start', new Date(start).toISOString())
  if (end) params.set('end', new Date(end).toISOString())
  try {
    const data = await fetchAnalytics('/admin/api/usage-logs?' + params.toString())
    renderLogRecords(data.records)
    document.getElementById('log-page-label').textContent = '第 ' + data.page + ' 页'
    document.getElementById('log-prev').disabled = analyticsLogPage <= 1
    document.getElementById('log-next').disabled = data.records.length < data.pageSize
    if (typeof markSaved === 'function') markSaved()  // UX8：查询已执行，筛选条件视为已确认
  } catch (error) {
    errorBox.innerHTML = '<i class="fas fa-exclamation-circle"></i><span>' + escapeHtml(error.message || '日志查询失败') + '</span>'
    errorBox.classList.remove('hd')
  }
}

function changeLogPage(offset) {
  analyticsLogPage = Math.max(1, analyticsLogPage + offset)
  loadUsageLogs(false)
}
function changeUsageLogPageSize(v) {
  v = parseInt(v, 10) || 5
  if (v === analyticsLogPageSize) return
  analyticsLogPageSize = v
  try { localStorage.setItem('usageLogPageSize', String(v)) } catch (e) {}
  loadUsageLogs(true)  // 切换每页条数后回到第一页
}
function resetLogFilters() {
  document.getElementById('log-start').value = ''; document.getElementById('log-end').value = ''; document.getElementById('log-keyword').value = ''; document.getElementById('log-result').value = 'all'; document.getElementById('log-dimension').value = 'model'; loadUsageLogs(true)
}

loadAnalytics()
// 同步本地记忆的每页条数到下拉框（SSR 默认选中 5）
function syncLogPageSizeSelect() {
  const sel = document.getElementById('log-page-size')
  if (sel) sel.value = String(analyticsLogPageSize)
}
const usageOpts = [5, 10, 20, 50, 100]
if (usageOpts.indexOf(analyticsLogPageSize) === -1) analyticsLogPageSize = 5
syncLogPageSizeSelect()
loadUsageLogs(true)
`