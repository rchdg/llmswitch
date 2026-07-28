import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { buildProxyEnv } from "../utils/proxy.js";
import { emptyProxy } from "../types.js";
import { readBridgeState, readBridgeUpstreams } from "./state.js";
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

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
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

function upstreamHeaders(
  upstream: BridgeUpstream,
  incoming: IncomingMessage,
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  const incomingAuth = incoming.headers.authorization;
  const incomingKey = incoming.headers["x-api-key"];
  if (incomingAuth) {
    headers.Authorization = Array.isArray(incomingAuth)
      ? incomingAuth[0]!
      : incomingAuth;
  } else if (incomingKey) {
    const key = Array.isArray(incomingKey) ? incomingKey[0]! : incomingKey;
    headers.Authorization = `Bearer ${key}`;
  } else if (upstream.apiKey) {
    headers.Authorization = `Bearer ${upstream.apiKey}`;
  }

  if (upstream.headers) {
    for (const [k, v] of Object.entries(upstream.headers)) {
      headers[k] = v;
    }
  }
  return headers;
}

function withProxyEnv<T>(
  upstream: BridgeUpstream,
  fn: () => Promise<T>,
): Promise<T> {
  if (emptyProxy(upstream.proxy)) return fn();
  const next = buildProxyEnv(upstream.proxy);
  const backup = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(next)) {
    backup.set(k, process.env[k]);
    process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of backup) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

async function fetchModelsJson(
  upstream: BridgeUpstream,
  req: IncomingMessage,
): Promise<{ ok: boolean; status: number; data: unknown[] }> {
  const url = joinUrl(upstream.baseUrl, "/models");
  const response = await withProxyEnv(upstream, () =>
    fetch(url, {
      method: "GET",
      headers: upstreamHeaders(upstream, req),
    }),
  );
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
  req: IncomingMessage,
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
    sides.map((u) => fetchModelsJson(u, req).catch(() => ({
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
  req: IncomingMessage,
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

  let response: Response;
  try {
    response = await withProxyEnv(upstream, () =>
      fetch(url, {
        method: "POST",
        headers: upstreamHeaders(upstream, req),
        body: JSON.stringify(chatReq),
      }),
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

  let response: Response;
  try {
    response = await withProxyEnv(upstream, () =>
      fetch(url, {
        method: "POST",
        headers: upstreamHeaders(upstream, req),
        body: JSON.stringify(chatReq),
      }),
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
      chatCompletionToResponse(json, String(body.model || ""), customTools),
    );
    return;
  }

  await pipeChatStreamToResponses(
    response,
    res,
    String(body.model || ""),
    customTools,
  );
}

async function forwardCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  upstream: BridgeUpstream,
  body: Record<string, unknown>,
  wantStream: boolean,
): Promise<void> {
  const completionReq = responsesToCompletionsRequest(body);
  const customTools = collectCustomToolNames(body.tools);
  const url = joinUrl(upstream.baseUrl, "/completions");

  let response: Response;
  try {
    response = await withProxyEnv(upstream, () =>
      fetch(url, {
        method: "POST",
        headers: upstreamHeaders(upstream, req),
        body: JSON.stringify(completionReq),
      }),
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
      chatCompletionToResponse(json, String(body.model || ""), customTools),
    );
    return;
  }

  await pipeChatStreamToResponses(
    response,
    res,
    String(body.model || ""),
    customTools,
  );
}

async function pipeChatStreamToResponses(
  upstream: Response,
  res: ServerResponse,
  model: string,
  customTools?: Iterable<string>,
): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const state = createStreamState(model, undefined, customTools);
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
  upstream: Response,
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

export function createBridgeServer(): Server {
  return createServer(async (req, res) => {
    try {
      const upstreams = readBridgeUpstreams();
      const state = readBridgeState();
      const merged = {
        codex: upstreams.codex || state.upstreams.codex,
        claude: upstreams.claude || state.upstreams.claude,
      };

      const url = new URL(
        req.url || "/",
        `http://${req.headers.host || "127.0.0.1"}`,
      );
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (req.method === "GET" && (path === "/health" || path === "/v1/health")) {
        sendJson(res, 200, {
          ok: true,
          upstreams: {
            codex: merged.codex
              ? {
                  baseUrl: merged.codex.baseUrl,
                  mode: merged.codex.mode,
                  profile: merged.codex.profileName || null,
                }
              : null,
            claude: merged.claude
              ? {
                  baseUrl: merged.claude.baseUrl,
                  mode: merged.claude.mode,
                  profile: merged.claude.profileName || null,
                }
              : null,
          },
        });
        return;
      }

      if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
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
      sendJson(res, 500, {
        error: {
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  });
}

export function listenBridge(port: number, host: string): Promise<Server> {
  const server = createBridgeServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}
