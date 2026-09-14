/**
 * Cross-process advisory file lock.
 *
 * Used to serialise read-modify-write on the gateway's shared JSON state
 * (rate-limit counters, usage accounting). `llms gateway serve` and the
 * daemon can run at the same time, and both write those files with
 * atomic-replace — without a lock they silently clobber each other's whole
 * file.
 *
 * Locking is best-effort by design: `tryWithFileLock` returns a miss instead of
 * blocking forever, so bookkeeping can degrade rather than stall live traffic.
 */

import {
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { ensureDir } from "./fs.js";

export interface FileLockHandle {
  release(): void;
}

export interface FileLockOptions {
  /** Give up after this long (ms). */
  timeoutMs?: number;
  /** Reclaim a lock this old when its owner cannot be identified (ms). */
  staleMs?: number;
  /** Busy-wait interval between attempts (ms). */
  spinMs?: number;
}

const DEFAULT_TIMEOUT_MS = 500;
const DEFAULT_STALE_MS = 5_000;
const DEFAULT_SPIN_MS = 10;

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
function reclaimable(path: string, staleMs: number): boolean {
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
  return Math.max(fileAge, recordedAge) > staleMs;
}

function makeLock(path: string, id: string): FileLockHandle {
  return {
    release(): void {
      try {
        if (readLockId(path) === id) unlinkSync(path);
      } catch {
        // Already released or reclaimed.
      }
    },
  };
}

/**
 * Acquire `path` as a lock, or return null when it stays busy past the timeout.
 */
export function acquireFileLock(
  path: string,
  options: FileLockOptions = {},
  now = Date.now(),
): FileLockHandle | null {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const spinMs = options.spinMs ?? DEFAULT_SPIN_MS;
  const id = randomBytes(8).toString("hex");
  const payload = JSON.stringify({ id, pid: process.pid, at: now });
  const deadline = now + timeoutMs;

  // The directory may not exist yet on a fresh install; without this the
  // exclusive create below fails with ENOENT and persistence never engages.
  try {
    ensureDir(dirname(path));
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

    if (reclaimable(path, staleMs)) {
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
    sleepSync(spinMs);
  }
}

/**
 * Run `fn` under the lock. When the lock cannot be taken, `onMiss` decides the
 * fallback (default: run `fn` anyway — callers that must not block traffic).
 */
export function tryWithFileLock<T>(
  path: string,
  fn: () => T,
  options: FileLockOptions & { onMiss?: () => T } = {},
  now = Date.now(),
): T {
  const lock = acquireFileLock(path, options, now);
  if (!lock) {
    if (options.onMiss) return options.onMiss();
    return fn();
  }
  try {
    return fn();
  } finally {
    lock.release();
  }
}
