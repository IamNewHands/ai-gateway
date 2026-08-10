export interface Model {
  id: string
  enabled: boolean
}

export interface ApiKeyEntry {
  key: string
  enabled: boolean
}

export interface Provider {
  id: string
  name: string
  baseUrl: string
  apiType?: 'openai' | 'anthropic'
  /** 认证方式：api-key（普通 API Key） | oauth-device（OAuth 设备码登录） */
  authType?: 'api-key' | 'oauth-device'
  /** OAuth 设备码认证配置（authType === 'oauth-device' 时生效） */
  oauth?: OAuthDeviceConfig
  apiKeys: ApiKeyEntry[]
  models: Model[]
  enabled: boolean
  createdAt: string
  updatedAt: string
  /**
   * 提供商类型扩展（可选项）：
   * - 'vision-bridge'：图片转写桥。自身不直连上游，将含图请求的图片先交给视觉模型链
   *   （visionBridge.vision）转写为文本，再连同原文本一起转发给主文本模型（visionBridge.primary）。
   *   对不支持图片输入的模型开放图片能力。
   */
  type?: 'vision-bridge'
  /** type === 'vision-bridge' 时的桥配置 */
  visionBridge?: VisionBridgeConfig
}

/**
 * Vision Bridge（图片转写桥）配置。
 * - 独立桥模式（type === 'vision-bridge'）：primary 必填，客户端请求该桥的任何模型
 *   都会改写 model 后转发到 primary 引用。
 * - 提供商级共享识图模式（type 不填）：primary 留空，请求仍转发到本提供商当前模型，
 *   只把含图请求自动转写为文本——一个提供商配一次识图模型，其下所有模型自动受益。
 */
export interface VisionBridgeConfig {
  /** 主文本模型引用（providerId/modelId）。留空 = 转发到本提供商当前的请求模型 */
  primary?: string
  /** 视觉模型链（providerId/modelId 数组），按顺序尝试，前一个失败自动回退下一个 */
  vision: string[]
  /** 视觉转写全部失败时的处理策略：error（直接报错，默认） | text_only（丢弃图片仅转发文本） */
  onVisionFailure?: 'error' | 'text_only'
  /** 发送给视觉模型的转写提示词（可选），默认：用中文详细描述图片内容 */
  visionPrompt?: string
}

/** OAuth 认证配置（authType === 'oauth-device' 时生效） */
export interface OAuthDeviceConfig {
  /**
   * 登录流程类型：
   * - device：标准设备码（RFC 8628）— 申请 device_code，用户在浏览器输入 user_code
   * - browser：浏览器登录 — POST deviceCodeUrl 拿到登录链接（authUrl），用户打开网页登录后轮询拿 token
   * - qoder：QoderWork 设备授权（PKCE）— 本地构造 selectAccounts 授权链接，用户浏览器授权后轮询拿 dt-/drt- token
   * - gemini：Gemini CLI（Google OAuth）— 标准授权码 + PKCE(S256) + offline/consent，
   *   网关无法监听本地回调端口，用户授权后把回调 URL（含 code）粘贴回后台完成换 token
   */
  flowType?: 'device' | 'browser' | 'qoder' | 'gemini'
  /**
   * 设备码申请端点 / 浏览器登录发起端点：
   * - device 模式：POST, x-www-form-urlencoded, 需 client_id，返回 device_code/user_code
   * - browser 模式：POST, JSON body {}，返回 {code,msg,data:{state, authUrl}}
   */
  deviceCodeUrl: string
  /**
   * 轮询端点：
   * - device 模式：POST, x-www-form-urlencoded, 提交 device_code
   * - browser 模式：GET，追加 ?state=xxx 轮询，返回 {code,msg,data:{accessToken,refreshToken,expiresIn,domain}}
   */
  deviceTokenUrl: string
  /**
   * token 刷新端点：
   * - device 模式：POST, JSON: {refresh_token, client_id}
   * - browser 模式：POST, header X-Refresh-Token: <refresh_token>
   */
  refreshTokenUrl: string
  /** OAuth 应用 client_id（browser 模式可留空） */
  clientId: string
  /** OAuth 应用 client_secret（gemini 模式必填；其余模式可留空） */
  clientSecret?: string
  /** 申请的 scope（可选） */
  scope?: string
  /** 轮询间隔（秒），默认 5 */
  pollInterval?: number
  /** access_token 注入到上游请求的哪个头，默认 x-api-key；browser 模式建议 Authorization */
  tokenHeader?: string
  /** token 注入时的值前缀，例如 "Bearer "（配合 Authorization 使用） */
  tokenHeaderPrefix?: string
  /** 转发时额外注入的固定请求头 */
  extraHeaders?: Record<string, string>
  /**
   * 模型列表发现端点（绝对 URL，GET）。
   * 留空则回退到 `${baseUrl}/models`（OpenAI 标准）。
   * WorkBuddy 等自定义 API 需填写，例如：
   * https://copilot.tencent.com/console/enterprises/personal/models
   */
  modelsUrl?: string
  /**
   * Global 域（海外账户，JWT iss 含 workbuddy.ai）的备选端点。
   * WorkBuddy 的 Global token 必须走 www.workbuddy.ai，否则
   * copilot.tencent.com 的 APISIX 会返回 401。留空则不区分域。
   */
  globalBaseUrl?: string
  globalModelsUrl?: string
  globalOrigin?: string
}

/** KV 中保存的 OAuth token 状态 */
export interface OAuthTokenState {
  access_token: string
  refresh_token?: string
  /** 过期时间（epoch ms） */
  expires_at: number
  updated_at: number
  /** browser 模式：发起登录时上游返回的 Set-Cookie，后续请求需复用 */
  cookies?: string
  /** qoder 设备授权返回的用户 ID（轮询/刷新响应携带），用于 COSY 签名 uid */
  user_id?: string
  /** qoder 账号昵称（轮询/刷新后按需回填） */
  nickname?: string
  /** gemini 模式：已授权的 Google 账号邮箱（userinfo 拉取） */
  email?: string
  /** gemini 模式：CodeAssist 项目 ID，cloudcode-pa 请求包装（{"project": ...}）需要 */
  projectId?: string
  /** gemini 模式：该账号可用的项目 ID 列表（cloudresourcemanager 拉取） */
  projectIds?: string[]
}

/** 进行中的设备码/浏览器/Qoder 登录流程状态 */
export interface DeviceFlowState {
  /** device 模式：device_code；browser 模式：state */
  device_code: string
  /** device 模式：用户码；browser 模式：空 */
  user_code: string
  /** device 模式：验证链接；browser 模式：登录页 authUrl */
  verification_uri: string
  interval: number
  expires_at: number
  /** 流程类型，用于轮询时分发 */
  flowType?: 'device' | 'browser' | 'qoder' | 'gemini'
  /**
   * browser 模式：发起登录时上游返回的 Set-Cookie。
   * cpa-plugin 强调 must reuse the same cookie jar，否则 token 无效导致 401。
   * 多个 cookie 用 "; " 分隔存储。
   */
  cookies?: string
  /** qoder/gemini 模式：PKCE code_verifier（换 token / 轮询时必须提交） */
  verifier?: string
  /** qoder 模式：设备授权 nonce（与授权链接配对） */
  nonce?: string
}

export interface ProxyKey {
  id: string
  key: string
  name: string
  enabled: boolean
  createdAt: string
  expiresAt?: string | null
  /** 允许的模型列表（含提供商前缀，如 "deepseek/deepseek-chat"）。空或不存在 = 全部允许 */
  allowedModels?: string[]
}

export interface Session {
  username: string
  expiresAt: number
}

export interface ProxyRequestBody {
  model?: string
  /**
   * 消息数组。content 可能是字符串，也可能是包含 text/image_url 等类型块的数组
   * （Vision Bridge 等图片处理会改写 messages），故放宽为宽松记录类型。
   */
  messages?: Array<Record<string, unknown>>
  [key: string]: unknown
}

export interface TestModelRequest {
  modelId: string
}

export interface CreateProviderRequest {
  id: string
  name: string
  baseUrl: string
  apiType?: 'openai' | 'anthropic'
  authType?: 'api-key' | 'oauth-device'
  oauth?: OAuthDeviceConfig
  apiKeys?: Array<{ key: string; enabled: boolean }>
  models?: Array<{ id: string; enabled: boolean }> | string[]
  enabled?: boolean
  type?: 'vision-bridge'
  visionBridge?: VisionBridgeConfig
}

export interface UpdateProviderRequest {
  name?: string
  baseUrl?: string
  apiType?: 'openai' | 'anthropic'
  authType?: 'api-key' | 'oauth-device'
  oauth?: OAuthDeviceConfig
  apiKeys?: Array<{ key: string; enabled: boolean }>
  models?: Array<{ id: string; enabled: boolean }> | string[]
  enabled?: boolean
  /** 传 null 可清除已设置的 type（如从独立桥恢复为普通提供商） */
  type?: 'vision-bridge' | null
  visionBridge?: VisionBridgeConfig | null
}

/**
 * 对外管理 API 的 upsert 请求体。
 * - id 必填：存在则合并，不存在则创建。
 * - 不含 oauth：OAuth 走管理后台 UI，脚本不碰。
 * - apiKeys/models 既支持字符串（追加为 enabled:true），也支持完整对象。
 * - key 元素不带 enabled：脚本只负责增 key，启停交给 UI。
 * 合并语义：keys/models 只增不删，key 字符串去重。
 */
export interface UpsertProviderRequest {
  id: string
  name?: string
  baseUrl?: string
  apiType?: 'openai' | 'anthropic'
  authType?: 'api-key' | 'oauth-device'
  apiKeys?: Array<ApiKeyEntry | string>
  models?: Array<Model | string>
  enabled?: boolean
}

/**
 * WorkBuddy/CodeBuddy 每日签到结果。
 * 存于 KV（CHECKIN_RESULT_PREFIX + providerId），管理后台面板展示。
 */
export interface CheckinResult {
  providerId: string
  name: string
  /** 账号领域：cn 可签到，global 跳过 */
  realm: 'cn' | 'global' | 'unknown'
  success: boolean
  /** ok | already | skipped_global | skipped_no_token | fail */
  reason: string
  message: string
  todayCheckedIn: boolean
  streakDays?: number
  totalCredits?: number
  dailyCredit?: number
  /** 上次签到时间（epoch ms） */
  lastCheckinAt?: number
  updatedAt: number
  // ===== 额度信息（来自 get-user-resource，仅 CN 有效） =====
  /** 可用余额 */
  totalRemain?: number
  /** 已用 */
  totalUsed?: number
  /** 额度池（总容量） */
  totalSize?: number
  /** 包数量 */
  packCount?: number
  /** 套餐类型：free / paid 等 */
  paymentType?: string
  /** 账号昵称（JWT 解出，解不出则留空） */
  nickname?: string
  /** 权益包明细（每个包的名称 + 到期时间），来自 get-user-resource Accounts[] */
  packages?: PackageInfo[]
}

/** 单个权益包信息（来自 get-user-resource 的 Accounts[] 元素） */
export interface PackageInfo {
  /** 包名，如 "CodeBuddy个人体验版" */
  name: string
  /** 到期时间（原始字符串）。空串表示未设置过期时间（通常为长期/按周期滚动） */
  expireAt: string
  /** 本周期结束时间（月度额度周期），如 "2026-08-31 23:59:59" */
  cycleEndTime?: string
  /** 该包已用额度（优先本周期 CycleCapacityUsed，回退整包 CapacityUsed） */
  used?: number
  /** 该包总额度（优先本周期 CycleCapacitySize，回退整包 CapacitySize） */
  size?: number
  /** 额度单位，如 credits */
  unit?: string
}

export interface CreateProxyKeyRequest {
  name?: string
  expiresIn?: string // '30d' | '90d' | '180d' | '1y' | 'forever'
}

export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  message?: string
}

export interface Env {
  KV: KVNamespace
  ADMIN_USERNAME?: string
  ADMIN_PASSWORD?: string
  OPENCODE_MIRRORS_URL?: string
  /** 对外管理 API 的认证 Token；未配置时 /api/manage/* 返回 503 */
  MANAGEMENT_TOKEN?: string
  /** Gemini OAuth 客户端凭据（官方公开凭据，避免硬编码进代码） */
  GEMINI_OAUTH_CLIENT_ID?: string
  GEMINI_OAUTH_CLIENT_SECRET?: string
  USAGE_ANALYTICS?: AnalyticsEngineDatasetBinding
  USAGE_ANALYTICS_DATASET?: string
  CF_ACCOUNT_ID?: string
  CF_API_TOKEN?: string
}

export interface AnalyticsEngineDatasetBinding {
  writeDataPoint(point: {
    indexes?: string[]
    blobs?: string[]
    doubles?: number[]
  }): void
}

export interface AppVariables {
  username?: string
  proxyKey?: ProxyKey
  proxyKeyHash?: string
}

export type AppEnv = {
  Bindings: Env
  Variables: AppVariables
}
