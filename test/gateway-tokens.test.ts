import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { deflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  checkRateLimit,
  getRateLimitLockPath,
  getRateLimitPath,
  peekRateLimit,
  resetRateLimits,
} from "../src/gateway/rate-limit.ts";
import {
  countAnthropicInputTokens,
  estimateTextTokens,
  imageTokensForSize,
  imageTokensFromBase64,
  parseImageDimensions,
  resetTextCounterCache,
} from "../src/gateway/tokens.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "llms-gateway-limits-"));
  process.env.LLM_SWITCH_HOME = join(root, "home");
  process.env.LLM_SWITCH_DISABLE_TOKENIZER = "1";
  resetTextCounterCache();
  resetRateLimits();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.LLM_SWITCH_HOME;
  delete process.env.LLM_SWITCH_DISABLE_TOKENIZER;
  resetTextCounterCache();
});

/** Seed a file that the gateway would normally create itself. */
function seed(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

describe("persistent rate limiting", () => {
  test("counts down within a window and refuses past the limit", () => {
    const now = Date.now();
    const first = checkRateLimit("key-a", 2, now);
    expect(first.allowed).toBe(true);
    expect(first.limit).toBe(2);
    expect(first.remaining).toBe(1);
    expect(first.resetAt).toBeGreaterThan(Math.floor(now / 1000));

    expect(checkRateLimit("key-a", 2, now).remaining).toBe(0);

    const blocked = checkRateLimit("key-a", 2, now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  test("rolls over to a fresh window", () => {
    const now = Date.now();
    checkRateLimit("key-a", 1, now);
    expect(checkRateLimit("key-a", 1, now).allowed).toBe(false);
    expect(checkRateLimit("key-a", 1, now + 61_000).allowed).toBe(true);
  });

  test("treats a limit of zero as unlimited and records nothing", () => {
    const decision = checkRateLimit("key-a", 0);
    expect(decision.allowed).toBe(true);
    expect(decision.limit).toBe(0);
    expect(decision.remaining).toBe(-1);
    expect(existsSync(getRateLimitPath())).toBe(false);
  });

  test("keeps separate counters per key", () => {
    const now = Date.now();
    checkRateLimit("key-a", 1, now);
    expect(checkRateLimit("key-a", 1, now).allowed).toBe(false);
    expect(checkRateLimit("key-b", 1, now).allowed).toBe(true);
  });

  test("persists counts to disk so a restart resumes the window", () => {
    const now = Date.now();
    checkRateLimit("key-a", 5, now);
    checkRateLimit("key-a", 5, now);
    expect(existsSync(getRateLimitPath())).toBe(true);

    const persisted = JSON.parse(
      readFileSync(getRateLimitPath(), "utf8"),
    ) as { windows: Record<string, { windowStart: number; count: number }> };
    expect(persisted.windows["key-a"]).toEqual({
      windowStart: now,
      count: 2,
    });
  });

  test("a second process sees counts written by the first", () => {
    const now = Date.now();
    // Emulate another instance having already consumed the window.
    seed(
      getRateLimitPath(),
      JSON.stringify({
        version: 1,
        windows: { "key-a": { windowStart: now, count: 5 } },
      }),
    );
    expect(checkRateLimit("key-a", 5, now).allowed).toBe(false);
  });

  test("peek reports usage without consuming a slot", () => {
    const now = Date.now();
    checkRateLimit("key-a", 3, now);
    const peeked = peekRateLimit("key-a", 3, now);
    expect(peeked.remaining).toBe(2);
    expect(peekRateLimit("key-a", 3, now).remaining).toBe(2);
  });

  test("fails open when the lock is held by a live process", () => {
    // A lock owned by this (alive) pid is never reclaimed.
    seed(
      getRateLimitLockPath(),
      JSON.stringify({ id: "held", pid: process.pid, at: Date.now() }),
    );
    const now = Date.now();
    const decision = checkRateLimit("key-a", 1, now);
    expect(decision.allowed).toBe(true);
    // The in-memory fallback still enforces the limit for this process.
    expect(checkRateLimit("key-a", 1, now).allowed).toBe(false);
  });

  test("reclaims a stale lock left by a dead process", () => {
    seed(
      getRateLimitLockPath(),
      JSON.stringify({
        id: "orphan",
        // Impossible pid, so the owner is treated as gone.
        pid: 2_147_483_646,
        at: Date.now() - 60_000,
      }),
    );
    const decision = checkRateLimit("key-a", 2, Date.now());
    expect(decision.allowed).toBe(true);
    expect(existsSync(getRateLimitPath())).toBe(true);
  });

  test("discards a corrupt counter file", () => {
    seed(getRateLimitPath(), "{not json");
    const decision = checkRateLimit("key-a", 2, Date.now());
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(1);
  });

  test("reset clears persisted counters", () => {
    const now = Date.now();
    checkRateLimit("key-a", 1, now);
    resetRateLimits();
    expect(existsSync(getRateLimitPath())).toBe(false);
    expect(checkRateLimit("key-a", 1, now).allowed).toBe(true);
  });
});

// --- image fixtures ---------------------------------------------------------

function pngFixture(width: number, height: number): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "ascii");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  return Buffer.concat([header, ihdr]);
}

function jpegFixture(width: number, height: number): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  // An APP0 segment first, so the parser has to walk past it.
  const app0 = Buffer.alloc(4 + 14);
  app0.writeUInt16BE(0xffe0, 0);
  app0.writeUInt16BE(16, 2);
  app0.write("JFIF\0", 4, "ascii");
  const sof0 = Buffer.alloc(11);
  sof0.writeUInt16BE(0xffc0, 0);
  sof0.writeUInt16BE(9, 2);
  sof0.writeUInt8(8, 4);
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  return Buffer.concat([soi, app0, sof0]);
}

function gifFixture(width: number, height: number): Buffer {
  const buf = Buffer.alloc(13);
  buf.write("GIF89a", 0, "ascii");
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

function webpVp8xFixture(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(22, 4);
  buf.write("WEBP", 8, "ascii");
  buf.write("VP8X", 12, "ascii");
  buf.writeUInt32LE(10, 16);
  buf.writeUIntLE(width - 1, 24, 3);
  buf.writeUIntLE(height - 1, 27, 3);
  return buf;
}

describe("image token accounting", () => {
  test("reads PNG dimensions", () => {
    expect(parseImageDimensions(pngFixture(800, 600))).toEqual({
      width: 800,
      height: 600,
    });
  });

  test("reads JPEG dimensions past an APP0 segment", () => {
    expect(parseImageDimensions(jpegFixture(1024, 768))).toEqual({
      width: 1024,
      height: 768,
    });
  });

  test("reads GIF dimensions", () => {
    expect(parseImageDimensions(gifFixture(320, 240))).toEqual({
      width: 320,
      height: 240,
    });
  });

  test("reads WebP VP8X dimensions", () => {
    expect(parseImageDimensions(webpVp8xFixture(640, 480))).toEqual({
      width: 640,
      height: 480,
    });
  });

  test("returns null for unrecognised data", () => {
    expect(parseImageDimensions(deflateSync(Buffer.from("nope")))).toBeNull();
  });

  test("prices images by pixel area", () => {
    // Anthropic's guidance: width * height / 750.
    expect(imageTokensForSize({ width: 750, height: 1 })).toBe(1);
    expect(imageTokensForSize({ width: 1092, height: 1092 })).toBe(1590);
  });

  test("falls back to a conservative cost for unknown dimensions", () => {
    expect(imageTokensForSize(null)).toBe(1_200);
    expect(imageTokensFromBase64("")).toBe(1_200);
  });

  test("prices a base64 payload from its header alone", () => {
    const base64 = pngFixture(800, 600).toString("base64");
    expect(imageTokensFromBase64(base64)).toBe(640);
  });
});

describe("script-aware text estimation", () => {
  test("counts latin text at roughly four characters per token", () => {
    // Tallied across the whole string, not rounded up per word.
    expect(estimateTextTokens("hello")).toBe(2);
    expect(estimateTextTokens("hello world")).toBe(3);
  });

  test("counts CJK far denser than the naive characters/4 rule", () => {
    const text = "今天天气很好我们出去散步吧";
    const naive = Math.ceil(text.length / 4);
    const estimate = estimateTextTokens(text);
    expect(estimate).toBeGreaterThan(naive * 2);
    expect(estimate).toBeLessThanOrEqual(text.length);
  });

  test("handles mixed scripts roughly additively", () => {
    const parts = estimateTextTokens("hello") + estimateTextTokens("世界");
    const mixed = estimateTextTokens("hello 世界");
    // Rounding happens once per script, so allow a token of slack.
    expect(Math.abs(mixed - parts)).toBeLessThanOrEqual(1);
  });

  test("charges a single separating space to the character budget", () => {
    expect(estimateTextTokens(" word")).toBeLessThanOrEqual(
      estimateTextTokens("word") + 1,
    );
  });

  test("costs each digit run separately", () => {
    // BPE never merges digits across a separator.
    const oneRun = estimateTextTokens("123456");
    const twoRuns = estimateTextTokens("123 456");
    expect(twoRuns).toBeGreaterThan(oneRun);
  });

  test("counts digits denser than letters", () => {
    // 12 digits at ~3/token beats 12 letters at ~4/token.
    expect(estimateTextTokens("123456789012")).toBeGreaterThan(
      estimateTextTokens("abcdefghijkl"),
    );
  });

  test("charges astral symbols more than one token", () => {
    expect(estimateTextTokens("🎉")).toBeGreaterThanOrEqual(1);
    expect(estimateTextTokens("🎉🚀🎉🚀")).toBeGreaterThan(
      estimateTextTokens("ab"),
    );
  });

  test("folds CJK punctuation into the CJK budget", () => {
    // Fullwidth punctuation tokenizes with the surrounding script.
    expect(estimateTextTokens("你好，世界。")).toBeLessThan(
      estimateTextTokens("你好") + estimateTextTokens("世界") + 2,
    );
  });

  test("returns zero for empty input", () => {
    expect(estimateTextTokens("")).toBe(0);
  });
});

describe("request token accounting", () => {
  test("sums text, tools, images and structural overhead", async () => {
    const png = pngFixture(800, 600).toString("base64");
    const result = await countAnthropicInputTokens({
      model: "claude",
      system: "You are helpful.",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: png },
            },
          ],
        },
      ],
      tools: [
        {
          name: "search",
          description: "search the web",
          input_schema: { type: "object", properties: { q: { type: "string" } } },
        },
      ],
    });

    expect(result.method).toBe("heuristic");
    expect(result.breakdown.images).toBe(640);
    expect(result.breakdown.text).toBeGreaterThan(0);
    expect(result.breakdown.tools).toBeGreaterThan(10);
    // Request envelope + one message + system.
    expect(result.breakdown.overhead).toBe(8 + 3 + 3);
    expect(result.inputTokens).toBe(
      result.breakdown.text +
        result.breakdown.images +
        result.breakdown.tools +
        result.breakdown.overhead,
    );
  });

  test("counts tool_use input and tool_result content", async () => {
    const withTools = await countAnthropicInputTokens({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "search",
              input: { query: "a rather long search query here" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: "some results came back",
            },
          ],
        },
      ],
    });
    const bare = await countAnthropicInputTokens({
      messages: [
        { role: "assistant", content: [] },
        { role: "user", content: [] },
      ],
    });
    expect(withTools.breakdown.text).toBeGreaterThan(bare.breakdown.text);
  });

  test("counts a plain string system prompt and string content", async () => {
    const result = await countAnthropicInputTokens({
      system: "short",
      messages: [{ role: "user", content: "hello there" }],
    });
    expect(result.breakdown.text).toBe(
      estimateTextTokens("short") + estimateTextTokens("hello there"),
    );
  });

  test("never reports zero tokens", async () => {
    const result = await countAnthropicInputTokens({ messages: [] });
    expect(result.inputTokens).toBeGreaterThan(0);
  });

  test("prices url-sourced images conservatively", async () => {
    const result = await countAnthropicInputTokens({
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "url", url: "https://x/a.png" } },
          ],
        },
      ],
    });
    expect(result.breakdown.images).toBe(1_200);
  });

  test("understands OpenAI-style image_url data urls", async () => {
    const png = pngFixture(800, 600).toString("base64");
    const result = await countAnthropicInputTokens({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${png}` },
            },
          ],
        },
      ],
    });
    expect(result.breakdown.images).toBe(640);
  });
});
