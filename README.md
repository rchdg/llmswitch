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