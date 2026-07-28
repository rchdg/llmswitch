# Claude OpenAI 兼容桥设计

日期：2026-07-28  
状态：已实现，待验收

## 背景与目标

Claude Code 仅消费 Anthropic Messages（`POST /v1/messages`）。用户希望在 `llms claude provider` 中也能添加「自定义（OpenAI 兼容）」供应商，由本工具在后台自动转换为 Anthropic 可消费的形式。

已确认约束：

1. **共用**现有 bridge 进程与端口（默认 `127.0.0.1:17890`）
2. 上游按工具隔离：`upstreams.claude` / `upstreams.codex`，可同时指向不同上游
3. Claude 自定义预设**仅**支持 Chat Completions（不提供 Completions / Responses）

## 架构与数据流

```
Claude Code
  → ANTHROPIC_BASE_URL = http://127.0.0.1:17890
  → POST /v1/messages（含 stream）
       ↓
llm-switch bridge（与 Codex 共用进程）
  → 读取 upstreams.claude
  → Anthropic Messages → OpenAI Chat Completions
  → 上游 POST {base}/chat/completions
  → 将上游响应译回 Anthropic JSON / SSE
```

Codex 路径不变：`POST /v1/responses` → `upstreams.codex` →（现有）Chat/Completions 翻译。

`GET /v1/models` / `GET /models`：

- **合并**两侧上游的 `/models` 结果，按模型 `id` 去重
- 一侧失败不影响另一侧；两侧皆失败则返回错误

Health：`GET /health` 返回两侧上游摘要（可为空）。

## 预设与兼容性

### `supportedFormats`

| 工具 | 格式 |
|------|------|
| `claude` | `anthropic`, `openai-chat` |
| `codex` | `openai-responses`, `openai-chat`（不变） |
| `opencode` | 不变 |

### 预设可见性

| 模版 | Claude | Codex | OpenCode |
|------|--------|-------|----------|
| 自定义（OpenAI 兼容） | ✓ **新增** | ✓ | ✓ |
| OpenAI | ✗ | ✓ | ✓ |
| Anthropic | ✓ | ✗ | ✓ |

Claude 选择「自定义」时：

- `apiFormat` 固定为 `openai-chat`
- **不**询问上游类型（无 Completions / Responses 选项）
- Base URL 走现有 OpenAI 格式规范化（末尾有且仅有一个 `/v1`）

## Claude adapter 行为

### 启用 `openai-chat` profile

1. 规范化 `baseUrl`
2. `ensureBridgeForProfile` 写入 `upstreams.claude` 并确保 bridge 进程在听
3. `ANTHROPIC_BASE_URL` = bridge 根地址（`http://127.0.0.1:17890`，**不含**多余 path；Claude Code 自行请求 `/v1/messages`）
4. 继续写入 `ANTHROPIC_AUTH_TOKEN`、模型相关 env、代理 env（与现逻辑一致）
5. `restartHint` 说明已启用本地 Anthropic↔Chat 桥

### 启用 `anthropic` profile

行为与现网一致：直连 `profile.baseUrl`，**不**写入/更新 `upstreams.claude`，不因本 profile 单独要求 bridge。

### 禁用

清除 Claude 托管 env；清除 `upstreams.claude`；若 `upstreams.codex` 亦空则可停止 bridge（与现「无人使用则停」策略对齐，实现时复用/扩展现有 stop 条件）。

## Bridge 状态迁移

### 新格式 `upstream.json`

```json
{
  "codex": { "baseUrl", "apiKey", "mode", "proxy?", "headers?", "profileName?", "updatedAt" } | null,
  "claude": { "baseUrl", "apiKey", "mode", "proxy?", "headers?", "profileName?", "updatedAt" } | null
}
```

- Claude 侧 `mode` 固定为 `"chat"`（写入时强制）
- Codex 侧仍可为 `chat` | `completions`

### 旧格式兼容

若文件为旧版单对象（存在顶层 `baseUrl` 且无 `codex`/`claude` 键），读取时迁移为：

```json
{ "codex": <旧对象>, "claude": null }
```

并在下次写入时落盘新格式。运行时状态同步为 `upstreams: { codex, claude }`；`llms bridge status` 展示两侧。

### 写入 API

- `writeBridgeUpstream(tool, upstream)` / `ensureBridgeForProfile(profile, tool)`  
  - Codex 路径传 `codex`  
  - Claude 路径传 `claude`  
- 同一进程内刷新某一侧不影响另一侧已有配置

## 协议翻译（Claude 路径）

新增模块（建议）：

- `src/bridge/anthropic-translate-request.ts` — Messages → Chat
- `src/bridge/anthropic-translate-response.ts` — Chat → Messages（含 SSE）

不复用 Responses 翻译器（协议形状不同）；可复用底层 SSE 行解析、proxy env、`joinUrl` 等基础设施。

### 请求映射

| Anthropic | Chat Completions |
|-----------|------------------|
| `model` | `model` |
| `system`（string 或 text blocks） | `messages` 首条 `role=system` |
| `messages` 文本 | `messages` user/assistant 文本 |
| `tool_use`（assistant） | `tool_calls` |
| `tool_result`（user） | `role=tool` + `tool_call_id` |
| `tools[].input_schema` | `tools[].function.parameters` |
| `tool_choice: auto` | `tool_choice: auto` |
| `tool_choice: any` | `tool_choice: required` |
| `tool_choice: { type: tool, name }` | `tool_choice: { type: function, function: { name } }` |
| `max_tokens` | `max_tokens` |
| `temperature` / `top_p` / `stream` | 同名透传 |

首版范围：

- **做**：文本、工具调用往返、流式与非流式
- **不做**：图像/文档块、prompt caching、完整 thinking/reasoning blocks（若出现则尽量忽略或降级为可跳过，不阻断主文本）

### 响应映射

非流式：

- assistant `content` 文本 → `{ type: "text", text }`
- `tool_calls` → `{ type: "tool_use", id, name, input }`（`arguments` JSON 解析失败时 `input` 为 `{}`）
- `finish_reason`：`stop`→`end_turn`，`tool_calls`→`tool_use`，`length`→`max_tokens`

流式：输出 Anthropic SSE，至少覆盖 Claude Code 常用事件序：

`message_start` → `content_block_start` / `content_block_delta` / `content_block_stop`（文本与 tool_use）→ `message_delta`（含 `stop_reason`）→ `message_stop`

上游错误：将 HTTP 状态与 body 尽量转为 Anthropic 风格 error JSON；网络失败返回 502。

### 路由

| 方法 | 路径 | 上游 |
|------|------|------|
| POST | `/v1/messages` 或 `/messages` | `upstreams.claude` |
| POST | `/v1/responses` 或 `/responses` | `upstreams.codex` |
| GET | `/v1/models`、`/models` | 合并两侧 |
| GET | `/health`、`/v1/health` | 状态 |

若 `POST /v1/messages` 时 `upstreams.claude` 为空 → 503，提示先 `llms claude use <openai-chat profile>`。

认证：优先透传入站 `Authorization` / `x-api-key`；否则用对应上游 `apiKey` 作为 `Bearer`。

## 文档与 CLI

- README：Claude + 自定义（经本地桥）说明；预设表、格式表、bridge 章节更新为「Codex Responses + Claude Messages」
- `llms bridge status`：展示 claude/codex 两侧上游
- 错误文案与 help 中凡写「仅 Codex」处改为双边

## 测试计划

1. Anthropic→Chat 请求翻译（system、多轮、tools、tool_result）
2. Chat→Anthropic 非流式与流式（文本 + tool_use）
3. 旧 `upstream.json` 迁移为 `{ codex, claude }`
4. `buildClaudeSettings`：`openai-chat` 时 `ANTHROPIC_BASE_URL` 为桥地址；`anthropic` 时为 profile.baseUrl
5. `presetsForTool("claude")` 含 `custom` + `anthropic`
6. `assertCompatible("claude", "openai-chat")` 通过；`openai-responses` 仍拒绝
7. 现有 Codex bridge 单测回归通过

## 非目标（本规格不做）

- Claude 支持 `openai-responses` 或 Completions 上游模式
- 图像等多模态完整支持
- 将 bridge 拆成独立 npm 包
- 迁移用户磁盘上旧 Claude profile 的语义（无 openai-chat Claude profile 则无需迁移）

## 验收标准

1. `llms claude provider` → 添加：可见「自定义（OpenAI 兼容）」「Anthropic」；自定义不询问 Completions/Responses
2. 启用 Claude openai-chat profile 后，Claude Code 发消息经 bridge 打到上游 `/v1/chat/completions`，工具调用可用
3. 同时启用 Claude 与 Codex 的不同 openai-chat 上游时，两侧互不覆盖
4. 仅启用 Anthropic 格式 Claude profile 时行为与改前一致
5. `bun test` 通过；README 与相关文案无「Claude 仅 anthropic / 桥仅 Codex」半截残留
