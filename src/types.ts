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
}

/** OAuth 认证配置（authType === 'oauth-device' 时生效） */
export interface OAuthDeviceConfig {
  /**
   * 登录流程类型：
   * - device：标准设备码（RFC 8628）— 申请 device_code，用户在浏览器输入 user_code
   * - browser：浏览器登录 — POST deviceCodeUrl 拿到登录链接（authUrl），用户打开网页登录后轮询拿 token
   */
  flowType?: 'device' | 'browser'
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
}

/** 进行中的设备码/浏览器登录流程状态 */
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
  flowType?: 'device' | 'browser'
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
  messages?: Array<{ role: string; content: string }>
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
}
