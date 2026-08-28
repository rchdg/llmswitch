import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayServer, upstreamUrl } from "../src/gateway/server.ts";
import {
  createGatewayKey,
  resetRateLimits,
  updateGatewayKey,
  rotateGatewayKey,
} from "../src/gateway/keys.ts";
import { summarizeUsage } from "../src/gateway/usage.ts";
import {
  saveGatewayProvider,
  saveGatewayRoute,
  readGatewayConfig,
  writeGatewayConfig,
} from "../src/gateway/store.ts";
import type { ApiFormat } from "../src/types.ts";

let root: string;
let gateway: Server;
let gatewayUrl: string;
const upstreams: Server[] = [];

interface UpstreamRecord {
  path: string;
  body: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
}

interface UpstreamHandle {
  url: string;
  requests: UpstreamRecord[];
}

/** Start a mock upstream whose responses are supplied by the test. */
async function startUpstream(
  handler: (
    record: UpstreamRecord,
    respond: (
      status: number,
      body: unknown,
      options?: { sse?: string[] },
    ) => void,
  ) => void,
): Promise<UpstreamHandle> {
  const requests: UpstreamRecord[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
          string,
          unknown
        >;
      } catch {
        body = {};
      }
      const record: UpstreamRecord = {
        path: req.url || "/",
        body,
        headers: req.headers,
      };
      requests.push(record);
      handler(record, (status, payload, options) => {
        if (options?.sse) {
          res.writeHead(status, {
            "Content-Type": "text/event-stream; charset=utf-8",
          });
          for (const frame of options.sse) res.write(frame);
          res.end();
          return;
        }
        const raw = JSON.stringify(payload);
        res.writeHead(status, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(raw),
        });
        res.end(raw);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  upstreams.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { url: `http://127.0.0.1:${address.port}`, requests };
}

function addProvider(options: {
  name: string;
  baseUrl: string;
  apiFormat: ApiFormat;
  models?: string[];
  priority?: number;
}) {
  return saveGatewayProvider({
    name: options.name,
    displayName: options.name,
    apiFormat: options.apiFormat,
    baseUrl: options.baseUrl,
    apiKey: `sk-${options.name}`,
    models: options.models ?? ["test-model"],
    headers: {},
    priority: options.priority ?? 100,
    enabled: true,
    sourceProfile: null,
    updatedAt: new Date().toISOString(),
  });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "llms-gateway-server-"));
  process.env.LLM_SWITCH_HOME = join(root, "home");
  resetRateLimits();
  gateway = createGatewayServer({ log: false });
  await new Promise<void>((resolve) =>
    gateway.listen(0, "127.0.0.1", resolve),
  );
  const address = gateway.address();
  if (!address || typeof address === "string") throw new Error("no port");
  gatewayUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => gateway.close(() => resolve()));
  for (const server of upstreams.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  rmSync(root, { recursive: true, force: true });
  delete process.env.LLM_SWITCH_HOME;
});

function chatCompletionPayload(text: string) {
  return {
    id: "chatcmpl-upstream",
    object: "chat.completion",
    created: 1,
    model: "upstream-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  };
}

async function readSse(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

describe("authentication", () => {
  test("rejects requests without a key", async () => {
    const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test-model", messages: [] }),
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, any>;
    expect(body.error.code).toBe("missing_api_key");
  });

  test("rejects an unknown key", async () => {
    const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer llmsk-deadbeef-nope",
      },
      body: JSON.stringify({ model: "test-model", messages: [] }),
    });
    expect(response.status).toBe(401);
  });

  test("accepts the anthropic x-api-key header and uses its error shape", async () => {
    const response = await fetch(`${gatewayUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test-model", messages: [] }),
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, any>;
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("authentication_error");
  });

  test("enforces per-key model scopes", async () => {
    const upstream = await startUpstream((_record, respond) =>
      respond(200, chatCompletionPayload("hi")),
    );
    addProvider({
      name: "alpha",
      baseUrl: `${upstream.url}/v1`,
      apiFormat: "openai-chat",
      models: ["test-model", "secret-model"],
    });
    const key = createGatewayKey({ name: "scoped", models: ["test-model"] });

    const allowed = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.plaintext}`,
      },
      body: JSON.stringify({ model: "test-model", messages: [] }),
    });
    expect(allowed.status).toBe(200);

    const denied = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.plaintext}`,
      },
      body: JSON.stringify({ model: "secret-model", messages: [] }),
    });
    expect(denied.status).toBe(403);
  });

  test("advertises rate-limit headers and blocks past the limit", async () => {
    const upstream = await startUpstream((_record, respond) =>
      respond(200, chatCompletionPayload("hi")),
    );
    addProvider({
      name: "alpha",
      baseUrl: `${upstream.url}/v1`,
      apiFormat: "openai-chat",
    });
    const key = createGatewayKey({ name: "limited", rateLimitPerMinute: 1 });

    const send = () =>
      fetch(`${gatewayUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key.plaintext}`,
        },
        body: JSON.stringify({ model: "test-model", messages: [] }),
      });

    const first = await send();
    expect(first.status).toBe(200);
    expect(first.headers.get("x-ratelimit-limit")).toBe("1");
    expect(first.headers.get("x-ratelimit-remaining")).toBe("0");
    expect(Number(first.headers.get("x-ratelimit-reset"))).toBeGreaterThan(0);

    const second = await send();
    expect(second.status).toBe(429);
    expect(second.headers.get("x-ratelimit-remaining")).toBe("0");
    expect(Number(second.headers.get("retry-after"))).toBeGreaterThan(0);
    // The blocked request never reached the upstream.
    expect(upstream.requests).toHaveLength(1);
  });

  test("omits rate-limit headers when no limit applies", async () => {
    const upstream = await startUpstream((_record, respond) =>
      respond(200, chatCompletionPayload("hi")),
    );
    addProvider({
      name: "alpha",
      baseUrl: `${upstream.url}/v1`,
      apiFormat: "openai-chat",
    });
    const key = createGatewayKey({ name: "unlimited" });
    const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.plaintext}`,
      },
      body: JSON.stringify({ model: "test-model", messages: [] }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratelimit-limit")).toBeNull();
  });
});

describe("model catalogue", () => {
  test("lists routable models filtered by key scope", async () => {
    addProvider({
      name: "alpha",
      baseUrl: "https://alpha.test/v1",
      apiFormat: "openai-chat",
      models: ["m1", "m2"],
    });
    saveGatewayRoute({
      alias: "friendly",
      provider: "alpha",
      model: "m1",
      updatedAt: new Date().toISOString(),
    });
    const key = createGatewayKey({ name: "scoped", models: ["m1"] });

    const response = await fetch(`${gatewayUrl}/v1/models`, {
      headers: { authorization: `Bearer ${key.plaintext}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Array<Record<string, any>> };
    const ids = body.data.map((item) => item.id);
    expect(ids).toContain("friendly");
    expect(ids).toContain("m1");
    expect(ids).not.toContain("m2");
    expect(body.data[0]?.owned_by).toBe("alpha");
  });
});

describe("format conversion", () => {
  test("passes an OpenAI request through to an OpenAI upstream", async () => {
    const upstream = await startUpstream((_record, respond) =>
      respond(200, chatCompletionPayload("pass")),
    );
    addProvider({
      name: "alpha",
      baseUrl: `${upstream.url}/v1`,
      apiFormat: "openai-chat",
    });
    const key = createGatewayKey({ name: "k" });

    const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.plaintext}`,
      },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    // The client-requested model id is echoed back, not the upstream's.
    expect(body.model).toBe("test-model");
    expect(body.choices[0].message.content).toBe("pass");
    expect(upstream.requests[0]?.path).toBe("/v1/chat/completions");
    expect(upstream.requests[0]?.headers.authorization).toBe("Bearer sk-alpha");
  });

  test("converts an OpenAI request into an Anthropic upstream call", async () => {
    const upstream = await startUpstream((_record, respond) =>
      respond(200, {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-upstream",
        content: [{ type: "text", text: "converted" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 6 },
      }),
    );
    addProvider({
      name: "claude",
      baseUrl: upstream.url,
      apiFormat: "anthropic",
    });
    const key = createGatewayKey({ name: "k" });

    const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.plaintext}`,
      },
      body: JSON.stringify({
        model: "test-model",
        max_tokens: 32,
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hi" },
        ],
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("test-model");
    expect(body.choices[0].message.content).toBe("converted");
    expect(body.usage.prompt_tokens).toBe(5);

    const sent = upstream.requests[0]!;
    expect(sent.path).toBe("/v1/messages");
    expect(sent.headers["x-api-key"]).toBe("sk-claude");
    expect(sent.headers["anthropic-version"]).toBe("2023-06-01");
    expect(sent.body.system).toBe("sys");
    expect(sent.body.max_tokens).toBe(32);
  });

  test("converts an Anthropic request into an OpenAI upstream call", async () => {
    const upstream = await startUpstream((_record, respond) =>
      respond(200, chatCompletionPayload("from chat")),
    );
    addProvider({
      name: "alpha",
      baseUrl: `${upstream.url}/v1`,
      apiFormat: "openai-chat",
    });
    const key = createGatewayKey({ name: "k" });

    const response = await fetch(`${gatewayUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key.plaintext,
      },
      body: JSON.stringify({
        model: "test-model",
        max_tokens: 64,
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.type).toBe("message");
    expect(body.model).toBe("test-model");
    expect(body.content[0]).toEqual({ type: "text", text: "from chat" });
    expect(body.usage.input_tokens).toBe(1);
    expect(upstream.requests[0]?.body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
  });

  test("converts a Responses request into an OpenAI chat upstream call", async () => {
    const upstream = await startUpstream((_record, respond) =>
      respond(200, chatCompletionPayload("responses out")),
    );
    addProvider({
      name: "alpha",
      baseUrl: `${upstream.url}/v1`,
      apiFormat: "openai-chat",
    });
    const key = createGatewayKey({ name: "k" });

    const response = await fetch(`${gatewayUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.plaintext}`,
      },
      body: JSON.stringify({
        model: "test-model",
        instructions: "sys",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hi" }],
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.object).toBe("response");
    expect(body.status).toBe("completed");
    expect(body.output[0].content[0].text).toBe("responses out");
  });

  test("converts an OpenAI request into a Responses upstream call", async () => {
    const upstream = await startUpstream((_record, respond) =>
      respond(200, {
        id: "resp_1",
        object: "response",
        status: "completed",
        model: "gpt-upstream",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "via responses" }],
          },
        ],
        usage: { input_tokens: 4, output_tokens: 8 },
      }),
    );
    addProvider({
      name: "oa",
      baseUrl: `${upstream.url}/v1`,
      apiFormat: "openai-responses",
    });
    const key = createGatewayKey({ name: "k" });

    const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.plaintext}`,
      },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.choices[0].message.content).toBe("via responses");
    expect(body.usage.completion_tokens).toBe(8);
    const sent = upstream.requests[0]!;
    expect(sent.path).toBe("/v1/responses");
    expect(sent.body.store).toBe(false);
  });
});

describe("streaming", () => {
  test("relays an OpenAI stream verbatim", async () => {
    const upstream = await startUpstream((_record, respond) =>
      respond(200, null, {
        sse: [
          'data: {"id":"1","choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n',
          'data: {"id":"1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
          "data: [DONE]\n\n",
        ],
      }),
    );
    addProvider({
      name: "alpha",
      baseUrl: `${upstream.url}/v1`,
      apiFormat: "openai-chat",
    });
    const key = createGatewayKey({ name: "k" });

    const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.plaintext}`,
      },
      body: JSON.stringify({
        model: "test-model",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await readSse(response);
    expect(text).toContain('"content":"Hi"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  test("translates an Anthropic upstream stream into OpenAI chunks", async () => {
    const upstream = await startUpstream((_record, respond) =>
      respond(200, null, {
        sse: [
          `event: message_start\ndata: ${JSON.stringify({
            type: "message_start",
            message: {
              id: "msg_1",
              model: "claude-upstream",
              usage: { input_tokens: 3, output_tokens: 0 },
            },
          })}\n\n`,
          `event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          })}\n\n`,
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Hello" },
          })}\n\n`,
          `event: message_delta\ndata: ${JSON.stringify({
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 5 },
          })}\n\n`,
          `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
        ],
      }),
    );
    addProvider({
      name: "claude",
      baseUrl: upstream.url,
      apiFormat: "anthropic",
    });
    const key = createGatewayKey({ name: "k" });

    const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.plaintext}`,
      },
      body: JSON.stringify({
        model: "test-model",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    const text = await readSse(response);
    expect(text).toContain('"content":"Hello"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain('"model":"test-model"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(upstream.requests[0]?.body.stream).toBe(true);
  });

  test("translates an OpenAI upstream stream into Anthropic events", async () => {
    const upstream = await startUpstream((_record, respond) =>
      respond(200, null, {
        sse: [
          'data: {"id":"1","choices":[{"index":0,"delta":{"role":"assistant","content":"Hey"}}]}\n\n',
          'data: {"id":"1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
          "data: [DONE]\n\n",
        ],
      }),
    );
    addProvider({
      name: "alpha",
      baseUrl: `${upstream.url}/v1`,
      apiFormat: "openai-chat",
    });
    const key = createGatewayKey({ name: "k" });

    const response = await fetch(`${gatewayUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key.plaintext,
      },
      body: JSON.stringify({
        model: "test-model",
        max_tokens: 16,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    const text = await readSse(response);
    expect(text).toContain("event: message_start");
    expect(text).toContain('"text_delta"');
    expect(text).toContain("event: message_stop");
  });
});

describe("provider fallback", () => {
  test("moves to the next provider on a retryable status", async () => {
    const failing = await startUpstream((_record, respond) =>
      respond(503, { error: { message: "overloaded" } }),
    );
    const healthy = await startUpstream((_record, respond) =>
      respond(200, chatCompletionPayload("second try")),
    );
    addProvider({
      name: "primary",
      baseUrl: `${failing.url}/v1`,
      apiFormat: "openai-chat",
      priority: 1,
    });
    addProvider({
      name: "backup",
      baseUrl: `${healthy.url}/v1`,
      apiFormat: "openai-chat",
      priority: 2,
    });
    const key = createGatewayKey({ name: "k" });

    const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.plaintext}`,
      },
      body: JSON.stringify({ model: "test-model", messages: [] }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.choices[0].message.content).toBe("second try");
    expect(failing.requests).toHaveLength(1);
    expect(healthy.requests).toHaveLength(1);
  });

  test("does not fall back on a non-retryable status", async () => {
    const failing = await startUpstream((_record, respond) =>
      respond(400, { error: { message: "bad request" } }),
    );
    const healthy = await startUpstream((_record, respond) =>
      respond(200, chatCompletionPayload("unused")),
    );
    addProvider({
      name: "primary",
      baseUrl: `${failing.url}/v1`,
      apiFormat: "openai-chat",
      priority: 1,
    });
    addProvider({
      name: "backup",
      baseUrl: `${healthy.url}/v1`,
      apiFormat: "openai-chat",
      priority: 2,
    });
    const key = createGatewayKey({ name: "k" });

    const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.plaintext}`,
      },
      body: JSON.stringify({ model: "test-model", messages: [] }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, any>;
    expect(body.error.message).toBe("bad request");
    expect(healthy.requests).toHaveLength(0);
  });

  test("reports every attempt when all upstreams fail", async () => {
    const first = await startUpstream((_record, respond) =>
      respond(503, { error: { message: "down-1" } }),
    );
    const second = await startUpstream((_record, respond) =>
      respond(502, { error: { message: "down-2" } }),
    );
    addProvider({
      name: "one",
      baseUrl: `${first.url}/v1`,
      apiFormat: "openai-chat",
      priority: 1,
    });
    addProvider({
      name: "two",
      baseUrl: `${second.url}/v1`,
      apiFormat: "openai-chat",
      priority: 2,
    });
    const key = createGatewayKey({ name: "k" });

    const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.plaintext}`,
      },
      body: JSON.stringify({ model: "test-model", messages: [] }),
    });

    expect(response.status).toBe(502);
    const body = (await response.json()) as Record<string, any>;
    expect(body.error.message).toContain("down-2");
  });

  test("respects a disabled fallback policy", async () => {
    const failing = await startUpstream((_record, respond) =>
      respond(503, { error: { message: "nope" } }),
    );
    const healthy = await startUpstream((_record, respond) =>
      respond(200, chatCompletionPayload("unused")),
    );
    addProvider({
      name: "one",
      baseUrl: `${failing.url}/v1`,
      apiFormat: "openai-chat",
      priority: 1,
    });
    addProvider({
      name: "two",
      baseUrl: `${healthy.url}/v1`,
      apiFormat: "openai-chat",
      priority: 2,
    });
    const config = readGatewayConfig();
    writeGatewayConfig({
      ...config,
      fallback: { ...config.fallback, enabled: false },
    });
    const key = createGatewayKey({ name: "k" });

    const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.plaintext}`,
      },
      body: JSON.stringify({ model: "test-model", messages: [] }),
    });

    expect(response.status).toBe(503);
    expect(healthy.requests).toHaveLength(0);
  });
});

describe("auxiliary endpoints", () => {
  test("proxies embeddings to an OpenAI-compatible upstream", async () => {
    const upstream = await startUpstream((_record, respond) =>
      respond(200, {
        object: "list",
        model: "embed-upstream",
        data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
      }),
    );
    addProvider({
      name: "alpha",
      baseUrl: `${upstream.url}/v1`,
      apiFormat: "openai-chat",
      models: ["embed-model"],
    });
    const key = createGatewayKey({ name: "k" });

    const response = await fetch(`${gatewayUrl}/v1/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.plaintext}`,
      },
      body: JSON.stringify({ model: "embed-model", input: "hello" }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.model).toBe("embed-model");
    expect(upstream.requests[0]?.path).toBe("/v1/embeddings");
  });

  test("rejects embeddings when only anthropic upstreams can serve the model", async () => {
    addProvider({
      name: "claude",
      baseUrl: "https://claude.test",
      apiFormat: "anthropic",
      models: ["embed-model"],
    });
    const key = createGatewayKey({ name: "k" });

    const response = await fetch(`${gatewayUrl}/v1/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.plaintext}`,
      },
      body: JSON.stringify({ model: "embed-model", input: "hello" }),
    });

    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, any>;
    expect(body.error.code).toBe("embeddings_unsupported");
  });

  test("proxies count_tokens to a native anthropic upstream", async () => {
    const upstream = await startUpstream((_record, respond) =>
      respond(200, { input_tokens: 42 }),
    );
    addProvider({
      name: "claude",
      baseUrl: upstream.url,
      apiFormat: "anthropic",
    });
    const key = createGatewayKey({ name: "k" });

    const response = await fetch(`${gatewayUrl}/v1/messages/count_tokens`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key.plaintext,
      },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ input_tokens: 42 });
    expect(upstream.requests[0]?.path).toBe("/v1/messages/count_tokens");
  });

  test("estimates count_tokens locally for non-anthropic upstreams", async () => {
    addProvider({
      name: "alpha",
      baseUrl: "https://alpha.test/v1",
      apiFormat: "openai-chat",
    });
    const key = createGatewayKey({ name: "k" });

    const response = await fetch(`${gatewayUrl}/v1/messages/count_tokens`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key.plaintext,
      },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "hello there" }],
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.llm_switch.estimated).toBe(true);
    expect(body.llm_switch.reason).toBe("upstream_not_anthropic");
    expect(["tokenizer", "heuristic"]).toContain(body.llm_switch.method);
    expect(body.llm_switch.breakdown).toMatchObject({
      images: 0,
      tools: 0,
    });
    expect(body.input_tokens).toBeGreaterThan(0);
  });

  test("estimates count_tokens when the native upstream call fails", async () => {
    const upstream = await startUpstream((_record, respond) =>
      respond(500, { error: { message: "boom" } }),
    );
    addProvider({
      name: "claude",
      baseUrl: upstream.url,
      apiFormat: "anthropic",
    });
    const key = createGatewayKey({ name: "k" });

    const response = await fetch(`${gatewayUrl}/v1/messages/count_tokens`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key.plaintext,
      },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.llm_switch.reason).toBe("upstream_count_failed");
    expect(body.input_tokens).toBeGreaterThan(0);
  });

  test("serves an unauthenticated liveness probe", async () => {
    const response = await fetch(`${gatewayUrl}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body).toEqual({ ok: true, service: "llm-switch-gateway" });
  });

  test("returns a protocol-shaped 404 for unknown endpoints", async () => {
    const response = await fetch(`${gatewayUrl}/v1/nope`, { method: "POST" });
    expect(response.status).toBe(404);
  });

  test("rejects malformed json with the inbound error shape", async () => {
    const key = createGatewayKey({ name: "k" });
    addProvider({
      name: "alpha",
      baseUrl: "https://alpha.test/v1",
      apiFormat: "openai-chat",
    });
    const response = await fetch(`${gatewayUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key.plaintext,
      },
      body: "{not json",
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, any>;
    expect(body.type).toBe("error");
  });

  test("returns 404 for a model that cannot be routed", async () => {
    addProvider({
      name: "alpha",
      baseUrl: "https://alpha.test/v1",
      apiFormat: "openai-chat",
      models: ["known"],
    });
    const key = createGatewayKey({ name: "k" });
    const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.plaintext}`,
      },
      body: JSON.stringify({ model: "unknown", messages: [] }),
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, any>;
    expect(body.error.code).toBe("model_not_found");
  });
});

describe("key scope alias matching", () => {
  test("a key scoped to an alias keeps working when the route maps to another upstream id", async () => {
    const upstream = await startUpstream((_record, respond) =>
      respond(200, chatCompletionPayload("hi")),
    );
    addProvider({
      name: "alpha",
      baseUrl: `${upstream.url}/v1`,
      apiFormat: "openai-chat",
      models: ["gpt-4o-2024-11"],
    });
    saveGatewayRoute({
      alias: "gpt-4o",
      provider: "alpha",
      model: "gpt-4o-2024-11",
      updatedAt: new Date().toISOString(),
    });
    const key = createGatewayKey({ name: "aliased", models: ["gpt-4o"] });

    const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.plaintext}`,
      },
      body: JSON.stringify({ model: "gpt-4o", messages: [] }),
    });
    expect(response.status).toBe(200);
    expect(upstream.requests[0]?.body.model).toBe("gpt-4o-2024-11");
  });

  test("a key scoped to a qualified provider/model entry matches both spellings", async () => {
    const upstream = await startUpstream((_record, respond) =>
      respond(200, chatCompletionPayload("hi")),
    );
    addProvider({
      name: "alpha",
      baseUrl: `${upstream.url}/v1`,
      apiFormat: "openai-chat",
    });
    const key = createGatewayKey({
      name: "qualified",
      models: ["alpha/test-model"],
    });

    const bare = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.plaintext}`,
      },
      body: JSON.stringify({ model: "alpha/test-model", messages: [] }),
    });
    expect(bare.status).toBe(200);

    const direct = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.plaintext}`,
      },
      body: JSON.stringify({ model: "test-model", messages: [] }),
    });
    expect(direct.status).toBe(200);
  });

  test("a key scoped to one provider never matches another provider's model", async () => {
    const upstream = await startUpstream((_record, respond) =>
      respond(200, chatCompletionPayload("hi")),
    );
    addProvider({
      name: "alpha",
      baseUrl: `${upstream.url}/v1`,
      apiFormat: "openai-chat",
    });
    addProvider({
      name: "beta",
      baseUrl: `${upstream.url}/v1`,
      apiFormat: "openai-chat",
    });
    const key = createGatewayKey({
      name: "strict",
      providers: ["alpha"],
      models: ["beta/test-model"],
    });

    const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.plaintext}`,
      },
      body: JSON.stringify({ model: "test-model", messages: [] }),
    });
    expect(response.status).toBe(403);
  });

  test("the model catalogue reflects alias scopes", async () => {
    addProvider({
      name: "alpha",
      baseUrl: "https://alpha.test/v1",
      apiFormat: "openai-chat",
      models: ["m1"],
    });
    saveGatewayRoute({
      alias: "friendly",
      provider: "alpha",
      model: "m1",
      updatedAt: new Date().toISOString(),
    });
    const key = createGatewayKey({ name: "scoped", models: ["friendly"] });

    const response = await fetch(`${gatewayUrl}/v1/models`, {
      headers: { authorization: `Bearer ${key.plaintext}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Array<Record<string, any>> };
    const ids = body.data.map((item) => item.id);
    // Strict scope: the key named the alias, so only that spelling is exposed.
    expect(ids).toContain("friendly");
    expect(ids).not.toContain("m1");
  });
});

describe("key validation", () => {
  test("rejects unknown format scopes instead of widening them", () => {
    expect(() => createGatewayKey({ name: "bad", formats: ["bogus"] })).toThrow(
      /无效的接口格式/,
    );
  });

  test("accepts explicit format scopes", () => {
    const created = createGatewayKey({
      name: "good",
      formats: ["anthropic", "openai-chat"],
    });
    expect(created.key.formats).toEqual(["anthropic", "openai-chat"]);
  });
});

describe("rate limit semantics", () => {
  test("rateLimitPerMinute -1 exempts a key from the global default", async () => {
    const upstream = await startUpstream((_record, respond) =>
      respond(200, chatCompletionPayload("hi")),
    );
    addProvider({
      name: "alpha",
      baseUrl: `${upstream.url}/v1`,
      apiFormat: "openai-chat",
    });
    const config = readGatewayConfig();
    writeGatewayConfig({ ...config, rateLimitPerMinute: 1 });
    const key = createGatewayKey({ name: "exempt", rateLimitPerMinute: -1 });

    const send = () =>
      fetch(`${gatewayUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key.plaintext}`,
        },
        body: JSON.stringify({ model: "test-model", messages: [] }),
      });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect(upstream.requests).toHaveLength(2);
  });

  test("rateLimitPerMinute 0 inherits the global default", async () => {
    const upstream = await startUpstream((_record, respond) =>
      respond(200, chatCompletionPayload("hi")),
    );
    addProvider({
      name: "alpha",
      baseUrl: `${upstream.url}/v1`,
      apiFormat: "openai-chat",
    });
    const config = readGatewayConfig();
    writeGatewayConfig({ ...config, rateLimitPerMinute: 1 });
    const key = createGatewayKey({ name: "inherit" });

    const send = () =>
      fetch(`${gatewayUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key.plaintext}`,
        },
        body: JSON.stringify({ model: "test-model", messages: [] }),
      });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(429);
  });
});

describe("upstream path prefix", () => {
  test("defaults to /v1 and never duplicates an existing suffix", () => {
    const provider = (baseUrl: string, pathPrefix?: string) =>
      ({
        name: "p",
        displayName: "p",
        apiFormat: "openai-chat",
        baseUrl,
        apiKey: "",
        models: [],
        ...(pathPrefix === undefined ? {} : { pathPrefix }),
        priority: 100,
        enabled: true,
        updatedAt: new Date(0).toISOString(),
      }) as Parameters<typeof upstreamUrl>[0];
    expect(upstreamUrl(provider("https://x.test"), "/chat/completions")).toBe(
      "https://x.test/v1/chat/completions",
    );
    expect(upstreamUrl(provider("https://x.test/v1"), "/chat/completions")).toBe(
      "https://x.test/v1/chat/completions",
    );
    expect(
      upstreamUrl(provider("https://x.test/v1", ""), "/chat/completions"),
    ).toBe("https://x.test/v1/chat/completions");
    expect(
      upstreamUrl(
        provider("https://x.test/v1beta/openai", ""),
        "/chat/completions",
      ),
    ).toBe("https://x.test/v1beta/openai/chat/completions");
    expect(
      upstreamUrl(provider("https://x.test", "v2"), "/chat/completions"),
    ).toBe("https://x.test/v2/chat/completions");
  });

  test("routes to a prefix-less upstream verbatim", async () => {
    const upstream = await startUpstream((_record, respond) =>
      respond(200, chatCompletionPayload("hi")),
    );
    saveGatewayProvider({
      name: "gemini-compat",
      displayName: "gemini-compat",
      apiFormat: "openai-chat",
      baseUrl: `${upstream.url}/v1beta/openai`,
      apiKey: "sk-test",
      models: ["test-model"],
      pathPrefix: "",
      priority: 100,
      enabled: true,
      sourceProfile: null,
      updatedAt: new Date().toISOString(),
    });
    const key = createGatewayKey({ name: "k" });

    const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.plaintext}`,
      },
      body: JSON.stringify({ model: "test-model", messages: [] }),
    });
    expect(response.status).toBe(200);
    expect(upstream.requests[0]?.path).toBe("/v1beta/openai/chat/completions");
  });
});

describe("beta header forwarding", () => {
  test("relays anthropic-beta on an anthropic passthrough", async () => {
    const upstream = await startUpstream((_record, respond) =>
      respond(200, {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "test-model",
        content: [{ type: "text", text: "hi" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    addProvider({
      name: "claude",
      baseUrl: upstream.url,
      apiFormat: "anthropic",
    });
    const key = createGatewayKey({ name: "k" });

    const response = await fetch(`${gatewayUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key.plaintext,
        "anthropic-beta": "interleaved-thinking-2025-05-14",
      },
      body: JSON.stringify({
        model: "test-model",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(response.status).toBe(200);
    expect(upstream.requests[0]?.headers["anthropic-beta"]).toBe(
      "interleaved-thinking-2025-05-14",
    );
  });

  test("does not relay beta headers across format conversions", async () => {
    const upstream = await startUpstream((_record, respond) =>
      respond(200, chatCompletionPayload("hi")),
    );
    addProvider({
      name: "alpha",
      baseUrl: `${upstream.url}/v1`,
      apiFormat: "openai-chat",
    });
    const key = createGatewayKey({ name: "k" });

    const response = await fetch(`${gatewayUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key.plaintext,
        "anthropic-beta": "some-beta",
      },
      body: JSON.stringify({
        model: "test-model",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(response.status).toBe(200);
    expect(upstream.requests[0]?.headers["anthropic-beta"]).toBeUndefined();
  });

  test("provider-configured headers win over forwarded client headers", async () => {
    const upstream = await startUpstream((_record, respond) =>
      respond(200, {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "test-model",
        content: [{ type: "text", text: "hi" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    saveGatewayProvider({
      name: "claude",
      displayName: "claude",
      apiFormat: "anthropic",
      baseUrl: upstream.url,
      apiKey: "sk-test",
      models: ["test-model"],
      headers: { "anthropic-beta": "provider-pin" },
      priority: 100,
      enabled: true,
      sourceProfile: null,
      updatedAt: new Date().toISOString(),
    });
    const key = createGatewayKey({ name: "k" });

    const response = await fetch(`${gatewayUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key.plaintext,
        "anthropic-beta": "client-beta",
      },
      body: JSON.stringify({
        model: "test-model",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(response.status).toBe(200);
    expect(upstream.requests[0]?.headers["anthropic-beta"]).toBe(
      "provider-pin",
    );
  });
});

describe("key edit and rotate", () => {
  test("widening a model scope takes effect on the next request", async () => {
    const upstream = await startUpstream((_record, respond) =>
      respond(200, chatCompletionPayload("hi")),
    );
    addProvider({
      name: "alpha",
      baseUrl: `${upstream.url}/v1`,
      apiFormat: "openai-chat",
      models: ["test-model", "other-model"],
    });
    const key = createGatewayKey({ name: "scoped", models: ["test-model"] });

    const denied = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.plaintext}`,
      },
      body: JSON.stringify({ model: "other-model", messages: [] }),
    });
    expect(denied.status).toBe(403);

    updateGatewayKey(key.key.id, { models: ["test-model", "other-model"] });

    const allowed = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.plaintext}`,
      },
      body: JSON.stringify({ model: "other-model", messages: [] }),
    });
    expect(allowed.status).toBe(200);
  });

  test("editing rejects invalid formats and negative expiry", () => {
    const key = createGatewayKey({ name: "guard" });
    expect(() =>
      updateGatewayKey(key.key.id, { formats: ["nope"] }),
    ).toThrow(/无效的接口格式/);
    expect(() =>
      updateGatewayKey(key.key.id, { expiresInDays: -1 }),
    ).toThrow(/有效期天数/);
  });

  test("rotate invalidates the old plaintext and keeps scopes", async () => {
    const upstream = await startUpstream((_record, respond) =>
      respond(200, chatCompletionPayload("hi")),
    );
    addProvider({
      name: "alpha",
      baseUrl: `${upstream.url}/v1`,
      apiFormat: "openai-chat",
    });
    const key = createGatewayKey({ name: "rotating", models: ["test-model"] });
    const rotated = rotateGatewayKey(key.key.id);

    const oldResponse = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.plaintext}`,
      },
      body: JSON.stringify({ model: "test-model", messages: [] }),
    });
    expect(oldResponse.status).toBe(401);

    const newResponse = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${rotated.plaintext}`,
      },
      body: JSON.stringify({ model: "test-model", messages: [] }),
    });
    expect(newResponse.status).toBe(200);
    expect(rotated.key.models).toEqual(["test-model"]);
  });

  test("clearing expiry via edit works", () => {
    const key = createGatewayKey({ name: "expiry", expiresInDays: 1 });
    expect(key.key.expiresAt).not.toBeNull();
    const updated = updateGatewayKey(key.key.id, { expiresInDays: 0 });
    expect(updated.expiresAt).toBeNull();
  });
});

describe("provider breaker", () => {
  test("a cooling provider is skipped on the next request", async () => {
    const failing = await startUpstream((_record, respond) =>
      respond(503, { error: { message: "overloaded" } }),
    );
    const healthy = await startUpstream((_record, respond) =>
      respond(200, chatCompletionPayload("ok")),
    );
    addProvider({
      name: "primary",
      baseUrl: `${failing.url}/v1`,
      apiFormat: "openai-chat",
      priority: 1,
    });
    addProvider({
      name: "backup",
      baseUrl: `${healthy.url}/v1`,
      apiFormat: "openai-chat",
      priority: 2,
    });
    const key = createGatewayKey({ name: "k" });
    const send = () =>
      fetch(`${gatewayUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key.plaintext}`,
        },
        body: JSON.stringify({ model: "test-model", messages: [] }),
      });

    const first = await send();
    expect(first.status).toBe(200);
    expect(failing.requests).toHaveLength(1);

    // Second request: primary is cooling down, so it is not tried again.
    const second = await send();
    expect(second.status).toBe(200);
    expect(failing.requests).toHaveLength(1);
    expect(healthy.requests).toHaveLength(2);
  });
});

describe("usage accounting", () => {
  test("records requests and tokens for non-stream completions", async () => {
    const upstream = await startUpstream((_record, respond) =>
      respond(200, chatCompletionPayload("hi")),
    );
    addProvider({
      name: "alpha",
      baseUrl: `${upstream.url}/v1`,
      apiFormat: "openai-chat",
    });
    const key = createGatewayKey({ name: "k" });

    await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.plaintext}`,
      },
      body: JSON.stringify({ model: "test-model", messages: [] }),
    });

    const rows = summarizeUsage({ days: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: key.key.id,
      provider: "alpha",
      model: "test-model",
      requests: 1,
      inputTokens: 1,
      outputTokens: 2,
    });
  });

  test("records usage for streaming completions", async () => {
    // Anthropic upstream → OpenAI inbound is a decoded stream, so usage lines
    // from message_start / message_delta reach the accounting layer.
    const upstream = await startUpstream((_record, respond) =>
      respond(200, null, {
        sse: [
          `event: message_start\ndata: ${JSON.stringify({
            type: "message_start",
            message: {
              id: "msg_1",
              model: "claude-upstream",
              usage: { input_tokens: 3, output_tokens: 0 },
            },
          })}\n\n`,
          `event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          })}\n\n`,
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Hello" },
          })}\n\n`,
          `event: message_delta\ndata: ${JSON.stringify({
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 5 },
          })}\n\n`,
          `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
        ],
      }),
    );
    addProvider({
      name: "claude",
      baseUrl: upstream.url,
      apiFormat: "anthropic",
    });
    const key = createGatewayKey({ name: "k" });

    const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.plaintext}`,
      },
      body: JSON.stringify({ model: "test-model", messages: [], stream: true }),
    });
    expect(response.status).toBe(200);

    const rows = summarizeUsage({ days: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "claude",
      inputTokens: 3,
      outputTokens: 5,
    });
  });
});

describe("model detail endpoint", () => {
  test("returns a single routable model", async () => {
    addProvider({
      name: "alpha",
      baseUrl: "https://alpha.test/v1",
      apiFormat: "openai-chat",
      models: ["m1"],
    });
    const key = createGatewayKey({ name: "k" });

    const response = await fetch(`${gatewayUrl}/v1/models/m1`, {
      headers: { authorization: `Bearer ${key.plaintext}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.id).toBe("m1");
    expect(body.owned_by).toBe("alpha");
    expect(body.llm_switch.format).toBe("openai-chat");
  });

  test("404s for unknown or out-of-scope models", async () => {
    addProvider({
      name: "alpha",
      baseUrl: "https://alpha.test/v1",
      apiFormat: "openai-chat",
      models: ["m1", "m2"],
    });
    const key = createGatewayKey({ name: "scoped", models: ["m1"] });

    const missing = await fetch(`${gatewayUrl}/v1/models/nope`, {
      headers: { authorization: `Bearer ${key.plaintext}` },
    });
    expect(missing.status).toBe(404);

    const denied = await fetch(`${gatewayUrl}/v1/models/m2`, {
      headers: { authorization: `Bearer ${key.plaintext}` },
    });
    expect(denied.status).toBe(404);
  });
});

describe("legacy completions", () => {
  test("translates prompt-based requests into chat and back", async () => {
    const upstream = await startUpstream((_record, respond) =>
      respond(200, chatCompletionPayload("legacy hi")),
    );
    addProvider({
      name: "alpha",
      baseUrl: `${upstream.url}/v1`,
      apiFormat: "openai-chat",
    });
    const key = createGatewayKey({ name: "k" });

    const response = await fetch(`${gatewayUrl}/v1/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.plaintext}`,
      },
      body: JSON.stringify({ model: "test-model", prompt: "say hi" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.object).toBe("text_completion");
    expect(body.model).toBe("test-model");
    expect(body.choices[0].text).toBe("legacy hi");
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.usage.total_tokens).toBe(3);
    expect(upstream.requests[0]?.body.messages).toEqual([
      { role: "user", content: "say hi" },
    ]);
    expect(upstream.requests[0]?.body.prompt).toBeUndefined();
  });

  test("streams legacy text chunks", async () => {
    const upstream = await startUpstream((_record, respond) =>
      respond(200, null, {
        sse: [
          'data: {"id":"1","choices":[{"index":0,"delta":{"content":"Hel"}}]}\n\n',
          'data: {"id":"1","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}\n\n',
          'data: {"id":"1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
          "data: [DONE]\n\n",
        ],
      }),
    );
    addProvider({
      name: "alpha",
      baseUrl: `${upstream.url}/v1`,
      apiFormat: "openai-chat",
    });
    const key = createGatewayKey({ name: "k" });

    const response = await fetch(`${gatewayUrl}/v1/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.plaintext}`,
      },
      body: JSON.stringify({
        model: "test-model",
        prompt: "say hi",
        stream: true,
      }),
    });
    expect(response.status).toBe(200);
    const text = await readSse(response);
    expect(text).toContain('"object":"text_completion.chunk"');
    expect(text).toContain('"text":"Hel"');
    expect(text).toContain('"text":"lo"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });
});

describe("daily quota", () => {
  test("blocks requests once the daily cap is reached", async () => {
    const upstream = await startUpstream((_record, respond) =>
      respond(200, chatCompletionPayload("hi")),
    );
    addProvider({
      name: "alpha",
      baseUrl: `${upstream.url}/v1`,
      apiFormat: "openai-chat",
    });
    const key = createGatewayKey({ name: "daily", requestsPerDay: 2 });
    const send = () =>
      fetch(`${gatewayUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key.plaintext}`,
        },
        body: JSON.stringify({ model: "test-model", messages: [] }),
      });

    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    const third = await send();
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(upstream.requests).toHaveLength(2);
  });
});

describe("request id", () => {
  test("echoes a client-supplied x-request-id and forwards it upstream", async () => {
    const upstream = await startUpstream((_record, respond) =>
      respond(200, chatCompletionPayload("hi")),
    );
    addProvider({
      name: "alpha",
      baseUrl: `${upstream.url}/v1`,
      apiFormat: "openai-chat",
    });
    const key = createGatewayKey({ name: "k" });

    const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.plaintext}`,
        "x-request-id": "client-req-42",
      },
      body: JSON.stringify({ model: "test-model", messages: [] }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("client-req-42");
    expect(upstream.requests[0]?.headers["x-request-id"]).toBe("client-req-42");
  });

  test("mints a request id when the client sends none", async () => {
    addProvider({
      name: "alpha",
      baseUrl: "https://alpha.test/v1",
      apiFormat: "openai-chat",
      models: ["test-model"],
    });
    const key = createGatewayKey({ name: "k" });

    const response = await fetch(`${gatewayUrl}/v1/models`, {
      headers: { authorization: `Bearer ${key.plaintext}` },
    });
    expect(response.status).toBe(200);
    const id = response.headers.get("x-request-id");
    expect(id).toBeTruthy();
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  test("401 responses advertise WWW-Authenticate", async () => {
    const response = await fetch(`${gatewayUrl}/v1/models`);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });
});
