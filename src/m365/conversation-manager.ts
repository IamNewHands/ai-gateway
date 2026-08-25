/**
 * M365 对话管理器（移植自 M365-Copilot2API internal/web/conversation_manager.go）。
 *
 * 管理云端对话的本地元数据（记录/列表/白名单/清理模式），
 * 配合 auto-cleanup.ts 实现云端对话的自动回收。
 *
 * 清理模式：
 * - after_response：每次对话结束后清理超过 30s 未使用的对话（默认）
 * - keep_n：保留最近 N 个对话
 * - max_age：删除超过 maxAge 的对话
 * - on_exit：不自动清理
 *
 * 存储：KV（每 provider 一个 JSON 对象），格式：
 *   { conversations: { [id]: ManagedConversation }, whitelist: string[] }
 */
import type { Env } from '../types'

export type CleanupMode = 'after_response' | 'keep_n' | 'max_age' | 'on_exit'

export interface ManagedConversation {
  id: string
  accountId: string
  createdAt: number
  lastUsedAt: number
  title?: string
}

interface ConversationPersist {
  conversations: Record<string, ManagedConversation>
  whitelist: string[]
}

const CONVERSATION_PREFIX = 'm365:conversations:'

function kvKey(providerId: string): string {
  return CONVERSATION_PREFIX + providerId
}

async function readPersist(env: Env, providerId: string): Promise<ConversationPersist> {
  try {
    const raw = await env.KV.get(kvKey(providerId))
    if (!raw) return { conversations: {}, whitelist: [] }
    const p = JSON.parse(raw) as Partial<ConversationPersist>
    return {
      conversations: (p.conversations && typeof p.conversations === 'object') ? p.conversations : {},
      whitelist: Array.isArray(p.whitelist) ? p.whitelist : [],
    }
  } catch {
    return { conversations: {}, whitelist: [] }
  }
}

async function writePersist(env: Env, providerId: string, p: ConversationPersist): Promise<void> {
  try {
    await env.KV.put(kvKey(providerId), JSON.stringify(p), { expirationTtl: 30 * 24 * 60 * 60 })
  } catch { /* 写入失败不影响主流程 */ }
}

/** 记录一条对话（已存在时保留原 createdAt，同原版 conversation_manager.go） */
export async function recordConversation(env: Env, providerId: string, conversationId: string, accountId: string, title?: string): Promise<void> {
  const p = await readPersist(env, providerId)
  const now = Date.now()
  const existing = p.conversations[conversationId]
  p.conversations[conversationId] = {
    id: conversationId,
    accountId,
    createdAt: existing?.createdAt || now,
    lastUsedAt: now,
    title: title || existing?.title,
  }
  await writePersist(env, providerId, p)
  console.log(`[conversation-manager] recorded conversation ${conversationId}`)
}

/** 更新对话最近使用时间 */
export async function touchConversation(env: Env, providerId: string, conversationId: string): Promise<void> {
  const p = await readPersist(env, providerId)
  const c = p.conversations[conversationId]
  if (c) {
    c.lastUsedAt = Date.now()
    await writePersist(env, providerId, p)
  }
}

/** 添加白名单（保护对话不被自动清理） */
export async function whitelistConversation(env: Env, providerId: string, conversationId: string): Promise<void> {
  const p = await readPersist(env, providerId)
  if (!p.whitelist.includes(conversationId)) {
    p.whitelist.push(conversationId)
    await writePersist(env, providerId, p)
  }
}

/** 移除白名单 */
export async function unwhitelistConversation(env: Env, providerId: string, conversationId: string): Promise<void> {
  const p = await readPersist(env, providerId)
  p.whitelist = p.whitelist.filter((id) => id !== conversationId)
  await writePersist(env, providerId, p)
}

/** 是否在白名单中 */
export async function isWhitelisted(env: Env, providerId: string, conversationId: string): Promise<boolean> {
  const p = await readPersist(env, providerId)
  return p.whitelist.includes(conversationId)
}

/** 获取白名单 ID 列表 */
export async function whitelistedIDs(env: Env, providerId: string): Promise<string[]> {
  const p = await readPersist(env, providerId)
  return [...p.whitelist]
}

/** 删除本地对话记录 */
export async function deleteConversationRecord(env: Env, providerId: string, conversationId: string): Promise<void> {
  const p = await readPersist(env, providerId)
  delete p.conversations[conversationId]
  await writePersist(env, providerId, p)
  console.log(`[conversation-manager] deleted conversation ${conversationId}`)
}

/** 列出本地对话记录 */
export async function listConversations(env: Env, providerId: string): Promise<ManagedConversation[]> {
  const p = await readPersist(env, providerId)
  return Object.values(p.conversations)
}

/**
 * 按清理模式执行本地清理，返回需要删除的云端对话 ID 列表。
 * 调用方负责调用云端 API 删除并联动清理本地记录和会话绑定。
 */
export async function cleanupConversations(
  env: Env,
  providerId: string,
  mode: CleanupMode,
  keepN: number,
  maxAgeMs: number,
  activeIds: Set<string>,
): Promise<string[]> {
  const p = await readPersist(env, providerId)
  const whitelistSet = new Set(p.whitelist)
  const toDelete: string[] = []
  const now = Date.now()

  const entries = Object.entries(p.conversations)

  switch (mode) {
    case 'after_response': {
      for (const [id, c] of entries) {
        if (whitelistSet.has(id)) continue
        if (activeIds.has(id)) continue
        if (now - c.lastUsedAt > 30_000) {
          toDelete.push(id)
        }
      }
      break
    }
    case 'max_age': {
      const cutoff = now - maxAgeMs
      for (const [id, c] of entries) {
        if (whitelistSet.has(id)) continue
        if (activeIds.has(id)) continue
        if (c.createdAt < cutoff) {
          toDelete.push(id)
        }
      }
      break
    }
    case 'keep_n': {
      if (entries.length > keepN) {
        const sorted = [...entries].sort((a, b) => b[1].lastUsedAt - a[1].lastUsedAt)
        for (let i = keepN; i < sorted.length; i++) {
          const [id] = sorted[i]
          if (whitelistSet.has(id)) continue
          if (activeIds.has(id)) continue
          toDelete.push(id)
        }
      }
      break
    }
    case 'on_exit':
      // 不自动清理
      break
  }

  for (const id of toDelete) {
    delete p.conversations[id]
  }

  if (toDelete.length > 0) {
    await writePersist(env, providerId, p)
    console.log(`[conversation-manager] cleaned up ${toDelete.length} conversations`)
  }

  return toDelete
}

/** 获取清理模式（从 KV 存储的环境配置读取，默认 after_response） */
export async function getCleanupMode(env: Env, providerId: string): Promise<CleanupMode> {
  const key = `m365:cleanup:mode:${providerId}`
  const raw = await env.KV.get(key)
  if (raw === 'keep_n' || raw === 'max_age' || raw === 'on_exit') return raw
  return 'after_response'
}

/** 设置清理模式 */
export async function setCleanupMode(env: Env, providerId: string, mode: CleanupMode): Promise<void> {
  await env.KV.put(`m365:cleanup:mode:${providerId}`, mode)
}

/** 获取清理配置 (keepN, maxAgeHours) */
export async function getCleanupConfig(env: Env, providerId: string): Promise<{ keepN: number; maxAgeHours: number }> {
  const key = `m365:cleanup:config:${providerId}`
  const raw = await env.KV.get(key)
  try {
    if (raw) {
      const cfg = JSON.parse(raw) as { keepN?: number; maxAgeHours?: number }
      return { keepN: cfg.keepN || 5, maxAgeHours: cfg.maxAgeHours || 2 }
    }
  } catch { /* fall through */ }
  return { keepN: 5, maxAgeHours: 2 }
}

/** 设置清理配置 */
export async function setCleanupConfig(env: Env, providerId: string, keepN: number, maxAgeHours: number): Promise<void> {
  await env.KV.put(`m365:cleanup:config:${providerId}`, JSON.stringify({ keepN, maxAgeHours }))
}

/** 判断是否需要清理（on_exit 模式除外） */
export async function shouldCleanup(env: Env, providerId: string): Promise<boolean> {
  const mode = await getCleanupMode(env, providerId)
  return mode !== 'on_exit'
}