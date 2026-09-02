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

// ===== COSY 指纹常量（对齐 keirouter constants.go） =====
// 这些值不是任意的——上游签名校验会把它们与签名时的值比对。
const IDE_VERSION = '1.0.0'
const CLIENT_TYPE = '5'
const DATA_POLICY = 'disagree'
const LOGIN_VERSION = 'v2'
const MACHINE_OS = 'x86_64_windows'
const MACHINE_TYPE = '5'
const CLIENT_IP = '127.0.0.1'

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

/**
 * jsonObjectOrdered：按给定键序构造紧凑 JSON。
 * Go `json.Marshal` 对 struct 按字段声明顺序（而非字母序）序列化，
 * keirouter 的 userInfo/cosyPayload 依赖此顺序，故身份与 payload 需固定键序
 * 而非排序，确保与参考实现逐字节一致。
 */
function jsonObjectOrdered(entries: Array<[string, string]>): string {
  let out = '{'
  for (let i = 0; i < entries.length; i++) {
    if (i > 0) out += ','
    out += JSON.stringify(entries[i][0]) + ':' + JSON.stringify(entries[i][1])
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
  /** 用户真实 uid（来自态 UserStatus/deviceToken user_id），绝不能是合成值 */
  uid: string
  /** 上游信任的鉴权 token（access token） */
  securityOauthToken: string
  name: string
  email: string
}

/** newCosySession：精确移植 Go sign.go newCosySession（身份字段对齐 keirouter userInfo）。 */
async function newCosySession(id: CosyIdentity): Promise<CosySession> {
  const machineID = uuid()
  const seed = (uuid() + uuid()).slice(0, 50)
  const machineToken = base64UrlNoPad(new TextEncoder().encode(seed))
  const machineType = uuid().replace(/-/g, '').slice(0, 18)
  const tempKey = uuid().replace(/-/g, '').slice(0, 16)

  const cosyKeyBytes = rsaEncrypt(new TextEncoder().encode(tempKey))
  const cosyKey = base64Std(cosyKeyBytes)

  // 身份 JSON 与 keirouter userInfo 完全一致：{uid, security_oauth_token, name, aid, email}
  // aid 恒为空串。字段顺序用 jsonObjectOrdered 对齐 Go json.Marshal 的 struct 声明序。
  const identityJSON = jsonObjectOrdered([
    ['uid', id.uid],
    ['security_oauth_token', id.securityOauthToken],
    ['name', id.name],
    ['aid', ''],
    ['email', id.email],
  ])
  // 只记长度，绝不打印 identityJSON（含 refresh_token / oauth token）/ tempKey 原文
  console.log('[cosy:session] identityJSON len=', identityJSON.length)
  console.log('[cosy:session] tempKey len=', tempKey.length)
  const infoBytes = await aesCbcEncrypt(identityJSON, new TextEncoder().encode(tempKey))
  const info = base64Std(infoBytes)
  console.log('[cosy:session] info len=', info.length)
  console.log('[cosy:session] cosyKey len=', cosyKey.length)

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
  const payload = {
    // 对齐 keirouter cosyPayload struct 声明序：{version, requestId, info, cosyVersion, ideVersion}
    version: 'v1',
    requestId: uuid(),
    info: sess.info,
    cosyVersion: IDE_VERSION,
    ideVersion: '',
  }
  const payloadJSON = JSON.stringify(payload)
  const payloadB64 = utf8ToBase64(payloadJSON)
  const date = String(Math.floor(Date.now() / 1000))
  const sigInput = payloadB64 + '\n' + sess.cosyKey + '\n' + date + '\n' + body + '\n' + pathSig
  const sig = md5Hex(sigInput)
  // 只记长度与 md5，绝不打印 payloadJSON / body / cosyKey 原文
  console.log('[cosy:sign] payloadB64 len=', payloadB64.length)
  console.log('[cosy:sign] cosyKey len=', sess.cosyKey.length)
  console.log('[cosy:sign] date=', date)
  console.log('[cosy:sign] body len=', body.length)
  console.log('[cosy:sign] pathSig len=', pathSig.length)
  console.log('[cosy:sign] sigInput len=', sigInput.length, 'md5=', sig)
  return { payloadB64, date, bearer: 'Bearer COSY.' + payloadB64 + '.' + sig, sigInput }
}

/**
 * cosyHeaders：一次推理/模型请求的完整头集合，对齐 keirouter BuildCosyHeaders。
 * sse=true 时加 cache-control。accept 参数在参考实现中未使用，保留签名仅为兼容调用方。
 */
export function cosyHeaders(sess: CosySession, body: string, rawUrl: string, accept: string, sse: boolean): Record<string, string> {
  const { date, bearer } = buildBearer(sess, body, rawUrl)
  const u = new URL(rawUrl)
  let sigPath = u.pathname
  if (sigPath.startsWith('/algo')) sigPath = sigPath.slice('/algo'.length)
  // Cosy-Machinetoken 与 machineId 同值（与 keirouter MachineID 逻辑一致）
  const machineID = sess.machineId
  const h: Record<string, string> = {
    'Authorization': bearer,
    'Cosy-Key': sess.cosyKey,
    'Cosy-User': sess.uid,
    'Cosy-Date': date,
    'Cosy-Version': IDE_VERSION,
    'Cosy-Machineid': machineID,
    'Cosy-Machinetoken': machineID,
    'Cosy-Machinetype': sess.machineType,
    'Cosy-Machineos': MACHINE_OS,
    'Cosy-Clienttype': CLIENT_TYPE,
    'Cosy-Clientip': CLIENT_IP,
    'Cosy-Bodyhash': md5Hex(body),
    'Cosy-Bodylength': String(body.length),
    'Cosy-Sigpath': sigPath,
    'Cosy-Data-Policy': DATA_POLICY,
    'Cosy-Organization-Id': '',
    'Cosy-Organization-Tags': '',
    'Login-Version': LOGIN_VERSION,
    'X-Request-Id': uuid(),
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
  nickname: string,
  email = ''
): Promise<CosySession> {
  const key = uid || accessToken.slice(0, 16)
  const cached = cosySessionCache.get(key)
  if (cached && cached.accessToken === accessToken) return cached.session
  const session = await newCosySession({
    uid,
    securityOauthToken: accessToken,
    name: nickname,
    email,
  })
  cosySessionCache.set(key, { session, accessToken })
  return session
}
