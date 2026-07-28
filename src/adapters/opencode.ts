import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ApiFormat, ApplyResult, Profile } from "../types.js";
import { assertCompatible } from "../formats/compatibility.js";
import { normalizeBaseUrlForFormat } from "../utils/base-url.js";
import { atomicWriteFile, backupFile, ensureDir } from "../utils/fs.js";
import { applyProxyToEnvRecord, clearProxyEnvKeys } from "../utils/proxy.js";
import {
  getBackupsDir,
  getOpenCodeAuthPath,
  getOpenCodeConfigDir,
  getOpenCodeConfigPath,
} from "../utils/paths.js";
import { setActiveProfile } from "../store/profiles.js";

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
  if (!existsSync(path)) {
    return { $schema: "https://opencode.ai/config.json" };
  }
  return JSON.parse(readFileSync(path, "utf8")) as JsonObject;
}

export function readOpenCodeAuth(path = getOpenCodeAuthPath()): JsonObject {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as JsonObject;
}

export function buildOpenCodeProviderBlock(profile: Profile): JsonObject {
  const models: JsonObject = {};
  for (const id of profile.models.list) {
    models[id] = { name: id };
  }
  if (!models[profile.models.default]) {
    models[profile.models.default] = { name: profile.models.default };
  }

  const options: JsonObject = {
    baseURL: normalizeBaseUrlForFormat(profile.apiFormat, profile.baseUrl),
  };
  if (profile.apiKey) {
    options.apiKey = profile.apiKey;
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
): JsonObject {
  assertCompatible("opencode", profile.apiFormat);
  const id = providerId(profile.name);
  const providers = {
    ...((existing.provider as JsonObject) || {}),
  };
  providers[id] = buildOpenCodeProviderBlock(profile);

  // Optional top-level env for proxy (OpenCode may pass through)
  const env = {
    ...((existing.env as Record<string, string>) || {}),
  };
  clearProxyEnvKeys(env);
  applyProxyToEnvRecord(env, profile.proxy);

  const next: JsonObject = {
    ...existing,
    $schema:
      (existing.$schema as string) || "https://opencode.ai/config.json",
    provider: providers,
    model: `${id}/${profile.models.default}`,
  };

  if (Object.keys(env).length > 0) {
    next.env = env;
  } else {
    delete next.env;
  }

  return next;
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

export function applyOpenCodeProfile(profile: Profile): ApplyResult {
  assertCompatible("opencode", profile.apiFormat);
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

  const nextConfig = buildOpenCodeConfig(existing, profile);
  atomicWriteFile(configPath, JSON.stringify(nextConfig, null, 2) + "\n");

  const nextAuth = buildOpenCodeAuth(readOpenCodeAuth(authPath), profile);
  atomicWriteFile(authPath, JSON.stringify(nextAuth, null, 2) + "\n");

  setActiveProfile("opencode", profile.name);

  return {
    tool: "opencode",
    profile: profile.name,
    configPath,
    backupPath,
    restartHint: "请重新启动 OpenCode 会话以使配置与代理生效。",
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

  const providers = {
    ...((existing.provider as JsonObject) || {}),
  };
  const id = profileName ? providerId(profileName) : null;
  if (id) delete providers[id];

  const env = {
    ...((existing.env as Record<string, string>) || {}),
  };
  clearProxyEnvKeys(env);

  const next: JsonObject = {
    ...existing,
    provider: providers,
  };
  if (id && typeof existing.model === "string" && existing.model.startsWith(`${id}/`)) {
    delete next.model;
  }
  if (Object.keys(env).length > 0) next.env = env;
  else delete next.env;

  atomicWriteFile(configPath, JSON.stringify(next, null, 2) + "\n");

  if (id) {
    const auth = readOpenCodeAuth(authPath);
    if (auth[id]) {
      const nextAuth = { ...auth };
      delete nextAuth[id];
      atomicWriteFile(authPath, JSON.stringify(nextAuth, null, 2) + "\n");
    }
  }

  return {
    tool: "opencode",
    profile: profileName || "",
    configPath,
    backupPath,
    restartHint: "已禁用供应商。请重新启动 OpenCode 会话使变更生效。",
  };
}
