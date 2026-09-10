import { describe, it, expect } from 'vitest'
import { repairTaskAnchorArtifacts } from './task-anchors'
import type { TaskAnchor } from './task-anchors'

describe('repairTaskAnchorArtifacts', () => {
  it('修复中文路径中的 X 伪影', () => {
    const anchors: TaskAnchor[] = [{ kind: 'windows_path', value: 'D:\\项目\\config' }]
    const input = '路径是 D:\\项目X\\config'
    expect(repairTaskAnchorArtifacts(input, anchors)).toBe('路径是 D:\\项目\\config')
  })

  it('路径正确时不做修改', () => {
    const anchors: TaskAnchor[] = [{ kind: 'windows_path', value: 'D:\\项目\\config' }]
    const input = '路径是 D:\\项目\\config'
    expect(repairTaskAnchorArtifacts(input, anchors)).toBe(input)
  })

  it('没有锚点时原样保留', () => {
    expect(repairTaskAnchorArtifacts('路径是 D:\\项目X\\config', undefined)).toBe('路径是 D:\\项目X\\config')
  })

  it('多字中文字符的 X 伪影修复', () => {
    const anchors: TaskAnchor[] = [{ kind: 'windows_path', value: 'C:\\Users\\张三\\Documents' }]
    const input = '查看 C:\\Users\\张三X\\Documents'
    expect(repairTaskAnchorArtifacts(input, anchors)).toBe('查看 C:\\Users\\张三\\Documents')
  })

  it('空串安全返回', () => {
    const anchors: TaskAnchor[] = [{ kind: 'windows_path', value: 'D:\\项目' }]
    expect(repairTaskAnchorArtifacts('', anchors)).toBe('')
  })

  it('从 Chat 消息与 Responses 输入中提取 Task Anchors', async () => {
    const { extractChatTaskAnchors, extractResponsesTaskAnchors } = await import('./task-anchors')
    const chatAnchors = extractChatTaskAnchors([
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: '请部署 8 号服务器 并检查 D:\\项目\\dist' },
      { role: 'assistant', content: '好的' },
    ])
    expect(chatAnchors.some((a) => a.kind === 'server' && a.value === '8号服务器')).toBe(true)
    expect(chatAnchors.some((a) => a.kind === 'windows_path' && a.value === 'D:\\项目\\dist')).toBe(true)

    const responsesAnchors = extractResponsesTaskAnchors([
      { role: 'user', content: [{ type: 'input_text', text: '访问 https://example.com/api 测试' }] },
      { type: 'function_call_output', output: 'ok' },
    ])
    expect(responsesAnchors.some((a) => a.kind === 'url' && a.value === 'https://example.com/api')).toBe(true)
  })
})