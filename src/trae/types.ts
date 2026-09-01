/**
 * types.ts — TRAE SOLO 账号 / 账号池 / SSE 事件类型（移植自 traework2api）。
 */

/** 上游错误分类（SPEC §4.3），pool 据此决定冷却时长 */
export type TraeErrKind =
  | 'none'        // 成功
  | 'plan_limit'  // 1005 + plan → 权益不足（硬冷却 12h）
  | 'soft_rate'   // 429 → 短冷却 60s
  | 'session_dead'// 401 + Cloud-IDE-JWT 失效 → 禁用
  | 'not_found'   // 404 → 短冷却 60s 不累计 errCount
  | 'server'      // 5xx
  | 'client'      // 其他 4xx
  | 'transport'   // 网络/连接中断（建连超时、客户端掐断等），与账号健康无关，不惩罚账号

/** 归一化后的账号凭证（持久化为 JSON 存在 provider.apiKeys 中，每个 key 一行一个账号） */
export interface TraeAccount {
  /** Cloud-IDE-JWT 头用 */
  accessToken: string
  /** 每次 ExchangeToken 轮换 */
  refreshToken: string
  /** Unix 秒（accessToken 过期时刻） */
  expiresAt: number
  /** ExchangeToken/GetUserInfo host */
  apiHost?: string
  /** "trae.cn"（CN）/ "trae.com"（Global）等 */
  domain?: string
  machineId?: string
  deviceId?: string
  uid: string
  enterpriseId?: string
  nickname?: string
}

/** 账号池条目状态（存在 KV trae:pool:<providerId>，跨 isolate 共享冷却/禁用/积分） */
export interface TraeAccountState {
  credits: number
  disabled: boolean
  reason?: string
  /** 冷却至 epoch ms；0 = 无冷却 */
  until: number
  errCount: number
  /** 账号级并发占用会话数（特性A 并发信号量） */
  activeSessions?: number
  /** 最近一次活跃会话时刻 epoch ms（特性A 空闲回收用） */
  lastActiveAt?: number
}

/** 账号池：uid → 状态 */
export type TraePool = Record<string, TraeAccountState>

/** 对外暴露的账号状态（脱敏，不含 token），供 /status 与面板展示 */
export interface TraeAccountStatus {
  uid: string
  nickname?: string
  credits: number
  cooling: boolean
  until?: number
  reason?: string
  disabled: boolean
  errCount: number
}

/** 单条 SOLO SSE 事件（归一化） */
export interface SOLOEvent {
  event: string // metadata | timing_cost | output | extra_info | token_usage | done | error
  response: string // output: content 增量
  reasoning: string // output: 思考链增量
  toolCalls: unknown // output: 工具调用（null 或对象/数组）
  usage: Record<string, any> | null // token_usage
  finishReason: string // done
  errorCode: number // error
  errorMessage: string // error
}

/** 上游 SSE 流内的业务错误（event:error），非流式聚合时返回，调用方可据此分类冷却并轮转 */
export interface SOLOStreamError {
  code: number
  msg: string
}

/** 动态模型信息（get_detail_param） */
export interface TraeModelInfo {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
}

/** 登录流程中间状态（存在 KV trae:login:<providerId>） */
export interface TraeLoginState {
  machineId: string
  deviceId: string
  loginTraceId: string
  createdAt: number
}

/** 签到结果（面板展示，存 KV trae:checkin:<providerId>） */
export interface TraeCheckinResult {
  uid: string
  nickname?: string
  success: boolean
  message: string
  checkedIn: boolean
  credits?: number
  updatedAt: number
}
