import type { ProxyConfig } from "../types.js";

export type BridgeUpstreamMode = "chat" | "completions";

export type BridgeTool = "codex" | "claude" | "opencode";

export interface BridgeUpstream {
  baseUrl: string;
  apiKey: string;
  /** How to talk to upstream. Default chat. */
  mode: BridgeUpstreamMode;
  proxy?: ProxyConfig;
  headers?: Record<string, string>;
  profileName?: string;
  updatedAt: string;
  /** Data-plane credential written to the corresponding local client. */
  clientToken?: string | null;
  /** Legacy state cannot authenticate this side until it is reapplied. */
  migrationRequired?: boolean;
  /** Context window of the active model (models.lonae.com metadata). */
  modelContextWindow?: number;
  /** Whether the active model supports reasoning; undefined = unknown. */
  modelSupportsReasoning?: boolean;
  /** Input modalities of the active model (text/image/pdf/...). */
  modelInputModalities?: string[];
  /** Default model of this candidate; rewrite the client's request to it. */
  model?: string;
  /**
   * Failover candidates tried in order after a retryable failure of this
   * upstream. They never serve client auth (clientToken lives on the primary).
   */
  fallbacks?: BridgeUpstream[];
}

export interface BridgeUpstreams {
  codex: BridgeUpstream | null;
  claude: BridgeUpstream | null;
  opencode: BridgeUpstream | null;
}

export interface BridgeListenerState {
  bindHost: string;
  advertiseHost: string;
  port: number;
  allowRemote: boolean;
}

export interface BridgeInstanceState {
  id: string;
  controlToken: string;
  pid: number;
  startedAt: string;
}

export interface BridgePendingState {
  revision: number;
  upstreams: BridgeUpstreams;
  transactionId?: string;
}

/**
 * Authoritative v2 state plus flat aliases retained for existing callers.
 * Only the nested v2 fields are persisted.
 */
export interface BridgeRuntimeState {
  version: 2;
  revision: number;
  listener: BridgeListenerState;
  instance: BridgeInstanceState | null;
  upstreams: BridgeUpstreams;
  pending: BridgePendingState | null;
  /** @deprecated Use listener.port. */
  port: number;
  /** @deprecated Use instance.pid. */
  pid: number | null;
  /** @deprecated Use listener.bindHost. */
  host: string;
}

export const DEFAULT_BRIDGE_PORT = 17890;
export const DEFAULT_BRIDGE_HOST = "127.0.0.1";

export function emptyUpstreams(): BridgeUpstreams {
  return { codex: null, claude: null, opencode: null };
}

export function hasAnyUpstream(upstreams: BridgeUpstreams): boolean {
  return Boolean(
    upstreams.codex?.baseUrl ||
      upstreams.claude?.baseUrl ||
      upstreams.opencode?.baseUrl,
  );
}
