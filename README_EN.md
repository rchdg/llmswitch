<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="llmswitch: switch providers and models for Claude Code, Codex, and OpenCode">
</p>

<p align="center">
  <strong>One CLI to manage model switching for Claude Code, Codex, and OpenCode.</strong>
</p>

<p align="center">
  <a href="./README.md">简体中文</a> · <strong>English</strong>
</p>

---

## Quick Start

### Install

Requires Node.js 20+.

```bash
npm install -g @nvae/llmswitch
# or
bun add -g @nvae/llmswitch
```

After installation, use the `llms` command (or `llm-switch` / `llmswitch`). Running `llms` with no arguments picks a tool and launches it; `llms <tool>` works the same way.

### 0. One-Command Launch (Continuous Flow)

```bash
# Pick a tool and launch; if no provider is configured, it guides you through: add provider → pick models → enable → launch
llms

# Launch Codex directly (equivalent to llms launch codex)
llms codex
```

`llms <tool>` adapts based on state:

- Provider configured → launch directly (uses the currently enabled / default provider and its default model)
- Not configured → automatically guides through adding a provider, picking models, silently enables it, then launches

### 1. Explicit Guided Setup

```bash
llms setup
```

The wizard guides you through: pick a tool → add a provider (API URL, key) → pick models → enable → launch. Installed tools are detected automatically; if only one is installed, it is selected for you.

```bash
# Skip tool selection, guide for Codex directly
llms setup --tool codex
```

### 2. Add Provider Configuration
```bash
# Add configuration for Claude Code
llms claude provider

# Add configuration for Codex
llms codex provider

# Add configuration for OpenCode
llms opencode provider
```

Follow the prompts to enter: API URL, API Key, display name.

For custom upstreams, the API type (Anthropic / OpenAI Chat / OpenAI Responses) is auto-detected by probing the endpoint — no manual selection needed. Manual selection only appears when detection fails. Local Ollama is supported too (`/v1` compatible or native `/api/tags`, no API key required), and an "Ollama (local)" preset is available.

Profile names are auto-generated (5 random lowercase letters/digits, e.g. `69pjb`). Every command accepts either the name or the display name to reference a provider:

```bash
# Both name and display name work
llms codex use 69pjb
llms codex use DeepSeek
llms launch codex --profile deepseek   # normalized fuzzy match (case/separators ignored)
```

### 3. Select Models

```bash
# Select models for current tool
llms codex model

# Select models for a specific configuration
llms codex model --profile my-provider
```

With an API key, it automatically fetches the upstream model list. You can also manually enter model IDs.

### 4. Enable Configuration

```bash
llms codex use my-provider

# View current configuration status
llms codex current
```

### 5. Launch Tool

```bash
# Launch Codex with specified model
llms launch codex gpt-4.1

# Launch Claude Code
llms launch claude --model claude-sonnet-4-20250514

# Launch OpenCode
llms run opencode my-model

# Launch with specific configuration
llms launch claude --profile my-provider --model claude-sonnet-4
```

When `--profile` is not specified, it automatically selects the configuration that contains the target model.

### 6. Preview Execution Plan

```bash
# View plan without actually launching
llms launch codex gpt-4.1 --dry-run

# Output as JSON
llms launch codex gpt-4.1 --dry-run --json
```

### 7. Manage Local Bridge

When Claude Code or Codex uses a non-native protocol, a local Bridge starts automatically.

```bash
# View Bridge status
llms bridge status

# Start/stop manually
llms bridge start
llms bridge stop

# Reload configuration
llms bridge reload claude
llms bridge reload codex --profile my-provider
```

---

## Common Commands

| Command | Description |
| --- | --- |
| `llms` | Pick a tool and launch (auto-guides when not configured) |
| `llms <tool>` | Launch the tool directly (auto-guides through full flow when not configured) |
| `llms setup [--tool <tool>]` | Explicit guided setup (provider → models → enable → launch) |
| `llms <tool> provider` | Manage provider configurations (add, view, edit, delete) |
| `llms <tool> use [name]` | Enable specified configuration |
| `llms <tool> current` | View current configuration |
| `llms <tool> model` | Select models |
| `llms launch/run <tool> [model]` | Launch tool |
| `llms bridge status` | View Bridge status |
| `llms path` | View data directory |

`<tool>` can be `claude`, `codex`, or `opencode`.

View full help:

```bash
llms --help
llms launch --help
```

---

## Configuration Locations

| Data | Location |
| --- | --- |
| llmswitch config | `~/.config/llm-switch/` |
| Claude Code | `~/.claude/settings.json` |
| Codex | `~/.codex/config.toml` |
| OpenCode | `~/.config/opencode/opencode.json` |

View actual path:

```bash
llms path
```

---

## Specify Executable Path

If the tool is not in `PATH`, specify via environment variables:

```bash
export CLAUDE_BIN=/path/to/claude
export CODEX_BIN=/path/to/codex
export OPENCODE_BIN=/path/to/opencode
```

---

## Feedback

Found an issue or have a suggestion? Feel free to reach out:

- Email: rchdg50@gmail.com
- GitHub Issues: https://github.com/rchdg/llmswitch/issues

---

## License

MIT License - see [LICENSE](./LICENSE)