/**
 * deepseek/images.ts — 请求里的 `image_url` → 上游可用的图片字节。
 *
 * 移植自 simple-chat `internal/openai/openai.go` 的 `ExtractImages` / `decodeDataURL`
 * / `fetchImage`（MIT）。上游没有多模态请求体：图片必须**先上传**拿到 file id，再把
 * file id 放进补全请求的 `ref_file_ids`。所以这一层的产物是「待上传的字节 + 后缀」，
 * 上传与轮询在 `client.ts` 的 `uploadImageAndWait` 里（T3 已移植）。
 *
 * 线上约束（Go 版注释里的实测，逐条保留）：
 *  - 上传文件名**必须带受支持的后缀**：上游按后缀判类型，不看 part 的 MIME；
 *  - 图片走**独立的 fetch 客户端**：默认客户端没有超时，而上游客户端的 transport 调优
 *    不该被任意外部主机共用；
 *  - 单张图上限 10MB，抓取超时 30s（挂住的图床必须干净失败，不能把请求连同池槽位一起卡死）。
 *
 * 失败语义：**取不到图就是错误，绝不静默丢弃**——静默丢弃会产出一个「客户端以为带了图」
 * 的回答，这比直接报错更糟。
 *
 * 与 Go 版的有意差异（仅一处）：data URL 的 MIME 不受支持、base64 解码失败或超过 10MB 时，
 * Go 会**静默跳过**（`decodeDataURL` 返回 ok=false 后落到「非 http(s) URL 静默跳过」那条）。
 * 这与它自己声明的契约矛盾，这里按契约改成报错。非 data / 非 http(s) 的 URL 仍按 Go 静默跳过。
 */

/** 单张图片字节上限（Go `10<<20`）。 */
export const DEEPSEEK_IMAGE_MAX_BYTES = 10 * 1024 * 1024

/** 单张图片抓取超时（Go `imageFetchTimeout`）。 */
export const DEEPSEEK_IMAGE_FETCH_TIMEOUT_MS = 30_000

/** 一张待上传的图片。 */
export interface DeepseekImage {
  data: Uint8Array
  /** `png` / `jpg` / `webp` / `gif`——上传文件名要用它（上游按后缀判类型）。 */
  ext: string
}

/** 图片取用失败（抓取/解码/超限）。 */
export class DeepseekImageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeepseekImageError'
  }
}

/** MIME → 后缀；不支持的图片类型返回空串。 */
export function imageExtByMime(contentType: string): string {
  const ct = contentType.split(';')[0].trim().toLowerCase()
  switch (ct) {
    case 'image/png':
      return 'png'
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg'
    case 'image/webp':
      return 'webp'
    case 'image/gif':
      return 'gif'
    default:
      return ''
  }
}

/** 错误信息里只保留 `scheme://host/path`：客户端给的 URL 可能把 token 放在 query 里。 */
export function firstSegment(u: string): string {
  const cut = u.indexOf('?')
  const base = cut >= 0 ? u.slice(0, cut) : u
  return base.length > 128 ? base.slice(0, 128) : base
}

function base64ToBytes(payload: string): Uint8Array | null {
  try {
    // atob 在 Workers 与 Node 都有；先按 latin1 还原成二进制串，再逐字节取。
    const binary = atob(payload)
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

/**
 * 解析 `data:image/...;base64,<payload>`。
 * 返回 null = **不是** data URL（调用方应继续尝试 http 抓取）；抛错 = 是 data URL 但不可用。
 */
export function decodeDataUrl(u: string): DeepseekImage | null {
  if (!u.startsWith('data:')) return null
  const rest = u.slice('data:'.length)
  const semi = rest.indexOf(',')
  if (semi < 0) throw new DeepseekImageError(`image data URL has no comma: ${firstSegment(u)}`)
  const meta = rest.slice(0, semi)
  const payload = rest.slice(semi + 1)
  if (!meta.endsWith(';base64')) {
    throw new DeepseekImageError(`image data URL must be base64-encoded: ${meta}`)
  }
  const ext = imageExtByMime(meta.slice(0, -';base64'.length))
  if (!ext) throw new DeepseekImageError(`unsupported image type in data URL: ${meta}`)
  const data = base64ToBytes(payload)
  if (!data) throw new DeepseekImageError('image data URL payload is not valid base64')
  if (data.length > DEEPSEEK_IMAGE_MAX_BYTES) {
    throw new DeepseekImageError(`image data URL exceeds the 10MB cap (${data.length} bytes)`)
  }
  return { data, ext }
}

export type ImageFetchLike = (input: string, init?: RequestInit) => Promise<Response>

/**
 * 抓取 http(s) 图片。返回 null = 不是 http(s) URL（Go 里「唯一剩下的非错误跳过」）。
 * 超时用 AbortSignal 实现（Go 用独立 http.Client 的 Timeout）。
 */
export async function fetchImage(
  u: string,
  deps: { fetch?: ImageFetchLike; timeoutMs?: number } = {},
): Promise<DeepseekImage | null> {
  if (!u.startsWith('http://') && !u.startsWith('https://')) return null
  const doFetch: ImageFetchLike = deps.fetch ?? ((input, init) => fetch(input, init))
  const timeoutMs = deps.timeoutMs ?? DEEPSEEK_IMAGE_FETCH_TIMEOUT_MS

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let resp: Response
  try {
    resp = await doFetch(u, { signal: controller.signal })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new DeepseekImageError(`image fetch ${firstSegment(u)}: ${message}`)
  } finally {
    clearTimeout(timer)
  }

  if (resp.status !== 200) {
    throw new DeepseekImageError(`image fetch ${firstSegment(u)}: http ${resp.status}`)
  }
  const ext = imageExtByMime(resp.headers.get('Content-Type') ?? '')
  if (!ext) {
    throw new DeepseekImageError(
      `image fetch ${firstSegment(u)}: unsupported content type "${resp.headers.get('Content-Type') ?? ''}"`,
    )
  }
  const buf = await resp.arrayBuffer().catch((err: unknown) => {
    throw new DeepseekImageError(`image fetch ${firstSegment(u)}: ${(err as Error).message ?? String(err)}`)
  })
  if (buf.byteLength > DEEPSEEK_IMAGE_MAX_BYTES) {
    throw new DeepseekImageError(`image fetch ${firstSegment(u)}: exceeds 10MB cap`)
  }
  return { data: new Uint8Array(buf), ext }
}

/** 从消息里抽出所有图片（data URL 就地解码，http(s) 服务端抓取）。 */
export async function extractDeepseekImages(
  messages: Array<{ contentParts: Array<{ type: string; imageUrl?: string }> }>,
  deps: { fetch?: ImageFetchLike; timeoutMs?: number } = {},
): Promise<DeepseekImage[]> {
  const images: DeepseekImage[] = []
  for (const m of messages) {
    for (const p of m.contentParts) {
      const url = p.imageUrl ?? ''
      if (p.type !== 'image_url' || url === '') continue
      const inline = decodeDataUrl(url)
      if (inline) {
        images.push(inline)
        continue
      }
      const fetched = await fetchImage(url, deps)
      if (fetched) images.push(fetched)
    }
  }
  return images
}