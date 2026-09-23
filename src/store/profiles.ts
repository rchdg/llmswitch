import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { readFileSync } from "node:fs";
import type { ModelMeta, Profile, Tool, ToolState } from "../types.js";
import { API_FORMATS, isApiFormat, normalizeProxyValue } from "../types.js";
import { normalizeBaseUrlForFormat } from "../utils/base-url.js";
import {
  atomicWriteFile,
  ensureDir,
  maskSecret,
  readStructuredFile,
} from "../utils/fs.js";
import {
  getProfilePath,
  getProfilesDir,
  getStatePath,
  getToolStoreDir,
} from "../utils/paths.js";

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** Keep only metadata entries whose model id is still in the list. */
function filterModelMeta(
  meta: Record<string, ModelMeta> | undefined,
  list: readonly string[],
): Record<string, ModelMeta> | undefined {
  if (!meta) return undefined;
  const filtered = Object.fromEntries(
    Object.entries(meta).filter(([id]) => list.includes(id)),
  );
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

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
    .map((f) => {
      const name = f.replace(/\.json$/, "");
      try {
        return readProfile(tool, name);
      } catch (err) {
        // 单个坏 profile 不应让整份列表（以及所有命令）不可用。
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`警告：跳过损坏的 ${tool} profile「${name}」：${msg}`);
        return null;
      }
    })
    .filter((p): p is Profile => p !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function profileExists(tool: Tool, name: string): boolean {
  return existsSync(getProfilePath(tool, name));
}

export function readProfile(tool: Tool, name: string): Profile | null {
  const path = getProfilePath(tool, name);
  if (!existsSync(path)) return null;
  const raw = readStructuredFile<Profile | null>(
    path,
    (text) => JSON.parse(text) as Profile,
    { label: `${tool} 供应商配置`, fallback: () => null },
  );
  if (!raw) return null;
  return normalizeProfile(raw, name);
}

export function requireProfile(tool: Tool, name: string): Profile {
  const profile = readProfile(tool, name);
  if (!profile) {
    throw new Error(`未找到 ${tool} 的 profile「${name}」`);
  }
  return profile;
}

/** 归一化引用串：小写并去掉分隔符（kimi-openai ↔ kimiOpenai）。 */
export function normalizeReference(value: string): string {
  return value.toLowerCase().replace(/[_\s./-]+/g, "");
}

/**
 * 按用户输入解析 profile：优先名称精确匹配，其次显示名称精确匹配，
 * 再尝试归一化（大小写/分隔符）与包含匹配；多义时返回 null。
 */
export function resolveProfile(tool: Tool, query: string): Profile | null {
  const trimmed = query.trim();
  if (!trimmed) return null;
  const byName = readProfile(tool, trimmed);
  if (byName) return byName;

  const profiles = listProfiles(tool);
  const normalized = normalizeReference(trimmed);
  // 纯分隔符的输入（如 "---"）归一化后为空串，而 "".includes("") 恒真，
  // 会让下面的包含匹配命中任意 profile。这种查询直接视为无匹配。
  if (!normalized) return null;

  const exactDisplay = profiles.find(
    (p) => normalizeReference(p.displayName) === normalized,
  );
  if (exactDisplay) return exactDisplay;

  const fuzzy = profiles.filter(
    (p) =>
      normalizeReference(p.displayName).includes(normalized) ||
      normalizeReference(p.name).includes(normalized),
  );
  return fuzzy.length === 1 ? fuzzy[0]! : null;
}

export function resolveProfileOrThrow(tool: Tool, query: string): Profile {
  const profile = resolveProfile(tool, query);
  if (!profile) {
    const profiles = listProfiles(tool);
    if (profiles.length === 0) {
      throw new Error(`暂无 ${tool} 供应商。请先：llms ${tool} provider`);
    }
    const names = profiles
      .map((p) => `${p.name}（${p.displayName}）`)
      .join(", ");
    throw new Error(
      `未找到匹配「${query}」的供应商。现有：${names}。可通过名称或显示名称引用。`,
    );
  }
  return profile;
}

/** Max failover candidates per profile — chains stay predictable. */
const MAX_FALLBACKS = 3;

/**
 * Clean a failover chain: drop self references, duplicates and unknown names
 * are validated by the caller; cap the length.
 */
export function normalizeFallbackNames(
  profileName: string,
  fallbacks: unknown,
): string[] | undefined {
  if (!Array.isArray(fallbacks)) return undefined;
  const seen = new Set<string>();
  const names: string[] = [];
  for (const raw of fallbacks) {
    if (typeof raw !== "string") continue;
    const name = raw.trim();
    if (!name || name === profileName || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
    if (names.length >= MAX_FALLBACKS) break;
  }
  return names.length > 0 ? names : undefined;
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
      [
        profile.models.default,
        profile.models.smallModel,
        ...(profile.models.list || []),
      ]
        .filter(Boolean)
        .map((m) => m!.trim()),
    ),
  );
  const meta = filterModelMeta(profile.models.meta, list);
  const defaultModel = profile.models.default.trim();
  const smallModel = profile.models.smallModel?.trim() || undefined;
  const next: Profile = {
    ...profile,
    displayName: profile.displayName || profile.name,
    baseUrl: normalizeBaseUrlForFormat(profile.apiFormat, profile.baseUrl),
    apiKey: profile.apiKey ?? "",
    models: {
      default: defaultModel,
      // Same as the default model → no point declaring a separate small model.
      smallModel:
        smallModel && smallModel !== defaultModel ? smallModel : undefined,
      list,
      meta,
    },
    headers: profile.headers || {},
    fallbacks: normalizeFallbackNames(profile.name, profile.fallbacks),
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
    fallbacks: profile.fallbacks ?? [],
    updatedAt: profile.updatedAt,
  };
}

/**
 * Small model as stored on disk. Older profiles used `models.fast`; keep reading
 * it so existing installs do not silently lose the setting after the rename.
 */
function legacySmallModel(raw: Profile): string | undefined {
  const models = raw.models as
    | (Partial<Profile["models"]> & { fast?: unknown })
    | undefined;
  const value = models?.smallModel ?? models?.fast;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeProfile(raw: Profile, fallbackName: string): Profile {
  const name = raw.name || fallbackName;
  // apiFormat 非法时不要透传成合法类型再等到 apply 才炸——那时用户已经改了一堆东西。
  if (!isApiFormat(raw.apiFormat)) {
    throw new Error(
      `供应商「${name}」的 apiFormat「${String(raw.apiFormat)}」无效。` +
        `可选：${API_FORMATS.join("、")}。请修正该 profile 或重新添加。`,
    );
  }
  const apiFormat = raw.apiFormat;
  const list = Array.from(
    new Set(
      [
        raw.models?.default,
        legacySmallModel(raw),
        ...(raw.models?.list || []),
      ]
        .filter(Boolean)
        .map((m) => String(m).trim()),
    ),
  );
  const defaultModel = raw.models?.default || list[0] || "";
  return {
    name,
    displayName: raw.displayName || name,
    apiFormat,
    baseUrl: normalizeBaseUrlForFormat(apiFormat, String(raw.baseUrl || "")),
    apiKey: raw.apiKey ?? "",
    models: {
      default: defaultModel,
      smallModel:
        legacySmallModel(raw) && legacySmallModel(raw) !== defaultModel
          ? legacySmallModel(raw)
          : undefined,
      list: list.length ? list : raw.models?.default ? [raw.models.default] : [],
      meta: filterModelMeta(raw.models?.meta, list),
    },
    proxy: normalizeProxyValue(raw.proxy),
    bridgeMode: raw.bridgeMode,
    headers: raw.headers || {},
    fallbacks: normalizeFallbackNames(name, raw.fallbacks),
    updatedAt: raw.updatedAt || new Date(0).toISOString(),
  };
}

export function storeRoot(tool: Tool): string {
  return getToolStoreDir(tool);
}
