/**
 * 入站请求体大小限制（移植自 M365-Gateway src/request-body.ts）。
 *
 * 背景：Cloudflare Worker isolate 有 128 MiB 内存上限，而 JSON 输入在内存中同时以
 * UTF-16 文本、解析对象、扁平化 prompt、SignalR 负载等多种形态存在。若不在入口处
 * 设置上界，超大请求可能在发起上游调用前就撑爆隔离区。优先使用远程图片 URL 承载大媒体。
 */

/** 请求体超限或 JSON 非法；code 为闭合机读标签，绝不携带请求内容 */
export class RequestBodyError extends Error {
  constructor(readonly code: 'REQUEST_TOO_LARGE' | 'INVALID_JSON') {
    super(code)
    this.name = 'RequestBodyError'
  }
}

// 普通推理入口（Chat / Messages / Responses）的 wire 预算。
export const MAX_AI_REQUEST_BYTES = 8 * 1024 * 1024

// Responses 入口除文本/工具历史外还携带 base64 input_image 片段，采用与 Chat/Messages
// 相同的 wire 预算，避免在 multimodal 校验前就拒掉合法图片。单图与解码后聚合上限另行生效。
export const MAX_RESPONSES_REQUEST_BYTES = MAX_AI_REQUEST_BYTES

// 压缩端点在解析后即丢弃二进制媒体与原始工具输出，给予更大但仍受内存约束的预算，
// 使略超普通上限的会话仍可恢复，而不是永久无法压缩。
export const MAX_COMPACTION_REQUEST_BYTES = 16 * 1024 * 1024

function declaredLength(request: Request): number | null {
  const raw = request.headers.get('Content-Length')?.trim()
  if (!raw) return null
  if (!/^\d+$/u.test(raw)) throw new RequestBodyError('INVALID_JSON')
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) throw new RequestBodyError('INVALID_JSON')
  return value
}

/**
 * 在拒绝超过 maxBytes 的前提下读取请求体，绝不缓冲超过 maxBytes。
 * Cloudflare Workers 可能收到无 Content-Length 的 chunked 请求，因此
 * "先 request.text() 再查头" 不是内存上界；必须在流式读取过程中累计计数。
 */
export async function readTextLimited(request: Request, maxBytes: number): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('maxBytes must be a non-negative safe integer')
  const declared = declaredLength(request)
  if (declared !== null && declared > maxBytes) throw new RequestBodyError('REQUEST_TOO_LARGE')
  if (!request.body) return ''

  const reader = request.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })
  let total = 0
  let text = ''
  let fragments: string[] = []
  let fragmentBytes = 0
  const flushFragments = (): void => {
    if (fragments.length === 0) return
    text += fragments.join('')
    fragments = []
    fragmentBytes = 0
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.byteLength === 0) continue
      if (value.byteLength > maxBytes - total) {
        // 不等发送方传完超大上传：立即取消并快速失败。
        await reader.cancel('request body exceeds configured limit').catch(() => undefined)
        throw new RequestBodyError('REQUEST_TOO_LARGE')
      }
      total += value.byteLength
      // 增量解码，避免同时保留全部原始分片与合并后的字节缓冲（chunked 无长度头时尤为关键）。
      const fragment = decoder.decode(value, { stream: true })
      if (fragment) fragments.push(fragment)
      fragmentBytes += value.byteLength
      // 对抗性分片时限制单块对象开销，同时避免正常上传的二次方拼接。
      if (fragmentBytes >= 64 * 1024 || fragments.length >= 4_096) flushFragments()
    }
    const finalFragment = decoder.decode()
    if (finalFragment) fragments.push(finalFragment)
    flushFragments()
  } finally {
    reader.releaseLock()
  }
  return text
}

/** 有界读取 + JSON 解析；超限/非法 JSON 统一抛 RequestBodyError（同原版 readJSONLimited） */
export async function readJSONLimited<T>(request: Request, maxBytes: number): Promise<T> {
  let text: string
  try {
    text = await readTextLimited(request, maxBytes)
    return JSON.parse(text || '{}') as T
  } catch (cause) {
    if (cause instanceof RequestBodyError) throw cause
    throw new RequestBodyError('INVALID_JSON')
  }
}
