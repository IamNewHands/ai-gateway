# AI Gateway API 文档

## Base URL

```
https://你的域名
```

## 认证方式

### 管理后台认证 (Session Cookie)

登录成功后通过 `Set-Cookie` 写入 `session_id`（HttpOnly、Secure、SameSite=Lax，有效期 7 天）。后续所有 `/admin/*` 请求需携带该 Cookie。

| 端点 | 方法 | 说明 |
|------|------|------|
| `/admin/login` | GET | 登录页面 |
| `/admin/login` | POST | 登录提交 |
| `/admin/logout` | GET | 退出登录 |

#### POST /admin/login

提交 JSON 进行登录校验（用户名明文比对，密码 SHA-256 哈希比对）。

**请求体**:
```json
{
  "username": "admin",
  "password": "your_password"
}
```

**成功响应** (`200`):
```json
{
  "success": true,
  "message": "登录成功"
}
```

**失败响应**:

| 状态码 | 场景 | 响应 |
|--------|------|------|
| 400 | 用户名/密码为空 | `{ "success": false, "message": "请输入用户名和密码" }` |
| 401 | 用户名或密码错误 | `{ "success": false, "message": "用户名或密码错误" }` |
| 500 | 未配置管理员账号 | `{ "success": false, "message": "未配置管理员账号，请在 Cloudflare 环境变量中设置 ADMIN_USERNAME 和 ADMIN_PASSWORD" }` |

#### GET /admin/logout

删除当前 Session 并清除 Cookie，重定向到首页 (`/`)。

---

### API 转发认证 (Bearer Token)

所有 `/v1/*` 请求需在 Header 中携带转发 API Key（即管理后台生成的 `sk_cf_*`）：

```
Authorization: Bearer sk_cf_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**失败响应** (`401`):
```json
{
  "error": { "message": "缺少或无效的 Authorization 头，格式: Bearer sk_cf_*", "type": "authentication_error" }
}
```
或
```json
{
  "error": { "message": "API Key 无效或已禁用", "type": "authentication_error" }
}
```

### 对外管理 API 认证 (Management Token)

`/api/manage/*` 端点供外部脚本（手机、CI 等）维护 provider，使用独立的 `MANAGEMENT_TOKEN`（环境变量）做 Bearer 认证，与上述两套凭证无关：

```
Authorization: Bearer <MANAGEMENT_TOKEN>
```

未配置 `MANAGEMENT_TOKEN` → `503`；缺失/不匹配 → `401`。完整对接说明与多语言 demo 代码见 [MANAGE_API.md](./MANAGE_API.md)。

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/manage/providers` | GET | 查询全部 provider |
| `/api/manage/providers/upsert` | POST | upsert + 合并 provider（存在则合并 keys/models，不存在则创建） |
| `/api/manage/providers/:id` | DELETE | 删除 provider |

## API 端点

### 公开端点

#### GET /

首页，返回站点信息与所有已启用提供商/模型列表（无需认证）。

---

### API 转发端点（需 Bearer Token）

#### GET /v1/models

返回所有已启用的模型列表（提供商与模型均需处于启用状态）。

**响应**:
```json
{
  "object": "list",
  "data": [
    {
      "id": "opencode/deepseek-v4-flash-free",
      "provider": "opencode",
      "provider_name": "OpenCode",
      "object": "model",
      "created": 1712345678,
      "owned_by": "opencode"
    }
  ]
}
```

---

#### POST /v1/chat/completions

转发 OpenAI 兼容的聊天补全请求。

**请求体**:
```json
{
  "model": "opencode/deepseek-v4-flash-free",
  "messages": [{"role": "user", "content": "Hello!"}]
}
```

模型格式: `提供商ID/模型ID`

**响应**: 透传 AI 提供商的原始响应（含流式响应）。

---

#### POST /v1/messages

转发 Anthropic 兼容的 Messages 请求。需将模型指定为 `anthropic/<模型ID>`。

**请求体**:
```json
{
  "model": "anthropic/claude-sonnet-4-20250514",
  "messages": [{"role": "user", "content": "Hello!"}],
  "max_tokens": 1024
}
```

**响应**: 透传 Anthropic 的原始响应。

---

#### ALL /v1/*

其他 `/v1/*` 子路径请求会原样透传到对应提供商。转发逻辑：

1. 解析 `model` 字段中的 `提供商ID/模型ID`，定位提供商与模型配置
2. 校验提供商/模型是否启用、是否配置了可用 API Key
3. 将请求体中的 `model` 改写为纯 `模型ID`，路径去除 `/v1/` 前缀拼接到提供商 `baseUrl`
4. **Key 排序与健康检查**：
   - 读取该提供商下每个 Key 的历史健康状态（基于 KV 持久化）
   - **健康 Key**（无失败记录）：Fisher-Yates 洗牌后优先使用
   - **不健康 Key**（有失败记录，< 5 次）：追加到队列末尾
   - **降权 Key**（连续失败 >= 5 次）：进入冷却排除，**1 小时后自动恢复试用**
   - **试用 Key**（冷却到期）：追加到不健康 Key 之后，限试一次
   - 仅有 1 个 Key 时跳过所有健康检查
5. 按排序后的顺序依次尝试；遇 `401/403/5xx` 或网络错误时标记该 Key 失败（`failures++`、`demotedAt` 刷新）并切换下一个，成功时重置该 Key 的健康状态；遇 `429` 时不记录失败，切换下一个key

**Key 健康状态**存储在 KV 中（`key:health:{providerId}`），每次请求后更新，仅保留有失败记录的 Key。

> Anthropic 协议的提供商请求会使用 `x-api-key` + `anthropic-version: 2023-06-01` 头；OpenAI 协议使用 `Authorization: Bearer <key>` 头。请求超时为 60 秒。

#### OpenCode 专用故障转移

OpenCode 是全新部署唯一的默认提供商，默认启用以下模型：

- `deepseek-v4-flash-free`
- `mimo-v2.5-free`
- `nemotron-3-ultra-free`
- `hy3-free`

默认官方地址为 `https://opencode.ai/zen/v1`，上游 API Key 可以留空：

1. 配置了启用的 Key 时，先使用后台配置的 OpenCode 地址和用户 Key。
2. 官方请求未成功后，从随机起点依次尝试三个固定公共镜像。
3. 未配置 Key 时直接进入公共镜像链路。
4. 公共镜像使用内置 `Authorization: Bearer public`，不会写入 KV 或显示在管理页。
5. 镜像遇到网络错误、超时或任意非成功 HTTP 状态时继续下一镜像；每个镜像最多尝试一次。
6. 一旦收到成功响应便直接透传，包括 SSE 流式响应；流中途失败不会重新请求。
7. 后台检测到的 OpenCode 模型列表仅显示 `big-pickle` 和以 `-free` 结尾的模型 ID。

**管理后台 OpenCode 特殊处理**：
- **创建**：ID 输入 `opencode` 时自动填充官方 API 地址 `https://opencode.ai/zen/v1`，模型字段留空，API Key 可选
- **测试**：未填写 API Key 时自动走镜像地址获取可用模型列表；若镜像未配置则提示"请先填写 API Key 或配置 OPENCODE_MIRRORS_URL 环境变量"
- **编辑**：提供"获取模型"按钮，一键从镜像或官方获取可用模型列表并添加到表单

### 环境变量 `OPENCODE_MIRRORS_URL`

类型：`string`（多行文本，每行一个 URL）

控制 OpenCode 镜像降级时使用的地址列表。默认值由部署脚本写入三个镜像地址：

- `https://opencode.ai.cmliussss.net/zen/v1`
- `https://opencode.fastly.cmliussss.net/zen/v1`
- `https://opencode.gcore.cmliussss.net/zen/v1`

用户可通过 GitHub Actions Variables 设置 `OPENCODE_MIRRORS_URL`，内容追加到默认地址之后，全局去重（保留首次出现顺序）。设置方式：

- **GitHub 仓库** → Settings → Secrets and variables → Actions → Variables → 新增 `OPENCODE_MIRRORS_URL`
- 支持换行或逗号分隔，每行/每段一个 URL

若部署时未设置或设为空字符串，则 `mirrorUrls = []`，官方地址失败后不做镜像降级。

已有 KV 中的 Provider 不会被删除或覆盖；缺少 `opencode` 时只追加默认配置。其他 Provider 仍使用原有单地址和 Key 健康调度逻辑。

---

### 管理 API 端点（需 Session 认证）

所有 `/admin/api/*` 端点需先登录并携带 Session Cookie，未登录返回 `401`：
```json
{ "success": false, "message": "未登录" }
```
Session 过期返回 `401`：
```json
{ "success": false, "message": "Session 已过期" }
```

#### GET /admin/api/status

获取系统状态总览。

**响应**:
```json
{
  "success": true,
  "data": {
    "providersCount": 4,
    "enabledProvidersCount": 4,
    "modelsCount": 12,
    "enabledModelsCount": 12,
    "proxyKeysCount": 2,
    "adminConfigured": true,
    "baseUrl": "https://your-domain.com"
  }
}
```

| 字段 | 说明 |
|------|------|
| `providersCount` | 提供商总数 |
| `enabledProvidersCount` | 已启用提供商数 |
| `modelsCount` | 模型总数 |
| `enabledModelsCount` | 已启用模型数 |
| `proxyKeysCount` | 已启用的转发 Key 数 |
| `adminConfigured` | 是否已配置 `ADMIN_USERNAME` / `ADMIN_PASSWORD` |
| `baseUrl` | 当前部署的根域名 |

---

#### GET /admin/api/providers

获取所有提供商列表（含完整 API Key）。

**响应**:
```json
{
  "success": true,
  "data": [
    {
      "id": "deepseek",
      "name": "DeepSeek",
      "baseUrl": "https://api.deepseek.com",
      "apiType": "openai",
      "apiKeys": [
        { "key": "sk-xxx1", "enabled": true },
        { "key": "sk-xxx2", "enabled": false }
      ],
      "models": [
        { "id": "deepseek-chat", "enabled": true },
        { "id": "deepseek-reasoner", "enabled": false }
      ],
      "enabled": true,
      "createdAt": "2024-01-01T00:00:00.000Z",
      "updatedAt": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

---

#### POST /admin/api/providers

添加新提供商。

**请求体**:
```json
{
  "id": "my-provider",
  "name": "我的提供商",
  "baseUrl": "https://api.example.com",
  "apiType": "openai",
  "apiKeys": ["sk-xxx"],
  "models": ["model-1", "model-2"],
  "enabled": true
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✅ | 提供商唯一标识，需全局唯一。当 `id` 为 `opencode` 且未传 `baseUrl` 时自动填充 `https://opencode.ai/zen/v1` |
| `name` | ✅ | 显示名称 |
| `baseUrl` | ✅ ¹ | 提供商 API 基础地址，尾部 `/` 会被自动去除 |
| `apiType` | ❌ | `openai`（默认）或 `anthropic` |
| `apiKeys` | ❌ | 字符串数组或 `{key, enabled}` 对象数组。opencode 可留空（走镜像） |
| `models` | ❌ | 字符串数组或 `{id, enabled}` 对象数组 |
| `enabled` | ❌ | 默认 `true` |

> ¹ 当 `id` 为 `opencode` 时 `baseUrl` 可选，后台自动填充，不传不会触发必填校验错误。

**成功响应** (`201`): 返回新建的 Provider 对象。

**冲突响应** (`409`): `提供商 id "my-provider" 已存在`。

---

#### PUT /admin/api/providers/:id

更新提供商配置。`id`、`baseUrl`、`apiType` 等字段均可更新，`updatedAt` 自动刷新。

**请求体**（所有字段可选）:
```json
{
  "name": "新名称",
  "baseUrl": "https://new-api.example.com",
  "apiType": "anthropic",
  "apiKeys": [{"key": "sk-new-key", "enabled": true}],
  "models": [{"id": "new-model", "enabled": true}],
  "enabled": false
}
```

> `apiKeys` / `models` 传数组时为**整体替换**，支持字符串数组或 `{key/id, enabled}` 对象数组。

**成功响应**: 返回更新后的 Provider 对象。

**未找到** (`404`): `提供商不存在`。

---

#### DELETE /admin/api/providers/:id

删除提供商。

**成功响应**:
```json
{ "success": true, "message": "提供商已删除" }
```

---

#### POST /admin/api/providers/:id/test-model

测试指定提供商下某个模型的连接是否可用。发送最小请求（`max_tokens: 1`，超时 15 秒）。

**请求体**:
```json
{
  "modelId": "deepseek-chat"
}
```

**响应**:
```json
{
  "success": true,
  "data": {
    "success": true,
    "message": "连接成功",
    "statusCode": 200
  }
}
```

> `data.success` 表示实际连接是否成功；外层 `success` 固定为 `true` 表示测试流程本身执行完成。

---

#### POST /admin/api/test-key

测试指定 API Key 的连接是否可用（用于"添加新提供商"表单，无需提供商已保存）。通过服务端代理请求上游 `/models` 端点，避免浏览器跨域限制。

**请求体**:
```json
{
  "url": "https://api.deepseek.com",
  "apiKey": "sk-xxx",
  "apiType": "openai",
  "providerId": "opencode"
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `url` | ✅ | API 基础地址，尾部 `/` 会被自动去除 |
| `apiKey` | ✅ (opencode 可选) | 待测试的 API Key。opencode 可留空，将走镜像地址获取模型 |
| `apiType` | ❌ | `openai`（默认）或 `anthropic` |
| `providerId` | ❌ | 提供商 ID。当为 `opencode` 时走专用逻辑；为空则走标准测试 |

**opencode 特殊行为**:
- `apiKey` 为空时，自动使用 `OPENCODE_MIRRORS_URL` 配置的镜像地址（`Bearer public`）获取模型
- 若镜像未配置（`OPENCODE_MIRRORS_URL` 为空），返回明确错误提示："请先填写 API Key 或配置 OPENCODE_MIRRORS_URL 环境变量"
- 返回的模型列表自动过滤，仅保留 `-free` 结尾和 `big-pickle` 模型

**成功响应**:
```json
{
  "success": true,
  "data": {
    "success": true,
    "statusCode": 200,
    "data": { "object": "list", "data": [...] }
  }
}
```

> 连接成功时 `data.data` 包含上游返回的模型列表；连接失败时 `data.success` 为 `false`，`message` 包含错误描述，`statusCode` 为 `0`（网络错误）或具体 HTTP 状态码。

---

#### POST /admin/api/test-model

测试指定模型的连接是否可用（用于"添加新提供商"表单）。通过服务端代理请求上游 `/chat/completions` 或 `/messages` 端点，避免浏览器跨域限制。

**请求体**:
```json
{
  "url": "https://api.deepseek.com",
  "apiKey": "sk-xxx",
  "apiType": "openai",
  "model": "deepseek-chat"
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `url` | ✅ | API 基础地址 |
| `apiKey` | ✅ | 待测试的 API Key |
| `apiType` | ❌ | 决定使用 `/chat/completions`（openai）或 `/messages`（anthropic） |
| `model` | ✅ | 模型 ID |

**成功响应**:
```json
{
  "success": true,
  "data": {
    "success": true,
    "statusCode": 200
  }
}
```

---

#### GET /admin/api/proxy-keys

获取所有转发 API Key 列表。返回的 `key` 字段会做脱敏处理（仅显示前 8 位 + `****` + 后 4 位）。

**响应**:
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "key": "sk_cf_xxxxxx****xxxx",
      "name": "测试 Key",
      "enabled": true,
      "createdAt": "2024-01-01T00:00:00.000Z",
      "expiresAt": null
    }
  ]
}
```

---

#### POST /admin/api/proxy-keys

生成新的转发 API Key。Key 格式为 `sk_cf_` + 32 位随机 hex，**仅在此响应中返回完整明文，之后不再可见**。

**请求体**（全部可选）:
```json
{
  "name": "我的Key名称",
  "expiresIn": "90d"
}
```

`expiresIn` 可选值：

| 值 | 有效期 |
|----|--------|
| `30d` | 30 天 |
| `90d` | 90 天 |
| `180d` | 180 天 |
| `1y` | 1 年（365 天） |
| `forever` | 永久（默认） |

**成功响应** (`201`):
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "key": "sk_cf_abcdef0123456789abcdef0123456789",
    "name": "我的Key名称",
    "enabled": true,
    "createdAt": "2024-01-01T00:00:00.000Z",
    "expiresAt": "2024-04-01T00:00:00.000Z"
  },
  "message": "请立即保存此 Key，关闭后将不再显示"
}
```

---

#### PATCH /admin/api/proxy-keys/:id

更新转发 Key 的启用状态。

**请求体**:
```json
{ "enabled": false }
```

**成功响应**: 返回更新后的 ProxyKey 对象（key 仍为完整值）。

**未找到** (`404`): `转发 Key 不存在`。

---

#### DELETE /admin/api/proxy-keys/:id

删除转发 API Key。

**成功响应**:
```json
{ "success": true, "message": "转发 Key 已删除" }
```

---

## 错误响应格式

所有 API 错误返回以下格式:

```json
{
  "error": {
    "message": "错误描述",
    "type": "error_type"
  }
}
```

部分错误（如所有 Key 耗尽）会附带 `detail` 字段：
```json
{
  "error": {
    "message": "所有 API Key 已用完，最后一次错误: HTTP 429",
    "type": "key_exhausted",
    "detail": "..."
  }
}
```

常见错误类型:

| 类型 | 说明 |
|------|------|
| `authentication_error` | 认证失败（缺少/无效 Token 或 Session） |
| `invalid_request_error` | 请求参数错误（如缺少 model、模型格式错误、提供商/模型不存在） |
| `provider_disabled` | 提供商已禁用 |
| `model_disabled` | 模型已禁用 |
| `configuration_error` | 配置错误（如提供商未配置可用 API Key） |
| `key_exhausted` | 所有 API Key 均失败 |
| `proxy_error` | 转发过程出错（如网络异常） |
| `server_error` | 服务器内部错误 |
| `not_found` | 接口不存在（404） |

管理 API 的错误响应使用 `success: false` + `message` 的格式：

```json
{ "success": false, "message": "错误描述" }
```
