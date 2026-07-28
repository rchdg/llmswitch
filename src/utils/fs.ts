import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function atomicWriteFile(
  filePath: string,
  content: string,
  mode = 0o600,
): void {
  ensureDir(dirname(filePath));
  const tmp = join(
    dirname(filePath),
    `.${randomBytes(8).toString("hex")}.tmp`,
  );
  writeFileSync(tmp, content, { encoding: "utf8", mode });
  try {
    chmodSync(tmp, mode);
  } catch {
    // Windows may ignore mode; continue.
  }
  renameSync(tmp, filePath);
  try {
    chmodSync(filePath, mode);
  } catch {
    // ignore
  }
}

export function backupFile(
  sourcePath: string,
  backupDir: string,
  label: string,
): string | undefined {
  if (!existsSync(sourcePath)) return undefined;
  ensureDir(backupDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(backupDir, `${label}-${stamp}.bak`);
  copyFileSync(sourcePath, dest);
  return dest;
}

export function maskSecret(value: string | undefined | null): string {
  if (!value) return "(empty)";
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
