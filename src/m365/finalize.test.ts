import { describe, it, expect, vi } from 'vitest'
import {
  finalizeText,
  collapseExcessBlankLines,
  appendChatHubDelta,
  appendChatSnapshot,
  scrubNarration,
  syntheticUpstreamFailureCode,
  reconcileChatHubText,
  chatHubUpdateHasSemanticProgress,
} from './chathub'

describe('syntheticUpstreamFailureCode（B:853-861 假成功限流占位识别）', () => {
  it('上游容量占位文本 → CHAT_UPSTREAM_RATE_LIMITED', () => {
    expect(syntheticUpstreamFailureCode("We're temporarily unable to respond to this volume of requests")).toBe('CHAT_UPSTREAM_RATE_LIMITED')
    expect(syntheticUpstreamFailureCode('We are temporarily unable to respond to the current volume of requests. Please try again later!')).toBe('CHAT_UPSTREAM_RATE_LIMITED')
    expect(syntheticUpstreamFailureCode("We're currently experiencing high traffic. Please try again later.")).toBe('CHAT_UPSTREAM_RATE_LIMITED')
    expect(syntheticUpstreamFailureCode('We are currently experiencing high traffic')).toBe('CHAT_UPSTREAM_RATE_LIMITED')
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

describe('reconcileChatHubText', () => {
  it('当 final 和 streamed 一致或为前缀时判定为非偏离', () => {
    const res1 = reconcileChatHubText('hello world', 'hello world')
    expect(res1.divergent).toBe(false)
    expect(res1.text).toBe('hello world')

    const res2 = reconcileChatHubText('hello', 'hello world')
    expect(res2.divergent).toBe(false)
    expect(res2.text).toBe('hello world')
  })

  it('当 final 和 streamed 冲突偏离时判定为 divergent: true 并以 final 优先', () => {
    const res = reconcileChatHubText('Hello, world!', 'Goodbye, world!')
    expect(res.divergent).toBe(true)
    expect(res.text).toBe('Goodbye, world!')
    expect(res.streamedCharacters).toBe(13)
    expect(res.finalCharacters).toBe(15)
  })
})

describe('chatHubUpdateHasSemanticProgress', () => {
  it('包含 throttling 时返回 true', () => {
    expect(chatHubUpdateHasSemanticProgress({ throttling: {} })).toBe(true)
  })

  it('包含 writeAtCursor 时返回 true', () => {
    expect(chatHubUpdateHasSemanticProgress({ writeAtCursor: 'a' })).toBe(true)
  })

  it('包含 Progress / SearchResults / ToolCall 消息时返回 true', () => {
    expect(chatHubUpdateHasSemanticProgress({
      messages: [{ messageType: 'Progress' }],
    })).toBe(true)
    expect(chatHubUpdateHasSemanticProgress({
      messages: [{ contentType: 'ToolCall' }],
    })).toBe(true)
  })

  it('普通空消息返回 false', () => {
    expect(chatHubUpdateHasSemanticProgress({})).toBe(false)
    expect(chatHubUpdateHasSemanticProgress({ messages: [] })).toBe(false)
  })
})

describe('appendChatSnapshot（log4 段落开头被吞回归）', () => {
  it('current 为空 → 返回快照并透出', () => {
    const emit = vi.fn()
    expect(appendChatSnapshot('', 'hello', emit)).toEqual({ text: 'hello', skipped: false })
    expect(emit).toHaveBeenCalledWith('hello')
  })

  it('快照是前缀扩展 → 只透出尾部', () => {
    const emit = vi.fn()
    expect(appendChatSnapshot('hello', 'hello world', emit)).toEqual({
      text: 'hello world',
      skipped: false,
    })
    expect(emit).toHaveBeenCalledWith(' world')
  })

  it('快照更长的分歧重写 → 采纳更长者（不得停在陈旧短文本）', () => {
    const emit = vi.fn()
    // 偏移对齐后的权威重写：前缀不匹配但更长
    const res = appendChatSnapshot('TacReader> 主要通过', 'SangTacReader> 主要通过 WKWebView', emit)
    expect(res.skipped).toBe(true)
    expect(res.text).toBe('SangTacReader> 主要通过 WKWebView')
    // 已发出的"TacReader> 主要通过"无法撤回，但也不能再透出分歧部分造成错乱
    expect(emit).not.toHaveBeenCalled()
  })

  it('快照更短的分歧重写 → 保留当前文本', () => {
    const emit = vi.fn()
    const res = appendChatSnapshot('hello world', 'hello', emit)
    expect(res).toEqual({ text: 'hello world', skipped: true })
    expect(emit).not.toHaveBeenCalled()
  })

  it('采纳更长分歧快照后，后续增量以正确偏移做差集（log4 截断根因）', () => {
    // 复现 log4：分歧快照被丢弃时，累计文本停留在更短版本，
    // 后续 writeAtCursor 增量便以错误偏移做差集 → 段落开头文字被吞。
    const stale = appendChatSnapshot('际架构', '实际架构') // 旧行为会丢弃 "实"
    expect(stale.text).toBe('实际架构')
    // 以推进后的文本为基准，下一段增量可完整拼接
    const next = appendChatHubDelta(stale.text, `${stale.text}\n\n1. 原生外壳`)
    expect(next).toBe('实际架构\n\n1. 原生外壳')
  })
})

