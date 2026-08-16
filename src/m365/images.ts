/**
 * M365 DALL-E 图片生成（移植自 M365-Copilot2API internal/web/images.go）。
 *
 * 通过 M365 ChatHub 的 GPT Image 2 / Designer 生成图片，
 * 兼容 OpenAI DALL-E API 格式（/v1/images/generations, /v1/images/edits）。
 *
 * 实现方式：
 * - 图片生成请求转发到 M365 Session DO，由 DO 内部调用 ChatHub 生成图片
 * - DO 返回 OpenAI DALL-E 格式响应（b64_json 或 url）
 * - Designer 图片通过专用 token 下载后转为 base64 或本地 URL
 */
import type { Env, Provider } from '../types'
import { isM365Provider } from './proxy'
import { getM365Account } from './oauth'

/** DALL-E 请求格式 */
interface ImageGenRequest {
  prompt: string
  model?: string
  n?: number
  size?: string
  response_format?: 'url' | 'b64_json'
  user?: string
  accountId?: string
  operation?: 'generation' | 'edit'
  /** base64 图片数据（edit 模式） */
  image?: string
  /** 图片 MIME 类型 */
  imageType?: string
}

/** 判断 URL 是否是 Designer 图片 */
function isDesignerImageURL(url: string): boolean {
  try {
    const u = new URL(url)
    return u.hostname === 'designerapp.officeapps.live.com'
  } catch {
    return false
  }
}

/** 获取 Designer 下载 token（通过 refresh_token 换取 Designer scope） */
async function getDesignerToken(env: Env, providerId: string, _provider: Provider): Promise<string> {
  const account = await getM365Account(env, providerId)
  if (!account || !account.refreshToken) {
    throw new Error('account has no refresh token for Designer image download')
  }
  // 用 refresh_token 换取 Designer app service scope 的 access token
  // client_id 使用 M365 默认 client ID（同原版 auth.ClientID）
  const clientId = 'abc06c5a-7202-4b42-9b8e-3473353e0700'
  const resp = await fetch(
    `https://login.microsoftonline.com/${account.tid || 'common'}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: account.refreshToken,
        scope: 'https://designerappservice.officeapps.live.com/.default',
      }).toString(),
      signal: AbortSignal.timeout(15000),
    },
  )
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`Designer token refresh failed: HTTP ${resp.status} ${body.substring(0, 200)}`)
  }
  const json = (await resp.json()) as Record<string, unknown>
  if (typeof json['access_token'] !== 'string') {
    throw new Error('Designer token response missing access_token')
  }
  return json['access_token'] as string
}

/** 下载 Designer 图片 */
async function downloadDesignerImage(url: string, token: string): Promise<{ data: Uint8Array; contentType: string }> {
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'image/*' },
    signal: AbortSignal.timeout(30000),
    redirect: 'manual',
  })
  // Designer 可能返回 302/307 重定向到真实 CDN
  if (resp.status >= 300 && resp.status < 400) {
    const location = resp.headers.get('Location')
    if (location) {
      return downloadDesignerImage(location, token)
    }
  }
  if (!resp.ok) {
    throw new Error(`Designer image download HTTP ${resp.status}`)
  }
  const MAX_BYTES = 20 * 1024 * 1024
  const buf = await resp.arrayBuffer()
  if (buf.byteLength > MAX_BYTES) {
    throw new Error(`generated image exceeds ${MAX_BYTES} bytes`)
  }
  const ct = resp.headers.get('Content-Type') || 'image/png'
  return { data: new Uint8Array(buf), contentType: ct }
}

/** 从 raw JSON 字符串中提取图片 URL */
function extractImageURLs(raw: string): string[] {
  if (!raw) return []
  const urls: string[] = []
  const seen = new Set<string>()
  try {
    const parsed = JSON.parse(raw)
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) {
        for (const e of v) walk(e)
      } else if (typeof v === 'object' && v !== null) {
        for (const [k, e] of Object.entries(v as Record<string, unknown>)) {
          const lk = k.toLowerCase()
          if (typeof e === 'string' && (lk === 'url' || lk === 'imageurl' || lk === 'thumbnailurl' || lk === 'downloadurl' || lk === 'src')) {
            if (e.startsWith('https://') && !seen.has(e)) {
              const le = e.toLowerCase()
              if (le.includes('image') || le.endsWith('.png') || le.endsWith('.jpg') || le.endsWith('.jpeg') || le.endsWith('.webp')) {
                seen.add(e)
                urls.push(e)
              }
            }
          } else {
            walk(e)
          }
        }
      }
    }
    walk(parsed)
  } catch { /* ignore parse errors */ }
  return urls
}

/** 判断是否图片额度耗尽 */
function isImageQuotaRefusal(text: string): boolean {
  const low = text.toLowerCase()
  for (const phrase of [
    'generate any more images',
    'image generation quota',
    'daily image limit',
    'try again tomorrow',
    '无法再生成图片',
    '请明天再试',
  ]) {
    if (low.includes(phrase)) return true
  }
  return false
}

/**
 * 处理图片生成请求（/v1/images/generations 和 /v1/images/edits）。
 * 在 Worker 层面直接调用 ChatHub DO 生成图片，返回 DALL-E 格式响应。
 */
export async function handleImageGeneration(
  env: Env,
  provider: Provider,
  body: ImageGenRequest,
): Promise<Response> {
  const account = await getM365Account(env, provider.id)
  if (!account || !account.accessToken) {
    return new Response(JSON.stringify({ error: { message: 'M365 account not authorized', type: 'auth_error' } }), { status: 401, headers: { 'Content-Type': 'application/json' } })
  }

  const n = Math.max(1, Math.min(body.n || 1, 10))
  const size = body.size || '1024x1024'
  const format = body.response_format || 'url'
  const isEdit = body.operation === 'edit'

  if (isEdit && !body.image) {
    return new Response(JSON.stringify({ error: { message: 'image is required for edits', type: 'invalid_request_error' } }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }

  // 构造图片生成 prompt
  let prompt: string
  if (isEdit) {
    prompt = `Edit the first attached image with GPT Image 2. Size: ${size}. Instructions: ${body.prompt}. Preserve everything not requested to change. Return the edited image URL directly.`
  } else {
    prompt = `Generate an image with GPT Image 2. Size: ${size}. Description: ${body.prompt}. Return the image URL directly.`
  }

  // 通过 DO 发送图片生成请求
  const payload = {
    providerId: provider.id,
    model: body.model || 'gpt-image-2',
    body: {
      model: body.model || 'gpt-image-2',
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      ...(isEdit && body.image ? {
        attachments: [{
          type: 'image',
          url: `data:${body.imageType || 'image/png'};base64,${body.image}`,
          name: 'image.' + (body.imageType === 'image/jpeg' ? 'jpg' : body.imageType === 'image/webp' ? 'webp' : 'png'),
          mimeType: body.imageType || 'image/png',
        }],
      } : {}),
      // 标记为图片模式，DO 内部不走工具路由
      _m365_image_mode: true,
    },
    stream: false,
    _image_mode: true,
  }

  const sessionId = provider.id + ':image:' + crypto.randomUUID()
  const stub = env.M365_SESSION.get(env.M365_SESSION.idFromName(sessionId))
  const resp = await stub.fetch('https://m365-session.local/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    return new Response(JSON.stringify({ error: { message: `image generation failed: ${text.substring(0, 200)}`, type: 'upstream_error' } }), { status: 502, headers: { 'Content-Type': 'application/json' } })
  }

  // 解析 DO 返回的结果（ChatHub 原始结果）
  const result = (await resp.json().catch(() => ({}))) as Record<string, unknown>
  const images: string[] = (result['images'] as string[]) || []
  const resultText = (result['text'] as string) || ''
  const rawResult = (result['rawResult'] as string) || ''

  if (images.length === 0) {
    // 尝试从 rawResult 中提取
    const extracted = extractImageURLs(rawResult) || extractImageURLs(resultText)
    images.push(...extracted)
  }

  if (images.length === 0) {
    if (isImageQuotaRefusal(resultText + rawResult)) {
      return new Response(JSON.stringify({ error: { message: 'M365 image generation quota is exhausted; try again later or use another account', type: 'rate_limit_error' } }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '86400' } })
    }
    return new Response(JSON.stringify({ error: { message: 'upstream returned no image resource', type: 'upstream_error' } }), { status: 502, headers: { 'Content-Type': 'application/json' } })
  }

  const selected = images.slice(0, n)

  // 处理图片：下载 Designer 图片或返回原始 URL
  let designerToken = ''
  const data: Array<{ url?: string; b64_json?: string }> = []

  for (const imgUrl of selected) {
    if (imgUrl.startsWith('data:image/')) {
      if (format === 'b64_json') {
        const parts = imgUrl.split(',', 2)
        data.push({ b64_json: parts[1] || parts[0] })
      } else {
        data.push({ url: imgUrl })
      }
      continue
    }

    if (!isDesignerImageURL(imgUrl)) {
      if (format === 'b64_json') {
        return new Response(JSON.stringify({ error: { message: 'upstream returned URL, not b64_json', type: 'unsupported_response_format' } }), { status: 502, headers: { 'Content-Type': 'application/json' } })
      }
      data.push({ url: imgUrl })
      continue
    }

    // Designer 图片需要专用 token 下载
    if (!designerToken) {
      try {
        designerToken = await getDesignerToken(env, provider.id, provider)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return new Response(JSON.stringify({ error: { message: `Designer token: ${msg}`, type: 'upstream_error' } }), { status: 502, headers: { 'Content-Type': 'application/json' } })
      }
    }

    try {
      const { data: imgData, contentType } = await downloadDesignerImage(imgUrl, designerToken)
      if (format === 'b64_json') {
        data.push({ b64_json: btoa(String.fromCharCode(...imgData)) })
      } else {
        // 存储到 KV 并返回本地 URL
        const id = crypto.randomUUID()
        const kvKey = `image:${id}`
        await env.KV.put(kvKey, btoa(String.fromCharCode(...imgData)), { expirationTtl: 900 })
        data.push({ url: `/v1/images/files/${id}` })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`[image-gen] download failed: ${msg}`)
      return new Response(JSON.stringify({ error: { message: `image download failed: ${msg}`, type: 'upstream_error' } }), { status: 502, headers: { 'Content-Type': 'application/json' } })
    }
  }

  return new Response(JSON.stringify({
    created: Math.floor(Date.now() / 1000),
    data,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

/**
 * 提供本地存储的图片文件（/v1/images/files/:id）。
 */
export async function handleImageFile(env: Env, id: string): Promise<Response> {
  const kvKey = `image:${id}`
  const raw = await env.KV.get(kvKey)
  if (!raw) {
    return new Response(JSON.stringify({ error: { message: 'image not found or expired', type: 'not_found' } }), { status: 404, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    const binary = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0))
    return new Response(binary, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'private, max-age=300',
        'Content-Length': String(binary.length),
      },
    })
  } catch {
    return new Response(JSON.stringify({ error: { message: 'invalid image data', type: 'internal_error' } }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
}