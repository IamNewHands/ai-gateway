/**
 * 入站请求体大小限制（移植自 M365-Gateway src/request-body.ts）。
 *
 * 背景：Cloudflare Worker isolate 有 128 MiB 内存上限，而 JSON 输入在内存中同时以
 * UTF-16 文本、解析对象、扁平化 prompt、SignalR 负载等多种形态存在。若不在入口处
 * 设置上界，超大请求可能在发起上游调用前就撑爆隔离区。优先使用远程图片 URL 承载大媒体。
 */

/** 请求体超限、JSON 非法或 multipart 非法；code 为闭合机读标签，绝不携带请求内容 */
export class RequestBodyError extends Error {
  constructor(readonly code: 'REQUEST_TOO_LARGE' | 'INVALID_JSON' | 'INVALID_MULTIPART') {
    super(code)
    this.name = 'RequestBodyError'
  }
}

// 普通推理入口（Chat / Messages / Responses）的 wire 预算。
export const MAX_AI_REQUEST_BYTES = 8 * 1024 * 1024

// Responses 入口除文本/工具历史外还携带 base64 input_image 片段，采用与 Chat/Messages
// 相同的 wire 预算，避免在 multimodal 校验前就拒掉合法图片。单图与解码后聚合上限另行生效。
export const MAX_RESPONSES_REQUEST_BYTES = MAX_AI_REQUEST_BYTES

// 管理/控制类入口（admin/auth/checkin/trae 管理 API、MCP JSON-RPC）的 wire 预算。
// 这些入口的 body 是配置对象或 JSON-RPC 信封，正常远小于此值；取与推理入口同值，
// 保证粘贴超大配置时不被误伤，同时杜绝"先完整缓冲再解析"的无界路径。
export const MAX_ADMIN_REQUEST_BYTES = MAX_AI_REQUEST_BYTES

// 图片入口（/v1/images/generations、/v1/images/edits）的 wire 预算。
// 与普通推理同量级：edits 需容纳 base64(MAX_IMAGE_BINARY_BYTES)≈5.33MiB 加提示词与 JSON 结构，
// 8MiB 留出余量；两个入口此前完全不设上界（裸 c.req.json() / parseBody()）。
export const MAX_IMAGE_REQUEST_BYTES = 8 * 1024 * 1024

// 单张图片的解码后字节上限。这是"发给 M365 的一张图"的唯一预算，JSON edits 入口与
// chat multimodal 入口共用（multimodal.ts 的 MAX_DATA_IMAGE_BYTES 由此处导入），避免两处各写一份。
export const MAX_IMAGE_BINARY_BYTES = 4 * 1024 * 1024

/**
 * 由 base64 文本长度推算解码后字节数上界（O(1)，不做逐字符校验）。
 * 用于在把 base64 拼进 `data:` URL 之前做体积判断——拼接与 JSON.stringify 会让同一份
 * 数据在内存中出现多份，必须在拼之前而不是之后拦截。
 */
export function base64ByteLength(value: string): number {
  if (!value) return 0
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor(value.length / 4) * 3 - padding)
}

function declaredLength(request: Request): number | null {
  const raw = request.headers.get('Content-Length')?.trim()
  if (!raw) return null
  if (!/^\d+$/u.test(raw)) throw new RequestBodyError('INVALID_JSON')
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) throw new RequestBodyError('INVALID_JSON')
  return value
}

/**
 * 在累计字节不超过 maxBytes 的前提下逐块读取请求体，超限立即取消并抛 REQUEST_TOO_LARGE。
 * Cloudflare Workers 可能收到无 Content-Length 的 chunked 请求，因此
 * "先 request.text() 再查头" 不是内存上界；必须在流式读取过程中累计计数。
 * 本函数是文本/字节/multipart 三条有界读取路径共用的唯一读取循环（避免各写一份上限逻辑）。
 */
async function readBoundedChunks(
  request: Request,
  maxBytes: number,
  onChunk: (chunk: Uint8Array) => void,
): Promise<void> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('maxBytes must be a non-negative safe integer')
  const declared = declaredLength(request)
  if (declared !== null && declared > maxBytes) throw new RequestBodyError('REQUEST_TOO_LARGE')
  if (!request.body) return

  const reader = request.body.getReader()
  let total = 0
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
      onChunk(value)
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * 有界读取为 UTF-8 文本。
 * 增量解码，避免同时保留全部原始分片与合并后的字节缓冲（chunked 无长度头时尤为关键）。
 */
export async function readTextLimited(request: Request, maxBytes: number): Promise<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })
  let text = ''
  let fragments: string[] = []
  let fragmentBytes = 0
  const flushFragments = (): void => {
    if (fragments.length === 0) return
    text += fragments.join('')
    fragments = []
    fragmentBytes = 0
  }
  await readBoundedChunks(request, maxBytes, (chunk) => {
    const fragment = decoder.decode(chunk, { stream: true })
    if (fragment) fragments.push(fragment)
    fragmentBytes += chunk.byteLength
    // 对抗性分片时限制单块对象开销，同时避免正常上传的二次方拼接。
    if (fragmentBytes >= 64 * 1024 || fragments.length >= 4_096) flushFragments()
  })
  const finalFragment = decoder.decode()
  if (finalFragment) fragments.push(finalFragment)
  flushFragments()
  return text
}

/**
 * 有界读取为原始字节。multipart 请求体含二进制图片，不能按 UTF-8 文本解码
 * （fatal 解码器会在任意非 UTF-8 图片字节上抛错），因此单独提供字节路径。
 * 上限即 wire 预算，超出部分不会进入内存。
 */
export async function readBytesLimited(request: Request, maxBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  await readBoundedChunks(request, maxBytes, (chunk) => {
    chunks.push(chunk)
    total += chunk.byteLength
  })
  if (chunks.length === 0) return new Uint8Array(0)
  if (chunks.length === 1) return chunks[0]
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

/**
 * 有界读取 + multipart 解析。
 * 先按字节上界读完整段，再从字节构造 Response 交给平台解析——`c.req.parseBody()` 直接读原始流，
 * 没有任何上界，超大上传会先被完整缓冲。非法 multipart → INVALID_MULTIPART（映射 400）。
 */
export async function readFormDataLimited(request: Request, maxBytes: number): Promise<FormData> {
  const contentType = request.headers.get('Content-Type') || ''
  const bytes = await readBytesLimited(request, maxBytes)
  try {
    return await new Response(bytes, { headers: { 'Content-Type': contentType } }).formData()
  } catch {
    throw new RequestBodyError('INVALID_MULTIPART')
  }
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

/**
 * 有界读取 + 严格 JSON 解析：空正文与非法 JSON 都抛 INVALID_JSON，**不**把空正文默认成 `{}`。
 * 供需要区分"未提供 body"与"body 非法"的入口使用（管理员登录、MCP JSON-RPC）。
 */
export async function readStrictJSONLimited<T>(request: Request, maxBytes: number): Promise<T> {
  let text: string
  try {
    text = await readTextLimited(request, maxBytes)
  } catch (cause) {
    if (cause instanceof RequestBodyError) throw cause
    throw new RequestBodyError('INVALID_JSON')
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new RequestBodyError('INVALID_JSON')
  }
}

/**
 * 有界读取 + 容错 JSON 解析：正文为空或非法时返回 fallback（默认 `{}`），**仅超限抛错**。
 * 用于管理面既有 `await c.req.json().catch(() => ({}))` 的调用点——换成严格解析会把
 * "坏 body 继续按空配置执行" 变成 400，属于行为变更；这里只补上界，不改错误语义。
 */
export async function readOptionalJSONLimited<T = Record<string, unknown>>(
  request: Request,
  maxBytes: number,
  fallback: T = {} as T,
): Promise<T> {
  try {
    return await readJSONLimited<T>(request, maxBytes)
  } catch (cause) {
    if (cause instanceof RequestBodyError && cause.code === 'REQUEST_TOO_LARGE') throw cause
    return fallback
  }
}
