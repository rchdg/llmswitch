import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Profile } from "../src/types.ts";
import {
  resolveProfile,
  requireProfile,
  saveProfile,
  setActiveProfile,
} from "../src/store/profiles.ts";
import {
  findProfileForModel,
  launchTool,
  matchModel,
  normalizeModelId,
  resolveLaunchTarget,
} from "../src/commands/launch.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "llms-launch-"));
  process.env.LLM_SWITCH_HOME = join(root, "home");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.LLM_SWITCH_HOME;
});

function profile(
  name: string,
  models: string[],
  partial: Partial<Profile> = {},
): Profile {
  return {
    name,
    displayName: name,
    apiFormat: "openai-responses",
    baseUrl: "http://127.0.0.1:8000",
    apiKey: "sk",
    models: { default: models[0]!, list: models },
    updatedAt: new Date().toISOString(),
    ...partial,
  };
}

describe("model matching", () => {
  test("normalize strips separators", () => {
    expect(normalizeModelId("glm-5.2")).toBe("glm52");
    expect(normalizeModelId("GLM5.2")).toBe("glm52");
  });

  test("fuzzy match", () => {
    expect(matchModel(["glm-5.2", "gpt-4.1"], "glm5.2")).toBe("glm-5.2");
  });
});

describe("resolveLaunchTarget", () => {
  test("finds profile by model and fuzzy id", () => {
    saveProfile("codex", profile("custom", ["minimax-m2.5", "glm-5.2"]));
    saveProfile("codex", profile("oai", ["gpt-4.1"]));
    setActiveProfile("codex", "oai");

    const hit = resolveLaunchTarget("codex", { model: "glm5.2" });
    expect(hit.profile.name).toBe("custom");
    expect(hit.model).toBe("glm-5.2");
  });

  test("uses active profile when no model", () => {
    saveProfile("codex", profile("custom", ["minimax-m2.5"]));
    setActiveProfile("codex", "custom");
    const hit = resolveLaunchTarget("codex", {});
    expect(hit.profile.name).toBe("custom");
    expect(hit.model).toBe("minimax-m2.5");
  });

  test("findProfileForModel", () => {
    const list = [
      profile("a", ["x"]),
      profile("b", ["glm-5.2"]),
    ];
    expect(findProfileForModel(list, "glm5.2")?.name).toBe("b");
  });
});

describe("launch does not mutate stored profiles", () => {
  // Regression: launchTool used to write models.default/list back on every run,
  // so `llms launch codex <typo>` permanently polluted the saved profile.
  test("one-shot model is applied without persisting", async () => {
    process.env.CODEX_HOME = join(root, "codex-home");
    saveProfile("codex", profile("custom", ["glm-5.2"]));
    setActiveProfile("codex", "custom");

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
    try {
      const plan = await launchTool({
        tool: "codex",
        model: "typo-model",
        printOnly: true,
      });
      expect(plan.model).toBe("typo-model");
      expect(plan.saved).toBe(false);
    } finally {
      console.error = originalError;
      delete process.env.CODEX_HOME;
    }

    const stored = requireProfile("codex", "custom");
    expect(stored.models.default).toBe("glm-5.2");
    expect(stored.models.list).toEqual(["glm-5.2"]);
    // 未知模型要给出提示，避免上游返回含糊的 404
    expect(errors.join("\n")).toMatch(/typo-model/);
  });

  test("--save persists the model as the new default", async () => {
    process.env.CODEX_HOME = join(root, "codex-home2");
    saveProfile("codex", profile("custom", ["glm-5.2"]));
    setActiveProfile("codex", "custom");

    const originalError = console.error;
    console.error = () => {};
    try {
      const plan = await launchTool({
        tool: "codex",
        model: "glm-5.3",
        printOnly: true,
        save: true,
      });
      expect(plan.saved).toBe(true);
    } finally {
      console.error = originalError;
      delete process.env.CODEX_HOME;
    }

    const stored = requireProfile("codex", "custom");
    expect(stored.models.default).toBe("glm-5.3");
    expect(stored.models.list).toContain("glm-5.3");
  });
});

describe("resolveProfile", () => {
  test("exact name match", () => {
    saveProfile("codex", profile("ab12c", ["m"], { displayName: "DeepSeek" }));
    expect(resolveProfile("codex", "ab12c")?.name).toBe("ab12c");
  });

  test("display name exact match", () => {
    saveProfile("codex", profile("ab12c", ["m"], { displayName: "DeepSeek" }));
    expect(resolveProfile("codex", "DeepSeek")?.name).toBe("ab12c");
  });

  test("display name normalized match (case/separators)", () => {
    saveProfile(
      "codex",
      profile("ab12c", ["m"], { displayName: "Kimi OpenAI" }),
    );
    expect(resolveProfile("codex", "kimi-openai")?.name).toBe("ab12c");
    expect(resolveProfile("codex", "KIMI openai")?.name).toBe("ab12c");
  });

  test("partial display name resolves only when unambiguous", () => {
    saveProfile("codex", profile("a1", ["m"], { displayName: "DeepSeek" }));
    saveProfile("codex", profile("b2", ["m"], { displayName: "DeepThought" }));
    expect(resolveProfile("codex", "deep")).toBeNull();
  });

  test("returns null when unknown", () => {
    saveProfile("codex", profile("a1", ["m"], { displayName: "DeepSeek" }));
    expect(resolveProfile("codex", "nope")).toBeNull();
  });
});
