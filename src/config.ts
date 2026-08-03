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
  OAUTH_TOKEN_PREFIX: 'oauth:token:',
  OAUTH_DEVICE_PREFIX: 'oauth:device:',
  CHECKIN_RESULT_PREFIX: 'checkin:result:',
} as const

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
]
