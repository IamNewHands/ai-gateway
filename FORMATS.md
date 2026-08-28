# AI Gateway 多格式转换保真度核对

本文档核对 AI Gateway 支持的三种 API 格式（OpenAI Chat Completions、OpenAI Responses、Anthropic Messages）之间的请求体 / 响应体 / 流式转换保真度，记录每个字段的映射关系与已知有损点。

> 核对基于 `src/formats.ts` 与 `src/proxy.ts`（commit：anthropic-native 适配）。

## 架构总览

网关内部统一以 **OpenAI Chat Completions 格式**作为中间表示：

```
客户端(三种格式任一)
  └─> 网关(解析 + 注入缓存前缀/思维引导 + 各种桥接，均作用于 OpenAI 形态)
        └─> 上游出口
              ├─ provider.apiType === 'openai'（默认）→ 直接发 OpenAI chat/completions
              └─ provider.apiType === 'anthropic'（如 api.anthropic.com）→ 转回 Anthropic /v1/messages 原生格式
```

- `provider.apiType` 是**提供商级**配置（默认 `'openai'`），只影响「网关 → 上游」的出口格式。
- 客户端侧**不需要**改对接方式：无论客户端配 Anthropic / Responses / Chat Completions 哪种，网关都会转换到对应上游格式。
- 三种入口路径：`POST /v1/messages`（Anthropic）、`POST /v1/responses`（Responses）、`POST /v1/chat/completions`（Chat）。

## 一、请求体转换

### A. Anthropic Messages → OpenAI Chat（`anthropicToOpenAI`）

| 字段 | 映射 | 保真 |
|---|---|---|
| `system`（字符串或块数组） | 只取 text 块 → system 消息 | ⚠️ system 内非 text 块（如 image）丢弃 |
| user 纯文本 | `content` 字符串 | ✅ |
| user text/image 混合块 | 转 `text` / `image_url`(base64 data URL) | ✅ |
| user `tool_result` | 拆为 `role:tool` + 后续 user | ✅ 顺序正确（tool 在前） |
| assistant text | `content` | ✅ |
| assistant `tool_use` | `tool_calls`（arguments 为 JSON 字符串） | ✅ |
| assistant `thinking` | 丢弃 | ❌ OpenAI chat 无对应字段 |
| `max_tokens` | `max_completion_tokens` | ✅ |
| `stop_sequences` | `stop` | ✅ |
| `temperature` / `top_p` | 同名字段 | ✅ |
| `top_k` | 丢弃 | ❌ OpenAI 无对应 |
| `tools` | function tools（parameters=input_schema） | ✅ |
| `tool_choice` auto/any/tool/none | auto/required/`{type:function}`/none | ✅ 语义等价 |
| `disable_parallel_tool_use` | `parallel_tool_calls:false` | ✅ |
| `thinking` → `reasoning_effort` | enabled→high / disabled→none | ⚠️ 粗略映射 |
| `metadata` | 丢弃 | ❌ |

### B. Responses → OpenAI Chat（`responsesToOpenAI`）

| 字段 | 映射 | 保真 |
|---|---|---|
| `instructions` | system 消息 | ✅ |
| `input` 字符串/数组 | user 消息 / 逐条映射 | ✅ |
| input 中 `function_call` 历史项 | 忽略 | ❌ 多轮工具调用场景丢失 |
| `max_output_tokens` | `max_completion_tokens` | ✅ |
| `tools` / `tool_choice` / `reasoning.effort` | 对应映射 | ✅ |
| `previous_response_id` / `store` 等 | 丢弃 | ❌ 无对应 |

### C. OpenAI Chat → Anthropic Messages（`openAIRequestToAnthropic`，anthropic-native 方向）

| 字段 | 映射 | 保真 |
|---|---|---|
| system 消息 | `system` 字符串（多条 `\n\n` 连接） | ✅ |
| user 纯文本 | `content` 字符串 | ✅ |
| user text/image_url（base64 或 http） | text / `image` 块（base64 或 `source:{type:'url'}` 直通） | ✅ 支持两种图片来源 |
| `role:tool` 消息 | `tool_result` 块 | ✅ 与后续用户文本合并进同一条 user 消息（符合 Anthropic 规范） |
| assistant text + `tool_calls` | text 块 + `tool_use` 块 | ✅ |
| `max_tokens` / `max_completion_tokens` | `max_tokens`（缺失时给默认 4096） | ⚠️ 缺失时强给默认值 |
| `temperature` / `top_p` | 同名字段 | ✅ |
| `stop` | `stop_sequences` | ✅ |
| `tools` | `input_schema` | ✅ |
| `tool_choice` auto/none/required/`{fn}` | auto/none/any/`{type:tool}` | ✅ |
| `reasoning_effort` | `thinking`(disabled/enabled+预算)。档位归一化：none/off/minimal→disabled，low→2048，medium→8192，high→16384，ultra/max/extreme/super→32768 | ⚠️ 粗略映射，但超高档不再被降级为中等 |
| `parallel_tool_calls:false` | `disable_parallel_tool_use` | ✅ |

## 二、响应体转换

### D. Anthropic → OpenAI Chat 非流式（`anthropicResponseToOpenAI`）

| 字段 | 映射 | 保真 |
|---|---|---|
| text 块 | `content`（多块拼接） | ✅ |
| `tool_use` | `tool_calls`（JSON.stringify input） | ✅ |
| `thinking` 块 | `reasoning_content` | ✅ 保留思考内容 |
| `stop_reason` | `finish_reason`（end_turn→stop 等） | ✅ |
| `usage` input/output/cache_read | prompt/completion/total + cached_tokens | ✅ |
| `id` | `id`（去掉 msg_ 前缀） | ✅ |

### E. Anthropic → Responses 非流式（`anthropicResponseToResponses`）

| 字段 | 映射 | 保真 |
|---|---|---|
| text 块 | output message / `output_text` | ✅ |
| `tool_use` | `function_call`（id/call_id/name/arguments） | ✅ |
| `thinking` 块 | 丢弃 | ❌ Responses 无标准对应（可选 reasoning item，未实现） |
| `stop_reason` | `status:completed` | ✅ 语义等价 |
| `usage` | input/output/total + cached | ✅ |

## 三、流式转换

### F. Anthropic SSE → OpenAI SSE（`createAnthropicSSEToOpenAI`）

| 事件 | 映射 | 保真 |
|---|---|---|
| `message_start` | chunk{role:assistant, content:''} | ✅ |
| `content_block_start`(text) | 不输出（等 text delta） | ✅ 符合 OpenAI 语义 |
| `content_block_start`(tool_use) | `tool_calls` 起始帧 | ✅ 多工具 index 追踪 |
| `text_delta` | `content` delta | ✅ |
| `thinking_delta` | `reasoning_content` delta | ✅ |
| `input_json_delta` | `tool_calls` arguments delta | ✅ 按 blockIndex→tool 序号匹配 |
| `message_delta` | finish_reason + usage 帧 | ✅ 只发一次（去重） |
| `message_stop` | `[DONE]` | ✅ |

### G. Anthropic SSE → Responses SSE（`createAnthropicSSEToResponses`）

| 事件 | 映射 | 保真 |
|---|---|---|
| `message_start` | `response.created` + `in_progress` | ✅ |
| `content_block_start`(text) | `output_item.added` + `content_part.added` | ✅ |
| `content_block_start`(tool_use) | `output_item.added`(function_call) | ✅ 多工具 id/name 按 idx 记录 |
| `text_delta` | `output_text.delta` | ✅ |
| `input_json_delta` | `function_call_arguments.delta` | ✅ item_id 按 tool 匹配 |
| `thinking_delta` | 丢弃 | ❌ |
| `message_delta` | `response.completed`（汇总 output+usage） | ✅ 只发一次（去重） |
| `message_stop` | 无（completed 已发） | ✅ |

## 四、认证头转换（anthropic-native 方向）

网关 → 原生 `api.anthropic.com` 时，认证从 OpenAI 风格 `Authorization: Bearer <key>` 切换为 Anthropic 风格：

```
x-api-key: <provider.apiKeys[].key>
anthropic-version: 2023-06-01
anthropic-dangerous-direct-browser-access: true
```

同时也携带 `Authorization: Bearer <key>`，以兼容 SenseNova（https://platform.sensenova.cn/docs）等第三方「Anthropic 兼容」端点——这类端点要求 `Authorization: Bearer`，忽略 `x-api-key`（否则返回 `code 16: Authorization Not Found`）。与官方 `api.anthropic.com` 同时发送两者互不冲突。

- 请求路径固定为 `${cleanBase}/v1/messages`（baseUrl 兼容 `https://api.anthropic.com` 与 `https://api.anthropic.com/v1` 两种写法）。
- 多 Key 顺序 failover：单 Key 故障（HTTP 非 2xx / 网络异常）自动切换下一个。
- 客户端透传头（`x-` / `anthropic-` / `user-` 前缀）仍会原样透传给上游。

## 五、保真度总结

- **保真度高**：文本、工具调用（含多工具并行）、usage、base64/url 图片、thinking 思考流（chat 方向）全部保留。
- **结构性有损（两格式无对应字段，属预期）**：
  1. `top_k`、`metadata`（Anthropic → OpenAI 方向丢弃）
  2. Responses input 中的 `function_call` / `function_call_output` 历史项（Responses → OpenAI 方向忽略）
  3. thinking 块在 Responses 响应方向丢弃
  4. system 内非 text 块丢弃
- **语义等价**（非逐字节，但行为一致）：`tool_choice`、`stop_reason`、`reasoning_effort ↔ thinking`、`max_tokens ↔ max_completion_tokens`。

## 六、本地测试

本地可通过 `wrangler dev` + 管理 API 配置一个 `apiType: 'anthropic'` 的提供商指向 mock 上游（模拟 `api.anthropic.com`），分别用三种客户端格式（/v1/messages、/v1/responses、/v1/chat/completions）调用，核对请求到达 mock 时已是 Anthropic 原生格式、认证头为 `x-api-key`，且响应正确转回客户端格式。

详细步骤见本仓库的开发环境配置（`wrangler.toml`、`.dev.vars`）。
