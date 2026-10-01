/**
 * deepseek/images.test.ts — 图片提取：data URL 解码、MIME→后缀、http 抓取与各类失败。
 *
 * 这些断言对应 Go 版 `openai_test.go` / `image_ctx_test.go` 的金字案例，另加一条
 * **有意的行为差异**：Go 的 `decodeDataURL` 对「不受支持的 MIME / base64 损坏 / 超 10MB」
 * 静默跳过（落到「非 http(s) URL」那条），这与它自己「绝不静默丢图」的契约矛盾，
 * 这里按契约改成报错。
 */

import { describe, it, expect } from 'vitest'
import {
  DEEPSEEK_IMAGE_FETCH_TIMEOUT_MS,
  DEEPSEEK_IMAGE_MAX_BYTES,
  DeepseekImageError,
  decodeDataUrl,
  extractDeepseekImages,
  fetchImage,
  firstSegment,
  imageExtByMime,
} from './images'

/** 1×1 PNG 的 base64（最小合法图，仅用于解码路径）。 */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

describe('imageExtByMime', () => {
  it('映射常见图片类型，忽略参数与大小写', () => {
    expect(imageExtByMime('image/png')).toBe('png')
    expect(imageExtByMime('IMAGE/JPEG')).toBe('jpg')
    expect(imageExtByMime('image/jpg')).toBe('jpg')
    expect(imageExtByMime('image/webp')).toBe('webp')
    expect(imageExtByMime('image/gif')).toBe('gif')
    expect(imageExtByMime('image/png; charset=binary')).toBe('png')
    expect(imageExtByMime('  image/png  ')).toBe('png')
  })

  it('非图片类型返回空串（调用方据此报错，不猜后缀）', () => {
    for (const ct of ['text/html', 'application/octet-stream', 'image/svg+xml', 'image/avif', '']) {
      expect(imageExtByMime(ct), ct).toBe('')
    }
  })
})

describe('firstSegment', () => {
  it('去掉 query 并限长（客户端 URL 的 query 里可能带 token）', () => {
    expect(firstSegment('https://img.test/a.png?token=secret')).toBe('https://img.test/a.png')
    expect(firstSegment('https://img.test/a.png')).toBe('https://img.test/a.png')
    expect(firstSegment('https://img.test/' + 'x'.repeat(300)).length).toBe(128)
  })
})

describe('decodeDataUrl', () => {
  it('解码 base64 data URL 并给出后缀', () => {
    const img = decodeDataUrl(`data:image/png;base64,${PNG_B64}`)!
    expect(img).not.toBeNull()
    expect(img.ext).toBe('png')
    expect(img.data.length).toBeGreaterThan(0)
    // PNG magic：确认真的解出了字节而不是空壳
    expect(Array.from(img.data.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47])
  })

  it('非 data URL 返回 null（调用方应继续尝试 http 抓取）', () => {
    expect(decodeDataUrl('https://img.test/a.png')).toBeNull()
    expect(decodeDataUrl('')).toBeNull()
  })

  /**
   * 有意的差异：Go 在这里静默跳过，我们报错。
   * 静默跳过会产出一个「客户端以为带了图」的回答，比报错更糟。
   */
  it('不受支持的 MIME 报错（不静默丢图）', () => {
    expect(() => decodeDataUrl('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')).toThrow(DeepseekImageError)
    expect(() => decodeDataUrl('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')).toThrow(/unsupported image type/)
  })

  it('非 base64 的 data URL 报错', () => {
    expect(() => decodeDataUrl('data:image/png,notbase64')).toThrow(/base64-encoded/)
  })

  it('缺少逗号的 data URL 报错', () => {
    expect(() => decodeDataUrl('data:image/png;base64')).toThrow(/no comma/)
  })

  it('base64 负载损坏时报错', () => {
    expect(() => decodeDataUrl('data:image/png;base64,!!!!')).toThrow(/not valid base64/)
  })

  it('超过 10MB 上限时报错', () => {
    const huge = 'A'.repeat(Math.ceil((DEEPSEEK_IMAGE_MAX_BYTES + 1024) / 3) * 4)
    expect(() => decodeDataUrl(`data:image/png;base64,${huge}`)).toThrow(/10MB cap/)
  })
})

describe('fetchImage', () => {
  const png = () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200, headers: { 'Content-Type': 'image/png' } })

  it('抓取 http(s) 图片并按 Content-Type 定后缀', async () => {
    let seenUrl = ''
    const img = await fetchImage('https://img.test/photo', {
      fetch: async (u) => {
        seenUrl = u
        return png()
      },
    })
    expect(seenUrl).toBe('https://img.test/photo')
    expect(img!.ext).toBe('png')
    expect(img!.data.length).toBe(4)
  })

  it('非 http(s) URL 返回 null（唯一剩下的非错误跳过）', async () => {
    expect(await fetchImage('ftp://img.test/a.png')).toBeNull()
    expect(await fetchImage('file:///tmp/a.png')).toBeNull()
    // 且不发出任何请求
    let called = 0
    await fetchImage('ftp://x/a.png', { fetch: async () => { called++; return png() } })
    expect(called).toBe(0)
  })

  it('非 200 报错', async () => {
    await expect(
      fetchImage('https://img.test/a.png', { fetch: async () => new Response('nope', { status: 404 }) }),
    ).rejects.toThrow(/http 404/)
  })

  it('不受支持的 content-type 报错', async () => {
    await expect(
      fetchImage('https://img.test/a', {
        fetch: async () => new Response('<html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
      }),
    ).rejects.toThrow(/unsupported content type/)
  })

  it('网络异常报错（不吞掉）', async () => {
    await expect(
      fetchImage('https://img.test/a.png', { fetch: async () => { throw new Error('ECONNREFUSED') } }),
    ).rejects.toThrow(/ECONNREFUSED/)
  })

  /** 挂住的图床必须干净失败：不能把请求连同池槽位一起卡死。 */
  it('超时被中止并报错', async () => {
    await expect(
      fetchImage('https://img.test/slow.png', {
        timeoutMs: 10,
        fetch: (_u, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
          }),
      }),
    ).rejects.toThrow(/aborted/)
  })

  it('超过 10MB 报错', async () => {
    await expect(
      fetchImage('https://img.test/big.png', {
        fetch: async () =>
          new Response(new Uint8Array(DEEPSEEK_IMAGE_MAX_BYTES + 1), {
            status: 200,
            headers: { 'Content-Type': 'image/png' },
          }),
      }),
    ).rejects.toThrow(/10MB cap/)
  })

  it('默认超时常量是 30s（Go imageFetchTimeout）', () => {
    expect(DEEPSEEK_IMAGE_FETCH_TIMEOUT_MS).toBe(30_000)
  })
})

describe('extractDeepseekImages', () => {
  const msg = (parts: Array<{ type: string; imageUrl?: string }>) => ({ contentParts: parts })

  it('data URL 与 http URL 混用时都收齐，且保持顺序', async () => {
    const imgs = await extractDeepseekImages(
      [
        msg([{ type: 'text' }, { type: 'image_url', imageUrl: `data:image/png;base64,${PNG_B64}` }]),
        msg([{ type: 'image_url', imageUrl: 'https://img.test/b.gif' }]),
      ],
      {
        fetch: async () => new Response(new Uint8Array([1, 2]), { status: 200, headers: { 'Content-Type': 'image/gif' } }),
      },
    )
    expect(imgs.map((i) => i.ext)).toEqual(['png', 'gif'])
  })

  it('纯文本请求不产生任何图片、也不发请求', async () => {
    let called = 0
    const imgs = await extractDeepseekImages([msg([{ type: 'text' }])], {
      fetch: async () => { called++; return new Response('', { status: 200 }) },
    })
    expect(imgs).toEqual([])
    expect(called).toBe(0)
  })

  it('空的 imageUrl 被跳过（不产生空图）', async () => {
    const imgs = await extractDeepseekImages([msg([{ type: 'image_url', imageUrl: '' }])])
    expect(imgs).toEqual([])
  })

  it('抓取失败让整次提取失败（不静默丢图）', async () => {
    await expect(
      extractDeepseekImages([msg([{ type: 'image_url', imageUrl: 'https://img.test/x.png' }])], {
        fetch: async () => new Response('nope', { status: 500 }),
      }),
    ).rejects.toThrow(DeepseekImageError)
  })
})