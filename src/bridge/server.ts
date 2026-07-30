import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { parseBridgeRuntimeLimits } from "./runtime.js";
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

export interface BridgeServerOptions {
  controlToken?: string;
  instanceId?: string;
  onShutdown?: (instanceId: string) => void | Promise<void>;
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
  tool: "codex" | "claude",
): boolean {
  if (!upstream?.clientToken || upstream.migrationRequired) return false;
  const bearer = bearerToken(req);
  if (tool === "codex") {
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
    authenticateDataRequest(req, upstreams.claude, "claude")
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
): Promise<NodeTransportResponse> {
  const limits = parseBridgeRuntimeLimits();
  return requestWithNodeTransport({
    url,
    method,
    headers: upstreamHeaders(upstream),
    body,
    proxy: upstream.proxy,
    signal,
    connectTimeoutMs: limits.connectTimeoutMs,
    idleTimeoutMs: limits.idleTimeoutMs,
    totalTimeoutMs: limits.totalTimeoutMs,
    maxResponseBytes: limits.maxResponseBytes,
  });
}

async function fetchModelsJson(
  upstream: BridgeUpstream,
): Promise<{ ok: boolean; status: number; data: unknown[] }> {
  const url = joinUrl(upstream.baseUrl, "/models");
  const response = await requestUpstream(upstream, url, "GET");
  if (!response.ok) {
    return { ok: false, status: response.status, data: [] };
  }
  try {
    const json = (await response.json()) as Record<string, unknown>;
    const data = Array.isArray(json.data) ? json.data : [];
    return { ok: true, status: 200, data: data as unknown[] };
  } catch {
    return { ok: false, status: 502, data: [] };
  }
}

async function proxyModelsMerged(
  _req: IncomingMessage,
  res: ServerResponse,
  upstreams: BridgeUpstreams,
): Promise<void> {
  const sides = [upstreams.codex, upstreams.claude].filter(
    (u): u is BridgeUpstream => Boolean(u?.baseUrl),
  );
  if (!sides.length) {
    sendJson(res, 503, {
      error: { message: "Bridge 未配置上游" },
    });
    return;
  }

  const results = await Promise.all(
    sides.map((u) => fetchModelsJson(u).catch(() => ({
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
      const id =
        item && typeof item === "object" && "id" in item
          ? String((item as { id: unknown }).id)
          : "";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      merged.push(item);
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
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyBuf.toString("utf8")) as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { error: { message: "Invalid JSON body" } });
    return;
  }

  const mode = upstream.mode || "chat";
  const wantStream = Boolean(body.stream);

  if (mode === "completions") {
    await forwardCompletions(req, res, upstream, body, wantStream);
    return;
  }

  await forwardChatResponses(req, res, upstream, body, wantStream);
}

async function handleMessages(
  _req: IncomingMessage,
  res: ServerResponse,
  upstream: BridgeUpstream,
  bodyBuf: Buffer,
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
  const chatReq = anthropicToChatRequest(body);
  const url = joinUrl(upstream.baseUrl, "/chat/completions");

  let response: NodeTransportResponse;
  try {
    response = await requestUpstream(
      upstream,
      url,
      "POST",
      JSON.stringify(chatReq),
    );
  } catch (err) {
    sendJson(res, 502, {
      type: "error",
      error: {
        type: "api_error",
        message: `Upstream chat 请求失败: ${err instanceof Error ? err.message : String(err)}`,
      },
    });
    return;
  }

  if (!response.ok) {
    const text = await response.text();
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

  if (!wantStream) {
    const json = (await response.json()) as Record<string, unknown>;
    sendJson(
      res,
      200,
      chatCompletionToAnthropicMessage(json, String(body.model || "")),
    );
    return;
  }

  await pipeChatStreamToAnthropic(response, res, String(body.model || ""));
}

async function forwardChatResponses(
  req: IncomingMessage,
  res: ServerResponse,
  upstream: BridgeUpstream,
  body: Record<string, unknown>,
  wantStream: boolean,
): Promise<void> {
  const chatReq = responsesToChatRequest(body);
  const customTools = collectCustomToolNames(body.tools);
  const url = joinUrl(upstream.baseUrl, "/chat/completions");

  let response: NodeTransportResponse;
  try {
    response = await requestUpstream(
      upstream,
      url,
      "POST",
      JSON.stringify(chatReq),
    );
  } catch (err) {
    sendJson(res, 502, {
      error: {
        message: `Upstream chat 请求失败: ${err instanceof Error ? err.message : String(err)}`,
      },
    });
    return;
  }

  if (!response.ok) {
    if (response.status === 404 || response.status === 405) {
      await forwardCompletions(req, res, upstream, body, wantStream);
      return;
    }
    const text = await response.text();
    res.writeHead(response.status, {
      "Content-Type":
        response.headers.get("content-type") || "application/json",
    });
    res.end(text);
    return;
  }

  if (!wantStream) {
    const json = (await response.json()) as Record<string, unknown>;
    sendJson(
      res,
      200,
      chatCompletionToResponse(
        json,
        String(body.model || ""),
        customTools,
        true,
      ),
    );
    return;
  }

  await pipeChatStreamToResponses(
    response,
    res,
    String(body.model || ""),
    customTools,
    true,
  );
}

async function forwardCompletions(
  _req: IncomingMessage,
  res: ServerResponse,
  upstream: BridgeUpstream,
  body: Record<string, unknown>,
  wantStream: boolean,
): Promise<void> {
  const completionReq = responsesToCompletionsRequest(body);
  const customTools = collectCustomToolNames(body.tools);
  const url = joinUrl(upstream.baseUrl, "/completions");

  let response: NodeTransportResponse;
  try {
    response = await requestUpstream(
      upstream,
      url,
      "POST",
      JSON.stringify(completionReq),
    );
  } catch (err) {
    sendJson(res, 502, {
      error: {
        message: `Upstream completions 请求失败: ${err instanceof Error ? err.message : String(err)}`,
      },
    });
    return;
  }

  if (!response.ok) {
    const text = await response.text();
    res.writeHead(response.status, {
      "Content-Type":
        response.headers.get("content-type") || "application/json",
    });
    res.end(text);
    return;
  }

  if (!wantStream) {
    const json = (await response.json()) as Record<string, unknown>;
    sendJson(
      res,
      200,
      chatCompletionToResponse(
        json,
        String(body.model || ""),
        customTools,
        true,
      ),
    );
    return;
  }

  await pipeChatStreamToResponses(
    response,
    res,
    String(body.model || ""),
    customTools,
    true,
  );
}

async function pipeChatStreamToResponses(
  upstream: NodeTransportResponse,
  res: ServerResponse,
  model: string,
  customTools?: Iterable<string>,
  webSearchEnabled = false,
): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const state = createStreamState(
    model,
    undefined,
    customTools,
    webSearchEnabled,
  );
  const reader = upstream.body?.getReader();
  if (!reader) {
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
    res.write(
      `event: error\ndata: ${JSON.stringify({ type: "error", message })}\n\n`,
    );
  } finally {
    res.end();
  }
}

async function pipeChatStreamToAnthropic(
  upstream: NodeTransportResponse,
  res: ServerResponse,
  model: string,
): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const state = createAnthropicStreamState(model);
  const reader = upstream.body?.getReader();
  if (!reader) {
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
    res.write(
      `event: error\ndata: ${JSON.stringify({
        type: "error",
        error: { type: "api_error", message },
      })}\n\n`,
    );
  } finally {
    res.end();
  }
}

export function createBridgeServer(options: BridgeServerOptions = {}): Server {
  return createServer(async (req, res) => {
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
          },
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
        await proxyModelsMerged(req, res, merged);
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
        await handleResponses(req, res, merged.codex, body);
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
        await handleMessages(req, res, merged.claude, body);
        return;
      }

      sendJson(res, 404, {
        error: {
          message: `Bridge 支持 GET /v1/models、POST /v1/responses、POST /v1/messages（当前: ${req.method} ${path}）`,
        },
      });
    } catch (err) {
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
