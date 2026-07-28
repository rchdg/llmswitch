import type { ApiFormat, ProxyConfig } from "../types.js";
import { emptyProxy } from "../types.js";
import { normalizeBaseUrlForFormat } from "./base-url.js";
import { buildProxyEnv } from "./proxy.js";

export interface FetchModelsOptions {
  baseUrl: string;
  apiKey: string;
  apiFormat: ApiFormat;
  proxy?: ProxyConfig;
  timeoutMs?: number;
}

export interface FetchModelsResult {
  models: string[];
  endpoint: string;
  /**
   * API base derived from the successful /models endpoint.
   * E.g. http://host:8000/v1/models → http://host:8000/v1
   * Use this for chat/completions clients that append paths to baseURL.
   */
  resolvedBaseUrl: string;
}

/**
 * Derive the API base URL from a successful .../models endpoint.
 */
export function baseUrlFromModelsEndpoint(endpoint: string): string | null {
  const cleaned = endpoint.trim().replace(/\/+$/, "");
  const match = cleaned.match(/^(.*)\/models$/i);
  return match?.[1] || null;
}

/**
 * Prefer the base URL that actually served /models when it differs from input.
 * Common case: user enters http://host:8000 but only /v1/models works.
 */
export function preferResolvedBaseUrl(
  inputBaseUrl: string,
  resolvedBaseUrl: string | null | undefined,
): string {
  const input = inputBaseUrl.trim().replace(/\/+$/, "");
  const resolved = (resolvedBaseUrl || "").trim().replace(/\/+$/, "");
  if (!resolved) return input;
  if (resolved === input) return input;
  return resolved;
}

/**
 * Resolve candidate /models URLs for a provider base URL.
 */
export function modelListEndpoints(baseUrl: string): string[] {
  const base = baseUrl.trim().replace(/\/+$/, "");
  const endpoints: string[] = [];
  const add = (url: string) => {
    if (!endpoints.includes(url)) endpoints.push(url);
  };

  if (/\/v1$/i.test(base)) {
    add(`${base}/models`);
  } else {
    add(`${base}/models`);
    add(`${base}/v1/models`);
  }

  // Common gateway: .../anthropic → also try sibling /v1/models
  if (/\/anthropic$/i.test(base)) {
    add(`${base.replace(/\/anthropic$/i, "")}/v1/models`);
  }

  return endpoints;
}

export function buildModelsRequestHeaders(
  apiFormat: ApiFormat,
  apiKey: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (!apiKey) return headers;

  if (apiFormat === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
    // Some gateways also accept Bearer
    headers.Authorization = `Bearer ${apiKey}`;
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

export function parseModelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;

  const buckets: unknown[] = [];
  if (Array.isArray(root.data)) buckets.push(...root.data);
  if (Array.isArray(root.models)) buckets.push(...root.models);
  if (Array.isArray(payload)) buckets.push(...payload);

  const ids = new Set<string>();
  for (const item of buckets) {
    if (typeof item === "string" && item.trim()) {
      ids.add(item.trim());
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = row.id ?? row.name ?? row.model;
    if (typeof id === "string" && id.trim()) ids.add(id.trim());
  }

  return Array.from(ids).sort((a, b) => a.localeCompare(b));
}

/**
 * Fetch available model IDs from the provider using baseUrl + apiKey.
 * Tries several common /models paths; uses proxy env when configured.
 */
export async function fetchModelList(
  options: FetchModelsOptions,
): Promise<FetchModelsResult> {
  const { baseUrl, apiKey, apiFormat, proxy, timeoutMs = 20_000 } = options;
  if (!baseUrl?.trim()) {
    throw new Error("Base URL 为空，无法拉取模型列表");
  }
  if (!apiKey?.trim()) {
    throw new Error("API Key 为空，无法拉取模型列表");
  }

  const effectiveBaseUrl = normalizeBaseUrlForFormat(apiFormat, baseUrl);
  const endpoints = modelListEndpoints(effectiveBaseUrl);
  const headers = buildModelsRequestHeaders(apiFormat, apiKey.trim());
  const restore = applyProxyEnv(proxy);

  const errors: string[] = [];
  try {
    for (const endpoint of endpoints) {
      try {
        const models = await requestModels(endpoint, headers, timeoutMs);
        if (models.length > 0) {
          const resolvedBaseUrl =
            baseUrlFromModelsEndpoint(endpoint) || effectiveBaseUrl;
          return {
            models,
            endpoint,
            resolvedBaseUrl: normalizeBaseUrlForFormat(
              apiFormat,
              resolvedBaseUrl,
            ),
          };
        }
        errors.push(`${endpoint} → 返回空列表`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${endpoint} → ${msg}`);
      }
    }
  } finally {
    restore();
  }

  throw new Error(
    `无法从接口拉取模型列表。\n${errors.map((e) => `  - ${e}`).join("\n")}`,
  );
}

async function requestModels(
  endpoint: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`HTTP ${res.status}${body ? `: ${body}` : ""}`);
    }
    const json: unknown = await res.json();
    return parseModelIds(json);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`请求超时（${timeoutMs}ms）`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function applyProxyEnv(proxy?: ProxyConfig): () => void {
  if (emptyProxy(proxy)) return () => undefined;

  const next = buildProxyEnv(proxy);
  const keys = Object.keys(next);
  const backup = new Map<string, string | undefined>();
  for (const key of keys) {
    backup.set(key, process.env[key]);
    process.env[key] = next[key];
  }
  return () => {
    for (const [key, value] of backup) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
