/**
 * Per-day usage accounting for the gateway data plane.
 *
 * One JSON file with daily buckets; each row aggregates requests and token
 * counts for a (key, provider, model) triple. Writes are read-modify-write via
 * the same atomic-replace pattern as the rest of the store — the daemon is the
 * single writer in practice, so no lock is taken and a crashed process can lose
 * at most the in-flight update.
 */

import { existsSync, readFileSync } from "node:fs";
import { atomicWriteFile, ensureDir } from "../utils/fs.js";
import { getGatewayDir, getGatewayUsagePath } from "../utils/paths.js";

const RETENTION_DAYS = 90;

export interface UsageRecordInput {
  /** Gateway key id that served the request. */
  keyId: string;
  provider: string;
  /** Model id exactly as the client requested it (alias kept for grouping). */
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

interface UsageRow {
  key: string;
  provider: string;
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

interface UsageFile {
  version: 1;
  days: Record<string, { rows: UsageRow[] }>;
}

export interface UsageSummaryRow {
  day: string;
  key: string;
  provider: string;
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

function emptyFile(): UsageFile {
  return { version: 1, days: {} };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

export function getUsagePath(): string {
  return getGatewayUsagePath();
}

function dayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function readUsage(): UsageFile {
  const path = getUsagePath();
  if (!existsSync(path)) return emptyFile();
  try {
    const raw = asRecord(JSON.parse(readFileSync(path, "utf8")));
    if (!raw) return emptyFile();
    const rawDays = asRecord(raw.days);
    const out: UsageFile = { version: 1, days: {} };
    if (!rawDays) return out;
    for (const [day, value] of Object.entries(rawDays)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const bucket = asRecord(value);
      const rows = Array.isArray(bucket?.rows) ? bucket!.rows : [];
      const clean: UsageRow[] = [];
      for (const item of rows) {
        const row = asRecord(item);
        if (!row) continue;
        const key = String(row.key || "");
        const provider = String(row.provider || "");
        if (!key || !provider) continue;
        clean.push({
          key,
          provider,
          model: String(row.model || ""),
          requests: nonNegativeNumber(row.requests),
          inputTokens: nonNegativeNumber(row.inputTokens),
          outputTokens: nonNegativeNumber(row.outputTokens),
        });
      }
      out.days[day] = { rows: clean };
    }
    return out;
  } catch {
    return emptyFile();
  }
}

function writeUsage(file: UsageFile, now = Date.now()): void {
  const cutoff = new Date(now - RETENTION_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const days: UsageFile["days"] = {};
  for (const [day, bucket] of Object.entries(file.days)) {
    if (day >= cutoff && bucket.rows.length) days[day] = bucket;
  }
  ensureDir(getGatewayDir());
  atomicWriteFile(
    getUsagePath(),
    JSON.stringify({ version: 1, days }, null, 2) + "\n",
  );
}

function mergeRow(
  rows: UsageRow[],
  record: UsageRecordInput,
): void {
  const key = record.keyId;
  const provider = record.provider;
  const model = record.model || "";
  const existing = rows.find(
    (row) =>
      row.key === key && row.provider === provider && row.model === model,
  );
  if (existing) {
    existing.requests += 1;
    existing.inputTokens += record.inputTokens ?? 0;
    existing.outputTokens += record.outputTokens ?? 0;
    return;
  }
  rows.push({
    key,
    provider,
    model,
    requests: 1,
    inputTokens: record.inputTokens ?? 0,
    outputTokens: record.outputTokens ?? 0,
  });
}

/** Best-effort: accounting failures must never break a live request. */
export function recordUsage(record: UsageRecordInput, now = Date.now()): void {
  try {
    const file = readUsage();
    const day = dayKey(now);
    const bucket = file.days[day] ?? { rows: [] };
    mergeRow(bucket.rows, record);
    file.days[day] = bucket;
    writeUsage(file, now);
  } catch {
    // Non-fatal.
  }
}

/** Aggregated rows for the last `days` days (inclusive of today). */
export function summarizeUsage(
  options: { days?: number } = {},
  now = Date.now(),
): UsageSummaryRow[] {
  const days = Math.max(1, Math.min(options.days ?? 7, RETENTION_DAYS));
  const cutoff = new Date(now - (days - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const file = readUsage();
  const out: UsageSummaryRow[] = [];
  for (const [day, bucket] of Object.entries(file.days)) {
    if (day < cutoff) continue;
    for (const row of bucket.rows) {
      out.push({ day, ...row });
    }
  }
  return out.sort(
    (a, b) =>
      b.day.localeCompare(a.day) ||
      b.requests - a.requests ||
      a.provider.localeCompare(b.provider) ||
      a.model.localeCompare(b.model) ||
      a.key.localeCompare(b.key),
  );
}

/** Drop every recorded usage (test seam and `llms gateway usage reset`). */
export function resetUsage(): void {
  try {
    atomicWriteFile(getUsagePath(), `${JSON.stringify(emptyFile(), null, 2)}\n`);
  } catch {
    // Nothing persisted yet.
  }
}
