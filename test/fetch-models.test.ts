import { describe, expect, test } from "bun:test";
import {
  buildModelsRequestHeaders,
  baseUrlFromModelsEndpoint,
  modelListEndpoints,
  parseModelIds,
  preferResolvedBaseUrl,
} from "../src/utils/fetch-models.ts";

describe("modelListEndpoints", () => {
  test("v1 base appends /models only", () => {
    expect(modelListEndpoints("https://api.openai.com/v1")).toEqual([
      "https://api.openai.com/v1/models",
    ]);
  });

  test("plain base tries /models and /v1/models", () => {
    expect(modelListEndpoints("http://127.0.0.1:8000")).toEqual([
      "http://127.0.0.1:8000/models",
      "http://127.0.0.1:8000/v1/models",
    ]);
  });

  test("anthropic suffix also tries sibling /v1/models", () => {
    const urls = modelListEndpoints("https://api.deepseek.com/anthropic");
    expect(urls).toContain("https://api.deepseek.com/anthropic/models");
    expect(urls).toContain("https://api.deepseek.com/anthropic/v1/models");
    expect(urls).toContain("https://api.deepseek.com/v1/models");
  });
});

describe("baseUrlFromModelsEndpoint", () => {
  test("strips /models suffix", () => {
    expect(
      baseUrlFromModelsEndpoint("http://127.0.0.1:8000/v1/models"),
    ).toBe("http://127.0.0.1:8000/v1");
    expect(baseUrlFromModelsEndpoint("https://api.openai.com/v1/models")).toBe(
      "https://api.openai.com/v1",
    );
  });
});

describe("preferResolvedBaseUrl", () => {
  test("upgrades plain host to /v1 when models lived there", () => {
    expect(
      preferResolvedBaseUrl(
        "http://127.0.0.1:8000",
        "http://127.0.0.1:8000/v1",
      ),
    ).toBe("http://127.0.0.1:8000/v1");
  });

  test("keeps input when already matching", () => {
    expect(
      preferResolvedBaseUrl(
        "http://127.0.0.1:8000/v1",
        "http://127.0.0.1:8000/v1",
      ),
    ).toBe("http://127.0.0.1:8000/v1");
  });
});

describe("parseModelIds", () => {
  test("openai data array", () => {
    expect(
      parseModelIds({
        data: [{ id: "gpt-4.1" }, { id: "o4-mini" }],
      }),
    ).toEqual(["gpt-4.1", "o4-mini"]);
  });

  test("anthropic-like data with display names", () => {
    expect(
      parseModelIds({
        data: [{ id: "claude-sonnet-4", display_name: "Sonnet" }],
      }),
    ).toEqual(["claude-sonnet-4"]);
  });

  test("string array and models key", () => {
    expect(parseModelIds({ models: ["a", "b"] })).toEqual(["a", "b"]);
  });
});

describe("buildModelsRequestHeaders", () => {
  test("anthropic uses x-api-key", () => {
    const h = buildModelsRequestHeaders("anthropic", "sk-x");
    expect(h["x-api-key"]).toBe("sk-x");
    expect(h["anthropic-version"]).toBe("2023-06-01");
    expect(h.Authorization).toBe("Bearer sk-x");
  });

  test("openai uses bearer", () => {
    const h = buildModelsRequestHeaders("openai-responses", "sk-y");
    expect(h.Authorization).toBe("Bearer sk-y");
    expect(h["x-api-key"]).toBeUndefined();
  });
});
