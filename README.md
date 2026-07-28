<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="llmswitch：为 Claude Code、Codex 和 OpenCode 切换供应商与模型，并按需转换 API 协议">
</p>

<p align="center">
  <strong>用一套 CLI 管理 Claude Code、Codex 与 OpenCode 的供应商、模型、代理和启动流程。</strong>
</p>

<p align="center">
  <strong>简体中文</strong> · <a href="./README_EN.md">English</a>
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#兼容性">兼容性</a> ·
  <a href="#命令参考">命令参考</a> ·
  <a href="#配置与安全">配置与安全</a> ·
  <a href="./LICENSE">MIT License</a>
</p>

## llmswitch 是什么？

`llmswitch` 是一个面向 **Claude Code、Codex 和 OpenCode** 的本地命令行工具。它使用彼此独立的 profile 管理每种工具的 API 地址、密钥、模型和代理，并将选中的 profile 合并写入目标工具的原生配置。

原生协议可以直接连接；当 Claude Code 或 Codex 需要访问仅兼容 OpenAI Chat Completions 的上游时，`llmswitch` 会自动启动一个仅监听本机的 bridge，完成常用请求、响应和 SSE 事件的协议转换。

```text
                            ┌─ Claude Code ── Anthropic Messages
provider profiles ─ llms ──┼─ Codex ──────── OpenAI Responses
                            └─ OpenCode ────── 原生 provider
                                  │
                     协议不兼容时启用 local bridge
                                  │
                            OpenAI Chat API
```

## 核心能力

- **统一操作三种工具**：使用一致的命令管理 Claude Code、Codex 和 OpenCode。
- **配置相互隔离**：每种工具独立保存 profile、默认项和当前启用项，不会混用供应商配置。
- **一条命令切换并启动**：选择 profile 和模型、更新配置，然后启动目标 CLI。
- **按需转换协议**：在 Messages / Responses 与 Chat Completions 之间转换常用文本、工具调用、工具结果及流式事件。
- **保留现有配置**：只合并受管理字段，并在修改已有目标文件前创建时间戳备份。
- **支持模型发现**：尝试从上游 `/models` 获取模型；失败时可手动输入模型 ID。
- **支持上游代理**：每个 profile 可独立配置 HTTP、HTTPS 或 ALL proxy。
- **便于脚本集成**：查询、切换、启动计划和 bridge 状态等命令支持 JSON 输出。

## 快速开始

### 1. 添加供应商

分别为需要使用的工具创建 profile：

```bash
llms claude provider
llms codex provider
llms opencode provider
```

交互界面支持添加、查看、编辑、删除、设为默认以及启用/禁用 profile。可从以下模板开始：

| 模板 | 默认 API 格式 | 默认 Base URL |
| --- | --- | --- |
| 自定义（OpenAI 兼容） | Chat Completions | 手动填写 |
| OpenAI | Responses | `https://api.openai.com/v1` |
| Anthropic | Messages | `https://api.anthropic.com` |

其他供应商可通过兼容的 OpenAI 或 Anthropic API 地址接入；这不代表所有厂商、字段或扩展协议都已完整适配。

### 2. 选择模型

```bash
llms codex model
# 为指定 profile 选择模型
llms codex model --profile my-provider
```

有 API Key 时，`llmswitch` 会尝试获取上游模型列表。使用空格多选、回车确认，然后指定默认模型；请求失败或上游没有兼容的模型端点时，可手动输入模型 ID。

### 3. 启用 profile

```bash
llms codex use my-provider
llms codex current
```

`use` 会备份现有目标配置、合并新的供应商设置，并将该 profile 记录为当前启用项。

### 4. 切换模型并启动

```bash
llms launch codex gpt-4.1

# 等价写法
llms launch codex --model gpt-4.1

# 显式指定 profile
llms launch claude --profile my-provider --model claude-sonnet-4

# run 是 launch 的别名
llms run opencode my-model
```

未指定 `--profile` 时，profile 的选择顺序为：

1. 模型列表中包含目标模型的 profile；
2. 当前启用的 profile；
3. 默认 profile。

模型匹配会忽略大小写和常见分隔符。例如，`gpt4.1` 可匹配 `gpt-4.1`。如果输入的模型不在 profile 中，它会被加入模型列表并设为该 profile 的默认模型。

### 5. 预览或只写配置

```bash
# 只查看执行计划，不修改配置、不启动 CLI
llms launch codex gpt-4.1 --dry-run

# 输出 JSON 计划
llms launch codex gpt-4.1 --dry-run --json

# 写入配置，但不启动目标 CLI
llms launch opencode my-model --print-only

# 将额外参数透传给目标 CLI
llms launch opencode my-model -- --resume
```

如目标 CLI 不在 `PATH` 中，可指定可执行文件：

```bash
export CLAUDE_BIN=/path/to/claude
export CODEX_BIN=/path/to/codex
export OPENCODE_BIN=/path/to/opencode
```

## 兼容性

| 目标工具 | Anthropic Messages | OpenAI Chat Completions | OpenAI Responses |
| --- | :---: | :---: | :---: |
| Claude Code | 直连 | 通过 bridge | 不支持 |
| Codex | 不支持 | 通过 bridge | 直连 |
| OpenCode | 直连 | 直连 | 直连 |

OpenCode 会根据 API 格式写入对应的 AI SDK provider：

- Anthropic：`@ai-sdk/anthropic`
- OpenAI Responses：`@ai-sdk/openai`
- OpenAI Chat：`@ai-sdk/openai-compatible`

OpenAI 格式的 Base URL 会规范为末尾恰好一个 `/v1`；Anthropic 格式只移除末尾多余的 `/`。如果某个特殊网关不使用 `/v1` 路径，它可能无法直接使用当前的 OpenAI 格式 profile。

## 本地 bridge

Claude Code 和 Codex 共用一个 bridge 进程，但两侧上游配置相互隔离，可以同时连接不同供应商。默认监听 `127.0.0.1:17890`：

```text
Claude Code  POST /v1/messages  ─┐
                                 ├─ local bridge ─→ POST /v1/chat/completions
Codex        POST /v1/responses ─┘
```

当启用需要 bridge 的 profile 时，进程会自动启动；切回原生格式后会清理对应侧上游，两侧均不再使用 bridge 时会停止进程。

常用管理命令：

```bash
llms bridge status
llms bridge status --json
llms bridge start
llms bridge stop
llms bridge reload claude
llms bridge reload codex --profile my-provider

# 前台运行，便于排查问题
llms bridge serve
```

Bridge 提供以下本地端点：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/health`、`/v1/health` | 查看服务及两侧上游状态 |
| `GET` | `/models`、`/v1/models` | 合并已配置上游的模型列表 |
| `POST` | `/messages`、`/v1/messages` | Anthropic Messages → Chat |
| `POST` | `/responses`、`/v1/responses` | OpenAI Responses → Chat/Completions |

```bash
curl http://127.0.0.1:17890/health
```

> [!WARNING]
> Bridge 本身没有身份认证、限流或请求体大小限制。请保持默认回环地址，不要将其作为公网或多租户生产网关使用。

## 上游代理

添加或编辑 profile 时可以配置：

- `HTTP_PROXY`
- `HTTPS_PROXY`
- `ALL_PROXY`，例如 `socks5h://127.0.0.1:1080`

```bash
llms claude provider
# 选择“添加”或“编辑”，然后填写代理字段
```

原生直连 profile 会将适用的代理变量合并到目标工具配置；bridge profile 则由 bridge 使用对应上游的代理设置。实际代理行为仍取决于目标 CLI、Node.js 网络环境和代理协议，建议在真实环境中验证。

## 命令参考

统一形式为 `llms <tool> <action>`，其中 `<tool>` 为 `claude`、`codex` 或 `opencode`。

| 命令 | 说明 |
| --- | --- |
| `llms <tool> provider` | 交互式管理 profile；`--json` 可查看列表 |
| `llms <tool> use [name]` | 启用已有 profile；支持 `--json` |
| `llms <tool> current` | 查看默认项和当前启用项；API Key 会脱敏 |
| `llms <tool> model [--profile name]` | 获取、选择并保存模型；支持 `--json` |
| `llms launch\|run <tool> [model]` | 切换 profile/模型并启动目标 CLI |
| `llms bridge status` | 查看 bridge 进程和两侧上游状态 |
| `llms bridge start\|stop` | 手动启动或停止 bridge |
| `llms bridge reload [tool]` | 从当前或指定 profile 刷新 bridge 上游 |
| `llms bridge serve` | 在前台运行 bridge |
| `llms path` | 显示 llmswitch 本地数据目录 |

查看完整参数：

```bash
llms --help
llms launch --help
llms bridge --help
llms codex --help
```

## 配置与安全

### 配置位置

| 数据 | 默认位置 | 覆盖方式 |
| --- | --- | --- |
| llmswitch（macOS/Linux） | `~/.config/llm-switch/` | `LLM_SWITCH_HOME` 或 `XDG_CONFIG_HOME` |
| llmswitch（Windows） | `%APPDATA%\llm-switch\` | `LLM_SWITCH_HOME` |
| Claude Code | `~/.claude/settings.json` | `CLAUDE_CONFIG_DIR` |
| Codex | `~/.codex/config.toml`、`~/.codex/.env` | `CODEX_HOME` |
| OpenCode 配置 | `~/.config/opencode/opencode.json` | `OPENCODE_CONFIG_DIR` 或 `XDG_CONFIG_HOME` |
| OpenCode认证 | `~/.local/share/opencode/auth.json` | `OPENCODE_DATA_DIR` 或 `XDG_DATA_HOME` |

为兼容当前程序和已有配置，llmswitch 的默认数据目录仍使用 `llm-switch` 目录名。Windows 下，OpenCode 认证默认位于 `%LOCALAPPDATA%\opencode\auth.json`。运行以下命令可查看当前环境中的实际数据目录：

```bash
llms path
```

### 备份策略

修改或禁用配置前，已存在的目标文件会备份到对应工具目录的 `backups/` 中，文件名包含时间戳。首次创建的文件没有可备份内容。写入过程使用同目录临时文件再重命名，降低配置只写入一部分的风险。

### API Key

API Key 会以**明文**保存在本机 profile、目标工具认证文件或 bridge 上游配置中。llmswitch 会尝试将新写文件权限设置为 `0600`，但不会使用系统钥匙串，也不会加密密钥。

请保护配置目录，不要将其中内容提交到版本控制，不要在不受信任的设备上保存长期密钥。JSON 查询结果会对 API Key 脱敏，但磁盘文件仍包含真实值。

## 已知限制

- Bridge 是面向本地使用的协议适配器，不保证 OpenAI 与 Anthropic 协议 100% 等价。
- Responses 中的加密 reasoning 内容不会转发；未识别的工具类型可能被忽略。
- Anthropic 转换主要覆盖文本、工具调用和工具结果，图片等非文本内容可能无法完整保留。
- Codex 的 Completions 模式是降级路径：对话会被展平为 prompt，复杂工具调用或 agent 流程可能表现不佳。
- Codex Chat 模式仅在上游返回 HTTP `404` 或 `405` 时回退到 Completions；认证、网络及其他错误不会触发回退。
- 托管 `web_search` 会转换为普通客户端函数，不会自动获得上游的托管搜索能力。
- 自动发现模型需要 API Key 和兼容的 `/models` 端点；失败时需手动输入模型。

## 参与贡献

欢迎通过 Issue 报告兼容性问题，或提交 Pull Request 改进配置适配、协议转换、测试和文档。

提交新供应商或协议适配时，建议同时提供：

- 目标工具与 API 格式；
- 可复现的请求和响应行为；
- 普通响应与流式响应的测试；
- 工具调用、工具结果和错误响应等边界场景。

## License

本项目基于 [MIT License](./LICENSE) 开源。
