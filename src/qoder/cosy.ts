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
function jsonSortedCompact(m: Record<string, string>): string {
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

// ===== 纯 JS RSA-PKCS1v1.5（Workers 未注册 RSAES-PKCS1-v1_5 算法，改用 BigInt） =====

interface TLVNode { tag: number; value: Uint8Array; next: number }
/** 简易 DER TLV 读取。 */
function readTLV(buf: Uint8Array, pos: number): TLVNode {
  let p = pos
  const tag = buf[p++]
  let len = buf[p++]
  if (len & 0x80) {
    const count = len & 0x7f
    len = 0
    for (let i = 0; i < count; i++) len = len * 256 + buf[p++]
  }
  return { tag, value: buf.slice(p, p + len), next: p + len }
}

function bytesToBigInt(b: Uint8Array): bigint {
  let x = 0n
  let start = 0
  if (b[0] === 0) start = 1
  for (let i = start; i < b.length; i++) x = (x << 8n) | BigInt(b[i])
  return x
}

function bigIntToBytes(x: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length)
  let v = x
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n
  base = base % mod
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod
    base = (base * base) % mod
    exp >>= 1n
  }
  return result
}

/** 从 SPKI 解析 RSA 公钥 (n, e)。 */
function parseRSAPublicKey(bytes: Uint8Array): { n: bigint; e: bigint } {
  const top = readTLV(bytes, 0) // SEQUENCE
  const alg = readTLV(top.value, 0) // SEQUENCE { OID, NULL }
  const bitStr = readTLV(top.value, alg.next) // BIT STRING
  const inner = bitStr.value.slice(1) // 跳过 unused-bits
  const seq = readTLV(inner, 0) // SEQUENCE（RSAPublicKey: { INTEGER n, INTEGER e }）
  const nTlv = readTLV(seq.value, 0) // INTEGER n
  const eTlv = readTLV(seq.value, nTlv.next) // INTEGER e
  return { n: bytesToBigInt(nTlv.value), e: bytesToBigInt(eTlv.value) }
}

const SERVER_RSA_PUB = parseRSAPublicKey(pemToBytes(SERVER_PUB_KEY_PEM))

/** RSA-1024 PKCS1 v1.5 (type 2) 加密。data 为首部 0x00 0x02 对齐后的消息。 */
function rsaEncrypt(data: Uint8Array): Uint8Array {
  const k = 128 // 1024-bit → 128 字节输出
  const padLen = k - data.length - 3 // 0x00 0x02 + PS(nonzero) + 0x00
  if (padLen < 8) throw new Error('RSA: message too long')
  const em = new Uint8Array(k)
  em[0] = 0x00
  em[1] = 0x02
  const rnd = crypto.getRandomValues(new Uint8Array(padLen))
  for (let i = 0; i < padLen; i++) em[2 + i] = rnd[i] === 0 ? 1 : rnd[i] // PS 需全部非零
  em[2 + padLen] = 0x00
  em.set(data, 3 + padLen)

  const m = bytesToBigInt(em) // em[0]=0x00 保证 m < 2^1016 < n
  const c = modPow(m, SERVER_RSA_PUB.e, SERVER_RSA_PUB.n)
  return bigIntToBytes(c, k)
}

/** AES-128-CBC 加密，key = iv = tempKey（16 字节）。
 *  Web Crypto 的 AES-CBC 会自动 PKCS7 padding，不要手动 pad。 */
async function aesCbcEncrypt(plain: string, keyBytes: Uint8Array): Promise<Uint8Array> {
  const plainBytes = new TextEncoder().encode(plain)
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
    plainBytes
  )
  return new Uint8Array(out)
}

// ===== cosySession（cosy_session.go + sign.go newCosySession） =====

export interface CosySession {
  machineId: string
  machineToken: string
  machineType: string
  tempKey: string
  cosyKey: string
  info: string
  uid: string
  identityJSON: string
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

/** newCosySession：精确移植 Go sign.go newCosySession。 */
async function newCosySession(id: CosyIdentity): Promise<CosySession> {
  const machineID = uuid()
  const seed = (uuid() + uuid()).slice(0, 50)
  const machineToken = base64UrlNoPad(new TextEncoder().encode(seed))
  const machineType = uuid().replace(/-/g, '').slice(0, 18)
  const tempKey = uuid().replace(/-/g, '').slice(0, 16)

  const cosyKeyBytes = rsaEncrypt(new TextEncoder().encode(tempKey))
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
  const identityJSON = jsonSortedCompact(identityMap)
  console.log('[cosy:session] identityJSON=', identityJSON.substring(0, 200))
  console.log('[cosy:session] identityJSON len=', identityJSON.length)
  console.log('[cosy:session] tempKey=', tempKey, 'len=', tempKey.length)
  const infoBytes = await aesCbcEncrypt(identityJSON, new TextEncoder().encode(tempKey))
  const info = base64Std(infoBytes)
  console.log('[cosy:session] info len=', info.length, 'info head=', info.substring(0, 40))
  console.log('[cosy:session] cosyKey len=', cosyKey.length, 'cosyKey head=', cosyKey.substring(0, 40))

  return {
    machineId: machineID,
    machineToken,
    machineType,
    tempKey,
    cosyKey,
    info,
    uid: id.uid,
    identityJSON,
  }
}

// ===== 签名（sign.go buildBearer + headers） =====

export interface CosyBearer {
  payloadB64: string
  date: string
  bearer: string
  sigInput: string
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
  const payloadJSON = jsonSortedCompact(payload)
  const payloadB64 = utf8ToBase64(payloadJSON)
  const date = String(Math.floor(Date.now() / 1000))
  const sigInput = payloadB64 + '\n' + sess.cosyKey + '\n' + date + '\n' + body + '\n' + pathSig
  const sig = md5Hex(sigInput)
  console.log('[cosy:sign] payloadJSON=', payloadJSON.substring(0, 200))
  console.log('[cosy:sign] payloadB64 len=', payloadB64.length, 'head=', payloadB64.substring(0, 40))
  console.log('[cosy:sign] cosyKey len=', sess.cosyKey.length, 'head=', sess.cosyKey.substring(0, 40))
  console.log('[cosy:sign] date=', date)
  console.log('[cosy:sign] body len=', body.length, 'body head=', body.substring(0, 100))
  console.log('[cosy:sign] pathSig=', pathSig)
  console.log('[cosy:sign] sigInput len=', sigInput.length, 'md5=', sig)
  return { payloadB64, date, bearer: 'Bearer COSY.' + payloadB64 + '.' + sig, sigInput }
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
