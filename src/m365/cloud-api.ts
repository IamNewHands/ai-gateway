/**
 * M365 Cloud API 客户端（移植自 M365-Copilot2API internal/web/m365cloud.go）。
 *
 * 调用 https://m365.cloud.microsoft/chat 的 RefreshNavPane / DeleteConversation
 * 等管理面 API，用于云端对话列表查询与自动清理。
 *
 * 鉴权：从 KV 读取该 provider 的 OAuth token（accessToken），过期自动刷新。
 */
import type { Env } from '../types'
import { getM365Account } from './oauth'
import { unbindByConversation } from './session'

interface CloudChat {
  conversationId?: string
  createTimeUtc?: number
  [key: string]: unknown
}

/** 调用 m365.cloud.microsoft/chat API；oid 指定账号，缺省取账号池第一个 */
async function doCloudAPI(env: Env, providerId: string, action: string, payload: Record<string, unknown>, oid?: string): Promise<Record<string, unknown>> {
  const account = await getM365Account(env, providerId, oid)
  if (!account || !account.accessToken) {
    throw new Error(oid ? `M365 账号 ${oid} 未授权或 token 失效` : 'M365 账号未授权或 token 失效')
  }

  const reqBody: Record<string, unknown> = {
    action,
    ...payload,
  }

  const resp = await fetch('https://m365.cloud.microsoft/chat', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${account.accessToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:148.0) Gecko/20100101 Firefox/148.0',
      'Origin': 'https://m365.cloud.microsoft',
      'Referer': 'https://m365.cloud.microsoft/',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: JSON.stringify(reqBody),
    signal: AbortSignal.timeout(30000),
  })

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`cloud API HTTP ${resp.status}: ${body.substring(0, 300)}`)
  }

  const ct = resp.headers.get('Content-Type') || ''
  if (ct && !ct.includes('application/json')) {
    throw new Error(`unexpected content type from m365 endpoint: ${ct}`)
  }

  const result = (await resp.json()) as Record<string, unknown>
  return result
}

/** 删除云端对话 */
export async function deleteConversation(env: Env, providerId: string, conversationId: string, oid?: string): Promise<void> {
  console.log(`[m365-cloud] deleting conversation ${conversationId}`)
  await doCloudAPI(env, providerId, 'DeleteConversation', {
    conversationId,
    state: {
      conversationPageHistoryList: {
        chats: [],
      },
    },
  }, oid)
}

/** 列出云端对话列表 */
export async function listConversations(env: Env, providerId: string, oid?: string): Promise<CloudChat[]> {
  const result = await doCloudAPI(env, providerId, 'RefreshNavPane', {}, oid)

  const store = result['store'] as Record<string, unknown> | undefined
  if (!store) {
    console.log(`[m365-cloud] unexpected response: ${JSON.stringify(result).substring(0, 200)}`)
    throw new Error('unexpected response format')
  }

  const historyList = store['conversationPageHistoryList'] as Record<string, unknown> | undefined
  if (!historyList) {
    throw new Error('no conversationPageHistoryList')
  }

  const chatsRaw = historyList['chats'] as unknown[] | undefined
  if (!chatsRaw) {
    console.log(`[m365-cloud] chats type: ${typeof historyList['chats']}, value: ${JSON.stringify(historyList['chats']).substring(0, 200)}`)
    throw new Error('no chats')
  }

  const chats: CloudChat[] = []
  for (const raw of chatsRaw) {
    if (typeof raw === 'string') {
      try {
        const chat = JSON.parse(raw) as CloudChat
        chats.push(chat)
      } catch {
        console.log(`[m365-cloud] failed to parse chat string`)
      }
    } else if (typeof raw === 'object' && raw !== null) {
      chats.push(raw as CloudChat)
    } else {
      console.log(`[m365-cloud] unexpected chat type: ${typeof raw}`)
    }
  }

  return chats
}

/**
 * 清理云端旧对话。
 * 微软历史列表是"滑动式"的：RefreshNavPane 一次只返回一屏对话，
 * 删除后旧对话会顶上来，需循环拉取删除直到列表清空。
 * 返回删除数量。
 */
export async function cleanupCloudConversations(
  env: Env,
  providerId: string,
  maxAgeMs: number,
  keepN: number,
  activeConversationIds: Set<string>,
  oid?: string,
): Promise<number> {
  const now = Date.now()
  let deleted = 0
  let kept = 0

  // 云端删除后级联清理本地会话绑定，防止死绑定被复用串号
  const deleteConversationLocal = async (cid: string): Promise<void> => {
    await unbindByConversation(env, providerId, cid)
  }

  for (let round = 0; round < 100; round++) {
    let chats: CloudChat[]
    try {
      chats = await listConversations(env, providerId, oid)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`[m365-cloud] list failed: ${msg}`)
      return deleted
    }
    if (chats.length === 0) break

    let anyDeleted = false
    for (const chat of chats) {
      const convId = chat.conversationId || ''
      if (!convId) continue
      // 活跃对话保护：正在使用中的云端对话不删除
      if (activeConversationIds.has(convId)) continue

      const createTime = typeof chat.createTimeUtc === 'number' ? chat.createTimeUtc : 0
      if (createTime === 0) continue

      const age = now - createTime
      if (age > maxAgeMs) {
        try {
          await deleteConversation(env, providerId, convId, oid)
          await deleteConversationLocal(convId)
          deleted++
          anyDeleted = true
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.log(`[m365-cloud] failed to delete ${convId}: ${msg}`)
        }
      } else {
        if (kept >= keepN) {
          try {
            await deleteConversation(env, providerId, convId, oid)
            await deleteConversationLocal(convId)
            deleted++
            anyDeleted = true
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            console.log(`[m365-cloud] failed to delete ${convId}: ${msg}`)
          }
        } else {
          kept++
        }
      }
    }
    // 本轮没有删除，列表不会再变化
    if (!anyDeleted) break
  }

  console.log(`[m365-cloud] cleanup done(oid=${oid || '*'}): deleted=${deleted} kept=${kept}`)
  return deleted
}