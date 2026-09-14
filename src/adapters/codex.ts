import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parse, stringify } from "smol-toml";
import type { ApplyResult, Profile } from "../types.js";
import { emptyProxy } from "../types.js";
import { assertCompatible } from "../formats/compatibility.js";
import { normalizeBaseUrlForFormat } from "../utils/base-url.js";
import {
  backupFile,
  ensureDir,
  plainObjectAt,
  readStructuredFile,
  writeFilesAtomically,
} from "../utils/fs.js";
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

/**
 * Codex identifiers derived from a profile name.
 *
 * Profile names may contain `-` (see NAME_RE) but Codex provider keys and env
 * var names are safest restricted to `[A-Za-z0-9_]`. Naively replacing `-` with
 * `_` is not injective: `a-b` and `a_b` both collapse to `a_b`, so one profile
 * would silently overwrite the other's provider block and API key. Append a
 * short hash of the original name whenever the name contains a character that
 * gets rewritten, which keeps distinct profiles distinct.
 */
function sanitizeCodexId(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_]/g, "_");
  if (sanitized === name) return sanitized;
  const suffix = createHash("sha256")
    .update(name)
    .digest("hex")
    .slice(0, 6);
  return `${sanitized}_${suffix}`;
}

function providerKey(name: string): string {
  return sanitizeCodexId(name);
}

/** Pre-fix form, kept only so stale entries can be cleaned up on apply. */
function legacyProviderKey(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

export function envKeyName(profileName: string): string {
  return `LLM_SWITCH_${providerKey(profileName).toUpperCase()}_API_KEY`;
}

/** Pre-fix env var name; removed alongside the current one so no key lingers. */
export function legacyEnvKeyName(profileName: string): string {
  return `LLM_SWITCH_${legacyProviderKey(profileName).toUpperCase()}_API_KEY`;
}

/**
 * Model-level metadata Codex accepts in config.toml. Only `model_context_window`
 * is a stable model-info key (schema is deny_unknown_fields — never write
 * removed keys like model_max_output_tokens).
 */
function applyModelInfo(config: TomlTable, profile: Profile): void {
  const context = profile.models.meta?.[profile.models.default]?.context;
  if (typeof context === "number" && context > 0) {
    config.model_context_window = Math.round(context);
  } else {
    delete config.model_context_window;
  }
}

export function readCodexConfig(path = getCodexConfigPath()): TomlTable {
  return readStructuredFile(path, (text) => parse(text) as TomlTable, {
    label: "Codex 配置",
    fallback: () => ({}),
  });
}

export function buildCodexConfig(
  existing: TomlTable,
  profile: Profile,
  effectiveBaseUrl: string,
): TomlTable {
  assertCompatible("codex", profile.apiFormat);
  const id = providerKey(profile.name);
  const providers = {
    ...plainObjectAt(existing, "model_providers"),
  };

  const providerBlock: TomlTable = {
    name: profile.displayName || profile.name,
    base_url: effectiveBaseUrl,
    // 对 Codex 一律声明 responses：原生 openai-responses 上游直连，
    // openai-chat 上游则由本地 bridge 转成 /v1/responses 后再交给 Codex，
    // 两种情况下 Codex 看到的都是 Responses 协议。
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
  // 清掉旧命名方案留下的同名 provider 块（否则会与新键并存）。
  const legacyId = legacyProviderKey(profile.name);
  if (legacyId !== id) delete providers[legacyId];

  const next: TomlTable = {
    ...existing,
    model: profile.models.default,
    model_provider: id,
    model_providers: providers,
  };
  applyModelInfo(next, profile);
  return next;
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

  // 旧命名方案下的密钥行必须删掉，否则明文会一直留在 .env 里。
  const legacyKeyName = legacyEnvKeyName(profile.name);
  const keyName = envKeyName(profile.name);
  if (legacyKeyName !== keyName) map.delete(legacyKeyName);
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

  // config.toml 与 .env 必须一起生效：先把两份内容都构造好，再作为一个单元写入。
  const next = buildCodexConfig(existing, profile, effectiveBaseUrl);
  const prevEnv = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  writeFilesAtomically([
    { path: configPath, content: stringify(next) + "\n" },
    { path: envPath, content: buildCodexEnvFile(prevEnv, profile, effectiveApiKey) },
  ]);

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
    ...plainObjectAt(existing, "model_providers"),
  };
  if (profileName) {
    const id = providerKey(profileName);
    delete providers[id];
    const legacyId = legacyProviderKey(profileName);
    if (legacyId !== id) delete providers[legacyId];
    if (next.model_provider === id || next.model_provider === legacyId) {
      delete next.model_provider;
      delete next.model;
      delete next.model_context_window;
    }
  } else if (next.model_provider) {
    delete next.model_provider;
    delete next.model;
    delete next.model_context_window;
  }
  next.model_providers = providers;
  const prevEnv = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  writeFilesAtomically([
    { path: configPath, content: stringify(next) + "\n" },
    { path: envPath, content: stripCodexManagedEnv(prevEnv, profileName) },
  ]);

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
  const keysToRemove = new Set(
    profileName
      ? [envKeyName(profileName), legacyEnvKeyName(profileName)]
      : [],
  );
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
    if (keysToRemove.size > 0 && keysToRemove.has(k)) continue;
    if (
      keysToRemove.size === 0 &&
      k.startsWith("LLM_SWITCH_") &&
      k.endsWith("_API_KEY")
    ) {
      continue;
    }
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  if (out.length > 0) out.push("");
  return out.join("\n");
}
