import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Profile } from "../src/types.ts";
import { saveProfile, listProfiles, requireProfile } from "../src/store/profiles.ts";
import { buildClaudeSettings, applyClaudeProfile } from "../src/adapters/claude.ts";
import {
  buildCodexConfig,
  buildCodexEnvFile,
  applyCodexProfile,
  envKeyName,
} from "../src/adapters/codex.ts";
import {
  buildOpenCodeConfig,
  applyOpenCodeProfile,
} from "../src/adapters/opencode.ts";
import { assertCompatible } from "../src/formats/compatibility.ts";
import { buildProxyEnv } from "../src/utils/proxy.ts";

let root: string;

function setHomes(base: string) {
  process.env.LLM_SWITCH_HOME = join(base, "llms-home");
  process.env.CLAUDE_CONFIG_DIR = join(base, "claude");
  process.env.CODEX_HOME = join(base, "codex");
  process.env.OPENCODE_CONFIG_DIR = join(base, "opencode");
  process.env.OPENCODE_DATA_DIR = join(base, "opencode-data");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "llms-test-"));
  setHomes(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.LLM_SWITCH_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  delete process.env.OPENCODE_CONFIG_DIR;
  delete process.env.OPENCODE_DATA_DIR;
});

function sample(partial: Partial<Profile> & Pick<Profile, "name" | "apiFormat">): Profile {
  return {
    name: partial.name,
    displayName: partial.displayName || partial.name,
    apiFormat: partial.apiFormat,
    baseUrl: partial.baseUrl || "https://api.example.com",
    apiKey: partial.apiKey ?? "sk-test-key",
    models: partial.models || {
      default: "model-a",
      list: ["model-a", "model-b"],
    },
    proxy: partial.proxy,
    headers: partial.headers || {},
    updatedAt: new Date().toISOString(),
  };
}

describe("proxy env", () => {
  test("single socks url fills ALL and HTTP(S)", () => {
    const env = buildProxyEnv("socks5h://127.0.0.1:1080");
    expect(env.ALL_PROXY).toBe("socks5h://127.0.0.1:1080");
    expect(env.HTTP_PROXY).toBe("socks5h://127.0.0.1:1080");
    expect(env.HTTPS_PROXY).toBe("socks5h://127.0.0.1:1080");
  });

  test("single http url applies to all proxy vars", () => {
    const env = buildProxyEnv("http://127.0.0.1:5112");
    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:5112");
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:5112");
    expect(env.ALL_PROXY).toBe("http://127.0.0.1:5112");
  });

  test("empty proxy yields no vars", () => {
    expect(buildProxyEnv(undefined)).toEqual({});
    expect(buildProxyEnv("")).toEqual({});
  });
});

describe("compatibility", () => {
  test("claude rejects openai-responses", () => {
    expect(() => assertCompatible("claude", "openai-responses")).toThrow(
      /openai-chat|anthropic/,
    );
  });

  test("claude accepts openai-chat via bridge", () => {
    assertCompatible("claude", "openai-chat");
    assertCompatible("claude", "anthropic");
  });

  test("codex accepts openai-chat via bridge", () => {
    assertCompatible("codex", "openai-chat");
    assertCompatible("codex", "openai-responses");
  });

  test("opencode accepts all", () => {
    assertCompatible("opencode", "anthropic");
    assertCompatible("opencode", "openai-chat");
    assertCompatible("opencode", "openai-responses");
  });
});

describe("store", () => {
  test("save and list profiles", () => {
    saveProfile("claude", sample({ name: "deepseek", apiFormat: "anthropic" }));
    const list = listProfiles("claude");
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe("deepseek");
    expect(requireProfile("claude", "deepseek").apiKey).toBe("sk-test-key");
  });

  test("save openai profile normalizes baseUrl to single /v1", () => {
    saveProfile(
      "opencode",
      sample({
        name: "gw",
        apiFormat: "openai-chat",
        baseUrl: "http://127.0.0.1:8000/v1/v1/",
      }),
    );
    expect(requireProfile("opencode", "gw").baseUrl).toBe(
      "http://127.0.0.1:8000/v1",
    );
  });
});

describe("claude adapter", () => {
  test("merges env and preserves unrelated settings", () => {
    const existing = {
      theme: "dark",
      env: { FOO: "bar", ANTHROPIC_BASE_URL: "old" },
    };
    const profile = sample({
      name: "ds",
      apiFormat: "anthropic",
      baseUrl: "https://api.deepseek.com/anthropic",
      proxy: "http://127.0.0.1:5112",
    });
    const next = buildClaudeSettings(existing, profile);
    expect(next.theme).toBe("dark");
    expect(next.env!.FOO).toBe("bar");
    expect(next.env!.ANTHROPIC_BASE_URL).toBe(
      "https://api.deepseek.com/anthropic",
    );
    expect(next.env!.ANTHROPIC_AUTH_TOKEN).toBe("sk-test-key");
    expect(next.env!.HTTP_PROXY).toBe("http://127.0.0.1:5112");
    expect(next.model).toBe("model-a");
  });

  test("openai-chat uses bridge base url when provided", () => {
    const profile = sample({
      name: "gw",
      apiFormat: "openai-chat",
      baseUrl: "http://127.0.0.1:8000/v1",
    });
    const next = buildClaudeSettings({}, profile, "http://127.0.0.1:17890");
    expect(next.env!.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:17890");
    expect(next.env!.HTTP_PROXY).toBeUndefined();
  });

  test("apply writes settings.json", async () => {
    const profile = sample({ name: "ds", apiFormat: "anthropic" });
    saveProfile("claude", profile);
    const result = await applyClaudeProfile(profile);
    expect(existsSync(result.configPath)).toBe(true);
    const raw = JSON.parse(readFileSync(result.configPath, "utf8"));
    expect(raw.env.ANTHROPIC_MODEL).toBe("model-a");
  });
});

describe("codex adapter", () => {
  test("builds responses provider block", () => {
    const profile = sample({
      name: "gw",
      apiFormat: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
    const cfg = buildCodexConfig({}, profile, profile.baseUrl);
    expect(cfg.model_provider).toBe("gw");
    expect(cfg.model).toBe("model-a");
    const providers = cfg.model_providers as Record<string, Record<string, unknown>>;
    expect(providers.gw.wire_api).toBe("responses");
    expect(providers.gw.base_url).toBe("https://api.openai.com/v1");
    expect(providers.gw.env_key).toBe(envKeyName("gw"));
  });

  test("env file includes key and proxy", () => {
    const profile = sample({
      name: "gw",
      apiFormat: "openai-responses",
      proxy: "socks5h://127.0.0.1:1080",
    });
    const env = buildCodexEnvFile("OTHER=1\n", profile);
    expect(env).toContain("OTHER=1");
    expect(env).toContain(`${envKeyName("gw")}=sk-test-key`);
    expect(env).toContain("ALL_PROXY=socks5h://127.0.0.1:1080");
  });

  test("apply writes config and env", async () => {
    const profile = sample({ name: "gw", apiFormat: "openai-responses" });
    saveProfile("codex", profile);
    const result = await applyCodexProfile(profile);
    expect(existsSync(result.configPath)).toBe(true);
    expect(existsSync(join(process.env.CODEX_HOME!, ".env"))).toBe(true);
  });

  test("model_context_window written from metadata and cleared without it", () => {
    const withMeta = sample({
      name: "gw",
      apiFormat: "openai-responses",
      models: {
        default: "gpt-5.5",
        list: ["gpt-5.5"],
        meta: { "gpt-5.5": { id: "openai/gpt-5.5", context: 400000 } },
      },
    });
    const cfg = buildCodexConfig({}, withMeta, "https://api.example.com/v1");
    expect(cfg.model_context_window).toBe(400000);

    const withoutMeta = sample({ name: "gw2", apiFormat: "openai-responses" });
    const cfg2 = buildCodexConfig(
      { model_context_window: 12345 },
      withoutMeta,
      "https://api.example.com/v1",
    );
    expect(cfg2.model_context_window).toBeUndefined();
  });
});

describe("opencode adapter", () => {
  test("openai-chat uses openai-compatible package", () => {
    const profile = sample({
      name: "or",
      apiFormat: "openai-chat",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    const cfg = buildOpenCodeConfig({}, profile);
    const providers = cfg.provider as Record<string, Record<string, unknown>>;
    const block = providers["llms-or"] as {
      npm: string;
      options: { baseURL: string };
    };
    expect(block.npm).toBe("@ai-sdk/openai-compatible");
    expect(block.options.baseURL).toBe("https://openrouter.ai/api/v1");
    expect(cfg.model).toBe("llms-or/model-a");
  });

  test("openai-chat baseURL auto-appends /v1", () => {
    const profile = sample({
      name: "gw",
      apiFormat: "openai-chat",
      baseUrl: "http://127.0.0.1:8000",
    });
    const cfg = buildOpenCodeConfig({}, profile);
    const providers = cfg.provider as Record<string, Record<string, unknown>>;
    const block = providers["llms-gw"] as {
      options: { baseURL: string };
    };
    expect(block.options.baseURL).toBe("http://127.0.0.1:8000/v1");
  });

  test("model entries expose full metadata for opencode schema", () => {
    const profile = sample({
      name: "meta",
      apiFormat: "openai-chat",
      models: {
        default: "claude-3.7-sonnet",
        list: ["claude-3.7-sonnet", "text-only-model"],
        meta: {
          "claude-3.7-sonnet": {
            id: "anthropic/claude-3-7-sonnet",
            name: "Claude 3.7 Sonnet",
            family: "claude-3-7",
            releaseDate: "2025-02-19",
            context: 200000,
            maxOutput: 64000,
            reasoning: true,
            toolCall: true,
            temperature: true,
            modalities: { input: ["text", "image"], output: ["text"] },
            attachment: true,
            cost: { input: 3, output: 15 },
          },
        },
      },
    });
    const cfg = buildOpenCodeConfig({}, profile);
    const providers = cfg.provider as Record<string, Record<string, unknown>>;
    const block = providers["llms-meta"] as {
      models: Record<string, Record<string, unknown>>;
    };
    expect(block.models["claude-3.7-sonnet"]).toEqual({
      name: "Claude 3.7 Sonnet",
      family: "claude-3-7",
      release_date: "2025-02-19",
      limit: { context: 200000, output: 64000 },
      cost: { input: 3, output: 15 },
      modalities: { input: ["text", "image"], output: ["text"] },
      attachment: true,
      reasoning: true,
      temperature: true,
      tool_call: true,
    });
    expect(block.models["text-only-model"]).toEqual({
      name: "text-only-model",
    });
  });

  test("model entry falls back to id as name when metadata lacks it", () => {
    const profile = sample({
      name: "meta2",
      apiFormat: "openai-chat",
      models: {
        default: "model-a",
        list: ["model-a"],
        meta: {
          "model-a": {
            id: "lab/model-a",
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    });
    const cfg = buildOpenCodeConfig({}, profile);
    const providers = cfg.provider as Record<string, Record<string, unknown>>;
    const block = providers["llms-meta2"] as {
      models: Record<string, Record<string, unknown>>;
    };
    expect(block.models["model-a"]).toEqual({
      name: "model-a",
      modalities: { input: ["text"], output: ["text"] },
    });
  });

  test("apply writes config", async () => {
    const profile = sample({ name: "or", apiFormat: "anthropic" });
    saveProfile("opencode", profile);
    const result = await applyOpenCodeProfile(profile);
    expect(existsSync(result.configPath)).toBe(true);
  });
});
