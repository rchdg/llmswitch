import { dirname } from "node:path";
import type { ApiFormat, ApplyResult, ModelMeta, Profile } from "../types.js";
import { assertCompatible } from "../formats/compatibility.js";
import { normalizeBaseUrlForFormat } from "../utils/base-url.js";
import {
  backupFile,
  ensureDir,
  plainObjectAt,
  readStructuredFile,
  stringRecordAt,
  writeFilesAtomically,
} from "../utils/fs.js";
import { applyProxyToEnvRecord, clearProxyEnvKeys } from "../utils/proxy.js";
import {
  getBackupsDir,
  getOpenCodeAuthPath,
  getOpenCodeConfigDir,
  getOpenCodeConfigPath,
} from "../utils/paths.js";
import { setActiveProfile } from "../store/profiles.js";
import {
  ensureBridgeForProfile,
  profileNeedsBridge,
} from "../bridge/manager.js";

type JsonObject = Record<string, unknown>;

function providerId(name: string): string {
  return `llms-${name}`.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function npmForFormat(format: ApiFormat): string {
  switch (format) {
    case "anthropic":
      return "@ai-sdk/anthropic";
    case "openai-responses":
      return "@ai-sdk/openai";
    case "openai-chat":
      return "@ai-sdk/openai-compatible";
  }
}

export function readOpenCodeConfig(
  path = getOpenCodeConfigPath(),
): JsonObject {
  return readStructuredFile(path, (text) => JSON.parse(text) as JsonObject, {
    label: "OpenCode 配置",
    fallback: () => ({ $schema: "https://opencode.ai/config.json" }),
  });
}

export function readOpenCodeAuth(path = getOpenCodeAuthPath()): JsonObject {
  return readStructuredFile(path, (text) => JSON.parse(text) as JsonObject, {
    label: "OpenCode 凭据文件",
    fallback: () => ({}),
  });
}

/**
 * Build one model entry for the OpenCode provider block, filling in every
 * per-model field the OpenCode schema supports when metadata from
 * models.lonae.com is available:
 * { name, family, release_date, limit, cost, modalities, attachment,
 *   reasoning, temperature, tool_call }
 */
function buildOpenCodeModelEntry(id: string, meta?: ModelMeta): JsonObject {
  const entry: JsonObject = { name: meta?.name || id };
  if (meta?.family) {
    entry.family = meta.family;
  }
  if (meta?.releaseDate) {
    entry.release_date = meta.releaseDate;
  }
  if (typeof meta?.context === "number" && typeof meta?.maxOutput === "number") {
    entry.limit = { context: meta.context, output: meta.maxOutput };
  }
  if (meta?.cost) {
    entry.cost = { input: meta.cost.input, output: meta.cost.output };
  }
  if (meta?.modalities) {
    entry.modalities = {
      input: meta.modalities.input?.length ? meta.modalities.input : ["text"],
      output: meta.modalities.output?.length ? meta.modalities.output : ["text"],
    };
  }
  if (typeof meta?.attachment === "boolean") {
    entry.attachment = meta.attachment;
  }
  if (typeof meta?.reasoning === "boolean") {
    entry.reasoning = meta.reasoning;
  }
  if (typeof meta?.temperature === "boolean") {
    entry.temperature = meta.temperature;
  }
  if (typeof meta?.toolCall === "boolean") {
    entry.tool_call = meta.toolCall;
  }
  return entry;
}

export function buildOpenCodeProviderBlock(
  profile: Profile,
  overrides?: { baseURL?: string; apiKey?: string },
): JsonObject {
  const metaById = profile.models.meta || {};
  const models: JsonObject = {};
  for (const id of profile.models.list) {
    models[id] = buildOpenCodeModelEntry(id, metaById[id]);
  }
  if (!models[profile.models.default]) {
    models[profile.models.default] = buildOpenCodeModelEntry(
      profile.models.default,
      metaById[profile.models.default],
    );
  }
  if (profile.models.smallModel && !models[profile.models.smallModel]) {
    models[profile.models.smallModel] = buildOpenCodeModelEntry(
      profile.models.smallModel,
      metaById[profile.models.smallModel],
    );
  }

  const options: JsonObject = {
    baseURL:
      overrides?.baseURL ||
      normalizeBaseUrlForFormat(profile.apiFormat, profile.baseUrl),
  };
  const apiKey = overrides?.apiKey ?? profile.apiKey;
  if (apiKey) {
    options.apiKey = apiKey;
  }
  if (profile.headers && Object.keys(profile.headers).length > 0) {
    options.headers = { ...profile.headers };
  }

  return {
    npm: npmForFormat(profile.apiFormat),
    name: profile.displayName || profile.name,
    options,
    models,
  };
}

export function buildOpenCodeConfig(
  existing: JsonObject,
  profile: Profile,
  overrides?: { baseURL?: string; apiKey?: string },
): JsonObject {
  assertCompatible("opencode", profile.apiFormat);
  const id = providerId(profile.name);
  const providers: JsonObject = { ...plainObjectAt(existing, "provider") };
  providers[id] = buildOpenCodeProviderBlock(profile, overrides);

  // Optional top-level env for proxy (OpenCode may pass through). When the
  // profile routes through the bridge, the upstream proxy is applied inside the
  // bridge; skip env-var proxy injection so OpenCode doesn't apply its own.
  const env = stringRecordAt(existing, "env");
  clearProxyEnvKeys(env);
  if (!overrides) {
    applyProxyToEnvRecord(env, profile.proxy);
  }

  const next: JsonObject = {
    ...existing,
    $schema:
      (existing.$schema as string) || "https://opencode.ai/config.json",
    provider: providers,
    model: `${id}/${profile.models.default}`,
  };

  // `small_model` handles lightweight tasks (title generation, summaries).
  // Only touch it when it is ours: a user-configured value pointing at another
  // provider must survive.
  if (profile.models.smallModel) {
    next.small_model = `${id}/${profile.models.smallModel}`;
  } else if (ownsModelRef(existing.small_model, id)) {
    delete next.small_model;
  }

  if (Object.keys(env).length > 0) {
    next.env = env;
  } else {
    delete next.env;
  }

  return next;
}

/** Whether an OpenCode `provider/model` reference belongs to the given provider id. */
function ownsModelRef(value: unknown, id: string): boolean {
  return typeof value === "string" && value.startsWith(`${id}/`);
}

export function buildOpenCodeAuth(
  existing: JsonObject,
  profile: Profile,
): JsonObject {
  const id = providerId(profile.name);
  const next = { ...existing };
  if (profile.apiKey) {
    next[id] = {
      type: "api",
      key: profile.apiKey,
    };
  }
  return next;
}

export async function applyOpenCodeProfile(profile: Profile): Promise<ApplyResult> {
  assertCompatible("opencode", profile.apiFormat);
  ensureDir(getOpenCodeConfigDir());
  ensureDir(dirname(getOpenCodeAuthPath()));

  let bridgeConnection: { baseUrl: string; clientToken: string } | null = null;
  if (profileNeedsBridge(profile)) {
    bridgeConnection = await ensureBridgeForProfile(profile, "opencode");
  }

  const configPath = getOpenCodeConfigPath();
  const authPath = getOpenCodeAuthPath();
  const existing = readOpenCodeConfig(configPath);
  const backupPath = backupFile(
    configPath,
    getBackupsDir("opencode"),
    "opencode",
  );
  backupFile(authPath, getBackupsDir("opencode"), "auth");

  const nextConfig = buildOpenCodeConfig(
    existing,
    profile,
    bridgeConnection
      ? { baseURL: bridgeConnection.baseUrl, apiKey: bridgeConnection.clientToken }
      : undefined,
  );

  // opencode.json 与 auth.json 必须一起生效，否则会出现“选了供应商但没有凭据”的半更新状态。
  const bridgeApiKey = bridgeConnection?.clientToken || profile.apiKey;
  const nextAuth = buildOpenCodeAuth(
    readOpenCodeAuth(authPath),
    { ...profile, apiKey: bridgeApiKey },
  );
  writeFilesAtomically([
    { path: configPath, content: JSON.stringify(nextConfig, null, 2) + "\n" },
    { path: authPath, content: JSON.stringify(nextAuth, null, 2) + "\n" },
  ]);

  setActiveProfile("opencode", profile.name);

  return {
    tool: "opencode",
    profile: profile.name,
    configPath,
    backupPath,
    restartHint: bridgeConnection
      ? "已通过本地 bridge 启用供应商（上游代理在 bridge 内生效）。请重新启动 OpenCode 会话使配置生效。"
      : "请重新启动 OpenCode 会话以使配置与代理生效。",
  };
}

export function deactivateOpenCodeProfile(
  profileName?: string | null,
): ApplyResult {
  ensureDir(getOpenCodeConfigDir());
  ensureDir(dirname(getOpenCodeAuthPath()));

  const configPath = getOpenCodeConfigPath();
  const authPath = getOpenCodeAuthPath();
  const existing = readOpenCodeConfig(configPath);
  const backupPath = backupFile(
    configPath,
    getBackupsDir("opencode"),
    "opencode",
  );
  backupFile(authPath, getBackupsDir("opencode"), "auth");

  const providers: JsonObject = { ...plainObjectAt(existing, "provider") };
  const id = profileName ? providerId(profileName) : null;
  if (id) delete providers[id];

  const env = stringRecordAt(existing, "env");
  clearProxyEnvKeys(env);

  const next: JsonObject = {
    ...existing,
    provider: providers,
  };
  if (id && typeof existing.model === "string" && existing.model.startsWith(`${id}/`)) {
    delete next.model;
  }
  if (id && ownsModelRef(existing.small_model, id)) {
    delete next.small_model;
  }
  if (Object.keys(env).length > 0) next.env = env;
  else delete next.env;

  const writes = [
    { path: configPath, content: JSON.stringify(next, null, 2) + "\n" },
  ];
  if (id) {
    const auth = readOpenCodeAuth(authPath);
    if (auth[id]) {
      const nextAuth = { ...auth };
      delete nextAuth[id];
      writes.push({
        path: authPath,
        content: JSON.stringify(nextAuth, null, 2) + "\n",
      });
    }
  }
  writeFilesAtomically(writes);

  return {
    tool: "opencode",
    profile: profileName || "",
    configPath,
    backupPath,
    restartHint: "已禁用供应商。请重新启动 OpenCode 会话使变更生效。",
  };
}
