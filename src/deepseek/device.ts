/**
 * deepseek/device.ts — 每账号的设备身份（移植自 simple-chat `internal/upstream/region.go`）。
 *
 * 上游风险服务按设备指纹给账号打分，因此这三条是协议级不变式，不是可选项：
 *  1) device_id 必须是**该 App 的真实构造**，不能是随手一个 UUID：
 *     base64( AES-128-CBC/PKCS7( ANDROID_ID + "_" + Build.BRAND,
 *                                key = MD5(packageName), IV = 0 ) )
 *     （App 侧 nf3.java, com.deepseek.chat）。UUID 形状是「伪造客户端」的明显特征。
 *  2) device_id 按账号**确定性铸造**（同一账号永远同一 id），且**绝不跨账号复用**——
 *     风控会做跨账号设备关联。
 *  3) x-rangers-id（APM install id）同样按账号确定性派生，形状是 UUID。
 *
 * 与 Go 版的差异：WebCrypto 的摘要/AES 都是异步的，所以本模块返回 Promise。
 */

import { base64Encode, fromHex, toHex, utf8 } from './bytes'

/** App 包名（device_id 铸造的密钥来源）。 */
export const APP_PACKAGE_NAME = 'com.deepseek.chat'

/** App 上报的设备品牌（ANDROID_ID 的拼接后缀）。 */
export const APP_DEVICE_BRAND = 'google'

/**
 * MD5("com.deepseek.chat") = 7614e48627b7380b17b386d382d1b2ef。
 * 写成常量而不是运行时算 MD5：Workers 的 WebCrypto 不提供 MD5，而这个值只依赖
 * 一个不会变的包名。改动前请重算：`node -e "…md5 com.deepseek.chat"`。
 */
const APP_DEVICE_KEY = fromHex('7614e48627b7380b17b386d382d1b2ef')

/**
 * 设备 id / rangers id 的 UUIDv5 命名空间（simple-chat 自定，非标准命名空间）：
 * a5c3f7e1-2b4d-4f6a-8c91-0d3e5f7a9b2c。
 * 用自定命名空间是为了让本部署铸造的 UUIDv5 不会与标准命名空间下的产物偶然撞车。
 */
const DEVICE_ID_NAMESPACE = fromHex('a5c3f7e12b4d4f6a8c910d3e5f7a9b2c')

/** 空身份账号（测试/单账号场景）的最后兜底身份。 */
const DEFAULT_IDENTITY = 'simple-chat-default'

export interface AccountIdentity {
  mobile?: string
  email?: string
  /** 显式 device_id（例如浏览器收割的 Shumei SMSdk id）会**原样**使用。 */
  deviceId?: string
  /** "" = 安卓（默认），"web" = 浏览器收割的 Shumei 指纹。 */
  channel?: string
}

/** 一个账号在上游线上呈现的设备身份。 */
export interface DeviceProfile {
  /** 铸造后的 App 形状 device_id（web 频道下这是 Shumei id，只进登录体）。 */
  deviceId: string
  /** x-rangers-id（APM install id，UUID 形状）。 */
  rangersId: string
  /** x-device-id 头：安卓=deviceId；web=另一个铸造 UUID（对齐浏览器行为）。 */
  headerDeviceId: string
  /** 归一化后的频道："" 或 "web"。 */
  channel: string
}

/** 账号主身份：手机号优先，其次邮箱。 */
export function accountIdentity(a: Pick<AccountIdentity, 'mobile' | 'email'>): string {
  const mobile = (a.mobile ?? '').trim()
  if (mobile) return mobile
  return (a.email ?? '').trim()
}

/** 登录体的 "os" 值：web 频道发 "web"，其余一律 "android"。 */
export function channelOS(channel: string): string {
  return channel.trim() === 'web' ? 'web' : 'android'
}

/** 规范化频道值；不支持的频道返回 null（调用方据此在加载期拒绝账号）。 */
export function normalizeChannel(raw: string | undefined): string | null {
  const v = (raw ?? '').trim()
  return v === '' || v === 'web' ? v : null
}

/** SHA-1 / SHA-256 摘要（WebCrypto）。 */
async function digest(alg: 'SHA-1' | 'SHA-256', data: Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest(alg, data as unknown as ArrayBufferView)
  return new Uint8Array(buf)
}

/** RFC 4122 v5（SHA-1 名字型）UUID，规范 8-4-4-4-12 小写。 */
export async function uuidV5(namespace: Uint8Array, name: string): Promise<string> {
  const nameBytes = utf8(name)
  const input = new Uint8Array(namespace.length + nameBytes.length)
  input.set(namespace)
  input.set(nameBytes, namespace.length)
  const h = await digest('SHA-1', input)
  const u = h.slice(0, 16)
  u[6] = (u[6] & 0x0f) | 0x50 // version 5
  u[8] = (u[8] & 0x3f) | 0x80 // RFC 4122 variant
  const hex = toHex(u)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** 从账号身份派生稳定的 16 位十六进制 ANDROID_ID（形状同 Settings.Secure）。 */
export async function syntheticAndroidId(identity: string): Promise<string> {
  const h = await digest('SHA-256', utf8(`simple-chat/device-id/${identity}`))
  return toHex(h.slice(0, 8))
}

/** 复刻 App 的 device_id 铸造：AES-128-CBC/PKCS7 → Base64。 */
export async function mintAppDeviceId(androidId: string, brand = APP_DEVICE_BRAND): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    APP_DEVICE_KEY as unknown as ArrayBufferView,
    { name: 'AES-CBC' },
    false,
    ['encrypt'],
  )
  const plain = utf8(`${androidId}_${brand}`)
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv: new Uint8Array(16) },
    key,
    plain as unknown as ArrayBufferView,
  )
  return base64Encode(new Uint8Array(cipher))
}

/**
 * 账号的 device_id：显式值原样返回，否则按身份确定性铸造。
 * 注意「确定性」是保证，写回账号表只是文件格式上的整洁。
 */
export async function resolveDeviceId(a: AccountIdentity): Promise<string> {
  const explicit = (a.deviceId ?? '').trim()
  if (explicit) return explicit
  const identity = accountIdentity(a) || DEFAULT_IDENTITY
  return mintAppDeviceId(await syntheticAndroidId(identity))
}

/** 解析账号的完整设备身份（登录体 device_id + 两个头）。 */
export async function resolveDeviceProfile(a: AccountIdentity): Promise<DeviceProfile> {
  const identity = accountIdentity(a) || DEFAULT_IDENTITY
  const deviceId = await resolveDeviceId(a)
  const channel = normalizeChannel(a.channel) ?? ''
  if (channel === 'web') {
    return {
      deviceId,
      rangersId: await uuidV5(DEVICE_ID_NAMESPACE, `simple-chat/rangers-id/${identity}`),
      headerDeviceId: await uuidV5(DEVICE_ID_NAMESPACE, `simple-chat/web-header-device-id/${identity}`),
      channel,
    }
  }
  return {
    deviceId,
    rangersId: await uuidV5(DEVICE_ID_NAMESPACE, `simple-chat/rangers-id/${identity}`),
    headerDeviceId: deviceId,
    channel: '',
  }
}
