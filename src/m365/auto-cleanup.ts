/**
 * M365 自动清理（移植自 M365-Copilot2API internal/web/auto_cleanup.go）。
 *
 * 对标 DeepSeek 磁盘缓存的闲置回收：对话即缓存条目，
 * 命中（会话复用）自动刷新存活时间，长期闲置或超出数量上限的条目
 * 由 Cron 定时任务回收，防止滥用/测试把云端对话堆满触发封号。
 *
 * 清理策略：
 * - 闲置超过 maxAge（默认 2 小时）的云端对话 → 删除
 * - 保留最多 keepN（默认 5）个对话
 * - 活跃对话（在白名单/会话窗口/最近使用内）受保护，永不回收
 * - 删除云端对话后联动清理本地索引与防串号绑定
 */
import type { Env, Provider } from '../types'
import { getProviders } from '../storage'
import { isM365Provider } from './proxy'
import { cleanupCloudConversations } from './cloud-api'
import { listConversations, whitelistedIDs, getCleanupConfig } from './conversation-manager'
import { listSessions, cleanupSessions } from './session'

/**
 * 收集活跃对话 ID 集合（受保护的对话，不会被清理）。
 * 活跃对话包括：
 * - 白名单中的对话
 * - 会话绑定窗口内的对话（最近使用过）
 * - 对话管理器记录的最近使用的对话
 */
async function activeConversationSet(env: Env, providerId: string, windowMs: number): Promise<Set<string>> {
  const active = new Set<string>()

  // 白名单
  const whitelist = await whitelistedIDs(env, providerId)
  for (const id of whitelist) active.add(id)

  // 会话绑定中的活跃对话
  const sessions = await listSessions(env, providerId)
  const cutoff = Date.now() - windowMs
  for (const s of sessions) {
    if (s.lastUsedAt > cutoff) {
      active.add(s.conversationId)
    }
  }

  // 对话管理器中的最近使用对话
  const conversations = await listConversations(env, providerId)
  for (const c of conversations) {
    if (c.lastUsedAt > cutoff) {
      active.add(c.id)
    }
  }

  return active
}

/**
 * 对单个 M365 提供商执行自动清理。
 * 返回清理的对话数量。
 */
export async function autoCleanupProvider(env: Env, provider: Provider): Promise<number> {
  const { id: providerId } = provider

  // 清理过期会话绑定
  await cleanupSessions(env, providerId)

  const config = await getCleanupConfig(env, providerId)
  const maxAgeMs = config.maxAgeHours * 60 * 60 * 1000
  const keepN = config.keepN

  // 活跃对话保护窗口（与 maxAge 一致）
  const activeIds = await activeConversationSet(env, providerId, maxAgeMs)

  console.log(`[auto-cleanup] provider=${providerId} maxAge=${config.maxAgeHours}h keepN=${keepN} active=${activeIds.size}`)

  let deleted = 0
  try {
    deleted = await cleanupCloudConversations(env, providerId, maxAgeMs, keepN, activeIds)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[auto-cleanup] provider=${providerId} cleanup failed: ${msg}`)
    return 0
  }

  if (deleted > 0) {
    console.log(`[auto-cleanup] provider=${providerId} removed ${deleted} idle conversations`)
  }

  return deleted
}

/**
 * 对所有 M365 提供商执行自动清理（Cron 入口）。
 * 返回清理结果汇总。
 */
export async function autoCleanupAll(env: Env): Promise<{ total: number; providers: number; errors: number }> {
  const providers = (await getProviders(env)) as Provider[]
  const m365Providers = providers.filter((p) => isM365Provider(p))

  if (m365Providers.length === 0) {
    console.log('[auto-cleanup] no M365 providers found')
    return { total: 0, providers: 0, errors: 0 }
  }

  let totalDeleted = 0
  let errorCount = 0

  for (const provider of m365Providers) {
    try {
      const deleted = await autoCleanupProvider(env, provider)
      totalDeleted += deleted
    } catch (err) {
      errorCount++
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`[auto-cleanup] provider=${provider.id} error: ${msg}`)
    }
  }

  console.log(`[auto-cleanup] done: total=${totalDeleted} providers=${m365Providers.length} errors=${errorCount}`)
  return { total: totalDeleted, providers: m365Providers.length, errors: errorCount }
}