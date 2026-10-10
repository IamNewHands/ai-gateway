/**
 * constants.ts — TRAE SOLO 上游技术常量（移植自 traework2api/internal/upstream/constants.go，实测值，禁止改动）。
 */
import { contextWindowListing, maxOutputTokensListing } from '../model-context-catalog'

export const TRAE_CONSTANTS = {
  AgentHost: 'https://trae-api-cn.mchost.guru',
  UgHost: 'https://api.trae.cn',
  OAuthHost: 'https://api.trae.com.cn',
  ConsoleHost: 'https://www.trae.cn',
  ClientID: 'en1oxy7wnw8j9n', // SOLO stable
  AppID: '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
  IdeVersion: '0.1.52',
  IdeVersionCode: '20260811',
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

/**
 * TRAE Work 专属通道常量（移植自 trae2api work_client.go）。
 */
export const TRAE_WORK_CONSTANTS = {
  WorkTargetHost: 'https://api5-normal.mchost.guru',
  WorkSoloHost: 'https://trae-api-cn.mchost.guru',
  WorkAppID: '931506',
  WorkAppIDChat: '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
  WorkIdeVersion: '0.1.63',
  WorkIdeVersionCode: '20260901',
  WorkAgentType: 'solo_work_lite',
  DefaultWorkModel: 'DeepSeek-V4-Flash-Official',

  // 端点
  EpCreateAgentTask: '/api/agent/v3/create_agent_task',
  EpWorkflowStart: '/api/agent/v3/workflow/start',
  EpQueryHistory: '/api/agent/v3/query_history_state',
  EpSyncHistory: '/api/agent/v3/sync_history_state',
} as const

export const TRAE_WORK_UA = `Trae/${TRAE_WORK_CONSTANTS.WorkIdeVersion}`

/** 判断是否属于 Work 专属通道模型（包含 work 或以 -Official 结尾） */
export function isWorkModel(model: string): boolean {
  const m = (model || '').trim().toLowerCase()
  if (m === 'work') return true
  return m.includes('work') || m.includes('agent') || model.includes('Flash-Official') || model.toLowerCase().endsWith('-official')
}

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

/**
 * 建连（fetch → 响应头）死线阶梯：同一条请求内逐段给死线，**段间立刻换一条新连接重发**。
 * 仅覆盖建立连接与收到响应头的阶段；响应头到达后计时取消，body 流交给上层 SSE 心跳/idle 兜底。
 *
 * 为什么分段而不是继续调单段上限（2026-10-09 落地）：
 *  - 坏连接是「死」不是「慢」。2026-10-08 的 30s→60s 单变量实验已证：给到 60s 照样不回响应头
 *    （`connect=60000ms timeout=true elapsed=60675ms`），而 0.5s 后重开连接的请求几秒内就完成
 *    ⇒ 等满上限没有任何收益，唯一有信息量的动作是「换一条连接」。
 *  - 线上会话实测（session-1e29c762，2026-10-09）：坏窗口里客户端白等 32.1s / 33.6s 并各收到
 *    一次 503，而它 0.5s 后的重试全部成功——这些等待与报错是纯浪费。
 *  ⇒ 每段只给 10s：活连接实测 1.5–9.2s 就出响应头，而死连接在 30s/60s 都不回（5/5 撞满），
 *    10s 后突然回话的概率极低。撞了就立刻重发。
 *
 * 为什么每段都是 10s（2026-10-10 由 [10s, 30s] 收紧）：
 *  落地时把最后一段留在 30s，理由是「只有 ≥ 原单段上限才能保证改前能成功的请求改后仍成功」，
 *  其前提是「10–30s 才出响应头的合法慢请求」存在。2026-10-10 拿到成功侧 `connect=` 分布后该前提
 *  被证伪：9 个样本全部 ≤ 9187ms（中位 2283ms），10–30s 区间仍是零样本。同一坏窗口里还有更直接
 *  的反证：21:25:06 两段皆死报 503，21:25:12 新连接 `connect=1820ms` 成功——活连接 2 秒就回话，
 *  在死连接上多等 20s 拿不到任何信息。旧口径的代价是每次失败死等 42s（10.5 + 31.7），
 *  而阶梯上线后的 36/36 次 503 全是「两段皆死」——那段 30s 从未换来过一次成功。
 *  收紧后：失败死等 ~21s（10.5 + 10.5），判定结果不变（死连接不会因为多等 20s 而回话）。
 *
 * 触发条件：**只有网关自己的定时器掐断（`timing.connectTimeout === true`）才走阶梯**；
 * 上游自己断的（`timeout=false`）不重发——那不是死连接，语义保留给原有兜底链。
 */
export const TRAE_CONNECT_DEADLINES_MS: readonly number[] = [10_000, 10_000]

/**
 * 单段建连上限：**未传死线的调用点**（直接调 `chatStream` / `chatWorkStream` 的默认值，
 * 如管理后台「测试连接」）用。数值恒等于阶梯最后一段，使「不走阶梯」的调用点与主路径共用
 * 同一套建连判据（单一 owner，不留第二个超时口径）。
 *
 * 注意：proxy.ts / truncation.test.ts 里若干注释写的「30s / 62s」是 2026-09-27、10-07、10-08
 * 的历史实测口径，不是现值，勿据此推断当前超时。
 */
export const TRAE_CHAT_CONNECT_TIMEOUT_MS = 10_000

// ===== raw/remote 省输入积分预算默认值（对齐 Trae2api-cn TRAE_RAW_* 常量） =====
/** 保留的非 system 历史消息条数上限 */
export const TRAE_RAW_MAX_MESSAGES = 20
/** 历史文本字符上限（0 = 不限） */
export const TRAE_RAW_MAX_HISTORY_CHARS = 0
/** 工具 schema 字符预算（超限压缩，0 = 不压缩） */
export const TRAE_RAW_MAX_TOOL_SCHEMA_CHARS = 10000

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

/**
 * OpenAI 模型列表条目（静态回退用，created 用固定值保持稳定）。
 * context_length 经共享知识表三级查找（远端值 → 知识表 → 1M 兜底）：静态表无远端值，
 * 故按模型名查表；未收录落 DEFAULT_CONTEXT_WINDOW（1M），不再透出假 131072
 * （上游 workbuddy2api 32a3c13 同口径）。max_output_tokens 未知即省略（不编造输出上限）。
 */
export const TRAE_STATIC_MODELS = TRAE_STATIC_MODEL_IDS.map((id) => {
  const entry: {
    id: string
    object: string
    created: number
    owned_by: string
    context_length: number
    max_output_tokens?: number
  } = {
    id,
    object: 'model',
    created: 1753600000,
    owned_by: 'trae-solo',
    context_length: contextWindowListing(id),
  }
  const maxOut = maxOutputTokensListing(id)
  if (maxOut !== null) entry.max_output_tokens = maxOut
  return entry
})

/** 模型名归一化：下划线 → 横线，首字母大写（deepseek_v4_pro → DeepSeek-V4-Pro） */
export function normalizeTraeModelName(s: string): string {
  const parts = s.split('_')
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '') continue
    parts[i] = parts[i][0].toUpperCase() + parts[i].slice(1).toLowerCase()
  }
  return parts.join('-')
}
