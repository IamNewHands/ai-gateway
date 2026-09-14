import { describe, expect, it } from 'vitest'
import { resolveKukuModel } from './constants'

describe('resolveKukuModel', () => {
  it('accepts prefixed and bare known models', () => {
    expect(resolveKukuModel('kuku/glm-5.3')).toBe('glm-5.3')
    expect(resolveKukuModel('auto')).toBe('auto')
  })

  it('rejects unknown models instead of silently falling back', () => {
    expect(() => resolveKukuModel('kuku/not-real')).toThrow(/Unsupported Kuku model/)
  })
})
