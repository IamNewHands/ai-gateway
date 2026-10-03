import { describe, it, expect } from 'vitest'
import { parseJwtClaims } from './workbuddy-upstream'

/**
 * parseJwtClaims 的 UTF-8 解码回归测试。
 *
 * 背景（用户实测 2026-10）：账号池昵称显示成 `å¦¹` / `å¿«å¿«ä¹ä¹` 这类乱码。
 * 根因是 `JSON.parse(atob(segment))` —— atob 返回「每字符 = 一字节」的 Latin-1 串，
 * UTF-8 多字节昵称被逐字节当成独立字符。修复：还原字节后用 TextDecoder('utf-8') 解码。
 */

/** 用 UTF-8 字节构造 base64url JWT 段（测试侧不依赖被测实现）。 */
function makeJwt(payload: Record<string, unknown>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload))
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `eyJhbGciOiJIUzI1NiJ9.${b64}.sig`
}

describe('parseJwtClaims：UTF-8 昵称解码', () => {
  it('中文昵称不再乱码（妹 → å¦¹ 是 Latin-1 误读的典型形态）', () => {
    const claims = parseJwtClaims(makeJwt({ uid: 'u-1', nickname: '妹' }))
    expect(claims.nickname).toBe('妹')
    expect(claims.nickname).not.toBe('å¦¹')
  })

  it('多字中文昵称完整还原（快快乐乐）', () => {
    expect(parseJwtClaims(makeJwt({ uid: 'u-2', nickname: '快快乐乐' })).nickname).toBe('快快乐乐')
  })

  it('emoji 与中英混排（4 字节码点也不截断）', () => {
    expect(parseJwtClaims(makeJwt({ uid: 'u-3', nickname: '猫猫🐱travel' })).nickname).toBe('猫猫🐱travel')
  })

  it('ASCII 昵称保持原样（回归：修复不得破坏原路径）', () => {
    expect(parseJwtClaims(makeJwt({ uid: 'u-4', nickname: 'Shiro' })).nickname).toBe('Shiro')
  })

  it('uid / enterpriseId / domain 同步解析且不受昵称编码影响', () => {
    const claims = parseJwtClaims(makeJwt({
      uid: 'ba670e9d-9deb-4d4e-8ee4-0e10719f647e',
      enterprise_id: 'ent-9',
      nickname: '妹妹',
      domain: 'codebuddy.cn',
    }))
    expect(claims).toEqual({
      uid: 'ba670e9d-9deb-4d4e-8ee4-0e10719f647e',
      enterpriseId: 'ent-9',
      nickname: '妹妹',
      domain: 'codebuddy.cn',
    })
  })

  it('昵称字段回退顺序：nickname → name → username', () => {
    expect(parseJwtClaims(makeJwt({ uid: 'u-5', name: '名字' })).nickname).toBe('名字')
    expect(parseJwtClaims(makeJwt({ uid: 'u-6', username: '账号' })).nickname).toBe('账号')
  })

  it('非法/非 JWT token 返回空字段而不抛错', () => {
    for (const bad of ['', 'not-a-jwt', 'a.b', 'a.!!!.c']) {
      const claims = parseJwtClaims(bad)
      expect(claims.nickname).toBe('')
      expect(claims.uid).toBe('')
    }
  })
})
