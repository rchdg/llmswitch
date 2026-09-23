import { createHash } from "node:crypto";

/**
 * OpenCode Go 已把 `x-opencode-session` 从可选升级为必填：缺失时上游直接返回
 * 400 MissingSessionID，请求在到达模型前就被拒绝。该头用于把同一会话的多轮请求
 * 路由到同一后端节点，从而复用 prompt cache。
 */
export const OPENCODE_SESSION_HEADER = "x-opencode-session";

/** 客户端可能用来标识会话的请求头，按优先级排列。 */
const CLIENT_SESSION_HEADERS = [
  OPENCODE_SESSION_HEADER,
  // Codex CLI 会用 session_id / x-client-request-id 标识 thread。
  "session_id",
  "x-session-id",
  "x-client-request-id",
  // 其余代理常见的会话头。
  "conversation_id",
] as const;

/** OpenCode 自身使用的取值形态：`ses_` + 32 位小写十六进制。 */
const OPENCODE_SESSION_VALUE_RE = /^ses_[0-9a-f]{32}$/;

/** 允许原样转发的取值字符集，避免把我们无法校验的内容塞进请求头。 */
const FORWARDABLE_SESSION_VALUE_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** 单条消息参与指纹计算的最大字符数。 */
const FINGERPRINT_CHARS = 2_000;

/** 参与指纹计算的消息条数：会话每轮在尾部追加，前几条始终不变。 */
const FINGERPRINT_MESSAGES = 3;

/**
 * 伪造会话标识的轮换周期。上游会把会话与后端节点绑定，长时间复用一个伪造
 * 会话既不利于负载分散，也更容易被识别；按小时分桶后，同一个小时内同一会话
 * 仍复用同一个标识（保住 prompt cache），跨过整点则自动换新。
 *
 * 客户端自己发来的会话头不受影响，始终原样透传。
 */
export const SESSION_ROTATION_MS = 60 * 60 * 1_000;

export type HeaderBag = Record<string, string | string[] | undefined>;

function isOpenCodeHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "opencode.ai" || host.endsWith(".opencode.ai");
}

/**
 * base URL 是否指向 OpenCode 的 API（Zen / Go）。只有这类上游需要会话头，
 * 其余供应商不受影响，也不会收到这个私有请求头。
 */
export function requiresOpenCodeSession(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    return isOpenCodeHost(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

function hashSessionValue(value: string): string {
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `ses_${digest}`;
}

/** 把时间戳收敛成整点分桶，同一小时内的所有请求落在同一个桶里。 */
export function sessionRotationBucket(now: number = Date.now()): number {
  return Math.floor(now / SESSION_ROTATION_MS);
}

/**
 * 从任意种子推导会话标识。请求体指纹包含任意 JSON，直接用哈希收敛成定长、
 * 安全的取值。
 *
 * 种子会并入当前小时分桶，因此同一个会话的伪造标识每小时更换一次：
 * 整点之前的请求共用一个标识（保留 prompt cache），跨过整点后自然得到新标识。
 */
export function deriveSessionId(seed: string, now: number = Date.now()): string {
  const trimmed = seed.trim();
  if (!trimmed) return "";
  return hashSessionValue(`${trimmed}#${sessionRotationBucket(now)}`);
}

/**
 * 把候选会话标识规整成 OpenCode 的取值形态。已经是 `ses_...` 的原样保留
 * （例如 OpenCode CLI 自己发的会话头），其余合法标识做哈希，保持定长且不泄露内容。
 */
export function normalizeSessionId(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (OPENCODE_SESSION_VALUE_RE.test(value)) return value;
  if (FORWARDABLE_SESSION_VALUE_RE.test(value)) return hashSessionValue(value);
  return null;
}

/** 客户端请求头里第一个可用的会话标识（Node 已把请求头名小写化）。 */
export function sessionIdFromHeaders(
  headers: HeaderBag | undefined,
): string | undefined {
  if (!headers) return undefined;
  for (const name of CLIENT_SESSION_HEADERS) {
    const raw = headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value?.trim()) return value;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stableStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function fingerprintPiece(value: unknown): string {
  return stableStringify(value).slice(0, FINGERPRINT_CHARS);
}

/**
 * 对请求体的“稳定前缀”做指纹：模型 + 首批消息。
 *
 * 会话每轮只在末尾追加内容，因此前缀对同一会话的每次请求都相同，而不同会话
 * （或上下文被压缩后）会得到不同的指纹，正好满足会话头的稳定性要求。
 * 同时兼容 Responses（input/instructions）、Chat（messages）与 Completions（prompt）。
 */
export function requestBodyFingerprint(
  bodyText: string | undefined,
): string | null {
  if (!bodyText) return null;
  let body: Record<string, unknown>;
  try {
    body = asRecord(JSON.parse(bodyText)) ?? {};
  } catch {
    return null;
  }

  const pieces: string[] = [];
  if (typeof body.model === "string") pieces.push(body.model);
  if (typeof body.instructions === "string") {
    pieces.push(fingerprintPiece(body.instructions));
  }
  if (Array.isArray(body.messages)) {
    for (const message of body.messages.slice(0, FINGERPRINT_MESSAGES)) {
      pieces.push(fingerprintPiece(message));
    }
  }
  const input = body.input;
  if (typeof input === "string") {
    pieces.push(input.slice(0, FINGERPRINT_CHARS));
  } else if (Array.isArray(input)) {
    for (const item of input.slice(0, FINGERPRINT_MESSAGES)) {
      pieces.push(fingerprintPiece(item));
    }
  }
  if (typeof body.prompt === "string") {
    pieces.push(body.prompt.slice(0, FINGERPRINT_CHARS));
  }

  const joined = pieces.join("\u0000");
  return joined || null;
}

export interface OpenCodeSessionOptions {
  baseUrl?: string;
  headers?: HeaderBag;
  bodyText?: string;
  /** 会话头无法从请求头或请求体推导时使用的兜底种子（如 profile 名）。 */
  fallbackSeed?: string;
  /** 用于计算伪造标识的小时分桶；默认取当前时间，测试可注入。 */
  now?: number;
}

/**
 * 构造发往上游的会话头。非 OpenCode 上游返回空对象，因此调用方可以无条件合并。
 *
 * 客户端自带的会话标识原样透传；需要伪造时按小时分桶，每小时更换一次。
 */
export function openCodeSessionHeaders(
  options: OpenCodeSessionOptions,
): Record<string, string> {
  if (!requiresOpenCodeSession(options.baseUrl)) return {};

  const fromClient = normalizeSessionId(sessionIdFromHeaders(options.headers));
  if (fromClient) return { [OPENCODE_SESSION_HEADER]: fromClient };

  const seed =
    requestBodyFingerprint(options.bodyText) ?? options.fallbackSeed?.trim();
  if (!seed) return {};
  return {
    [OPENCODE_SESSION_HEADER]: deriveSessionId(
      seed,
      options.now ?? Date.now(),
    ),
  };
}

function hasHeader(
  headers: Record<string, string | undefined> | undefined,
  name: string,
): boolean {
  if (!headers) return false;
  const wanted = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === wanted);
}

export interface OpenCodeSessionFallbackOptions {
  /** 即将请求的目标 URL；据此判断是否 OpenCode 上游。 */
  url: string;
  /** 已经组好的上游请求头；已携带会话头时保持不动。 */
  headers?: Record<string, string | undefined>;
  /** 即将发送的请求体（字符串），用于推导同一会话的稳定标识。 */
  bodyText?: string;
  /** 用于计算伪造标识的小时分桶；默认取当前时间，测试可注入。 */
  now?: number;
}

/**
 * 传输层兜底：任何发往 OpenCode 上游的请求，若仍未携带会话头就补一个。
 *
 * bridge / gateway 会结合客户端会话与请求体推导出更准确的标识，正常情况下这里
 * 什么都不做；但 CLI 直连的请求（模型列表、格式探测等）不经过那两层，缺失时会被
 * 上游以 MissingSessionID 拒绝。放在传输层后，所有出站请求都被兜住。
 */
export function fallbackOpenCodeSessionHeaders(
  options: OpenCodeSessionFallbackOptions,
): Record<string, string> {
  if (!requiresOpenCodeSession(options.url)) return {};
  if (hasHeader(options.headers, OPENCODE_SESSION_HEADER)) return {};

  const seed = requestBodyFingerprint(options.bodyText) ?? options.url;
  if (!seed) return {};
  return {
    [OPENCODE_SESSION_HEADER]: deriveSessionId(
      seed,
      options.now ?? Date.now(),
    ),
  };
}
