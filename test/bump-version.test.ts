import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../scripts/bump-version.mjs");

function runBump(manifest: Record<string, unknown>): {
  status: number | null;
  stdout: string;
  version: string | undefined;
} {
  const dir = mkdtempSync(join(tmpdir(), "llms-bump-"));
  try {
    const file = join(dir, "package.json");
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    const result = spawnSync("node", [script, file], { encoding: "utf-8" });
    const written = JSON.parse(readFileSync(file, "utf-8"));
    return {
      status: result.status,
      stdout: result.stdout,
      version: written.version,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("bump-version", () => {
  test("increments the middle digit and resets the patch", () => {
    expect(runBump({ name: "x", version: "1.2.0" }).version).toBe("1.3.0");
    expect(runBump({ name: "x", version: "1.2.9" }).version).toBe("1.3.0");
    expect(runBump({ name: "x", version: "0.0.5" }).version).toBe("0.1.0");
  });

  test("preserves the rest of the manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "llms-bump-"));
    try {
      const file = join(dir, "package.json");
      writeFileSync(
        file,
        `${JSON.stringify({ name: "x", version: "2.9.4", private: true }, null, 2)}\n`,
      );
      spawnSync("node", [script, file], { encoding: "utf-8" });
      const written = JSON.parse(readFileSync(file, "utf-8"));
      expect(written).toEqual({ name: "x", version: "2.10.0", private: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails on a non-semver version", () => {
    const result = runBump({ name: "x", version: "banana" });
    expect(result.status).not.toBe(0);
  });
});
