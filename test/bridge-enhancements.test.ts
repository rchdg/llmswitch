import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  estimateChatInputTokens,
  responsesToChatRequest,
} from "../src/bridge/translate-request.ts";
import {
  chatChunkToResponsesEvents,
  chatCompletionToResponse,
  createStreamState,
  estimateTokens,
  forceCompleteStream,
} from "../src/bridge/translate-response.ts";
import {
  recentBridgeLogs,
  recordBridgeLog,
} from "../src/bridge/logs.ts";
import { runBridgeForeground, stopBridge } from "../src/bridge/manager.ts";
import {
  generateBridgeToken,
  readBridgeState,
  writeBridgeUpstream,
} from "../src/bridge/state.ts";
import type { BridgeUpstream } from "../src/bridge/types.ts";

describe("usage estimation", () => {
  test("estimateTokens stays positive for short text", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("hi")).toBe(1);
    expect(estimateTokens("a".repeat(401))).toBe(100);
  });

  test("estimateChatInputTokens sums message text and tool calls", () => {
    const tokens = estimateChatInputTokens([
      { role: "system", content: "You are helpful" },
      { role: "user", content: "hello world" },
    ]);
    expect(tokens).toBeGreaterThan(0);
  });

  test("stream completion synthesizes usage when upstream omits it", () => {
    const state = createStreamState("m", undefined, [], false, 42);
    const frames = chatChunkToResponsesEvents(
      {
        choices: [{ delta: { content: "hello" }, finish_reason: null }],
      },
      state,
    );
    const done = forceCompleteStream(state);
    const all = parseData([...frames, ...done]);
    const completed = all.find((frame) => frame.type === "response.completed");
    expect(completed).toBeDefined();
    const response = completed?.response as Record<string, unknown>;
    const usage = response?.usage as Record<string, unknown>;
    expect(usage).toBeDefined();
    expect(usage.input_tokens).toBe(42);
    expect(Number(usage.output_tokens)).toBeGreaterThan(0);
    expect(Number(usage.total_tokens)).toBe(
      Number(usage.input_tokens) + Number(usage.output_tokens),
    );
  });

  test("real usage wins over the estimate when present", () => {
    const state = createStreamState("m", undefined, [], false, 42);
    const frames = chatChunkToResponsesEvents(
      {
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        choices: [{ delta: {}, finish_reason: "stop" }],
      },
      state,
    );
    const done = forceCompleteStream(state);
    const completed = parseData([...frames, ...done]).find(
      (frame) => frame.type === "response.completed",
    );
    const response = completed?.response as Record<string, unknown>;
    const usage = response?.usage as Record<string, unknown>;
    expect(usage.input_tokens).toBe(10);
    expect(usage.output_tokens).toBe(5);
  });

  test("non-stream completion synthesizes usage when omitted", () => {
    const response = chatCompletionToResponse(
      {
        model: "m",
        choices: [
          { message: { role: "assistant", content: "hi there" }, finish_reason: "stop" },
        ],
      },
      "m",
      [],
      false,
      33,
    );
    const usage = response.usage as Record<string, unknown>;
    expect(usage.input_tokens).toBe(33);
    expect(Number(usage.output_tokens)).toBeGreaterThan(0);
  });
});

describe("reasoning_effort shaping", () => {
  const body = {
    model: "m",
    input: "hi",
    reasoning: { effort: "high" },
  };

  test("kept when unknown or supported", () => {
    expect(responsesToChatRequest(body).reasoning_effort).toBe("high");
    expect(
      responsesToChatRequest(body, { supportsReasoning: true })
        .reasoning_effort,
    ).toBe("high");
  });

  test("stripped when the model cannot reason", () => {
    const chat = responsesToChatRequest(body, { supportsReasoning: false });
    expect(chat.reasoning_effort).toBeUndefined();
  });
});

function parseData(frames: string[]): Array<Record<string, unknown>> {
  return frames
    .join("")
    .split(/\n\n/)
    .map((frame) => frame.split("\n").find((line) => line.startsWith("data: ")))
    .filter((line): line is string => Boolean(line))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

describe("bridge request log buffer", () => {
  test("recent logs come back newest-first and cap at 200", () => {
    const original = recentBridgeLogs(200);
    expect(Array.isArray(original)).toBe(true);

    recordBridgeLog({
      ts: new Date().toISOString(),
      tool: "codex",
      method: "POST",
      path: "/v1/responses",
      model: "m",
      status: 200,
      durationMs: 12,
      stream: true,
    });
    const after = recentBridgeLogs(1);
    expect(after.length).toBeGreaterThanOrEqual(1);
    expect(after[0]?.tool).toBe("codex");
  });
});

// --- integration: keepalive-first headers, usage synthesis, /_control/logs --

let root: string;
let upstream: Server;
let upstreamHits: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "llms-bridge-enh-"));
  process.env.LLM_SWITCH_HOME = join(root, "home");
});

afterEach(() => {
  upstream?.close();
  rmSync(root, { recursive: true, force: true });
  delete process.env.LLM_SWITCH_HOME;
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return address.port;
}

/** Chat upstream that waits before replying and sends chunks without usage. */
function startSlowUpstream(delayMs: number): Promise<number> {
  upstreamHits = 0;
  upstream = createServer((req, res) => {
    upstreamHits += 1;
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      const parsed = JSON.parse(body) as { stream?: boolean };
      setTimeout(() => {
        if (parsed.stream) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write(
            `data: ${JSON.stringify({
              choices: [{ delta: { content: "hey" }, finish_reason: null }],
            })}\n\n`,
          );
          res.write("data: [DONE]\n\n");
          res.end();
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              choices: [
                { message: { role: "assistant", content: "hey" }, finish_reason: "stop" },
              ],
            }),
          );
        }
      }, delayMs);
    });
  });
  return new Promise((resolve) => {
    upstream.listen(0, "127.0.0.1", () => {
      const address = upstream.address();
      if (!address || typeof address === "string") throw new Error("no port");
      resolve(address.port);
    });
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition timed out");
}

describe("bridge integration: keepalive-first streaming + logs", () => {
  test("SSE headers arrive before a slow upstream responds", async () => {
    const upstreamPort = await startSlowUpstream(700);
    const port = await freePort();
    const running = runBridgeForeground("127.0.0.1", port, false);
    await waitFor(() => readBridgeState().instance !== null);

    const clientToken = generateBridgeToken();
    const upstreamConfig: BridgeUpstream = {
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      apiKey: "sk-test",
      mode: "chat",
      updatedAt: new Date().toISOString(),
      clientToken,
      profileName: "slow",
      modelSupportsReasoning: false,
    };
    writeBridgeUpstream("codex", upstreamConfig);

    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${clientToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "m",
        input: "hi",
        stream: true,
        reasoning: { effort: "high" },
      }),
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const text = await response.text();
    expect(upstreamHits).toBe(1);
    // Upstream omitted usage → completed frame must still carry usage.
    const completed = text.split("\n\n").find((frame) =>
      frame.includes("response.completed"),
    );
    expect(completed).toBeDefined();
    const dataLine = completed?.split("\n").find((line) => line.startsWith("data: "));
    const payload = JSON.parse(dataLine!.slice(6)) as {
      response: { usage: { input_tokens: number; output_tokens: number } };
    };
    expect(payload.response.usage.input_tokens).toBeGreaterThan(0);
    expect(payload.response.usage.output_tokens).toBeGreaterThan(0);

    const instance = readBridgeState().instance;
    const logsResponse = await fetch(
      `http://127.0.0.1:${port}/_control/logs?limit=10`,
      { headers: { "x-llm-switch-control": instance?.controlToken ?? "" } },
    );
    expect(logsResponse.ok).toBe(true);
    const logs = (await logsResponse.json()) as {
      entries: Array<{ tool: string; model: string; status: number }>;
    };
    expect(logs.entries.length).toBeGreaterThan(0);
    expect(logs.entries[0]?.tool).toBe("codex");
    expect(logs.entries[0]?.model).toBe("m");

    await stopBridge();
    await running;
  });
});
