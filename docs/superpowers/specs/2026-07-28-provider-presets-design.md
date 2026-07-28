# 供应商预设模版精简设计

日期：2026-07-28  
状态：已确认，待实现

## 背景与问题

添加供应商时的预设菜单过长（DeepSeek、智谱、Kimi、OpenRouter 等多厂商条目），与「自定义 / OpenAI / Claude」等文案混用，体验不清晰。

目标：

1. 预设只保留三种：**自定义（OpenAI 兼容）**、**OpenAI**、**Anthropic**
2. 「自定义」默认走现有 Responses 兼容中继（`openai-chat` + bridge），仍允许改为原生 Responses 或 Completions
3. OpenAI / Anthropic 预填官方 Base URL，允许用户覆盖
4. 三工具共用同一套交互；与 Codex 不一致的步骤与文案全部按 Codex 对齐
5. 厂商预设及相关文档、示例、CLI 说明一次清理干净，避免半截残留

## 预设定义

| id | 显示名 | 默认 `apiFormat` | 预填 `baseUrl` | 默认模型列表 |
|----|--------|------------------|----------------|--------------|
| `custom` | 自定义（OpenAI 兼容） | `openai-chat` | （空，用户必填） | 空，依赖拉取或手填 |
| `openai` | OpenAI | `openai-responses` | `https://api.openai.com/v1` | 可空，依赖拉取；无拉取时手填 |
| `anthropic` | Anthropic | `anthropic` | `https://api.anthropic.com` | 可空，依赖拉取；无拉取时手填 |

按工具可见性（与 `supportedFormats` 一致）：

| 模版 | Claude | Codex | OpenCode |
|------|--------|-------|----------|
| `custom` | ✗ | ✓ | ✓ |
| `openai` | ✗ | ✓ | ✓ |
| `anthropic` | ✓ | ✗ | ✓ |

说明：

- Base URL、显示名称均可在交互中覆盖预填值
- OpenAI / Anthropic 模版选定后**不再询问**接口格式（格式已由模版锁定）
- 仅 `custom` 额外询问上游接口类型（见下节）
- 删除全部厂商预设：`deepseek-*`、`glm-*`、`kimi-*`、`openrouter-*`、`custom-openai-chat`、旧 id `openai-responses` 等

## 添加供应商交互（三工具共用，对齐 Codex）

入口：`llms <tool> provider` →「添加新供应商」。

入口列表 hint 统一为：`自定义 / OpenAI / Anthropic`（不再使用「Claude」作为模版名）。

步骤顺序：

1. **选择预设模版**（仅展示当前工具可见项）
2. **Profile 名称**（命令行引用 id）
3. **显示名称**（默认：自定义用 name；OpenAI / Anthropic 用模版显示名，可改）
4. **上游接口类型**（仅 `custom`）：
   - **Chat Completions**（默认）→ `apiFormat: openai-chat`；Codex 下 `bridgeMode: chat`（启用时走本地 Responses 兼容桥）
   - **Completions** → `apiFormat: openai-chat` + `bridgeMode: completions`（**仅 Codex 显示**；OpenCode 不出现此项）
   - **OpenAI Responses** → `apiFormat: openai-responses`，不经桥
5. **API Base URL**（预填可改，必填）
6. **API Key**（可留空）
7. **是否配置上游代理**（与现逻辑一致）
8. **拉取 / 选择模型**（与现逻辑一致）
9. 保存后询问是否立即启用（与现逻辑一致）

非交互 `--preset` 仅接受：`custom` | `openai` | `anthropic`。非法 id 报错并提示可用值。

## 编辑供应商交互

`promptEditProfile` 与添加侧对齐：

- 接口格式选项文案与「自定义」上游类型选择一致，去掉「自定义 / OpenAI / Claude」混用说法
- Codex + `openai-chat` 时仍可改 `bridgeMode`（chat / completions）
- 非 `openai-chat` 时清除 `bridgeMode`

## Bridge 行为（不改协议）

现有逻辑保持不变：

- `profileNeedsBridge`：`apiFormat === "openai-chat"` 时需要桥
- Codex 启用此类 profile 时启动本地桥，把 `/v1/responses` 转到上游 chat/completions
- 本改动只保证「自定义」默认落在该路径；不修改 bridge 请求/响应翻译实现

## 清理清单

必须同步修改，避免文档或代码仍引用旧预设：

| 区域 | 内容 |
|------|------|
| `src/presets/index.ts` | 仅三模版；`presetsForTool` 按可见性表过滤 |
| `src/commands/prompts.ts` | 自定义格式选择；默认 bridge；编辑侧文案对齐 |
| `src/commands/tool.ts` | 「添加新供应商」hint 等 |
| `src/commands/launch-cmd.ts` 等注释 | 示例 profile 名改为通用名（如 `my-provider`） |
| `README.md` | 去掉厂商预设说明；示例与「支持的接口格式」章节与三模版一致；Codex+Chat 桥说明指向「自定义」模版 |
| 测试 | 去掉对旧 preset id 的依赖；厂商 URL 仅作假数据时可保留 |
| CLI `--preset` help | 列出新 id |

不在范围内：

- bridge 协议与翻译逻辑重构
- ~~为 Claude 增加 OpenAI 兼容路径~~（已由 `2026-07-28-claude-openai-bridge-design.md` 覆盖）
- 迁移用户已保存的旧 profile（磁盘上的 profile 继续有效）

## 验收标准

1. `llms codex provider` → 添加：仅见「自定义（OpenAI 兼容）」「OpenAI」；自定义默认 Chat Completions，启用后走 bridge
2. `llms claude provider` → 添加：仅见「Anthropic」；预填官方 URL 可改
3. `llms opencode provider` → 添加：三者都有；自定义无 Completions 选项（无 Codex bridge）
4. 仓库内无 DeepSeek / 智谱 / Kimi / OpenRouter 作为预设模版的引用；README 示例不再引导选厂商预设
5. `bun test` 通过
