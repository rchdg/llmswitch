import type { ApiFormat, ProxyConfig } from "../types.js";
import { requestWithNodeTransport } from "../bridge/transport.js";
import { normalizeBaseUrlForFormat } from "./base-url.js";

export interface FetchModelsOptions {
  baseUrl: string;
  apiKey: string;
  apiFormat: ApiFormat;
  proxy?: ProxyConfig;
  headers?: Record<string, string>;
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
  customHeaders: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (apiKey) {
    if (apiFormat === "anthropic") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
      headers.Authorization = `Bearer ${apiKey}`;
    } else {
      headers.Authorization = `Bearer ${apiKey}`;
    }
  }
  for (const [name, value] of Object.entries(customHeaders)) {
    if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
      throw new Error(`无效的模型请求 header: ${name}`);
    }
    const existing = Object.keys(headers).find(
      (key) => key.toLowerCase() === name.toLowerCase(),
    );
    if (existing) delete headers[existing];
    headers[name] = value;
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
  const {
    baseUrl,
    apiKey,
    apiFormat,
    proxy,
    headers: customHeaders,
    timeoutMs = 20_000,
  } = options;
  if (!baseUrl?.trim()) {
    throw new Error("Base URL 为空，无法拉取模型列表");
  }

  const effectiveBaseUrl = normalizeBaseUrlForFormat(apiFormat, baseUrl);
  const endpoints = modelListEndpoints(effectiveBaseUrl);
  // 无 Key 的本地服务（如 Ollama 原生 API）兜底探测 /api/tags
  if (!apiKey?.trim()) {
    const root = effectiveBaseUrl
      .replace(/\/v1$/i, "")
      .replace(/\/+$/, "");
    const tags = `${root}/api/tags`;
    if (!endpoints.includes(tags)) endpoints.push(tags);
  }
  const headers = buildModelsRequestHeaders(
    apiFormat,
    apiKey.trim(),
    customHeaders,
  );

  const errors: string[] = [];
  for (const endpoint of endpoints) {
    try {
      const models = await requestModels(endpoint, headers, timeoutMs, proxy);
      if (models.length > 0) {
        // Anthropic Messages base URLs are not implied by a sibling /v1/models
        // endpoint; keep the operator-provided base for those.
        const resolvedBaseUrl =
          apiFormat === "anthropic"
            ? effectiveBaseUrl
            : baseUrlFromModelsEndpoint(endpoint) || effectiveBaseUrl;
        return {
          models,
          endpoint,
          resolvedBaseUrl: normalizeBaseUrlForFormat(apiFormat, resolvedBaseUrl),
        };
      }
      errors.push(`${endpoint} → 返回空列表`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${endpoint} → ${msg}`);
    }
  }

  throw new Error(
    `无法从接口拉取模型列表。\n${errors.map((e) => `  - ${e}`).join("\n")}`,
  );
}

async function requestModels(
  endpoint: string,
  headers: Record<string, string>,
  timeoutMs: number,
  proxy?: ProxyConfig,
): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await requestWithNodeTransport({
      url: endpoint,
      method: "GET",
      headers,
      proxy,
      signal: controller.signal,
      totalTimeoutMs: timeoutMs,
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
