import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { connect, createServer as createNetServer, type Socket } from "node:net";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import {
  CrossOriginRedirectError,
  ResponseLimitError,
  TransportTimeoutError,
  createTransportAgent,
  requestWithNodeTransport,
  selectProxyUrl,
} from "../src/bridge/transport.ts";

const openServers = new Set<Server>();
const openSockets = new Set<Socket>();

async function listen(server: Server): Promise<number> {
  openServers.add(server);
  server.on("connection", (socket: Socket) => {
    openSockets.add(socket);
    socket.once("close", () => openSockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  openServers.delete(server);
  for (const socket of [...openSockets]) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

afterEach(async () => {
  await Promise.all([...openServers].map((server) => closeServer(server)));
});

function proxyEnvSnapshot(): Record<string, string | undefined> {
  return Object.fromEntries(
    [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
    ].map((key) => [key, process.env[key]]),
  );
}

async function createConnectProxy(): Promise<{
  server: Server;
  port: number;
  targets: string[];
}> {
  const targets: string[] = [];
  const server = createServer();
  server.on("connect", (req, client, head) => {
    const authority = req.url || "";
    targets.push(authority);
    const separator = authority.lastIndexOf(":");
    const host = authority.slice(0, separator).replace(/^\[|\]$/g, "");
    const port = Number(authority.slice(separator + 1));
    const upstream = connect(port, host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    upstream.on("error", () => client.destroy());
  });
  const port = await listen(server);
  return { server, port, targets };
}

type SocksRequest = { atyp: number; host: string };

async function createSocks5Proxy(): Promise<{
  server: Server;
  port: number;
  requests: SocksRequest[];
}> {
  const requests: SocksRequest[] = [];
  const server = createNetServer((client) => {
    let buffer = Buffer.alloc(0);
    let phase: "greeting" | "request" | "proxy" = "greeting";
    let upstream: Socket | null = null;

    client.on("data", (chunk) => {
      if (phase === "proxy") return;
      buffer = Buffer.concat([buffer, chunk]);

      if (phase === "greeting") {
        if (buffer.length < 2) return;
        const length = 2 + buffer[1]!;
        if (buffer.length < length) return;
        buffer = buffer.subarray(length);
        client.write(Buffer.from([0x05, 0x00]));
        phase = "request";
      }

      if (phase !== "request" || buffer.length < 4) return;
      const atyp = buffer[3]!;
      let offset = 4;
      let host = "";
      if (atyp === 0x01) {
        if (buffer.length < offset + 4 + 2) return;
        host = [...buffer.subarray(offset, offset + 4)].join(".");
        offset += 4;
      } else if (atyp === 0x04) {
        if (buffer.length < offset + 16 + 2) return;
        host = buffer.subarray(offset, offset + 16).toString("hex");
        offset += 16;
      } else if (atyp === 0x03) {
        const size = buffer[offset]!;
        offset += 1;
        if (buffer.length < offset + size + 2) return;
        host = buffer.subarray(offset, offset + size).toString("utf8");
        offset += size;
      } else {
        client.destroy(new Error(`unsupported atyp ${atyp}`));
        return;
      }
      const port = buffer.readUInt16BE(offset);
      offset += 2;
      const pending = buffer.subarray(offset);
      buffer = Buffer.alloc(0);
      requests.push({ atyp, host });
      phase = "proxy";
      // Test proxy always dials the loopback target regardless of the
      // requested host, so IPv6 vs IPv4 resolution can't break reachability.
      upstream = connect(port, "127.0.0.1", () => {
        client.write(
          Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]),
        );
        if (pending.length) upstream!.write(pending);
        client.pipe(upstream!).pipe(client);
      });
      upstream.on("error", () => client.destroy());
    });
  });
  const port = await listen(server);
  return { server, port, requests };
}

describe("transport proxy selection", () => {
  test("returns the single proxy url for any target, or null when unset", () => {
    const proxy = "socks5h://proxy.test:1080";
    expect(selectProxyUrl(new URL("http://target.test"), proxy)).toBe(proxy);
    expect(selectProxyUrl(new URL("https://target.test"), proxy)).toBe(proxy);
    expect(selectProxyUrl(new URL("https://target.test"), " ")).toBeNull();
    expect(selectProxyUrl(new URL("https://target.test"), undefined)).toBeNull();
  });

  test("constructs supported per-request HTTP(S) and SOCKS agents", () => {
    const httpsProxy = createTransportAgent(
      new URL("https://target.test"),
      "https://proxy.test:8443",
    );
    const socks = createTransportAgent(
      new URL("http://target.test"),
      "socks4a://proxy.test:1080",
    );
    expect(httpsProxy).toBeInstanceOf(HttpsProxyAgent);
    expect(socks).toBeInstanceOf(SocksProxyAgent);
    httpsProxy.destroy();
    socks.destroy();
  });

  test("rejects unsupported target and proxy schemes before I/O", async () => {
    await expect(
      requestWithNodeTransport({ url: "ftp://target.test/file" }),
    ).rejects.toThrow(/target protocol/i);
    await expect(
      requestWithNodeTransport({
        url: "http://target.test",
        proxy: "ftp://proxy.test",
      }),
    ).rejects.toThrow(/proxy protocol/i);
  });
});

describe("node transport behavior", () => {
  // agent-base proxy agents rely on real node:http socket handoff, which Bun's
  // node:http polyfill routes through fetch and ignores. These proxy paths are
  // exercised under Node (see scripts/verify-transport-proxies.mjs and CI).
  const nodeAgentIntegrationTest =
    typeof Bun === "undefined" ? test : test.skip;

  test("uses direct HTTP, filters hop-by-hop headers, and keeps env unchanged", async () => {
    let received: Record<string, string | string[] | undefined> = {};
    const target = createServer((req, res) => {
      received = req.headers;
      res.end("direct-ok");
    });
    const port = await listen(target);
    const envBefore = proxyEnvSnapshot();

    const response = await requestWithNodeTransport({
      url: `http://127.0.0.1:${port}/`,
      headers: {
        Authorization: "Bearer profile-secret",
        Connection: "x-remove-me",
        "Proxy-Authorization": "Basic remove-me",
        "X-Custom-Passthrough": "keep",
      },
    });

    expect(await response.text()).toBe("direct-ok");
    expect(received.authorization).toBe("Bearer profile-secret");
    expect(received["proxy-authorization"]).toBeUndefined();
    expect(received.connection).not.toBe("x-remove-me");
    expect(received["x-custom-passthrough"]).toBe("keep");
    expect(proxyEnvSnapshot()).toEqual(envBefore);
  });

  nodeAgentIntegrationTest("routes HTTP through an isolated CONNECT proxy", async () => {
    const target = createServer((_req, res) => res.end("proxied"));
    const targetPort = await listen(target);
    const proxy = await createConnectProxy();

    const response = await requestWithNodeTransport({
      url: `http://127.0.0.1:${targetPort}/models`,
      proxy: `http://127.0.0.1:${proxy.port}`,
    });

    expect(await response.text()).toBe("proxied");
    expect(proxy.targets).toEqual([`127.0.0.1:${targetPort}`]);
  });

  nodeAgentIntegrationTest("preserves socks5 local DNS vs socks5h proxy DNS", async () => {
    const target = createServer((_req, res) => res.end("socks-ok"));
    const targetPort = await listen(target);
    const proxy = await createSocks5Proxy();

    for (const scheme of ["socks5", "socks5h"] as const) {
      const response = await requestWithNodeTransport({
        url: `http://localhost:${targetPort}/`,
        proxy: `${scheme}://127.0.0.1:${proxy.port}`,
      });
      expect(await response.text()).toBe("socks-ok");
    }

    // socks5 resolves DNS locally, so the proxy receives an IP literal
    // (atyp 1 or 4); socks5h defers resolution and receives the hostname.
    expect([0x01, 0x04]).toContain(proxy.requests[0]?.atyp);
    expect(proxy.requests[1]).toEqual({ atyp: 0x03, host: "localhost" });
  });

  test("follows same-origin redirects and rejects cross-origin redirects", async () => {
    let crossOriginHits = 0;
    const other = createServer((_req, res) => {
      crossOriginHits += 1;
      res.end("should-not-arrive");
    });
    const otherPort = await listen(other);
    const target = createServer((req, res) => {
      if (req.url === "/same") {
        res.writeHead(302, { Location: "/ok" });
        res.end();
        return;
      }
      if (req.url === "/cross") {
        res.writeHead(302, {
          Location: `http://127.0.0.1:${otherPort}/secret`,
        });
        res.end();
        return;
      }
      res.end("redirect-ok");
    });
    const port = await listen(target);

    const same = await requestWithNodeTransport({
      url: `http://127.0.0.1:${port}/same`,
    });
    expect(await same.text()).toBe("redirect-ok");
    await expect(
      requestWithNodeTransport({
        url: `http://127.0.0.1:${port}/cross`,
        headers: { Authorization: "Bearer must-not-leak" },
      }),
    ).rejects.toBeInstanceOf(CrossOriginRedirectError);
    expect(crossOriginHits).toBe(0);
  });

  test("enforces buffered response limits", async () => {
    const target = createServer((_req, res) => res.end("x".repeat(128)));
    const port = await listen(target);
    const response = await requestWithNodeTransport({
      url: `http://127.0.0.1:${port}/`,
      maxResponseBytes: 16,
    });
    await expect(response.text()).rejects.toBeInstanceOf(ResponseLimitError);
  });

  test("enforces total and idle timeouts", async () => {
    const noHeaders = createServer(() => undefined);
    const noHeadersPort = await listen(noHeaders);
    await expect(
      requestWithNodeTransport({
        url: `http://127.0.0.1:${noHeadersPort}/`,
        connectTimeoutMs: 200,
        idleTimeoutMs: 200,
        totalTimeoutMs: 30,
      }),
    ).rejects.toBeInstanceOf(TransportTimeoutError);

    const idleBody = createServer((_req, res) => {
      res.writeHead(200);
      res.write("first");
    });
    const idlePort = await listen(idleBody);
    const response = await requestWithNodeTransport({
      url: `http://127.0.0.1:${idlePort}/`,
      connectTimeoutMs: 200,
      idleTimeoutMs: 30,
      totalTimeoutMs: 500,
    });
    await expect(response.text()).rejects.toBeInstanceOf(TransportTimeoutError);
  });

  test("propagates AbortSignal cancellation", async () => {
    const target = createServer(() => undefined);
    const port = await listen(target);
    const controller = new AbortController();
    const pending = requestWithNodeTransport({
      url: `http://127.0.0.1:${port}/`,
      signal: controller.signal,
      totalTimeoutMs: 1_000,
    });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
