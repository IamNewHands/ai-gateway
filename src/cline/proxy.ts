/**
 * proxy.ts — Cline 上游转发（移植自 cline2api-workers worker.js）。
 *
 * 核心逻辑：
 *   1. 用 refreshToken（Cline 账号的"长期钥匙"）换 accessToken（内存缓存，过期自动刷新）。
 *   2. 把 OpenAI 请求转发到 https://api.cline.bot/api/v1/chat/completions。
 *   3. SSE 流式响应剥掉上游 {data:{...}} 包装后透传给客户端。
 *
 * 多账号：provider.apiKeys（enabled）里一行一个 refreshToken，
 *   额度用尽(空响应)/刷失败/401 时自动冷却并切换到下一个账号。
 *
 * 模型分档（2026-09-24 实测 https://api.cline.bot/api/v1/ai/cline/recommended-models）：
 *   free 档（走官方免费额度，不需 credits）：cline-free/gemini-3.8-flash、
 *     stealth/space-bunny-alpha、cline-free/mimo-v2.6-flash、
 *     cline-free/deepseek-v4.1-flash、cline-free/muse-spark-1.3-contributor；
 *   cline-pass/* 需付费订阅；其余（如 z-ai/glm-5.3-flash）走 credits 计费档，
 *     余额不足返回 402 insufficient_credits。
 *
 * ⚠️ 免费判定必须用「free 列表成员」而非前缀：stealth/space-bunny-alpha 是免费模型
 *    但没有 cline-free/ 前缀，前缀判定会把它当计费档 → 402。
 */

import type { ClinePinConfig, Env, Provider } from '../types'
import { updateProvider, getProviders } from '../storage'
import { streamFetchWithTimeout } from '../opencode'
// 通用 tool 配对工具（纯函数、与提供商无关）：Cline 出站历史同样需要清孤儿 tool 结果。
// 复用而非复制，避免两份实现漂移（owner 仍在 workbuddy-upstream.ts）。
import { cleanupOrphanToolCalls } from '../workbuddy-upstream'
// 拦截归因同时落 KV 系统日志（管理面板「系统日志」可直接搜 `[cline-attempt]`），
// 不再只进 CF 仪表盘。admin 亦 import 本模块，但 writeLog 只在运行期调用，无循环初始化问题
// （与 src/trae/proxy.ts 同一既有口径）。
import { writeLog } from '../admin'
// 账号冷却状态的 KV 留档（面板据此显示「额度耗尽 / 限流 / 凭据失效」）。与 admin 之间没有循环
// 初始化问题：account-state 只依赖 types 与 env.KV，运行期才用（与 writeLog 同一既有口径）。
import {
  classifyClineCooldownKind,
  clearClineAccountState,
  maskClineToken,
  recordClineAccountState,
} from './account-state'
import type { ClineAccountStateKind } from './account-state'

export const CLINE_PROVIDER_ID = 'cline'
export const CLINE_API_BASE = 'https://api.cline.bot/api/v1'

/** 默认模型：Cline 官方免费额度通道（对齐上游 cline2api-workers 1.1.8 的 DEFAULT_MODEL）。 */
export const DEFAULT_MODEL = 'cline-free/deepseek-v4.1-flash'

/**
 * 静态兜底模型表（2026-09-24 实测）。
 * 动态目录拉取成功时以动态结果为准；本表仅在拉取失败时兜底，并供后台「获取模型」预填。
 */
export const CLINE_MODELS: Array<{ id: string; provider: string; cost: string }> = [
  { id: 'cline-free/deepseek-v4.1-flash', provider: 'cline-free', cost: 'free' },
  { id: 'cline-free/gemini-3.8-flash', provider: 'cline-free', cost: 'free' },
  { id: 'cline-free/mimo-v2.6-flash', provider: 'cline-free', cost: 'free' },
  { id: 'cline-free/muse-spark-1.3-contributor', provider: 'cline-free', cost: 'free' },
  { id: 'stealth/space-bunny-alpha', provider: 'stealth', cost: 'free' },
  { id: 'cline-pass/glm-5.3', provider: 'zai', cost: 'pass' },
  { id: 'cline-pass/deepseek-v4.1-flash', provider: 'deepseek', cost: 'pass' },
  { id: 'cline-pass/qwen3.8-max', provider: 'qwen', cost: 'pass' },
]

/**
 * Cline 官方免费白名单（移植 cline2api-workers worker.js `refreshModels` 的 FREE_WHITELIST）。
 * 这些 ID 在 `/v1/models` 里没有 `:free` 后缀，但走官方免费额度，必须显式识别。
 */
export const CLINE_FREE_WHITELIST: readonly string[] = [
  'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-v4-flash-0731',
  'z-ai/glm-5.3-flash',
  'z-ai/glm-5.2:free',
  'xiaomi/mimo-v2.5',
  'minimax/minimax-m3',
  'poolside/laguna-s-2.1',
  'cline-free/deepseek-v4.1-flash',
  'cline-free/muse-spark-1.3-contributor',
  'cline-free/solar-pro4',
]

export function isClineProvider(providerId: string): boolean {
  return providerId === CLINE_PROVIDER_ID
}

// ===== 账号池状态（per isolate，按 provider.id 隔离） =====

// Cline 客户端指纹头：模拟官方 Cline 客户端，规避 "only available via Cline product surfaces"
// 这类对非官方客户端的 403 锁定（移植自 cline2api-workers worker.js 的 clineHeaders）。
const CLINE_SDK_VERSION = '3.0.47'
const CLINE_FINGERPRINT_HEADERS: Record<string, string> = {
  'User-Agent': `Cline/${CLINE_SDK_VERSION}`,
  'HTTP-Referer': 'https://cline.bot',
  'X-Title': 'Cline',
  'X-IS-MULTIROOT': 'false',
  'X-CLIENT-TYPE': 'cline-sdk',
  'X-CLIENT-VERSION': CLINE_SDK_VERSION,
  'X-PLATFORM': 'terminal',
  'X-CORE-VERSION': '0.0.66',
}

// 冷却时长（解析上游 Retry-After / "Try again in 2h 51m"，封顶 6h 防止账号被过久冻结）
const CLINE_COOLDOWN_MAX_MS = 6 * 3600 * 1000
const CLINE_COOLDOWN_LIMIT_MS = 5 * 60 * 1000   // 429 默认冷却
const CLINE_COOLDOWN_EMPTY_MS = 60 * 1000       // 空响应（免费额度耗尽）默认冷却
const CLINE_COOLDOWN_401_MS = 60 * 1000         // token 失效默认冷却
// 推理空转（length 截断但无正文）默认冷却：比普通空响应短，便于快速切号重试
const CLINE_COOLDOWN_RUNAWAY_MS = 30 * 1000
/**
 * 余额/权益耗尽（402 insufficient_credits）的模型级冷却默认时长。
 *
 * 402 的语义是「该模型走 credits 计费档，而当前账号余额不足」——**不代表账号不能跑免费模型**，
 * 所以只冷却「账号 × 该模型」这一格，由免费链换模型；整体冷却账号会把后续免费模型一起打死。
 * 时长给足 12h（余额耗尽不会自愈，除非充值或次日探活复活），但下一次请求若该模型仍被点名，
 * 免费链会直接跳过它，不再空转打上游。
 */
const CLINE_COOLDOWN_PLAN_MS = 12 * 3600 * 1000

/**
 * Cline chat 的建连/首字节超时（**cline 专属，不继承全局 OPENCODE_CONNECT_TIMEOUT_MS**）。
 *
 * 从原 30s 放宽到 60s（2026-10-01）：
 * 现代思考模型（长 reasoning / 上游排队 / 复杂提示词）在高峰期生成首个 chunk 常需 30-50s，
 * 30s 硬超时在线上产生了一定比例的「合法思考未出首字节」误杀。放宽到 60s 留足合理等待窗口，
 * 同时相较全局默认 90s 仍保持 30s 保护，兼顾推理排队容限与失败止损。
 * **可调**：若线上出现「60s 内合法未出首字节」的误杀，改这一个常量即可。
 */
export const CLINE_CHAT_CONNECT_TIMEOUT_MS = 60_000

/**
 * 传输层故障内部最多重试尝试次数（与 trae 通道 MAX_TRANSPORT_ATTEMPTS=2 同纪律）。
 * 建连超时或传输抖动时，第 1 次失败不惩罚账号，短暂退避后做 1 次内部重试；撞满 2 次即跳出，
 * 避免在死链路上无休止空转。
 */
export const CLINE_MAX_TRANSPORT_ATTEMPTS = 2

/**
 * 传输层故障标记（与 trae 同口径：`src/trae/upstream.ts:605-613` 给建连失败打 `kind='transport'`）。
 *
 * 只在**建连/首字节失败**处打标（DNS/TLS/连接被掐断/30s 超时 abort），
 * 账号池问题（无 refreshToken、全账号冷却、token 刷新失败）**不带此标记**——
 * 两者出口不同：传输类回 503 `upstream_unreachable`（可重试、不冤枉账号），
 * 池类保持原 500，避免把「账号池不可用」伪装成「网络故障」。
 */
interface ClineTransportError extends Error {
  kind?: 'transport' | 'client'
}

/**
 * 上游对输出 token 的硬下限（移植 luawei1/cline2api 1184f91）。
 *
 * Cline 免费模型经 OpenRouter 转发时（如 meta/muse-spark），max_output_tokens < 16
 * 会被上游直接 400，且错误会被免费模型回退链吞掉。故非免费通道把 < 16 兜到默认值。
 */
const CLINE_MIN_UPSTREAM_MAX_TOKENS = 16

/**
 * max_tokens「护栏默认」与 effort 默认档（推理空转防御）。
 *
 * 实测（2026-09 一份 108 轮 cline/z-ai 会话）：正常轮次 reasoning 中位仅 ~1.5k 字符、
 * 重的工具轮 ~10k–55k；真正病态的轮次是「推理退化空转」——吐 ~3.2 万条 reasoning 里
 * 95% 是空白/换行、几乎不产出正文，最后以 length 截断。而 OpenAI 兼容推理模型把
 * reasoning 与最终答案共用一个 max_tokens 总预算，空转会一次性烧光它。
 *
 * 因此把原来无脑兜底 128000 换成「护栏语义」，并按通道分档（2026-09-24 移植）：
 *   - **免费档**（官方免费额度通道）：**剥离 max_tokens / max_completion_tokens**。
 *     上游风控「免费模型请求体带 max_tokens 一律 500 empty response content」
 *     （移植 cline2api-workers v1.1.8 `43a2930`）。已知代价：上游按自己节奏生成，
 *     客户端无法提前截断——这是上游明示的取舍。
 *   - **非免费档**：保留客户端值；低于上游硬下限 `CLINE_MIN_UPSTREAM_MAX_TOKENS` 的
 *     兜到 CLINE_MAX_TOKENS（移植 luawei1/cline2api `1184f91`，防 OpenRouter 转发 400）。
 *   - 客户端没带时同样兜 CLINE_MAX_TOKENS，避免空转烧光几十万预算。
 * 空转的兜底见 isRunawayReasoningCutoff + proxyNonStreamChat 的重试/冷却。
 *
 * 2026-09-05 复盘：昨天只把空转兜底挂在非流式路径（proxyNonStreamChat），而 DSH 等
 * 客户端走的是流式透传（streamSSE 直通），退化照样直播到 UI（思考一屏一屏的换行/空格），
 * 预算也照样被烧光直到 length 截断。本次给流式加同等防护：
 *   - isDegenerateReasoningDeltas：流式早期退化检测（阈值按 342 个真实 reasoning 步校准）；
 *   - proxyStreamChat：探测期缓冲 → 退化则取消上游 + 冷却 + 换号重试；健康才放行，
 *     放行后继续滚动监控，退化中途出现则抑制后续 reasoning delta（不再往 UI 直播垃圾）。
 */
export const CLINE_MAX_TOKENS = 32768          // 客户端未指定 max_tokens 时的护栏默认（原 128000 过激进）
const CLINE_DEFAULT_REASONING_EFFORT = 'medium'  // 免费通道默认档位（原 high 过激进）

/**
 * SSE 心跳间隔：超过这么久没往客户端写任何字节就补一条注释行（2026-10-05，
 * 移植 luawei1/cline2api `a055b13`）。与 opencode 侧 OPENCODE_KEEPALIVE_MS 同值同形态。
 * 背景：探测期此前一个字节都不写，慢首 token（长 reasoning / 上游排队）会被中间层
 * 读超时掐掉（上游实测 Cloudflare 隧道 120s read timeout → 524）。
 */
export const CLINE_KEEPALIVE_MS = 15000

/**
 * 探测期时间上限：到点仍未做出放行/拦截判定就先放行，让响应头在中间层读超时前出去
 * （Cloudflare 边缘对「迟迟不出响应头」的连接会回 524）。远小于边缘超时，留足余量。
 */
export const CLINE_PROBE_MAX_MS = 10000

/**
 * 已知模型的 **输出硬上限**（`maxOutputTokens` / `max_tokens` 的合法取值上界）。
 *
 * 移植 luawei1/cline2api `3f72255`：Cline 官方的 recommended-models 接口**不带**
 * context/maxTokens 元数据，客户端（大量 OpenAI 兼容 SDK 默认 `max_tokens: 128000`）的值
 * 会原样透传，超过模型硬上限时上游直接 400，而 400 落在「参数错误原样透传」分支
 * （见 proxyClineChatRequest 的「只服务点名模型」注释）——用户直接吃硬失败，且日志看不出是预算超限。
 * 上游 A/B 实测：gemini-3.8-flash 上 128000 必现 400，65536 全部成功。
 *
 * 键为**基名**（剥掉 `cline-free/` `cline-pass/` `google/` 等路由前缀后匹配）。
 * **未收录的模型一律不封顶**：宁可漏封顶（回落原有行为），也不误伤长输出模型。
 */
export const CLINE_MODEL_MAX_OUTPUT: Record<string, number> = {
  'gemini-3.8-flash': 65536,
}

/** 取模型基名：剥掉路由前缀（cline-free/ cline-pass/ google/ vendor/model 等）。 */
function clineModelBaseName(id: string): string {
  const tail = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id
  return tail.toLowerCase()
}

/** 模型的输出预算硬上限；未收录返回 null（不封顶）。 */
export function clineMaxOutputLimit(model: string): number | null {
  return CLINE_MODEL_MAX_OUTPUT[clineModelBaseName(model)] ?? null
}

/** 出站 body 是否发生过 max_tokens 封顶（buildUpstreamBody 把事实挂在不可枚举属性上）。 */
export function clineMaxTokensClamp(
  body: Record<string, unknown>
): { from: number; to: number } | null {
  const v = (body as { __maxTokensClamp?: { from: number; to: number } | null }).__maxTokensClamp
  return v ?? null
}

/** 给响应加上「输出预算被封顶」的可归因标记（不改变 body 与状态码）。 */
function withMaxTokensClampHeader(
  resp: Response,
  clamp: { from: number; to: number } | null
): Response {
  if (!clamp) return resp
  resp.headers.set('X-Cline-Max-Tokens-Clamped', `${clamp.from}->${clamp.to}`)
  return resp
}

/**
 * 判定一次聚合结果是否为「推理空转被截断」：finish_reason=length 且几乎没有真实正文，
 * 说明预算被 reasoning 耗尽而未产出答案。此时应视为失败（冷却+切号/重试），而不是
 * 把一段空转后的 length 当作「正常被截断的答案」返回。
 * @param content  聚合出的真实正文（assistant content）
 * @param toolCalls 聚合出的工具调用
 * @param finishReason 上游 finish_reason
 */
export function isRunawayReasoningCutoff(content: string, toolCalls: unknown[], finishReason: string): boolean {
  if (finishReason !== 'length') return false
  const hasContent = (content || '').trim().length > 0
  const hasToolCall = Array.isArray(toolCalls) && toolCalls.length > 0
  return !hasContent && !hasToolCall
}

// ===== 推理退化检测（流式防护，2026-09-05，v2 校准） =====

// v1 用「空白碎片 delta 占比 / 换行率」判别（换行率 ≥0.3 即判退化），会误杀大量正常思考：
// cline/z-ai 上游（glm）常把每个思考 token 单独成行/每个 token 后跟换行发出，使"换行率"
// 虚高（实测正常思考到 0.2–0.3），内容却是连贯技术推理，被 v1 当成退化拦截，
// 导致同轮 3 次重试全被掐 → 客户端收到 502 upstream_runaway，正常会话反而做不了。
//
// 用日志两批真实 reasoning 步校准「空白占比」（空白字符 ÷ 总字符）：
//   真退化（空白/乱码洪泛，烧光预算）：0.59–0.96（T5/S34、T12/S39、T12/S34、T5/S30…）
//   一词一行但连贯的思考（本次被误杀对象）：0.21–0.45（T18/S3/S6/S7…）
//   正常散文/中文思考：0.15–0.25
// 判别：空白占比 ≥0.55 且总字符 ≥250 → 退化。语言无关（英文/中文/乱码一致）。
const DEGENERATE_MIN_DELTAS = 1        // 按字符占比判别，条数门槛放宽
const DEGENERATE_MIN_CHARS = 250       // 太少字符无法稳定估计，且短垃圾自限不烧预算
const DEGENERATE_MAX_WS_RATIO = 0.55   // 空白占比低于此判定（正常思考 ≤0.45，留裕量）
const PROBE_MAX_DELTAS = 24            // 流式探测窗口：缓冲满这个数量即做放行/拦截判定
const RING_SIZE = 32                   // 放行后的滚动监控窗口

/**
 * 判定一组 reasoning delta 是否为「推理退化空转」。
 *
 * 不能看"换行多/碎片多"——正常思考也常被上游拆成一词一行。真正病态是「攒了很多字符却几乎
 * 都是空白/换行」：乱码洪泛、单字符碎片铺满。用整体空白占比区分（语言无关，≥0.55 判退化；
 * 正常连贯思考含一词一行 ≤0.45，不会误伤）。
 * @param deltas 按到达顺序排列的 reasoning 文本片段
 */
export function isDegenerateReasoningDeltas(deltas: string[]): boolean {
  if (deltas.length < DEGENERATE_MIN_DELTAS) return false
  let chars = 0
  let ws = 0
  for (const t of deltas) {
    chars += t.length
    ws += (t.match(/\s/g) || []).length
  }
  if (chars < DEGENERATE_MIN_CHARS) return false
  return ws / chars >= DEGENERATE_MAX_WS_RATIO
}

/**
 * 判定单条 reasoning delta 是否为「纯排版噪声」：整条内容仅由空白组成。
 *
 * 背景（2026-09-06、2026-09-10 会话日志确认）：glm 上游既会发送 token 与独立
 * "\n" 交替的分片，也会发送独立 "\n\n" 或把双换行粘在短句尾部。纯空白分片
 * 不携带语义，直接拼入思考流会造成大量空白行，因此单换行、双换行和空格均不转发。
 *
 * 注意：这里只影响直播转发，不影响退化判定。原始分片仍会计入 probeDeltas/ring，
 * 纯空白洪泛（≥250 字符、空白占比 ≥0.55）仍会被判定为退化并拦截。
 */
export function isWhitespaceOnlyReasoningDelta(t: unknown): boolean {
  if (typeof t !== 'string' || t === '') return false
  return /^\s+$/.test(t)
}

/**
 * 归一化单条 reasoning delta，让思考流在 UI 里可读（只影响转发直播，不影响退化判定）。
 *
 * 背景（2026-09-06 log4 确认）：独立 "\n" 空白 delta 被过滤后，glm 还有第二形态——
 * 换行粘在标点 token 尾部（".\n" ",\n" "—\n\n" "...\n\n\n"），每个分句强制换行，
 * 渲染出来一行一个短句，长思考没法看。策略：
 *   - 尾部换行 ≥2 个 → 压成一个段落分隔 "\n\n"（保留结构）；
 *   - 尾部单个换行   → 折叠成一个空格（分句连排成段）；
 *   - 其余内容原样返回。
 * 仅用于转发路径；probeDeltas/ring 的退化检测始终使用上游原始 delta。
 */
export function normalizeReasoningDeltaForUI(t: unknown): string {
  if (typeof t !== 'string' || t === '') return typeof t === 'string' ? t : ''
  const m = /\n[\n\t ]*$/.exec(t)
  if (!m) return t
  const head = t.slice(0, t.length - m[0].length)
  // Cline 的轮换推理供应商可能把每个短句甚至 token 以双换行结尾。
  // 在单条 delta 内无法可靠区分语义段落与供应商排版，因此正文尾部的
  // 任意数量换行统一折叠成一个空格；纯空白 delta 由调用方直接抑制。
  return head ? head + ' ' : ' '
}

/**
 * 就地改写 SSE 帧内的 reasoning delta 为 UI 归一化版本（探测缓冲与续流共用）。
 *
 * 字段覆盖（2026-09-06 实测 Novita 池帧结构确认）：cline 免费通道的 glm 由多个
 * 推理商（Parasail/Novita/…）轮换托管，delta 字段不统一——有的发 reasoning_content，
 * 有的发 reasoning + reasoning_details 双字段。DSH 的思考流读的是
 * reasoning_details[].text（与 DSH replayState.blocks 结构逐字段一致），漏改它
 * 等于所有归一化白做（log6 实测三连换行原样穿透的根因）。三处同步改写。
 */
function patchReasoningDeltaForUI(clone: Record<string, unknown>): void {
  const choice = ((clone.choices as Array<Record<string, unknown>>) || [])[0] as Record<string, unknown> | undefined
  if (!choice) return
  const delta = (choice.delta || choice.message) as Record<string, unknown> | undefined
  if (!delta) return
  if (delta.reasoning_content !== undefined) delta.reasoning_content = normalizeReasoningDeltaForUI(delta.reasoning_content)
  if (delta.reasoning !== undefined) delta.reasoning = normalizeReasoningDeltaForUI(delta.reasoning)
  const details = delta.reasoning_details as Array<Record<string, unknown>> | undefined
  if (Array.isArray(details)) {
    for (const item of details) {
      if (item && item.type === 'reasoning.text' && typeof item.text === 'string') {
        item.text = normalizeReasoningDeltaForUI(item.text)
      }
    }
  }
}

interface Account {
  refreshToken: string
  accessToken: string | null
  expiry: number
  cooldownUntil: number
  /** 模型级冷却：modelId → 冷却截止时间戳。仅该模型暂停，账号其它模型仍可用。 */
  modelCooldowns: Map<string, number>
}

interface Pool {
  accounts: Account[]
  accountIndex: number
  current: Account | null
  /** refreshToken 轮换回调：上游换发新 refreshToken 时触发，用于持久化到 KV，避免下次 invalid_grant。 */
  onRotate?: (oldRt: string, newRt: string) => void
  /** 提供商 id：冷却留档写 KV 时要按提供商分键（面板也按它查）。 */
  providerId: string
  /** 冷却留档需要 KV 绑定；未注入（如测试路径 `__cline_test__`）时只做内存冷却。 */
  env?: Env
}

const pools = new Map<string, Pool>()

function getPool(providerId: string, refreshTokens: string[]): Pool {
  const tokens = refreshTokens
    .map((t) => (t || '').trim())
    .filter((t) => t.length > 8)
  let pool = pools.get(providerId)
  const changed =
    !pool ||
    pool.accounts.length !== tokens.length ||
    pool.accounts.some((a, i) => a.refreshToken !== tokens[i])
  if (changed) {
    pool = {
      accounts: tokens.map((rt) => ({ refreshToken: rt, accessToken: null, expiry: 0, cooldownUntil: 0, modelCooldowns: new Map() })),
      accountIndex: 0,
      current: null,
      providerId,
    }
    pools.set(providerId, pool)
  }
  return pool!
}

/** 由 provider 的启用 apiKeys（即各账号 refreshToken）构造账号池。 */
function poolFromProvider(provider: Provider, env?: Env): Pool {
  const tokens = (provider.apiKeys || []).filter((k) => k.enabled).map((k) => k.key)
  const pool = getPool(provider.id, tokens)
  // refreshToken 轮换时回写 KV，避免下次 invalid_grant（永久 key 更新持久）。
  if (env) pool.onRotate = (oldRt, newRt) => { void persistClineRotation(env, provider, oldRt, newRt) }
  // env 每次都刷新：同一 isolate 先后用不同 env（测试常见）时不能沿用上一次的绑定
  pool.env = env
  return pool
}

async function persistClineRotation(env: Env, provider: Provider, oldRt: string, newRt: string): Promise<void> {
  try {
    const apiKeys = (provider.apiKeys || []).map((k) => (k.key === oldRt ? { ...k, key: newRt } : k))
    if (!apiKeys.some((k) => k.key === oldRt)) return
    await updateProvider(env, provider.id, { apiKeys })
    provider.apiKeys = apiKeys
  } catch { /* 持久化失败不阻断请求，下一轮会重新刷新 */ }
}

// ===== 冷却时长计算（移植 cline2api-workers 的 parseCooldown / Retry-After 支持） =====

/** 解析 "Try again in 2h 51m / 30m / 15s" 这类文本为毫秒；仍封顶 6h。 */
export function parseCooldownMs(text: string): number | null {
  if (!text) return null
  let totalSec = 0
  let found = false
  const re = /(\d+)\s*(h(?:our)?s?|m(?:in(?:ute)?)?s?|s(?:ec(?:ond)?)?s?)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const n = parseInt(m[1], 10)
    const unit = m[2][0]
    totalSec += unit === 'h' ? n * 3600 : unit === 'm' ? n * 60 : n
    found = true
  }
  if (!found) return null
  return Math.min(totalSec * 1000, CLINE_COOLDOWN_MAX_MS)
}

/** 从响应取冷却时长：优先 Retry-After 头，其次响应体 "Try again in..."，否则用 fallbackMs。 */
function cooldownFromResponse(resp: Response, text: string, fallbackMs: number): number {
  const retryAfter = resp?.headers?.get?.('Retry-After')
  if (retryAfter) {
    const sec = parseInt(retryAfter, 10)
    if (!isNaN(sec) && sec > 0) return Math.min(sec * 1000, CLINE_COOLDOWN_MAX_MS)
  }
  const parsed = parseCooldownMs(text)
  if (parsed !== null) return parsed
  return fallbackMs
}

/** 冷却一个账号（整体冷却）。返回冷却截止时刻，供状态留档与面板显示共用同一个真值。 */
function cooldownAccount(acc: Account, ms: number): number {
  acc.cooldownUntil = Date.now() + ms
  acc.accessToken = null
  acc.expiry = 0
  return acc.cooldownUntil
}

/**
 * 在冷却生效之后，把「哪个账号、为什么、到什么时候」写到 KV，供面板显示。
 *
 * 为什么统一走一个入口：「账号为什么现在不可用」在同一次请求里有多个触发点（401/402/429/
 * 空响应/推理空转），各写各的必然分叉。落档口径只此一处，且**必须在内存冷却之后**——
 * KV 写失败只影响面板可见性，绝不影响路由行为。
 */
async function recordCooldownState(
  pool: Pool | undefined,
  acc: Account | null,
  until: number,
  kind: ClineAccountStateKind,
  model: string | null,
  reason: string
): Promise<void> {
  if (!pool || !acc) return
  const index = pool.accounts.indexOf(acc)
  if (index < 0) return
  await recordClineAccountState(pool.env, pool.providerId, {
    index,
    masked: maskClineToken(acc.refreshToken),
    kind,
    until,
    at: Date.now(),
    model,
    reason,
  })
}

/**
 * 清除某账号的冷却留档——**只在网关确定要交付一个健康结果时调用**。
 *
 * 为什么不放在「HTTP 200」上：上游对免费档额度耗尽的一种形态就是 **200 + 零帧流**（网关恒定强制
 * 流式，见 proxyClineFetchWithRetry 注释）。按 200 清档会让「刚判定的额度耗尽」当场被抹掉，
 * 面板继续显示健康——正是要消灭的谎报。清除的判据只能是"这一轮真的产出了可用内容"。
 */
async function clearCooldownState(pool: Pool | undefined, acc: Account | null): Promise<void> {
  if (!pool || !acc) return
  const index = pool.accounts.indexOf(acc)
  if (index < 0) return
  await clearClineAccountState(pool.env, pool.providerId, index)
}

/**
 * 账号当前是否可用：软冷却与「账号 × 模型」冷却都不命中才算可用。
 * @param model 有模型上下文时额外检查模型级冷却；不传则只判账号级。
 */
function isAccountAvailable(acc: Account, model: string | undefined, now: number): boolean {
  if (acc.cooldownUntil > now) return false
  if (model) {
    const until = acc.modelCooldowns.get(model)
    if (until && until > now) return false
  }
  return true
}

/** 池中是否还有账号能跑该模型（不改状态，供免费链跳过与降级判定）。 */
function hasAvailableAccount(pool: Pool, model?: string): boolean {
  const now = Date.now()
  return pool.accounts.some((acc) => isAccountAvailable(acc, model, now))
}

/**
 * 池中是否还有账号可用（**忽略模型级冷却**）。
 * 用于区分「账号池整体不可用（应立刻回错）」与「只是该模型在部分账号上冷却（可换模型）」。
 */
function hasAnyUsableAccount(pool: Pool): boolean {
  const now = Date.now()
  return pool.accounts.some((acc) => acc.cooldownUntil <= now)
}

async function getAccountToken(account: Account, pool?: Pool): Promise<string> {
  const now = Date.now()
  if (account.cooldownUntil > now) throw new Error('account_cooldown')
  if (account.accessToken && now < account.expiry) return account.accessToken

  const resp = await fetch(CLINE_API_BASE + '/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: account.refreshToken, grantType: 'refresh_token' }),
    signal: AbortSignal.timeout(15000),
  })
  if (!resp.ok) {
    account.cooldownUntil = now + CLINE_COOLDOWN_401_MS
    // 刷新失败 = 这条凭据现在换不出 token：落档，「凭据失效」必须在面板上看得见（面板据此提示重新授权）
    await recordCooldownState(pool, account, account.cooldownUntil, 'auth', null, `刷新 accessToken 失败：HTTP ${resp.status}`)
    throw new Error('refresh_failed')
  }
  const data = (await resp.json()) as { data?: { accessToken?: string; refreshToken?: string; expiresAt?: number | string } }
  const accessToken = data?.data?.accessToken
  if (!accessToken) {
    account.cooldownUntil = now + CLINE_COOLDOWN_401_MS
    await recordCooldownState(pool, account, account.cooldownUntil, 'auth', null, '刷新接口未返回 accessToken')
    throw new Error('refresh_no_token')
  }
  account.accessToken = accessToken
  // 轮换的新 refreshToken：更新内存并异步持久化到 KV（item2）
  const rotated = data?.data?.refreshToken
  if (rotated && rotated.length > 8 && rotated !== account.refreshToken) {
    const oldRt = account.refreshToken
    account.refreshToken = rotated
    try { pool?.onRotate?.(oldRt, rotated) } catch { /* onRotate 失败不影响 */ }
  }
  // 过期时间：优先服务端，兜底 10 分钟，留 60 秒余量
  const expiresAt = data?.data?.expiresAt
  let expiry = now + 10 * 60 * 1000
  if (typeof expiresAt === 'number') expiry = expiresAt
  else if (typeof expiresAt === 'string') {
    const t = Date.parse(expiresAt)
    if (!isNaN(t)) expiry = t
  }
  account.expiry = expiry - 60000
  return accessToken
}

/** 轮询选一个可用账号，取到 accessToken。（item7 支持模型级冷却） */
async function getAccessToken(pool: Pool, model?: string): Promise<string> {
  if (pool.accounts.length === 0) throw new Error('未配置 Cline RefreshToken')
  const now = Date.now()
  for (let attempt = 0; attempt < pool.accounts.length; attempt++) {
    const acc = pool.accounts[attempt % pool.accounts.length]
    if (!isAccountAvailable(acc, model, now)) continue
    pool.current = acc
    try {
      return await getAccountToken(acc, pool)
    } catch {
      continue // 刷新失败也切下个号
    }
  }
  // 兜底：优先挑一个软冷却已到期的账号强制复活一次（保留原「不空转」语义）；
  // 若全都还在软冷却，则挑一个「该模型未冷却」的账号复活——**不能挑该模型已冷却的账号**，
  // 否则会把「该模型余额耗尽 → 改走免费链」的判定绕过去，又去打一次必然 402 的上游。
  const acc =
    pool.accounts.find((a) => a.cooldownUntil <= now) ??
    pool.accounts.find((a) => !model || (a.modelCooldowns.get(model) ?? 0) <= now)
  if (!acc) throw new Error('该模型在所有账号上均处于冷却中')
  pool.current = acc
  acc.cooldownUntil = 0
  try {
    return await getAccountToken(acc, pool)
  } catch {
    throw new Error('所有账号刷新 token 均失败')
  }
}

async function clineFetch(
  pool: Pool,
  path: string,
  bodyObj: Record<string, unknown>,
  sessionId: string,
  retried = false,
  clientSignal?: AbortSignal,
  opts?: { skipCooldown?: boolean }
): Promise<Response> {
  const model = String((bodyObj as Record<string, unknown>).model || '')
  const token = await getAccessToken(pool, model || undefined)
  const headers = {
    Authorization: 'Bearer workos:' + token,
    'Content-Type': 'application/json',
    'X-Task-ID': sessionId,
    // item1：Cline 客户端指纹头，规避非官方客户端 403
    ...CLINE_FINGERPRINT_HEADERS,
  }
  // 建连/首字节阶段的失败（DNS/TLS/连接被掐断/CLINE_CHAT_CONNECT_TIMEOUT_MS 到点 abort）
  // 与账号健康无关，打 transport 标记供上层定责；不在这里罚号（同 trae 的纪律：
  // 一次网络抖动不该把整个账号池刷成 no_healthy_account）。
  let resp: Response
  try {
    resp = await streamFetchWithTimeout(CLINE_API_BASE + path, {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyObj),
    }, { connectTimeoutMs: CLINE_CHAT_CONNECT_TIMEOUT_MS, signal: clientSignal })
  } catch (e) {
    // 客户端主动断开不算传输故障：定责为 client_closed，调用方据此放弃本轮且不罚冷却。
    if (clientSignal?.aborted) {
      const err = new Error('client disconnected') as ClineTransportError
      err.kind = 'client'
      throw err
    }
    const err = new Error(
      `cline transport error: ${(e as Error).message || String(e)}`
    ) as ClineTransportError
    err.kind = 'transport'
    throw err
  }
  // token 失效：标记当前账号冷却，强制重试（会用别的账号/刷新）
  if (resp.status === 401 && !retried) {
    // 探测/校验不罚号：诊断动作不该把账号拉进冷却（同「客户端断开不罚号」纪律）
    if (!opts?.skipCooldown && pool.current) {
      const until = cooldownAccount(pool.current, CLINE_COOLDOWN_401_MS)
      await recordCooldownState(pool, pool.current, until, 'auth', null, '上游 HTTP 401（凭据失效，需重新授权）')
    }
    return clineFetch(pool, path, bodyObj, sessionId, true, clientSignal, opts)
  }
  return resp
}

// ===== 并发限流队列：上游免费通道并发 >1 会返回空响应，强制串行 + 间隔 =====

let queueTail: Promise<unknown> = Promise.resolve()
export const MIN_GAP_MS = 800

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queueTail.then(() => sleep(MIN_GAP_MS)).then(fn)
  queueTail = run.catch(() => {})
  return run
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 带重试的上游转发：429/空响应自动冷却并切换账号 + 指数退避。item7 优先记模型级冷却。 */
async function clineFetchWithRetry(
  pool: Pool,
  path: string,
  bodyObj: Record<string, unknown>,
  sessionId: string,
  isStream: boolean,
  maxRetries = 4,
  clientSignal?: AbortSignal
): Promise<Response> {
  const model = String((bodyObj as Record<string, unknown>).model || '')
  // 冷却当前账号：优先模型级（该账号还能跑其它模型），无模型上下文则整体冷却。
  // 客户端已断开时不冷却：Esc 中断 / 客户端重连不是模型的失败，冷却会把用户点名的
  // 模型拉黑，后续请求被静默赶到回退链上（移植 luawei1/cline2api `4265b29`）。
  // 每条冷却同时落 KV 状态留档（面板显示「额度耗尽 / 限流 / 凭据失效」的唯一来源）。
  const applyCooldown = async (ms: number, kind: ClineAccountStateKind, reason: string) => {
    if (clientSignal?.aborted) return
    if (!pool.current) return
    const acc = pool.current
    if (model) {
      const until = Date.now() + Math.max(ms, 60 * 1000)
      acc.modelCooldowns.set(model, until)
      await recordCooldownState(pool, acc, until, kind, model, reason)
    } else {
      const until = cooldownAccount(acc, ms)
      await recordCooldownState(pool, acc, until, kind, null, reason)
    }
  }
  let transportAttempts = 0
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (clientSignal?.aborted) throw clientAbortedError()
    let resp: Response
    try {
      resp = await enqueue(() => clineFetch(pool, path, bodyObj, sessionId, false, clientSignal))
    } catch (err) {
      if ((err as ClineTransportError).kind === 'client' || clientSignal?.aborted) {
        throw err
      }
      if ((err as ClineTransportError).kind === 'transport') {
        transportAttempts++
        if (transportAttempts < CLINE_MAX_TRANSPORT_ATTEMPTS && attempt < maxRetries) {
          // 传输抖动/超时：不惩罚账号（与 trae 同纪律），短暂退避后重试 1 次（兼顾偶发抖动自愈与失败止损）
          await sleep(500 + Math.random() * 500)
          continue
        }
      }
      throw err
    }
    // 余额/权益耗尽（402）：该模型走 credits 计费档，而当前账号余额不足。
    // 只做**模型级**冷却（账号仍可跑免费模型），换号重试可能命中有余额的账号；
    // 全账号都不可用时立刻回 402，由调用方沿免费链换模型（移植 luawei1 169fd9d 语义）。
    if (resp.status === 402) {
      const text = await resp.clone().text().catch(() => '')
      await applyCooldown(cooldownFromResponse(resp, text, CLINE_COOLDOWN_PLAN_MS), 'plan_exhausted', text)
      if (!hasAvailableAccount(pool, model)) return planExhaustedResponse(text)
      await sleep(500 + Math.floor(Math.random() * 500))
      continue
    }
    // 明确限流：冷却 + 切号重试。同为 429，**免费额度耗尽**与普通限流必须分开归类：
    // 官方 429 文案固定为 `Daily free limit reached on model X. Try again in 23h 59m`，
    // 面板据此显示「额度耗尽」并带上上游给的重置倒计时（官方客户端就是这么解析的）。
    if (resp.status === 429) {
      const text = await resp.clone().text().catch(() => '')
      await applyCooldown(
        cooldownFromResponse(resp, text, CLINE_COOLDOWN_LIMIT_MS),
        classifyClineCooldownKind(429, text),
        text
      )
      const short = 500 + Math.floor(Math.random() * 500)
      await sleep(short)
      continue
    }
    if (resp.ok) {
      if (!isStream) {
        const text = await resp.clone().text()
        if (!text.includes('empty response content')) return resp
        // 免费额度耗尽空响应：冷却 + 切号
        await applyCooldown(cooldownFromResponse(resp, text, CLINE_COOLDOWN_EMPTY_MS), 'quota_empty', text)
        await sleep(500 + Math.random() * 500)
        continue
      }
      // 流式：HTTP 200 直接转发，空流/错误由流式/聚合处理器判断
      return resp
    }
    // 非 2xx 且非 429：仅 5xx 这类可重试；403/400 直接返回（模型锁定 / 参数错误）
    const limitable = resp.status === 500 || resp.status === 502 || resp.status === 503 || resp.status === 504
    if (!limitable) return resp
    const errText = await resp.clone().text().catch(() => '')
    if (errText.includes('empty response content')) {
      // 5xx + 空响应：额度耗尽，冷却 + 切号
      await applyCooldown(cooldownFromResponse(resp, errText, CLINE_COOLDOWN_EMPTY_MS), 'quota_empty', errText)
      await sleep(500 + Math.random() * 500)
      continue
    }
    return resp
  }
  return enqueue(() => clineFetch(pool, path, bodyObj, sessionId, false, clientSignal))
}

/** 客户端主动断开：不是模型故障，调用方据此放弃本轮（不冷却、不降级、不定责 5xx）。 */
function clientAbortedError(): ClineTransportError {
  const err = new Error('client disconnected') as ClineTransportError
  err.kind = 'client'
  return err
}

// ===== 请求体构造 =====

/**
 * 清洗出站消息历史里的畸形 tool_calls（移植 luawei1/cline2api `49fdb8a` 步骤①②）。
 *
 * 背景：上游偶发输出 `function.name` 为空的 tool call（GLM 流式分片丢失 / 工具调用以
 * 文本形式泄漏），客户端执行后把残缺记录回放进下一轮历史，导致上游**恒定 400**
 * `tool_calls[N].function.name must be a non-empty string`，毒化整个会话。
 *
 *   ① 丢弃 `function.name` 为空的 tool_call；
 *   ② 过滤后 `tool_calls` 为空则移除该字段；
 *   ③ 孤儿 tool 结果（无对应合法 tool_call）整条删除 —— 复用已导出的
 *      `cleanupOrphanToolCalls`，不重复实现。
 *
 * **顺序要紧**：先做①②再做③。反过来的话，被①②丢掉的空名 tool_call 所对应的
 * tool 结果会因为「调用当时还在」而被保留，变成新的孤儿。
 *
 * @param messages 客户端原始 messages（非数组时原样返回）
 */
export function sanitizeClineMessages(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages
  for (const m of messages) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) continue
    const msg = m as Record<string, unknown>
    if (msg['role'] !== 'assistant') continue
    const tcs = msg['tool_calls']
    if (!Array.isArray(tcs)) continue
    const kept = tcs.filter((tc) => {
      if (!tc || typeof tc !== 'object' || Array.isArray(tc)) return false
      const fn = (tc as Record<string, unknown>)['function']
      if (!fn || typeof fn !== 'object' || Array.isArray(fn)) return false
      const name = (fn as Record<string, unknown>)['name']
      return typeof name === 'string' && name !== ''
    })
    if (kept.length === tcs.length) continue // 无空名：零改动
    if (kept.length === 0) delete msg['tool_calls'] // ② 全空名 → 删键
    else msg['tool_calls'] = kept
  }
  // ③ 再清孤儿 tool 结果（② 删掉调用后，其结果在这里被一并清掉）
  return cleanupOrphanToolCalls(messages).messages
}

// ===== 上游渠道钉住（移植 munmunjaklin458-afk/cline-pass-switcher 的 injectPrefs） =====
//
// 为什么必须"双注入"（2026-10-02 free 账号真机实测，证据见
// _port-analysis/cline-pass-switcher-porting-analysis.md）：
//   - 规划器管道（Vercel AI Gateway，实测免费档走这条，与 cline-pass 相同）：
//     只有嵌套 `providerOptions.gateway` 被透传；顶层 `provider` 被**静默丢弃**——
//     请求照常 200 出流，routing 元数据里也看不出你钉过，所以别用"没报错"验收；
//   - 直连管道（OpenRouter）：只有顶层 `provider` 生效，`providerOptions` 被忽略。
// 管道归属由 Cline 侧按模型决定且会漂移，因此两种形态同时写，各自取用、互不干扰。
//
// 有意不移植源项目的 `runChatChain`（按渠道顺序逐个重试）：本仓 2026-10-02 已决定
// 「只服务点名模型、不做任何自动替换」（见 proxyClineChatRequest 注释），再加一层渠道级
// 自动重试与该决定冲突，且会把 cline-pass 的订阅额度按候选数放大。
/** OpenRouter 顶层 `provider.sort` 的枚举名与 Vercel 不同，需要映射。 */
const CLINE_OR_SORT: Record<string, string> = { cost: 'price', ttft: 'latency', tps: 'throughput' }

/**
 * 一次注入的**实际下发内容**（不是配置回显：`exclude` 已换算成白名单、`exclude` 与 `upstreams`
 * 冲突已裁决）。挂在出站 body 的不可枚举属性上供归因日志与测试读取，不发给上游。
 * 为什么需要它：`[cline-pin]` 日志必须回答「这条请求被钉到哪」，而配置里写的东西与
 * 实际下发的东西在 exclude 场景下并不相同（清单缺失时排除根本没生效）。
 */
export interface ClinePinDecision {
  /** 是否真的改写了路由偏好；false = 本请求仍按网关自动选渠道 */
  applied: boolean
  /** 实际下发到 order 的优先序列（空数组 = 未下发 order） */
  order: string[]
  /** 实际下发到 only 的白名单（空数组 = 未下发 only） */
  only: string[]
  /** 实际下发的排序偏好（Vercel 枚举；OpenRouter 侧另有映射） */
  sort: string | null
  /** exclude 已配置但渠道清单缺失 → **排除未生效**，必须能在日志里一眼看出 */
  excludeUnresolved: boolean
}

const CLINE_PIN_DECISION_KEY = '__clinePinDecision'

/** 读取注入器贴在出站 body 上的决策摘要（未配置 pin 时为 null）。 */
export function clinePinDecision(body: Record<string, unknown>): ClinePinDecision | null {
  const v = (body as Record<string, unknown>)[CLINE_PIN_DECISION_KEY]
  return v && typeof v === 'object' ? (v as ClinePinDecision) : null
}

/** 决策摘要的单行文案（归因日志用；面板侧文案在 pages.ts，两处口径由测试各自钉住）。 */
export function clinePinDecisionText(d: ClinePinDecision): string {
  const parts = [`applied=${d.applied ? 1 : 0}`]
  if (d.only.length) parts.push(`only=[${d.only.join(',')}]`)
  if (d.order.length) parts.push(`order=[${d.order.join(',')}]`)
  if (d.sort) parts.push(`sort=${d.sort}`)
  if (d.excludeUnresolved) parts.push('exclude-unresolved（渠道清单缺失，排除未生效）')
  return parts.join(' ')
}

function attachPinDecision(body: Record<string, unknown>, decision: ClinePinDecision): void {
  Object.defineProperty(body, CLINE_PIN_DECISION_KEY, { value: decision, enumerable: false })
}

/**
 * 把渠道钉住偏好注入出站请求体。**原地改 `body` 并返回同一个对象**：
 * `buildUpstreamBody` 把 max_tokens 封顶事实挂在**不可枚举**属性 `__maxTokensClamp` 上，
 * 换成 spread 复制会把它丢掉，响应侧的 `X-Cline-Max-Tokens-Clamped` 归因头随之失效。
 *
 * @param pin 该模型的钉住配置；未配置 / 空配置时**零改动**（保持网关自动选渠道）
 * @param knownUpstreams 该模型已知的渠道清单（探测留档）。**只有配了 `exclude` 时才需要**：
 *   网关两侧都不认 exclude/ignore 字段（源项目实测被静默忽略），排除只能换算成显式 `only`
 *   白名单，而白名单必须从已知清单里减出来。
 */
export function injectClineUpstreamPrefs(
  body: Record<string, unknown>,
  pin?: ClinePinConfig | null,
  knownUpstreams: string[] = []
): Record<string, unknown> {
  if (!pin || typeof pin !== 'object') return body
  const norm = (raw: unknown) =>
    Array.isArray(raw)
      ? [...new Set(raw.filter((u) => typeof u === 'string' && u.trim() !== '').map((u) => u.trim()))]
      : []
  const veto = norm(pin.exclude)
  const vetoSet = new Set(veto)
  // exclude 否决一切：与 upstreams 同时出现时，被排除的渠道直接从候选序列里去掉（源项目口径
  // buildAttempts: wanted = listed.filter(u => !excl.has(u))），而不是留下一份自相矛盾的配置。
  const list = norm(pin.upstreams).filter((u) => !vetoSet.has(u))
  const strict = (pin.pinMode || 'strict') === 'strict'
  const sort = pin.sort
  const known = norm(knownUpstreams)
  // 否决围栏（only 白名单）：exclude 与清单**都**有料时才算得出来，否则置空——**不假装排除生效**
  // （宁可退回网关自动选，也不能谎报"已排除"）。围栏里并入 `list`：勾选的渠道即使已从清单消失
  // （渠道下架 / 留档过期）也不能被自己的围栏排除掉，否则 order 与 only 互相矛盾、网关行为未定义。
  const fence = veto.length && known.length
    ? [...new Set([...list, ...known.filter((u) => !vetoSet.has(u))])]
    : []
  const excludeUnresolved = veto.length > 0 && known.length === 0
  const decision: ClinePinDecision = {
    applied: false, order: [], only: [], sort: sort || null, excludeUnresolved,
  }
  // 真正「什么都没配」时不留决策摘要：调用方据此判定该不该写归因日志（空配置不产生日志噪声）。
  if (!veto.length && !list.length && !sort) return body
  if (!list.length && !sort && fence.length === 0) {
    attachPinDecision(body, decision)
    return body
  }

  // 规划器管道（Vercel AI Gateway）
  const gw: Record<string, unknown> = {}
  // strict → only（回退被清空，多选即「只用这几个」）；preferred → order（保留网关兜底）
  if (list.length) {
    if (strict) gw.only = list
    else {
      gw.order = list
      // preferred 只给 order 的话，网关兜底仍可能落到被排除的渠道 → 必须同时用 only 圈定范围
      if (fence.length) gw.only = fence
    }
  } else if (fence.length) gw.only = fence
  if (sort) gw.sort = sort
  if (Object.keys(gw).length > 0) {
    const prev = (body.providerOptions as Record<string, unknown> | undefined) || {}
    const prevGw = (prev.gateway as Record<string, unknown> | undefined) || {}
    body.providerOptions = { ...prev, gateway: { ...prevGw, ...gw } }
  }

  // 直连管道（OpenRouter）
  const or: Record<string, unknown> = {}
  if (list.length) {
    if (strict) or.only = list
    else {
      or.order = list
      if (fence.length) or.only = fence
    }
  } else if (fence.length) or.only = fence
  if (sort) or.sort = CLINE_OR_SORT[sort] || sort
  if (Object.keys(or).length > 0) {
    const prev = (body.provider as Record<string, unknown> | undefined) || {}
    body.provider = { ...prev, ...or }
  }

  decision.applied = Object.keys(gw).length > 0 || Object.keys(or).length > 0
  decision.only = Array.isArray(gw.only) ? (gw.only as string[]).slice() : []
  decision.order = Array.isArray(gw.order) ? (gw.order as string[]).slice() : []
  attachPinDecision(body, decision)
  return body
}

export function buildUpstreamBody(
  forwardBody: Record<string, unknown>,
  isStream: boolean,
  sessionId: string,
  freeSet?: Set<string>,
  pin?: ClinePinConfig | null,
  knownUpstreams?: string[]
): Record<string, unknown> {
  const model = (forwardBody.model as string) || DEFAULT_MODEL
  const body: Record<string, unknown> = {
    model,
    session_id: sessionId,
    messages: sanitizeClineMessages(forwardBody.messages) as unknown[],
  }
  // reasoning_effort：**Cline 上游不接受 "none" 枚举**（移植 luawei1/cline2api
  // `proxy.go:870-874` 及其 issue #9）。客户端显式关思考时删字段，而不是回落默认档——
  // 默认档是 medium，回落等于把「关」悄悄变「开」。
  // Anthropic / Responses 入口本来就先过 sanitizeUpstreamBody（删 reasoning_effort），
  // 只有 Chat Completions 直连路径会带着 "none" 走到这里。
  const effort = String(forwardBody.reasoning_effort || forwardBody.reasoningEffort || CLINE_DEFAULT_REASONING_EFFORT)
  if (effort !== 'none') body.reasoning_effort = effort
  // max_tokens 分档（见 CLINE_MAX_TOKENS 文档）：免费档剥离，非免费档保留并兜下限。
  // 免费判定用 free 列表成员（不是前缀）——stealth/space-bunny-alpha 无 cline-free/ 前缀。
  let clamped = false
  let lower = 0
  if (!isFreeClineModel(model, freeSet)) {
    const rawMax = forwardBody.max_tokens ?? forwardBody.max_completion_tokens
    const parsed = rawMax != null && rawMax !== '' ? Math.floor(Number(rawMax)) || 0 : 0
    lower = parsed >= CLINE_MIN_UPSTREAM_MAX_TOKENS ? parsed : CLINE_MAX_TOKENS
    // 上限封顶（移植 3f72255）：客户端默认值（常见 128000）超过模型硬上限时上游必 400，
    // 且 400 不会被降级链兜住。未收录模型不封顶。
    const limit = clineMaxOutputLimit(model)
    const finalMax = limit !== null && lower > limit ? limit : lower
    clamped = finalMax !== lower
    body.max_tokens = finalMax
  }
  // 封顶事实挂成**不可枚举**属性：JSON.stringify 自动忽略，不会把内部标记发给上游；
  // 供响应侧加可归因响应头（withMaxTokensClampHeader）与测试断言使用。
  Object.defineProperty(body, '__maxTokensClamp', {
    value: clamped ? { from: lower, to: body.max_tokens as number } : null,
    enumerable: false,
  })
  if (isStream) body.stream = true
  const passthrough = [
    'temperature', 'top_p', 'tools', 'tool_choice', 'stop',
    'presence_penalty', 'frequency_penalty', 'response_format', 'user', 'n', 'seed',
  ] as const
  for (const k of passthrough) {
    if ((forwardBody as Record<string, unknown>)[k] !== undefined) body[k] = (forwardBody as Record<string, unknown>)[k]
  }
  // 渠道钉住放最后：必须在 `__maxTokensClamp` defineProperty 之后，且只能原地改（见函数注释）。
  // 客户端自带的 provider / providerOptions 不参与透传（不在 passthrough 清单里），
  // 出站路由偏好**只由网关配置决定**，避免客户端绕过钉住。
  injectClineUpstreamPrefs(body, pin, knownUpstreams)
  return body
}

// ===== 响应处理 =====

/** 剥掉上游 {data:{...}} 包装（上游有时包一层 data）。 */
function unwrapData(obj: unknown): unknown {
  if (obj && typeof obj === 'object' && (obj as any).data && typeof (obj as any).data === 'object') {
    const d = (obj as any).data
    if (d.choices || d.id || d.usage) return d
  }
  return obj
}

/** OpenAI SSE 流式帧规整（剥 data 包装），返回要写给客户端的原始文本行；无变化返回 null。 */
function normalizeSSELine(line: string): string | null {
  if (!line.startsWith('data:')) return line + '\n'
  const payload = line.slice(5).trim()
  if (payload === '' || payload === '[DONE]') return line + '\n\n'
  try {
    const normalized = unwrapData(JSON.parse(payload))
    return 'data: ' + JSON.stringify(normalized) + '\n\n'
  } catch {
    return line + '\n'
  }
}

/** 从一帧规整后的 payload 提取 (finish_reason, content 长度, 是否 tool_calls, reasoning 片段)。 */
interface FrameFacts {
  finishReason: string
  contentChars: number
  hasToolCalls: boolean
  reasoningDelta: string | null
}

function inspectFrame(obj: Record<string, unknown> | null): FrameFacts {
  const facts: FrameFacts = { finishReason: '', contentChars: 0, hasToolCalls: false, reasoningDelta: null }
  if (!obj) return facts
  const choice = (((obj.choices as Array<Record<string, unknown>>) || [])[0]) as Record<string, unknown> | undefined
  if (!choice) return facts
  if (choice.finish_reason) facts.finishReason = String(choice.finish_reason)
  const delta = (choice.delta || choice.message) as Record<string, unknown> | undefined
  if (!delta) return facts
  if (delta.content) facts.contentChars = String(delta.content).length
  if (delta.tool_calls && Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) facts.hasToolCalls = true
  const r = (delta.reasoning_content ?? delta.reasoning) as string | undefined
  if (r) facts.reasoningDelta = String(r)
  return facts
}

/**
 * 一帧的「形状」摘录：只取键名 / delta 键名 / finish_reason / error.message，不落正文。
 *
 * 为什么需要（2026-10-02 实测）：上游 200 但零正文时，`frames=1 content=0 reasoning=0`
 * 只能说明「回了一帧空壳」，说不出空壳是**错误帧**（`{"error":…}`）、**role-only 帧**
 * 还是 **usage-only 帧**——而这三者处置完全不同（上游报错 / 模型拒答 / 只结算）。
 * 摘录形状即可定性，且不含用户内容，可安全落 KV 系统日志。
 */
function describeFrameSkeleton(obj: Record<string, unknown> | null, raw: string): string {
  if (!obj) return `unparsed:${raw.replace(/\s+/g, ' ').slice(0, 80)}`
  const keys = Object.keys(obj).slice(0, 8).join(',')
  const err = obj.error
  const errMsg =
    typeof err === 'string' ? err
      : err && typeof err === 'object' ? String((err as Record<string, unknown>).message ?? '')
        : ''
  const choice = (((obj.choices as Array<Record<string, unknown>>) || [])[0]) as Record<string, unknown> | undefined
  const delta = choice && choice.delta && typeof choice.delta === 'object' ? Object.keys(choice.delta as object).slice(0, 8).join(',') : ''
  const finish = choice && choice.finish_reason ? String(choice.finish_reason) : ''
  return `keys=${keys}`
    + (delta ? ` deltaKeys=${delta}` : '')
    + (finish ? ` finish=${finish}` : '')
    + (errMsg ? ` upstreamError=${errMsg.replace(/\s+/g, ' ').slice(0, 120)}` : '')
}

/** 拦截失败时的现场计数（探测期口径）：定性 502 归因用。 */
interface StreamAttemptStats {
  /** 探测期已解析的 SSE data 帧数（0 = 上游一个可用帧都没有）。 */
  frames: number
  /** 探测期见到的正文字符数。 */
  content: number
  /** 探测期见到的 reasoning 字符数。 */
  reasoning: number
  /** 放行缓冲里的帧数（拦截时这些帧会被丢弃）。 */
  buffered: number
  /** 是否见过带 finish_reason 的帧（false = 上游未正常收尾）。 */
  sawFinish: boolean
  /** 探测期读上游是否抛过异常（区分「干净 EOF」与「读错误」）。 */
  probeReadError: boolean
  /** 探测期**首帧**的形状摘录（零正文时用它定性「上游到底回了什么空壳」）。 */
  frameSkeleton: string
}

interface StreamAttemptOutcome {
  kind: 'healthy' | 'degenerate' | 'empty'
  response?: Response
  /** 失败归因：在 pumpStreamAttempt 的哪个分支被判拦截（唯一定性点，见 failed()）。 */
  detail?: string
  /** 失败现场计数（探测期已见的帧/字符），供 proxyStreamChat 逐尝试记日志。 */
  stats?: StreamAttemptStats
}

/**
 * 单次流式尝试的探测阶段 + 后台续流。
 *
 * 关键约束：探测一旦判定「健康放行」，必须【立刻】把 SSE Response 返回给路由，
 * Cloudflare 才会向客户端下发响应头并开始直播；续读上游放在后台任务里写进同一个流。
 * 否则 pump 会等上游整轮结束才返回 → 客户端看不到任何输出（卡住直到超时）。
 *
 * 流程：
 *   1. 探测期：缓冲前 PROBE_MAX_DELTAS 条 reasoning delta，用 isDegenerateReasoningDeltas 判定；
 *      退化/空转 → 取消上游，返回 outcome 供调用方冷却换号重试。
 *   2. 健康 → 建流、把缓冲帧写入、立刻返回 healthy Response，同时后台任务接管剩余上游帧。
 *   3. 后台续流阶段：32 条滚动窗口持续监控，退化中途出现则抑制后续 reasoning delta，
 *      全程未产出正文时发 upstream_runaway 错误帧，并回调 onRunaway 让调用方冷却账号。
 */
/** @internal 流式尝试的探测 + 后台续流（导出供测试验证流式语义）。 */
export async function pumpStreamAttempt(
  resp: Response,
  /** 退化回调：允许返回 Promise（冷却同时要落 KV 状态留档），由本函数 await 后再继续。 */
  onRunaway?: () => void | Promise<void>,
  /** 真实流量留档上下文：给了才会把"上游实际走了哪个渠道"落库（面板的流量视图）。 */
  traffic?: ClineTrafficContext
): Promise<StreamAttemptOutcome> {  const reader = resp.body!.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const sseHeaders = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' }
  const newStream = () => {
    const ts = new TransformStream<Uint8Array, Uint8Array>()
    return { ts, writer: ts.writable.getWriter() }
  }

  // 后台续流阶段共享的滚动状态
  const state = {
    ring: [] as string[],
    suppress: false,
    contentChars: 0,
    reasoningChars: 0,
    frames: 0,
    /** 是否见过带 finish_reason 的帧：流结束时用它判定「上游是否正常收尾」。 */
    sawFinish: false,
    hasToolCalls: false,
  }
  /**
   * 本请求观测到的路由元数据（`provider_metadata.gateway.routing`）。**每请求一份**，
   * 因为它描述的是"这次上游把请求交给了谁"，与帧无关；只保留最后一次出现（后帧更权威，
   * 与 parseClineRoutingMeta 的覆盖语义一致）。
   */
  let routing: ClineRoutingMeta | null = null
  /**
   * 记录一帧的终态统计（探测期与续流期共用，保证 sawFinish 在两条路径上都被置位）。
   *
   * sawFinish 是「上游是否正常收尾」的唯一判据：探测期缓冲的帧由 flushHealthy 直接
   * 写回、不经过 routeToStream，所以只在一处统计会漏掉探测期见到的 finish_reason。
   *
   * 路由元数据也在这里摘（而不是在 routeToStream）：探测期的帧**不经过** routeToStream，
   * 只在那一处摘会漏掉"上游在探测期就已宣告实际渠道"的情况——而那正是最常见的情况。
   * obj 是已经 parse 过的对象，这里是纯遍历，不重复解析 JSON。
   */
  const noteFacts = (facts: FrameFacts, obj?: Record<string, unknown> | null) => {
    state.frames++
    state.contentChars += facts.contentChars
    if (facts.reasoningDelta !== null) state.reasoningChars += (facts.reasoningDelta as string).length
    if (facts.finishReason) state.sawFinish = true
    if (facts.hasToolCalls) state.hasToolCalls = true
    if (traffic && obj) {
      const r = clineRoutingFromFrame(obj)
      if (r.finalProvider || r.fallbacksAvailable) routing = r
    }
  }
  /** 本次尝试收尾时的流量留档（所有出口共用；ok=是否产出了可用流）。 */
  const finishTraffic = async (ok: boolean): Promise<void> => {
    if (!traffic) return
    await recordClineTraffic(traffic, routing, ok)
  }
  let buf = ''
  const probeDeltas: string[] = []   // 探测期收集的 reasoning delta
  const buffered: string[] = []      // 探测期缓冲的原始帧，放行时一次性写回
  /** 探测期**首帧**的形状摘录（只在零正文被拦截时才用得上，见 describeFrameSkeleton）。 */
  let frameSkeleton = ''

  // ---- 探测期时间上限 + 续流期心跳（2026-10-05，移植 luawei1/cline2api `a055b13`）----
  // 背景：探测期此前**一个字节都不写给客户端**（Response 直到 flushHealthy 才构造），
  // 慢首 token（长 reasoning / 上游排队）时中间层读超时会掐掉连接
  // （上游实测 Cloudflare 隧道 120s read timeout → 524）。
  // 处置分两段：
  //   1. 探测期最多等 CLINE_PROBE_MAX_MS：到点仍没判定，就按「当前证据不构成退化」放行，
  //      让响应头先出去；此后由续流阶段的滚动退化监控接管（routeToStream 会抑制垃圾
  //      reasoning 并在收尾发 upstream_runaway），退化保护不丢。
  //   2. 续流阶段超过 CLINE_KEEPALIVE_MS 没往客户端写字节就补一条 SSE 注释行 `: keep-alive`
  //      （与 withSSEKeepAlive 同形态），防上游中途长时间静默被中间层掐断。
  let lastEmitAt = Date.now()
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null
  const stopHeartbeat = () => {
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer)
      heartbeatTimer = null
    }
  }
  const armHeartbeat = (w: WritableStreamDefaultWriter<Uint8Array>) => {
    if (CLINE_KEEPALIVE_MS <= 0) return
    if (heartbeatTimer) clearTimeout(heartbeatTimer)
    heartbeatTimer = setTimeout(() => {
      if (Date.now() - lastEmitAt >= CLINE_KEEPALIVE_MS) {
        lastEmitAt = Date.now()
        // 写失败只可能是流已关闭（客户端断开），忽略即可。
        void w.write(encoder.encode(': keep-alive\n\n')).catch(() => { /* 流已关闭 */ })
      }
      armHeartbeat(w)
    }, CLINE_KEEPALIVE_MS)
  }

  /** 把单行 SSE 帧路由到 writer（供后台续流用），含退化监控 + 抑制 + 空转报错。 */
  const routeToStream = async (line: string, w: WritableStreamDefaultWriter<Uint8Array>): Promise<void> => {
    if (!line.startsWith('data:')) {
      if (line !== '') {
        lastEmitAt = Date.now() // 交到客户端侧流就算「有输出」（TransformStream 写要等读方才 resolve）
        await w.write(encoder.encode(line + '\n'))
      }
      return
    }
    const payload = line.slice(5).trim()
    if (payload === '' || payload === '[DONE]') {
      lastEmitAt = Date.now()
      await w.write(encoder.encode(line + '\n\n'))
      return
    }
    let obj: Record<string, unknown> | null = null
    try { obj = unwrapData(JSON.parse(payload)) as Record<string, unknown> } catch { obj = null }
    const facts = inspectFrame(obj)
    noteFacts(facts, obj)
    const isReasoning = facts.reasoningDelta !== null
    if (isReasoning) {
      state.ring.push(facts.reasoningDelta as string)
      // 按字符数约束窗口（需 ≥DEGENERATE_MIN_CHARS 才能做退化判定，故窗口要够大）
      let ringChars = 0
      for (let i = state.ring.length - 1; i >= 0; i--) {
        ringChars += state.ring[i].length
        if (ringChars >= DEGENERATE_MIN_CHARS * 2) {
          state.ring = state.ring.slice(i)
          break
        }
      }
      if (isDegenerateReasoningDeltas(state.ring)) state.suppress = true
      if (state.suppress) return // 抑制垃圾 reasoning，不再直播到 UI
      // 单词间独立 "\n" 空白 delta：零信息量排版噪声，不再往 UI 直播（段落级 "\n\n" 保留）。
      // 仅跳过转发；ring 上面已计入，退化判定不受影响。
      // 带 finish_reason 的帧不在此跳过——下方空转报错分支依赖它到达客户端。
      if (!facts.finishReason && isWhitespaceOnlyReasoningDelta(facts.reasoningDelta)) return
    }
    // UI 归一化：粘在标点尾部的换行折叠（".\n"→". "，"…\n\n\n"→"…\n\n"）。
    // 只改写转发帧；facts/probeDeltas/ring 里留的是原始 delta，退化判定不受影响。
    if (isReasoning && obj) patchReasoningDeltaForUI(obj)
    if (facts.finishReason && state.suppress && state.contentChars === 0 && !state.hasToolCalls) {
      await onRunaway?.()
      const errMsg = { error: { message: 'Cline 推理退化空转：全程未产出正文，已抑制垃圾 reasoning', type: 'upstream_runaway' } }
      await w.write(encoder.encode('data: ' + JSON.stringify(errMsg) + '\n\n'))
    }
    lastEmitAt = Date.now()
    await w.write(encoder.encode('data: ' + JSON.stringify(obj ?? payload) + '\n\n'))
  }

  /** 健康放行：立即返回 Response，缓冲帧与后续上游帧都在后台任务里写入（reader 挂上后再写，避免背压死锁）。 */
  // firstRead：探测期超时放行时，那次仍在飞的 read 交给续流任务消费——
  // 丢掉它会让续流阶段的第一个 read 变成「下一块」，已入队的首帧永久丢失。
  const flushHealthy = (
    continuationBuf: string,
    firstRead?: Promise<ReadableStreamReadResult<Uint8Array>>
  ): StreamAttemptOutcome => {
    const { ts, writer: w } = newStream()
    const initial = buffered.slice()
    buffered.length = 0
    state.ring = probeDeltas.slice(-RING_SIZE)
    void (async () => {
      armHeartbeat(w)
      let abnormal = false
      try {
        // 先写探测期缓冲的帧
        for (const f of initial) {
          lastEmitAt = Date.now()
          await w.write(encoder.encode(f))
        }
        let cbuf = continuationBuf
        // 排空探测期已读入但尚未处理的整行
        let ci: number
        while ((ci = cbuf.indexOf('\n')) >= 0) {
          const line = cbuf.slice(0, ci)
          cbuf = cbuf.slice(ci + 1)
          await routeToStream(line, w)
        }
        // 探测期超时放行时那次仍在飞的 read 排在本轮队首，必须先消费它
        let carried: Promise<ReadableStreamReadResult<Uint8Array>> | null = firstRead ?? null
        try {
          while (true) {
            const r = carried ?? reader.read()
            carried = null
            const { done, value } = await r
            if (done) break
            cbuf += decoder.decode(value, { stream: true })
            let idx: number
            while ((idx = cbuf.indexOf('\n')) >= 0) {
              const line = cbuf.slice(0, idx)
              cbuf = cbuf.slice(idx + 1)
              await routeToStream(line, w)
            }
          }
        } catch {
          // 上游流异常（网络重置/断连等）：不再静默截断。给客户端发一帧错误后再收尾，
          // 让 DSH 等客户端按可重试错误快速处理，而不是对着一个没有 finish_reason 的
          // 半截流干等超时。帧格式与上方 upstream_runaway 错误帧一致。
          abnormal = true
          const errMsg = { error: { message: 'Cline 上游流中途断开，连接异常终止', type: 'upstream_interrupted' } }
          await w.write(encoder.encode('data: ' + JSON.stringify(errMsg) + '\n\n')).catch(() => {})
        }
        // 上游「干净结束」但全程没发 finish_reason：此前直接 w.close()，客户端只看到半截流，
        // DSH 归类成 TRANSPORT 的 Stream ended without finish_reason 并白重试 5 次（实测
        // 2026-09-25 一轮 6 次全挂、约 77 秒）。补一帧具名错误，把静默截断变成可归因的失败。
        // 注意：探测期缓冲帧由上面 initial 循环直接写回、不过 routeToStream，故 sawFinish
        // 必须由 noteFacts 在探测期也置位（见 state 上方注释）。
        if (!abnormal && !state.sawFinish) {
          const detail =
            `frames=${state.frames}, content=${state.contentChars}, reasoning=${state.reasoningChars}, toolCalls=${state.hasToolCalls}`
          const errMsg = {
            error: { message: `Cline 上游流未发送 finish_reason 即结束（疑似截断）：${detail}`, type: 'upstream_no_finish' },
          }
          await w.write(encoder.encode('data: ' + JSON.stringify(errMsg) + '\n\n')).catch(() => {})
        }
      } finally {
        // 收尾必须放在 finally：客户端中途断开时上面的 w.write 会抛，若不留档就正好丢掉
        // 「被断开的那次请求实际走了哪个渠道」——而那恰恰是最需要看的样本。
        stopHeartbeat()
        // 留档在 close 之前 await：观测必须在响应真正结束前落盘，否则 isolate 可能先被回收，
        // 留下「发过请求却没有任何记录」的洞（同 logClineAttempt 的确定性取舍）。
        await finishTraffic(!abnormal && state.sawFinish)
        await w.close().catch(() => {})
      }
    })().catch(() => {
      // 客户端在续流途中断开：TransformStream 写入会 reject，属正常收尾，不外抛
    })
    return { kind: 'healthy', response: new Response(ts.readable, { status: 200, headers: sseHeaders }) }
  }

  /** 探测期累计 reasoning 的空白占比（随时可算，无需等满 250 字符）。 */
  const probeWsRatio = () => {
    let chars = 0
    let ws = 0
    for (const t of probeDeltas) {
      chars += t.length
      ws += (t.match(/\s/g) || []).length
    }
    return { chars, ratio: chars ? ws / chars : 0 }
  }

  // ---- 探测阶段：读行直到能做出放行/拦截判定 ----
  // 探测最多等 CLINE_PROBE_MAX_MS：到点仍未判定就放行（响应头先出去，防 524）。
  // 到点时若证据已构成退化，仍按 degenerate 拦截——空白洪泛通常在几百字符内就够判，
  // 慢的是「正常长思考」，那种本来就该早点放行给客户端看。
  let probeErrored = false
  let probeTimer: ReturnType<typeof setTimeout> | null = null
  const PROBE_TIMEOUT = Symbol('probe-timeout')
  /** 探测期唯一在飞的 read：超时放行时必须交给续流任务，否则首帧会被跳过。 */
  let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | null = null
  /**
   * 拦截出口统一构造器：除 kind 外附带 detail（命中分支）+ 现场计数。
   * 此前只有聚合 502（「退化/空响应/截断」三合一文案），线上无法分辨到底中了哪一种；
   * detail 是唯一能定性的字段，新增拦截分支时**必须**给出新的 detail 值。
   *
   * 为什么是 async：拦截路径也要留流量观测（被拦截的那一轮**照样**从上游拿到了真实路由结果，
   * 丢掉它等于把"最需要看的失败请求"排除在流量画像之外）。
   */
  const failed = async (kind: 'degenerate' | 'empty', detail: string): Promise<StreamAttemptOutcome> => {
    await finishTraffic(false)
    return {
      kind,
      detail,
      stats: {
        frames: state.frames,
        content: state.contentChars,
        reasoning: state.reasoningChars,
        buffered: buffered.length,
        sawFinish: state.sawFinish,
        probeReadError: probeErrored,
        frameSkeleton: frameSkeleton || '(无 data 帧)',
      },
    }
  }
  try {
    while (true) {
      const readOnce = pendingRead ?? (pendingRead = reader.read())
      const raced = await Promise.race([
        readOnce,
        new Promise<typeof PROBE_TIMEOUT>((resolve) => {
          probeTimer = setTimeout(() => resolve(PROBE_TIMEOUT), CLINE_PROBE_MAX_MS)
        }),
      ])
      if (probeTimer) {
        clearTimeout(probeTimer)
        probeTimer = null
      }
      // 到点：只放行缓冲帧交给续流监控；退化证据已足则照旧拦截
      if (raced === PROBE_TIMEOUT) {
        const { chars: tChars, ratio: tRatio } = probeWsRatio()
        if (tChars >= DEGENERATE_MIN_CHARS && tRatio >= DEGENERATE_MAX_WS_RATIO) {
          await reader.cancel().catch(() => {})
          return failed('degenerate', 'probe-timeout-ws-ratio')
        }
        return flushHealthy(buf, readOnce)
      }
      pendingRead = null
      const { done, value } = raced
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)

        if (!line.startsWith('data:')) {
          if (line !== '') buffered.push(line + '\n')
          continue
        }
        const payload = line.slice(5).trim()
        if (payload === '' || payload === '[DONE]') {
          buffered.push(line + '\n\n')
          continue
        }
        let obj: Record<string, unknown> | null = null
        try { obj = unwrapData(JSON.parse(payload)) as Record<string, unknown> } catch { obj = null }
        if (!frameSkeleton) frameSkeleton = describeFrameSkeleton(obj, payload)
        const facts = inspectFrame(obj)
        noteFacts(facts, obj)
        const isReasoning = facts.reasoningDelta !== null
        if (isReasoning) probeDeltas.push(facts.reasoningDelta as string)
        // 纯空白 "\n" 排版噪声：照常计入 probeDeltas（退化判定依赖空白占比），
        // 但不写入放行缓冲，放行后不会直播到 UI。
        const noiseFrame = isReasoning && isWhitespaceOnlyReasoningDelta(facts.reasoningDelta)
        // 探测缓冲帧同样做 UI 归一化（粘在标点尾部的换行折叠），与续流路径行为一致。
        if (isReasoning && obj) patchReasoningDeltaForUI(obj)
        const frame = 'data: ' + JSON.stringify(obj ?? payload) + '\n\n'
        const { chars: pChars, ratio: pRatio } = probeWsRatio()

        // 模型已开始产出正文或工具调用 → 正常回答，健康放行
        if (facts.contentChars > 0 || state.hasToolCalls) {
          if (!noiseFrame) buffered.push(frame)
          return flushHealthy(buf)
        }
        // 已缓冲足够 reasoning 且空白占绝对主导（≥0.55 持续）→ 退化空转，拦截重试
        if (pChars >= DEGENERATE_MIN_CHARS && pRatio >= DEGENERATE_MAX_WS_RATIO) {
          await reader.cancel().catch(() => {})
          return failed('degenerate', 'probe-ws-ratio')
        }
        // 窗口满且空白未占主导 → 是正常（可能一词一行）的思考，健康放行
        if (probeDeltas.length >= PROBE_MAX_DELTAS && pRatio < DEGENERATE_MAX_WS_RATIO) {
          if (!noiseFrame) buffered.push(frame)
          return flushHealthy(buf)
        }
        // 探测期内上游已结束：空白主导→退化；length 无产出→空响应；否则放行缓冲内容
        if (facts.finishReason) {
          if (pRatio >= DEGENERATE_MAX_WS_RATIO && pChars >= DEGENERATE_MIN_CHARS) {
            await reader.cancel().catch(() => {})
            return failed('degenerate', 'probe-finish-ws-ratio')
          }
          if (facts.finishReason === 'length' && state.contentChars === 0 && !state.hasToolCalls) {
            await reader.cancel().catch(() => {})
            return failed('empty', 'probe-finish-length-no-content')
          }
          if (!noiseFrame) buffered.push(frame)
          return flushHealthy(buf)
        }
        if (!noiseFrame) buffered.push(frame)
      }
    }
  } catch {
    /* 探测期读上游异常：下方按空流处理 */
    probeErrored = true
  }

  // 探测阶段上游流自然结束
  const { chars: tailChars, ratio: tailRatio } = probeWsRatio()
  if (tailChars >= DEGENERATE_MIN_CHARS && tailRatio >= DEGENERATE_MAX_WS_RATIO) {
    await reader.cancel().catch(() => {})
    return failed('degenerate', 'probe-eof-ws-ratio')
  }
  if (buffered.length === 0) {
    await reader.cancel().catch(() => {})
    return failed('empty', 'probe-eof-no-frames')
  }
  // 有帧、但全程没见过 finish_reason：上游是「截断结束」而不是正常收尾。
  // 此刻还一字节都没写给客户端（探测期的帧全在 buffered 里），所以可以安全丢弃重试——
  // 交给 proxyStreamChat 冷却换号，比把半截流交给客户端好（DSH 会归成 TRANSPORT 的
  // Stream ended without finish_reason 并白重试 5 次；2026-09-25 实测一轮 6 次全挂）。
  //
  // 只覆盖「干净 EOF」这一种。探测期读异常（probeErrored）保持原行为：flushHealthy +
  // upstream_interrupted 错误帧——那条路径有专门用例钉住，是否也改成重试属于独立决策。
  // 观测到的线上故障正是干净 EOF（客户端只报 Stream ended without finish_reason、
  // 没收到任何具名错误帧），所以这个范围足够覆盖它。
  if (!probeErrored && !state.sawFinish) {
    await reader.cancel().catch(() => {})
    return failed('empty', 'probe-eof-no-finish')
  }
  return flushHealthy(buf)
}

/**
 * 模型级冷却（与 clineFetchWithRetry 同语义：有 model 上下文时只冷却该账号的该模型）。
 * 流式路径的拦截出口（退化/空流）也经此落 KV 状态，面板才能看到「这个号为什么被换掉」。
 */
async function applyModelCooldown(
  pool: Pool,
  model: string,
  ms: number,
  kind: ClineAccountStateKind,
  reason: string,
  clientSignal?: AbortSignal
) {
  // 客户端已断开不是模型故障（移植 4265b29）：不冷却，否则单账号池下用户配置的模型被拉黑。
  if (clientSignal?.aborted) return
  if (!pool.current) return
  const acc = pool.current
  if (model) {
    const until = Date.now() + Math.max(ms, 60 * 1000)
    acc.modelCooldowns.set(model, until)
    await recordCooldownState(pool, acc, until, kind, model, reason)
  } else {
    const until = cooldownAccount(acc, ms)
    await recordCooldownState(pool, acc, until, kind, null, reason)
  }
}

/**
 * 把一条拦截归因写到两个日志出口：console（CF 仪表盘）+ KV 系统日志（管理面板「系统日志」）。
 *
 * 为什么必须落 KV（2026-10-02）：三轮全失败的聚合 502 文案把「推理退化 / 零帧空流 / 截断无
 * finish / 探测期读错误」四类混在一起，只有 detail 能定性；而 console 只在 CF 仪表盘可见，
 * 用户在面板里查不到，线上排查只能靠猜。落 KV 后发起一次请求即可在面板搜 `[cline-attempt]`。
 *
 * 有意取舍：await 而不 fire-and-forget——失败路径本来就要等冷却+重试，多一次 KV put 无感，
 * 换来「响应返回时日志已落盘」的确定性（也便于单测断言）。任何写日志失败都不得影响响应。
 */
async function logClineAttempt(env: Env | undefined, message: string, details?: string): Promise<void> {
  console.log(message)
  if (!env?.KV) return
  try {
    await writeLog(env, 'warn', message, details)
  } catch { /* 日志失败不影响响应 */ }
}

/**
 * 渠道钉住归因日志：把「这条请求被钉到哪」同时写 console 与 KV 系统日志（面板里搜 `[cline-pin]`）。
 *
 * 为什么必须落 KV：钉住是否生效**只能从日志看出来**——出站请求体是网关拼的，客户端看不到；
 * console 只在 CF 仪表盘可见，用户面板里查不到（与 `[cline-attempt]` 同一动机，见上）。
 *
 * 为什么用 info 而不是 warn（2026-10-06）：钉住是**配置驱动的正常行为**，不是告警。走 warn 出口
 * 会让「系统日志」的 warn 计数被正常流量灌满，真正的告警被淹没。
 *
 * 为什么按 (提供商, 模型, 决定内容) 做 5 分钟去重：配置不变时同模型的决定恒定不变，逐请求落盘
 * 只会刷满日志（面板按 KV 键名分页，噪声会挤掉真正的错误行）。决定一变（改配置/清单变化）立刻
 * 留痕。与 `logClineAttempt` 不同——那条是异常路径，逐次必落。
 */
const CLINE_PIN_LOG_WINDOW_MS = 5 * 60 * 1000
const clinePinLoggedAt = new Map<string, number>()

/** 去重判定（导出以便单测直接钉住"5 分钟内不重复落盘、决定变化立刻落盘"）。 */
export function shouldLogClinePin(key: string, now = Date.now()): boolean {
  const last = clinePinLoggedAt.get(key)
  if (last !== undefined && now - last < CLINE_PIN_LOG_WINDOW_MS) return false
  // isolate 长活时键数受 (提供商 × 模型 × 决定) 组合数限制，但仍加一道上界防无界增长
  if (clinePinLoggedAt.size > 200) clinePinLoggedAt.clear()
  clinePinLoggedAt.set(key, now)
  return true
}

/** 仅供测试：清空去重窗口，避免用例间互相影响。 */
export function __resetClinePinLogForTests(): void {
  clinePinLoggedAt.clear()
}

async function logClinePinDecision(
  env: Env | undefined,
  providerId: string,
  model: string,
  decision: ClinePinDecision
): Promise<void> {
  const text = clinePinDecisionText(decision)
  if (!shouldLogClinePin(`${providerId}|${model}|${text}`)) return
  const line = `[cline-pin] ${providerId} model=${model} ${text}`
  console.log(line)
  if (!env?.KV) return
  try {
    await writeLog(env, 'info', line)
  } catch { /* 日志失败不影响响应 */ }
}

/**
 * 流式转发（带推理空转防护）：最多 3 次尝试，退化/空响应冷却切号重试；
 * 全部失败时返回 502 错误 JSON（客户端按错误处理，可自行重试）。
 */
async function proxyStreamChat(
  pool: Pool,
  body: Record<string, unknown>,
  sessionId: string,
  clientSignal?: AbortSignal,
  env?: Env,
  /** 真实流量留档上下文：透传给每次流式尝试（含被拦截重试的那几轮）。 */
  traffic?: ClineTrafficContext
): Promise<Response> {
  const model = String((body as Record<string, unknown>).model || '')
  /** 三次尝试的定性结果（kind:detail），用于聚合 502 时一行说清「空在哪一种」。 */
  const failedKinds: string[] = []
  for (let attempt = 0; attempt < 3; attempt++) {
    if (clientSignal?.aborted) throw clientAbortedError()
    const resp = await clineFetchWithRetry(pool, '/chat/completions', body, sessionId, true, 4, clientSignal)
    if (!resp.ok) {
      // 402 余额耗尽是我们自己合成的响应（已带明确 message 与 type），原样透传不二次包装
      if (resp.headers.get('X-Cline-Plan-Exhausted')) return resp
      const errText = await resp.text().catch(() => '')
      return jsonResponse(
        { error: { message: `Cline 上游 HTTP ${resp.status}: ${errText.slice(0, 300)}`, type: 'upstream_error' } },
        resp.status || 502
      )
    }
    const outcome = await pumpStreamAttempt(
      resp,
      () => applyModelCooldown(pool, model, CLINE_COOLDOWN_RUNAWAY_MS, 'runaway', '推理退化空转：全程未产出正文', clientSignal),
      traffic
    )
    if (outcome.kind === 'healthy') {
      // 真的产出了可用流 = 这个账号此刻确实能用，清掉它的冷却留档（面板不再挂着过期结论）
      await clearCooldownState(pool, pool.current)
      return outcome.response!
    }
    // 客户端已断开：不再冷却、不再重试，直接放弃本轮（上游白烧的代价已止住）
    if (clientSignal?.aborted) throw clientAbortedError()
    const cooldownReqMs = outcome.kind === 'degenerate' ? CLINE_COOLDOWN_RUNAWAY_MS : CLINE_COOLDOWN_EMPTY_MS
    await applyModelCooldown(
      pool,
      model,
      cooldownReqMs,
      // degenerate = 模型输出退化（空转/噪声），empty = 上游零帧或截断，后者是免费额度耗尽的典型形态
      outcome.kind === 'degenerate' ? 'runaway' : 'quota_empty',
      `流式尝试被拦截：${outcome.kind}:${outcome.detail || 'unknown'}`,
      clientSignal
    )
    // 逐尝试归因日志：三轮全失败时客户端只拿到三合一的 502 文案，分辨不了中了哪一种
    // （退化 / 零帧 / 截断无 finish / 探测期读错误）。detail 是 pumpStreamAttempt 拦截出口
    // 唯一给出的定性字段；stats 计数（尤其 frames=0 与 sawFinish）用于区分「上游空响应」
    // 与「上游截断」。console 进 CF 仪表盘，同时落 KV 系统日志供面板检索。
    const detail = outcome.detail || 'unknown'
    failedKinds.push(`${outcome.kind}:${detail}`)
    await logClineAttempt(
      env,
      `[cline-attempt] model=${model} attempt=${attempt + 1}/3 kind=${outcome.kind} detail=${detail} ` +
      `frames=${outcome.stats?.frames ?? '?'} content=${outcome.stats?.content ?? '?'} ` +
      `reasoning=${outcome.stats?.reasoning ?? '?'} buffered=${outcome.stats?.buffered ?? '?'} ` +
      `sawFinish=${outcome.stats?.sawFinish ?? '?'} probeReadError=${outcome.stats?.probeReadError ?? '?'} ` +
      `firstFrame=${outcome.stats?.frameSkeleton ?? '?'} cooldownReqMs=${cooldownReqMs}`,
      JSON.stringify({ ...(outcome.stats || {}), cooldownReqMs }),
    )
    await sleep(500 + Math.random() * 500)
  }
  // 聚合结论单独一行：一条日志即可回答「三轮分别空在哪一种」，不用翻三条。
  await logClineAttempt(
    env,
    `[cline-attempt] model=${model} 三轮全拦截 → 502 upstream_runaway，明细=[${failedKinds.join(', ')}]`,
    JSON.stringify({ model, attempts: failedKinds }),
  )
  // 不带任何换模型标记：客户端拿到的就是「点名模型三轮产不出可用流」这个事实
  // （用户决定不做自动切换免费路由，见 proxyClineChatRequest 的注释）。
  return jsonResponse(
    { error: { message: 'Cline 推理退化/空响应/上游截断连续 3 次未产出可用流，已冷却换号仍失败', type: 'upstream_runaway' } },
    502
  )
}

function jsonResponse(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

/**
 * 402 余额耗尽、且该模型在全部账号上都不可用时的响应。
 *
 * 状态码保留 402（上层与客户端能按「余额」语义识别、可与 429 区分），
 * `type` 用 `upstream_plan_exhausted` 与普通上游错误区分。
 * 该响应同时是免费链的「换下一个模型」信号（见 proxyClineChatRequest）。
 */
function planExhaustedResponse(upstreamText = ''): Response {
  const detail = upstreamText ? ` 上游原文：${upstreamText.slice(0, 200)}` : ''
  return new Response(
    JSON.stringify({
      error: {
        message:
          'Cline 余额/权益耗尽（402 insufficient_credits）：该模型走 credits 计费档而账号余额不足。' +
          '请改用免费档模型（cline-free/* 或 stealth/space-bunny-alpha），或充值后重试。' +
          detail,
        type: 'upstream_plan_exhausted',
      },
    }),
    {
      status: 402,
      // 标记：调用方原样透传，不再被包装成 "Cline 上游 HTTP 402: {...}"
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Cline-Plan-Exhausted': '1' },
    }
  )
}

// ===== 非流式聚合（item4/5）：上游恒定流式，客户端要非流式时把 SSE 聚合成 chat.completion =====

interface AggregatedChat {
  id: string
  model: string
  created: number
  content: string
  reasoning: string
  toolCalls: Array<{ id: string; name: string; arguments: string }>
  usage: Record<string, unknown> | null
  finishReason: string
  /** 是否见到上游的正常收尾标记（`[DONE]` 或带 finish_reason 的帧）。 */
  sawDone: boolean
  /** 上游在 200 之后于流内下发的具名错误帧（代理常把 502/504 这样塞进 SSE）。 */
  streamError: string
  /** 本段流里读到的路由元数据（上游实际走了哪个渠道）；读不到为 null。 */
  routing: ClineRoutingMeta | null
}

/** 读取整段上游 SSE，累积 content / reasoning / tool_calls / usage，返回聚合后的 chat 状态。 */
async function aggregateStream(upstream: Response): Promise<AggregatedChat> {
  const reader = upstream.body!.getReader()
  const decoder = new TextDecoder()
  const toolIndex = new Map<number, number>()
  const acc: AggregatedChat = { id: '', model: '', created: 0, content: '', reasoning: '', toolCalls: [], usage: null, finishReason: '', sawDone: false, streamError: '', routing: null }
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '') continue
      if (payload === '[DONE]') {
        acc.sawDone = true
        continue
      }
      try {
        const obj = JSON.parse(payload) as Record<string, unknown>
        const o = unwrapData(obj) as Record<string, unknown>
        // 流内错误帧：上游以 HTTP 200 + SSE error 的形式下发（排队超时 / 空闲 504 / 早断流）。
        // 此前整帧被当作无 choices 的普通帧忽略 → 最终回 200 + 空 content，客户端无从归因。
        const err = o.error as Record<string, unknown> | undefined
        if (err && typeof err === 'object') {
          const msg = err.message
          acc.streamError = typeof msg === 'string' && msg ? msg : 'upstream stream error'
          continue
        }
        if (o.id) acc.id = String(o.id)
        if (o.model) acc.model = String(o.model)
        if (o.created) acc.created = Number(o.created)
        if (o.usage) acc.usage = o.usage as Record<string, unknown>
        // 路由元数据与 content 无关，可能出现在任意一帧（实测常与 usage 同帧）；读到即覆盖
        // （后帧更权威，与 parseClineRoutingMeta 的语义一致）。非流式路径同样要留流量观测。
        const r = clineRoutingFromFrame(o)
        if (r.finalProvider || r.fallbacksAvailable) acc.routing = r
        const choice = (((o.choices as Array<Record<string, unknown>>) || [])[0]) as Record<string, unknown> | undefined
        if (!choice) continue
        if (choice.finish_reason) acc.finishReason = String(choice.finish_reason)
        const delta = (choice.delta || choice.message) as Record<string, unknown> | undefined
        if (!delta) continue
        if (delta.content) acc.content += String(delta.content)
        if (delta.reasoning_content) acc.reasoning += String(delta.reasoning_content)
        else if (delta.reasoning) acc.reasoning += String(delta.reasoning)
        const tcs = delta.tool_calls as Array<Record<string, unknown>> | undefined
        if (Array.isArray(tcs)) {
          for (const tc of tcs) {
            const i = Number(tc.index ?? 0)
            const fn = tc.function as Record<string, unknown> | undefined
            if (tc.id && fn) {
              toolIndex.set(i, acc.toolCalls.length)
              acc.toolCalls.push({ id: String(tc.id), name: String(fn.name || ''), arguments: String(fn.arguments || '') })
            } else if (fn?.arguments) {
              const ti = toolIndex.get(i)
              if (ti !== undefined) acc.toolCalls[ti].arguments += String(fn.arguments)
            }
          }
        }
      } catch { /* 解析失败忽略 */ }
    }
  }
  return acc
}

/** 聚合结果 → OpenAI 非流式 chat.completion JSON。 */
function chatCompletionFromAgg(a: AggregatedChat): Record<string, unknown> {
  const message: Record<string, unknown> = { role: 'assistant', content: a.content }
  if (a.reasoning) message['reasoning_content'] = a.reasoning
  if (a.toolCalls.length) {
    message['tool_calls'] = a.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } }))
  }
  return {
    id: a.id || 'chatcmpl-' + Date.now(),
    object: 'chat.completion',
    created: a.created || Math.floor(Date.now() / 1000),
    model: a.model,
    choices: [{ index: 0, message, finish_reason: a.finishReason || 'stop' }],
    usage: a.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }
}

/**
 * 非流式转发：上游已是 SSE，聚合成非流式。
 * - 流内错误帧 / 中途截断（既无 finish_reason 也无 [DONE]）→ 直接 502 具名错误，不冷却账号、不谎报 200；
 * - 正常收尾但正文为空（含推理空转被 length 截断）→ 冷却切号重试（最多 3 次），
 *   最后仍空则把 reasoning 兜底拼进 content，避免"静默不回复"（item5）。
 */
async function proxyNonStreamChat(
  pool: Pool,
  body: Record<string, unknown>,
  sessionId: string,
  clientSignal?: AbortSignal,
  traffic?: ClineTrafficContext
): Promise<Response> {
  // 恒流式前置：无论调用方 body 是否带 stream，一律强制 stream:true，
  // 否则免费通道非流式返回 500 "empty response content"（item4 修复测试/直连等手工 body 场景）。
  body['stream'] = true
  let last: AggregatedChat | null = null
  // 真实流量留档：非流式是**同一段上游流**聚合出来的，路由证据一样有效，不能只在流式路径记。
  // 用 try/finally 收口：本函数有多条 return（成功 / 流内错误 / 截断 / 空响应兜底），
  // 逐条补留档必然漏一条——而漏掉的那条恰好会是"失败请求"。
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (clientSignal?.aborted) throw clientAbortedError()
      const resp = await clineFetchWithRetry(pool, '/chat/completions', body, sessionId, true, 4, clientSignal)
      if (!resp.ok) {
        // 402 余额耗尽是我们自己合成的响应（已带明确 message 与 type），原样透传不二次包装
        if (resp.headers.get('X-Cline-Plan-Exhausted')) return resp
        const errText = await resp.text().catch(() => '')
        return jsonResponse(
          { error: { message: `Cline 上游 HTTP ${resp.status}: ${errText.slice(0, 300)}`, type: 'upstream_error' } },
          resp.status || 502
        )
      }
      const agg = await aggregateStream(resp)
      last = agg
      // 上游流内错误帧：200 里塞的具名失败（排队超时 / 空闲 504）。此前整帧被忽略，
      // 结果是回 200 + 空 content，客户端看到「成功但什么都没说」。
      if (agg.streamError) {
        return jsonResponse(
          { error: { message: `Cline 上游流内报错：${agg.streamError.slice(0, 300)}`, type: 'upstream_stream_error' } },
          502,
        )
      }
      // 流被中途截断（全程既没见 [DONE] 也没有 finish_reason）：**即使已有部分正文也不谎报成功**，
      // 与流式路径同口径（探测期丢弃半截帧、交给上层重试，见 pumpStreamAttempt 的截断分支）。
      // 不冷却账号：截断多来自网关/中间层掐连接，不是账号本身的问题，冷却只会连坐好号。
      if (!agg.sawDone && !agg.finishReason) {
        return jsonResponse(
          {
            error: {
              message: `Cline 上游流未发送 finish_reason/[DONE] 即结束（疑似截断）：chars=${agg.content.length}, reasoning=${agg.reasoning.length}, toolCalls=${agg.toolCalls.length}`,
              type: 'upstream_truncated',
            },
          },
          502,
        )
      }
      if (agg.content) {
        // 非流式路径：真拿到正文才算这个账号可用，清掉冷却留档（200 但无正文不算）
        await clearCooldownState(pool, pool.current)
        return jsonResponse(chatCompletionFromAgg(agg), 200)
      }
      // 推理空转被截断（length + 无正文/无工具调用）：预算烧在 reasoning 上未产出 → 冷却切号重试
      if (isRunawayReasoningCutoff(agg.content, agg.toolCalls, agg.finishReason)) {
        if (pool.current) {
          const until = cooldownAccount(pool.current, CLINE_COOLDOWN_RUNAWAY_MS)
          // model 传 null：这是**账号级**冷却，留档里写模型会让面板把「整个账号被禁入」误读成「只有该模型不可用」
          await recordCooldownState(pool, pool.current, until, 'runaway', null, '推理空转被 length 截断，未产出正文')
        }
        await sleep(500 + Math.random() * 500)
        continue
      }
      // 有正常结束原因但无文本：不空转重试（如 stop/tool_calls 但 content 空，属合法但不该重试）
      if (agg.finishReason) break
      // 客户端已断开：放弃本轮且不冷却账号（移植 4265b29）
      if (clientSignal?.aborted) throw clientAbortedError()
      if (pool.current) {
        // 无 finish_reason 且无正文 = 上游零帧/空响应，免费额度耗尽的典型形态（账号级冷却）
        const until = cooldownAccount(pool.current, CLINE_COOLDOWN_EMPTY_MS)
        await recordCooldownState(pool, pool.current, until, 'quota_empty', null, '上游零帧空响应（免费额度可能已耗尽）')
      }
      await sleep(500 + Math.random() * 500)
    }
    if (last && last.content === '' && last.reasoning) last.content = last.reasoning
    return jsonResponse(chatCompletionFromAgg(last as AggregatedChat), 200)
  } finally {
    // 只在真的读到过上游 200 响应体时留档：402 余额耗尽 / HTTP 错误是**路由之前**就被拒的，
    // 把它们算成"读不到路由信息"会污染流量画像（看起来像网关不吐路由元数据）。
    if (traffic && last) {
      await recordClineTraffic(traffic, last.routing, !!(last.sawDone || last.finishReason))
    }
  }
}

// ===== 对外接口 =====

export interface ClineProxyOptions {
  /** 客户端是否要求流式（false 时聚合为非流式 chat.completion） */
  stream?: boolean
  /**
   * 入站请求的 signal（客户端断开时 abort）。用于两处纪律（移植 luawei1/cline2api `4265b29`）：
   *   - 立刻中止上游 fetch，不再把整轮读完；
   *   - 断开**不**记任何账号/模型冷却——Esc 中断与客户端重连不是模型失败。
   */
  signal?: AbortSignal
}

/**
 * 转发一次 chat 请求到 Cline 上游。
 * 返回 Response：
 *   - stream=true：OpenAI SSE（剥掉 data 包装后的透传）
 *   - stream=false：剥掉 data 包装后的非流式 chat.completion JSON
 */
export async function proxyClineChatRequest(
  _env: unknown,
  provider: Provider,
  forwardBody: Record<string, unknown>,
  opts?: ClineProxyOptions
): Promise<Response> {
  const pool = poolFromProvider(provider, _env as Env)
  // 只认显式给出的 opts.stream；opts 存在但没带 stream 时**不能**当成非流式——
  // 否则流式客户端会收到一个 application/json 聚合体，pi-ai/OpenAI SDK 按 SSE
  // 解析得到 0 个 chunk，报 "Stream ended without finish_reason"（TRANSPORT）并白重试 5 次。
  const wantStream = opts?.stream ?? forwardBody.stream === true
  const sessionId = 'sess_' + Date.now()
  const model = String(forwardBody.model || DEFAULT_MODEL)
  const { freeSet } = await getClineCatalog()
  // 只服务点名的模型（用户决定，2026-10-02）：**不做任何模型级自动替换**。
  // 402/429（余额耗尽/限流）、连接故障、三轮产不出可用流，一律原样报错，由客户端决定
  // 重试还是自己换模型。曾经的两条自动换模型路径——免费链降级（移植 169fd9d）与
  // transport 换候选（456d6ce）——已按同一决定退役，回归保护见 proxy.test.ts。
  // 该模型在所有账号上都冷却中（余额耗尽/限流的模型级冷却）→ 直接报错，不打上游。
  if (!hasAvailableAccount(pool, model)) {
    return jsonResponse({
      error: {
        message: `Cline 点名模型 ${model} 在当前账号池上均处于冷却中（余额耗尽/限流），请稍后重试或自行更换模型`,
        type: 'upstream_unavailable',
      },
    }, 502)
  }
  // 上游恒定强制流式（item4）：免费通道非流式返回 500 "empty response content"，
  // 统一以流式取数，客户端要非流式时再聚合成 chat.completion。
  // 渠道钉住按**点名模型**取配置：本仓不做模型级替换，所以这里的 model 就是发给上游的 model。
  const pinCfg = provider.clinePinByModel?.[model] || null
  // `exclude` 只能换算成 only 白名单（网关两侧都不认 exclude/ignore 字段），换算要用该模型的
  // 渠道清单；没配 exclude 时**不读 KV**，热路径零额外开销。清单读不到时排除不会生效，
  // 但会由归因日志的 exclude-unresolved 标记出来（见 logClinePinDecision）。
  const knownUpstreams = pinCfg?.exclude?.length
    ? (await readClineUpstreamCache(_env as Env | undefined, provider.id)).probes[model]?.upstreams || []
    : []
  const body = buildUpstreamBody({ ...forwardBody, model }, true, sessionId, freeSet, pinCfg, knownUpstreams)
  // 归因：钉住是配置驱动的路由改写，出问题时必须能一眼看出「这条请求被谁钉到哪」。
  const pinDecision = clinePinDecision(body)
  if (pinDecision) await logClinePinDecision(_env as Env | undefined, provider.id, model, pinDecision)
  // 真实流量留档：把「上游实际走了哪个渠道」写进 KV，面板不必再发请求就能看到全量流量画像。
  // sent 取**实际下发**的偏好（不是配置）：exclude 换算失败时两者不同，拿配置判会得出假结论。
  const traffic: ClineTrafficContext = {
    env: _env as Env | undefined,
    providerId: provider.id,
    model,
    sent: {
      only: pinDecision?.only || [],
      order: pinDecision?.order || [],
      sort: pinDecision?.sort ?? null,
    },
  }
  try {
    const resp = wantStream
      ? await proxyStreamChat(pool, body, sessionId, opts?.signal, _env as Env | undefined, traffic)
      : await proxyNonStreamChat(pool, body, sessionId, opts?.signal, traffic)
    const clamp = clineMaxTokensClamp(body)
    if (clamp) console.log(`[cline-max-tokens] ${model} 输出预算被封顶 ${clamp.from}->${clamp.to}（模型硬上限）`)
    return withMaxTokensClampHeader(resp, clamp)
  } catch (err) {
    // 客户端已断开：没人要这个响应了，也不该定责成任何错误码（更不能罚冷却）。
    if ((err as ClineTransportError).kind === 'client') {
      return new Response(null, { status: 499 })
    }
    // 传输层故障（建连/首字节失败，见 clineFetch 的 ClineTransportError）→ 按 trae 口径定责：
    // 503 `upstream_unreachable`，文案点明「账号未被惩罚，非账号池问题」。
    // 用 503 而非 500：客户端（DSH/pi-ai）对 5xx 一样可重试，但 code 与文案把排查方向
    // 从「账号池」引回「网关↔上游连接」——2026-09-27 那次用户正是被 500 api_error 引偏，
    // 去查重试延迟而不是 90s 建连超时（trae 侧同类修复见 src/trae/proxy.ts:733-738）。
    if ((err as ClineTransportError).kind === 'transport') {
      return jsonResponse({
        error: {
          message: 'Cline 上游连接超时/中断（账号未被惩罚，非账号池问题）：' + ((err as Error).message || ''),
          type: 'api_error',
          code: 'upstream_unreachable',
        },
      }, 503)
    }
    return jsonResponse({ error: { message: (err as Error).message || 'Cline 转发失败', type: 'api_error' } }, 500)
  }
}

// ===== 上游渠道探测与校验（移植 cline-pass-switcher 的 harvestAvailableProviders / validateUpstreams） =====
//
// 为什么用「假渠道」探测：给一个不存在的渠道名，网关会在**路由层**拒绝并回吐完整可用渠道清单，
// 不产生 token 消耗。2026-10-02 真机实测：单次 297ms、无正文输出、回吐 16 个渠道。
//
// 为什么探测与校验必须分开（这是设计约束，不是保守）：
//   - 探测（枚举清单）在路由层就失败，**一个模型一次请求**，便宜；
//   - 校验（逐渠道实测可用性）每个渠道都要发一次真实最小请求，而免费通道**并发 >1 会返回
//     空响应**，所以必须走 enqueue 串行（MIN_GAP_MS = 800）→ 16 个渠道约占队列 13s，
//     期间其它 Cline 请求全部排队。因此「探测全部模型」只做枚举；校验按模型手动触发，
//     并在面板上明示将占用的请求数与队列时间。
export const CLINE_PROBE_UPSTREAM = '__cline_probe__'
/**
 * 探测/校验的读体上限：正常错误体很小；若某条管道把假渠道**静默丢弃**而转入真实推理，
 * 到量/到点立即取消，避免把一整轮 completion 读进来（免费档也不发 max_tokens，拦不住）。
 */
const CLINE_PROBE_READ_BYTES = 8192
const CLINE_PROBE_READ_MS = 20000
/**
 * 「验证钉住」的读体上限：路由元数据帧在流的前几帧，但真实 completion 的正文也在同一段里，
 * 给到 32KB 足以覆盖"元数据 + 少量正文"，又不必把整轮读进来。
 */
const CLINE_VERIFY_READ_BYTES = 32768

export interface ClineUpstreamProbeResult {
  model: string
  ok: boolean
  /** 管道归属：planner（Vercel AI Gateway）| direct（OpenRouter）| unknown */
  pipeline: 'planner' | 'direct' | 'unknown'
  upstreams: string[]
  status: number
  note: string
  ms: number
  probedAt: number
}

export interface ClineUpstreamCheck {
  upstream: string
  status: 'ok' | 'limited' | 'bad' | 'auth' | 'unknown'
  note: string
  ms: number
}

/**
 * 「钉住是否真的生效」的判定结论。
 * - `ok`：实际渠道落在你钉住/勾选的范围内（硬约束满足）
 * - `fallback`：实际走了范围外的兜底渠道——**只在「优先」模式且没配排除时合法**
 * - `mismatch`：违反了硬约束（实际渠道不在 only 白名单里）
 * - `unpinned`：该模型没配钉住，无事可验
 * - `unknown`：没读到路由元数据，无法判定（**不等于生效**）
 */
export type ClinePinVerdict = 'ok' | 'fallback' | 'mismatch' | 'unpinned' | 'unknown'

export interface ClinePinVerifyResult {
  model: string
  verdict: ClinePinVerdict
  /** 上游实际选用的渠道（响应帧 provider_metadata.gateway.routing.finalProvider） */
  finalProvider: string | null
  /** 网关侧仍可回退的渠道；strict 生效时应为空数组 */
  fallbacksAvailable: string[] | null
  /** 已保存配置里的期望（面板回显用） */
  expected: { upstreams: string[]; exclude: string[]; pinMode: 'strict' | 'preferred' }
  /** 出站请求体里**实际下发**的偏好（自证"我们确实发了什么"，与 expected 可能不同） */
  sent: { only: string[]; order: string[]; sort: string | null }
  note: string
  status: number
  ms: number
  verifiedAt: number
}

export interface ClineUpstreamCache {
  probes: Record<string, ClineUpstreamProbeResult>
  checks: Record<string, Record<string, ClineUpstreamCheck>>
  /** 上次「验证钉住」的结论：重载面板后仍能看到，不必重新发请求 */
  verifies?: Record<string, ClinePinVerifyResult>
  updatedAt: number
}

/** 读响应体到上限/超时即停并取消，返回已读文本（探测只关心路由层错误，不该读完整流）。 */
async function readTextCapped(
  resp: Response,
  limit = CLINE_PROBE_READ_BYTES,
  ms = CLINE_PROBE_READ_MS
): Promise<string> {
  if (!resp.body) return ''
  const reader = resp.body.getReader()
  const dec = new TextDecoder()
  let out = ''
  const deadline = Date.now() + ms
  try {
    for (;;) {
      if (out.length >= limit || Date.now() > deadline) break
      const { done, value } = await reader.read()
      if (done) break
      out += dec.decode(value, { stream: true })
    }
  } catch { /* 读中断按已读部分处理 */ }
  finally {
    try { await reader.cancel() } catch { /* 已结束 */ }
  }
  return out
}

/**
 * 从路由层错误文本里抽渠道清单。两条管道报错形态不同（实测）：
 *   - 规划器管道（Vercel AI Gateway）：`Available providers are: a, b, c`；
 *   - 直连管道（OpenRouter）：JSON 里的 `"available_providers": [...]`。
 * 不逐层取信封（两条管道的嵌套层级不一致），直接正则抓，再用 slug 规则过滤噪声 token。
 */
export function parseClineUpstreamList(text: string): string[] {
  const t = String(text || '')
  const out: string[] = []
  const listed = /Available providers are:\s*([^.]+)/i.exec(t)
  if (listed) {
    out.push(...listed[1].split(/,\s*/).map((s) => s.trim()).filter((s) => /^[a-z0-9][a-z0-9-]*$/i.test(s)))
  }
  const jsonArr = /"available_providers"\s*:\s*\[([^\]]*)\]/i.exec(t)
  if (jsonArr) {
    out.push(...(jsonArr[1].match(/"([^"]+)"/g) || []).map((s) => s.replace(/"/g, '')).filter((s) => /^[a-z0-9][a-z0-9-]*$/i.test(s)))
  }
  return [...new Set(out.map((s) => s.toLowerCase()))]
}

/** 渠道错误分类（口径对齐源项目 classifyUpstreamError：限流不算不可用，认证问题与渠道无关）。 */
export function classifyClineUpstreamError(msg: string): ClineUpstreamCheck['status'] {
  const t = String(msg || '')
  if (/empty response content/i.test(t)) return 'ok'
  if (/\b429\b|rate.?limit|too many requests|temporarily/i.test(t)) return 'limited'
  if (/unauthorized|re-?authenticate|invalid_grant|\b401\b/i.test(t)) return 'auth'
  if (/invalid_request|not allowed|no available providers|no allowed providers|not found|unsupported|unknown provider|does not exist/i.test(t)) return 'bad'
  return 'unknown'
}

/** 把上游原文压成一行短摘要（探测/校验的 note 字段，面板直接显示）。 */
function probeNote(text: string): string {
  const t = String(text || '')
  const m = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(t)
  const body = (m ? m[1] : t).replace(/\s+/g, ' ').trim()
  return body.slice(0, 200)
}

/**
 * 探测一个模型的上游渠道清单与管道归属。两种形态**同时下发**：管道归属决定哪个后端处理这次
 * 请求，它只认自己那一侧、另一侧被忽略，所以一次请求即覆盖两条管道。
 */
async function probeClineUpstreams(pool: Pool, model: string): Promise<ClineUpstreamProbeResult> {
  const sessionId = 'sess_probe_' + Date.now()
  const body: Record<string, unknown> = {
    model,
    session_id: sessionId,
    messages: [{ role: 'user', content: 'hi' }],
    providerOptions: { gateway: { only: [CLINE_PROBE_UPSTREAM] } },
    provider: { only: [CLINE_PROBE_UPSTREAM] },
  }
  const t0 = Date.now()
  let resp: Response
  try {
    resp = await enqueue(() => clineFetch(pool, '/chat/completions', body, sessionId, false, undefined, { skipCooldown: true }))
  } catch (err) {
    return {
      model, ok: false, pipeline: 'unknown', upstreams: [], status: 0,
      note: `探测请求失败：${(err as Error).message || String(err)}`, ms: Date.now() - t0, probedAt: Date.now(),
    }
  }
  const text = await readTextCapped(resp)
  const upstreams = parseClineUpstreamList(text)
  const pipeline: ClineUpstreamProbeResult['pipeline'] = /available providers are/i.test(text)
    ? 'planner'
    : /available_providers/i.test(text)
      ? 'direct'
      : 'unknown'
  return {
    model, ok: upstreams.length > 0, pipeline, upstreams, status: resp.status,
    note: probeNote(text), ms: Date.now() - t0, probedAt: Date.now(),
  }
}

/** 逐个渠道实测可用性（串行：免费通道并发 >1 会返回空响应）。不罚号、不冷却。 */
async function validateClineUpstreams(pool: Pool, model: string, upstreams: string[]): Promise<ClineUpstreamCheck[]> {
  const out: ClineUpstreamCheck[] = []
  for (const upstream of upstreams) {
    const sessionId = 'sess_check_' + Date.now()
    const body: Record<string, unknown> = {
      model,
      session_id: sessionId,
      messages: [{ role: 'user', content: 'hi' }],
      providerOptions: { gateway: { only: [upstream] } },
      provider: { only: [upstream] },
    }
    const t0 = Date.now()
    let status = 0
    let text = ''
    try {
      const resp = await enqueue(() => clineFetch(pool, '/chat/completions', body, sessionId, false, undefined, { skipCooldown: true }))
      status = resp.status
      text = await readTextCapped(resp)
    } catch (err) {
      text = `网络失败：${(err as Error).message || String(err)}`
    }
    // 200 且真的吐了内容 = 该渠道可用；否则按错误文本分类（限流/不可钉/认证）
    const hasOutput = status === 200 && /"(content|reasoning_content|reasoning|tool_calls)"\s*:/.test(text)
    const st: ClineUpstreamCheck['status'] = hasOutput && !/error/i.test(text) ? 'ok' : classifyClineUpstreamError(text)
    out.push({ upstream, status: st, note: probeNote(text), ms: Date.now() - t0 })
  }
  return out
}

// ----- 缓存（KV）：探测/校验结果留档，面板打开时直接渲染，不必每次打上游 -----

const CLINE_UPSTREAM_CACHE_PREFIX = 'cline:upstreams:'
/** 7 天上限：探测结果会漂移，留档只为回答「上次看到什么」，过期即重探。 */
const CLINE_UPSTREAM_CACHE_TTL_SEC = 7 * 24 * 3600

export async function readClineUpstreamCache(env: Env | undefined, providerId: string): Promise<ClineUpstreamCache> {
  const empty: ClineUpstreamCache = { probes: {}, checks: {}, verifies: {}, updatedAt: 0 }
  if (!env?.KV) return empty
  try {
    const raw = await env.KV.get(CLINE_UPSTREAM_CACHE_PREFIX + providerId)
    if (!raw) return empty
    const parsed = JSON.parse(raw) as Partial<ClineUpstreamCache>
    return {
      probes: parsed.probes && typeof parsed.probes === 'object' ? parsed.probes : {},
      checks: parsed.checks && typeof parsed.checks === 'object' ? parsed.checks : {},
      verifies: parsed.verifies && typeof parsed.verifies === 'object' ? parsed.verifies : {},
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
    }
  } catch { return empty }
}

async function writeClineUpstreamCache(env: Env | undefined, providerId: string, next: ClineUpstreamCache): Promise<void> {
  if (!env?.KV) return
  try {
    await env.KV.put(CLINE_UPSTREAM_CACHE_PREFIX + providerId, JSON.stringify(next), {
      expirationTtl: CLINE_UPSTREAM_CACHE_TTL_SEC,
    })
  } catch { /* 留档失败不影响本次返回 */ }
}

/** 探测一个模型并落 KV；返回本次结果（面板拿到的是最新值，不依赖 KV 的最终一致）。 */
export async function probeClineProviderUpstream(
  env: Env,
  provider: Provider,
  model: string
): Promise<ClineUpstreamProbeResult> {
  const pool = poolFromProvider(provider, env)
  const result = await probeClineUpstreams(pool, model)
  const cache = await readClineUpstreamCache(env, provider.id)
  const merged: ClineUpstreamCache = { ...cache, probes: { ...cache.probes, [model]: result }, updatedAt: Date.now() }
  await writeClineUpstreamCache(env, provider.id, merged)
  return result
}

/**
 * 校验一个模型已探测到的全部渠道并落 KV。
 * 渠道清单取自缓存（不重新探测）：探测与校验的请求形态不同，分开更便于面板分两步展示与分步确认成本。
 */
export async function validateClineProviderUpstream(
  env: Env,
  provider: Provider,
  model: string
): Promise<{ model: string; checks: ClineUpstreamCheck[]; total: number }> {
  const cache = await readClineUpstreamCache(env, provider.id)
  const upstreams = cache.probes[model]?.upstreams || []
  const pool = poolFromProvider(provider, env)
  const checks = await validateClineUpstreams(pool, model, upstreams)
  const byChannel: Record<string, ClineUpstreamCheck> = {}
  for (const c of checks) byChannel[c.upstream] = c
  const merged: ClineUpstreamCache = {
    ...cache,
    checks: { ...cache.checks, [model]: { ...(cache.checks[model] || {}), ...byChannel } },
    updatedAt: Date.now(),
  }
  await writeClineUpstreamCache(env, provider.id, merged)
  return { model, checks, total: upstreams.length }
}

/**
 * 从响应帧里抽「上游实际用了哪个渠道」。
 *
 * 为什么必须读它：出站偏好是我们自己拼的，日志只能证明**我们发出去了**；而规划器管道会
 * **静默丢弃**顶层 provider.only（照常 200 出流、不报错、也看不出你钉过），所以"没报错"
 * 与"日志有 [cline-pin]"都不能当验收。唯一硬证据是响应里的路由元数据。
 *
 * 字段位置与名字按 2026-10-02 真机实测（见 `_port-analysis/cps-premise-probe.mjs`）：
 * `provider_metadata.gateway.routing.finalProvider`，同段里还有 `fallbacksAvailable`。
 * 逐帧解析而不是正则抓全文——routing 是嵌套对象，正则容易跨对象误匹配。
 * `resolvedProvider` 是同一段的另一个字段名，作为兜底（不同管道用词不同）。
 */
export interface ClineRoutingMeta {
  finalProvider: string | null
  fallbacksAvailable: string[] | null
}

/**
 * 路由元数据的递归摘取（就地累加进 out）。
 *
 * 为什么是递归而不是按固定层级取：两条管道的信封嵌套层级不一致（planner 的
 * `provider_metadata` 有时在 data 包装里），写死层级会在换管道时静默读不到——而"读不到"
 * 与"没生效"在面板上是两种结论，静默降级会把它俩混成一个。
 */
function walkClineRouting(node: unknown, out: ClineRoutingMeta): void {
  if (!node || typeof node !== 'object') return
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === 'gateway' && v && typeof v === 'object') {
      const routing = (v as Record<string, unknown>).routing
      if (routing && typeof routing === 'object') {
        const rt = routing as Record<string, unknown>
        const fp = rt.finalProvider ?? rt.resolvedProvider
        if (typeof fp === 'string' && fp) out.finalProvider = fp
        if (Array.isArray(rt.fallbacksAvailable)) {
          out.fallbacksAvailable = rt.fallbacksAvailable.filter((x): x is string => typeof x === 'string')
        }
      }
    }
    if (v && typeof v === 'object') walkClineRouting(v, out)
  }
}

/**
 * 从一个**已解析**的帧对象里抽路由元数据。
 *
 * 为什么单独导出这个（而不只留 parseClineRoutingMeta 的文本版）：热路径的每一帧在
 * routeToStream/探测期都已经 JSON.parse 过一次了，真实流量留档若再走一遍文本版就是
 * 把同一段 JSON 解析两次。这里直接吃已解析的对象，零重复解析。
 */
export function clineRoutingFromFrame(node: unknown): ClineRoutingMeta {
  const out: ClineRoutingMeta = { finalProvider: null, fallbacksAvailable: null }
  walkClineRouting(node, out)
  return out
}

export function parseClineRoutingMeta(text: string): ClineRoutingMeta {
  const out: ClineRoutingMeta = { finalProvider: null, fallbacksAvailable: null }
  const raw = String(text || '')
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('data:')) continue
    const payload = t.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try { walkClineRouting(JSON.parse(payload), out) } catch { /* 非 JSON 帧忽略 */ }
  }
  // 非流式/无 data: 前缀的实现也兜一下（整段就是一个 JSON 对象）
  if (out.finalProvider === null && out.fallbacksAvailable === null) {
    try { walkClineRouting(JSON.parse(raw), out) } catch { /* 不是 JSON，保持未知 */ }
  }
  return out
}

/**
 * 判定「钉住是否生效」。**纯函数**，便于直接把判定矩阵钉在测试里。
 * 判定口径以**实际下发的偏好**（sent）为准，而不是配置（expected）——两者在 exclude 清单缺失时
 * 并不相同，拿配置去判会得出"应该生效"的假结论。
 */
export function judgeClinePinVerify(
  sent: { only: string[]; order: string[] },
  finalProvider: string | null,
  fallbacksAvailable: string[] | null
): { verdict: ClinePinVerdict; note: string } {
  const fb = fallbacksAvailable === null ? '回退清单未读到' : (fallbacksAvailable.length ? `仍可回退 [${fallbacksAvailable.join(',')}]` : '回退已清空')
  if (!sent.only.length && !sent.order.length) {
    return {
      verdict: 'unpinned',
      note: '该模型未配钉住（网关自动选）' + (finalProvider ? `，本次实际走 ${finalProvider}` : ''),
    }
  }
  if (!finalProvider) {
    return { verdict: 'unknown', note: '未读到路由元数据，无法判定（这**不等于**生效）' }
  }
  if (sent.only.length) {
    const hit = sent.only.includes(finalProvider)
    return hit
      ? { verdict: 'ok', note: `实际走 ${finalProvider}，落在白名单 [${sent.only.join(',')}] 内（${fb}）` }
      : { verdict: 'mismatch', note: `实际走 ${finalProvider}，不在白名单 [${sent.only.join(',')}] 内——钉住没生效` }
  }
  // 只下发了 order（优先模式且没配排除）：范围外的兜底是**允许**的，不能算失败
  if (finalProvider === sent.order[0]) {
    return { verdict: 'ok', note: `实际走 ${finalProvider}，正是优先序列首位（${fb}）` }
  }
  if (sent.order.includes(finalProvider)) {
    return { verdict: 'ok', note: `实际走 ${finalProvider}，在你勾选的序列 [${sent.order.join(',')}] 内（${fb}）` }
  }
  return { verdict: 'fallback', note: `实际走 ${finalProvider}，不在优先序列 [${sent.order.join(',')}] 内（优先模式允许兜底，非失败）` }
}

// ===== 真实流量的路由结果留档（2026-10-06）=====
//
// 为什么需要：「验证钉住」是**抽样**——它回答"此刻生效吗"，且只在有人点按钮时才发生。真实流量里
// 每一条响应帧都带着 `provider_metadata.gateway.routing.finalProvider`，那才是**全量证据**。落库后
// 面板不必再发请求就能回答两件手动验证答不了的事：
//   1. 这个模型最近实际走了哪些渠道、有没有违反白名单（自动发现"配置还在、上游已经不服从"的漂移）；
//   2. 出站偏好改对了但**该渠道本身已经挂了**（配置生效、实走却是兜底渠道）。
//
// 为什么另开一个键空间而不写系统日志：系统日志是**逐请求**一条（见 logClinePinDecision 里同一取舍），
// 逐请求落盘会刷满面板分页、把真正的错误行挤掉。流量观测天然可聚合——一条记录/模型足够，
// 读取成本是 1 次 KV.get/模型（不是 list 全量扫）。
//
// 有意取舍（丢更新）：单键是 read-modify-write，跨 isolate 并发写会丢计数（本仓已记录过同类坑）。
// 所以这里只当**近似统计**用：计数可能偏小；`last` 与 `anomalies` 由 at 时间戳保护（新者胜），
// 而**异常另有 append-only 的系统日志兜底**（精确、可检索）。真值来源是日志，这个键是快视图。
const CLINE_TRAFFIC_PREFIX = 'cline:traffic:'
/** 7 天：与渠道留档同量级——流量画像会漂移，过期数据只会误导。 */
const CLINE_TRAFFIC_TTL_SEC = 7 * 24 * 3600
/**
 * 两次落盘之间的最小间隔（毫秒）：把并发突发合并成一条。
 *
 * 为什么必须限流：KV 写配额是所有功能共享的（日志、渠道留档、**提供商配置**）。逐请求落盘在
 * 持续流量下能把配额写爆，而配额耗尽的后果是**连提供商配置都存不进去**——用一个观测功能的
 * 写量去换配置功能不可用，是本末倒置。5 秒的代价：突发后立刻停流量时，桶里最后几次观测会随
 * isolate 一起消失（见上面"有意取舍"）。
 */
export const CLINE_TRAFFIC_MIN_GAP_MS = 5000
/** 异常样本上限：面板只展示最近几条，留档不必无限增长。 */
const CLINE_TRAFFIC_ANOMALY_CAP = 5

/** 一次真实流量的路由观测（面板展示的最小单元）。 */
export interface ClineTrafficSample {
  at: number
  finalProvider: string | null
  fallbacksAvailable: string[] | null
  verdict: ClinePinVerdict
  note: string
  /** 该次请求是否产出了可用流（false = 被退化/截断拦截；**路由证据仍然有效**，照样计入） */
  ok: boolean
}

/** 一个模型的路由留档（KV 值；面板直接渲染）。 */
export interface ClineTrafficRecord {
  model: string
  /** 观测到的请求数（含读不到路由元数据的——它们同样是"流量"） */
  requests: number
  /** 其中读到路由元数据的请求数（requests - routed = 读不到的次数） */
  routed: number
  /** 各渠道实际被选中的次数 */
  providers: Record<string, number>
  /** 判定结果计数（口径与 judgeClinePinVerify 一致） */
  verdicts: Partial<Record<ClinePinVerdict, number>>
  /** 最近一次观测 */
  last: ClineTrafficSample | null
  /** 违反硬约束的样本（新→旧，最多 CLINE_TRAFFIC_ANOMALY_CAP 条） */
  anomalies: ClineTrafficSample[]
  /** 最近一次出站**实际下发**的偏好（解释判定口径：可能与面板上的配置不同） */
  sent: { only: string[]; order: string[]; sort: string | null }
  /** 首末观测时间 */
  from: number
  updatedAt: number
}

/** 热路径携带的留档上下文（谁在钉、钉的是什么）。 */
export interface ClineTrafficContext {
  env?: Env
  providerId: string
  model: string
  sent: { only: string[]; order: string[]; sort: string | null }
}

/** in-isolate 聚合桶：同 (提供商, 模型) 的并发请求共用一个桶，落盘时合并成一条记录。 */
interface ClineTrafficBucket {
  providerId: string
  model: string
  from: number
  requests: number
  routed: number
  providers: Record<string, number>
  verdicts: Record<string, number>
  last: ClineTrafficSample | null
  anomalies: ClineTrafficSample[]
  sent: { only: string[]; order: string[]; sort: string | null }
}

const clineTrafficBuckets = new Map<string, ClineTrafficBucket>()
/** 上次落盘时刻（isolate 级，**跨模型共享**）：限流的意义是限制总写量，不是每个模型各写一条。 */
let clineTrafficFlushedAt = 0

/** 仅供测试：清空聚合桶与限流窗口，避免用例间互相影响。 */
export function __resetClineTrafficForTests(): void {
  clineTrafficBuckets.clear()
  clineTrafficFlushedAt = 0
}

const sumCounts = (a: Record<string, number>, b: Record<string, number>): Record<string, number> => {
  const out: Record<string, number> = { ...a }
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] || 0) + v
  return out
}

/**
 * 合并「旧留档 + 本次增量」。**纯函数**（便于把丢更新下的保护语义钉在测试里）。
 *
 * 计数是相加的（读到的旧值若偏旧，加出来的总数就偏小——这是已知的近似，见上方取舍），
 * 但 last 与 anomalies 按 `at` 取新：**并发的旧写不允许把"最近一次观测"回退成更早的时刻**，
 * 否则面板会显示一个比实际更旧的结论，看起来像"流量停了"。
 */
export function mergeClineTraffic(
  prev: ClineTrafficRecord | null,
  delta: Omit<ClineTrafficBucket, 'last'> & { last: ClineTrafficSample; to?: number }
): ClineTrafficRecord {
  const mergedAnomalies = [...(delta.anomalies || []), ...((prev && prev.anomalies) || [])]
    .filter((s, i, arr) => arr.findIndex((x) => x.at === s.at && x.finalProvider === s.finalProvider) === i)
    .sort((a, b) => b.at - a.at)
    .slice(0, CLINE_TRAFFIC_ANOMALY_CAP)
  const prevLast = prev?.last || null
  const last = !prevLast || delta.last.at >= prevLast.at ? delta.last : prevLast
  return {
    model: delta.model,
    requests: (prev?.requests || 0) + delta.requests,
    routed: (prev?.routed || 0) + delta.routed,
    providers: sumCounts(prev?.providers || {}, delta.providers),
    verdicts: sumCounts((prev?.verdicts || {}) as Record<string, number>, delta.verdicts),
    last,
    anomalies: mergedAnomalies,
    // sent 跟着 last 走：判定口径必须与"最近一次观测"是同一次请求的，否则面板会用旧口径解释新结论
    sent: last === delta.last ? delta.sent : ((prev as ClineTrafficRecord).sent || delta.sent),
    from: Math.min(prev?.from || delta.from, delta.from),
    updatedAt: Math.max(prev?.updatedAt || 0, delta.to ?? delta.from),
  }
}

/** 读一个模型的路由留档（无则 null）。 */
export async function readClineTraffic(
  env: Env | undefined,
  providerId: string,
  model: string
): Promise<ClineTrafficRecord | null> {
  if (!env?.KV) return null
  try {
    const raw = await env.KV.get(CLINE_TRAFFIC_PREFIX + providerId + ':' + model)
    if (!raw) return null
    const p = JSON.parse(raw) as Partial<ClineTrafficRecord>
    if (!p || typeof p !== 'object') return null
    return {
      model: typeof p.model === 'string' ? p.model : model,
      requests: Number(p.requests) || 0,
      routed: Number(p.routed) || 0,
      providers: p.providers && typeof p.providers === 'object' ? p.providers : {},
      verdicts: p.verdicts && typeof p.verdicts === 'object' ? p.verdicts : {},
      last: p.last && typeof p.last === 'object' ? p.last : null,
      anomalies: Array.isArray(p.anomalies) ? p.anomalies.slice(0, CLINE_TRAFFIC_ANOMALY_CAP) : [],
      sent: p.sent && typeof p.sent === 'object' ? p.sent : { only: [], order: [], sort: null },
      from: Number(p.from) || 0,
      updatedAt: Number(p.updatedAt) || 0,
    }
  } catch { return null }
}

/**
 * 异常（实际渠道违反硬约束）同时进系统日志。
 *
 * 为什么异常要额外落日志：聚合键可能丢更新、也可能被 5 秒限流合并掉，而"钉住没生效"是**必须
 * 留痕**的事实。日志是 append-only 的（每条约一个独立键），所以它是精确的真值来源；面板上的
 * 聚合只是快视图。按 (提供商, 模型, 实际渠道, 结论) 做 5 分钟去重——钉住持续失效时每 5 秒
 * 一条会把面板刷满，而结论完全相同，重复落盘没有信息量。
 */
async function logClineTrafficAnomaly(
  env: Env,
  providerId: string,
  model: string,
  sample: ClineTrafficSample
): Promise<void> {
  if (!shouldLogClinePin(`anomaly|${providerId}|${model}|${sample.finalProvider}|${sample.verdict}`)) return
  const line = `[cline-route] ${providerId} model=${model} ${sample.note}`
  console.log(line)
  try {
    await writeLog(env, 'warn', line, JSON.stringify(sample))
  } catch { /* 日志失败不影响响应 */ }
}

/** 把桶写进 KV 并清空；桶里的异常顺带落系统日志。 */
async function flushClineTraffic(env: Env, bucketKey: string): Promise<void> {
  const b = clineTrafficBuckets.get(bucketKey)
  if (!b) return
  // 先摘桶再 await：写期间新到的观测要落进**新桶**，否则会在下面 delete 时被一起丢掉
  clineTrafficBuckets.delete(bucketKey)
  clineTrafficFlushedAt = Date.now()
  // last 理论上必非空（recordClineTraffic 落盘前一定先赋值），这里只是把不变量显式化
  if (!b.last) return
  try {
    const prev = await readClineTraffic(env, b.providerId, b.model)
    const merged = mergeClineTraffic(prev, { ...b, last: b.last, to: Date.now() })
    await env.KV.put(CLINE_TRAFFIC_PREFIX + b.providerId + ':' + b.model, JSON.stringify(merged), {
      expirationTtl: CLINE_TRAFFIC_TTL_SEC,
    })
  } catch { /* 留档失败不影响本次请求 */ }
  for (const a of b.anomalies) await logClineTrafficAnomaly(env, b.providerId, b.model, a)
}

/**
 * 记录一次真实流量的路由观测，并在限流窗口外落盘。
 *
 * 判定在**记录时**按该次请求自己下发的偏好算（而不是落盘时按聚合口径重算）：配置改过之后，
 * 同一个桶里可能混着两种口径的请求，用最新配置去重判旧请求会得出错误的"生效/未生效"。
 */
export async function recordClineTraffic(
  traffic: ClineTrafficContext,
  routing: ClineRoutingMeta | null,
  ok: boolean
): Promise<void> {
  const { env, providerId, model, sent } = traffic
  if (!env?.KV) return
  const bucketKey = providerId + '|' + model
  let b = clineTrafficBuckets.get(bucketKey)
  if (!b) {
    b = {
      providerId, model, from: Date.now(), requests: 0, routed: 0,
      providers: {}, verdicts: {}, last: null, anomalies: [], sent,
    }
    clineTrafficBuckets.set(bucketKey, b)
  }
  const judged = judgeClinePinVerify(sent, routing?.finalProvider ?? null, routing?.fallbacksAvailable ?? null)
  const sample: ClineTrafficSample = {
    at: Date.now(),
    finalProvider: routing?.finalProvider ?? null,
    fallbacksAvailable: routing?.fallbacksAvailable ?? null,
    verdict: judged.verdict,
    note: judged.note,
    ok,
  }
  b.requests++
  b.sent = sent
  if (sample.finalProvider) {
    b.routed++
    b.providers[sample.finalProvider] = (b.providers[sample.finalProvider] || 0) + 1
  }
  b.verdicts[judged.verdict] = (b.verdicts[judged.verdict] || 0) + 1
  b.last = sample
  // 桶内异常也设上限：持续失效时 5 秒限流窗口内可能攒下几十条，留档只需最近几条
  if (judged.verdict === 'mismatch' && b.anomalies.length < CLINE_TRAFFIC_ANOMALY_CAP) b.anomalies.push(sample)
  if (Date.now() - clineTrafficFlushedAt < CLINE_TRAFFIC_MIN_GAP_MS) return
  await flushClineTraffic(env, bucketKey)
}

/**
 * 验证「**已保存的**钉住配置」是否真的生效：发 1 次最小真实请求，读回路由元数据再判定。
 *
 * 为什么按已保存配置而不是面板的本地状态：面板是即时保存的，本地状态与存储一致；但"验证"
 * 这个动作的语义是**验收存下来的东西**，所以从 provider 读，避免验证了一个没存住的配置。
 *
 * 成本：每模型 1 次真实请求（约几百毫秒 + 极少量 token），且走共享串行队列（免费通道并发 >1
 * 会返回空响应）。不罚号（skipCooldown）——诊断动作不该让账号进冷却。
 */
export async function verifyClineProviderUpstream(
  env: Env,
  provider: Provider,
  model: string
): Promise<ClinePinVerifyResult> {
  const pin = provider.clinePinByModel?.[model] || null
  // 与热路径同一口径：只有配了 exclude 才需要渠道清单来换算 only 白名单
  const knownUpstreams = pin?.exclude?.length
    ? (await readClineUpstreamCache(env, provider.id)).probes[model]?.upstreams || []
    : []
  const { freeSet } = await getClineCatalog()
  const sessionId = 'sess_verify_' + Date.now()
  const body = buildUpstreamBody(
    { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 },
    true,
    sessionId,
    freeSet,
    pin,
    knownUpstreams
  )
  const decision = clinePinDecision(body)
  const sent = {
    only: decision?.only ? decision.only.slice() : [],
    order: decision?.order ? decision.order.slice() : [],
    sort: decision?.sort ?? null,
  }
  const expected = {
    upstreams: (pin?.upstreams || []).filter(Boolean),
    exclude: (pin?.exclude || []).filter(Boolean),
    pinMode: (pin?.pinMode === 'preferred' ? 'preferred' : 'strict') as 'strict' | 'preferred',
  }
  const pool = poolFromProvider(provider, env)
  const t0 = Date.now()
  let status = 0
  let text = ''
  try {
    const resp = await enqueue(() =>
      clineFetch(pool, '/chat/completions', body, sessionId, false, undefined, { skipCooldown: true })
    )
    status = resp.status
    // 元数据帧在流的前几帧就该到；给足上限但不读完整轮（验证不该把整段 completion 读进来）
    text = await readTextCapped(resp, CLINE_VERIFY_READ_BYTES, CLINE_PROBE_READ_MS)
  } catch (err) {
    const judged = { verdict: 'unknown' as ClinePinVerdict, note: `请求失败，无法判定：${(err as Error).message || String(err)}` }
    return {
      model, ...judged, finalProvider: null, fallbacksAvailable: null,
      expected, sent, status, ms: Date.now() - t0, verifiedAt: Date.now(),
    }
  }
  const meta = parseClineRoutingMeta(text)
  const judged = judgeClinePinVerify(sent, meta.finalProvider, meta.fallbacksAvailable)
  const result: ClinePinVerifyResult = {
    model,
    verdict: judged.verdict,
    finalProvider: meta.finalProvider,
    fallbacksAvailable: meta.fallbacksAvailable,
    expected,
    sent,
    // HTTP 非 200 时把状态码带上：此时"没读到元数据"的原因通常就在这儿
    note: judged.verdict === 'unknown' && status !== 200 ? `HTTP ${status}：${probeNote(text) || '无响应正文'}` : judged.note,
    status,
    ms: Date.now() - t0,
    verifiedAt: Date.now(),
  }
  const cache = await readClineUpstreamCache(env, provider.id)
  await writeClineUpstreamCache(env, provider.id, {
    ...cache,
    verifies: { ...(cache.verifies || {}), [model]: result },
    updatedAt: Date.now(),
  })
  return result
}

/** 返回 Cline 实测可用模型列表（普通 JSON，供管理面板拉取模型）。 */
export function fetchClineModels(): { ok: true; message: string; models: Array<{ id: string }> } {
  return {
    ok: true,
    message: 'success',
    models: CLINE_MODELS.map((m) => ({ id: m.id })),
  }
}

// ===== 动态模型同步（item6，移植自 luawei1/cline2api models_sync.go） =====
// 2026-09-24 扩为三源合并（移植 cline2api-workers worker.js refreshModels）：
//   ① recommended-models 的 free / recommended / clinePass
//   ② /v1/models 的 `:free` 后缀
//   ③ /v1/models 命中 CLINE_FREE_WHITELIST 的 ID
// ②③ 是必需的：`stealth/space-bunny-alpha` 这类免费模型**只在 /v1/models 里出现**，
// 且没有 cline-free/ 前缀，只靠①会把它判成计费档 → 402。
// 有意未纳入：recommended-models 的 clineCloud 组（Cline Cloud 独立档，上游 workers 版也不读）。

const CLINE_RECOMMENDED_URL = 'https://api.cline.bot/api/v1/ai/cline/recommended-models'
const CLINE_MODELS_URL = 'https://api.cline.bot/api/v1/models'
/** 目录缓存 TTL（对齐上游 workers 版 MODELS_TTL = 10 分钟）。 */
const CLINE_CATALOG_TTL_MS = 10 * 60 * 1000

export interface RemoteClineModel { id: string; cost: 'free' | 'pass' }

/** 拉取 `/v1/models`（免鉴权），只保留免费档：`:free` 后缀或命中 FREE_WHITELIST。 */
async function fetchClineModelsEndpoint(): Promise<RemoteClineModel[]> {
  const resp = await fetch(CLINE_MODELS_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (cline2api)' },
    signal: AbortSignal.timeout(10000),
  })
  if (!resp.ok) throw new Error(`/v1/models HTTP ${resp.status}`)
  const data = (await resp.json()) as { data?: Array<{ id?: string; batch?: boolean }> }
  const list = Array.isArray(data?.data) ? data.data : []
  const out: RemoteClineModel[] = []
  for (const m of list) {
    const id = m?.id
    if (!id) continue
    // batch 变体不是对话模型，剔除（对齐上游）
    if (m.batch || id.endsWith(':batch')) continue
    if (id.includes(':free') || CLINE_FREE_WHITELIST.includes(id)) out.push({ id, cost: 'free' })
  }
  return out
}

/**
 * 拉取 Cline 官方推荐/免费/订阅模型清单（免认证），按 free 优先去重。
 * `/v1/models` 失败**不致命**（主清单已拿到时静默跳过），保证后台「获取模型」不因单源故障全灭。
 */
export async function fetchClineRecommendedModels(): Promise<RemoteClineModel[]> {
  const resp = await fetch(CLINE_RECOMMENDED_URL, { signal: AbortSignal.timeout(10000) })
  if (!resp.ok) throw new Error(`recommended-models HTTP ${resp.status}`)
  const data = (await resp.json()) as {
    recommended?: Array<{ id?: string; tags?: string[] }>
    free?: Array<{ id?: string }>
    clinePass?: Array<{ id?: string }>
  }
  const out: RemoteClineModel[] = []
  const seen = new Set<string>()
  const add = (list: Array<{ id?: string; tags?: string[] }> | undefined, cost: 'free' | 'pass') => {
    for (const m of list || []) {
      const id = m?.id
      if (!id || seen.has(id)) continue
      // recommended 组按 tags 是否含 FREE 判定，否则 pass
      const c = cost !== 'free' && Array.isArray(m?.tags) && m.tags.some((t) => (t || '').toUpperCase() === 'FREE') ? 'free' : cost
      seen.add(id)
      out.push({ id, cost: c })
    }
  }
  add(data.free, 'free')
  add(data.recommended, 'pass')
  add(data.clinePass, 'pass')
  // 补 /v1/models 的免费档（stealth/* 等无前缀免费模型只在这里出现）
  try {
    for (const m of await fetchClineModelsEndpoint()) {
      if (seen.has(m.id)) continue
      seen.add(m.id)
      out.push(m)
    }
  } catch { /* 非致命：主清单已拿到 */ }
  return out
}

/** 静态兜底目录（动态拉取失败时使用）。 */
function staticClineCatalog(): RemoteClineModel[] {
  return CLINE_MODELS.map((m) => ({ id: m.id, cost: m.cost === 'free' ? 'free' : 'pass' }) as RemoteClineModel)
}

let clineCatalogCache: { models: RemoteClineModel[]; freeSet: Set<string>; at: number } | null = null

/**
 * 取 Cline 模型目录与 free 集合（10 分钟缓存）。**请求路径的 free 判定唯一真源。**
 * 拉取失败回落静态表——请求路径不能因目录不可用而整体失败。
 */
export async function getClineCatalog(): Promise<{ models: RemoteClineModel[]; freeSet: Set<string> }> {
  const now = Date.now()
  if (clineCatalogCache && now - clineCatalogCache.at < CLINE_CATALOG_TTL_MS) {
    return { models: clineCatalogCache.models, freeSet: clineCatalogCache.freeSet }
  }
  let models: RemoteClineModel[]
  try {
    models = await fetchClineRecommendedModels()
    if (models.length === 0) models = staticClineCatalog()
  } catch {
    models = staticClineCatalog()
  }
  const freeSet = new Set(models.filter((m) => m.cost === 'free').map((m) => m.id))
  clineCatalogCache = { models, freeSet, at: now }
  return { models, freeSet }
}

/** 供测试清空目录缓存。 */
export function __resetClineCatalogCacheForTests(): void { clineCatalogCache = null }

/**
 * 判定模型是否走官方免费额度（决定 max_tokens 剥离与降级链成员资格）。
 *
 * **必须用 free 列表成员判定，不能用前缀**：`stealth/space-bunny-alpha` 是免费模型但
 * 没有 `cline-free/` 前缀，前缀判定会把它当计费档 → 送 max_tokens → 上游 500。
 * 目录尚未取到时回落「前缀 + 白名单」启发式，宁可保守也不能漏判。
 */
export function isFreeClineModel(id: string, freeSet?: Set<string>): boolean {
  if (freeSet && freeSet.size > 0) return freeSet.has(id)
  return id.startsWith('cline-free/') || CLINE_FREE_WHITELIST.includes(id)
}

// 已退役（2026-10-02，用户决定）：`clineModelFallbackChain` / `CLINE_FREE_LAST_RESORT`
// ——「点名模型全账号不可用时沿免费链降级」不再存在。网关只服务点名的模型，402/429/连接故障/
// 三轮产不出流一律原样报错。若要恢复，请先确认这是产品决定而不是顺手加回来的 fallback。

// ===== 每日健康检查（item10，移植自 Go 版冷却自愈：探活并刷新过期 token） =====

export interface ClineHealthSummary {
  providers: number
  accounts: number
  ok: number
  failed: number
  errors: number
}

/** 遍历 Cline 提供商，逐个账号刷新 accessToken（临期/过期自动刷新，失败标记冷却），并持久化轮换的新 refreshToken。 */
export async function healthCheckClineAll(env: Env): Promise<ClineHealthSummary> {
  let providers = 0
  let accounts = 0
  let ok = 0
  let failed = 0
  let errors = 0
  try {
    const list = await getProviders(env)
    for (const p of list) {
      if (!isClineProvider(p.id)) continue
      providers++
      const enabled = (p.apiKeys || []).filter((k) => k.enabled)
      if (enabled.length === 0) continue
      const pool = getPool(p.id, enabled.map((k) => k.key))
      pool.onRotate = (oldRt, newRt) => { void persistClineRotation(env, p, oldRt, newRt) }
      pool.env = env
      for (const acc of pool.accounts) {
        accounts++
        acc.cooldownUntil = 0 // 探活忽略既有冷却，尝试复活
        try {
          await getAccountToken(acc, pool)
          ok++
          // 复活成功即清掉冷却留档：否则面板会一直显示一个已经被证明不成立的结论
          const idx = pool.accounts.indexOf(acc)
          if (idx >= 0) await clearClineAccountState(env, p.id, idx)
        } catch {
          failed++ // getAccountToken 失败时已标记冷却
        }
      }
    }
  } catch {
    errors++
  }
  return { providers, accounts, ok, failed, errors }
}

/** 单个 refreshToken 的探测结果（管理面板「检测账号」用）。 */
export interface ClineAccountProbe {
  /** 能否换到 accessToken。false 时 message 给出原因。 */
  valid: boolean
  /** 上游 userInfo.email；上游没给或 token 无效时为空串。 */
  email: string
  message: string
  /** 上游轮换出的新 refreshToken；非空时**必须**由调用方持久化，否则旧值立即失效。 */
  rotatedTo: string
  statusCode: number
}

/**
 * 用 refreshToken 换一次 accessToken，判定有效性并取回账号 email（管理面板检测用）。
 *
 * 独立于 getAccountToken：面板探测的是「未进池的单个 token」，不该改动任何池状态
 * （不写 accessToken 缓存、不设冷却）。但**上游会轮换 refreshToken**——探测本身
 * 就可能让调用方手里的旧 token 作废，所以 rotatedTo 必须被调用方落库。
 */
export async function probeClineAccount(refreshToken: string): Promise<ClineAccountProbe> {
  const rt = (refreshToken || '').trim()
  if (rt.length <= 8) {
    return { valid: false, email: '', message: 'RefreshToken 为空或过短', rotatedTo: '', statusCode: 0 }
  }
  let resp: Response
  try {
    resp = await fetch(CLINE_API_BASE + '/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: rt, grantType: 'refresh_token' }),
      signal: AbortSignal.timeout(15000),
    })
  } catch (err) {
    // 连接层失败 ≠ token 失效：文案要区分，否则用户会白换号
    return { valid: false, email: '', message: `连接 Cline 失败：${(err as Error).message || '网络错误'}`, rotatedTo: '', statusCode: 0 }
  }
  if (!resp.ok) {
    return { valid: false, email: '', message: `HTTP ${resp.status}：${await readErrSnippet(resp)}`, rotatedTo: '', statusCode: resp.status }
  }
  const data = (await resp.json().catch(() => null)) as {
    data?: { accessToken?: string; refreshToken?: string; userInfo?: { email?: string } }
  } | null
  const accessToken = data?.data?.accessToken
  if (!accessToken) {
    return { valid: false, email: '', message: '上游未返回 accessToken', rotatedTo: '', statusCode: resp.status }
  }
  const email = (data?.data?.userInfo?.email || '').trim()
  const rotated = (data?.data?.refreshToken || '').trim()
  return {
    valid: true,
    email,
    message: email ? `有效（${email}）` : '有效（上游未返回账号 email）',
    rotatedTo: rotated && rotated !== rt ? rotated : '',
    statusCode: resp.status,
  }
}

/** 截断上游错误体，避免把整段 HTML 塞进面板。 */
async function readErrSnippet(resp: Response): Promise<string> {
  try {
    const raw = (await resp.text()) || ''
    return raw.length > 120 ? `${raw.slice(0, 120)}…` : raw
  } catch {
    return ''
  }
}

/** 校验单个 refreshToken 是否能换取 accessToken（管理面板"测试"用）。 */
export async function testClineRefreshToken(refreshToken: string): Promise<{ success: boolean; message: string; statusCode?: number; email?: string; rotatedTo?: string }> {
  const probe = await probeClineAccount(refreshToken)
  return { success: probe.valid, message: probe.message, statusCode: probe.statusCode || undefined, email: probe.email, rotatedTo: probe.rotatedTo }
}

/** 上游「模型不存在」类错误（400/404）判定，正则对齐 cline2api `modelGoneRe`（JS 无内联 flag，用 i 标志）。 */
const CLINE_MODEL_GONE_RE = /model[\s_-]*(not[\s_-]*found|does\s+not\s+exist|no\s+such|unknown|invalid)|(invalid|unknown|no\s+such)[\s_-]*model/i

export function isClineModelGone(status: number, body: string): boolean {
  if (status !== 400 && status !== 404) return false
  return CLINE_MODEL_GONE_RE.test(body || '')
}

/** 用给定账号池发送一个最小 chat 请求来测试模型可用性。 */
export async function testClineChat(
  refreshTokens: string[],
  modelId: string
): Promise<{ success: boolean; message: string; statusCode?: number }> {
  const pool = getPool('__cline_test__', refreshTokens)
  const sessionId = 'sess_test_' + Date.now()
  try {
    const body: Record<string, unknown> = {
      model: modelId || DEFAULT_MODEL,
      // 推理模型思考阶段也要消耗 token：max_tokens 太小会一进 reasoning 就 length 截断，
      // 导致"空内容"。给足量让模型能走完思考并产出正文。
      max_tokens: 600,
      session_id: sessionId,
      reasoning_effort: 'medium',
      messages: [{ role: 'user', content: 'hi' }],
    }
    // 走非流式聚合通道：规避免费通道非流式 500，并能在聚合结果里判断模型是否真实回复
    const resp = await proxyNonStreamChat(pool, body, sessionId)
    if (resp.status === 200) {
      const data = (await resp.json().catch(() => null)) as {
        choices?: Array<{ message?: { content?: string; reasoning_content?: string; tool_calls?: unknown[] }; finish_reason?: string }>
      } | null
      const message = data?.choices?.[0]?.message || {}
      const content = String(message.content || '')
      const reasoning = String(message.reasoning_content || '')
      const finishReason = String(data?.choices?.[0]?.finish_reason || '')
      if (content) return { success: true, statusCode: 200, message: `模型可回复（${content.slice(0, 50)}）` }
      // 有思考但没正文：模型是通的（推理模型），只是本次没吐文本
      if (reasoning) return { success: true, statusCode: 200, message: `模型已连通（${reasoning.slice(0, 50)}…）` }
      const detail = finishReason ? `（finish_reason=${finishReason}）` : ''
      return { success: false, statusCode: 200, message: `模型返回空内容${detail}，免费额度可能已耗尽或该模型暂无可输出，请换号或改用 poolside/laguna-s-2.1:free` }
    }
    const t = await resp.text().catch(() => '').then((s) => s.slice(0, 300))
    // 官方锁定模型（仅 Cline 产品界面可用）与需订阅模型的 403，给出更明确的提示
    if (resp.status === 403 && /only available via Cline product surfaces|not available/i.test(t)) {
      return { success: false, statusCode: resp.status, message: '该模型已被 Cline 官方锁定（仅 Cline 产品界面可用），请改用 poolside/laguna-s-2.1:free' }
    }
    if (resp.status === 403 && /cline-pass/i.test(t)) {
      return { success: false, statusCode: resp.status, message: '该模型需要付费订阅 cline-pass 才能使用' }
    }
    // 上游「模型不存在」（400/404）——**不是账号问题**，别让用户去换号：
    // Cline 的目录端点（recommended-models / /v1/models）与推理端点会不一致，
    // 目录里还列着的模型推理侧可能已经下架/改名（cline2api 对同一现象的处理见
    // 其 models_sync.go 的 modelGoneRe + Delisted 标记）。这里顺手查一次实时目录，
    // 把「目录也查不到（确实下架）」与「目录还列着（上游两套数据打架）」分开说。
    if (isClineModelGone(resp.status, t)) {
      let inCatalog = false
      try {
        const { models } = await getClineCatalog()
        inCatalog = models.some((m) => m.id === (modelId || DEFAULT_MODEL))
      } catch { /* 目录不可用时按「已下架」表述 */ }
      const id = modelId || DEFAULT_MODEL
      const raw = t ? `（上游原文：${t.replace(/\s+/g, ' ').slice(0, 120)}）` : ''
      return {
        success: false,
        statusCode: resp.status,
        message: inCatalog
          ? `上游不认识该模型：${id}。它还在官方目录里（上游目录与推理端点不一致，属上游侧下架/改名），请改用其它免费模型，或重新「获取模型」后从列表里移除它${raw}`
          : `上游已下架该模型：${id}（官方目录里已没有它）。请点「获取模型」重新同步并移除它${raw}`,
      }
    }
    return { success: false, statusCode: resp.status, message: `HTTP ${resp.status}: ${t}` }
  } catch (err) {
    return { success: false, message: (err as Error).message || '测试失败' }
  }
}

// ===== 一键授权（WorkOS 设备码流程，与原项目 cline_oauth.py 一致） =====
//
// 流程（逆向自 cline2api/auth.go 和 cline_oauth.py）：
//   1. POST api.workos.com/user_management/authorize/device（表单 client_id）
//      → 返回 device_code + user_code + 授权链接
//   2. 用户在浏览器打开链接，用 Google/GitHub/邮箱登录授权（即注册的 Cline 账号）
//   3. 轮询 POST api.workos.com/user_management/authenticate
//      → 授权成功后拿 WorkOS access_token + refresh_token
//   4. POST api.cline.bot/api/v1/auth/register（{accessToken, refreshToken}）
//      → 返回值 data.refreshToken 即 Cline 账号的"长期钥匙"
//   5. 把 refreshToken 追加进该提供商的 apiKeys（启用），完成接入

export const CLINE_WORKOS_CLIENT_ID = 'client_01K3A541FN8TA3EPPHTD2325AR'
const CLINE_WORKOS_DEVICE = 'https://api.workos.com/user_management/authorize/device'
const CLINE_WORKOS_AUTH = 'https://api.workos.com/user_management/authenticate'
const CLINE_REGISTER = 'https://api.cline.bot/api/v1/auth/register'
const CLINE_DEVICE_TTL_SEC = 900 // 设备码 15 分钟有效，到期自清理

const clineDeviceKey = (providerId: string) => 'cline:device:' + providerId

interface ClineDeviceState {
  device_code: string
  user_code: string
  verification_uri: string
  interval: number
  expires_at: number
}

export interface StartClineOAuthResult {
  success: boolean
  message: string
  device?: { user_code: string; verification_uri: string; interval: number; expires_at: number }
}

/** 发起 Cline 一键授权，生成 WorkOS 设备码与授权链接。 */
export async function startClineOAuth(env: Env, providerId: string): Promise<StartClineOAuthResult> {
  try {
    const body = new URLSearchParams({ client_id: CLINE_WORKOS_CLIENT_ID })
    const res = await fetch(CLINE_WORKOS_DEVICE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) {
      return { success: false, message: `申请设备码失败 HTTP ${res.status}: ${(await res.text()).substring(0, 200)}` }
    }
    const data = (await res.json()) as {
      device_code?: string
      user_code?: string
      verification_uri_complete?: string
      verification_uri?: string
      interval?: number
      expires_in?: number
    }
    if (!data.device_code || !data.user_code) {
      return { success: false, message: 'WorkOS 设备码接口返回格式异常' }
    }
    const state: ClineDeviceState = {
      device_code: data.device_code,
      user_code: data.user_code,
      verification_uri: data.verification_uri_complete || data.verification_uri || '',
      interval: Math.max(data.interval || 5, 5),
      expires_at: Date.now() + (data.expires_in || 300) * 1000,
    }
    await env.KV.put(clineDeviceKey(providerId), JSON.stringify(state), { expirationTtl: CLINE_DEVICE_TTL_SEC })
    return {
      success: true,
      message: '设备码已生成',
      device: {
        user_code: state.user_code,
        verification_uri: state.verification_uri,
        interval: state.interval,
        expires_at: state.expires_at,
      },
    }
  } catch (err) {
    return { success: false, message: `申请设备码异常: ${(err as Error).message || '未知错误'}` }
  }
}

export type ClineOAuthPollResult =
  | { status: 'pending'; message: string }
  | { status: 'success'; message: string; refreshToken: string }
  | { status: 'failed'; message: string }
  | { status: 'error'; message: string }

/** 轮询 WorkOS 授权结果；授权成功后调 register 换 Cline refreshToken 并存入账号池。 */
export async function pollClineOAuth(env: Env, provider: Provider): Promise<ClineOAuthPollResult> {
  const raw = await env.KV.get(clineDeviceKey(provider.id))
  if (!raw) return { status: 'error', message: '没有进行中的登录流程，请重新发起' }
  let state: ClineDeviceState
  try { state = JSON.parse(raw) as ClineDeviceState } catch {
    await env.KV.delete(clineDeviceKey(provider.id))
    return { status: 'error', message: '设备码数据异常，请重新发起' }
  }
  if (Date.now() > state.expires_at) {
    await env.KV.delete(clineDeviceKey(provider.id))
    return { status: 'failed', message: '设备码已过期，请重新发起' }
  }

  try {
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: state.device_code,
      client_id: CLINE_WORKOS_CLIENT_ID,
    })
    const res = await fetch(CLINE_WORKOS_AUTH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    })

    if (!res.ok) {
      const errorData = (await res.json().catch(() => ({ error: 'unknown' }))) as { error?: string; error_description?: string }
      switch (errorData.error) {
        case 'authorization_pending':
          return { status: 'pending', message: '等待用户授权…' }
        case 'slow_down':
          return { status: 'pending', message: '轮询过快，请稍候重试' }
        case 'expired_token':
          await env.KV.delete(clineDeviceKey(provider.id))
          return { status: 'failed', message: '设备码已过期，请重新发起' }
        case 'access_denied':
          await env.KV.delete(clineDeviceKey(provider.id))
          return { status: 'failed', message: '用户拒绝了授权' }
        default:
          return { status: 'error', message: `轮询异常: ${errorData.error_description || errorData.error || res.status}` }
      }
    }

    const workos = (await res.json()) as { access_token?: string; refresh_token?: string }
    if (!workos.access_token) return { status: 'error', message: '轮询接口返回异常：缺少 access_token' }

    // 用 WorkOS token 在 Cline 注册，换 Cline refreshToken
    const regRes = await fetch(CLINE_REGISTER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: workos.access_token, refreshToken: workos.refresh_token || '' }),
      signal: AbortSignal.timeout(20000),
    })
    const regData = (await regRes.json().catch(() => ({}))) as { data?: { refreshToken?: string } }
    const clineRefreshToken = regData?.data?.refreshToken
    if (!clineRefreshToken) {
      return { status: 'error', message: 'Cline 注册失败，未获取到 refreshToken，请重试（可能需要稍后清理重发）' }
    }

    // 存入账号池（enabled 去重追加）
    const apiKeys = [...(provider.apiKeys || [])]
    if (!apiKeys.some((k) => k.key === clineRefreshToken)) {
      apiKeys.push({ key: clineRefreshToken, enabled: true })
      await updateProvider(env, provider.id, { apiKeys })
    }

    await env.KV.delete(clineDeviceKey(provider.id))
    return { status: 'success', message: '授权成功，已添加 Cline 账号', refreshToken: clineRefreshToken }
  } catch (err) {
    return { status: 'error', message: `轮询异常: ${(err as Error).message || '未知错误'}` }
  }
}