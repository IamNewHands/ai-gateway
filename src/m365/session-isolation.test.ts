import { describe, it, expect, beforeEach } from 'vitest'
import { listSessions, deleteSession } from './session'

function makeKV() {
  const store = new Map<string, string>()
  return {
    env: {
      KV: {
        async get(key: string) { return store.get(key) ?? null },
        async put(key: string, value: string) { store.set(key, value); return undefined },
      },
    } as any,
    store,
  }
}

function seed(store: Map<string, string>, providerId: string) {
  const now = Date.now()
  const list = [
    { sessionId: 'sess-a', conversationId: 'conv-a', accountId: 'oid-a', tenant: 'tenantA', createdAt: now, lastUsedAt: now },
    { sessionId: 'sess-b', conversationId: 'conv-b', accountId: 'oid-b', tenant: 'tenantB', createdAt: now, lastUsedAt: now },
  ]
  // 与 session.ts kvKey（m365:sessions:<provider>）一致
  store.set(`m365:sessions:${providerId}`, JSON.stringify(list))
}

describe('#57 会话租户隔离', () => {
  let kv: { env: any; store: Map<string, string> }

  beforeEach(() => {
    kv = makeKV()
    seed(kv.store, 'm365-p')
  })

  it('listSessions 传 tenant 时只返回该租户会话', async () => {
    const tenantA = await listSessions(kv.env, 'm365-p', 'tenantA')
    expect(tenantA.map((s) => s.sessionId)).toEqual(['sess-a'])
    const all = await listSessions(kv.env, 'm365-p')
    expect(all.length).toBe(2)
  })

  it('deleteSession 仅删除属于该租户的会话', async () => {
    const ok = await deleteSession(kv.env, 'm365-p', 'sess-a', 'tenantA')
    expect(ok).toBe(true)
    // 剩下的会话里不再有 sess-a，仍有 sess-b
    const all = await listSessions(kv.env, 'm365-p')
    expect(all.map((s) => s.sessionId)).toEqual(['sess-b'])
  })

  it('跨租户试图删除他人会话时返回 false（隔离保护）', async () => {
    const ok = await deleteSession(kv.env, 'm365-p', 'sess-b', 'tenantA')
    expect(ok).toBe(false)
    const all = await listSessions(kv.env, 'm365-p')
    expect(all.map((s) => s.sessionId).sort()).toEqual(['sess-a', 'sess-b'])
  })
})