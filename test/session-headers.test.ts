import { describe, expect, test } from "bun:test";
import type { IncomingMessage } from "node:http";
import type { BridgeUpstream } from "../src/bridge/types.ts";
import { sessionHeadersFor } from "../src/bridge/server.ts";
import type { GatewayProvider } from "../src/gateway/types.ts";
import { buildUpstreamHeaders } from "../src/gateway/server.ts";
import {
  OPENCODE_SESSION_HEADER,
  SESSION_ROTATION_MS,
  deriveSessionId,
  fallbackOpenCodeSessionHeaders,
  normalizeSessionId,
  openCodeSessionHeaders,
  requestBodyFingerprint,
  requiresOpenCodeSession,
  sessionIdFromHeaders,
  sessionRotationBucket,
} from "../src/utils/session.ts";

const OPENCODE_BASE = "https://opencode.ai/zen/go/v1";

function fakeRequest(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

/** A chat body shaped like the second turn of a conversation. */
function chatBody(secondUser: string): string {
  return JSON.stringify({
    model: "glm-5.3",
    messages: [
      { role: "system", content: "You are a coding agent." },
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: secondUser },
    ],
    stream: true,
  });
}

describe("opencode session requirement", () => {
  test("detects opencode hosts only", () => {
    expect(requiresOpenCodeSession(OPENCODE_BASE)).toBe(true);
    expect(requiresOpenCodeSession("https://opencode.ai")).toBe(true);
    expect(requiresOpenCodeSession("https://api.opencode.ai/v1")).toBe(true);
    expect(requiresOpenCodeSession("https://OpenCode.AI/v1")).toBe(true);
    expect(requiresOpenCodeSession("https://notopencode.ai/v1")).toBe(false);
    expect(requiresOpenCodeSession("https://opencode.ai.evil.test/v1")).toBe(
      false,
    );
    expect(requiresOpenCodeSession("https://api.openai.com/v1")).toBe(false);
    expect(requiresOpenCodeSession("http://127.0.0.1:11434")).toBe(false);
    expect(requiresOpenCodeSession("")).toBe(false);
    expect(requiresOpenCodeSession(undefined)).toBe(false);
    expect(requiresOpenCodeSession("not a url")).toBe(false);
  });
});

describe("session id normalization", () => {
  test("keeps OpenCode's own ses_ form verbatim", () => {
    const id = `ses_${"a1".repeat(16)}`;
    expect(normalizeSessionId(id)).toBe(id);
  });

  test("hashes other opaque identifiers into the ses_ form", () => {
    const normalized = normalizeSessionId("thread-42");
    expect(normalized).toMatch(/^ses_[0-9a-f]{32}$/);
    expect(normalized).toBe(normalizeSessionId("thread-42"));
    expect(normalized).not.toBe(normalizeSessionId("thread-43"));
  });

  test("rejects empty and unsafe values", () => {
    expect(normalizeSessionId("")).toBeNull();
    expect(normalizeSessionId("   ")).toBeNull();
    expect(normalizeSessionId(undefined)).toBeNull();
    expect(normalizeSessionId("bad value with spaces")).toBeNull();
    expect(normalizeSessionId("crlf\r\ninjected: true")).toBeNull();
    expect(normalizeSessionId("x".repeat(129))).toBeNull();
  });
});

describe("client session headers", () => {
  test("prefers the opencode header, then the coding-agent session headers", () => {
    expect(
      sessionIdFromHeaders({
        "x-opencode-session": "ses_primary",
        session_id: "fallback",
      }),
    ).toBe("ses_primary");
    expect(sessionIdFromHeaders({ session_id: "codex-thread" })).toBe(
      "codex-thread",
    );
    expect(
      sessionIdFromHeaders({ "x-client-request-id": "client-thread" }),
    ).toBe("client-thread");
    expect(sessionIdFromHeaders({ conversation_id: "conv" })).toBe("conv");
  });

  test("handles repeated headers and blank values", () => {
    expect(
      sessionIdFromHeaders({ "x-opencode-session": ["ses_a", "ses_b"] }),
    ).toBe("ses_a");
    expect(sessionIdFromHeaders({ session_id: "   " })).toBeUndefined();
    expect(sessionIdFromHeaders({})).toBeUndefined();
    expect(sessionIdFromHeaders(undefined)).toBeUndefined();
  });
});

describe("body fingerprint", () => {
  test("is stable across turns of one conversation and differs between them", () => {
    const first = requestBodyFingerprint(chatBody("second question"));
    const followUp = requestBodyFingerprint(chatBody("third question"));
    const other = requestBodyFingerprint(
      JSON.stringify({
        model: "glm-5.3",
        messages: [
          { role: "system", content: "You are a coding agent." },
          { role: "user", content: "an unrelated conversation" },
        ],
      }),
    );
    expect(first).not.toBeNull();
    expect(first).toBe(followUp);
    expect(first).not.toBe(other);
    expect(
      requestBodyFingerprint(
        JSON.stringify({
          model: "kimi-k3",
          messages: [
            { role: "system", content: "You are a coding agent." },
            { role: "user", content: "first question" },
            { role: "assistant", content: "first answer" },
            { role: "user", content: "second question" },
          ],
        }),
      ),
    ).not.toBe(first);
  });

  test("supports responses input and legacy prompts", () => {
    const responses = requestBodyFingerprint(
      JSON.stringify({
        model: "gpt-5.6-luna",
        instructions: "be brief",
        input: [{ type: "message", role: "user", content: "hello" }],
      }),
    );
    expect(responses).not.toBeNull();
    expect(
      requestBodyFingerprint(JSON.stringify({ prompt: "legacy", model: "m" })),
    ).not.toBeNull();
    expect(requestBodyFingerprint(JSON.stringify({}))).toBeNull();
    expect(requestBodyFingerprint("not json")).toBeNull();
    expect(requestBodyFingerprint(undefined)).toBeNull();
  });
});

describe("opencode session headers", () => {
  test("adds nothing for non-opencode upstreams", () => {
    expect(
      openCodeSessionHeaders({
        baseUrl: "https://api.openai.com/v1",
        headers: { "x-opencode-session": "ses_keep" },
        bodyText: chatBody("hi"),
      }),
    ).toEqual({});
  });

  test("forwards a client session id without re-deriving it", () => {
    const client = `ses_${"b2".repeat(16)}`;
    expect(
      openCodeSessionHeaders({
        baseUrl: OPENCODE_BASE,
        headers: { "x-opencode-session": client },
        bodyText: chatBody("hi"),
      }),
    ).toEqual({ [OPENCODE_SESSION_HEADER]: client });
  });

  test("derives a stable value from the request body when the client sends none", () => {
    const now = 1_800_000_000_000;
    const first = openCodeSessionHeaders({
      baseUrl: OPENCODE_BASE,
      bodyText: chatBody("second question"),
      now,
    });
    const next = openCodeSessionHeaders({
      baseUrl: OPENCODE_BASE,
      bodyText: chatBody("third question"),
      now,
    });
    expect(Object.keys(first)).toEqual([OPENCODE_SESSION_HEADER]);
    expect(first[OPENCODE_SESSION_HEADER]).toMatch(/^ses_[0-9a-f]{32}$/);
    expect(first).toEqual(next);
  });

  test("falls back to the seed when no body is available", () => {
    const derived = openCodeSessionHeaders({
      baseUrl: OPENCODE_BASE,
      fallbackSeed: "opencode-go",
    });
    expect(derived[OPENCODE_SESSION_HEADER]).toMatch(/^ses_[0-9a-f]{32}$/);
    expect(openCodeSessionHeaders({ baseUrl: OPENCODE_BASE })).toEqual({});
  });
});

describe("forged session rotation", () => {
  const HOUR = SESSION_ROTATION_MS;
  const base = 1_800_000_000_000 - (1_800_000_000_000 % HOUR);

  test("buckets timestamps by whole hours", () => {
    expect(sessionRotationBucket(base)).toBe(sessionRotationBucket(base + 1));
    expect(sessionRotationBucket(base + HOUR - 1)).toBe(
      sessionRotationBucket(base),
    );
    expect(sessionRotationBucket(base + HOUR)).toBe(
      sessionRotationBucket(base) + 1,
    );
  });

  test("keeps the same forged id inside one hour and rotates at the boundary", () => {
    const seed = "same conversation";
    const start = deriveSessionId(seed, base);
    expect(start).toMatch(/^ses_[0-9a-f]{32}$/);
    expect(deriveSessionId(seed, base)).toBe(start);
    expect(deriveSessionId(seed, base + HOUR - 1)).toBe(start);

    const rotated = deriveSessionId(seed, base + HOUR);
    expect(rotated).toMatch(/^ses_[0-9a-f]{32}$/);
    expect(rotated).not.toBe(start);
  });

  test("rotates the derived header hourly but never touches a client value", () => {
    const client = `ses_${"f6".repeat(16)}`;
    const before = openCodeSessionHeaders({
      baseUrl: OPENCODE_BASE,
      headers: { "x-opencode-session": client },
      now: base,
    });
    const after = openCodeSessionHeaders({
      baseUrl: OPENCODE_BASE,
      headers: { "x-opencode-session": client },
      now: base + HOUR,
    });
    expect(before).toEqual({ [OPENCODE_SESSION_HEADER]: client });
    expect(after).toEqual(before);

    const forgedBefore = openCodeSessionHeaders({
      baseUrl: OPENCODE_BASE,
      fallbackSeed: "opencode-go",
      now: base,
    });
    const forgedAfter = openCodeSessionHeaders({
      baseUrl: OPENCODE_BASE,
      fallbackSeed: "opencode-go",
      now: base + HOUR,
    });
    expect(forgedBefore[OPENCODE_SESSION_HEADER]).toMatch(/^ses_[0-9a-f]{32}$/);
    expect(forgedAfter[OPENCODE_SESSION_HEADER]).not.toBe(
      forgedBefore[OPENCODE_SESSION_HEADER],
    );
  });
});

describe("transport-level session fallback", () => {
  test("adds a session header for an opencode upstream that lacks one", () => {
    const headers = fallbackOpenCodeSessionHeaders({
      url: `${OPENCODE_BASE}/chat/completions`,
      headers: { "Content-Type": "application/json" },
      bodyText: chatBody("hi"),
    });
    expect(headers[OPENCODE_SESSION_HEADER]).toMatch(/^ses_[0-9a-f]{32}$/);
  });

  test("leaves a request that already carries the header untouched", () => {
    const client = `ses_${"a7".repeat(16)}`;
    expect(
      fallbackOpenCodeSessionHeaders({
        url: `${OPENCODE_BASE}/chat/completions`,
        headers: { "x-opencode-session": client },
        bodyText: chatBody("hi"),
      }),
    ).toEqual({});
    // Header lookups are case-insensitive.
    expect(
      fallbackOpenCodeSessionHeaders({
        url: `${OPENCODE_BASE}/chat/completions`,
        headers: { "X-OpenCode-Session": client },
        bodyText: chatBody("hi"),
      }),
    ).toEqual({});
  });

  test("ignores non-opencode hosts entirely", () => {
    expect(
      fallbackOpenCodeSessionHeaders({
        url: "https://api.openai.com/v1/chat/completions",
        headers: {},
        bodyText: chatBody("hi"),
      }),
    ).toEqual({});
    expect(
      fallbackOpenCodeSessionHeaders({ url: "not a url", headers: {} }),
    ).toEqual({});
  });

  test("derives a stable id from the body, and falls back to the url", () => {
    const now = 1_800_000_000_000;
    const first = fallbackOpenCodeSessionHeaders({
      url: `${OPENCODE_BASE}/models`,
      bodyText: chatBody("second question"),
      now,
    });
    const next = fallbackOpenCodeSessionHeaders({
      url: `${OPENCODE_BASE}/models`,
      bodyText: chatBody("third question"),
      now,
    });
    expect(first).toEqual(next);

    // A GET probing /models has no body; the url keeps it deterministic.
    const probe = fallbackOpenCodeSessionHeaders({
      url: `${OPENCODE_BASE}/models`,
      now,
    });
    expect(probe[OPENCODE_SESSION_HEADER]).toMatch(/^ses_[0-9a-f]{32}$/);
    expect(probe).toEqual(
      fallbackOpenCodeSessionHeaders({ url: `${OPENCODE_BASE}/models`, now }),
    );
  });
});

describe("bridge upstream session header", () => {
  const upstream: BridgeUpstream = {
    baseUrl: `${OPENCODE_BASE}`,
    apiKey: "secret",
    mode: "chat",
    profileName: "opencode-go",
    updatedAt: "2026-09-23T00:00:00.000Z",
  };

  test("derives a session id for an opencode upstream", () => {
    const headers = sessionHeadersFor(undefined, upstream, chatBody("hi"));
    expect(headers[OPENCODE_SESSION_HEADER]).toMatch(/^ses_[0-9a-f]{32}$/);
  });

  test("passes through a session id sent by the local client", () => {
    const client = `ses_${"c3".repeat(16)}`;
    const headers = sessionHeadersFor(
      fakeRequest({ "x-opencode-session": client }),
      upstream,
      chatBody("hi"),
    );
    expect(headers).toEqual({ [OPENCODE_SESSION_HEADER]: client });
  });

  test("ignores unrelated upstreams", () => {
    expect(
      sessionHeadersFor(
        undefined,
        { ...upstream, baseUrl: "http://127.0.0.1:1/v1" },
        chatBody("hi"),
      ),
    ).toEqual({});
  });
});

describe("gateway upstream session header", () => {
  function provider(overrides: Partial<GatewayProvider> = {}): GatewayProvider {
    return {
      name: "opencode-go",
      displayName: "OpenCode Go",
      apiFormat: "openai-chat",
      baseUrl: OPENCODE_BASE,
      apiKey: "sk-test",
      models: ["glm-5.3"],
      headers: {},
      priority: 100,
      enabled: true,
      updatedAt: "2026-09-23T00:00:00.000Z",
      ...overrides,
    };
  }

  test("adds a derived session header even when the client is translated", () => {
    const headers = buildUpstreamHeaders(provider(), undefined, {
      bodyText: chatBody("hi"),
    });
    expect(headers[OPENCODE_SESSION_HEADER]).toMatch(/^ses_[0-9a-f]{32}$/);
    expect(headers.Authorization).toBe("Bearer sk-test");
  });

  test("preserves the client session id even when the payload is translated", () => {
    const client = `ses_${"d4".repeat(16)}`;
    // Translated requests do not relay `req` wholesale (beta headers would not
    // survive the reformat), but the session id is still carried over.
    const headers = buildUpstreamHeaders(provider(), undefined, {
      bodyText: chatBody("hi"),
      sessionReq: fakeRequest({ session_id: client }),
    });
    expect(headers[OPENCODE_SESSION_HEADER]).toBe(client);
  });

  test("prefers the client session id over a body-derived one", () => {
    const client = `ses_${"e5".repeat(16)}`;
    const headers = buildUpstreamHeaders(
      provider(),
      fakeRequest({ "x-opencode-session": client }),
      { bodyText: chatBody("hi") },
    );
    expect(headers[OPENCODE_SESSION_HEADER]).toBe(client);
  });

  test("never lets the derived header override an explicit provider header", () => {
    const headers = buildUpstreamHeaders(
      provider({ headers: { "x-opencode-session": "ses_explicit" } }),
      fakeRequest({}),
      { bodyText: chatBody("hi") },
    );
    expect(headers[OPENCODE_SESSION_HEADER]).toBe("ses_explicit");
  });

  test("skips unrelated providers", () => {
    const headers = buildUpstreamHeaders(
      provider({ name: "openai", baseUrl: "https://api.openai.com/v1" }),
      fakeRequest({ "x-opencode-session": "ses_keep" }),
      { bodyText: chatBody("hi") },
    );
    expect(headers[OPENCODE_SESSION_HEADER]).toBeUndefined();
  });

  test("still yields a session id without a request body", () => {
    const headers = buildUpstreamHeaders(provider());
    expect(headers[OPENCODE_SESSION_HEADER]).toMatch(/^ses_[0-9a-f]{32}$/);
  });
});
