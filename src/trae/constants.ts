/**
 * constants.ts — TRAE SOLO 上游技术常量（移植自 traework2api/internal/upstream/constants.go，实测值，禁止改动）。
 */
export const TRAE_CONSTANTS = {
  AgentHost: 'https://trae-api-cn.mchost.guru',
  UgHost: 'https://api.trae.cn',
  OAuthHost: 'https://api.trae.com.cn',
  ConsoleHost: 'https://www.trae.cn',
  ClientID: 'en1oxy7wnw8j9n', // SOLO stable
  AppID: '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
  IdeVersion: '0.1.43',
  IdeVersionCode: '20260716',
  DeviceBrand: '83DG',
  OSVersion: 'Windows 11 Pro',
  Function: 'solo_work_lite',

  // 端点
  EpChat: '/api/agent/v3/llm_utils_chat',
  EpModels: '/api/ide/v1/get_detail_param',
  EpExchange: '/cloudide/api/v3/trae/oauth/ExchangeToken',
  EpUserInfo: '/cloudide/api/v3/trae/GetUserInfo',
  EpCheckinStatus: '/trae/api/v2/ug/checkin_credits/status',
  EpCheckinClaim: '/trae/api/v2/ug/checkin_credits/claim',
  EpEntUsage: '/trae/api/v2/pay/ide_user_ent_usage',
} as const

export const TRAE_UA = `Trae/${TRAE_CONSTANTS.IdeVersion}`

/** 默认模型（实测可用） */
export const TRAE_DEFAULT_MODEL = 'glm-5.2'

/**
 * 流式响应心跳：距上次向客户端输出超过该值即注入 `: keep-alive\n\n` SSE 注释行。
 * TRAE 思考模型在推理阶段可能长时间不发数据，客户端（AI SDK / iOS 严格解析器）通常
 * 有 ~15s 的空闲超时，无数据即判定流结束 → 回答被截断（用户实测 15~20s 自动停止）。
 * 心跳注释行客户端会忽略但能重置 idle 计时器（同 opencode 的 OPENCODE_KEEPALIVE_MS）。
 */
export const TRAE_KEEPALIVE_MS = 8000

/** 流式 idle 兜底：上游超过该时长完全无数据视为挂起，主动结束流（防无限挂起）。 */
export const TRAE_STREAM_IDLE_TIMEOUT_MS = 180000

/** chatStream 连接+响应头超时：仅覆盖建立连接与收到响应头的阶段，响应头到达后取消。 */
export const TRAE_CHAT_CONNECT_TIMEOUT_MS = 30000

/** 静态 SOLO 模型表（32 个 config_name，来自逆向报告；动态拉取失败时回退） */
export const TRAE_STATIC_MODEL_IDS: string[] = [
  'Doubao-Seed-2.1-Pro',
  'seed-code-pro-0430',
  'Doubao-Seed-2.1-Turbo',
  'Doubao-Seed-2.0-Code',
  'DeepSeek-V4-Flash-Official',
  'browser_use_subagent',
  'glm-5.2',
  'glm-5-turbo',
  'glm-5',
  'DeepSeek-V4-Pro',
  'DeepSeek-V4-Flash',
  'kimi-k3',
  'kimi-k2.7-code',
  'kimi-k2.6',
  'minimax-m3',
  'qwen-3.7-plus',
  'sagitta',
  'aquila',
  'custom_model_gemini',
  'custom_model_placeholder',
  'custom_model_1M_text',
  'custom_model_1M',
  'custom_model_kimi',
  'custom_model_claude',
  'custom_model_gpt-5',
  'custom_model_no-fc',
  'custom_model_deepseek_chat',
  'custom_model_deepseek_reasoner',
  'custom_model_deepseek_v4',
  'explore_sub_agent_v13',
  'explore_sub_agent_v2',
  'summary',
]

/** OpenAI 模型列表条目（静态回退用，created 用固定值保持稳定） */
export const TRAE_STATIC_MODELS = TRAE_STATIC_MODEL_IDS.map((id) => ({
  id,
  object: 'model',
  created: 1753600000,
  owned_by: 'trae-solo',
  context_length: 131072,
}))

/** 模型名归一化：下划线 → 横线，首字母大写（deepseek_v4_pro → DeepSeek-V4-Pro） */
export function normalizeTraeModelName(s: string): string {
  const parts = s.split('_')
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '') continue
    parts[i] = parts[i][0].toUpperCase() + parts[i].slice(1).toLowerCase()
  }
  return parts.join('-')
}
