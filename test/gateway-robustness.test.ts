import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireFileLock, tryWithFileLock } from "../src/utils/file-lock.ts";
import { splitQualified } from "../src/gateway/router.ts";
import {
  createGatewayKey,
  listGatewayKeys,
  publicKeyView,
  rotateGatewayKey,
} from "../src/gateway/keys.ts";
import {
  invalidateGatewayProviderCache,
  listGatewayProviders,
  saveGatewayProvider,
} from "../src/gateway/store.ts";
import { getUsageLockPath, recordUsage, summarizeUsage } from "../src/gateway/usage.ts";
import { envKeyName, legacyEnvKeyName } from "../src/adapters/codex.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "llms-gw-"));
  process.env.LLM_SWITCH_HOME = join(root, "home");
  invalidateGatewayProviderCache();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.LLM_SWITCH_HOME;
  invalidateGatewayProviderCache();
});

describe("file lock", () => {
  test("second acquire fails while the first is held", () => {
    const path = join(root, "x.lock");
    const held = acquireFileLock(path, { timeoutMs: 30 });
    expect(held).not.toBeNull();
    expect(acquireFileLock(path, { timeoutMs: 30 })).toBeNull();
    held!.release();
    const again = acquireFileLock(path, { timeoutMs: 30 });
    expect(again).not.toBeNull();
    again!.release();
  });

  test("onMiss decides the fallback when the lock is busy", () => {
    const path = join(root, "y.lock");
    const held = acquireFileLock(path, { timeoutMs: 30 })!;
    const result = tryWithFileLock(
      path,
      () => "ran",
      { timeoutMs: 20, onMiss: () => "skipped" },
    );
    expect(result).toBe("skipped");
    held.release();
  });
});

describe("usage accounting", () => {
  test("records under a lock and skips when the lock is held", () => {
    recordUsage({ keyId: "k1", provider: "p1", model: "m1", inputTokens: 5 });
    expect(summarizeUsage({ days: 1 })).toHaveLength(1);

    // 锁被别人拿着时应放弃这一条，而不是覆盖整份账
    const held = acquireFileLock(getUsageLockPath(), { timeoutMs: 30 })!;
    recordUsage({ keyId: "k2", provider: "p2", model: "m2" });
    held.release();

    const rows = summarizeUsage({ days: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key).toBe("k1");
  });

  test("aggregates repeated calls for the same triple", () => {
    recordUsage({ keyId: "k", provider: "p", model: "m", inputTokens: 2, outputTokens: 3 });
    recordUsage({ keyId: "k", provider: "p", model: "m", inputTokens: 4, outputTokens: 1 });
    const rows = summarizeUsage({ days: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.requests).toBe(2);
    expect(rows[0]!.inputTokens).toBe(6);
    expect(rows[0]!.outputTokens).toBe(4);
  });
});

describe("key hint", () => {
  // 之前 hint 同时暴露密钥的首 4 位和尾 4 位，与「仅存哈希」的说法不符。
  test("only exposes the last 4 characters of the secret", () => {
    const { key, plaintext } = createGatewayKey({ name: "t" });
    const secret = plaintext.split("-").pop()!;
    expect(key.hint).toContain(secret.slice(-4));
    expect(key.hint).not.toContain(secret.slice(0, 4));
    expect(key.hint).not.toContain(secret);
    expect(publicKeyView(key).hint).toBe(key.hint);
  });

  test("rotate keeps the same rule", () => {
    const created = createGatewayKey({ name: "t" });
    const rotated = rotateGatewayKey(created.key.id);
    const secret = rotated.plaintext.split("-").pop()!;
    expect(rotated.key.hint).toContain(secret.slice(-4));
    expect(rotated.key.hint).not.toContain(secret.slice(0, 4));
    expect(listGatewayKeys()).toHaveLength(1);
  });
});

describe("splitQualified is shared with the CLI", () => {
  test("accepts both separators", () => {
    expect(splitQualified("openrouter/openai/gpt-4o")).toEqual({
      provider: "openrouter",
      model: "openai/gpt-4o",
    });
    expect(splitQualified("azure:gpt-4o")).toEqual({
      provider: "azure",
      model: "gpt-4o",
    });
    expect(splitQualified("bare-model")).toBeNull();
    expect(splitQualified("/leading")).toBeNull();
  });
});

describe("codex id collisions", () => {
  // `a-b` 与 `a_b` 以前都被规整成 `a_b`，会互相覆盖 provider 块与 API Key。
  test("names differing only by separator get distinct env keys", () => {
    expect(envKeyName("a-b")).not.toBe(envKeyName("a_b"));
    expect(legacyEnvKeyName("a-b")).toBe(legacyEnvKeyName("a_b"));
  });

  test("plain names are unchanged and stay readable", () => {
    expect(envKeyName("abc12")).toBe("LLM_SWITCH_ABC12_API_KEY");
  });
});

describe("provider list cache", () => {
  test("a save is visible immediately", () => {
    saveGatewayProvider({
      name: "p1",
      displayName: "P1",
      apiFormat: "openai-chat",
      baseUrl: "https://a.test/v1",
      apiKey: "k",
      models: ["m"],
    } as never);
    expect(listGatewayProviders().map((p) => p.name)).toEqual(["p1"]);

    saveGatewayProvider({
      name: "p2",
      displayName: "P2",
      apiFormat: "openai-chat",
      baseUrl: "https://b.test/v1",
      apiKey: "k",
      models: ["m"],
    } as never);
    expect(listGatewayProviders().map((p) => p.name)).toEqual(["p1", "p2"]);
  });

  test("an out-of-band edit is picked up after invalidation", () => {
    saveGatewayProvider({
      name: "p1",
      displayName: "P1",
      apiFormat: "openai-chat",
      baseUrl: "https://a.test/v1",
      apiKey: "k",
      models: ["m"],
    } as never);
    expect(listGatewayProviders()).toHaveLength(1);

    writeFileSync(
      join(root, "home", "gateway", "providers", "p3.json"),
      JSON.stringify({
        name: "p3",
        apiFormat: "openai-chat",
        baseUrl: "https://c.test/v1",
        models: ["m"],
      }),
    );
    invalidateGatewayProviderCache();
    expect(listGatewayProviders().map((p) => p.name)).toEqual(["p1", "p3"]);
  });
});
