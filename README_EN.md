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

An "OpenCode Go" preset is also available: it prefills the Zen Go endpoint `https://opencode.ai/zen/go/v1` plus the common models, over Chat Completions. Note that Zen Go splits protocols per model: Grok / GPT / Muse Spark use `/v1/responses`, and MiniMax / Qwen use `/v1/messages` — those need a separate profile with the matching format.

Zen Go requires an `x-opencode-session` header on every request (a missing one returns `MissingSessionID`). llms adds it before forwarding through the bridge or the gateway: a session header from the client is passed through untouched, and otherwise it is derived from the request body (model + first messages) so every turn of one conversation keeps reusing the same session instead of losing prompt-cache locality. A derived id rotates once per hour (at the top of the hour) so a forged session is not reused indefinitely; a client-supplied header is never touched.

Every outbound request to an OpenCode host is additionally backfilled with the header at the transport layer (an existing one is left untouched), so direct CLI calls such as model listing and format probing — which never pass through the bridge or gateway — cannot fail for a missing session id either.

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

Claude Code and OpenCode support a second, lightweight model alongside the default one, used for cheap tasks like title generation and summarization. After picking the default model you get one extra step, "select a lightweight model"; choosing "not set" falls back to the default model:

```bash
# Interactive (default model → enabled models → lightweight model)
llms opencode model

# Set it directly, skipping the lightweight-model prompt
llms opencode model --small glm-4.5-air

# Clear a configured lightweight model
llms opencode model --small ""
```

The lightweight model is written to each tool's own setting: OpenCode gets a top-level `small_model`, Claude Code gets `ANTHROPIC_SMALL_FAST_MODEL` / `ANTHROPIC_DEFAULT_HAIKU_MODEL`. Codex has no equivalent knob, so the option is not offered there.

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

A model passed on the command line applies to that launch only and does not modify the saved provider configuration (so a typo cannot silently become your new default). Add `--save` to make it the provider's new default:

```bash
llms launch codex gpt-4.1 --save
```

### 6. Preview Execution Plan

```bash
# View plan without actually launching
llms launch codex gpt-4.1 --dry-run

# Output as JSON
llms launch codex gpt-4.1 --dry-run --json
```

### 7. Non-Interactive Use (Scripts / CI)

Besides the interactive menu, provider management is fully scriptable. With all arguments supplied there are no prompts:

```bash
# Add and enable (--no-enable saves without enabling)
llms opencode provider add \
  --base-url https://api.example.com/v1 --api-key sk-xxx \
  --name myprov --model glm-4.6 --small glm-4.5-air --json

# List and remove
llms opencode provider list --json
llms opencode provider rm myprov --yes
```

Every interactive command fails fast with the flag to use instead when stdin is not a TTY, rather than silently waiting for input.

### 8. Manage Local Bridge

When Claude Code, Codex or OpenCode uses a non-native protocol, a local Bridge starts automatically.

```bash
# View Bridge status
llms bridge status

# Start/stop manually
llms bridge start
llms bridge stop

# Reload configuration
llms bridge reload claude
llms bridge reload codex --profile my-provider
llms bridge reload opencode
```

### 9. Serve an Outward-Facing AI Gateway

The Bridge serves Claude Code / Codex / OpenCode on your own machine. To let
**third-party clients** reach your configured models through a single port, use
the gateway:

```bash
# 1. Set up providers (import from existing tool configs, de-duplicated by upstream)
llms gateway provider import
# ...or add one manually (API format and model list are auto-detected)
llms gateway provider add

# 2. Issue a gateway API key (plaintext is shown once — save it now)
llms gateway key create --name my-app

# 3. Start the gateway
llms gateway start

# 4. Inspect status and routable models
llms gateway status
llms gateway models
```

It listens on `127.0.0.1:17900` by default. Clients treat it as an OpenAI or
Anthropic endpoint:

```bash
# OpenAI format
curl http://127.0.0.1:17900/v1/chat/completions \
  -H "Authorization: Bearer llmsk-..." \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}]}'

# Anthropic format (same upstream, translated by the gateway)
curl http://127.0.0.1:17900/v1/messages \
  -H "x-api-key: llmsk-..." \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","max_tokens":1024,"messages":[{"role":"user","content":"hi"}]}'
```

**Any inbound format ↔ any upstream format.** All three inbound protocols
(OpenAI Chat, OpenAI Responses, Anthropic Messages) combine freely with all
three upstream formats, including streaming and tool calls. When inbound and
upstream formats match, bytes are passed through verbatim to avoid a lossy
round-trip. Known limitation: stateful OpenAI Responses features
(`previous_response_id`, `store`, background mode) only work in same-format
passthrough, not across format translation.

Upstream URLs get a `/v1` prefix by default; non-standard paths can be
customized:

```bash
# Use baseUrl verbatim (e.g. Gemini's OpenAI-compatible …/v1beta/openai endpoint)
llms gateway provider add --path-prefix ""
# Or a custom prefix
llms gateway provider edit my-provider --path-prefix v2
```

| Endpoint | Description |
| --- | --- |
| `GET /v1/models` | Routable models (filtered by key scope) |
| `GET /v1/models/{id}` | Single model detail (OpenAI-client compatible) |
| `POST /v1/chat/completions` | OpenAI Chat Completions |
| `POST /v1/completions` | Legacy Text Completions (`prompt` is converted to messages) |
| `POST /v1/messages` | Anthropic Messages |
| `POST /v1/messages/count_tokens` | Native on Anthropic upstreams; computed locally otherwise (see below) |
| `POST /v1/responses` | OpenAI Responses |
| `POST /v1/embeddings` | OpenAI-compatible upstreams only |
| `GET /health` | Liveness probe (unauthenticated, exposes no configuration) |

Every response carries `x-request-id` (clients may supply their own to correlate
logs), which is also forwarded upstream.

**Model resolution order:**

1. an explicit alias (`llms gateway route add`)
2. a qualified reference: `provider/model` or `provider:model`
3. a bare model id declared by a provider
4. providers with no declared model list (passthrough upstreams)
5. the provider set via `config set --default-provider`

When several providers serve the same model they are ordered by ascending
`priority` and automatically form a fallback chain:

```bash
# Alias plus explicit fallbacks
llms gateway route add gpt-4o --provider azure --model gpt-4o-2024-11 --fallback openrouter/openai/gpt-4o

# Inspect the effective route order for a model id
llms gateway resolve gpt-4o
```

**Provider fallback**: retryable upstream statuses (429/5xx) and connection
failures move on to the next provider. Once the response has started streaming,
no further switching occurs, so clients never receive two spliced outputs.

```bash
llms gateway config set --fallback true --max-attempts 3 --retry-statuses 429,500,502,503,504
```

**Failure cooldown**: providers that fail repeatedly enter an exponential
backoff cooldown (starting at 5s, capped at 2 minutes) and are skipped by
routing while cooling down. If every candidate is cooling down they are still
tried. `llms gateway status` shows which providers are cooling.

```bash
# Probe provider connectivity (model list; --call also sends a 1-token completion)
llms gateway provider test my-provider --call

# Re-fetch the model list from the upstream
llms gateway provider refresh-models my-provider

# Custom upstream headers (repeatable)
llms gateway provider edit my-provider --header "X-Title: my-app"
```

**API key management**: only hashes are stored; keys support scoping, limits,
expiry, editing and rotation.

```bash
llms gateway key create --name partner \
  --providers deepseek --models deepseek-chat \
  --formats openai-chat --rate-limit 60 --expires-in-days 30 \
  --daily-requests 5000

llms gateway key list
llms gateway key edit <id> --rate-limit 120 --daily-requests 8000   # limits / scopes / expiry
llms gateway key rotate <id>                          # new plaintext, old key dies
llms gateway key revoke <id>
```

Scope semantics: `--models` matches the model spelling the client sends — a
key scoped to an alias is usable only through that alias spelling, while a
`provider/model` entry accepts both spellings. Typos produce a warning at
creation time.

**Rate limiting**: counters are persisted in `gateway/rate-limit.json`, so they
survive a restart and are shared by every gateway process using the same config
directory. Responses carry the standard hint headers so clients can back off on
their own:

```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 59
X-RateLimit-Reset: 1787894760
Retry-After: 43          # only on 429
```

```bash
# Default ceiling, applied to keys with no limit of their own
llms gateway config set --rate-limit 120

# Inspect current window usage / clear all counters
llms gateway ratelimit show
llms gateway ratelimit reset
```

`--rate-limit` semantics: `-1` disables limiting entirely (exempt from the
global default), `0` inherits the global default, `> 0` is a hard cap;
`--daily-requests` adds a per-UTC-day request quota on top.

The counter file is lock-protected. If the lock cannot be taken quickly the
request is allowed rather than blocked: a slightly loose limit beats stalling
live traffic.

**Token counting**: `count_tokens` prefers the upstream's native endpoint
(Anthropic-format providers). When that is unavailable it is computed locally
and the source is reported under `llm_switch`:

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

Local counting has two tiers:

- `heuristic` (default, no extra dependency): characters are tallied per writing
  system — CJK, Latin and digits each have their own characters-per-token rate —
  then per-message, per-tool-schema and request-envelope overhead is added.
  Measured mean absolute error is around 11% across English/Chinese/Japanese/
  Korean prose, JSON and emoji, and nearly all samples err high rather than low,
  which is the safer direction when deciding whether a request fits.
  Punctuation-dense source code is the known weak spot and can come in ~15% low.
- `tokenizer` (optional, exact): enabled automatically when `gpt-tokenizer` is
  installed. Exact for OpenAI encodings and closer than the heuristic elsewhere.

```bash
# Install it yourself when exact counts matter; llmswitch does not depend on it
npm install -g gpt-tokenizer

# Force the heuristic
export LLM_SWITCH_DISABLE_TOKENIZER=1
```

Both tiers add image cost on top: real pixel dimensions are read from the
base64 header for PNG / JPEG / GIF / WebP and priced at `width × height / 750`.
Images whose dimensions cannot be determined (URL sources, for example) fall
back to a conservative figure.

**Usage accounting**: the gateway records daily request and token counts per
(key / provider / model) combination in `gateway/usage.json` (kept 90 days):

```bash
llms gateway usage --days 7
llms gateway usage --json
llms gateway usage reset
```

**Logs**: written to `~/.config/llm-switch/gateway/gateway.log`, recording only
key ids — never plaintext keys or upstream credentials. Each line carries
`req=<request-id>` for correlating client and upstream logs. Files over 10MB are
rotated to `gateway.log.old` on startup:

```bash
llms gateway logs              # last 100 lines
llms gateway logs --lines 500
llms gateway logs --follow     # tail continuously
```

**Runtime limits** (timeouts / concurrency / body size) are tuned through
environment variables shared with the Bridge:

| Environment variable | Default | Description |
| --- | --- | --- |
| `LLM_SWITCH_MAX_CONCURRENCY` | 0 (unlimited) | Max concurrent requests, 503 beyond it; 0 means unlimited |
| `LLM_SWITCH_MAX_BODY_BYTES` | 16MB | Request body cap |
| `LLM_SWITCH_MAX_RESPONSE_BYTES` | 32MB | Upstream response cap |
| `LLM_SWITCH_CONNECT_TIMEOUT_MS` | 30000 | Upstream connect timeout |
| `LLM_SWITCH_IDLE_TIMEOUT_MS` | 90000 | Streaming idle timeout |
| `LLM_SWITCH_TOTAL_TIMEOUT_MS` | 600000 | Total timeout per request |

`llms gateway config show` also prints the effective values (add `--json` for structured output). These limits apply to both the gateway and the Bridge.

**Exposure safety**: the gateway binds to loopback by default. Binding to a
non-loopback address requires `--allow-remote` *and* at least one active API
key, otherwise startup is refused.

```bash
llms gateway start --host 0.0.0.0 --allow-remote
```

The gateway speaks plain HTTP only. Terminate TLS with a reverse proxy (Nginx /
Caddy) rather than exposing raw HTTP to the internet. Browser clients need CORS
enabled explicitly (the `anthropic-beta` request header is allowed, and the
rate-limit / request-id response headers are exposed):

```bash
llms gateway config set --cors-origins https://app.example.com
```

---

## Common Commands

| Command | Description |
| --- | --- |
| `llms` | Pick a tool and launch (auto-guides when not configured) |
| `llms <tool>` | Launch the tool directly (auto-guides through full flow when not configured) |
| `llms setup [--tool <tool>]` | Explicit guided setup (provider → models → enable → launch) |
| `llms <tool> provider` | Interactive provider management (add, view, edit, delete) |
| `llms <tool> provider list/add/rm` | Non-interactive add/list/remove (scripts / CI) |
| `llms <tool> use [name]` | Enable specified configuration |
| `llms <tool> current` | View current configuration |
| `llms <tool> model` | Select models |
| `llms launch/run <tool> [model]` | Launch tool (add `--save` to change the default model) |
| `llms bridge status` | View Bridge status |
| `llms gateway start` | Start the outward-facing AI gateway |
| `llms gateway provider import` | Import gateway providers from tool configs |
| `llms gateway provider test <name>` | Probe provider connectivity |
| `llms gateway key create` | Issue a gateway API key |
| `llms gateway key rotate <id>` | Rotate a gateway API key |
| `llms gateway status` | View gateway status |
| `llms gateway ratelimit show` | Inspect per-key rate-limit usage |
| `llms gateway usage` | Daily usage accounting |
| `llms gateway logs` | View gateway logs |
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
| Gateway providers / keys / logs | `~/.config/llm-switch/gateway/` |
| Automatic pre-write backups | `~/.config/llm-switch/<tool>/backups/` (latest 10 per kind) |
| Claude Code | `~/.claude/settings.json` |
| Codex | `~/.codex/config.toml` |
| OpenCode | `~/.config/opencode/opencode.json` |

The original file is backed up before any write. Backups contain plaintext API keys, so only the 10 most recent per kind are kept. If a target config file has broken syntax, the command reports the exact file path instead of crashing.

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