/**
 * cosy.ts — Qoder COSY 请求签名（移植自 cpa-plugin/qoderwork/sign.go）。
 *
 * 签名流程：
 *   1. 生成随机 machineId/machineToken/machineType/tempKey（16 ASCII 字符）
 *   2. RSA-1024 (PKCS1v15) 加密 tempKey → cosyKey
 *   3. AES-128-CBC (key=iv=tempKey, PKCS7) 加密身份 JSON（按键排序紧凑序列化）→ info
 *   4. 每次请求：payload = {cosyVersion,ideVersion,info,requestId,version} → base64 → payloadB64
 *      date = unix 秒；sig = md5(payloadB64\ncosyKey\ndate\n<body>\n<pathSig>)
 *      Authorization = "Bearer COSY." + payloadB64 + "." + sig
 *
 * 另含 QoderEncoding（自定义 base64 变体）与 cosySession 缓存。
 */

import { md5Hex } from './md5'

// ===== QoderEncoding（encoding.go） =====

const QODER_CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!'
const QODER_STD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/**
 * qoderEncode 将 plaintext 编码为 Qoder 自定义 base64 变体：
 *   1. 标准 base64
 *   2. 三段重排（a = n/3）
 *   3. 字母表映射，'=' → '$'
 */
export function qoderEncode(plain: string): string {
  const std = utf8ToBase64(plain)
  const n = std.length
  const a = Math.floor(n / 3)
  const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a)
  let out = ''
  for (let i = 0; i < n; i++) {
    const ch = rearranged[i]
    const idx = QODER_STD_ALPHABET.indexOf(ch)
    if (idx >= 0) {
      out += QODER_CUSTOM_ALPHABET[idx]
    } else if (ch === '=') {
      out += '$'
    } else {
      out += ch
    }
  }
  return out
}

// ===== 通用 base64 / uuid 工具 =====

function base64Std(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

function base64UrlNoPad(bytes: Uint8Array): string {
  return base64Std(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function uuid(): string {
  return crypto.randomUUID()
}

/** jsonSortedCompact：按键排序的紧凑 JSON（与 Go jsonSortedCompact 一致）。 */
export function jsonSortedCompact(m: Record<string, string>): string {
  const keys = Object.keys(m).sort()
  let out = '{'
  for (let i = 0; i < keys.length; i++) {
    if (i > 0) out += ','
    out += JSON.stringify(keys[i]) + ':' + JSON.stringify(m[keys[i]])
  }
  out += '}'
  return out
}

// ===== RSA / AES（Web Crypto） =====

// Qoder 服务器 RSA 公钥（来自桌面客户端 main.js，1024-bit SPKI）。
const SERVER_PUB_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`

function pemToBytes(pem: string): Uint8Array {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

async function rsaEncrypt(data: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'spki',
    pemToBytes(SERVER_PUB_KEY_PEM) as unknown as ArrayBuffer,
    { name: 'RSAES-PKCS1-v1_5' },
    false,
    ['encrypt']
  )
  const out = await crypto.subtle.encrypt({ name: 'RSAES-PKCS1-v1_5' }, key, data)
  return new Uint8Array(out)
}

/** AES-128-CBC 加密，key = iv = tempKey（16 字节），PKCS7 padding。 */
async function aesCbcEncrypt(plain: string, keyBytes: Uint8Array): Promise<Uint8Array> {
  const plainBytes = new TextEncoder().encode(plain)
  const blockSize = 16
  const padLen = blockSize - (plainBytes.length % blockSize)
  const padded = new Uint8Array(plainBytes.length + padLen)
  padded.set(plainBytes)
  padded.fill(padLen, plainBytes.length)
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes as unknown as ArrayBuffer,
    { name: 'AES-CBC' },
    false,
    ['encrypt']
  )
  const out = await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv: keyBytes as unknown as ArrayBuffer },
    key,
    padded
  )
  return new Uint8Array(out)
}

// ===== cosySession =====

export interface CosySession {
  machineId: string
  machineToken: string
  machineType: string
  tempKey: string
  cosyKey: string
  info: string
  uid: string
}

export interface CosyIdentity {
  name: string
  aid: string
  uid: string
  yxUid: string
  organizationId: string
  organizationName: string
  userType: string
  securityOauthToken: string
  refreshToken: string
}

async function newCosySession(id: CosyIdentity): Promise<CosySession> {
  const machineID = uuid()
  const seed = (uuid() + uuid()).slice(0, 50)
  const machineToken = base64UrlNoPad(new TextEncoder().encode(seed))
  const machineType = uuid().replace(/-/g, '').slice(0, 18)
  const tempKey = uuid().replace(/-/g, '').slice(0, 16)

  const cosyKeyBytes = await rsaEncrypt(new TextEncoder().encode(tempKey))
  const cosyKey = base64Std(cosyKeyBytes)

  const identityMap: Record<string, string> = {
    name: id.name,
    aid: id.aid,
    uid: id.uid,
    yx_uid: id.yxUid,
    organization_id: id.organizationId,
    organization_name: id.organizationName,
    user_type: id.userType,
    security_oauth_token: id.securityOauthToken,
    refresh_token: id.refreshToken,
  }
  const infoBytes = await aesCbcEncrypt(jsonSortedCompact(identityMap), new TextEncoder().encode(tempKey))
  const info = base64Std(infoBytes)

  return {
    machineId: machineID,
    machineToken,
    machineType,
    tempKey,
    cosyKey,
    info,
    uid: id.uid,
  }
}

// ===== 签名 =====

export interface CosyBearer {
  payloadB64: string
  date: string
  bearer: string
}

/** buildBearer：构造 Authorization 头。pathSig 为 URL path 去掉 /algo 前缀。 */
export function buildBearer(sess: CosySession, body: string, rawUrl: string): CosyBearer {
  const u = new URL(rawUrl)
  let pathSig = u.pathname
  if (pathSig.startsWith('/algo')) pathSig = pathSig.slice('/algo'.length)
  const payload: Record<string, string> = {
    cosyVersion: '0.1.43',
    ideVersion: '',
    info: sess.info,
    requestId: uuid(),
    version: 'v1',
  }
  const payloadB64 = utf8ToBase64(jsonSortedCompact(payload))
  const date = String(Math.floor(Date.now() / 1000))
  const sig = md5Hex(payloadB64 + '\n' + sess.cosyKey + '\n' + date + '\n' + body + '\n' + pathSig)
  return { payloadB64, date, bearer: 'Bearer COSY.' + payloadB64 + '.' + sig }
}

/** cosyHeaders：一次推理/模型请求的完整头集合。sse=true 时加 cache-control。 */
export function cosyHeaders(sess: CosySession, body: string, rawUrl: string, accept: string, sse: boolean): Record<string, string> {
  const { date, bearer } = buildBearer(sess, body, rawUrl)
  const h: Record<string, string> = {
    'cosy-data-policy': 'AGREE',
    'content-type': 'application/json',
    'cosy-machinetype': sess.machineType,
    'cosy-clienttype': '5',
    'cosy-date': date,
    'cosy-user': sess.uid,
    'cosy-key': sess.cosyKey,
    'accept': accept,
    'cosy-clientip': '169.254.198.161',
    'authorization': bearer,
    'accept-encoding': 'identity',
    'cosy-version': '0.1.43',
    'cosy-machineid': sess.machineId,
    'cosy-machinetoken': sess.machineToken,
    'login-version': 'v2',
    'user-agent': 'Go-http-client/2.0',
  }
  if (sse) h['cache-control'] = 'no-cache'
  return h
}

// ===== 会话缓存（cosy_session.go） =====

const cosySessionCache = new Map<string, { session: CosySession; accessToken: string }>()

/**
 * cosySessionFor：按 accessToken 缓存 cosySession，token 变化时自动重建。
 * uid 为空时退化为 accessToken 前 16 位（与 cosy_session.go 一致）。
 */
export async function cosySessionFor(
  accessToken: string,
  refreshToken: string,
  uid: string,
  nickname: string
): Promise<CosySession> {
  const key = uid || accessToken.slice(0, 16)
  const cached = cosySessionCache.get(key)
  if (cached && cached.accessToken === accessToken) return cached.session
  const session = await newCosySession({
    name: nickname,
    aid: uid,
    uid,
    yxUid: '',
    organizationId: '',
    organizationName: '',
    userType: 'personal_professional_trial',
    securityOauthToken: accessToken,
    refreshToken,
  })
  cosySessionCache.set(key, { session, accessToken })
  return session
}
