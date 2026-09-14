import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
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
  const dir = dirname(filePath);
  // 同目录写临时文件再 rename，保证替换是原子的。前缀固定，便于清理历史残留。
  const tmp = join(dir, `${TMP_PREFIX}${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, content, { encoding: "utf8", mode });
    try {
      chmodSync(tmp, mode);
    } catch {
      // Windows may ignore mode; continue.
    }
    renameSync(tmp, filePath);
  } catch (err) {
    // 失败时不要把临时文件留在用户目录里——它可能含明文密钥。
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
  try {
    chmodSync(filePath, mode);
  } catch {
    // ignore
  }
  pruneStaleTempFiles(dir);
}

const TMP_PREFIX = ".llmswitch-";
const TMP_STALE_MS = 60 * 60 * 1000;

export interface PendingWrite {
  path: string;
  content: string;
  mode?: number;
}

/**
 * Write several files as one unit.
 *
 * Adapters often have to update two files together (Codex: config.toml + .env;
 * OpenCode: opencode.json + auth.json). Writing them one by one means a failure
 * on the second leaves the tool pointing at a provider whose credentials were
 * never written. On failure we restore every file already written back to its
 * previous content, or delete it if it did not exist before.
 *
 * Callers must build all contents *before* calling this, so that a build-time
 * throw also leaves nothing half-applied.
 */
export function writeFilesAtomically(writes: PendingWrite[]): void {
  const done: Array<{ path: string; previous: string | null }> = [];
  try {
    for (const write of writes) {
      const previous = existsSync(write.path)
        ? readFileSync(write.path, "utf8")
        : null;
      atomicWriteFile(write.path, write.content, write.mode);
      done.push({ path: write.path, previous });
    }
  } catch (err) {
    for (const entry of done.reverse()) {
      try {
        if (entry.previous === null) unlinkSync(entry.path);
        else atomicWriteFile(entry.path, entry.previous);
      } catch {
        // 回滚只能尽力而为；原始错误更重要，继续抛出。
      }
    }
    throw err;
  }
}

/**
 * Sweep temp files left behind by a process that died between write and rename.
 * They can contain plaintext API keys, so they must not accumulate in
 * ~/.claude, ~/.codex or ~/.config/opencode.
 */
function pruneStaleTempFiles(dir: string): void {
  try {
    const now = Date.now();
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(TMP_PREFIX) || !name.endsWith(".tmp")) continue;
      const full = join(dir, name);
      if (now - statSync(full).mtimeMs < TMP_STALE_MS) continue;
      unlinkSync(full);
    }
  } catch {
    // Best effort only; never fail a write because cleanup failed.
  }
}

/** Keep at most this many backups per label, newest first. */
const MAX_BACKUPS_PER_LABEL = 10;

export function backupFile(
  sourcePath: string,
  backupDir: string,
  label: string,
): string | undefined {
  if (!existsSync(sourcePath)) return undefined;
  ensureDir(backupDir);
  const dest = uniqueBackupPath(backupDir, label);
  copyFileSync(sourcePath, dest);
  try {
    chmodSync(dest, 0o600);
  } catch {
    // ignore
  }
  // 备份里含明文 API Key，且每次 apply/deactivate 都会产生一份。
  // 不设上限的话既会无限占盘，也会让历史密钥永久堆积。
  pruneBackups(backupDir, label);
  return dest;
}

/**
 * ISO timestamps only have millisecond resolution, and two backups of the same
 * label can easily land in the same millisecond (apply writes config + env
 * back to back). Without a tiebreaker the second copy silently overwrites the
 * first. The suffix is zero-padded so lexicographic order stays time order.
 */
function uniqueBackupPath(backupDir: string, label: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = join(backupDir, `${label}-${stamp}`);
  if (!existsSync(`${base}.bak`)) return `${base}.bak`;
  for (let i = 1; i < 1000; i++) {
    const candidate = `${base}-${String(i).padStart(3, "0")}.bak`;
    if (!existsSync(candidate)) return candidate;
  }
  return `${base}-${randomBytes(4).toString("hex")}.bak`;
}

function pruneBackups(backupDir: string, label: string): void {
  try {
    const prefix = `${label}-`;
    const files = readdirSync(backupDir)
      .filter((name) => name.startsWith(prefix) && name.endsWith(".bak"))
      // 文件名里的时间戳是 ISO 且定长，字典序即时间序。
      .sort()
      .reverse();
    for (const name of files.slice(MAX_BACKUPS_PER_LABEL)) {
      unlinkSync(join(backupDir, name));
    }
  } catch {
    // Best effort only.
  }
}

export function maskSecret(value: string | undefined | null): string {
  if (!value) return "(empty)";
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/**
 * Read + parse a config file we do not own, turning parser failures into an
 * actionable Chinese error instead of a raw SyntaxError. A single stray comma in
 * the user's own ~/.claude/settings.json must not take the whole CLI down with
 * an unreadable stack trace.
 */
export function readStructuredFile<T>(
  path: string,
  parser: (text: string) => T,
  opts: { label: string; fallback: () => T },
): T {
  if (!existsSync(path)) return opts.fallback();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`无法读取${opts.label}「${path}」：${msg}`);
  }
  // 空文件（或只有空白）按“尚未配置”处理，而不是解析失败。
  if (!text.trim()) return opts.fallback();
  try {
    return parser(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${opts.label}「${path}」解析失败：${msg}。` +
        `请修复该文件的语法，或将其移走后重试（本工具会在写入前自动备份）。`,
    );
  }
}

/** True only for a real `{...}` object (not null, not an array). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}

/**
 * Spread-safe accessor for a nested table inside someone else's config file.
 * If the key holds a non-object (array/string/number), we must not spread it —
 * that silently produces a garbage structure like {"0":"a","1":"b"}.
 */
export function plainObjectAt(
  container: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = container[key];
  return isPlainObject(value) ? value : {};
}

/**
 * Read a string map (e.g. an `env` block), dropping non-string values instead of
 * carrying them into a Record<string, string> that the type system trusts.
 */
export function stringRecordAt(
  container: Record<string, unknown>,
  key: string,
): Record<string, string> {
  const source = plainObjectAt(container, key);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
  }
  return out;
}
