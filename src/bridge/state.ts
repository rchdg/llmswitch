import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, ensureDir } from "../utils/fs.js";
import { getAppConfigRoot } from "../utils/paths.js";
import {
  DEFAULT_BRIDGE_HOST,
  DEFAULT_BRIDGE_PORT,
  emptyUpstreams,
  type BridgeRuntimeState,
  type BridgeTool,
  type BridgeUpstream,
  type BridgeUpstreams,
} from "./types.js";

export function getBridgeDir(): string {
  return join(getAppConfigRoot(), "bridge");
}

export function getBridgeStatePath(): string {
  return join(getBridgeDir(), "state.json");
}

export function getBridgeUpstreamPath(): string {
  return join(getBridgeDir(), "upstream.json");
}

export function getBridgePidPath(): string {
  return join(getBridgeDir(), "bridge.pid");
}

function isLegacyUpstream(raw: unknown): raw is BridgeUpstream {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const row = raw as Record<string, unknown>;
  return typeof row.baseUrl === "string" && !("codex" in row) && !("claude" in row);
}

/**
 * Normalize disk/runtime upstream payloads (legacy single object → per-tool map).
 */
export function normalizeBridgeUpstreams(raw: unknown): BridgeUpstreams {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return emptyUpstreams();
  }
  const row = raw as Record<string, unknown>;
  if (isLegacyUpstream(raw)) {
    return { codex: raw, claude: null };
  }
  return {
    codex: (row.codex as BridgeUpstream | null | undefined) ?? null,
    claude: (row.claude as BridgeUpstream | null | undefined) ?? null,
  };
}

export function readBridgeUpstreams(): BridgeUpstreams {
  const path = getBridgeUpstreamPath();
  if (!existsSync(path)) return emptyUpstreams();
  try {
    return normalizeBridgeUpstreams(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return emptyUpstreams();
  }
}

export function writeBridgeUpstreams(upstreams: BridgeUpstreams): void {
  ensureDir(getBridgeDir());
  atomicWriteFile(
    getBridgeUpstreamPath(),
    JSON.stringify(
      {
        codex: upstreams.codex,
        claude: upstreams.claude,
      },
      null,
      2,
    ) + "\n",
  );
}

export function readBridgeUpstream(tool: BridgeTool = "codex"): BridgeUpstream | null {
  return readBridgeUpstreams()[tool];
}

export function writeBridgeUpstream(
  tool: BridgeTool,
  upstream: BridgeUpstream | null,
): void {
  const current = readBridgeUpstreams();
  current[tool] = upstream;
  writeBridgeUpstreams(current);

  const state = readBridgeStateRaw();
  writeBridgeState({
    ...state,
    upstreams: current,
  });
}

function readBridgeStateRaw(): BridgeRuntimeState {
  const path = getBridgeStatePath();
  const defaults: BridgeRuntimeState = {
    port: Number(process.env.LLM_SWITCH_BRIDGE_PORT) || DEFAULT_BRIDGE_PORT,
    host: process.env.LLM_SWITCH_BRIDGE_HOST || DEFAULT_BRIDGE_HOST,
    pid: null,
    upstreams: readBridgeUpstreams(),
  };
  if (!existsSync(path)) return defaults;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const upstreams = raw.upstreams
      ? normalizeBridgeUpstreams(raw.upstreams)
      : raw.upstream
        ? normalizeBridgeUpstreams(raw.upstream)
        : readBridgeUpstreams();
    return {
      port: (raw.port as number) || defaults.port,
      host: (raw.host as string) || defaults.host,
      pid: (raw.pid as number | null | undefined) ?? null,
      upstreams,
    };
  } catch {
    return defaults;
  }
}

export function readBridgeState(): BridgeRuntimeState {
  return readBridgeStateRaw();
}

export function writeBridgeState(state: BridgeRuntimeState): void {
  ensureDir(getBridgeDir());
  const upstreams = normalizeBridgeUpstreams(state.upstreams);
  atomicWriteFile(
    getBridgeStatePath(),
    JSON.stringify(
      {
        port: state.port,
        host: state.host,
        pid: state.pid,
        upstreams,
      },
      null,
      2,
    ) + "\n",
  );
  writeBridgeUpstreams(upstreams);
  if (state.pid != null) {
    atomicWriteFile(getBridgePidPath(), String(state.pid) + "\n");
  }
}

/** Codex-facing base URL (includes /v1). */
export function bridgeBaseUrl(state?: BridgeRuntimeState): string {
  const s = state || readBridgeState();
  return `http://${s.host}:${s.port}/v1`;
}

/** Claude-facing root URL (no /v1; client appends /v1/messages). */
export function bridgeRootUrl(state?: BridgeRuntimeState): string {
  const s = state || readBridgeState();
  return `http://${s.host}:${s.port}`;
}
