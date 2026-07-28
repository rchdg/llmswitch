import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Profile, Tool } from "../types.js";
import { normalizeBaseUrlForFormat } from "../utils/base-url.js";
import {
  bridgeBaseUrl,
  bridgeRootUrl,
  getBridgePidPath,
  readBridgeState,
  readBridgeUpstreams,
  writeBridgeState,
  writeBridgeUpstream,
} from "./state.js";
import {
  DEFAULT_BRIDGE_HOST,
  DEFAULT_BRIDGE_PORT,
  emptyUpstreams,
  hasAnyUpstream,
  type BridgeTool,
  type BridgeUpstream,
  type BridgeUpstreamMode,
} from "./types.js";
import { listenBridge } from "./server.js";

export function profileNeedsBridge(profile: Profile): boolean {
  return profile.apiFormat === "openai-chat";
}

export function bridgeToolForCliTool(tool: Tool): BridgeTool | null {
  if (tool === "codex" || tool === "claude") return tool;
  return null;
}

export function upstreamFromProfile(
  profile: Profile,
  tool: BridgeTool,
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
  };
}

export type BridgeProbe = {
  /** TCP/HTTP responded at all (including old incompatible bridge). */
  reachable: boolean;
  /** Current bridge health payload with ok + upstreams. */
  healthy: boolean;
};

/**
 * Probe local bridge. Old builds may return 503 without `upstreams` — treat as
 * reachable but not healthy so callers can restart.
 */
export async function probeBridge(
  host = readBridgeState().host,
  port = readBridgeState().port,
): Promise<BridgeProbe> {
  try {
    const res = await fetch(`http://${host}:${port}/health`, {
      signal: AbortSignal.timeout(800),
    });
    let body: Record<string, unknown> | null = null;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      body = null;
    }
    const healthy =
      res.ok && body?.ok === true && body != null && "upstreams" in body;
    return { reachable: true, healthy };
  } catch {
    return { reachable: false, healthy: false };
  }
}

export async function isBridgeAlive(
  host = readBridgeState().host,
  port = readBridgeState().port,
): Promise<boolean> {
  return (await probeBridge(host, port)).healthy;
}

export function readPid(): number | null {
  const path = getBridgePidPath();
  if (!existsSync(path)) return null;
  const n = Number(readFileSync(path, "utf8").trim());
  return Number.isFinite(n) ? n : null;
}

export function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function urlForTool(
  tool: BridgeTool,
  host: string,
  port: number,
  pid: number | null,
): string {
  const upstreams = readBridgeUpstreams();
  const state = { host, port, upstreams, pid };
  return tool === "claude" ? bridgeRootUrl(state) : bridgeBaseUrl(state);
}

/**
 * Configure per-tool upstream and ensure local bridge is listening.
 * Returns Codex base (`…/v1`) or Claude root (`…` without /v1).
 */
export async function ensureBridgeForProfile(
  profile: Profile,
  tool: BridgeTool,
): Promise<string> {
  const upstream = upstreamFromProfile(profile, tool);
  writeBridgeUpstream(tool, upstream);

  const state = readBridgeState();
  const host = state.host || DEFAULT_BRIDGE_HOST;
  const port =
    Number(process.env.LLM_SWITCH_BRIDGE_PORT) ||
    state.port ||
    DEFAULT_BRIDGE_PORT;

  const upstreams = readBridgeUpstreams();
  writeBridgeState({
    ...state,
    host,
    port,
    upstreams,
    pid: state.pid,
  });

  const probe = await probeBridge(host, port);
  if (probe.healthy) {
    return urlForTool(tool, host, port, state.pid);
  }

  // Stale / incompatible process holding the port (e.g. pre-dual-upstream build).
  if (probe.reachable) {
    await forceStopBridge(host, port);
  }

  await startBridgeDaemon(host, port);
  for (let i = 0; i < 50; i++) {
    if (await isBridgeAlive(host, port)) {
      return urlForTool(tool, host, port, readPid());
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `Bridge 启动超时（${host}:${port}）。可手动运行：llms bridge serve`,
  );
}

export async function clearBridgeUpstream(tool: BridgeTool): Promise<void> {
  writeBridgeUpstream(tool, null);
  const upstreams = readBridgeUpstreams();
  if (!hasAnyUpstream(upstreams)) {
    await stopBridge();
  }
}

export async function startBridgeDaemon(
  host = DEFAULT_BRIDGE_HOST,
  port = DEFAULT_BRIDGE_PORT,
): Promise<number> {
  if (await isBridgeAlive(host, port)) {
    return readPid() || 0;
  }

  const probe = await probeBridge(host, port);
  if (probe.reachable) {
    await forceStopBridge(host, port);
  }

  const entry = resolveCliEntry();
  const child = spawn(
    process.execPath,
    [entry, "bridge", "serve", "--host", host, "--port", String(port)],
    {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        LLM_SWITCH_BRIDGE_PORT: String(port),
        LLM_SWITCH_BRIDGE_HOST: host,
      },
    },
  );
  child.unref();
  const pid = child.pid;
  if (!pid) throw new Error("无法启动 bridge 进程");

  const state = readBridgeState();
  writeBridgeState({
    ...state,
    host,
    port,
    pid,
    upstreams: state.upstreams,
  });
  return pid;
}

/** Stop by recorded pid, then free the listen port if still held. */
export async function forceStopBridge(
  host = readBridgeState().host,
  port = readBridgeState().port,
): Promise<void> {
  await stopBridge();
  await killListenersOnPort(port);
  // Brief wait so TIME_WAIT / bind release settles.
  for (let i = 0; i < 20; i++) {
    const probe = await probeBridge(host, port);
    if (!probe.reachable) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function stopBridge(): Promise<boolean> {
  const state = readBridgeState();
  const pid = state.pid || readPid();
  let stopped = false;
  if (pid && isPidRunning(pid)) {
    try {
      process.kill(pid, "SIGTERM");
      stopped = true;
    } catch {
      // ignore
    }
  }
  writeBridgeState({
    ...state,
    pid: null,
    upstreams: state.upstreams,
  });
  return stopped;
}

function killListenersOnPort(port: number): void {
  if (process.platform === "win32") return;
  try {
    const out = execFileSync(
      "lsof",
      ["-ti", `tcp:${port}`, `-sTCP:LISTEN`],
      { encoding: "utf8" },
    );
    for (const line of out.split(/\n/)) {
      const pid = Number(line.trim());
      if (!pid || pid === process.pid) continue;
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // ignore
      }
    }
  } catch {
    // lsof miss / no listeners — ignore
  }
}

export async function runBridgeForeground(
  host: string,
  port: number,
): Promise<void> {
  const state = readBridgeState();
  writeBridgeState({
    ...state,
    host,
    port,
    pid: process.pid,
    upstreams: state.upstreams.codex || state.upstreams.claude
      ? state.upstreams
      : readBridgeUpstreams() || emptyUpstreams(),
  });

  const server = await listenBridge(port, host);
  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.error(
    `llm-switch bridge listening on http://${host}:${port} (POST /v1/responses · POST /v1/messages → upstream chat/completions)`,
  );
  await new Promise(() => undefined);
}

/**
 * Prefer the entry currently running this CLI so `bun run ./src/index.ts`
 * respawns the same source tree; published installs use dist/index.js.
 */
function resolveCliEntry(): string {
  const running = process.argv[1];
  if (running && existsSync(running)) {
    return running;
  }
  const compiled = fileURLToPath(new URL("../index.js", import.meta.url));
  if (existsSync(compiled)) return compiled;
  const source = fileURLToPath(new URL("../index.ts", import.meta.url));
  if (existsSync(source)) return source;
  throw new Error("无法定位 llmswitch 入口文件");
}
