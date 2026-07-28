import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { readFileSync } from "node:fs";
import type { Profile, Tool, ToolState } from "../types.js";
import { isApiFormat } from "../types.js";
import { normalizeBaseUrlForFormat } from "../utils/base-url.js";
import { atomicWriteFile, ensureDir, maskSecret } from "../utils/fs.js";
import {
  getProfilePath,
  getProfilesDir,
  getStatePath,
  getToolStoreDir,
} from "../utils/paths.js";

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function assertValidProfileName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(
      `无效的 profile 名称「${name}」。仅允许字母、数字、下划线、连字符，且以字母或数字开头。`,
    );
  }
}

export function ensureToolStore(tool: Tool): void {
  ensureDir(getProfilesDir(tool));
}

export function readState(tool: Tool): ToolState {
  const path = getStatePath(tool);
  if (!existsSync(path)) return { active: null, default: null };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ToolState>;
    return {
      active: raw.active ?? null,
      default: raw.default ?? null,
    };
  } catch {
    return { active: null, default: null };
  }
}

export function writeState(tool: Tool, state: ToolState): void {
  ensureToolStore(tool);
  atomicWriteFile(
    getStatePath(tool),
    JSON.stringify(
      {
        active: state.active ?? null,
        default: state.default ?? null,
      },
      null,
      2,
    ) + "\n",
  );
}

export function listProfiles(tool: Tool): Profile[] {
  ensureToolStore(tool);
  const dir = getProfilesDir(tool);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readProfile(tool, f.replace(/\.json$/, "")))
    .filter((p): p is Profile => p !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function profileExists(tool: Tool, name: string): boolean {
  return existsSync(getProfilePath(tool, name));
}

export function readProfile(tool: Tool, name: string): Profile | null {
  const path = getProfilePath(tool, name);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8")) as Profile;
  return normalizeProfile(raw, name);
}

export function requireProfile(tool: Tool, name: string): Profile {
  const profile = readProfile(tool, name);
  if (!profile) {
    throw new Error(`未找到 ${tool} 的 profile「${name}」`);
  }
  return profile;
}

export function saveProfile(tool: Tool, profile: Profile): void {
  assertValidProfileName(profile.name);
  if (!isApiFormat(profile.apiFormat)) {
    throw new Error(`无效的 apiFormat: ${profile.apiFormat}`);
  }
  if (!profile.baseUrl?.trim()) {
    throw new Error("baseUrl 不能为空");
  }
  if (!profile.models?.default?.trim()) {
    throw new Error("默认模型不能为空");
  }
  const list = Array.from(
    new Set(
      [profile.models.default, profile.models.fast, ...(profile.models.list || [])]
        .filter(Boolean)
        .map((m) => m!.trim()),
    ),
  );
  const next: Profile = {
    ...profile,
    displayName: profile.displayName || profile.name,
    baseUrl: normalizeBaseUrlForFormat(profile.apiFormat, profile.baseUrl),
    apiKey: profile.apiKey ?? "",
    models: {
      default: profile.models.default.trim(),
      fast: profile.models.fast?.trim() || undefined,
      list,
    },
    headers: profile.headers || {},
    updatedAt: new Date().toISOString(),
  };
  ensureToolStore(tool);
  atomicWriteFile(
    getProfilePath(tool, next.name),
    JSON.stringify(next, null, 2) + "\n",
  );
}

export function deleteProfile(tool: Tool, name: string): void {
  const path = getProfilePath(tool, name);
  if (!existsSync(path)) {
    throw new Error(`未找到 ${tool} 的 profile「${name}」`);
  }
  unlinkSync(path);
  const state = readState(tool);
  writeState(tool, {
    active: state.active === name ? null : state.active,
    default: state.default === name ? null : state.default,
  });
  ensureDefaultProvider(tool);
}

export function getActiveProfile(tool: Tool): Profile | null {
  const { active } = readState(tool);
  if (!active) return null;
  return readProfile(tool, active);
}

export function setActiveProfile(tool: Tool, name: string): void {
  requireProfile(tool, name);
  const state = readState(tool);
  const defaultName =
    state.default && profileExists(tool, state.default) ? state.default : name;
  writeState(tool, { active: name, default: defaultName });
}

export function clearActiveProfile(tool: Tool): void {
  const state = readState(tool);
  writeState(tool, { ...state, active: null });
}

/**
 * Ensure a default provider exists whenever there is at least one profile.
 * Missing/invalid default falls back to active (if valid), otherwise the first profile.
 */
export function ensureDefaultProvider(tool: Tool): string | null {
  const profiles = listProfiles(tool);
  const state = readState(tool);
  if (profiles.length === 0) {
    if (state.default !== null || state.active !== null) {
      writeState(tool, { active: null, default: null });
    }
    return null;
  }

  if (state.default && profiles.some((p) => p.name === state.default)) {
    return state.default;
  }

  if (state.active && profiles.some((p) => p.name === state.active)) {
    writeState(tool, { ...state, default: state.active });
    return state.active;
  }

  const first = profiles[0]!.name;
  writeState(tool, { ...state, default: first });
  return first;
}

export function getDefaultProfile(tool: Tool): Profile | null {
  const name = ensureDefaultProvider(tool);
  if (!name) return null;
  return readProfile(tool, name);
}

export function setDefaultProfile(tool: Tool, name: string): void {
  requireProfile(tool, name);
  const state = readState(tool);
  writeState(tool, { ...state, default: name });
}

export function publicProfileView(profile: Profile) {
  return {
    name: profile.name,
    displayName: profile.displayName,
    apiFormat: profile.apiFormat,
    baseUrl: profile.baseUrl,
    apiKey: maskSecret(profile.apiKey),
    models: profile.models,
    proxy: profile.proxy || null,
    updatedAt: profile.updatedAt,
  };
}

function normalizeProfile(raw: Profile, fallbackName: string): Profile {
  const name = raw.name || fallbackName;
  const list = Array.from(
    new Set(
      [
        raw.models?.default,
        raw.models?.fast,
        ...(raw.models?.list || []),
      ]
        .filter(Boolean)
        .map((m) => String(m).trim()),
    ),
  );
  return {
    name,
    displayName: raw.displayName || name,
    apiFormat: raw.apiFormat,
    baseUrl: isApiFormat(raw.apiFormat)
      ? normalizeBaseUrlForFormat(raw.apiFormat, String(raw.baseUrl || ""))
      : String(raw.baseUrl || "").replace(/\/+$/, ""),
    apiKey: raw.apiKey ?? "",
    models: {
      default: raw.models?.default || list[0] || "",
      fast: raw.models?.fast || undefined,
      list: list.length ? list : raw.models?.default ? [raw.models.default] : [],
    },
    proxy: raw.proxy,
    bridgeMode: raw.bridgeMode,
    headers: raw.headers || {},
    updatedAt: raw.updatedAt || new Date(0).toISOString(),
  };
}

export function storeRoot(tool: Tool): string {
  return getToolStoreDir(tool);
}
