/**
 * Translate OpenAI Chat Completions requests → OpenAI Responses API.
 *
 * Reverse direction of `translate-request.ts`. Used by the gateway when a
 * Chat-format client is routed to a Responses upstream.
 */

import type { ChatMessage, ChatRequest } from "./translate-request.js";

type Item = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function contentToText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((raw) => {
      const part = asRecord(raw);
      return part && typeof part.text === "string" ? part.text : "";
    })
    .join("");
}

/** Chat content parts → Responses input content parts. */
function chatContentToInputParts(
  content: ChatMessage["content"],
  textType: "input_text" | "output_text",
): Item[] {
  if (typeof content === "string") {
    return content ? [{ type: textType, text: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const parts: Item[] = [];
  for (const raw of content) {
    const part = asRecord(raw);
    if (!part) continue;
    const type = String(part.type || "");

    if (
      (type === "text" || type === "input_text" || type === "output_text") &&
      typeof part.text === "string"
    ) {
      parts.push({ type: textType, text: part.text });
      continue;
    }
    if (type === "image_url") {
      const nested = asRecord(part.image_url);
      const url =
        typeof nested?.url === "string"
          ? nested.url
          : typeof part.image_url === "string"
            ? part.image_url
            : "";
      if (url) {
        const item: Item = { type: "input_image", image_url: url };
        if (typeof nested?.detail === "string") item.detail = nested.detail;
        parts.push(item);
      }
      continue;
    }
    if (type === "input_audio") {
      const nested = asRecord(part.input_audio);
      if (nested) parts.push({ type: "input_audio", input_audio: nested });
      continue;
    }
    if (type === "file") {
      const nested = asRecord(part.file);
      if (nested) parts.push({ type: "input_file", ...nested });
      continue;
    }
    if (typeof part.text === "string") {
      parts.push({ type: textType, text: part.text });
    }
  }
  return parts;
}

export interface ChatToResponsesInput {
  instructions: string;
  input: Item[];
}

export function chatMessagesToResponsesInput(
  chatMessages: readonly ChatMessage[],
): ChatToResponsesInput {
  const instructionParts: string[] = [];
  const input: Item[] = [];

  for (const message of chatMessages) {
    const role = String(message.role || "user");

    if (role === "system" || role === "developer") {
      const text = contentToText(message.content);
      if (text) instructionParts.push(text);
      continue;
    }

    if (role === "tool" || role === "function") {
      const callId = message.tool_call_id || message.name || "";
      if (!callId) continue;
      input.push({
        type: "function_call_output",
        call_id: callId,
        output: contentToText(message.content),
      });
      continue;
    }

    if (role === "assistant") {
      const parts = chatContentToInputParts(message.content, "output_text");
      if (parts.length) {
        input.push({ type: "message", role: "assistant", content: parts });
      }
      for (const call of message.tool_calls ?? []) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.function?.name || "tool",
          arguments:
            typeof call.function?.arguments === "string"
              ? call.function.arguments
              : JSON.stringify(call.function?.arguments ?? {}),
        });
      }
      continue;
    }

    const parts = chatContentToInputParts(message.content, "input_text");
    if (parts.length) {
      input.push({ type: "message", role: "user", content: parts });
    }
  }

  return { instructions: instructionParts.join("\n\n"), input };
}

export function chatToolsToResponsesTools(
  tools: ChatRequest["tools"],
): Item[] | undefined {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  const out: Item[] = [];
  for (const tool of tools) {
    const fn = tool?.function;
    const name = String(fn?.name || "").trim();
    if (!name) continue;
    const entry: Item = {
      type: "function",
      name,
      parameters: fn?.parameters ?? { type: "object", properties: {} },
      strict: false,
    };
    if (typeof fn?.description === "string") entry.description = fn.description;
    out.push(entry);
  }
  return out.length ? out : undefined;
}

export function chatToolChoiceToResponses(toolChoice: unknown): unknown {
  if (toolChoice == null) return undefined;
  if (
    toolChoice === "auto" ||
    toolChoice === "none" ||
    toolChoice === "required"
  ) {
    return toolChoice;
  }
  const obj = asRecord(toolChoice);
  if (!obj) return undefined;
  if (obj.type === "function") {
    const nested = asRecord(obj.function);
    const name = String(nested?.name || obj.name || "");
    return name ? { type: "function", name } : "auto";
  }
  return toolChoice;
}

/**
 * Chat Completions request → Responses request body.
 * `store` defaults to false: the gateway is stateless and must not create
 * server-side conversation state on the upstream.
 */
export function chatToResponsesRequest(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const chatMessages = Array.isArray(body.messages)
    ? (body.messages as ChatMessage[])
    : [];
  const { instructions, input } = chatMessagesToResponsesInput(chatMessages);
  const stream = Boolean(body.stream);

  const out: Record<string, unknown> = {
    model: String(body.model || ""),
    input,
    stream,
    store: false,
  };
  if (instructions) out.instructions = instructions;

  const tools = chatToolsToResponsesTools(
    body.tools as ChatRequest["tools"] | undefined,
  );
  if (tools) out.tools = tools;

  if (body.tool_choice !== undefined) {
    const choice = chatToolChoiceToResponses(body.tool_choice);
    if (choice !== undefined) out.tool_choice = choice;
  }
  if (typeof body.parallel_tool_calls === "boolean") {
    out.parallel_tool_calls = body.parallel_tool_calls;
  }
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;

  const maxOut =
    typeof body.max_completion_tokens === "number"
      ? body.max_completion_tokens
      : typeof body.max_tokens === "number"
        ? body.max_tokens
        : undefined;
  if (typeof maxOut === "number") out.max_output_tokens = maxOut;

  if (typeof body.reasoning_effort === "string") {
    out.reasoning = { effort: body.reasoning_effort };
  }

  const responseFormat = asRecord(body.response_format);
  if (responseFormat) {
    out.text = { format: responseFormat };
  }

  if (typeof body.metadata === "object" && body.metadata) {
    out.metadata = body.metadata;
  }
  if (typeof body.user === "string" && body.user) {
    out.user = body.user;
  }

  return out;
}
