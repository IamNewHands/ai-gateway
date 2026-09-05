import { describe, it, expect, vi } from 'vitest'
import { finalizeText, collapseExcessBlankLines, appendChatHubDelta, scrubNarration, syntheticUpstreamFailureCode } from './chathub'

describe('syntheticUpstreamFailureCode（B:853-861 假成功限流占位识别）', () => {
  it('上游容量占位文本 → CHAT_UPSTREAM_RATE_LIMITED', () => {
    expect(syntheticUpstreamFailureCode("We're temporarily unable to respond to this volume of requests")).toBe('CHAT_UPSTREAM_RATE_LIMITED')
    expect(syntheticUpstreamFailureCode('We are temporarily unable to respond to the current volume of requests. Please try again later!')).toBe('CHAT_UPSTREAM_RATE_LIMITED')
  })

  it('大小写与空白差异不敏感（归一化后匹配）', () => {
    expect(syntheticUpstreamFailureCode('  we\'RE   TEMPORARILY   UNABLE to respond\n to this volume\t of requests ')).toBe('CHAT_UPSTREAM_RATE_LIMITED')
  })

  it('提及限流的普通模型长文保持可见（非精确匹配 → null）', () => {
    expect(syntheticUpstreamFailureCode('The rate limit was hit because we\'re temporarily unable to respond to this volume of requests today, see docs.')).toBeNull()
    expect(syntheticUpstreamFailureCode('用户提到 we are temporarily unable to respond to this volume of requests。')).toBeNull()
  })

  it('超过 512 字符直接不判定（防长文误判）', () => {
    expect(syntheticUpstreamFailureCode('x'.repeat(513))).toBeNull()
    // 边界：归一化后 513 字符的占位文本（原长可更长）仍不匹配
    const long = 'we are temporarily unable to respond to this volume of requests. ' + 'y'.repeat(460)
    expect(syntheticUpstreamFailureCode(long)).toBeNull()
  })

  it('裸句点结尾且无 please 尾巴的变体不判定（精确匹配边界，与 B 正则一致）', () => {
    expect(syntheticUpstreamFailureCode("We're temporarily unable to respond to this volume of requests.")).toBeNull()
  })

  it('非字符串与空串返回 null', () => {
    expect(syntheticUpstreamFailureCode(undefined)).toBeNull()
    expect(syntheticUpstreamFailureCode(null)).toBeNull()
    expect(syntheticUpstreamFailureCode(123)).toBeNull()
    expect(syntheticUpstreamFailureCode('')).toBeNull()
    expect(syntheticUpstreamFailureCode('   ')).toBeNull()
  })
})

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

describe('appendChatHubDelta', () => {
  it('chunk 为空 → 返回 current', () => {
    expect(appendChatHubDelta('hello', '')).toBe('hello')
  })

  it('current 为空 → 返回 chunk 并触发 emit', () => {
    const emit = vi.fn()
    expect(appendChatHubDelta('', 'hello', emit)).toBe('hello')
    expect(emit).toHaveBeenCalledWith('hello')
  })

  it('chunk === current → 返回 current（无变化）', () => {
    const emit = vi.fn()
    expect(appendChatHubDelta('hello', 'hello', emit)).toBe('hello')
    expect(emit).not.toHaveBeenCalled()
  })

  it('current 以 chunk 结尾 → 返回 current（blind append 场景）', () => {
    const emit = vi.fn()
    expect(appendChatHubDelta('hello world', 'world', emit)).toBe('hello world')
    expect(emit).not.toHaveBeenCalled()
  })

  it('chunk 以 current 开头 → 取增量并返回 chunk', () => {
    const emit = vi.fn()
    const result = appendChatHubDelta('hello', 'hello world', emit)
    expect(result).toBe('hello world')
    expect(emit).toHaveBeenCalledWith(' world')
  })

  it('chunk 与 current 无关 → 直接追加并触发 emit', () => {
    const emit = vi.fn()
    const result = appendChatHubDelta('hello', ' world', emit)
    expect(result).toBe('hello world')
    expect(emit).toHaveBeenCalledWith(' world')
  })

  it('无 emit 回调时不抛错', () => {
    expect(appendChatHubDelta('a', 'bc')).toBe('abc')
  })
})

describe('scrubNarration', () => {
  it('剥除"我将执行"完整三字段旁白', () => {
    const input = '我将执行：\n目的：配置服务器\n预期：成功。'
    expect(scrubNarration(input)).toBe('')
  })

  it('剥除"我将执行"简短旁白', () => {
    const input = '我将执行：配置服务器。后续内容。'
    expect(scrubNarration(input)).toBe('后续内容。')
  })

  it('普通文本不受影响', () => {
    const input = '已经完成了配置，服务器已重启。'
    expect(scrubNarration(input)).toBe(input)
  })

  it('空串安全返回', () => {
    expect(scrubNarration('')).toBe('')
  })
})
