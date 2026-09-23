import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { ConcurrencyGate, parseBridgeRuntimeLimits } from "./runtime.js";
import {
  requestWithNodeTransport,
  type NodeTransportResponse,
} from "./transport.js";
import {
  constantTimeTokenEqual,
  readBridgeState,
  readBridgeUpstreams,
} from "./state.js";
import type { BridgeUpstream, BridgeUpstreams } from "./types.js";
import { anthropicToChatRequest } from "./anthropic-translate-request.js";
import {
  chatChunkToAnthropicEvents,
  chatCompletionToAnthropicMessage,
  createAnthropicStreamState,
  forceCompleteAnthropicStream,
  parseChatSseLine,
} from "./anthropic-translate-response.js";
import {
  collectCustomToolNames,
  responsesToChatRequest,
  responsesToCompletionsRequest,
} from "./translate-request.js";
import {
  chatChunkToResponsesEvents,
  chatCompletionToResponse,
  createStreamState,
  forceCompleteStream,
  parseChatSseLine as parseChatSseLineResponses,
} from "./translate-response.js";
import { modelItemId, modelsFromPayload } from "../utils/fetch-models.js";
import { openCodeSessionHeaders } from "../utils/session.js";
import {
  attachBridgeLog,
  markBridgeError,
  markBridgeModel,
  markBridgeUpstream,
  recentBridgeLogs,
} from "./logs.js";
import {
  estimateChatInputTokens,
  type RequestShapingMeta,
} from "./translate-request.js";

export interface BridgeServerOptions {
  controlToken?: string;
  instanceId?: string;
  onShutdown?: (instanceId: string) => void | Promise<void>;
}

/** Statuses where a different provider plausibly succeeds right now. */
const FAILOVER_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

/** Write a ping comment when nothing arrives for this long (deep reasoning). */
const SSE_KEEPALIVE_MS = 15_000;

/**
 * Periodic SSE comment frames (`: ping`) so idle periods — a slow upstream,
 * minutes-long reasoning before the first token — don't trip intermediate
 * proxies or the client's own timeouts. Comment lines are ignored by every
 * SSE parser.
 */
class SseKeepalive {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly res: ServerResponse) {}

  start(): this {
    if (this.timer) return this;
    this.timer = setInterval(() => {
      if (!this.res.writableEnded) this.res.write(": ping\n\n");
    }, SSE_KEEPALIVE_MS);
    this.timer.unref();
    return this;
  }

  /** Reset the countdown after any upstream activity. */
  touch(): void {
    if (!this.timer) return;
    this.timer.refresh();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

function writeSseFrame(res: ServerResponse, frame: string): void {
  if (!res.writableEnded) res.write(frame);
}

/**
 * Send SSE headers immediately and start the keepalive timer — before the
 * upstream request goes out. Without flushHeaders() Node buffers the headers
 * until the first body write, which is exactly the multi-minute reasoning
 * window this exists to bridge.
 */
function startSse(res: ServerResponse): SseKeepalive {
  res.writeHead(200, SSE_HEADERS);
  res.flushHeaders();
  return new SseKeepalive(res).start();
}

/** Responses-protocol failure for an already-streaming client. */
function emitResponsesFailure(
  res: ServerResponse,
  message: string,
  code = "upstream_error",
): void {
  writeSseFrame(
    res,
    `event: response.failed\ndata: ${JSON.stringify({
      type: "response.failed",
      response: {
        id: `resp_${Date.now().toString(36)}`,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status: "failed",
        model: "",
        output: [],
        error: { code, message },
        incomplete_details: null,
        usage: null,
      },
    })}\n\n`,
  );
}

// --- failover ---------------------------------------------------------------

function upstreamCandidates(upstream: BridgeUpstream): BridgeUpstream[] {
  const candidates = [upstream];
  for (const fallback of upstream.fallbacks ?? []) {
    if (fallback?.baseUrl) candidates.push(fallback);
  }
  return candidates;
}

function candidateLabel(candidate: BridgeUpstream): string {
  return candidate.profileName || candidate.baseUrl;
}

/**
 * Each candidate serves its own default model: the client (Codex) sends the
 * primary's model id, so a fallback rewrite is what makes the request land
 * on the fallback's actual model.
 */
function withCandidateModel(
  body: Record<string, unknown>,
  candidate: BridgeUpstream,
): Record<string, unknown> {
  if (!candidate.model || candidate.model === body.model) return body;
  return { ...body, model: candidate.model };
}

function shapingFor(candidate: BridgeUpstream): RequestShapingMeta {
  return { supportsReasoning: candidate.modelSupportsReasoning };
}

/** Visible hint in the SSE stream (comment frames are ignored by parsers). */
function announceFailover(
  res: ServerResponse,
  keepalive: SseKeepalive | undefined,
  from: BridgeUpstream,
  to: BridgeUpstream,
): void {
  const note = `failover: ${candidateLabel(from)} → ${candidateLabel(to)}`;
  console.log(`[llm-switch bridge] ${note}`);
  if (keepalive) writeSseFrame(res, `: llm-switch ${note}\n\n`);
}

function upstreamErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function headerValue(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function controlToken(req: IncomingMessage): string | undefined {
  return headerValue(req.headers["x-llm-switch-control"]);
}

class RequestBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Request body exceeded ${maxBytes} bytes`);
    this.name = "RequestBodyTooLargeError";
  }
}

function bearerToken(req: IncomingMessage): string | undefined {
  const authorization = headerValue(req.headers.authorization);
  const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1];
}

function authenticateDataRequest(
  req: IncomingMessage,
  upstream: BridgeUpstream | null,
  tool: "codex" | "claude" | "opencode",
): boolean {
  if (!upstream?.clientToken || upstream.migrationRequired) return false;
  const bearer = bearerToken(req);
  if (tool === "codex" || tool === "opencode") {
    return constantTimeTokenEqual(upstream.clientToken, bearer);
  }
  const apiKey = headerValue(req.headers["x-api-key"]);
  if (bearer && apiKey && !constantTimeTokenEqual(bearer, apiKey)) {
    return false;
  }
  return constantTimeTokenEqual(upstream.clientToken, bearer || apiKey);
}

function authenticateModelsRequest(
  req: IncomingMessage,
  upstreams: BridgeUpstreams,
): boolean {
  return (
    authenticateDataRequest(req, upstreams.codex, "codex") ||
    authenticateDataRequest(req, upstreams.claude, "claude") ||
    authenticateDataRequest(req, upstreams.opencode, "opencode")
  );
}

function readBody(
  req: IncomingMessage,
  maxBytes = parseBridgeRuntimeLimits().maxBodyBytes,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const onData = (value: Buffer | string) => {
      if (settled) return;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += chunk.length;
      if (bytes > maxBytes) {
        settled = true;
        cleanup();
        req.resume();
        reject(new RequestBodyTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(raw),
  });
  res.end(raw);
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  if (/\/v1$/i.test(base) && p.startsWith("/v1/")) {
    return `${base}${p.slice(3)}`;
  }
  if (!/\/v1$/i.test(base) && !p.startsWith("/v1/")) {
    return `${base}/v1${p.startsWith("/") ? p : `/${p}`}`;
  }
  return `${base}${p}`;
}

function upstreamHeaders(upstream: BridgeUpstream): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  let hasAuthorization = false;
  if (upstream.headers) {
    for (const [name, value] of Object.entries(upstream.headers)) {
      if (/^(connection|keep-alive|proxy-authenticate|proxy-authorization|te|trailer|transfer-encoding|upgrade)$/i.test(name)) {
        continue;
      }
      headers[name] = value;
      if (name.toLowerCase() === "authorization") hasAuthorization = true;
    }
  }
  if (upstream.apiKey && !hasAuthorization) {
    headers.Authorization = `Bearer ${upstream.apiKey}`;
  }
  return headers;
}

function requestUpstream(
  upstream: BridgeUpstream,
  url: string,
  method: "GET" | "POST",
  body?: string,
  signal?: AbortSignal,
  sessionHeaders: Record<string, string> = {},
): Promise<NodeTransportResponse> {
  const limits = parseBridgeRuntimeLimits();
  return requestWithNodeTransport({
    url,
    method,
    headers: mergeUpstreamHeaders(upstream, sessionHeaders),
    body,
    proxy: upstream.proxy,
    signal,
    connectTimeoutMs: limits.connectTimeoutMs,
    idleTimeoutMs: limits.idleTimeoutMs,
    totalTimeoutMs: limits.totalTimeoutMs,
    maxResponseBytes: limits.maxResponseBytes,
  });
}

/** 显式配置的上游请求头优先于本地推导出的会话头（按名称不区分大小写）。 */
function mergeUpstreamHeaders(
  upstream: BridgeUpstream,
  sessionHeaders: Record<string, string>,
): Record<string, string> {
  const headers = upstreamHeaders(upstream);
  const configured = new Set(
    Object.keys(headers).map((name) => name.toLowerCase()),
  );
  for (const [name, value] of Object.entries(sessionHeaders)) {
    if (configured.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  return headers;
}

/**
 * 上游要求时（OpenCode Go）补上会话头：优先沿用客户端自己的会话标识，否则从
 * 请求体的稳定前缀推导，保证同一会话的多轮请求复用同一个上游会话。
 *
 * 导出供测试直接验证推导结果；实际发送由 requestUpstream 完成。
 */
export function sessionHeadersFor(
  req: IncomingMessage | undefined,
  upstream: BridgeUpstream,
  bodyText?: string,
): Record<string, string> {
  return openCodeSessionHeaders({
    baseUrl: upstream.baseUrl,
    headers: req?.headers,
    bodyText,
    fallbackSeed: upstream.profileName || upstream.baseUrl,
  });
}

async function fetchModelsJson(
  upstream: BridgeUpstream,
  signal?: AbortSignal,
  req?: IncomingMessage,
): Promise<{ ok: boolean; status: number; data: unknown[] }> {
  const url = joinUrl(upstream.baseUrl, "/models");
  const response = await requestUpstream(
    upstream,
    url,
    "GET",
    undefined,
    signal,
    sessionHeadersFor(req, upstream),
  );
  if (!response.ok) {
    return { ok: false, status: response.status, data: [] };
  }
  try {
    const json = (await response.json()) as Record<string, unknown>;
    return { ok: true, status: 200, data: modelsFromPayload(json) };
  } catch {
    return { ok: false, status: 502, data: [] };
  }
}

async function proxyModelsMerged(
  req: IncomingMessage,
  res: ServerResponse,
  upstreams: BridgeUpstreams,
  signal?: AbortSignal,
): Promise<void> {
  const sides = [upstreams.codex, upstreams.claude, upstreams.opencode].filter(
    (u): u is BridgeUpstream => Boolean(u?.baseUrl),
  );
  if (!sides.length) {
    sendJson(res, 503, {
      error: { message: "Bridge 未配置上游" },
    });
    return;
  }

  const results = await Promise.all(
    sides.map((u) => fetchModelsJson(u, signal, req).catch(() => ({
      ok: false as const,
      status: 502,
      data: [] as unknown[],
    }))),
  );
  const seen = new Set<string>();
  const merged: unknown[] = [];
  for (const result of results) {
    if (!result.ok) continue;
    for (const item of result.data) {
      const id = modelItemId(item);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const row =
        item && typeof item === "object"
          ? (item as Record<string, unknown>)
          : {};
      merged.push(row.id ? item : { ...row, id });
    }
  }
  if (!merged.length && results.every((r) => !r.ok)) {
    sendJson(res, 502, {
      error: { message: "无法从任一上游拉取模型列表" },
    });
    return;
  }
  sendJson(res, 200, { object: "list", data: merged });
}

async function handleResponses(
  req: IncomingMessage,
  res: ServerResponse,
  upstream: BridgeUpstream,
  bodyBuf: Buffer,
  signal?: AbortSignal,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyBuf.toString("utf8")) as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { error: { message: "Invalid JSON body" } });
    return;
  }

  markBridgeModel(res, String(body.model || ""));
  await forwardResponses(req, res, upstream, body, Boolean(body.stream), signal);
}

async function handleMessages(
  req: IncomingMessage,
  res: ServerResponse,
  upstream: BridgeUpstream,
  bodyBuf: Buffer,
  signal?: AbortSignal,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyBuf.toString("utf8")) as Record<string, unknown>;
  } catch {
    sendJson(res, 400, {
      type: "error",
      error: { type: "invalid_request_error", message: "Invalid JSON body" },
    });
    return;
  }

  const wantStream = Boolean(body.stream);
  const candidates = upstreamCandidates(upstream);
  const keepalive = wantStream ? startSse(res) : undefined;
  const failures: string[] = [];

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const isLast = index === candidates.length - 1;
    const effectiveBody = withCandidateModel(body, candidate);
    const chatReq = anthropicToChatRequest(effectiveBody);
    const chatBody = JSON.stringify(chatReq);
    const url = joinUrl(candidate.baseUrl, "/chat/completions");
    markBridgeModel(res, String(effectiveBody.model || ""));

    let response: NodeTransportResponse;
    try {
      response = await requestUpstream(
        candidate,
        url,
        "POST",
        chatBody,
        signal,
        sessionHeadersFor(req, candidate, chatBody),
      );
    } catch (err) {
      const message = `Upstream chat 请求失败: ${upstreamErrorMessage(err)}`;
      markBridgeError(res, message);
      if (isLast) {
        finishAnthropicError(res, keepalive, failures, candidateLabel(candidate), message, failures.length > 0);
        return;
      }
      failures.push(`${candidateLabel(candidate)}: ${message}`);
      announceFailover(res, keepalive, candidate, candidates[index + 1]!);
      continue;
    }

    if (!response.ok) {
      const text = await response.text();
      const summary = `HTTP ${response.status}: ${text.slice(0, 300)}`;
      markBridgeError(res, summary);
      if (FAILOVER_STATUSES.has(response.status) && !isLast) {
        failures.push(`${candidateLabel(candidate)}: ${summary}`);
        announceFailover(res, keepalive, candidate, candidates[index + 1]!);
        continue;
      }
      keepalive?.stop();
      if (keepalive) {
        writeSseFrame(
          res,
          `event: error\ndata: ${JSON.stringify({
            type: "error",
            error: { type: "api_error", message: summary },
          })}\n\n`,
        );
        res.end();
        return;
      }
      try {
        const json = JSON.parse(text) as unknown;
        sendJson(res, response.status, json);
      } catch {
        sendJson(res, response.status, {
          type: "error",
          error: { type: "api_error", message: text.slice(0, 500) },
        });
      }
      return;
    }

    markBridgeUpstream(res, candidateLabel(candidate));
    if (!wantStream) {
      const json = (await response.json()) as Record<string, unknown>;
      sendJson(
        res,
        200,
        chatCompletionToAnthropicMessage(json, String(effectiveBody.model || "")),
      );
      return;
    }
    await pipeChatStreamToAnthropic(response, res, String(effectiveBody.model || ""), keepalive);
    return;
  }

  finishAnthropicError(
    res,
    keepalive,
    failures,
    candidateLabel(upstream),
    "所有上游均失败",
    true,
  );
}

/** Terminal Anthropic-protocol failure (Claude side). */
function finishAnthropicError(
  res: ServerResponse,
  keepalive: SseKeepalive | undefined,
  failures: string[],
  label: string,
  message: string,
  aggregated = false,
): void {
  keepalive?.stop();
  const text = aggregated
    ? `${message} → ${failures.join("；") || label}`
    : `${label}: ${message}`;
  if (keepalive) {
    writeSseFrame(
      res,
      `event: error\ndata: ${JSON.stringify({
        type: "error",
        error: { type: "api_error", message: text },
      })}\n\n`,
    );
    res.end();
    return;
  }
  sendJson(res, 502, {
    type: "error",
    error: { type: "api_error", message: text },
  });
}

type ResponsesProtocol = "chat" | "completions";

interface ResponsesAttempt {
  url: string;
  payload: string;
  inputEstimate?: number;
}

/** 候选的协议跟随自身配置（profile.bridgeMode），而不是主上游。 */
function candidateProtocol(candidate: BridgeUpstream): ResponsesProtocol {
  return candidate.mode === "completions" ? "completions" : "chat";
}

function buildResponsesAttempt(
  body: Record<string, unknown>,
  candidate: BridgeUpstream,
  protocol: ResponsesProtocol,
): ResponsesAttempt {
  if (protocol === "completions") {
    return {
      url: joinUrl(candidate.baseUrl, "/completions"),
      payload: JSON.stringify(
        responsesToCompletionsRequest(body, shapingFor(candidate)),
      ),
    };
  }
  const chatReq = responsesToChatRequest(body, shapingFor(candidate));
  return {
    url: joinUrl(candidate.baseUrl, "/chat/completions"),
    payload: JSON.stringify(chatReq),
    inputEstimate: estimateChatInputTokens(chatReq.messages),
  };
}

/**
 * 候选先按自己声明的协议请求。端点返回 404/405 说明协议配置不准（典型是
 * completions-only 上游被当成 chat），换另一协议在同一候选上重试一次，不消耗
 * 备用名额、不插入 failover 提示。连接错误与协议无关，直接交给上层 failover。
 */
async function requestResponsesCandidate(
  req: IncomingMessage,
  candidate: BridgeUpstream,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<
  | { response: NodeTransportResponse; attempt: ResponsesAttempt }
  | { error: string }
> {
  const order: ResponsesProtocol[] =
    candidateProtocol(candidate) === "completions"
      ? ["completions", "chat"]
      : ["chat", "completions"];
  let lastError = "";
  for (let index = 0; index < order.length; index += 1) {
    const attempt = buildResponsesAttempt(body, candidate, order[index]!);
    let response: NodeTransportResponse;
    try {
      response = await requestUpstream(
        candidate,
        attempt.url,
        "POST",
        attempt.payload,
        signal,
        sessionHeadersFor(req, candidate, attempt.payload),
      );
    } catch (err) {
      lastError = upstreamErrorMessage(err);
      break;
    }
    const isLastProtocol = index === order.length - 1;
    if (
      !response.ok &&
      (response.status === 404 || response.status === 405) &&
      !isLastProtocol
    ) {
      console.log(
        `[llm-switch bridge] ${candidateLabel(candidate)} ${attempt.url} 返回 HTTP ${response.status}，改用另一协议重试`,
      );
      // 丢弃探测响应体，避免占着 keep-alive 连接。
      await response.text().catch(() => "");
      continue;
    }
    return { response, attempt };
  }
  return { error: lastError };
}

async function forwardResponses(
  req: IncomingMessage,
  res: ServerResponse,
  upstream: BridgeUpstream,
  body: Record<string, unknown>,
  wantStream: boolean,
  signal?: AbortSignal,
): Promise<void> {
  const customTools = collectCustomToolNames(body.tools);
  const candidates = upstreamCandidates(upstream);
  // 流式请求先把 SSE 头发出去并保持心跳：深度推理可能几分钟没有首字节，
  // 中间代理与客户端超时都发生在等待阶段。headers 只发一次，候选切换复用。
  const keepalive = wantStream ? startSse(res) : undefined;
  const failures: string[] = [];

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const isLast = index === candidates.length - 1;
    const effectiveBody = withCandidateModel(body, candidate);
    markBridgeModel(res, String(effectiveBody.model || ""));

    const outcome = await requestResponsesCandidate(
      req,
      candidate,
      effectiveBody,
      signal,
    );
    if ("error" in outcome) {
      const message = `Upstream 请求失败: ${outcome.error}`;
      markBridgeError(res, message);
      if (isLast) {
        finishResponsesError(
          res,
          keepalive,
          failures,
          candidateLabel(candidate),
          message,
          failures.length > 0,
        );
        return;
      }
      failures.push(`${candidateLabel(candidate)}: ${message}`);
      announceFailover(res, keepalive, candidate, candidates[index + 1]!);
      continue;
    }

    const { response, attempt } = outcome;
    if (!response.ok) {
      const text = await response.text();
      const summary = `HTTP ${response.status}: ${text.slice(0, 300)}`;
      markBridgeError(res, summary);
      if (FAILOVER_STATUSES.has(response.status) && !isLast) {
        failures.push(`${candidateLabel(candidate)}: ${summary}`);
        announceFailover(res, keepalive, candidate, candidates[index + 1]!);
        continue;
      }
      keepalive?.stop();
      if (keepalive) {
        emitResponsesFailure(res, summary);
        res.end();
        return;
      }
      res.writeHead(response.status, {
        "Content-Type":
          response.headers.get("content-type") || "application/json",
      });
      res.end(text);
      return;
    }

    markBridgeUpstream(res, candidateLabel(candidate));
    if (!wantStream) {
      const json = (await response.json()) as Record<string, unknown>;
      sendJson(
        res,
        200,
        chatCompletionToResponse(
          json,
          String(effectiveBody.model || ""),
          customTools,
          true,
          attempt.inputEstimate,
        ),
      );
      return;
    }
    await pipeChatStreamToResponses(
      response,
      res,
      String(effectiveBody.model || ""),
      customTools,
      true,
      keepalive,
      attempt.inputEstimate,
    );
    return;
  }

  // 循环走完 = 所有候选（主 + 备用）都失败。
  finishResponsesError(
    res,
    keepalive,
    failures,
    candidateLabel(upstream),
    "所有上游均失败",
    true,
  );
}

/** Terminal failure after every candidate (or a non-retryable one) blew up. */
function finishResponsesError(
  res: ServerResponse,
  keepalive: SseKeepalive | undefined,
  failures: string[],
  label: string,
  message: string,
  aggregated = false,
): void {
  keepalive?.stop();
  const text = aggregated
    ? `${message} → ${failures.join("；") || label}`
    : `${label}: ${message}`;
  if (keepalive) {
    emitResponsesFailure(res, text);
    res.end();
    return;
  }
  sendJson(res, 502, { error: { message: text } });
}

/**
 * OpenCode-facing passthrough: forward an OpenAI chat request verbatim to the
 * upstream `/chat/completions` (with llm-switch transport applying the proxy)
 * and relay the raw response, preserving streaming for SSE.
 */
async function forwardOpenCodeChat(
  req: IncomingMessage,
  res: ServerResponse,
  upstream: BridgeUpstream,
  bodyBuf: Buffer,
  signal?: AbortSignal,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyBuf.toString("utf8")) as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { error: { message: "Invalid JSON body" } });
    return;
  }

  const wantStream = Boolean(body.stream);
  const candidates = upstreamCandidates(upstream);
  const keepalive = wantStream ? startSse(res) : undefined;
  const failures: string[] = [];
  const originalRawBody = bodyBuf.toString("utf8");

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const isLast = index === candidates.length - 1;
    const effectiveBody = withCandidateModel(body, candidate);
    // 首个候选且无需改写模型时保持原始字节，维持纯透传语义。
    const rawBody =
      index === 0 && effectiveBody === body
        ? originalRawBody
        : JSON.stringify(effectiveBody);
    const url = joinUrl(candidate.baseUrl, "/chat/completions");
    markBridgeModel(res, String(effectiveBody.model || ""));

    let response: NodeTransportResponse;
    try {
      response = await requestUpstream(
        candidate,
        url,
        "POST",
        rawBody,
        signal,
        sessionHeadersFor(req, candidate, rawBody),
      );
    } catch (err) {
      const message = `Upstream chat 请求失败: ${upstreamErrorMessage(err)}`;
      markBridgeError(res, message);
      if (isLast) {
        keepalive?.stop();
        const text = failures.length > 0
          ? `所有上游均失败 → ${[...failures, `${candidateLabel(candidate)}: ${message}`].join("；")}`
          : `${candidateLabel(candidate)}: ${message}`;
        if (keepalive) {
          writeSseFrame(
            res,
            `event: error\ndata: ${JSON.stringify({ type: "error", message: text })}\n\n`,
          );
          res.end();
        } else {
          sendJson(res, 502, { error: { message: text } });
        }
        return;
      }
      failures.push(`${candidateLabel(candidate)}: ${message}`);
      announceFailover(res, keepalive, candidate, candidates[index + 1]!);
      continue;
    }

    if (!response.ok) {
      const text = await response.text();
      const summary = `HTTP ${response.status}: ${text.slice(0, 300)}`;
      markBridgeError(res, summary);
      if (FAILOVER_STATUSES.has(response.status) && !isLast) {
        failures.push(`${candidateLabel(candidate)}: ${summary}`);
        announceFailover(res, keepalive, candidate, candidates[index + 1]!);
        continue;
      }
      keepalive?.stop();
      if (keepalive) {
        writeSseFrame(
          res,
          `event: error\ndata: ${JSON.stringify({ type: "error", message: summary })}\n\n`,
        );
        res.end();
        return;
      }
      res.writeHead(response.status, {
        "Content-Type":
          response.headers.get("content-type") || "application/json",
      });
      res.end(text);
      return;
    }

    markBridgeUpstream(res, candidateLabel(candidate));
    if (!wantStream) {
      keepalive?.stop();
      const text = await response.text();
      res.writeHead(response.status, {
        "Content-Type":
          response.headers.get("content-type") || "application/json",
      });
      res.end(text);
      return;
    }

    await pipeRawStream(response, res);
    return;
  }
}

async function pipeChatStreamToResponses(
  upstream: NodeTransportResponse,
  res: ServerResponse,
  model: string,
  customTools?: Iterable<string>,
  webSearchEnabled = false,
  keepalive?: SseKeepalive,
  estimatedInputTokens?: number,
): Promise<void> {
  const ka = keepalive ?? startSse(res);

  const state = createStreamState(
    model,
    undefined,
    customTools,
    webSearchEnabled,
    estimatedInputTokens,
  );
  const reader = upstream.body?.getReader();
  if (!reader) {
    ka.stop();
    for (const frame of forceCompleteStream(state)) res.write(frame);
    res.end();
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      ka.touch();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        const parsed = parseChatSseLineResponses(line);
        if (parsed === "done") {
          for (const frame of forceCompleteStream(state)) res.write(frame);
          continue;
        }
        if (!parsed) continue;
        for (const frame of chatChunkToResponsesEvents(parsed, state)) {
          res.write(frame);
        }
      }
    }
    if (buffer.trim()) {
      const parsed = parseChatSseLineResponses(buffer);
      if (parsed && parsed !== "done") {
        for (const frame of chatChunkToResponsesEvents(parsed, state)) {
          res.write(frame);
        }
      }
    }
    for (const frame of forceCompleteStream(state)) res.write(frame);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    markBridgeError(res, message);
    res.write(
      `event: error\ndata: ${JSON.stringify({ type: "error", message })}\n\n`,
    );
  } finally {
    ka.stop();
    res.end();
  }
}

async function pipeChatStreamToAnthropic(
  upstream: NodeTransportResponse,
  res: ServerResponse,
  model: string,
  keepalive?: SseKeepalive,
): Promise<void> {
  const ka = keepalive ?? startSse(res);

  const state = createAnthropicStreamState(model);
  const reader = upstream.body?.getReader();
  if (!reader) {
    ka.stop();
    for (const frame of forceCompleteAnthropicStream(state)) res.write(frame);
    res.end();
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      ka.touch();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        const parsed = parseChatSseLine(line);
        if (parsed === "done") {
          for (const frame of forceCompleteAnthropicStream(state)) {
            res.write(frame);
          }
          continue;
        }
        if (!parsed) continue;
        for (const frame of chatChunkToAnthropicEvents(parsed, state)) {
          res.write(frame);
        }
      }
    }
    if (buffer.trim()) {
      const parsed = parseChatSseLine(buffer);
      if (parsed && parsed !== "done") {
        for (const frame of chatChunkToAnthropicEvents(parsed, state)) {
          res.write(frame);
        }
      }
    }
    for (const frame of forceCompleteAnthropicStream(state)) res.write(frame);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    markBridgeError(res, message);
    res.write(
      `event: error\ndata: ${JSON.stringify({
        type: "error",
        error: { type: "api_error", message },
      })}\n\n`,
    );
  } finally {
    ka.stop();
    res.end();
  }
}

/** Relay an upstream SSE stream verbatim (OpenCode chat passthrough). */
async function pipeRawStream(
  upstream: NodeTransportResponse,
  res: ServerResponse,
): Promise<void> {
  const ka = startSse(res);

  const reader = upstream.body?.getReader();
  if (!reader) {
    ka.stop();
    res.end();
    return;
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      ka.touch();
      res.write(value);
    }
  } catch {
    // Connection dropped; best-effort close.
  } finally {
    ka.stop();
    res.end();
  }
}

export function createBridgeServer(options: BridgeServerOptions = {}): Server {
  const limits = parseBridgeRuntimeLimits();
  // LLM_SWITCH_MAX_CONCURRENCY 与 gateway 共用；默认 0 表示不限，
  // 此时 gate 只统计在途请求、不做拒绝。
  const gate = new ConcurrencyGate(limits.maxConcurrency);

  return createServer(async (req, res) => {
    // 客户端断开（Ctrl-C）后必须把上游请求也取消掉，否则 bridge 会一直把流读到
    // idle/total 超时，白白消耗上游 token 与连接。
    //
    // 注意运行时差异：Node 会在客户端掉线时给 ServerResponse 发 "close"，
    // 但 Bun 的 node:http 不发（只有 req 的 "aborted" 与 socket 的 "close"）。
    // bridge 守护进程两种运行时都可能跑，所以三个信号都监听，并用
    // writableFinished 兜底避免正常收尾时误取消。
    const controller = new AbortController();
    const abort = () => {
      if (res.writableFinished) return;
      controller.abort();
    };
    const socket = res.socket;
    res.on("close", abort);
    req.on("aborted", abort);
    socket?.on("close", abort);
    const signal = controller.signal;

    const urlPath = (req.url || "/").split("?")[0]!.replace(/\/+$/, "") || "/";
    const isDataPlane =
      req.method === "POST" &&
      /^\/(v1\/)?(responses|messages|chat\/completions|completions)$/.test(
        urlPath,
      );
    if (isDataPlane) {
      // /responses 与 /completions 服务 Codex，/messages 服务 Claude，
      // /chat/completions 服务 OpenCode。
      const tool = /messages$/.test(urlPath)
        ? "claude"
        : /chat\/completions$/.test(urlPath)
          ? "opencode"
          : "codex";
      attachBridgeLog(res, {
        tool,
        method: req.method || "POST",
        path: urlPath,
        stream: true,
      });
      if (!gate.tryAcquire()) {
        res.setHeader("Retry-After", "1");
        sendJson(res, 503, {
          error: {
            code: "too_many_concurrent_requests",
            message: `并发请求数已达上限 ${limits.maxConcurrency}（LLM_SWITCH_MAX_CONCURRENCY 可调整）`,
          },
        });
        return;
      }
    }

    try {
      const state = readBridgeState();
      const expectedControlToken =
        options.controlToken ?? state.instance?.controlToken;
      const expectedInstanceId = options.instanceId ?? state.instance?.id;
      const upstreams = readBridgeUpstreams();
      const merged = upstreams;

      const url = new URL(
        req.url || "/",
        `http://${req.headers.host || "127.0.0.1"}`,
      );
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (req.method === "GET" && (path === "/health" || path === "/v1/health")) {
        const suppliedControl = controlToken(req);
        if (!suppliedControl) {
          sendJson(res, 200, { ok: true, service: "llm-switch-bridge" });
          return;
        }
        if (
          !expectedControlToken ||
          !constantTimeTokenEqual(expectedControlToken, suppliedControl)
        ) {
          sendJson(res, 401, {
            ok: false,
            error: { code: "invalid_control_token", message: "Unauthorized" },
          });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          service: "llm-switch-bridge",
          instanceId: expectedInstanceId,
          upstreams: {
            codex: merged.codex
              ? {
                  mode: merged.codex.mode,
                  profile: merged.codex.profileName || null,
                  migrationRequired: merged.codex.migrationRequired === true,
                }
              : null,
            claude: merged.claude
              ? {
                  mode: merged.claude.mode,
                  profile: merged.claude.profileName || null,
                  migrationRequired: merged.claude.migrationRequired === true,
                }
              : null,
            opencode: merged.opencode
              ? {
                  mode: merged.opencode.mode,
                  profile: merged.opencode.profileName || null,
                  migrationRequired: merged.opencode.migrationRequired === true,
                }
              : null,
          },
        });
        return;
      }

      if (req.method === "GET" && path === "/_control/logs") {
        const suppliedControl = controlToken(req);
        if (
          !expectedControlToken ||
          !constantTimeTokenEqual(expectedControlToken, suppliedControl)
        ) {
          sendJson(res, 401, {
            ok: false,
            error: { code: "invalid_control_token", message: "Unauthorized" },
          });
          return;
        }
        const limit = Number(url.searchParams.get("limit") || "50");
        sendJson(res, 200, {
          entries: recentBridgeLogs(
            Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50,
          ),
        });
        return;
      }

      if (req.method === "POST" && path === "/_control/shutdown") {
        const suppliedControl = controlToken(req);
        if (
          !expectedControlToken ||
          !constantTimeTokenEqual(expectedControlToken, suppliedControl)
        ) {
          sendJson(res, 401, {
            ok: false,
            error: { code: "invalid_control_token", message: "Unauthorized" },
          });
          return;
        }
        let instanceId = "";
        try {
          const body = JSON.parse((await readBody(req)).toString("utf8")) as {
            instanceId?: unknown;
          };
          instanceId = typeof body.instanceId === "string" ? body.instanceId : "";
        } catch {
          sendJson(res, 400, { error: { message: "Invalid JSON body" } });
          return;
        }
        if (!expectedInstanceId || instanceId !== expectedInstanceId) {
          sendJson(res, 409, {
            error: { code: "instance_mismatch", message: "Bridge instance mismatch" },
          });
          return;
        }
        sendJson(res, 202, { ok: true, instanceId });
        queueMicrotask(() => {
          void options.onShutdown?.(instanceId);
        });
        return;
      }

      if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
        if (!authenticateModelsRequest(req, merged)) {
          sendJson(res, 401, {
            error: {
              code: "invalid_bridge_token",
              message: "Bridge token 无效；升级后请重新执行 llms <tool> use <profile>",
            },
          });
          return;
        }
        await proxyModelsMerged(req, res, merged, signal);
        return;
      }

      if (
        req.method === "POST" &&
        (path === "/v1/responses" || path === "/responses")
      ) {
        if (!merged.codex?.baseUrl) {
          sendJson(res, 503, {
            error: {
              message:
                "Bridge 未配置 Codex 上游。请先 llms codex use <openai-chat profile>",
            },
          });
          return;
        }
        if (!authenticateDataRequest(req, merged.codex, "codex")) {
          sendJson(res, 401, {
            error: {
              code: "invalid_bridge_token",
              message: "Bridge token 无效；请重新执行 llms codex use <profile>",
            },
          });
          return;
        }
        const body = await readBody(req);
        await handleResponses(req, res, merged.codex, body, signal);
        return;
      }

      if (
        req.method === "POST" &&
        (path === "/v1/messages" || path === "/messages")
      ) {
        if (!merged.claude?.baseUrl) {
          sendJson(res, 503, {
            type: "error",
            error: {
              type: "api_error",
              message:
                "Bridge 未配置 Claude 上游。请先 llms claude use <openai-chat profile>",
            },
          });
          return;
        }
        if (!authenticateDataRequest(req, merged.claude, "claude")) {
          sendJson(res, 401, {
            type: "error",
            error: {
              type: "authentication_error",
              message: "Bridge token 无效；请重新执行 llms claude use <profile>",
            },
          });
          return;
        }
        const body = await readBody(req);
        await handleMessages(req, res, merged.claude, body, signal);
        return;
      }

      if (
        req.method === "POST" &&
        (path === "/v1/chat/completions" || path === "/chat/completions")
      ) {
        if (!merged.opencode?.baseUrl) {
          sendJson(res, 503, {
            error: {
              message:
                "Bridge 未配置 OpenCode 上游。请先 llms opencode use <openai-chat profile>",
            },
          });
          return;
        }
        if (!authenticateDataRequest(req, merged.opencode, "opencode")) {
          sendJson(res, 401, {
            error: {
              code: "invalid_bridge_token",
              message: "Bridge token 无效；请重新执行 llms opencode use <profile>",
            },
          });
          return;
        }
        const body = await readBody(req);
        await forwardOpenCodeChat(req, res, merged.opencode, body, signal);
        return;
      }

      sendJson(res, 404, {
        error: {
          message: `Bridge 支持 GET /v1/models、POST /v1/responses、POST /v1/messages、POST /v1/chat/completions（当前: ${req.method} ${path}）`,
        },
      });
    } catch (err) {
      // 客户端已经走了就没人读响应了，不必再写。
      if (signal.aborted || res.writableEnded) return;
      if (err instanceof RequestBodyTooLargeError) {
        sendJson(res, 413, {
          error: { code: "request_too_large", message: err.message },
        });
        return;
      }
      sendJson(res, 500, {
        error: {
          message: err instanceof Error ? err.message : String(err),
        },
      });
    } finally {
      res.off("close", abort);
      req.off("aborted", abort);
      socket?.off("close", abort);
      if (isDataPlane) gate.release();
    }
  });
}

export function listenBridge(
  port: number,
  host: string,
  options: BridgeServerOptions = {},
): Promise<Server> {
  const server = createBridgeServer(options);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}
