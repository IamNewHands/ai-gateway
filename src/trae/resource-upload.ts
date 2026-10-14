/**
 * resource-upload.ts — TRAE **资源上传**：把图片字节换成 `trae-res://` URI。
 *
 * ## 为什么需要这一层
 *
 * Remote 的 `initial_message.query` 是「JSON 块数组的字符串」，图片走独立的 `attachment`
 * 块，其 `uri` 指向 Trae 自己的对象存储（火山 TOS）——**不是** data URI。所以图片必须
 * 先上传、拿到一个**已存在**的对象名，才能在 query 里被引用。三步全部照官方 web 客户端
 * 的抓包实证（`POST /api/remote/v1/chat_sessions` 的真实请求体）：
 *
 *   ① `POST {IDE}/get_resource_upload_url`  申请上传位 → 短期写凭据 `auth` + 目标 `store_uri`
 *   ② `PUT  https://{upload_host}/{store_uri}` 上传字节（`Authorization: <auth>` **原样**，无 Bearer）
 *   ③ `trae-res://{biz_type}/{store_uri}`   拼进 `attachment.uri`
 *
 * 注意 ① 的端点在 **`/api/ide/v1/`**（IDE API），**不是** `/api/remote/v1/`；两者同源不同路径。
 *
 * ## 凭据边界（硬约束，改动前先读完）
 *
 * `auth` 是约 24h 有效的**写凭据**（形如 `<accessKeyId>:version:v2:<JWT>`），`session_key`
 * 是同一次响应里的会话密钥。两者**绝不进日志、绝不进错误信息、绝不进测试快照**。
 * 落实方式不是「记得别打」，而是三条结构性约束：
 *
 *  1. `session_key` 我们**根本不读**（官方上传只用 `auth`）—— 从源头没有它可泄；
 *  2. 响应体在进错误信息前一律过 `redactCredentials()`；
 *  3. 本文件抛出的每个 `Error` 都满足上述不变量，因此**调用方可以直接把 `message` 写进
 *     日志**（`remote.ts` 的 warn 日志与 `trace.imageUploadError` 就依赖这条）。
 *
 * ## 唯一没有抓包确认的地方
 *
 * ① 的**请求头**。body 与 response 都是实证的，头部只能推断：该端点在 IDE API 命名空间下，
 * 所以复用 IDE 客户端那一套（`upstream.ts` 的 `soloHeaders`，等价于源侧 `trae_client.py`
 * 的 `build_headers`）。因此失败时错误信息里**必须**带上状态码与响应体前 200 字符，
 * 否则「是不是鉴权头不对」永远只能靠猜。
 */
import type { TraeQueryAttachment } from './payload'
import type { TraeAccount } from './types'
import { soloHeaders } from './upstream'

/**
 * ① 的默认基址（IDE API）。
 *
 * 刻意**不**放进 `constants.ts` 的 `TRAE_REMOTE_CONSTANTS`：那是 Remote 传输的常量表
 *（`/api/remote/v1`），而这里是 IDE 命名空间，混在一起会让「Remote 基址」这个概念失去边界。
 */
export const TRAE_IDE_API_HOST = 'https://trae-api-cn.mchost.guru/api/ide/v1'

/** ① 的路径（挂在 IDE 基址下）。 */
export const TRAE_RESOURCE_UPLOAD_URL_PATH = '/get_resource_upload_url'

/** 默认 `biz_type`：Remote 的图片资源。同一个值既进 ① 的 body，也进 ③ 的 URI 前缀。 */
export const TRAE_RESOURCE_BIZ_TYPE = 'remote_resource'

/** ① / ② 的单次请求超时。上传是写请求，卡住必须干净失败，不能把整轮对话拖死。 */
export const TRAE_RESOURCE_TIMEOUT_MS = 60_000

// ===== CRC32（② 的 Content-CRC32 头） =====

/**
 * 标准 CRC32 查表（IEEE 802.3，反射多项式 `0xEDB88320`）。
 *
 * 必须是**标准** CRC32：上游用它做整块校验，换成 CRC32C/变体不会报错，只会让上传静默失败。
 * 表只算一次（模块级），单次校验是 O(n) 的整数运算，无需 WebCrypto（那是异步的，用不上）。
 */
const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

/**
 * 标准 CRC32 → **8 位小写 hex**。
 *
 * 大小写与位数都是协议要求（`Content-CRC32` 头）：少补前导零会让短内容的上传被拒。
 * 纯函数，无副作用，可在任何运行时（Workers / Node）直接调用。
 */
export function crc32Hex(bytes: Uint8Array): string {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    crc = (CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)) >>> 0
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0')
}

// ===== 凭据脱敏 =====

/**
 * 抹掉文本里的写凭据，供「把上游响应打进错误信息」这一条路使用。
 *
 * 为什么需要：失败时**必须**能看到上游说了什么（① 的头部没抓包确认，不打出响应体就只能猜），
 * 但 2xx 之外的响应体里也可能回显 `auth` / `session_key`。两条约束同时成立只有一条路：
 * 先脱敏再截断。
 *
 * 覆盖三种形态：JSON 键值（`"auth":"…"`）、`Authorization:` 头行、以及 `auth` 的裸值
 * 形态（`<accessKeyId>:version:v2:<JWT>`）——最后一条是兜底，因为凭据可能被上游塞进
 * 任意文本位置而不是某个固定键。
 */
export function redactCredentials(text: string): string {
  if (!text) return ''
  return text
    .replace(
      /("(?:auth|session_key|sessionKey|accessKeyId|access_key_id|secretAccessKey|security_token|sessionToken)"\s*:\s*")[^"]*(")/gi,
      '$1[redacted]$2'
    )
    .replace(/(Authorization["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[redacted]')
    .replace(/[A-Za-z0-9_\-]+:version:v2:[A-Za-z0-9_\-.]+/g, '[redacted-auth]')
}

// ===== ① 申请上传位 =====

/** ① 的产物：上传位 + 写凭据。**不要把这个对象整体打进日志**（`auth` 在里面）。 */
export interface ResourceUploadTicket {
  /** 目标对象名，形如 `tos-cn-i-aiagcest/cn/<uid>/remote_resource/<uuid>.trae` */
  storeUri: string
  /** 短期写凭据。**绝不进日志/错误信息/快照。** */
  auth: string
  /** 上游广告的上传主机（实测与浏览器真正发的主机基域不同，见 `uploadResourceToTrae`） */
  uploadHosts: string[]
  /** 我们生成的 `<uuid>.trae`（只用于排障，不是凭据） */
  target: string
}

/**
 * 由 Remote 基址推出 ① 的基址。
 *
 * 调用方（`remote.ts`）手上的 `baseUrl` 是 **Remote** 基址，可能已经带 `/api/remote/v1`
 * （`normalizeTraeRemoteBase` 补的）。① 挂在 IDE 命名空间下，所以要**换路径而不是拼路径**
 * ——直接拼会得到 `…/api/remote/v1/api/ide/v1/…`，必然 404，而 404 在本仓被归类成
 * `not_found`（短冷却换号），排查时会一路怀疑账号。
 */
export function resourceUploadBase(baseUrl?: string | null): string {
  const text = String(baseUrl ?? '').trim().replace(/\/+$/, '')
  if (text === '') return TRAE_IDE_API_HOST
  const remote = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]+)\/api\/remote\//.exec(text)
  if (remote) return `${remote[1]}/api/ide/v1`
  if (/\/api\/ide\//i.test(text)) return text
  const lowered = text.toLowerCase()
  if (
    lowered.includes('mchost.guru')
    || lowered.includes('core-normal.trae.cn')
    || lowered.includes('trae.ai')
  ) {
    return `${text}/api/ide/v1`
  }
  // 自定义中转主机：不知道它的路径约定，原样保留（与 normalizeTraeRemoteBase 同口径）。
  return text
}

/**
 * ①：申请上传位。
 *
 * `targets` 里的 uuid **由我们生成**（不是上游给的），文件名形如 `<uuid>.trae` —— 这是
 * 官方客户端的实际形态，也是 ③ 里 `store_uri` 末段与 `target` 必须一致的原因。
 *
 * 失败一律抛错（图片少一张总比整轮对话挂掉强，由调用方降级）；错误信息**不含** `auth` /
 * `session_key`，含状态码与脱敏后的响应体前 200 字符。
 *
 * `opts.filename` **只用于排障文案**（哪个文件申请失败），不参与协议：对象名固定是
 * `<uuid>.trae`，人类文件名是在 ③ 的 `attachment.filename` 里带上去的。
 */
export async function fetchResourceUploadUrl(
  account: TraeAccount,
  opts?: { baseUrl?: string | null; filename?: string }
): Promise<ResourceUploadTicket> {
  const base = resourceUploadBase(opts?.baseUrl)
  const target = `${crypto.randomUUID()}.trae`
  // 排障定位（哪张图、哪个账号）；`uid` 不是凭据，本仓其它日志也照打。
  const where = `uid=${account?.uid || '-'} file=${opts?.filename || '-'}`
  // ① 的头部是**推断**的（见文件头「唯一没有抓包确认的地方」）：端点在 IDE API 下，
  // 就复用 IDE 客户端那一套。`soloHeaders(account, false)` → `Accept: application/json`
  //（这是普通 JSON 往返，不是 SSE）。
  const headers = soloHeaders(account, false)
  let resp: Response
  try {
    resp = await fetch(`${base}${TRAE_RESOURCE_UPLOAD_URL_PATH}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ targets: [target], biz_type: TRAE_RESOURCE_BIZ_TYPE }),
      signal: AbortSignal.timeout(TRAE_RESOURCE_TIMEOUT_MS),
    })
  } catch (e) {
    // 网络层错误信息里可能带 URL（`store_uri` 不是凭据，可以留）；头部不会出现在这里。
    throw new Error(`Trae resource upload url transport error (${where}): ${(e as Error).message || String(e)}`)
  }

  const text = await resp.text().catch(() => '')
  if (!resp.ok) {
    // 状态码 + 脱敏响应体：这是判断「是不是鉴权头不对」的唯一线索。
    throw new Error(`Trae resource upload url [${resp.status}] (${where}): ${redactCredentials(text).slice(0, 200)}`)
  }

  let parsed: Record<string, any>
  try {
    const obj = JSON.parse(text)
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('not an object')
    parsed = obj as Record<string, any>
  } catch {
    throw new Error(`Trae resource upload url returned non-JSON (${where}): ${redactCredentials(text).slice(0, 200)}`)
  }

  const storeInfos = Array.isArray(parsed['store_infos']) ? (parsed['store_infos'] as unknown[]) : []
  const first = storeInfos.find(
    (x) => Boolean(x) && typeof x === 'object' && !Array.isArray(x)
  ) as Record<string, any> | undefined
  const auth = first ? String(first['auth'] ?? '') : ''
  const storeUri = first ? String(first['store_uri'] ?? '') : ''
  if (!auth || !storeUri) {
    // 刻意**不读** `session_key`：上传只用 `auth`，读了它就多一个泄露面。
    throw new Error(
      `Trae resource upload url missing auth/store_uri (${where}): ${redactCredentials(text).slice(0, 200)}`
    )
  }

  const uploadHosts = (Array.isArray(parsed['upload_hosts']) ? (parsed['upload_hosts'] as unknown[]) : [])
    .map((h) => String(h ?? '').trim())
    .filter(Boolean)

  return { storeUri, auth, uploadHosts, target }
}

// ===== ② 上传字节 =====

/**
 * 上传主机的**基域映射**（观测值优先）。
 *
 * **这是实测踩到的坑**：① `get_resource_upload_url` 广告的是
 * `tos-d-x-lf.snssdk.com`，而官方 web 客户端真正发的是 `tos-d-x-lf.douyin.com`
 * —— 首个子域标签相同、基域不同。规则照抄实证：「首个子域标签不变，基域换成
 * `douyin.com`」。
 *
 * ⚠️ 它产出的主机是**候选链的第一位**（不是「失败后才用的回退值」）：
 * 照广告打 `snssdk.com` 会拿到 `400 InvalidFileType`，而同一份合法 PNG
 *（`bytes=21674 first8=89504e470d0a1a0a`）打到 `douyin.com` 是 200。
 *
 * 返回 `null` = 没有可换的基域（已经是 `douyin.com`，或主机名没有点）。
 */
export function douyinFallbackHost(host: string): string | null {
  const h = String(host ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '')
  const dot = h.indexOf('.')
  if (dot <= 0 || dot === h.length - 1) return null
  const first = h.slice(0, dot)
  const rest = h.slice(dot + 1)
  if (rest.toLowerCase() === 'douyin.com') return null
  return `${first}.douyin.com`
}

/** 上传 URL：`https://<host>/<store_uri>`（`store_uri` 是相对对象名，不带前导斜杠）。 */
function uploadUrlFor(host: string, storeUri: string): string {
  const h = String(host ?? '').trim().replace(/\/+$/, '')
  const base = /^https?:\/\//i.test(h) ? h : `https://${h}`
  return `${base}/${String(storeUri ?? '').replace(/^\/+/, '')}`
}

/** 单次 PUT 的结果（`status` 与 body 都要，成功判据要两者一起看）。 */
interface PutResult {
  status: number
  ok: boolean
  body: string
}

/**
 * 上传**变体**名（同一次部署内按顺序全试，成功即停）。
 *
 * 为什么会有「变体」这一维：2026-10-15 真机把除「类型」以外的维度全排除了 ——
 * ① 鉴权 OK、`Authorization` OK、字节是真 PNG（`bytes=21674 first8=89504e470d0a1a0a`）、
 * URL 形态与抓包一致、两台主机（`douyin` / `snssdk`）回**同一个**
 * `400 InvalidFileType`、CRC32 算法已用标准向量 `cbf43926` 验过。
 * 而上游报错原文就是 `invalid file type` —— 我们唯一在声明的「类型」就是 `Content-Type`。
 *
 * 抓包里官方发的是 `application/octet-stream`，但那可能只是 JWT 里
 * `mime_list: ["application/octet-stream"]` 的默认占位；真正被校验的可能是**实际图片 mime**。
 * 与其再猜一轮，不如一次部署把候选跑完，让日志直接说哪个赢（命中变体见
 * `ResourceUploadTrace` / `ImageUploadOutcome.variantSummary`）。
 */
export type ResourceUploadVariant = 'octet+crc' | 'mime+crc' | 'mime-nocrc'

/** 一个候选变体：只有 `Content-Type` 与「带不带 Content-CRC32」在变。 */
interface PutVariant {
  name: ResourceUploadVariant
  contentType: string
  includeCrc: boolean
}

/**
 * 硬上限：一次上传最多发几个 PUT。
 *
 * 3 变体 × 2 主机 = 6 正好够（真机就是 2 台主机）。有第三台时会被截断，那时
 * `trace.exhausted = true` 且错误信息里带 `exhausted=true` —— **绝不把「没试完」说成
 * 「都试过了」**，否则实验结论会假阴性。
 */
export const TRAE_RESOURCE_MAX_PUTS = 6

/**
 * 魔术字节 → 真实图片 mime；嗅不出返回 `''`。
 *
 * 返回空串时调用方**必须跳过** mime 变体：瞎填一个 `Content-Type` 只会把
 * `InvalidFileType` 换成另一种失败，还会污染实验结论（分不清是「mime 猜错了」还是
 * 「mime 这条路本来就不通」）。
 */
export function imageMimeFromBytes(bytes: Uint8Array): string {
  switch (sniffImageExt(bytes)) {
    case 'png': return 'image/png'
    case 'jpg': return 'image/jpeg'
    case 'gif': return 'image/gif'
    case 'webp': return 'image/webp'
    default: return ''
  }
}

/**
 * 变体阶梯：**顺序是契约**。
 *
 *  1. `octet+crc` —— 现状（抓包里官方发的形态）。放第一位是为了**不回归**：万一真机
 *     其实已经能过，就不该白打后面两枪；
 *  2. `mime+crc` —— 真实 mime + CRC（假设「被校验的是实际图片类型」）；
 *  3. `mime-nocrc` —— 真实 mime、**不带** CRC（TOS 可能对「未知 Content-Type + CRC」
 *     这个组合做了校验，去掉 CRC 是最后一个正交变量）。
 *
 * 嗅不出 mime 时只留 1（见 `imageMimeFromBytes`）。
 */
function uploadVariants(mime: string): PutVariant[] {
  const ladder: PutVariant[] = [
    { name: 'octet+crc', contentType: 'application/octet-stream', includeCrc: true },
  ]
  if (mime) {
    ladder.push({ name: 'mime+crc', contentType: mime, includeCrc: true })
    ladder.push({ name: 'mime-nocrc', contentType: mime, includeCrc: false })
  }
  return ladder
}

/**
 * 发一次 PUT。**网络层失败会抛出**，由调用方决定要不要换下一个 (变体, 主机) 组合。
 *
 * 变体之间只有 `Content-Type` / `Content-CRC32` 不同；`Authorization` / `Accept` /
 * `Origin` / `Referer` 四个头**恒定** —— 实验只允许一个变量在动，否则赢了也不知道赢在哪。
 */
async function putObject(
  url: string,
  auth: string,
  bytes: Uint8Array,
  crc: string,
  variant: PutVariant
): Promise<PutResult> {
  const headers: Record<string, string> = {
    // 实证：`auth` **原样**进 Authorization，没有 Bearer / 其他前缀。
    Authorization: auth,
    'Content-Type': variant.contentType,
    // 以下三个照抄官方客户端那次成功的 PUT（**不是**发明）。TOS 侧可能对
    // 跨站直传做来源校验，缺了它们可能以 400/InvalidFileType 的形式被拒。
    Accept: '*/*',
    Origin: 'https://work.trae.cn',
    Referer: 'https://work.trae.cn/',
  }
  if (variant.includeCrc) headers['Content-CRC32'] = crc
  const resp = await fetch(url, {
    method: 'PUT',
    headers,
    body: bytes,
    signal: AbortSignal.timeout(TRAE_RESOURCE_TIMEOUT_MS),
  })
  const body = await resp.text().catch(() => '')
  return { status: resp.status, ok: resp.ok, body }
}

/** `uploadResourceToTrae` 回填的诊断（**命中的是哪个变体** —— 下次收敛到只用它的唯一依据）。 */
export interface ResourceUploadTrace {
  /** 命中的变体名（**只有成功时才有值**） */
  variant?: ResourceUploadVariant
  /** 实际发出的 PUT 次数（含失败的那些） */
  attempts?: number
  /** `true` = 撞到硬上限提前停：候选**没穷尽**，别据此下「都不行」的结论 */
  exhausted?: boolean
}

/**
 * ②：上传字节，返回 ③ 的 `trae-res://…` URI。
 *
 * ## 成功判据（两条都要，顺序固定）
 *  - HTTP 非 2xx → 失败（响应体脱敏后进错误信息）；
 *  - 2xx 且响应体里有数字 `success` → **只有 `success === 0` 才算成功**
 *    （实测语义是 0 = 成功，非 0 = 失败）；响应体解析不出 `success` 时按 2xx 认成功
 *    （中转/代理可能吃掉 body，此时以 HTTP 状态为准）。
 *
 * ## 候选阶梯：**外层变体、内层主机**，成功即停
 *
 * 主机维度已被真机证明无关（两台回同一个 400），所以放**内层**：同一个变体先把两台主机
 * 走完，再换下一个变体 —— 这样「哪个变体赢」在日志里是单调可读的。反过来（外层主机）会让
 * 同一变体的两条结果被别的变体隔开，实验结论读不出来。
 *
 * 顺序（`uploadVariants`）与上限（`TRAE_RESOURCE_MAX_PUTS`）都是**契约**。撞到上限时
 * `trace.exhausted = true`、错误信息里也带 `exhausted=true`。
 *
 * ## 为什么任一组合失败都要继续（而不是只回退网络错误）
 *
 * 2026-10-14 真机推翻的旧判断：广告主机 `tos-d-x-lf.snssdk.com` 回的是 **HTTP 400 业务
 * 错误**（`InvalidFileType`），不是连接失败 —— 只认网络错误就会一直卡在第一个组合上，
 * 永远试不到后面真正能用的那个。聚合错误会把每个组合的原因都列出来，所以「凭据错」
 *（所有组合同状态码）与「组合不对」（有 200）仍然可区分。
 *
 * 多打几枪不会产生孤儿对象：所有组合用的是**同一个 `store_uri`**，后一枪是覆盖写。
 */
export async function uploadResourceToTrae(
  account: TraeAccount,
  ticket: ResourceUploadTicket,
  bytes: Uint8Array,
  filename: string,
  opts?: { baseUrl?: string | null; bizType?: string; trace?: ResourceUploadTrace }
): Promise<string> {
  // 说明：上传的凭据是 ① 下发的短期写凭据 `auth`，**不是** Cloud-IDE-JWT。
  // `account` / `filename` 在这里只用于**排障定位**（哪张图、哪个账号），不参与协议。
  const bizType = String(opts?.bizType ?? '').trim() || TRAE_RESOURCE_BIZ_TYPE
  const storeUri = String(ticket?.storeUri ?? '').trim()
  const auth = String(ticket?.auth ?? '').trim()
  if (!storeUri || !auth) throw new Error('Trae resource upload: ticket is missing store_uri/auth')

  // 排障前缀：`uid` 不是凭据（本仓其它日志也照打），`filename` 定位是哪张图。
  const where = `uid=${account?.uid || '-'} file=${filename || '-'}`

  const hosts = (ticket.uploadHosts ?? []).map((h) => String(h ?? '').trim()).filter(Boolean)
  const primary = hosts[0]
  if (!primary) throw new Error(`Trae resource upload: upstream returned no upload_hosts (${where})`)

  /**
   * 候选主机顺序：**观测到能用的放最前**。
   *
   * 实测（2026-10-14）：`get_resource_upload_url` 广告的是 `tos-d-x-lf.snssdk.com`，
   * 而官方 web 客户端真正发的是 `tos-d-x-lf.douyin.com`（子域相同、基域不同）。
   * 照广告打 `snssdk.com` 时上游回 `400 InvalidFileType`，而字节已验证是合法 PNG
   *（`bytes=21674 first8=89504e470d0a1a0a`）—— 当时据此判定「被拒的是主机」。
   *
   * ⚠️ 2026-10-15 更正：两台主机回的是**同一个** 400，主机维度已被排除。这里保留候选链
   * 只是为了「万一某天只有一台通」时还能自愈，不再是本轮的重点（重点在变体阶梯）。
   */
  const candidates: string[] = []
  const observed = douyinFallbackHost(primary)
  if (observed && observed !== primary) candidates.push(observed)
  candidates.push(primary)
  for (const h of hosts.slice(1)) if (!candidates.includes(h)) candidates.push(h)

  const crc = crc32Hex(bytes)
  const mime = imageMimeFromBytes(bytes)
  const ladder = uploadVariants(mime)
  // 先摊平成 (变体, 主机) 组合列表，再按上限截断：这样「未穷尽」是**算出来的**
  //（combos.length > 实际试过的数量），而不是靠循环里数数猜的。
  const combos: Array<{ variant: PutVariant; host: string }> = []
  for (const variant of ladder) for (const host of candidates) combos.push({ variant, host })
  const planned = combos.slice(0, TRAE_RESOURCE_MAX_PUTS)
  const exhausted = combos.length > planned.length

  const failures: string[] = []
  let attempts = 0
  for (const { variant, host } of planned) {
    attempts++
    const url = uploadUrlFor(host, storeUri)
    let result: PutResult
    try {
      result = await putObject(url, auth, bytes, crc, variant)
    } catch (e) {
      failures.push(
        `variant=${variant.name} host=${host} transport: ${(e as Error).message || String(e)}`
      )
      continue
    }
    // **任何非 2xx 都要换下一个组合**（理由见函数头注释）。
    if (!result.ok) {
      failures.push(
        `variant=${variant.name} host=${host} [${result.status}]: ${redactCredentials(result.body).slice(0, 800)}`
      )
      continue
    }
    const success = readSuccessFlag(result.body)
    if (success !== null && success !== 0) {
      failures.push(
        `variant=${variant.name} host=${host} rejected (success=${success}): ${redactCredentials(result.body).slice(0, 800)}`
      )
      continue
    }
    if (opts?.trace) {
      opts.trace.variant = variant.name
      opts.trace.attempts = attempts
      opts.trace.exhausted = false
    }
    return `trae-res://${bizType}/${storeUri}`
  }

  if (opts?.trace) {
    opts.trace.attempts = attempts
    opts.trace.exhausted = exhausted
  }
  // 全部组合都失败：把字节诊断、mime 嗅探结果与每个组合的原因一起抛出，便于一眼定位。
  throw new Error(
    `Trae resource upload failed (${where} bytes=${bytes.length} first8=${hexPreview(bytes)} crc=${crc}`
    + ` mime=${mime || 'unknown'} variants=${ladder.map((v) => v.name).join('+')}`
    + `${exhausted ? ' exhausted=true' : ''}): ${failures.join(' | ') || 'no upload host tried'}`
  )
}

/** 前 8 字节的 hex（诊断「传上去的到底是不是图片」；不含任何凭据）。 */
function hexPreview(b: Uint8Array): string {
  const n = Math.min(8, b.length)
  const parts: string[] = []
  for (let i = 0; i < n; i++) parts.push(b[i].toString(16).padStart(2, '0'))
  return parts.join('') || '(empty)'
}

/** 读响应体里的数字 `success`；没有/不是数字 → `null`（此时以 HTTP 状态为准）。 */
function readSuccessFlag(body: string): number | null {
  try {
    const obj = JSON.parse(body)
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
    const value = (obj as Record<string, any>)['success']
    return typeof value === 'number' ? value : null
  } catch {
    return null
  }
}

// ===== 批量上传（建会话前的门禁调用点） =====

/** 一张待上传的图片（`bytes` 来自请求里的 base64）。 */
export interface TraeImagePart {
  bytes: Uint8Array
  filename: string
}

/** 单张图上传失败的原因（`reason` 已脱敏、已截断，可直接进日志）。 */
export interface ImageUploadFailure {
  filename: string
  reason: string
}

/** 批量上传结果：成功的进 `attachments`，失败的进 `failures`（**逐张独立**，不互相连坐）。 */
export interface ImageUploadOutcome {
  attachments: TraeQueryAttachment[]
  failures: ImageUploadFailure[]
  /**
   * 每张**成功**的图命中的上传变体（`filename` → 变体名）。
   *
   * 为什么必须暴露：变体阶梯存在的意义就是「一次部署收敛到只用那一个」。没有这个映射，
   * 下次就只能继续把三个都跑一遍（每次上传 3 倍写请求），或者靠人肉读日志。
   */
  variants: Record<string, ResourceUploadVariant>
  /** 命中变体的计数摘要（如 `octet+crc=2`）；没有成功图时是空串 */
  variantSummary: string
}

/**
 * 逐张上传。**单张失败不影响其余**：一张坏图不该把另外三张也拖下水。
 *
 * 这里不吞掉失败（返回 `failures` 而不是只打日志），因为调用方要据此决定
 *「图片没进上游」的那条 warn 日志与降级说明。
 */
export async function uploadImageParts(
  account: TraeAccount,
  parts: TraeImagePart[],
  opts?: { baseUrl?: string | null; bizType?: string }
): Promise<ImageUploadOutcome> {
  const attachments: TraeQueryAttachment[] = []
  const failures: ImageUploadFailure[] = []
  const variants: Record<string, ResourceUploadVariant> = {}
  for (const part of parts) {
    try {
      const ticket = await fetchResourceUploadUrl(account, { baseUrl: opts?.baseUrl, filename: part.filename })
      const trace: ResourceUploadTrace = {}
      const uri = await uploadResourceToTrae(account, ticket, part.bytes, part.filename, {
        baseUrl: opts?.baseUrl,
        bizType: opts?.bizType,
        trace,
      })
      attachments.push({ uri, filename: part.filename })
      if (trace.variant) {
        variants[part.filename] = trace.variant
        // 这一行就是「一次部署直接告诉我们哪个变体赢」的落点。变体阶梯是**实验**：
        // 没有它，跑完三个变体也只剩一个「成功了」的结论，收敛不到「以后只用哪一个」。
        console.log(
          `[trae-upload] variant-hit file=${part.filename} variant=${trace.variant}`
          + ` puts=${trace.attempts ?? -1}${trace.exhausted ? ' exhausted=true' : ''}`
        ) // codeql-disable: 只含文件名/变体名/次数，不含凭据
      }
    } catch (e) {
      // 本模块抛出的错误已保证不含凭据（见文件头「凭据边界」），可以直接落日志。
      failures.push({ filename: part.filename, reason: (e as Error).message || String(e) })
    }
  }
  const hits: Record<string, number> = {}
  for (const name of Object.values(variants)) hits[name] = (hits[name] ?? 0) + 1
  const variantSummary = Object.entries(hits).map(([name, n]) => `${name}=${n}`).join(',')
  return { attachments, failures, variants, variantSummary }
}

// ===== 请求体 → 待上传字节 =====

/**
 * 从 messages 里抽出图片字节（供 `createRemoteSession` 上传）。
 *
 * 只认两种形态（与 `remote-messages.ts` 的 `countImageBlocks` 同一口径，两者必须成对演进）：
 *  - OpenAI：`{ type: 'image_url', image_url: { url } }`（`image_url` 是字符串也认）
 *  - Anthropic：`{ type: 'image', source: { type: 'base64', media_type, data } }`
 *
 * `url` 支持 `data:image/…;base64,<payload>` 与**纯 base64**（客户端两种都给过）。
 *
 * **刻意不做的事**：`http(s)://` 的远端图片不在这里抓。那是「服务端替调用方去请求任意第三方
 * 主机」，既有 SSRF 面，也不是本任务的范围。这类图**不产出 part**，差额由调用方用
 * `countImageBlocks() - extractImageParts().length` 暴露到日志里 —— 静默少一张图正是这轮
 * 要消灭的东西。
 */
export function extractImageParts(messages: unknown): TraeImagePart[] {
  const out: TraeImagePart[] = []
  if (!Array.isArray(messages)) return out
  let index = 0
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const content = (raw as Record<string, any>)['content']
    if (!Array.isArray(content)) continue
    for (const rawBlock of content) {
      if (!rawBlock || typeof rawBlock !== 'object' || Array.isArray(rawBlock)) continue
      const block = rawBlock as Record<string, any>
      const type = String(block['type'] ?? '').trim().toLowerCase()
      let payload = ''
      if (type === 'image_url') {
        const iu = block['image_url']
        if (typeof iu === 'string') payload = iu
        else if (iu && typeof iu === 'object' && !Array.isArray(iu)) {
          payload = String((iu as Record<string, any>)['url'] ?? '')
        }
      } else if (type === 'image') {
        const src = block['source']
        if (typeof src === 'string') {
          payload = src
        } else if (src && typeof src === 'object' && !Array.isArray(src)) {
          const s = src as Record<string, any>
          const st = String(s['type'] ?? '').trim().toLowerCase()
          // Anthropic 的 `source.type` 只有 base64（或缺省）能在这里变成字节；
          // `type: 'url'` 要走网络，同上：不做。
          if (st === '' || st === 'base64') payload = String(s['data'] ?? '')
        }
      } else {
        continue
      }
      const decoded = decodeImagePayload(payload)
      if (!decoded) continue
      index++
      // 文件名：请求里没有人类文件名（OpenAI/Anthropic 两种形态都没有这个字段），
      // 就按顺序造一个**带正确后缀**的 —— 上游按后缀判类型，后缀错了图会被当垃圾。
      out.push({ bytes: decoded.bytes, filename: `image-${index}.${decoded.ext}` })
    }
  }
  return out
}

/** 解出一个图片载荷；返回 `null` = 不是可用的内联图片（远端 URL / 非法 base64 / 空）。 */
function decodeImagePayload(payload: string): { bytes: Uint8Array; ext: string } | null {
  const raw = String(payload ?? '').trim()
  if (raw === '') return null
  let mediaType = ''
  let b64 = raw
  if (raw.startsWith('data:')) {
    const comma = raw.indexOf(',')
    if (comma < 0) return null
    const meta = raw.slice('data:'.length, comma)
    if (!/;base64$/i.test(meta)) return null
    mediaType = meta.slice(0, meta.length - ';base64'.length)
    b64 = raw.slice(comma + 1)
  } else if (/^https?:\/\//i.test(raw)) {
    return null
  }
  const bytes = base64ToBytes(b64)
  if (!bytes || bytes.length === 0) return null
  // 后缀优先级：魔术字节（最可信）→ data URI 的 media type → `bin`（不猜图片类型）。
  return { bytes, ext: sniffImageExt(bytes) || mimeExt(mediaType) || 'bin' }
}

/** atob 在 Workers 与 Node 都有；先按 latin1 还原成二进制串，再逐字节取。 */
function base64ToBytes(payload: string): Uint8Array | null {
  try {
    const binary = atob(payload.replace(/\s+/g, ''))
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

/** 魔术字节判图片类型（`bin` 之外不猜）。 */
function sniffImageExt(b: Uint8Array): string {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif'
  if (
    b.length >= 12
    && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return 'webp'
  return ''
}

/** MIME → 后缀；不认识的返回空串（交给 `bin` 兜底）。 */
function mimeExt(mediaType: string): string {
  const ct = String(mediaType ?? '').split(';')[0].trim().toLowerCase()
  switch (ct) {
    case 'image/png': return 'png'
    case 'image/jpeg':
    case 'image/jpg': return 'jpg'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
    default: return ''
  }
}
