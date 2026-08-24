import type { Provider } from './types'

export const SITE_CONFIG = {
  title: 'AI Gateway',
  subtitle: '统一的 AI 管理平台',
  author: 'QingYun',
  authorUrl: 'https://github.com/yutian81/ai-gateway',
  blogUrl: 'https://blog.notett.com',
  description: 'AI 提供商 API 代理网关 — 统一 /v1 接口转发',
  favicon: 'https://pan.811520.xyz/icon/ai.webp',
  faCdn: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css',
}

export const SESSION_TTL = 7 * 24 * 60 * 60

export const PROXY_KEY_PREFIX = 'sk_cf_'

export const OPENCODE_DEFAULT_URL = 'https://opencode.ai/zen/v1'

// Key 降权后自动恢复的冷却时间 (毫秒)
export const KEY_HEALTH_COOLDOWN_MS = 5 * 60 * 1000

// 连续失败多少次后降权
export const KEY_HEALTH_MAX_FAILURES = 5

export const KV_KEYS = {
  PROVIDERS: 'providers',
  PROXY_KEYS: 'proxy:keys',
  SESSION_PREFIX: 'admin:session:',
  KEY_HEALTH_PREFIX: 'key:health:',
  OPENCODE_MIGRATION: 'migration:opencode-default:v1',
  DEFAULT_PROVIDERS_MIGRATION: 'migration:default-providers:v2',
  OAUTH_TOKEN_PREFIX: 'oauth:token:',
  OAUTH_DEVICE_PREFIX: 'oauth:device:',
  CHECKIN_RESULT_PREFIX: 'checkin:result:',
  LOGIN_RATE: 'login:rate:',
  MCPS: 'mcps',
  UNIMODELS: 'unimodels',
  // TRAE SOLO 账号池 / 登录流程 / 签到结果 / 动态模型缓存
  TRAE_POOL_PREFIX: 'trae:pool:',
  TRAE_LOGIN_PREFIX: 'trae:login:',
  TRAE_CHECKIN_PREFIX: 'trae:checkin:',
  TRAE_MODELS_PREFIX: 'trae:models:',
  // QoderWork 账号池（多账号轮转 + 冷却）
  QODER_POOL_PREFIX: 'qoder:pool:',
  THINKING_PROMPT: 'thinking:prompt',
  CACHE_PREFIX: 'cache:prefix',
  PERF_SETTINGS: 'perf:settings',
  RESPONSES_PREFIX: 'proxy:responses:',
} as const

/** uni-model 虚拟提供商 ID（模型 ID 前缀，如 unimodel/xxx） */
export const UNIMODEL_PROVIDER_ID = 'unimodel'

/** uni-model 每个候选最多尝试次数（aihub 原值 5） */
export const UNIMODEL_MAX_RETRIES = 5

/** uni-model 候选失败后切换间隔（毫秒，aihub 原值 1s） */
export const UNIMODEL_RETRY_DELAY_MS = 1000

// access_token 过期前多少毫秒触发惰性刷新（默认提前 60 秒）
export const OAUTH_TOKEN_REFRESH_MARGIN_MS = 60 * 1000

// 签到结果在 KV 中的保留时间（2 天，足够展示当日状态）
export const CHECKIN_RESULT_TTL_SEC = 2 * 24 * 60 * 60

// 有效期选项（秒）
export const EXPIRY_OPTIONS: Record<string, number | null> = {
  '30d': 30 * 24 * 60 * 60,
  '90d': 90 * 24 * 60 * 60,
  '180d': 180 * 24 * 60 * 60,
  '1y': 365 * 24 * 60 * 60,
  'forever': null,
}

export const DEFAULT_PROVIDERS: Provider[] = [
  {
    id: 'opencode',
    name: 'OpenCode',
    baseUrl: 'https://opencode.ai/zen/v1',
    apiType: 'openai',
    apiKeys: [],
    models: [
      { id: 'deepseek-v4-flash-free', enabled: true },
      { id: 'mimo-v2.5-free', enabled: true },
      { id: 'nemotron-3-ultra-free', enabled: true },
      { id: 'hy3-free', enabled: true },
    ],
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    // Cloudflare Workers AI：每天 10,000 Neurons 免费额度（所有模型共享，UTC 0 点重置）。
    // baseUrl 里的 {CF_ACCOUNT_ID} 占位符会在转发/测试时被替换为 env.CF_ACCOUNT_ID；
    // 也可在管理后台直接把占位符改成真实 Account ID（两种方式任选）。
    id: 'cloudflare-ai',
    name: 'Cloudflare Workers AI',
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/ai/v1',
    apiType: 'openai',
    apiKeys: [],
    models: [
      { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', enabled: true },
      { id: '@cf/meta/llama-3.1-8b-instruct-fp8-fast', enabled: true },
      { id: '@cf/meta/llama-4-scout-17b-16e-instruct', enabled: true },
      { id: '@cf/mistralai/mistral-small-3.1-24b-instruct', enabled: true },
      { id: '@cf/mistral/mistral-7b-instruct-v0.1', enabled: true },
      { id: '@cf/qwen/qwen1.5-7b-chat', enabled: true },
      { id: '@cf/zai-org/glm-4.7-flash', enabled: true },
      { id: '@cf/google/gemma-4-26b-a4b-it', enabled: true },
      { id: '@cf/nvidia/nemotron-3-120b-a12b', enabled: true },
      { id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', enabled: true },
    ],
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    // OpenRouter：OpenAI 兼容聚合平台，替代已下线的 GitHub Models（2026-07-30 关闭）。
    // 免费模型以 ":free" 结尾（如 deepseek/deepseek-chat-v3-0324:free），
    // 需在管理后台配置 apiKey（OpenRouter 官网申请，免费模型无需充值）。
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiType: 'openai',
    apiKeys: [],
    models: [
      { id: 'deepseek/deepseek-chat-v3-0324:free', enabled: true },
      { id: 'meta-llama/llama-3.3-70b-instruct:free', enabled: true },
      { id: 'qwen/qwen-2.5-72b-instruct:free', enabled: true },
      { id: 'mistralai/mistral-small-3.1-24b-instruct:free', enabled: true },
    ],
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
]
