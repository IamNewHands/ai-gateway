/**
 * upstream-failure.ts — 上游失败响应「不可诊断」时的可诊断化。
 *
 * 背景 1：2026-10-21 DSH 通过网关请求 `opencode/deepseek-v4.1-flash-free` 连续两次报
 * `LlmError: 404 status code (no body)`。排查发现网关自己返回的 404 都带 JSON 中文
 * 文案（`模型"x"未配置` / `提供商"x"不存在`），而那次是**上游 404 且响应体为空**
 * 被 `restoreFailure` 原样透传——客户端只能看到「404 无响应体」，无法判断是模型不存在、
 * 形状被拦，还是上游网关抖动，排查方向被引偏。
 *
 * 背景 2：2026-10-22 DSH 又报 `LlmError: 400 {"model":"deepseek-v4.1-flash-free"}`。
 * 该报文非空，旧逻辑（只处理空体）于是原样透传；但它是**语义空体**：整段只有 `model`
 * 一个键，既不是网关自己的错误信封（`{"error":{...}}`），也不含任何
 * `error/message/type/code` 字段——看不出是哪个通道（官方地址 / public 镜像）、
 * 试过几个 key、上游到底说了什么，也看不出该重试还是该改配置。
 *
 * 本模块只做一件事：**状态码保持上游原值**（不谎报成功、不把 4xx 改写成 2xx/5xx），
 * 但把「不可诊断」的失败体（空体，或非空但没有错误信封的 JSON）替换成含上游状态、
 * 模型、通道、尝试次数、镜像数与上游原始报文片段的 JSON 诊断体，并加
 * `x-ai-gateway-upstream-empty` / `x-ai-gateway-upstream-nondiagnostic` 标记头，
 * 便于日志与客户端一眼区分「上游静默/畸形失败」与「网关自身错误」。
 *
 * 「可诊断」的判定口径集中在本文件（`isDiagnosticUpstreamBody`）：调用方不得各自
 * 复制一份关键字表，否则「是否重试」与「报文如何改写」会跑偏。
 */

/** 不可诊断失败所需的上下文，由调用方在失败出口处提供。 */
export interface EmptyBodyContext {
  /** 上游状态码（已在响应里，这里冗余一份便于测试断言）。 */
  status: number
  /** 请求的模型 id（含或不含 provider 前缀，按调用方口径）。 */
  model: string
  /** 本次尝试过的账号/Key 数量。 */
  keysTried?: number
  /** 本次配置的镜像数量（0 = 无镜像可回退）。 */
  mirrors?: number
  /** 失败发生在官方地址还是镜像。 */
  lane?: 'official' | 'mirror' | 'transport'
}

/** 空体诊断体的稳定类型标签，客户端/日志可据此匹配。 */
export const UPSTREAM_EMPTY_ERROR_TYPE = 'upstream_empty_error'
/** 非空但无错误信封的诊断体类型标签（如上游只回 `{"model":"..."}`）。 */
export const UPSTREAM_NONDIAGNOSTIC_ERROR_TYPE = 'upstream_nondiagnostic_error'
/** 标记头（空体）：值为上游状态码。 */
export const UPSTREAM_EMPTY_HEADER = 'x-ai-gateway-upstream-empty'
/** 标记头（非空但无信封）：值为上游状态码。 */
export const UPSTREAM_NONDIAGNOSTIC_HEADER = 'x-ai-gateway-upstream-nondiagnostic'

/** 上游错误信封里出现任一字段，即认为该报文对排查有意义。 */
const DIAGNOSTIC_ENVELOPE_KEYS = ['error', 'errors', 'message', 'msg', 'type', 'code', 'detail', 'details', 'hint']

/**
 * 判断一段上游失败报文是否「可诊断」。
 *
 * - 空/纯空白 → 不可诊断（由空体诊断体兜底）
 * - 非 JSON 且非空 → 可诊断（纯文本错误信息本身就是信息）
 * - JSON 对象/数组且带任一信封字段（`error`/`message`/`type`/`code`/…）→ 可诊断
 * - JSON 对象/数组但不带任何信封字段（如 `{"model":"x"}`）→ 不可诊断
 */
export function isDiagnosticUpstreamBody(text: string): boolean {
  const raw = String(text ?? '').trim()
  if (raw === '') return false
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return true
  }
  const probe = Array.isArray(parsed) ? parsed[0] : parsed
  if (!probe || typeof probe !== 'object') return false
  const record = probe as Record<string, unknown>
  for (const key of DIAGNOSTIC_ENVELOPE_KEYS) {
    const value = record[key]
    if (value !== undefined && value !== null && value !== '') return true
  }
  return false
}

/** 上游报文片段：限长 + 去掉控制字符 + 抹掉疑似凭据，只用于诊断展示 */
function excerpt(text: string, max = 400): string {
  const cleaned = text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned
}

function hintFor(context: EmptyBodyContext, empty: boolean): string {
  const parts: string[] = []
  if (context.lane === 'mirror') parts.push('已回退到 public 镜像仍失败')
  if (context.keysTried === 0) parts.push('该提供商没有启用任何 Key（走镜像模式）')
  if (context.mirrors === 0) parts.push('未配置 OPENCODE_MIRRORS_URL 等镜像回退')
  if (empty) {
    parts.push('上游静默失败常见于：模型已下架、镜像未代理该路径（如只转发 /zen 不转发 /inference）、或上游网关抖动；稍后重试或换模型/换账号')
  } else {
    parts.push('上游回了不可识别的畸形报文（不含 error/message 字段），常见于镜像/反代自身校验失败或路径版本不匹配；原始报文已附在 upstream_body，可据此判断是官方地址还是镜像')
  }
  return parts.join('；')
}

/**
 * 若失败响应体「不可诊断」（空体，或非空但无错误信封），替换为可诊断 JSON 体
 * （保留原状态码）；可诊断则**原样返回**。
 *
 * 用 `clone()` 读取一次文本，因此对可诊断情形不会消费掉原响应体。
 */
export async function withUpstreamFailureDiagnosis(
  response: Response,
  context: EmptyBodyContext,
): Promise<Response> {
  if (response.ok) return response

  const text = await response.clone().text().catch(() => '')
  const empty = text.trim() === ''
  if (!empty && isDiagnosticUpstreamBody(text)) return response

  const payload = {
    error: {
      type: empty ? UPSTREAM_EMPTY_ERROR_TYPE : UPSTREAM_NONDIAGNOSTIC_ERROR_TYPE,
      message: empty
        ? `上游返回 ${response.status} 但响应体为空，无法从上游取得诊断信息`
        : `上游返回 ${response.status} 但响应体不含错误字段（不可诊断），无法判断是哪个通道、哪一步失败`,
      upstream_status: response.status,
      model: context.model,
      ...(empty ? {} : { upstream_body: excerpt(text) }),
      ...(context.keysTried === undefined ? {} : { keys_tried: context.keysTried }),
      ...(context.mirrors === undefined ? {} : { mirrors: context.mirrors }),
      ...(context.lane === undefined ? {} : { lane: context.lane }),
      hint: hintFor(context, empty),
    },
  }

  const headers = new Headers()
  headers.set('Content-Type', 'application/json; charset=utf-8')
  headers.set(empty ? UPSTREAM_EMPTY_HEADER : UPSTREAM_NONDIAGNOSTIC_HEADER, String(response.status))
  // 上游若给了 Retry-After 就保留，其余头（content-encoding/content-length 等）与
  // 重写后的 body 不再匹配，一律丢弃。
  const retryAfter = response.headers.get('retry-after')
  if (retryAfter) headers.set('Retry-After', retryAfter)

  return new Response(JSON.stringify(payload), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
