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
import { checkRateLimit, type RateLimitDecision } from "./rate-limit.js";
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
    rateLimitPerMinute:
      typeof row.rateLimitPerMinute === "number" && row.rateLimitPerMinute >= 0
        ? row.rateLimitPerMinute
        : 0,
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
  rateLimitPerMinute?: number;
}

export interface CreatedGatewayKey {
  key: GatewayKey;
  /** Shown once; not recoverable afterwards. */
  plaintext: string;
}

export function createGatewayKey(
  options: CreateGatewayKeyOptions = {},
): CreatedGatewayKey {
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
    hint: `${KEY_PREFIX}-${id}-${secret.slice(0, 4)}…${secret.slice(-4)}`,
    createdAt: new Date().toISOString(),
    expiresAt,
    revokedAt: null,
    providers: stringList(options.providers),
    models: stringList(options.models),
    formats: normalizeFormats(options.formats),
    rateLimitPerMinute:
      typeof options.rateLimitPerMinute === "number" &&
      options.rateLimitPerMinute >= 0
        ? Math.floor(options.rateLimitPerMinute)
        : 0,
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
  checkRateLimit,
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

  const limit =
    candidate.rateLimitPerMinute > 0
      ? candidate.rateLimitPerMinute
      : (options.defaultRateLimitPerMinute ?? 0);
  const rate = checkRateLimit(candidate.id, limit, now);
  if (!rate.allowed) {
    return {
      ok: false,
      reason: "rate_limited",
      retryAfterSeconds: rate.retryAfterSeconds,
      rate,
    };
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

/** Whether a key may use the resolved provider and model. */
export function keyAllowsTarget(
  key: GatewayKey,
  providerName: string,
  model: string,
): boolean {
  if (key.providers.length && !key.providers.includes(providerName)) {
    return false;
  }
  if (key.models.length) {
    const wanted = model.toLowerCase();
    const allowed = key.models.some(
      (item) => item.toLowerCase() === wanted,
    );
    if (!allowed) return false;
  }
  return true;
}
