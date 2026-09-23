/**
 * Translate OpenAI Chat Completions requests → Anthropic Messages API.
 *
 * Reverse direction of `anthropic-translate-request.ts`. Used by the gateway
 * when an OpenAI-format client is routed to an Anthropic upstream.
 */

import type { ChatMessage, ChatRequest } from "./translate-request.js";

/** Anthropic requires max_tokens; use this when the client omits it. */
export const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096;

type Block = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function parseDataUrl(url: string): { mediaType: string; data: string } | null {
  const match = url.match(/^data:([^;,]+);base64,([\s\S]*)$/);
  if (!match) return null;
  return { mediaType: match[1] ?? "image/png", data: match[2] ?? "" };
}

function imageBlock(url: string): Block | null {
  const inline = parseDataUrl(url);
  if (inline) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: inline.mediaType,
        data: inline.data,
      },
    };
  }
  if (/^https?:\/\//i.test(url)) {
    return { type: "image", source: { type: "url", url } };
  }
  return null;
}

/** Chat content (string or multimodal parts) → Anthropic content blocks. */
export function chatContentToAnthropicBlocks(
  content: ChatMessage["content"],
): Block[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const blocks: Block[] = [];
  for (const raw of content) {
    const part = asRecord(raw);
    if (!part) continue;
    const type = String(part.type || "");

    if (
      (type === "text" || type === "input_text" || type === "output_text") &&
      typeof part.text === "string"
    ) {
      blocks.push({ type: "text", text: part.text });
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
      const block = url ? imageBlock(url) : null;
      if (block) blocks.push(block);
      continue;
    }
    // Chat file 部分 → Anthropic document 块（data URL 形式）。
    if (type === "file") {
      const nested = asRecord(part.file);
      const fileData =
        typeof nested?.file_data === "string" ? nested.file_data : "";
      const inline = fileData ? parseDataUrl(fileData) : null;
      if (inline) {
        const block: Block = {
          type: "document",
          source: {
            type: "base64",
            media_type: inline.mediaType,
            data: inline.data,
          },
        };
        if (typeof nested?.filename === "string" && nested.filename) {
          block.title = nested.filename;
        }
        blocks.push(block);
      }
      // file_id 引用是供应商私有资源，Anthropic 上无等价物，跳过。
      continue;
    }
    // Already an Anthropic-shaped block (image/document/thinking): keep as-is.
    if (part.source || type === "thinking" || type === "redacted_thinking") {
      blocks.push(part as Block);
      continue;
    }
    if (typeof part.text === "string") {
      blocks.push({ type: "text", text: part.text });
    }
  }
  return blocks;
}

function stringifyToolArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Partial or non-JSON arguments: forward as a single field.
  }
  return { input: raw };
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

interface AnthropicMessage {
  role: "user" | "assistant";
  content: Block[];
}

function pushMessage(
  messages: AnthropicMessage[],
  role: "user" | "assistant",
  blocks: Block[],
): void {
  if (!blocks.length) return;
  const last = messages[messages.length - 1];
  // Anthropic expects alternating roles; merge consecutive same-role turns.
  if (last && last.role === role) {
    last.content.push(...blocks);
    return;
  }
  messages.push({ role, content: blocks });
}

export interface ChatToAnthropicMessages {
  system: string;
  messages: AnthropicMessage[];
}

export function chatMessagesToAnthropicMessages(
  chatMessages: readonly ChatMessage[],
): ChatToAnthropicMessages {
  const systemParts: string[] = [];
  const messages: AnthropicMessage[] = [];

  for (const message of chatMessages) {
    const role = String(message.role || "user");

    if (role === "system" || role === "developer") {
      const text = contentToText(message.content);
      if (text) systemParts.push(text);
      continue;
    }

    if (role === "tool" || role === "function") {
      const toolUseId = message.tool_call_id || message.name || "";
      if (!toolUseId) continue;
      pushMessage(messages, "user", [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: contentToText(message.content),
        },
      ]);
      continue;
    }

    if (role === "assistant") {
      const blocks = chatContentToAnthropicBlocks(message.content);
      for (const call of message.tool_calls ?? []) {
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.function?.name || "tool",
          input: stringifyToolArguments(call.function?.arguments),
        });
      }
      pushMessage(messages, "assistant", blocks);
      continue;
    }

    pushMessage(messages, "user", chatContentToAnthropicBlocks(message.content));
  }

  return { system: systemParts.join("\n\n"), messages };
}

export function chatToolsToAnthropicTools(
  tools: ChatRequest["tools"],
): Block[] | undefined {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  const out: Block[] = [];
  for (const tool of tools) {
    const fn = tool?.function;
    const name = String(fn?.name || "").trim();
    if (!name) continue;
    const entry: Block = {
      name,
      input_schema: fn?.parameters ?? { type: "object", properties: {} },
    };
    if (typeof fn?.description === "string") entry.description = fn.description;
    out.push(entry);
  }
  return out.length ? out : undefined;
}

export function chatToolChoiceToAnthropic(toolChoice: unknown): unknown {
  if (toolChoice == null) return undefined;
  if (toolChoice === "auto") return { type: "auto" };
  if (toolChoice === "required") return { type: "any" };
  if (toolChoice === "none") return { type: "none" };
  const obj = asRecord(toolChoice);
  if (!obj) return undefined;
  if (obj.type === "function") {
    const nested = asRecord(obj.function);
    const name = String(nested?.name || obj.name || "");
    return name ? { type: "tool", name } : { type: "auto" };
  }
  // Already Anthropic-shaped.
  if (obj.type === "auto" || obj.type === "any" || obj.type === "tool") {
    return obj;
  }
  return undefined;
}

function normalizeStop(stop: unknown): string[] | undefined {
  if (typeof stop === "string") return stop ? [stop] : undefined;
  if (Array.isArray(stop)) {
    const list = stop.filter((v): v is string => typeof v === "string");
    return list.length ? list : undefined;
  }
  return undefined;
}

/**
 * Chat Completions request → Anthropic Messages request body.
 * `max_tokens` is mandatory upstream, so a default is applied when missing.
 */
export function chatToAnthropicRequest(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const chatMessages = Array.isArray(body.messages)
    ? (body.messages as ChatMessage[])
    : [];
  const { system, messages } = chatMessagesToAnthropicMessages(chatMessages);
  const stream = Boolean(body.stream);

  const maxTokens =
    typeof body.max_tokens === "number"
      ? body.max_tokens
      : typeof body.max_completion_tokens === "number"
        ? body.max_completion_tokens
        : DEFAULT_ANTHROPIC_MAX_TOKENS;

  const out: Record<string, unknown> = {
    model: String(body.model || ""),
    max_tokens: maxTokens,
    messages,
    stream,
  };
  if (system) out.system = system;

  const tools = chatToolsToAnthropicTools(
    body.tools as ChatRequest["tools"] | undefined,
  );
  if (tools) out.tools = tools;

  if (body.tool_choice !== undefined) {
    const choice = chatToolChoiceToAnthropic(body.tool_choice);
    if (choice !== undefined) out.tool_choice = choice;
  }
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;

  const stopSequences = normalizeStop(body.stop);
  if (stopSequences) out.stop_sequences = stopSequences;

  if (typeof body.metadata === "object" && body.metadata) {
    out.metadata = body.metadata;
  }

  // Map OpenAI reasoning_effort onto Anthropic extended thinking budget.
  const effort = body.reasoning_effort;
  if (typeof effort === "string") {
    const budget =
      effort === "low"
        ? 1024
        : effort === "medium"
          ? 4096
          : effort === "high"
            ? 8192
            : 0;
    if (budget > 0) {
      out.thinking = { type: "enabled", budget_tokens: budget };
      // Thinking requires headroom above the budget.
      if (maxTokens <= budget) out.max_tokens = budget + 1024;
    }
  }

  return out;
}
