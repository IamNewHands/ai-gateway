/**
 * session-registry.test.ts — Remote 存活会话登记表 + 僵尸回收。
 *
 * ## 为什么需要这张表（最后一条泄漏路径）
 *
 * 正常出口（`onDone` / `onClose` / 失败路径 / 非流式成功）都要求**当前请求的隔离进程
 * 还活着**。隔离进程若在「建好会话」与「发出 stop」之间死掉（Worker 被驱逐、CPU 超限），
 * 那个上游会话仍在跑、仍占着账号并发槽位，而**再没人知道它的 id** —— 于是永久泄漏，
 * 积满上限 2 之后新会话只排队、executor 不启动（2026-10-14 现场）。
 *
 * 表的作用就是把「谁还活着」这件事从进程内存搬到 KV，让 cron 能兜底。
 *
 * ## 本文件钉住的四条
 *
 * 1. **租约判活**：活会话（续期新鲜）绝不被回收；僵尸（续期陈旧）必须被回收。
 * 2. **touch 绝不复活已摘除的记录**：否则「续期在途 + 回收已完成」会把死会话写回表里。
 * 3. **停不掉也要摘登记**：账号已被移除时无法构造鉴权头，但记录留着只会让每轮 cron
 *    白重试一次。
 * 4. **登记表故障绝不影响对话**：KV 全挂时所有函数都不抛。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquireTraeSession } from './pool'
import {
  TRAE_REMOTE_LEASE_STALE_MS,
  TRAE_REMOTE_LEASE_TOUCH_MS,
  listRemoteSessions,
  reapRemoteSessions,
  registerRemoteSession,
  touchRemoteSession,
  unregisterRemoteSession,
  type TraeRemoteSessionRecord,
} from './session-registry'

const UID = 'u_reap'

afterEach(() => { vi.unstubAllGlobals() })

function makeEnv(): any {
  const data = new Map<string, string>()
  return {
    KV: {
      data,
      async get(k: string) { return data.get(k) ?? null },
      async put(k: string, v: string) { data.set(k, v) },
      async delete(k: string) { data.delete(k) },
      async list({ prefix }: { prefix: string }) {
        return { keys: [...data.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }
      },
    },
  }
}

function makeProvider(apiKeys?: unknown[]): any {
  return {
    id: 'trae-reap',
    name: 'TRAE Remote',
    baseUrl: 'https://trae-api-cn.mchost.guru',
    traeUpstreamEndpoint: 'remote',
    apiKeys: apiKeys ?? [{
      key: JSON.stringify({ uid: UID, token: 'tok_reap', refreshToken: 'ref_reap', expiresAt: Date.now() + 3600_000 }),
      enabled: true,
    }],
    models: [{ id: 'glm-5.2', enabled: true }],
  }
}

function rec(sessionId: string, lastSeenAt: number): TraeRemoteSessionRecord {
  return {
    uid: UID,
    sessionId,
    messageId: `m-${sessionId}`,
    agentType: 'solo_work_remote',
    startedAt: lastSeenAt,
    lastSeenAt,
  }
}

/** 从 KV 里读出该账号的本地并发计数（不依赖 pool 的 key 前缀写法）。 */
function poolActiveSessions(env: any): number {
  const key = [...env.KV.data.keys()].find((k: string) => k.includes('pool'))
  if (!key) return 0
  const pool = JSON.parse(env.KV.data.get(key) as string)
  return pool?.[UID]?.activeSessions ?? 0
}

describe('登记表：写 / 读 / 续期 / 摘除', () => {
  it('register → list 往返，记录内容不丢', async () => {
    const env = makeEnv()
    await registerRemoteSession(env, 'p', rec('s1', 111))
    const got = await listRemoteSessions(env, 'p')
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ sessionId: 's1', messageId: 'm-s1', agentType: 'solo_work_remote', lastSeenAt: 111 })
  })

  it('list 按 provider 前缀隔离：不会看到别的 provider 的会话', async () => {
    const env = makeEnv()
    await registerRemoteSession(env, 'p1', rec('a', 1))
    await registerRemoteSession(env, 'p2', rec('b', 1))
    expect((await listRemoteSessions(env, 'p1')).map((r) => r.sessionId)).toEqual(['a'])
    expect((await listRemoteSessions(env, 'p2')).map((r) => r.sessionId)).toEqual(['b'])
  })

  it('touch 刷新 lastSeenAt —— 这是租约续期的全部作用', async () => {
    const env = makeEnv()
    await registerRemoteSession(env, 'p', rec('s1', 100))
    await touchRemoteSession(env, 'p', rec('s1', 100))
    const [got] = await listRemoteSessions(env, 'p')
    expect(got.lastSeenAt).toBeGreaterThan(100)
  })

  /**
   * 回归点：`touch` 必须**先读后写**。KV 没有 CAS，若直接 `put`，
   * 「续期请求在途」+「回收已完成」的竞态会把已回收的会话重新写回表里，
   * 于是 reaper 永远追不上它。
   */
  it('touch 绝不复活已摘除的记录', async () => {
    const env = makeEnv()
    await registerRemoteSession(env, 'p', rec('s1', 100))
    await unregisterRemoteSession(env, 'p', 's1')
    await touchRemoteSession(env, 'p', rec('s1', 999))
    expect(await listRemoteSessions(env, 'p')).toEqual([])
  })

  it('unregister 幂等：摘一个不存在的记录不抛错', async () => {
    const env = makeEnv()
    await expect(unregisterRemoteSession(env, 'p', 'never')).resolves.toBeUndefined()
  })
})

describe('reapRemoteSessions：只回收租约陈旧的会话', () => {
  it('活会话（续期新鲜）不动；僵尸（续期陈旧）发 stop 并摘除', async () => {
    const env = makeEnv()
    const provider = makeProvider()
    const stopped: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/stop')) stopped.push(String(url))
      return new Response('{}', { status: 200 })
    }))

    const now = 10_000_000
    await registerRemoteSession(env, provider.id, rec('alive', now - 1_000))
    await registerRemoteSession(env, provider.id, rec('zombie', now - 10 * 60_000))

    const r = await reapRemoteSessions(env, provider, { now })
    expect(r).toMatchObject({ scanned: 2, reaped: 1, skipped: 1, failed: 0 })
    expect(stopped).toHaveLength(1)
    expect(stopped[0]).toContain('/zombie/stop')
    // 停掉的摘除、活着的留下
    expect((await listRemoteSessions(env, provider.id)).map((s) => s.sessionId)).toEqual(['alive'])
  })

  it('表为空时不发任何请求', async () => {
    const env = makeEnv()
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    const r = await reapRemoteSessions(env, makeProvider(), { now: 1 })
    expect(r).toMatchObject({ scanned: 0, reaped: 0 })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  /**
   * 账号已不在池里 → 无法构造鉴权头，停不掉。但**仍要摘登记**：
   * 留着它只会让每 5 分钟的 cron 白重试一次，永远停不下来。
   */
  it('账号已移除 → 停不掉（不计 reaped），但仍摘登记避免无限重试', async () => {
    const env = makeEnv()
    const provider = makeProvider([])
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    const now = 5_000_000
    await registerRemoteSession(env, provider.id, rec('orphan', now - 10 * 60_000))

    const r = await reapRemoteSessions(env, provider, { now })
    expect(r).toMatchObject({ scanned: 1, reaped: 0, failed: 1 })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(await listRemoteSessions(env, provider.id)).toEqual([])
  })

  it('阈值必须是续期间隔的 3 倍以上：一次续期抖动不得误杀活会话', () => {
    expect(TRAE_REMOTE_LEASE_STALE_MS).toBeGreaterThanOrEqual(TRAE_REMOTE_LEASE_TOUCH_MS * 3)
  })

  /**
   * 回归点：reaper 停掉的是**上游**会话，而 `pickTraeAccount` 的并发判定读的是 KV 里的
   * `activeSessions`。只停上游不减计数，账号会一直被跳过 —— 泄漏的槽位只是从「上游占满」
   * 变成「本地占满」，症状一模一样（503 no_healthy_account）。
   */
  it('回收僵尸时同时减掉本地并发计数', async () => {
    const env = makeEnv()
    const provider = makeProvider()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))

    await acquireTraeSession(env, provider.id, UID, true)
    expect(poolActiveSessions(env)).toBe(1)

    const now = 9_000_000
    await registerRemoteSession(env, provider.id, rec('zombie', now - 10 * 60_000))
    await reapRemoteSessions(env, provider, { now })

    expect(poolActiveSessions(env)).toBe(0)
  })
})

describe('登记表故障绝不影响对话', () => {
  it('KV 全抛异常时，四个函数都不抛、list 返回空', async () => {
    const boom = async () => { throw new Error('kv down') }
    const env = { KV: { get: boom, put: boom, delete: boom, list: boom } } as any
    const r = rec('s', 0)
    await expect(registerRemoteSession(env, 'p', r)).resolves.toBeUndefined()
    await expect(touchRemoteSession(env, 'p', r)).resolves.toBeUndefined()
    await expect(unregisterRemoteSession(env, 'p', 's')).resolves.toBeUndefined()
    await expect(listRemoteSessions(env, 'p')).resolves.toEqual([])
    // reaper 也要能安全降级：KV 挂了当作「没有僵尸」，宁可漏收也不误杀
    await expect(reapRemoteSessions(env, makeProvider(), { now: 1 })).resolves.toMatchObject({ scanned: 0, reaped: 0 })
  })
})
