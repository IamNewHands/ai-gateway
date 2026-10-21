/**
 * json-repair.ts — JSON 参数文本的判定与「纯追加」修复。
 *
 * 为什么单独成文件：同一条纪律要服务两条出口，两处必须用**同一份**算法，否则同一个上游
 * 坏参数在 OpenAI 出口修好了、在 Anthropic 出口又漏出去：
 *   - `src/trae/sse.ts`（TRAE SOLO/Work → OpenAI chat.completion）；
 *   - `src/formats.ts`（OpenAI chunk → Anthropic Messages，全 provider 共享）。
 *
 * 移植自 Trae2api-cn `src/sse.py` `_repair_json_arguments`（`a01d77c` / `e5eb6d1`）与
 * `src/anthropic_api.py` 同名函数：**只在结果能通过 `JSON.parse` 时才返回新值**，
 * 否则原样返回 —— 宁可不修，也不编造一个能过 schema 的错误参数。
 *
 * 修复只做「纯追加」（补未闭合字符串的引号、按括号栈补闭合符），因此调用方可以安全地把
 * `repaired.slice(original.length)` 当作**追加增量**下发给已收到半截参数的客户端 ——
 * 这正是流式路径能「事后修好已下发内容」的前提（源侧改用缓冲到流末一次性下发，代价是
 * 工具调用延迟；本仓库选择保留渐进下发 + 收尾补发，见 `SoloToolCallMerger.finalizeDeltas`）。
 */

/** 合法 JSON 文本（含标量）→ true；空串与解析失败 → false。 */
export function isJsonText(text: string): boolean {
  if (text === '') return false
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/**
 * 尽力补全被截断的 JSON 参数（补未闭合字符串与括号栈）。
 *
 * 只在修复结果能通过 `JSON.parse` 时返回新值，否则原样返回。返回值**必以入参为前缀**
 * （纯追加），调用方可据此算增量后缀。
 */
export function repairJsonArguments(argumentsText: string): string {
  if (!argumentsText || isJsonText(argumentsText)) return argumentsText
  let repaired = argumentsText.replace(/\s+$/, '')
  const stack: string[] = []
  let inStr = false
  let esc = false
  for (const ch of repaired) {
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{' || ch === '[') stack.push(ch)
    else if (ch === '}' || ch === ']') {
      if (stack.length > 0) stack.pop()
    }
  }
  if (inStr) repaired += '"'
  for (let i = stack.length - 1; i >= 0; i--) repaired += stack[i] === '{' ? '}' : ']'
  return isJsonText(repaired) ? repaired : argumentsText
}

/**
 * 该 JSON 参数文本是否「可用」：空串视同零参数（`{}` 语义），非空则必须能解析。
 *
 * 空串单独放行的理由：上游对零参数工具调用常常不发 `arguments`，把它判成坏参数会让
 * 每一次无参调用都报错。源侧同口径（`_ensure_native_tool_arguments` 把空参数归一成 `"{}"`）。
 */
export function isUsableToolArgs(argumentsText: string): boolean {
  return argumentsText === '' || isJsonText(argumentsText)
}
