// Node-only verification for NET-1 proxy transport paths.
// agent-base proxy agents need real node:http socket handoff, which Bun's
// node:http polyfill does not provide. Run with: node scripts/verify-transport-proxies.mjs
// Requires a prior `bun run build` so dist/bridge/transport.js exists.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect, createServer as createNetServer } from "node:net";
import { requestWithNodeTransport } from "../dist/bridge/transport.js";

const servers = new Set();

function listen(server) {
  servers.add(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(address.port);
    });
  });
}

async function closeAll() {
  await Promise.all(
    [...servers].map(
      (server) => new Promise((resolve) => server.close(() => resolve())),
    ),
  );
  servers.clear();
}

async function createConnectProxy() {
  const targets = [];
  const server = createServer();
  server.on("connect", (req, client, head) => {
    targets.push(req.url || "");
    const authority = req.url || "";
    const sep = authority.lastIndexOf(":");
    const host = authority.slice(0, sep).replace(/^\[|\]$/g, "");
    const port = Number(authority.slice(sep + 1));
    const upstream = connect(port, host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    upstream.on("error", () => client.destroy());
  });
  const port = await listen(server);
  return { port, targets };
}

async function createSocks5Proxy() {
  const requests = [];
  const server = createNetServer((client) => {
    let buffer = Buffer.alloc(0);
    let phase = "greeting";
    let upstream = null;
    client.on("data", (chunk) => {
      if (phase === "proxy") return;
      buffer = Buffer.concat([buffer, chunk]);
      if (phase === "greeting") {
        if (buffer.length < 2) return;
        const length = 2 + buffer[1];
        if (buffer.length < length) return;
        buffer = buffer.subarray(length);
        client.write(Buffer.from([0x05, 0x00]));
        phase = "request";
      }
      if (phase !== "request" || buffer.length < 4) return;
      const atyp = buffer[3];
      let offset = 4;
      let host = "";
      if (atyp === 0x01) {
        if (buffer.length < offset + 6) return;
        host = [...buffer.subarray(offset, offset + 4)].join(".");
        offset += 4;
      } else if (atyp === 0x04) {
        if (buffer.length < offset + 18) return;
        host = buffer.subarray(offset, offset + 16).toString("hex");
        offset += 16;
      } else if (atyp === 0x03) {
        const size = buffer[offset];
        offset += 1;
        if (buffer.length < offset + size + 2) return;
        host = buffer.subarray(offset, offset + size).toString("utf8");
        offset += size;
      } else {
        client.destroy();
        return;
      }
      const port = buffer.readUInt16BE(offset);
      offset += 2;
      const pending = buffer.subarray(offset);
      buffer = Buffer.alloc(0);
      requests.push({ atyp, host });
      phase = "proxy";
      upstream = connect(port, "127.0.0.1", () => {
        client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
        if (pending.length) upstream.write(pending);
        client.pipe(upstream).pipe(client);
      });
      upstream.on("error", () => client.destroy());
    });
  });
  const port = await listen(server);
  return { port, requests };
}

async function main() {
  const target = createServer((_req, res) => res.end("proxied"));
  const targetPort = await listen(target);
  const proxy = await createConnectProxy();
  const connectResponse = await requestWithNodeTransport({
    url: `http://127.0.0.1:${targetPort}/models`,
    proxy: `http://127.0.0.1:${proxy.port}`,
  });
  assert.equal(await connectResponse.text(), "proxied");
  assert.deepEqual(proxy.targets, [`127.0.0.1:${targetPort}`]);

  const socksTarget = createServer((_req, res) => res.end("socks-ok"));
  const socksTargetPort = await listen(socksTarget);
  const socks = await createSocks5Proxy();
  for (const scheme of ["socks5", "socks5h"]) {
    const response = await requestWithNodeTransport({
      url: `http://localhost:${socksTargetPort}/`,
      proxy: `${scheme}://127.0.0.1:${socks.port}`,
    });
    assert.equal(await response.text(), "socks-ok");
  }
  assert.ok(
    socks.requests[0].atyp === 0x01 || socks.requests[0].atyp === 0x04,
    "socks5 resolves DNS locally (IP literal)",
  );
  assert.deepEqual(
    socks.requests[1],
    { atyp: 0x03, host: "localhost" },
    "socks5h defers DNS to the proxy",
  );

  await closeAll();
  console.log("transport proxy verification passed (CONNECT + SOCKS5/5h)");
}

main().catch(async (err) => {
  await closeAll();
  console.error(err);
  process.exit(1);
});
