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
| **唯一硬门（已通过）** | ✅ Cloudflare 数据中心 IP **被上游接受**（2026-09-30 临时 Worker/HKG 实测全链路通过）。真正未解的是「自主登录」：上游硬卡密码登录，须人工注入 token。 |

**逃生方案（已不需要）**：原计划「IP 门失败就改在 VPS 跑 simple-chat 容器」——实测后两点都变了：① IP 门已通过，Workers 可托管；② simple-chat/ds2api 都只支持密码登录，而密码登录正是被硬卡的那条路径，所以容器方案在当前账号下同样不可用。保留此段仅为记录决策链。

## 三、架构落点（复用本仓库既有 owner）

- 新目录 `src/deepseek/`，镜像 `src/trae/`、`src/kuku/` 的分层：`pow.ts` / `device.ts` / `client.ts` / `pool.ts` / `sse.ts` / `proxy.ts`（+ `admin.ts`）。
- provider 判定：`isDeepseekAppProvider(provider)`（`provider.id === 'deepseek-app'`），在 `src/proxy.ts` 的 4 个 dispatch 点挂载（chat 流式/非流式、models、test）。
- **凭据形态（据实测修订）：token 注入型，不是密码型。** 上游硬卡密码登录（真实浏览器同样 `biz_code 11`），且短信登录需要浏览器侧 Shumei `rid` —— 无头进程两种都做不了。因此 provider 的「账号」= **一个 web token + 它对应的 header device id / UA**，由管理后台注入：
  - KV 存 token 池（`token` / `headerDeviceId` / `userAgent` / `shumeiDeviceId`(备用) / `state` / `addedAt` / `expiredAt`）；
  - 面板给**操作指引**（浏览器登录 chat.deepseek.com → DevTools → `localStorage.userToken` → 取 `value` 字段的 64 字符）+「测试」按钮（打 `users/current` 判活）；
  - token 失效时打上 `expired` 标记并在面板提示「需重新注入」，**不静默降级**；
  - 与 ai-gateway 既有的手工登录型 provider（kuku 扫码、trae 登录、cline OAuth）同类，不引入新范式。
- 模型：`deepseek-flash`（上游只有一个模型，`GET /v1/models` 与之对齐）。
- 鉴权：复用 `proxyKeyAuthMiddleware`（对齐 `DS_API_KEY` 语义）。
- **不接线的既有产物**：`client.ts` 的密码登录路径（`login()`）保留但**不接入 provider 流程**——它是上游硬卡的死路，留在代码里只为将来上游放开时复用，并在注释里写明原因，避免后人误以为漏接。

## 四、TDD 路线

`TDD Route: auto` → **strict**（协议/契约/持久化边界，且上游提供 golden vector）。权威来源：simple-chat 自带 12,542 行测试 + `pow_test.go` 的独立 golden vector（含一次真实挑战 answer=86022/difficulty=144000）。移植时以「Go 测试断言 → TS 测试」的方式保留证据，不允许只靠手测。

## 五、任务清单

> 测试命令注意：本机沙箱禁止 `child_process` 管道，vitest 默认 forks 池会 `spawn EPERM`。
> 本仓库测试统一加 `--pool=threads`：`npx vitest run --pool=threads src/deepseek/pow.test.ts`

**阶段 0 — 可行性门（先做，未过则停止）**
- [x] T0.1 本机 Node live probe：**API 通路（token 模式）端到端通过**；密码登录被上游硬卡（详见「阶段 0 实测结果」）。
- [x] T0.2 Worker live probe（CF 出口 IP 门）：**通过**（HKG 出口，completion 1333ms 拿到真实 SSE）。

### 阶段 0 实测结果（2026-09-30，本机 Node + 真账号）

| 尝试 | 指纹 | 结果 |
|---|---|---|
| 1 | App 2.5.3 完整头块 + 按账号铸造的 App 形状 device_id | `biz_code 11 RISK_DEVICE_DETECTED` |
| 2 | **ds2api 生产用线**（极简头 + 字面量 `device_id:"deepseek_to_api"`） | `biz_code 11 RISK_DEVICE_DETECTED` |
| 3–5 | 其余两个组合 | `code 40029 TOO_MANY_REQUESTS`（被限流，不再构成证据） |

关键事实：
- **协议层是对的**：请求穿过 WAF 并拿到正常 JSON 信封（HTTP 200 + 结构化 `biz_code`），说明 URL/方法/头部形状/编码都没问题；PoW、device_id 铸造、信封解析均在单测里用 golden vector 钉死。
- **拦截点在风控**，且**不是 HTTP 层指纹**：连参考实现（ds2api）**逐字**的线上组合也被同一个 biz_code 拒。
- 参考实现能跑通的三个额外条件（本机/Workers 都不具备或不可控）：
  1. **TLS 指纹伪造**：ds2api 用 `refraction-networking/utls` 的 `HelloSafari_Auto`（Safari ClientHello，强制 HTTP/1.1）；Fly143 用 `curl_cffi` 的 Chrome/iOS 指纹。**Cloudflare Workers 的 `fetch()` 无法控制 TLS ClientHello**——这是架构级不可控项。
  2. **出口 IP 信誉**：Fly143 的运维手册把「代理是否开启」列为风控要素；CF 边缘 IP 是国内风控的重点关照对象。
  3. **设备信任**：Fly143 用**私有 device_ids 池**，并明确「公共 device_ids 池会被整体标记」→ device_id 是一类会被烧掉的资源。

**待判定的未知量**：biz 11 究竟来自「TLS/客户端指纹」还是「账号信任 / 本机出口 IP」。一次浏览器侧实验即可分离。在判定前，T3 之后的移植（账号池、SSE、会话生命周期）都属于「协议已备、通路未证」，不建议继续投入。

### 浏览器侧判定实验（2026-09-30，用户真实 Chrome + 真实页面）

做法：CDP 驱动用户日常 Chrome，打开 `chat.deepseek.com`（未登录，落到 `/sign_in`），切到密码登录，用同一账号提交；同时 hook `fetch`/XHR 抓下真实请求与响应。

结果：**`{"code":0,"data":{"biz_code":11,"biz_msg":"RISK_DEVICE_DETECTED"}}`——与 Node/Workers 侧完全一致。**

**结论（关键）**：真实浏览器 + 真实页面 JS + 真实 Shumei device_id + 用户本机出口 IP，同样被风控拒。**问题不在我们的客户端指纹、不在 TLS、也不在 HTTP 线格式**，而在**账号本身或这条网络出口**。

顺带拿到**web 频道的权威线上格式**（对移植有独立价值，之前只能靠 Go 注释推测）：

| 项 | 实测值 |
|---|---|
| 端点 | `POST /api/v0/users/login` |
| 头 | `x-client-platform: web`、`x-client-version: 2.5.0`、`x-client-locale: zh_CN`、`x-client-timezone-offset: 28800`、`x-client-bundle-id: com.deepseek.chat`、`x-device-model: ""`、`x-device-id: <UUID>`（来自 localStorage `deepseek-device-id:chat`）、`accept: */*` |
| 体 | `{email:"", mobile, password, area_code:"+86", device_id:"B…==", os:"web"}` |
| 备注 | web 频道 `area_code` 是 **"+86"**（不是 null，安卓路径才是 null）；体里的 `device_id` 是 Shumei SMSdk 的 base64（`B…`），与 `x-device-id` 的 UUID 是两个不同的值——与 simple-chat 的 `region.go` 描述一致 |

**下一步判定**：改用同一标签页的**短信验证码登录**。若短信能登进去 ⇒ 账号与出口 IP 都没问题，只是密码流程/密码本身有问题（或密码错误被上游统一回成风控）；若短信也被拒 ⇒ 账号或 IP 被风控盯上，移植继续无意义。

### 短信登录实测：账号没问题，密码登录路径是唯一被拒的一环（2026-09-30）

在同一个真实浏览器里走短信：**成功登入**（页面落到 `/`，`localStorage.userToken` 92 字符）。

抓到的完整 web 频道线上格式（比 Go 注释更权威，移植可直接照用）：

| 步骤 | 端点 | 请求体要点 | 结果 |
|---|---|---|---|
| 通讯录/配置 | `GET /api/v0/client/settings?did=<UUID>&scope=…` | `did` = localStorage `__ds_remote_feature_did` | 200 |
| 密码登录 | `POST /api/v0/users/login` | `{email:"",mobile,password,area_code:"+86",device_id:"B…==",os:"web"}` | **`biz_code 11`** |
| 取短信 guest 挑战 | `POST /api/v0/users/create_guest_challenge` | — | 200，`{algorithm:"DeepSeekHashV1",challenge:"…"}` |
| 发短信 | `POST /api/v0/users/create_sms_verification_code` | `{locale:"zh_CN",turnstile_token:"",`**`shumei_verification:{region:"CN",rid:"20260930…"}`**`,device_id:"B…==",scenario:"login",mobile_number}` | 200，`send_window_secs:60` |
| 短信登录 | `POST /api/v0/users/login_by_mobile_sms` | `{region:"CN",locale:"zh_CN",mobile_number,area_code:"+86",sms_verification_code,device_id:"B…==",os:"web"}` | 200，`biz_code 1 LOGIN_TO_EXISTING_ACCOUNT` + `user.token` |

**三个决定性结论**：

1. **账号与出口 IP 都没问题**（短信登录直接拿到 token）；被拒的只有**密码登录**这一条路径——而且是在**真实浏览器 + 真实页面 JS + 真实 Shumei device_id** 下被拒。⇒ biz 11 与我们的代码、TLS、HTTP 线格式全部无关，最可能是**密码本身不对**（CN 平台常把凭证错误统一回成风控文案以防撞库），或该账号走的是「注册即短信、从未设密码」。
2. **发短信需要 `shumei_verification.rid`**（Shumei SDK 在浏览器里生成的设备风险令牌）⇒ **无头客户端根本无法走短信路径**，无论是 Workers 还是 VPS。
3. 页面里 12 次 `gator.volces.com`（火山引擎埋点/SDK）全部网络层失败（status 0），但既不阻止发码也不阻止登录 ⇒ 与本问题无关。

**对「逃生方案」的连带影响**：simple-chat 与 ds2api 都**只支持密码登录**（`accounts.json` = mobile/email + password）。也就是说，只要这个账号的密码路径走不通，**换成 VPS 跑容器也一样不可用**——两者共用同一个前置条件。

**唯一待确认项**：这个账号的密码到底是 `qwzas120` 吗？是「从未设过密码、一直短信登录」吗？这一项决定移植是否还有任何可行路径。

### token 模式实测：**API 通路全部打通（端到端真机验证）**（2026-09-30）

从浏览器取出 `localStorage.userToken`（注意：它是 `{"value":"<64 字符 token>","__version":…}` 的包装，**92 字符是包装后的长度**，直接用会得到 `code 40003 Authorization Failed`），配上实测的 web 指纹，**从 Node 进程**（非浏览器）依次调用：

| 步骤 | 结果 |
|---|---|
| `GET /api/v0/users/current` | 200，返回账号信息（`is_mainland:true`、`chat.is_muted:0`） |
| `POST /api/v0/chat_session/create` | 200，会话 id `fd6b277e-…` |
| `POST /api/v0/chat/create_pow_challenge` → 解算 → `POST /api/v0/chat/completion` | **200 `text/event-stream`**，真实产出：`event: ready` → `{"v":{"response":{…,"fragments":[{"id":2,"type":"RESPONSE","content":"你好"…` |

**结论修订（重要）**：

1. **协议移植本身成立且已被真实上游验证**：HashV1 PoW 被服务端接受、会话创建可用、SSE 形态与 `simple-chat` 的 `sse.go` 描述一致。T1/T2 的移植产物（pow / device / client）不是纸面正确，而是**打通过真实上游**。
2. **风控只卡「登录」，不卡 API**：一旦有 token，session / pow / completion 从非浏览器进程访问完全放行（至少从本机出口是这样）。
3 .**需要 token 供给方式**：网关无法自主密码登录（biz 11），短信登录需要真人 + 浏览器侧 Shumei `rid`。可行形态是**「浏览器登录一次 → 注入 token」**——这与 ai-gateway 既有的手工登录型 provider（kuku 扫码、trae 登录、cline OAuth 回调）是同一类设计，不是新范式。
4. **仍待测**：① token 的有效期（决定注入频率）；② **Cloudflare Workers 边缘出口**是否同样放行 API（决定「托管在 Workers」是否成立；这是 T0.2 的窄化版本，不再需要登录）。

### T0.2 Cloudflare 边缘探测（探针已就绪，待用户执行）

探针：`probe/worker.ts`（+ `probe/wrangler.toml`），复用 `src/deepseek/client`，**不内置凭据**，token 由请求体传入。

```powershell
# 1) 普通终端（非 DSH 沙箱）里部署 —— 临时预览账号，不需 CF 账号
cd D:\GitHub_Clone\ai-gateway
node node_modules\wrangler\wrangler-dist\cli.js deploy --temporary --config probe\wrangler.toml

# 2) 把打印出来的 URL 交给 Agent；Agent 用本机 .secrets 里的 token 调 /probe
#    POST <url>/probe  {"token":"…","headerDeviceId":"…","userAgent":"…"}
```

判定：`ok:true` 且 `chat/completion` 阶段有 SSE 字节 ⇒ CF 边缘可托管，移植继续；被 40003/风控/连接层拒 ⇒ CF 边缘不可用，转 VPS 方案。

### T0.2 实测结果：**CF 边缘通过（2026-09-30）**

临时预览部署 → `https://deepseek-probe.learned-bard.workers.dev`（`request.cf.colo = HKG`，HK 出口）：

| 阶段 | 结果 |
|---|---|
| `users/current` | ok，709ms，`biz_code 0`，账号信息正常 |
| `chat_session/create` | ok，384ms，会话 `4b011c03-…` |
| `chat/completion`（含 PoW 解算） | ok，**1333ms**，`text/event-stream`，1005 字节，真实产出 `"content":"你好"` + `quasi_status:"FINISHED"` |

**结论**：Cloudflare 边缘出口（数据中心 IP）**不被 API 侧风控拦截**，HashV1 PoW 在 Workers 运行时被服务端接受，SSE 形态完整。**托管目标成立。** 至此阶段 0 全部通过（唯一被卡的是「自主登录」，见上）。

**部署约束（2026-09-30 实测，本机）**
- `npx wrangler` 与 `node node_modules/wrangler/wrangler-dist/cli.js` 在本沙箱内都失败：wrangler 启动器与 esbuild 都 `spawn` 子进程，沙箱禁止管道 ⇒ `spawn EPERM`。**wrangler 只能在沙箱外的普通终端跑。**
- 本机 wrangler **未认证**（`You are not authenticated`），且无 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`。故 T0.2 的可行路径是 `wrangler deploy --temporary`（临时预览账号，真实 CF 边缘出口，无需 CF 账号），由用户在自己的终端执行；探针 Worker 写成**单文件纯 JS、零依赖**，避免 bundling。

**阶段 1 — 纯计算（无凭据、可离线验证）**
- [x] T1.1 `src/deepseek/pow.ts`：Keccak-f23/HashV1 + SolvePow + `BuildPowHeader`
- [x] T1.2 `src/deepseek/pow.test.ts`：5 条 golden vector + 真实挑战求解 + 边界（非法 hex / difficulty=0 / 取消）
      → 验证：`npx vitest run --pool=threads src/deepseek/pow.test.ts` **17/17 通过**；`npx tsc --noEmit` 干净。

**阶段 2 — 设备身份与客户端**
- [x] T2.1 `device.ts`：MD5 常量、AES-CBC 铸造、UUIDv5、rangers-id、web/android channel
      → 验证：`npx vitest run --pool=threads src/deepseek/` **37/37 通过**（含 uuidV5 对 RFC 4122 附录 DNS+python.org 标准向量、device_id 用字面量密钥独立解密回放）；`npx tsc --noEmit` 干净。
- [ ] T2.2 `client.ts`：baseHeaders、envelope/BizError、`postJSON/postEmpty/getJSON`、ban 分类（5/10/11）、IsAuthFailure/IsRetryable
- [x] T2.3 登录 + 懒重登 + 启动序列（`users/current`）
      → **上游硬卡密码登录**（真实浏览器同样 `biz_code 11`），故此路径**实现但不接入** provider 流程；改走 token 注入（见架构落点）。

**阶段 3 — 账号池**
- [ ] T3.1 KV **token 池** CRUD（token / headerDeviceId / userAgent / shumeiDeviceId / state / addedAt / expiredAt）
- [ ] T3.2 round-robin + 每 token in-flight 信号量 + QueueWait
- [ ] T3.3 token 失效标记与面板提示（`users/current` 判活；失效即 `expired`，不静默降级）

**阶段 4 — 补全链路**
- [x] T4.2 SSE → OpenAI：`src/deepseek/sse.ts`（解释器逐条移植 `sse.go`：JSON-patch `{p,o,v}`、省略 p/o 沿用上次、裸增量按上次片段 type 归属、BATCH、噪声路径过滤、`event: hint`、`content_filter`）+ OpenAI chunk / 错误帧 / `[DONE]` 构造器
      → 验证：`npx vitest run --pool=threads src/deepseek/sse.test.ts` **18/18 通过**，其中 3 例直接吃**真实上游固件**（`__fixtures__/completion-{plain,thinking,search}.sse.txt`，2026-09-30 抓取：1002/10378/7362 字节）。覆盖跨块切行、CRLF、THINK/RESPONSE 归属、搜索 hits 收集、断流不谎报 stop。
- [x] T4.3 非流式聚合：`aggregateDeepseekSse()` + `truncated` 语义（断流标 `length`，不谎报 `stop`）
- [x] T4.1a 上游补全请求体（10 字段 kotlinx 序、thinking/search 开关）——见 `client.ts`
- [ ] T4.1b messages → 上游单一 `prompt` 的扁平化规则（system/多轮/角色前缀，移植 `openai.go`）
- [ ] T4.2b `ReadableStream` 包装（上游流 → OpenAI SSE 响应体，含 idle 看门狗）——与 T6.1 接线一起做

**阶段 5 — 会话生命周期（cron）**
- [ ] T5.1 `chat_session/create`+`delete` 包装、`fetch_page` 列表
- [ ] T5.2 人类节奏清理（抖动 ±50%、floor、batch 1–3）
- [ ] T5.3 每周 purge-all（weekday/hour/宽限补跑）+ `DS_SESSION_CAP` 同步上限

**阶段 6 — 网关集成**
- [ ] T6.1 `proxy.ts` 4 个 dispatch 点 + `GET /v1/models` + 预置 DEFAULT_PROVIDERS 条目
- [ ] T6.2 管理后台：**token 注入面板**（粘贴 → 判活 → 存池）、池状态、失效提示 + 取 token 的操作指引（不回显完整 token）
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
- 风险 1（**已实测排除**）：CF 出口 IP 被风控。2026-09-30 临时 Worker（HKG）实测 `users/current` / `create` / `completion(+PoW)` 全通。**真正的限制是「无法自主登录」**：须由人从浏览器注入 token，token 失效后需重新注入（有效期待测）。
- 风险 2（已实测降级）：PoW 在 JS 里的 CPU 成本。本机实测 **86,022 次置换 = 313ms**（≈275k 置换/秒，3.6µs/次），一次 worst-case 144000 难度约 0.5s CPU，Workers Paid `cpu_ms=300000` 完全容得下。仍需按账号缓存挑战至 `expire_at`（同一 target_path 不必每次重解）。
- 风险 3：账号封禁不可逆（biz 10 永久）——测试必须用专门的小号，且 park 持久化要在阶段 3 就位，避免测试期把主号打死。
- 风险 4：上游协议随时变更（App 版本升级即失效）。移植不改变这一事实，只把维护面收敛到 `src/deepseek/`。
