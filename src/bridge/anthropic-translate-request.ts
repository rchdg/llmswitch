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

function toDataUrl(mediaType: string, base64: string): string {
  return `data:${mediaType};base64,${base64}`;
}

/**
 * Anthropic image/document 块 → Chat 多模态部分。
 * base64 图文转 data URL；图片 URL 原样透传；纯文本文档包成 data URL。
 * 返回 null 表示该块在 Chat 里没有等价形式（如 URL 引用的文档）。
 */
export function attachmentChatPart(
  row: Record<string, unknown>,
): Record<string, unknown> | null {
  const type = String(row.type || "");
  if (type !== "image" && type !== "document") return null;
  const source = asRecord(row.source);
  if (!source) return null;
  const sourceType = String(source.type || "");
  const title =
    typeof row.title === "string" && row.title ? row.title : undefined;

  if (sourceType === "base64") {
    const mediaType =
      typeof source.media_type === "string" && source.media_type
        ? source.media_type
        : type === "image"
          ? "image/png"
          : "application/pdf";
    const data = typeof source.data === "string" ? source.data : "";
    if (!data) return null;
    const url = toDataUrl(mediaType, data);
    if (type === "image") {
      return { type: "image_url", image_url: { url } };
    }
    const file: Record<string, unknown> = { file_data: url };
    if (title) file.filename = title;
    return { type: "file", file };
  }

  if (sourceType === "url" && type === "image") {
    const url = typeof source.url === "string" ? source.url : "";
    if (!url || !/^https?:\/\//i.test(url)) return null;
    return { type: "image_url", image_url: { url } };
  }

  if (sourceType === "text" && type === "document") {
    const text = typeof source.data === "string" ? source.data : "";
    if (!text) return null;
    const file: Record<string, unknown> = {
      file_data: toDataUrl(
        "text/plain",
        Buffer.from(text, "utf8").toString("base64"),
      ),
    };
    if (title) file.filename = title;
    return { type: "file", file };
  }

  return null;
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

  // parts 按原顺序保留 text 与附件；无附件时回退为纯字符串 content。
  const parts: Array<Record<string, unknown>> = [];
  const textParts: string[] = [];
  const toolResults: ChatMessage[] = [];
  // tool_result 里的图片（如 Read 工具读截图）：Chat 的 tool 消息只接受
  // 字符串内容，附件挪到紧随其后的 user 消息里。
  const toolAttachments: Array<Record<string, unknown>> = [];

  for (const part of content) {
    const row = asRecord(part);
    if (!row) continue;
    if (row.type === "text" && typeof row.text === "string") {
      textParts.push(row.text);
      parts.push({ type: "text", text: row.text });
      continue;
    }
    if (row.type === "tool_result") {
      const toolCallId = String(row.tool_use_id || row.id || "");
      let resultContent = "";
      if (typeof row.content === "string") resultContent = row.content;
      else if (Array.isArray(row.content)) {
        resultContent = extractTextBlocks(row.content);
        for (const block of row.content) {
          const b = asRecord(block);
          if (!b) continue;
          const attachment = attachmentChatPart(b);
          if (attachment) toolAttachments.push(attachment);
        }
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
      continue;
    }
    const attachment = attachmentChatPart(row);
    if (attachment) parts.push(attachment);
  }

  const hasAttachment = parts.some((p) => p.type !== "text");
  const out: ChatMessage[] = [];
  if (parts.length) {
    out.push({
      role: "user",
      content: hasAttachment ? parts : textParts.join(""),
    });
  }
  out.push(...toolResults);
  if (toolAttachments.length) {
    out.push({ role: "user", content: toolAttachments });
  }
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
