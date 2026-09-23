import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const target = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : resolve(here, "../package.json");

const pkg = JSON.parse(readFileSync(target, "utf-8"));
const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(pkg.version ?? ""));
if (!match) {
  throw new Error(`cannot bump non-semver version: ${pkg.version}`);
}

const current = `${match[1]}.${match[2]}.${match[3]}`;
const next = `${match[1]}.${Number(match[2]) + 1}.0`;
pkg.version = next;
writeFileSync(target, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`version bumped: ${current} -> ${next}`);
