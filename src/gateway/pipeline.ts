/**
 * Format conversion pipeline.
 *
 * Every request is normalised into the hub format (OpenAI Chat Completions),
 * then rendered into the upstream's format; responses travel back the same way.
 * When the inbound and upstream formats match, callers should use raw
 * passthrough instead to avoid a lossy round-trip.
 */

import { anthropicToChatRequest } from "./../bridge/anthropic-translate-request.js";
import {
  chatChunkToAnthropicEvents,
  chatCompletionToAnthropicMessage,
  createAnthropicStreamState,
  forceCompleteAnthropicStream,
} from "./../bridge/anthropic-translate-response.js";
import { chatToAnthropicRequest } from "./../bridge/chat-to-anthropic-request.js";
import {
  anthropicEventToChatChunks,
  anthropicMessageToChatCompletion,
  createAnthropicToChatStreamState,
  forceCompleteAnthropicToChatStream,
  parseAnthropicSseLine,
} from "./../bridge/anthropic-to-chat-response.js";
import { chatToResponsesRequest } from "./../bridge/chat-to-responses-request.js";
import {
  collectCustomToolNames,
  responsesToChatRequest,
  type ChatRequest,
} from "./../bridge/translate-request.js";
import {
  chatChunkToResponsesEvents,
  chatCompletionToResponse,
  createStreamState,
  forceCompleteStream,
  parseChatSseLine,
} from "./../bridge/translate-response.js";
import {
  createResponsesToChatStreamState,
  forceCompleteResponsesToChatStream,
  parseResponsesSseLine,
  responseToChatCompletion,
  responsesEventToChatChunks,
} from "./../bridge/responses-to-chat-response.js";
import type { GatewayFormat } from "./types.js";

export interface InboundRequest {
  format: GatewayFormat;
  body: Record<string, unknown>;
  /** Model id as sent by the client, echoed back in responses. */
  requestedModel: string;
  stream: boolean;
  /** Responses-only: `type: "custom"` tool names that must round-trip. */
  customTools: Set<string>;
  /** Legacy `/v1/completions`: responses are rendered as text completions. */
  legacyCompletion?: boolean;
}

export function parseInboundRequest(
  format: GatewayFormat,
  body: Record<string, unknown>,
): InboundRequest {
  return {
    format,
    body,
    requestedModel: String(body.model || ""),
    stream: Boolean(body.stream),
    customTools:
      format === "openai-responses"
        ? collectCustomToolNames(body.tools)
        : new Set<string>(),
  };
}

/** Inbound body → hub Chat Completions request. */
export function inboundToChatRequest(
  inbound: InboundRequest,
): Record<string, unknown> {
  switch (inbound.format) {
    case "openai-chat":
      return { ...inbound.body };
    case "anthropic":
      return anthropicToChatRequest(inbound.body) as unknown as Record<
        string,
        unknown
      >;
    case "openai-responses":
      return responsesToChatRequest(inbound.body) as unknown as Record<
        string,
        unknown
      >;
  }
}

/** Upstream request path (relative to the provider base URL). */
export function upstreamPath(format: GatewayFormat): string {
  switch (format) {
    case "openai-chat":
      return "/chat/completions";
    case "anthropic":
      return "/messages";
    case "openai-responses":
      return "/responses";
  }
}

/** Hub Chat Completions request → upstream body for the target format. */
export function chatRequestToUpstream(
  format: GatewayFormat,
  chat: Record<string, unknown>,
): Record<string, unknown> {
  switch (format) {
    case "openai-chat":
      return chat;
    case "anthropic":
      return chatToAnthropicRequest(chat);
    case "openai-responses":
      return chatToResponsesRequest(chat);
  }
}

/** Upstream non-streaming payload → hub Chat Completions object. */
export function upstreamToChatCompletion(
  format: GatewayFormat,
  payload: Record<string, unknown>,
  fallbackModel: string,
): Record<string, unknown> {
  switch (format) {
    case "openai-chat":
      return payload;
    case "anthropic":
      return anthropicMessageToChatCompletion(payload, fallbackModel);
    case "openai-responses":
      return responseToChatCompletion(payload, fallbackModel);
  }
}

/** Hub Chat Completions object → inbound response payload. */
export function chatCompletionToInbound(
  inbound: InboundRequest,
  chat: Record<string, unknown>,
): Record<string, unknown> {
  switch (inbound.format) {
    case "openai-chat":
      return chat;
    case "anthropic":
      return chatCompletionToAnthropicMessage(chat, inbound.requestedModel);
    case "openai-responses":
      return chatCompletionToResponse(
        chat,
        inbound.requestedModel,
        inbound.customTools,
        false,
      );
  }
}

/**
 * Overwrite the model field with the client-requested id so aliases and
 * provider-qualified ids round-trip transparently.
 */
export function withRequestedModel(
  payload: Record<string, unknown>,
  requestedModel: string,
): Record<string, unknown> {
  if (!requestedModel) return payload;
  if (typeof payload.model === "string") {
    return { ...payload, model: requestedModel };
  }
  return payload;
}

// --- legacy text completions --------------------------------------------------

/** Normalize `prompt` (string | string[]) into a single user message body. */
export function legacyPromptToChatBody(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const prompt = body.prompt;
  const text = Array.isArray(prompt)
    ? prompt.map((item) => String(item)).join("\n")
    : prompt === undefined || prompt === null
      ? ""
      : String(prompt);
  const { prompt: _ignored, ...rest } = body;
  return {
    ...rest,
    messages: [{ role: "user", content: text }],
  };
}

function legacyText(chat: Record<string, unknown>): string {
  const choices = chat.choices;
  if (!Array.isArray(choices) || !choices.length) return "";
  const message = (choices[0] as Record<string, unknown> | undefined)?.message;
  const content = (message as Record<string, unknown> | undefined)?.content;
  return typeof content === "string" ? content : "";
}

function legacyFinishReason(chat: Record<string, unknown>): string | null {
  const choices = chat.choices;
  if (!Array.isArray(choices) || !choices.length) return null;
  const reason = (choices[0] as Record<string, unknown> | undefined)
    ?.finish_reason;
  return typeof reason === "string" ? reason : null;
}

/** Hub chat completion → legacy `text_completion` payload. */
export function chatCompletionToLegacyCompletion(
  chat: Record<string, unknown>,
  requestedModel: string,
): Record<string, unknown> {
  return withRequestedModel(
    {
      id: typeof chat.id === "string" ? chat.id : "cmpl-gateway",
      object: "text_completion",
      created:
        typeof chat.created === "number" ? chat.created : Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices: [
        {
          index: 0,
          text: legacyText(chat),
          logprobs: null,
          finish_reason: legacyFinishReason(chat),
        },
      ],
      ...(chat.usage ? { usage: chat.usage } : {}),
    },
    requestedModel,
  );
}

/** Hub chat chunk → legacy `text_completion.chunk` payload. */
export function chatChunkToLegacyChunk(
  chunk: Record<string, unknown>,
  requestedModel: string,
): Record<string, unknown> {
  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
  const first = (choices[0] as Record<string, unknown> | undefined) ?? {};
  const delta = (first.delta as Record<string, unknown> | undefined) ?? {};
  const text = typeof delta.content === "string" ? delta.content : "";
  return withRequestedModel(
    {
      id: typeof chunk.id === "string" ? chunk.id : "cmpl-gateway",
      object: "text_completion.chunk",
      created:
        typeof chunk.created === "number"
          ? chunk.created
          : Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices: [
        {
          index: 0,
          text,
          logprobs: null,
          finish_reason:
            typeof first.finish_reason === "string"
              ? first.finish_reason
              : null,
        },
      ],
    },
    requestedModel,
  );
}

// --- streaming --------------------------------------------------------------

/** Decodes upstream SSE lines into hub Chat Completions chunks. */
export interface UpstreamStreamDecoder {
  push(line: string): Array<Record<string, unknown>>;
  finish(): Array<Record<string, unknown>>;
}

export function createUpstreamDecoder(
  format: GatewayFormat,
  fallbackModel: string,
): UpstreamStreamDecoder {
  if (format === "openai-chat") {
    return {
      push(line) {
        const parsed = parseChatSseLine(line);
        if (!parsed || parsed === "done") return [];
        return [parsed];
      },
      finish() {
        return [];
      },
    };
  }

  if (format === "anthropic") {
    const state = createAnthropicToChatStreamState(fallbackModel);
    return {
      push(line) {
        const parsed = parseAnthropicSseLine(line);
        if (!parsed) return [];
        if (parsed === "done") return forceCompleteAnthropicToChatStream(state);
        return anthropicEventToChatChunks(parsed, state);
      },
      finish() {
        return forceCompleteAnthropicToChatStream(state);
      },
    };
  }

  const state = createResponsesToChatStreamState(fallbackModel);
  return {
    push(line) {
      const parsed = parseResponsesSseLine(line);
      if (!parsed) return [];
      if (parsed === "done") return forceCompleteResponsesToChatStream(state);
      return responsesEventToChatChunks(parsed, state);
    },
    finish() {
      return forceCompleteResponsesToChatStream(state);
    },
  };
}

/** Encodes hub Chat Completions chunks into inbound SSE frames. */
export interface InboundStreamEncoder {
  encode(chunk: Record<string, unknown>): string[];
  finish(): string[];
}

export function createInboundEncoder(
  inbound: InboundRequest,
): InboundStreamEncoder {
  if (inbound.format === "openai-chat" && inbound.legacyCompletion) {
    return {
      encode(chunk) {
        return [
          `data: ${JSON.stringify(chatChunkToLegacyChunk(chunk, inbound.requestedModel))}\n\n`,
        ];
      },
      finish() {
        return ["data: [DONE]\n\n"];
      },
    };
  }

  if (inbound.format === "openai-chat") {
    return {
      encode(chunk) {
        return [`data: ${JSON.stringify(chunk)}\n\n`];
      },
      finish() {
        return ["data: [DONE]\n\n"];
      },
    };
  }

  if (inbound.format === "anthropic") {
    const state = createAnthropicStreamState(inbound.requestedModel);
    return {
      encode(chunk) {
        return chatChunkToAnthropicEvents(chunk, state);
      },
      finish() {
        return forceCompleteAnthropicStream(state);
      },
    };
  }

  const state = createStreamState(
    inbound.requestedModel,
    undefined,
    inbound.customTools,
    false,
  );
  return {
    encode(chunk) {
      return chatChunkToResponsesEvents(chunk, state);
    },
    finish() {
      return forceCompleteStream(state);
    },
  };
}

// --- errors -----------------------------------------------------------------

export interface GatewayErrorBody {
  status: number;
  payload: Record<string, unknown>;
}

/** Render an error in the inbound protocol's own error shape. */
export function formatErrorBody(
  format: GatewayFormat,
  status: number,
  message: string,
  code = "gateway_error",
): GatewayErrorBody {
  if (format === "anthropic") {
    return {
      status,
      payload: {
        type: "error",
        error: { type: anthropicErrorType(status, code), message },
      },
    };
  }
  return {
    status,
    payload: {
      error: {
        message,
        type: openAiErrorType(status),
        code,
        param: null,
      },
    },
  };
}

function openAiErrorType(status: number): string {
  if (status === 401 || status === 403) return "authentication_error";
  if (status === 404) return "invalid_request_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "api_error";
  return "invalid_request_error";
}

function anthropicErrorType(status: number, code: string): string {
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 413) return "request_too_large";
  if (status === 429) return "rate_limit_error";
  if (status === 529) return "overloaded_error";
  if (status >= 500) return "api_error";
  return code === "invalid_json" ? "invalid_request_error" : "invalid_request_error";
}

/** Wrap an upstream error payload so the client sees its own protocol shape. */
export function translateUpstreamError(
  inboundFormat: GatewayFormat,
  status: number,
  rawBody: string,
): GatewayErrorBody {
  let message = rawBody.slice(0, 1000);
  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    const error = parsed.error;
    if (error && typeof error === "object") {
      const row = error as Record<string, unknown>;
      if (typeof row.message === "string") message = row.message;
    } else if (typeof parsed.message === "string") {
      message = parsed.message;
    }
  } catch {
    // Non-JSON upstream error; keep the truncated raw text.
  }
  return formatErrorBody(inboundFormat, status, message, "upstream_error");
}

export type { ChatRequest };
