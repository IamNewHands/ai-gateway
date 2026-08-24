export interface Model {
  id: string
  enabled: boolean
}

/**
 * 账号池冷却参数（trae 与 workbuddy 账号池共用，provider.cooldown 可覆盖默认值）。
 * 对齐 workbuddy-wild 的 cooldown.* 配置：余额不足（plan）/ 429（soft）/ 连续错误。
 * 单位均为毫秒；errThreshold 为连续错误触发冷却的阈值（次）。
 */
export interface CooldownConfig {
  /** plan 权益不足长冷却（ms） */
  planMs?: number
  /** 429 短冷却（ms） */
  softMs?: number
  /** 连续错误触发冷却的阈值（次） */
  errThreshold?: number
  /** 连续错误冷却（ms） */
  errMs?: number
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
  /**
   * 工具桥开关（当前用于 CNB 提供商）。上游禁原生 tools（403 Agent calls not allowed），
   * 开启后网关把客户端 tools 转成 XYML 提示词注入（见 src/cnb/xyml.ts），
   * 并将模型输出的 XYML 文本流式解析回标准 tool_calls 返回客户端。
   */
  toolBridge?: boolean
  /**
   * CNB 凭证池配置（仅 cnb 提供商生效，见 src/cnb/proxy.ts）。
   * CNB 免登录凭证是匿名单会话（csrfkey + csrftoken 配对），单会话并发受限；
   * 池 = 多个独立会话 round-robin 轮转，提升并发与稳定性，过期/失败自动淘汰补证。
   * 不配则用默认值：min=2 / max=8 / ttl=30 分钟。
   */
  cnbPool?: { min?: number; max?: number; ttlMinutes?: number }
  /**
   * 账号池冷却参数（trae 与 workbuddy 账号池共用）。不配则用各池默认值。
   */
  cooldown?: CooldownConfig
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
  /**
   * 允许未配置模型透传（P6 后台开关，从 aihub 移植）。
   * 开启后，请求该提供商的任意 modelId 都直接转发（跳过"模型未配置"校验），
   * 适合模型频繁新增上架、不想每次后台手动加模型的提供商（如 OpenRouter）。
   * 关闭（默认）则保持原有预配置校验。
   */
  allowUnlistedModels?: boolean
  /**
   * TRAE 首选账号 UID（面板下拉框手工指定，仅 trae 提供商生效）。
   * 填写后转发时优先使用该账号（按 uid 精确匹配），
   * 被冷却/禁用/失败时才回退到池内其他账号。留空 = 维持按剩余积分自动挑选。
   */
  preferTraeUid?: string
  /**
   * 思维模式引导注入（provider 级勾选哪些模型启用）。
   * 值为需注入的模型 ID 数组（如 ['deepseek-v4-flash']）。命中的模型在转发前会被注入
   * 一段固定的思维引导 system 提示词（见 src/thinking.ts），未勾选的模型原样转发。
   * 留空/不配 = 全部模型不注入，零影响。
   */
  thinkingInject?: string[]
  /**
   * 缓存前缀注入（provider 级勾选哪些模型启用）。
   * 值为需注入的模型 ID 数组。命中的模型在转发前会被注入一段固定的缓存前缀
   * system 提示词（见 src/cache-prefix.ts），利用上游前缀缓存降低 token 成本。
   * 未勾选的模型原样转发。留空/不配 = 全部模型不注入，零影响。
   */
  cachePrefixInject?: string[]
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
   * - m365-pkce：M365 Copilot（微软 Entra ID）— 标准授权码 + PKCE(S256)+offline，
   *   网关无法监听本地回调端口，用户授权后把回调 URL 粘贴回后台完成换 token（同 gemini）
   * - m365-ropc：M365 Copilot（资源所有者密码凭据）— 直接填写企业订阅账号/密码换 token
   */
  flowType?: 'device' | 'browser' | 'qoder' | 'gemini' | 'm365-pkce' | 'm365-ropc'
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
  /** OAuth 回调地址（gemini/m365-pkce 模式可用；留空走官方默认） */
  redirectUri?: string
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
  /**
   * Global 域（海外账户，workbuddy.ai）的 OAuth 登录端点（browser 模式专用）。
   * 与 deviceCodeUrl/deviceTokenUrl/refreshTokenUrl 同协议，只是换到 www.workbuddy.ai 域。
   * 留空则对应操作只能走 CN 端点。
   */
  globalDeviceCodeUrl?: string
  globalDeviceTokenUrl?: string
  globalRefreshTokenUrl?: string
  /**
   * 发起浏览器登录时使用的域（browser 模式）。
   * 'cn'（默认）走 copilot.tencent.com 端点；'global' 走 www.workbuddy.ai 端点。
   * 仅影响登录流程；登录成功后 token 的 CN/Global 域仍按 JWT iss 自动路由。
   */
  loginRealm?: 'cn' | 'global'
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
  /** m365 模式：Entra ID 对象的 Object ID（ChatHub WS 需要） */
  oid?: string
  /** m365 模式：Entra ID 租户 ID（ChatHub WS 需要） */
  tid?: string
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
  flowType?: 'device' | 'browser' | 'qoder' | 'gemini' | 'm365-pkce' | 'm365-ropc'
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
  /** browser 模式：本次登录使用的域（发起时按 cfg.loginRealm 固化，轮询/刷新时复用） */
  loginRealm?: 'cn' | 'global'
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

/**
 * MCP Server 配置（MCP 聚合网关用）。
 * 网关聚合多个 MCP Server 的工具列表并统一路由 tools/call。
 * 工具名命名空间：`${name(空格转下划线)}-${工具名}`。
 */
export interface McpServer {
  id: string
  name: string
  url: string
  /** 请求上游时附加的 HTTP 头（如鉴权头） */
  httpHeaders: Record<string, string>
  enabled: boolean
  createdAt: string
  updatedAt: string
}

/**
 * 联合模型（uni-model）：一个逻辑模型名映射一组 `提供商ID/模型ID`，
 * 调用时按顺序逐个 failover，第一个成功即返回。模型 ID 形如 `unimodel/xxx`。
 */
export interface UniModel {
  id: string
  name: string
  /** 候选模型引用列表，格式 `providerId/modelId`，按顺序 failover */
  models: string[]
  enabled: boolean
  createdAt: string
  updatedAt: string
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
  toolBridge?: boolean
  cnbPool?: { min?: number; max?: number; ttlMinutes?: number }
  cooldown?: CooldownConfig
  allowUnlistedModels?: boolean
  thinkingInject?: string[]
  cachePrefixInject?: string[]
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
  /** 传 null 可清除工具桥开关 */
  toolBridge?: boolean | null
  cnbPool?: { min?: number; max?: number; ttlMinutes?: number } | null
  /** 传 null 可恢复各池默认冷却参数 */
  cooldown?: CooldownConfig | null
  allowUnlistedModels?: boolean
  /** 传空数组可清空思维引导注入选择 */
  thinkingInject?: string[] | null
  /** 传空数组可清空缓存前缀注入选择 */
  cachePrefixInject?: string[] | null
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
  toolBridge?: boolean
  cnbPool?: { min?: number; max?: number; ttlMinutes?: number }
  cooldown?: CooldownConfig
  allowUnlistedModels?: boolean
  thinkingInject?: string[]
  cachePrefixInject?: string[]
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
  /** 本次签到获得积分（仅签到成功当天有值，already 当天无） */
  checkinCredit?: number
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
  /**
   * WorkBuddy 多账号池：本 provider 下每个池账号的独立签到结果（池提供商才有）。
   * 面板可按账号逐条展示；汇总字段（success/credits 等）为池整体快照。
   */
  accounts?: CheckinResult[]
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
  /** 预设有效期（兼容旧版）：'30d' | '90d' | '180d' | '1y' | 'forever' */
  expiresIn?: string
  /** 自定义天数（优先级高于 expiresIn） */
  expiresInDays?: number
  /** 自定义小时数（优先级低于 expiresInDays） */
  expiresInHours?: number
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
  /** M365 Session Durable Object 绑定（承载 ChatHub WS 对话与会话串行化） */
  M365_SESSION: DurableObjectNamespace
  /** M365 账号级并发闸门 Durable Object（每 provider 一个，跨会话共享并发计数） */
  M365_FLUX: DurableObjectNamespace
  /** M365 每账号最大并发对话数（默认 8） */
  M365_ACCOUNT_DEFAULT_CONCURRENCY?: string
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
