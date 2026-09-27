/**
 * runaway.ts — TRAE 推理退化（思考死循环）防护。
 *
 * 现场（用户实测，ai-gateway 的 trae 通道）：
 *   思考面板里刷出 `Go.` / `Writing.` / `OK.` / `Let me output the calls.` 之类的短句，
 *   反复重复直到用户手动发「继续，不要过度思考」才打断。上游 SOLO/Work 的
 *   `reasoning_content` 退化，正文与工具调用迟迟不产出，work_credits/积分被烧。
 *
 * 为什么**复用** workbuddy-sse 的判据而不是新写一个：
 *   仓内已有两个推理退化 owner，判据不同、互为盲区：
 *   1. `src/cline/proxy.ts` 的 `isDegenerateReasoningDeltas`：整体**空白占比 ≥0.55** 判退化
 *      （按 342 个真实 reasoning 步校准）。它专治「空白/乱码洪泛」，但本次的
 *      「短句一行一行重复」空白占比只有 ~0.3 → **必然漏判**；
 *   2. `src/workbuddy-sse.ts` 的 `isDegenerateReasoningWindow`：**行重复**判据
 *      （≥20 行、去重 ≤10 种、重复行占比 ≥0.85、单行出现 ≥4 次），其测试夹具
 *      `workbuddy-sse.test.ts:454` 用的正是与本次同形的
 *      `'Writing.\n\nLet me output.\n\nGo.\n\nNow.\n\nOK.\n\n'`（按 log3/log4 真实会话校准）。
 *
 * 所以本模块**只做聚合与接线**，判据本体仍归 `workbuddy-sse.ts` 所有（单一事实来源）；
 * 命名上的「workbuddy」前缀与本通道无关，属历史遗留（未来可无损迁到中性模块，见
 * CODING_NOTES 的待办；本轮不迁移以免制造第二个 owner）。
 *
 * 触发后的语义（与 `src/cline/proxy.ts` 的 `pumpStreamAttempt` 对齐）：
 *  - **抑制**：不再把退化推理下发给客户端（不再刷思考面板）；
 *  - **提前熔断**：抑制后继续累积 `TRAE_RUNAWAY_GRACE_CHARS` 仍无正文/工具调用 → 立刻
 *    结束并取消上游读取（省积分；上游不会自己停）；
 *  - **定责**：发 `upstream_runaway` 错误帧 + `finish_reason:"length"`，让 OpenAI 兼容客户端
 *    （DSH 的 pi-ai 等）按「可重试失败」处理，而不是把垃圾当成功答案；
 *  - **不罚号**：退化是模型行为，不是账号问题，因此本通道**不**触发账号冷却
 *    （对比 `applyStreamError`/`noteTraeError` 的错误归因纪律）。
 */

import { WorkbuddyDegeneracyDetector, isDegenerateReasoningWindow } from '../workbuddy-sse'

/** 退化成因：行重复死循环 / 推理预算耗尽（两者都表现为「只思考、不产出」）。 */
export type TraeRunawayKind = 'degenerate_loop' | 'budget_exhausted'

/** 熔断诊断信息（日志与错误帧共用）。 */
export interface TraeRunawayInfo {
  kind: TraeRunawayKind
  /** 本次响应累计的推理字符数（含被抑制部分——它是「烧了多少」的度量） */
  reasoningChars: number
  /** 累计正文字符数 */
  contentChars: number
  /** 是否已经产出过工具调用 */
  sawToolCalls: boolean
}

/**
 * 熔断后仍无产出的容忍字符数：命中退化后上游通常不会自愈，继续读只会烧积分。
 * 4096 字符（约 1k token）足够让「先长思考、再出正文」的正常回答把正文吐出来——
 * 阈值再小会误杀思考型模型的合法长推理，再大则白烧积分。
 */
export const TRAE_RUNAWAY_GRACE_CHARS = 4096

/**
 * 「尚未产出正文/工具调用」时的推理字符硬上限（约 16k token）。
 *
 * 取值对齐仓内既有先例 `WORKBUDDY_DEFAULT_MAX_REASONING_CHARS`（65536）。
 * 与先例的差异：**只在尚未产出正文时**计数——已开始产出的回答即使后续还有长推理
 * 也不再受此上限约束（那种形态不是空转，掐掉会毁掉可用答案）。
 */
export const TRAE_MAX_REASONING_CHARS_BEFORE_PROGRESS = 65536

/**
 * 流式推理防护状态机（一条上游流一个实例）。
 *
 * 只做「是否退化」与「退化后还烧了多少」的状态维护，不持有 IO —— 帧的抑制/收尾由
 * `src/trae/sse.ts` 的两条流式转换器负责（它们才持有 controller）。
 */
export class TraeReasoningGuard {
  private detector = new WorkbuddyDegeneracyDetector()
  private kindValue: TraeRunawayKind | null = null
  private grace = 0
  /** 累计推理字符数（无论是否已抑制） */
  reasoningChars = 0

  /** 已判定退化/超预算 → 调用方必须停止下发推理增量。 */
  get suppressed(): boolean {
    return this.kindValue !== null
  }

  /** 退化成因；未触发为 null。 */
  get kind(): TraeRunawayKind | null {
    return this.kindValue
  }

  /** 触发后继续累积的推理字符数（用于提前熔断判定）。 */
  get graceChars(): number {
    return this.grace
  }

  /**
   * 投喂一条推理增量。
   *
   * @param delta 上游本次下发的推理增量（SOLO `output.reasoning_content` /
   *   Work `plan_item` 的 thought 文本；均为**增量**语义，见 types.ts 的 SOLOEvent 注释）
   * @param hasProgress 本次响应是否已产出正文或工具调用。已产出则不再做退化/预算判定：
   *   此时的长推理属正常链路，掐掉会毁掉可用回答（误杀代价远高于漏判代价）。
   */
  feed(delta: string, hasProgress: boolean): void {
    if (delta === '') return
    this.reasoningChars += delta.length
    if (this.kindValue === null) {
      if (hasProgress) return
      if (this.detector.feedDelta(delta)) {
        this.kindValue = 'degenerate_loop'
        return
      }
      if (this.reasoningChars >= TRAE_MAX_REASONING_CHARS_BEFORE_PROGRESS) {
        this.kindValue = 'budget_exhausted'
      }
      return
    }
    this.grace += delta.length
  }
}

/** 组装本次熔断的诊断信息。 */
export function buildTraeRunawayInfo(
  guard: TraeReasoningGuard,
  contentChars: number,
  sawToolCalls: boolean,
): TraeRunawayInfo {
  return {
    kind: guard.kind ?? 'degenerate_loop',
    reasoningChars: guard.reasoningChars,
    contentChars,
    sawToolCalls,
  }
}

/** 熔断错误帧（OpenAI 兼容；`type` 让客户端走「可重试失败」而不是把垃圾当成功）。 */
export function traeRunawayErrorFrame(info: TraeRunawayInfo): Record<string, unknown> {
  const label = info.kind === 'degenerate_loop'
    ? '推理退化空转（短句重复）'
    : '推理预算耗尽'
  return {
    error: {
      message: `Trae 上游${label}：全程未产出正文/工具调用，已抑制退化推理`
        + `（reasoning=${info.reasoningChars}, content=${info.contentChars}）`,
      type: 'upstream_runaway',
      code: 'upstream_runaway',
    },
  }
}

/**
 * 非流式聚合用的一次性退化判定。
 *
 * 与流式侧的差异：聚合拿到的是**整段**推理文本，不需要滑动窗口与「连续 N 窗」确认，
 * 直接对全文跑同一条行重复判据即可（判据本体在 `workbuddy-sse.ts`）。
 * 未触发时调用方必须原样保留推理文本（正常思考不能被动）。
 */
export function isDegenerateReasoningText(text: string): boolean {
  return text !== '' && isDegenerateReasoningWindow(text)
}
