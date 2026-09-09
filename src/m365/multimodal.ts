/**
 * Protocol-only multimodal normalization for the Cloudflare-native gateway.
 *
 * This module deliberately performs no network or account access. It gives a
 * future ChatHub adapter one strict representation for OpenAI Chat and
 * Responses image parts, and prevents unsupported parts from being silently
 * discarded.
 */

const MAX_CONTENT_PARTS = 256
const MAX_IMAGES = 8
const MAX_IMAGE_URL_CHARACTERS = 8_192
const MAX_DATA_IMAGE_BYTES = 4 * 1_024 * 1_024
const MAX_TOTAL_DATA_IMAGE_BYTES = 6 * 1_024 * 1_024
// Base64 expands binary data by roughly 4/3. Reject an obviously oversized
// data URI before the anchored regexp and per-character validator allocate or
// scan several megabytes of attacker-controlled text.
const MAX_DATA_IMAGE_BASE64_CHARACTERS = Math.ceil(MAX_DATA_IMAGE_BYTES / 3) * 4
const MAX_DATA_IMAGE_URI_CHARACTERS = MAX_DATA_IMAGE_BASE64_CHARACTERS + 128

const DATA_IMAGE_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
])

export type MultimodalInputErrorCode =
  | 'audio_not_supported'
  | 'image_too_large'
  | 'invalid_image'
  | 'invalid_multimodal_content'
  | 'too_many_images'
  | 'unsupported_content_part'

export class MultimodalInputError extends Error {
  constructor(readonly code: MultimodalInputErrorCode) {
    super(code.toUpperCase())
    this.name = 'MultimodalInputError'
  }
}

export interface NormalizedImageAttachment {
  type: 'image'
  url: string
  mimeType: string
  detail: 'auto' | 'high' | 'low'
}

export interface NormalizedMultimodalContent {
  text: string
  attachments: NormalizedImageAttachment[]
  dataImageBytes: number
}

export interface NormalizedMultimodalContents {
  /** One normalized result per supplied message/input content value. */
  contents: NormalizedMultimodalContent[]
  /** Flattened attachments in original message/part order. */
  attachments: NormalizedImageAttachment[]
  dataImageBytes: number
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function strictBase64Bytes(value: string, maximumBytes = Number.POSITIVE_INFINITY): number | null {
  if (!value || value.length % 4 !== 0) return null
  const maximumEncodedCharacters = Math.ceil(maximumBytes / 3) * 4
  if (value.length > maximumEncodedCharacters) return maximumBytes + 1
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const contentEnd = value.length - padding
  // Avoid one enormous regular expression. Multi-megabyte data URLs can make
  // some JS regexp engines exhaust their backtracking stack before the size
  // guard gets a chance to reject the image.
  for (let index = 0; index < contentEnd; index += 1) {
    const code = value.charCodeAt(index)
    const base64 = (code >= 0x41 && code <= 0x5a)
      || (code >= 0x61 && code <= 0x7a)
      || (code >= 0x30 && code <= 0x39)
      || code === 0x2b
      || code === 0x2f
    if (!base64) return null
  }
  for (let index = contentEnd; index < value.length; index += 1) if (value.charCodeAt(index) !== 0x3d) return null
  return (value.length / 4) * 3 - padding
}

function privateOrLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true
  // Image CDNs normally use DNS names. Reject every literal IPv6 spelling so
  // IPv4-mapped, compressed, link-local and ULA variants cannot bypass a
  // partial private-range parser.
  if (host.includes(':')) return true
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host)
  if (!ipv4) return false
  const octets = ipv4.slice(1).map(Number)
  if (octets.some((octet) => octet > 255)) return true
  const [a, b] = octets
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224
}

function normalizedDetail(value: unknown): 'auto' | 'high' | 'low' {
  if (value == null || value === '') return 'auto'
  if (value === 'auto' || value === 'high' || value === 'low') return value
  throw new MultimodalInputError('invalid_image')
}

function normalizeImageURL(value: unknown, detail: unknown): { attachment: NormalizedImageAttachment; dataBytes: number } {
  if (typeof value !== 'string' || !value) {
    throw new MultimodalInputError('invalid_image')
  }
  if (value.startsWith('data:')) {
    if (value.length > MAX_DATA_IMAGE_URI_CHARACTERS) throw new MultimodalInputError('image_too_large')
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/u.exec(value)
    const mimeType = match?.[1]?.toLowerCase() ?? ''
    const bytes = match ? strictBase64Bytes(match[2], MAX_DATA_IMAGE_BYTES) : null
    if (!DATA_IMAGE_TYPES.has(mimeType) || bytes == null || bytes === 0) {
      throw new MultimodalInputError('invalid_image')
    }
    if (bytes > MAX_DATA_IMAGE_BYTES) throw new MultimodalInputError('image_too_large')
    return {
      attachment: { type: 'image', url: value, mimeType, detail: normalizedDetail(detail) },
      dataBytes: bytes,
    }
  }

  if (value.length > MAX_IMAGE_URL_CHARACTERS) throw new MultimodalInputError('invalid_image')

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new MultimodalInputError('invalid_image')
  }
  if (url.protocol !== 'https:' || url.username || url.password || privateOrLocalHostname(url.hostname)) {
    throw new MultimodalInputError('invalid_image')
  }
  return {
    attachment: { type: 'image', url: url.toString(), mimeType: 'image/*', detail: normalizedDetail(detail) },
    dataBytes: 0,
  }
}

function imagePart(raw: Record<string, unknown>): { attachment: NormalizedImageAttachment; dataBytes: number } {
  if (raw['type'] === 'image_url') {
    if (typeof raw['image_url'] === 'string') return normalizeImageURL(raw['image_url'], raw['detail'])
    const image = record(raw['image_url'])
    if (!image) throw new MultimodalInputError('invalid_image')
    return normalizeImageURL(image['url'], image['detail'] ?? raw['detail'])
  }
  if (raw['type'] === 'input_image') return normalizeImageURL(raw['image_url'] ?? raw['url'], raw['detail'])
  if (raw['type'] === 'image') return normalizeImageURL(raw['url'], raw['detail'])
  throw new MultimodalInputError('unsupported_content_part')
}

/** Normalize OpenAI Chat/Responses content without fetching remote images. */
export function normalizeMultimodalContent(content: unknown): NormalizedMultimodalContent {
  if (typeof content === 'string') return { text: content, attachments: [], dataImageBytes: 0 }
  if (!Array.isArray(content) || content.length > MAX_CONTENT_PARTS) {
    throw new MultimodalInputError('invalid_multimodal_content')
  }
  const text: string[] = []
  const attachments: NormalizedImageAttachment[] = []
  let dataImageBytes = 0
  for (const value of content) {
    const part = record(value)
    if (!part || typeof part['type'] !== 'string') throw new MultimodalInputError('invalid_multimodal_content')
    if (['text', 'input_text', 'output_text'].includes(part['type'])) {
      if (typeof part['text'] !== 'string') throw new MultimodalInputError('invalid_multimodal_content')
      text.push(part['text'])
      continue
    }
    if (['image_url', 'input_image', 'image'].includes(part['type'])) {
      if (attachments.length >= MAX_IMAGES) throw new MultimodalInputError('too_many_images')
      const image = imagePart(part)
      dataImageBytes += image.dataBytes
      if (dataImageBytes > MAX_TOTAL_DATA_IMAGE_BYTES) throw new MultimodalInputError('image_too_large')
      attachments.push(image.attachment)
      continue
    }
    if (['audio', 'input_audio'].includes(part['type'])) throw new MultimodalInputError('audio_not_supported')
    throw new MultimodalInputError('unsupported_content_part')
  }
  return { text: text.join('\n'), attachments, dataImageBytes }
}

/**
 * Normalize all message content fields as one request budget. Calling the
 * single-content helper independently for every message would otherwise let a
 * request multiply the eight-image and six-MiB limits by its message count.
 */
export function normalizeMultimodalContents(values: readonly unknown[]): NormalizedMultimodalContents {
  if (!Array.isArray(values)) throw new MultimodalInputError('invalid_multimodal_content')
  const contents: NormalizedMultimodalContent[] = []
  const attachments: NormalizedImageAttachment[] = []
  let dataImageBytes = 0
  for (const value of values) {
    const normalized = normalizeMultimodalContent(value)
    if (attachments.length + normalized.attachments.length > MAX_IMAGES) {
      throw new MultimodalInputError('too_many_images')
    }
    dataImageBytes += normalized.dataImageBytes
    if (dataImageBytes > MAX_TOTAL_DATA_IMAGE_BYTES) throw new MultimodalInputError('image_too_large')
    contents.push(normalized)
    attachments.push(...normalized.attachments)
  }
  return { contents, attachments, dataImageBytes }
}

function probableImageURL(value: string): boolean {
  if (value.startsWith('data:')) {
    try {
      normalizeImageURL(value, 'auto')
      return true
    } catch {
      return false
    }
  }
  let url: URL
  try {
    normalizeImageURL(value, 'auto')
    url = new URL(value)
  } catch {
    return false
  }
  const path = url.pathname.toLowerCase()
  return path.includes('image') || /\.(?:gif|jpe?g|png|webp)$/u.test(path)
}

/**
 * Extract bounded, de-duplicated image resources from opaque ChatHub events.
 * Arbitrary links in assistant prose are intentionally not treated as images.
 */
export function extractUpstreamImageURLs(value: unknown): string[] {
  const output: string[] = []
  const seen = new Set<string>()
  let visited = 0
  const visit = (item: unknown, depth: number): void => {
    if (depth > 12 || visited >= 10_000 || output.length >= 4) return
    visited += 1
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1)
      return
    }
    const object = record(item)
    if (!object) return
    for (const [key, child] of Object.entries(object)) {
      if (typeof child === 'string'
        && ['downloadurl', 'imageurl', 'src', 'thumbnailurl', 'url'].includes(key.toLowerCase())
        && probableImageURL(child)
        && !seen.has(child)) {
        seen.add(child)
        output.push(child)
        if (output.length >= 4) return
      } else if (typeof child === 'object' && child !== null) {
        visit(child, depth + 1)
      }
    }
  }
  visit(value, 0)
  return output
}
