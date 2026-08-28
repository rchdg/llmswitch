/**
 * Gateway daemon lifecycle: probe, start, stop, foreground run.
 *
 * Mirrors the bridge manager's cooperative-shutdown model — the daemon is only
 * ever asked to exit through an authenticated control call, never signalled by
 * PID — but uses its own port, state file and log file.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, openSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir } from "../utils/fs.js";
import { getGatewayDir } from "../utils/paths.js";
import { formatHostForUrl } from "../bridge/runtime.js";
import {
  generateGatewayControlToken,
  gatewayRootUrl,
  readGatewayState,
  updateGatewayState,
} from "./state.js";
import { resolveGatewayListener } from "./runtime.js";
import { listenGateway } from "./server.js";
import {
  DEFAULT_GATEWAY_HOST,
  DEFAULT_GATEWAY_PORT,
  type GatewayInstanceState,
} from "./types.js";

export class GatewayPortOccupiedError extends Error {
  constructor(host: string, port: number) {
    super(
      `端口 ${host}:${port} 已被其他进程占用；为避免误杀，llm-switch 不会自动终止该进程。`,
    );
    this.name = "GatewayPortOccupiedError";
  }
}

export class GatewayControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayControlError";
  }
}

export function getGatewayLogPath(): string {
  return join(getGatewayDir(), "gateway.log");
}

const LOG_ROTATE_BYTES = 10 * 1024 * 1024;

/** Size-based rotation at process start: gateway.log → gateway.log.old. */
export function rotateGatewayLogIfNeeded(): void {
  const path = getGatewayLogPath();
  try {
    if (statSync(path).size < LOG_ROTATE_BYTES) return;
    rmSync(`${path}.old`, { force: true });
    renameSync(path, `${path}.old`);
  } catch {
    // No log file yet, or rotation raced with another process; keep going.
  }
}

function controlUrl(host: string, port: number, path: string): string {
  return `http://${formatHostForUrl(host)}:${port}${path}`;
}

export interface GatewayProbe {
  reachable: boolean;
  healthy: boolean;
  instanceId?: string;
  startedAt?: string;
  uptimeSeconds?: number;
  stats?: {
    requests: number;
    errors4xx: number;
    errors5xx: number;
    activeConnections: number;
    maxConcurrency: number;
  };
  /** Provider cooldown states reported by the daemon (token-authenticated). */
  breakers?: Array<{
    provider: string;
    consecutiveFailures: number;
    coolingMsRemaining: number;
    lastError: string;
  }>;
}

export async function probeGateway(
  host = readGatewayState().listener.advertiseHost,
  port = readGatewayState().listener.port,
): Promise<GatewayProbe> {
  const expected = readGatewayState().instance;
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
    const breakers = Array.isArray(body?.breakers)
      ? (body!.breakers as GatewayProbe["breakers"])
      : undefined;
    const stats = body?.stats as GatewayProbe["stats"];
    return {
      reachable: true,
      healthy: Boolean(
        response.ok && expected && instanceId && instanceId === expected.id,
      ),
      instanceId,
      ...(typeof body?.startedAt === "string"
        ? { startedAt: body.startedAt }
        : {}),
      ...(typeof body?.uptimeSeconds === "number"
        ? { uptimeSeconds: body.uptimeSeconds }
        : {}),
      ...(stats && typeof stats === "object" ? { stats } : {}),
      breakers,
    };
  } catch {
    return { reachable: false, healthy: false };
  }
}

export async function isGatewayAlive(
  host = readGatewayState().listener.advertiseHost,
  port = readGatewayState().listener.port,
): Promise<boolean> {
  return (await probeGateway(host, port)).healthy;
}

export function readGatewayPid(): number | null {
  return readGatewayState().instance?.pid ?? null;
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

/**
 * Resolve how the detached daemon is launched. Node is preferred: Bun resolves
 * target DNS locally, which defeats socks5h remote DNS for proxied upstreams.
 */
function resolveDaemonRunner(): { command: string; entry: string } {
  const candidates = [
    fileURLToPath(new URL("../index.js", import.meta.url)),
    fileURLToPath(new URL("../../dist/index.js", import.meta.url)),
    fileURLToPath(new URL("../index.ts", import.meta.url)),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate.endsWith(".js")
        ? { command: "node", entry: candidate }
        : { command: process.execPath, entry: candidate };
    }
  }
  const running = process.argv[1];
  if (running && existsSync(running)) {
    return { command: process.execPath, entry: running };
  }
  throw new GatewayControlError("无法定位 llmswitch 入口文件");
}

export async function startGatewayDaemon(
  host = DEFAULT_GATEWAY_HOST,
  port = DEFAULT_GATEWAY_PORT,
  allowRemote = false,
): Promise<number> {
  const listener = resolveGatewayListener({ host, port, allowRemote });
  const probe = await probeGateway(listener.advertiseHost, listener.port);
  if (probe.healthy) return readGatewayPid() || 0;
  if (probe.reachable) {
    throw new GatewayPortOccupiedError(listener.bindHost, listener.port);
  }

  updateGatewayState((state) => ({ ...state, listener, instance: null }));

  ensureDir(getGatewayDir());
  rotateGatewayLogIfNeeded();
  const logFd = openSync(getGatewayLogPath(), "a");
  const runner = resolveDaemonRunner();
  const args = [
    runner.entry,
    "gateway",
    "serve",
    "--host",
    listener.bindHost,
    "--port",
    String(listener.port),
  ];
  if (allowRemote) args.push("--allow-remote");

  const child = spawn(runner.command, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      LLM_SWITCH_GATEWAY_HOST: listener.bindHost,
      LLM_SWITCH_GATEWAY_PORT: String(listener.port),
      LLM_SWITCH_GATEWAY_RUNTIME: runner.command,
    },
  });
  child.unref();
  if (!child.pid) throw new GatewayControlError("无法启动 gateway 进程");
  return child.pid;
}

export async function stopGateway(): Promise<boolean> {
  const state = readGatewayState();
  const instance = state.instance;
  if (!instance) return false;
  const probe = await probeGateway(
    state.listener.advertiseHost,
    state.listener.port,
  );
  if (!probe.reachable) {
    // Stale identity: the process is gone, so clear it instead of erroring.
    updateGatewayState((current) =>
      current.instance?.id === instance.id
        ? { ...current, instance: null }
        : current,
    );
    return false;
  }
  if (!probe.healthy || probe.instanceId !== instance.id) {
    throw new GatewayControlError(
      "无法验证 gateway 实例身份；为避免误杀，未发送任何进程信号。",
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
    throw new GatewayControlError(
      `Gateway 协作关闭失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new GatewayControlError(
      `Gateway 拒绝关闭请求（HTTP ${response.status}）`,
    );
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (readGatewayState().instance?.id !== instance.id) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new GatewayControlError(
    "Gateway 已接受关闭请求，但未在宽限期内清除实例身份",
  );
}

export async function runGatewayForeground(
  host: string,
  port: number,
  allowRemote = false,
): Promise<void> {
  ensureDir(getGatewayDir());
  rotateGatewayLogIfNeeded();
  const listener = resolveGatewayListener({ host, port, allowRemote });
  const previous = readGatewayState();
  const instance: GatewayInstanceState = {
    id: randomUUID(),
    controlToken: generateGatewayControlToken(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  updateGatewayState((state) => ({ ...state, listener, instance }));

  let resolveClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let server: Awaited<ReturnType<typeof listenGateway>> | null = null;
  let closing = false;

  const clearIdentity = () => {
    updateGatewayState((state) =>
      state.instance?.id === instance.id
        ? { ...state, instance: null }
        : state,
    );
  };

  const shutdown = async (requestedId = instance.id): Promise<void> => {
    if (requestedId !== instance.id || closing) return;
    closing = true;
    if (server) {
      const forceTimer = setTimeout(
        () => server?.closeAllConnections(),
        30_000,
      );
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      clearTimeout(forceTimer);
    }
    clearIdentity();
    resolveClosed?.();
  };

  try {
    server = await listenGateway(listener.port, listener.bindHost, {
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
      throw new GatewayPortOccupiedError(listener.bindHost, listener.port);
    }
    updateGatewayState((state) =>
      state.instance ? state : { ...state, listener: previous.listener },
    );
    throw error;
  }

  const onSignal = () => {
    void shutdown();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  console.error(
    `llm-switch gateway listening on ${gatewayRootUrl(readGatewayState())}` +
      `（bind ${formatHostForUrl(listener.bindHost)}:${listener.port}${listener.allowRemote ? "，已对外暴露" : ""}）`,
  );
  await closed;
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
}
