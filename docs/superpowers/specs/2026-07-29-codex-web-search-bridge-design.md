# Codex Web Search 响应转换设计

日期：2026-07-29  
状态：已实现，已验证

## 背景与根因

Codex 通过本地 bridge 调用仅支持 OpenAI Chat Completions 的上游时，请求链路为：

```text
Codex POST /v1/responses
  -> llm-switch bridge
  -> POST /v1/chat/completions
  -> Chat SSE/JSON 转为 Responses SSE/JSON
```

bridge 已将 Responses 请求中的 `type: "web_search"` 或 `type: "web_search_preview"` 映射为名为 `web_search` 的 Chat function。不过，实测本地网关的 `gpt-5.6-sol` 不返回 `tool_calls`，而是自行完成搜索，并将结果放入 assistant `content`：

```text
<web_search>
Search results for "current weather in Tokyo Japan":
...
</web_search>
```

流式响应中，开始标签、结果和结束标签可能分布在任意多个 `delta.content` chunk。现有 `chatChunkToResponsesEvents` 将所有 `delta.content` 无条件转为 `response.output_text.delta`，因此 Codex 把 `<web_search>` 及其内容显示成普通文本。

已使用以下接口复现并确认模型 ID：

```text
GET http://127.0.0.1:8000/v1/models
POST http://127.0.0.1:8000/v1/chat/completions
model = gpt-5.6-sol
```

## 目标

1. 在 Codex bridge 响应中识别 Chat assistant 文本里的完整 `<web_search>...</web_search>` 块。
2. 将每个完整搜索块转换为 Codex 0.146.0 可识别的 `web_search_call` output item。
3. 去除 XML 包装后，将标签内搜索结果保留为 assistant message，避免丢失上游已经取得的内容。
4. 流式和非流式响应保持相同语义及 output item 顺序。
5. 不影响普通文本、标准 Chat `tool_calls`、custom tools 和不含完整搜索标签的响应。

## 非目标

- bridge 不执行联网搜索；搜索仍由上游完成。
- bridge 不自动发起第二次模型请求来总结搜索结果。
- 不为任意 XML 工具格式建立通用解析框架。
- 不解析搜索结果正文为 OpenAI `results` 或 citation annotations；当前上游只提供非结构化文本，强行推断字段不可靠。
- 不改变原生 `openai-responses` profile；该路径不经过 bridge。

## 方案选择

采用“结构化搜索 item + 清洗后的结果 message”方案：

```text
<web_search>RESULTS</web_search>
  -> response.output_item.added  (web_search_call, in_progress)
  -> response.output_item.done   (web_search_call, completed)
  -> response.output_item.added  (assistant message)
  -> response.output_text.delta  (RESULTS，仅流式)
  -> response.output_item.done   (assistant message, RESULTS)
```

未采用的方案：

- 仅剥离标签：改动较小，但 Codex 无法知道发生过 web search。
- 仅输出 `web_search_call`：Codex 只展示搜索动作，标签内结果会丢失。
- 自动二次生成：更接近原生托管搜索，但增加延迟、token 消耗、错误处理和循环风险。

## 识别条件

Codex 0.146.0 对自定义 provider 可能不在 Responses 请求中声明 hosted `web_search`，即使 Chat 上游仍会自行完成搜索并返回 XML。因此 bridge 不能依赖请求 `tools` 判断是否启用转换。

Codex 的 Chat/Completions bridge 路径始终识别大小写完全一致且完整闭合的 `<web_search>...</web_search>` 响应块。该标记由上游放在 assistant 输出中，按响应协议标记处理；不完整或大小写不同的文本不转换。

## 文本解析规则

解析器只识别大小写完全一致的：

```text
<web_search>
...
</web_search>
```

规则如下：

1. 标签外文本保持普通 assistant 文本。
2. 每个完整标签块产生一个 `web_search_call`，随后产生一个包含标签内正文的 assistant message。
3. 标签本身不进入任何 message。
4. 支持同一响应内多个搜索块及搜索块前后的普通文本，output item 按原文顺序产生。
5. 单独出现的结束标签按普通文本处理。
6. 流结束时仍未闭合的开始标签及其内容按原文本回退，不吞掉内容，也不生成搜索 item。
7. 转换器显式关闭 XML 识别时，整段内容（包括标签）保持原样；server 的 Codex bridge 路径始终开启识别。

### 流式状态机

流式状态增加以下概念：

- 当前位于标签外或标签内。
- 标签外待定缓冲区：保留可能构成 `<web_search>` 的最长后缀，解决开始标签跨 chunk。
- 标签内缓冲区：在完整 `</web_search>` 到达前保存搜索结果，解决结束标签跨 chunk。
- 已完成 output items：用于构造最终 `response.completed.response.output`。

标签外可确认不是开始标签的文本立即按普通文本输出。完整搜索块在结束标签到达后一次转换；这会延迟该块正文的输出，但避免在确认标签闭合前产生无法回滚的结构化事件。

## Responses Item 格式

每个搜索块使用稳定且唯一的 `ws_...` ID。完成 item 形状为：

```json
{
  "id": "ws_...",
  "type": "web_search_call",
  "status": "completed",
  "action": {
    "type": "search",
    "query": "current weather in Tokyo Japan"
  }
}
```

查询优先从标签正文第一段的以下标题提取：

```text
Search results for "QUERY":
```

同时接受直引号和弯引号。无法提取时仍生成合法的 completed item：`action.type` 为 `search`，省略 `query`。Codex 会显示空查询，但搜索结果正文仍完整保留。

Codex 0.146.0 从 `response.output_item.added` 和 `response.output_item.done` 反序列化 `web_search_call`；专用的 `response.web_search_call.in_progress/searching/completed` 事件不是客户端识别所必需，因此本次不额外生成。

## 输出一致性

当前流式状态以单个 `fullText` 构造最终 output，不能准确表达“普通文本 -> 搜索 -> 结果 -> 普通文本”等多个 item。实现时改为按完成顺序记录 output item，并用该列表构造 `response.completed.response.output`。

必须满足：

1. 每个 `response.output_item.added` 最终有同 ID 的 `response.output_item.done`。
2. 每个 item 的 `output_index` 在 added、delta、done 和 completed response 中一致。
3. `response.completed.response.output` 的类型、ID、内容及顺序与已发送的 done items 一致。
4. 标准 function/custom tool call 的现有事件格式不变，并与文本及搜索 item 共享同一 output index 序列。

非流式转换使用同一分段和查询提取规则，直接构造等价的 output 数组。

## 错误与降级

- XML 不完整：原样作为普通文本输出。
- 搜索正文为空：生成 `web_search_call`，不额外生成空 message。
- 查询提取失败：省略 `action.query`，不影响结果正文。
- 上游返回标准 `tool_calls`：继续走现有 function/custom tool 转换，不应用 XML 逻辑。
- 同一响应同时含标准 tool call 和 XML 搜索块：均保留，按接收顺序分配 output index；Chat chunk 内先处理 content，再处理 `tool_calls`，延续现有处理顺序。

## 测试计划

在 `test/bridge-translate.test.ts` 增加针对性测试：

1. 非流式完整搜索块转换为 `web_search_call` + 去标签结果 message。
2. 流式开始和结束标签跨多个 chunk，标签不出现在 text delta。
3. 查询从 `Search results for "..."` 提取并写入 action。
4. 搜索块前后普通文本保持顺序并形成一致的 completed output。
5. 同一响应中的多个搜索块分别生成唯一 item。
6. 未闭合开始标签在结束流时原样回退。
7. 显式关闭识别时不解析标签，server 路径默认开启。
8. 空搜索正文不生成空 message。
9. 现有 function call、custom tool、纯文本和 usage 测试继续通过。

验证命令：

```bash
bun test test/bridge-translate.test.ts
bun test
bun run typecheck
bun run build
```

最后使用本地 `gpt-5.6-sol` 网关做一次 smoke test，确认 bridge 输出中存在 `web_search_call`，且 Codex 运行时不再显示原始 `<web_search>` 标签。

## 验收标准

1. `gpt-5.6-sol` 返回的完整 `<web_search>` 块不再作为带标签的普通文本显示。
2. Codex 0.146.0 能识别并显示 web search activity。
3. 标签内搜索结果仍可见，不因结构化转换而丢失。
4. 流式事件和最终 completed output 的 item 顺序及 ID 一致。
5. 标签不完整、大小写不同及普通响应行为保持兼容。
6. targeted tests、完整测试、typecheck 和 build 均通过。
