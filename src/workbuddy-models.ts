/**
 * workbuddy-models.ts — WorkBuddy/CodeBuddy **模型目录探测**的唯一 owner。
 *
 * 移植 workbuddy2api `0adc345`（v3-config-merge）：官方客户端的模型目录是**两级取数**，
 * 只探企业端点会丢掉 `/v3/config` 独有的模型。本模块把「主路 `/v3/config` + 补缺路企业端点」
 * 的并发并集探测收敛到一处，供管理后台「获取模型」与 `/v1/models` 元数据**共用同一口径**
 * （此前两处各自实现，已出现口径分叉）。
 *
 * 为什么独立成文件而非塞进 admin.ts / proxy.ts：那两个文件已分别是 2900+ / 4800+ 行的
 * 混合职责文件；本模块是**新的职责**（目录探测与合并），按"新职责新建 owner"处理。
 *
 * 跨平台约束（Go 长驻服务 → Cloudflare Workers）：
 *  - Go 的 `goroutine + channel` → `Promise.all`（Workers 并发子请求受限，两路安全）；
 *  - Go 的实例字段缓存 → 模块级 `Map` + TTL / 负缓存（多 isolate 无共享内存）。
 */

import type { Env, OAuthDeviceConfig, Provider } from './types'
import { buildOauthHeaders, readOauthToken } from './oauth'
import {
  WORKBUDDY_CN_MODELS_PATH,
  WORKBUDDY_GLOBAL_MODELS_PROBE_PATHS,
  WORKBUDDY_V3_CONFIG_PATH,
  injectWorkbuddyChatHeaders,
  mergeWorkbuddyModelCatalogs,
  parseWorkbuddyGlobalModels,
  type WorkbuddyGlobalModelEntry,
} from './workbuddy-upstream'

// ===== 静态兜底清单 =====
//
// 定位（与上游 workbuddy2api `1b7ce4a` 的取舍不同）：workbuddy2api 是**面向客户端的代理**，
// `/v1/models` 空列表是"上游没给"的诚实表达。本仓这条链路服务于**管理后台的「获取模型」按钮**
// ——用户主动点击、期待拿到可勾选清单的交互；返回空列表等同于功能损坏。故**保留静态兜底**，
// 但降级为"仅动态失败时使用"，并在响应里标注 `stale: true`（见 WorkbuddyModelCatalogResult）。

/**
 * WorkBuddy/CodeBuddy 国内版（CN）静态候选模型。
 *
 * P1 修正：原清单（`glm-4.5/glm-4.6/glm-4.7/deepseek-v3/deepseek-r1/hunyuan-lite/
 * hunyuan-turbo/kimi-k2/qwen-3/doubao-1.5-pro`）是**上一代模型名**，与上游 CN 侧实际下发的
 * 清单**几乎完全不相交**。用户据此入库后每次调用都撞 `11102`（该后端无此模型）——这不是
 * "兜底不完美"，而是主动误导。现清单对齐上游 `1b7ce4a` 删除前的 `staticModels`（CN 实测世代）。
 */
export const WORKBUDDY_MODELS: string[] = [
  'glm-5.2',
  'glm-5.1',
  'glm-5v-turbo',
  'kimi-k2.7',
  'minimax-m3',
  'hy3',
  'hy3-preview',
  'hy3-preview-agent',
  'deepseek-v4-pro',
  'deepseek-v4-flash',
]

/** WorkBuddy 国际版（workbuddy.ai）静态候选模型：对齐 LazyChara/WkBdy2api `wb_v3config.public.json`
 *  中 `/v3/config` 载荷的 `cli` agent 白名单（顺序保持）。国际版模型集与国内版完全不同。
 *
 *  P1 修正：补入上游 21 名单里本仓缺失的 `hy4-preview`（原有 `hy4-preview-f` 之外）。 */
export const WORKBUDDY_GLOBAL_MODELS: string[] = [
  'default-model',
  'fast-model',
  'balanced-model',
  'primary-model',
  'deep-model',
  'hy4-preview',
  'hy4-preview-f',
  'hy3',
  'deepseek-v4.1-flash',
  'gpt-6-astra',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.3-codex',
  'gemini-3.5-flash',
  'glm-5.3',
  'glm-5.2',
  'kimi-k3',
  'kimi-k2.6',
]

// ===== 探测缓存 =====

interface CatalogCacheEntry {
  entries: WorkbuddyGlobalModelEntry[]
  stale: boolean
  warnings: string[]
  at: number
  ok: boolean
}

/** 探测结果缓存：`${providerId}:${realm}` → 目录。成功 1h，失败 5min 负缓存。 */
const catalogCache = new Map<string, CatalogCacheEntry>()
const CATALOG_TTL_MS = 60 * 60 * 1000
const CATALOG_FAIL_MS = 5 * 60 * 1000
/** 单路探测超时（与既有 global 探测一致）。 */
const PROBE_TIMEOUT_MS = 10000

/** 供测试清空目录探测缓存。 */
export function __resetWorkbuddyCatalogCacheForTests(): void {
  catalogCache.clear()
}

/** 探测结果。 */
export interface WorkbuddyModelCatalogResult {
  /** 合并后的模型条目（动态成功 = 动态结果；动态失败 = 静态兜底） */
  entries: WorkbuddyGlobalModelEntry[]
  /** 是否**回落静态兜底**（两路动态全失败）。前端可据此提示"清单可能过期"。 */
  stale: boolean
  /** 各路降级诊断（便于后台解释为什么 stale / 为什么少了某路） */
  warnings: string[]
}

/** 单路探测结果。 */
interface ProbeOutcome {
  entries: WorkbuddyGlobalModelEntry[] | null
  warning?: string
}

/**
 * 探测单个端点。返回 `entries` 为 null 表示该路不可用（非 2xx / 解析失败 / 空名单）。
 *
 * `filterNonChat`：`/v3/config` 返回全量 models（含图片/补全模型），必须过滤——
 * 否则用户勾选到 `nes-*` 之类条目会撞 `11106/11102`。
 */
async function probeOneEndpoint(
  url: string,
  headers: Record<string, string>,
  label: string,
  filterNonChat: boolean,
): Promise<ProbeOutcome> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (!response.ok) {
      return { entries: null, warning: `${label} HTTP ${response.status}` }
    }
    const entries = parseWorkbuddyGlobalModels(await response.text(), { filterNonChat })
    if (!entries || entries.length === 0) {
      return { entries: null, warning: `${label} 解析为空名单` }
    }
    return { entries }
  } catch (err) {
    return { entries: null, warning: `${label} ${(err as Error)?.message || '请求异常'}` }
  }
}

/** 拼出某路的绝对 URL：配置里给了绝对 URL 就用它，否则 base + 路径。 */
function resolveProbeUrl(configured: string | undefined, base: string, path: string): string {
  const cfgUrl = (configured || '').trim()
  if (cfgUrl !== '') return cfgUrl
  return `${base.replace(/\/$/, '')}${path}`
}

/**
 * 探测 WorkBuddy 模型目录（CN/global 对称）：
 *  主路 `/v3/config`（全量，需 nonChat 过滤）+ 补缺路企业端点家族（CN `/console/...`；
 *  global `/v2/...` → `/console/...` 依次探活）**并发**探测后并集合并。
 *
 * 合并口径（对齐上游 `mergeGlobalCatalog`）：去重 key = id，**主路条目字段权威**
 * （credits 以 v3 为准），补缺路只补主路缺失的 id，输出顺序稳定。
 *
 * 容错（对齐上游）：单路失败 → 降级为另一路 + `warnings`；两路全失败 → 回落静态兜底并
 * 标记 `stale: true`（**不返回空列表**——本仓该链路服务管理后台可勾选清单）。
 *
 * 缓存：成功 1h / 失败 5min 负缓存，按 `providerId:realm` 分桶（CN 与 global 不互相污染）。
 */
export async function probeWorkbuddyModelCatalog(
  env: Env,
  provider: Provider,
  realm: 'cn' | 'global',
  token: string,
  cookies?: string,
): Promise<WorkbuddyModelCatalogResult> {
  const cfg = provider.oauth as OAuthDeviceConfig
  const cacheKey = `${provider.id}:${realm}`
  const now = Date.now()
  const cached = catalogCache.get(cacheKey)
  if (cached) {
    const freshWindow = cached.ok ? CATALOG_TTL_MS : CATALOG_FAIL_MS
    if (now - cached.at < freshWindow) {
      return { entries: cached.entries, stale: cached.stale, warnings: cached.warnings }
    }
  }

  const tokenState = await readOauthToken(env, provider.id).catch(() => null)
  const accountTokenState = tokenState
    ? {
        uid: tokenState.uid,
        enterprise_id: tokenState.enterprise_id,
        domain: tokenState.domain,
        device_token: tokenState.device_token,
      }
    : undefined

  const buildHeaders = (origin: string | undefined) => {
    const headers = buildOauthHeaders(cfg, token, {
      origin,
      apiType: provider.apiType,
      cookies,
    })
    injectWorkbuddyChatHeaders(headers, token, realm, accountTokenState, cfg, { chatPath: false })
    return headers
  }

  const isGlobal = realm === 'global'
  const base = isGlobal && cfg.globalBaseUrl ? cfg.globalBaseUrl : provider.baseUrl
  const origin = isGlobal ? cfg.globalOrigin : (cfg.extraHeaders?.Origin as string | undefined)

  // 主路：/v3/config（全量 → 必须 nonChat 过滤）
  const v3Url = resolveProbeUrl(undefined, base, WORKBUDDY_V3_CONFIG_PATH)
  // 补缺路：企业端点。CN 单路径；global 走家族（/v2 → /console 依次探活）。
  const enterpriseConfigured = isGlobal ? cfg.globalModelsUrl : cfg.modelsUrl
  const enterprisePaths = isGlobal ? WORKBUDDY_GLOBAL_MODELS_PROBE_PATHS : [WORKBUDDY_CN_MODELS_PATH]

  const enterpriseProbe = async (): Promise<ProbeOutcome> => {
    // 配置了绝对 URL → 只试它（用户显式指定优先）；否则按家族依次探活。
    if ((enterpriseConfigured || '').trim() !== '') {
      return probeOneEndpoint(enterpriseConfigured!.trim(), buildHeaders(origin), '企业端点', false)
    }
    let lastWarning = '企业端点 未探活'
    for (const path of enterprisePaths) {
      const out = await probeOneEndpoint(
        `${base.replace(/\/$/, '')}${path}`,
        buildHeaders(origin),
        `企业端点 ${path}`,
        false,
      )
      if (out.entries) return out
      lastWarning = out.warning || lastWarning
    }
    return { entries: null, warning: lastWarning }
  }

  // 并发两路（对齐上游 goroutine + channel → Promise.all）
  const [v3, enterprise] = await Promise.all([
    probeOneEndpoint(v3Url, buildHeaders(origin), 'v3/config', true),
    enterpriseProbe(),
  ])

  const warnings: string[] = []
  if (v3.warning) warnings.push(v3.warning)
  if (enterprise.warning) warnings.push(enterprise.warning)

  let entries: WorkbuddyGlobalModelEntry[] = []
  let stale = false
  if (v3.entries && enterprise.entries) {
    entries = mergeWorkbuddyModelCatalogs(v3.entries, enterprise.entries)
  } else if (v3.entries) {
    entries = v3.entries
  } else if (enterprise.entries) {
    entries = enterprise.entries
  } else {
    // 两路全失败 → 静态兜底（**不返回空列表**），并标注 stale
    stale = true
    const fallback = isGlobal ? WORKBUDDY_GLOBAL_MODELS : WORKBUDDY_MODELS
    entries = fallback.map((id) => ({ id }))
  }

  const result: WorkbuddyModelCatalogResult = { entries, stale, warnings }
  catalogCache.set(cacheKey, { ...result, at: now, ok: !stale })
  return result
}

/**
 * 同步读取**已缓存**的探测结果（不触发网络）。未探测过 / 缓存过期 → null。
 *
 * 用途（P2-1）：转发路径需要在**同步**上下文里拿模型的 reasoning 档位来做 effort 降级，
 * 而探测是异步且不该在每次转发时都打上游。故由 `/v1/models` 与管理后台的探测把结果写进
 * 缓存，转发路径只读缓存（读不到就退回"仅运营者手填 effortPolicy"的既有行为，零回归）。
 */
export function getCachedWorkbuddyCatalog(
  providerId: string,
  realm: 'cn' | 'global',
): WorkbuddyModelCatalogResult | null {
  const cached = catalogCache.get(`${providerId}:${realm}`)
  if (!cached) return null
  const freshWindow = cached.ok ? CATALOG_TTL_MS : CATALOG_FAIL_MS
  if (Date.now() - cached.at >= freshWindow) return null
  return { entries: cached.entries, stale: cached.stale, warnings: cached.warnings }
}

/**
 * 从缓存里取某模型的 reasoning 档位桶（P2-1：探测结果自动填充 effort 能力桶）。
 *
 * 返回 null 表示缓存里没有该模型的档位信息——调用方应退回运营者手填的 `effortPolicy`。
 * **不返回空数组**：空数组与"没有信息"语义不同（前者会明确表达"该模型无可用档位"）。
 */
export function getCachedWorkbuddyEfforts(
  providerId: string,
  realm: 'cn' | 'global',
  model: string,
): string[] | null {
  const cached = getCachedWorkbuddyCatalog(providerId, realm)
  if (!cached || cached.stale) return null
  for (const e of cached.entries) {
    if (e.id === model) {
      return e.supportedEfforts && e.supportedEfforts.length > 0 ? e.supportedEfforts : null
    }
  }
  return null
}

/**
 * 便捷入口：按 provider 当前 token 的 realm 自动选域探测。
 *
 * 无 token / 非 WorkBuddy → 返回静态兜底并标记 `stale`（调用方无需区分"没连账号"与
 * "探测失败"：两者对用户的含义都是"这份清单可能不是最新的"）。
 */
export async function probeWorkbuddyModelCatalogForProvider(
  env: Env,
  provider: Provider,
  realm: 'cn' | 'global',
): Promise<WorkbuddyModelCatalogResult> {
  // 延迟 import 避免与 oauth.ts 的顶层依赖形成环
  const { getOauthAccessToken } = await import('./oauth')
  const cfg = provider.oauth as OAuthDeviceConfig
  let token: string | null = null
  try {
    token = await getOauthAccessToken(env, provider.id, cfg)
  } catch {
    token = null
  }
  if (!token) {
    const fallback = realm === 'global' ? WORKBUDDY_GLOBAL_MODELS : WORKBUDDY_MODELS
    return {
      entries: fallback.map((id) => ({ id })),
      stale: true,
      warnings: ['无可用 OAuth token，返回静态兜底清单'],
    }
  }
  return probeWorkbuddyModelCatalog(env, provider, realm, token)
}
