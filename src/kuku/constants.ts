export const KUKU_TARGET = 'https://kuku.baidu.com'
export const KUKU_APP_ID = 123971023
export const KUKU_CHANNEL = 'kuku_web_genflowpro_v1'
export const KUKU_QUERY_BASE = `clienttype=400&app_id=${KUKU_APP_ID}&web=1&channel=chunlei&version=1.4.4`
export const KUKU_DEFAULT_MODEL = 'auto'

export const KUKU_MODELS = [
  'auto',
  'gateway-deepseek-v4.1-flash-tencent',
  'gateway-deepseek-v4-pro-tencent',
  'gateway-deepseek-v4-flash-tencent',
  'gateway-glm-5.3-flash',
  'glm-5.3',
  'gateway-glm-5.2',
  'gateway-glm-5.1-kuaishou',
  'ernie-5.1',
  'ms-kimi-k3',
  'gateway-kimi-k2.7-code-tencent',
  'gateway-kimi-k2.6',
  'ali-minimax/minimax-m3',
] as const

const KUKU_MODEL_SET = new Set<string>(KUKU_MODELS)

export function resolveKukuModel(name: unknown): string {
  const raw = typeof name === 'string' ? name.trim() : ''
  const model = raw.startsWith('kuku/') ? raw.slice('kuku/'.length) : raw
  if (!model || !KUKU_MODEL_SET.has(model)) {
    throw new Error(`Unsupported Kuku model: ${raw || '(empty)'}`)
  }
  return model
}
