/**
 * remaining.ts — 剩余时长的**唯一**文案实现（面板徽章、tooltip、服务端状态行共用）。
 *
 * 为什么必须只有一处：Cline 账号池与 WorkBuddy/Qoder 池都要在界面上写「还剩多久」，
 * 各写各的必然分叉（同一份冷却在两处显示成「8m」与「8 分钟」，用户无法比对）。
 * 更关键的是**客户端不许自己算**剩余时间——两端口径一旦漂移，面板就会开始说谎。
 * 所以服务端算好字符串下发，客户端只负责画（见 cline/account-state 与 oauth-pool）。
 *
 * 口径：只表达「时长」，不表达绝对时刻。绝对时刻必须由**浏览器**按用户本地时区格式化
 * （Worker 运行在 UTC，服务端 toLocaleString 会给出与用户时差 8 小时的时间）。
 */

/** 剩余时长的紧凑写法：`11h59m` / `8m` / `30s`（<=0 一律 `0s`）。 */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return '0s'
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hour = Math.floor(min / 60)
  return `${hour}h${min % 60}m`
}
