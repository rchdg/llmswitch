/**
 * Translate Chat Completions (stream/non-stream) → Responses API events/objects.
 */

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function sseEvent(type: string, data: Record<string, unknown>): string {
  const payload = { type, ...data };
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function mapUsage(usage: Record<string, unknown> | null | undefined) {
  if (!usage) return undefined;
  const input =
    numberOr(usage.prompt_tokens) ??
    numberOr(usage.input_tokens) ??
    0;
  const output =
    numberOr(usage.completion_tokens) ??
    numberOr(usage.output_tokens) ??
    0;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens:
      numberOr(usage.total_tokens) ?? input + output,
    output_tokens_details: {
      reasoning_tokens:
        numberOr(
          (usage.completion_tokens_details as Record<string, unknown> | undefined)
            ?.reasoning_tokens,
        ) ?? 0,
    },
  };
}

function numberOr(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export interface StreamBridgeState {
  responseId: string;
  model: string;
  textItemId: string | null;
  textStarted: boolean;
  textContentIndex: number;
  outputIndex: number;
  currentText: string;
  completedItems: Array<{
    outputIndex: number;
    item: Record<string, unknown>;
  }>;
  webSearchEnabled: boolean;
  webSearchBuffer: string;
  insideWebSearch: boolean;
  /** Responses `type: "custom"` tool names that must round-trip as custom_tool_call. */
  customTools: Set<string>;
  toolCalls: Map<
    number,
    {
      itemId: string;
      callId: string;
      name: string;
      arguments: string;
      started: boolean;
      custom: boolean;
      /** output_index assigned when the item was added (stable for deltas/done). */
      outputIndex: number;
    }
  >;
  created: boolean;
  completed: boolean;
  usage?: ReturnType<typeof mapUsage>;
}

export function createStreamState(
  model: string,
  responseId?: string,
  customTools?: Iterable<string>,
  webSearchEnabled = false,
): StreamBridgeState {
  return {
    responseId: responseId || newId("resp"),
    model,
    textItemId: null,
    textStarted: false,
    textContentIndex: 0,
    outputIndex: 0,
    currentText: "",
    completedItems: [],
    webSearchEnabled,
    webSearchBuffer: "",
    insideWebSearch: false,
    customTools: new Set(customTools ?? []),
    toolCalls: new Map(),
    created: false,
    completed: false,
  };
}

const WEB_SEARCH_OPEN = "<web_search>";
const WEB_SEARCH_CLOSE = "</web_search>";

type TextSegment =
  | { type: "text"; content: string }
  | { type: "web_search"; content: string };

function pushTextSegment(segments: TextSegment[], content: string): void {
  if (!content) return;
  const previous = segments[segments.length - 1];
  if (previous?.type === "text") previous.content += content;
  else segments.push({ type: "text", content });
}

function splitWebSearchContent(
  content: string,
  enabled: boolean,
): TextSegment[] {
  if (!enabled || !content) {
    return content ? [{ type: "text", content }] : [];
  }

  const segments: TextSegment[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    const open = content.indexOf(WEB_SEARCH_OPEN, cursor);
    if (open < 0) {
      pushTextSegment(segments, content.slice(cursor));
      break;
    }
    const close = content.indexOf(
      WEB_SEARCH_CLOSE,
      open + WEB_SEARCH_OPEN.length,
    );
    if (close < 0) {
      pushTextSegment(segments, content.slice(cursor));
      break;
    }
    pushTextSegment(segments, content.slice(cursor, open));
    segments.push({
      type: "web_search",
      content: content.slice(open + WEB_SEARCH_OPEN.length, close),
    });
    cursor = close + WEB_SEARCH_CLOSE.length;
  }
  return segments;
}

function webSearchAction(content: string): Record<string, unknown> {
  const match = content.match(
    /^\s*Search results for\s+["“]([^"”]+)["”]\s*:/,
  );
  return match
    ? { type: "search", query: match[1] }
    : { type: "search" };
}

/**
 * Chat function-calling often wraps freeform payloads as `{"input":"..."}`.
 * Codex custom tools need the raw string in `input`.
 */
export function unwrapCustomToolInput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.input === "string") return obj.input;
      if (typeof obj.text === "string") return obj.text;
      if (typeof obj.query === "string" && Object.keys(obj).length === 1) {
        return obj.query;
      }
    }
  } catch {
    // Freeform text / partial JSON — keep as-is
  }
  return raw;
}

function isCustomToolName(state: StreamBridgeState, name: string): boolean {
  return Boolean(name) && state.customTools.has(name);
}

function baseResponse(state: StreamBridgeState, status: string) {
  return {
    id: state.responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model: state.model,
    output: [] as unknown[],
    error: null,
    incomplete_details: null,
    usage: state.usage,
  };
}

function ensureCreated(state: StreamBridgeState, out: string[]): void {
  if (state.created) return;
  state.created = true;
  const response = baseResponse(state, "in_progress");
  out.push(sseEvent("response.created", { response }));
  out.push(sseEvent("response.in_progress", { response }));
}

function ensureTextItem(state: StreamBridgeState, out: string[]): void {
  if (state.textStarted) return;
  state.textStarted = true;
  state.textItemId = newId("msg");
  state.currentText = "";
  const outputIndex = state.outputIndex;
  out.push(
    sseEvent("response.output_item.added", {
      output_index: outputIndex,
      item: {
        id: state.textItemId,
        type: "message",
        status: "in_progress",
        role: "assistant",
        content: [],
      },
    }),
  );
  out.push(
    sseEvent("response.content_part.added", {
      item_id: state.textItemId,
      output_index: outputIndex,
      content_index: state.textContentIndex,
      part: { type: "output_text", text: "", annotations: [] },
    }),
  );
}

function emitTextDelta(
  state: StreamBridgeState,
  out: string[],
  content: string,
): void {
  if (!content) return;
  ensureTextItem(state, out);
  state.currentText += content;
  out.push(
    sseEvent("response.output_text.delta", {
      item_id: state.textItemId,
      output_index: state.outputIndex,
      content_index: state.textContentIndex,
      delta: content,
    }),
  );
}

function pendingOpenTagLength(value: string): number {
  const max = Math.min(value.length, WEB_SEARCH_OPEN.length - 1);
  for (let length = max; length > 0; length -= 1) {
    if (WEB_SEARCH_OPEN.startsWith(value.slice(-length))) return length;
  }
  return 0;
}

function emitWebSearchItem(
  state: StreamBridgeState,
  out: string[],
  content: string,
): void {
  if (state.textStarted) closeTextItem(state, out);
  const outputIndex = state.outputIndex;
  const itemId = newId("ws");
  const action = webSearchAction(content);
  out.push(
    sseEvent("response.output_item.added", {
      output_index: outputIndex,
      item: {
        id: itemId,
        type: "web_search_call",
        status: "in_progress",
        action,
      },
    }),
  );
  const item = {
    id: itemId,
    type: "web_search_call",
    status: "completed",
    action,
  };
  out.push(
    sseEvent("response.output_item.done", {
      output_index: outputIndex,
      item,
    }),
  );
  state.completedItems.push({ outputIndex, item });
  state.outputIndex += 1;

  if (content) {
    emitTextDelta(state, out, content);
    closeTextItem(state, out);
  }
}

function consumeTextContent(
  state: StreamBridgeState,
  out: string[],
  content: string,
): void {
  if (!content) return;
  if (!state.webSearchEnabled) {
    emitTextDelta(state, out, content);
    return;
  }

  state.webSearchBuffer += content;
  while (state.webSearchBuffer) {
    if (state.insideWebSearch) {
      const close = state.webSearchBuffer.indexOf(WEB_SEARCH_CLOSE);
      if (close < 0) return;
      const searchContent = state.webSearchBuffer.slice(0, close);
      state.webSearchBuffer = state.webSearchBuffer.slice(
        close + WEB_SEARCH_CLOSE.length,
      );
      state.insideWebSearch = false;
      emitWebSearchItem(state, out, searchContent);
      continue;
    }

    const open = state.webSearchBuffer.indexOf(WEB_SEARCH_OPEN);
    if (open >= 0) {
      emitTextDelta(state, out, state.webSearchBuffer.slice(0, open));
      if (state.textStarted) closeTextItem(state, out);
      state.webSearchBuffer = state.webSearchBuffer.slice(
        open + WEB_SEARCH_OPEN.length,
      );
      state.insideWebSearch = true;
      continue;
    }

    const pending = pendingOpenTagLength(state.webSearchBuffer);
    const safeLength = state.webSearchBuffer.length - pending;
    emitTextDelta(state, out, state.webSearchBuffer.slice(0, safeLength));
    state.webSearchBuffer = state.webSearchBuffer.slice(safeLength);
    return;
  }
}

function flushPendingWebSearchText(
  state: StreamBridgeState,
  out: string[],
): void {
  if (!state.webSearchBuffer && !state.insideWebSearch) return;
  const content = state.insideWebSearch
    ? WEB_SEARCH_OPEN + state.webSearchBuffer
    : state.webSearchBuffer;
  state.webSearchBuffer = "";
  state.insideWebSearch = false;
  emitTextDelta(state, out, content);
}

/**
 * Convert one Chat Completions SSE JSON chunk into zero or more Responses SSE frames.
 */
export function chatChunkToResponsesEvents(
  chunk: Record<string, unknown>,
  state: StreamBridgeState,
): string[] {
  const out: string[] = [];
  ensureCreated(state, out);

  if (chunk.usage && typeof chunk.usage === "object") {
    state.usage = mapUsage(chunk.usage as Record<string, unknown>);
  }

  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
  for (const choiceRaw of choices) {
    const choice = choiceRaw as Record<string, unknown>;
    const delta = (choice.delta || choice.message || {}) as Record<string, unknown>;
    const finish = choice.finish_reason as string | null | undefined;

    if (typeof delta.content === "string" && delta.content.length > 0) {
      consumeTextContent(state, out, delta.content);
    }

    // Completions-style: choices[].text
    if (typeof choice.text === "string" && choice.text.length > 0) {
      consumeTextContent(state, out, choice.text);
    }

    const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    if (toolCalls.length > 0) flushPendingWebSearchText(state, out);
    for (const tcRaw of toolCalls) {
      const tc = tcRaw as Record<string, unknown>;
      const idx = typeof tc.index === "number" ? tc.index : 0;
      let entry = state.toolCalls.get(idx);
      const fn = (tc.function || {}) as Record<string, unknown>;

      if (!entry) {
        const callId = String(tc.id || newId("call"));
        const name = String(fn.name || "");
        entry = {
          itemId: newId(isCustomToolName(state, name) ? "ctc" : "fc"),
          callId,
          name,
          arguments: "",
          started: false,
          custom: isCustomToolName(state, name),
          outputIndex: -1,
        };
        state.toolCalls.set(idx, entry);
      } else {
        if (tc.id) entry.callId = String(tc.id);
        if (typeof fn.name === "string" && fn.name) {
          entry.name = fn.name;
          entry.custom = isCustomToolName(state, entry.name);
        }
      }

      if (!entry.started && entry.name) {
        entry.started = true;
        entry.custom = isCustomToolName(state, entry.name);
        // Close text item before tool calls if needed
        if (state.textStarted && state.textItemId) {
          closeTextItem(state, out);
        }
        entry.outputIndex = state.outputIndex;
        state.outputIndex += 1;
        if (entry.custom) {
          out.push(
            sseEvent("response.output_item.added", {
              output_index: entry.outputIndex,
              item: {
                id: entry.itemId,
                type: "custom_tool_call",
                status: "in_progress",
                call_id: entry.callId,
                name: entry.name,
                input: "",
              },
            }),
          );
        } else {
          out.push(
            sseEvent("response.output_item.added", {
              output_index: entry.outputIndex,
              item: {
                id: entry.itemId,
                type: "function_call",
                status: "in_progress",
                call_id: entry.callId,
                name: entry.name,
                arguments: "",
              },
            }),
          );
        }
      }

      if (typeof fn.arguments === "string" && fn.arguments.length > 0) {
        if (!entry.started) {
          // name may arrive later; start with placeholder
          entry.started = true;
          entry.custom = isCustomToolName(state, entry.name);
          if (state.textStarted && state.textItemId) closeTextItem(state, out);
          entry.outputIndex = state.outputIndex;
          state.outputIndex += 1;
          if (entry.custom) {
            out.push(
              sseEvent("response.output_item.added", {
                output_index: entry.outputIndex,
                item: {
                  id: entry.itemId,
                  type: "custom_tool_call",
                  status: "in_progress",
                  call_id: entry.callId,
                  name: entry.name || "tool",
                  input: "",
                },
              }),
            );
          } else {
            out.push(
              sseEvent("response.output_item.added", {
                output_index: entry.outputIndex,
                item: {
                  id: entry.itemId,
                  type: "function_call",
                  status: "in_progress",
                  call_id: entry.callId,
                  name: entry.name || "tool",
                  arguments: "",
                },
              }),
            );
          }
        }
        entry.arguments += fn.arguments;
        // For custom tools, buffer JSON-wrapped args and emit raw input at done.
        // Function tools stream argument deltas as usual.
        if (!entry.custom) {
          out.push(
            sseEvent("response.function_call_arguments.delta", {
              item_id: entry.itemId,
              output_index: entry.outputIndex,
              delta: fn.arguments,
            }),
          );
        }
      }
    }

    if (finish) {
      finalizeStream(state, out, finish);
    }
  }

  return out;
}

function closeTextItem(state: StreamBridgeState, out: string[]): void {
  if (!state.textStarted || !state.textItemId) return;
  const outputIndex = state.outputIndex;
  const item = {
    id: state.textItemId,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [
      { type: "output_text", text: state.currentText, annotations: [] },
    ],
  };
  out.push(
    sseEvent("response.output_text.done", {
      item_id: state.textItemId,
      output_index: outputIndex,
      content_index: state.textContentIndex,
      text: state.currentText,
    }),
  );
  out.push(
    sseEvent("response.content_part.done", {
      item_id: state.textItemId,
      output_index: outputIndex,
      content_index: state.textContentIndex,
      part: { type: "output_text", text: state.currentText, annotations: [] },
    }),
  );
  out.push(
    sseEvent("response.output_item.done", {
      output_index: outputIndex,
      item,
    }),
  );
  state.completedItems.push({ outputIndex, item });
  state.outputIndex += 1;
  state.textStarted = false;
  state.textItemId = null;
  state.currentText = "";
}

function finalizeStream(
  state: StreamBridgeState,
  out: string[],
  finishReason: string,
): void {
  if (state.completed) return;

  flushPendingWebSearchText(state, out);
  if (state.textStarted && state.textItemId) {
    closeTextItem(state, out);
  }

  for (const entry of state.toolCalls.values()) {
    if (!entry.started) continue;
    // Re-evaluate in case the name arrived after the item was opened
    entry.custom = isCustomToolName(state, entry.name) || entry.custom;
    const outputIndex =
      entry.outputIndex >= 0 ? entry.outputIndex : state.outputIndex;

    if (entry.custom) {
      const input = unwrapCustomToolInput(entry.arguments);
      const item = {
        id: entry.itemId,
        type: "custom_tool_call",
        status: "completed",
        call_id: entry.callId,
        name: entry.name || "tool",
        input,
      };
      out.push(
        sseEvent("response.custom_tool_call_input.delta", {
          item_id: entry.itemId,
          output_index: outputIndex,
          call_id: entry.callId,
          delta: input,
        }),
      );
      out.push(
        sseEvent("response.custom_tool_call_input.done", {
          item_id: entry.itemId,
          output_index: outputIndex,
          call_id: entry.callId,
          input,
        }),
      );
      out.push(
        sseEvent("response.output_item.done", {
          output_index: outputIndex,
          item,
        }),
      );
      state.completedItems.push({ outputIndex, item });
    } else {
      const item = {
        id: entry.itemId,
        type: "function_call",
        status: "completed",
        call_id: entry.callId,
        name: entry.name || "tool",
        arguments: entry.arguments,
      };
      out.push(
        sseEvent("response.function_call_arguments.done", {
          item_id: entry.itemId,
          output_index: outputIndex,
          arguments: entry.arguments,
        }),
      );
      out.push(
        sseEvent("response.output_item.done", {
          output_index: outputIndex,
          item,
        }),
      );
      state.completedItems.push({ outputIndex, item });
    }
    if (entry.outputIndex < 0) {
      entry.outputIndex = outputIndex;
      state.outputIndex = Math.max(state.outputIndex, outputIndex + 1);
    }
  }

  const status =
    finishReason === "length" || finishReason === "content_filter"
      ? "incomplete"
      : "completed";

  const output = state.completedItems
    .slice()
    .sort((a, b) => a.outputIndex - b.outputIndex)
    .map(({ item }) => item);

  const response = {
    ...baseResponse(state, status),
    output,
    usage: state.usage,
  };
  out.push(sseEvent("response.completed", { response }));
  state.completed = true;
}

export function forceCompleteStream(state: StreamBridgeState): string[] {
  if (state.completed) return [];
  const out: string[] = [];
  ensureCreated(state, out);
  finalizeStream(state, out, "stop");
  return out;
}

/**
 * Non-streaming Chat Completions JSON → Responses JSON.
 */
export function chatCompletionToResponse(
  chat: Record<string, unknown>,
  modelFallback?: string,
  customTools?: Iterable<string>,
  webSearchEnabled = false,
): Record<string, unknown> {
  const id = newId("resp");
  const model = String(chat.model || modelFallback || "");
  const customSet = new Set(customTools ?? []);
  const usage = mapUsage(
    chat.usage && typeof chat.usage === "object"
      ? (chat.usage as Record<string, unknown>)
      : undefined,
  );
  const output: unknown[] = [];
  const choices = Array.isArray(chat.choices) ? chat.choices : [];
  const choice = (choices[0] || {}) as Record<string, unknown>;
  const message = (choice.message || {}) as Record<string, unknown>;

  // Completions API shape
  const textFromCompletions =
    typeof choice.text === "string" ? choice.text : "";

  const content =
    typeof message.content === "string"
      ? message.content
      : textFromCompletions;

  for (const segment of splitWebSearchContent(content, webSearchEnabled)) {
    if (segment.type === "web_search") {
      output.push({
        id: newId("ws"),
        type: "web_search_call",
        status: "completed",
        action: webSearchAction(segment.content),
      });
      if (!segment.content) continue;
    }
    output.push({
      id: newId("msg"),
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        { type: "output_text", text: segment.content, annotations: [] },
      ],
    });
  }

  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const tcRaw of toolCalls) {
    const tc = tcRaw as Record<string, unknown>;
    const fn = (tc.function || {}) as Record<string, unknown>;
    const name = String(fn.name || "tool");
    const args =
      typeof fn.arguments === "string"
        ? fn.arguments
        : JSON.stringify(fn.arguments ?? {});
    if (customSet.has(name)) {
      output.push({
        id: newId("ctc"),
        type: "custom_tool_call",
        status: "completed",
        call_id: String(tc.id || newId("call")),
        name,
        input: unwrapCustomToolInput(args),
      });
    } else {
      output.push({
        id: newId("fc"),
        type: "function_call",
        status: "completed",
        call_id: String(tc.id || newId("call")),
        name,
        arguments: args,
      });
    }
  }

  const finish = String(choice.finish_reason || "stop");
  const status =
    finish === "length" || finish === "content_filter"
      ? "incomplete"
      : "completed";

  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output,
    error: null,
    incomplete_details: null,
    usage,
  };
}

/**
 * Parse SSE lines from Chat Completions upstream into JSON chunk objects.
 */
export function parseChatSseLine(
  line: string,
): Record<string, unknown> | "done" | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const data = trimmed.slice(5).trim();
  if (data === "[DONE]") return "done";
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
}
