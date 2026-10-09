/**
 * model-meta.ts — Qoder 上游模型元数据表（model_config 逐字段赋值 + 思考档位归一的唯一数据源）。
 *
 * ## 为什么需要它
 *
 * 请求模板 `baseprompt.json` 里的 `model_config` 是**一份写死的示例**：
 *   {key:"lite", display_name:"Lite", is_vl:false, is_reasoning:false, max_input_tokens:180000}
 *
 * 旧实现只覆盖 `key` 一个字段（`body.ts` 的 `base.model_config.key = modelKey`），于是：
 *   - **VL 模型带着 `is_vl:false` 发出**（上游按纯文本模型对待，图片能力被自己关掉）；
 *   - 推理模型带 `is_reasoning:false`；
 *   - 所有模型的 `max_input_tokens` 恒为 180000（1M 上下文的模型被误报成 18 万）；
 *   - `display_name` 恒为 `"Lite"`。
 *
 * 源实现（hub `qoder_proxy.py:2341-2363`）从**出口区域的官方清单**取这些字段逐字段赋值：
 *   mc["display_name"] = catalog_meta.get("display_name") or model_key
 *   mc["is_vl"] = bool(catalog_meta.get("is_vl"))
 *   mc["is_reasoning"] = bool(catalog_meta.get("is_reasoning"))
 *   mc["max_input_tokens"] = catalog_meta.get("max_input_tokens") or 180000
 *
 * ## 数据来源与生成方式
 *
 * 表值**逐字段照抄** hub 的官方目录快照（`qoder_catalog_intl.json` / `qoder_catalog_cn.json`），
 * 那两份文件由 `_refresh_catalog.py` 从本机官方客户端解密目录缓存 `catalog-v6` 得来。
 * 生成脚本：`_port-analysis/gen-qoder-model-meta.js`（只读快照，不写源仓库）。
 *
 * 为什么不照搬 hub 的**运行时读快照文件**：Workers 里没有文件系统，且目标没有等价目录。
 * 也不走 `/algo/api/v2/model/list`：那条路是**选号热路径之外的额外上游调用**，而元数据是
 * 静态的——客户端更新后重跑生成脚本即可，不该让每次请求多一次网络往返（hub 自己也是读本地快照）。
 *
 * ## 双区不同（为什么按 realm 分表）
 *
 * 同一 key 在两区的元数据**确实不同**（不是冗余）：
 *   - `dmodel`：intl `max_input_tokens` 1000000 / cn 96000；
 *   - `dfmodel`：intl `is_reasoning` true / cn false；
 *   - `kmodel`：intl `is_reasoning` false / cn true；
 *   - `qmodel`/`qmodel_latest`：intl `is_reasoning` false / cn true，且 intl 1000000 / cn 180000；
 *   - 区域独占 key：intl 有 `ultimate/performance/efficient/smodel/cmodel`，cn 有 `q37fmodel/gm51model`。
 * 故必须按**账号域**取表，混用会把另一区的值发给上游。
 *
 * ## 未知 key 的处理
 *
 * 表里没有的 key（例如目标 `MODEL_KEY_MAP` 里尚未跟上的旧名 `qmodel_preview` / `q36fmodel`，
 * hub 的 `MODEL_ALIASES` 已把它们归一成 `qmodel_38max`）按 hub 同口径兜底：
 * `displayName = key`、布尔开关与上限**保持模板值不变**（不编造能力）。
 * 只写 `display_name` 是刻意的——把未知模型标成 `is_vl:false` 等于替上游宣称「它不支持图片」，
 * 而模板本来就是 false，保持原样才是零信息变更。
 */

/** 账号域（与 billing.QoderRealm 同值；此处独立声明以免 model-meta 反向依赖 billing）。 */
export type QoderMetaRealm = 'cn' | 'global'

/** 该模型官方的思考档位表（来自官方目录 `thinking_config.enabled.efforts`）。 */
export interface QoderModelThinkingConfig {
  /** 官方支持的档位，已按官方词表顺序（none→max）排序 */
  efforts: readonly string[]
  /** 官方默认档（`is_default` 标注项）；无标注时为空串 */
  defaultEffort: string
}

/** 一个上游模型 key 的元数据。 */
export interface QoderModelMeta {
  displayName: string
  isVl: boolean
  isReasoning: boolean
  maxInputTokens: number
  /**
   * 缺省 = 该模型**没有** thinking_config（如路由器 `auto`）→ 思考档位原样透传，不做猜测。
   * 存在但 `efforts` 为空 = 该模型只有「开/关」没有档位 → 除 `none` 外不下发该参数。
   */
  thinkingConfig?: QoderModelThinkingConfig
}

/** 国际版（qoder.com / api1-3.qoder.sh）官方清单。 */
const INTL_MODEL_META: Record<string, QoderModelMeta> = {
  'auto': { displayName: 'Auto', isVl: true, isReasoning: false, maxInputTokens: 200000 },
  'ultimate': { displayName: 'Ultimate', isVl: true, isReasoning: true, maxInputTokens: 1000000, thinkingConfig: { efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' } },
  'performance': { displayName: 'Performance', isVl: true, isReasoning: false, maxInputTokens: 1000000, thinkingConfig: { efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' } },
  'efficient': { displayName: 'Efficient', isVl: true, isReasoning: false, maxInputTokens: 200000 },
  'smodel': { displayName: 'Sonus', isVl: true, isReasoning: true, maxInputTokens: 180000, thinkingConfig: { efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' } },
  'cmodel': { displayName: 'Cantus', isVl: true, isReasoning: true, maxInputTokens: 180000, thinkingConfig: { efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' } },
  'qmodel_38max': { displayName: 'Qwen3.8-Max', isVl: true, isReasoning: true, maxInputTokens: 180000, thinkingConfig: { efforts: ['low', 'medium', 'xhigh'], defaultEffort: 'xhigh' } },
  'qfmodel': { displayName: 'Qwen3.8-Flash', isVl: true, isReasoning: true, maxInputTokens: 180000, thinkingConfig: { efforts: ['low', 'medium', 'xhigh'], defaultEffort: 'medium' } },
  'qmodel_latest': { displayName: 'Qwen3.7-Max', isVl: true, isReasoning: false, maxInputTokens: 1000000, thinkingConfig: { efforts: [], defaultEffort: '' } },
  'qmodel': { displayName: 'Qwen3.7-Plus', isVl: true, isReasoning: false, maxInputTokens: 1000000, thinkingConfig: { efforts: [], defaultEffort: '' } },
  'kmodel_latest': { displayName: 'Kimi-K3', isVl: true, isReasoning: false, maxInputTokens: 180000, thinkingConfig: { efforts: ['low', 'high', 'max'], defaultEffort: 'max' } },
  'kmodel': { displayName: 'Kimi-K2.8-Preview', isVl: true, isReasoning: false, maxInputTokens: 180000, thinkingConfig: { efforts: ['low', 'high', 'max'], defaultEffort: 'max' } },
  'gmodel': { displayName: 'GLM-5.3', isVl: true, isReasoning: true, maxInputTokens: 180000, thinkingConfig: { efforts: ['low', 'high', 'max'], defaultEffort: 'max' } },
  'gfmodel': { displayName: 'GLM-5.3-Flash', isVl: true, isReasoning: true, maxInputTokens: 1000000, thinkingConfig: { efforts: ['high', 'max'], defaultEffort: 'max' } },
  'dmodel': { displayName: 'DeepSeek-V4-Pro', isVl: true, isReasoning: true, maxInputTokens: 1000000, thinkingConfig: { efforts: ['high', 'max'], defaultEffort: 'max' } },
  'dfmodel': { displayName: 'DeepSeek-Flash', isVl: true, isReasoning: true, maxInputTokens: 1000000, thinkingConfig: { efforts: ['low', 'high', 'max'], defaultEffort: 'max' } },
  'mmodel': { displayName: 'MiniMax-M3', isVl: true, isReasoning: false, maxInputTokens: 180000 },
}

/** 国内版（qoder.com.cn / gateway.qoder.com.cn）官方清单。 */
const CN_MODEL_META: Record<string, QoderModelMeta> = {
  'auto': { displayName: 'Auto', isVl: true, isReasoning: true, maxInputTokens: 200000 },
  'qmodel_38max': { displayName: 'Qwen3.8-Max', isVl: true, isReasoning: true, maxInputTokens: 180000, thinkingConfig: { efforts: ['low', 'medium', 'xhigh'], defaultEffort: 'medium' } },
  'qfmodel': { displayName: 'Qwen3.8-Flash', isVl: true, isReasoning: true, maxInputTokens: 180000, thinkingConfig: { efforts: ['low', 'medium', 'xhigh'], defaultEffort: 'medium' } },
  'qmodel_latest': { displayName: 'Qwen3.7-Max', isVl: true, isReasoning: true, maxInputTokens: 180000, thinkingConfig: { efforts: [], defaultEffort: '' } },
  'qmodel': { displayName: 'Qwen3.7-Plus', isVl: true, isReasoning: true, maxInputTokens: 180000, thinkingConfig: { efforts: [], defaultEffort: '' } },
  'q37fmodel': { displayName: 'Qwen3.7-Flash', isVl: true, isReasoning: true, maxInputTokens: 180000 },
  'dmodel': { displayName: 'DeepSeek-V4-Pro', isVl: true, isReasoning: true, maxInputTokens: 96000, thinkingConfig: { efforts: ['high', 'max'], defaultEffort: 'max' } },
  'dfmodel': { displayName: 'DeepSeek-Flash', isVl: true, isReasoning: false, maxInputTokens: 180000, thinkingConfig: { efforts: ['low', 'high', 'max'], defaultEffort: 'max' } },
  'gmodel': { displayName: 'GLM-5.3', isVl: true, isReasoning: true, maxInputTokens: 180000, thinkingConfig: { efforts: ['low', 'high', 'max'], defaultEffort: 'max' } },
  'gfmodel': { displayName: 'GLM-5.3-Flash', isVl: true, isReasoning: true, maxInputTokens: 1000000, thinkingConfig: { efforts: ['high', 'max'], defaultEffort: 'max' } },
  'gm51model': { displayName: 'GLM-5.2', isVl: true, isReasoning: true, maxInputTokens: 180000, thinkingConfig: { efforts: ['high', 'max'], defaultEffort: 'max' } },
  'kmodel_latest': { displayName: 'Kimi-K3', isVl: true, isReasoning: false, maxInputTokens: 180000, thinkingConfig: { efforts: ['low', 'high', 'max'], defaultEffort: 'max' } },
  'kmodel': { displayName: 'Kimi-K2.8-Preview', isVl: true, isReasoning: true, maxInputTokens: 180000, thinkingConfig: { efforts: ['low', 'high', 'max'], defaultEffort: 'max' } },
  'mmodel': { displayName: 'MiniMax-M2.7', isVl: false, isReasoning: false, maxInputTokens: 180000 },
}

/** 表里没有该 key 时 `max_input_tokens` 的兜底值（hub `or 180000` 同口径）。 */
export const QODER_DEFAULT_MAX_INPUT_TOKENS = 180000

/** 按账号域取该 key 的元数据；表里没有 → null（调用方按「未知 key」兜底，不编造能力）。 */
export function qoderModelMeta(modelKey: string, realm: QoderMetaRealm = 'cn'): QoderModelMeta | null {
  const table = realm === 'global' ? INTL_MODEL_META : CN_MODEL_META
  return table[modelKey] || null
}

/** 该 key 在任一区域的官方显示名（模型列表/日志用）；未知 → 空串。 */
export function qoderModelDisplayName(modelKey: string, realm: QoderMetaRealm = 'cn'): string {
  return qoderModelMeta(modelKey, realm)?.displayName || ''
}

// ===== 思考档位归一（hub qoder_proxy.py:1910-1982） =====

/**
 * 官方档位词表顺序（hub `EFFORT_RANK`）。数值只用于「最近合法档位」的距离计算。
 * 含 `none`/`minimal`：前者是关闭值，后者是部分客户端会传的档位。
 */
const EFFORT_RANK: Record<string, number> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
}

/** 关闭类取值（hub `_EFFORT_OFF`）：统一映射为官方通用关闭值 `none`。 */
const EFFORT_OFF = ['none', 'off', 'disabled', 'disable', 'false', '0', 'no']

/**
 * 把客户端请求的思考档位归一化到该模型**官方支持**的档位集合。
 *
 * ## 为什么必须做（源实测记载，hub `normalize_reasoning_effort` docstring）
 *
 * 上游对不支持的档位**不报错、直接忽略**（回落到模型默认档）。实测：
 *   - `dfmodel` 官方只支持 low/high/max（默认 max），传 medium/xhigh 时输出与默认档一致
 *     ——客户端以为「思考档位没生效」；
 *   - cn 的 `qmodel` 只有开/关，传任何档位都被忽略（只有 `none` 能关掉思考）。
 * 故「原样透传」会把客户端的意图静默丢掉，而客户端无从察觉。
 *
 * ## 规则（与源逐条同构）
 *
 *   - 空值 → 不下发；
 *   - 关闭类取值 → `none`；
 *   - 模型**没有** thinking_config（如路由器 `auto`）→ 原样透传，不做猜测；
 *   - 模型有 thinking_config 但**无档位表**（仅开/关）→ 除 `none` 外不下发该参数
 *     （避免给上游发它不认识的档位）；
 *   - 有档位表：命中则原样透传；未知档位 → 取默认档；未命中 → 取最近合法档位
 *     （同距时偏向模型默认档）。
 *
 * 返回 `null` = 不下发 `reasoning_effort`。
 */
export function normalizeQoderReasoningEffort(effort: unknown, meta: QoderModelMeta | null): string | null {
  const e = String(effort ?? '').trim().toLowerCase()
  if (!e) return null
  if (EFFORT_OFF.includes(e)) return 'none'

  const tc = meta?.thinkingConfig
  if (!tc) return e // 目录里没有该模型的思考配置（路由器/未知模型）：不猜测，原样透传

  const sup = tc.efforts
  if (sup.length === 0) return null // 只有开/关，没有档位：除 none 外不下发

  if (sup.includes(e)) return e

  const def = tc.defaultEffort && sup.includes(tc.defaultEffort) ? tc.defaultEffort : ''
  const want = EFFORT_RANK[e]
  if (want === undefined) return def || sup[0] // 词表外的未知档位 → 默认档

  const defRank = def ? EFFORT_RANK[def] : want
  // 同距时偏向模型默认档（源的 key 是二元组比较）
  const best = [...sup].sort((a, b) => {
    const da = Math.abs(EFFORT_RANK[a] - want)
    const db = Math.abs(EFFORT_RANK[b] - want)
    if (da !== db) return da - db
    return Math.abs(EFFORT_RANK[a] - defRank) - Math.abs(EFFORT_RANK[b] - defRank)
  })[0]
  return best
}
