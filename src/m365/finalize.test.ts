import { describe, it, expect, vi } from 'vitest'
import { finalizeText, collapseExcessBlankLines } from './chathub'

describe('finalizeText', () => {
  it('final 为空时返回 streamed（或空串）', () => {
    expect(finalizeText('hello', '')).toBe('hello')
    expect(finalizeText('', '')).toBe('')
  })

  it('final 不高于 streamed 时保留流式文本', () => {
    expect(finalizeText('abc', 'ab')).toBe('abc')
    expect(finalizeText('abc', 'abc')).toBe('abc')
  })

  it('streamed 是 final 的前缀时补发缺失尾部并返回 final', () => {
    const emit = vi.fn()
    const result = finalizeText('你好，世界', '你好，世界！今天天气不错', emit)
    expect(result).toBe('你好，世界！今天天气不错')
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith('！今天天气不错')
  })

  it('streamed 已偏离 final（final 更长但非前缀）时以 final 为准且不补发', () => {
    const emit = vi.fn()
    const result = finalizeText('完全不同的开头文本AAAA', '真正的最终答案在这里补充得更长', emit)
    expect(result).toBe('真正的最终答案在这里补充得更长')
    expect(emit).not.toHaveBeenCalled()
  })

  it('无 emit 回调时前缀补发仍返回 final 且不抛错', () => {
    expect(finalizeText('ab', 'abcd')).toBe('abcd')
  })

  it('streamed 为空且 final 非空时直接返回 final', () => {
    expect(finalizeText('', 'final answer')).toBe('final answer')
  })
})

describe('collapseExcessBlankLines', () => {
  it('连续 3+ 空行压缩为 1 个空行，保留单个空行段落留白', () => {
    const input = '第一段\n\n\n\n第二段'
    expect(collapseExcessBlankLines(input)).toBe('第一段\n\n第二段')
  })

  it('多段之间的单个空行（2 个换行）保持不变', () => {
    const input = '第一段\n\n第二段\n\n第三段'
    expect(collapseExcessBlankLines(input)).toBe(input)
  })

  it('代码块内部空行全部保留', () => {
    const input = '说明\n\n```\na\n\n\nb\n```\n\n结尾'
    expect(collapseExcessBlankLines(input)).toBe('说明\n\n```\na\n\n\nb\n```\n\n结尾')
  })

  it('代码块外连续空行仍被折叠', () => {
    const input = '```\na\n\n\nb\n```\n\n\n\n结尾'
    expect(collapseExcessBlankLines(input)).toBe('```\na\n\n\nb\n```\n\n结尾')
  })

  it('清掉末尾多余空行', () => {
    expect(collapseExcessBlankLines('内容\n\n\n\n')).toBe('内容')
  })

  it('空串安全返回', () => {
    expect(collapseExcessBlankLines('')).toBe('')
  })
})
