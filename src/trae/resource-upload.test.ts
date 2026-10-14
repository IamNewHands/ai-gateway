/**
 * resource-upload.test.ts — TRAE 资源上传（图片 → `trae-res://` URI）。
 *
 * 三条链路都按官方 web 客户端的抓包实证写死，**改测试前先确认协议没变**：
 *   ① `POST {IDE}/get_resource_upload_url` → 上传位 + 短期写凭据
 *   ② `PUT  https://{upload_host}/{store_uri}` → 传字节（标准 CRC32 进 `Content-CRC32`）
 *   ③ `trae-res://{biz_type}/{store_uri}`
 *
 * 另外守两条**安全不变量**（它们比功能本身更容易被后续改动破坏）：
 *  - `auth` / `session_key` 绝不进错误信息；
 *  - `session_key` 根本不读（读了就多一个泄露面）。
 *
 * 全部用假凭据。任何断言里出现真实形态的凭据都是 bug。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  crc32Hex,
  douyinFallbackHost,
  extractImageParts,
  fetchResourceUploadUrl,
  imageMimeFromBytes,
  redactCredentials,
  resourceUploadBase,
  TRAE_RESOURCE_MAX_PUTS,
  uploadImageParts,
  uploadResourceToTrae,
  type ResourceUploadTicket,
  type ResourceUploadTrace,
} from './resource-upload'
import type { TraeAccount } from './types'

const ACCOUNT: TraeAccount = {
  accessToken: 'tok-abc',
  refreshToken: 'ref-abc',
  expiresAt: 0,
  uid: 'u1',
  deviceId: 'dev-1',
}

/** 假凭据：形态照真实值（`<accessKeyId>:version:v2:<JWT>`），但内容全是标记串。 */
const FAKE_AUTH = 'AKIDFAKE:version:v2:JWT-SECRET'
const FAKE_SESSION_KEY = 'sk-LEAK'
const STORE_URI = 'tos-cn-i-aiagcest/cn/u1/remote_resource/abc.trae'
/** ① `get_resource_upload_url` **广告**的主机（真机实测：照它打回 `400 InvalidFileType`）。 */
const UPLOAD_HOST = 'tos-d-x-lf.snssdk.com'
/**
 * `douyinFallbackHost` **推导**出的候选（首个子域标签不变、基域换成 `douyin.com`），排第一。
 *
 * ⚠️ 2026-10-14 16:11 真机：新一代主机名（`tos-lq-x.*`）经同一映射后得到
 * `tos-lq-x.douyin.com`，回的是 **Cloudflare 530 / `error code: 1016`（源站 DNS 不解析）**
 * —— 也就是**推导出来的那台是死的**，白占候选链第一枪。它是否真被官方用过尚无直证，
 * 所以这里只改注释、**不动顺序**（本轮只做插桩，不叠第二个变量）。
 */
const OBSERVED_HOST = 'tos-d-x-lf.douyin.com'

function ticket(extra: Partial<ResourceUploadTicket> = {}): ResourceUploadTicket {
  return { storeUri: STORE_URI, auth: FAKE_AUTH, uploadHosts: [UPLOAD_HOST], target: 'abc.trae', ...extra }
}

function uploadUrlResponse(): Response {
  return new Response(
    JSON.stringify({
      session_key: FAKE_SESSION_KEY,
      store_infos: [{ auth: FAKE_AUTH, store_uri: STORE_URI }],
      upload_hosts: [UPLOAD_HOST],
    }),
    { status: 200 }
  )
}

function putResponse(success: unknown = 0): Response {
  return new Response(
    JSON.stringify({ Version: '', success, error: { code: 200 }, payload: { hash: 'deadbeef', key: 'k' } }),
    { status: 200 }
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

// ===== CRC32 =====

describe('crc32Hex：标准 CRC32（IEEE 802.3，反射多项式 0xEDB88320）', () => {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

  it('已知向量：空串 / "123456789" / 经典句子', () => {
    // 这三个是 CRC32 的公开测试向量；换成 CRC32C 或别的变体立刻对不上。
    expect(crc32Hex(new Uint8Array(0))).toBe('00000000')
    expect(crc32Hex(enc('123456789'))).toBe('cbf43926')
    expect(crc32Hex(enc('The quick brown fox jumps over the lazy dog'))).toBe('414fa339')
  })

  it('输出恒为 8 位小写 hex（协议要求，短内容也不能少前导零）', () => {
    for (const s of ['', 'a', 'ab', 'hello world', '中文']) {
      expect(crc32Hex(enc(s))).toMatch(/^[0-9a-f]{8}$/)
    }
    // 单字节 0x00：CRC 值高位可能为 0，正是「补零」这条的靶子。
    expect(crc32Hex(new Uint8Array([0]))).toMatch(/^[0-9a-f]{8}$/)
  })

  it('二进制字节按原值参与计算（不是按字符串编码）', () => {
    expect(crc32Hex(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(crc32Hex(new Uint8Array([0x89, 0x50, 0x4e, 0x47])))
    expect(crc32Hex(new Uint8Array([1, 2, 3]))).not.toBe(crc32Hex(new Uint8Array([3, 2, 1])))
  })
})

// ===== 凭据脱敏 =====

describe('redactCredentials：凭据绝不进错误信息', () => {
  it('抹掉 JSON 键值与 Authorization 头行', () => {
    const text = redactCredentials(
      `{"auth":"${FAKE_AUTH}","session_key":"${FAKE_SESSION_KEY}"}\nAuthorization: ${FAKE_AUTH}`
    )
    expect(text).not.toContain('JWT-SECRET')
    expect(text).not.toContain(FAKE_SESSION_KEY)
    expect(text).toContain('[redacted]')
  })

  it('裸值形态（<accessKeyId>:version:v2:<JWT>）也抹掉 —— 它可能出现在任意文本位置', () => {
    const text = redactCredentials(`upstream said: ${FAKE_AUTH} is expired`)
    expect(text).not.toContain('JWT-SECRET')
    expect(text).toContain('[redacted-auth]')
  })

  it('空输入返回空串（不抛）', () => {
    expect(redactCredentials('')).toBe('')
  })
})

// ===== 基址推导 =====

describe('resourceUploadBase：Remote 基址 → IDE 基址（换路径，不是拼路径）', () => {
  it('带 /api/remote/v1 的 Remote 基址 → 同源 /api/ide/v1', () => {
    expect(resourceUploadBase('https://trae-api-cn.mchost.guru/api/remote/v1'))
      .toBe('https://trae-api-cn.mchost.guru/api/ide/v1')
  })

  it('裸 Trae 主机 → 补 /api/ide/v1', () => {
    expect(resourceUploadBase('https://trae-api-cn.mchost.guru'))
      .toBe('https://trae-api-cn.mchost.guru/api/ide/v1')
  })

  it('已经是 IDE 路径 → 原样保留', () => {
    expect(resourceUploadBase('https://x.example.com/api/ide/v1')).toBe('https://x.example.com/api/ide/v1')
  })

  it('空值 → 内置 IDE 基址；自定义主机原样保留（不猜路径）', () => {
    expect(resourceUploadBase(null)).toBe('https://trae-api-cn.mchost.guru/api/ide/v1')
    expect(resourceUploadBase('')).toBe('https://trae-api-cn.mchost.guru/api/ide/v1')
    expect(resourceUploadBase('https://my-relay.example.com/relay')).toBe('https://my-relay.example.com/relay')
  })

  it('绝不产出 /api/remote/v1/api/ide/v1 这种双层路径（那会 404）', () => {
    expect(resourceUploadBase('https://trae-api-cn.mchost.guru/api/remote/v1')).not.toContain('/api/remote/v1/api/')
  })
})

// ===== ① 申请上传位 =====

describe('fetchResourceUploadUrl：① 申请上传位', () => {
  it('打到 /api/ide/v1/ 并带 targets/biz_type，解析出 store_uri/auth/upload_hosts', async () => {
    const calls: Array<{ url: string; init: any }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      calls.push({ url, init })
      return uploadUrlResponse()
    }))

    const t = await fetchResourceUploadUrl(ACCOUNT, {
      baseUrl: 'https://trae-api-cn.mchost.guru/api/remote/v1',
      filename: 'PixPin.png',
    })

    expect(calls).toHaveLength(1)
    // 端点在 IDE 命名空间下，**不是** /api/remote/v1（这是最容易抄错的一处）。
    expect(calls[0].url).toBe('https://trae-api-cn.mchost.guru/api/ide/v1/get_resource_upload_url')
    expect(calls[0].init.method).toBe('POST')
    const body = JSON.parse(calls[0].init.body)
    expect(body.biz_type).toBe('remote_resource')
    expect(body.targets).toHaveLength(1)
    // uuid 由我们生成，后缀是**实测值** `.trae`：抓包里官方 `attachment.data.uri` 末段就是
    // `…/remote_resource/<uuid>.trae`，而同一个 attachment 的 `filename` 是 `PixPin….png`
    // —— 官方就是把 PNG 字节写进 `.trae` 对象并成功的。别按「服务端校验后缀」去改这一行。
    expect(body.targets[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.trae$/)

    expect(t.storeUri).toBe(STORE_URI)
    expect(t.auth).toBe(FAKE_AUTH)
    expect(t.uploadHosts).toEqual([UPLOAD_HOST])
    // target 必须与请求里发的一致（③ 的 store_uri 末段就是它）。
    expect(t.target).toBe(body.targets[0])
  })

  it('filename 不参与协议：换任何人类文件名，target 后缀都是 .trae', async () => {
    const targets: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      targets.push(JSON.parse(init.body).targets[0])
      return uploadUrlResponse()
    }))

    await fetchResourceUploadUrl(ACCOUNT, { filename: 'photo.jpg' })
    await fetchResourceUploadUrl(ACCOUNT, { filename: 'anim.webp' })
    await fetchResourceUploadUrl(ACCOUNT)

    // 人类文件名只在 ③ 的 `attachment.filename` 里带上去，不改对象名。
    expect(targets).toHaveLength(3)
    for (const t of targets) expect(t).toMatch(/\.trae$/)
  })

  it('头部复用 IDE API 那一套（Authorization: Cloud-IDE-JWT）', async () => {
    let headers: Record<string, string> = {}
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      headers = init.headers
      return uploadUrlResponse()
    }))
    await fetchResourceUploadUrl(ACCOUNT)
    expect(headers['Authorization']).toBe('Cloud-IDE-JWT tok-abc')
    expect(headers['X-Cloudide-Token']).toBe('tok-abc')
    expect(headers['Accept']).toBe('application/json')
  })

  it('**不读** session_key：它压根不出现在产物里', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => uploadUrlResponse()))
    const t = await fetchResourceUploadUrl(ACCOUNT)
    expect(JSON.stringify(t)).not.toContain(FAKE_SESSION_KEY)
    expect(Object.keys(t).sort()).toEqual(['auth', 'storeUri', 'target', 'uploadHosts'])
  })

  it('HTTP 失败：错误信息带状态码 + 响应体前 200 字符，但凭据已脱敏', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ code: 401, msg: 'unauthorized', session_key: FAKE_SESSION_KEY, store_infos: [{ auth: FAKE_AUTH, store_uri: STORE_URI }] }),
      { status: 401 }
    )))
    const err = await fetchResourceUploadUrl(ACCOUNT).then(() => null, (e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toContain('[401]')
    expect(err!.message).toContain('unauthorized')
    // 关键：失败时能看到上游说了什么，但看不到凭据。
    expect(err!.message).not.toContain('JWT-SECRET')
    expect(err!.message).not.toContain(FAKE_SESSION_KEY)
  })

  it('2xx 但响应体不是 JSON / 缺 store_infos：抛错且不含凭据', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    const err = await fetchResourceUploadUrl(ACCOUNT).then(() => null, (e: Error) => e)
    expect(err!.message).toContain('non-JSON')

    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ session_key: FAKE_SESSION_KEY, store_infos: [], upload_hosts: [] }),
      { status: 200 }
    )))
    const err2 = await fetchResourceUploadUrl(ACCOUNT).then(() => null, (e: Error) => e)
    expect(err2!.message).toContain('missing auth/store_uri')
    expect(err2!.message).not.toContain(FAKE_SESSION_KEY)
  })

  it('网络层异常 → 抛 transport 错误（不吞）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('socket hang up') }))
    await expect(fetchResourceUploadUrl(ACCOUNT)).rejects.toThrow(/transport error/)
  })
})

// ===== ② 上传字节 =====

describe('uploadResourceToTrae：② 上传字节 + ③ 拼 URI', () => {
  const BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff])

  it('URL 拼接 / 头部 / body 逐项对照协议', async () => {
    const calls: Array<{ url: string; init: any }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      calls.push({ url, init })
      return putResponse(0)
    }))

    const uri = await uploadResourceToTrae(ACCOUNT, ticket(), BYTES, 'image-1.png')

    // 第一枪打**观测到能用的**主机（douyin），不是 API 广告的那个（snssdk）：
    // 2026-10-14 真机实证，照广告打 snssdk 会被 `400 InvalidFileType` 拒掉，而字节是合法 PNG。
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`https://${OBSERVED_HOST}/${STORE_URI}`)
    expect(calls[0].init.method).toBe('PUT')
    // auth **原样**进 Authorization：没有 Bearer、没有别的前缀。
    expect(calls[0].init.headers['Authorization']).toBe(FAKE_AUTH)
    expect(calls[0].init.headers['Content-Type']).toBe('application/octet-stream')
    expect(calls[0].init.headers['Content-Length']).toBe(String(BYTES.byteLength))
    // Content-CRC32 = 标准 CRC32 的 8 位小写 hex。
    expect(calls[0].init.headers['Content-CRC32']).toBe(crc32Hex(BYTES))
    expect(calls[0].init.headers['Content-CRC32']).toMatch(/^[0-9a-f]{8}$/)
    // 照抄官方客户端那次成功 PUT 的三个头（跨站直传的来源校验）。
    expect(calls[0].init.headers['Accept']).toBe('*/*')
    expect(calls[0].init.headers['Origin']).toBe('https://work.trae.cn')
    expect(calls[0].init.headers['Referer']).toBe('https://work.trae.cn/')
    expect(calls[0].init.body).toBe(BYTES)

    expect(uri).toBe(`trae-res://remote_resource/${STORE_URI}`)
  })

  it('biz_type 可覆盖（进 ③ 的 URI 前缀，不进 ② 的头）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => putResponse(0)))
    const uri = await uploadResourceToTrae(ACCOUNT, ticket(), BYTES, 'a.png', { bizType: 'other_biz' })
    expect(uri).toBe(`trae-res://other_biz/${STORE_URI}`)
  })

  it('success=0 是成功（0 表示成功，别按直觉反过来读）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => putResponse(0)))
    await expect(uploadResourceToTrae(ACCOUNT, ticket(), BYTES, 'a.png')).resolves.toContain('trae-res://')
  })

  it('HTTP 2xx 但 success != 0 → 失败（不能把业务失败当成功）', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      return putResponse(1)
    }))
    const err = await uploadResourceToTrae(ACCOUNT, ticket(), BYTES, 'a.png').then(() => null, (e: Error) => e)
    expect(err!.message).toContain('success=1')
    // `success !== 0` 也算「这个组合不行」→ 阶梯走完：4 变体 × 2 主机 = 8 枪。
    expect(urls).toHaveLength(8)
    expect(err!.message).toContain('variant=octet+crc host=')
    expect(err!.message).toContain('variant=octet-nocrc host=')
    expect(err!.message).toContain('variant=mime+crc host=')
    expect(err!.message).toContain('variant=mime-nocrc host=')
  })

  it('HTTP 2xx 且响应体没有 success 字段 → 按 2xx 认成功（代理可能吃掉 body）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    await expect(uploadResourceToTrae(ACCOUNT, ticket(), BYTES, 'a.png'))
      .resolves.toBe(`trae-res://remote_resource/${STORE_URI}`)
  })

  it('HTTP 失败 → 抛聚合错误，含每个组合的变体名/状态码与排障定位（uid/filename），不含 auth', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      return new Response(`denied ${FAKE_AUTH}`, { status: 403 })
    }))
    const err = await uploadResourceToTrae(ACCOUNT, ticket(), BYTES, 'image-1.png').then(() => null, (e: Error) => e)
    expect(urls).toHaveLength(8)
    expect(err!.message).toContain(`variant=octet+crc host=${OBSERVED_HOST} [403]`)
    expect(err!.message).toContain(`variant=octet-nocrc host=${OBSERVED_HOST} [403]`)
    expect(err!.message).toContain(`variant=mime+crc host=${UPLOAD_HOST} [403]`)
    expect(err!.message).toContain(`variant=mime-nocrc host=${UPLOAD_HOST} [403]`)
    expect(err!.message).toContain('uid=u1')
    expect(err!.message).toContain('file=image-1.png')
    expect(err!.message).not.toContain('JWT-SECRET')
  })

  it('上传位缺 store_uri/auth 或没有 upload_hosts → 明确抛错（不静默传空）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => putResponse(0)))
    await expect(uploadResourceToTrae(ACCOUNT, ticket({ auth: '' }), BYTES, 'a.png'))
      .rejects.toThrow(/missing store_uri\/auth/)
    await expect(uploadResourceToTrae(ACCOUNT, ticket({ uploadHosts: [] }), BYTES, 'a.png'))
      .rejects.toThrow(/no upload_hosts/)
  })
})

describe('uploadResourceToTrae：上传主机候选顺序与逐个换主机（2026-10-14 真机实证）', () => {
  const BYTES = new Uint8Array([1, 2, 3])

  it('第一个主机（观测值 douyin）网络失败 → 换回广告主机 snssdk 再试一次', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      if (urls.length === 1) throw new TypeError('fetch failed')
      return putResponse(0)
    }))

    const uri = await uploadResourceToTrae(ACCOUNT, ticket(), BYTES, 'a.png')

    expect(urls).toHaveLength(2)
    // 顺序是「观测值优先」：douyin 先，snssdk 后。
    expect(urls[0]).toBe(`https://${OBSERVED_HOST}/${STORE_URI}`)
    expect(urls[1]).toBe(`https://${UPLOAD_HOST}/${STORE_URI}`)
    expect(uri).toBe(`trae-res://remote_resource/${STORE_URI}`)
  })

  it('所有主机都网络失败 → 抛聚合错误，**每个主机的原因都列出**', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      throw new TypeError('fetch failed')
    }))
    const err = await uploadResourceToTrae(ACCOUNT, ticket(), BYTES, 'a.png').then(() => null, (e: Error) => e)

    // 嗅不出 mime（BYTES 是 [1,2,3]）→ 阶梯只剩 octet 两档：2 变体 × 2 主机 = 4 枪。
    expect(urls).toHaveLength(4)
    expect(err!.message).toContain('Trae resource upload failed')
    // 两个变体 × 两个主机各一条原因，用 ` | ` 分隔（排障时一眼看出「都试过了、都挂了」）。
    expect(err!.message).toContain(`variant=octet+crc host=${OBSERVED_HOST} transport:`)
    expect(err!.message).toContain(`variant=octet+crc host=${UPLOAD_HOST} transport:`)
    expect(err!.message).toContain(`variant=octet-nocrc host=${OBSERVED_HOST} transport:`)
    expect(err!.message).toContain(`variant=octet-nocrc host=${UPLOAD_HOST} transport:`)
    expect(err!.message).toContain(' | ')
    // 阶梯只有两档这件事要如实写在错误信息里（别让读日志的人以为 mime 变体也试过了）。
    expect(err!.message).toContain('variants=octet+crc+octet-nocrc')
    // 字节诊断：证明「传上去的确实是图片」，而不是内容被拒。
    expect(err!.message).toContain(`bytes=${BYTES.length}`)
    expect(err!.message).toContain('first8=010203')
    expect(err!.message).toContain(`crc=${crc32Hex(BYTES)}`)
  })

  it('**HTTP 400 也要换下一个主机**（旧行为「HTTP 失败不回退」被真机推翻）', async () => {
    // 真机依据（2026-10-14）：`get_resource_upload_url` 广告 `tos-d-x-lf.snssdk.com`，但官方
    // 客户端实际发 `tos-d-x-lf.douyin.com`。照广告打时上游回的是 **HTTP 400 + success:-1 +
    // InvalidFileType**，而字节已验证合法（`bytes=21674 first8=89504e470d0a1a0a` = PNG 魔术
    // 字节）—— 被拒的是**主机**，不是内容。
    //
    // 所以「非 2xx 就放弃」是错的：它会把一个**主机级**的 400 当成**内容/凭据级**的终态，
    // 整条图片链路就永远卡在广告主机上（真机上就是这么丢图的）。
    //
    // 这条用例用「第一个主机 400、第二个主机 200」钉住规则本身：任一主机失败都不得中止候选链。
    //（线上因为 douyin 排第一，通常压根走不到第二个；规则的价值是在映射未知/反转时兜底。）
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      if (urls.length === 1) {
        return new Response(
          JSON.stringify({ Version: '', success: -1, error: { code: 400, error: 'InvalidFileType', error_code: 4028 } }),
          { status: 400 }
        )
      }
      return putResponse(0)
    }))

    const uri = await uploadResourceToTrae(ACCOUNT, ticket(), BYTES, 'image-1.png')

    expect(urls).toHaveLength(2)
    expect(urls[0]).toBe(`https://${OBSERVED_HOST}/${STORE_URI}`)
    expect(urls[1]).toBe(`https://${UPLOAD_HOST}/${STORE_URI}`)
    expect(uri).toBe(`trae-res://remote_resource/${STORE_URI}`)
  })

  it('所有主机都回 HTTP 400 → 聚合错误里带每个主机的状态码与脱敏响应体', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      return new Response(
        JSON.stringify({ Version: '', success: -1, error: { code: 400, error: 'InvalidFileType', error_code: 4028 } }),
        { status: 400 }
      )
    }))
    const err = await uploadResourceToTrae(ACCOUNT, ticket(), BYTES, 'image-1.png').then(() => null, (e: Error) => e)

    // octet 两档 × 2 主机 = 4 枪，每枪都 400。
    expect(urls).toHaveLength(4)
    expect(err!.message).toContain(`variant=octet+crc host=${OBSERVED_HOST} [400]`)
    expect(err!.message).toContain(`variant=octet+crc host=${UPLOAD_HOST} [400]`)
    expect(err!.message).toContain(`variant=octet-nocrc host=${OBSERVED_HOST} [400]`)
    expect(err!.message).toContain(`variant=octet-nocrc host=${UPLOAD_HOST} [400]`)
    expect(err!.message).toContain('InvalidFileType')
    // 响应体被压成**一行短码**（而不是 800 字符原文）：8 枪也放得下调用方的上限。
    expect(err!.message).toContain('InvalidFileType/4028')
    // `store=` 是 ① 实际下发的对象名 —— 后缀到底是谁说了算，看这一项（不再是猜）。
    expect(err!.message).toContain(`store=${STORE_URI}`)
    // 失败细节进错误信息，但凭据不进。
    expect(err!.message).not.toContain('JWT-SECRET')
    expect(err!.message).not.toContain(FAKE_SESSION_KEY)
  })

  it('**8 枪全失败时整条消息不超 1200 字符**（上一轮就是被截尾丢了结论）', async () => {
    // PNG 魔术字节 → 阶梯满 4 档；2 主机 → 4 × 2 = 8 枪，正好撞上限。
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ Version: '', success: -1, error: { code: 400, error: 'InvalidFileType', error_code: 4028 } }),
      { status: 400 }
    )))
    const err = await uploadResourceToTrae(
      ACCOUNT,
      ticket({ uploadHosts: [UPLOAD_HOST, 'tos-extra.example.com'] }),
      PNG,
      'image-1.png'
    ).then(() => null, (e: Error) => e)

    // `remote.ts` 的上限是 1200：超了就会截尾，把后面几枪和 `store=` 一起丢掉。
    expect(err!.message.length).toBeLessThanOrEqual(1200)
    // 8 枪的**最后一枪**必须还在（截尾的判据就是「最后一枪不见了」）。
    // 外层变体、内层主机 → 4 变体 × 3 主机 = 12 个组合，截到 8 时的末枪是
    // `mime+crc` 的第 2 台主机（`mime-nocrc` 一枪都轮不到，由 `exhausted=true` 如实报出）。
    expect(err!.message).toContain(`variant=mime+crc host=${UPLOAD_HOST} [400]`)
    expect(err!.message).not.toContain('variant=mime-nocrc')
    expect(err!.message).toContain('exhausted=true')
    expect(err!.message).toContain(`store=${STORE_URI}`)
  })

  it('候选链 = [观测主机, 广告主机, 上游其余主机…]（顺序固定，去重）', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      // 前两台一律 400，逼候选链走到底 —— 这样才能把**完整顺序**钉住（而不是只看第一台）。
      if (urls.length < 3) return new Response('nope', { status: 400 })
      return putResponse(0)
    }))

    await uploadResourceToTrae(
      ACCOUNT,
      ticket({ uploadHosts: [UPLOAD_HOST, 'tos-extra.example.com'] }),
      BYTES,
      'a.png'
    )

    expect(urls).toEqual([
      `https://${OBSERVED_HOST}/${STORE_URI}`,
      `https://${UPLOAD_HOST}/${STORE_URI}`,
      `https://tos-extra.example.com/${STORE_URI}`,
    ])
  })

  it('候选链去重：上游广告的就是观测主机时只打一次，不重复同一个 URL', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      return new Response('nope', { status: 400 })
    }))

    await expect(uploadResourceToTrae(ACCOUNT, ticket({ uploadHosts: [OBSERVED_HOST] }), BYTES, 'a.png'))
      .rejects.toThrow(/Trae resource upload failed/)
    // 去重只针对**主机**（候选链里没有重复主机），**不**针对变体：同一台主机上还有 2 个变体
    //（这块字节嗅不出 mime → octet+crc / octet-nocrc），所以同一个 URL 会被打 2 次。
    expect(urls).toEqual([
      `https://${OBSERVED_HOST}/${STORE_URI}`,
      `https://${OBSERVED_HOST}/${STORE_URI}`,
    ])
  })

  it('douyinFallbackHost：基域映射（观测值优先），只换基域、首个子域标签原样保留', () => {
    expect(douyinFallbackHost('tos-d-x-lf.snssdk.com')).toBe('tos-d-x-lf.douyin.com')
    expect(douyinFallbackHost('https://tos-d-x-lf.snssdk.com/path')).toBe('tos-d-x-lf.douyin.com')
    // 已经在 douyin.com 上 → 没有可换的（避免原地重试一次）
    expect(douyinFallbackHost('tos-d-x-lf.douyin.com')).toBeNull()
    expect(douyinFallbackHost('localhost')).toBeNull()
    expect(douyinFallbackHost('')).toBeNull()
  })
})

// ===== 上传变体阶梯（2026-10-15：主机维度已排除，只剩「类型」这一个变量） =====

describe('uploadResourceToTrae：变体阶梯（Content-Type / Content-CRC32 的候选）', () => {
  /** PNG 魔术字节开头 → `imageMimeFromBytes` 认得出，阶梯有 4 档（2×2）。 */
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  /** 没有魔术字节 → mime 嗅不出，阶梯只有 2 档（octet+crc / octet-nocrc）。 */
  const UNKNOWN = new Uint8Array([1, 2, 3])

  /** 记录每次 PUT 的 (host, contentType, crc 头有没有, 四个恒定头, 原始头对象)。 */
  function ladderSpy(responder: (n: number) => Response) {
    const puts: Array<{
      host: string
      contentType: string | undefined
      crc: string | undefined
      authorization: string | undefined
      accept: string | undefined
      origin: string | undefined
      referer: string | undefined
      headers: Record<string, string>
    }> = []
    let n = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      n++
      puts.push({
        host: new URL(url).host,
        contentType: init.headers['Content-Type'],
        crc: init.headers['Content-CRC32'],
        authorization: init.headers['Authorization'],
        accept: init.headers['Accept'],
        origin: init.headers['Origin'],
        referer: init.headers['Referer'],
        headers: { ...init.headers },
      })
      return responder(n)
    }))
    return puts
  }

  /**
   * 两组 PUT 头里**取值不同**的键（排序后）。
   *
   * 这是「一步只动一个变量」的可证伪形式：期望恰好一个键名，多一个就说明实验被污染了。
   */
  function changedHeaderKeys(
    a: Record<string, string | undefined>,
    b: Record<string, string | undefined>
  ): string[] {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    return [...keys].filter((k) => a[k] !== b[k]).sort()
  }

  it('imageMimeFromBytes：魔术字节 → 真实 mime；嗅不出返回空串（不瞎填）', () => {
    expect(imageMimeFromBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png')
    expect(imageMimeFromBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(imageMimeFromBytes(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('image/gif')
    expect(imageMimeFromBytes(
      new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
    )).toBe('image/webp')
    expect(imageMimeFromBytes(UNKNOWN)).toBe('')
    expect(imageMimeFromBytes(new Uint8Array(0))).toBe('')
  })

  it('顺序是契约：外层变体、内层主机，4 变体 × 2 主机 = 8 枪', async () => {
    const puts = ladderSpy(() => new Response('nope', { status: 400 }))
    const trace: ResourceUploadTrace = {}

    await expect(
      uploadResourceToTrae(ACCOUNT, ticket(), PNG, 'image-1.png', { trace })
    ).rejects.toThrow(/Trae resource upload failed/)

    // 阶梯是一步只动一个变量的 2×2：
    //   ①octet+crc → ②octet-nocrc（**只**去掉 CRC）→ ③mime+crc（**只**换 Content-Type）→ ④mime-nocrc。
    expect(puts.map((p) => `${p.host}|${p.contentType}|${p.crc === undefined ? 'nocrc' : 'crc'}`)).toEqual([
      `${OBSERVED_HOST}|application/octet-stream|crc`,
      `${UPLOAD_HOST}|application/octet-stream|crc`,
      `${OBSERVED_HOST}|application/octet-stream|nocrc`,
      `${UPLOAD_HOST}|application/octet-stream|nocrc`,
      `${OBSERVED_HOST}|image/png|crc`,
      `${UPLOAD_HOST}|image/png|crc`,
      `${OBSERVED_HOST}|image/png|nocrc`,
      `${UPLOAD_HOST}|image/png|nocrc`,
    ])
    // 4 个恒定头在所有 8 枪上都不变 —— 实验只允许一个变量（Content-Type / CRC）在动。
    for (const p of puts) {
      expect(p.authorization).toBe(FAKE_AUTH)
      expect(p.accept).toBe('*/*')
      expect(p.origin).toBe('https://work.trae.cn')
      expect(p.referer).toBe('https://work.trae.cn/')
    }
    expect(trace.attempts).toBe(8)
    expect(trace.exhausted).toBe(false)
    expect(trace.variant).toBeUndefined()
  })

  it('[trae-upload] plan：开打前一次性打全「广告主机/候选顺序/对象名/计划枪数」，独立于会被截断的聚合错误', async () => {
    // 上一轮真机日志的教训：结论只能从**聚合错误**里读，而它有字符上限 —— 尾巴一截，
    //「到底广告了几台主机」「对象名是什么后缀」「有没有 exhausted」就全丢了。
    // 这条钉住「计划」是一条独立的、开打前就发出的读数。
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(' '))
    })
    try {
      ladderSpy(() => new Response('nope', { status: 400 }))
      await expect(
        uploadResourceToTrae(
          ACCOUNT,
          ticket({ uploadHosts: [UPLOAD_HOST, 'tos-extra.example.com'] }),
          PNG,
          'PixPin_2026-10-14_14-16-32.png'
        )
      ).rejects.toThrow(/Trae resource upload failed/)
    } finally {
      spy.mockRestore()
    }

    const plan = logs.find((l) => l.includes('[trae-upload] plan'))
    expect(plan).toBeDefined()
    // ① 原样广告的主机 —— 与候选顺序一比，就知道「推导主机」是不是我们自造的。
    expect(plan).toContain(`advertised=${UPLOAD_HOST},tos-extra.example.com`)
    expect(plan).toContain(`candidates=${OBSERVED_HOST},${UPLOAD_HOST},tos-extra.example.com`)
    // `store=` 是 ① 下发的对象名（后缀的唯一读数），`target=` 是我们申请的名字。
    expect(plan).toContain(`store=${STORE_URI}`)
    expect(plan).toContain('target=abc.trae')
    // 4 变体 × 3 主机 = 12 个组合，硬上限只允许 8 枪 → 必须如实标 exhausted。
    expect(plan).toContain('planned=8/12 exhausted=true')
    // 凭据绝不进日志（plan 行里有主机名与对象名，但不能有 auth/session_key）。
    expect(plan).not.toContain('JWT-SECRET')
    expect(plan).not.toContain(FAKE_SESSION_KEY)
  })

  it('单变量隔离：变体 2 相对变体 1**只**差 Content-CRC32，变体 3 相对变体 1**只**差 Content-Type', async () => {
    // 这条把「CRC 头是不是毒药」变成可**单独**证伪的命题：取每个变体的第一台主机
    //（同一主机 → 主机维度被排除），直接 diff 头部键集合 —— 多一个键就说明实验被污染。
    const puts = ladderSpy(() => new Response('nope', { status: 400 }))

    await expect(
      uploadResourceToTrae(ACCOUNT, ticket(), PNG, 'image-1.png')
    ).rejects.toThrow(/Trae resource upload failed/)

    // puts[0]=变体1 第一台主机，puts[2]=变体2，puts[4]=变体3。
    const [v1, v2, v3] = [puts[0], puts[2], puts[4]]
    expect([v1.host, v2.host, v3.host]).toEqual([OBSERVED_HOST, OBSERVED_HOST, OBSERVED_HOST])

    // 变体 1 → 2：Content-Type 不变，**只**少了 Content-CRC32。
    expect(v1.contentType).toBe('application/octet-stream')
    expect(v2.contentType).toBe(v1.contentType)
    expect(v1.crc).toBe(crc32Hex(PNG))
    expect(v2.crc).toBeUndefined()
    expect(changedHeaderKeys(v1.headers, v2.headers)).toEqual(['Content-CRC32'])

    // 变体 1 → 3：CRC 不变，**只**换了 Content-Type。
    expect(v3.contentType).toBe('image/png')
    expect(v3.contentType).not.toBe(v1.contentType)
    expect(v3.crc).toBe(v1.crc)
    expect(changedHeaderKeys(v1.headers, v3.headers)).toEqual(['Content-Type'])
  })

  it('嗅不出 mime → 只留 octet 两档（4 枪），不瞎填 Content-Type', async () => {
    const puts = ladderSpy(() => new Response('nope', { status: 400 }))
    const trace: ResourceUploadTrace = {}

    await expect(
      uploadResourceToTrae(ACCOUNT, ticket(), UNKNOWN, 'image-1.bin', { trace })
    ).rejects.toThrow(/mime=unknown/)

    // 2 变体（octet+crc / octet-nocrc）× 2 主机 = 4 枪；mime 两档**一枪都没发**。
    expect(puts).toHaveLength(4)
    expect(puts.every((p) => p.contentType === 'application/octet-stream')).toBe(true)
    expect(puts.map((p) => (p.crc === undefined ? 'nocrc' : 'crc'))).toEqual(['crc', 'crc', 'nocrc', 'nocrc'])
    expect(trace.attempts).toBe(4)
    expect(trace.variant).toBeUndefined()
    // 错误信息要如实说「阶梯只有这两档」，别让读日志的人以为 mime 变体也试过了
    //（后面紧跟的 ` store=` 钉住列表就此结束：没有第三个变体名被塞进来）。
    await expect(
      uploadResourceToTrae(ACCOUNT, ticket(), UNKNOWN, 'image-1.bin')
    ).rejects.toThrow(/variants=octet\+crc\+octet-nocrc store=/)
  })

  it('变体 3（mime+crc）成功即停：不再试变体 4（mime-nocrc），也不再多打主机', async () => {
    // 前 2 个变体（octet+crc / octet-nocrc，各 2 台主机 = 4 枪）全 400；
    // 第 5 枪（变体 3 的第一台主机）成功 → 立刻停。
    const puts = ladderSpy((n) => (n < 5 ? new Response('nope', { status: 400 }) : putResponse(0)))
    const trace: ResourceUploadTrace = {}

    const uri = await uploadResourceToTrae(ACCOUNT, ticket(), PNG, 'image-1.png', { trace })

    expect(uri).toBe(`trae-res://remote_resource/${STORE_URI}`)
    expect(puts).toHaveLength(5)
    expect(puts[4].contentType).toBe('image/png')
    expect(puts[4].crc).toBe(crc32Hex(PNG))
    // 变体 4（mime-nocrc）一次都没发过：真实 mime 且**不带** CRC 的请求不存在。
    expect(puts.some((p) => p.contentType === 'image/png' && p.crc === undefined)).toBe(false)
    expect(trace.variant).toBe('mime+crc')
    expect(trace.attempts).toBe(5)
    expect(trace.exhausted).toBe(false)
  })

  it('变体 1 成功 → trace 记 octet+crc、只打 1 枪（不回归）', async () => {
    const puts = ladderSpy(() => putResponse(0))
    const trace: ResourceUploadTrace = {}

    await uploadResourceToTrae(ACCOUNT, ticket(), PNG, 'image-1.png', { trace })

    expect(puts).toHaveLength(1)
    expect(puts[0].contentType).toBe('application/octet-stream')
    expect(trace.variant).toBe('octet+crc')
    expect(trace.attempts).toBe(1)
  })

  it('PUT 次数有硬上限：候选多于上限时截断，并**如实报告未穷尽**', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      return new Response('nope', { status: 400 })
    }))
    // 4 台主机 × 4 变体 = 16 组合 > 上限 8。
    const trace: ResourceUploadTrace = {}
    const err = await uploadResourceToTrae(
      ACCOUNT,
      ticket({ uploadHosts: [UPLOAD_HOST, 'tos-a.example.com', 'tos-b.example.com'] }),
      PNG,
      'image-1.png',
      { trace }
    ).then(() => null, (e: Error) => e)

    // 上限本身就是契约（4 变体 × 2 主机正好够；有第三台主机时会被截断）。
    expect(TRAE_RESOURCE_MAX_PUTS).toBe(8)
    expect(urls).toHaveLength(8)
    expect(err!.message).toContain('exhausted=true')
    expect(trace.exhausted).toBe(true)
    expect(trace.attempts).toBe(TRAE_RESOURCE_MAX_PUTS)
    // 没穷尽时**不能**留下「命中了某个变体」的假结论。
    expect(trace.variant).toBeUndefined()
  })

  it('未到上限时错误信息里**不带** exhausted（别把「试完了」说成「没试完」）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 400 })))
    const err = await uploadResourceToTrae(ACCOUNT, ticket(), PNG, 'image-1.png').then(() => null, (e: Error) => e)
    expect(err!.message).not.toContain('exhausted')
    expect(err!.message).toContain('mime=image/png')
    expect(err!.message).toContain('variants=octet+crc+octet-nocrc+mime+crc+mime-nocrc')
  })

  it('失败信息里每条都带变体名（否则分不清是哪一档挂的）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 400 })))
    const err = await uploadResourceToTrae(ACCOUNT, ticket(), PNG, 'image-1.png').then(() => null, (e: Error) => e)
    for (const variant of ['octet+crc', 'octet-nocrc', 'mime+crc', 'mime-nocrc']) {
      expect(err!.message).toContain(`variant=${variant} host=${OBSERVED_HOST} [400]`)
      expect(err!.message).toContain(`variant=${variant} host=${UPLOAD_HOST} [400]`)
    }
  })

  it('凭据安全：8 条失败原因堆在一起也不含 auth / session_key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ success: -1, auth: FAKE_AUTH, session_key: FAKE_SESSION_KEY }),
      { status: 400 }
    )))
    const err = await uploadResourceToTrae(ACCOUNT, ticket(), PNG, 'image-1.png').then(() => null, (e: Error) => e)
    expect(err!.message).not.toContain('JWT-SECRET')
    expect(err!.message).not.toContain(FAKE_SESSION_KEY)
    expect(err!.message).toContain('[redacted]')
  })
})

// ===== 批量上传 =====

describe('uploadImageParts：逐张独立，一张坏不拖累其余', () => {
  const BYTES = new Uint8Array([1, 2, 3])
  /** PNG 魔术字节：mime 嗅得出，阶梯 4 档（用来验证变体命中摘要）。 */
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  it('全成功 → attachments 齐全，failures 为空，并暴露命中的变体', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      if (url.includes('get_resource_upload_url')) return uploadUrlResponse()
      if (init?.method === 'PUT') return putResponse(0)
      return new Response('{}', { status: 200 })
    }))
    const out = await uploadImageParts(ACCOUNT, [
      { bytes: BYTES, filename: 'image-1.png' },
      { bytes: BYTES, filename: 'image-2.png' },
    ])
    expect(out.attachments).toHaveLength(2)
    expect(out.failures).toHaveLength(0)
    expect(out.attachments[0].uri).toBe(`trae-res://remote_resource/${STORE_URI}`)
    expect(out.attachments[0].filename).toBe('image-1.png')
    // 命中的变体必须能带出去 —— 这是「下次收敛到只用那一个」的唯一依据。
    expect(out.variants).toEqual({ 'image-1.png': 'octet+crc', 'image-2.png': 'octet+crc' })
    expect(out.variantSummary).toBe('octet+crc=2')
  })

  it('后面的变体才成功时，命中的是真实命中的那个（不是兜底的 octet+crc）', async () => {
    let puts = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      if (url.includes('get_resource_upload_url')) return uploadUrlResponse()
      if (init?.method === 'PUT') {
        puts++
        // 变体 1/2（octet 两档，各 2 台主机 = 4 枪）全 400，变体 3 的第一台主机（第 5 枪）成功。
        return puts < 5 ? new Response('nope', { status: 400 }) : putResponse(0)
      }
      return new Response('{}', { status: 200 })
    }))
    const out = await uploadImageParts(ACCOUNT, [{ bytes: PNG, filename: 'image-1.png' }])
    expect(out.attachments).toHaveLength(1)
    expect(out.variants).toEqual({ 'image-1.png': 'mime+crc' })
    expect(out.variantSummary).toBe('mime+crc=1')
  })

  it('第一张申请上传位就失败 → 第二张照常成功，失败原因可读且不含凭据', async () => {
    let seen = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      if (url.includes('get_resource_upload_url')) {
        seen++
        if (seen === 1) {
          return new Response(JSON.stringify({ msg: 'quota', session_key: FAKE_SESSION_KEY, auth: FAKE_AUTH }), { status: 429 })
        }
        return uploadUrlResponse()
      }
      if (init?.method === 'PUT') return putResponse(0)
      return new Response('{}', { status: 200 })
    }))

    const out = await uploadImageParts(ACCOUNT, [
      { bytes: BYTES, filename: 'bad.png' },
      { bytes: BYTES, filename: 'good.png' },
    ])
    expect(out.attachments.map((a) => a.filename)).toEqual(['good.png'])
    expect(out.failures).toHaveLength(1)
    expect(out.failures[0].filename).toBe('bad.png')
    expect(out.failures[0].reason).toContain('[429]')
    expect(out.failures[0].reason).not.toContain('JWT-SECRET')
    expect(out.failures[0].reason).not.toContain(FAKE_SESSION_KEY)
  })

  it('空列表 → 空结果（不发任何请求）', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    const out = await uploadImageParts(ACCOUNT, [])
    expect(out).toEqual({ attachments: [], failures: [], variants: {}, variantSummary: '' })
    expect(spy).not.toHaveBeenCalled()
  })
})

// ===== 请求体 → 待上传字节 =====

describe('extractImageParts：从 messages 抽图片字节', () => {
  /** 1×1 PNG 的 base64（前缀 89504E47，用来验证魔术字节判后缀）。 */
  const PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

  it('OpenAI data URI → 字节 + 正确后缀的文件名', () => {
    const parts = extractImageParts([
      { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } }] },
    ])
    expect(parts).toHaveLength(1)
    expect(parts[0].filename).toBe('image-1.png')
    expect(Array.from(parts[0].bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47])
  })

  it('纯 base64（无 data: 前缀）也认', () => {
    const parts = extractImageParts([
      { role: 'user', content: [{ type: 'image_url', image_url: { url: PNG_B64 } }] },
    ])
    expect(parts).toHaveLength(1)
    expect(parts[0].bytes.length).toBeGreaterThan(8)
  })

  it('Anthropic base64 source 也认（source.type 缺省按 base64）', () => {
    const parts = extractImageParts([
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } },
          { type: 'image', source: { media_type: 'image/png', data: PNG_B64 } },
        ],
      },
    ])
    expect(parts.map((p) => p.filename)).toEqual(['image-1.png', 'image-2.png'])
  })

  it('远端 http(s) URL / Anthropic source.type=url **不产出** part（本层不抓第三方图床）', () => {
    const parts = extractImageParts([
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
          { type: 'image', source: { type: 'url', url: 'https://example.com/b.png' } },
        ],
      },
    ])
    expect(parts).toEqual([])
  })

  it('非法 base64 / 非图片块 / 畸形输入都不产出 part，也不抛错', () => {
    expect(extractImageParts([
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,@@@not-base64@@@' } }] },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'user', content: [{ type: 'image_url' }] },
      { role: 'user', content: 'plain' },
      null,
      1,
      [],
    ])).toEqual([])
    expect(extractImageParts(null)).toEqual([])
    expect(extractImageParts('nope')).toEqual([])
  })

  it('文件名序号连续、按出现顺序（与 countImageBlocks 的口径一致）', () => {
    const parts = extractImageParts([
      { role: 'system', content: 'S' },
      { role: 'user', content: [
        { type: 'text', text: 'A' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } },
      ] },
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${PNG_B64}` } },
      ] },
    ])
    // 第二张虽然声明 jpeg，但字节是 PNG —— 魔术字节优先，后缀必须跟着**字节**走。
    expect(parts.map((p) => p.filename)).toEqual(['image-1.png', 'image-2.png'])
  })

  it('JPEG / GIF / WEBP 的魔术字节各自识别', () => {
    // 不引 Buffer：本仓 tsconfig 只挂 workers-types，`btoa` 在两个运行时都有。
    const b64 = (bytes: number[]): string => {
      let bin = ''
      for (const b of bytes) bin += String.fromCharCode(b)
      return btoa(bin)
    }
    const jpeg = b64([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
    const gif = b64([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
    const webp = b64([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20])
    const parts = extractImageParts([
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: jpeg } },
        { type: 'image_url', image_url: { url: gif } },
        { type: 'image_url', image_url: { url: webp } },
      ] },
    ])
    expect(parts.map((p) => p.filename)).toEqual(['image-1.jpg', 'image-2.gif', 'image-3.webp'])
  })
})
