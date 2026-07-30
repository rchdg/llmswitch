import { isIP } from "node:net";
import type { BridgeListenerState } from "./types.js";

export interface BridgeRuntimeLimits {
  maxBodyBytes: number;
  maxResponseBytes: number;
  maxSseFrameBytes: number;
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  totalTimeoutMs: number;
  maxConcurrency: number;
  rateLimitPerMinute: number;
}

export const DEFAULT_BRIDGE_RUNTIME_LIMITS: Readonly<BridgeRuntimeLimits> =
  Object.freeze({
    maxBodyBytes: 16_777_216,
    maxResponseBytes: 33_554_432,
    maxSseFrameBytes: 2_097_152,
    connectTimeoutMs: 30_000,
    idleTimeoutMs: 90_000,
    totalTimeoutMs: 600_000,
    maxConcurrency: 16,
    rateLimitPerMinute: 120,
  });

type RuntimeLimitSpec = {
  env: string;
  key: keyof BridgeRuntimeLimits;
  min: number;
  max: number;
};

const RUNTIME_LIMIT_SPECS: readonly RuntimeLimitSpec[] = [
  {
    env: "LLM_SWITCH_MAX_BODY_BYTES",
    key: "maxBodyBytes",
    min: 1_024,
    max: 67_108_864,
  },
  {
    env: "LLM_SWITCH_MAX_RESPONSE_BYTES",
    key: "maxResponseBytes",
    min: 1_024,
    max: 134_217_728,
  },
  {
    env: "LLM_SWITCH_MAX_SSE_FRAME_BYTES",
    key: "maxSseFrameBytes",
    min: 1_024,
    max: 16_777_216,
  },
  {
    env: "LLM_SWITCH_CONNECT_TIMEOUT_MS",
    key: "connectTimeoutMs",
    min: 1_000,
    max: 120_000,
  },
  {
    env: "LLM_SWITCH_IDLE_TIMEOUT_MS",
    key: "idleTimeoutMs",
    min: 1_000,
    max: 600_000,
  },
  {
    env: "LLM_SWITCH_TOTAL_TIMEOUT_MS",
    key: "totalTimeoutMs",
    min: 1_000,
    max: 3_600_000,
  },
  {
    env: "LLM_SWITCH_MAX_CONCURRENCY",
    key: "maxConcurrency",
    min: 1,
    max: 128,
  },
  {
    env: "LLM_SWITCH_RATE_LIMIT_PER_MINUTE",
    key: "rateLimitPerMinute",
    min: 1,
    max: 10_000,
  },
] as const;

export function parseBridgeRuntimeLimits(
  env: Readonly<Record<string, string | undefined>> = process.env,
): BridgeRuntimeLimits {
  const parsed: BridgeRuntimeLimits = { ...DEFAULT_BRIDGE_RUNTIME_LIMITS };
  for (const spec of RUNTIME_LIMIT_SPECS) {
    const raw = env[spec.env];
    if (raw === undefined) continue;
    if (!/^\d+$/.test(raw)) {
      throw new Error(
        `${spec.env} 必须是 ${spec.min}..${spec.max} 范围内的整数`,
      );
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < spec.min || value > spec.max) {
      throw new Error(
        `${spec.env} 必须是 ${spec.min}..${spec.max} 范围内的整数`,
      );
    }
    parsed[spec.key] = value;
  }
  return parsed;
}

export function parseBridgePort(value: string | number): number {
  const raw = typeof value === "number" ? String(value) : value;
  if (!/^\d+$/.test(raw)) {
    throw new Error("Port 必须是 1..65535 范围内的整数");
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Port 必须是 1..65535 范围内的整数");
  }
  return port;
}

export function normalizeHost(host: string): string {
  const trimmed = host.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseIpv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const byte = Number(part);
    if (byte < 0 || byte > 255) return null;
    bytes.push(byte);
  }
  return bytes;
}

function parseIpv6Groups(value: string): number[] | null {
  let host = value.toLowerCase();
  if (host.includes("%")) return null;

  const lastColon = host.lastIndexOf(":");
  const tail = lastColon >= 0 ? host.slice(lastColon + 1) : host;
  if (tail.includes(".")) {
    const ipv4 = parseIpv4(tail);
    if (!ipv4) return null;
    const high = ((ipv4[0] ?? 0) << 8) | (ipv4[1] ?? 0);
    const low = ((ipv4[2] ?? 0) << 8) | (ipv4[3] ?? 0);
    host = `${host.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`;
  }

  const halves = host.split("::");
  if (halves.length > 2) return null;
  const parseHalf = (half: string): number[] | null => {
    if (!half) return [];
    const groups: number[] = [];
    for (const part of half.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      groups.push(Number.parseInt(part, 16));
    }
    return groups;
  };
  const left = parseHalf(halves[0] ?? "");
  const right = parseHalf(halves[1] ?? "");
  if (!left || !right) return null;

  if (halves.length === 1) {
    return left.length === 8 ? left : null;
  }
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

export function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host).toLowerCase();
  if (normalized === "localhost") return true;

  const ipv4 = parseIpv4(normalized);
  if (ipv4) return ipv4[0] === 127;

  const groups = parseIpv6Groups(normalized);
  if (!groups) return false;
  const isV6Loopback =
    groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
  if (isV6Loopback) return true;

  const isMappedIpv4 =
    groups.slice(0, 5).every((group) => group === 0) &&
    groups[5] === 0xffff;
  return isMappedIpv4 && ((groups[6] ?? 0) >> 8) === 127;
}

export function formatHostForUrl(host: string): string {
  const normalized = normalizeHost(host);
  return isIP(normalized) === 6 || normalized.includes(":")
    ? `[${normalized}]`
    : normalized;
}

export function assertBridgeListenerAllowed(
  host: string,
  allowRemote: boolean,
): void {
  if (!isLoopbackHost(host) && !allowRemote) {
    throw new Error(
      `非回环 bridge 监听地址 ${host || "(empty)"} 必须显式传入 --allow-remote`,
    );
  }
}

export function advertiseHostForBind(host: string): string {
  const normalized = normalizeHost(host);
  if (!normalized || normalized === "0.0.0.0") return "127.0.0.1";
  if (normalized === "::") return "::1";
  return normalized;
}

export function resolveBridgeListener(options: {
  host: string;
  port: string | number;
  allowRemote: boolean;
  advertiseHost?: string;
}): BridgeListenerState {
  const bindHost = normalizeHost(options.host);
  assertBridgeListenerAllowed(bindHost, options.allowRemote);
  return {
    bindHost,
    advertiseHost: options.advertiseHost
      ? normalizeHost(options.advertiseHost)
      : advertiseHostForBind(bindHost),
    port: parseBridgePort(options.port),
    allowRemote: options.allowRemote,
  };
}
