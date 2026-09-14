/**
 * Gateway provider / route / config persistence.
 *
 * Deliberately separate from `store/profiles.ts`: tool profiles are stored per
 * tool (claude/codex/opencode), so the same upstream can exist three times with
 * different names. The gateway needs one tool-independent provider list.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { chmodSync } from "node:fs";
import { TOOLS, isApiFormat, normalizeProxyValue } from "../types.js";
import type { Tool } from "../types.js";
import { ensureOpenAiV1BaseUrl, isOpenAiApiFormat } from "../utils/base-url.js";
import { atomicWriteFile, ensureDir, maskSecret } from "../utils/fs.js";
import {
  getGatewayConfigPath,
  getGatewayDir,
  getGatewayProviderPath,
  getGatewayProvidersDir,
  getGatewayRoutesPath,
} from "../utils/paths.js";
import { listProfiles } from "../store/profiles.js";
import {
  defaultGatewayConfig,
  DEFAULT_GATEWAY_FALLBACK,
  type GatewayConfig,
  type GatewayProvider,
  type GatewayRoute,
} from "./types.js";

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
/** Sanitized shape for `pathPrefix`: no slashes at the edges, bounded length. */
const PATH_PREFIX_MAX = 64;

export function normalizePathPrefix(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const trimmed = raw.replace(/^\/+|\/+$/g, "");
  if (!trimmed) return "";
  if (trimmed.length > PATH_PREFIX_MAX || /[?#]/.test(trimmed)) return "v1";
  return trimmed;
}

export function assertValidProviderName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(
      `无效的 provider 名称「${name}」。仅允许字母、数字、下划线、连字符，且以字母或数字开头。`,
    );
  }
}

function ensureGatewayDir(): void {
  ensureDir(getGatewayDir());
  try {
    chmodSync(getGatewayDir(), 0o700);
  } catch {
    // Windows relies on user-directory ACLs.
  }
}

/**
 * Gateway-specific base URL normalization.
 *
 * With the default prefix (`v1`, undefined field) OpenAI-format bases keep the
 * historical "exactly one /v1" shape. Once a provider pins an explicit
 * `pathPrefix` (including `""`), the base URL is the operator's business: only
 * trailing slashes are trimmed, and `upstreamUrl` joins the prefix.
 */
function normalizeProviderBaseUrl(
  apiFormat: GatewayProvider["apiFormat"],
  baseUrl: string,
  hasExplicitPrefix: boolean,
): string {
  const trimmed = baseUrl.trim();
  if (!hasExplicitPrefix && isOpenAiApiFormat(apiFormat)) {
    return ensureOpenAiV1BaseUrl(trimmed);
  }
  return trimmed.replace(/\/+$/, "");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

// --- providers --------------------------------------------------------------

function normalizeProvider(
  raw: Record<string, unknown>,
  fallbackName: string,
): GatewayProvider | null {
  const name = typeof raw.name === "string" && raw.name ? raw.name : fallbackName;
  const apiFormat = String(raw.apiFormat || "");
  if (!isApiFormat(apiFormat)) return null;
  const baseUrl = String(raw.baseUrl || "");
  if (!baseUrl) return null;
  const source = asRecord(raw.sourceProfile);
  const pathPrefix =
    raw.pathPrefix === undefined ? undefined : normalizePathPrefix(raw.pathPrefix);
  return {
    name,
    displayName:
      typeof raw.displayName === "string" && raw.displayName
        ? raw.displayName
        : name,
    apiFormat,
    baseUrl: normalizeProviderBaseUrl(apiFormat, baseUrl, pathPrefix !== undefined),
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey : "",
    models: stringList(raw.models),
    headers: (asRecord(raw.headers) as Record<string, string> | null) ?? {},
    proxy: normalizeProxyValue(raw.proxy),
    pathPrefix:
      raw.pathPrefix === undefined ? undefined : normalizePathPrefix(raw.pathPrefix),
    priority: typeof raw.priority === "number" ? raw.priority : 100,
    enabled: raw.enabled !== false,
    sourceProfile:
      source && typeof source.tool === "string" && typeof source.name === "string"
        ? { tool: source.tool, name: source.name }
        : null,
    updatedAt:
      typeof raw.updatedAt === "string"
        ? raw.updatedAt
        : new Date(0).toISOString(),
  };
}

/**
 * Provider list cache.
 *
 * The gateway data plane reads the provider list on every request (routing,
 * /v1/models, key scoping), and each read scanned the directory and JSON-parsed
 * every file. Invalidation is by directory mtime plus a short TTL, so an edit
 * from another process is still picked up within a second.
 */
const PROVIDER_CACHE_TTL_MS = 1_000;
let providerCache: {
  at: number;
  dir: string;
  dirMtimeMs: number;
  value: GatewayProvider[];
} | null = null;

/** Drop the cache after any write (same process). */
export function invalidateGatewayProviderCache(): void {
  providerCache = null;
}

export function listGatewayProviders(): GatewayProvider[] {
  const dir = getGatewayProvidersDir();
  if (!existsSync(dir)) return [];

  let dirMtimeMs = 0;
  try {
    dirMtimeMs = statSync(dir).mtimeMs;
  } catch {
    dirMtimeMs = 0;
  }
  const now = Date.now();
  if (
    providerCache &&
    // 目录路径也要比对：LLM_SWITCH_HOME 变了（测试、多配置目录）就必须重读。
    providerCache.dir === dir &&
    providerCache.dirMtimeMs === dirMtimeMs &&
    now - providerCache.at < PROVIDER_CACHE_TTL_MS
  ) {
    return providerCache.value;
  }

  const out: GatewayProvider[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const name = file.replace(/\.json$/, "");
    const provider = readGatewayProvider(name);
    if (provider) out.push(provider);
  }
  const sorted = out.sort(
    (a, b) => a.priority - b.priority || a.name.localeCompare(b.name),
  );
  providerCache = { at: now, dir, dirMtimeMs, value: sorted };
  return sorted;
}

export function readGatewayProvider(name: string): GatewayProvider | null {
  const path = getGatewayProviderPath(name);
  if (!existsSync(path)) return null;
  try {
    const raw = asRecord(JSON.parse(readFileSync(path, "utf8")));
    return raw ? normalizeProvider(raw, name) : null;
  } catch {
    return null;
  }
}

export function requireGatewayProvider(name: string): GatewayProvider {
  const provider = readGatewayProvider(name);
  if (provider) return provider;
  const available = listGatewayProviders().map((p) => p.name);
  throw new Error(
    available.length
      ? `未找到 gateway provider「${name}」。现有：${available.join(", ")}`
      : `未找到 gateway provider「${name}」。请先执行 llms gateway provider add`,
  );
}

export function saveGatewayProvider(provider: GatewayProvider): GatewayProvider {
  assertValidProviderName(provider.name);
  if (!isApiFormat(provider.apiFormat)) {
    throw new Error(`无效的 apiFormat: ${provider.apiFormat}`);
  }
  if (!provider.baseUrl?.trim()) {
    throw new Error("baseUrl 不能为空");
  }
  const nextPathPrefix =
    provider.pathPrefix === undefined
      ? undefined
      : normalizePathPrefix(provider.pathPrefix);
  const next: GatewayProvider = {
    ...provider,
    displayName: provider.displayName || provider.name,
    baseUrl: normalizeProviderBaseUrl(
      provider.apiFormat,
      provider.baseUrl,
      nextPathPrefix !== undefined,
    ),
    apiKey: provider.apiKey ?? "",
    models: stringList(provider.models),
    headers: provider.headers || {},
    pathPrefix: nextPathPrefix,
    priority:
      typeof provider.priority === "number" ? provider.priority : 100,
    enabled: provider.enabled !== false,
    sourceProfile: provider.sourceProfile ?? null,
    updatedAt: new Date().toISOString(),
  };
  ensureGatewayDir();
  ensureDir(getGatewayProvidersDir());
  atomicWriteFile(
    getGatewayProviderPath(next.name),
    JSON.stringify(next, null, 2) + "\n",
  );
  invalidateGatewayProviderCache();
  return next;
}

export function deleteGatewayProvider(name: string): void {
  const path = getGatewayProviderPath(name);
  if (!existsSync(path)) {
    throw new Error(`未找到 gateway provider「${name}」`);
  }
  unlinkSync(path);
  invalidateGatewayProviderCache();
  // Drop routes that pointed at the removed provider.
  const routes = listGatewayRoutes().filter((route) => {
    if (route.provider === name) return false;
    route.fallbacks = (route.fallbacks || []).filter(
      (item) => item.provider !== name,
    );
    return true;
  });
  writeGatewayRoutes(routes);
  const config = readGatewayConfig();
  if (config.defaultProvider === name) {
    writeGatewayConfig({ ...config, defaultProvider: null });
  }
}

export function publicProviderView(provider: GatewayProvider) {
  return {
    name: provider.name,
    displayName: provider.displayName,
    apiFormat: provider.apiFormat,
    baseUrl: provider.baseUrl,
    apiKey: maskSecret(provider.apiKey),
    models: provider.models,
    pathPrefix: provider.pathPrefix ?? "v1",
    /** Header names only; values may carry secrets. */
    headerNames: Object.keys(provider.headers || {}),
    priority: provider.priority,
    enabled: provider.enabled,
    proxy: provider.proxy || null,
    sourceProfile: provider.sourceProfile || null,
    updatedAt: provider.updatedAt,
  };
}

// --- import from tool profiles ---------------------------------------------

export interface ImportResult {
  imported: GatewayProvider[];
  skipped: Array<{ tool: Tool; name: string; reason: string }>;
}

/**
 * Import tool profiles as gateway providers, de-duplicated by
 * (apiFormat, baseUrl, apiKey). Existing providers are never overwritten.
 */
export function importProvidersFromProfiles(
  tools: readonly Tool[] = TOOLS,
): ImportResult {
  const existing = listGatewayProviders();
  const fingerprint = (
    apiFormat: string,
    baseUrl: string,
    apiKey: string,
  ): string => `${apiFormat}|${baseUrl.replace(/\/+$/, "")}|${apiKey}`;
  const seen = new Set(
    existing.map((p) => fingerprint(p.apiFormat, p.baseUrl, p.apiKey)),
  );
  const usedNames = new Set(existing.map((p) => p.name));

  const imported: GatewayProvider[] = [];
  const skipped: ImportResult["skipped"] = [];

  for (const tool of tools) {
    for (const profile of listProfiles(tool)) {
      const key = fingerprint(
        profile.apiFormat,
        profile.baseUrl,
        profile.apiKey,
      );
      if (seen.has(key)) {
        skipped.push({ tool, name: profile.name, reason: "重复上游" });
        continue;
      }
      let name = profile.name;
      let suffix = 2;
      while (usedNames.has(name)) {
        name = `${profile.name}-${suffix++}`;
      }
      const models = Array.from(
        new Set(
          [
            profile.models.default,
            profile.models.smallModel,
            ...(profile.models.list || []),
          ].filter((m): m is string => Boolean(m?.trim())),
        ),
      );
      const provider = saveGatewayProvider({
        name,
        displayName: profile.displayName || name,
        apiFormat: profile.apiFormat,
        baseUrl: profile.baseUrl,
        apiKey: profile.apiKey,
        models,
        headers: profile.headers || {},
        proxy: profile.proxy,
        priority: 100,
        enabled: true,
        sourceProfile: { tool, name: profile.name },
        updatedAt: new Date().toISOString(),
      });
      seen.add(key);
      usedNames.add(name);
      imported.push(provider);
    }
  }

  return { imported, skipped };
}

// --- routes -----------------------------------------------------------------

function normalizeRoute(raw: unknown): GatewayRoute | null {
  const row = asRecord(raw);
  if (!row) return null;
  const alias = String(row.alias || "").trim();
  const provider = String(row.provider || "").trim();
  if (!alias || !provider) return null;
  const fallbacks: NonNullable<GatewayRoute["fallbacks"]> = [];
  if (Array.isArray(row.fallbacks)) {
    for (const item of row.fallbacks) {
      const entry = asRecord(item);
      const name = String(entry?.provider || "").trim();
      if (!name) continue;
      const model =
        typeof entry?.model === "string" && entry.model.trim()
          ? entry.model.trim()
          : undefined;
      fallbacks.push(model ? { provider: name, model } : { provider: name });
    }
  }
  const model =
    typeof row.model === "string" && row.model.trim()
      ? row.model.trim()
      : undefined;
  return {
    alias,
    provider,
    ...(model ? { model } : {}),
    ...(fallbacks.length ? { fallbacks } : {}),
    updatedAt:
      typeof row.updatedAt === "string"
        ? row.updatedAt
        : new Date(0).toISOString(),
  };
}

export function listGatewayRoutes(): GatewayRoute[] {
  const path = getGatewayRoutesPath();
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const rows = Array.isArray(raw)
      ? raw
      : Array.isArray(asRecord(raw)?.routes)
        ? (asRecord(raw)!.routes as unknown[])
        : [];
    return rows
      .map(normalizeRoute)
      .filter((route): route is GatewayRoute => route !== null);
  } catch {
    return [];
  }
}

export function writeGatewayRoutes(routes: readonly GatewayRoute[]): void {
  ensureGatewayDir();
  atomicWriteFile(
    getGatewayRoutesPath(),
    JSON.stringify({ version: 1, routes }, null, 2) + "\n",
  );
}

export function saveGatewayRoute(route: GatewayRoute): GatewayRoute {
  const alias = route.alias.trim();
  if (!alias) throw new Error("模型别名不能为空");
  requireGatewayProvider(route.provider);
  for (const fallback of route.fallbacks || []) {
    requireGatewayProvider(fallback.provider);
  }
  const next: GatewayRoute = {
    ...route,
    alias,
    updatedAt: new Date().toISOString(),
  };
  const routes = listGatewayRoutes().filter(
    (item) => item.alias.toLowerCase() !== alias.toLowerCase(),
  );
  routes.push(next);
  routes.sort((a, b) => a.alias.localeCompare(b.alias));
  writeGatewayRoutes(routes);
  return next;
}

export function deleteGatewayRoute(alias: string): void {
  const routes = listGatewayRoutes();
  const next = routes.filter(
    (item) => item.alias.toLowerCase() !== alias.trim().toLowerCase(),
  );
  if (next.length === routes.length) {
    throw new Error(`未找到模型路由「${alias}」`);
  }
  writeGatewayRoutes(next);
}

// --- config -----------------------------------------------------------------

export function readGatewayConfig(): GatewayConfig {
  const path = getGatewayConfigPath();
  const fallback = defaultGatewayConfig();
  if (!existsSync(path)) return fallback;
  try {
    const raw = asRecord(JSON.parse(readFileSync(path, "utf8")));
    if (!raw) return fallback;
    const fallbackRaw = asRecord(raw.fallback);
    const retryStatuses = Array.isArray(fallbackRaw?.retryStatuses)
      ? fallbackRaw!.retryStatuses.filter(
          (item): item is number =>
            typeof item === "number" && item >= 100 && item <= 599,
        )
      : [...DEFAULT_GATEWAY_FALLBACK.retryStatuses];
    return {
      version: 1,
      defaultProvider:
        typeof raw.defaultProvider === "string" && raw.defaultProvider
          ? raw.defaultProvider
          : null,
      fallback: {
        enabled: fallbackRaw?.enabled !== false,
        maxAttempts:
          typeof fallbackRaw?.maxAttempts === "number" &&
          fallbackRaw.maxAttempts >= 1
            ? Math.min(fallbackRaw.maxAttempts, 10)
            : DEFAULT_GATEWAY_FALLBACK.maxAttempts,
        retryStatuses: retryStatuses.length
          ? retryStatuses
          : [...DEFAULT_GATEWAY_FALLBACK.retryStatuses],
      },
      corsOrigins: stringList(raw.corsOrigins),
      rateLimitPerMinute:
        typeof raw.rateLimitPerMinute === "number" &&
        raw.rateLimitPerMinute >= 0
          ? raw.rateLimitPerMinute
          : 0,
      updatedAt:
        typeof raw.updatedAt === "string"
          ? raw.updatedAt
          : fallback.updatedAt,
    };
  } catch {
    return fallback;
  }
}

export function writeGatewayConfig(config: GatewayConfig): GatewayConfig {
  const next: GatewayConfig = {
    ...config,
    version: 1,
    updatedAt: new Date().toISOString(),
  };
  ensureGatewayDir();
  atomicWriteFile(
    getGatewayConfigPath(),
    JSON.stringify(next, null, 2) + "\n",
  );
  return next;
}
