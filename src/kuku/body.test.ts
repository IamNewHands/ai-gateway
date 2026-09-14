import { describe, expect, it } from 'vitest'
import { buildKukuPrompt } from './body'

describe('buildKukuPrompt', () => {
  it('preserves role order and text parts', () => {
    expect(buildKukuPrompt([
      { role: 'system', content: 'follow instructions' },
      { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }] },
    ])).toBe('[system]\nfollow instructions\n\n[user]\nhello\nworld')
  })

  it('rejects multimodal content explicitly', () => {
    expect(() => buildKukuPrompt([{ role: 'user', content: [{ type: 'image_url', image_url: {} }] }]))
      .toThrow(/does not support image/)
  })
})
