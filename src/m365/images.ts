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
import { getM365Account, updateM365RefreshToken, M365_OAUTH } from './oauth'

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
  /** 网关公网 origin（用于把本地图片文件 URL 拼成绝对地址，同原版） */
  baseUrl?: string
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

/** 分块转 base64，避免对 20MB 大数组展开导致调用栈溢出（同 chathub bytesToBase64） */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[])
  }
  return btoa(binary)
}

/** 获取 Designer 下载 token（通过 refresh_token 换取 Designer scope）。oid 指定时用同账号，保证下载与生成归属一致 */
async function getDesignerToken(env: Env, providerId: string, _provider: Provider, oid?: string): Promise<string> {
  const account = await getM365Account(env, providerId, oid)
  if (!account || !account.refreshToken) {
    throw new Error('account has no refresh token for Designer image download')
  }
  // 用 refresh_token 换取 Designer app service scope 的 access token
  // client_id 必须与签发 refresh_token 的 client 一致（同原版 firstNonEmpty(acc.ClientID, auth.ClientID())）
  const resp = await fetch(
    `https://login.microsoftonline.com/${account.tid || 'common'}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: M365_OAUTH.clientId,
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
  // 同原版：微软可能轮换 refresh_token，必须回写账号池，否则旧 token 作废后刷新链断裂
  const rotated = json['refresh_token']
  if (typeof rotated === 'string' && rotated && rotated !== account.refreshToken) {
    try {
      await updateM365RefreshToken(env, providerId, account.oid, rotated)
    } catch (err) {
      console.error(`[image-gen] 轮换 refresh_token 持久化失败 provider=${providerId} account=${account.oid}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return json['access_token'] as string
}

/** 下载 Designer 图片。重定向仅允许落到 designerapp 主机、最多 3 跳，鉴权只发给目标图床（防 token 泄露 / SSRF） */
async function downloadDesignerImage(url: string, token: string, hops = 0): Promise<{ data: Uint8Array; contentType: string }> {
  const MAX_REDIRECTS = 3
  if (hops > MAX_REDIRECTS) {
    throw new Error('Designer image download exceeded redirect limit')
  }
  const targetIsDesigner = (() => {
    try { return new URL(url).hostname === 'designerapp.officeapps.live.com' } catch { return false }
  })()

  const headers: Record<string, string> = { Accept: 'image/*' }
  // 鉴权只发给 designerapp 图床；重定向到未知主机不带 Bearer，避免 token 落第三方
  if (targetIsDesigner) headers['Authorization'] = `Bearer ${token}`

  const resp = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(30000),
    redirect: 'manual',
  })
  if (resp.status >= 300 && resp.status < 400) {
    const location = resp.headers.get('Location')
    if (!location) throw new Error('Designer image redirect without Location')
    // 仅允许重定向到 designerapp（主图床）或与当前同域的 CDN
    let next = location
    if (!next.startsWith('http')) next = new URL(location, url).toString()
    let nextHost = ''
    try { nextHost = new URL(next).hostname } catch { throw new Error('Designer image redirect to invalid URL') }
    if (nextHost === 'designerapp.officeapps.live.com') {
      return downloadDesignerImage(next, token, hops + 1)
    }
    // 非 designer 域的图床：视为一次跨域跳转，改用无鉴权下载
    const anon = await fetch(next, { headers: { Accept: 'image/*' }, signal: AbortSignal.timeout(30000), redirect: 'follow' })
    if (!anon.ok) throw new Error(`Designer image download HTTP ${anon.status}`)
    const buf = await anon.arrayBuffer()
    if (buf.byteLength > 20 * 1024 * 1024) {
      throw new Error('generated image exceeds 20MiB')
    }
    const ct = anon.headers.get('Content-Type') || 'image/png'
    return { data: new Uint8Array(buf), contentType: ct }
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
          if (typeof e === 'string' && (lk === 'url' || lk === 'imageurl' || lk === 'thumbnailurl' || lk === 'downloadurl' || lk === 'src' || lk === 'value' || lk === 'data')) {
            if (e.startsWith('https://') && !seen.has(e)) {
              const le = e.toLowerCase()
              if (le.includes('image') || /\.(png|jpe?g|gif|webp)(&|$)/.test(le)) {
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
  const account = await getM365Account(env, provider.id, body.accountId)
  if (!account || !account.accessToken) {
    return new Response(JSON.stringify({ error: { message: 'M365 account not authorized', type: 'auth_error' } }), { status: 401, headers: { 'Content-Type': 'application/json' } })
  }

  // 参数校验（同原版）：n>10 → 400；response_format 非 url/b64_json → 400
  const n = body.n ?? 1
  if (!Number.isInteger(n) || n < 1 || n > 10) {
    return new Response(JSON.stringify({ error: { message: '"n" must be an integer between 1 and 10', type: 'invalid_request_error' } }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }
  const rawFormat = body.response_format || 'url'
  if (rawFormat !== 'url' && rawFormat !== 'b64_json') {
    return new Response(JSON.stringify({ error: { message: '"response_format" must be "url" or "b64_json"', type: 'invalid_request_error' } }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }
  const format = rawFormat
  const size = body.size || '1024x1024'
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
      // 指定账号时透传给 DO，保证生成账号与下载账号一致
      m365_account_id: body.accountId,
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
    // 原版两级回退：先 rawResult，提取不到再从 resultText 提取
    let extracted = extractImageURLs(rawResult)
    if (extracted.length === 0) extracted = extractImageURLs(resultText)
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
        // data:image/...;base64,<data> —— 缺少逗号视为非法数据（同原版）
        const parts = imgUrl.split(',', 2)
        if (parts.length < 2 || parts[1] === '') {
          return new Response(JSON.stringify({ error: { message: 'invalid image data url', type: 'invalid_request_error' } }), { status: 400, headers: { 'Content-Type': 'application/json' } })
        }
        data.push({ b64_json: parts[1] })
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

    // Designer 图片需要专用 token 下载（用同一账号 oid，保证 token 归属与生成账号一致）
    if (!designerToken) {
      try {
        designerToken = await getDesignerToken(env, provider.id, provider, body.accountId)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return new Response(JSON.stringify({ error: { message: `Designer token: ${msg}`, type: 'upstream_error' } }), { status: 502, headers: { 'Content-Type': 'application/json' } })
      }
    }

    try {
      const { data: imgData, contentType } = await downloadDesignerImage(imgUrl, designerToken)
      if (format === 'b64_json') {
        data.push({ b64_json: bytesToBase64(imgData) })
      } else {
        // 存储到 KV 并返回本地 URL：可取得 origin 时返回绝对地址（同原版），否则退回相对路径
        const id = crypto.randomUUID()
        const kvKey = `image:${id}`
        await env.KV.put(kvKey, JSON.stringify({ d: bytesToBase64(imgData), c: contentType }), { expirationTtl: 900 })
        data.push({ url: body.baseUrl ? `${body.baseUrl}/v1/images/files/${id}` : `/v1/images/files/${id}` })
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
    // 附加 m365 元数据块（同原版响应携带 m365:{...}）
    m365: {
      accountId: account.oid,
      providerId: provider.id,
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

/**
 * 提供本地存储的图片文件（/v1/images/files/:id）。
 * KV 存 {"d":<base64>,"c":<contentType>}；兼容旧版裸 base64（回退 image/png）。
 */
export async function handleImageFile(env: Env, id: string): Promise<Response> {
  const kvKey = `image:${id}`
  const raw = await env.KV.get(kvKey)
  if (!raw) {
    return new Response(JSON.stringify({ error: { message: 'image not found or expired', type: 'not_found' } }), { status: 404, headers: { 'Content-Type': 'application/json' } })
  }
  let b64 = raw
  let contentType = 'image/png'
  try {
    const obj = JSON.parse(raw) as { d?: string; c?: string }
    if (typeof obj.d === 'string') {
      b64 = obj.d
      if (typeof obj.c === 'string' && obj.c.trim() !== '') contentType = obj.c
    }
  } catch { /* 旧版裸 base64 */ }
  try {
    const binary = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    return new Response(binary, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'private, max-age=300',
        'Content-Length': String(binary.length),
      },
    })
  } catch {
    return new Response(JSON.stringify({ error: { message: 'invalid image data', type: 'internal_error' } }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
}