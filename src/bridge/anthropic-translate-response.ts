/**
 * Translate Chat Completions (stream/non-stream) → Anthropic Messages API.
 */

import { parseChatSseLine } from "./translate-response.js";

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function numberOr(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

export function mapFinishReason(
  reason: unknown,
): "end_turn" | "tool_use" | "max_tokens" | null {
  if (reason === "tool_calls" || reason === "function_call") return "tool_use";
  if (reason === "length") return "max_tokens";
  if (reason === "stop" || reason === "end_turn") return "end_turn";
  return reason == null ? null : "end_turn";
}

export function chatCompletionToAnthropicMessage(
  chat: Record<string, unknown>,
  fallbackModel: string,
): Record<string, unknown> {
  const choice = Array.isArray(chat.choices)
    ? asRecord(chat.choices[0])
    : null;
  const message = choice ? asRecord(choice.message) : null;
  const content: Array<Record<string, unknown>> = [];

  const text =
    typeof message?.content === "string"
      ? message.content
      : message?.content == null
        ? ""
        : String(message.content);
  if (text) {
    content.push({ type: "text", text });
  }

  const toolCalls = Array.isArray(message?.tool_calls)
    ? message!.tool_calls
    : [];
  for (const call of toolCalls) {
    const row = asRecord(call);
    if (!row) continue;
    const fn = asRecord(row.function);
    content.push({
      type: "tool_use",
      id: String(row.id || newId("toolu")),
      name: String(fn?.name || "tool"),
      input: parseToolArguments(fn?.arguments),
    });
  }

  if (!content.length) {
    content.push({ type: "text", text: "" });
  }

  const usage = asRecord(chat.usage);
  const stopReason =
    mapFinishReason(choice?.finish_reason) ||
    (toolCalls.length ? "tool_use" : "end_turn");

  return {
    id: typeof chat.id === "string" ? `msg_${chat.id}` : newId("msg"),
    type: "message",
    role: "assistant",
    model: String(chat.model || fallbackModel || ""),
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens:
        numberOr(usage?.prompt_tokens) ?? numberOr(usage?.input_tokens) ?? 0,
      output_tokens:
        numberOr(usage?.completion_tokens) ??
        numberOr(usage?.output_tokens) ??
        0,
    },
  };
}

export interface AnthropicStreamState {
  messageId: string;
  model: string;
  textIndex: number | null;
  textStarted: boolean;
  fullText: string;
  toolCalls: Map<
    number,
    {
      blockIndex: number;
      id: string;
      name: string;
      arguments: string;
      started: boolean;
    }
  >;
  nextBlockIndex: number;
  started: boolean;
  stopped: boolean;
  stopReason: string | null;
  usage?: { input_tokens: number; output_tokens: number };
}

export function createAnthropicStreamState(
  model: string,
  messageId?: string,
): AnthropicStreamState {
  return {
    messageId: messageId || newId("msg"),
    model,
    textIndex: null,
    textStarted: false,
    fullText: "",
    toolCalls: new Map(),
    nextBlockIndex: 0,
    started: false,
    stopped: false,
    stopReason: null,
  };
}

function sseData(payload: Record<string, unknown>): string {
  return `event: ${String(payload.type)}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function ensureMessageStart(state: AnthropicStreamState, out: string[]): void {
  if (state.started) return;
  state.started = true;
  out.push(
    sseData({
      type: "message_start",
      message: {
        id: state.messageId,
        type: "message",
        role: "assistant",
        model: state.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }),
  );
}

function ensureTextBlock(state: AnthropicStreamState, out: string[]): void {
  if (state.textStarted) return;
  state.textStarted = true;
  state.textIndex = state.nextBlockIndex++;
  out.push(
    sseData({
      type: "content_block_start",
      index: state.textIndex,
      content_block: { type: "text", text: "" },
    }),
  );
}

function closeTextBlock(state: AnthropicStreamState, out: string[]): void {
  if (!state.textStarted || state.textIndex == null) return;
  out.push(
    sseData({
      type: "content_block_stop",
      index: state.textIndex,
    }),
  );
  state.textStarted = false;
  state.textIndex = null;
}

export function chatChunkToAnthropicEvents(
  chunk: Record<string, unknown>,
  state: AnthropicStreamState,
): string[] {
  const out: string[] = [];
  ensureMessageStart(state, out);

  if (chunk.model && typeof chunk.model === "string") {
    state.model = chunk.model;
  }

  const usage = asRecord(chunk.usage);
  if (usage) {
    state.usage = {
      input_tokens:
        numberOr(usage.prompt_tokens) ?? numberOr(usage.input_tokens) ?? 0,
      output_tokens:
        numberOr(usage.completion_tokens) ??
        numberOr(usage.output_tokens) ??
        0,
    };
  }

  const choice = Array.isArray(chunk.choices)
    ? asRecord(chunk.choices[0])
    : null;
  if (!choice) return out;

  const finish = mapFinishReason(choice.finish_reason);
  if (finish) state.stopReason = finish;

  const delta = asRecord(choice.delta) || asRecord(choice.message);
  if (!delta) return out;

  if (typeof delta.content === "string" && delta.content.length) {
    ensureTextBlock(state, out);
    state.fullText += delta.content;
    out.push(
      sseData({
        type: "content_block_delta",
        index: state.textIndex,
        delta: { type: "text_delta", text: delta.content },
      }),
    );
  }

  const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
  for (const call of toolCalls) {
    const row = asRecord(call);
    if (!row) continue;
    const index =
      typeof row.index === "number" ? row.index : state.toolCalls.size;
    let entry = state.toolCalls.get(index);
    const fn = asRecord(row.function);
    if (!entry) {
      // Close text before tool blocks when tools start
      closeTextBlock(state, out);
      entry = {
        blockIndex: state.nextBlockIndex++,
        id: String(row.id || newId("toolu")),
        name: String(fn?.name || ""),
        arguments: "",
        started: false,
      };
      state.toolCalls.set(index, entry);
    }
    if (row.id) entry.id = String(row.id);
    if (fn?.name) entry.name = String(fn.name);
    if (typeof fn?.arguments === "string") {
      entry.arguments += fn.arguments;
    }

    if (!entry.started && entry.name) {
      entry.started = true;
      out.push(
        sseData({
          type: "content_block_start",
          index: entry.blockIndex,
          content_block: {
            type: "tool_use",
            id: entry.id,
            name: entry.name,
            input: {},
          },
        }),
      );
    }
    if (entry.started && typeof fn?.arguments === "string" && fn.arguments) {
      out.push(
        sseData({
          type: "content_block_delta",
          index: entry.blockIndex,
          delta: {
            type: "input_json_delta",
            partial_json: fn.arguments,
          },
        }),
      );
    }
  }

  return out;
}

export function forceCompleteAnthropicStream(
  state: AnthropicStreamState,
): string[] {
  if (state.stopped) return [];
  state.stopped = true;
  const out: string[] = [];
  ensureMessageStart(state, out);
  closeTextBlock(state, out);
  for (const entry of state.toolCalls.values()) {
    if (entry.started) {
      out.push(
        sseData({
          type: "content_block_stop",
          index: entry.blockIndex,
        }),
      );
    }
  }

  const stopReason =
    state.stopReason ||
    (state.toolCalls.size > 0 ? "tool_use" : "end_turn");

  out.push(
    sseData({
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: {
        output_tokens: state.usage?.output_tokens ?? 0,
      },
    }),
  );
  out.push(sseData({ type: "message_stop" }));
  return out;
}

export { parseChatSseLine };
