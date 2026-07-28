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
 * Build proxy env vars for injection into tool configs.
 * Prefer explicit http/https; when only `all` is set (e.g. socks5h),
 * set ALL_PROXY (and lowercase) and also mirror to HTTP(S)_PROXY
 * so runtimes that only read those still attempt the proxy URL.
 */
export function buildProxyEnv(proxy?: ProxyConfig): ProxyEnvMap {
  if (emptyProxy(proxy)) return {};

  const env: ProxyEnvMap = {};
  const http = proxy!.http?.trim();
  const https = proxy!.https?.trim();
  const all = proxy!.all?.trim();

  if (all) {
    env.ALL_PROXY = all;
    env.all_proxy = all;
  }
  if (http) {
    env.HTTP_PROXY = http;
    env.http_proxy = http;
  } else if (all) {
    env.HTTP_PROXY = all;
    env.http_proxy = all;
  }
  if (https) {
    env.HTTPS_PROXY = https;
    env.https_proxy = https;
  } else if (all) {
    env.HTTPS_PROXY = all;
    env.https_proxy = all;
  }

  return env;
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
  const parts: string[] = [];
  if (proxy?.http) parts.push(`http=${proxy.http}`);
  if (proxy?.https) parts.push(`https=${proxy.https}`);
  if (proxy?.all) parts.push(`all=${proxy.all}`);
  return parts.join(", ");
}
