import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBridgeForeground, resolveFallbackUpstreams, stopBridge } from "../src/bridge/manager.ts";
import {
  generateBridgeToken,
  readBridgeState,
  writeBridgeUpstream,
} from "../src/bridge/state.ts";
import { normalizeFallbackNames, readProfile, saveProfile } from "../src/store/profiles.ts";
import type { BridgeUpstream } from "../src/bridge/types.ts";
import type { Profile } from "../src/types.ts";

let root: string;
const servers: Server[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "llms-bridge-failover-"));
  process.env.LLM_SWITCH_HOME = join(root, "home");
});

afterEach(async () => {
  for (const server of servers) server.close();
  servers.length = 0;
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

interface MockUpstream {
  port: number;
  requests: Array<{ model: string; stream: boolean }>;
  /** Response behaviour per request. */
  status?: number;
  ok?: boolean;
}

/** Chat upstream mock: replies SSE or JSON, records what it received. */
function startMock(options: { status?: number; ok?: boolean } = {}): Promise<MockUpstream> {
  const mock: MockUpstream = { port: 0, requests: [], ...options };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      const parsed = JSON.parse(body) as { model?: string; stream?: boolean };
      mock.requests.push({ model: parsed.model ?? "", stream: Boolean(parsed.stream) });
      if (options.status && options.status !== 200) {
        res.writeHead(options.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: `mock ${options.status}` } }));
        return;
      }
      if (parsed.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { content: "from-mock" }, finish_reason: null }],
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: parsed.model,
          choices: [
            { message: { role: "assistant", content: "from-mock" }, finish_reason: "stop" },
          ],
        }),
      );
    });
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      mock.port = address.port;
      resolve(mock);
    });
  });
}

function candidateFrom(mock: MockUpstream, profileName: string, model: string): BridgeUpstream {
  return {
    baseUrl: `http://127.0.0.1:${mock.port}/v1`,
    apiKey: "sk-test",
    mode: "chat",
    updatedAt: new Date().toISOString(),
    clientToken: null,
    profileName,
    model,
  };
}

async function startBridgeWith(
  primary: BridgeUpstream,
): Promise<{ port: number; token: string }> {
  const port = await freePort();
  // Bridge lifecycle ends with stopBridge() in each test.
  void runBridgeForeground("127.0.0.1", port, false).catch(() => {});
  await waitFor(() => readBridgeState().instance !== null);
  writeBridgeUpstream("codex", primary);
  return { port, token: primary.clientToken ?? "" };
}

function post(
  port: number,
  token: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function recentLogs(port: number): Promise<Array<Record<string, unknown>>> {
  const instance = readBridgeState().instance;
  const response = await fetch(
    `http://127.0.0.1:${port}/_control/logs?limit=5`,
    { headers: { "x-llm-switch-control": instance?.controlToken ?? "" } },
  );
  const payload = (await response.json()) as { entries: Array<Record<string, unknown>> };
  return payload.entries;
}

describe("fallback chain resolution", () => {
  function profileOf(
    name: string,
    overrides: Partial<Profile> = {},
  ): Profile {
    return {
      name,
      displayName: name,
      apiFormat: "openai-chat",
      baseUrl: `https://api.example.com/${name}`,
      apiKey: `sk-${name}`,
      models: { default: `${name}-model`, list: [`${name}-model`] },
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  test("normalizeFallbackNames drops self, duplicates and caps at 3", () => {
    expect(normalizeFallbackNames("a", ["a", "b", "b", "c", "d", "e"])).toEqual([
      "b",
      "c",
      "d",
    ]);
    expect(normalizeFallbackNames("a", ["a"])).toBeUndefined();
    expect(normalizeFallbackNames("a", "b")).toBeUndefined();
  });

  test("resolveFallbackUpstreams resolves profiles and skips missing ones", () => {
    saveProfile("codex", profileOf("main", { fallbacks: ["b1", "ghost"] }));
    saveProfile("codex", profileOf("b1"));

    const main = profileOf("main", { fallbacks: ["b1", "ghost"] });
    const upstreams = resolveFallbackUpstreams(main, "codex");
    expect(upstreams).toBeDefined();
    expect(upstreams!.length).toBe(1);
    expect(upstreams![0]!.profileName).toBe("b1");
    expect(upstreams![0]!.model).toBe("b1-model");
    expect(upstreams![0]!.clientToken).toBeNull();
    // Nested chains are not supported: fallback-of-fallback is ignored.
    expect(upstreams![0]!.fallbacks).toBeUndefined();
  });

  test("resolveFallbackUpstreams returns undefined without valid names", () => {
    const main = profileOf("main", { fallbacks: ["main"] });
    expect(resolveFallbackUpstreams(main, "codex")).toBeUndefined();
  });

  test("profile round-trip keeps the fallback chain", () => {
    saveProfile("codex", profileOf("a", { fallbacks: ["b"] }));
    expect(readProfile("codex", "a")?.fallbacks).toEqual(["b"]);

    saveProfile("codex", profileOf("a", { fallbacks: ["a", "b", "c", "d", "e"] }));
    expect(readProfile("codex", "a")?.fallbacks).toEqual(["b", "c", "d"]);
  });
});

describe("bridge failover", () => {
  test("streams from the fallback when primary answers 500", async () => {
    const primaryMock = await startMock({ status: 500 });
    const backupMock = await startMock();
    const token = generateBridgeToken();
    const { port } = await startBridgeWith({
      ...candidateFrom(primaryMock, "primary", "primary-model"),
      clientToken: token,
      fallbacks: [candidateFrom(backupMock, "backup", "backup-model")],
    });

    const response = await post(port, token, { model: "primary-model", input: "hi", stream: true });
    expect(response.status).toBe(200);
    const text = await response.text();
    // Failover hint comment + content from the fallback.
    expect(text).toContain(": llm-switch failover: primary → backup");
    expect(text).toContain("from-mock");
    const completed = text.split("\n\n").find((frame) => frame.includes("response.completed"));
    expect(completed).toBeDefined();

    // Fallback received the rewritten model id.
    expect(backupMock.requests).toEqual([{ model: "backup-model", stream: true }]);
    expect(primaryMock.requests.length).toBe(1);

    const logs = await recentLogs(port);
    expect(logs[0]?.upstream).toBe("backup");
    expect(logs[0]?.error).toBe("HTTP 500: {\"error\":{\"message\":\"mock 500\"}}");

    await stopBridge();
  });

  test("failover on connection refused (dead primary)", async () => {
    const deadPort = await freePort();
    const backupMock = await startMock();
    const token = generateBridgeToken();
    const { port } = await startBridgeWith({
      baseUrl: `http://127.0.0.1:${deadPort}/v1`,
      apiKey: "sk-test",
      mode: "chat",
      updatedAt: new Date().toISOString(),
      clientToken: token,
      profileName: "dead",
      model: "dead-model",
      fallbacks: [candidateFrom(backupMock, "backup", "backup-model")],
    });

    const response = await post(port, token, { model: "dead-model", input: "hi" });
    expect(response.status).toBe(200);
    const json = (await response.json()) as { output: unknown };
    expect(json.output).toBeDefined();
    expect(backupMock.requests.length).toBe(1);
    await stopBridge();
  });

  test("400 is not retryable: failover skipped", async () => {
    const primaryMock = await startMock({ status: 400 });
    const backupMock = await startMock();
    const token = generateBridgeToken();
    const { port } = await startBridgeWith({
      ...candidateFrom(primaryMock, "primary", "primary-model"),
      clientToken: token,
      fallbacks: [candidateFrom(backupMock, "backup", "backup-model")],
    });

    const response = await post(port, token, { model: "primary-model", input: "hi" });
    expect(response.status).toBe(400);
    expect(primaryMock.requests.length).toBe(1);
    expect(backupMock.requests.length).toBe(0);
    await stopBridge();
  });

  test("all candidates failing yields an aggregated error", async () => {
    const first = await startMock({ status: 500 });
    const second = await startMock({ status: 429 });
    const token = generateBridgeToken();
    const { port } = await startBridgeWith({
      ...candidateFrom(first, "a", "model-a"),
      clientToken: token,
      fallbacks: [candidateFrom(second, "b", "model-b")],
    });

    const response = await post(port, token, { model: "model-a", input: "hi" });
    // Non-streaming: last candidate's status passes through with an aggregate message.
    expect([429, 502]).toContain(response.status);
    const text = await response.text();
    expect(text).toContain("a");
    expect(second.requests.length).toBe(1);
    await stopBridge();
  });
});
