import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { detectApiFormat } from "../src/utils/detect-format.ts";

type Req = {
  url: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
};

type Res = {
  status: number;
  json: unknown;
  headers: Record<string, string>;
};

type Handler = (req: Req, res: Res) => void;

let server: Server;
let base: string;
let handler: Handler;

beforeEach(async () => {
  handler = () => {};
  server = createServer((req, res) => {
    const out: Res = {
      status: 404,
      json: { error: "not found" },
      headers: { "content-type": "application/json" },
    };
    handler(
      {
        url: req.url || "",
        method: req.method || "GET",
        headers: req.headers as Record<string, string | string[] | undefined>,
      },
      out,
    );
    res.writeHead(out.status, out.headers);
    res.end(JSON.stringify(out.json));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function json(res: Res, status: number, payload: unknown): void {
  res.status = status;
  res.json = payload;
}

const MODELS_OK = { data: [{ id: "model-a" }, { id: "model-b" }] };

describe("detectApiFormat", () => {
  test("openai /v1/models → chat (responses route missing)", async () => {
    handler = (req, res) => {
      if (req.url === "/v1/models") json(res, 200, MODELS_OK);
    };
    const result = await detectApiFormat("codex", {
      baseUrl: base,
      apiKey: "sk-test",
    });
    expect(result.detected).toBe(true);
    expect(result.apiFormat).toBe("openai-chat");
    expect(result.bridgeMode).toBe("chat");
    expect(result.resolvedBaseUrl).toBe(`${base}/v1`);
  });

  test("openai /models without /v1 prefix → resolved base stays root", async () => {
    handler = (req, res) => {
      if (req.url === "/models") json(res, 200, MODELS_OK);
    };
    const result = await detectApiFormat("opencode", {
      baseUrl: base,
      apiKey: "sk-test",
    });
    expect(result.detected).toBe(true);
    expect(result.resolvedBaseUrl).toBe(base);
  });

  test("openai + responses route → openai-responses", async () => {
    handler = (req, res) => {
      if (req.url === "/v1/models") json(res, 200, MODELS_OK);
      if (req.url === "/v1/responses") {
        json(res, 400, { error: { type: "invalid_request_error" } });
      }
    };
    const result = await detectApiFormat("codex", {
      baseUrl: base,
      apiKey: "sk-test",
    });
    expect(result.detected).toBe(true);
    expect(result.apiFormat).toBe("openai-responses");
  });

  test("anthropic models (x-api-key) → anthropic for claude", async () => {
    handler = (req, res) => {
      if (req.url === "/v1/models" && req.headers["x-api-key"]) {
        json(res, 200, { data: [{ type: "model", id: "claude-x" }] });
      }
    };
    const result = await detectApiFormat("claude", {
      baseUrl: `${base}/v1`,
      apiKey: "sk-ant-test",
    });
    expect(result.detected).toBe(true);
    expect(result.apiFormat).toBe("anthropic");
    expect(result.resolvedBaseUrl).toBe(`${base}/v1`);
  });

  test("anthropic-compatible preferred over openai for claude", async () => {
    handler = (req, res) => {
      if (req.url === "/v1/models" && req.headers["x-api-key"]) {
        json(res, 200, { data: [{ type: "model", id: "claude-x" }] });
      } else if (req.url === "/v1/models") {
        json(res, 200, MODELS_OK);
      }
    };
    const result = await detectApiFormat("claude", {
      baseUrl: base,
      apiKey: "sk-test",
    });
    expect(result.apiFormat).toBe("anthropic");
  });

  test("codex never picks anthropic", async () => {
    handler = (req, res) => {
      if (req.url === "/v1/models" && req.headers["x-api-key"]) {
        json(res, 200, { data: [{ type: "model", id: "claude-x" }] });
      }
    };
    const result = await detectApiFormat("codex", {
      baseUrl: base,
      apiKey: "sk-ant-test",
    });
    expect(result.detected).toBe(false);
  });

  test("no /models but chat route exists → openai-chat", async () => {
    handler = (req, res) => {
      if (req.url === "/v1/chat/completions") {
        json(res, 400, { error: { message: "model is required" } });
      }
    };
    const result = await detectApiFormat("opencode", {
      baseUrl: base,
      apiKey: "sk-test",
    });
    expect(result.detected).toBe(true);
    expect(result.apiFormat).toBe("openai-chat");
  });

  test("everything 404 → not detected", async () => {
    const result = await detectApiFormat("opencode", {
      baseUrl: base,
      apiKey: "sk-test",
    });
    expect(result.detected).toBe(false);
  });

  test("empty api key + openai /models → chat (keyless local server)", async () => {
    handler = (req, res) => {
      if (req.url === "/v1/models") json(res, 200, MODELS_OK);
    };
    const result = await detectApiFormat("codex", {
      baseUrl: base,
      apiKey: "",
    });
    expect(result.detected).toBe(true);
    expect(result.apiFormat).toBe("openai-chat");
    expect(result.resolvedBaseUrl).toBe(`${base}/v1`);
  });

  test("ollama /api/tags without key → openai-chat via /v1", async () => {
    handler = (req, res) => {
      if (req.url === "/api/tags") {
        json(res, 200, { models: [{ name: "llama3.2:3b" }, { name: "qwen2.5:7b" }] });
      }
    };
    const result = await detectApiFormat("claude", {
      baseUrl: base,
      apiKey: "",
    });
    expect(result.detected).toBe(true);
    expect(result.apiFormat).toBe("openai-chat");
    expect(result.source).toBe("ollama-tags");
    expect(result.resolvedBaseUrl).toBe(`${base}/v1`);
  });

  test("ollama detected before chat route probing (no false route hits)", async () => {
    handler = (req, res) => {
      if (req.url === "/api/tags") {
        json(res, 200, { models: [{ name: "llama3.2:3b" }] });
      }
      if (req.url === "/v1/chat/completions") {
        json(res, 400, { error: { message: "model is required" } });
      }
    };
    const result = await detectApiFormat("opencode", {
      baseUrl: base,
      apiKey: "sk-test",
    });
    expect(result.detected).toBe(true);
    expect(result.source).toBe("ollama-tags");
  });

  test("without key, anthropic probe is skipped (no x-api-key misuse)", async () => {
    handler = (req, res) => {
      if (req.url === "/v1/models" && req.headers["x-api-key"]) {
        json(res, 200, { data: [{ type: "model", id: "claude-x" }] });
      }
    };
    const result = await detectApiFormat("claude", {
      baseUrl: base,
      apiKey: "",
    });
    expect(result.detected).toBe(false);
  });

  test("non-JSON responses treated as missing route", async () => {
    handler = (req, res) => {
      if (req.url === "/v1/models") json(res, 200, MODELS_OK);
      if (req.url === "/v1/responses") {
        res.status = 200;
        res.json = null;
        res.headers = { "content-type": "text/html" };
      }
    };
    const result = await detectApiFormat("codex", {
      baseUrl: base,
      apiKey: "sk-test",
    });
    expect(result.detected).toBe(true);
    expect(result.apiFormat).toBe("openai-chat");
  });
});
