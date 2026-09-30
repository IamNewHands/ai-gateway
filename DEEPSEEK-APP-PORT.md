# simple-chat → ai-gateway 移植计划（deepseek-app 提供商）

基准源：`D:\GitHub_Clone\simple-chat`（`Sliverkiss/simple-chat`，MIT，Go 1.23，commit `c858d32`）
目标：ai-gateway `src/deepseek/`（Cloudflare Workers + Hono）
性质：**不是逐函数翻译**，而是「协议重写到 Workers 运行时」——Go 的 goroutine/文件/Redis 语义在 Workers 里不存在，需换成本仓库既有形态（KV 账号池 + per-isolate 运行态 + cron）。

---

## 一、上游事实（已核实）

上游是 **chat.deepseek.com 安卓 App 2.5.3 的私有 API**，不是公开 OpenAI 兼容端点：

| 端点 | 用途 |
|---|---|
| `POST /api/v0/users/login` | 手机号/邮箱 + 密码登录，返回 bearer token |
| `POST /api/v0/chat_session/create` | 每次补全前新建会话 |
| `POST /api/v0/chat/create_pow_challenge` | 取 PoW 挑战（按 target_path） |
| `POST /api/v0/chat/completion` | SSE 补全（thinking / search） |
| `POST /api/v0/file/upload_file` + `GET /api/v0/file/fetch_files` | 图片上传与就绪轮询 |
| `GET /api/v0/chat_session/fetch_page` | 会话抽屉列表 |
| `POST /api/v0/chat_session/delete` / `delete_all` | 单删 / 清空 |
| `GET /api/v0/users/current` | 启动序列 |

关键机制：
1. **PoW（HashV1）**：`HashV1 = SHA3-256 但跳过 Keccak-f 第 0 轮`，rate 136。挑战 = `HashV1(salt_expireAt_nonce)`，nonce 均匀取自 `[0, difficulty)`（实测 difficulty=144000），求解 = 精确 32 字节匹配 ⇒ 暴力枚举，平均 ~72k 次置换。应答头 `x-ds-pow-response = base64(JSON)`。PoW 对 completion 与图片上传都要。
2. **设备指纹**：UA `DeepSeek/2.5.3 Android/35`、`x-client-platform/version/locale/bundle-id/timezone-offset`、`x-device-id`、`x-rangers-id`；中性 UA 会被 WAF 挡成 HTTP 202 空体。device_id = `base64(AES-128-CBC(PKCS7)(ANDROID_ID + "_google", key=MD5("com.deepseek.chat"), IV=0))`，按账号确定性铸造；`x-rangers-id` = UUIDv5(自定 namespace)。
3. **风控语义**：`biz_code 5`=禁言（带 `mute_until`，重新请求会续期）、`10`=封禁（永久）、`11`=设备风险（RISK_DEVICE_DETECTED）。账号 park 状态必须持久化，否则重启后重新触达会续期/升级。
4. **会话生命周期**：每次补全新建一个上游会话（App 语义），后台按「人类节奏」随机清理最老的 1–3 个 + 每周一次 `delete_all`。
5. 单账号并发上限默认 2；池内严格 round-robin。

## 二、可移植性判定

| 维度 | 结论 |
|---|---|
| 协议/加密 | ✅ 纯计算，TS 可实现（PoW 用手写 Keccak-f23，device_id 用 WebCrypto AES-CBC + MD5 常量） |
| 运行时 | ✅ 无 Durable Object 需求；账号池用 KV 持久化 + per-isolate 内存态，与 trae/kuku/cnb 同形态 |
| 后台任务 | ✅ Go goroutine → Cloudflare cron（`[triggers]` 已有 4 条，可增补） |
| Redis/Upstash 账号库 | ✅ 换成 KV（`storage.ts` 既有形态） |
| 流式转换 | ✅ Workers ReadableStream transform；idle 看门狗用 AbortController + setTimeout |
| **唯一硬门** | ⚠️ **Cloudflare 数据中心 IP 是否被 chat.deepseek.com 风控接受**（GitHub 上是住宅/机房混合场景，无 CF 出口的先例）。必须先做一次 Worker 上的 live probe 再决定是否全量移植。 |

**逃生方案（若 IP 门失败）**：不移植，改为在 VPS/Coolify 跑 simple-chat 容器，ai-gateway 里登记为普通 `api-key` 提供商（30 分钟工作量，零代码）。

## 三、架构落点（复用本仓库既有 owner）

- 新目录 `src/deepseek/`，镜像 `src/trae/`、`src/kuku/` 的分层：`pow.ts` / `device.ts` / `client.ts` / `pool.ts` / `sse.ts` / `proxy.ts`（+ `admin.ts`）。
- provider 判定：`isDeepseekAppProvider(provider)`（`provider.id === 'deepseek-app'`），在 `src/proxy.ts` 的 4 个 dispatch 点挂载（chat 流式/非流式、models、test）。
- 账号存储：KV（`storage.ts` 加 key + CRUD），管理后台账号管理面板沿用 trae 的账号池 UI 形态。
- 模型：`deepseek-flash`（上游只有这一个模型，`GET /v1/models` 与之对齐）。
- 鉴权：复用 `proxyKeyAuthMiddleware`（对齐 `DS_API_KEY` 语义）。

## 四、TDD 路线

`TDD Route: auto` → **strict**（协议/契约/持久化边界，且上游提供 golden vector）。权威来源：simple-chat 自带 12,542 行测试 + `pow_test.go` 的独立 golden vector（含一次真实挑战 answer=86022/difficulty=144000）。移植时以「Go 测试断言 → TS 测试」的方式保留证据，不允许只靠手测。

## 五、任务清单

> 测试命令注意：本机沙箱禁止 `child_process` 管道，vitest 默认 forks 池会 `spawn EPERM`。
> 本仓库测试统一加 `--pool=threads`：`npx vitest run --pool=threads src/deepseek/pow.test.ts`

**阶段 0 — 可行性门（先做，未过则停止）**
- [ ] T0.1 Worker 上最小 probe：登录 → 取 PoW 挑战 → 解 → 补全一段话。(需真实账号凭据 + 一次 deploy 授权)

**阶段 1 — 纯计算（无凭据、可离线验证）**
- [x] T1.1 `src/deepseek/pow.ts`：Keccak-f23/HashV1 + SolvePow + `BuildPowHeader`
- [x] T1.2 `src/deepseek/pow.test.ts`：5 条 golden vector + 真实挑战求解 + 边界（非法 hex / difficulty=0 / 取消）
      → 验证：`npx vitest run --pool=threads src/deepseek/pow.test.ts` **17/17 通过**；`npx tsc --noEmit` 干净。

**阶段 2 — 设备身份与客户端**
- [ ] T2.1 `device.ts`：MD5 常量、AES-CBC 铸造、UUIDv5、rangers-id、web/android channel
- [ ] T2.2 `client.ts`：baseHeaders、envelope/BizError、`postJSON/postEmpty/getJSON`、ban 分类（5/10/11）、IsAuthFailure/IsRetryable
- [ ] T2.3 登录 + 懒重登 + 启动序列（`users/current`）

**阶段 3 — 账号池**
- [ ] T3.1 KV 账号 CRUD（`accounts.json` 字段对齐：mobile/email/password/region/channel/device_id/park_*）
- [ ] T3.2 round-robin + 每账号 in-flight 信号量 + QueueWait
- [ ] T3.3 park 持久化（muted 带窗口 / banned 永久 / risk 冷却）+ 自然 unpark 回写

**阶段 4 — 补全链路**
- [ ] T4.1 请求体构造：messages→上游 payload、thinking 开关、search 开关、图片 parts
- [ ] T4.2 SSE → OpenAI：`delta.reasoning_content` 先行、`delta.content`、`citations`、finish 诚实收尾
- [ ] T4.3 非流式聚合（sawDone/truncated 语义对齐 trae 的既有教训）
- [ ] T4.4 重试阶梯 + idle 看门狗 + 错误映射（不罚号/不谎报 stop）

**阶段 5 — 会话生命周期（cron）**
- [ ] T5.1 `chat_session/create`+`delete` 包装、`fetch_page` 列表
- [ ] T5.2 人类节奏清理（抖动 ±50%、floor、batch 1–3）
- [ ] T5.3 每周 purge-all（weekday/hour/宽限补跑）+ `DS_SESSION_CAP` 同步上限

**阶段 6 — 网关集成**
- [ ] T6.1 `proxy.ts` 4 个 dispatch 点 + `GET /v1/models` + 预置 DEFAULT_PROVIDERS 条目
- [ ] T6.2 管理后台：账号上传/列表/删除（不回显凭据）、pool 状态、park 展示
- [ ] T6.3 用量统计接入 `analytics/usage-logger.ts`

**阶段 7 — 可选能力**
- [ ] T7.1 `search: {type: enabled}` + 独立 `POST /v1/web_search`
- [ ] T7.2 图片：`image_url`（http/base64）→ upload_file → fetch_files 轮询

**阶段 8 — 验证与入库**
- [ ] T8.1 全量 `vitest run` + `tsc` 通过
- [ ] T8.2 本机 live probe（Node + 真账号，绕开 CF IP 单独验证协议正确性）
- [ ] T8.3 Worker 部署 live probe（阶段 0 的正式版）
- [ ] T8.4 `CODING_NOTES.md` 记录决策与风险，推送 main

## 六、工作量与风险

- 代码量：Go 非测试 6,732 行 → 预计 TS 3,500–4,500 行（含测试）。分 8 个阶段，**预计 12–16 小时 agent 工时**，跨多次会话。
- 风险 1（阻断级）：CF 出口 IP 被风控 → 见逃生方案。
- 风险 2（已实测降级）：PoW 在 JS 里的 CPU 成本。本机实测 **86,022 次置换 = 313ms**（≈275k 置换/秒，3.6µs/次），一次 worst-case 144000 难度约 0.5s CPU，Workers Paid `cpu_ms=300000` 完全容得下。仍需按账号缓存挑战至 `expire_at`（同一 target_path 不必每次重解）。
- 风险 3：账号封禁不可逆（biz 10 永久）——测试必须用专门的小号，且 park 持久化要在阶段 3 就位，避免测试期把主号打死。
- 风险 4：上游协议随时变更（App 版本升级即失效）。移植不改变这一事实，只把维护面收敛到 `src/deepseek/`。
