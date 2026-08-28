/**
 * Translate OpenAI Responses API results (stream/non-stream) → Chat Completions.
 *
 * Reverse direction of `translate-response.ts`. Used by the gateway when a
 * Responses upstream must be presented in Chat Completions shape (the
 * gateway's hub format).
 */

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function numberOr(value: unknown, fallback = 0): number {
  return typeof value === "number" ? value : fallback;
}

function mapUsage(
  usage: Record<string, unknown> | null,
): Record<string, unknown> | undefined {
  if (!usage) return undefined;
  const prompt = numberOr(usage.input_tokens, numberOr(usage.prompt_tokens));
  const completion = numberOr(
    usage.output_tokens,
    numberOr(usage.completion_tokens),
  );
  const out: Record<string, unknown> = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: numberOr(usage.total_tokens, prompt + completion),
  };
  const details = asRecord(usage.output_tokens_details);
  if (details && typeof details.reasoning_tokens === "number") {
    out.completion_tokens_details = {
      reasoning_tokens: details.reasoning_tokens,
    };
  }
  const inputDetails = asRecord(usage.input_tokens_details);
  if (inputDetails && typeof inputDetails.cached_tokens === "number") {
    out.prompt_tokens_details = { cached_tokens: inputDetails.cached_tokens };
  }
  return out;
}

/** Responses status → Chat Completions finish_reason. */
export function responsesStatusToFinishReason(
  status: unknown,
  incompleteDetails?: Record<string, unknown> | null,
): string {
  if (status === "incomplete") {
    return incompleteDetails?.reason === "content_filter"
      ? "content_filter"
      : "length";
  }
  return "stop";
}

function extractOutputText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const raw of content) {
    const part = asRecord(raw);
    if (!part) continue;
    if (typeof part.text === "string") parts.push(part.text);
  }
  return parts.join("");
}

function extractReasoning(item: Record<string, unknown>): string {
  const summary = Array.isArray(item.summary) ? item.summary : [];
  const parts: string[] = [];
  for (const raw of summary) {
    const entry = asRecord(raw);
    if (entry && typeof entry.text === "string") parts.push(entry.text);
    else if (typeof raw === "string") parts.push(raw);
  }
  if (!parts.length && typeof item.text === "string") parts.push(item.text);
  return parts.join("\n");
}

/** Custom (freeform) tool input → Chat function arguments JSON string. */
function customInputToArguments(input: unknown): string {
  const raw = typeof input === "string" ? input : "";
  try {
    return JSON.stringify({ input: raw });
  } catch {
    return "{}";
  }
}

/** Non-streaming Responses object → Chat Completions object. */
export function responseToChatCompletion(
  response: Record<string, unknown>,
  fallbackModel = "",
): Record<string, unknown> {
  const output = Array.isArray(response.output) ? response.output : [];
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];

  for (const raw of output) {
    const item = asRecord(raw);
    if (!item) continue;
    const type = String(item.type || "");

    if (type === "message") {
      const text = extractOutputText(item.content);
      if (text) textParts.push(text);
      continue;
    }
    if (type === "reasoning") {
      const text = extractReasoning(item);
      if (text) reasoningParts.push(text);
      continue;
    }
    if (type === "function_call") {
      toolCalls.push({
        index: toolCalls.length,
        id: String(item.call_id || item.id || newId("call")),
        type: "function",
        function: {
          name: String(item.name || "tool"),
          arguments:
            typeof item.arguments === "string"
              ? item.arguments
              : JSON.stringify(item.arguments ?? {}),
        },
      });
      continue;
    }
    if (type === "custom_tool_call") {
      toolCalls.push({
        index: toolCalls.length,
        id: String(item.call_id || item.id || newId("call")),
        type: "function",
        function: {
          name: String(item.name || "tool"),
          arguments: customInputToArguments(item.input),
        },
      });
    }
  }

  const message: Record<string, unknown> = {
    role: "assistant",
    content: textParts.length ? textParts.join("") : null,
  };
  if (reasoningParts.length) {
    message.reasoning_content = reasoningParts.join("\n");
  }
  if (toolCalls.length) message.tool_calls = toolCalls;

  const finishReason = toolCalls.length
    ? "tool_calls"
    : responsesStatusToFinishReason(
        response.status,
        asRecord(response.incomplete_details),
      );

  const out: Record<string, unknown> = {
    id:
      typeof response.id === "string" && response.id
        ? response.id.replace(/^resp_/, "chatcmpl-")
        : newId("chatcmpl"),
    object: "chat.completion",
    created: numberOr(response.created_at, Math.floor(Date.now() / 1000)),
    model: String(response.model || fallbackModel || ""),
    choices: [
      { index: 0, message, finish_reason: finishReason, logprobs: null },
    ],
  };
  const usage = mapUsage(asRecord(response.usage));
  if (usage) out.usage = usage;
  return out;
}

interface ToolEntry {
  toolIndex: number;
  callId: string;
  name: string;
  custom: boolean;
  /** Buffered freeform input for custom tools (emitted as JSON at done). */
  customInput: string;
  emittedStart: boolean;
}

export interface ResponsesToChatStreamState {
  id: string;
  model: string;
  created: number;
  /** Responses item_id → chat tool_call slot. */
  items: Map<string, ToolEntry>;
  nextToolIndex: number;
  roleEmitted: boolean;
  finishReason: string | null;
  usage: Record<string, unknown> | undefined;
  completed: boolean;
  includeUsage: boolean;
}

export function createResponsesToChatStreamState(
  model: string,
  options: { includeUsage?: boolean } = {},
): ResponsesToChatStreamState {
  return {
    id: newId("chatcmpl"),
    model,
    created: Math.floor(Date.now() / 1000),
    items: new Map(),
    nextToolIndex: 0,
    roleEmitted: false,
    finishReason: null,
    usage: undefined,
    completed: false,
    includeUsage: options.includeUsage !== false,
  };
}

function chunk(
  state: ResponsesToChatStreamState,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): Record<string, unknown> {
  return {
    id: state.id,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
  };
}

function ensureRole(
  state: ResponsesToChatStreamState,
  out: Array<Record<string, unknown>>,
): void {
  if (state.roleEmitted) return;
  state.roleEmitted = true;
  out.push(chunk(state, { role: "assistant", content: "" }));
}

/** Parse one Responses SSE line; the JSON payload carries the event `type`. */
export function parseResponsesSseLine(
  line: string,
): Record<string, unknown> | "done" | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const data = trimmed.slice(5).trim();
  if (!data) return null;
  if (data === "[DONE]") return "done";
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export class ResponsesStreamError extends Error {
  constructor(
    message: string,
    readonly errorType = "api_error",
  ) {
    super(message);
    this.name = "ResponsesStreamError";
  }
}

function toolEntryFor(
  state: ResponsesToChatStreamState,
  itemId: string,
): ToolEntry | undefined {
  if (!itemId) return undefined;
  return state.items.get(itemId);
}

/**
 * Convert one Responses SSE event into zero or more Chat Completions chunks.
 * Throws `ResponsesStreamError` on upstream error/failed events.
 */
export function responsesEventToChatChunks(
  event: Record<string, unknown>,
  state: ResponsesToChatStreamState,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const type = String(event.type || "");

  if (type === "response.created" || type === "response.in_progress") {
    const response = asRecord(event.response);
    if (response) {
      if (typeof response.model === "string" && response.model) {
        state.model = response.model;
      }
      if (typeof response.id === "string" && response.id) {
        state.id = response.id.replace(/^resp_/, "chatcmpl-");
      }
    }
    ensureRole(state, out);
    return out;
  }

  if (type === "response.output_item.added") {
    ensureRole(state, out);
    const item = asRecord(event.item);
    if (!item) return out;
    const itemType = String(item.type || "");
    if (itemType !== "function_call" && itemType !== "custom_tool_call") {
      return out;
    }
    const itemId = String(item.id || "");
    const entry: ToolEntry = {
      toolIndex: state.nextToolIndex++,
      callId: String(item.call_id || item.id || newId("call")),
      name: String(item.name || "tool"),
      custom: itemType === "custom_tool_call",
      customInput: "",
      emittedStart: true,
    };
    if (itemId) state.items.set(itemId, entry);
    out.push(
      chunk(state, {
        tool_calls: [
          {
            index: entry.toolIndex,
            id: entry.callId,
            type: "function",
            function: { name: entry.name, arguments: "" },
          },
        ],
      }),
    );
    return out;
  }

  if (
    type === "response.output_text.delta" ||
    type === "response.refusal.delta"
  ) {
    ensureRole(state, out);
    const delta = event.delta;
    if (typeof delta === "string" && delta) {
      out.push(chunk(state, { content: delta }));
    }
    return out;
  }

  if (
    type === "response.reasoning_summary_text.delta" ||
    type === "response.reasoning_text.delta"
  ) {
    ensureRole(state, out);
    const delta = event.delta;
    if (typeof delta === "string" && delta) {
      out.push(chunk(state, { reasoning_content: delta }));
    }
    return out;
  }

  if (type === "response.function_call_arguments.delta") {
    const entry = toolEntryFor(state, String(event.item_id || ""));
    const delta = event.delta;
    if (entry && typeof delta === "string" && delta) {
      out.push(
        chunk(state, {
          tool_calls: [
            { index: entry.toolIndex, function: { arguments: delta } },
          ],
        }),
      );
    }
    return out;
  }

  if (type === "response.custom_tool_call_input.delta") {
    const entry = toolEntryFor(state, String(event.item_id || ""));
    const delta = event.delta;
    // Freeform input is not valid JSON; buffer and emit once complete.
    if (entry && typeof delta === "string") entry.customInput += delta;
    return out;
  }

  if (type === "response.custom_tool_call_input.done") {
    const entry = toolEntryFor(state, String(event.item_id || ""));
    if (entry) {
      const input =
        typeof event.input === "string" ? event.input : entry.customInput;
      out.push(
        chunk(state, {
          tool_calls: [
            {
              index: entry.toolIndex,
              function: { arguments: customInputToArguments(input) },
            },
          ],
        }),
      );
      entry.customInput = "";
    }
    return out;
  }

  if (type === "response.output_item.done") {
    const item = asRecord(event.item);
    if (!item) return out;
    const itemId = String(item.id || "");
    const entry = toolEntryFor(state, itemId);
    // Non-streamed argument payloads only appear on the done event.
    if (entry && entry.custom && entry.customInput) {
      out.push(
        chunk(state, {
          tool_calls: [
            {
              index: entry.toolIndex,
              function: {
                arguments: customInputToArguments(entry.customInput),
              },
            },
          ],
        }),
      );
      entry.customInput = "";
    }
    return out;
  }

  if (type === "response.completed" || type === "response.incomplete") {
    const response = asRecord(event.response);
    if (response) {
      state.usage = mapUsage(asRecord(response.usage));
      state.finishReason = state.items.size
        ? "tool_calls"
        : responsesStatusToFinishReason(
            response.status ?? (type === "response.incomplete" ? "incomplete" : "completed"),
            asRecord(response.incomplete_details),
          );
    }
    return finishResponsesToChatStream(state);
  }

  if (type === "response.failed" || type === "error") {
    const response = asRecord(event.response);
    const error = asRecord(event.error) || asRecord(response?.error);
    throw new ResponsesStreamError(
      String(error?.message || "上游 Responses 流返回错误"),
      String(error?.type || error?.code || "api_error"),
    );
  }

  return out;
}

function finishResponsesToChatStream(
  state: ResponsesToChatStreamState,
): Array<Record<string, unknown>> {
  if (state.completed) return [];
  state.completed = true;
  const out: Array<Record<string, unknown>> = [];
  const finishReason =
    state.finishReason || (state.items.size ? "tool_calls" : "stop");
  out.push(chunk(state, {}, finishReason));
  if (state.includeUsage && state.usage) {
    out.push({
      id: state.id,
      object: "chat.completion.chunk",
      created: state.created,
      model: state.model,
      choices: [],
      usage: state.usage,
    });
  }
  return out;
}

/** Emit terminal chunks when the upstream stream ends without a completion event. */
export function forceCompleteResponsesToChatStream(
  state: ResponsesToChatStreamState,
): Array<Record<string, unknown>> {
  return finishResponsesToChatStream(state);
}
