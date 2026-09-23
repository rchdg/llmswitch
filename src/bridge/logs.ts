/**
 * In-process request log for the bridge data plane.
 *
 * A fixed-size ring buffer in bridge process memory — no disk writes, no
 * persistence. Third-party upstreams fail in confusing ways (HTML error
 * pages, silent 401s, wrong model ids), and this is what `llms bridge logs`
 * reads through the control endpoint.
 */

export interface BridgeLogEntry {
  /** ISO timestamp of request completion. */
  ts: string;
  /** Which tool side handled it: codex / claude / opencode. */
  tool: string;
  method: string;
  path: string;
  model?: string;
  status: number;
  durationMs: number;
  stream: boolean;
  /** Short error summary when the request failed upstream. */
  error?: string;
  /** Profile that actually served the request (differs after failover). */
  upstream?: string;
}

const MAX_ENTRIES = 200;

const buffer: BridgeLogEntry[] = [];

export function recordBridgeLog(entry: BridgeLogEntry): void {
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.shift();
}

export function recentBridgeLogs(limit = 50): BridgeLogEntry[] {
  const count = Math.max(0, Math.min(limit, MAX_ENTRIES));
  return buffer.slice(-count).reverse();
}

/** Attach completion tracking to a data-plane request. */
export function attachBridgeLog(
  res: import("node:http").ServerResponse,
  base: { tool: string; method: string; path: string; stream: boolean },
): void {
  const startedAt = Date.now();
  let model: string | undefined;
  let upstream: string | undefined;
  let error: string | undefined;
  const tracked = res as import("node:http").ServerResponse & {
    __bridgeLog?: TrackedFields;
  };
  tracked.__bridgeLog = {
    setModel(value: string) {
      model = value;
    },
    setUpstream(value: string) {
      upstream = value;
    },
    setError(value: string) {
      if (!error) error = value.slice(0, 200);
    },
  };
  res.once("finish", () => {
    recordBridgeLog({
      ts: new Date().toISOString(),
      tool: base.tool,
      method: base.method,
      path: base.path,
      model,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
      stream: base.stream,
      error,
      upstream,
    });
  });
}

interface TrackedFields {
  setModel(value: string): void;
  setUpstream(value: string): void;
  setError(value: string): void;
}

type TrackedResponse = import("node:http").ServerResponse & {
  __bridgeLog?: TrackedFields | undefined;
};

/** Record the model id once the handler has parsed the request body. */
export function markBridgeModel(
  res: import("node:http").ServerResponse,
  model: string,
): void {
  (res as TrackedResponse).__bridgeLog?.setModel(model);
}

/** Record the profile that actually served the request (failover-aware). */
export function markBridgeUpstream(
  res: import("node:http").ServerResponse,
  upstream: string,
): void {
  (res as TrackedResponse).__bridgeLog?.setUpstream(upstream);
}

/** Record the first error summary for the in-flight request. */
export function markBridgeError(
  res: import("node:http").ServerResponse,
  message: string,
): void {
  (res as TrackedResponse).__bridgeLog?.setError(message);
}
