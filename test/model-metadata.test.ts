import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectModelMeta,
  fetchModelMetadata,
  getModelMetadataCachePath,
  lookupModelMeta,
  normalizeModelKey,
  parseModelMetadata,
} from "../src/utils/model-metadata.ts";

// 元数据抓取会写本地缓存；测试必须指向临时目录，否则会污染真实 ~/.config/llm-switch。
let metaRoot: string;
beforeEach(() => {
  metaRoot = mkdtempSync(join(tmpdir(), "llms-meta-"));
  process.env.LLM_SWITCH_HOME = join(metaRoot, "home");
});
afterEach(() => {
  rmSync(metaRoot, { recursive: true, force: true });
  delete process.env.LLM_SWITCH_HOME;
});

const SAMPLE_PAYLOAD = {
  data: [
    {
      id: "anthropic/claude-3-7-sonnet",
      name: "Claude 3.7 Sonnet",
      family: "claude-3-7",
      releaseDate: "2025-02-19",
      context: 200000,
      output: 64000,
      reasoning: true,
      toolCall: true,
      temperature: true,
      modalities: { input: ["text", "image", "pdf"], output: ["text"] },
      attachment: true,
      priceInput: 3,
      priceOutput: 15,
    },
    {
      id: "openai/gpt-5.5",
      name: "GPT-5.5",
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      attachment: false,
      context: 400000,
      output: 128000,
      reasoning: true,
      toolCall: true,
      priceInput: 1.25,
    },
    {
      id: "meta/llama-4-scout",
      name: "Llama 4 Scout",
      modalities: { input: ["text"], output: ["text", "image"] },
    },
  ],
};

describe("parseModelMetadata", () => {
  test("indexes full id, bare id, and normalized variants", () => {
    const catalog = parseModelMetadata(SAMPLE_PAYLOAD);
    expect(Object.keys(catalog.full)).toHaveLength(3);
    expect(catalog.bare["claude-3-7-sonnet"]?.name).toBe("Claude 3.7 Sonnet");
    expect(catalog.norm["claude37sonnet"]?.id).toBe(
      "anthropic/claude-3-7-sonnet",
    );
  });

  test("parses capability, limit, and pricing fields", () => {
    const catalog = parseModelMetadata(SAMPLE_PAYLOAD);
    const meta = catalog.full["anthropic/claude-3-7-sonnet"];
    expect(meta?.family).toBe("claude-3-7");
    expect(meta?.releaseDate).toBe("2025-02-19");
    expect(meta?.context).toBe(200000);
    expect(meta?.maxOutput).toBe(64000);
    expect(meta?.reasoning).toBe(true);
    expect(meta?.toolCall).toBe(true);
    expect(meta?.temperature).toBe(true);
    expect(meta?.cost).toEqual({ input: 3, output: 15 });
  });

  test("accepts inputModalities/outputModalities fallback fields", () => {
    const catalog = parseModelMetadata(SAMPLE_PAYLOAD);
    const meta = catalog.full["openai/gpt-5.5"];
    expect(meta?.modalities).toEqual({
      input: ["text", "image"],
      output: ["text"],
    });
    expect(meta?.attachment).toBe(false);
    expect(meta?.cost).toBeUndefined();
  });

  test("non-object payloads yield an empty catalog", () => {
    const catalog = parseModelMetadata({ error: "boom" });
    expect(catalog.full).toEqual({});
    expect(catalog.bare).toEqual({});
    expect(catalog.norm).toEqual({});
  });
});

describe("lookupModelMeta", () => {
  const catalog = parseModelMetadata(SAMPLE_PAYLOAD);

  test("exact full id", () => {
    expect(lookupModelMeta(catalog, "anthropic/claude-3-7-sonnet")?.name).toBe(
      "Claude 3.7 Sonnet",
    );
  });

  test("bare id matches provider-prefixed catalog entry", () => {
    expect(lookupModelMeta(catalog, "gpt-5.5")?.id).toBe("openai/gpt-5.5");
  });

  test("dotted version variants normalize to dashes", () => {
    expect(
      lookupModelMeta(catalog, "claude-3.7-sonnet")?.modalities,
    ).toEqual({ input: ["text", "image", "pdf"], output: ["text"] });
  });

  test("date-stamped catalog ids match undated queries", () => {
    const catalog = parseModelMetadata({
      data: [
        {
          id: "anthropic/claude-sonnet-4-5-20250929",
          name: "Claude Sonnet 4.5",
          modalities: { input: ["text", "image"], output: ["text"] },
          attachment: true,
        },
      ],
    });
    const meta = lookupModelMeta(catalog, "claude-sonnet-4-5");
    expect(meta?.id).toBe("anthropic/claude-sonnet-4-5-20250929");
    expect(lookupModelMeta(catalog, "claude-sonnet-4-5-20250929")?.id).toBe(
      "anthropic/claude-sonnet-4-5-20250929",
    );
  });

  test("prefers the undated entry when both exist", () => {
    const catalog = parseModelMetadata({
      data: [
        {
          id: "lab/model-x-20250101",
          name: "Model X dated",
          modalities: { input: ["text"], output: ["text"] },
        },
        {
          id: "lab/model-x",
          name: "Model X",
          modalities: { input: ["text"], output: ["text"] },
        },
      ],
    });
    expect(lookupModelMeta(catalog, "model-x")?.name).toBe("Model X");
  });

  test("unknown model returns undefined", () => {
    expect(lookupModelMeta(catalog, "totally-unknown")).toBeUndefined();
    expect(lookupModelMeta(catalog, "")).toBeUndefined();
  });
});

describe("normalizeModelKey", () => {
  test("lowercases and strips separators", () => {
    expect(normalizeModelKey("Claude-3.7-Sonnet")).toBe("claude37sonnet");
    expect(normalizeModelKey("openai/gpt-5.5")).toBe("openaigpt55");
  });
});

describe("collectModelMeta", () => {
  test("collects only resolvable models", () => {
    const catalog = parseModelMetadata(SAMPLE_PAYLOAD);
    const meta = collectModelMeta(catalog, [
      "claude-3.7-sonnet",
      "gpt-5.5",
      "unknown-model",
    ]);
    expect(Object.keys(meta || {}).sort()).toEqual([
      "claude-3.7-sonnet",
      "gpt-5.5",
    ]);
  });

  test("returns undefined without catalog or matches", () => {
    expect(collectModelMeta(undefined, ["a"])).toBeUndefined();
    expect(
      collectModelMeta(parseModelMetadata(SAMPLE_PAYLOAD), ["nope"]),
    ).toBeUndefined();
  });
});

describe("fetchModelMetadata pagination", () => {
  test("follows meta.total across pages", async () => {
    const { createServer } = await import("node:http");
    const allRows = Array.from({ length: 25 }, (_, i) => ({
      id: `lab-${i % 2}/model-${i}`,
      name: `Model ${i}`,
      modalities: { input: ["text"], output: ["text"] },
      attachment: i % 3 === 0,
    }));
    const server = createServer((req, res) => {
      const url = new URL(req.url || "/", "http://localhost");
      const page = Number(url.searchParams.get("page") || "1");
      const pageSize = Number(url.searchParams.get("page_size") || "1000");
      const start = (page - 1) * pageSize;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          data: allRows.slice(start, start + pageSize),
          meta: { total: allRows.length, page, pageSize },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing port");

    try {
      const endpoint = `http://127.0.0.1:${address.port}/api/v1/models`;
      // force：这条用例就是要验证翻页，不能被本地缓存短路
      const catalog = await fetchModelMetadata({ endpoint, force: true });
      expect(Object.keys(catalog.full)).toHaveLength(25);
      expect(lookupModelMeta(catalog, "model-24")?.name).toBe("Model 24");
      expect(lookupModelMeta(catalog, "model-0")?.attachment).toBe(true);
      expect(lookupModelMeta(catalog, "model-1")?.attachment).toBe(false);

      // 抓取成功后应写下缓存，并且第二次调用能命中（不再请求上游）
      expect(existsSync(getModelMetadataCachePath())).toBe(true);
      let requestsAfter = 0;
      const countingServer = createServer((_req, res) => {
        requestsAfter += 1;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ data: [], meta: { total: 0 } }));
      });
      const cached = await fetchModelMetadata({ endpoint });
      expect(Object.keys(cached.full)).toHaveLength(25);
      expect(requestsAfter).toBe(0);
      countingServer.close();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
