const encoder = new TextEncoder()
const decoder = new TextDecoder()
const PBKDF2_ITERATIONS = 100_000

export function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

export function decodeBase64url(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)))
}

export async function sha256(value: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))))
}

export async function passwordRecord(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS, salt },
    material,
    256,
  )
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${base64url(salt)}$${base64url(new Uint8Array(bits))}`
}

export async function verifyPassword(record: string, password: string): Promise<boolean> {
  const [algorithm, iterationsRaw, saltRaw, expectedRaw] = record.split('$')
  if (algorithm !== 'pbkdf2-sha256') return false
  const iterations = Number.parseInt(iterationsRaw, 10)
  if (!Number.isFinite(iterations) || iterations !== PBKDF2_ITERATIONS) return false
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: decodeBase64url(saltRaw) },
    material,
    256,
  ))
  const expected = decodeBase64url(expectedRaw)
  if (bits.length !== expected.length) return false
  let difference = 0
  for (let index = 0; index < bits.length; index += 1) difference |= bits[index] ^ expected[index]
  return difference === 0
}

async function encryptionKey(encoded: string): Promise<CryptoKey> {
  const raw = decodeBase64url(encoded)
  if (raw.length !== 32) throw new Error('ENCRYPTION_KEY must contain exactly 32 bytes')
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function encryptJSON(value: unknown, encodedKey: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await encryptionKey(encodedKey),
    encoder.encode(JSON.stringify(value)),
  ))
  const payload = new Uint8Array(iv.length + ciphertext.length)
  payload.set(iv)
  payload.set(ciphertext, iv.length)
  return base64url(payload)
}

export async function decryptJSON<T>(payload: string, encodedKey: string): Promise<T> {
  const bytes = decodeBase64url(payload)
  if (bytes.length < 29) throw new Error('encrypted payload is invalid')
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, 12) },
    await encryptionKey(encodedKey),
    bytes.slice(12),
  )
  return JSON.parse(decoder.decode(plaintext)) as T
}

export async function encryptCompactionCapsule(value: unknown, encodedKey: string): Promise<string> {
  return encryptJSON(value, encodedKey)
}

export async function decryptCompactionCapsule<T>(payload: string, encodedKeys: string | readonly string[]): Promise<T> {
  const keys = (Array.isArray(encodedKeys) ? encodedKeys : [encodedKeys])
    .filter((k): k is string => typeof k === 'string' && Boolean(k.trim()))
  if (keys.length === 0) throw new Error('MISSING_COMPACTION_ENCRYPTION_KEY')
  for (const key of keys) {
    try {
      return await decryptJSON<T>(payload, key)
    } catch {
      // Try next candidate key
    }
  }
  throw new Error('INVALID_COMPACTION_CAPSULE')
}
