import { Buffer } from "node:buffer";
import { request as httpRequest, type ClientRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Agent } from "node:http";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import type { ProxyConfig } from "../types.js";

const SUPPORTED_TARGET_PROTOCOLS = new Set(["http:", "https:"]);
const SUPPORTED_PROXY_PROTOCOLS = new Set([
  "http:",
  "https:",
  "socks:",
  "socks4:",
  "socks4a:",
  "socks5:",
  "socks5h:",
]);

/** Hop-by-hop and inbound-credential headers never forwarded upstream. */
const STRIPPED_REQUEST_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_TIMEOUT_MS = 90_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_REDIRECTS = 5;

export class TransportTimeoutError extends Error {
  constructor(message = "上游请求超时") {
    super(message);
    this.name = "TransportTimeoutError";
  }
}

export class ResponseLimitError extends Error {
  constructor(message = "上游响应超出大小限制") {
    super(message);
    this.name = "ResponseLimitError";
  }
}

export class CrossOriginRedirectError extends Error {
  constructor(message = "拒绝跨源 redirect") {
    super(message);
    this.name = "CrossOriginRedirectError";
  }
}

export class TransportProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransportProtocolError";
  }
}

export interface TransportRequestOptions {
  url: string;
  method?: string;
  headers?: Record<string, string | undefined>;
  body?: string | Buffer | Uint8Array | null;
  proxy?: ProxyConfig;
  signal?: AbortSignal;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxResponseBytes?: number;
  maxRedirects?: number;
}

/**
 * Resolve the proxy URL for a target. A profile has a single proxy applied to
 * all traffic; the URL scheme (http/https/socks*) selects the agent.
 */
export function selectProxyUrl(
  _target: URL,
  proxy?: ProxyConfig,
): string | null {
  const chosen = proxy?.trim();
  return chosen || null;
}

/**
 * Build a fresh per-request Agent for the given proxy URL. Callers own its
 * lifecycle and must call `.destroy()` once the response is drained.
 */
export function createTransportAgent(_target: URL, proxyUrl: string): Agent {
  let proxy: URL;
  try {
    proxy = new URL(proxyUrl);
  } catch {
    throw new TransportProtocolError(`无效的 proxy URL: ${proxyUrl}`);
  }
  if (!SUPPORTED_PROXY_PROTOCOLS.has(proxy.protocol)) {
    throw new TransportProtocolError(
      `不支持的 proxy protocol: ${proxy.protocol}`,
    );
  }
  if (proxy.protocol === "http:" || proxy.protocol === "https:") {
    return new HttpsProxyAgent(proxy);
  }
  // socks5 resolves DNS locally; socks5h/socks4a defer to the proxy.
  return new SocksProxyAgent(proxy);
}

function sanitizeHeaders(
  headers: Record<string, string | undefined> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

function isSameOrigin(a: URL, b: URL): boolean {
  return (
    a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port
  );
}

interface BodyContext {
  res: import("node:http").IncomingMessage;
  maxResponseBytes?: number;
  armIdle(): void;
  finalize(): void;
}

/**
 * A Web-`Response`-like view. Consume the body exactly once: either as a
 * stream (`body`) for SSE pass-through, or buffered (`text`/`json`/
 * `arrayBuffer`) with the response size limit enforced. Both paths re-arm the
 * idle timer, and finalize timers/abort listener/proxy Agent on completion.
 */
class NodeTransportResponse {
  private consumed = false;
  private pendingFatal: Error | null = null;
  private failSink: ((err: Error) => void) | null = null;

  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly headers: Headers,
    private readonly ctx: BodyContext,
  ) {}

  get ok(): boolean {
    return this.status >= 200 && this.status < 300;
  }

  /** Routes a fatal condition (idle/total timeout, abort) to the active consumer. */
  fail(err: Error): void {
    if (this.failSink) this.failSink(err);
    else this.pendingFatal = err;
  }

  get body(): ReadableStream<Uint8Array> | null {
    if (this.consumed) return null;
    this.consumed = true;
    const ctx = this.ctx;
    const { res } = ctx;
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        let closed = false;
        const stop = (err: Error | null) => {
          if (closed) return;
          closed = true;
          ctx.finalize();
          if (err) {
            res.destroy();
            try {
              controller.error(err);
            } catch {
              // already errored
            }
          } else {
            try {
              controller.close();
            } catch {
              // already closed
            }
          }
        };
        this.failSink = (err) => stop(err);
        if (this.pendingFatal) {
          stop(this.pendingFatal);
          return;
        }
        res.on("data", (chunk: Buffer) => {
          ctx.armIdle();
          controller.enqueue(new Uint8Array(chunk));
        });
        res.on("end", () => stop(null));
        res.on("error", (err) => stop(err));
        res.on("aborted", () =>
          stop(new TransportTimeoutError("上游连接中断")),
        );
        res.resume();
      },
      cancel: () => {
        ctx.finalize();
        res.destroy();
      },
    });
  }

  private buffered(): Promise<Buffer> {
    if (this.consumed) {
      return Promise.reject(new Error("响应 body 已被消费"));
    }
    this.consumed = true;
    const ctx = this.ctx;
    const { res } = ctx;
    const max = ctx.maxResponseBytes;
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let done = false;
      const finish = (err: Error | null, buf?: Buffer) => {
        if (done) return;
        done = true;
        ctx.finalize();
        if (err) {
          res.destroy();
          reject(err);
        } else {
          resolve(buf ?? Buffer.concat(chunks));
        }
      };
      this.failSink = (err) => finish(err);
      if (this.pendingFatal) {
        finish(this.pendingFatal);
        return;
      }
      res.on("data", (chunk: Buffer) => {
        ctx.armIdle();
        total += chunk.byteLength;
        if (max !== undefined && total > max) {
          finish(new ResponseLimitError());
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => finish(null, Buffer.concat(chunks)));
      res.on("error", (err) => finish(err));
      res.on("aborted", () =>
        finish(new TransportTimeoutError("上游连接中断")),
      );
      res.resume();
    });
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const buf = await this.buffered();
    return buf.buffer.slice(
      buf.byteOffset,
      buf.byteOffset + buf.byteLength,
    ) as ArrayBuffer;
  }

  async text(): Promise<string> {
    return (await this.buffered()).toString("utf8");
  }

  async json(): Promise<unknown> {
    return JSON.parse(await this.text());
  }
}

export type { NodeTransportResponse };

export type TransportResponse = NodeTransportResponse;

interface TimerBag {
  clearAll(): void;
}

export async function requestWithNodeTransport(
  options: TransportRequestOptions,
): Promise<TransportResponse> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const origin = parseTarget(options.url);
  let current = origin;

  for (let redirects = 0; ; redirects += 1) {
    const result = await performRequest(current, options);
    if (
      result.type === "redirect" &&
      redirects < maxRedirects &&
      result.location
    ) {
      const next = parseTarget(new URL(result.location, current).toString());
      if (!isSameOrigin(next, origin)) {
        throw new CrossOriginRedirectError(
          `拒绝跨源 redirect: ${current.origin} → ${next.origin}`,
        );
      }
      current = next;
      continue;
    }
    if (result.type === "redirect" && redirects >= maxRedirects) {
      throw new TransportProtocolError("redirect 次数超过上限");
    }
    return result.response;
  }
}

function parseTarget(url: string): URL {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new TransportProtocolError(`无效的目标 URL: ${url}`);
  }
  if (!SUPPORTED_TARGET_PROTOCOLS.has(target.protocol)) {
    throw new TransportProtocolError(
      `不支持的 target protocol: ${target.protocol}`,
    );
  }
  return target;
}

type RequestOutcome =
  | { type: "response"; response: TransportResponse; location?: undefined }
  | { type: "redirect"; location: string; response: TransportResponse };

function performRequest(
  target: URL,
  options: TransportRequestOptions,
): Promise<RequestOutcome> {
  const proxyUrl = selectProxyUrl(target, options.proxy);
  const agent = proxyUrl ? createTransportAgent(target, proxyUrl) : undefined;
  const isHttps = target.protocol === "https:";
  const requestImpl = isHttps ? httpsRequest : httpRequest;

  const connectTimeoutMs =
    options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes;

  const headers = sanitizeHeaders(options.headers);
  const bodyBuffer = normalizeBody(options.body);
  if (bodyBuffer) {
    headers["Content-Length"] = String(bodyBuffer.byteLength);
  }

  return new Promise<RequestOutcome>((resolve, reject) => {
    let settled = false;
    let req: ClientRequest | null = null;
    const timers = new Set<NodeJS.Timeout>();
    // Set once headers arrive; routes body-phase failures to the body reader.
    let bodyController: { fail: (err: Error) => void } | null = null;

    const timerBag: TimerBag = {
      clearAll() {
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
      },
    };

    const cleanupAgent = () => {
      if (agent && typeof (agent as { destroy?: () => void }).destroy === "function") {
        (agent as { destroy: () => void }).destroy();
      }
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      timerBag.clearAll();
      if (options.signal)
        options.signal.removeEventListener("abort", onAbort);
      req?.destroy();
      cleanupAgent();
      reject(err);
    };

    // Fatal condition (timeout/abort): before headers reject the request
    // promise; during the body phase reject the body reader instead.
    const onFatal = (err: Error) => {
      if (bodyController) bodyController.fail(err);
      else fail(err);
    };

    const onAbort = () => {
      const reason =
        options.signal?.reason instanceof Error
          ? options.signal.reason
          : abortError();
      onFatal(reason);
    };

    if (options.signal) {
      if (options.signal.aborted) {
        cleanupAgent();
        reject(abortError());
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    const totalTimer = setTimeout(
      () => onFatal(new TransportTimeoutError("上游总超时")),
      totalTimeoutMs,
    );
    timers.add(totalTimer);

    req = requestImpl(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: options.method ?? "GET",
        headers,
        agent,
      },
      (res) => {
        const location = res.headers.location;
        const status = res.statusCode ?? 0;
        const isRedirect =
          status >= 300 && status < 400 && typeof location === "string";

        if (isRedirect) {
          // Drain and discard the redirect body, keep the connection tidy.
          res.resume();
          if (!settled) {
            settled = true;
            timerBag.clearAll();
            if (options.signal)
              options.signal.removeEventListener("abort", onAbort);
            cleanupAgent();
            const redirectResponse = new NodeTransportResponse(
              status,
              res.statusMessage ?? "",
              toHeaders(res.headers),
              { res, armIdle: () => undefined, finalize: () => undefined },
            );
            resolve({
              type: "redirect",
              location: location!,
              response: redirectResponse,
            });
          }
          return;
        }

        // Pause until a consumer (stream or buffered) attaches, so no chunk is
        // lost between headers and consumption.
        res.pause();

        let idleTimer: NodeJS.Timeout | null = null;
        let finalized = false;
        const armIdle = () => {
          if (idleTimer) {
            clearTimeout(idleTimer);
            timers.delete(idleTimer);
          }
          idleTimer = setTimeout(
            () => bodyController?.fail(new TransportTimeoutError("上游空闲超时")),
            idleTimeoutMs,
          );
          timers.add(idleTimer);
        };
        const finalize = () => {
          if (finalized) return;
          finalized = true;
          timerBag.clearAll();
          if (options.signal)
            options.signal.removeEventListener("abort", onAbort);
          cleanupAgent();
        };

        const response = new NodeTransportResponse(
          status,
          res.statusMessage ?? "",
          toHeaders(res.headers),
          { res, maxResponseBytes, armIdle, finalize },
        );

        bodyController = { fail: (err) => response.fail(err) };
        armIdle();

        if (!settled) {
          settled = true;
          resolve({ type: "response", response });
        }
      },
    );

    req.setTimeout(connectTimeoutMs, () => {
      fail(new TransportTimeoutError("上游连接超时"));
    });
    req.on("error", (err) => fail(err));

    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}

function normalizeBody(
  body: string | Buffer | Uint8Array | null | undefined,
): Buffer | null {
  if (body == null) return null;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  return Buffer.from(body);
}

function toHeaders(raw: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  return headers;
}

function abortError(): Error {
  const err = new Error("请求已取消");
  err.name = "AbortError";
  return err;
}
