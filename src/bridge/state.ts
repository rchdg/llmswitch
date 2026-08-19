import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { atomicWriteFile, ensureDir } from "../utils/fs.js";
import { getAppConfigRoot } from "../utils/paths.js";
import {
  DEFAULT_BRIDGE_HOST,
  DEFAULT_BRIDGE_PORT,
  emptyUpstreams,
  type BridgeInstanceState,
  type BridgeListenerState,
  type BridgePendingState,
  type BridgeRuntimeState,
  type BridgeTool,
  type BridgeUpstream,
  type BridgeUpstreams,
} from "./types.js";

const STATE_VERSION = 2 as const;
const MAX_PID = 2_147_483_647;
const LOCK_STALE_MS = 120_000;
const LOCK_DEFAULT_TIMEOUT_MS = 5_000;

export class BridgeStateConflictError extends Error {
  constructor(expected: number, actual: number) {
    super(`Bridge 状态版本冲突：期望 revision ${expected}，实际 ${actual}`);
    this.name = "BridgeStateConflictError";
  }
}

export class BridgeLockTimeoutError extends Error {
  constructor(message = "获取 bridge 锁超时") {
    super(message);
    this.name = "BridgeLockTimeoutError";
  }
}

export function getBridgeDir(): string {
  return join(getAppConfigRoot(), "bridge");
}

export function getBridgeStatePath(): string {
  return join(getBridgeDir(), "state.json");
}

/** @deprecated v1 single-object upstream file; read once for migration only. */
export function getBridgeUpstreamPath(): string {
  return join(getBridgeDir(), "upstream.json");
}

/** @deprecated PID is diagnostic only; identity lives in state.instance. */
export function getBridgePidPath(): string {
  return join(getBridgeDir(), "bridge.pid");
}

export function getBridgeLockPath(): string {
  return join(getBridgeDir(), "state.lock");
}

export function getTransactionsDir(): string {
  return join(getAppConfigRoot(), "transactions");
}

// --- tokens -----------------------------------------------------------------

/** 32 random bytes as unpadded base64url. */
export function generateBridgeToken(): string {
  return randomBytes(32).toString("base64url");
}

export function isValidBridgeToken(token: unknown): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
}

/** Constant-time token comparison; length mismatch is a fast, safe reject. */
export function constantTimeTokenEqual(
  a: string | undefined | null,
  b: string | undefined | null,
): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// --- upstream normalization -------------------------------------------------

function isLegacyUpstream(raw: unknown): raw is BridgeUpstream {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const row = raw as Record<string, unknown>;
  return (
    typeof row.baseUrl === "string" &&
    !("codex" in row) &&
    !("claude" in row) &&
    !("opencode" in row)
  );
}

export function normalizeBridgeUpstreams(raw: unknown): BridgeUpstreams {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return emptyUpstreams();
  }
  const row = raw as Record<string, unknown>;
  if (isLegacyUpstream(raw)) {
    return { codex: raw, claude: null, opencode: null };
  }
  return {
    codex: (row.codex as BridgeUpstream | null | undefined) ?? null,
    claude: (row.claude as BridgeUpstream | null | undefined) ?? null,
    opencode: (row.opencode as BridgeUpstream | null | undefined) ?? null,
  };
}

/** Legacy upstreams cannot authenticate until reapplied. */
function markUpstreamMigrationRequired(
  upstream: BridgeUpstream | null,
): BridgeUpstream | null {
  if (!upstream) return null;
  return { ...upstream, clientToken: null, migrationRequired: true };
}

// --- persistence ------------------------------------------------------------

function isValidPid(pid: unknown): pid is number {
  return (
    typeof pid === "number" &&
    Number.isInteger(pid) &&
    pid >= 1 &&
    pid <= MAX_PID
  );
}

function defaultListener(): BridgeListenerState {
  return {
    bindHost: process.env.LLM_SWITCH_BRIDGE_HOST || DEFAULT_BRIDGE_HOST,
    advertiseHost: process.env.LLM_SWITCH_BRIDGE_HOST || DEFAULT_BRIDGE_HOST,
    port: Number(process.env.LLM_SWITCH_BRIDGE_PORT) || DEFAULT_BRIDGE_PORT,
    allowRemote: false,
  };
}

function withFlatAliases(
  state: Omit<BridgeRuntimeState, "port" | "pid" | "host">,
): BridgeRuntimeState {
  return {
    ...state,
    port: state.listener.port,
    pid: state.instance?.pid ?? null,
    host: state.listener.bindHost,
  };
}

function parseInstance(raw: unknown): BridgeInstanceState | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (
    typeof row.id !== "string" ||
    !isValidBridgeToken(row.controlToken) ||
    !isValidPid(row.pid)
  ) {
    return null;
  }
  return {
    id: row.id,
    controlToken: row.controlToken,
    pid: row.pid,
    startedAt: typeof row.startedAt === "string" ? row.startedAt : "",
  };
}

function parseListener(raw: unknown): BridgeListenerState {
  const fallback = defaultListener();
  if (!raw || typeof raw !== "object") return fallback;
  const row = raw as Record<string, unknown>;
  return {
    bindHost: typeof row.bindHost === "string" ? row.bindHost : fallback.bindHost,
    advertiseHost:
      typeof row.advertiseHost === "string"
        ? row.advertiseHost
        : fallback.advertiseHost,
    port: typeof row.port === "number" ? row.port : fallback.port,
    allowRemote: row.allowRemote === true,
  };
}

/**
 * Read the one-time v1 migration state: legacy upstream.json, flagged so it can
 * be inspected but never authenticate a client until reapplied.
 */
function readLegacyMigrationState(): BridgeRuntimeState | null {
  const legacyPath = getBridgeUpstreamPath();
  if (!existsSync(legacyPath)) return null;
  try {
    const upstreams = normalizeBridgeUpstreams(
      JSON.parse(readFileSync(legacyPath, "utf8")),
    );
    return withFlatAliases({
      version: STATE_VERSION,
      revision: 0,
      listener: defaultListener(),
      instance: null,
      upstreams: {
        codex: markUpstreamMigrationRequired(upstreams.codex),
        claude: markUpstreamMigrationRequired(upstreams.claude),
        opencode: markUpstreamMigrationRequired(upstreams.opencode),
      },
      pending: null,
    });
  } catch {
    return null;
  }
}

export function readBridgeState(): BridgeRuntimeState {
  const path = getBridgeStatePath();
  if (!existsSync(path)) {
    const legacy = readLegacyMigrationState();
    if (legacy) return legacy;
    return withFlatAliases({
      version: STATE_VERSION,
      revision: 0,
      listener: defaultListener(),
      instance: null,
      upstreams: emptyUpstreams(),
      pending: null,
    });
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const pending =
      raw.pending && typeof raw.pending === "object"
        ? {
            revision: Number((raw.pending as Record<string, unknown>).revision) || 0,
            upstreams: normalizeBridgeUpstreams(
              (raw.pending as Record<string, unknown>).upstreams,
            ),
            transactionId: (raw.pending as Record<string, unknown>)
              .transactionId as string | undefined,
          }
        : null;
    return withFlatAliases({
      version: STATE_VERSION,
      revision: typeof raw.revision === "number" ? raw.revision : 0,
      listener: parseListener(raw.listener),
      instance: parseInstance(raw.instance),
      upstreams: normalizeBridgeUpstreams(raw.upstreams),
      pending: pending as BridgePendingState | null,
    });
  } catch {
    return withFlatAliases({
      version: STATE_VERSION,
      revision: 0,
      listener: defaultListener(),
      instance: null,
      upstreams: emptyUpstreams(),
      pending: null,
    });
  }
}

function persistState(next: BridgeRuntimeState): void {
  ensureDir(getBridgeDir());
  try {
    chmodSync(getBridgeDir(), 0o700);
  } catch {
    // best effort; Windows relies on user-dir ACLs
  }
  const payload = {
    version: STATE_VERSION,
    revision: next.revision,
    listener: next.listener,
    instance: next.instance,
    upstreams: {
      codex: next.upstreams.codex,
      claude: next.upstreams.claude,
      opencode: next.upstreams.opencode,
    },
    pending: next.pending,
  };
  atomicWriteFile(getBridgeStatePath(), JSON.stringify(payload, null, 2) + "\n");
}

/**
 * Persist state with an incremented revision. Rejects stale writes: the input
 * revision must equal the on-disk revision (compare-and-set).
 */
export function writeBridgeState(state: BridgeRuntimeState): BridgeRuntimeState {
  const current = readBridgeState();
  if (existsSync(getBridgeStatePath()) && state.revision !== current.revision) {
    throw new BridgeStateConflictError(current.revision, state.revision);
  }
  const next = withFlatAliases({
    version: STATE_VERSION,
    revision: current.revision + 1,
    listener: state.listener,
    instance: state.instance,
    upstreams: normalizeBridgeUpstreams(state.upstreams),
    pending: state.pending,
  });
  persistState(next);
  return next;
}

/**
 * Atomically mutate state under compare-and-set. `expectedRevision` defaults to
 * the current on-disk revision.
 */
export function updateBridgeState(
  mutate: (current: BridgeRuntimeState) => BridgeRuntimeState,
  expectedRevision?: number,
): BridgeRuntimeState {
  const current = readBridgeState();
  if (expectedRevision !== undefined && expectedRevision !== current.revision) {
    throw new BridgeStateConflictError(current.revision, expectedRevision);
  }
  const mutated = mutate(current);
  const next = withFlatAliases({
    version: STATE_VERSION,
    revision: current.revision + 1,
    listener: mutated.listener,
    instance: mutated.instance,
    upstreams: normalizeBridgeUpstreams(mutated.upstreams),
    pending: mutated.pending,
  });
  persistState(next);
  return next;
}

// --- upstream facade (compat) ----------------------------------------------

export function readBridgeUpstreams(): BridgeUpstreams {
  return readBridgeState().upstreams;
}

export function readBridgeUpstream(
  tool: BridgeTool = "codex",
): BridgeUpstream | null {
  return readBridgeUpstreams()[tool];
}

export function writeBridgeUpstream(
  tool: BridgeTool,
  upstream: BridgeUpstream | null,
): BridgeRuntimeState {
  return updateBridgeState((current) => ({
    ...current,
    upstreams: { ...current.upstreams, [tool]: upstream },
  }));
}

export function writeBridgeUpstreams(
  upstreams: BridgeUpstreams,
): BridgeRuntimeState {
  return updateBridgeState((current) => ({ ...current, upstreams }));
}

// --- URLs -------------------------------------------------------------------

function hostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/** Codex-facing base URL (includes /v1), using the connectable advertise host. */
export function bridgeBaseUrl(state?: BridgeRuntimeState): string {
  const s = state || readBridgeState();
  return `http://${hostForUrl(s.listener.advertiseHost)}:${s.listener.port}/v1`;
}

/** Claude-facing root URL (no /v1; client appends /v1/messages). */
export function bridgeRootUrl(state?: BridgeRuntimeState): string {
  const s = state || readBridgeState();
  return `http://${hostForUrl(s.listener.advertiseHost)}:${s.listener.port}`;
}

// --- file lock --------------------------------------------------------------

export interface BridgeLock {
  release(): void;
}

interface LockRecord {
  lockId: string;
  pid: number;
  instanceId: string | null;
  transactionId: string | null;
  createdAt: string;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function hasPendingJournal(transactionId: string | null): boolean {
  if (!transactionId) return false;
  return existsSync(join(getTransactionsDir(), `${transactionId}.json`));
}

function readLockRecord(path: string): LockRecord | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LockRecord;
  } catch {
    return null;
  }
}

/**
 * Acquire the exclusive bridge lock (global lock in the design's lock order).
 * Reclaims a stale lock when: (a) the owner PID is dead and an associated
 * transaction journal exists (immediate journal recovery), or (b) the owner PID
 * is dead and the lock is older than two minutes. Never steals a live lock.
 */
export function acquireBridgeLock(
  options: { timeoutMs?: number; instanceId?: string; transactionId?: string } = {},
): BridgeLock {
  ensureDir(getBridgeDir());
  const lockPath = getBridgeLockPath();
  const deadline = Date.now() + (options.timeoutMs ?? LOCK_DEFAULT_TIMEOUT_MS);
  const lockId = randomBytes(8).toString("hex");
  const record: LockRecord = {
    lockId,
    pid: process.pid,
    instanceId: options.instanceId ?? null,
    transactionId: options.transactionId ?? null,
    createdAt: new Date().toISOString(),
  };
  const serialized = JSON.stringify(record) + "\n";

  for (;;) {
    try {
      writeFileSync(lockPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
      return makeLock(lockPath, lockId);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    const existing = readLockRecord(lockPath);
    if (existing && reclaimable(existing, lockPath)) {
      // Atomically take over by replacing via temp rename.
      const tmp = `${lockPath}.${lockId}.tmp`;
      writeFileSync(tmp, serialized, { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, lockPath);
      const confirmed = readLockRecord(lockPath);
      if (confirmed?.lockId === lockId) return makeLock(lockPath, lockId);
    }

    if (Date.now() >= deadline) {
      throw new BridgeLockTimeoutError();
    }
    sleepSync(25);
  }
}

function reclaimable(record: LockRecord, lockPath: string): boolean {
  if (isValidPid(record.pid) && pidAlive(record.pid)) return false;
  // Dead owner with a pending journal: recover immediately.
  if (hasPendingJournal(record.transactionId)) return true;
  // Orphan lock without a journal: only after the stale age.
  let age = Number.POSITIVE_INFINITY;
  try {
    age = Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    age = Number.POSITIVE_INFINITY;
  }
  const recordedAge = record.createdAt
    ? Date.now() - Date.parse(record.createdAt)
    : Number.POSITIVE_INFINITY;
  return Math.max(age, recordedAge) > LOCK_STALE_MS;
}

function makeLock(lockPath: string, lockId: string): BridgeLock {
  return {
    release() {
      const current = readLockRecord(lockPath);
      if (current?.lockId === lockId) {
        rmSync(lockPath, { force: true });
      }
    },
  };
}

function sleepSync(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}
