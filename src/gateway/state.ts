/**
 * Gateway runtime state: listener address and the live daemon instance.
 * Kept in its own file/port namespace so the outward-facing gateway never
 * interferes with the local bridge.
 */

import { chmodSync, existsSync, readFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { atomicWriteFile, ensureDir } from "../utils/fs.js";
import { getGatewayDir, getGatewayStatePath } from "../utils/paths.js";
import {
  DEFAULT_GATEWAY_HOST,
  DEFAULT_GATEWAY_PORT,
  type GatewayInstanceState,
  type GatewayListenerState,
  type GatewayRuntimeState,
} from "./types.js";

const STATE_VERSION = 1 as const;
const MAX_PID = 2_147_483_647;

export function generateGatewayControlToken(): string {
  return randomBytes(32).toString("base64url");
}

export function constantTimeTokenEqual(
  a: string | undefined | null,
  b: string | undefined | null,
): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function isValidPid(pid: unknown): pid is number {
  return (
    typeof pid === "number" &&
    Number.isInteger(pid) &&
    pid >= 1 &&
    pid <= MAX_PID
  );
}

function defaultListener(): GatewayListenerState {
  return {
    bindHost: process.env.LLM_SWITCH_GATEWAY_HOST || DEFAULT_GATEWAY_HOST,
    advertiseHost: process.env.LLM_SWITCH_GATEWAY_HOST || DEFAULT_GATEWAY_HOST,
    port: Number(process.env.LLM_SWITCH_GATEWAY_PORT) || DEFAULT_GATEWAY_PORT,
    allowRemote: false,
  };
}

function parseListener(raw: unknown): GatewayListenerState {
  const fallback = defaultListener();
  if (!raw || typeof raw !== "object") return fallback;
  const row = raw as Record<string, unknown>;
  return {
    bindHost:
      typeof row.bindHost === "string" ? row.bindHost : fallback.bindHost,
    advertiseHost:
      typeof row.advertiseHost === "string"
        ? row.advertiseHost
        : fallback.advertiseHost,
    port: typeof row.port === "number" ? row.port : fallback.port,
    allowRemote: row.allowRemote === true,
  };
}

function parseInstance(raw: unknown): GatewayInstanceState | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (
    typeof row.id !== "string" ||
    typeof row.controlToken !== "string" ||
    !isValidPid(row.pid)
  ) {
    return null;
  }
  return {
    id: row.id,
    controlToken: row.controlToken,
    pid: row.pid,
    startedAt: typeof row.startedAt === "string" ? row.startedAt : "",
  };
}

export function readGatewayState(): GatewayRuntimeState {
  const path = getGatewayStatePath();
  if (!existsSync(path)) {
    return {
      version: STATE_VERSION,
      revision: 0,
      listener: defaultListener(),
      instance: null,
    };
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    return {
      version: STATE_VERSION,
      revision: typeof raw.revision === "number" ? raw.revision : 0,
      listener: parseListener(raw.listener),
      instance: parseInstance(raw.instance),
    };
  } catch {
    return {
      version: STATE_VERSION,
      revision: 0,
      listener: defaultListener(),
      instance: null,
    };
  }
}

function persist(state: GatewayRuntimeState): void {
  ensureDir(getGatewayDir());
  try {
    chmodSync(getGatewayDir(), 0o700);
  } catch {
    // Windows relies on user-directory ACLs.
  }
  atomicWriteFile(
    getGatewayStatePath(),
    JSON.stringify(
      {
        version: STATE_VERSION,
        revision: state.revision,
        listener: state.listener,
        instance: state.instance,
      },
      null,
      2,
    ) + "\n",
  );
}

export function updateGatewayState(
  mutate: (current: GatewayRuntimeState) => GatewayRuntimeState,
): GatewayRuntimeState {
  const current = readGatewayState();
  const mutated = mutate(current);
  const next: GatewayRuntimeState = {
    version: STATE_VERSION,
    revision: current.revision + 1,
    listener: mutated.listener,
    instance: mutated.instance,
  };
  persist(next);
  return next;
}

function hostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/** Root URL third parties connect to (clients append /v1/...). */
export function gatewayRootUrl(state?: GatewayRuntimeState): string {
  const current = state || readGatewayState();
  return `http://${hostForUrl(current.listener.advertiseHost)}:${current.listener.port}`;
}

/** OpenAI-style base URL (includes /v1). */
export function gatewayBaseUrl(state?: GatewayRuntimeState): string {
  return `${gatewayRootUrl(state)}/v1`;
}
