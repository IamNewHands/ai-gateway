/**
 * M365 Cloud API 客户端（移植自 M365-Copilot2API internal/web/m365cloud.go）。
 *
 * 调用 https://m365.cloud.microsoft/chat 的 RefreshNavPane / DeleteConversation
 * 等管理面 API，用于云端对话列表查询与自动清理。
 *
 * 鉴权：用账号 refresh_token 换取 audience 为 https://m365.cloud.microsoft/v2/.default
 * 的专用 token（与 ChatHub 的 substrate token 不同），isolate 内存缓存并临期自动重换。
 */
import type { Env } from '../types'
import { getM365Account, M365_OAUTH } from './oauth'
import { unbindByConversation } from './session'

interface CloudChat {
  conversationId?: string
  createTimeUtc?: number
  [key: string]: unknown
}

/**
 * 换取 m365.cloud.microsoft 管理 API 专用 token。
 * 原版（M365-Copilot2API m365cloud.go）的关键细节：chat 管理面 API 的 audience 是
 * https://m365.cloud.microsoft/v2/.default，不能直接复用 ChatHub 的 substrate token，
 * 需用 refresh_token 向租户端点换取。isolate 内存缓存，临期 2 分钟自动重换。
 */
const cloudTokenCache = new Map<string, { token: string; expiresAt: number }>()

async function getCloudAccessToken(env: Env, providerId: string, oid?: string): Promise<string> {
  const account = await getM365Account(env, providerId, oid)
  if (!account || !account.accessToken) {
    throw new Error(oid ? `M365 账号 ${oid} 未授权或 token 失效` : 'M365 账号未授权或 token 失效')
  }
  if (!account.refreshToken || !account.tid) {
    throw new Error('账号缺少 refresh_token/tid，无法换取 cloud API token')
  }
  const cacheKey = account.oid || providerId
  const cached = cloudTokenCache.get(cacheKey)
  if (cached && cached.expiresAt - Date.now() > 2 * 60 * 1000) return cached.token

  const params = new URLSearchParams({
    client_id: M365_OAUTH.clientId,
    refresh_token: account.refreshToken,
    grant_type: 'refresh_token',
    scope: 'https://m365.cloud.microsoft/v2/.default',
  })
  const res = await fetch(`https://login.microsoftonline.com/${account.tid}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: params.toString(),
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`cloud token exchange HTTP ${res.status}: ${body.substring(0, 200)}`)
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!data.access_token) throw new Error('cloud token exchange 响应缺少 access_token')
  const expiresIn = (data.expires_in || 3600) * 1000
  cloudTokenCache.set(cacheKey, { token: data.access_token, expiresAt: Date.now() + expiresIn })
  return data.access_token
}

/** 调用 m365.cloud.microsoft/chat API；oid 指定账号，缺省取账号池第一个 */
async function doCloudAPI(env: Env, providerId: string, action: string, payload: Record<string, unknown>, oid?: string): Promise<Record<string, unknown>> {
  // chat 管理面 API 需 audience=m365.cloud.microsoft 的专用 token（非 ChatHub 的 substrate token）
  const token = await getCloudAccessToken(env, providerId, oid)

  const reqBody: Record<string, unknown> = {
    action,
    ...payload,
  }

  const resp = await fetch('https://m365.cloud.microsoft/chat', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
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

      // createTimeUtc 缺失视为 0 → age 为极大值 → 按最老处理直接删除（对齐原版 m365cloud.go 语义）
      const createTime = typeof chat.createTimeUtc === 'number' ? chat.createTimeUtc : 0

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