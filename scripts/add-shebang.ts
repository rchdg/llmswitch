import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

const file = join(import.meta.dirname, "..", "dist", "index.js");
const content = readFileSync(file, "utf8");
const shebang = "#!/usr/bin/env node\n";
if (!content.startsWith("#!")) {
  writeFileSync(file, shebang + content);
}
chmodSync(file, 0o755);
