import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BridgeLockTimeoutError,
  BridgeStateConflictError,
  acquireBridgeLock,
  constantTimeTokenEqual,
  generateBridgeToken,
  getBridgeDir,
  getBridgeLockPath,
  getBridgeStatePath,
  getBridgeUpstreamPath,
  getTransactionsDir,
  isValidBridgeToken,
  readBridgeState,
  readBridgeUpstreams,
  updateBridgeState,
  writeBridgeState,
  writeBridgeUpstream,
} from "../src/bridge/state.ts";
import type { BridgeUpstream } from "../src/bridge/types.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "llms-bridge-state-"));
  process.env.LLM_SWITCH_HOME = join(root, "home");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.LLM_SWITCH_HOME;
});

function upstream(name: string): BridgeUpstream {
  return {
    baseUrl: `http://${name}.test/v1`,
    apiKey: `${name}-secret`,
    mode: "chat",
    profileName: name,
    updatedAt: "2026-07-30T00:00:00.000Z",
  };
}

describe("bridge tokens", () => {
  test("uses 32 random bytes encoded as unpadded base64url", () => {
    const first = generateBridgeToken();
    const second = generateBridgeToken();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isValidBridgeToken(first)).toBe(true);
    expect(first).not.toBe(second);
    expect(constantTimeTokenEqual(first, first)).toBe(true);
    expect(constantTimeTokenEqual(first, second)).toBe(false);
    expect(constantTimeTokenEqual(first, `${first}=`)).toBe(false);
    expect(isValidBridgeToken("short")).toBe(false);
  });
});

describe("BridgeStateV2", () => {
  test("writes one authoritative 0600 v2 state with a 0700 directory", () => {
    const initial = readBridgeState();
    expect(initial).toMatchObject({
      version: 2,
      revision: 0,
      host: "127.0.0.1",
      port: 17890,
      pid: null,
      instance: null,
      pending: null,
    });

    const saved = writeBridgeState({
      ...initial,
      upstreams: { codex: upstream("codex"), claude: null },
    });
    expect(saved.revision).toBe(1);
    expect(saved.upstreams.codex?.profileName).toBe("codex");

    const raw = JSON.parse(readFileSync(getBridgeStatePath(), "utf8"));
    expect(raw).toMatchObject({
      version: 2,
      revision: 1,
      listener: {
        bindHost: "127.0.0.1",
        advertiseHost: "127.0.0.1",
        port: 17890,
        allowRemote: false,
      },
      instance: null,
      pending: null,
    });
    expect(raw.host).toBeUndefined();
    expect(raw.pid).toBeUndefined();
    expect(existsSync(getBridgeUpstreamPath())).toBe(false);

    if (process.platform !== "win32") {
      expect(statSync(getBridgeDir()).mode & 0o777).toBe(0o700);
      expect(statSync(getBridgeStatePath()).mode & 0o777).toBe(0o600);
    }
  });

  test("rejects stale revision writes and exposes an atomic CAS updater", () => {
    const stale = readBridgeState();
    const first = writeBridgeState(stale);
    expect(first.revision).toBe(1);
    expect(() => writeBridgeState(stale)).toThrow(BridgeStateConflictError);

    const second = updateBridgeState(
      (current) => ({
        ...current,
        upstreams: { ...current.upstreams, claude: upstream("claude") },
      }),
      first.revision,
    );
    expect(second.revision).toBe(2);
    expect(second.upstreams.claude?.profileName).toBe("claude");
    expect(() => updateBridgeState((state) => state, first.revision)).toThrow(
      BridgeStateConflictError,
    );
  });

  test("reads v1 only before v2 establishment and marks it for migration", () => {
    mkdirSync(getBridgeDir(), { recursive: true });
    writeFileSync(
      getBridgeUpstreamPath(),
      JSON.stringify({ codex: upstream("legacy"), claude: null }),
    );

    const migrated = readBridgeState();
    expect(migrated.upstreams.codex).toMatchObject({
      profileName: "legacy",
      clientToken: null,
      migrationRequired: true,
    });

    writeBridgeState(migrated);
    writeFileSync(
      getBridgeUpstreamPath(),
      JSON.stringify({ codex: upstream("stale"), claude: null }),
    );
    expect(readBridgeUpstreams().codex?.profileName).toBe("legacy");

    writeBridgeUpstream("codex", upstream("current"));
    expect(readBridgeUpstreams().codex?.profileName).toBe("current");
    expect(
      JSON.parse(readFileSync(getBridgeUpstreamPath(), "utf8")).codex
        .profileName,
    ).toBe("stale");
  });

  test("drops invalid runtime PID identity", () => {
    const token = generateBridgeToken();
    mkdirSync(getBridgeDir(), { recursive: true });
    writeFileSync(
      getBridgeStatePath(),
      JSON.stringify({
        version: 2,
        revision: 4,
        listener: {
          bindHost: "127.0.0.1",
          advertiseHost: "127.0.0.1",
          port: 17890,
          allowRemote: false,
        },
        instance: {
          id: "bad-pid",
          controlToken: token,
          pid: -1,
          startedAt: "2026-07-30T00:00:00.000Z",
        },
        upstreams: { codex: null, claude: null },
        pending: null,
      }),
    );
    expect(readBridgeState().instance).toBeNull();
    expect(readBridgeState().pid).toBeNull();
  });
});

describe("bridge file lock", () => {
  test("does not steal a lock whose owner PID is alive", () => {
    const held = acquireBridgeLock({ timeoutMs: 50 });
    try {
      expect(() => acquireBridgeLock({ timeoutMs: 20 })).toThrow(
        BridgeLockTimeoutError,
      );
    } finally {
      held.release();
    }
  });

  test("recovers an old orphan lock after two minutes", () => {
    mkdirSync(getBridgeDir(), { recursive: true });
    writeFileSync(
      getBridgeLockPath(),
      JSON.stringify({
        lockId: "orphan",
        pid: 2_147_483_647,
        instanceId: null,
        transactionId: null,
        createdAt: new Date(Date.now() - 121_000).toISOString(),
      }),
    );
    chmodSync(getBridgeLockPath(), 0o600);

    const lock = acquireBridgeLock({ timeoutMs: 100 });
    expect(JSON.parse(readFileSync(getBridgeLockPath(), "utf8")).pid).toBe(
      process.pid,
    );
    lock.release();
  });

  test("immediately recovers a dead transaction lock with a journal", () => {
    const transactionId = "txn-recover";
    mkdirSync(getTransactionsDir(), { recursive: true });
    mkdirSync(getBridgeDir(), { recursive: true });
    writeFileSync(
      join(getTransactionsDir(), `${transactionId}.json`),
      JSON.stringify({ transactionId, stage: "prepared" }),
    );
    writeFileSync(
      getBridgeLockPath(),
      JSON.stringify({
        lockId: "dead-transaction",
        pid: 2_147_483_647,
        instanceId: null,
        transactionId,
        createdAt: new Date().toISOString(),
      }),
    );

    const lock = acquireBridgeLock({ timeoutMs: 100 });
    expect(JSON.parse(readFileSync(getBridgeLockPath(), "utf8")).pid).toBe(
      process.pid,
    );
    lock.release();
  });
});
