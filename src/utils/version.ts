import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = resolve(__dirname, "../../package.json");

export function getVersion(): string {
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
  return pkg.version ?? "unknown";
}