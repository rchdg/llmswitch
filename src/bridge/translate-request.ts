/**
 * Translate OpenAI Responses API requests → Chat Completions / Completions.
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface ChatMessage {
  role: string;
  content?: string | null | Array<Record<string, unknown>>;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  tools?: Array<{
    type: "function";
    function: {
      name: string;
      description?: string;
      parameters?: unknown;
    };
  }>;
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  response_format?: unknown;
  reasoning_effort?: string;
  [key: string]: unknown;
}

export interface CompletionsRequest {
  model: string;
  prompt: string;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  [key: string]: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    const row = asRecord(part);
    if (!row) continue;
    if (typeof row.text === "string") parts.push(row.text);
    else if (typeof row.input_text === "string") parts.push(row.input_text);
    else if (typeof row.output_text === "string") parts.push(row.output_text);
    else if (row.type === "input_text" && typeof row.text === "string") {
      parts.push(row.text);
    } else if (row.type === "output_text" && typeof row.text === "string") {
      parts.push(row.text);
    } else if (row.type === "text" && typeof row.text === "string") {
      parts.push(row.text);
    }
  }
  return parts.join("");
}

function mapRole(role: unknown): string {
  if (role === "developer" || role === "system") return "system";
  if (role === "assistant") return "assistant";
  if (role === "tool") return "tool";
  return "user";
}

/**
 * Convert Responses `input` (+ instructions) into Chat `messages`.
 */
export function responsesInputToMessages(
  body: Record<string, unknown>,
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const instructions = body.instructions;
  if (typeof instructions === "string" && instructions.trim()) {
    messages.push({ role: "system", content: instructions });
  }

  const input = body.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }
  if (!Array.isArray(input)) return messages;

  // Pending assistant tool_calls aggregation
  let pendingToolCalls: NonNullable<ChatMessage["tool_calls"]> = [];

  const flushToolCalls = () => {
    if (pendingToolCalls.length === 0) return;
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: pendingToolCalls,
    });
    pendingToolCalls = [];
  };

  for (const raw of input) {
    if (typeof raw === "string") {
      flushToolCalls();
      messages.push({ role: "user", content: raw });
      continue;
    }
    const item = asRecord(raw);
    if (!item) continue;
    const type = String(item.type || "message");

    if (type === "message") {
      flushToolCalls();
      const role = mapRole(item.role);
      const text = extractText(item.content);
      messages.push({ role, content: text });
      continue;
    }

    if (type === "function_call" || type === "custom_tool_call") {
      const callId = String(item.call_id || item.id || `call_${messages.length}`);
      const name = String(item.name || "tool");
      const args =
        typeof item.arguments === "string"
          ? item.arguments
          : typeof item.input === "string"
            ? item.input
            : JSON.stringify(item.arguments ?? item.input ?? {});
      pendingToolCalls.push({
        id: callId,
        type: "function",
        function: { name, arguments: args },
      });
      continue;
    }

    if (type === "function_call_output" || type === "custom_tool_call_output") {
      flushToolCalls();
      const callId = String(item.call_id || "");
      const output =
        typeof item.output === "string"
          ? item.output
          : JSON.stringify(item.output ?? "");
      if (!callId) continue;
      messages.push({
        role: "tool",
        tool_call_id: callId,
        content: output,
      });
      continue;
    }

    if (type === "reasoning") {
      // Drop encrypted reasoning for chat upstreams
      continue;
    }

    // Fallback: treat unknown items with text as user content
    const text = extractText(item.content) || extractText(item);
    if (text) {
      flushToolCalls();
      messages.push({ role: "user", content: text });
    }
  }

  flushToolCalls();
  return messages;
}

export function mapResponsesTools(
  tools: unknown,
): ChatRequest["tools"] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const out: NonNullable<ChatRequest["tools"]> = [];
  for (const raw of tools) {
    const tool = asRecord(raw);
    if (!tool) continue;
    const type = String(tool.type || "function");

    if (type === "function") {
      // Already flat Responses style OR nested chat style
      const nested = asRecord(tool.function);
      if (nested) {
        out.push({
          type: "function",
          function: {
            name: String(nested.name || "tool"),
            description:
              typeof nested.description === "string"
                ? nested.description
                : undefined,
            parameters: nested.parameters,
          },
        });
      } else {
        out.push({
          type: "function",
          function: {
            name: String(tool.name || "tool"),
            description:
              typeof tool.description === "string" ? tool.description : undefined,
            parameters: tool.parameters,
          },
        });
      }
      continue;
    }

    // Map Codex local_shell / custom to a generic function for chat upstreams
    if (type === "local_shell") {
      out.push({
        type: "function",
        function: {
          name: "local_shell",
          description: "Run a local shell command",
          parameters: tool.parameters || {
            type: "object",
            properties: {
              command: { type: "array", items: { type: "string" } },
            },
          },
        },
      });
      continue;
    }

    if (type === "custom") {
      out.push({
        type: "function",
        function: {
          name: String(tool.name || "custom"),
          description:
            typeof tool.description === "string" ? tool.description : "Custom tool",
          parameters: tool.parameters || {
            type: "object",
            properties: { input: { type: "string" } },
          },
        },
      });
    }
  }
  return out.length ? out : undefined;
}

export function mapToolChoice(toolChoice: unknown): unknown {
  if (toolChoice == null || toolChoice === "auto" || toolChoice === "none" || toolChoice === "required") {
    return toolChoice;
  }
  const obj = asRecord(toolChoice);
  if (!obj) return toolChoice;
  if (obj.type === "function") {
    const nested = asRecord(obj.function);
    const name = String(nested?.name || obj.name || "");
    if (!name) return "auto";
    return { type: "function", function: { name } };
  }
  return toolChoice;
}

export function responsesToChatRequest(
  body: Record<string, unknown>,
): ChatRequest {
  const model = String(body.model || "");
  const messages = responsesInputToMessages(body);
  const stream = Boolean(body.stream);

  const req: ChatRequest = {
    model,
    messages,
    stream,
  };

  if (stream) {
    req.stream_options = { include_usage: true };
  }

  const tools = mapResponsesTools(body.tools);
  if (tools) req.tools = tools;

  if (body.tool_choice !== undefined) {
    req.tool_choice = mapToolChoice(body.tool_choice);
  }
  if (typeof body.parallel_tool_calls === "boolean") {
    req.parallel_tool_calls = body.parallel_tool_calls;
  }
  if (typeof body.temperature === "number") req.temperature = body.temperature;
  if (typeof body.top_p === "number") req.top_p = body.top_p;

  const maxOut = body.max_output_tokens ?? body.max_tokens;
  if (typeof maxOut === "number") {
    req.max_tokens = maxOut;
    req.max_completion_tokens = maxOut;
  }

  const reasoning = asRecord(body.reasoning);
  if (reasoning && typeof reasoning.effort === "string") {
    req.reasoning_effort = reasoning.effort;
  }

  const text = asRecord(body.text);
  const format = text ? asRecord(text.format) : null;
  if (format) {
    req.response_format = format;
  }

  return req;
}

/**
 * Degraded path: flatten chat messages into a single completions prompt.
 * Tool calls are stringified; many Codex agent flows will not work well.
 */
export function chatToCompletionsRequest(chat: ChatRequest): CompletionsRequest {
  const lines: string[] = [];
  for (const msg of chat.messages) {
    const role = msg.role.toUpperCase();
    let content = "";
    if (typeof msg.content === "string") content = msg.content;
    else if (msg.content == null && msg.tool_calls) {
      content = JSON.stringify(msg.tool_calls);
    } else if (Array.isArray(msg.content)) {
      content = extractText(msg.content);
    }
    if (msg.tool_call_id) {
      lines.push(`[TOOL ${msg.tool_call_id}]: ${content}`);
    } else {
      lines.push(`${role}: ${content}`);
    }
  }
  lines.push("ASSISTANT:");

  const req: CompletionsRequest = {
    model: chat.model,
    prompt: lines.join("\n\n"),
    stream: chat.stream,
  };
  if (typeof chat.temperature === "number") req.temperature = chat.temperature;
  if (typeof chat.top_p === "number") req.top_p = chat.top_p;
  if (typeof chat.max_tokens === "number") req.max_tokens = chat.max_tokens;
  return req;
}

export function responsesToCompletionsRequest(
  body: Record<string, unknown>,
): CompletionsRequest {
  return chatToCompletionsRequest(responsesToChatRequest(body));
}
