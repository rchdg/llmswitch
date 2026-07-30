import type { ProxyConfig } from "../types.js";
import { emptyProxy } from "../types.js";

export const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

export type ProxyEnvMap = Record<string, string>;

/**
 * Build proxy env vars for injection into tool configs. A single proxy URL is
 * applied to all traffic, so HTTP_PROXY, HTTPS_PROXY and ALL_PROXY (plus their
 * lowercase forms) are all set to that URL. SOCKS URLs are honored by runtimes
 * that read these variables.
 */
export function buildProxyEnv(proxy?: ProxyConfig): ProxyEnvMap {
  if (emptyProxy(proxy)) return {};
  const url = proxy!.trim();
  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    ALL_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    all_proxy: url,
  };
}

export function clearProxyEnvKeys(
  env: Record<string, string | undefined>,
): void {
  for (const key of PROXY_ENV_KEYS) {
    delete env[key];
  }
}

export function applyProxyToEnvRecord(
  env: Record<string, string | undefined>,
  proxy?: ProxyConfig,
): void {
  clearProxyEnvKeys(env);
  const next = buildProxyEnv(proxy);
  for (const [k, v] of Object.entries(next)) {
    env[k] = v;
  }
}

export function formatProxySummary(proxy?: ProxyConfig): string {
  if (emptyProxy(proxy)) return "(none)";
  return proxy!.trim();
}
