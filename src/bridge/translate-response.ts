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
  fullText: string;
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
): StreamBridgeState {
  return {
    responseId: responseId || newId("resp"),
    model,
    textItemId: null,
    textStarted: false,
    textContentIndex: 0,
    outputIndex: 0,
    fullText: "",
    customTools: new Set(customTools ?? []),
    toolCalls: new Map(),
    created: false,
    completed: false,
  };
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
      ensureTextItem(state, out);
      state.fullText += delta.content;
      out.push(
        sseEvent("response.output_text.delta", {
          item_id: state.textItemId,
          output_index: state.outputIndex,
          content_index: state.textContentIndex,
          delta: delta.content,
        }),
      );
    }

    // Completions-style: choices[].text
    if (typeof choice.text === "string" && choice.text.length > 0) {
      ensureTextItem(state, out);
      state.fullText += choice.text;
      out.push(
        sseEvent("response.output_text.delta", {
          item_id: state.textItemId,
          output_index: state.outputIndex,
          content_index: state.textContentIndex,
          delta: choice.text,
        }),
      );
    }

    const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
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
  out.push(
    sseEvent("response.output_text.done", {
      item_id: state.textItemId,
      output_index: outputIndex,
      content_index: state.textContentIndex,
      text: state.fullText,
    }),
  );
  out.push(
    sseEvent("response.content_part.done", {
      item_id: state.textItemId,
      output_index: outputIndex,
      content_index: state.textContentIndex,
      part: { type: "output_text", text: state.fullText, annotations: [] },
    }),
  );
  out.push(
    sseEvent("response.output_item.done", {
      output_index: outputIndex,
      item: {
        id: state.textItemId,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          { type: "output_text", text: state.fullText, annotations: [] },
        ],
      },
    }),
  );
  state.outputIndex += 1;
  state.textStarted = false;
  state.textItemId = null;
}

function finalizeStream(
  state: StreamBridgeState,
  out: string[],
  finishReason: string,
): void {
  if (state.completed) return;

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
          item: {
            id: entry.itemId,
            type: "custom_tool_call",
            status: "completed",
            call_id: entry.callId,
            name: entry.name || "tool",
            input,
          },
        }),
      );
    } else {
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
          item: {
            id: entry.itemId,
            type: "function_call",
            status: "completed",
            call_id: entry.callId,
            name: entry.name || "tool",
            arguments: entry.arguments,
          },
        }),
      );
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

  const output: unknown[] = [];
  if (state.fullText) {
    output.push({
      id: newId("msg"),
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: state.fullText, annotations: [] }],
    });
  }
  for (const entry of state.toolCalls.values()) {
    if (entry.custom) {
      output.push({
        id: entry.itemId,
        type: "custom_tool_call",
        status: "completed",
        call_id: entry.callId,
        name: entry.name || "tool",
        input: unwrapCustomToolInput(entry.arguments),
      });
    } else {
      output.push({
        id: entry.itemId,
        type: "function_call",
        status: "completed",
        call_id: entry.callId,
        name: entry.name || "tool",
        arguments: entry.arguments,
      });
    }
  }

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

  if (content) {
    output.push({
      id: newId("msg"),
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: content, annotations: [] }],
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
