/**
 * upstream-failure.ts — 上游失败响应体为空时的可诊断化。
 *
 * 背景：2026-10-21 DSH 通过网关请求 `opencode/deepseek-v4.1-flash-free` 连续两次报
 * `LlmError: 404 status code (no body)`。排查发现网关自己返回的 404 都带 JSON 中文
 * 文案（`模型"x"未配置` / `提供商"x"不存在`），而那次是**上游 404 且响应体为空**
 * 被 `restoreFailure` 原样透传——客户端只能看到「404 无响应体」，无法判断是模型不存在、
 * 形状被拦，还是上游网关抖动，排查方向被引偏。
 *
 * 本模块只做一件事：状态码保持上游原值（不谎报成功、不把 4xx 改写成 2xx/5xx），
 * 但把**空体**替换成含上游状态、模型、尝试次数与镜像数的 JSON 诊断体，并加一个
 * `x-ai-gateway-upstream-empty` 标记头，便于日志与客户端一眼区分「上游静默失败」
 * 与「网关自身错误」。
 */

/** 空体诊断所需的上下文，由调用方在失败出口处提供。 */
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
/** 标记头：值为上游状态码。 */
export const UPSTREAM_EMPTY_HEADER = 'x-ai-gateway-upstream-empty'

function hintFor(context: EmptyBodyContext): string {
  const parts: string[] = []
  if (context.lane === 'mirror') parts.push('已回退到 public 镜像仍为空体')
  if (context.keysTried === 0) parts.push('该提供商没有启用任何 Key（走镜像模式）')
  if (context.mirrors === 0) parts.push('未配置 OPENCODE_MIRRORS_URL 等镜像回退')
  parts.push('上游静默失败常见于：模型已下架、免费档形状被拦、或上游网关抖动；稍后重试或换模型/换账号')
  return parts.join('；')
}

/**
 * 若失败响应体为空，替换为可诊断 JSON 体（保留原状态码）；非空则**原样返回**。
 *
 * 用 `clone()` 读取一次文本，因此对非空情形不会消费掉原响应体。
 */
export async function withEmptyBodyDiagnosis(
  response: Response,
  context: EmptyBodyContext,
): Promise<Response> {
  if (response.ok) return response

  const text = await response.clone().text().catch(() => '')
  if (text.trim() !== '') return response

  const payload = {
    error: {
      type: UPSTREAM_EMPTY_ERROR_TYPE,
      message: `上游返回 ${response.status} 但响应体为空，无法从上游取得诊断信息`,
      upstream_status: response.status,
      model: context.model,
      ...(context.keysTried === undefined ? {} : { keys_tried: context.keysTried }),
      ...(context.mirrors === undefined ? {} : { mirrors: context.mirrors }),
      ...(context.lane === undefined ? {} : { lane: context.lane }),
      hint: hintFor(context),
    },
  }

  const headers = new Headers()
  headers.set('Content-Type', 'application/json; charset=utf-8')
  headers.set(UPSTREAM_EMPTY_HEADER, String(response.status))
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
