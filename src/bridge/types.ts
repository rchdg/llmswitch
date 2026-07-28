import type { ProxyConfig } from "../types.js";

export type BridgeUpstreamMode = "chat" | "completions";

export type BridgeTool = "codex" | "claude";

export interface BridgeUpstream {
  baseUrl: string;
  apiKey: string;
  /** How to talk to upstream. Default chat. */
  mode: BridgeUpstreamMode;
  proxy?: ProxyConfig;
  headers?: Record<string, string>;
  profileName?: string;
  updatedAt: string;
}

export interface BridgeUpstreams {
  codex: BridgeUpstream | null;
  claude: BridgeUpstream | null;
}

export interface BridgeRuntimeState {
  port: number;
  pid: number | null;
  host: string;
  upstreams: BridgeUpstreams;
}

export const DEFAULT_BRIDGE_PORT = 17890;
export const DEFAULT_BRIDGE_HOST = "127.0.0.1";

export function emptyUpstreams(): BridgeUpstreams {
  return { codex: null, claude: null };
}

export function hasAnyUpstream(upstreams: BridgeUpstreams): boolean {
  return Boolean(upstreams.codex?.baseUrl || upstreams.claude?.baseUrl);
}
