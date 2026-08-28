import type { ApiFormat, ProxyConfig } from "../types.js";

export const DEFAULT_GATEWAY_PORT = 17900;
export const DEFAULT_GATEWAY_HOST = "127.0.0.1";

/** Wire formats the gateway can speak, both inbound and upstream. */
export const GATEWAY_FORMATS = [
  "openai-chat",
  "openai-responses",
  "anthropic",
] as const;
export type GatewayFormat = (typeof GATEWAY_FORMATS)[number];

export function isGatewayFormat(value: string): value is GatewayFormat {
  return (GATEWAY_FORMATS as readonly string[]).includes(value);
}

/**
 * An upstream the gateway can route to. Independent of tool profiles: the same
 * provider is declared once and reachable by every inbound format.
 */
export interface GatewayProvider {
  name: string;
  displayName: string;
  apiFormat: ApiFormat;
  baseUrl: string;
  apiKey: string;
  /** Routable models. Empty means "accept any model id" (passthrough). */
  models: string[];
  /** Extra upstream headers; `authorization` here wins over apiKey. */
  headers?: Record<string, string>;
  proxy?: ProxyConfig;
  /** Lower runs first during routing and fallback. */
  priority: number;
  enabled: boolean;
  /** Imported from a tool profile, for traceability. */
  sourceProfile?: { tool: string; name: string } | null;
  updatedAt: string;
}

/** Maps a client-visible model id onto a concrete provider/model pair. */
export interface GatewayRoute {
  /** Model id third parties send in the request body. */
  alias: string;
  /** Provider name; must exist in the provider store. */
  provider: string;
  /** Upstream model id. Defaults to the alias when omitted. */
  model?: string;
  /** Ordered fallbacks, tried when the primary target fails. */
  fallbacks?: Array<{ provider: string; model?: string }>;
  updatedAt: string;
}

export type GatewayKeyScopeFormat = GatewayFormat | "*";

/**
 * A gateway-issued credential. Only the hash is persisted; the plaintext is
 * shown once at creation time.
 */
export interface GatewayKey {
  id: string;
  name: string;
  /** scrypt hash of the plaintext key. */
  hash: string;
  /** Random salt, hex encoded. */
  salt: string;
  /** Leading plaintext fragment, for identification in listings. */
  hint: string;
  createdAt: string;
  /** ISO timestamp; null means no expiry. */
  expiresAt: string | null;
  revokedAt: string | null;
  /** Allowed provider names; empty means all. */
  providers: string[];
  /** Allowed model ids/aliases; empty means all. */
  models: string[];
  /** Allowed inbound formats; empty or ["*"] means all. */
  formats: GatewayKeyScopeFormat[];
  /** Per-key request cap; 0 disables the limit. */
  rateLimitPerMinute: number;
  lastUsedAt: string | null;
}

export interface GatewayFallbackConfig {
  enabled: boolean;
  /** Upstream attempts per request, including the primary target. */
  maxAttempts: number;
  /** HTTP statuses that trigger the next candidate. */
  retryStatuses: number[];
}

export interface GatewayConfig {
  version: 1;
  /** Route requests with an unknown model to this provider (by name). */
  defaultProvider: string | null;
  fallback: GatewayFallbackConfig;
  /** Allow browser clients; empty disables CORS entirely. */
  corsOrigins: string[];
  /** Requests per minute applied when a key sets no limit of its own. */
  rateLimitPerMinute: number;
  updatedAt: string;
}

export interface GatewayListenerState {
  bindHost: string;
  advertiseHost: string;
  port: number;
  allowRemote: boolean;
}

export interface GatewayInstanceState {
  id: string;
  controlToken: string;
  pid: number;
  startedAt: string;
}

export interface GatewayRuntimeState {
  version: 1;
  revision: number;
  listener: GatewayListenerState;
  instance: GatewayInstanceState | null;
}

export const DEFAULT_GATEWAY_FALLBACK: Readonly<GatewayFallbackConfig> =
  Object.freeze({
    enabled: true,
    maxAttempts: 3,
    retryStatuses: [408, 409, 429, 500, 502, 503, 504, 529],
  });

export function defaultGatewayConfig(): GatewayConfig {
  return {
    version: 1,
    defaultProvider: null,
    fallback: { ...DEFAULT_GATEWAY_FALLBACK, retryStatuses: [...DEFAULT_GATEWAY_FALLBACK.retryStatuses] },
    corsOrigins: [],
    rateLimitPerMinute: 0,
    updatedAt: new Date(0).toISOString(),
  };
}

/** The API format a provider speaks, expressed as a gateway wire format. */
export function providerFormat(provider: GatewayProvider): GatewayFormat {
  return provider.apiFormat as GatewayFormat;
}
