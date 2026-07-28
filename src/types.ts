export const TOOLS = ["claude", "codex", "opencode"] as const;
export type Tool = (typeof TOOLS)[number];

export const API_FORMATS = [
  "anthropic",
  "openai-chat",
  "openai-responses",
] as const;
export type ApiFormat = (typeof API_FORMATS)[number];

export interface ProxyConfig {
  http?: string;
  https?: string;
  all?: string;
}

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

export function emptyProxy(proxy?: ProxyConfig): boolean {
  if (!proxy) return true;
  return !proxy.http && !proxy.https && !proxy.all;
}
