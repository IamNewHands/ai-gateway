/**
 * device.ts — Qoder 真机设备身份（KV 存储，管理后台可配置）。
 *
 * 为什么需要它（2026-10-02 调研四个同类项目 + qoder2api-hub 源码，结论一致）：
 * 官方 **2026-09-26 起要求请求携带设备标识才下发每日活动**；缺 `Cosy-ClientType: 10`
 * 时服务端不报错，只返回 `{"showCampaign":false,"campaigns":[]}`。而身份是**抄来的常量、
 * 不是算出来的**——wallechfox/qoder-checkin、sunp-1/qoder-checkin、chevy222/qoder-cf-checkin、
 * chevy222/app-cf-checkin 四个项目全部在本机跑桌面端自带的 `runtime-info.exe --account-stdin`
 * 取 machineToken/machineCode/machineType、读 `auth.machine-id` 取 machineId、读
 * `build-manifest.json` 取 productVersion，然后当固定值长期回放；**没有一个是随机或派生的**。
 * hub 的对照实验（qoder_accounts.py:128-130）证明：派生的假身份不报错，但活动列表里会
 * **静默少掉**「每日领取 100 Credits」——这正是我们「无可用签到活动」的根因。
 *
 * Cloudflare Workers 跑不了那个原生二进制，所以真机身份只能由用户在装了桌面端的机器上
 * 一次性提取后填进来。**存储位置是 KV（`qoder:device`），不是环境变量/Secret**：
 * 改一次不用重新部署，面板上直接看到当前生效的是真机身份还是 uid 派生值。
 *
 * 身份是**机器级**的、不是账号级的（app-cf-checkin 设计文档 §7.1：「这是一台机器的身份，
 * 所以是 config 而不是 creds——多个账号共用一份」），故这里不按 uid 分。
 *
 * 注意：这不是热路径。只有签到（cron 每日两次 / 面板手动触发）会读它，所以不做内存缓存
 * ——省掉缓存失效这一整类 bug，代价是每次签到多一次 KV 读。
 */

import { KV_KEYS } from '../config'
import type { Env } from '../types'
import { QODER_DESKTOP_DEFAULTS, type QoderDeviceIdentity } from './billing'

/** 一个设备身份字段的面板元数据。 */
export interface QoderDeviceField {
  key: keyof QoderDeviceIdentity
  /** 实际发出的头名（用户照着提取脚本输出填的就是这个）。 */
  header: string
  /** 留空时的内置回退值；空串 = 没有内置值，回退到 uid 派生值。 */
  placeholder: string
  hint: string
}

/**
 * 8 个字段的单一 owner：面板渲染、归一、测试都读它。
 *
 * 顺序 = chevy222/qoder-cf-checkin 提取脚本 `config.json` 的 `device` 块顺序，
 * 用户从上到下抄一遍即可。
 */
export const QODER_DEVICE_FIELDS: readonly QoderDeviceField[] = [
  { key: 'clientType', header: 'Cosy-ClientType', placeholder: QODER_DESKTOP_DEFAULTS.clientType, hint: '桌面端 10 / CLI 5 / QoderWork 6' },
  { key: 'machineId', header: 'Cosy-MachineId', placeholder: '', hint: 'auth.machine-id 文件内容（无内置值，留空即用 uid 派生值）' },
  { key: 'machineToken', header: 'Cosy-MachineToken', placeholder: '', hint: 'runtime-info.exe 的 machineToken —— 属凭据，勿外传（无内置值）' },
  { key: 'machineType', header: 'Cosy-MachineType', placeholder: '', hint: 'runtime-info.exe 的 machineType（无内置值）' },
  { key: 'machineCode', header: 'Cosy-MachineCode', placeholder: '', hint: 'runtime-info.exe 的 machineCode（无内置值）' },
  { key: 'machineOS', header: 'Cosy-MachineOS', placeholder: QODER_DESKTOP_DEFAULTS.machineOS, hint: '提取脚本输出（实测 x86_64_windows）' },
  { key: 'machineHostname', header: 'Cosy-MachineHostname', placeholder: QODER_DESKTOP_DEFAULTS.machineHostname, hint: '提取机器的主机名' },
  { key: 'version', header: 'Cosy-Version', placeholder: QODER_DESKTOP_DEFAULTS.version, hint: 'build-manifest.json 的 productVersion（实测 0.4.3）' },
]

/**
 * 归一：只保留已知字段、trim 后非空的值；未知键丢弃。
 * 空值**不写入**（而非写空串），这样「已配置哪些字段」直接看 key 是否存在。
 */
export function normalizeQoderDevice(raw: unknown): QoderDeviceIdentity {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out: QoderDeviceIdentity = {}
  for (const f of QODER_DEVICE_FIELDS) {
    const v = src[f.key]
    const s = typeof v === 'string' ? v.trim() : ''
    if (s) out[f.key] = s
  }
  return out
}

/** 是否有任一字段被配置（决定签到走真机身份还是 uid 派生值）。 */
export function hasQoderDevice(device: QoderDeviceIdentity | undefined): boolean {
  return !!device && Object.values(device).some(Boolean)
}

/**
 * 请求体里是否存在任何「trim 后非空的字符串」值。
 *
 * 用途：把「用户真的清空了所有字段」（值全空 → 应该删 KV）与「客户端用了后端不认识的键名」
 * （值非空，但 normalizeQoderDevice 一个都不认 → 归一结果为空）区分开。后者若按「全空」处理，
 * 会**静默删掉已配置的身份**，而面板上只表现为「保存后一片空白」。
 *
 * 2026-10-02 真实踩过：面板客户端把键名归一成了全小写（`clienttype`），后端只认 camelCase
 * 已知键 → 整包被丢弃 → `hasQoderDevice` 为假 → 走 delete 分支，把之前配好的真机身份一起清掉，
 * 而且**不报任何错**。现在 handleSetQoderDevice 用本函数把这种请求挡在 400 上。
 */
export function hasAnyNonEmptyStringValue(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  return Object.values(raw as Record<string, unknown>).some((v) => typeof v === 'string' && v.trim() !== '')
}

/** 读取面板配置：未配置时返回空对象（KV 损坏/非法 JSON 同样回退空对象，不 500）。 */
export async function getQoderDeviceConfig(env: Env): Promise<QoderDeviceIdentity> {
  try {
    return normalizeQoderDevice(await env.KV.get(KV_KEYS.QODER_DEVICE, 'json'))
  } catch {
    return {}
  }
}

/**
 * 签到用：一个字段都没配时返回 undefined，调用方据此走 uid 派生路径并标记 `derived`。
 * 不在这里补默认值——默认值由 checkinHeaders 在发头时补（`device?.x || 内置值`），
 * 这样「面板里存了什么」与「实际发什么」不会出现两份真相。
 */
export async function getQoderDevice(env: Env): Promise<QoderDeviceIdentity | undefined> {
  const device = await getQoderDeviceConfig(env)
  return hasQoderDevice(device) ? device : undefined
}

/** 覆盖保存；全空 → 删除 KV（回退内置默认 + uid 派生值）。 */
export async function setQoderDevice(env: Env, raw: unknown): Promise<void> {
  const device = normalizeQoderDevice(raw)
  if (!hasQoderDevice(device)) {
    await env.KV.delete(KV_KEYS.QODER_DEVICE)
    return
  }
  await env.KV.put(KV_KEYS.QODER_DEVICE, JSON.stringify(device))
}
