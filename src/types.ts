export const TOOLS = ["claude", "codex", "opencode"] as const;
export type Tool = (typeof TOOLS)[number];

export const API_FORMATS = [
  "anthropic",
  "openai-chat",
  "openai-responses",
] as const;
export type ApiFormat = (typeof API_FORMATS)[number];

/**
 * Upstream proxy for a profile: a single URL applied to all provider traffic.
 * Supported schemes: http, https, socks/socks4/socks4a/socks5/socks5h.
 */
export type ProxyConfig = string;

export interface ModelsConfig {
  default: string;
  fast?: string;
  list: string[];
}

export interface Profile {
  name: string;
  displayName: string;
  apiFormat: ApiFormat;
  baseUrl: string;
  apiKey: string;
  models: ModelsConfig;
  proxy?: ProxyConfig;
  headers?: Record<string, string>;
  /**
   * When apiFormat is openai-chat and tool is codex, bridge upstream mode.
   * Default: chat. Set completions for /v1/completions-only upstreams.
   */
  bridgeMode?: "chat" | "completions";
  updatedAt: string;
}

export interface ToolState {
  /** Currently enabled provider (written into the target tool config). */
  active: string | null;
  /**
   * Default provider for selection fallbacks.
   * Always set when at least one provider exists.
   */
  default: string | null;
}

export interface ApplyResult {
  tool: Tool;
  profile: string;
  configPath: string;
  backupPath?: string;
  restartHint: string;
}

export function isTool(value: string): value is Tool {
  return (TOOLS as readonly string[]).includes(value);
}

export function isApiFormat(value: string): value is ApiFormat {
  return (API_FORMATS as readonly string[]).includes(value);
}

export function emptyProxy(proxy?: ProxyConfig | null): boolean {
  return !proxy || !proxy.trim();
}

/**
 * Coerce a stored proxy value into a single URL string. Accepts the current
 * string form, or the legacy `{ http, https, all }` object (preferring `all`,
 * then `https`, then `http`). Returns undefined when no proxy is set.
 */
export function normalizeProxyValue(raw: unknown): ProxyConfig | undefined {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed ? trimmed : undefined;
  }
  if (raw && typeof raw === "object") {
    const row = raw as { http?: unknown; https?: unknown; all?: unknown };
    for (const value of [row.all, row.https, row.http]) {
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return undefined;
}
