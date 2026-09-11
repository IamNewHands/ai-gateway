import { describe, expect, it } from 'vitest'
import {
  MAX_CALLER_TOOLS_SNAPSHOT_BYTES,
  MAX_CHAT_SESSION_STATE_BYTES,
  MAX_PORTABLE_SESSION_BYTES,
  MAX_TOOL_LEDGER_SNAPSHOT_BYTES,
  PORTABLE_TURN_SEPARATOR,
  boundPortableSessionState,
  boundedPortableProtocolSuffix,
  boundedUtf8Suffix,
  portableSessionByteLength,
  utf8Bytes,
} from './portable-session'

const turn = (user: string, assistant: string) =>
  `[USER]\n${user}\n\n[ASSISTANT]\n${assistant}`

describe('portable-session 字节预算常量', () => {
  it('上限常量与源一致', () => {
    expect(MAX_CHAT_SESSION_STATE_BYTES).toBe(192 * 1024)
    expect(MAX_PORTABLE_SESSION_BYTES).toBe(64 * 1024)
    expect(MAX_CALLER_TOOLS_SNAPSHOT_BYTES).toBe(64 * 1024)
    expect(MAX_TOOL_LEDGER_SNAPSHOT_BYTES).toBe(64 * 1024)
  })
})

describe('boundedUtf8Suffix', () => {
  it('未超预算时原样返回', () => {
    expect(boundedUtf8Suffix('hello', 100)).toBe('hello')
  })

  it('空值/非正预算返回空串', () => {
    expect(boundedUtf8Suffix('', 10)).toBe('')
    expect(boundedUtf8Suffix('hello', 0)).toBe('')
    expect(boundedUtf8Suffix('hello', -1)).toBe('')
  })

  it('ASCII 截取最新后缀', () => {
    expect(boundedUtf8Suffix('abcdef', 3)).toBe('def')
  })

  it('多字节字符起点不落在码点中间', () => {
    // 每个汉字 3 字节；限制 4 字节只能容纳最后一个完整的汉字
    const value = '你好世界'
    const result = boundedUtf8Suffix(value, 4)
    expect(result).toBe('界')
    expect(utf8Bytes(result)).toBeLessThanOrEqual(4)
  })

  it('结果不会包含替换字符 U+FFFD', () => {
    const result = boundedUtf8Suffix('你好世界', 5)
    expect(result).not.toContain('\uFFFD')
  })
})

describe('boundedPortableProtocolSuffix', () => {
  it('未超预算时原样返回', () => {
    const value = turn('hi', 'ok')
    expect(boundedPortableProtocolSuffix(value, 10_000)).toBe(value)
  })

  it('空值/非正预算返回空串', () => {
    expect(boundedPortableProtocolSuffix('', 100)).toBe('')
    expect(boundedPortableProtocolSuffix('x', 0)).toBe('')
  })

  it('按完整成帧回合从尾部保留，不切断最新任务', () => {
    const t1 = turn('第一条很长很长的用户指令内容', '回复一')
    const t2 = turn('第二条用户指令', '回复二')
    const value = `${t1}${PORTABLE_TURN_SEPARATOR}${t2}`
    // 预算只够容纳最新一个完整回合
    const budget = utf8Bytes(t2) + 4
    const result = boundedPortableProtocolSuffix(value, budget)
    expect(result).toContain('第二条用户指令')
    expect(result).not.toContain('第一条很长很长的用户指令内容')
  })

  it('无帧的遗留文本退化为码点安全的字节后缀', () => {
    const value = '没有成帧标记的自由文本内容'
    const result = boundedPortableProtocolSuffix(value, 9)
    expect(utf8Bytes(result)).toBeLessThanOrEqual(9)
    expect(result).not.toContain('\uFFFD')
  })

  it('单条超大回合保留结构完整检查点而非过期历史', () => {
    const huge = turn('A'.repeat(50_000), '答')
    const value = `${turn('旧任务', '旧回复')}${PORTABLE_TURN_SEPARATOR}${huge}`
    const result = boundedPortableProtocolSuffix(value, 2_000)
    expect(result).toContain('[ASSISTANT]')
    expect(result).toContain('OVERSIZED PORTABLE TURN CONTENT OMITTED')
    expect(utf8Bytes(result)).toBeLessThanOrEqual(2_000)
  })
})

describe('boundPortableSessionState', () => {
  it('锚点与尾部均在预算内时保持', () => {
    const state = boundPortableSessionState([{ kind: 'unix_path', value: '/tmp/a' }], turn('hi', 'ok'))
    expect(state.taskAnchors).toEqual([{ kind: 'unix_path', value: '/tmp/a' }])
    expect(state.protocolTail).toContain('[USER]')
  })

  it('尾部超预算时按回合裁剪', () => {
    const tail = `${turn('老指令', '老回复')}${PORTABLE_TURN_SEPARATOR}${turn('新指令', '新回复')}`
    const state = boundPortableSessionState([], tail)
    expect(portableSessionByteLength(state)).toBeLessThanOrEqual(MAX_PORTABLE_SESSION_BYTES)
  })

  it('锚点非法时被归一为空', () => {
    const state = boundPortableSessionState([{ kind: 'bogus', value: 'x' } as never], '')
    expect(state.taskAnchors).toEqual([])
  })

  it('锚点经归一后被限制在预算内（目标锚点有独立计数/长度上限）', () => {
    const huge = Array.from({ length: 40 }, (_, i) => ({
      kind: 'unix_path' as const,
      value: `/very/long/path/${i}/${'x'.repeat(4_000)}`,
    }))
    const state = boundPortableSessionState(huge, '')
    // 目标 mergeTaskAnchors 先按 MAX_TASK_ANCHORS=4 截断，锚点远低于 64 KiB
    expect(state.taskAnchors.length).toBeLessThanOrEqual(4)
    expect(portableSessionByteLength(state)).toBeLessThan(MAX_PORTABLE_SESSION_BYTES)
  })

  it('null 尾部视为空串', () => {
    const state = boundPortableSessionState([], null)
    expect(state.protocolTail).toBe('')
    expect(portableSessionByteLength(state)).toBeGreaterThanOrEqual(0)
  })
})

describe('portableSessionByteLength', () => {
  it('等于锚点编码字节 + 尾部字节', () => {
    const tail = turn('hi', 'ok')
    const state = boundPortableSessionState([], tail)
    // 空锚点编码为 "[]"（2 字节）
    expect(portableSessionByteLength(state)).toBe(utf8Bytes(tail) + 2)
  })

  it('含锚点时计入锚点编码字节', () => {
    const tail = turn('hi', 'ok')
    const state = boundPortableSessionState([{ kind: 'unix_path', value: '/tmp/a' }], tail)
    const anchorBytes = utf8Bytes(JSON.stringify(state.taskAnchors))
    expect(portableSessionByteLength(state)).toBe(anchorBytes + utf8Bytes(state.protocolTail))
  })
})
