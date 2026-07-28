import { describe, expect, test } from "bun:test";
import {
  PRESETS,
  PRESET_IDS,
  getPreset,
  presetsForTool,
} from "../src/presets/index.js";

describe("provider presets", () => {
  test("only three presets exist", () => {
    expect(PRESET_IDS).toEqual(["custom", "openai", "anthropic"]);
    expect(PRESETS.map((p) => p.id).sort()).toEqual(
      [...PRESET_IDS].sort(),
    );
  });

  test("filters by tool compatibility", () => {
    expect(presetsForTool("claude").map((p) => p.id)).toEqual([
      "custom",
      "anthropic",
    ]);
    expect(presetsForTool("codex").map((p) => p.id)).toEqual([
      "custom",
      "openai",
    ]);
    expect(presetsForTool("opencode").map((p) => p.id)).toEqual([
      "custom",
      "openai",
      "anthropic",
    ]);
  });

  test("official presets prefill base urls", () => {
    expect(getPreset("openai")?.baseUrl).toBe("https://api.openai.com/v1");
    expect(getPreset("openai")?.apiFormat).toBe("openai-responses");
    expect(getPreset("anthropic")?.baseUrl).toBe(
      "https://api.anthropic.com",
    );
    expect(getPreset("anthropic")?.apiFormat).toBe("anthropic");
    expect(getPreset("custom")?.apiFormat).toBe("openai-chat");
    expect(getPreset("custom")?.baseUrl).toBe("");
  });
});
