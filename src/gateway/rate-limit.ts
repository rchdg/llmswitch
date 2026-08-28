/**
 * Cross-process rate limiting.
 *
 * Counters live in a small JSON file guarded by an exclusive lock, so limits
 * survive a daemon restart and hold across several gateway processes sharing one
 * config directory (the common case being an accidental double start, or a
 * foreground `serve` alongside a daemon).
 *
 * Two deliberate trade-offs:
 *  - The critical section is a tiny read-modify-write. Upstream LLM calls take
 *    seconds, so a sub-millisecond file operation per request is irrelevant.
 *  - If the lock cannot be acquired quickly the request is allowed rather than
 *    blocked: a slightly loose limit is preferable to stalling live traffic on
 *    lock contention.
 */

import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { atomicWriteFile, ensureDir } from "../utils/fs.js";
import { getGatewayDir } from "../utils/paths.js";

const WINDOW_MS = 60_000;
const DAY_MS = 86_400_000;
const LOCK_TIMEOUT_MS = 500;
const LOCK_STALE_MS = 5_000;
const LOCK_SPIN_MS = 2;

export function getRateLimitPath(): string {
  return join(getGatewayDir(), "rate-limit.json");
}

export function getRateLimitLockPath(): string {
  return join(getGatewayDir(), "rate-limit.lock");
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Configured ceiling; 0 means unlimited. */
  limit: number;
  /** Requests left in the current window; -1 when unlimited. */
  remaining: number;
  /** Unix seconds when the current window resets; 0 when unlimited. */
  resetAt: number;
  retryAfterSeconds: number;
}

interface WindowRecord {
  windowStart: number;
  count: number;
}

type WindowMap = Record<string, WindowRecord>;

const UNLIMITED: RateLimitDecision = {
  allowed: true,
  limit: 0,
  remaining: -1,
  resetAt: 0,
  retryAfterSeconds: 0,
};

function sleepSync(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface LockHandle {
  release(): void;
}

/**
 * Acquire the counter lock, or return null when it stays busy past the timeout.
 * A lock whose owner process is gone and which is older than the stale age is
 * reclaimed.
 */
function acquireLock(now: number): LockHandle | null {
  const path = getRateLimitLockPath();
  const id = randomBytes(8).toString("hex");
  const payload = JSON.stringify({ id, pid: process.pid, at: now });
  const deadline = now + LOCK_TIMEOUT_MS;
  // The directory may not exist yet on a fresh install; without this the
  // exclusive create below fails with ENOENT and persistence never engages.
  try {
    ensureDir(getGatewayDir());
  } catch {
    return null;
  }

  for (;;) {
    try {
      writeFileSync(path, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
      return makeLock(path, id);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return null;
    }

    if (reclaimable(path)) {
      try {
        const tmp = `${path}.${id}.tmp`;
        writeFileSync(tmp, payload, { encoding: "utf8", mode: 0o600 });
        renameSync(tmp, path);
        if (readLockId(path) === id) return makeLock(path, id);
      } catch {
        // Someone else won the race; fall through and retry.
      }
    }

    if (Date.now() >= deadline) return null;
    sleepSync(LOCK_SPIN_MS);
  }
}

function readLockId(path: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { id?: unknown };
    return typeof raw.id === "string" ? raw.id : null;
  } catch {
    return null;
  }
}

/**
 * A lock is reclaimable when its owner is gone. A dead owner can never release
 * the lock, so that case is reclaimed immediately; when ownership cannot be
 * determined we fall back to an age check that trusts whichever of the file
 * mtime or the recorded timestamp looks older.
 */
function reclaimable(path: string): boolean {
  let record: { pid?: unknown; at?: unknown } = {};
  let readable = false;
  try {
    record = JSON.parse(readFileSync(path, "utf8")) as typeof record;
    readable = true;
  } catch {
    // Unreadable lock file: fall back to the age check below.
  }
  if (readable && typeof record.pid === "number") {
    return !pidAlive(record.pid);
  }

  let fileAge = Number.POSITIVE_INFINITY;
  try {
    fileAge = Date.now() - statSync(path).mtimeMs;
  } catch {
    return true;
  }
  const recordedAge =
    typeof record.at === "number"
      ? Date.now() - record.at
      : Number.NEGATIVE_INFINITY;
  return Math.max(fileAge, recordedAge) > LOCK_STALE_MS;
}

function makeLock(path: string, id: string): LockHandle {
  return {
    release() {
      if (readLockId(path) === id) rmSync(path, { force: true });
    },
  };
}

function readWindows(): WindowMap {
  const path = getRateLimitPath();
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const windows = raw.windows;
    if (!windows || typeof windows !== "object") return {};
    const out: WindowMap = {};
    for (const [key, value] of Object.entries(windows as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const row = value as Record<string, unknown>;
      if (typeof row.windowStart !== "number" || typeof row.count !== "number") {
        continue;
      }
      out[key] = { windowStart: row.windowStart, count: row.count };
    }
    return out;
  } catch {
    return {};
  }
}

function writeWindows(windows: WindowMap, now: number): void {
  // Drop windows that can no longer affect a decision.
  const pruned: WindowMap = {};
  for (const [key, record] of Object.entries(windows)) {
    const span = key.endsWith("#day") ? DAY_MS * 2 : WINDOW_MS * 2;
    if (now - record.windowStart < span) pruned[key] = record;
  }
  ensureDir(getGatewayDir());
  atomicWriteFile(
    getRateLimitPath(),
    JSON.stringify({ version: 1, windows: pruned }, null, 2) + "\n",
  );
}

/** In-process fallback used when the lock cannot be taken. */
const memoryWindows = new Map<string, WindowRecord>();

function decide(
  record: WindowRecord | undefined,
  limit: number,
  windowMs: number,
  now: number,
): { next: WindowRecord; decision: RateLimitDecision } {
  const fresh = !record || now - record.windowStart >= windowMs;
  const windowStart = fresh ? now : record!.windowStart;
  const used = fresh ? 0 : record!.count;
  const resetAt = Math.ceil((windowStart + windowMs) / 1000);

  if (used >= limit) {
    return {
      next: { windowStart, count: used },
      decision: {
        allowed: false,
        limit,
        remaining: 0,
        resetAt,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((windowStart + windowMs - now) / 1000),
        ),
      },
    };
  }

  const count = used + 1;
  return {
    next: { windowStart, count },
    decision: {
      allowed: true,
      limit,
      remaining: Math.max(0, limit - count),
      resetAt,
      retryAfterSeconds: 0,
    },
  };
}

/**
 * Consume one request slot for `keyId`. A limit of 0 or less is unlimited and
 * records nothing.
 */
export function checkRateLimit(
  keyId: string,
  limitPerMinute: number,
  now = Date.now(),
): RateLimitDecision {
  return checkWindow(keyId, limitPerMinute, WINDOW_MS, now);
}

/** Clear all counters (test seam and `llms gateway ratelimit reset`). */
export function resetRateLimits(): void {
  memoryWindows.clear();
  try {
    rmSync(getRateLimitPath(), { force: true });
    rmSync(getRateLimitLockPath(), { force: true });
  } catch {
    // Nothing persisted yet.
  }
}

/**
 * Consume one request slot from the UTC-day window for `keyId`. A limit of 0
 * or less means no daily quota and records nothing.
 */
export function checkDailyQuota(
  keyId: string,
  limitPerDay: number,
  now = Date.now(),
): RateLimitDecision {
  return checkWindow(`${keyId}#day`, limitPerDay, DAY_MS, now);
}

/** Read the daily window without consuming a slot. */
export function peekDailyQuota(
  keyId: string,
  limitPerDay: number,
  now = Date.now(),
): RateLimitDecision {
  return peekWindow(`${keyId}#day`, limitPerDay, DAY_MS, now);
}

function checkWindow(
  bucket: string,
  limit: number,
  windowMs: number,
  now: number,
): RateLimitDecision {
  if (!limit || limit <= 0) return { ...UNLIMITED };

  const lock = acquireLock(now);
  if (!lock) {
    const { next, decision } = decide(memoryWindows.get(bucket), limit, windowMs, now);
    memoryWindows.set(bucket, next);
    return decision;
  }

  try {
    const windows = readWindows();
    const { next, decision } = decide(windows[bucket], limit, windowMs, now);
    windows[bucket] = next;
    memoryWindows.set(bucket, next);
    writeWindows(windows, now);
    return decision;
  } catch {
    // Never fail a request because bookkeeping failed.
    return { ...UNLIMITED, limit };
  } finally {
    lock.release();
  }
}

/** Read the current window without consuming a slot. */
export function peekRateLimit(
  keyId: string,
  limitPerMinute: number,
  now = Date.now(),
): RateLimitDecision {
  return peekWindow(keyId, limitPerMinute, WINDOW_MS, now);
}

function peekWindow(
  bucket: string,
  limit: number,
  windowMs: number,
  now: number,
): RateLimitDecision {
  if (!limit || limit <= 0) return { ...UNLIMITED };
  const record = readWindows()[bucket] ?? memoryWindows.get(bucket);
  const fresh = !record || now - record.windowStart >= windowMs;
  const windowStart = fresh ? now : record!.windowStart;
  const used = fresh ? 0 : record!.count;
  return {
    allowed: used < limit,
    limit,
    remaining: Math.max(0, limit - used),
    resetAt: Math.ceil((windowStart + windowMs) / 1000),
    retryAfterSeconds: 0,
  };
}
