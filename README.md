<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="llmswitch：为 Claude Code、Codex 和 OpenCode 切换供应商与模型工具">
</p>

<p align="center">
  <strong>一个 CLI 工具管理 Claude Code、Codex 与 OpenCode 的模型切换。</strong>
</p>

<p align="center">
  <strong>简体中文</strong> · <a href="./README_EN.md">English</a>
</p>

---

## 快速开始

### 安装

需要 Node.js 20+。

```bash
npm install -g @nvae/llmswitch
# 或
bun add -g @nvae/llmswitch
```

安装后使用 `llms`（或 `llm-switch`、`llmswitch`）命令。直接输入 `llms` 会自动选择工具并启动；`llms <tool>` 同理。

### 0. 一键启动（连贯流程）

```bash
# 选择工具并启动；未配置供应商时会自动引导：添加供应商 → 选模型 → 启用 → 启动
llms

# 直接启动 Codex（等价于 llms launch codex）
llms codex
```

`llms <tool>` 会根据状态自动衔接：

- 已配置供应商 → 直接启动（使用当前启用 / 默认供应商及其默认模型）
- 未配置 → 自动引导添加供应商、选择模型，静默启用后自动启动

### 1. 显式引导配置

```bash
llms setup
```

向导会依次引导：选择工具 → 添加供应商（API 地址、Key）→ 选择模型 → 启用 → 启动工具。已安装的工具会自动识别，只装一个时无需手动选择。

```bash
# 跳过工具选择，直接为 Codex 引导
llms setup --tool codex
```

### 2. 添加供应商配置

```bash
# 为 Claude Code 添加配置
llms claude provider

# 为 Codex 添加配置
llms codex provider

# 为 OpenCode 添加配置
llms opencode provider
```

按提示输入：API 地址、API Key、显示名称。

自定义上游时，工具会自动探测接口类型（Anthropic / OpenAI Chat / OpenAI Responses），无需手动选择；仅当自动识别失败时才需要手动指定。支持本地 Ollama（`/v1` 兼容或原生 `/api/tags`，无需 API Key），预设中也有「Ollama（本地）」可选。

Profile 名称会自动生成（5 位随机小写字母数字，如 `69pjb`），所有命令都可通过名称或显示名称引用供应商：

```bash
# 名称与显示名称均可引用
llms codex use 69pjb
llms codex use DeepSeek
llms launch codex --profile deepseek   # 归一化模糊匹配（忽略大小写/分隔符）
```

### 3. 选择模型

```bash
# 为当前工具选择模型
llms codex model

# 为指定配置选择模型
llms codex model --profile my-provider
```

有 API Key 时会自动获取上游模型列表，也可手动输入模型 ID。

### 4. 启用配置

```bash
llms codex use my-provider

# 查看当前配置状态
llms codex current
```

### 5. 启动工具

```bash
# 启动 Codex 并使用指定模型
llms launch codex gpt-4.1

# 启动 Claude Code
llms launch claude --model claude-sonnet-4-20250514

# 启动 OpenCode
llms run opencode my-model

# 指定配置启动
llms launch claude --profile my-provider --model claude-sonnet-4
```

未指定 `--profile` 时，会自动选择包含目标模型的配置。

### 6. 预览执行计划

```bash
# 只查看计划，不实际启动
llms launch codex gpt-4.1 --dry-run

# 输出 JSON 格式
llms launch codex gpt-4.1 --dry-run --json
```

### 7. 管理本地 Bridge

Claude Code 或 Codex 使用非原生协议时，会自动启动本地 Bridge。

```bash
# 查看 Bridge 状态
llms bridge status

# 手动启动/停止
llms bridge start
llms bridge stop

# 重载配置
llms bridge reload claude
llms bridge reload codex --profile my-provider
```

### 8. 对外提供 AI 网关

Bridge 服务的是本机的 Claude Code / Codex / OpenCode。如果要让**第三方客户端**通过一个端口访问你配置的模型，用 gateway：

```bash
# 1. 准备供应商（可从已有工具配置导入，按上游去重）
llms gateway provider import
# 或手动添加（自动探测接口类型与模型列表）
llms gateway provider add

# 2. 创建网关 API Key（明文只显示一次，请立即保存）
llms gateway key create --name my-app

# 3. 启动网关
llms gateway start

# 4. 查看状态与可路由模型
llms gateway status
llms gateway models
```

默认监听 `127.0.0.1:17900`。第三方客户端直接把它当成 OpenAI 或 Anthropic 端点使用：

```bash
# OpenAI 格式
curl http://127.0.0.1:17900/v1/chat/completions \
  -H "Authorization: Bearer llmsk-..." \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}]}'

# Anthropic 格式（同一个上游，网关自动转换）
curl http://127.0.0.1:17900/v1/messages \
  -H "x-api-key: llmsk-..." \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","max_tokens":1024,"messages":[{"role":"user","content":"hi"}]}'
```

**任意入口格式 ↔ 任意上游格式**。三种入口（OpenAI Chat、OpenAI Responses、Anthropic Messages）与三种上游格式可自由组合，含流式与工具调用；入口与上游格式相同时原样透传，避免无谓的转换损耗。已知限制：OpenAI Responses 的有状态特性（`previous_response_id`、`store`、后台模式）只在同格式透传时可用，跨格式转换不支持。

上游地址默认拼 `/v1` 前缀；非标准路径的上游可自定义：

```bash
# 直连 baseUrl（如 Gemini OpenAI 兼容端点 …/v1beta/openai）
llms gateway provider add --path-prefix ""
# 自定义前缀
llms gateway provider edit my-provider --path-prefix v2
```

| 端点 | 说明 |
| --- | --- |
| `GET /v1/models` | 可路由模型列表（按 Key 作用域过滤） |
| `GET /v1/models/{id}` | 单个模型详情（OpenAI 客户端兼容） |
| `POST /v1/chat/completions` | OpenAI Chat Completions |
| `POST /v1/completions` | Legacy Text Completions（`prompt` 自动转为消息） |
| `POST /v1/messages` | Anthropic Messages |
| `POST /v1/messages/count_tokens` | Anthropic 上游走原生接口，其他上游本地计算（见下） |
| `POST /v1/responses` | OpenAI Responses |
| `POST /v1/embeddings` | 仅 OpenAI 兼容上游 |
| `GET /health` | 存活探针（无需鉴权，不含任何配置信息） |

每个响应都带 `x-request-id`（客户端可传入以关联日志），并转发到上游，方便全链路排查。

**模型路由解析顺序**：

1. 显式别名（`llms gateway route add`）
2. 限定写法 `provider/model` 或 `provider:model`
3. 裸模型 id（在某个 provider 的模型列表中）
4. 未声明模型列表的 provider（作为 passthrough 兜底）
5. `config set --default-provider` 指定的兜底供应商

多个供应商提供同一模型时，按 `priority` 升序排列，自动构成 fallback 链：

```bash
# 别名 + 显式 fallback
llms gateway route add gpt-4o --provider azure --model gpt-4o-2024-11 --fallback openrouter/openai/gpt-4o

# 查看某个模型 id 的实际路由顺序
llms gateway resolve gpt-4o
```

**Provider fallback**：上游返回 429/5xx 等可重试状态或连接失败时自动换下一个供应商。响应一旦开始写出（流式首帧之后）便不再切换，避免给客户端拼接两段不一致的输出。

```bash
llms gateway config set --fallback true --max-attempts 3 --retry-statuses 429,500,502,503,504
```

**熔断冷却**：连续失败的上游会进入指数退避冷却（5s 起，封顶 2 分钟），冷却期内路由直接跳过它；全部候选都在冷却时仍会照常尝试。`llms gateway status` 会显示当前冷却中的供应商。

```bash
# 测试供应商连通性（拉模型列表；--call 额外发一次 1-token 补全）
llms gateway provider test my-provider --call

# 从上游重新拉取模型列表
llms gateway provider refresh-models my-provider

# 自定义上游请求头（可重复传）
llms gateway provider edit my-provider --header "X-Title: my-app"
```

**API Key 管理**：仅存储哈希，支持作用域、限额、过期、编辑与换发。

```bash
# 限定供应商、模型、接口格式与速率
llms gateway key create --name partner \
  --providers deepseek --models deepseek-chat \
  --formats openai-chat --rate-limit 60 --expires-in-days 30 \
  --daily-requests 5000

llms gateway key list
llms gateway key edit <id> --rate-limit 120          # 改限额/作用域/续期
llms gateway key rotate <id>                          # 换发明文，旧 Key 立即失效
llms gateway key revoke <id>
```

作用域说明：`--models` 按"客户端请求里的模型写法"匹配——限定别名就只用别名拼写访问，限定 `provider/model` 则两种写法都可；拼写错误在创建时会收到警告。

**限流**：计数持久化在 `gateway/rate-limit.json`，重启不丢失，多个网关进程共享同一份计数。响应会带标准限流头，客户端可据此自行退避：

```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 59
X-RateLimit-Reset: 1787894760
Retry-After: 43          # 仅 429 时出现
```

```bash
# 默认限额（Key 未单独设置时生效）
llms gateway config set --rate-limit 120

# 查看各 Key 当前窗口用量 / 清空计数
llms gateway ratelimit show
llms gateway ratelimit reset
```

`--rate-limit` 的语义：`-1` 完全不限流（豁免全局默认），`0` 继承全局默认，`> 0` 硬上限；`--daily-requests` 额外提供按 UTC 日的请求配额。

计数文件读写有锁保护；极端争用下拿不到锁时会放行请求而非阻塞流量，宁可限额略松也不卡住线上调用。

**Token 计数**：`count_tokens` 优先走上游原生接口（Anthropic 格式上游），拿不到时在本地计算并在 `llm_switch` 字段里说明来源：

```json
{
  "input_tokens": 1234,
  "llm_switch": {
    "estimated": true,
    "reason": "upstream_not_anthropic",
    "method": "heuristic",
    "breakdown": { "text": 30, "images": 1190, "tools": 0, "overhead": 14 }
  }
}
```

本地计算分两档：

- `heuristic`（默认，无额外依赖）：按书写系统分别计数（中日韩、拉丁、数字各有不同的字符/token 比），再加上每条消息、每个工具 schema 与请求信封的结构开销。实测对中英日韩散文、JSON 与表情符号的平均绝对误差约 11%，且绝大多数样本偏高而非偏低——用于判断"这个请求装不装得下"时偏保守更安全。标点密集的源码是已知弱项，可能低估约 15%。
- `tokenizer`（可选，精确）：装上 `gpt-tokenizer` 后自动启用，对 OpenAI 系编码是精确值，其他词表下也比启发式更接近。

```bash
# 需要精确计数时自行安装，llmswitch 不强制依赖它
npm install -g gpt-tokenizer

# 强制使用启发式
export LLM_SWITCH_DISABLE_TOKENIZER=1
```

两档都会额外计入图片开销：从 base64 头部解析 PNG / JPEG / GIF / WebP 的真实像素尺寸，按 `宽 × 高 / 750` 折算；无法判定尺寸时（例如 URL 图片）按保守值计入。

**用量统计**：网关按天记录每个（Key / 供应商 / 模型）组合的请求数与 token 用量，持久化在 `gateway/usage.json`（保留 90 天）：

```bash
llms gateway usage --days 7
llms gateway usage --json
llms gateway usage reset
```

**日志**：写入 `~/.config/llm-switch/gateway/gateway.log`，仅记录 Key 的 id，不记录明文或上游密钥；每行含 `req=<request-id>` 可与客户端和上游日志关联。启动时若超过 10MB 自动轮转为 `gateway.log.old`：

```bash
llms gateway logs              # 最后 100 行
llms gateway logs --lines 500
llms gateway logs --follow     # 持续跟踪
```

**运行时限额**（超时/并发/请求体大小）通过环境变量调整，与 Bridge 共用：

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `LLM_SWITCH_MAX_CONCURRENCY` | 16 | 最大并发请求数 |
| `LLM_SWITCH_MAX_BODY_BYTES` | 16MB | 请求体上限 |
| `LLM_SWITCH_MAX_RESPONSE_BYTES` | 32MB | 上游响应上限 |
| `LLM_SWITCH_CONNECT_TIMEOUT_MS` | 30000 | 上游连接超时 |
| `LLM_SWITCH_IDLE_TIMEOUT_MS` | 90000 | 流式空闲超时 |
| `LLM_SWITCH_TOTAL_TIMEOUT_MS` | 600000 | 单请求总超时 |

`llms gateway config show` 会一并显示当前生效值。

**对外暴露的安全要求**：默认只绑回环地址。绑到非回环地址必须显式传 `--allow-remote`，且至少存在一个有效 API Key，否则拒绝启动。

```bash
llms gateway start --host 0.0.0.0 --allow-remote
```

网关只提供明文 HTTP，请放在反向代理（Nginx / Caddy）后面终止 TLS，不要把裸 HTTP 直接暴露到公网。浏览器直连需显式开启 CORS（已允许 `anthropic-beta` 等请求头，并暴露限流与 request-id 响应头）：

```bash
llms gateway config set --cors-origins https://app.example.com
```

日志写入 `~/.config/llm-switch/gateway/gateway.log`，仅记录 Key 的 id，不记录明文或上游密钥。

---

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `llms` | 选择工具并启动（未配置时自动引导） |
| `llms <tool>` | 直接启动工具（未配置时自动引导完整链路） |
| `llms setup [--tool <tool>]` | 显式引导配置（添加供应商 → 模型 → 启用 → 启动） |
| `llms <tool> provider` | 管理供应商配置（添加、查看、编辑、删除） |
| `llms <tool> use [name]` | 启用指定配置 |
| `llms <tool> current` | 查看当前配置 |
| `llms <tool> model` | 选择模型 |
| `llms launch/run <tool> [model]` | 启动工具 |
| `llms bridge status` | 查看 Bridge 状态 |
| `llms gateway start` | 启动对外 AI 网关 |
| `llms gateway provider import` | 从工具配置导入网关供应商 |
| `llms gateway provider test <name>` | 测试供应商连通性 |
| `llms gateway key create` | 创建网关 API Key |
| `llms gateway key rotate <id>` | 换发 API Key |
| `llms gateway status` | 查看网关状态 |
| `llms gateway ratelimit show` | 查看各 Key 限流用量 |
| `llms gateway usage` | 查看按天聚合的用量统计 |
| `llms gateway logs` | 查看网关日志 |
| `llms path` | 查看数据目录 |

`<tool>` 可选 `claude`、`codex`、`opencode`。

查看完整帮助：

```bash
llms --help
llms launch --help
```

---

## 配置位置

| 数据 | 位置 |
| --- | --- |
| llmswitch 配置 | `~/.config/llm-switch/` |
| 网关供应商 / Key / 日志 | `~/.config/llm-switch/gateway/` |
| Claude Code | `~/.claude/settings.json` |
| Codex | `~/.codex/config.toml` |
| OpenCode | `~/.config/opencode/opencode.json` |

查看实际路径：

```bash
llms path
```

---

## 指定可执行文件路径

如果工具不在 `PATH` 中，可通过环境变量指定：

```bash
export CLAUDE_BIN=/path/to/claude
export CODEX_BIN=/path/to/codex
export OPENCODE_BIN=/path/to/opencode
```

---

## 反馈与建议

遇到问题或有改进想法，欢迎反馈：

- 邮箱：rchdg50@gmail.com
- GitHub Issues：https://github.com/rchdg/llmswitch/issues

---

## License

MIT License - 查看 [LICENSE](./LICENSE)