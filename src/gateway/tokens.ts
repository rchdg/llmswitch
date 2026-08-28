/**
 * Input token accounting for the `count_tokens` endpoint.
 *
 * Native upstream endpoints are always preferred (see `forwardCountTokens`).
 * This module covers the remaining case: the model lives behind a non-Anthropic
 * upstream that offers no counting API.
 *
 * Two levels of fidelity:
 *  - `tokenizer`: a real BPE tokenizer, used when the optional `gpt-tokenizer`
 *    package is installed. Exact for OpenAI encodings and a close proxy for
 *    other vocabularies.
 *  - `heuristic`: a script-aware estimate. Text is segmented by writing system
 *    because tokens-per-character differs sharply between CJK, Latin and
 *    digits; a flat characters/4 rule is badly wrong on mixed content.
 *
 * Both levels add the parts a text tokenizer cannot know about: per-message
 * framing, tool schema text and image tokens derived from real pixel
 * dimensions. Estimates lean slightly high, since the caller uses the result to
 * decide whether a request fits.
 */

/** Anthropic bills images at roughly width × height / 750 tokens. */
const IMAGE_PIXELS_PER_TOKEN = 750;
/** Used when an image's dimensions cannot be determined. */
const UNKNOWN_IMAGE_TOKENS = 1_200;
/** Per-message envelope (role marker plus delimiters). */
const MESSAGE_OVERHEAD_TOKENS = 3;
/** Per-tool envelope on top of the serialized schema. */
const TOOL_OVERHEAD_TOKENS = 10;
/** Request-level envelope. */
const REQUEST_OVERHEAD_TOKENS = 8;

export interface TokenBreakdown {
  text: number;
  images: number;
  tools: number;
  overhead: number;
}

export interface TokenCountResult {
  inputTokens: number;
  method: "tokenizer" | "heuristic";
  /** Identifier of the tokenizer actually used, when method is `tokenizer`. */
  tokenizer?: string;
  breakdown: TokenBreakdown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

// --- image dimensions -------------------------------------------------------

export interface ImageSize {
  width: number;
  height: number;
}

function parsePngSize(buf: Buffer): ImageSize | null {
  // 8-byte signature, then an IHDR chunk whose payload starts at offset 16.
  if (buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function parseGifSize(buf: Buffer): ImageSize | null {
  if (buf.length < 10) return null;
  if (buf.toString("ascii", 0, 3) !== "GIF") return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function parseJpegSize(buf: Buffer): ImageSize | null {
  if (buf.length < 4 || buf.readUInt16BE(0) !== 0xffd8) return null;
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buf[offset + 1]!;
    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = buf.readUInt16BE(offset + 2);
    // SOF0..SOF15, excluding the DHT/JPG/DAC markers interleaved in that range.
    const isStartOfFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isStartOfFrame) {
      return {
        height: buf.readUInt16BE(offset + 5),
        width: buf.readUInt16BE(offset + 7),
      };
    }
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

function parseWebpSize(buf: Buffer): ImageSize | null {
  if (buf.length < 30) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buf.toString("ascii", 8, 12) !== "WEBP") return null;
  const chunk = buf.toString("ascii", 12, 16);
  if (chunk === "VP8X") {
    // 24-bit little-endian canvas size minus one.
    const width = 1 + (buf.readUIntLE(24, 3) & 0xffffff);
    const height = 1 + (buf.readUIntLE(27, 3) & 0xffffff);
    return { width, height };
  }
  if (chunk === "VP8 ") {
    return {
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === "VP8L") {
    const bits = buf.readUInt32LE(21);
    return {
      width: 1 + (bits & 0x3fff),
      height: 1 + ((bits >> 14) & 0x3fff),
    };
  }
  return null;
}

/** Read pixel dimensions from a PNG, JPEG, GIF or WebP header. */
export function parseImageDimensions(buf: Buffer): ImageSize | null {
  const size =
    parsePngSize(buf) ||
    parseJpegSize(buf) ||
    parseGifSize(buf) ||
    parseWebpSize(buf);
  if (!size) return null;
  if (
    !Number.isFinite(size.width) ||
    !Number.isFinite(size.height) ||
    size.width <= 0 ||
    size.height <= 0
  ) {
    return null;
  }
  return size;
}

export function imageTokensForSize(size: ImageSize | null): number {
  if (!size) return UNKNOWN_IMAGE_TOKENS;
  return Math.max(1, Math.ceil((size.width * size.height) / IMAGE_PIXELS_PER_TOKEN));
}

/** Token cost of a base64 image payload, decoding only the header bytes. */
export function imageTokensFromBase64(data: string): number {
  if (!data) return UNKNOWN_IMAGE_TOKENS;
  try {
    // 64 base64 chars decode to 48 bytes, enough for every header above except
    // deeply-nested JPEG frames, for which we read a larger prefix.
    const prefix = data.slice(0, 4_096);
    const buf = Buffer.from(prefix, "base64");
    return imageTokensForSize(parseImageDimensions(buf));
  } catch {
    return UNKNOWN_IMAGE_TOKENS;
  }
}

// --- script-aware text estimation -------------------------------------------

type Script = "cjk" | "kana" | "hangul" | "latin" | "digit" | "other";

/**
 * Approximate characters or tokens per unit, by writing system. Calibrated
 * against o200k_base on prose samples; mixed-script text lands within roughly
 * 10-25% and leans high.
 */
const CJK_TOKENS_PER_CHAR = 0.7;
const KANA_TOKENS_PER_CHAR = 0.6;
const HANGUL_TOKENS_PER_CHAR = 0.8;
const CHARS_PER_LATIN_TOKEN = 4;
const CHARS_PER_DIGIT_TOKEN = 3;

function classify(code: number): Script {
  // Whitespace is folded into the latin budget: the "~4 characters per token"
  // rule of thumb already counts the spaces between words.
  if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
    return "latin";
  }
  if (code >= 0x30 && code <= 0x39) return "digit";
  if (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    // Latin-1 letters, Latin Extended, Greek, Cyrillic.
    (code >= 0xc0 && code <= 0x24f) ||
    (code >= 0x370 && code <= 0x3ff) ||
    (code >= 0x400 && code <= 0x4ff)
  ) {
    return "latin";
  }
  if (
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x20000 && code <= 0x2ffff) ||
    // CJK symbols/punctuation and fullwidth forms tokenize with the script.
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0xff00 && code <= 0xffef)
  ) {
    return "cjk";
  }
  if (code >= 0x3040 && code <= 0x30ff) return "kana";
  if (
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0x1100 && code <= 0x11ff)
  ) {
    return "hangul";
  }
  return "other";
}

/**
 * Estimate tokens for a string.
 *
 * Characters are tallied per writing system across the whole string and
 * converted once at the end. Converting per word instead would round up on
 * every word and inflate ordinary prose by a third or more.
 *
 * Digit runs are the exception: BPE never merges digits across a separator, so
 * each run is costed individually plus a token for the run boundary.
 *
 * Known weak spot: punctuation-dense input such as source code can come in
 * under the real count, because symbols are charged at the same rate as prose.
 * Install `gpt-tokenizer` for exact numbers when that matters.
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let kana = 0;
  let hangul = 0;
  let latin = 0;
  let other = 0;
  let digitTokens = 0;
  let digitRun = 0;

  const flushDigits = () => {
    if (digitRun === 0) return;
    // ceil(run / 3) for the digit groups, plus the boundary token.
    digitTokens += Math.ceil(digitRun / CHARS_PER_DIGIT_TOKEN) + 1;
    digitRun = 0;
  };

  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const script = classify(code);
    if (script !== "digit") flushDigits();
    switch (script) {
      case "cjk":
        cjk += 1;
        break;
      case "kana":
        kana += 1;
        break;
      case "hangul":
        hangul += 1;
        break;
      case "latin":
        latin += 1;
        break;
      case "digit":
        digitRun += 1;
        break;
      case "other":
        // Astral symbols (emoji and friends) cost more than one token.
        other += code > 0xffff ? 2 : 1;
        break;
    }
  }
  flushDigits();

  return (
    Math.ceil(cjk * CJK_TOKENS_PER_CHAR) +
    Math.ceil(kana * KANA_TOKENS_PER_CHAR) +
    Math.ceil(hangul * HANGUL_TOKENS_PER_CHAR) +
    Math.ceil((latin + other) / CHARS_PER_LATIN_TOKEN) +
    digitTokens
  );
}

// --- optional real tokenizer ------------------------------------------------

export type TextCounter = { name: string; count: (text: string) => number };

let tokenizerPromise: Promise<TextCounter | null> | null = null;

function extractCounter(
  module: Record<string, unknown>,
  name: string,
): TextCounter | null {
  const direct = module.countTokens;
  if (typeof direct === "function") {
    return {
      name,
      count: (text) => Number((direct as (t: string) => number)(text)) || 0,
    };
  }
  const encode = module.encode;
  if (typeof encode === "function") {
    return {
      name,
      count: (text) => {
        const result = (encode as (t: string) => unknown)(text);
        return Array.isArray(result) ? result.length : 0;
      },
    };
  }
  return null;
}

/**
 * Load `gpt-tokenizer` if the host project installed it. It is intentionally
 * not a dependency: most users do not need exact counts, and the encoding
 * tables are large. Set LLM_SWITCH_DISABLE_TOKENIZER=1 to force the heuristic.
 */
export function loadTextCounter(): Promise<TextCounter | null> {
  if (process.env.LLM_SWITCH_DISABLE_TOKENIZER === "1") {
    return Promise.resolve(null);
  }
  if (tokenizerPromise) return tokenizerPromise;
  tokenizerPromise = (async () => {
    const candidates = [
      "gpt-tokenizer/encoding/o200k_base",
      "gpt-tokenizer",
    ];
    for (const specifier of candidates) {
      try {
        const module = (await import(specifier)) as Record<string, unknown>;
        const counter = extractCounter(module, specifier);
        if (counter) {
          // Confirm it actually runs before trusting it on live traffic.
          counter.count("probe");
          return counter;
        }
      } catch {
        // Not installed or failed to initialise; try the next candidate.
      }
    }
    return null;
  })();
  return tokenizerPromise;
}

/** Test seam: forget the cached tokenizer lookup. */
export function resetTextCounterCache(): void {
  tokenizerPromise = null;
}

// --- request accounting -----------------------------------------------------

interface Accumulator {
  text: string[];
  imageTokens: number;
}

function collectContent(content: unknown, acc: Accumulator): void {
  if (typeof content === "string") {
    acc.text.push(content);
    return;
  }
  if (Array.isArray(content)) {
    for (const item of content) collectContent(item, acc);
    return;
  }
  const block = asRecord(content);
  if (!block) return;
  const type = String(block.type || "");

  if (type === "image") {
    const source = asRecord(block.source);
    if (source && typeof source.data === "string") {
      acc.imageTokens += imageTokensFromBase64(source.data);
    } else {
      // URL sources cannot be measured without fetching them.
      acc.imageTokens += UNKNOWN_IMAGE_TOKENS;
    }
    return;
  }
  if (type === "image_url") {
    const nested = asRecord(block.image_url);
    const url =
      typeof nested?.url === "string"
        ? nested.url
        : typeof block.image_url === "string"
          ? block.image_url
          : "";
    const base64 = url.match(/^data:[^;,]+;base64,([\s\S]*)$/)?.[1];
    acc.imageTokens += base64
      ? imageTokensFromBase64(base64)
      : UNKNOWN_IMAGE_TOKENS;
    return;
  }

  if (typeof block.text === "string") acc.text.push(block.text);
  if (typeof block.thinking === "string") acc.text.push(block.thinking);
  if (block.content !== undefined) collectContent(block.content, acc);
  if (block.input !== undefined && typeof block.input === "object") {
    try {
      acc.text.push(JSON.stringify(block.input));
    } catch {
      // Unserializable tool input; skip it.
    }
  } else if (typeof block.input === "string") {
    acc.text.push(block.input);
  }
}

/**
 * Count input tokens for an Anthropic Messages request body.
 * Shape-compatible with `POST /v1/messages/count_tokens`.
 */
export async function countAnthropicInputTokens(
  body: Record<string, unknown>,
): Promise<TokenCountResult> {
  const counter = await loadTextCounter();
  const countText = counter
    ? (text: string) => counter.count(text)
    : estimateTextTokens;

  const acc: Accumulator = { text: [], imageTokens: 0 };
  collectContent(body.system, acc);

  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of messages) {
    const message = asRecord(raw);
    if (!message) continue;
    collectContent(message.content, acc);
  }

  const toolTexts: string[] = [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  for (const raw of tools) {
    const tool = asRecord(raw);
    if (!tool) continue;
    try {
      toolTexts.push(JSON.stringify(tool));
    } catch {
      if (typeof tool.name === "string") toolTexts.push(tool.name);
    }
  }

  const text = acc.text.reduce((sum, chunk) => sum + countText(chunk), 0);
  const toolTokens = toolTexts.reduce(
    (sum, chunk) => sum + countText(chunk) + TOOL_OVERHEAD_TOKENS,
    0,
  );
  const overhead =
    REQUEST_OVERHEAD_TOKENS +
    messages.length * MESSAGE_OVERHEAD_TOKENS +
    (body.system ? MESSAGE_OVERHEAD_TOKENS : 0);

  const breakdown: TokenBreakdown = {
    text,
    images: acc.imageTokens,
    tools: toolTokens,
    overhead,
  };

  return {
    inputTokens: Math.max(
      1,
      breakdown.text + breakdown.images + breakdown.tools + breakdown.overhead,
    ),
    method: counter ? "tokenizer" : "heuristic",
    ...(counter ? { tokenizer: counter.name } : {}),
    breakdown,
  };
}
