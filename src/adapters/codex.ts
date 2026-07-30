import { existsSync, readFileSync } from "node:fs";
import { parse, stringify } from "smol-toml";
import type { ApplyResult, Profile } from "../types.js";
import { emptyProxy } from "../types.js";
import { assertCompatible } from "../formats/compatibility.js";
import { normalizeBaseUrlForFormat } from "../utils/base-url.js";
import { atomicWriteFile, backupFile, ensureDir } from "../utils/fs.js";
import { buildProxyEnv } from "../utils/proxy.js";
import {
  getBackupsDir,
  getCodexConfigPath,
  getCodexEnvPath,
  getCodexHome,
} from "../utils/paths.js";
import { setActiveProfile } from "../store/profiles.js";
import {
  clearBridgeUpstream,
  ensureBridgeForProfile,
  profileNeedsBridge,
} from "../bridge/manager.js";

type TomlTable = Record<string, unknown>;

function providerKey(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

export function envKeyName(profileName: string): string {
  const key = providerKey(profileName).toUpperCase();
  return `LLM_SWITCH_${key}_API_KEY`;
}

export function readCodexConfig(path = getCodexConfigPath()): TomlTable {
  if (!existsSync(path)) return {};
  return parse(readFileSync(path, "utf8")) as TomlTable;
}

export function buildCodexConfig(
  existing: TomlTable,
  profile: Profile,
  effectiveBaseUrl: string,
): TomlTable {
  assertCompatible("codex", profile.apiFormat);
  const id = providerKey(profile.name);
  const providers = {
    ...((existing.model_providers as TomlTable) || {}),
  };

  const providerBlock: TomlTable = {
    name: profile.displayName || profile.name,
    base_url: effectiveBaseUrl,
    wire_api: "responses",
    env_key: envKeyName(profile.name),
    requires_openai_auth: false,
  };

  if (profile.headers && Object.keys(profile.headers).length > 0) {
    // When using bridge, upstream headers live in bridge upstream.json;
    // still pass through for native responses providers.
    if (!profileNeedsBridge(profile)) {
      providerBlock.http_headers = { ...profile.headers };
    }
  }

  providers[id] = providerBlock;

  return {
    ...existing,
    model: profile.models.default,
    model_provider: id,
    model_providers: providers,
  };
}

export function buildCodexEnvFile(
  existingContent: string,
  profile: Profile,
  effectiveApiKey = profile.apiKey || "llm-switch-bridge",
): string {
  const lines = existingContent ? existingContent.split(/\r?\n/) : [];
  const map = new Map<string, string>();
  const order: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (!map.has(k)) order.push(k);
    map.set(k, v);
  }

  const keyName = envKeyName(profile.name);
  if (!map.has(keyName)) order.push(keyName);
  // When bridging, Codex talks to local bridge; key can be placeholder.
  // Bridge uses upstream.apiKey from its own config. Still write real key
  // so native responses profiles keep working.
  map.set(keyName, effectiveApiKey);

  const proxyKeys = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ];
  for (const k of proxyKeys) map.delete(k);

  // Proxy for Codex process itself is usually unnecessary when talking to localhost bridge;
  // upstream proxy is applied inside the bridge. For native responses, keep profile proxy.
  if (!profileNeedsBridge(profile) && !emptyProxy(profile.proxy)) {
    const env = buildProxyEnv(profile.proxy);
    for (const [k, v] of Object.entries(env)) {
      if (!map.has(k)) order.push(k);
      map.set(k, v);
    }
  }

  const seen = new Set<string>();
  const out: string[] = [
    "# Managed in part by llm-switch — proxy and API keys for Codex",
  ];
  for (const k of order) {
    if (!map.has(k)) continue;
    out.push(`${k}=${escapeEnv(map.get(k)!)}`);
    seen.add(k);
  }
  for (const [k, v] of map) {
    if (seen.has(k)) continue;
    out.push(`${k}=${escapeEnv(v)}`);
  }
  out.push("");
  return out.join("\n");
}

function escapeEnv(value: string): string {
  if (/[\s#"']/.test(value) || value.includes("=")) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

export async function applyCodexProfile(
  profile: Profile,
): Promise<ApplyResult> {
  assertCompatible("codex", profile.apiFormat);
  ensureDir(getCodexHome());

  let effectiveBaseUrl = normalizeBaseUrlForFormat(
    profile.apiFormat,
    profile.baseUrl,
  );
  let effectiveApiKey = profile.apiKey || "llm-switch-bridge";
  let bridgeNote = "";

  if (profileNeedsBridge(profile)) {
    const connection = await ensureBridgeForProfile(profile, "codex");
    effectiveBaseUrl = connection.baseUrl.replace(/\/+$/, "");
    effectiveApiKey = connection.clientToken;
    bridgeNote = `已启动本地 Responses 适配桥 → ${effectiveBaseUrl}（上游 ${normalizeBaseUrlForFormat(profile.apiFormat, profile.baseUrl)}，模式 ${profile.bridgeMode || "chat"}）。`;
  } else {
    await clearBridgeUpstream("codex");
  }

  const configPath = getCodexConfigPath();
  const envPath = getCodexEnvPath();
  const existing = readCodexConfig(configPath);
  const backupPath = backupFile(
    configPath,
    getBackupsDir("codex"),
    "config",
  );
  backupFile(envPath, getBackupsDir("codex"), "env");

  const next = buildCodexConfig(existing, profile, effectiveBaseUrl);
  atomicWriteFile(configPath, stringify(next) + "\n");

  const prevEnv = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  atomicWriteFile(
    envPath,
    buildCodexEnvFile(prevEnv, profile, effectiveApiKey),
  );

  setActiveProfile("codex", profile.name);

  return {
    tool: "codex",
    profile: profile.name,
    configPath,
    backupPath,
    restartHint: bridgeNote
      ? `${bridgeNote}请新开终端或重新启动 Codex 使配置生效。`
      : "请新开终端或重新启动 Codex，使 config.toml 与 .env 中的代理/密钥生效。",
  };
}

export async function deactivateCodexProfile(
  profileName?: string | null,
): Promise<ApplyResult> {
  ensureDir(getCodexHome());
  const configPath = getCodexConfigPath();
  const envPath = getCodexEnvPath();
  const existing = readCodexConfig(configPath);
  const backupPath = backupFile(
    configPath,
    getBackupsDir("codex"),
    "config",
  );
  backupFile(envPath, getBackupsDir("codex"), "env");

  const next: TomlTable = { ...existing };
  const providers = {
    ...((existing.model_providers as TomlTable) || {}),
  };
  if (profileName) {
    const id = providerKey(profileName);
    delete providers[id];
    if (next.model_provider === id) {
      delete next.model_provider;
      delete next.model;
    }
  } else if (next.model_provider) {
    delete next.model_provider;
    delete next.model;
  }
  next.model_providers = providers;
  atomicWriteFile(configPath, stringify(next) + "\n");

  const prevEnv = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  atomicWriteFile(envPath, stripCodexManagedEnv(prevEnv, profileName));

  await clearBridgeUpstream("codex");

  return {
    tool: "codex",
    profile: profileName || "",
    configPath,
    backupPath,
    restartHint:
      "已禁用供应商并清除 Codex 桥上游。请新开终端或重新启动 Codex。",
  };
}

function stripCodexManagedEnv(
  existingContent: string,
  profileName?: string | null,
): string {
  const lines = existingContent ? existingContent.split(/\r?\n/) : [];
  const proxyKeys = new Set([
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ]);
  const keyToRemove = profileName ? envKeyName(profileName) : null;
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      // Drop our managed header comment; keep other comments.
      if (trimmed.startsWith("# Managed in part by llm-switch")) continue;
      out.push(line);
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      out.push(line);
      continue;
    }
    const k = trimmed.slice(0, eq).trim();
    if (proxyKeys.has(k)) continue;
    if (keyToRemove && k === keyToRemove) continue;
    if (!keyToRemove && k.startsWith("LLM_SWITCH_") && k.endsWith("_API_KEY")) {
      continue;
    }
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  if (out.length > 0) out.push("");
  return out.join("\n");
}
