# llm-switch

为 **Claude Code**、**Codex**、**OpenCode** 切换供应商、默认模型与上游代理的纯命令行工具。

三个工具的配置彼此独立，互不影响。

## 安装

```bash
npm install -g llm-switch
# 或
bun add -g llm-switch
```

安装后可使用命令：`llms` 或 `llm-switch`。

## 快速开始

```bash
# 管理供应商（顶部添加；选中后：设默认 / 启用禁用 / 查看 / 编辑 / 删除）
llms claude provider
llms codex provider

# 配置模型（先选供应商 → 拉取列表 → 选默认 → 空格多选 → 回车确认）
llms claude model
llms codex model

# 启用已有供应商
llms claude use my-provider

# 快捷启动（类似 ollama run：先切模型，再拉起 CLI）
llms launch codex --model gpt-4.1
llms launch codex gpt-4.1
llms run claude --profile my-provider
llms launch opencode --model xxx --print-only   # 只切配置不启动

# 查看当前
llms claude current

# 同样适用于 codex / opencode
llms opencode provider
```

添加或编辑供应商时，从三种预设模版中选择（按工具过滤）：**自定义（OpenAI 兼容）**、**OpenAI**、**Anthropic**。填写 Base URL、API Key、上游代理并拉取模型的流程对各工具一致。

## 快捷启动

类似 `ollama run`：切换 profile/模型并启动对应命令行工具。

```bash
llms launch codex --model gpt-4.1
llms launch codex gpt-4.1                 # 位置参数同样表示模型
llms run claude --profile my-provider     # run 是 launch 的别名
llms launch opencode mymodel --resume     # 余下参数传给底层 CLI
llms launch codex --model x --print-only  # 只写配置，不启动
llms launch codex --model x --dry-run     # 只看计划
```

解析规则：

- 未指定 `--profile` 时，优先选择**模型列表里包含该模型**的 profile；否则用当前启用项
- 模型 ID 支持模糊匹配（`gpt4.1` ≈ `gpt-4.1`）
- 底层命令默认：`claude` / `codex` / `opencode`，可用 `CLAUDE_BIN` / `CODEX_BIN` / `OPENCODE_BIN` 覆盖

## 预设模版

| 模版 | 默认格式 | 预填 Base URL | 可用工具 |
|------|----------|---------------|----------|
| 自定义（OpenAI 兼容） | Chat Completions | 空（自行填写） | Claude Code、Codex、OpenCode |
| OpenAI | OpenAI Responses | `https://api.openai.com/v1`（可改） | Codex、OpenCode |
| Anthropic | Anthropic Messages | `https://api.anthropic.com`（可改） | Claude Code、OpenCode |

选择「自定义」时：

- **Claude Code**：固定 Chat Completions，启用时经本地桥转为 Anthropic Messages（不再询问 Completions/Responses）
- **Codex**：默认 Chat Completions（经本地桥兼容 `/v1/responses`）；仍可改为原生 Responses 或 Completions
- **OpenCode**：可选手动选 Chat / Responses 等（见添加流程）

## 支持的接口格式

| 格式 | 说明 | 可用工具 |
|------|------|----------|
| `anthropic` | Anthropic Messages | Claude Code、OpenCode |
| `openai-chat` | OpenAI Chat Completions | OpenCode、**Claude Code / Codex（经本地 bridge）** |
| `openai-responses` | OpenAI Responses | Codex、OpenCode |

OpenCode **不会**走本地 bridge；`openai-chat` 直接用 `@ai-sdk/openai-compatible`。对 `openai-chat` / `openai-responses`，Base URL 会自动规范为末尾有且仅有一个 `/v1`（例如 `http://host:8000` → `http://host:8000/v1`，`.../v1/v1/` → `.../v1`）。

### Claude Code + 仅有 Chat Completions 的上游

Claude Code 只认 Anthropic Messages。若自定义 API 只有 `/v1/chat/completions`，添加时选择 **自定义（OpenAI 兼容）**，启用时会自动：

1. 启动本地适配桥（默认 `http://127.0.0.1:17890`，与 Codex 共用进程）
2. 把 `ANTHROPIC_BASE_URL` 指到该桥根地址
3. 桥将 `POST /v1/messages` 转成上游 chat，再把结果转回 Anthropic JSON / SSE

Claude 与 Codex 的桥上游彼此隔离，可同时指向不同供应商。

```bash
llms claude provider
# 选择「添加新供应商」→ 自定义（OpenAI 兼容）
# 填写 Base URL 与 API Key

llms claude use my-provider
llms bridge status
```

### Codex + 仅有 Chat/Completions 的上游

新版 Codex 只认 `/v1/responses`。若你的自定义 API 只有 `/v1/chat/completions`（或 `/v1/completions`），添加供应商时选择 **自定义（OpenAI 兼容）**（默认 Chat Completions），启用时会自动：

1. 启动本地适配桥（默认 `http://127.0.0.1:17890`）
2. 把 Codex 的 `base_url` 指到该桥
3. 桥将 `POST /v1/responses` 转成上游 chat（必要时回退 completions），再把流式结果转回 Responses 事件

```bash
llms codex provider
# 选择「添加新供应商」→ 自定义（OpenAI 兼容）→ 默认 Chat Completions
# 填写 Base URL 与 API Key

llms launch codex --model my-model

llms bridge status
llms bridge stop
```

仅支持 `/v1/completions` 时，在上游接口类型中选择 Completions，或在 profile 中设置 `"bridgeMode": "completions"`。默认 `bridgeMode` 为 `chat`。

## 上游代理

在 `provider` 添加或编辑供应商时可配置：

- HTTP 代理（`HTTP_PROXY`）
- HTTPS 代理（`HTTPS_PROXY`）
- 全局代理（`ALL_PROXY`，适合 `socks5h://127.0.0.1:1080` 等）

```bash
llms claude provider
# 添加或编辑供应商 → 填写代理字段
```

启用（`use` / `provider` → 启用）或编辑已启用供应商的代理后，会写入对应工具配置中的环境变量。Codex / OpenCode 一般需要**新开终端或重启会话**后生效。

## 命令一览

统一形式：`llms <tool> <action>`，其中 `<tool>` 为 `claude` | `codex` | `opencode`。

| 命令 | 说明 |
|------|------|
| `llms <tool> provider` | 供应商管理：顶部添加；选中后可设默认 / 启用或禁用 / 查看 / 编辑 / 删除（含上游代理） |
| `llms <tool> use [name]` | 启用已有供应商 |
| `llms <tool> current` | 查看默认与当前启用项（密钥脱敏） |
| `llms <tool> model` | 先选供应商，再拉取模型并空格多选；已启用时同步写回 |

只要存在供应商，就会自动保证有一个**默认供应商**（未设置时兜底为列表第一项）。`provider` 与 `model` / `use` 的供应商列表会在名称后标注 `（默认）`、`（已启用）`。「启用」会写入对应工具配置；「禁用」会清除本工具写入的配置。模型配置请使用 `model` 命令。

其他：

```bash
llms path          # 本地配置目录
llms launch …      # 切换模型并启动 CLI
llms bridge …      # 本地协议适配桥（Codex / Claude）
llms --help
```

## 配置存放位置

- 本工具数据：`~/.config/llm-switch/`（可用环境变量 `LLM_SWITCH_HOME` 覆盖）
- Claude Code：`~/.claude/settings.json`（`CLAUDE_CONFIG_DIR`）
- Codex：`~/.codex/config.toml` 与 `~/.codex/.env`（`CODEX_HOME`）
- OpenCode：`~/.config/opencode/opencode.json` 与数据目录下的 `auth.json`

切换前会自动备份被改动的目标配置到本工具目录的 `backups/` 下。

## 开发

```bash
bun install
bun test
bun run build
bun run dev codex -h
bun run dev codex provider
```

## License

MIT
