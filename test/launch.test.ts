import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Profile } from "../src/types.ts";
import { saveProfile, setActiveProfile } from "../src/store/profiles.ts";
import {
  findProfileForModel,
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
