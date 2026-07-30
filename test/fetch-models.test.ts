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


describe("fetchModelList transport integration", () => {
  test("passes profile headers without mutating proxy env", async () => {
    const { createServer } = await import("node:http");
    let seenHeader: string | undefined;
    const server = createServer((req, res) => {
      seenHeader = req.headers["x-profile-header"] as string | undefined;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "model-via-transport" }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing port");
    const before = process.env.ALL_PROXY;
    process.env.ALL_PROXY = "sentinel://must-not-change";
    try {
      const { fetchModelList } = await import("../src/utils/fetch-models.ts");
      const result = await fetchModelList({
        baseUrl: `http://127.0.0.1:${address.port}`,
        apiKey: "profile-key",
        apiFormat: "openai-chat",
        headers: { "X-Profile-Header": "profile-value" },
      });
      expect(result.models).toEqual(["model-via-transport"]);
      expect(seenHeader).toBe("profile-value");
      expect(process.env.ALL_PROXY).toBe("sentinel://must-not-change");
    } finally {
      if (before === undefined) delete process.env.ALL_PROXY;
      else process.env.ALL_PROXY = before;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("does not infer an Anthropic Messages base from a sibling models URL", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/v1/models") {
        res.end(JSON.stringify({ data: [{ id: "claude-compatible" }] }));
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing port");
    try {
      const { fetchModelList } = await import("../src/utils/fetch-models.ts");
      const baseUrl = `http://127.0.0.1:${address.port}/anthropic`;
      const result = await fetchModelList({
        baseUrl,
        apiKey: "anthropic-key",
        apiFormat: "anthropic",
      });
      expect(result.endpoint).toBe(`http://127.0.0.1:${address.port}/v1/models`);
      expect(result.resolvedBaseUrl).toBe(baseUrl);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
