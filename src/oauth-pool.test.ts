import { describe, it, expect, beforeEach } from 'vitest'
import { pickOauthAccount, readOauthPool, type OAuthPool } from './oauth-pool'
import type { Env, OAuthTokenState } from './types'
import { OAUTH_POOL_KV_PREFIX } from './oauth'

const PROVIDER = 'wb-prefer-test'
const poolKey = (p: string) => OAUTH_POOL_KV_PREFIX + p

function makeToken(uid: string, nicknameToUid = uid): OAuthTokenState {
  const payload = btoa(JSON.stringify({ uid }))
  return {
    access_token: `h.${payload}.s`,
    refresh_token: `r-${uid}`,
    token_type: 'Bearer',
    scope: 'all',
    // nickname 无独立字段时用 access_token 占位，测试不依赖
    nickname_to: nicknameToUid,
    expires_at: 0,
  } as unknown as OAuthTokenState
}

function makeAccount(uid: string, over: Partial<OAuthPool[number]> = {}): OAuthPool[number] {
  return {
    uid,
    token: makeToken(uid),
    enabled: true,
    state: { credits: 0, disabled: false, until: 0, errCount: 0 },
    updatedAt: Date.now(),
    ...over,
  }
}

/** 写入一个池（绕过缓存），返回匹配最健康账号的顺序。 */
function seedPool(store: Map<string, string>, accounts: OAuthPool): void {
  store.set(poolKey(PROVIDER), JSON.stringify(accounts))
}

function makeKV(seedAccounts: OAuthPool) {
  const store = new Map<string, string>()
  if (seedAccounts) seedPool(store, seedAccounts)
  return {
    env: { KV: store } as unknown as Env,
    store,
  }
}

describe('手工指定首选账号 pickOauthAccount(preferUid)', () => {
  let kv: ReturnType<typeof makeKV>

  beforeEach(() => {
    const now = Date.now()
    kv = makeKV([
      // credits 最高的是 low，用于验证“首选覆盖积分排序”
      makeAccount('high', { state: { credits: 999, disabled: false, until: 0, errCount: 0 } }),
      makeAccount('low', { state: { credits: 1, disabled: false, until: 0, errCount: 0 } }),
      makeAccount('cold', { state: { credits: 500, disabled: false, until: now + 60000, errCount: 0 } }),
      makeAccount('off', { state: { credits: 999, disabled: true, until: 0, errCount: 0 } }),
    ])
  })

  it('指定首选 uid（low）时，即使积分不是最高也优先选它', async () => {
    const acc = await pickOauthAccount(kv.env, PROVIDER, new Set(), 'low')
    expect(acc).toBeTruthy()
    expect(acc!.uid).toBe('low')
  })

  it('不指定 preferUid 时按剩余积分最高的健康账号挑选', async () => {
    const acc = await pickOauthAccount(kv.env, PROVIDER, new Set())
    expect(acc!.uid).toBe('high')
  })

  it('首选账号被禁用/冷却时不采用，回退到自动挑选', async () => {
    // off 被禁用：首选无效 → 回退积分最高健康账号
    const acc = await pickOauthAccount(kv.env, PROVIDER, new Set(), 'off')
    expect(acc!.uid).toBe('high')
    // cold 冷却中：同样回退
    const acc2 = await pickOauthAccount(kv.env, PROVIDER, new Set(), 'cold')
    expect(acc2!.uid).toBe('high')
  })

  it('首选账号已在 tried 集合中，则跳过并回退自动挑选', async () => {
    const acc = await pickOauthAccount(kv.env, PROVIDER, new Set(['low']), 'low')
    expect(acc!.uid).toBe('high')
  })

  it('首选 uid 不存在于池内时回退自动挑选', async () => {
    const acc = await pickOauthAccount(kv.env, PROVIDER, new Set(), 'ghost-uid')
    expect(acc!.uid).toBe('high')
  })

  it('池内无账号时返回 null', async () => {
    const empty = makeKV([])
    const acc = await pickOauthAccount(empty.env, PROVIDER + '-empty', new Set(), 'low')
    expect(acc).toBeNull()
  })

  it('不污染池缓存：preferUid 不写到 KV（仅做读侧选择）', async () => {
    await pickOauthAccount(kv.env, PROVIDER, new Set(), 'low')
    const pool = await readOauthPool(kv.env, PROVIDER)
    expect(pool.map((a) => a.uid)).toEqual(['high', 'low', 'cold', 'off'])
  })
})