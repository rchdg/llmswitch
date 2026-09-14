/**
 * Gateway API key issuance and verification.
 *
 * Keys are high-entropy random secrets, so a single salted SHA-256 is enough at
 * rest: there is no low-entropy password to grind. A slow KDF would only add
 * per-request latency on the hot auth path. The plaintext is returned once at
 * creation and never persisted.
 *
 * Plaintext layout: `llmsk-<keyId>-<secret>`. The embedded id makes lookup O(1)
 * so verification hashes exactly one candidate.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { atomicWriteFile, ensureDir } from "../utils/fs.js";
import { getGatewayDir, getGatewayKeysPath } from "../utils/paths.js";
import { checkDailyQuota, checkRateLimit, type RateLimitDecision } from "./rate-limit.js";
import {
  isGatewayFormat,
  type GatewayFormat,
  type GatewayKey,
  type GatewayKeyScopeFormat,
} from "./types.js";

const KEY_PREFIX = "llmsk";
const KEY_ID_BYTES = 6;
const KEY_SECRET_BYTES = 32;
const SALT_BYTES = 16;
/**
 * Explicit "never rate-limit this key" marker. `0` keeps the legacy meaning of
 * inheriting the global default so existing key files behave unchanged.
 */
export const UNLIMITED_RATE_LIMIT = -1;
/** Minimum gap between lastUsedAt persists for one key. */
const TOUCH_INTERVAL_MS = 60_000;
const lastTouchedAt = new Map<string, number>();

export class GatewayKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayKeyError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function hashSecret(secret: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${secret}`, "utf8").digest("hex");
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function normalizeFormats(value: unknown): GatewayKeyScopeFormat[] {
  const list = stringList(value);
  if (!list.length) return ["*"];
  if (list.includes("*")) return ["*"];
  const out = list.filter((item): item is GatewayFormat =>
    isGatewayFormat(item),
  );
  return out.length ? out : ["*"];
}

/**
 * Strict format validation for newly issued keys: an invalid value must fail
 * loudly instead of silently widening the scope to every format.
 */
function assertValidFormats(value: unknown): void {
  const list = stringList(value);
  for (const item of list) {
    if (item !== "*" && !isGatewayFormat(item)) {
      throw new GatewayKeyError(
        `无效的接口格式「${item}」。可用：openai-chat, anthropic, openai-responses, *`,
      );
    }
  }
}

/** Non-negative integer or 0. */
function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

/** Per-key rate limit: >= 1 is a cap, 0 inherits the global default, -1 is unlimited. */
function normalizeRateLimit(value: unknown): number {
  if (value === UNLIMITED_RATE_LIMIT) return UNLIMITED_RATE_LIMIT;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return 0;
}

function normalizeKey(raw: unknown): GatewayKey | null {
  const row = asRecord(raw);
  if (!row) return null;
  const id = String(row.id || "").trim();
  const hash = String(row.hash || "").trim();
  const salt = String(row.salt || "").trim();
  if (!id || !hash || !salt) return null;
  return {
    id,
    name: typeof row.name === "string" && row.name ? row.name : id,
    hash,
    salt,
    hint: typeof row.hint === "string" ? row.hint : "",
    createdAt:
      typeof row.createdAt === "string"
        ? row.createdAt
        : new Date(0).toISOString(),
    expiresAt: typeof row.expiresAt === "string" ? row.expiresAt : null,
    revokedAt: typeof row.revokedAt === "string" ? row.revokedAt : null,
    providers: stringList(row.providers),
    models: stringList(row.models),
    formats: normalizeFormats(row.formats),
    rateLimitPerMinute: normalizeRateLimit(row.rateLimitPerMinute),
    requestsPerDay: nonNegative(row.requestsPerDay),
    lastUsedAt: typeof row.lastUsedAt === "string" ? row.lastUsedAt : null,
  };
}

export function listGatewayKeys(): GatewayKey[] {
  const path = getGatewayKeysPath();
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const rows = Array.isArray(raw)
      ? raw
      : Array.isArray(asRecord(raw)?.keys)
        ? (asRecord(raw)!.keys as unknown[])
        : [];
    return rows
      .map(normalizeKey)
      .filter((key): key is GatewayKey => key !== null);
  } catch {
    return [];
  }
}

function writeGatewayKeys(keys: readonly GatewayKey[]): void {
  ensureDir(getGatewayDir());
  try {
    chmodSync(getGatewayDir(), 0o700);
  } catch {
    // Windows relies on user-directory ACLs.
  }
  atomicWriteFile(
    getGatewayKeysPath(),
    JSON.stringify({ version: 1, keys }, null, 2) + "\n",
  );
}

export interface CreateGatewayKeyOptions {
  name?: string;
  /** Days until expiry; omit or 0 for no expiry. */
  expiresInDays?: number;
  providers?: string[];
  models?: string[];
  formats?: string[];
  /**
   * Per-minute request cap. `> 0` is a hard cap, `0` inherits the global
   * default, `-1` is explicitly unlimited.
   */
  rateLimitPerMinute?: number;
  /** Daily request quota; 0 (default) means no daily quota. */
  requestsPerDay?: number;
}

export interface CreatedGatewayKey {
  key: GatewayKey;
  /** Shown once; not recoverable afterwards. */
  plaintext: string;
}

/**
 * Display hint for a key. The id alone already identifies the key, so only the
 * last 4 characters of the secret are shown — the previous form leaked both the
 * first and last 4 characters into `key list`, `status --json` and the keys file,
 * which sits badly with the "only the hash is stored" promise.
 */
function keyHint(id: string, secret: string): string {
  return `${KEY_PREFIX}-${id}-…${secret.slice(-4)}`;
}

export function createGatewayKey(
  options: CreateGatewayKeyOptions = {},
): CreatedGatewayKey {
  assertValidFormats(options.formats);
  const id = randomBytes(KEY_ID_BYTES).toString("hex");
  const secret = randomBytes(KEY_SECRET_BYTES).toString("base64url");
  const salt = randomBytes(SALT_BYTES).toString("hex");
  const plaintext = `${KEY_PREFIX}-${id}-${secret}`;

  const days = options.expiresInDays ?? 0;
  if (days < 0 || !Number.isFinite(days)) {
    throw new GatewayKeyError("有效期天数必须是非负数");
  }
  const expiresAt =
    days > 0
      ? new Date(Date.now() + days * 86_400_000).toISOString()
      : null;

  const key: GatewayKey = {
    id,
    name: options.name?.trim() || `key-${id.slice(0, 4)}`,
    hash: hashSecret(secret, salt),
    salt,
    hint: keyHint(id, secret),
    createdAt: new Date().toISOString(),
    expiresAt,
    revokedAt: null,
    providers: stringList(options.providers),
    models: stringList(options.models),
    formats: normalizeFormats(options.formats),
    rateLimitPerMinute: normalizeRateLimit(options.rateLimitPerMinute),
    requestsPerDay: nonNegative(options.requestsPerDay),
    lastUsedAt: null,
  };

  writeGatewayKeys([...listGatewayKeys(), key]);
  return { key, plaintext };
}

export function revokeGatewayKey(idOrName: string): GatewayKey {
  const keys = listGatewayKeys();
  const target = findKeyByIdOrName(keys, idOrName);
  if (!target) throw new GatewayKeyError(`未找到 API Key「${idOrName}」`);
  if (target.revokedAt) return target;
  const revoked: GatewayKey = {
    ...target,
    revokedAt: new Date().toISOString(),
  };
  writeGatewayKeys(keys.map((key) => (key.id === target.id ? revoked : key)));
  return revoked;
}

export function deleteGatewayKey(idOrName: string): GatewayKey {
  const keys = listGatewayKeys();
  const target = findKeyByIdOrName(keys, idOrName);
  if (!target) throw new GatewayKeyError(`未找到 API Key「${idOrName}」`);
  writeGatewayKeys(keys.filter((key) => key.id !== target.id));
  return target;
}

export interface UpdateGatewayKeyPatch {
  name?: string;
  /** Replaces the scope when provided. */
  providers?: string[];
  /** Replaces the scope when provided. */
  models?: string[];
  /** Replaces the scope when provided; validated strictly. */
  formats?: string[];
  /** Per-minute cap: -1 unlimited, 0 inherit global, > 0 hard cap. */
  rateLimitPerMinute?: number;
  /** Daily quota; 0 clears the quota. */
  requestsPerDay?: number;
  /**
   * New expiry relative to now, in days. 0 clears the expiry; omit to leave
   * the existing expiry untouched.
   */
  expiresInDays?: number;
}

export function updateGatewayKey(
  idOrName: string,
  patch: UpdateGatewayKeyPatch,
): GatewayKey {
  assertValidFormats(patch.formats ?? []);
  const days = patch.expiresInDays;
  if (days !== undefined && (days < 0 || !Number.isFinite(days))) {
    throw new GatewayKeyError("有效期天数必须是非负数");
  }
  const keys = listGatewayKeys();
  const target = findKeyByIdOrName(keys, idOrName);
  if (!target) throw new GatewayKeyError(`未找到 API Key「${idOrName}」`);
  const next: GatewayKey = {
    ...target,
    name: patch.name?.trim() || target.name,
    ...(patch.providers ? { providers: stringList(patch.providers) } : {}),
    ...(patch.models ? { models: stringList(patch.models) } : {}),
    ...(patch.formats ? { formats: normalizeFormats(patch.formats) } : {}),
    ...(patch.rateLimitPerMinute !== undefined
      ? { rateLimitPerMinute: normalizeRateLimit(patch.rateLimitPerMinute) }
      : {}),
    ...(patch.requestsPerDay !== undefined
      ? { requestsPerDay: nonNegative(patch.requestsPerDay) }
      : {}),
    ...(days !== undefined
      ? {
          expiresAt:
            days > 0
              ? new Date(Date.now() + days * 86_400_000).toISOString()
              : null,
        }
      : {}),
  };
  writeGatewayKeys(keys.map((key) => (key.id === target.id ? next : key)));
  return next;
}

/**
 * Re-issue a key with a fresh id and secret while keeping its scopes. The old
 * plaintext stops working immediately; the new one is shown once.
 */
export function rotateGatewayKey(idOrName: string): CreatedGatewayKey {
  const keys = listGatewayKeys();
  const target = findKeyByIdOrName(keys, idOrName);
  if (!target) throw new GatewayKeyError(`未找到 API Key「${idOrName}」`);

  const id = randomBytes(KEY_ID_BYTES).toString("hex");
  const secret = randomBytes(KEY_SECRET_BYTES).toString("base64url");
  const salt = randomBytes(SALT_BYTES).toString("hex");
  const rotated: GatewayKey = {
    ...target,
    id,
    hash: hashSecret(secret, salt),
    salt,
    hint: keyHint(id, secret),
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
  writeGatewayKeys(keys.map((key) => (key.id === target.id ? rotated : key)));
  return {
    key: rotated,
    plaintext: `${KEY_PREFIX}-${id}-${secret}`,
  };
}

function findKeyByIdOrName(
  keys: readonly GatewayKey[],
  idOrName: string,
): GatewayKey | undefined {
  const query = idOrName.trim();
  if (!query) return undefined;
  return (
    keys.find((key) => key.id === query) ||
    keys.find((key) => key.name === query) ||
    keys.find((key) => key.id.startsWith(query))
  );
}

export function publicKeyView(key: GatewayKey) {
  return {
    id: key.id,
    name: key.name,
    hint: key.hint,
    createdAt: key.createdAt,
    expiresAt: key.expiresAt,
    revokedAt: key.revokedAt,
    status: keyStatus(key),
    providers: key.providers,
    models: key.models,
    formats: key.formats,
    rateLimitPerMinute: key.rateLimitPerMinute,
    requestsPerDay: key.requestsPerDay,
    lastUsedAt: key.lastUsedAt,
  };
}

export function keyStatus(key: GatewayKey): "active" | "revoked" | "expired" {
  if (key.revokedAt) return "revoked";
  if (key.expiresAt && Date.parse(key.expiresAt) <= Date.now()) {
    return "expired";
  }
  return "active";
}

export function hasAnyActiveKey(): boolean {
  return listGatewayKeys().some((key) => keyStatus(key) === "active");
}

// --- verification -----------------------------------------------------------

export type AuthFailureReason =
  | "missing"
  | "malformed"
  | "unknown"
  | "revoked"
  | "expired"
  | "format_denied"
  | "rate_limited";

export type AuthResult =
  | { ok: true; key: GatewayKey; rate: RateLimitDecision }
  | {
      ok: false;
      reason: AuthFailureReason;
      retryAfterSeconds?: number;
      rate?: RateLimitDecision;
    };

function parsePlaintext(
  plaintext: string,
): { id: string; secret: string } | null {
  const parts = plaintext.trim().split("-");
  if (parts.length < 3) return null;
  if (parts[0] !== KEY_PREFIX) return null;
  const id = parts[1] ?? "";
  const secret = parts.slice(2).join("-");
  if (!id || !secret) return null;
  return { id, secret };
}

/** In-memory fixed-window counters were replaced by a cross-process store. */
export {
  checkDailyQuota,
  checkRateLimit,
  peekDailyQuota,
  peekRateLimit,
  resetRateLimits,
  type RateLimitDecision,
} from "./rate-limit.js";

export interface AuthenticateOptions {
  /** Inbound wire format being requested, for scope checks. */
  format?: GatewayFormat;
  /** Applied when the key sets no per-key limit. */
  defaultRateLimitPerMinute?: number;
  keys?: readonly GatewayKey[];
  now?: number;
}

/** -1 = unlimited, > 0 = per-key cap, otherwise fall back to the global default. */
export function resolveKeyRateLimit(
  keyLimit: number,
  defaultLimit: number,
): number {
  if (keyLimit === UNLIMITED_RATE_LIMIT) return 0;
  if (keyLimit > 0) return keyLimit;
  return defaultLimit > 0 ? defaultLimit : 0;
}

export function authenticateGatewayKey(
  presented: string | undefined | null,
  options: AuthenticateOptions = {},
): AuthResult {
  if (!presented || !presented.trim()) return { ok: false, reason: "missing" };
  const parsed = parsePlaintext(presented);
  if (!parsed) return { ok: false, reason: "malformed" };

  const keys = options.keys ?? listGatewayKeys();
  const candidate = keys.find((key) => key.id === parsed.id);
  if (!candidate) return { ok: false, reason: "unknown" };
  if (!constantTimeEqual(candidate.hash, hashSecret(parsed.secret, candidate.salt))) {
    return { ok: false, reason: "unknown" };
  }

  const now = options.now ?? Date.now();
  if (candidate.revokedAt) return { ok: false, reason: "revoked" };
  if (candidate.expiresAt && Date.parse(candidate.expiresAt) <= now) {
    return { ok: false, reason: "expired" };
  }

  if (options.format && !candidate.formats.includes("*")) {
    if (!candidate.formats.includes(options.format)) {
      return { ok: false, reason: "format_denied" };
    }
  }

  const limit = resolveKeyRateLimit(
    candidate.rateLimitPerMinute,
    options.defaultRateLimitPerMinute ?? 0,
  );
  const rate = checkRateLimit(candidate.id, limit, now);
  if (!rate.allowed) {
    return {
      ok: false,
      reason: "rate_limited",
      retryAfterSeconds: rate.retryAfterSeconds,
      rate,
    };
  }

  if (candidate.requestsPerDay > 0) {
    const daily = checkDailyQuota(candidate.id, candidate.requestsPerDay, now);
    if (!daily.allowed) {
      return {
        ok: false,
        reason: "rate_limited",
        retryAfterSeconds: daily.retryAfterSeconds,
        rate: daily,
      };
    }
  }

  return { ok: true, key: candidate, rate };
}

/**
 * Best-effort last-used bookkeeping. Debounced: a busy key would otherwise
 * rewrite the whole key file on every single request.
 */
export function touchGatewayKey(id: string, now = Date.now()): void {
  const last = lastTouchedAt.get(id) ?? 0;
  if (now - last < TOUCH_INTERVAL_MS) return;
  lastTouchedAt.set(id, now);
  try {
    const keys = listGatewayKeys();
    const next = keys.map((key) =>
      key.id === id ? { ...key, lastUsedAt: new Date(now).toISOString() } : key,
    );
    writeGatewayKeys(next);
  } catch {
    // Non-fatal.
  }
}

/**
 * Whether a key may use the resolved provider and model.
 *
 * `model` is the upstream id resolved by the router; `requestedModel` is the
 * raw id the client sent (an alias or a qualified `provider/model` reference).
 * A scope entry matches when it equals either id, so keys scoped to an alias
 * keep working after the alias is remapped to a different upstream id.
 */
export function keyAllowsTarget(
  key: GatewayKey,
  providerName: string,
  model: string,
  requestedModel?: string,
): boolean {
  if (key.providers.length && !key.providers.includes(providerName)) {
    return false;
  }
  if (!key.models.length) return true;
  return modelScopeMatches(key.models, providerName, model, requestedModel);
}

function modelScopeMatches(
  scope: readonly string[],
  providerName: string,
  model: string,
  requestedModel?: string,
): boolean {
  const provider = providerName.trim().toLowerCase();
  // Every spelling that should count as "this model on this provider".
  const wanted = new Set<string>();
  const add = (value: string | undefined): void => {
    const id = value?.trim().toLowerCase();
    if (!id) return;
    wanted.add(id);
    wanted.add(`${provider}/${id}`);
  };
  add(model);
  add(requestedModel);

  return scope.some((entry) => {
    const id = entry.trim().toLowerCase();
    if (!id) return false;
    if (wanted.has(id)) return true;
    // A scoped entry may itself be qualified (`provider/model`); compare both
    // halves so an entry for another provider never matches by accident.
    const separator = id.indexOf("/");
    if (separator <= 0) return false;
    return (
      id.slice(0, separator) === provider &&
      wanted.has(id.slice(separator + 1))
    );
  });
}
