/**
 * Outward-facing AI gateway HTTP server.
 *
 * Third-party clients authenticate with a gateway-issued API key, address any
 * configured provider by model id, and may speak OpenAI Chat, OpenAI Responses
 * or Anthropic Messages. Requests are routed with provider fallback and
 * translated between formats as needed.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { parseBridgeRuntimeLimits } from "../bridge/runtime.js";
import { randomBytes } from "node:crypto";
import {
  requestWithNodeTransport,
  type NodeTransportResponse,
} from "../bridge/transport.js";
import {
  authenticateGatewayKey,
  keyAllowsTarget,
  listGatewayKeys,
  touchGatewayKey,
  type AuthFailureReason,
  type RateLimitDecision,
} from "./keys.js";
import {
  createInboundEncoder,
  createUpstreamDecoder,
  chatCompletionToInbound,
  chatCompletionToLegacyCompletion,
  chatRequestToUpstream,
  formatErrorBody,
  inboundToChatRequest,
  legacyPromptToChatBody,
  parseInboundRequest,
  translateUpstreamError,
  upstreamPath,
  upstreamToChatCompletion,
  withRequestedModel,
  type InboundRequest,
} from "./pipeline.js";
import {
  ModelNotRoutableError,
  listRoutableModels,
  resolveModelRoute,
  type RouteCandidate,
} from "./router.js";
import {
  listGatewayProviders,
  listGatewayRoutes,
  readGatewayConfig,
} from "./store.js";
import { constantTimeTokenEqual, readGatewayState } from "./state.js";
import { ProviderBreaker } from "./health.js";
import { countAnthropicInputTokens } from "./tokens.js";
import { recordUsage } from "./usage.js";
import {
  providerFormat,
  type GatewayConfig,
  type GatewayFormat,
  type GatewayKey,
  type GatewayProvider,
} from "./types.js";

export interface GatewayServerOptions {
  controlToken?: string;
  instanceId?: string;
  onShutdown?: (instanceId: string) => void | Promise<void>;
  /** Set false to silence per-request logging. */
  log?: boolean;
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

const SSE_HEARTBEAT_MS = 15_000;

class RequestBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`请求体超过 ${maxBytes} 字节上限`);
    this.name = "RequestBodyTooLargeError";
  }
}

function headerValue(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const REQUEST_ID_SOURCE = Symbol("llm-switch-request-id");
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** Echo a client-supplied id or mint a fresh one for correlation. */
function requestIdOf(req: IncomingMessage): string {
  const bag = req as unknown as Record<symbol, unknown>;
  const existing = bag[REQUEST_ID_SOURCE];
  if (typeof existing === "string") return existing;
  const supplied = headerValue(req.headers["x-request-id"]);
  const id =
    supplied && REQUEST_ID_RE.test(supplied)
      ? supplied
      : randomBytes(8).toString("hex");
  bag[REQUEST_ID_SOURCE] = id;
  return id;
}

/** Accept both OpenAI (`Authorization: Bearer`) and Anthropic (`x-api-key`). */
function presentedKey(req: IncomingMessage): string | undefined {
  const authorization = headerValue(req.headers.authorization);
  const bearer = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (bearer) return bearer;
  const apiKey = headerValue(req.headers["x-api-key"]);
  if (apiKey) return apiKey;
  return undefined;
}

function controlToken(req: IncomingMessage): string | undefined {
  return headerValue(req.headers["x-llm-switch-control"]);
}

function readBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };
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
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(raw),
    ...extraHeaders,
  });
  res.end(raw);
}

/** Join a provider base URL with an API path, honoring its path prefix. */
export function upstreamUrl(provider: GatewayProvider, path: string): string {
  const base = provider.baseUrl.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  const prefix = (provider.pathPrefix ?? "v1").replace(/^\/+|\/+$/g, "");
  if (!prefix) return `${base}${suffix}`;
  if (base.endsWith(`/${prefix}`)) return `${base}${suffix}`;
  return `${base}/${prefix}${suffix}`;
}

const HOP_BY_HOP =
  /^(connection|keep-alive|proxy-authenticate|proxy-authorization|te|trailer|transfer-encoding|upgrade|host|content-length)$/i;

/**
 * Client headers worth relaying on a format-preserving pass-through, so beta
 * programs (`anthropic-beta`, `openai-beta`) keep working through the gateway.
 * Provider-configured headers always win.
 */
const FORWARDED_CLIENT_HEADERS = [
  "anthropic-version",
  "anthropic-beta",
  "openai-beta",
] as const;

export function buildUpstreamHeaders(
  provider: GatewayProvider,
  req?: IncomingMessage,
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  const format = providerFormat(provider);
  if (format === "anthropic") {
    headers["anthropic-version"] = "2023-06-01";
    if (provider.apiKey) headers["x-api-key"] = provider.apiKey;
  } else if (provider.apiKey) {
    headers.Authorization = `Bearer ${provider.apiKey}`;
  }

  let hasAuthorization = Boolean(headers.Authorization);
  const providerHeaderNames = new Set(
    Object.keys(provider.headers || {}).map((name) => name.toLowerCase()),
  );
  for (const [name, value] of Object.entries(provider.headers || {})) {
    if (HOP_BY_HOP.test(name)) continue;
    headers[name] = value;
    if (name.toLowerCase() === "authorization") hasAuthorization = true;
  }
  // An explicit authorization header replaces the derived bearer token.
  if (hasAuthorization && provider.apiKey && format !== "anthropic") {
    const explicit = Object.keys(provider.headers || {}).find(
      (name) => name.toLowerCase() === "authorization",
    );
    if (explicit) headers.Authorization = provider.headers![explicit]!;
  }

  if (req) {
    for (const name of FORWARDED_CLIENT_HEADERS) {
      if (providerHeaderNames.has(name)) continue;
      const value = headerValue(req.headers[name]);
      if (value !== undefined) headers[name] = value;
    }
    // Correlate upstream calls with the gateway request id.
    headers["x-request-id"] = requestIdOf(req);
  }
  return headers;
}

interface AttemptFailure {
  candidate: RouteCandidate;
  status: number;
  message: string;
}

/**
 * Tolerant token-usage extraction: upstream payloads and hub chunks speak
 * either the OpenAI or the Anthropic usage vocabulary.
 */
export function extractTokenUsage(
  payload: Record<string, unknown> | undefined,
): { inputTokens?: number; outputTokens?: number } {
  const usage = payload?.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return {};
  }
  const row = usage as Record<string, unknown>;
  const num = (...names: string[]): number | undefined => {
    for (const name of names) {
      const value = row[name];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
    return undefined;
  };
  const inputTokens = num("prompt_tokens", "input_tokens");
  const outputTokens = num("completion_tokens", "output_tokens");
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
}

function isRetryableStatus(config: GatewayConfig, status: number): boolean {
  return config.fallback.retryStatuses.includes(status);
}

function authFailureResponse(
  format: GatewayFormat,
  reason: AuthFailureReason,
  retryAfterSeconds?: number,
  rate?: RateLimitDecision,
): { status: number; payload: Record<string, unknown>; headers: Record<string, string> } {
  const messages: Record<AuthFailureReason, [number, string, string]> = {
    missing: [
      401,
      "缺少 API Key。请在 Authorization: Bearer <key> 或 x-api-key 中提供。",
      "missing_api_key",
    ],
    malformed: [401, "API Key 格式无效。", "invalid_api_key"],
    unknown: [401, "API Key 无效。", "invalid_api_key"],
    revoked: [401, "API Key 已被吊销。", "revoked_api_key"],
    expired: [401, "API Key 已过期。", "expired_api_key"],
    format_denied: [
      403,
      "该 API Key 无权访问此接口格式。",
      "format_not_allowed",
    ],
    rate_limited: [429, "请求频率超过限制。", "rate_limit_exceeded"],
  };
  const [status, message, code] = messages[reason];
  const body = formatErrorBody(format, status, message, code);
  const headers = rateLimitHeaders(rate);
  if (status === 401) {
    headers["WWW-Authenticate"] = 'Bearer realm="llm-switch-gateway"';
  }
  if (reason === "rate_limited" && retryAfterSeconds) {
    headers["Retry-After"] = String(retryAfterSeconds);
  }
  return { status: body.status, payload: body.payload, headers };
}

/** Standard rate-limit hints so clients can self-throttle. */
function rateLimitHeaders(
  rate: RateLimitDecision | undefined,
): Record<string, string> {
  if (!rate || rate.limit <= 0) return {};
  return {
    "X-RateLimit-Limit": String(rate.limit),
    "X-RateLimit-Remaining": String(Math.max(0, rate.remaining)),
    "X-RateLimit-Reset": String(rate.resetAt),
  };
}

interface RequestLogFields {
  method: string;
  path: string;
  status: number;
  requestId?: string;
  model?: string;
  provider?: string;
  keyId?: string;
  attempts?: number;
  durationMs: number;
}

function logRequest(enabled: boolean, fields: RequestLogFields): void {
  if (!enabled) return;
  const parts = [
    new Date().toISOString(),
    `${fields.method} ${fields.path}`,
    `status=${fields.status}`,
    `dur=${fields.durationMs}ms`,
  ];
  if (fields.requestId) parts.push(`req=${fields.requestId}`);
  if (fields.model) parts.push(`model=${fields.model}`);
  if (fields.provider) parts.push(`provider=${fields.provider}`);
  if (fields.attempts && fields.attempts > 1) {
    parts.push(`attempts=${fields.attempts}`);
  }
  // Only the key id is logged; the secret never appears in logs.
  if (fields.keyId) parts.push(`key=${fields.keyId}`);
  console.error(parts.join(" "));
}

function applyCors(
  req: IncomingMessage,
  res: ServerResponse,
  config: GatewayConfig,
): void {
  if (!config.corsOrigins.length) return;
  const origin = headerValue(req.headers.origin);
  if (!origin) return;
  const allowAll = config.corsOrigins.includes("*");
  if (!allowAll && !config.corsOrigins.includes(origin)) return;
  res.setHeader("Access-Control-Allow-Origin", allowAll ? "*" : origin);
  res.setHeader("Vary", "Origin");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "authorization, x-api-key, content-type, anthropic-version, anthropic-beta, openai-beta, x-request-id",
  );
  res.setHeader(
    "Access-Control-Expose-Headers",
    "x-request-id, retry-after, x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset",
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Max-Age", "600");
}

/** Bounded in-flight request counter shared by all data-plane endpoints. */
class ConcurrencyGate {
  private active = 0;
  constructor(private readonly max: number) {}
  get inFlight(): number {
    return this.active;
  }
  tryAcquire(): boolean {
    if (this.active >= this.max) return false;
    this.active += 1;
    return true;
  }
  release(): void {
    if (this.active > 0) this.active -= 1;
  }
}

export function createGatewayServer(
  options: GatewayServerOptions = {},
): Server {
  const limits = parseBridgeRuntimeLimits();
  const gate = new ConcurrencyGate(limits.maxConcurrency);
  const breaker = new ProviderBreaker();
  const logEnabled = options.log !== false;
  const startedAtIso = new Date().toISOString();
  const startedMs = Date.now();
  const stats = { requests: 0, errors4xx: 0, errors5xx: 0 };

  return createServer(async (req, res) => {
    const startedAt = Date.now();
    stats.requests += 1;
    const config = readGatewayConfig();
    applyCors(req, res, config);
    const requestId = requestIdOf(req);
    res.setHeader("x-request-id", requestId);

    const url = new URL(
      req.url || "/",
      `http://${req.headers.host || "127.0.0.1"}`,
    );
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method || "GET";

    const finish = (status: number, extra: Partial<RequestLogFields> = {}) => {
      if (status >= 500) stats.errors5xx += 1;
      else if (status >= 400) stats.errors4xx += 1;
      logRequest(logEnabled, {
        method,
        path,
        status,
        requestId,
        durationMs: Date.now() - startedAt,
        ...extra,
      });
    };

    try {
      if (method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        finish(204);
        return;
      }

      // --- control plane ----------------------------------------------------

      if (method === "GET" && (path === "/health" || path === "/v1/health")) {
        const supplied = controlToken(req);
        const state = readGatewayState();
        const expectedToken = options.controlToken ?? state.instance?.controlToken;
        const expectedId = options.instanceId ?? state.instance?.id;
        if (!supplied) {
          sendJson(res, 200, { ok: true, service: "llm-switch-gateway" });
          finish(200);
          return;
        }
        if (!expectedToken || !constantTimeTokenEqual(expectedToken, supplied)) {
          sendJson(res, 401, {
            ok: false,
            error: { code: "invalid_control_token", message: "Unauthorized" },
          });
          finish(401);
          return;
        }
        const providers = listGatewayProviders();
        sendJson(res, 200, {
          ok: true,
          service: "llm-switch-gateway",
          instanceId: expectedId,
          startedAt: state.instance?.startedAt ?? startedAtIso,
          uptimeSeconds: Math.floor((Date.now() - startedMs) / 1000),
          stats: {
            requests: stats.requests,
            errors4xx: stats.errors4xx,
            errors5xx: stats.errors5xx,
            activeConnections: gate.inFlight,
            maxConcurrency: limits.maxConcurrency,
          },
          providers: providers.map((provider) => ({
            name: provider.name,
            apiFormat: provider.apiFormat,
            enabled: provider.enabled,
            models: provider.models.length,
          })),
          routes: listGatewayRoutes().length,
          activeKeys: listGatewayKeys().filter((key) => !key.revokedAt).length,
          breakers: breaker.snapshot(),
        });
        finish(200);
        return;
      }

      if (method === "POST" && path === "/_control/shutdown") {
        const state = readGatewayState();
        const expectedToken = options.controlToken ?? state.instance?.controlToken;
        const expectedId = options.instanceId ?? state.instance?.id;
        const supplied = controlToken(req);
        if (!expectedToken || !constantTimeTokenEqual(expectedToken, supplied)) {
          sendJson(res, 401, {
            ok: false,
            error: { code: "invalid_control_token", message: "Unauthorized" },
          });
          finish(401);
          return;
        }
        let instanceId = "";
        try {
          const parsed = JSON.parse(
            (await readBody(req, 4_096)).toString("utf8"),
          ) as { instanceId?: unknown };
          instanceId =
            typeof parsed.instanceId === "string" ? parsed.instanceId : "";
        } catch {
          sendJson(res, 400, {
            error: { message: "Invalid JSON body" },
          });
          finish(400);
          return;
        }
        if (!expectedId || instanceId !== expectedId) {
          sendJson(res, 409, {
            error: {
              code: "instance_mismatch",
              message: "Gateway instance mismatch",
            },
          });
          finish(409);
          return;
        }
        sendJson(res, 202, { ok: true, instanceId });
        finish(202);
        queueMicrotask(() => {
          void options.onShutdown?.(instanceId);
        });
        return;
      }

      if (method === "GET" && path === "/") {
        sendJson(res, 200, {
          service: "llm-switch-gateway",
          endpoints: [
            "GET /v1/models",
            "GET /v1/models/{id}",
            "POST /v1/chat/completions",
            "POST /v1/completions",
            "POST /v1/messages",
            "POST /v1/messages/count_tokens",
            "POST /v1/responses",
            "POST /v1/embeddings",
          ],
        });
        finish(200);
        return;
      }

      // --- data plane -------------------------------------------------------

      const endpoint = matchEndpoint(method, path);
      if (!endpoint) {
        sendJson(res, 404, {
          error: {
            message: `未知端点：${method} ${path}`,
            type: "invalid_request_error",
          },
        });
        finish(404);
        return;
      }

      const auth = authenticateGatewayKey(presentedKey(req), {
        format: endpoint.format,
        defaultRateLimitPerMinute: config.rateLimitPerMinute,
      });
      if (!auth.ok) {
        const failure = authFailureResponse(
          endpoint.format,
          auth.reason,
          auth.retryAfterSeconds,
          auth.rate,
        );
        sendJson(res, failure.status, failure.payload, failure.headers);
        finish(failure.status);
        return;
      }

      // Set once so both JSON and SSE responses carry the hints.
      for (const [name, value] of Object.entries(rateLimitHeaders(auth.rate))) {
        res.setHeader(name, value);
      }

      if (!gate.tryAcquire()) {
        const body = formatErrorBody(
          endpoint.format,
          503,
          "网关并发已达上限，请稍后重试。",
          "gateway_busy",
        );
        sendJson(res, body.status, body.payload, { "Retry-After": "1" });
        finish(503, { keyId: auth.key.id });
        return;
      }

      try {
        if (endpoint.kind === "models") {
          const models = listRoutableModels().filter((model) =>
            keyAllowsTarget(
              auth.key,
              model.provider,
              model.upstreamModel,
              model.id,
            ),
          );
          sendJson(res, 200, {
            object: "list",
            data: models.map((model) => ({
              id: model.id,
              object: "model",
              created: 0,
              owned_by: model.provider,
              /** Non-standard hints, useful for gateway clients. */
              llm_switch: {
                provider: model.provider,
                upstream_model: model.upstreamModel,
                format: model.format,
              },
            })),
          });
          finish(200, { keyId: auth.key.id });
          return;
        }

        if (endpoint.kind === "model-detail") {
          const found = listRoutableModels().find(
            (model) =>
              model.id.toLowerCase() === (endpoint.modelId || "").toLowerCase(),
          );
          if (
            !found ||
            !keyAllowsTarget(
              auth.key,
              found.provider,
              found.upstreamModel,
              found.id,
            )
          ) {
            const body = formatErrorBody(
              endpoint.format,
              404,
              `模型「${endpoint.modelId}」不存在或不可访问。`,
              "model_not_found",
            );
            sendJson(res, body.status, body.payload);
            finish(404, { keyId: auth.key.id });
            return;
          }
          sendJson(res, 200, {
            id: found.id,
            object: "model",
            created: 0,
            owned_by: found.provider,
            llm_switch: {
              provider: found.provider,
              upstream_model: found.upstreamModel,
              format: found.format,
            },
          });
          finish(200, { keyId: auth.key.id });
          return;
        }

        const bodyBuf = await readBody(req, limits.maxBodyBytes);
        let parsedBody: Record<string, unknown>;
        try {
          parsedBody = JSON.parse(bodyBuf.toString("utf8")) as Record<
            string,
            unknown
          >;
        } catch {
          const body = formatErrorBody(
            endpoint.format,
            400,
            "请求体不是合法 JSON。",
            "invalid_json",
          );
          sendJson(res, body.status, body.payload);
          finish(400, { keyId: auth.key.id });
          return;
        }

        const outcome = await handleDataRequest({
          req,
          res,
          endpoint,
          body: parsedBody,
          key: auth.key,
          config,
          limits,
          breaker,
        });
        touchGatewayKey(auth.key.id);
        finish(outcome.status, {
          keyId: auth.key.id,
          model: outcome.model,
          provider: outcome.provider,
          attempts: outcome.attempts,
        });
      } finally {
        gate.release();
      }
    } catch (err) {
      const format = matchEndpoint(method, path)?.format ?? "openai-chat";
      if (err instanceof RequestBodyTooLargeError) {
        const body = formatErrorBody(
          format,
          413,
          err.message,
          "request_too_large",
        );
        sendJson(res, body.status, body.payload);
        finish(413);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      const body = formatErrorBody(format, 500, message, "internal_error");
      sendJson(res, body.status, body.payload);
      finish(500);
    }
  });
}

type EndpointKind =
  | "models"
  | "model-detail"
  | "completion"
  | "completion-legacy"
  | "embeddings"
  | "count_tokens";

interface EndpointMatch {
  kind: EndpointKind;
  format: GatewayFormat;
  /** For `model-detail`: the requested model id. */
  modelId?: string;
}

function matchEndpoint(method: string, path: string): EndpointMatch | null {
  const normalized = path.replace(/^\/v1/, "") || "/";
  if (method === "GET" && normalized === "/models") {
    return { kind: "models", format: "openai-chat" };
  }
  if (method === "GET" && normalized.startsWith("/models/")) {
    const id = normalized.slice("/models/".length);
    if (!id.includes("/")) {
      return {
        kind: "model-detail",
        format: "openai-chat",
        ...(id ? { modelId: decodeURIComponent(id) } : {}),
      };
    }
  }
  if (method !== "POST") return null;
  switch (normalized) {
    case "/chat/completions":
      return { kind: "completion", format: "openai-chat" };
    case "/completions":
      return { kind: "completion-legacy", format: "openai-chat" };
    case "/messages":
      return { kind: "completion", format: "anthropic" };
    case "/messages/count_tokens":
      return { kind: "count_tokens", format: "anthropic" };
    case "/responses":
      return { kind: "completion", format: "openai-responses" };
    case "/embeddings":
      return { kind: "embeddings", format: "openai-chat" };
    default:
      return null;
  }
}

interface DataRequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  endpoint: EndpointMatch;
  body: Record<string, unknown>;
  key: GatewayKey;
  config: GatewayConfig;
  limits: ReturnType<typeof parseBridgeRuntimeLimits>;
  breaker: ProviderBreaker;
}

interface DataRequestOutcome {
  status: number;
  model?: string;
  provider?: string;
  attempts?: number;
}

async function handleDataRequest(
  ctx: DataRequestContext,
): Promise<DataRequestOutcome> {
  const { endpoint, res } = ctx;
  const body =
    endpoint.kind === "completion-legacy"
      ? legacyPromptToChatBody(ctx.body)
      : ctx.body;
  const inbound = parseInboundRequest(endpoint.format, body);
  if (endpoint.kind === "completion-legacy") inbound.legacyCompletion = true;

  let candidates: RouteCandidate[];
  try {
    candidates = resolveModelRoute(inbound.requestedModel).candidates;
  } catch (err) {
    const status = err instanceof ModelNotRoutableError ? 404 : 500;
    const error = formatErrorBody(
      endpoint.format,
      status,
      err instanceof Error ? err.message : String(err),
      "model_not_found",
    );
    sendJson(res, error.status, error.payload);
    return { status: error.status, model: inbound.requestedModel };
  }

  const allowed = candidates.filter((candidate) =>
    keyAllowsTarget(
      ctx.key,
      candidate.provider.name,
      candidate.model,
      inbound.requestedModel,
    ),
  );
  if (!allowed.length) {
    const error = formatErrorBody(
      endpoint.format,
      403,
      `该 API Key 无权访问模型「${inbound.requestedModel}」。`,
      "model_not_allowed",
    );
    sendJson(res, error.status, error.payload);
    return { status: error.status, model: inbound.requestedModel };
  }

  // Skip providers in failure cooldown; if all of them are cooling, prefer a
  // delayed attempt over an immediate hard failure.
  const coolingFree = allowed.filter((candidate) =>
    ctx.breaker.allows(candidate.provider.name),
  );
  const routable = coolingFree.length ? coolingFree : allowed;

  if (endpoint.kind === "embeddings") {
    return forwardEmbeddings(ctx, inbound, routable);
  }
  if (endpoint.kind === "count_tokens") {
    return forwardCountTokens(ctx, inbound, routable);
  }
  return forwardCompletion(ctx, inbound, routable);
}

/** Abort the upstream request as soon as the client goes away. */
function clientAbortSignal(
  req: IncomingMessage,
  res: ServerResponse,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  req.once("close", onClose);
  return {
    signal: controller.signal,
    dispose: () => req.off("close", onClose),
  };
}

function transportOptionsFor(
  provider: GatewayProvider,
  limits: ReturnType<typeof parseBridgeRuntimeLimits>,
  signal: AbortSignal,
) {
  return {
    proxy: provider.proxy,
    signal,
    connectTimeoutMs: limits.connectTimeoutMs,
    idleTimeoutMs: limits.idleTimeoutMs,
    totalTimeoutMs: limits.totalTimeoutMs,
    maxResponseBytes: limits.maxResponseBytes,
  };
}

async function forwardCompletion(
  ctx: DataRequestContext,
  inbound: InboundRequest,
  candidates: readonly RouteCandidate[],
): Promise<DataRequestOutcome> {
  const { res, config, limits } = ctx;
  const hubRequest = inboundToChatRequest(inbound);
  const failures: AttemptFailure[] = [];
  const abort = clientAbortSignal(ctx.req, res);

  try {
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]!;
      const hasMore = index < candidates.length - 1;
      const provider = candidate.provider;
      const targetFormat = providerFormat(provider);
      // Legacy text completions always reshape the payload (chat → completion),
      // so the raw passthrough path never applies to them.
      const passthrough =
        targetFormat === inbound.format && !inbound.legacyCompletion;

      const upstreamBody = passthrough
        ? { ...inbound.body, model: candidate.model }
        : chatRequestToUpstream(targetFormat, {
            ...hubRequest,
            model: candidate.model,
          });

      let response: NodeTransportResponse;
      try {
        response = await requestWithNodeTransport({
          url: upstreamUrl(provider, upstreamPath(targetFormat)),
          method: "POST",
          // Relay beta headers only when the wire format is preserved; a
          // translated request has no guarantee the beta flag still applies.
          headers: buildUpstreamHeaders(provider, passthrough ? ctx.req : undefined),
          body: JSON.stringify(upstreamBody),
          ...transportOptionsFor(provider, limits, abort.signal),
        });
      } catch (err) {
        if (abort.signal.aborted) return { status: 499, attempts: index + 1 };
        const message = err instanceof Error ? err.message : String(err);
        ctx.breaker.failure(provider.name, message);
        failures.push({ candidate, status: 502, message });
        if (hasMore && config.fallback.enabled) continue;
        return respondWithFailures(res, inbound, failures, index + 1);
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        const retryable =
          config.fallback.enabled && isRetryableStatus(config, response.status);
        if (hasMore && retryable) {
          ctx.breaker.failure(provider.name, `HTTP ${response.status}`);
          failures.push({
            candidate,
            status: response.status,
            message: text.slice(0, 300),
          });
          continue;
        }
        if (response.status >= 500) {
          ctx.breaker.failure(provider.name, `HTTP ${response.status}`);
        }
        const error = translateUpstreamError(
          inbound.format,
          response.status,
          text,
        );
        sendJson(res, error.status, error.payload);
        return {
          status: error.status,
          model: inbound.requestedModel,
          provider: provider.name,
          attempts: index + 1,
        };
      }

      // Committed to this candidate: no fallback once bytes are written.
      ctx.breaker.success(provider.name);
      if (!inbound.stream) {
        let payload: Record<string, unknown>;
        try {
          payload = (await response.json()) as Record<string, unknown>;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const error = formatErrorBody(
            inbound.format,
            502,
            `无法解析上游响应：${message}`,
            "upstream_error",
          );
          sendJson(res, error.status, error.payload);
          return {
            status: error.status,
            model: inbound.requestedModel,
            provider: provider.name,
            attempts: index + 1,
          };
        }
        const finalBody = passthrough
          ? withRequestedModel(payload, inbound.requestedModel)
          : withRequestedModel(
              chatCompletionToInbound(
                inbound,
                upstreamToChatCompletion(
                  targetFormat,
                  payload,
                  inbound.requestedModel,
                ),
              ),
              inbound.requestedModel,
            );
        sendJson(
          res,
          200,
          inbound.legacyCompletion
            ? chatCompletionToLegacyCompletion(
                finalBody,
                inbound.requestedModel,
              )
            : finalBody,
        );
        recordUsage({
          keyId: ctx.key.id,
          provider: provider.name,
          model: inbound.requestedModel,
          ...extractTokenUsage(payload),
        });
        return {
          status: 200,
          model: inbound.requestedModel,
          provider: provider.name,
          attempts: index + 1,
        };
      }

      const streamUsage = await pipeStream(
        response,
        res,
        inbound,
        targetFormat,
        passthrough,
      );
      recordUsage({
        keyId: ctx.key.id,
        provider: provider.name,
        model: inbound.requestedModel,
        ...streamUsage,
      });
      return {
        status: 200,
        model: inbound.requestedModel,
        provider: provider.name,
        attempts: index + 1,
      };
    }

    return respondWithFailures(res, inbound, failures, candidates.length);
  } finally {
    abort.dispose();
  }
}

function respondWithFailures(
  res: ServerResponse,
  inbound: InboundRequest,
  failures: readonly AttemptFailure[],
  attempts: number,
): DataRequestOutcome {
  const last = failures[failures.length - 1];
  const detail = failures
    .map(
      (failure) =>
        `${failure.candidate.provider.name}(${failure.status}): ${failure.message || "无响应"}`,
    )
    .join(" | ");
  const status = last && last.status >= 400 && last.status < 600 ? last.status : 502;
  const error = formatErrorBody(
    inbound.format,
    status === 429 ? 429 : 502,
    `所有上游尝试均失败。${detail}`,
    "all_upstreams_failed",
  );
  sendJson(res, error.status, error.payload);
  return { status: error.status, model: inbound.requestedModel, attempts };
}

/**
 * Relay a streaming upstream response. Passthrough copies bytes verbatim;
 * otherwise upstream frames are decoded to hub chunks and re-encoded into the
 * inbound protocol. Usage lines spotted in decoded chunks are returned so the
 * caller can account tokens.
 */
async function pipeStream(
  upstream: NodeTransportResponse,
  res: ServerResponse,
  inbound: InboundRequest,
  targetFormat: GatewayFormat,
  passthrough: boolean,
): Promise<{ inputTokens?: number; outputTokens?: number }> {
  res.writeHead(200, { ...SSE_HEADERS });

  const usage: { inputTokens?: number; outputTokens?: number } = {};
  const noteUsage = (payload: Record<string, unknown>): void => {
    const found = extractTokenUsage(payload);
    if (found.inputTokens !== undefined) usage.inputTokens = found.inputTokens;
    if (found.outputTokens !== undefined) {
      usage.outputTokens = found.outputTokens;
    }
  };

  let lastWrite = Date.now();
  const heartbeat = setInterval(() => {
    if (res.writableEnded) return;
    if (Date.now() - lastWrite < SSE_HEARTBEAT_MS) return;
    // SSE comment frame: ignored by every conforming client, keeps proxies warm.
    res.write(": keep-alive\n\n");
    lastWrite = Date.now();
  }, SSE_HEARTBEAT_MS);
  const write = (frame: string | Uint8Array) => {
    res.write(frame);
    lastWrite = Date.now();
  };

  const reader = upstream.body?.getReader();
  if (!reader) {
    clearInterval(heartbeat);
    res.end();
    return usage;
  }

  const decoder = createUpstreamDecoder(targetFormat, inbound.requestedModel);
  const encoder = createInboundEncoder(inbound);
  const textDecoder = new TextDecoder();
  let buffer = "";

  const emit = (chunks: Array<Record<string, unknown>>) => {
    for (const chunk of chunks) {
      noteUsage(chunk);
      const normalized = withRequestedModel(chunk, inbound.requestedModel);
      for (const frame of encoder.encode(normalized)) write(frame);
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (passthrough) {
        write(value);
        continue;
      }
      buffer += textDecoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) emit(decoder.push(line));
    }
    if (!passthrough) {
      if (buffer.trim()) emit(decoder.push(buffer));
      emit(decoder.finish());
      for (const frame of encoder.finish()) write(frame);
    }
  } catch (err) {
    if (!res.writableEnded) {
      const message = err instanceof Error ? err.message : String(err);
      const payload =
        inbound.format === "anthropic"
          ? { type: "error", error: { type: "api_error", message } }
          : { error: { message, type: "api_error" } };
      write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
    }
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
  return usage;
}

/**
 * Embeddings only exist on OpenAI-compatible upstreams; Anthropic providers are
 * skipped rather than silently mistranslated.
 */
async function forwardEmbeddings(
  ctx: DataRequestContext,
  inbound: InboundRequest,
  candidates: readonly RouteCandidate[],
): Promise<DataRequestOutcome> {
  const { res, config, limits } = ctx;
  const usable = candidates.filter(
    (candidate) => providerFormat(candidate.provider) !== "anthropic",
  );
  if (!usable.length) {
    const error = formatErrorBody(
      inbound.format,
      404,
      `模型「${inbound.requestedModel}」没有支持 embeddings 的上游（Anthropic 格式不提供该接口）。`,
      "embeddings_unsupported",
    );
    sendJson(res, error.status, error.payload);
    return { status: error.status, model: inbound.requestedModel };
  }

  const abort = clientAbortSignal(ctx.req, res);
  const failures: AttemptFailure[] = [];
  try {
    for (let index = 0; index < usable.length; index += 1) {
      const candidate = usable[index]!;
      const hasMore = index < usable.length - 1;
      let response: NodeTransportResponse;
      try {
        response = await requestWithNodeTransport({
          url: upstreamUrl(candidate.provider, "/embeddings"),
          method: "POST",
          headers: buildUpstreamHeaders(candidate.provider, ctx.req),
          body: JSON.stringify({ ...inbound.body, model: candidate.model }),
          ...transportOptionsFor(candidate.provider, limits, abort.signal),
        });
      } catch (err) {
        if (abort.signal.aborted) return { status: 499, attempts: index + 1 };
        const message = err instanceof Error ? err.message : String(err);
        ctx.breaker.failure(candidate.provider.name, message);
        failures.push({
          candidate,
          status: 502,
          message,
        });
        if (hasMore && config.fallback.enabled) continue;
        return respondWithFailures(res, inbound, failures, index + 1);
      }

      const text = await response.text().catch(() => "");
      if (!response.ok) {
        if (
          hasMore &&
          config.fallback.enabled &&
          isRetryableStatus(config, response.status)
        ) {
          ctx.breaker.failure(
            candidate.provider.name,
            `HTTP ${response.status}`,
          );
          failures.push({
            candidate,
            status: response.status,
            message: text.slice(0, 300),
          });
          continue;
        }
        const error = translateUpstreamError(
          inbound.format,
          response.status,
          text,
        );
        sendJson(res, error.status, error.payload);
        return {
          status: error.status,
          model: inbound.requestedModel,
          provider: candidate.provider.name,
          attempts: index + 1,
        };
      }

      ctx.breaker.success(candidate.provider.name);
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(text) as Record<string, unknown>;
      } catch {
        payload = {};
      }
      sendJson(res, 200, withRequestedModel(payload, inbound.requestedModel));
      recordUsage({
        keyId: ctx.key.id,
        provider: candidate.provider.name,
        model: inbound.requestedModel,
        ...extractTokenUsage(payload),
      });
      return {
        status: 200,
        model: inbound.requestedModel,
        provider: candidate.provider.name,
        attempts: index + 1,
      };
    }
    return respondWithFailures(res, inbound, failures, usable.length);
  } finally {
    abort.dispose();
  }
}

/**
 * Anthropic `count_tokens`. Native upstreams answer authoritatively; for other
 * formats the gateway returns a clearly-labelled local estimate rather than
 * failing, because clients use this call to size requests.
 */
async function forwardCountTokens(
  ctx: DataRequestContext,
  inbound: InboundRequest,
  candidates: readonly RouteCandidate[],
): Promise<DataRequestOutcome> {
  const { res, limits } = ctx;
  const native = candidates.find(
    (candidate) => providerFormat(candidate.provider) === "anthropic",
  );

  if (native) {
    const abort = clientAbortSignal(ctx.req, res);
    try {
      const response = await requestWithNodeTransport({
        url: upstreamUrl(native.provider, "/messages/count_tokens"),
        method: "POST",
        headers: buildUpstreamHeaders(native.provider, ctx.req),
        body: JSON.stringify({ ...inbound.body, model: native.model }),
        ...transportOptionsFor(native.provider, limits, abort.signal),
      });
      const text = await response.text().catch(() => "");
      if (response.ok) {
        ctx.breaker.success(native.provider.name);
        try {
          sendJson(res, 200, JSON.parse(text) as unknown);
        } catch {
          sendJson(res, 200, { input_tokens: 0 });
        }
        return {
          status: 200,
          model: inbound.requestedModel,
          provider: native.provider.name,
          attempts: 1,
        };
      }
      // Fall through to the local estimate on upstream failure.
    } catch {
      if (abort.signal.aborted) return { status: 499 };
    } finally {
      abort.dispose();
    }
  }

  const estimate = await countAnthropicInputTokens(inbound.body);
  sendJson(res, 200, {
    input_tokens: estimate.inputTokens,
    llm_switch: {
      estimated: true,
      reason: native ? "upstream_count_failed" : "upstream_not_anthropic",
      method: estimate.method,
      ...(estimate.tokenizer ? { tokenizer: estimate.tokenizer } : {}),
      breakdown: estimate.breakdown,
    },
  });
  return { status: 200, model: inbound.requestedModel, attempts: 1 };
}

export function listenGateway(
  port: number,
  host: string,
  options: GatewayServerOptions = {},
): Promise<Server> {
  const server = createGatewayServer(options);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}
