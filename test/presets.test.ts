import { describe, expect, test } from "bun:test";
import {
  PRESETS,
  PRESET_IDS,
  getPreset,
  presetsForTool,
} from "../src/presets/index.js";

describe("provider presets", () => {
  test("only four presets exist", () => {
    expect(PRESET_IDS).toEqual(["custom", "openai", "anthropic", "ollama"]);
    expect(PRESETS.map((p) => p.id).sort()).toEqual(
      [...PRESET_IDS].sort(),
    );
  });

  test("filters by tool compatibility", () => {
    expect(presetsForTool("claude").map((p) => p.id)).toEqual([
      "custom",
      "anthropic",
      "ollama",
    ]);
    expect(presetsForTool("codex").map((p) => p.id)).toEqual([
      "custom",
      "openai",
      "ollama",
    ]);
    expect(presetsForTool("opencode").map((p) => p.id)).toEqual([
      "custom",
      "openai",
      "anthropic",
      "ollama",
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
    expect(getPreset("ollama")?.baseUrl).toBe("http://localhost:11434");
    expect(getPreset("ollama")?.apiFormat).toBe("openai-chat");
  });
});
