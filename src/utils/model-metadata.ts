import type { ProxyConfig } from "../types.js";
import { requestWithNodeTransport } from "../bridge/transport.js";

export const MODEL_METADATA_SOURCE = "https://models.lonae.com";
const DEFAULT_ENDPOINT = `${MODEL_METADATA_SOURCE}/api/v1/models`;
const PAGE_SIZE = 1000;

export interface ModelModalities {
  input: string[];
  output: string[];
}

export interface ModelMeta {
  /** Canonical model id on models.lonae.com, e.g. "anthropic/claude-sonnet-4-5". */
  id?: string;
  /** Display name, e.g. "Claude Sonnet 4.5". */
  name?: string;
  modalities?: ModelModalities;
  attachment?: boolean;
}
/** Metadata index keyed by full id, bare id, and normalized variants. */
export interface ModelMetadataCatalog {
  full: Record<string, ModelMeta>;
  bare: Record<string, ModelMeta>;
  norm: Record<string, ModelMeta>;
}

interface MetadataPage {
  data?: unknown;
  meta?: { total?: unknown };
}

/** Trailing date stamp, e.g. "-20250219" in "claude-3-7-sonnet-20250219". */
const DATE_SUFFIX_RE = /-?\d{8}$/;

/**
 * Normalize a model id for fuzzy matching: lowercase, drop separators, and
 * align dotted version segments ("claude-3.7-sonnet" ↔ "claude-3-7-sonnet").
 */
export function normalizeModelKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/\./g, "-")
    .replace(/[^a-z0-9]/g, "");
}

/** Normalize a model id ignoring a trailing date stamp. */
export function normalizeModelKeyLoose(value: string): string {
  const bare = value.replace(DATE_SUFFIX_RE, "");
  return normalizeModelKey(bare) || normalizeModelKey(value);
}

function asModalityList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter(
    (item): item is string => typeof item === "string" && !!item.trim(),
  );
  return list.length > 0 ? list : undefined;
}

function parseModalities(row: Record<string, unknown>): ModelModalities | undefined {
  const nested = row.modalities;
  const input =
    (nested && typeof nested === "object"
      ? asModalityList((nested as Record<string, unknown>).input)
      : undefined) ?? asModalityList(row.inputModalities);
  const output =
    (nested && typeof nested === "object"
      ? asModalityList((nested as Record<string, unknown>).output)
      : undefined) ?? asModalityList(row.outputModalities);
  if (!input && !output) return undefined;
  return {
    input: input ?? ["text"],
    output: output ?? ["text"],
  };
}

/** Insert into a normalized bucket, preferring undated ids as canonical. */
function indexNorm(
  bucket: Record<string, ModelMeta>,
  datedMetas: Set<ModelMeta>,
  key: string,
  meta: ModelMeta,
  dated: boolean,
): void {
  if (!key) return;
  const existing = bucket[key];
  if (!existing) {
    bucket[key] = meta;
    return;
  }
  if (datedMetas.has(existing) && !dated) bucket[key] = meta;
}

/**
 * Build the lookup catalog from a /api/v1/models payload.
 * Indexes: full id ("lab/model"), bare id ("model"), plus normalized variants
 * (date-stamp tolerant) so "claude-3.7-sonnet" can find
 * "claude-3-7-sonnet-20250219".
 */
export function parseModelMetadata(payload: unknown): ModelMetadataCatalog {
  const catalog: ModelMetadataCatalog = { full: {}, bare: {}, norm: {} };
  const rows = payload && typeof payload === "object"
    ? (payload as MetadataPage).data
    : null;
  if (!Array.isArray(rows)) return catalog;

  const datedMetas = new Set<ModelMeta>();
  for (const item of rows) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || !row.id.trim()) continue;
    const id = row.id.trim();
    const meta: ModelMeta = {
      id,
      name: typeof row.name === "string" && row.name.trim() ? row.name.trim() : undefined,
      modalities: parseModalities(row),
      attachment: typeof row.attachment === "boolean" ? row.attachment : undefined,
    };

    const bareIndex = id.indexOf("/");
    const bare = bareIndex >= 0 ? id.slice(bareIndex + 1).trim() : id;
    const dated = DATE_SUFFIX_RE.test(bare);
    if (dated) datedMetas.add(meta);

    const fullKey = id.toLowerCase();
    const bareKey = bare.toLowerCase();
    const normKey = normalizeModelKey(bare);
    const looseKey = normalizeModelKeyLoose(bare);

    if (!catalog.full[fullKey]) catalog.full[fullKey] = meta;
    if (bare && !catalog.bare[bareKey]) catalog.bare[bareKey] = meta;
    indexNorm(catalog.norm, datedMetas, normKey, meta, dated);
    if (looseKey !== normKey) indexNorm(catalog.norm, datedMetas, looseKey, meta, dated);
  }
  return catalog;
}

/** Look up metadata for a profile model id (exact → bare → normalized). */
export function lookupModelMeta(
  catalog: ModelMetadataCatalog,
  modelId: string,
): ModelMeta | undefined {
  const trimmed = modelId.trim();
  if (!trimmed) return undefined;

  const bareIndex = trimmed.indexOf("/");
  const bare = bareIndex >= 0 ? trimmed.slice(bareIndex + 1).trim() : trimmed;
  return (
    catalog.full[trimmed.toLowerCase()] ??
    catalog.bare[bare.toLowerCase()] ??
    catalog.norm[normalizeModelKey(bare)] ??
    catalog.norm[normalizeModelKeyLoose(bare)]
  );
}

/** Collect metadata for a set of profile model ids. */
export function collectModelMeta(
  catalog: ModelMetadataCatalog | undefined | null,
  models: readonly string[],
): Record<string, ModelMeta> | undefined {
  if (!catalog) return undefined;
  const meta: Record<string, ModelMeta> = {};
  for (const id of models) {
    const found = lookupModelMeta(catalog, id);
    if (found) meta[id] = found;
  }
  return Object.keys(meta).length > 0 ? meta : undefined;
}

/**
 * Fetch the model metadata catalog from models.lonae.com.
 * Paginates automatically (page_size capped at 1000 per request).
 */
export async function fetchModelMetadata(
  options: { proxy?: ProxyConfig; timeoutMs?: number; endpoint?: string } = {},
): Promise<ModelMetadataCatalog> {
  const endpoint = options.endpoint || DEFAULT_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? 15_000;

  const rows: unknown[] = [];
  let total = Infinity;
  let page = 1;

  while (rows.length < total) {
    const url = `${endpoint}${endpoint.includes("?") ? "&" : "?"}page_size=${PAGE_SIZE}&page=${page}`;
    const payload = await requestJson(url, options.proxy, timeoutMs);
    const batch = payload && typeof payload === "object"
      ? (payload as MetadataPage).data
      : null;
    if (!Array.isArray(batch) || batch.length === 0) break;
    rows.push(...batch);

    const totalRaw = payload && typeof payload === "object"
      ? (payload as MetadataPage).meta?.total
      : undefined;
    total = typeof totalRaw === "number" && totalRaw > 0 ? totalRaw : rows.length;
    page += 1;
  }

  return parseModelMetadata({ data: rows });
}

async function requestJson(
  url: string,
  proxy: ProxyConfig | undefined,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await requestWithNodeTransport({
      url,
      method: "GET",
      headers: { Accept: "application/json" },
      proxy,
      signal: controller.signal,
      totalTimeoutMs: timeoutMs,
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`HTTP ${res.status}${body ? `: ${body}` : ""}`);
    }
    return await res.json();
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`请求超时（${timeoutMs}ms）`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
