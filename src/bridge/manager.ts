import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Profile, Tool } from "../types.js";
import { normalizeBaseUrlForFormat } from "../utils/base-url.js";
import {
  bridgeBaseUrl,
  bridgeRootUrl,
  generateBridgeToken,
  readBridgeState,
  updateBridgeState,
  writeBridgeUpstream,
} from "./state.js";
import {
  DEFAULT_BRIDGE_HOST,
  DEFAULT_BRIDGE_PORT,
  hasAnyUpstream,
  type BridgeInstanceState,
  type BridgeRuntimeState,
  type BridgeTool,
  type BridgeUpstream,
  type BridgeUpstreamMode,
} from "./types.js";
import {
  assertBridgeListenerAllowed,
  formatHostForUrl,
  parseBridgePort,
  resolveBridgeListener,
} from "./runtime.js";
import { listenBridge } from "./server.js";

export class PortOccupiedError extends Error {
  constructor(host: string, port: number) {
    super(`端口 ${host}:${port} 已被其他进程占用；为避免误杀，llm-switch 不会自动终止该进程。`);
    this.name = "PortOccupiedError";
  }
}

export class LegacyBridgeRunningError extends Error {
  constructor(host: string, port: number) {
    super(
      `检测到旧版 bridge 正在 ${host}:${port} 运行。请先执行 llms bridge stop --legacy 并确认风险，然后重试。`,
    );
    this.name = "LegacyBridgeRunningError";
  }
}

export class BridgeControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeControlError";
  }
}

export interface BridgeConnection {
  baseUrl: string;
  clientToken: string;
}

export function profileNeedsBridge(profile: Profile): boolean {
  return profile.apiFormat === "openai-chat";
}

function isBunRuntime(): boolean {
  return typeof (process as { versions?: { bun?: string } }).versions?.bun ===
    "string";
}

export function bridgeToolForCliTool(tool: Tool): BridgeTool | null {
  return tool === "codex" || tool === "claude" || tool === "opencode"
    ? tool
    : null;
}

export function upstreamFromProfile(
  profile: Profile,
  tool: BridgeTool,
  clientToken: string | null = null,
): BridgeUpstream {
  const mode: BridgeUpstreamMode =
    tool === "claude" ? "chat" : profile.bridgeMode || "chat";
  return {
    baseUrl: normalizeBaseUrlForFormat(profile.apiFormat, profile.baseUrl),
    apiKey: profile.apiKey,
    mode,
    proxy: profile.proxy,
    headers: profile.headers,
    profileName: profile.name,
    updatedAt: new Date().toISOString(),
    clientToken,
    migrationRequired: !clientToken,
  };
}

export type BridgeProbe = {
  reachable: boolean;
  healthy: boolean;
  authenticated: boolean;
  legacy: boolean;
  instanceId?: string;
};

function controlUrl(host: string, port: number, path: string): string {
  return `http://${formatHostForUrl(host)}:${port}${path}`;
}

export async function probeBridge(
  host = readBridgeState().listener.advertiseHost,
  port = readBridgeState().listener.port,
): Promise<BridgeProbe> {
  const state = readBridgeState();
  const expected = state.instance;
  try {
    const headers: Record<string, string> = {};
    if (expected?.controlToken) {
      headers["x-llm-switch-control"] = expected.controlToken;
    }
    const response = await fetch(controlUrl(host, port, "/health"), {
      headers,
      signal: AbortSignal.timeout(800),
    });
    let body: Record<string, unknown> | null = null;
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      body = null;
    }
    const instanceId =
      typeof body?.instanceId === "string" ? body.instanceId : undefined;
    const authenticated = Boolean(
      response.ok &&
        expected &&
        instanceId &&
        instanceId === expected.id,
    );
    const legacy = Boolean(
      response.ok &&
        body?.ok === true &&
        body != null &&
        "upstreams" in body &&
        !("service" in body),
    );
    return {
      reachable: true,
      healthy: authenticated,
      authenticated,
      legacy,
      instanceId,
    };
  } catch {
    return {
      reachable: false,
      healthy: false,
      authenticated: false,
      legacy: false,
    };
  }
}

export async function isBridgeAlive(
  host = readBridgeState().listener.advertiseHost,
  port = readBridgeState().listener.port,
): Promise<boolean> {
  return (await probeBridge(host, port)).healthy;
}

export function readPid(): number | null {
  return readBridgeState().instance?.pid ?? null;
}

export function isPidRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1 || pid > 2_147_483_647) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function connectionForTool(
  tool: BridgeTool,
  state: BridgeRuntimeState,
  clientToken: string,
): BridgeConnection {
  return {
    baseUrl: tool === "claude" ? bridgeRootUrl(state) : bridgeBaseUrl(state),
    clientToken,
  };
}

function desiredListener(): ReturnType<typeof resolveBridgeListener> {
  const current = readBridgeState();
  const host = process.env.LLM_SWITCH_BRIDGE_HOST || current.listener.bindHost;
  const port = process.env.LLM_SWITCH_BRIDGE_PORT
    ? parseBridgePort(process.env.LLM_SWITCH_BRIDGE_PORT)
    : current.listener.port;
  const allowRemote = current.listener.allowRemote;
  return resolveBridgeListener({ host, port, allowRemote });
}

/**
 * Preflight the listen address before writing an upstream, then configure the
 * side and ensure an authenticated v2 daemon is running.
 */
export async function ensureBridgeForProfile(
  profile: Profile,
  tool: BridgeTool,
): Promise<BridgeConnection> {
  const listener = desiredListener();
  const before = await probeBridge(listener.advertiseHost, listener.port);
  if (before.reachable && !before.healthy) {
    if (before.legacy) {
      throw new LegacyBridgeRunningError(listener.bindHost, listener.port);
    }
    throw new PortOccupiedError(listener.bindHost, listener.port);
  }

  const clientToken = generateBridgeToken();
  const upstream = upstreamFromProfile(profile, tool, clientToken);
  const configured = updateBridgeState((state) => ({
    ...state,
    listener,
    host: listener.advertiseHost,
    port: listener.port,
    upstreams: { ...state.upstreams, [tool]: upstream },
  }));

  if (!before.healthy) {
    await startBridgeDaemon(listener.bindHost, listener.port, listener.allowRemote);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await isBridgeAlive(listener.advertiseHost, listener.port)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!(await isBridgeAlive(listener.advertiseHost, listener.port))) {
      throw new BridgeControlError(
        `Bridge 启动超时（${listener.bindHost}:${listener.port}）。可手动运行：llms bridge serve`,
      );
    }
  }
  return connectionForTool(tool, readBridgeState() || configured, clientToken);
}

export async function clearBridgeUpstream(tool: BridgeTool): Promise<void> {
  writeBridgeUpstream(tool, null);
  const state = readBridgeState();
  if (!hasAnyUpstream(state.upstreams) && state.instance) {
    await stopBridge();
  }
}

export async function startBridgeDaemon(
  host = DEFAULT_BRIDGE_HOST,
  port = DEFAULT_BRIDGE_PORT,
  allowRemote = false,
): Promise<number> {
  const listener = resolveBridgeListener({ host, port, allowRemote });
  const probe = await probeBridge(listener.advertiseHost, listener.port);
  if (probe.healthy) return readPid() || 0;
  if (probe.reachable) {
    if (probe.legacy) throw new LegacyBridgeRunningError(host, port);
    throw new PortOccupiedError(host, port);
  }

  updateBridgeState((state) => ({
    ...state,
    listener,
    host: listener.advertiseHost,
    port: listener.port,
    instance: null,
    pid: null,
  }));

  const runner = resolveBridgeDaemonRunner();
  const args = [
    runner.entry,
    "bridge",
    "serve",
    "--host",
    host,
    "--port",
    String(port),
  ];
  if (allowRemote) args.push("--allow-remote");
  const child = spawn(runner.command, args, {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      LLM_SWITCH_BRIDGE_PORT: String(port),
      LLM_SWITCH_BRIDGE_HOST: host,
      LLM_SWITCH_BRIDGE_RUNTIME: runner.command,
    },
  });
  child.unref();
  if (!child.pid) throw new BridgeControlError("无法启动 bridge 进程");
  return child.pid;
}

export async function stopBridge(): Promise<boolean> {
  const state = readBridgeState();
  const instance = state.instance;
  if (!instance) return false;
  const probe = await probeBridge(
    state.listener.advertiseHost,
    state.listener.port,
  );
  if (!probe.authenticated || probe.instanceId !== instance.id) {
    throw new BridgeControlError(
      "无法验证 bridge 实例身份；为避免误杀，未发送任何进程信号。",
    );
  }
  let response: Response;
  try {
    response = await fetch(
      controlUrl(
        state.listener.advertiseHost,
        state.listener.port,
        "/_control/shutdown",
      ),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-llm-switch-control": instance.controlToken,
        },
        body: JSON.stringify({ instanceId: instance.id }),
        signal: AbortSignal.timeout(2_000),
      },
    );
  } catch (error) {
    throw new BridgeControlError(
      `Bridge 协作关闭失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new BridgeControlError(`Bridge 拒绝关闭请求（HTTP ${response.status}）`);
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (readBridgeState().instance?.id !== instance.id) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new BridgeControlError("Bridge 已接受关闭请求，但未在宽限期内清除实例身份");
}

/** Compatibility alias: v2 never force-kills a listener. */
export async function forceStopBridge(): Promise<void> {
  await stopBridge();
}

export async function runBridgeForeground(
  host: string,
  port: number,
  allowRemote = false,
): Promise<void> {
  if (process.env.LLM_SWITCH_BRIDGE_RUNTIME !== "node" && isBunRuntime()) {
    console.error(
      "注意：bridge 当前由 Bun 运行，Bun 会本地解析 DNS，可能导致 socks5h 代理出口地区错误。建议用「node dist/index.js bridge serve」运行。",
    );
  }
  assertBridgeListenerAllowed(host, allowRemote);
  const listener = resolveBridgeListener({ host, port, allowRemote });
  const previous = readBridgeState();
  const instance: BridgeInstanceState = {
    id: randomUUID(),
    controlToken: generateBridgeToken(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  updateBridgeState((state) => ({
    ...state,
    listener,
    host: listener.advertiseHost,
    port: listener.port,
    pid: process.pid,
    instance,
  }));

  let resolveClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let server: Awaited<ReturnType<typeof listenBridge>> | null = null;
  let closing = false;

  const clearIdentity = () => {
    updateBridgeState((state) =>
      state.instance?.id === instance.id
        ? { ...state, instance: null, pid: null }
        : state,
    );
  };

  const shutdown = async (requestedId = instance.id): Promise<void> => {
    if (requestedId !== instance.id || closing) return;
    closing = true;
    if (server) {
      const forceTimer = setTimeout(() => server?.closeAllConnections(), 30_000);
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      clearTimeout(forceTimer);
    }
    clearIdentity();
    resolveClosed?.();
  };

  try {
    server = await listenBridge(listener.port, listener.bindHost, {
      controlToken: instance.controlToken,
      instanceId: instance.id,
      onShutdown: shutdown,
    });
  } catch (error) {
    try {
      clearIdentity();
    } catch {
      // Preserve the original bind error.
    }
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new PortOccupiedError(listener.bindHost, listener.port);
    }
    // Restore the previous listener only when no newer instance replaced us.
    updateBridgeState((state) =>
      state.instance
        ? state
        : {
            ...state,
            listener: previous.listener,
            host: previous.listener.advertiseHost,
            port: previous.listener.port,
          },
    );
    throw error;
  }

  const onSignal = () => {
    void shutdown();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  console.error(
    `llm-switch bridge listening on http://${formatHostForUrl(listener.bindHost)}:${listener.port} (authenticated)`,
  );
  await closed;
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
}

/**
 * Resolve how the detached bridge daemon is launched. The bridge must run under
 * Node.js: Bun's node:https stack resolves target DNS locally, which defeats
 * socks5h remote-DNS and can produce wrong-region egress. Node delegates the
 * hostname to the socks agent, giving correct remote-DNS behavior.
 */
function resolveBridgeDaemonRunner(): { command: string; entry: string } {
  const candidates = [
    fileURLToPath(new URL("../index.js", import.meta.url)),
    fileURLToPath(new URL("../../dist/index.js", import.meta.url)),
    fileURLToPath(new URL("../index.ts", import.meta.url)),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      if (candidate.endsWith(".js")) {
        return { command: "node", entry: candidate };
      }
      return { command: process.execPath, entry: candidate };
    }
  }
  const running = process.argv[1];
  if (running && existsSync(running)) {
    return { command: process.execPath, entry: running };
  }
  throw new BridgeControlError("无法定位 llmswitch 入口文件");
}
