/**
 * Translate Anthropic Messages responses (stream/non-stream) → OpenAI Chat
 * Completions.
 *
 * Reverse direction of `anthropic-translate-response.ts`. Used by the gateway
 * when an Anthropic upstream must be presented in Chat Completions shape (the
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

/** Anthropic stop_reason → Chat Completions finish_reason. */
export function anthropicStopReasonToFinishReason(
  reason: unknown,
): string | null {
  switch (reason) {
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    case "refusal":
      return "content_filter";
    case "end_turn":
    case "stop_sequence":
      return "stop";
    default:
      return reason == null ? null : "stop";
  }
}

function mapUsage(
  usage: Record<string, unknown> | null,
): Record<string, unknown> | undefined {
  if (!usage) return undefined;
  const prompt = numberOr(usage.input_tokens);
  const completion = numberOr(usage.output_tokens);
  const out: Record<string, unknown> = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
  const cacheRead = usage.cache_read_input_tokens;
  const cacheWrite = usage.cache_creation_input_tokens;
  if (typeof cacheRead === "number") {
    out.prompt_tokens_details = { cached_tokens: cacheRead };
  }
  if (typeof cacheWrite === "number") {
    out.cache_creation_input_tokens = cacheWrite;
  }
  return out;
}

function stringifyToolInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return "{}";
  }
}

/** Non-streaming Anthropic message → Chat Completions object. */
export function anthropicMessageToChatCompletion(
  message: Record<string, unknown>,
  fallbackModel = "",
): Record<string, unknown> {
  const blocks = Array.isArray(message.content) ? message.content : [];
  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];

  for (const raw of blocks) {
    const block = asRecord(raw);
    if (!block) continue;
    const type = String(block.type || "");
    if (type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
      continue;
    }
    if (type === "thinking" && typeof block.thinking === "string") {
      thinkingParts.push(block.thinking);
      continue;
    }
    if (type === "tool_use") {
      toolCalls.push({
        index: toolCalls.length,
        id: String(block.id || newId("call")),
        type: "function",
        function: {
          name: String(block.name || "tool"),
          arguments: stringifyToolInput(block.input),
        },
      });
    }
  }

  const chatMessage: Record<string, unknown> = {
    role: "assistant",
    content: textParts.length ? textParts.join("") : null,
  };
  if (thinkingParts.length) {
    chatMessage.reasoning_content = thinkingParts.join("");
  }
  if (toolCalls.length) chatMessage.tool_calls = toolCalls;

  const finishReason =
    anthropicStopReasonToFinishReason(message.stop_reason) ??
    (toolCalls.length ? "tool_calls" : "stop");

  const out: Record<string, unknown> = {
    id:
      typeof message.id === "string" && message.id
        ? message.id.replace(/^msg_/, "chatcmpl-")
        : newId("chatcmpl"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: String(message.model || fallbackModel || ""),
    choices: [
      {
        index: 0,
        message: chatMessage,
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
  };
  const usage = mapUsage(asRecord(message.usage));
  if (usage) out.usage = usage;
  return out;
}

export interface AnthropicToChatStreamState {
  id: string;
  model: string;
  created: number;
  /** Anthropic content block index → chat tool_call slot. */
  blocks: Map<number, { toolIndex: number; id: string; name: string }>;
  nextToolIndex: number;
  roleEmitted: boolean;
  finishReason: string | null;
  inputTokens: number;
  outputTokens: number;
  hasUsage: boolean;
  completed: boolean;
  /** Emit a trailing usage-only chunk (OpenAI stream_options.include_usage). */
  includeUsage: boolean;
}

export function createAnthropicToChatStreamState(
  model: string,
  options: { includeUsage?: boolean } = {},
): AnthropicToChatStreamState {
  return {
    id: newId("chatcmpl"),
    model,
    created: Math.floor(Date.now() / 1000),
    blocks: new Map(),
    nextToolIndex: 0,
    roleEmitted: false,
    finishReason: null,
    inputTokens: 0,
    outputTokens: 0,
    hasUsage: false,
    completed: false,
    includeUsage: options.includeUsage !== false,
  };
}

function chunk(
  state: AnthropicToChatStreamState,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): Record<string, unknown> {
  return {
    id: state.id,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
  };
}

function ensureRole(
  state: AnthropicToChatStreamState,
  out: Array<Record<string, unknown>>,
): void {
  if (state.roleEmitted) return;
  state.roleEmitted = true;
  out.push(chunk(state, { role: "assistant", content: "" }));
}

/**
 * Parse one Anthropic SSE line into an event object. Anthropic sends
 * `event: <name>` followed by `data: {...}`; the JSON payload carries `type`,
 * so only data lines are meaningful.
 */
export function parseAnthropicSseLine(
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

export class AnthropicStreamError extends Error {
  constructor(
    message: string,
    readonly errorType = "api_error",
  ) {
    super(message);
    this.name = "AnthropicStreamError";
  }
}

/**
 * Convert one Anthropic SSE event into zero or more Chat Completions chunks.
 * Throws `AnthropicStreamError` when the upstream emits an error event.
 */
export function anthropicEventToChatChunks(
  event: Record<string, unknown>,
  state: AnthropicToChatStreamState,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const type = String(event.type || "");

  switch (type) {
    case "message_start": {
      const message = asRecord(event.message);
      if (message) {
        if (typeof message.model === "string" && message.model) {
          state.model = message.model;
        }
        if (typeof message.id === "string" && message.id) {
          state.id = message.id.replace(/^msg_/, "chatcmpl-");
        }
        const usage = asRecord(message.usage);
        if (usage) {
          state.inputTokens = numberOr(usage.input_tokens, state.inputTokens);
          state.outputTokens = numberOr(usage.output_tokens, state.outputTokens);
          state.hasUsage = true;
        }
      }
      ensureRole(state, out);
      return out;
    }

    case "content_block_start": {
      ensureRole(state, out);
      const index = numberOr(event.index, -1);
      const block = asRecord(event.content_block);
      if (!block || index < 0) return out;
      if (String(block.type || "") !== "tool_use") return out;
      const toolIndex = state.nextToolIndex++;
      const id = String(block.id || newId("call"));
      const name = String(block.name || "tool");
      state.blocks.set(index, { toolIndex, id, name });
      out.push(
        chunk(state, {
          tool_calls: [
            {
              index: toolIndex,
              id,
              type: "function",
              function: { name, arguments: "" },
            },
          ],
        }),
      );
      return out;
    }

    case "content_block_delta": {
      ensureRole(state, out);
      const delta = asRecord(event.delta);
      if (!delta) return out;
      const deltaType = String(delta.type || "");

      if (deltaType === "text_delta" && typeof delta.text === "string") {
        if (delta.text) out.push(chunk(state, { content: delta.text }));
        return out;
      }
      if (deltaType === "thinking_delta" && typeof delta.thinking === "string") {
        if (delta.thinking) {
          out.push(chunk(state, { reasoning_content: delta.thinking }));
        }
        return out;
      }
      if (
        deltaType === "input_json_delta" &&
        typeof delta.partial_json === "string"
      ) {
        const index = numberOr(event.index, -1);
        const entry = state.blocks.get(index);
        if (!entry || !delta.partial_json) return out;
        out.push(
          chunk(state, {
            tool_calls: [
              {
                index: entry.toolIndex,
                function: { arguments: delta.partial_json },
              },
            ],
          }),
        );
      }
      return out;
    }

    case "message_delta": {
      const delta = asRecord(event.delta);
      const finish = anthropicStopReasonToFinishReason(delta?.stop_reason);
      if (finish) state.finishReason = finish;
      const usage = asRecord(event.usage);
      if (usage) {
        state.outputTokens = numberOr(usage.output_tokens, state.outputTokens);
        state.inputTokens = numberOr(usage.input_tokens, state.inputTokens);
        state.hasUsage = true;
      }
      return out;
    }

    case "message_stop":
      return finishAnthropicToChatStream(state);

    case "error": {
      const error = asRecord(event.error);
      throw new AnthropicStreamError(
        String(error?.message || "上游 Anthropic 流返回错误"),
        String(error?.type || "api_error"),
      );
    }

    default:
      // ping / content_block_stop / unknown events carry no chat payload.
      return out;
  }
}

function finishAnthropicToChatStream(
  state: AnthropicToChatStreamState,
): Array<Record<string, unknown>> {
  if (state.completed) return [];
  state.completed = true;
  const out: Array<Record<string, unknown>> = [];
  const finishReason =
    state.finishReason || (state.blocks.size ? "tool_calls" : "stop");
  out.push(chunk(state, {}, finishReason));
  if (state.includeUsage && state.hasUsage) {
    out.push({
      id: state.id,
      object: "chat.completion.chunk",
      created: state.created,
      model: state.model,
      choices: [],
      usage: {
        prompt_tokens: state.inputTokens,
        completion_tokens: state.outputTokens,
        total_tokens: state.inputTokens + state.outputTokens,
      },
    });
  }
  return out;
}

/** Emit the terminal chunks when the upstream stream ends without message_stop. */
export function forceCompleteAnthropicToChatStream(
  state: AnthropicToChatStreamState,
): Array<Record<string, unknown>> {
  return finishAnthropicToChatStream(state);
}
