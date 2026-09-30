/**
 * deepseek/admin.ts — deepseek-app 的管理接口（token 注入 / 判活 / 删除 / 池状态）。
 *
 * 为什么需要「注入」而不是「登录」：上游硬卡密码登录（真实浏览器同样 `biz_code 11`），
 * 短信登录又需要浏览器侧 Shumei `rid`，无头进程两条都走不了。所以获取凭据的唯一途径是
 * 人从浏览器里取一次 token —— 这些接口就是那条通路。
 *
 * 取 token 的操作步骤（同时随接口返回，便于面板直接展示）：
 *   1. 浏览器登录 https://chat.deepseek.com
 *   2. F12 → Application → Local Storage → https://chat.deepseek.com
 *   3. 复制 `userToken` 的值（形如 {"value":"<64 字符>","__version":…}），**只要 value 里的那 64 字符**
 *   4. 复制 `deepseek-device-id:chat` 的值（UUID）作为 headerDeviceId
 *   5. 把两者贴进来；浏览器 UA 可留空（留空则用内置 Chrome UA）
 *
 * 接口（全部挂在 `/admin/api/deepseek/:id/...`，`:id` = provider id）：
 *   GET    /tokens              池状态（脱敏）
 *   POST   /tokens              注入一条（注入后立即判活）
 *   POST   /tokens/verify       重新判活（body.tokenId）
 *   POST   /tokens/remove       删除（body.tokenId）
 */

import { Context } from 'hono'
import type { ApiResponse, AppEnv } from '../types'
import { getProvider } from '../storage'
import { MAX_ADMIN_REQUEST_BYTES, readOptionalJSONLimited } from '../request-body'
import {
  addDeepseekToken,
  readDeepseekPool,
  removeDeepseekToken,
  type DeepseekTokenRecord,
} from './pool'
import { deepseekPoolView, verifyDeepseekToken } from './proxy'

/** 取 token 的操作指引（面板与接口响应共用一份，避免两处描述漂移）。 */
export const DEEPSEEK_TOKEN_HOWTO = [
  '浏览器登录 https://chat.deepseek.com',
  'F12 → Application → Local Storage → https://chat.deepseek.com',
  '取 userToken 的值（形如 {"value":"<64字符>","__version":…}），只填 value 里那 64 字符',
  '取 deepseek-device-id:chat 的值（UUID）作为 headerDeviceId',
].join('；')

async function requireProvider(c: Context<AppEnv>, id: string) {
  if (!id) return { provider: null, error: c.json<ApiResponse>({ success: false, message: '缺少 id 参数' }, 400) }
  const provider = await getProvider(c.env, id)
  if (!provider) return { provider: null, error: c.json<ApiResponse>({ success: false, message: '提供商不存在' }, 404) }
  return { provider, error: null }
}

/** GET /admin/api/deepseek/:id/tokens */
export async function handleDeepseekTokensList(c: Context<AppEnv>) {
  const id = c.req.param('id') || ''
  const { provider, error } = await requireProvider(c, id)
  if (error) return error
  const tokens = await readDeepseekPool(c.env)
  const view = deepseekPoolView(tokens)
  return c.json<ApiResponse>({
    success: true,
    data: {
      providerId: provider!.id,
      ...view,
      howto: DEEPSEEK_TOKEN_HOWTO,
      // 失效提示：池里只要有 expired，就把「需重新注入」明确说出来，不静默
      notice:
        view.summary.total === 0
          ? '池是空的：请按 howto 注入一条 token'
          : view.summary.expired > 0
            ? `有 ${view.summary.expired} 条 token 已失效，请删除后重新注入`
            : '',
    },
  })
}

/** POST /admin/api/deepseek/:id/tokens —— 注入并立即判活。 */
export async function handleDeepseekTokenAdd(c: Context<AppEnv>) {
  const id = c.req.param('id') || ''
  const { provider, error } = await requireProvider(c, id)
  if (error) return error

  const body = await readOptionalJSONLimited<{
    token?: string
    headerDeviceId?: string
    userAgent?: string
    label?: string
    shumeiDeviceId?: string
  }>(c.req.raw, MAX_ADMIN_REQUEST_BYTES)

  const raw = (body.token || '').trim()
  // 用户常把整个 {"value":"…","__version":…} 贴进来：这里容错解析，省一次来回
  let token = raw
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as { value?: unknown }
      if (typeof parsed.value === 'string') token = parsed.value.trim()
    } catch {
      /* 保持原样，交由下面的格式校验报错 */
    }
  }
  if (!token) {
    return c.json<ApiResponse>({ success: false, message: `缺少 token。取法：${DEEPSEEK_TOKEN_HOWTO}` }, 400)
  }
  if (token.length < 40) {
    return c.json<ApiResponse>(
      { success: false, message: 'token 长度不像 DeepSeek 的 64 字符会话 token；请确认复制的是 userToken 的 value' },
      400,
    )
  }

  const profile: DeepseekTokenRecord = {
    id: 'pending-verify',
    token,
    headerDeviceId: (body.headerDeviceId || '').trim(),
    userAgent: (body.userAgent || '').trim(),
    state: 'ready',
    addedAt: Date.now(),
  }

  // 先判活再入库：避免把一条明显无效的 token 写进池里让后续请求白跑
  const verify = await verifyDeepseekToken(c.env, profile, { persist: false })
  const added = await addDeepseekToken(c.env, {
    token,
    headerDeviceId: profile.headerDeviceId || 'unknown',
    userAgent: profile.userAgent,
    shumeiDeviceId: body.shumeiDeviceId,
    label: body.label,
  })

  if (!added.ok) {
    return c.json<ApiResponse>(
      {
        success: false,
        message: added.duplicate ? '这条 token 已经在池里了' : (added.error || '注入失败'),
        data: { duplicateId: added.duplicate?.id },
      },
      added.duplicate ? 409 : 400,
    )
  }

  if (!verify.ok) {
    const { markDeepseekToken } = await import('./pool')
    await markDeepseekToken(c.env, added.record!.id, { state: verify.state, error: verify.detail })
  }

  return c.json<ApiResponse>({
    success: verify.ok,
    message: verify.ok ? `token 已注入并判活通过（${verify.detail}）` : `token 已注入，但判活失败：${verify.detail}`,
    data: {
      id: added.record!.id,
      verified: verify.ok,
      state: verify.state,
      account: verify.account,
      howto: DEEPSEEK_TOKEN_HOWTO,
    },
  })
}

/** POST /admin/api/deepseek/:id/tokens/verify —— 重新判活（token 会过期，面板需要能复检）。 */
export async function handleDeepseekTokenVerify(c: Context<AppEnv>) {
  const id = c.req.param('id') || ''
  const { provider, error } = await requireProvider(c, id)
  if (error) return error
  const body = await readOptionalJSONLimited<{ tokenId?: string }>(c.req.raw, MAX_ADMIN_REQUEST_BYTES)
  const tokenId = (body.tokenId || '').trim()
  if (!tokenId) return c.json<ApiResponse>({ success: false, message: '缺少 tokenId' }, 400)

  const tokens = await readDeepseekPool(c.env)
  const rec = tokens.find((t) => t.id === tokenId)
  if (!rec) return c.json<ApiResponse>({ success: false, message: 'token 不存在' }, 404)

  const result = await verifyDeepseekToken(c.env, rec)
  return c.json<ApiResponse>({
    success: result.ok,
    message: result.detail,
    data: { id: tokenId, state: result.state, account: result.account },
  })
}

/** POST /admin/api/deepseek/:id/tokens/remove */
export async function handleDeepseekTokenRemove(c: Context<AppEnv>) {
  const id = c.req.param('id') || ''
  const { provider, error } = await requireProvider(c, id)
  if (error) return error
  const body = await readOptionalJSONLimited<{ tokenId?: string }>(c.req.raw, MAX_ADMIN_REQUEST_BYTES)
  const tokenId = (body.tokenId || '').trim()
  if (!tokenId) return c.json<ApiResponse>({ success: false, message: '缺少 tokenId' }, 400)

  const removed = await removeDeepseekToken(c.env, tokenId)
  if (!removed) return c.json<ApiResponse>({ success: false, message: 'token 不存在' }, 404)
  return c.json<ApiResponse>({
    success: true,
    message: '已删除',
    data: { id: removed.id, removedTail: removed.token.slice(-6) },
  })
}
