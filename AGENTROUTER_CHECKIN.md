# AgentRouter 每日自动签到

签到运行在现有 `ai-gateway` Cloudflare Worker 中，不需要本机常开，也不需要另建 Worker、KV 或 Cron。
本功能使用 AgentRouter 绑定邮箱和站内密码，不使用 GitHub 密码，也不使用模型 API Key。

## 配置

1. 部署包含本功能的 Worker，登录网关 `/admin`。
2. 展开 AgentRouter 提供商详情，在「AgentRouter 每日签到」中添加绑定邮箱、站内密码和可选备注。
3. 保存并点击「立即签到」，确认显示「今日已签」及当天的签到日志核验结果。
4. 保持「每日自动签到」开启，Worker 将在北京时间 **10:05 / 22:05** 尝试签到。

没有 AgentRouter 提供商时，先通过现有「厂商预设」创建一个。Chat 与 Responses 原生提供商共用
同一组签到账号，任一处保存都会更新其他已展开的卡片，不需要重复添加邮箱。
签到账号独立于提供商配置：删除某张提供商卡片不会删除签到账号或停止其自动签到。
停用签到应关闭账号的「每日自动签到」开关，或删除该签到账号。

## 签到与结果

- `POST https://agentrouter.org/api/user/login` 登录有签到副作用；
  再以本次响应 Cookie 和 `New-API-User` 读取 `/api/log/self`、`/api/user/self`。
- 只有北京时间当天、类型为 `4`、明确包含「签到成功」且非否定文案的日志能确认今日已签。
  登录成功或 `checked_in=true` 本身不算核验通过；日志缺失、风控页面、超时会显示未确认或失败。
- 每日已确认标记会使后续定时轮次跳过登录；手动签到会重新登录、核验并更新余额。
  KV 标记不是跨实例原子锁，极少数重叠执行仍可能重复登录，不保证 exactly-once。
- 余额为上次读取的 **USD 快照**，不是实时值；上游 `500000 quota = 1 USD`。
  余额读取失败不抹掉已经确认的签到结果，也不把未知余额显示为零。
- 最多保存 20 个账号；每轮最多 3 个账号并发。单次请求 20 秒上限，每账号出站流程 60 秒预算。
  仅网络故障、请求超时及 HTTP 502/503/504 重试一次；密码错误、风控和限流不立即重试。

当前协议参考公开项目 [Code-kike/agentrouter-checkin](https://github.com/Code-kike/agentrouter-checkin)
中的 `worker.js`，实现没有复制其宽松的成功/日期判据。上游接口可能改变；
Cloudflare 出口是否被 AgentRouter 风控接受，必须以真实部署后的手动核验为准。
出现 CAPTCHA 或风控时，本功能会停止本次尝试，不自动绕过验证。

## 凭据

站内密码以 AES-GCM 密文写入独立 KV 键，密钥由 Worker 的 `ADMIN_PASSWORD` 派生。
建议将网关管理员密码设置为足够强的 Cloudflare Secret。
管理页、账号查询、签到结果和系统日志不返回密码或上游 Cookie；Cookie 只存在于单次运行中。

**更换 `ADMIN_PASSWORD` 后，已保存的站内密码无法解密。**
账号会显示「需更新密码」，自动签到会报 `CREDENTIALS_LOCKED`；编辑账号并重新输入站内密码即可恢复。
编辑时密码留空保留原密文，不会解除这种锁定。暂停账号不会删除凭据。

## 接口

浏览器接口均需管理员 Session，写接口沿用管理后台 CSRF 校验。
新增、编辑正文必须是合法 JSON，最大 16 KiB；邮箱用于稳定账号标识，创建后不可修改。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET / POST | `/admin/api/agentrouter/accounts` | 查询脱敏账号 / 添加账号 |
| PUT / DELETE | `/admin/api/agentrouter/accounts/:id` | 编辑 / 删除账号 |
| POST | `/admin/api/agentrouter/checkin` | 手动签到所有已启用账号 |
| POST | `/admin/api/agentrouter/checkin/:id` | 手动签到指定账号 |
| GET / POST | `/api/manage/agentrouter/accounts` / `/api/manage/agentrouter/checkin[/:id]` | 使用 `MANAGEMENT_TOKEN` 查询 / 手动签到 |

管理 Token 接口不提供密码 CRUD；密码只经 Web 管理端配置。
现有全量手动签到返回 `data.agentrouter`，现有签到状态与概览接口也附带独立的 `agentrouter` 字段；
AgentRouter 美元余额不会混入 WorkBuddy、Qoder 或 TRAE 的积分。

签到响应的 `success=true` 表示任务已执行并返回摘要，**不代表每个账号成功**；
应检查 `data.ok`、`data.already`、`data.fail` 和逐账号 `status` / `errorCode`。
状态为 `ok`、`already`、`unverified`、`fail`、`disabled`。

## 本地验证

```powershell
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run --pool=threads src/agentrouter.test.ts src/agentrouter-routes.test.ts src/agentrouter-scheduled.test.ts src/agentrouter-ui.test.ts
node node_modules/wrangler/bin/wrangler.js deploy --dry-run
```

单测使用虚构邮箱、密码和模拟上游；dry-run 不会发布 Worker。
这些检查不能替代真实账号核验。推送 `main` 会触发 `.github/workflows/deploy.yml` 自动部署，
需要发布时才进行推送。
