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
import type { Env, PackageInfo } from './types'

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
 * billing 域**结构化业务错误**：HTTP 非 2xx（带 status + 原始 body）或信封 code !== 0。
 *
 * 为什么要区分类型（对齐 workbuddy2api `*upstream.Error` 的设计）：签到幂等判定
 * （`isAlreadyCheckin`）必须区分「上游真实业务回复」与「传输层/解析层抖动」——
 * 前者里的 `already`/`inactive` 可信（是业务语义），后者里的 `already`（如
 * "address already in use"）只是网络栈文案，误判会把停机抖动记成"今日已签到"。
 * 故业务错误用本类承载结构化 code/status，传输层错误保持裸 Error。
 */
export class BillingError extends Error {
  /** 业务码（信封 code；HTTP 非 2xx 时为从 body 尽力解析出的 code，解析不到为 null） */
  readonly code: number | null
  /** HTTP 状态码（网络层失败时为 null） */
  readonly status: number | null
  constructor(message: string, opts?: { code?: number | null; status?: number | null }) {
    super(message)
    this.name = 'BillingError'
    this.code = opts?.code ?? null
    this.status = opts?.status ?? null
  }
}

/**
 * billing 域 `/billing/meter/*` 族的**路径候选序列**（按 realm 切，移植 workbuddy2api
 * client.go:502-519 billingMeterPaths / checkinMeterPaths）。
 *
 * 背景（源实现 R9 实测）：国际版（global）**无 `/v2` 前缀**——`/billing/meter/xxx` 是首选，
 * 带 `/v2` 的形态作为 fallback（上游若返回 404 再试）。CN 则维持带 `/v2` 的现状（零回归）。
 *
 * 仅作用于 `/billing/meter/*` 族（get-user-resource / daily-checkin / get-payment-type）；
 * `/v2/report` 与 growth 域端点**不参与**该 fallback（源实现明确限定范围）。
 */
export function billingMeterPaths(pathSuffix: string, realm: 'cn' | 'global'): string[] {
  if (realm === 'global') return [`/billing/meter/${pathSuffix}`, `/v2/billing/meter/${pathSuffix}`]
  return [`/v2/billing/meter/${pathSuffix}`]
}

/**
 * 发起一次 billing 请求。POST，带 Bearer + X-Domain。
 * opts.body 传入则序列化为请求体（否则默认 {}）；opts.extraHeaders 合并额外头（X-User-Id 等）。
 * code!==0 抛业务错误（含 msg）；5xx/网络错误抛 Error。
 * opts.paths 传入多条候选路径时，仅在**404**（路径不存在）时换下一条（对齐 workbuddy2api
 * billingMeterJSON 的 `ErrNotFound` 才 fallback 语义：其他错误不重试，避免掩盖真实故障）。
 */
export async function billingCall(
  token: string,
  path: string,
  realm: 'cn' | 'global',
  opts?: { body?: any; extraHeaders?: Record<string, string>; paths?: string[] }
): Promise<any> {
  const candidates = opts?.paths && opts.paths.length > 0 ? opts.paths : [path]
  let lastErr: unknown = null
  for (let i = 0; i < candidates.length; i++) {
    try {
      return await billingCallOnce(token, candidates[i], realm, opts)
    } catch (e) {
      lastErr = e
      // 仅 404 视为"该路径不存在"，值得换下一条候选；其他错误立即抛出（不掩盖真实故障）
      const is404 = e instanceof BillingError && e.status === 404
      if (!is404 || i === candidates.length - 1) throw e
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/** 单次 billing 请求（不做路径 fallback）。 */
async function billingCallOnce(
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
    //
    // 注意：这里**有意保留** Go-http-client UA，而不改为 workbuddy2api 的 WorkBuddy 客户端 UA
    // （其 BillingHeaders 用 `WorkBuddy/<ver>`）。理由是 403/10085 是本仓在 Cloudflare Workers
    // 出口上的**实测结论**（见上），而源实现在 Docker/宿主 Go 客户端下工作。UA 属风控敏感项，
    // 未经本环境实测不应改动——避免"为对齐而引入回归"。
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
    // HTTP 非 2xx：尽力从 body 解析业务 code（上游常在 4xx body 里带 code，
    // 如签到幂等的 10001/14001），解析不到则 code=null。保留 status 供调用方分类。
    let code: number | null = null
    try {
      const parsed = JSON.parse(text) as { code?: unknown }
      if (typeof parsed?.code === 'number') code = parsed.code
    } catch { /* 非 JSON body（网关/WAF 纯文本页）：code 保持 null */ }
    throw new BillingError(`http ${res.status} ${path}: ${text.substring(0, 200)}`, { code, status: res.status })
  }
  let env: BillingEnvelope
  try {
    env = JSON.parse(text)
  } catch {
    // 解析失败属传输/协议层，不是业务回复 → 裸 Error（不得被幂等判定消费）
    throw new Error(`parse failed ${path}: ${text.substring(0, 200)}`)
  }
  if (env.code !== 0) {
    throw new BillingError(`code=${env.code} msg=${env.msg || ''}`, { code: env.code, status: res.status })
  }
  return env.data
}

import { parseJwtClaims } from './workbuddy-upstream'
import { newMessageId } from './workbuddy-session-ids'

// ===== 签到幂等判定（移植 workbuddy2api cmd/signin/main.go） =====

/**
 * 幂等/不适用**业务码**（对齐 workbuddy2api idempotentCodes）。
 * 10001 = 实测 code=10001 "今天已签到"；14001 同义变体。
 */
export const CHECKIN_IDEMPOTENT_CODES = [10001, 14001]

/**
 * 幂等/不适用**文案关键词**（全量，仅对结构化业务错误生效）。
 * 对齐 workbuddy2api idempotentMarkers：中文原文 + 英文 lowcase；
 * global 无签到体系类（未开启/未开放/已过期/inactive）是兜底。
 */
const IDEMPOTENT_MARKERS = [
  '今天已签到', '今日已签到', '已签到', 'already',
  '未开启', '未开放', '已过期', 'inactive',
]

/**
 * 裸错误（传输层/解析层）回退匹配用的**中文文案子集**（对齐 workbuddy2api bareMarkers）。
 *
 * 刻意排除英文短词 `already`/`inactive`：它们在传输层错误文本里太常见
 * （`EADDRINUSE: address already in use`、proxy `session inactive`），
 * 对裸错误启用会把停机抖动/端口占用误判成"今日已签到"。
 */
const BARE_MARKERS = ['今天已签到', '今日已签到', '已签到', '未开启', '未开放', '已过期']

/** 字符是否属于「词内字符」（数字/字母/下划线）——用于幂等码的边界判定。 */
function isCodeWordChar(ch: string): boolean {
  return /[0-9a-zA-Z_]/.test(ch)
}

/**
 * 在消息中查找幂等业务码，要求**前后字符都不是词内字符**（对齐 workbuddy2api isAlreadyCode）。
 *
 * 为什么需要边界判定：`code=10001` 与 `"code":10001` 都含子串 `10001`，
 * 但 `12001` / `2010001` / `1_10001` 也含该子串——无边界判定会误判成"已签到"。
 */
export function hasCheckinIdempotentCode(message: string): boolean {
  for (const code of CHECKIN_IDEMPOTENT_CODES) {
    const needle = String(code)
    let from = 0
    for (;;) {
      const idx = message.indexOf(needle, from)
      if (idx < 0) break
      const before = idx > 0 ? message[idx - 1] : ''
      const after = idx + needle.length < message.length ? message[idx + needle.length] : ''
      if (!isCodeWordChar(before) && !isCodeWordChar(after)) return true
      from = idx + needle.length
    }
  }
  return false
}

/**
 * 判定一次签到调用抛出的错误是否表示「今天已签到 / 功能不适用」（幂等成功，不算失败）。
 *
 * 三段式（对齐 workbuddy2api cmd/signin/main.go 的 isAlready + bareMatch 双层设计）：
 *  1. `BillingError`（结构化业务错误，带 code/status）→ 走**全量**判定：
 *     业务码 10001/14001（带边界匹配）或全量文案关键词（含 already/inactive）；
 *  2. 其他错误（传输层/解析层，如超时、DNS、端口占用、解析失败）→ 只走
 *     **中文文案子集**，绝不认 `already`/`inactive`；
 *  3. `null`/非 Error → false。
 *
 * 为什么必须区分：`billingCall` 的网络失败（AbortSignal 超时、EADDRINUSE 等）文本里
 * 可能出现 `already`；若不区分就把它记成"今日已签到"，会让真实失败被静默吞掉，
 * 账号还会被错误地认为已签到（并可能据此解冻冷却）。
 */
export function isAlreadyCheckin(err: unknown): boolean {
  if (err === null || err === undefined) return false
  const message = err instanceof Error ? err.message : String(err)

  if (err instanceof BillingError) {
    // 结构化业务错误：先看业务码（带边界），再看全量文案
    if (err.code !== null && hasCheckinIdempotentCode(String(err.code))) return true
    if (hasCheckinIdempotentCode(message)) return true
    const lower = message.toLowerCase()
    for (const m of IDEMPOTENT_MARKERS) {
      if (lower.includes(m.toLowerCase())) return true
    }
    return false
  }

  // 传输层/解析层裸错误：只认中文专属文案（排除英文短词）
  for (const m of BARE_MARKERS) {
    if (message.includes(m)) return true
  }
  return false
}

/** 解码 WorkBuddy access_token (JWT) 的 uid / enterpriseId / nickname（不验签）。 */
export function decodeWorkbuddyClaims(token: string): { uid: string; enterpriseId: string; nickname: string } {
  return parseJwtClaims(token)
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
  enterpriseId: string,
  deviceToken?: string
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
  // 设备风控头：对齐 workbuddy2api BillingHeaders（billing 域同样注入 X-Device-Token）。
  // 本仓此前只有 report 路径带该头，签到/额度查询缺失。
  if (deviceToken) extraHeaders['X-Device-Token'] = deviceToken
  // 路径按 realm 切（global 无 /v2 前缀优先，404 时 fallback），移植 workbuddy2api billingMeterPaths
  const paths = billingMeterPaths('get-user-resource', realm)
  const data = await billingCall(token, paths[0], realm, { body, extraHeaders, paths })
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

// ===== 国际版（global）注册激活 / 地区完善 / trial 加油包 =====
// 移植 workbuddy2api internal/upstream/trial.go + scripts/global_region.py。
//
// 为什么需要（对齐源实现 PLAN D4）：global 账号**无签到、无任务中心**，
// 「一次性 trial 加油包」是其唯一天然的积分增益动作。且 trial 有前置条件——
// 账号必须完成 register 激活与注册地区完善（否则上游返回 code 500 "region required"
// 或 code 14017 "trial not activated"）。

/** global 域 base（trial / region 端点所在域）。 */
export const GLOBAL_BASE = 'https://www.workbuddy.ai'

/** trial 幂等码：14051 = 已领取过（视为正常，非错误）。 */
export const TRIAL_ALREADY_CODE = 14051

/** 国际版 web 端地区白名单（顺序 = web 展示顺序，对齐源实现 INL_CODES）。 */
export const INTL_REGION_CODES = ['HK', 'MO', 'SG', 'TH', 'PH', 'MY', 'ID'] as const

/** 地区条目（对齐源实现 country dict）。 */
export interface RegionCountry {
  EnName: string
  Name: string
  IOS2: string
  IOS3: string
  Code: string
}

/**
 * 国际版请求头（对齐源实现 `_headers`）：
 * 用浏览器 UA（非 Go-http-client）——这是 global web 域端点的实测要求。
 */
function globalWebHeaders(token?: string, extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'Origin': GLOBAL_BASE,
    'Referer': GLOBAL_BASE + '/',
  }
  if (token) h['Authorization'] = `Bearer ${token}`
  if (extra) Object.assign(h, extra)
  return h
}

/**
 * 拉取可选地区列表（POST /billing/area/get-country-code）。
 *
 * 注意：响应 `data` 是 **JSON 字符串**（需二次解析），内层形如
 * `{"code":0,"data":{"list":[{EnName,Name,IOS2,IOS3,Code},...]}}`。
 * intlOnly=true 时按国际版白名单过滤。
 */
export async function fetchIntlCountries(intlOnly = true): Promise<{ ok: boolean; list: RegionCountry[]; msg: string }> {
  try {
    const res = await fetch(GLOBAL_BASE + '/billing/area/get-country-code', {
      method: 'POST',
      headers: globalWebHeaders(),
      body: JSON.stringify({ filterForbidden: 1 }),
      signal: AbortSignal.timeout(20000),
    })
    const outer = await res.json() as { code?: number; msg?: string; data?: unknown }
    if (outer?.code !== 0) return { ok: false, list: [], msg: outer?.msg || `code=${outer?.code}` }
    const inner = typeof outer.data === 'string' ? JSON.parse(outer.data) : (outer.data as any) || {}
    const all: RegionCountry[] = inner?.data?.list || []
    if (!intlOnly) return { ok: true, list: all, msg: 'ok' }
    const byIos2 = new Map(all.filter((c) => c?.IOS2 && (INTL_REGION_CODES as readonly string[]).includes(c.IOS2)).map((c) => [c.IOS2, c]))
    const list = INTL_REGION_CODES.map((code) => byIos2.get(code)).filter((c): c is RegionCountry => !!c)
    return { ok: true, list, msg: 'ok' }
  } catch (e) {
    return { ok: false, list: [], msg: (e as Error).message }
  }
}

/** 检测当前注册地区（POST /billing/area/get-user-area-info）。返回 ios2 码。 */
export async function detectUserRegion(token: string): Promise<{ ok: boolean; ios2: string; enName: string; msg: string }> {
  try {
    const res = await fetch(GLOBAL_BASE + '/billing/area/get-user-area-info', {
      method: 'POST',
      headers: globalWebHeaders(token),
      body: JSON.stringify({ action: 'getUserAreaInfo' }),
      signal: AbortSignal.timeout(20000),
    })
    const outer = await res.json() as { code?: number; msg?: string; data?: unknown }
    if (outer?.code !== 0) return { ok: false, ios2: '', enName: '', msg: outer?.msg || `code=${outer?.code}` }
    const inner = typeof outer.data === 'string' ? JSON.parse(outer.data) : (outer.data as any) || {}
    const data = inner?.data || {}
    return { ok: true, ios2: String(data.IOS2 || ''), enName: String(data.enName || ''), msg: 'ok' }
  } catch (e) {
    return { ok: false, ios2: '', enName: '', msg: (e as Error).message }
  }
}

/** 提交注册地区（POST /console/login/account）。实测幂等。 */
export async function submitUserRegion(token: string, country: RegionCountry): Promise<{ ok: boolean; msg: string }> {
  try {
    const attrs = {
      countryCode: [String(country.Code)],
      countryFullName: [String(country.EnName)],
      countryName: [String(country.IOS2)],
    }
    const res = await fetch(GLOBAL_BASE + '/console/login/account', {
      method: 'POST',
      headers: globalWebHeaders(token),
      body: JSON.stringify({ attributes: attrs }),
      signal: AbortSignal.timeout(20000),
    })
    const body = await res.json() as { code?: number; msg?: string }
    if (body?.code === 0) return { ok: true, msg: 'ok' }
    return { ok: false, msg: body?.msg || `code=${body?.code}` }
  } catch (e) {
    return { ok: false, msg: (e as Error).message }
  }
}

/**
 * 注册激活/查询（GET /auth/realms/copilot/overseas/user/register?userId=<uid>）。
 *
 * 三态（对齐源实现 activate_region）：
 *  - `code === 200` → 已激活；
 *  - `code === 500` 或 msg 含 `region required` → **需补地区**；
 *  - 其他 → 失败（非"需补地区"）。
 * 携带 `X-User-Id` 与官方 web 对齐。
 */
export async function activateGlobalRegister(
  token: string,
  uid: string
): Promise<{ ok: boolean; needsRegion: boolean; msg: string }> {
  try {
    const url = `${GLOBAL_BASE}/auth/realms/copilot/overseas/user/register?userId=${encodeURIComponent(uid)}`
    const res = await fetch(url, {
      method: 'GET',
      headers: globalWebHeaders(token, { 'X-User-Id': uid }),
      signal: AbortSignal.timeout(20000),
    })
    const body = await res.json() as { code?: number; msg?: string }
    const code = body?.code
    const msg = String(body?.msg || '')
    if (code === 200) return { ok: true, needsRegion: false, msg: 'register success' }
    if (code === 500 || msg.toLowerCase().includes('region required')) {
      return { ok: false, needsRegion: true, msg: msg || `code=${code}` }
    }
    return { ok: false, needsRegion: false, msg: msg || `code=${code}` }
  } catch (e) {
    return { ok: false, needsRegion: false, msg: (e as Error).message }
  }
}

/**
 * 领取一次性 trial 加油包（POST /billing/ide/trial）。**仅 global 账号**。
 *
 * 返回 `{ ok, already, msg }`：
 *  - 成功新领 → `{ ok: true, already: false }`；
 *  - 幂等码 14051（已领过）→ `{ ok: true, already: true }`（**视为正常，非错误**）；
 *  - 其他 → `{ ok: false }`。
 *
 * 幂等码的两种拼写都要覆盖（对齐源实现 trialAlreadyMarkers）：
 * HTTP 200 + 业务 code 非 0 时是 `code=14051`；HTTP 4xx 时原始 body 里是 `"code":14051`。
 */
export async function claimGlobalTrial(token: string): Promise<{ ok: boolean; already: boolean; msg: string }> {
  try {
    const res = await fetch(GLOBAL_BASE + '/billing/ide/trial', {
      method: 'POST',
      headers: globalWebHeaders(token),
      body: '{}',
      signal: AbortSignal.timeout(20000),
    })
    const raw = await res.text()
    let body: { code?: number; msg?: string } | null = null
    try { body = JSON.parse(raw) } catch { body = null }

    if (body?.code === 0) return { ok: true, already: false, msg: 'ok' }
    // 幂等：业务码出现在 JSON 或原始文本里都算（覆盖两种拼写）
    if (raw.includes('14051')) return { ok: true, already: true, msg: '已领取' }
    if (!res.ok) {
      // 非 JSON 4xx（网关/WAF 纯文本页）：按文本判幂等，否则报 http 状态
      return { ok: false, already: false, msg: `http ${res.status}: ${raw.slice(0, 120)}` }
    }
    return { ok: false, already: false, msg: body?.msg || raw.slice(0, 150) }
  } catch (e) {
    return { ok: false, already: false, msg: (e as Error).message }
  }
}

/**
 * 完整完善流程（对齐源实现 complete_flow）：
 *  1. register 查询 → 已激活则直接成功；
 *  2. 需补地区 → 用 pick 提交地区 → **重新 register 验证**；
 *  3. 非"需补地区"的失败 → 直接返回失败（不盲目提交地区）。
 *
 * pick 为地区条目（来自 fetchIntlCountries）；未提供且需补地区 → 失败（需人工选择）。
 */
export async function completeGlobalRegionFlow(
  token: string,
  uid: string,
  pick?: RegionCountry
): Promise<{ ok: boolean; msg: string }> {
  const reg = await activateGlobalRegister(token, uid)
  if (reg.ok) return { ok: true, msg: 'register success' }
  if (!reg.needsRegion) return { ok: false, msg: `register 失败: ${reg.msg}` }
  if (!pick) return { ok: false, msg: '需完善注册地区，但未提供选择' }

  const sub = await submitUserRegion(token, pick)
  if (!sub.ok) return { ok: false, msg: `提交地区失败: ${sub.msg}` }

  const verify = await activateGlobalRegister(token, uid)
  if (!verify.ok) {
    return { ok: false, msg: `提交地区后 register 仍失败: ${verify.msg} (needs_region=${verify.needsRegion})` }
  }
  return { ok: true, msg: '地区已完善，register 成功' }
}

// ===== 生态增值与自动化任务（P2：活跃上报 / 连登天数 / 猫猫旅行） =====

export const CHAT_BASE_CN = 'https://copilot.tencent.com'

/**
 * 发起 growth 域请求（copilot.tencent.com 或 www.workbuddy.ai）。
 * 走 chatBase + 统一认证头与信封解析（{ code: 0, msg: '', data: ... }）。
 */
export async function growthCall(
  token: string,
  path: string,
  realm: 'cn' | 'global',
  opts?: { method?: 'GET' | 'POST'; body?: any; extraHeaders?: Record<string, string> }
): Promise<any> {
  const base = realm === 'global' ? 'https://www.workbuddy.ai' : CHAT_BASE_CN
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Domain': realm === 'global' ? 'workbuddy.ai' : 'codebuddy.cn',
    'User-Agent': 'Go-http-client/2.0',
  }
  if (opts?.extraHeaders) Object.assign(headers, opts.extraHeaders)
  const method = opts?.method || (opts?.body !== undefined ? 'POST' : 'GET')
  const body = method === 'GET' ? undefined : JSON.stringify(opts?.body ?? {})
  const res = await fetch(base + path, {
    method,
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

/** 对话活跃上报客户端完整事件形状（对齐 workbuddy2api probe_active.py / report.go）。 */
/**
 * 对话活跃上报客户端完整事件形状（对齐 workbuddy2api probe_active.py / report.go）。
 *
 * opts.mode / opts.modelId / opts.modelName 用于**夜猫子任务**（black_cat）等特殊场景：
 * 源实现中 black_cat 用 `mode: "night"` + `glm-5.2`（普通 chat 用 `mode: "craft"` +
 * `deepseek-v4-flash`）。缺省即普通形态（向后兼容）。
 */
export function buildChatRequestEvent(
  uid: string,
  cid: string,
  rid: string,
  opts?: { mode?: string; modelId?: string; modelName?: string }
): Record<string, unknown> {
  const now = Date.now()
  return {
    eventCode: 'chat_request_send',
    timestamp: now,
    reportDelay: 0,
    mode: opts?.mode || 'craft',
    conversationId: cid,
    requestId: rid,
    inputLength: 12,
    requestModelId: opts?.modelId || 'deepseek-v4-flash',
    requestModelName: opts?.modelName || 'DeepSeek V4 Flash',
    isPlan: false,
    isAutoExecuteTerminal: false,
    isAutoModify: false,
    codebaseEnable: false,
    maxToken: 0,
    maxSteps: 0,
    temperature: 0,
    maxRetries: 0,
    mentionContexts: [],
    knowledgeId: [],
    knowledgeName: [],
    codebaseId: '',
    mentionContextCount: 0,
    command: '',
    expertId: '',
    recommendId: '',
    skillId: '',
    skillCount: 0,
    totalCount: 0,
    fileUri: '',
    presentAt: now,
    traceId: '',
    rootRequestId: cid,
    parentConversationId: cid,
    agentName: 'default',
    agentType: 'conversation',
    userId: uid,
  }
}

/**
 * 同一账号内连续活跃上报之间的间隔（对齐 workbuddy2api `activityReportGap` = 1.5s）。
 *
 * 为什么需要：5 连发是在模拟"同一会话多轮对话"，**秒发易触发上游风控**
 * （源实现注释原文）。缺省 1500ms；测试可注入 0 跳过等待。
 */
export const ACTIVITY_REPORT_GAP_MS = 1500

/**
 * 账号之间的限速间隔（对齐 workbuddy2api `activityAccountDelay` / `travelAccountDelay` = 800ms）。
 * 用于"遍历池内账号"的场景，避免同一时刻连续打上游。
 */
export const ACTIVITY_ACCOUNT_DELAY_MS = 800

/** 可注入的延时函数（测试传 () => Promise.resolve() 跳过真实等待）。 */
export type DelayFn = (ms: number) => Promise<void>

const defaultDelay: DelayFn = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 真实延时（用于账号间限速等场景）。ms <= 0 时立即返回。
 * 测试可通过注入 delay 参数绕过（见 reportWorkbuddyChatActivity 的 opts.delay）。
 */
export function delayMs(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return defaultDelay(ms)
}

/**
 * 向上游发送对话活跃上报：POST /v2/report。
 * 一条上报同时点亮 growth 连登 + 解锁 first_buddy 任务（领养前置）。
 * 默认发送 count=5 条（同 conversationId、不同 requestId），满足首次领猫对话量门槛。
 *
 * opts.mode / opts.modelId / opts.modelName 透传给事件构造（夜猫子任务用）。
 * opts.delay / opts.gapMs 用于控制条间间隔（缺省 1.5s，对齐源实现 activityReportGap；
 * 测试可传 delay=noop 跳过等待）。
 */
export async function reportWorkbuddyChatActivity(
  token: string,
  realm: 'cn' | 'global',
  uid: string,
  opts?: {
    enterpriseId?: string
    deviceToken?: string
    count?: number
    mode?: string
    modelId?: string
    modelName?: string
    /** 条间间隔（ms）；缺省 ACTIVITY_REPORT_GAP_MS */
    gapMs?: number
    /** 注入延时实现（测试用）；缺省真实 setTimeout */
    delay?: DelayFn
  }
): Promise<{ success: boolean; reported: number; message: string }> {
  const count = typeof opts?.count === 'number' && opts.count > 0 ? opts.count : 5
  const gapMs = typeof opts?.gapMs === 'number' ? opts.gapMs : ACTIVITY_REPORT_GAP_MS
  const delay = opts?.delay || defaultDelay
  const cid = `wb2api-${Date.now()}`
  const extraHeaders: Record<string, string> = {}
  if (uid) extraHeaders['X-User-Id'] = uid
  if (opts?.enterpriseId) {
    extraHeaders['X-Enterprise-Id'] = opts.enterpriseId
    extraHeaders['X-Tenant-Id'] = opts.enterpriseId
  }
  if (opts?.deviceToken) extraHeaders['X-Device-Token'] = opts.deviceToken

  let ok = 0
  for (let i = 1; i <= count; i++) {
    const rid = `${cid}-r${i}`
    const ev = buildChatRequestEvent(uid, cid, rid, {
      mode: opts?.mode,
      modelId: opts?.modelId,
      modelName: opts?.modelName,
    })
    try {
      await billingCall(token, '/v2/report', realm, { body: [ev], extraHeaders })
      ok++
    } catch (e) {
      return { success: ok > 0, reported: ok, message: `第 ${i}/${count} 条上报失败: ${(e as Error).message}` }
    }
    // 条间间隔（对齐源实现：`if i < count { time.Sleep(activityReportGap) }`）——
    // 5 连发模拟同一会话多轮对话，秒发易触发上游风控。
    if (i < count && gapMs > 0) await delay(gapMs)
  }
  return { success: true, reported: ok, message: `成功上报 ${ok} 条对话活跃事件` }
}

// ===== 夜猫子任务（black_cat）=====
// 移植 workbuddy2api scripts/task_runner.py 的 black_cat 特殊分支 + scheduler/school.go RunCatNow。

/** 夜猫窗口（CST）：23:00 – 次日 08:00（对齐源实现 within_night_window）。 */
export const NIGHT_WINDOW_START_HOUR = 23
export const NIGHT_WINDOW_END_HOUR = 8

/**
 * 当前是否处于夜猫窗口（CST 23:00–08:00）。
 *
 * 时区必须显式按 CST(+08:00) 计算：Workers 运行时本地时区是 UTC，
 * 用本地 getHours() 会把窗口错位 8 小时。
 */
export function withinNightWindow(from: number = Date.now()): boolean {
  const cst = new Date(from + 8 * 60 * 60 * 1000)
  const hour = cst.getUTCHours()
  return hour >= NIGHT_WINDOW_START_HOUR || hour < NIGHT_WINDOW_END_HOUR
}

/**
 * 夜猫子任务：在夜猫窗口内补 1 次 `black_cat` 上报（`mode: "night"` + `glm-5.2`）。
 *
 * 语义（对齐源实现 task_runner.py:799-811）：
 *  - 非窗口期 → 直接返回 `skipped`（**不发任何上游请求**）；
 *  - 窗口内 → 发 **1 条**（cap=1，源实现明确"窗口内最多补 1 次"）。
 *
 * 为什么 mode 是 `night`：源实现 `build_event` 中 black_cat 用 `mode: "night"`，
 * 普通 chat 用 `"craft"`——上游按 mode 区分任务归属。
 */
export async function runWorkbuddyNightCat(
  token: string,
  realm: 'cn' | 'global',
  uid: string,
  opts?: { enterpriseId?: string; deviceToken?: string; from?: number }
): Promise<{ state: 'skipped' | 'reported' | 'error'; message: string }> {
  if (!withinNightWindow(opts?.from)) {
    return { state: 'skipped', message: '非夜猫窗口（23:00–08:00 CST），跳过' }
  }
  try {
    const r = await reportWorkbuddyChatActivity(token, realm, uid, {
      enterpriseId: opts?.enterpriseId,
      deviceToken: opts?.deviceToken,
      count: 1,
      mode: 'night',
      modelId: 'glm-5.2',
      modelName: 'GLM-5.2',
    })
    return { state: r.success ? 'reported' : 'error', message: r.message }
  } catch (e) {
    return { state: 'error', message: (e as Error).message }
  }
}

/** 查询连登天数（只读 oracle）：GET /activity/growth/streak。 */
export async function fetchWorkbuddyStreak(
  token: string,
  realm: 'cn' | 'global',
  opts?: { uid?: string; enterpriseId?: string; deviceToken?: string }
): Promise<number> {
  const extraHeaders: Record<string, string> = {}
  if (opts?.uid) extraHeaders['X-User-Id'] = opts.uid
  if (opts?.enterpriseId) extraHeaders['X-Enterprise-Id'] = opts.enterpriseId
  if (opts?.deviceToken) extraHeaders['X-Device-Token'] = opts.deviceToken
  try {
    const data = await growthCall(token, '/activity/growth/streak', realm, { method: 'GET', extraHeaders })
    const days = data?.streak?.days
    return typeof days === 'number' ? days : 0
  } catch {
    return 0
  }
}

/** 猫档案 */
export interface WorkbuddyBuddyInfo {
  id: number
  name: string
}

/** 猫猫旅行状态 */
export interface WorkbuddyTravelState {
  state: 'idle' | 'traveling' | 'arrived' | string
  daily_limit_reached: boolean
  record_id?: number
  reward_credit?: number
}

/** 查询当前猫档案：GET /activity/growth/buddy/info。null 表示无猫。 */
export async function fetchWorkbuddyBuddyInfo(
  token: string,
  realm: 'cn' | 'global',
  opts?: { uid?: string; enterpriseId?: string; deviceToken?: string }
): Promise<WorkbuddyBuddyInfo | null> {
  const extraHeaders: Record<string, string> = {}
  if (opts?.uid) extraHeaders['X-User-Id'] = opts.uid
  if (opts?.enterpriseId) extraHeaders['X-Enterprise-Id'] = opts.enterpriseId
  if (opts?.deviceToken) extraHeaders['X-Device-Token'] = opts.deviceToken
  try {
    const data = await growthCall(token, '/activity/growth/buddy/info', realm, { method: 'GET', extraHeaders })
    if (data && data.buddy && typeof data.buddy === 'object') {
      const b = data.buddy
      return { id: Number(b.id) || 0, name: String(b.name || '') }
    }
    return null
  } catch {
    return null
  }
}

/** 同意猫猫旅行协议：POST /activity/growth/buddy/agreement */
export async function agreeWorkbuddyBuddyAgreement(
  token: string,
  realm: 'cn' | 'global',
  opts?: { uid?: string; enterpriseId?: string; deviceToken?: string }
): Promise<void> {
  const extraHeaders: Record<string, string> = {}
  if (opts?.uid) extraHeaders['X-User-Id'] = opts.uid
  if (opts?.enterpriseId) extraHeaders['X-Enterprise-Id'] = opts.enterpriseId
  if (opts?.deviceToken) extraHeaders['X-Device-Token'] = opts.deviceToken
  await growthCall(token, '/activity/growth/buddy/agreement', realm, { method: 'POST', body: { agree: true }, extraHeaders })
}

/** 领养第一只猫：POST /activity/growth/buddy/first。成功送 300 分。 */
export async function adoptWorkbuddyFirstBuddy(
  token: string,
  realm: 'cn' | 'global',
  opts?: { uid?: string; enterpriseId?: string; deviceToken?: string }
): Promise<{ success: boolean; message: string }> {
  const extraHeaders: Record<string, string> = {}
  if (opts?.uid) extraHeaders['X-User-Id'] = opts.uid
  if (opts?.enterpriseId) extraHeaders['X-Enterprise-Id'] = opts.enterpriseId
  if (opts?.deviceToken) extraHeaders['X-Device-Token'] = opts.deviceToken
  try {
    await growthCall(token, '/activity/growth/buddy/first', realm, { method: 'POST', body: {}, extraHeaders })
    return { success: true, message: '领养成功 (+300 积分)' }
  } catch (e) {
    const msg = (e as Error).message || ''
    if (msg.includes('first_buddy task not completed yet')) {
      return { success: false, message: '领养门槛未达标（需前置对话）' }
    }
    return { success: false, message: `领养失败: ${msg}` }
  }
}

/** 查询猫猫旅行状态：GET /activity/growth/buddy/travel/status */
export async function fetchWorkbuddyTravelStatus(
  token: string,
  realm: 'cn' | 'global',
  opts?: { uid?: string; enterpriseId?: string; deviceToken?: string }
): Promise<WorkbuddyTravelState | null> {
  const extraHeaders: Record<string, string> = {}
  if (opts?.uid) extraHeaders['X-User-Id'] = opts.uid
  if (opts?.enterpriseId) extraHeaders['X-Enterprise-Id'] = opts.enterpriseId
  if (opts?.deviceToken) extraHeaders['X-Device-Token'] = opts.deviceToken
  try {
    const data = await growthCall(token, '/activity/growth/buddy/travel/status', realm, { method: 'GET', extraHeaders })
    if (!data || typeof data !== 'object') return null
    return {
      state: String(data.state || 'idle'),
      daily_limit_reached: Boolean(data.daily_limit_reached),
      record_id: data.record_id ? Number(data.record_id) : undefined,
      reward_credit: data.reward_credit ? Number(data.reward_credit) : undefined,
    }
  } catch {
    return null
  }
}

/** 派出猫猫旅行：POST /activity/growth/buddy/travel/depart */
export async function departWorkbuddyTravel(
  token: string,
  realm: 'cn' | 'global',
  locationId: number = 4,
  opts?: { uid?: string; enterpriseId?: string; deviceToken?: string }
): Promise<void> {
  const extraHeaders: Record<string, string> = {}
  if (opts?.uid) extraHeaders['X-User-Id'] = opts.uid
  if (opts?.enterpriseId) extraHeaders['X-Enterprise-Id'] = opts.enterpriseId
  if (opts?.deviceToken) extraHeaders['X-Device-Token'] = opts.deviceToken
  await growthCall(token, '/activity/growth/buddy/travel/depart', realm, { method: 'POST', body: { location_id: locationId }, extraHeaders })
}

/** 到站领取奖励：POST /activity/growth/buddy/travel/claim */
export async function claimWorkbuddyTravelReward(
  token: string,
  realm: 'cn' | 'global',
  recordId: number,
  opts?: { uid?: string; enterpriseId?: string; deviceToken?: string }
): Promise<number> {
  const extraHeaders: Record<string, string> = {}
  if (opts?.uid) extraHeaders['X-User-Id'] = opts.uid
  if (opts?.enterpriseId) extraHeaders['X-Enterprise-Id'] = opts.enterpriseId
  if (opts?.deviceToken) extraHeaders['X-Device-Token'] = opts.deviceToken
  const data = await growthCall(token, '/activity/growth/buddy/travel/claim', realm, { method: 'POST', body: { record_id: recordId }, extraHeaders })
  return data?.reward_credit ? Number(data.reward_credit) : 0
}

/**
 * 返回某时刻所属的 **CST 自然日**（`YYYY-MM-DD`）。
 * 对齐 workbuddy2api `travelDay`：上游每日重置按 CST 00:00，中国无夏令时，
 * 固定 +8 即可（Workers 运行时本地时区是 UTC，不能用本地日期）。
 */
export function cstDay(from: number = Date.now()): string {
  const cst = new Date(from + 8 * 60 * 60 * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${cst.getUTCFullYear()}-${p(cst.getUTCMonth() + 1)}-${p(cst.getUTCDate())}`
}

/**
 * 返回某时刻**前一日**的 CST 自然日（`YYYY-MM-DD`）。
 *
 * 为什么必须这么算（对齐 workbuddy2api `GrowthYesterdayDate`）：补签卡的 `target_date`
 * 是**上游 CST 自然日**。若写成「本地日期减一天」（`new Date(from - 86400000)` 后取本地
 * 年月日，或先取本地日期再 `setDate(-1)`），在 Workers（本地时区 = UTC）上会得到 UTC 日，
 * CST 00:00–08:00 这一档会**整整错一天**——把「昨天」补成「前天」，漏签的格子依旧是空的，
 * 连续天数照样断（上游 `d6f51a8` 专门修过这类 CST/DST 错位）。
 * 正确写法是先减 24h 再做 CST 换算，即复用 `cstDay`（中国无夏令时，固定 +8 无歧义）。
 */
export function cstYesterday(from: number = Date.now()): string {
  return cstDay(from - 86400000)
}

/**
 * 领养当日防抖 KV 前缀（uid → CST 日期）。
 *
 * 为什么需要：领养（`buddy/first`）有对话量门槛，未达标时上游返回 400
 * `first_buddy task not completed yet`。若不加防抖，每轮旅行巡检都会重试一次，
 * 对上游形成无意义的重复请求（源实现 `adoptTriedToday` 明确"避免同日多趟对上游重试轰炸"）。
 *
 * 与源实现的差异：源实现用**进程内存 Map**（重启即清零，单机部署可接受）；
 * Workers 多 isolate 无共享内存，故用 KV 按自然日记录，跨 isolate 一致。
 */
export const ADOPT_TRIED_KV_PREFIX = 'workbuddy:adopt-tried:'

/** 该账号今日是否已判定领养门槛未达。 */
export async function adoptTriedToday(env: Env, providerId: string, uid: string, from?: number): Promise<boolean> {
  try {
    const raw = await env.KV.get(`${ADOPT_TRIED_KV_PREFIX}${providerId}:${uid}`)
    return raw === cstDay(from)
  } catch {
    return false // KV 不可读时不抑制（宁可多试一次，也不漏领养）
  }
}

/** 记录该账号今日已尝试领养且未过门槛（TTL 2 天，跨日自动失效）。 */
export async function markAdoptTried(env: Env, providerId: string, uid: string, from?: number): Promise<void> {
  try {
    await env.KV.put(`${ADOPT_TRIED_KV_PREFIX}${providerId}:${uid}`, cstDay(from), { expirationTtl: 2 * 24 * 60 * 60 })
  } catch { /* KV 写失败不阻断主流程（退化为无防抖） */ }
}

// ===== 连登奖励兑换 + 连登抽奖（移植 workbuddy2api 91418c5 growth_reward.go） =====
//
// 端点（CN web 成长中心 SPA 逆向）：
//   GET  /activity/growth/streak          → data.streak.days + data.redemption_status（各档状态）
//   POST /activity/growth/redeem          → {"tier":"7d","client_token":"<hex>"}
//   GET  /activity/growth/lottery/chances → data.balance（抽奖次数）
//   POST /activity/growth/lottery/draw    → {"client_token":"<hex>"}
//
// 连登奖励 = **里程碑兑换**（非按天 claim）：7d/14d/28d 三档，同月每档各可领一次。
// 领奖成功送 {credit_granted, energy_granted, cards_granted, chances_granted}，
// chances 即抽奖次数，凭它调 draw。

/** 连登奖励档位（对齐源实现 GrowthTierSpec）。 */
export interface WorkbuddyGrowthTier {
  tier: string
  days?: number
  credit?: number
  energy?: number
  cards?: number
  chances?: number
}

/** 连登奖励兑换状态（对齐源实现 GrowthRedemptionStatus）。 */
export interface WorkbuddyRedemptionStatus {
  tier_7d_status?: string
  tier_14d_status?: string
  tier_28d_status?: string
  tiers?: WorkbuddyGrowthTier[]
  remaining_days?: number
}

/** 连登奖励 + 兑换状态整体快照（一次 GET 读完，免二次请求）。 */
export interface WorkbuddyRewardState {
  days: number
  redemption: WorkbuddyRedemptionStatus
  /**
   * 补签卡余额（同响应体的 `data.makeup_cards` 段）。
   *
   * 为什么放这里：源实现 `GrowthStreakWithCards` 与 `GrowthRewardState` **是同一个端点**
   * （`/activity/growth/streak`），只差解析哪一段。本仓既然已经为"免二次请求"把
   * days + redemption_status 一次读完，就顺手把 `makeup_cards` 也解析掉——否则补签判据
   * 会为同一端点再打一遍（与 `opts.state` 的设计意图相悖）。
   * 上游未返回该段时缺省（补签判据按"无卡"处理，不误补）。
   */
  makeupCards?: WorkbuddyMakeupCards
}

/** 领奖回执（对齐源实现 GrowthRedeemResult）。 */
export interface WorkbuddyRedeemResult {
  cards_granted: number
  cards_overflow: number
  credit_granted: number
  energy_granted: number
  chances_granted: number
}

/** 单次抽奖结果（对齐源实现 GrowthLotteryDrawResult）。 */
export interface WorkbuddyLotteryDrawResult {
  prize_code: string
  prize_name: string
  prize_type: string
  credit_amount: number
}

/** 连登奖励档位顺序（由高到低，供"挑最高可领档"策略）。 */
export const WORKBUDDY_GROWTH_TIERS = ['28d', '14d', '7d'] as const

/** 各档达标所需连登天数（上游 SPA 常量同构；redemption_status.tiers 缺失时的兜底）。 */
export const WORKBUDDY_GROWTH_TIER_DAYS: Record<string, number> = { '7d': 7, '14d': 14, '28d': 28 }

/** 生成 SPA 同款 client_token：`<prefix>-<32hex>`（对齐源实现 growthClientToken）。 */
export function growthClientToken(prefix: string): string {
  return `${prefix}-${newMessageId()}`
}

/** 判定某档本月是否已领（status === "claimed"）。 */
export function growthTierClaimed(redemption: WorkbuddyRedemptionStatus, tier: string): boolean {
  switch (tier) {
    case '7d': return redemption.tier_7d_status === 'claimed'
    case '14d': return redemption.tier_14d_status === 'claimed'
    case '28d': return redemption.tier_28d_status === 'claimed'
    default: return false
  }
}

/**
 * 从连登天数与兑换状态挑出**本日应领的最高档**（对齐源实现"从高到低挑已达标且未领"）：
 * 返回 null 表示没有可领档（全已领 / 全未达标）。
 */
export function pickWorkbuddyRedeemTier(state: WorkbuddyRewardState): string | null {
  for (const tier of WORKBUDDY_GROWTH_TIERS) {
    if (growthTierClaimed(state.redemption, tier)) continue
    const days = state.redemption.tiers?.find((t) => t.tier === tier)?.days
      ?? WORKBUDDY_GROWTH_TIER_DAYS[tier]
    if (state.days >= days) return tier
  }
  return null
}

/**
 * 判定错误消息是否为「本月已领取」幂等态（409 duplicate / 已领取）。正常态，不刷 WARN。
 * 注意 `growthCall` 抛的是 `new Error('http 409 …')` 形态，故按状态码 + 关键词双匹配。
 */
export function isRedeemAlreadyClaimed(errMsg: string): boolean {
  if (!/\bhttp 409\b/.test(errMsg)) return false
  const lower = errMsg.toLowerCase()
  return lower.includes('duplicate') || errMsg.includes('已领取')
}

/** 判定是否为「连续登录天数不足」（403）。正常态（本次连登天数 < 该档门槛）。 */
export function isRedeemNotEnoughDays(errMsg: string): boolean {
  return /\bhttp 403\b/.test(errMsg) && errMsg.includes('连续登录天数不足')
}

/** 判定是否为「无抽奖次数」（400 insufficient lottery chance balance）。正常态。 */
export function isLotteryNoChance(errMsg: string): boolean {
  return /\bhttp 400\b/.test(errMsg) && errMsg.toLowerCase().includes('insufficient lottery chance balance')
}

/** 判定是否为「抽奖未开启」（400 lottery disabled）。正常态。 */
export function isLotteryDisabled(errMsg: string): boolean {
  return /\bhttp 400\b/.test(errMsg) && errMsg.toLowerCase().includes('lottery disabled')
}

/** 组装 growth 请求的可选身份头（与 streak/buddy 系列同口径）。 */
function growthIdentityHeaders(opts?: { uid?: string; enterpriseId?: string; deviceToken?: string }): Record<string, string> {
  const extraHeaders: Record<string, string> = {}
  if (opts?.uid) extraHeaders['X-User-Id'] = opts.uid
  if (opts?.enterpriseId) extraHeaders['X-Enterprise-Id'] = opts.enterpriseId
  if (opts?.deviceToken) extraHeaders['X-Device-Token'] = opts.deviceToken
  return extraHeaders
}

// ===== 连登管家三动作（移植 workbuddy2api 243c7f2 growth_bonus.go）=====
//
// 端点（CN web 成长中心 SPA 逆向，源实现 growth_bonus.go 常量）：
//   GET  /activity/growth/heatmap           → data.cells[]{date,score}（活跃地图热力格，score==0 判漏签）
//   POST /activity/growth/makeup-cards/use  → {"target_date":"YYYY-MM-DD"}（对指定 CST 自然日补签）
//   POST /billing/meter/claim-gift          → 新手礼包（每号一次，重复领返回业务错误）
//   POST /billing/meter/claim-compensation  → 活动补偿（有则领，无则业务错误）
//
// 补签卡余额来自 `GET /activity/growth/streak` 的 `data.makeup_cards{balance,max}` 段
// （与 `fetchWorkbuddyRewardState` 同响应体，源实现也是同一端点只多解析一段）。
//
// 语义（对齐源实现）：补签只在「昨日漏签且有卡」时触发——连续天数一断就要重攒 7 天，
// 一张卡代价远小；礼包/补偿是幂等写（每号一次 / 有则领），业务错误是常态（绝大多数号
// 早已领过），无法与真错误可靠区分，故全部静默。**三者失败都不得影响签到成功语义。**

/** 活跃地图热力格（一日一格，对齐源实现 HeatmapCell）。 */
export interface WorkbuddyHeatmapCell {
  /** `YYYY-MM-DD`（上游可能带时间后缀，比较时只取前 10 位） */
  date: string
  /** 当日活跃计分（0 = 漏签） */
  score: number
}

/** 补签卡余额（streak 响应的 `makeup_cards` 段，对齐源实现 GrowthMakeupCards）。 */
export interface WorkbuddyMakeupCards {
  /** 可用补签卡数 */
  balance: number
  /** 持有上限 */
  max: number
}

/**
 * 读取活跃地图热力格：GET /activity/growth/heatmap。
 * 失败返回 null（只读判据，调用方静默跳过，次日再判）。
 */
export async function fetchWorkbuddyHeatmap(
  token: string,
  realm: 'cn' | 'global',
  opts?: { uid?: string; enterpriseId?: string; deviceToken?: string }
): Promise<WorkbuddyHeatmapCell[] | null> {
  try {
    const data = await growthCall(token, '/activity/growth/heatmap', realm, {
      method: 'GET',
      extraHeaders: growthIdentityHeaders(opts),
    })
    const raw = Array.isArray(data?.cells) ? data.cells : []
    return raw.map((c: any) => ({
      // 只取前 10 位：上游 date 可能带时间后缀（对齐源实现 `c.Date[:10]`）
      date: typeof c?.date === 'string' ? c.date.slice(0, 10) : '',
      score: Number(c?.score) || 0,
    }))
  } catch {
    return null
  }
}

/**
 * 返回 cells 中 `date` 当日的 score；**无该日格**返回 `undefined`。
 *
 * 为什么要区分「无格」与「score 0」：活跃地图未覆盖该日时拿不到漏签判据，
 * 此时**不能**当作漏签去补签（对齐源实现 `HeatmapDayScore` 的 `ok=false` 分支）。
 */
export function heatmapDayScore(cells: WorkbuddyHeatmapCell[], date: string): number | undefined {
  for (const c of cells) {
    if (c.date.length >= 10 && c.date.slice(0, 10) === date) return c.score
  }
  return undefined
}

/**
 * 读取连登天数 + 补签卡余额：GET /activity/growth/streak。
 * 与 `fetchWorkbuddyRewardState` 同端点不同切片（只多解析 `makeup_cards` 段）。
 * 失败返回 null（无卡判据 → 调用方静默跳过）。
 */
export async function fetchWorkbuddyMakeupCards(
  token: string,
  realm: 'cn' | 'global',
  opts?: { uid?: string; enterpriseId?: string; deviceToken?: string }
): Promise<WorkbuddyMakeupCards | null> {
  try {
    const data = await growthCall(token, '/activity/growth/streak', realm, {
      method: 'GET',
      extraHeaders: growthIdentityHeaders(opts),
    })
    return {
      balance: Number(data?.makeup_cards?.balance) || 0,
      max: Number(data?.makeup_cards?.max) || 0,
    }
  } catch {
    return null
  }
}

/**
 * 对指定日期使用补签卡：POST /activity/growth/makeup-cards/use `{"target_date":"YYYY-MM-DD"}`。
 * `targetDate` 必须是**上游 CST 自然日**（见 `cstYesterday`）。
 * 无卡 / 该日无漏签 / 已补过 → 上游业务错误（400），调用方静默跳过。
 */
export async function useMakeupCard(
  token: string,
  realm: 'cn' | 'global',
  targetDate: string,
  opts?: { uid?: string; enterpriseId?: string; deviceToken?: string }
): Promise<void> {
  await growthCall(token, '/activity/growth/makeup-cards/use', realm, {
    method: 'POST',
    body: { target_date: targetDate },
    extraHeaders: growthIdentityHeaders(opts),
  })
}

/** 新手礼包 / 活动补偿路径（对齐源实现 claimGiftPath / claimCompensationPath）。 */
export const CLAIM_GIFT_PATH = '/billing/meter/claim-gift'
export const CLAIM_COMPENSATION_PATH = '/billing/meter/claim-compensation'

/** billing 域领取类结果：`success` 表示上游受理，`credit` 为到账积分（缺失记 0）。 */
export interface WorkbuddyClaimOutcome {
  success: boolean
  credit: number
  message: string
}

/**
 * billing 域领取类公共实现（对齐源实现 `claimBillingCredit`）：POST path → `data.credit`。
 *
 * 走 `billingCall`（billing 域，非 growth 域）——与 `fetchWorkbuddyCredits` 同域同头口径。
 * 源实现用 `billingJSON` + **空对象** `{}` 请求体；本仓 `billingCall` 的 `body` 缺省即 `'{}'`，
 * 故不传 body，保持逐字一致（传 `{}` 会得到同样的 `'{}'`，但缺省更能表达"上游无入参"）。
 *
 * 回执字段缺失**不视为失败**（调用方按 0 记日志，对齐源实现 `_ = json.Unmarshal` 忽略错误）。
 * 业务错误（已领/未开启）是常态，返回 `success: false` 由调用方静默，不抛。
 */
export async function claimWorkbuddyBillingCredit(
  token: string,
  realm: 'cn' | 'global',
  path: string,
  opts?: { uid?: string; enterpriseId?: string; deviceToken?: string }
): Promise<WorkbuddyClaimOutcome> {
  try {
    const data = await billingCall(token, path, realm, { extraHeaders: growthIdentityHeaders(opts) })
    return { success: true, credit: Number(data?.credit) || 0, message: '已领取' }
  } catch (e) {
    return { success: false, credit: 0, message: (e as Error).message || String(e) }
  }
}

/**
 * 领取新手礼包：POST /billing/meter/claim-gift（每号一次）。
 * 已领返回业务错误 → `success: false`，调用方静默跳过。
 */
export async function claimWorkbuddyGift(
  token: string,
  realm: 'cn' | 'global',
  opts?: { uid?: string; enterpriseId?: string; deviceToken?: string }
): Promise<WorkbuddyClaimOutcome> {
  return claimWorkbuddyBillingCredit(token, realm, CLAIM_GIFT_PATH, opts)
}

/**
 * 领取活动补偿：POST /billing/meter/claim-compensation（有则领）。
 * 无可领返回业务错误 → `success: false`，调用方静默跳过。
 */
export async function claimWorkbuddyCompensation(
  token: string,
  realm: 'cn' | 'global',
  opts?: { uid?: string; enterpriseId?: string; deviceToken?: string }
): Promise<WorkbuddyClaimOutcome> {
  return claimWorkbuddyBillingCredit(token, realm, CLAIM_COMPENSATION_PATH, opts)
}

/**
 * 读取连登天数 + 各档兑换状态 + 补签卡余额：GET /activity/growth/streak。
 *
 * 一次 GET 同时给出 `streak.days` / `redemption_status` / `makeup_cards` 三段
 * （对齐源实现 `GrowthRewardState` 与 `GrowthStreakWithCards` 共用同一端点的设计）。
 * 失败返回 null（调用方跳过本轮，不改变签到语义）。
 */
export async function fetchWorkbuddyRewardState(
  token: string,
  realm: 'cn' | 'global',
  opts?: { uid?: string; enterpriseId?: string; deviceToken?: string }
): Promise<WorkbuddyRewardState | null> {
  try {
    const data = await growthCall(token, '/activity/growth/streak', realm, {
      method: 'GET',
      extraHeaders: growthIdentityHeaders(opts),
    })
    if (!data || typeof data !== 'object') return null
    const days = typeof data?.streak?.days === 'number' ? data.streak.days : 0
    const redemption = (data?.redemption_status && typeof data.redemption_status === 'object')
      ? data.redemption_status as WorkbuddyRedemptionStatus
      : {}
    const cards = data?.makeup_cards
    const makeupCards = (cards && typeof cards === 'object')
      ? { balance: Number(cards.balance) || 0, max: Number(cards.max) || 0 }
      : undefined
    return { days, redemption, makeupCards }
  } catch {
    return null
  }
}

/** 兑换结果（含正常态区分，供调用方静默处理）。 */
export interface WorkbuddyRedeemOutcome {
  /** 是否兑换成功 */
  success: boolean
  /** 正常态（本月已领 / 天数不足）：静默跳过，不算失败 */
  normal?: 'already_claimed' | 'not_enough_days'
  result?: WorkbuddyRedeemResult
  message: string
}

/**
 * 兑换指定档位连登奖励：POST /activity/growth/redeem。
 *
 * `client_token` **每次调用新生成**（对齐源实现注释）：复用旧键会被上游幂等去重吞掉本次领取。
 */
export async function redeemWorkbuddyGrowth(
  token: string,
  realm: 'cn' | 'global',
  tier: string,
  opts?: { uid?: string; enterpriseId?: string; deviceToken?: string; clientToken?: string }
): Promise<WorkbuddyRedeemOutcome> {
  const clientToken = opts?.clientToken || growthClientToken(`redeem-${tier}`)
  try {
    const data = await growthCall(token, '/activity/growth/redeem', realm, {
      method: 'POST',
      body: { tier, client_token: clientToken },
      extraHeaders: growthIdentityHeaders(opts),
    })
    return {
      success: true,
      result: {
        cards_granted: Number(data?.cards_granted) || 0,
        cards_overflow: Number(data?.cards_overflow) || 0,
        credit_granted: Number(data?.credit_granted) || 0,
        energy_granted: Number(data?.energy_granted) || 0,
        chances_granted: Number(data?.chances_granted) || 0,
      },
      message: `已兑换 ${tier} 连登奖励`,
    }
  } catch (e) {
    const msg = (e as Error).message || String(e)
    if (isRedeemAlreadyClaimed(msg)) return { success: false, normal: 'already_claimed', message: `${tier} 本月已领取` }
    if (isRedeemNotEnoughDays(msg)) return { success: false, normal: 'not_enough_days', message: `${tier} 连登天数不足` }
    return { success: false, message: `兑换失败: ${msg}` }
  }
}

/** 查询抽奖次数余额：GET /activity/growth/lottery/chances（0 = 无次数，正常态）。 */
export async function fetchWorkbuddyLotteryChances(
  token: string,
  realm: 'cn' | 'global',
  opts?: { uid?: string; enterpriseId?: string; deviceToken?: string }
): Promise<number | null> {
  try {
    const data = await growthCall(token, '/activity/growth/lottery/chances', realm, {
      method: 'GET',
      extraHeaders: growthIdentityHeaders(opts),
    })
    return typeof data?.balance === 'number' ? data.balance : 0
  } catch {
    return null
  }
}

/** 抽奖结果（含正常态区分）。 */
export interface WorkbuddyLotteryOutcome {
  success: boolean
  /** 正常态（无次数 / 抽奖未开启）：静默跳过，不算失败 */
  normal?: 'no_chance' | 'disabled'
  result?: WorkbuddyLotteryDrawResult
  message: string
}

/**
 * 抽一次奖：POST /activity/growth/lottery/draw。
 *
 * `client_token` 每次新生成（SPA `doDraw` 每次用新键）：抽奖对幂等键敏感，复用旧键会被吞掉。
 */
export async function drawWorkbuddyLottery(
  token: string,
  realm: 'cn' | 'global',
  opts?: { uid?: string; enterpriseId?: string; deviceToken?: string; clientToken?: string }
): Promise<WorkbuddyLotteryOutcome> {
  const clientToken = opts?.clientToken || growthClientToken('draw')
  try {
    const data = await growthCall(token, '/activity/growth/lottery/draw', realm, {
      method: 'POST',
      body: { client_token: clientToken },
      extraHeaders: growthIdentityHeaders(opts),
    })
    return {
      success: true,
      result: {
        prize_code: String(data?.prize_code || ''),
        prize_name: String(data?.prize_name || ''),
        prize_type: String(data?.prize_type || ''),
        credit_amount: Number(data?.credit_amount) || 0,
      },
      message: `抽奖获得: ${String(data?.prize_name || '未知奖品')}`,
    }
  } catch (e) {
    const msg = (e as Error).message || String(e)
    if (isLotteryNoChance(msg)) return { success: false, normal: 'no_chance', message: '无抽奖次数' }
    if (isLotteryDisabled(msg)) return { success: false, normal: 'disabled', message: '抽奖未开启' }
    return { success: false, message: `抽奖失败: ${msg}` }
  }
}

/**
 * 连登奖励**按天幂等闸** KV 前缀（`providerId:uid` → CST 日期）。
 *
 * 为什么需要：源实现用进程内存 Map（`rewardClaimed[uid] = 当日`）保证"每日每号最多领一轮"，
 * 重启清零靠上游 409 兜底。Workers 多 isolate 无共享内存，**必须用 KV**，否则同一账号
 * 会被不同 isolate 同时领奖（上游 409 能兜住，但会产生无意义的重复请求）。
 * 语义与 `ADOPT_TRIED_KV_PREFIX` 同构。
 */
export const REDEEM_TRIED_KV_PREFIX = 'workbuddy:redeem-tried:'

/** 该账号今日是否已领过连登奖励。 */
export async function redeemTriedToday(env: Env, providerId: string, uid: string, from?: number): Promise<boolean> {
  try {
    const raw = await env.KV.get(`${REDEEM_TRIED_KV_PREFIX}${providerId}:${uid}`)
    return raw === cstDay(from)
  } catch {
    return false // KV 不可读时不抑制（宁可多试一次，也不漏领）
  }
}

/** 记录该账号今日已领连登奖励（TTL 2 天，跨日自动失效）。 */
export async function markRedeemTried(env: Env, providerId: string, uid: string, from?: number): Promise<void> {
  try {
    await env.KV.put(`${REDEEM_TRIED_KV_PREFIX}${providerId}:${uid}`, cstDay(from), { expirationTtl: 2 * 24 * 60 * 60 })
  } catch { /* KV 写失败不阻断主流程（退化为无防抖，靠上游 409 兜底） */ }
}

/** 一趟连登奖励 + 抽奖的执行结果（供 CheckinResult 展示）。 */
export interface WorkbuddyRewardRunResult {
  /** 是否实际做了动作（无动作时调用方不展示该字段） */
  acted: boolean
  /** 兑换档位（未兑换则无） */
  tier?: string
  /** 兑换到的积分 */
  credit?: number
  /** 兑换到的抽奖次数 */
  chances?: number
  /** 抽奖获得的奖品名 */
  prize?: string
  /** 抽奖获得的积分 */
  prizeCredit?: number
  /** 新手礼包到账积分（未领到则不设） */
  giftCredit?: number
  /** 活动补偿到账积分（未领到则不设） */
  compensationCredit?: number
  /** 补签成功的目标日（CST `YYYY-MM-DD`，未补签则不设） */
  makeupDate?: string
  message: string
}

/**
 * 执行一趟「连登奖励兑换 + 连登抽奖」（对齐 workbuddy2api scheduler.runActivity 的末段）。
 *
 * 流程：
 *  0. **礼包 / 活动补偿**（移植 243c7f2）：幂等写，业务错误静默，先于 redeem；
 *  0.5 **补签保连登**（移植 243c7f2）：昨日漏签且有卡才补，补成功则重读 state 吃恢复后天数；
 *  1. **按天幂等闸**：本 isolate 已领过（KV 记了当日）→ 直接跳过，不打扰上游；
 *  2. 读 streak + 各档状态 → 挑最高可领档 → redeem；
 *  3. 兑换成功 → 记当日已领（KV）→ 领到的 chances 用来 draw（有次数才抽）。
 *
 * 正常态静默（对齐源实现）：409 已领 / 403 天数不足 / 400 无次数 / 400 抽奖未开启
 * 都不算失败，不刷 WARN、不改变 `base.success`。三个新动作同样**各自独立 try/catch**，
 * 失败只落 `message`，绝不冒泡污染签到结果。
 *
 * **global 门控**：调用方**不应**对 global realm 调用本函数——实测 global 新号
 * `GET /activity/growth/streak` 返回 500，证据不足以证明 redeem/draw 在 global 可用，
 * 故整链跳过（与既有"global 无签到/无猫猫旅行"的 D4 门控一致）。函数内也做一次防御性
 * 检查，避免误用。
 */
export async function runWorkbuddyGrowthRewards(
  token: string,
  realm: 'cn' | 'global',
  uid: string,
  opts?: {
    enterpriseId?: string
    deviceToken?: string
    env?: Env
    providerId?: string
    /** 注入"当前时刻"供测试（幂等闸按 CST 自然日） */
    now?: number
    /**
     * 调用方**已读过**的奖励状态（`fetchWorkbuddyRewardState` 的结果）。
     *
     * 为什么需要：签到路径本来就要读一次 `/activity/growth/streak` 回填连登天数展示，
     * 若本函数再读一次就是**同一端点一次签到打两遍**。源实现 `GrowthRewardState` 明确
     * 设计为"一次 GET 读完（days + redemption_status），免二次请求"，故这里允许复用。
     * 传 null 表示"调用方读过但失败了"——本函数仍会自行重试一次（保持独立调用语义）。
     */
    state?: WorkbuddyRewardState | null
  }
): Promise<WorkbuddyRewardRunResult> {
  if (realm === 'global') {
    return { acted: false, message: 'global 无连登奖励体系（门控跳过）' }
  }
  if (!uid) return { acted: false, message: 'uid 缺失，跳过' }

  // 按天幂等闸（KV）：今日已领过则整链跳过
  const canDebounce = !!opts?.env && !!opts?.providerId
  if (canDebounce && await redeemTriedToday(opts!.env!, opts!.providerId!, uid, opts?.now)) {
    return { acted: false, message: '今日已领连登奖励（防抖跳过）' }
  }

  const identity = { uid, enterpriseId: opts?.enterpriseId, deviceToken: opts?.deviceToken }

  // 0. 礼包 / 活动补偿领取（移植 workbuddy2api 243c7f2 claimGrowthBonus）：
  //    两者都是幂等写（礼包每号一次 / 补偿有则领），**先于 redeem**——到账积分不依赖连登状态。
  //    业务错误是常态（绝大多数号早已领过），无法与真错误可靠区分，故失败静默；
  //    两个函数内部各自 try/catch，**任何失败都不会冒泡污染 base.success**。
  const gift = await claimWorkbuddyGift(token, realm, identity)
  const compensation = await claimWorkbuddyCompensation(token, realm, identity)
  const bonusParts: string[] = []
  if (gift.success && gift.credit > 0) bonusParts.push(`新手礼包 +${gift.credit} 积分`)
  if (compensation.success && compensation.credit > 0) bonusParts.push(`活动补偿 +${compensation.credit} 积分`)

  // 补签成功时用恢复后的状态重新挑档（见下），故 state 必须是可重绑定的
  let state = opts?.state ?? await fetchWorkbuddyRewardState(token, realm, identity)
  if (!state) return { acted: false, message: '无法获取连登奖励状态' }

  // 0.5 补签保连登（移植 workbuddy2api 243c7f2 makeupYesterday）：昨日漏签且**有卡**才补。
  //     放在 reward-state 读取**之后**：补签把连登恢复到 7d/14d/28d 时，重读 state 让本日
  //     redeem 直接吃到恢复后的天数（补签是保里程碑的关键）。失败静默返回 null。
  //     cards 复用上面 state 里同响应体的 makeup_cards 段，不再单独 GET streak
  //     （state 是调用方传入或刚读过，两种来源都已带该段）。
  const makeupDate = await makeupWorkbuddyYesterday(token, realm, {
    ...identity,
    now: opts?.now,
    cards: state.makeupCards ?? null,
  })
  if (makeupDate) {
    const recovered = await fetchWorkbuddyRewardState(token, realm, identity)
    if (recovered) state = recovered // 重读失败则沿用旧 state（不误判、不中断）
  }

  const tier = pickWorkbuddyRedeemTier(state)
  if (!tier) {
    // 无档可领：但礼包/补偿/补签若真的到账/生效，本身就是本日的动作，不应被吞掉
    // （源实现对应位置有独立日志行 `gift ok (+N credit)` / `makeup ok ...`）。
    if (bonusParts.length === 0 && !makeupDate) {
      return { acted: false, message: `无可领档位（连登 ${state.days} 天）` }
    }
    const idleParts = [...bonusParts]
    if (makeupDate) idleParts.push(`补签 ${makeupDate}（保住连登）`)
    idleParts.push(`无可领档位（连登 ${state.days} 天）`)
    return {
      acted: true,
      giftCredit: gift.success && gift.credit > 0 ? gift.credit : undefined,
      compensationCredit: compensation.success && compensation.credit > 0 ? compensation.credit : undefined,
      makeupDate: makeupDate || undefined,
      message: idleParts.join('，'),
    }
  }

  const redeem = await redeemWorkbuddyGrowth(token, realm, tier, {
    uid,
    enterpriseId: opts?.enterpriseId,
    deviceToken: opts?.deviceToken,
  })
  if (!redeem.success) {
    // 天数不足是"上游说未达标"——记当日已试避免同日反复探测（与领养防抖同口径）
    if (redeem.normal === 'not_enough_days' && canDebounce) {
      await markRedeemTried(opts!.env!, opts!.providerId!, uid, opts?.now)
    }
    return { acted: false, message: redeem.message }
  }

  if (canDebounce) await markRedeemTried(opts!.env!, opts!.providerId!, uid, opts?.now)

  const credit = redeem.result?.credit_granted || 0
  const chances = redeem.result?.chances_granted || 0
  const parts = [...bonusParts]
  if (makeupDate) parts.push(`补签 ${makeupDate}（保住连登）`)
  parts.push(`已兑换 ${tier} 连登奖励`)
  if (credit > 0) parts.push(`+${credit} 积分`)
  if (chances > 0) parts.push(`+${chances} 抽奖次数`)

  // 有抽奖次数才抽（chances 也可能来自历史结余，故再查一次余额）
  let prize: string | undefined
  let prizeCredit: number | undefined
  const balance = chances > 0 ? chances : await fetchWorkbuddyLotteryChances(token, realm, {
    uid, enterpriseId: opts?.enterpriseId, deviceToken: opts?.deviceToken,
  })
  if (typeof balance === 'number' && balance > 0) {
    const draw = await drawWorkbuddyLottery(token, realm, {
      uid, enterpriseId: opts?.enterpriseId, deviceToken: opts?.deviceToken,
    })
    if (draw.success && draw.result) {
      prize = draw.result.prize_name || undefined
      prizeCredit = draw.result.credit_amount || undefined
      if (prize) parts.push(`抽奖: ${prize}`)
      if (prizeCredit && prizeCredit > 0) parts.push(`+${prizeCredit} 积分`)
    } else if (!draw.normal) {
      // 非正常态失败（网络/未知错误）也记入消息，便于面板定位
      parts.push(draw.message)
    }
  }

  return {
    acted: true,
    tier,
    credit,
    chances,
    prize,
    prizeCredit,
    giftCredit: gift.success && gift.credit > 0 ? gift.credit : undefined,
    compensationCredit: compensation.success && compensation.credit > 0 ? compensation.credit : undefined,
    makeupDate: makeupDate || undefined,
    message: parts.join('，'),
  }
}

/**
 * 昨日漏签且有补签卡时自动补签（移植 workbuddy2api 243c7f2 `makeupYesterday`）。
 *
 * 判据链（任一步不成立即静默返回 null，不写上游、不影响主流程）：
 *   1. `GET /activity/growth/heatmap` 里**昨日**格 `score === 0`（漏签；无该日格 = 无判据）；
 *   2. 补签卡余额 `> 0`（有卡）；
 *   3. `POST /activity/growth/makeup-cards/use {"target_date": 昨日}`。
 *
 * 补签成功返回昨日（CST `YYYY-MM-DD`），调用方据此重读 state 挑档；
 * 无卡 / 无漏签 / 无该日格 / 查询失败 / 上游业务错误（400）均返回 null。
 *
 * `opts.cards`：调用方**已读过**的补签卡余额（来自 `WorkbuddyRewardState.makeupCards`，
 * 与 streak 同响应体）。传入时**不再单独 GET streak**——源实现同样复用同一次读取。
 * 不传（或传 undefined）则自行读一次 `fetchWorkbuddyMakeupCards`，保持独立调用语义。
 * 显式传 `null` 表示"调用方读过但上游没给该段" → 视为无卡判据，直接返回 null。
 *
 * `opts.now` 注入"当前时刻"供测试；**昨日固定用 `cstYesterday(now)`**，
 * 不可用本地日期减一天（Workers 本地时区 = UTC，CST 00:00–08:00 会错一整天）。
 */
export async function makeupWorkbuddyYesterday(
  token: string,
  realm: 'cn' | 'global',
  opts?: {
    uid?: string
    enterpriseId?: string
    deviceToken?: string
    now?: number
    /** 已读到的补签卡余额（来自 reward state 同响应体）；null = 上游未给该段 */
    cards?: WorkbuddyMakeupCards | null
  }
): Promise<string | null> {
  try {
    const cells = await fetchWorkbuddyHeatmap(token, realm, opts)
    if (!cells) return null // 只读判据失败：静默（次日再判，无写风险）
    const yesterday = cstYesterday(opts?.now)
    const score = heatmapDayScore(cells, yesterday)
    if (score === undefined || score !== 0) return null // 昨日有分或无判据：无需补签

    // 有漏签 → 取补签卡余额：优先用调用方已读到的（同响应体，免二次请求）
    const cards = opts?.cards !== undefined
      ? opts.cards
      : await fetchWorkbuddyMakeupCards(token, realm, opts)
    if (!cards || cards.balance <= 0) return null // 无卡或查询失败：静默（次日再判）

    await useMakeupCard(token, realm, yesterday, opts)
    return yesterday
  } catch {
    // 上游业务错误（无卡/无漏签/已补过）是常态，静默返回 null
    return null
  }
}

/**
 * 推进一趟猫猫旅行状态机（对齐 workbuddy2api travel.go travelOne）： * 1. 查有无猫：无猫 → 同意协议 + 领养第一只猫（+300 分）；
 * 2. 有猫 → 查旅行状态：
 *    - arrived (到站) → 领奖 claim（带回 reward_credit 积分）
 *    - idle (空闲且未达当日上限) → 派出 depart（古镇客栈 location_id=4）
 *    - traveling (在途) → 保持在途
 *
 * opts.env / opts.providerId：提供时启用**领养当日防抖**（对齐源实现 adoptTriedToday）——
 * 门槛未达（`first_buddy task not completed yet`）记一次当日已试，同日后续巡检直接跳过领养，
 * 避免对上游重试轰炸。缺省不启用（保持既有调用方行为）。
 * opts.forceAdopt：豁免当日防抖（对齐源实现 travelAdoptForce）——活跃上报把对话量
 * 补满后是"门槛刚达成"的新状态，应就地闭环而非等下一轮。
 */
export async function runWorkbuddyCatTravel(
  token: string,
  realm: 'cn' | 'global',
  uid: string,
  opts?: {
    enterpriseId?: string
    deviceToken?: string
    env?: Env
    providerId?: string
    forceAdopt?: boolean
    /** 注入"当前时刻"供测试（防抖按 CST 自然日） */
    now?: number
  }
): Promise<{ state: string; reward?: number; message: string; buddyName?: string }> {
  try {
    const buddy = await fetchWorkbuddyBuddyInfo(token, realm, { uid, ...opts })
    if (!buddy) {
      // 领养当日防抖：门槛未达时同日不重试（forceAdopt 豁免）
      const canDebounce = !!opts?.env && !!opts?.providerId
      if (canDebounce && !opts?.forceAdopt) {
        if (await adoptTriedToday(opts!.env!, opts!.providerId!, uid, opts?.now)) {
          return { state: 'adopt_deferred', message: '今日领养门槛未达，已跳过（防抖）' }
        }
      }
      // 尝试同意协议 + 领养
      try { await agreeWorkbuddyBuddyAgreement(token, realm, { uid, ...opts }) } catch { /* ignore */ }
      const adoptRes = await adoptWorkbuddyFirstBuddy(token, realm, { uid, ...opts })
      if (adoptRes.success) {
        return { state: 'adopted', reward: 300, message: '领养成功 (+300 积分)', buddyName: '首只猫猫' }
      }
      // 门槛未达 → 记当日已试（仅该原因才防抖；其他失败下轮可重试）
      if (canDebounce && adoptRes.message.includes('门槛未达标')) {
        await markAdoptTried(opts!.env!, opts!.providerId!, uid, opts?.now)
      }
      return { state: 'no_buddy', message: adoptRes.message }
    }

    const ts = await fetchWorkbuddyTravelStatus(token, realm, { uid, ...opts })
    if (!ts) {
      return { state: 'unknown', message: '无法获取旅行状态', buddyName: buddy.name }
    }

    if (ts.state === 'arrived' && ts.record_id) {
      const reward = await claimWorkbuddyTravelReward(token, realm, ts.record_id, { uid, ...opts })
      return { state: 'claimed', reward, message: `到站领奖成功 (+${reward} 积分)`, buddyName: buddy.name }
    }

    if (ts.state === 'idle') {
      if (ts.daily_limit_reached) {
        return { state: 'idle_limit', message: '今日旅行已达上限', buddyName: buddy.name }
      }
      await departWorkbuddyTravel(token, realm, 4, { uid, ...opts })
      return { state: 'departed', message: '猫猫已出发旅行（古镇客栈）', buddyName: buddy.name }
    }

    if (ts.state === 'traveling') {
      return { state: 'traveling', message: '猫猫正在旅途中', buddyName: buddy.name }
    }

    return { state: ts.state, message: `当前状态: ${ts.state}`, buddyName: buddy.name }
  } catch (err) {
    return { state: 'error', message: (err as Error).message || String(err) }
  }
}

