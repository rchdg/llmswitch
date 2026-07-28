import type { ApiFormat } from "../types.js";

export function isOpenAiApiFormat(format: ApiFormat): boolean {
  return format === "openai-chat" || format === "openai-responses";
}

/**
 * Ensure an OpenAI-compatible base URL ends with exactly one `/v1`
 * (no trailing slash after it).
 *
 * Examples:
 * - `http://host:8000` → `http://host:8000/v1`
 * - `http://host:8000/` → `http://host:8000/v1`
 * - `http://host:8000/v1` → `http://host:8000/v1`
 * - `http://host:8000/v1/` → `http://host:8000/v1`
 * - `http://host:8000/v1/v1` → `http://host:8000/v1`
 * - `https://api.openai.com/v1/v1/` → `https://api.openai.com/v1`
 */
export function ensureOpenAiV1BaseUrl(baseUrl: string): string {
  let base = baseUrl.trim();
  if (!base) return base;

  base = base.replace(/\/+$/, "");
  while (/\/v1$/i.test(base)) {
    base = base.replace(/\/v1$/i, "").replace(/\/+$/, "");
  }

  if (!base) return "/v1";
  return `${base}/v1`;
}

/**
 * Normalize base URL for the given API format.
 * OpenAI formats always get a single trailing `/v1`; others only trim trailing slashes.
 */
export function normalizeBaseUrlForFormat(
  apiFormat: ApiFormat,
  baseUrl: string,
): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return trimmed;
  if (isOpenAiApiFormat(apiFormat)) {
    return ensureOpenAiV1BaseUrl(trimmed);
  }
  return trimmed;
}
