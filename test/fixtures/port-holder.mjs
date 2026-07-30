import { writeFileSync } from "node:fs";
import { createServer } from "node:http";

const port = Number(process.argv[2]);
const marker = process.argv[3];

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    writeFileSync(marker, `${signal}\n`, "utf8");
  });
}

const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, service: "external-holder" }));
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write("READY\n");
});
