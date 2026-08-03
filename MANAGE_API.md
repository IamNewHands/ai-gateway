# 对外管理 API 对接文档（给对接 AI / 开发者）

> 本文档面向「帮助开发者对接 AI Gateway 的 AI agent」与开发者本人。读完本文即可通过脚本维护网关的 provider（厂商）配置，无需登录管理后台。

## 1. 这个 API 是做什么的 / What it is

AI Gateway 是一个 Cloudflare Workers 上的 AI API 代理网关。它把多个上游 AI 厂商（DeepSeek、OpenAI、中转站等）统一成 OpenAI 兼容的 `/v1/*` 接口，客户端用一把 `sk_cf_*` key 即可调用所有模型。

**对外管理 API（`/api/manage/*`）** 让你用脚本（手机、CI、其他服务）维护这些 provider 配置：增删厂商、推送 API Key、同步模型列表。它与浏览器管理后台（`/admin/api/*`，session cookie 认证）并存，但走独立的 Token 认证，互不影响。

典型用途：手机上用脚本把某个中转站的地址 + key + 模型列表推送到网关，自动合并维护。

---

## 2. 前置准备 / Prerequisites

在 Cloudflare Dashboard 配置管理 Token：

**Cloudflare Dashboard → Workers & Pages → 你的 ai-gateway → Settings → Variables and Secrets → Add variable：**

| 变量名 | 值 | 说明 |
|---|---|---|
| `MANAGEMENT_TOKEN` | 你自定义的任意字符串，例如 `mt-9f3a7c2e1b8d4e6f` | 对外管理 API 的 Bearer Token。**不配置则 `/api/manage/*` 一律返回 503**。 |

> 建议用足够长的随机串（≥32 字符），并在 Secrets 里加密存储。Token 泄露后更换该变量即可，不影响浏览器登录密码。

**Base URL**：`https://你的网关域名`（下文以 `https://gateway.example.com` 演示，替换为你自己的）。

---

## 3. 认证 / Authentication

所有 `/api/manage/*` 请求必须在 Header 携带：

```
Authorization: Bearer <你的 MANAGEMENT_TOKEN>
```

| 状态码 | 场景 | 响应体 |
|---|---|---|
| `401` | 缺失 `Authorization` 头 / 格式错 / Token 不匹配 | `{ "success": false, "message": "缺少或无效的 Authorization 头..." }` 或 `"管理 Token 无效"` |
| `503` | 未配置 `MANAGEMENT_TOKEN` 环境变量 | `{ "success": false, "message": "管理 API 未启用（未配置 MANAGEMENT_TOKEN）" }` |

> 注意：这是与「转发 key」（`sk_cf_*`，用于 `/v1/*` 调模型）和「管理员账密」（用于 `/admin/*` 后台）**完全独立**的第三套凭证，三者不要混用。

---

## 4. 通用响应格式 / Response format

成功：
```json
{ "success": true, "data": { ... } }
```
失败：
```json
{ "success": false, "message": "错误描述" }
```

---

## 5. 数据模型 / Data model

### Provider（厂商）
```ts
{
  id: string          // 唯一标识，也是模型前缀，如 "deepseek"。创建后不可改
  name: string        // 显示名，如 "DeepSeek"
  baseUrl: string     // 上游 API 地址，如 "https://api.deepseek.com"（尾部 / 自动去除）
  apiType: "openai" | "anthropic"   // 上游协议，默认 openai
  authType: "api-key" | "oauth-device"  // 认证方式，默认 api-key
  apiKeys: ApiKeyEntry[]   // 上游 API Key 列表
  models: Model[]          // 该厂商提供的模型列表
  enabled: boolean         // 是否启用
  createdAt: string        // ISO 时间
  updatedAt: string        // ISO 时间
  oauth?: OAuthDeviceConfig  // OAuth 配置（脚本不碰，走后台 UI）
}
```

### ApiKeyEntry
```ts
{ key: string, enabled: boolean }
```

### Model
```ts
{ id: string, enabled: boolean }
```

> 客户端调模型时用 `模型 = providerId + "/" + modelId`，例如 `deepseek/deepseek-chat`。

---

## 6. 端点详解 / Endpoints

### 6.1 GET `/api/manage/providers` — 查询全部 provider

返回所有 provider 的完整配置（含 key 明文，请妥善保管）。

**请求**：
```bash
curl -H "Authorization: Bearer <TOKEN>" https://gateway.example.com/api/manage/providers
```

**响应** (`200`)：
```json
{
  "success": true,
  "data": [
    {
      "id": "deepseek",
      "name": "DeepSeek",
      "baseUrl": "https://api.deepseek.com",
      "apiType": "openai",
      "authType": "api-key",
      "apiKeys": [{ "key": "sk-aaa", "enabled": true }],
      "models": [{ "id": "deepseek-chat", "enabled": true }],
      "enabled": true,
      "createdAt": "2026-08-03T10:00:00.000Z",
      "updatedAt": "2026-08-03T10:00:00.000Z"
    }
  ]
}
```

---

### 6.2 POST `/api/manage/providers/upsert` — Upsert + 合并（核心）

**存在则合并、不存在则创建。** 这是手机维护场景的主接口。

**请求体**：
```json
{
  "id": "myrelay",
  "name": "我的中转站",
  "baseUrl": "https://relay.example.com/v1",
  "apiType": "openai",
  "apiKeys": ["sk-aaa", { "key": "sk-bbb", "enabled": true }],
  "models": ["deepseek-chat", "deepseek-reasoner"],
  "enabled": true
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | provider 唯一标识。存在则合并，不存在则创建。`id=opencode` 且未传 `baseUrl` 时自动填充官方地址 |
| `name` | 创建时必填 | 显示名。已存在时传了则覆盖 |
| `baseUrl` | 创建时必填 | 上游地址，尾部 `/` 自动去除。已存在时传了则覆盖 |
| `apiType` | ❌ | `openai`（默认）或 `anthropic` |
| `authType` | ❌ | `api-key`（默认）或 `oauth-device`。**OAuth provider 不建议用脚本维护**，走后台 UI |
| `apiKeys` | ❌ | 字符串数组 或 `{key, enabled}` 对象数组，**合并**（见下） |
| `models` | ❌ | 字符串数组 或 `{id, enabled}` 对象数组，**合并**（见下） |
| `enabled` | ❌ | 默认 `true` |

**合并语义（关键）**：
- `apiKeys`：以现有 key 列表为底，按 **key 字符串去重追加**。已存在的 key **保留原 enabled、不覆盖、不重复**；新 key 追加为 `enabled: true`。**永不删除已有 key**。
- `models`：以现有模型列表为底，按 **id 去重追加**。已存在的模型保留；新模型追加为 `enabled: true`。**永不删除已有模型**。
- `name`/`baseUrl`/`apiType`/`authType`/`enabled`：传了就覆盖；不传保持原值。
- `oauth`：脚本无法修改，始终保留原值。

**响应**：返回合并/创建后的完整 provider。
- 创建成功 → `201`
- 合并成功 → `200`
- `id` 缺失 → `400`；新建时 `name`/`baseUrl` 缺失 → `400`

**合并示例**：

假设 `myrelay` 当前有 `apiKeys=[sk-aaa]`、`models=[deepseek-chat]`。再次请求：
```json
{ "id": "myrelay", "apiKeys": ["sk-bbb"], "models": ["qwen-plus", "deepseek-chat"] }
```
结果：`apiKeys=[sk-aaa, sk-bbb]`（sk-aaa 保留），`models=[deepseek-chat, qwen-plus]`（deepseek-chat 去重，qwen-plus 新增）。`name`/`baseUrl` 不变。

---

### 6.3 DELETE `/api/manage/providers/:id` — 删除 provider

```bash
curl -X DELETE -H "Authorization: Bearer <TOKEN>" https://gateway.example.com/api/manage/providers/myrelay
```

**成功** (`200`)：`{ "success": true, "message": "提供商已删除" }`
**未找到** (`404`)：`{ "success": false, "message": "提供商不存在" }`

> 删除 OAuth provider 会同时清理其 token 状态。

---

### 6.4 POST `/api/manage/checkin` — WorkBuddy 每日签到（手动触发）

触发所有 WorkBuddy/CodeBuddy OAuth 账号签到（领取免费积分）。仅 CN 账号签到，国际版自动跳过。定时任务每天 09:00/21:00（北京时间）自动执行，此接口供脚本手动触发。

**全量签到**：
```bash
curl -X POST -H "Authorization: Bearer <TOKEN>" \
  https://gateway.example.com/api/manage/checkin
```

**单个账号签到**（指定 provider id）：
```bash
curl -X POST -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
  https://gateway.example.com/api/manage/checkin \
  -d '{"id":"workbuddy"}'
```
或 `POST /api/manage/checkin/:id`（路径参数形式）。

**全量响应** (`200`)：
```json
{
  "success": true,
  "data": {
    "total": 2, "success": 1, "already": 1, "fail": 0, "skipped": 0,
    "results": [
      { "providerId": "workbuddy", "name": "WorkBuddy", "realm": "cn",
        "success": true, "reason": "ok", "message": "签到成功",
        "todayCheckedIn": true, "streakDays": 5, "totalCredits": 1200,
        "lastCheckinAt": 1785770000000, "updatedAt": 1785770000000 }
    ]
  }
}
```

`reason` 取值：`ok`（本次签到成功）| `already`（今日已签）| `skipped_global`（国际版跳过）| `skipped_no_token`（未登录）| `fail`（失败，看 `message`）。

> 签到结果同时写入管理后台「签到」面板与系统日志。多账号：每个 WorkBuddy 账号是一个独立 provider（如 workbuddy、workbuddy-2），全量签到会遍历所有 OAuth provider。

---

## 7. 完整对接流程 / End-to-end flow

```
1. 后台设好 MANAGEMENT_TOKEN 环境变量
2. 脚本调 POST /api/manage/providers/upsert 推送 provider（地址+key+模型）
3. 后台生成一把转发 key sk_cf_*（给客户端调模型用，只能后台生成）
4. 客户端用 sk_cf_* 调 POST /v1/chat/completions，model="providerId/modelId"
```

> 第 3 步的 `sk_cf_*` 转发 key 目前**只能通过管理后台 UI 生成**（`/admin/api/proxy-keys`，session 认证），不在对外管理 API 范围内。一把 `sk_cf_*` 可调用所有已启用 provider 的模型。

**调用模型示例**（用转发 key，不是管理 token）：
```bash
curl -H "Authorization: Bearer sk_cf_xxx" -H "Content-Type: application/json" \
  https://gateway.example.com/v1/chat/completions \
  -d '{"model":"myrelay/deepseek-chat","messages":[{"role":"user","content":"你好"}]}'
```

---

## 8. Demo 代码 / Demo code

### 8.1 curl

```bash
# 查询
curl -H "Authorization: Bearer mt-9f3a7c2e1b8d4e6f" \
  https://gateway.example.com/api/manage/providers

# 新建 / 合并
curl -X POST https://gateway.example.com/api/manage/providers/upsert \
  -H "Authorization: Bearer mt-9f3a7c2e1b8d4e6f" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "myrelay",
    "name": "我的中转站",
    "baseUrl": "https://relay.example.com/v1",
    "apiType": "openai",
    "apiKeys": ["sk-aaa"],
    "models": ["deepseek-chat", "deepseek-reasoner"]
  }'

# 追加 key（合并，不覆盖 sk-aaa）
curl -X POST https://gateway.example.com/api/manage/providers/upsert \
  -H "Authorization: Bearer mt-9f3a7c2e1b8d4e6f" \
  -H "Content-Type: application/json" \
  -d '{"id":"myrelay","apiKeys":["sk-bbb"],"models":["qwen-plus"]}'

# 删除
curl -X DELETE -H "Authorization: Bearer mt-9f3a7c2e1b8d4e6f" \
  https://gateway.example.com/api/manage/providers/myrelay
```

### 8.2 Python（requests）

```python
import requests

GATEWAY = "https://gateway.example.com"
TOKEN = "mt-9f3a7c2e1b8d4e6f"
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}

def list_providers():
    r = requests.get(f"{GATEWAY}/api/manage/providers", headers=HEADERS, timeout=30)
    r.raise_for_status()
    return r.json()["data"]

def upsert_provider(payload: dict):
    """payload 至少含 id；新建时需 name + baseUrl。"""
    r = requests.post(f"{GATEWAY}/api/manage/providers/upsert",
                      headers=HEADERS, json=payload, timeout=30)
    r.raise_for_status()
    return r.json()["data"]

def delete_provider(provider_id: str):
    r = requests.delete(f"{GATEWAY}/api/manage/providers/{provider_id}",
                        headers=HEADERS, timeout=30)
    r.raise_for_status()
    return r.json()

# 示例：推送一个中转站
upsert_provider({
    "id": "myrelay",
    "name": "我的中转站",
    "baseUrl": "https://relay.example.com/v1",
    "apiType": "openai",
    "apiKeys": ["sk-aaa"],
    "models": ["deepseek-chat", "deepseek-reasoner"],
})

# 示例：追加一把 key 和一个模型（自动合并，不覆盖已有）
upsert_provider({
    "id": "myrelay",
    "apiKeys": ["sk-bbb"],
    "models": ["qwen-plus"],
})

# 查看当前所有 provider
for p in list_providers():
    print(p["id"], p["baseUrl"], len(p["apiKeys"]), "keys,", len(p["models"]), "models")
```

### 8.3 JavaScript / Node.js（fetch）

```js
const GATEWAY = "https://gateway.example.com";
const TOKEN = "mt-9f3a7c2e1b8d4e6f";
const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

async function listProviders() {
  const r = await fetch(`${GATEWAY}/api/manage/providers`, { headers });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return (await r.json()).data;
}

async function upsertProvider(payload) {
  const r = await fetch(`${GATEWAY}/api/manage/providers/upsert`, {
    method: "POST", headers, body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return (await r.json()).data;
}

async function deleteProvider(id) {
  const r = await fetch(`${GATEWAY}/api/manage/providers/${id}`, {
    method: "DELETE", headers,
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

// 用法
await upsertProvider({
  id: "myrelay", name: "我的中转站", baseUrl: "https://relay.example.com/v1",
  apiKeys: ["sk-aaa"], models: ["deepseek-chat"],
});
console.log(await listProviders());
```

### 8.4 手机 Shell 快捷函数（termux / iOS a-Shell 等）

把下面存成脚本，手机上 source 后即可 `gw_add myrelay sk-aaa`：

```bash
#!/data/data/com.termux/files/usr/bin/bash
GW="https://gateway.example.com"
TK="mt-9f3a7c2e1b8d4e6f"

gw_list() { curl -s -H "Authorization: Bearer $TK" "$GW/api/manage/providers"; }

# gw_add <id> <name> <baseUrl> <key> [model1 model2 ...]
gw_add() {
  local id="$1" name="$2" url="$3" key="$4"; shift 4
  local models=$(printf '"%s",' "$@" | sed 's/,$//')
  curl -s -X POST "$GW/api/manage/providers/upsert" \
    -H "Authorization: Bearer $TK" -H "Content-Type: application/json" \
    -d "{\"id\":\"$id\",\"name\":\"$name\",\"baseUrl\":\"$url\",\"apiKeys\":[\"$key\"],\"models\":[$models]}"
}

# gw_addkey <id> <key>           追加 key（合并）
gw_addkey() { curl -s -X POST "$GW/api/manage/providers/upsert" \
  -H "Authorization: Bearer $TK" -H "Content-Type: application/json" \
  -d "{\"id\":\"$1\",\"apiKeys\":[\"$2\"]}"; }

# gw_addmodel <id> <model...>    追加模型（合并）
gw_addmodel() { local id="$1"; shift; local m=$(printf '"%s",' "$@" | sed 's/,$//');
  curl -s -X POST "$GW/api/manage/providers/upsert" \
  -H "Authorization: Bearer $TK" -H "Content-Type: application/json" \
  -d "{\"id\":\"$id\",\"models\":[$m]}"; }

# gw_del <id>
gw_del() { curl -s -X DELETE -H "Authorization: Bearer $TK" "$GW/api/manage/providers/$1"; }
```

用法：
```bash
gw_add myrelay "我的中转" https://relay.example.com/v1 sk-aaa deepseek-chat deepseek-reasoner
gw_addkey myrelay sk-bbb
gw_addmodel myrelay qwen-plus
gw_list | jq '.data[] | {id, keys: (.apiKeys|length), models: (.models|length)}'
```

---

## 9. 错误处理建议 / Error handling

| 场景 | 判断 | 处理 |
|---|---|---|
| Token 未配 / 错 | `401` 或 `503` | 检查 `MANAGEMENT_TOKEN` 环境变量与请求头 |
| 新建缺字段 | `400` `name、baseUrl 为必填项` | 补全 `name`、`baseUrl` |
| `id` 冲突？ | 不会报错 | upsert 设计为幂等：存在即合并，不报冲突 |
| 网络超时 | `fetch` 抛异常 | 重试；upsert 幂等可安全重发 |
| 合并后 key 没变 | 检查 key 字符串 | key 按**字符串完全相等**去重，注意前后空格 |

**幂等性**：upsert 可安全重发。重复推相同的 `apiKeys`/`models` 不会产生重复项（去重），也不会删除任何已有项。

---

## 10. 常见问题 / FAQ

**Q：一个中转站有多把 key 怎么维护？**
A：同一个 `id` 下分多次 `upsert`，每次带不同 key 字符串，自动合并追加，互不影响。一把 key 失效后网关转发时会自动降权冷却，切换到其他 key。

**Q：不同中转站想分开维护？**
A：用不同 `id`（如 `relay-a`、`relay-b`），每个是一个独立 provider，各自有自己的 `baseUrl` 和 key。客户端用 `relay-a/模型` 或 `relay-b/模型` 调用。

**Q：能用这个 API 生成给客户端的 `sk_cf_*` 转发 key 吗？**
A：不能。`sk_cf_*` 目前只能通过管理后台 UI（`/admin/api/proxy-keys`，session 登录）生成。对外管理 API 只管 provider，不管转发 key。

**Q：能用这个 API 配置 OAuth 登录（如 WorkBuddy）吗？**
A：不能。OAuth 涉及浏览器交互登录，必须走管理后台 UI。脚本只维护 `authType=api-key` 的普通 provider。

**Q：apiType 选 openai 还是 anthropic？**
A：按**上游**实际协议选。中转站/OpenAI 兼容选 `openai`；只有真 Anthropic 上游才选 `anthropic`。**与客户端调用格式无关**——客户端无论用 `/v1/chat/completions`、`/v1/messages`(Anthropic) 还是 `/v1/responses`，网关都会自动转换，上游永远是 OpenAI 格式通信。

**Q：删除 provider 会影响正在进行的请求吗？**
A：已发出的请求继续完成；之后的请求会因 provider 不存在返回 404。删除不可恢复。

---

## 11. 端点速查表 / Quick reference

| 方法 | 路径 | 认证 | 作用 |
|---|---|---|---|
| GET | `/api/manage/providers` | Bearer MANAGEMENT_TOKEN | 查询全部 provider |
| POST | `/api/manage/providers/upsert` | Bearer MANAGEMENT_TOKEN | upsert + 合并 provider |
| DELETE | `/api/manage/providers/:id` | Bearer MANAGEMENT_TOKEN | 删除 provider |
| POST | `/api/manage/checkin` | Bearer MANAGEMENT_TOKEN | WorkBuddy 全量签到（可选 body `{id}` 单个） |
| POST | `/api/manage/checkin/:id` | Bearer MANAGEMENT_TOKEN | 单个账号签到 |
| GET | `/v1/models` | Bearer `sk_cf_*` | 查询可用模型（给客户端用） |
| POST | `/v1/chat/completions` | Bearer `sk_cf_*` | OpenAI 格式调用模型 |
| POST | `/v1/messages` | Bearer `sk_cf_*` | Anthropic 格式调用模型 |
| POST | `/v1/responses` | Bearer `sk_cf_*` | OpenAI Responses 格式调用模型 |

> 管理用 `MANAGEMENT_TOKEN`，调用模型用 `sk_cf_*`，两套凭证不要混。
