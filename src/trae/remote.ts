/**
 * remote.ts — TRAE **Remote** 传输客户端。
 * 移植自 Trae2api-cn `src/trae_remote_client.py`（1172 行 Python）。
 *
 * ## 与 SOLO / Work 的区别（为什么这是新增一条传输，不是改开关）
 *
 * | | SOLO（`llm_utils_chat`） | Work（`create_agent_task`） | **Remote** |
 * |---|---|---|---|
 * | 往返 | 1 次 POST，响应即 SSE | 1 次 POST，响应即 SSE | **2 步**：POST 建会话 → GET 读事件 |
 * | 会话 | 无状态 | 每次新建 | **服务端持有 session**，可 `stop` |
 * | 思考强度 | 忽略 | 忽略 | **生效**（写进 `custom_model`） |
 * | 头 UA | `Trae/0.1.52` | `Trae/0.1.63` | **Chrome 149（浏览器）** |
 *
 * 认证三条路完全一致：`Authorization: Cloud-IDE-JWT {accessToken}`，故账号池零改动。
 *
 * ## 非破坏性
 *
 * 本文件是**纯新增**：不改 `upstream.ts` 的 SOLO/Work 路径，不改 `proxy.ts` 的默认分支。
 * 只有运营者在面板显式把「上游端点」选成 Remote 才会走到这里；默认仍是 SOLO。
 */
import {
  TRAE_REMOTE_CONNECT_TIMEOUT_MS,
  TRAE_REMOTE_CONSTANTS,
  TRAE_REMOTE_FIRST_EVENT_TIMEOUT_MS,
  TRAE_REMOTE_PARALLEL_LIMIT,
  TRAE_REMOTE_STREAM_TIMEOUT_MS,
  normalizeTraeModelName,
} from './constants'
import { boundRemoteQuery, flattenTraeQuery, TRAE_REMOTE_QUERY_MAX_CHARS, type TraeQueryAttachment } from './payload'
import { applyReasoningEffort, type TraeEffortLevel } from './reasoning-effort'
import { uploadImageParts } from './resource-upload'
import type { TraeAccount, TraeErrKind, TraeReasoningEffortConfig, TraeRemoteEvent, TraeRemoteModelConfig } from './types'

/**
 * Remote 的**实际**每账号并发上限。
 *
 * 面板配置为 0（= 不限）时也必须收敛到 `TRAE_REMOTE_PARALLEL_LIMIT`，这是 Remote 与
 * SOLO 的关键差别：SOLO 一条 POST 打完就结束，上游不按「运行中的会话」计并发；Remote
 * 的会话在整条事件流期间都占着槽位，而槽位满了上游**不报错**、只让新会话排队
 *（executor 永不启动，客户端只见心跳）。
 *
 * 面板配得比上游上限更大同样没有意义（上游照样排队），所以取 `min`。
 */
export function effectiveRemoteConcurrency(configured: number): number {
  return configured > 0 ? Math.min(configured, TRAE_REMOTE_PARALLEL_LIMIT) : TRAE_REMOTE_PARALLEL_LIMIT
}

// ===== 基址 =====

/**
 * 修一个「少了 `/api/remote/v1` 路径」的 Remote 基址（源侧 `_normalize_remote_base`）。
 *
 * 为什么需要：面板的 `baseUrl` 历史上被 SOLO/IDE 复用成「只有 host」的形态
 *（`https://trae-api-cn.mchost.guru`）。若照抄进 Remote，每次 `chat_sessions` / `models`
 * 都会 404 —— 而 404 在本仓的错误分类里是 `not_found`（短冷却换号），排查时会一路
 * 怀疑账号。已知 Trae 主机一律补全路径，自定义主机原样保留。
 */
export function normalizeTraeRemoteBase(value: string | undefined | null): string {
  const text = String(value ?? '').trim().replace(/\/+$/, '')
  if (text === '') return TRAE_REMOTE_CONSTANTS.RemoteHost
  const lowered = text.toLowerCase()
  if (lowered.includes('/api/remote/')) return text
  if (lowered.includes('mchost.guru') || lowered.includes('core-normal.trae.cn') || lowered.includes('trae.ai')) {
    return text + '/api/remote/v1'
  }
  return text
}

/** Remote 基址：provider.baseUrl 优先，否则内置默认。 */
export function remoteBaseUrl(baseUrl?: string | null): string {
  return normalizeTraeRemoteBase(baseUrl)
}

/** 是否走国际站（决定 language/region/origin 默认值）。 */
function isIntlBase(base: string): boolean {
  const lowered = base.toLowerCase()
  return lowered.includes('trae.ai') && !lowered.includes('trae-api-cn')
}

// ===== 请求头 =====

/**
 * Remote 请求头。
 *
 * ⚠️ **不要复用 `soloHeaders`**：那是 IDE 客户端身份（`Trae/0.1.52` + X-Ide-* 一堆头），
 * Remote 端点期望的是 **web 浏览器身份**。混用会让上游按 IDE 客户端处理，
 * 与 `env:"remote"` / `origin:"web"` 的 body 自相矛盾。
 */
export function remoteHeaders(
  account: TraeAccount,
  stream: boolean,
  opts?: { baseUrl?: string | null; agentType?: string }
): Record<string, string> {
  const base = remoteBaseUrl(opts?.baseUrl)
  const intl = isIntlBase(base)
  const origin = intl ? 'https://solo.trae.ai' : TRAE_REMOTE_CONSTANTS.RemoteOrigin
  const h: Record<string, string> = {
    Authorization: `Cloud-IDE-JWT ${account.accessToken}`,
    'Content-Type': 'application/json',
    Accept: stream ? 'text/event-stream' : 'application/json',
    'User-Agent': TRAE_REMOTE_CONSTANTS.RemoteUA,
    'X-Trae-Client-Type': 'web',
    'X-Preferenced-Language': intl ? 'en' : 'zh-CN',
    'x-user-region': intl ? 'US' : 'CN',
    Origin: origin,
    Referer: origin.replace(/\/+$/, '') + '/',
  }
  // Work 档位走 lite 客户端身份（源侧 `_work_client_type_enabled`）。Agent 档位保持 web。
  if (String(opts?.agentType ?? '').toLowerCase().includes('work')) {
    h['X-Trae-Client-Type'] = 'lite'
  }
  return h
}

// ===== 模式 / 档位判定 =====

/**
 * 模型名 → `[mode, strategy, modelName]`（源侧 `resolve_mode`）。
 *
 * `mode` 进 body 顶层与 `common_params.solo_chat_mode`；`strategy` 决定
 * `model_selection_strategy`（`auto` 让上游自己挑，`manual` 表示我们钉了具体模型）。
 * 只有 `manual` 才需要解析 `custom_model` —— 而**必须**解析：源侧明确记录过
 * 「manual 请求省略完整 model 对象时，上游会静默选用默认模型」。
 */
export function resolveRemoteMode(model: string): { mode: string; strategy: string; modelName: string } {
  const value = (model || '').trim()
  const lowered = value.toLowerCase()
  if (lowered === 'work' || lowered === 'auto-work' || lowered === 'solo-work') {
    return { mode: 'work', strategy: 'auto', modelName: '' }
  }
  if (value === '' || lowered === 'auto') {
    return { mode: 'code', strategy: 'auto', modelName: '' }
  }
  return { mode: 'code', strategy: 'manual', modelName: value }
}

/**
 * 决定本次会话的 executor 档位：`solo_agent_remote`（Agent，1M 上下文）
 * 或 `solo_work_remote`（Work，200K 兜底）。
 *
 * 为什么必须显式下发：`agent_type` 选 executor，`agent_id` 把会话钉在该档位。
 * 少发 `agent_id` 时上游会静默解析到默认档（常见是 Work/Kimi），
 * 于是「我要 DeepSeek-V4-Pro」变成「给我 Kimi」，且模型绑定校验也会失败。
 */
export function remoteAgentType(model: string, explicit?: string | null): string {
  const value = String(explicit ?? '').trim().toLowerCase()
  if (value === 'solo_work_remote' || value === 'solo_work_lite' || value === 'work') return 'solo_work_remote'
  if (value === 'solo_agent_remote' || value === 'solo_agent_lite' || value === 'agent') return 'solo_agent_remote'
  return resolveRemoteMode(model).mode === 'work' ? 'solo_work_remote' : 'solo_agent_remote'
}

// ===== 设备指纹 / 会话 id =====

/** hex → RFC 4122 UUID 字符串（源侧用 `uuid.UUID(digest[:32])`）。 */
function hexToUuid(hex: string): string {
  const h = hex.padEnd(32, '0').slice(0, 32)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

/** sha256 → 小写 hex（WebCrypto，Workers 兼容）。 */
async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 账号级稳定会话 id（源侧 `model_session_id`）。
 *
 * 「稳定」是刻意的：同一账号 + 同一模型 + 同一变体恒定映射到同一个 UUID，
 * 让上游能复用远端会话（缓存/workspace 连续），而不是每轮都开一个新 workspace。
 * 显式传入 `sessionId` 时直接用它（测试与排障用）。
 */
export async function remoteModelSessionId(
  accountId: string,
  model: string,
  variant = '',
  explicit?: string | null
): Promise<string> {
  const given = String(explicit ?? '').trim()
  if (given) return given
  const material = [accountId || 'default', String(model || 'auto'), variant].join('\u001f')
  return hexToUuid(await sha256Hex(material))
}

/**
 * 设备 id：优先账号上已绑定的（签到接口绑定的那个），缺失则按 uid 派生。
 *
 * 派生值必须是**确定性**的：随机设备 id 会让同一账号每轮都像新设备，
 * 上游的风控与权益判定都会抖。
 */
async function resolveDeviceId(account: TraeAccount, accountId: string): Promise<string> {
  const bound = String(account.deviceId ?? '').trim()
  if (bound) return bound
  const digest = await sha256Hex(`trae${accountId}`)
  // 源侧同款：取前 32 hex 位当大整数，模 10^16，左补零到 16 位。
  const asInt = BigInt('0x' + digest.slice(0, 32)) % 10n ** 16n
  return asInt.toString().padStart(16, '0')
}

// ===== common_params =====

export interface RemoteCommonParamsInput {
  account: TraeAccount
  mode: string
  sessionId?: string
  baseUrl?: string | null
  /** Work 档位额外字段用 */
  agentType?: string
  /** 测试用：覆盖派生的 device_id */
  deviceId?: string
}

/**
 * 构造 `initial_message.common_params`（源侧 `common_params`，返回 JSON 字符串）。
 *
 * 三个「已实测非阻塞」的字段（`web_id` / `biz_user_id` / `user_unique_id`）在这里**按源侧
 * 原样下发为空串** ——2026-10-09 实测：本机 `storage.json` 里这三个全缺，纯 OAuth token
 * 直打 Remote 依然 200（models 34775 字节、chat_sessions 200）。所以它们是可观测性变量，
 * 不是门槛。仍下发空串是为了与源侧**逐字段一致**（空串 ≠ 缺键），减少真机排障的变量。
 *
 * Work 档位会额外下发一整套桌面客户端元数据（os/cpu/build_version 等）——
 * 这些是源侧实测值，**不要按本机真实环境改**：上游校验的是「TraeCode Linux 客户端」身份。
 */
export async function buildRemoteCommonParams(input: RemoteCommonParamsInput): Promise<string> {
  const base = remoteBaseUrl(input.baseUrl)
  const intl = isIntlBase(base)
  const accountId = String(input.account.uid || '').trim()
  const deviceId = input.deviceId ?? await resolveDeviceId(input.account, accountId)
  const params: Record<string, any> = {
    language: intl ? 'en-us' : 'zh-cn',
    app_language: intl ? 'en' : 'zh-CN',
    quality: 'stable',
    app_version: '1.0.0.1229',
    // 这三个字段照源侧**原样下发为空串**（不是省略）。2026-10-09 实测它们为空时
    // Remote 照常 200，所以它们**不是**门槛；但「空串」与「缺键」在协议上是两种形态，
    // 与源侧保持一致可以少一个变量——真机排障时不必再怀疑是不是少了这三个键。
    web_id: '',
    biz_user_id: '',
    user_unique_id: '',
    user_identity: 'Free',
    is_freshman: '0',
    scope: intl ? 'marscode-us' : 'marscode-cn',
    tenant: 'marscode',
    region: intl ? 'US-East' : 'cn',
    aiRegion: intl ? 'US-East' : 'cn',
    is_privacy_mode: 0,
    privacy_mode: 'off',
    solo_chat_mode: input.mode,
  }
  if (String(input.mode).trim().toLowerCase() === 'work') {
    const machineId = await sha256Hex([accountId, deviceId, 'traework-linux-probe'].join('\u001f'))
    const localDeviceId = 'aha-' + (await sha256Hex(`local-${accountId}-${deviceId}`)).slice(0, 32)
    Object.assign(params, {
      icube_uid: accountId,
      user_id: accountId,
      device_id: deviceId,
      local_device_id: localDeviceId,
      machine_id: machineId,
      arch: 'x64',
      system: 'linux',
      scope: 'marscode',
      tenant: 'marscode',
      region: 'CN',
      aiRegion: 'CN',
      build_version: '2.3.79946',
      vscode_version: '1.107.1',
      app_version: '3.3.96',
      os_name: 'linux',
      os_version: 'Linux x64',
      os_release: '6.1',
      platform: 'electron',
      device_model: 'TraeCode Linux',
      device_manufacturer: 'TraeCode',
      cpu: 'x86_64',
      cpu_brand: 'x86_64',
      cpu_speed: 0,
      memory: 0,
      chat_mode: 1,
      identity: '0',
      identity_str: 'Free',
      product_code: 'SOLO_Lite',
      message_source: 'manual',
    })
  }
  if (input.sessionId) params['biz_session_id'] = input.sessionId
  return JSON.stringify(params)
}

// ===== 模型目录 =====

/**
 * 拉 Remote 模型目录：`GET {base}/models?functions=…&show_custom_model=true`。
 *
 * 为什么必须自己拉一遍（而不是复用 SOLO 的 `get_detail_param`）：两个目录**不等价**。
 * Remote 返回的是 web 前端实际下发的完整 `custom_model` 对象（含
 * `reasoning_effort_config` / `max_mode` / `features`），SOLO 目录里没有这些字段。
 * 建会话时缺了 `custom_model`，上游会静默换默认模型。
 */
export async function fetchRemoteModels(
  account: TraeAccount,
  opts?: { baseUrl?: string | null; agentType?: string }
): Promise<Record<string, TraeRemoteModelConfig>> {
  const base = remoteBaseUrl(opts?.baseUrl)
  const url = `${base}${TRAE_REMOTE_CONSTANTS.EpRemoteModels}`
    + `?functions=${encodeURIComponent(TRAE_REMOTE_CONSTANTS.RemoteModelFunctions)}`
    + `&show_custom_model=true`
  let resp: Response
  try {
    resp = await fetch(url, {
      method: 'GET',
      headers: remoteHeaders(account, false, opts),
      signal: AbortSignal.timeout(TRAE_REMOTE_CONNECT_TIMEOUT_MS),
    })
  } catch (e) {
    const err = new Error(`remote models transport error: ${(e as Error).message || String(e)}`) as Error & { kind?: TraeErrKind }
    ;(err as any).kind = 'transport'
    throw err
  }
  if (resp.status >= 400) {
    const raw = await resp.text().catch(() => '')
    const err = new Error(`remote models upstream (http ${resp.status}): ${raw.slice(0, 200)}`) as Error & { kind?: TraeErrKind; status?: number; msg?: string }
    ;(err as any).kind = resp.status === 401 ? 'session_dead' : 'server'
    ;(err as any).status = resp.status
    ;(err as any).msg = raw.slice(0, 200)
    throw err
  }
  const payload = await resp.json().catch(() => null) as Record<string, any> | null
  const groups = (payload?.['data']?.['list'] ?? []) as unknown
  const requested = String(opts?.agentType ?? '').trim().toLowerCase()
  const out: Record<string, TraeRemoteModelConfig> = {}
  if (!Array.isArray(groups)) return out

  const groupFunction = (g: unknown): string => {
    if (!g || typeof g !== 'object') return ''
    const rec = g as Record<string, any>
    return String(rec['function'] ?? rec['agent_type'] ?? '').trim().toLowerCase()
  }
  const ingest = (group: unknown): void => {
    if (!group || typeof group !== 'object') return
    const models = (group as Record<string, any>)['models']
    if (!Array.isArray(models)) return
    for (const raw of models) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const rec = raw as Record<string, any>
      const name = String(rec['name'] ?? '').trim()
      if (!name || out[name]) continue
      out[name] = buildRemoteModelConfig(rec)
    }
  }

  // 档位隔离：Agent 档位带 1M 配置、Work 档位是 200K 兜底，**不得互相顶替**
  //（源侧注释：「an explicit Work lookup must stay in the Work tier」）。
  let preferred: unknown[] = []
  if (requested) {
    preferred = groups.filter((g) => groupFunction(g) === requested)
    if (preferred.length === 0) {
      // 老目录里档位可能只以 lite 兄弟形态存在；仍不允许 Work↔Agent 跨档顶替。
      const sibling = requested.endsWith('_remote')
        ? requested.slice(0, -7) + '_lite'
        : requested.endsWith('_lite')
          ? requested.slice(0, -5) + '_remote'
          : ''
      if (sibling) preferred = groups.filter((g) => groupFunction(g) === sibling)
    }
    if (preferred.length === 0) return out
  } else {
    preferred = groups.filter((g) => groupFunction(g) === 'solo_agent_remote')
      .concat(groups.filter((g) => groupFunction(g) === 'solo_agent_lite'))
  }
  for (const g of preferred) ingest(g)
  // 未指定档位时保留历史兜底：把其余分组也并进来（Agent 优先，缺失由 Work 补）。
  if (!requested) for (const g of groups) ingest(g)
  return out
}

/** 上游单个模型对象 → 归一化配置（源侧 `_build_web_model_config`）。 */
function buildRemoteModelConfig(raw: Record<string, any>): TraeRemoteModelConfig {
  const cfg: Record<string, any> = { ...raw }
  let features = cfg['features']
  if (typeof features === 'string') {
    try {
      features = JSON.parse(features)
    } catch {
      features = {}
    }
  }
  const name = String(cfg['name'] ?? '')
  cfg['config_name'] = cfg['config_name'] || name
  // CN 目录用 `name` 当 config 标识；Remote 也认 `model_name`。两个都留，
  // 让「选中的模型」是显式的，而不是给上游留一个默认回退的口子。
  cfg['model_name'] = cfg['model_name'] || name
  cfg['config_source'] = cfg['config_source'] || 1
  cfg['provider'] = cfg['provider'] || ''
  cfg['multimodal'] = Boolean(cfg['multimodal'])
  cfg['ak'] = cfg['ak'] || ''
  cfg['sk'] = cfg['sk'] || ''
  cfg['base_url'] = cfg['base_url'] || ''
  cfg['auth_type'] = cfg['auth_type'] || 0
  cfg['features'] = features
  cfg['use_remote_service'] = !Boolean(cfg['client_connect'])
  return {
    name,
    displayName: String(cfg['display_name'] ?? cfg['display_model_name'] ?? '').trim() || undefined,
    configSource: Number(cfg['config_source']) || 1,
    provider: String(cfg['provider'] || '') || undefined,
    multimodal: Boolean(cfg['multimodal']),
    maxMode: Boolean(cfg['max_mode']),
    reasoningEffortConfig: (cfg['reasoning_effort_config'] ?? undefined) as TraeReasoningEffortConfig | undefined,
    raw: cfg,
  }
}

/**
 * 按模型名解析 `custom_model`（源侧 `_get_web_custom_model`）。
 *
 * 查找顺序：精确 config_name → 大小写不敏感 config_name → display_name 精确 →
 * display_name 模糊。**全都不命中就返回 null**（调用方据此报错），
 * 绝不退化成「随便给一个模型」——那正是「网关偷偷换模型」的来源。
 */
export function resolveRemoteModelConfig(
  models: Record<string, TraeRemoteModelConfig>,
  modelName: string
): TraeRemoteModelConfig | null {
  const wanted = String(modelName ?? '').trim()
  if (!wanted) return null
  if (models[wanted]) return models[wanted]
  const lowered = wanted.toLowerCase()
  for (const name of Object.keys(models)) {
    if (name.toLowerCase() === lowered) return models[name]
  }
  for (const name of Object.keys(models)) {
    const display = models[name].displayName
    if (display && display.toLowerCase() === lowered) return models[name]
  }
  for (const name of Object.keys(models)) {
    const display = models[name].displayName
    if (display && (display.toLowerCase().includes(lowered) || display.replace(/ /g, '-').toLowerCase() === lowered)) {
      return models[name]
    }
  }
  return null
}

/**
 * 归一化模型族名，用于「绑定校验」（源侧 `_model_family`）。
 *
 * 目的：确认上游解析出来的模型**就是我们请求的那个族**。若不符，源侧直接抛错
 * （`_bound_model_name` 的 `Trae remote model binding mismatch`），而不是继续发请求——
 * 宁可失败也不让上游把 `DeepSeek-V4-Pro` 悄悄换成别的。
 */
export function remoteModelFamily(value: unknown): string {
  let text = String(value ?? '').trim()
  if (!text) return ''
  // ⚠️ 顺序是硬约束：`__suffix` 是内部变体标记，必须在归一化**之前**剥掉。
  // `normalizeTraeModelName` 会把 `_` 全变成 `-`，于是 `DeepSeek-V4-Pro__dev`
  // 变成 `DeepSeek-V4-Pro--dev`，`__` 再也认不出来（实测踩过：族名会多出 `--dev`，
  // 导致「同族」判定失败 → 绑定校验误报 → 正常请求被拒）。
  text = text.split('__')[0].trim()
  if (text.toLowerCase().startsWith('trae/')) text = text.slice(5)
  text = normalizeTraeModelName(text).trim().toLowerCase().replace(/_/g, '-')
  if (text.startsWith('ali-deepseek-v4-')) text = text.slice(4)
  const deepseek = /^(deepseek-v4-(?:pro|flash))(?:-(?:official|\d{4,8}))*$/.exec(text)
  if (deepseek) return deepseek[1]
  if (text.endsWith('-official')) text = text.slice(0, -'-official'.length)
  return text
}

/**
 * 校验并取出「上游实际会用的 config id」。
 *
 * 命中不了同族候选就抛错。这条是**用户偏好「不许偷偷换模型」的代码化落地**：
 * 请求 `DeepSeek-V4-Pro`、上游只给出 `kimi-k3` 时必须失败，而不是静默用 Kimi 回答。
 */
export function boundRemoteModelName(requestedModel: string, cfg: TraeRemoteModelConfig): string {
  const requestedFamily = remoteModelFamily(requestedModel)
  const candidates = [cfg.raw['config_name'], cfg.raw['model_name'], cfg.raw['name']]
    .map((v) => String(v ?? '').trim())
    .filter(Boolean)
  const selected = candidates.find((c) => !requestedFamily || remoteModelFamily(c) === requestedFamily)
    ?? candidates[0]
    ?? ''
  const resolvedFamilies = new Set(
    ['config_name', 'model_name', 'name', 'display_name', 'display_model_name']
      .map((k) => remoteModelFamily(cfg.raw[k]))
      .filter(Boolean)
  )
  if (!selected || (requestedFamily && resolvedFamilies.size > 0 && !resolvedFamilies.has(requestedFamily))) {
    throw new Error(
      `Trae remote model binding mismatch: requested ${requestedModel}, resolved ${selected || '<empty>'}`
    )
  }
  return selected
}

// ===== max mode（1M 上下文档）=====

/**
 * 是否启用 max mode。三个条件全中才开：
 *  ① Agent 档位（Work 档位没有 1M 配置）；
 *  ② 调用方/环境显式要求；
 *  ③ **上游账号配置确实标记了该模型支持 max**（`custom_model.max_mode`）。
 *
 * 第 ③ 条是硬约束（源侧注释：「Never fabricate max limits for a model the account
 * config does not mark」）——凭空造 1M 上限会让上游在会话中途拒绝，用户看到的是「莫名其妙断了」。
 */
export function maxModeRequested(
  modelName: string,
  cfg: TraeRemoteModelConfig | null,
  opts: { agentType: string; enabled: boolean }
): boolean {
  if (opts.agentType !== 'solo_agent_remote') return false
  if (!opts.enabled) return false
  return Boolean(cfg && cfg.maxMode)
}

/**
 * 把 slim 的 max_mode 条目补全成桌面客户端那份完整配置（源侧 `_max_mode_custom_model`）。
 *
 * 上游只返回 `max_mode: true` + `context_window_tokens`，缺了验证 1M 会话必需的
 * `context_window_size` / `prompt_max_tokens` / `max_tokens` / `features.context_windows`。
 * 不补全上游会按默认（200K）校验，max mode 实际不生效。
 */
export function enrichMaxModeConfig(cfg: TraeRemoteModelConfig): Record<string, any> {
  const raw = { ...cfg.raw }
  const cws = (raw['context_window_size'] ?? {}) as Record<string, any>
  let rawMax = cws['max'] ?? []
  if (typeof rawMax === 'number') rawMax = [rawMax]
  let rawFeatures = raw['features'] ?? {}
  if (typeof rawFeatures === 'string') {
    try {
      rawFeatures = JSON.parse(rawFeatures)
    } catch {
      rawFeatures = {}
    }
  }
  const featureCw = ((rawFeatures as Record<string, any>)['context_windows'] ?? {}) as Record<string, any>
  const featureData = (featureCw['data'] ?? {}) as Record<string, any>
  const tokens = (raw['context_window_tokens'] ?? {}) as Record<string, any>

  const toInt = (v: unknown, fallback: number): number => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
  }
  const maxContext = toInt(
    (Array.isArray(rawMax) ? rawMax[0] : undefined) ?? featureData['max_context'] ?? tokens['max'],
    TRAE_REMOTE_CONSTANTS.MaxContextTokens
  )
  const devContext = toInt(cws['default'] ?? featureData['dev_context'] ?? tokens['dev'], 200_000)
  const promptMax = toInt(raw['prompt_max_tokens'], TRAE_REMOTE_CONSTANTS.MaxPromptTokens)
  const outputMax = toInt(raw['max_tokens'], TRAE_REMOTE_CONSTANTS.MaxOutputTokens)
  const maxTurn = toInt(
    raw['max_turn'] ?? ((raw['max_turns'] as Record<string, any> | undefined)?.['default']) ?? featureData['max_turns'],
    500
  )

  raw['max_mode'] = true
  raw['context_window_size'] = { default: devContext, max: [maxContext] }
  raw['context_window_tokens'] = { dev: devContext, max: maxContext }
  raw['prompt_max_tokens'] = promptMax
  raw['max_tokens'] = outputMax
  raw['max_turn'] = maxTurn
  raw['max_turns'] = { default: maxTurn, max: maxTurn }
  const features = { ...(rawFeatures as Record<string, any>) }
  features['context_windows'] = {
    ...featureCw,
    enable: true,
    data: {
      dev_context: devContext,
      max_context: maxContext,
      max_context_list: [maxContext],
      dev_turns: maxTurn,
      max_turns: maxTurn,
    },
  }
  raw['features'] = features
  return raw
}

/** max mode 的线上字段（源侧 `_max_mode_fields`）。 */
export function maxModeFields(cfg: Record<string, any>): Record<string, any> {
  const cws = (cfg['context_window_size'] ?? {}) as Record<string, any>
  let rawMax = cws['max'] ?? []
  if (typeof rawMax === 'number') rawMax = [rawMax]
  const toInt = (v: unknown, fallback: number): number => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
  }
  return {
    model_auto_selection: { strategy: 'max', fallback_to_advance_model: null, entitlement_id: null },
    model_selection_strategy: 'max',
    mode_type: TRAE_REMOTE_CONSTANTS.MaxModeType,
    context_window_size: toInt((Array.isArray(rawMax) ? rawMax[0] : undefined), TRAE_REMOTE_CONSTANTS.MaxContextTokens),
    prompt_max_tokens: toInt(cfg['prompt_max_tokens'], TRAE_REMOTE_CONSTANTS.MaxPromptTokens),
    max_tokens: toInt(cfg['max_tokens'], TRAE_REMOTE_CONSTANTS.MaxOutputTokens),
  }
}

// ===== 建会话 =====

export interface CreateRemoteSessionOptions {
  baseUrl?: string | null
  /** 显式档位覆盖（面板/测试用） */
  agentType?: string | null
  /** 是否请求 max mode（1M 档） */
  maxMode?: boolean
  /** 已拉好的模型目录；不传则内部拉一次 */
  models?: Record<string, TraeRemoteModelConfig>
  /** 稳定会话 id 覆盖 */
  sessionId?: string | null
  /**
   * 会话变体标记（进稳定会话 id 的哈希材料）。
   * Work 兜底用 `'work-fallback'`，使兜底会话与正常 Work 会话不共用远端 workspace
   *（源侧 `work_fallback_options` 同款）。
   */
  sessionVariant?: string
  /** 客户端请求体（供 reasoning_effort 读取） */
  requestBody?: unknown
  /**
   * 待上传的图片（字节 + 文件名，由调用方从 messages 里抽出，见
   * `resource-upload.ts` 的 `extractImageParts`）。
   *
   * **只有** `cfg.multimodal === true` 才会真的上传；其余情况（模型不声明多模态、
   * `strategy === 'auto'` 拿不到模型目录）一律不上传 —— 与「面板识图桥只在配了识图模型时
   * 才转写图片」是同一个门禁语义。上传失败也不让整轮会话失败（见 `createRemoteSession`）。
   */
  imageParts?: Array<{ bytes: Uint8Array; filename: string }>
  /**
   * 扁平 `query` 的硬上限（字符）。不传用 `TRAE_REMOTE_QUERY_MAX_CHARS`（约 480k）。
   *
   * 面板 `traeMaxHistoryChars` 会经此生效 —— 此前 Remote 通道**完全没有**历史预算
   *（`__budget` 只在 SOLO 路径注入，`proxy.ts` 在 Remote 分支早退），面板里那个「历史总字符数
   * 上限」对 remote 提供商是静默失效的。
   */
  maxQueryChars?: number
  /** 诊断：把 effort / max / query 长度等结果写回调用方（见 RemoteSessionTrace） */
  trace?: RemoteSessionTrace
}

/**
 * `createRemoteSession` 回填的诊断信息（建会话阶段**实际**发生了什么）。
 *
 * 这些字段存在的唯一理由是：Remote 的失败常常是**静默**的 —— 档位被忽略、会话被丢弃
 * 都不报错。没有回填，日志只能证明「我们发了什么」，证明不了「上游收下了什么」。
 */
export interface RemoteSessionTrace {
  maxModeApplied?: boolean
  reasoningEffortApplied?: TraeEffortLevel | ''
  /**
   * 扁平化后的 `query` 字符数。
   *
   * 源侧 Remote 对超长 query 有**静默上限**（`_bounded_remote_query`，约 480k 字符），
   * 超了上游不发 `done`、直接丢会话 —— 客户端看到的就是「没有内容」，与 executor
   * 不启动的症状**完全一样**。没有这个数字，那种失败只能靠猜。
   */
  queryChars?: number
  /**
   * 为压到 `queryChars` 上限内被**整条丢弃**的历史消息数（源侧 `_bounded_remote_query`
   * 的 `removed`）。
   *
   * 与 `queryChars` 配对读：`queryChars` 贴边 + `queryDroppedMessages > 0` 说明这一轮上游
   * 看到的历史已经被砍过，模型「忘了前文」不是它的问题，而是压缩在起作用。
   */
  queryDroppedMessages?: number
  /** 为压到上限内被**头尾截断**的单条消息数（中间替换成截断标记）。 */
  queryTruncatedMessages?: number
  /**
   * 请求里带的图片张数（调用方从 messages 抽出的，不是原始块数）。
   *
   * 图片链路是 Remote 里**最容易静默失败**的一环：模型不识图、上传被拒、抽取阶段就丢了
   * 远端 URL —— 三种情况上游都不会报错，只会「答非所问」。这三个数字 + `imageSkipReason`
   * 是唯一能把它们区分开的东西（`proxy.ts` 的 `dropped_images=` 日志就靠它们）。
   */
  imageParts?: number
  /** 真正以 `attachment` 块下发的张数 */
  imageAttachments?: number
  /** 上传失败的张数 */
  imageUploadFailed?: number
  /** 首条上传失败原因（**已脱敏、已截断**，可直接进日志） */
  imageUploadError?: string
  /**
   * **成功**上传时命中的变体摘要，如 `mime+crc=2`（没有成功图时是空串）。
   *
   * 为什么必须回填它：变体阶梯是一次性实验，而面板 durable 日志是唯一读数入口 ——
   * 只知道「图传上去了」没用，**必须知道是哪一档赢的**，否则没法把阶梯收敛成只留那一档
   *（命中信息原本只走 `console.log`，面板里看不到）。
   */
  imageVariantSummary?: string
  /** 图片没上传的原因：`model-not-multimodal` / `model-config-unresolved` */
  imageSkipReason?: string
}

export interface CreateRemoteSessionResult {
  sessionId: string
  messageId: string
  /** 实际生效的档位（未施加为 ''） */
  agentType: string
  reasoningEffort: TraeEffortLevel | ''
  maxMode: boolean
}

/**
 * 第一步：`POST {base}/chat_sessions`，拿 `chat_session_id` + `message_id`。
 *
 * 关键点（都是源侧踩过的坑）：
 *  - **manual 必须带完整 `custom_model`**：省略时上游静默用默认模型；
 *  - **`agent_type` 与 `agent_id` 都要发**：只发前者，会话会静默解析到默认档；
 *  - **`custom_model` 里写思考档位**：这是切 Remote 的全部意义所在；
 *  - `query` 是扁平 JSON 字符串（见 `flattenTraeQuery`），不是结构化 messages。
 */
export async function createRemoteSession(
  account: TraeAccount,
  model: string,
  messages: unknown,
  opts: CreateRemoteSessionOptions = {}
): Promise<CreateRemoteSessionResult> {
  if (!account.accessToken) throw new Error('No Cloud-IDE-JWT token available')
  const base = remoteBaseUrl(opts.baseUrl)
  const resolved = resolveRemoteMode(model)
  const agentType = remoteAgentType(model, opts.agentType)
  const accountId = String(account.uid || '').trim()

  let cfg: TraeRemoteModelConfig | null = null
  if (resolved.strategy === 'manual') {
    const models = opts.models ?? await fetchRemoteModels(account, { baseUrl: opts.baseUrl, agentType })
    cfg = resolveRemoteModelConfig(models, resolved.modelName)
    if (!cfg) {
      throw new Error(`Trae remote model is not available for the bound account: ${resolved.modelName}`)
    }
  }

  const useMaxMode = maxModeRequested(resolved.modelName, cfg, {
    agentType,
    enabled: opts.maxMode === true,
  })
  const strategy = useMaxMode ? 'max' : resolved.strategy
  const variant = useMaxMode ? 'max' : String(opts.sessionVariant ?? '')
  const sessionId = await remoteModelSessionId(accountId, resolved.modelName || model, variant, opts.sessionId)

  // ===== 图片：只有「模型声明多模态」才上传 =====
  //
  // 门禁是 `cfg.multimodal`（`buildRemoteModelConfig` 从上游模型目录解析出来的字段）。
  // 为什么必须门禁，而不是「有图就传」：
  //  - `strategy === 'auto'` 时压根没有 `cfg`（上游自己挑模型），此时传附件等于给一个
  //    可能不识图的模型塞图 —— 与面板「识图桥只在配了识图模型时才转写」的语义一致；
  //  - 上传是**两步外部写请求**（还会在 Trae 存储里落一个对象），不该在模型不识图时白花。
  //
  // 失败**不让整轮会话失败**：图片丢了总比整轮对话挂掉强 —— 用户至少还能拿到回答，
  // 而下面留的 warn 日志（含张数与脱敏原因，**不含 auth**）能让人查到图为什么没上去。
  // 降级后的行为 == 加这个功能之前的行为（图片降级成纯文本，`contentToText` 吃掉）。
  //
  // 已知代价：档位兜底（Agent → Work）会**再建一次会话**，那时图片会重新上传一遍
  //（新的 uuid、新的对象）。只在上传成功但会话失败时发生，频率低；不做跨调用缓存是因为
  // Workers 的 isolate 生命周期不可依赖，缓存反而会引入「拿到过期凭据」这种更难查的故障。
  let attachments: TraeQueryAttachment[] = []
  if (opts.imageParts && opts.imageParts.length > 0) {
    if (cfg?.multimodal === true) {
      const outcome = await uploadImageParts(account, opts.imageParts, { baseUrl: opts.baseUrl })
      attachments = outcome.attachments
      if (outcome.failures.length > 0) {
        const first = outcome.failures[0]
        // 1200 而不是 600：上传失败是**聚合**错误（候选主机 × 变体阶梯），而
        // `resource-upload.ts` 现在把每条失败压成一行短码（`host [400]: InvalidFileType/4028`）。
        // 8 枪 ≈ 790 字符 —— 600 会把最后两枪与 `store=`（对象名后缀的唯一读数）截掉，
        // 2026-10-14 16:11 的真机日志就是这么丢掉结论的。留 1200 是为了**整条不截尾**。
        const reason = String(first.reason ?? '').slice(0, 1200)
        // 只含张数与已脱敏的原因（`resource-upload.ts` 保证错误信息里没有 auth/session_key）。
        console.warn(
          `[trae-remote] image upload failed: requested=${opts.imageParts.length}`
          + ` attached=${attachments.length} failed=${outcome.failures.length}`
          + ` first=${first.filename}: ${reason}`
        ) // CodeQL 误报（CODING_NOTES.md §493）： 纯诊断日志，不含凭据
      }
      if (opts.trace) {
        opts.trace.imageParts = opts.imageParts.length
        opts.trace.imageAttachments = attachments.length
        opts.trace.imageUploadFailed = outcome.failures.length
        // 成功命中的变体也要回填：失败时 `variantSummary` 是空串，原因由
        // `imageUploadError`（走 warn 日志）承载；成功时它是唯一的读数。
        opts.trace.imageVariantSummary = outcome.variantSummary
        opts.trace.imageUploadError = outcome.failures.length > 0
          ? String(outcome.failures[0].reason ?? '').slice(0, 1200)
          : undefined
      }
    } else if (opts.trace) {
      opts.trace.imageParts = opts.imageParts.length
      opts.trace.imageAttachments = 0
      opts.trace.imageUploadFailed = 0
      opts.trace.imageSkipReason = cfg ? 'model-not-multimodal' : 'model-config-unresolved'
    }
  }

  // 扁平化一次并留住长度：`query` 是 Remote 唯一的对话载体，而源侧对超长 query 有
  // **静默上限**（约 480k 字符）—— 超了上游不发 done、直接丢会话，症状与「executor
  // 不启动」完全一样。长度是区分这两种失败的唯一线索。
  //
  // 压缩（源侧 `_bounded_remote_query` 的等价物）：先丢最旧回合、再对单条超长消息头尾截断，
  // 仍超限则抛 `RemoteQueryTooLargeError` 由调用方返回 413 —— **不换号重放**，因为输入长度是
  // 确定性属性（源侧 release-v1.0.6 同口径）。图片以 attachment 块参与同一长度度量。
  const bounded = boundRemoteQuery(messages, {
    maxChars: opts.maxQueryChars ?? TRAE_REMOTE_QUERY_MAX_CHARS,
    attachments,
  })
  const query = flattenTraeQuery(bounded.messages, { attachments })
  const initialMessage: Record<string, any> = {
    chat_session_id: '',
    content: [],
    query,
    model_name: resolved.modelName,
    agent_type: agentType,
    agent_id: agentType,
    model_selection_strategy: strategy,
    common_params: await buildRemoteCommonParams({ account, mode: resolved.mode, sessionId, baseUrl: opts.baseUrl, agentType }),
  }

  if (resolved.strategy === 'manual' && cfg) {
    initialMessage['model_name'] = boundRemoteModelName(resolved.modelName, cfg)
    initialMessage['model_config_source'] = cfg.configSource ?? 1
    initialMessage['model_is_preset'] = cfg.raw['is_preset'] !== false
    initialMessage['model_provider'] = String(cfg.raw['provider'] ?? '')
    initialMessage['custom_model'] = cfg.raw
  }
  if (useMaxMode && cfg) {
    const enriched = enrichMaxModeConfig(cfg)
    initialMessage['custom_model'] = enriched
    Object.assign(initialMessage, maxModeFields(enriched))
  }

  // 思考强度：只有 custom_model 存在时才可能生效（= 只有 manual + Remote）。
  let appliedEffort: TraeEffortLevel | '' = ''
  if (initialMessage['custom_model'] && typeof initialMessage['custom_model'] === 'object') {
    const [effortModel, effortLevel] = applyReasoningEffort(initialMessage['custom_model'] as Record<string, any>, opts.requestBody)
    initialMessage['custom_model'] = effortModel
    appliedEffort = effortLevel
  }

  if (resolved.mode === 'work') {
    initialMessage['__hit_shared_artifact_and_workroom'] = true
    initialMessage['__hit_my_space'] = true
  }

  const body: Record<string, any> = {
    mode: resolved.mode,
    environment_id: 'default',
    initial_message: initialMessage,
    env: 'remote',
    auto_create_project: false,
    origin: 'web',
  }

  if (opts.trace) {
    opts.trace.maxModeApplied = useMaxMode
    opts.trace.reasoningEffortApplied = appliedEffort
    opts.trace.queryChars = query.length
    // 压缩读数：`dropped`/`truncated` 为 0 说明这次没触发压缩；非 0 时这两个数字是
    // 「上游看到的历史被删了多少」的唯一证据（面板按 queryChars 贴边时优先看它们）。
    opts.trace.queryDroppedMessages = bounded.droppedMessages
    opts.trace.queryTruncatedMessages = bounded.truncatedMessages
  }

  let resp: Response
  try {
    resp = await fetch(`${base}${TRAE_REMOTE_CONSTANTS.EpRemoteSessions}`, {
      method: 'POST',
      headers: remoteHeaders(account, false, { baseUrl: opts.baseUrl, agentType }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TRAE_REMOTE_CONNECT_TIMEOUT_MS),
    })
  } catch (e) {
    const err = new Error(`remote create_session transport error: ${(e as Error).message || String(e)}`) as Error & { kind?: TraeErrKind }
    ;(err as any).kind = 'transport'
    throw err
  }

  const text = await resp.text().catch(() => '')
  if (resp.status >= 400) {
    const err = new Error(`Trae remote create_session [${resp.status}]: ${text.slice(0, 500)}`) as Error & { kind?: TraeErrKind; status?: number; msg?: string; parallelLimit?: boolean }
    ;(err as any).kind = resp.status === 401 ? 'session_dead' : resp.status === 429 ? 'soft_rate' : 'server'
    ;(err as any).status = resp.status
    ;(err as any).msg = text.slice(0, 500)
    /**
     * 上游**并发会话上限**（`solo_agent_parallel_limit`，实测 `limit:2 / running:2`）。
     *
     * 这是**账号资源被占满**，不是账号坏了，也不是请求有问题，因此三件事都要区分开：
     *  - 不该长冷却（账号是好的，槽位很快会释放）；
     *  - 不该换档位（换 executor 换不掉「该账号还有 2 个会话在跑」这个事实）；
     *  - 只该**换号**（源侧 `main.py:7159` 同款：`solo_agent_parallel_limit` → rotating account）。
     *
     * 更要命的是它常常是**我们自己的漏**造成的：每次放弃会话而不 stop，就会占住一个槽位，
     * 积满 2 个之后新建的会话只会排队、executor 永远不启动（表现为「只发心跳」）。
     */
    if (text.includes('solo_agent_parallel_limit') || text.includes('991502')) {
      ;(err as any).parallelLimit = true
    }
    throw err
  }
  let payload: Record<string, any> | null = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    throw new Error(`Trae remote invalid create_session response: ${text.slice(0, 500)}`)
  }
  const code = payload?.['code']
  if (code !== null && code !== undefined && code !== 0 && !payload?.['data']) {
    throw new Error(`Trae remote create_session: ${text.slice(0, 500)}`)
  }
  const data = (payload?.['data'] ?? payload ?? {}) as Record<string, any>
  const sessionIdOut = String(data['chat_session_id'] ?? '')
  const messageId = String(data['message_id'] ?? '')
  if (!sessionIdOut || !messageId) {
    throw new Error(`Trae remote create_session missing ids: ${text.slice(0, 500)}`)
  }
  return { sessionId: sessionIdOut, messageId, agentType, reasoningEffort: appliedEffort, maxMode: useMaxMode }
}

// ===== 事件流 =====

/**
 * 归一化事件名（源侧 `event_name`）。
 *
 * 上游事件名存在多种拼写（`ResponseDone` / `response_done` / `streamDone`…），
 * 统一转 snake_case 并把已知别名折到 `done` / `model_config` / `plan_item` / `token_usage`。
 */
export function normalizeRemoteEventName(value: unknown): string {
  let text = String(value ?? '').trim()
  text = text.replace(/(?<=[a-z0-9])(?=[A-Z])/g, '_')
  const normalized = text.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase()
  const aliases: Record<string, string> = {
    modelconfig: 'model_config',
    planitem: 'plan_item',
    responsedone: 'done',
    response_done: 'done',
    streamdone: 'done',
    stream_done: 'done',
    tokenusage: 'token_usage',
  }
  return aliases[normalized] ?? normalized
}

/** 首事件前视为「模型已产出」的事件名——用于区分「会话根本没起来」与「已经在出内容」。 */
const REMOTE_MODEL_EVENTS = new Set([
  'model_config', 'plan_item', 'message', 'assistant_message',
  'response', 'text', 'output', 'token_usage', 'done',
])

/** Remote 首事件失败（会话起来了但没出模型事件）→ 可换号重试。 */
export class RemoteFirstEventTimeout extends Error {
  readonly kind: TraeErrKind = 'transport'
  constructor(message: string) {
    super(message)
    this.name = 'RemoteFirstEventTimeout'
  }
}

/** Remote 会话在模型产出前就报错（如 executor 没起来）→ 可换号重试。 */
export class RemoteFirstEventError extends Error {
  readonly kind: TraeErrKind = 'transport'
  constructor(message: string) {
    super(message)
    this.name = 'RemoteFirstEventError'
  }
}

/** Remote 事件流在已有产出之后超时/截断 → **不可**重试（否则重复计费）。 */
export class RemoteStreamIncomplete extends Error {
  readonly kind: TraeErrKind = 'transport'
  constructor(message: string) {
    super(message)
    this.name = 'RemoteStreamIncomplete'
  }
}

/** 一次 `reader.read()` 超时（首事件死线 / 空闲死线共用）。 */
class RemoteReadTimeout extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RemoteReadTimeout'
  }
}

/**
 * 给**一次** `reader.read()` 套死线。
 *
 * ⚠️ 为什么不能用 `AbortSignal.timeout` 代替：那是**整个请求的总时长**上限，而源侧
 * 的 300s 是 httpx 的 **read（每次读取之间）** 超时。两者语义完全不同——
 * 用总时长会把「思考了 6 分钟但一直在出数据」的正常长会话掐死。
 *
 * 而「只在循环里检查 deadline」也不行：`reader.read()` 会在上游完全静默时**永久阻塞**，
 * 循环根本没有机会再检查一次（实测：会话建起来了、一个字节都不发，客户端拿到
 * 8s 一次的心跳却永远等不到内容）。必须把死线压进 read 本身。
 */
function readWithDeadline<T>(
  reader: ReadableStreamDefaultReader<T>,
  ms: number
): Promise<ReadableStreamReadResult<T>> {
  if (!(ms > 0)) return reader.read()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new RemoteReadTimeout(`no data for ${ms}ms`)), ms)
    reader.read().then(
      (r) => { clearTimeout(timer); resolve(r) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

/**
 * 第二步：`GET /chat_sessions/{id}/events?reply_to_message_id={msgId}`，逐事件产出。
 *
 * 三道死线（源侧 `httpx.Timeout(read, connect)` 的等价物）：
 *  1. **建连**：`TRAE_REMOTE_CONNECT_TIMEOUT_MS`（拿到响应头即解除）；
 *  2. **首事件**（默认 120s）：Remote 在 executor 起来前会先发 queue/heartbeat 帧。
 *     若把心跳算作「已产出」，一次卡死的会话就会耗掉整个流超时；故**只有模型事件**
 *     才解除首事件死线。首事件前收到 `error` 则抛 `RemoteFirstEventError`（可重试）；
 *  3. **读空闲**（默认 300s，**每次读取之间**而非总时长）：拿到首个模型事件后改用
 *     这条，保证「思考很久但持续有输出」的长会话不被总时长误杀。
 *
 * 任一死线触发都会 **abort 底层连接** —— 否则上游会继续跑完、继续烧额度。
 *
 * 无 `done` 就结束 → 抛 `RemoteStreamIncomplete`：上游会在扁平 query 超过静默上限时
 * 直接关连接而不报错，此时若当正常 EOF，半句话会被伪装成完整回答。
 */
export async function* streamRemoteEvents(
  account: TraeAccount,
  sessionId: string,
  messageId: string,
  opts?: {
    baseUrl?: string | null
    agentType?: string
    firstEventTimeoutMs?: number
    /** 每次读取之间的空闲上限（默认 TRAE_REMOTE_STREAM_TIMEOUT_MS） */
    idleTimeoutMs?: number
    /** 诊断：首个原始字节片段（判定「上游发没发、什么形态」） */
    onRawHead?: (head: string) => void
    /**
     * 诊断：首个模型事件（判定「流是活的」）。
     *
     * 带上 `data` 是为了核对上游**有没有回显我们下发的思考档位**：`model_config` 是
     * 首个模型事件，它若回显了档位字段，那就是「档位真的被采纳」的直接证据 ——
     * 只看我们自己的日志只能证明「我们发了」，证明不了「上游收了」。
     */
    onFirstModelEvent?: (name: string, data: Record<string, any>) => void
  }
): AsyncGenerator<TraeRemoteEvent> {
  const base = remoteBaseUrl(opts?.baseUrl)
  const url = `${base}${TRAE_REMOTE_CONSTANTS.EpRemoteSessions}/${sessionId}/events`
    + `?reply_to_message_id=${encodeURIComponent(messageId)}`
  const firstEventTimeoutMs = opts?.firstEventTimeoutMs ?? TRAE_REMOTE_FIRST_EVENT_TIMEOUT_MS
  const idleTimeoutMs = opts?.idleTimeoutMs ?? TRAE_REMOTE_STREAM_TIMEOUT_MS

  // 建连死线：只覆盖「到响应头」。响应头一到就解除，剩下的交给每次读取的空闲死线。
  // 用 AbortController 而不是 AbortSignal.timeout：后者无法在中途解除，会把整条流
  // 按总时长掐死（见 readWithDeadline 注释）。
  const controller = new AbortController()
  const connectTimer = setTimeout(
    () => controller.abort(new Error(`connect timeout ${TRAE_REMOTE_CONNECT_TIMEOUT_MS}ms`)),
    TRAE_REMOTE_CONNECT_TIMEOUT_MS
  )
  let resp: Response
  try {
    resp = await fetch(url, {
      method: 'GET',
      headers: remoteHeaders(account, true, { baseUrl: opts?.baseUrl, agentType: opts?.agentType }),
      signal: controller.signal,
    })
  } catch (e) {
    clearTimeout(connectTimer)
    const err = new Error(`remote events transport error: ${(e as Error).message || String(e)}`) as Error & { kind?: TraeErrKind }
    ;(err as any).kind = 'transport'
    throw err
  }
  clearTimeout(connectTimer)
  if (resp.status >= 400 || !resp.body) {
    const raw = await resp.text().catch(() => '')
    const err = new Error(`Trae remote events [${resp.status}]: ${raw.slice(0, 500)}`) as Error & { kind?: TraeErrKind; status?: number; msg?: string }
    ;(err as any).kind = resp.status === 401 ? 'session_dead' : resp.status >= 500 ? 'server' : 'client'
    ;(err as any).status = resp.status
    ;(err as any).msg = raw.slice(0, 500)
    throw err
  }

  const reader = resp.body.pipeThrough(new TextDecoderStream()).getReader()
  const firstDeadline = firstEventTimeoutMs > 0 ? Date.now() + firstEventTimeoutMs : null
  let sawModelEvent = false
  let sawTerminal = false
  let lineBuffer = ''
  let eventName: string | null = null
  let rawHeadSeen = false

  /** 解析一条 SSE 行；返回事件或 null。 */
  const parseLine = (line: string): TraeRemoteEvent | null => {
    const trimmed = line.replace(/\r$/, '')
    if (trimmed.startsWith(':')) return null // SSE 注释/心跳行
    if (trimmed.startsWith('event:')) {
      eventName = trimmed.slice(6).trim()
      return null
    }
    if (trimmed === '') {
      eventName = null
      return null
    }
    if (!trimmed.startsWith('data:')) return null
    const payloadText = trimmed.slice(5).trim()
    if (payloadText === '[DONE]') return { event: 'done', data: {} }
    let data: Record<string, any>
    try {
      const parsed = JSON.parse(payloadText)
      data = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, any>
        : { value: parsed }
    } catch {
      data = { _raw: payloadText }
    }
    const name = normalizeRemoteEventName(eventName ?? data['event'] ?? 'message')
    eventName = null
    return { event: name, data }
  }

  try {
    while (true) {
      // 死线：首事件前用「首事件剩余预算」，之后用「每次读取之间的空闲上限」。
      // 这是**每次 read 各自的**上限，不是总时长（见 readWithDeadline 注释）。
      const budget = sawModelEvent
        ? idleTimeoutMs
        : (firstDeadline !== null ? Math.max(1, firstDeadline - Date.now()) : 0)
      let read: ReadableStreamReadResult<string>
      try {
        read = await readWithDeadline(reader, budget)
      } catch (e) {
        // 死线触发或读失败：先掐断底层连接（否则上游会跑完并继续烧额度），再定责。
        try { controller.abort(e) } catch { /* 已 abort */ }
        const reason = (e as Error).message || String(e)
        if (!sawModelEvent) {
          throw new RemoteFirstEventTimeout(`Trae remote session emitted no model event before the first-event deadline: ${reason}`)
        }
        throw new RemoteStreamIncomplete(`Trae remote event stream stalled after upstream activity began: ${reason}`)
      }
      if (read.done) break
      const chunk = read.value ?? ''
      lineBuffer += chunk
      // 诊断：首个**非空**字节片段原样上报 —— 用来判定上游到底发没发、发的什么形态。
      // 这是「会话建起来了但一直没内容」这类问题的唯一直接证据。
      if (!rawHeadSeen && chunk.trim() !== '') {
        rawHeadSeen = true
        if (opts?.onRawHead) { try { opts.onRawHead(lineBuffer.slice(0, 400)) } catch { /* 诊断不影响流 */ } }
      }
      const lines = lineBuffer.split('\n')
      lineBuffer = lines.pop() ?? ''
      for (const line of lines) {
        const ev = parseLine(line)
        if (!ev) continue
        if (ev.event === 'error' && !sawModelEvent) {
          const code = String(ev.data['code'] ?? '').trim()
          const message = String(ev.data['message'] ?? ev.data['error'] ?? ev.data['detail'] ?? 'remote session setup failed').trim()
          throw new RemoteFirstEventError(`Trae remote upstream error${code ? ' ' + code : ''}: ${message}`)
        }
        if (REMOTE_MODEL_EVENTS.has(ev.event)) {
          if (!sawModelEvent && opts?.onFirstModelEvent) {
            try { opts.onFirstModelEvent(ev.event, ev.data) } catch { /* 诊断不影响流 */ }
          }
          sawModelEvent = true
        }
        if (ev.event === 'done') sawTerminal = true
        yield ev
      }
    }
    if (lineBuffer.trim().startsWith('data:')) {
      const ev = parseLine(lineBuffer.trim())
      if (ev) {
        if (ev.event === 'done') sawTerminal = true
        yield ev
      }
    }
  } finally {
    await reader.cancel().catch(() => { /* 取消失败不影响已产出的事件 */ })
  }

  if (!sawModelEvent) {
    // 源侧同款定责（`StopAsyncIteration` → RemoteFirstEventTimeout）：会话建起来了、
    // 但一个模型事件都没出。这与「截断」是**两回事**——截断意味着已经有产出，
    // 重试会重复计费；而这里还没有任何产出，换号重试是安全的。
    throw new RemoteFirstEventTimeout('Trae remote session ended before its first model event')
  }
  if (!sawTerminal) {
    // 源侧同款定责：上游会静默关连接，半句话不得当正常收尾。
    throw new RemoteStreamIncomplete('Trae remote event stream ended without a done event')
  }
}

/** 给一次异步生成器的 `next()` 套死线（预读用；语义同 readWithDeadline）。 */
function nextWithDeadline<T>(gen: AsyncGenerator<T>, ms: number): Promise<IteratorResult<T>> {
  if (!(ms > 0)) return gen.next()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new RemoteReadTimeout(`no model event for ${ms}ms`)), ms)
    gen.next().then(
      (r) => { clearTimeout(timer); resolve(r) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

/**
 * 预读**首个模型事件** —— 把「会话建起来了但 executor 不启动」在**建流之前**暴露出来。
 *
 * 为什么必须提前读、不能等翻译层报错：源侧正是在 `RemoteFirstEventTimeout` 时才决定回落到
 * Work 档位（`work_fallback_options`）。而一旦我们已经把 `200` + SSE 响应头返回给客户端，
 * **就再也没有机会换档位了**（响应头已发出，改不了）。所以必须在返回 Response 之前读到
 * 首个模型事件，把「换档位」这个决定留在还来得及的时候。
 *
 * 返回 `[首个模型事件, 续流生成器]`；续流**先重放预读到的帧**，所以预读不丢帧、不重排。
 *
 * 失败一律归到 `RemoteFirstEventTimeout` / `RemoteFirstEventError`（都是可换号的
 * transport 类失败），让调用方只需判这两类。
 */
export async function preflightFirstModelEvent(
  events: AsyncGenerator<TraeRemoteEvent>,
  firstEventTimeoutMs: number
): Promise<{ head: TraeRemoteEvent; rest: AsyncGenerator<TraeRemoteEvent> }> {
  const buffered: TraeRemoteEvent[] = []
  const deadline = firstEventTimeoutMs > 0 ? Date.now() + firstEventTimeoutMs : null
  for (;;) {
    const budget = deadline !== null ? Math.max(1, deadline - Date.now()) : 0
    let next: IteratorResult<TraeRemoteEvent>
    try {
      next = await nextWithDeadline(events, budget)
    } catch (e) {
      // 上游给了**明确判决**（带 HTTP 状态码：401 禁用 / 429 软冷却 / 5xx 累计）→ 原样上抛。
      // 这属于**账号级**定责，不该被档位兜底盖掉
      //（源侧同款：`_stream_events_unbounded` 的 status 错误直接冒泡，不触发 work fallback）。
      if ((e as { status?: number }).status !== undefined) throw e
      // 建会话后上游立刻报错（executor 起不来）→ 仍属「首事件前失败」，可换档位。
      if (e instanceof RemoteFirstEventError) throw e
      // 不在这里主动 `return()` 关流：底层生成器里还有一条**自己的**首事件死线，它会在
      // 同一预算到达时 abort 连接 —— 连接不会漏，也就不用 fire-and-forget 一个可能挂住的清理。
      if (e instanceof RemoteFirstEventTimeout || e instanceof RemoteReadTimeout) {
        // 报**总预算**而不是最后一个窗口的剩余量：后者会让人误以为死线只有几秒
        //（实测踩过：日志写 `no model event for 4760ms`，实际已经等满 120s）。
        throw new RemoteFirstEventTimeout(
          `Trae remote session emitted no model event within ${firstEventTimeoutMs}ms (last window: ${(e as Error).message})`
        )
      }
      throw new RemoteFirstEventTimeout(
        `Trae remote event stream failed before its first model event: ${(e as Error).message}`
      )
    }
    if (next.done) {
      throw new RemoteFirstEventTimeout('Trae remote session ended before its first model event')
    }
    buffered.push(next.value)
    if (REMOTE_MODEL_EVENTS.has(next.value.event)) {
      const head = next.value
      const rest = (async function* replayPreflight() {
        for (const ev of buffered) yield ev
        for await (const ev of events) yield ev
      })()
      return { head, rest }
    }
  }
}

// ===== 停止会话 =====

/**
 * 尽力停止远端会话（源侧 `stop_session`）。
 *
 * **全程吞异常**：这是清理动作，失败不影响本次响应——调用方已经拿到（或已经放弃）
 * 结果了。刻意不 await 它的失败。
 */
export async function stopRemoteSession(
  account: TraeAccount,
  sessionId: string,
  messageId: string,
  opts?: { baseUrl?: string | null; agentType?: string }
): Promise<void> {
  if (!sessionId || !messageId || !account.accessToken) return
  try {
    await fetch(`${remoteBaseUrl(opts?.baseUrl)}${TRAE_REMOTE_CONSTANTS.EpRemoteSessions}/${sessionId}/stop`, {
      method: 'POST',
      headers: remoteHeaders(account, false, { baseUrl: opts?.baseUrl, agentType: opts?.agentType }),
      body: JSON.stringify({ chat_session_id: sessionId, user_message_id: messageId }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    /* 清理失败无所谓 */
  }
}
