/**
 * Translate Anthropic Messages API requests → OpenAI Chat Completions.
 */

import type { ChatMessage, ChatRequest } from "./translate-request.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function extractTextBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    const row = asRecord(part);
    if (!row) continue;
    if (row.type === "text" && typeof row.text === "string") {
      parts.push(row.text);
    } else if (typeof row.text === "string") {
      parts.push(row.text);
    }
  }
  return parts.join("");
}

function systemToMessage(system: unknown): ChatMessage | null {
  if (typeof system === "string" && system.trim()) {
    return { role: "system", content: system };
  }
  if (Array.isArray(system)) {
    const text = extractTextBlocks(system);
    if (text.trim()) return { role: "system", content: text };
  }
  return null;
}

function mapAssistantContent(content: unknown): ChatMessage {
  if (typeof content === "string") {
    return { role: "assistant", content };
  }
  if (!Array.isArray(content)) {
    return { role: "assistant", content: "" };
  }

  const textParts: string[] = [];
  const toolCalls: NonNullable<ChatMessage["tool_calls"]> = [];

  for (const part of content) {
    const row = asRecord(part);
    if (!row) continue;
    if (row.type === "text" && typeof row.text === "string") {
      textParts.push(row.text);
      continue;
    }
    if (row.type === "tool_use") {
      const id = String(row.id || `tool_${toolCalls.length}`);
      const name = String(row.name || "tool");
      let args = "{}";
      try {
        args = JSON.stringify(row.input ?? {});
      } catch {
        args = "{}";
      }
      toolCalls.push({
        id,
        type: "function",
        function: { name, arguments: args },
      });
    }
  }

  const msg: ChatMessage = {
    role: "assistant",
    content: textParts.length ? textParts.join("") : toolCalls.length ? null : "",
  };
  if (toolCalls.length) msg.tool_calls = toolCalls;
  return msg;
}

function mapUserContent(content: unknown): ChatMessage[] {
  if (typeof content === "string") {
    return [{ role: "user", content }];
  }
  if (!Array.isArray(content)) {
    return [{ role: "user", content: "" }];
  }

  const textParts: string[] = [];
  const toolResults: ChatMessage[] = [];

  for (const part of content) {
    const row = asRecord(part);
    if (!row) continue;
    if (row.type === "text" && typeof row.text === "string") {
      textParts.push(row.text);
      continue;
    }
    if (row.type === "tool_result") {
      const toolCallId = String(row.tool_use_id || row.id || "");
      let resultContent = "";
      if (typeof row.content === "string") resultContent = row.content;
      else if (Array.isArray(row.content)) {
        resultContent = extractTextBlocks(row.content);
      } else if (row.content != null) {
        try {
          resultContent = JSON.stringify(row.content);
        } catch {
          resultContent = String(row.content);
        }
      }
      toolResults.push({
        role: "tool",
        tool_call_id: toolCallId,
        content: resultContent,
      });
    }
  }

  const out: ChatMessage[] = [];
  if (textParts.length) {
    out.push({ role: "user", content: textParts.join("") });
  }
  out.push(...toolResults);
  if (!out.length) out.push({ role: "user", content: "" });
  return out;
}

export function anthropicMessagesToChatMessages(
  body: Record<string, unknown>,
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const system = systemToMessage(body.system);
  if (system) messages.push(system);

  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  for (const item of rawMessages) {
    const row = asRecord(item);
    if (!row) continue;
    const role = row.role;
    if (role === "assistant") {
      messages.push(mapAssistantContent(row.content));
      continue;
    }
    if (role === "user") {
      messages.push(...mapUserContent(row.content));
      continue;
    }
  }
  return messages;
}

export function mapAnthropicTools(
  tools: unknown,
): ChatRequest["tools"] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const out: NonNullable<ChatRequest["tools"]> = [];
  for (const tool of tools) {
    const row = asRecord(tool);
    if (!row) continue;
    const name = String(row.name || "").trim();
    if (!name) continue;
    out.push({
      type: "function",
      function: {
        name,
        description:
          typeof row.description === "string" ? row.description : undefined,
        parameters: row.input_schema ?? row.parameters ?? { type: "object", properties: {} },
      },
    });
  }
  return out.length ? out : undefined;
}

export function mapAnthropicToolChoice(toolChoice: unknown): unknown {
  if (toolChoice == null) return undefined;
  if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required") {
    return toolChoice;
  }
  const obj = asRecord(toolChoice);
  if (!obj) return "auto";
  if (obj.type === "auto") return "auto";
  if (obj.type === "any") return "required";
  if (obj.type === "none") return "none";
  if (obj.type === "tool") {
    const name = String(obj.name || "");
    if (!name) return "auto";
    return { type: "function", function: { name } };
  }
  return "auto";
}

export function anthropicToChatRequest(
  body: Record<string, unknown>,
): ChatRequest {
  const stream = Boolean(body.stream);
  const req: ChatRequest = {
    model: String(body.model || ""),
    messages: anthropicMessagesToChatMessages(body),
    stream,
  };
  if (stream) {
    req.stream_options = { include_usage: true };
  }

  const tools = mapAnthropicTools(body.tools);
  if (tools) req.tools = tools;

  if (body.tool_choice !== undefined) {
    req.tool_choice = mapAnthropicToolChoice(body.tool_choice);
  }
  if (typeof body.temperature === "number") req.temperature = body.temperature;
  if (typeof body.top_p === "number") req.top_p = body.top_p;
  if (typeof body.max_tokens === "number") {
    req.max_tokens = body.max_tokens;
    req.max_completion_tokens = body.max_tokens;
  }
  if (typeof body.stop_sequences !== "undefined") {
    req.stop = body.stop_sequences as string | string[];
  }
  return req;
}
