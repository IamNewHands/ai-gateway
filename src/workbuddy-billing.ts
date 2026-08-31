/**
 * workbuddy-billing.ts — WorkBuddy/CodeBuddy 计费面（billing）HTTP 与额度聚合。
 *
 * 从 checkin.ts 抽出的共享纯逻辑，供两处复用，避免循环依赖：
 *  - checkin.ts：签到 / 额度 / 套餐（面板展示）
 *  - oauth-pool.ts：WorkBuddy 多账号池懒刷新每账号剩余积分
 *
 * 协议（来源 cpa-plugin/workbuddy/billing.go）：
 *   统一 POST，Authorization: Bearer <access_token>，信封 { code, msg, data }，code=0 成功。
 */
import type { PackageInfo } from './types'

export const CHECKIN_BASE_CN = 'https://www.codebuddy.cn'

/**
 * get-user-resource 的 PackageEndTimeRangeEnd 过滤上界（ms）。
 * 请求体用 begin=now（排除已过期包）+ end=该远期值，保证所有有效权益包都被纳入额度聚合。
 * 沿用原实现的数值（365×101 天 ≈ 100.9 年，刻意取足够大的"远期"值，行为不得改动；
 * 套餐通常为月/年度，该值只保证不漏包，与取 1 年结果一致）。
 */
export const PACKAGE_END_HORIZON_MS = 365 * 101 * 24 * 60 * 60 * 1000

/** CPA billing 信封 */
export interface BillingEnvelope {
  code: number
  msg: string
  data?: any
}

/** 兼容下划线 / 驼峰两种字段命名（参考 CPA jsonBool/jsonI64） */
function pickField(obj: Record<string, any>, ...keys: string[]): any {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k]
  }
  return undefined
}

/** 取布尔（兼容 true/'true'/1/'1'）。 */
export function pickBool(obj: Record<string, any>, ...keys: string[]): boolean {
  const v = pickField(obj, ...keys)
  return v === true || v === 'true' || v === 1 || v === '1'
}

/** 取数值（不可解析返回 undefined）。 */
export function pickNum(obj: Record<string, any>, ...keys: string[]): number | undefined {
  const v = pickField(obj, ...keys)
  if (v === undefined || v === null) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/**
 * 发起一次 billing 请求。POST，带 Bearer + X-Domain。
 * opts.body 传入则序列化为请求体（否则默认 {}）；opts.extraHeaders 合并额外头（X-User-Id 等）。
 * code!==0 抛业务错误（含 msg）；5xx/网络错误抛 Error。
 */
export async function billingCall(
  token: string,
  path: string,
  realm: 'cn' | 'global',
  opts?: { body?: any; extraHeaders?: Record<string, string> }
): Promise<any> {
  const base = realm === 'global' ? 'https://www.workbuddy.ai' : CHECKIN_BASE_CN
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Domain': realm === 'global' ? 'workbuddy.ai' : 'codebuddy.cn',
    // 网关要求带 Go HTTP 客户端 UA，否则对该站点计费面返回 http 403 非法请求（code=10085）。
    // 参照 Go 参考实现（cpa-plugin billing.go，http 默认注入 Go-http-client/1.1）与本仓 qoder/billing.ts 的 Go-http-client/2.0。
    'User-Agent': 'Go-http-client/2.0',
  }
  if (opts?.extraHeaders) Object.assign(headers, opts.extraHeaders)
  const body = opts && opts.body !== undefined ? JSON.stringify(opts.body) : '{}'
  const res = await fetch(base + path, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(30000),
  })

  const text = await res.text()
  if (!res.ok) {
    throw new Error(`http ${res.status} ${path}: ${text.substring(0, 200)}`)
  }
  let env: BillingEnvelope
  try {
    env = JSON.parse(text)
  } catch {
    throw new Error(`parse failed ${path}: ${text.substring(0, 200)}`)
  }
  if (env.code !== 0) {
    throw new Error(`code=${env.code} msg=${env.msg || ''}`)
  }
  return env.data
}

/** 解码 WorkBuddy access_token (JWT) 的 uid / enterpriseId / nickname（不验签）。 */
export function decodeWorkbuddyClaims(token: string): { uid: string; enterpriseId: string; nickname: string } {
  let claims: Record<string, any> | null = null
  try {
    const parts = token.split('.')
    if (parts.length >= 2) {
      let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
      while (b64.length % 4) b64 += '='
      claims = JSON.parse(atob(b64))
    }
  } catch { claims = null }
  const out = { uid: '', enterpriseId: '', nickname: '' }
  if (!claims || typeof claims !== 'object') return out
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = claims[k]
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim()
    }
    return ''
  }
  out.uid = pick('uid', 'user_id', 'userId', 'sub', 'UserID')
  out.enterpriseId = pick('enterprise_id', 'enterpriseId', 'tenant_id', 'tenantId', 'TenantID', 'EnterpriseID')
  out.nickname = pick('nickname', 'name', 'username', 'nick', 'ScreenName')
  return out
}

/** 格式化为 CodeBuddy 接口期望的 "YYYY-MM-DD HH:mm:ss"（本地时间）。 */
function fmtLocalTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * 单个资源包的 remain/used/size 计算（移植自 CPA packageRemainUsed）。
 * 优先 Cycle 字段，回退 Capacity 字段；used = size − remain，避免漏报消耗。
 */
function packageRemainUsed(a: any): { remain: number; used: number; size: number } {
  const num = (v: any) => (v === undefined || v === null || v === '') ? 0 : (Number(v) || 0)
  if (num(a.CycleCapacitySize) > 0) {
    let remain = num(a.CycleCapacityRemain)
    const size = num(a.CycleCapacitySize)
    if (remain < 0) remain = 0
    if (remain > size) remain = size
    let used = size - remain
    if (num(a.CycleCapacityUsed) > used) {
      used = num(a.CycleCapacityUsed)
      if (size >= used) remain = size - used
    }
    return { remain, used, size }
  }
  if (num(a.CycleCapacityRemain) > 0 || num(a.CycleCapacityUsed) > 0) {
    let remain = num(a.CycleCapacityRemain)
    let used = num(a.CycleCapacityUsed)
    if (remain < 0) remain = 0
    if (used < 0) used = 0
    let size = remain + used
    if (num(a.CapacitySize) > size) {
      size = num(a.CapacitySize)
      if (size >= remain) used = size - remain
    }
    return { remain, used, size }
  }
  let remain = num(a.CapacityRemain)
  let used = num(a.CapacityUsed)
  let size = num(a.CapacitySize)
  if (remain < 0) remain = 0
  if (used < 0) used = 0
  if (size <= 0) size = remain + used
  if (used === 0 && size > remain) used = size - remain
  return { remain, used, size }
}

/**
 * 拉取用户资源（额度）：POST /v2/billing/meter/get-user-resource
 * 聚合所有包得到 totalRemain/totalUsed/totalSize/packCount + 包明细（移植自 CPA fetchUserResource）。
 * uid/enterpriseId 非空时补 X-User-Id / X-Enterprise-Id / X-Tenant-Id 头。
 * 失败抛错（调用方决定降级/跳过）。
 */
export async function fetchWorkbuddyCredits(
  token: string,
  realm: 'cn' | 'global',
  uid: string,
  enterpriseId: string
): Promise<{ totalRemain: number; totalUsed: number; totalSize: number; packCount: number; packages: PackageInfo[] }> {
  const now = new Date()
  const end = new Date(now.getTime() + PACKAGE_END_HORIZON_MS)
  const body = {
    PageNumber: 1,
    PageSize: 100,
    ProductCode: 'p_tcaca',
    Status: [0, 3],
    PackageEndTimeRangeBegin: fmtLocalTime(now),
    PackageEndTimeRangeEnd: fmtLocalTime(end),
  }
  const extraHeaders: Record<string, string> = {}
  if (uid) extraHeaders['X-User-Id'] = uid
  if (enterpriseId) {
    extraHeaders['X-Enterprise-Id'] = enterpriseId
    extraHeaders['X-Tenant-Id'] = enterpriseId
  }
  const data = await billingCall(token, '/v2/billing/meter/get-user-resource', realm, { body, extraHeaders })
  const resp = data && data.Response && data.Response.Data ? data.Response.Data : null
  if (!resp) throw new Error('get-user-resource 响应缺 Response.Data')
  const accounts: any[] = Array.isArray(resp.Accounts) ? resp.Accounts : []
  let totalRemain = 0, totalUsed = 0, totalSize = 0
  const packages: PackageInfo[] = []
  for (const a of accounts) {
    const { remain, used, size } = packageRemainUsed(a)
    totalRemain += remain
    totalUsed += used
    totalSize += size
    // 收集每个权益包的名称 + 到期时间（ExpiredTime 空串 = 未设置过期时间/长期）
    if (a && typeof a === 'object') {
      const name = typeof a.PackageName === 'string' ? a.PackageName : ''
      if (name) {
        const num = (v: any) => (v === undefined || v === null || v === '') ? 0 : (Number(v) || 0)
        // 优先本周期维度（CycleCapacity*），与实际扣费及顶部聚合口径一致；
        // 周期字段为 0 时（如已过期包无周期额度）回退整包维度（Capacity*）
        let pkgUsed = num(a.CycleCapacityUsed)
        let pkgSize = num(a.CycleCapacitySize)
        if (pkgSize <= 0) {
          pkgUsed = num(a.CapacityUsed)
          pkgSize = num(a.CapacitySize)
        }
        packages.push({
          name,
          expireAt: typeof a.ExpiredTime === 'string' ? a.ExpiredTime : '',
          cycleEndTime: typeof a.CycleEndTime === 'string' ? a.CycleEndTime : undefined,
          used: pkgUsed,
          size: pkgSize,
          unit: typeof a.CapacityUnit === 'string' ? a.CapacityUnit : undefined,
        })
      }
    }
  }
  const packCount = accounts.length
  // 用 size−remain 对齐 used，保证 UI 总计自洽
  if (totalSize > 0) {
    const derived = Math.max(0, totalSize - totalRemain)
    if (derived > totalUsed) totalUsed = derived
  }
  // TotalDosage 是额度池下限，包 size 不全时用它兜底
  const dosage = Number(resp.TotalDosage) || 0
  if (dosage > totalSize) {
    totalSize = dosage
    const derived = Math.max(0, totalSize - totalRemain)
    if (derived > totalUsed) totalUsed = derived
  }
  return { totalRemain, totalUsed, totalSize, packCount, packages }
}

/** 拉取套餐类型：POST /v2/billing/meter/get-payment-type → paymentType（free/paid…）。失败返回空串。 */
export async function fetchWorkbuddyPaymentType(
  token: string,
  realm: 'cn' | 'global',
  uid: string,
  enterpriseId: string
): Promise<string> {
  const extraHeaders: Record<string, string> = {}
  if (uid) extraHeaders['X-User-Id'] = uid
  if (enterpriseId) {
    extraHeaders['X-Enterprise-Id'] = enterpriseId
    extraHeaders['X-Tenant-Id'] = enterpriseId
  }
  try {
    const data = await billingCall(token, '/v2/billing/meter/get-payment-type', realm, { extraHeaders })
    if (data && typeof data.paymentType === 'string') return data.paymentType
    return ''
  } catch {
    return ''
  }
}
