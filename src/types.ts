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

/** Input/output modality types supported by a model. */
export interface ModelModalities {
  input: string[];
  output: string[];
}

/** Pricing per 1M tokens. */
export interface ModelCost {
  input: number;
  output: number;
}

/**
 * Model metadata sourced from models.lonae.com. Only fields relevant to the
 * target tools' config schemas are captured (see adapters).
 */
export interface ModelMeta {
  /** Canonical model id on models.lonae.com, e.g. "anthropic/claude-sonnet-4-5". */
  id?: string;
  /** Display name, e.g. "Claude Sonnet 4.5". */
  name?: string;
  /** Model family, e.g. "claude-sonnet-4". */
  family?: string;
  /** Release date, e.g. "2025-09-29". */
  releaseDate?: string;
  /** Context window in tokens. */
  context?: number;
  /** Maximum output tokens. */
  maxOutput?: number;
  /** Supports reasoning/thinking. */
  reasoning?: boolean;
  /** Supports tool/function calling. */
  toolCall?: boolean;
  /** Supports temperature control. */
  temperature?: boolean;
  modalities?: ModelModalities;
  attachment?: boolean;
  cost?: ModelCost;
}

/**
 * Tools whose config supports a second, lightweight model alongside the main
 * one (title generation, summaries and other cheap tasks):
 * - claude: ANTHROPIC_SMALL_FAST_MODEL / ANTHROPIC_DEFAULT_HAIKU_MODEL
 * - opencode: top-level `small_model`
 * Codex has no equivalent knob.
 */
const SMALL_MODEL_TOOLS = ["claude", "opencode"] as const;

/** Whether `models.smallModel` is meaningful for the given tool. */
export function supportsSmallModel(tool: Tool): boolean {
  return (SMALL_MODEL_TOOLS as readonly Tool[]).includes(tool);
}

export interface ModelsConfig {
  default: string;
  /**
   * Lightweight model for cheap tasks (title generation, summaries).
   * Maps to `small_model` (OpenCode) and ANTHROPIC_SMALL_FAST_MODEL /
   * ANTHROPIC_DEFAULT_HAIKU_MODEL (Claude Code). See supportsSmallModel().
   * Read back-compatibly from the legacy `fast` field.
   */
  smallModel?: string;
  list: string[];
  /** Metadata per model id, fetched from models.lonae.com during selection. */
  meta?: Record<string, ModelMeta>;
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
  /**
   * Failover chain: other profile names tried in order when this provider
   * fails with a retryable error (429/5xx/timeout). Max 3, self excluded.
   */
  fallbacks?: string[];
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
