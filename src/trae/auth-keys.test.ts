/**
 * auth-keys.test.ts — 凭据字段诊断（Remote 传输可行性探测）。
 *
 * 背景：Remote 传输的 `common_params` 需要 `webId` / `bizUserId` / `userUniqueId`，而这三个
 * 键不在 `parseAuth` 的读取白名单里 ⇒ 凭据 JSON 里**即便有**也读不出来。本诊断直接读原始
 * JSON 的键名 + accessToken 的 JWT claims，为「要不要移植 Remote」提供事实依据。
 *
 * 两条硬约束（本文件重点验证）：
 *  1. **绝不回传凭据值**：报告里只能出现字段名与长度，任何值本身都不得出现。
 *  2. 位置判定正确：字段可能在 auth / account / root 任一层，也可能只在 JWT claims 里。
 */
import { describe, expect, it } from 'vitest'
import { inspectTraeAuthKeys, TRAE_REMOTE_REQUIRED_FIELD_NAMES } from './upstream'

/** 造一个合法 JWT（不验签，只需 payload 可解）。用 Workers 也可用的 atob/btoa 编码。 */
function makeJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`
}

const REQUIRED = ['webId', 'bizUserId', 'userUniqueId']

describe('inspectTraeAuthKeys：Remote 必需字段探测', () => {
  it('必需字段名清单与 Remote common_params 对齐（三个，不可少）', () => {
    expect([...TRAE_REMOTE_REQUIRED_FIELD_NAMES]).toEqual(REQUIRED)
  })

  it('嵌套形：auth 层带三个字段 → 全部命中且位置为 auth', () => {
    const raw = JSON.stringify({
      auth: {
        accessToken: 'tok',
        refreshToken: 'ref',
        webId: 'w-123456',
        bizUserId: 'biz-abcdef',
        userUniqueId: 'uniq-xyz',
      },
      account: { uid: 'u1', nickname: 'n' },
    })
    const r = inspectTraeAuthKeys(raw)
    expect(r.parseOk).toBe(true)
    expect(r.uid).toBe('u1')
    for (const f of r.requiredFields) {
      expect(f.found).toBe(true)
      expect(f.in).toBe('auth')
      expect(f.length).toBeGreaterThan(0)
    }
    expect(r.requiredFields.map((f) => f.field)).toEqual(REQUIRED)
  })

  it('扁平形：root 层带 snake_case 别名 → 命中且位置为 root', () => {
    const raw = JSON.stringify({
      accessToken: 'tok',
      uid: 'u2',
      web_id: 'w-1',
      biz_user_id: 'b-1',
      user_unique_id: 'uu-1',
    })
    const r = inspectTraeAuthKeys(raw)
    for (const f of r.requiredFields) {
      expect(f.found).toBe(true)
      expect(f.in).toBe('root')
    }
  })

  it('三层都没有、JWT 里也没有 → 全部未命中（这是「需要先解决 webId 来源」的信号）', () => {
    const raw = JSON.stringify({ accessToken: makeJwt({ uid: 'u3' }), uid: 'u3' })
    const r = inspectTraeAuthKeys(raw)
    expect(r.requiredFields.every((f) => !f.found)).toBe(true)
    expect(r.jwtRequiredFields.every((f) => !f.found)).toBe(true)
    expect(r.jwtClaimKeys).toContain('uid')
  })

  it('JSON 里没有、但 JWT claims 里齐全 → jwt 位置命中（可从 token 补）', () => {
    const raw = JSON.stringify({
      accessToken: makeJwt({ uid: 'u4', webId: 'w-jwt', bizUserId: 'b-jwt', userUniqueId: 'uu-jwt' }),
      uid: 'u4',
    })
    const r = inspectTraeAuthKeys(raw)
    expect(r.requiredFields.every((f) => !f.found)).toBe(true)
    for (const f of r.jwtRequiredFields) {
      expect(f.found).toBe(true)
      expect(f.in).toBe('jwt')
    }
  })

  it('**不回传任何凭据值**：报告序列化后不含 token / 字段值本身', () => {
    const secretToken = 'SECRET-ACCESS-TOKEN-VALUE'
    const secretWebId = 'SECRET-WEB-ID-VALUE'
    const raw = JSON.stringify({
      auth: { accessToken: secretToken, webId: secretWebId, bizUserId: 'SECRET-BIZ' },
      account: { uid: 'u5' },
    })
    const serialized = JSON.stringify(inspectTraeAuthKeys(raw))
    expect(serialized).not.toContain(secretToken)
    expect(serialized).not.toContain(secretWebId)
    expect(serialized).not.toContain('SECRET-BIZ')
    // 但字段名与长度必须在（诊断的意义所在）
    expect(serialized).toContain('webId')
    expect(serialized).toContain('accessToken')
  })

  it('空值不算命中（空串 / 空对象都视为缺失）', () => {
    const raw = JSON.stringify({
      accessToken: 'tok',
      uid: 'u6',
      webId: '',
      bizUserId: {},
      userUniqueId: null,
    })
    const r = inspectTraeAuthKeys(raw)
    expect(r.requiredFields.every((f) => !f.found)).toBe(true)
  })

  it('非法 JSON → parseError 有值且不抛异常', () => {
    const r = inspectTraeAuthKeys('{ not json')
    expect(r.parseOk).toBe(false)
    expect(r.parseError).toBeTruthy()
    expect(r.topLevelKeys).toEqual([])
  })

  it('数组顶层 → 判为结构不正确（与 parseAuth 同口径）', () => {
    const r = inspectTraeAuthKeys('[1,2,3]')
    expect(r.parseOk).toBe(false)
    expect(r.parseError).toBe('JSON 结构不正确')
  })

  it('缺 accessToken → parseOk=false，但键名仍被列出（诊断不因解析失败而失效）', () => {
    const raw = JSON.stringify({ webId: 'w-1', bizUserId: 'b-1', userUniqueId: 'uu-1' })
    const r = inspectTraeAuthKeys(raw)
    expect(r.parseOk).toBe(false)
    expect(r.parseError).toContain('accessToken')
    // 关键：解析失败不妨碍字段探测 —— 这正是本诊断存在的理由
    expect(r.requiredFields.every((f) => f.found)).toBe(true)
  })

  it('可选字段（有默认值、不阻塞建会话）单独列出且不混入必需项', () => {
    const raw = JSON.stringify({
      accessToken: 'tok',
      uid: 'u7',
      scope: 'marscode-cn',
      tenant: 'marscode',
    })
    const r = inspectTraeAuthKeys(raw)
    const optFound = r.optionalFields.filter((f) => f.found).map((f) => f.field).sort()
    expect(optFound).toEqual(['scope', 'tenant'])
    // 可选字段不得污染必需字段结论
    expect(r.requiredFields.every((f) => !f.found)).toBe(true)
  })

  it('顶层键名按字典序返回（面板展示稳定）', () => {
    const raw = JSON.stringify({ zeta: 1, alpha: 2, mid: 3, accessToken: 'tok', uid: 'u8' })
    const r = inspectTraeAuthKeys(raw)
    expect(r.topLevelKeys).toEqual([...r.topLevelKeys].sort())
  })
})
