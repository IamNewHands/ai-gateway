/**
 * 移植回归（M365-Gateway-source-20260906-tool-image 快照）：
 * 1. genericAssistantNonAnswer 模板化空答复识别 → isToolRefusal（B openai.ts 3976 附近）
 * 2. uploadAttachments 加固：conversationId 绑定校验 / 30s 超时 / redirect:manual / 有界响应读取 / gptvnorm2048
 *    （B image-upload.ts + chathub.ts chatHub 预上传改动）
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { genericAssistantNonAnswer, isToolRefusal } from './tools'
import { readJsonBounded, uploadAttachments } from './chathub'
import type { ChatHubAccount, ChatHubAttachment } from './chathub'

const acc = { accessToken: 'test-private-token', oid: 'o', tid: 't' } as ChatHubAccount
const opts = { timeoutMs: 1000 } as never
const img = (url = 'data:image/png;base64,AAAA'): ChatHubAttachment => ({ type: 'image', url } as ChatHubAttachment)

afterEach(() => vi.restoreAllMocks())

describe('genericAssistantNonAnswer（移植 B 20260906）', () => {
  it('识别 Sorry/Hmm/I can not chat 模板化空答复', () => {
    expect(genericAssistantNonAnswer("Sorry, I wasn't able to respond. Is there something else I can help with?")).toBe(true)
    expect(genericAssistantNonAnswer('It looks like I am not able to respond to that!')).toBe(true)
    expect(genericAssistantNonAnswer("Hmm… I was not able to respond to that. Let's try a different topic.")).toBe(true)
    expect(genericAssistantNonAnswer("I can't chat about this.")).toBe(true)
    expect(genericAssistantNonAnswer('I am not able to respond')).toBe(true)
  })

  it('不命中真实回答/嵌入该措辞的长文本/中文内容', () => {
    expect(genericAssistantNonAnswer('Sorry to interrupt, but I found the bug: the config file was malformed.')).toBe(false)
    expect(genericAssistantNonAnswer('这里可以先看配置。Sorry, I was not able to respond. 之后再继续。')).toBe(false)
    expect(genericAssistantNonAnswer('好的，我继续修复这个问题。')).toBe(false)
    expect(genericAssistantNonAnswer('')).toBe(false)
  })

  it('并入 isToolRefusal：模板空答复触发纠正重试，其余行为不变', () => {
    expect(isToolRefusal("Sorry, I wasn't able to respond to that.")).toBe(true)
    expect(isToolRefusal('正常回答内容')).toBe(false)
    // 长度守卫保持：≥200 字符的长文本不判定
    const long = "Sorry, I wasn't able to respond." + 'x'.repeat(200)
    expect(isToolRefusal(long)).toBe(false)
  })
})

describe('uploadAttachments 加固（移植 B 20260906）', () => {
  const okBody = { result: { value: 'Success' }, conversationId: 'conv', docId: 'doc1', fileName: 'a.png', fileType: '.png' }

  it('上传成功：携带三个 optionsSets（含 gptvnorm2048）、redirect:manual、有界体，并回填 docId', async () => {
    let capturedInit: RequestInit | undefined
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      capturedInit = init
      return Response.json(okBody)
    })
    const a = img()
    await uploadAttachments(acc, 'conv', [a], opts)
    expect(capturedInit?.redirect).toBe('manual')
    const body = String(capturedInit?.body)
    expect(body).toContain('scenario=UploadImage')
    expect(body).toContain('conversationId=conv')
    expect(body).toContain('gptvnorm2048')
    expect(a.docId).toBe('doc1')
  })

  it.each([
    { ...okBody, conversationId: 'wrong' },
    { ...okBody, conversationId: undefined },
  ])('绑定校验失败即拒绝（不回填 docId）：%j', async (body) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(body))
    const a = img()
    await expect(uploadAttachments(acc, 'conv', [a], opts)).rejects.toThrow(/not bound to conversation/)
    expect(a.docId).toBeUndefined()
  })

  it('超大响应体（>64KiB）拒绝解析', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x'.repeat(65_537)))
    await expect(uploadAttachments(acc, 'conv', [img()], opts)).rejects.toThrow('bounded read limit')
  })

  it('HTTP 非 2xx 与 JSON 解析失败分别报错', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('denied', { status: 403 }))
    await expect(uploadAttachments(acc, 'conv', [img()], opts)).rejects.toThrow('HTTP 403')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not json'))
    await expect(uploadAttachments(acc, 'conv', [img()], opts)).rejects.toThrow('invalid JSON')
  })

  it('非 image 附件跳过上传', async () => {
    const f = vi.spyOn(globalThis, 'fetch')
    await uploadAttachments(acc, 'conv', [{ type: 'file', url: 'https://example.com/a.pdf' } as ChatHubAttachment], opts)
    expect(f).not.toHaveBeenCalled()
  })
})

describe('readJsonBounded', () => {
  it('正常解析 JSON；超过上限抛错；空 body 抛错', async () => {
    expect(await readJsonBounded(Response.json({ a: 1 }), 1024)).toEqual({ a: 1 })
    await expect(readJsonBounded(new Response('x'.repeat(2049)), 2048)).rejects.toThrow('bounded read limit')
    await expect(readJsonBounded(new Response(null, { status: 204 } as ResponseInit), 1024)).rejects.toThrow('empty body')
  })
})
