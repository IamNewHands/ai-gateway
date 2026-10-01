/**
 * url-host.test.ts — baseUrl 主机判定的唯一实现。
 *
 * 回归对象：CodeQL `js/incomplete-url-substring-sanitization`（#80/#81）。
 * `baseUrl.includes('chat.deepseek.com')` 会把 `https://chat.deepseek.com.evil.com`
 * 与 `https://evil.com/?u=chat.deepseek.com` 一起放行 → provider 被路由到本模块、
 * 面板被渲染成「自家上游」。这里把「必须拒绝」和「必须接受」两侧都钉住。
 */

import { describe, it, expect } from 'vitest'
import { baseUrlHostIs } from './url-host'

const HOST = 'chat.deepseek.com'

describe('baseUrlHostIs', () => {
  it('接受 hostname 精确命中的 URL（路径/端口/大小写/尾斜杠都不影响）', () => {
    for (const ok of [
      'https://chat.deepseek.com',
      'https://chat.deepseek.com/',
      'https://chat.deepseek.com/api/v0/chat/completion',
      'https://chat.deepseek.com:443',
      'http://chat.deepseek.com',
      'https://CHAT.DeepSeek.COM/v1',
    ]) {
      expect(baseUrlHostIs(ok, HOST), ok).toBe(true)
    }
  })

  it('拒绝子串/后缀伪装与任意拼接主机', () => {
    for (const evil of [
      'https://chat.deepseek.com.evil.com',
      'https://chat.deepseek.com.evil.com/v1',
      'https://evil.com/?u=chat.deepseek.com',
      'https://evil.com/chat.deepseek.com',
      'https://evil.com#chat.deepseek.com',
      'https://notchat.deepseek.com',
      'https://chat.deepseek.com.cn',
      'https://user:pass@evil.com/chat.deepseek.com',
    ]) {
      expect(baseUrlHostIs(evil, HOST), evil).toBe(false)
    }
  })

  it('非字符串 / 空串 / 不可解析的输入一律 false（不猜测）', () => {
    for (const bad of [undefined, null, '', 'chat.deepseek.com', '/v1', 'not a url', 42, {}]) {
      expect(baseUrlHostIs(bad as never, HOST), String(bad)).toBe(false)
    }
  })
})