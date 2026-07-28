import { describe, expect, test } from "bun:test";
import {
  ensureOpenAiV1BaseUrl,
  isOpenAiApiFormat,
  normalizeBaseUrlForFormat,
} from "../src/utils/base-url.ts";

describe("ensureOpenAiV1BaseUrl", () => {
  test("appends /v1 when missing", () => {
    expect(ensureOpenAiV1BaseUrl("http://127.0.0.1:8000")).toBe(
      "http://127.0.0.1:8000/v1",
    );
    expect(ensureOpenAiV1BaseUrl("http://127.0.0.1:8000/")).toBe(
      "http://127.0.0.1:8000/v1",
    );
  });

  test("keeps a single trailing /v1", () => {
    expect(ensureOpenAiV1BaseUrl("http://127.0.0.1:8000/v1")).toBe(
      "http://127.0.0.1:8000/v1",
    );
    expect(ensureOpenAiV1BaseUrl("http://127.0.0.1:8000/v1/")).toBe(
      "http://127.0.0.1:8000/v1",
    );
    expect(ensureOpenAiV1BaseUrl("https://api.openai.com/v1")).toBe(
      "https://api.openai.com/v1",
    );
  });

  test("collapses duplicate trailing /v1", () => {
    expect(ensureOpenAiV1BaseUrl("http://127.0.0.1:8000/v1/v1")).toBe(
      "http://127.0.0.1:8000/v1",
    );
    expect(ensureOpenAiV1BaseUrl("http://127.0.0.1:8000/v1/v1/")).toBe(
      "http://127.0.0.1:8000/v1",
    );
    expect(ensureOpenAiV1BaseUrl("https://api.openai.com/v1/v1/v1")).toBe(
      "https://api.openai.com/v1",
    );
  });

  test("preserves path prefixes before /v1", () => {
    expect(ensureOpenAiV1BaseUrl("https://opencode.ai/zen/go")).toBe(
      "https://opencode.ai/zen/go/v1",
    );
    expect(ensureOpenAiV1BaseUrl("https://opencode.ai/zen/go/v1")).toBe(
      "https://opencode.ai/zen/go/v1",
    );
  });

  test("empty stays empty", () => {
    expect(ensureOpenAiV1BaseUrl("")).toBe("");
    expect(ensureOpenAiV1BaseUrl("   ")).toBe("");
  });
});

describe("normalizeBaseUrlForFormat", () => {
  test("openai formats force /v1", () => {
    expect(
      normalizeBaseUrlForFormat("openai-chat", "http://127.0.0.1:8000"),
    ).toBe("http://127.0.0.1:8000/v1");
    expect(
      normalizeBaseUrlForFormat("openai-responses", "https://api.openai.com/v1/"),
    ).toBe("https://api.openai.com/v1");
  });

  test("anthropic only trims trailing slashes", () => {
    expect(
      normalizeBaseUrlForFormat("anthropic", "https://api.anthropic.com/"),
    ).toBe("https://api.anthropic.com");
    expect(
      normalizeBaseUrlForFormat("anthropic", "https://api.deepseek.com/anthropic"),
    ).toBe("https://api.deepseek.com/anthropic");
  });
});

describe("isOpenAiApiFormat", () => {
  test("detects openai formats", () => {
    expect(isOpenAiApiFormat("openai-chat")).toBe(true);
    expect(isOpenAiApiFormat("openai-responses")).toBe(true);
    expect(isOpenAiApiFormat("anthropic")).toBe(false);
  });
});
