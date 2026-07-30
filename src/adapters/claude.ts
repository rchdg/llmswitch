import { existsSync, readFileSync } from "node:fs";
import type { ApplyResult, Profile } from "../types.js";
import { emptyProxy } from "../types.js";
import { assertCompatible } from "../formats/compatibility.js";
import {
  clearBridgeUpstream,
  ensureBridgeForProfile,
  profileNeedsBridge,
} from "../bridge/manager.js";
import { backupFile, atomicWriteFile } from "../utils/fs.js";
import {
  applyProxyToEnvRecord,
  clearProxyEnvKeys,
} from "../utils/proxy.js";
import {
  getBackupsDir,
  getClaudeSettingsPath,
} from "../utils/paths.js";
import { setActiveProfile } from "../store/profiles.js";

/** Env keys managed by llm-switch for Claude Code. */
export const CLAUDE_MANAGED_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

type SettingsJson = {
  env?: Record<string, string>;
  model?: string;
  [key: string]: unknown;
};

export function readClaudeSettings(path = getClaudeSettingsPath()): SettingsJson {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as SettingsJson;
}

function stripManagedEnv(env: Record<string, string>): Record<string, string> {
  const next = { ...env };
  for (const key of CLAUDE_MANAGED_ENV_KEYS) {
    delete next[key];
  }
  return next;
}

export function buildClaudeSettings(
  existing: SettingsJson,
  profile: Profile,
  effectiveBaseUrl?: string,
  effectiveApiKey = profile.apiKey,
): SettingsJson {
  assertCompatible("claude", profile.apiFormat);

  const env = stripManagedEnv({ ...(existing.env || {}) });
  clearProxyEnvKeys(env);

  const needsBridge = profileNeedsBridge(profile);
  env.ANTHROPIC_BASE_URL = effectiveBaseUrl || profile.baseUrl;
  if (effectiveApiKey) {
    env.ANTHROPIC_AUTH_TOKEN = effectiveApiKey;
  }
  env.ANTHROPIC_MODEL = profile.models.default;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = profile.models.default;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = profile.models.default;
  if (profile.models.fast) {
    env.ANTHROPIC_SMALL_FAST_MODEL = profile.models.fast;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = profile.models.fast;
  } else {
    env.ANTHROPIC_SMALL_FAST_MODEL = profile.models.default;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = profile.models.default;
  }

  // When bridging, upstream proxy is applied inside the bridge process.
  if (!needsBridge && !emptyProxy(profile.proxy)) {
    applyProxyToEnvRecord(env, profile.proxy);
  }

  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || v === null) delete env[k];
  }

  return {
    ...existing,
    env,
    model: profile.models.default,
  };
}

export async function applyClaudeProfile(
  profile: Profile,
): Promise<ApplyResult> {
  assertCompatible("claude", profile.apiFormat);
  const configPath = getClaudeSettingsPath();
  const existing = readClaudeSettings(configPath);
  const backupPath = backupFile(
    configPath,
    getBackupsDir("claude"),
    "settings",
  );

  let effectiveBaseUrl = profile.baseUrl;
  let effectiveApiKey = profile.apiKey;
  let bridgeNote = "";
  if (profileNeedsBridge(profile)) {
    const connection = await ensureBridgeForProfile(profile, "claude");
    effectiveBaseUrl = connection.baseUrl;
    effectiveApiKey = connection.clientToken;
    bridgeNote = `已启动本地 Anthropic↔Chat 适配桥 → ${effectiveBaseUrl}（上游 ${profile.baseUrl}）。`;
  } else {
    await clearBridgeUpstream("claude");
  }

  const next = buildClaudeSettings(
    existing,
    profile,
    effectiveBaseUrl,
    effectiveApiKey,
  );
  atomicWriteFile(configPath, JSON.stringify(next, null, 2) + "\n");
  setActiveProfile("claude", profile.name);

  return {
    tool: "claude",
    profile: profile.name,
    configPath,
    backupPath,
    restartHint: bridgeNote
      ? `${bridgeNote}Claude Code 通常会热加载配置；若未生效，请新开一个会话后再试。`
      : "Claude Code 通常会热加载配置；若未生效，请新开一个会话后再试。",
  };
}

export async function deactivateClaudeProfile(): Promise<ApplyResult> {
  const configPath = getClaudeSettingsPath();
  const existing = readClaudeSettings(configPath);
  const backupPath = backupFile(
    configPath,
    getBackupsDir("claude"),
    "settings",
  );
  const env = stripManagedEnv({ ...(existing.env || {}) });
  clearProxyEnvKeys(env);
  const next: SettingsJson = { ...existing, env };
  if (Object.keys(env).length === 0) delete next.env;
  atomicWriteFile(configPath, JSON.stringify(next, null, 2) + "\n");

  await clearBridgeUpstream("claude");

  return {
    tool: "claude",
    profile: "",
    configPath,
    backupPath,
    restartHint:
      "已清除由本工具写入的 Claude 连接配置。若未生效，请新开一个会话后再试。",
  };
}
