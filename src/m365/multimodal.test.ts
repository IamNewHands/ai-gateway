import { describe, expect, it } from 'vitest'
import {
  normalizeMultimodalContent,
  normalizeMultimodalContents,
  extractUpstreamImageURLs,
  MultimodalInputError,
} from './multimodal'

describe('M365 multimodal normalization', () => {
  it('normalizes simple string content', () => {
    const res = normalizeMultimodalContent('hello world')
    expect(res).toEqual({
      text: 'hello world',
      attachments: [],
      dataImageBytes: 0,
    })
  })

  it('normalizes content parts with text and https image_url', () => {
    const res = normalizeMultimodalContent([
      { type: 'text', text: 'Here is the diagram:' },
      { type: 'image_url', image_url: 'https://example.com/diagram.png', detail: 'high' },
    ])
    expect(res.text).toBe('Here is the diagram:')
    expect(res.attachments).toHaveLength(1)
    expect(res.attachments[0]).toEqual({
      type: 'image',
      url: 'https://example.com/diagram.png',
      mimeType: 'image/*',
      detail: 'high',
    })
  })

  it('normalizes base64 data image URLs', () => {
    // 1x1 png base64
    const validBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    const res = normalizeMultimodalContent([
      { type: 'text', text: 'image test' },
      { type: 'image_url', image_url: { url: validBase64 } },
    ])
    expect(res.attachments).toHaveLength(1)
    expect(res.attachments[0].mimeType).toBe('image/png')
    expect(res.dataImageBytes).toBeGreaterThan(0)
  })

  it('rejects SSRF / private IP image URLs', () => {
    expect(() =>
      normalizeMultimodalContent([
        { type: 'image_url', image_url: 'https://127.0.0.1/secret.png' },
      ])
    ).toThrow(MultimodalInputError)

    expect(() =>
      normalizeMultimodalContent([
        { type: 'image_url', image_url: 'https://169.254.169.254/metadata.png' },
      ])
    ).toThrow(MultimodalInputError)

    expect(() =>
      normalizeMultimodalContent([
        { type: 'image_url', image_url: 'https://localhost/local.png' },
      ])
    ).toThrow(MultimodalInputError)
  })

  it('enforces total image count limit across multi-turn messages', () => {
    const validUrl = 'https://example.com/pic.png'
    const parts = [
      [{ type: 'image_url', image_url: validUrl }, { type: 'image_url', image_url: validUrl }],
      [{ type: 'image_url', image_url: validUrl }, { type: 'image_url', image_url: validUrl }],
      [{ type: 'image_url', image_url: validUrl }, { type: 'image_url', image_url: validUrl }],
      [{ type: 'image_url', image_url: validUrl }, { type: 'image_url', image_url: validUrl }],
      [{ type: 'image_url', image_url: validUrl }], // 9th image -> exceeds max 8
    ]

    expect(() => normalizeMultimodalContents(parts)).toThrow(MultimodalInputError)
  })

  it('extracts upstream image URLs from ChatHub events', () => {
    const event = {
      messages: [
        {
          author: 'bot',
          imageUrl: 'https://example.com/generated-image.png',
        },
      ],
    }
    const extracted = extractUpstreamImageURLs(event)
    expect(extracted).toEqual(['https://example.com/generated-image.png'])
  })
})
