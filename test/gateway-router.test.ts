import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ModelNotRoutableError,
  listRoutableModels,
  resolveModelRoute,
} from "../src/gateway/router.ts";
import {
  deleteGatewayProvider,
  importProvidersFromProfiles,
  listGatewayProviders,
  readGatewayConfig,
  saveGatewayProvider,
  saveGatewayRoute,
  writeGatewayConfig,
} from "../src/gateway/store.ts";
import {
  authenticateGatewayKey,
  createGatewayKey,
  deleteGatewayKey,
  hasAnyActiveKey,
  keyAllowsTarget,
  keyStatus,
  listGatewayKeys,
  resetRateLimits,
  revokeGatewayKey,
} from "../src/gateway/keys.ts";
import {
  GatewayExposureError,
  resolveGatewayListener,
} from "../src/gateway/runtime.ts";
import { saveProfile } from "../src/store/profiles.ts";
import type { GatewayProvider } from "../src/gateway/types.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "llms-gateway-"));
  process.env.LLM_SWITCH_HOME = join(root, "home");
  resetRateLimits();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.LLM_SWITCH_HOME;
});

function provider(
  name: string,
  overrides: Partial<GatewayProvider> = {},
): GatewayProvider {
  return saveGatewayProvider({
    name,
    displayName: name,
    apiFormat: "openai-chat",
    baseUrl: `https://${name}.test/v1`,
    apiKey: `sk-${name}`,
    models: ["shared-model", `${name}-only`],
    headers: {},
    priority: 100,
    enabled: true,
    sourceProfile: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  });
}

describe("provider store", () => {
  test("persists and normalizes providers", () => {
    provider("alpha", { baseUrl: "https://alpha.test", apiFormat: "openai-chat" });
    const stored = listGatewayProviders();
    expect(stored).toHaveLength(1);
    // OpenAI formats are normalized to a single /v1 suffix.
    expect(stored[0]?.baseUrl).toBe("https://alpha.test/v1");
    expect(stored[0]?.enabled).toBe(true);
  });

  test("rejects invalid names", () => {
    expect(() =>
      saveGatewayProvider({
        name: "bad name!",
        displayName: "x",
        apiFormat: "openai-chat",
        baseUrl: "https://x.test",
        apiKey: "",
        models: [],
        priority: 100,
        enabled: true,
        sourceProfile: null,
        updatedAt: new Date().toISOString(),
      }),
    ).toThrow(/无效的 provider 名称/);
  });

  test("removing a provider prunes its routes and default reference", () => {
    provider("alpha");
    provider("beta");
    saveGatewayRoute({
      alias: "fast",
      provider: "alpha",
      fallbacks: [{ provider: "beta" }],
      updatedAt: new Date().toISOString(),
    });
    writeGatewayConfig({ ...readGatewayConfig(), defaultProvider: "alpha" });

    deleteGatewayProvider("alpha");

    expect(readGatewayConfig().defaultProvider).toBeNull();
    expect(() => resolveModelRoute("fast")).toThrow(ModelNotRoutableError);
  });

  test("imports tool profiles and de-duplicates identical upstreams", () => {
    saveProfile("codex", {
      name: "shared",
      displayName: "Shared",
      apiFormat: "openai-chat",
      baseUrl: "https://dup.test/v1",
      apiKey: "sk-dup",
      models: { default: "m1", list: ["m1", "m2"] },
      updatedAt: new Date().toISOString(),
    });
    saveProfile("claude", {
      name: "shared",
      displayName: "Shared",
      apiFormat: "openai-chat",
      baseUrl: "https://dup.test/v1",
      apiKey: "sk-dup",
      models: { default: "m1", list: ["m1"] },
      updatedAt: new Date().toISOString(),
    });
    saveProfile("opencode", {
      name: "other",
      displayName: "Other",
      apiFormat: "anthropic",
      baseUrl: "https://other.test",
      apiKey: "sk-other",
      models: { default: "claude-x", list: ["claude-x"] },
      updatedAt: new Date().toISOString(),
    });

    const result = importProvidersFromProfiles();
    expect(result.imported).toHaveLength(2);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toBe("重复上游");

    const names = listGatewayProviders().map((item) => item.name).sort();
    expect(names).toEqual(["other", "shared"]);

    // A second import is a no-op.
    expect(importProvidersFromProfiles().imported).toHaveLength(0);
  });
});

describe("model routing", () => {
  test("prefers an explicit alias route and keeps its fallbacks", () => {
    provider("alpha");
    provider("beta");
    saveGatewayRoute({
      alias: "gpt-4o",
      provider: "alpha",
      model: "alpha-only",
      fallbacks: [{ provider: "beta", model: "beta-only" }],
      updatedAt: new Date().toISOString(),
    });

    const { candidates } = resolveModelRoute("gpt-4o");
    expect(candidates.map((c) => [c.provider.name, c.model, c.source])).toEqual([
      ["alpha", "alpha-only", "route"],
      ["beta", "beta-only", "route"],
    ]);
  });

  test("resolves provider-qualified ids", () => {
    provider("alpha");
    provider("beta");
    const { candidates } = resolveModelRoute("beta/shared-model");
    expect(candidates[0]?.provider.name).toBe("beta");
    expect(candidates[0]?.model).toBe("shared-model");
    expect(candidates[0]?.source).toBe("qualified");
  });

  test("orders providers offering the same model by priority as a fallback chain", () => {
    provider("slow", { priority: 200 });
    provider("fast", { priority: 10 });
    const { candidates } = resolveModelRoute("shared-model");
    expect(candidates.map((c) => c.provider.name)).toEqual(["fast", "slow"]);
  });

  test("honours the configured fallback attempt cap", () => {
    provider("a", { priority: 1 });
    provider("b", { priority: 2 });
    provider("c", { priority: 3 });
    const config = readGatewayConfig();
    writeGatewayConfig({
      ...config,
      fallback: { ...config.fallback, maxAttempts: 2 },
    });
    expect(resolveModelRoute("shared-model").candidates).toHaveLength(2);
  });

  test("disabling fallback keeps only the primary candidate", () => {
    provider("a", { priority: 1 });
    provider("b", { priority: 2 });
    const config = readGatewayConfig();
    writeGatewayConfig({
      ...config,
      fallback: { ...config.fallback, enabled: false },
    });
    expect(resolveModelRoute("shared-model").candidates).toHaveLength(1);
  });

  test("providers without a model list act as passthrough upstreams", () => {
    provider("catchall", { models: [] });
    const { candidates } = resolveModelRoute("some-unknown-model");
    expect(candidates[0]?.provider.name).toBe("catchall");
    expect(candidates[0]?.model).toBe("some-unknown-model");
    expect(candidates[0]?.source).toBe("passthrough");
  });

  test("falls back to the configured default provider", () => {
    provider("alpha");
    writeGatewayConfig({ ...readGatewayConfig(), defaultProvider: "alpha" });
    const { candidates } = resolveModelRoute("mystery");
    expect(candidates[0]?.source).toBe("default");
  });

  test("skips disabled providers", () => {
    provider("alpha", { enabled: false });
    expect(() => resolveModelRoute("shared-model")).toThrow(
      ModelNotRoutableError,
    );
  });

  test("throws with the available model list when nothing matches", () => {
    provider("alpha");
    try {
      resolveModelRoute("nope");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ModelNotRoutableError);
      expect((err as ModelNotRoutableError).availableModels).toContain(
        "shared-model",
      );
    }
  });

  test("lists bare and qualified model ids", () => {
    provider("alpha", { models: ["m1"] });
    saveGatewayRoute({
      alias: "friendly",
      provider: "alpha",
      model: "m1",
      updatedAt: new Date().toISOString(),
    });
    const ids = listRoutableModels().map((model) => model.id);
    expect(ids).toEqual(["friendly", "m1", "alpha/m1"]);
  });
});

describe("api keys", () => {
  test("issues a key whose plaintext is only returned once", () => {
    const created = createGatewayKey({ name: "ci" });
    expect(created.plaintext.startsWith("llmsk-")).toBe(true);
    const stored = listGatewayKeys();
    expect(stored).toHaveLength(1);
    // The plaintext secret is never persisted.
    expect(JSON.stringify(stored)).not.toContain(
      created.plaintext.split("-").slice(2).join("-"),
    );
    expect(stored[0]?.hash).not.toBe(created.plaintext);
  });

  test("authenticates a valid key and rejects tampered ones", () => {
    const created = createGatewayKey({ name: "ci" });
    expect(authenticateGatewayKey(created.plaintext).ok).toBe(true);
    expect(authenticateGatewayKey(`${created.plaintext}x`)).toEqual({
      ok: false,
      reason: "unknown",
    });
    expect(authenticateGatewayKey("not-a-key")).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(authenticateGatewayKey(undefined)).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  test("rejects revoked and expired keys", () => {
    const revoked = createGatewayKey({ name: "gone" });
    const revokedRecord = revokeGatewayKey(revoked.key.id);
    expect(authenticateGatewayKey(revoked.plaintext)).toEqual({
      ok: false,
      reason: "revoked",
    });

    const expiring = createGatewayKey({ name: "short", expiresInDays: 1 });
    const future = Date.now() + 2 * 86_400_000;
    expect(authenticateGatewayKey(expiring.plaintext, { now: future })).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(keyStatus(revokedRecord)).toBe("revoked");
    expect(keyStatus(expiring.key)).toBe("active");
  });

  test("enforces format scopes", () => {
    const created = createGatewayKey({
      name: "chat-only",
      formats: ["openai-chat"],
    });
    expect(
      authenticateGatewayKey(created.plaintext, { format: "openai-chat" }).ok,
    ).toBe(true);
    expect(
      authenticateGatewayKey(created.plaintext, { format: "anthropic" }),
    ).toEqual({ ok: false, reason: "format_denied" });
  });

  test("enforces provider and model scopes", () => {
    const created = createGatewayKey({
      name: "scoped",
      providers: ["alpha"],
      models: ["m1"],
    });
    expect(keyAllowsTarget(created.key, "alpha", "m1")).toBe(true);
    expect(keyAllowsTarget(created.key, "beta", "m1")).toBe(false);
    expect(keyAllowsTarget(created.key, "alpha", "m2")).toBe(false);
  });

  test("applies the per-key rate limit", () => {
    const created = createGatewayKey({ name: "limited", rateLimitPerMinute: 2 });
    const now = Date.now();
    expect(authenticateGatewayKey(created.plaintext, { now }).ok).toBe(true);
    expect(authenticateGatewayKey(created.plaintext, { now }).ok).toBe(true);
    const third = authenticateGatewayKey(created.plaintext, { now });
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.reason).toBe("rate_limited");
      expect(third.retryAfterSeconds).toBeGreaterThan(0);
    }
    // The window rolls over.
    expect(
      authenticateGatewayKey(created.plaintext, { now: now + 61_000 }).ok,
    ).toBe(true);
  });

  test("falls back to the gateway default rate limit", () => {
    const created = createGatewayKey({ name: "default-limited" });
    const now = Date.now();
    expect(
      authenticateGatewayKey(created.plaintext, {
        now,
        defaultRateLimitPerMinute: 1,
      }).ok,
    ).toBe(true);
    expect(
      authenticateGatewayKey(created.plaintext, {
        now,
        defaultRateLimitPerMinute: 1,
      }).ok,
    ).toBe(false);
  });

  test("tracks active keys and supports deletion", () => {
    expect(hasAnyActiveKey()).toBe(false);
    const created = createGatewayKey({ name: "temp" });
    expect(hasAnyActiveKey()).toBe(true);
    deleteGatewayKey(created.key.id);
    expect(listGatewayKeys()).toHaveLength(0);
    expect(hasAnyActiveKey()).toBe(false);
  });
});

describe("listener exposure guards", () => {
  test("loopback binds need no opt-in", () => {
    const listener = resolveGatewayListener({
      host: "127.0.0.1",
      port: 17900,
      allowRemote: false,
    });
    expect(listener.bindHost).toBe("127.0.0.1");
  });

  test("non-loopback binds require --allow-remote", () => {
    expect(() =>
      resolveGatewayListener({
        host: "0.0.0.0",
        port: 17900,
        allowRemote: false,
      }),
    ).toThrow(GatewayExposureError);
  });

  test("non-loopback binds require at least one active key", () => {
    expect(() =>
      resolveGatewayListener({
        host: "0.0.0.0",
        port: 17900,
        allowRemote: true,
      }),
    ).toThrow(/至少存在一个有效 API Key/);

    createGatewayKey({ name: "public" });
    const listener = resolveGatewayListener({
      host: "0.0.0.0",
      port: 17900,
      allowRemote: true,
    });
    expect(listener.advertiseHost).toBe("127.0.0.1");
    expect(listener.allowRemote).toBe(true);
  });
});
