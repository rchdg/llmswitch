import type { ApiFormat, ProxyConfig, Tool } from "../types.js";
import { supportedFormats } from "../formats/compatibility.js";
import { requestWithNodeTransport } from "../bridge/transport.js";
import {
  baseUrlFromModelsEndpoint,
  buildModelsRequestHeaders,
  modelListEndpoints,
  parseModelIds,
} from "./fetch-models.js";

export interface DetectFormatResult {
  apiFormat: ApiFormat;
  bridgeMode?: "chat" | "completions";
  /** true 表示自动识别成功；false 需要人工选择。 */
  detected: boolean;
  /** 识别来源，用于提示文案。 */
  source?: "anthropic" | "openai-models" | "openai-route" | "ollama-tags";
  /** OpenAI 兼容上游时：由 /models 端点推导出的 base URL。 */
  resolvedBaseUrl?: string;
}

const PROBE_TIMEOUT_MS = 4000;

type ProbeResponse = {
  status: number;
  json: unknown;
} | null;

async function probe(
  url: string,
  method: "GET" | "POST",
  headers: Record<string, string>,
  proxy?: ProxyConfig,
  body?: unknown,
): Promise<ProbeResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await requestWithNodeTransport({
      url,
      method,
      headers,
      proxy,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      totalTimeoutMs: PROBE_TIMEOUT_MS,
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      return null;
    }
    return { status: res.status, json };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** GET /models（Anthropic 头）成功且返回模型 → anthropic 兼容。 */
async function probeAnthropicModels(
  baseUrl: string,
  apiKey: string,
  proxy?: ProxyConfig,
): Promise<boolean> {
  const headers = buildModelsRequestHeaders("anthropic", apiKey);
  for (const endpoint of modelListEndpoints(baseUrl)) {
    const res = await probe(endpoint, "GET", headers, proxy);
    if (
      res &&
      res.status >= 200 &&
      res.status < 300 &&
      parseModelIds(res.json).length > 0
    ) {
      return true;
    }
  }
  return false;
}

/** GET /models（Bearer 头）成功 → OpenAI 兼容。 */
async function probeOpenAiModels(
  baseUrl: string,
  apiKey: string,
  proxy?: ProxyConfig,
): Promise<string | null> {
  const headers = buildModelsRequestHeaders("openai-chat", apiKey);
  for (const endpoint of modelListEndpoints(baseUrl)) {
    const res = await probe(endpoint, "GET", headers, proxy);
    if (
      res &&
      res.status >= 200 &&
      res.status < 300 &&
      parseModelIds(res.json).length > 0
    ) {
      return endpoint;
    }
  }
  return null;
}

/**
 * POST 探测某一路由是否存在：404/501 或非 JSON 响应视为不存在；
 * 400/401/422/200 等带 JSON body 的响应视为路由存在。
 */
async function routeExists(
  baseUrl: string,
  suffix: string,
  apiKey: string,
  proxy?: ProxyConfig,
  body?: unknown,
): Promise<boolean> {
  const base = baseUrl.trim().replace(/\/+$/, "");
  const candidates: string[] = [];
  if (/\/v1$/i.test(base)) {
    candidates.push(`${base}/${suffix}`);
  } else {
    candidates.push(`${base}/${suffix}`);
    candidates.push(`${base}/v1/${suffix}`);
  }
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (apiKey.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;

  for (const endpoint of candidates) {
    const res = await probe(endpoint, "POST", headers, proxy, body);
    if (!res) continue;
    if (res.status === 404 || res.status === 501 || res.status === 405) {
      continue;
    }
    if (res.json === null) continue;
    return true;
  }
  return false;
}

/** GET /api/tags（Ollama 原生）成功且返回模型 → 本地 Ollama。 */
async function probeOllamaTags(
  baseUrl: string,
  proxy?: ProxyConfig,
): Promise<boolean> {
  const base = baseUrl.trim().replace(/\/+$/, "");
  const endpoint = `${base}/api/tags`;
  const res = await probe(endpoint, "GET", { Accept: "application/json" }, proxy);
  return (
    res !== null &&
    res.status >= 200 &&
    res.status < 300 &&
    parseModelIds(res.json).length > 0
  );
}

/**
 * 自动识别上游接口类型。探测策略（每个请求 4s 超时，串行）：
 * 1. Anthropic /models（有 Key 且工具支持时，claude/opencode 优先原生）
 * 2. OpenAI /models（无 Key 也探测，覆盖 Ollama /vLLM 等本地服务）
 * 3. Ollama 原生 /api/tags（兼容 OpenAI 兼容层缺失的旧版本）
 * 4. /models 全失败且有 Key 时兜底探测 /v1/chat/completions 路由
 * 全部失败返回 detected: false，由调用方回退到人工选择。
 */
export async function detectApiFormat(
  tool: Tool,
  opts: {
    baseUrl: string;
    apiKey: string;
    proxy?: ProxyConfig;
  },
): Promise<DetectFormatResult> {
  const base = opts.baseUrl.trim();
  const key = opts.apiKey.trim();
  const supported = supportedFormats(tool);
  const fallback: DetectFormatResult = {
    apiFormat: "openai-chat",
    detected: false,
  };

  // 没有 URL 无法探测
  if (!base) return fallback;

  const chatResult: DetectFormatResult = {
    apiFormat: "openai-chat",
    bridgeMode: tool === "codex" ? "chat" : undefined,
    detected: true,
    source: "openai-models",
  };

  if (key && supported.includes("anthropic")) {
    const antOk = await probeAnthropicModels(base, key, opts.proxy);
    if (antOk) {
      return {
        apiFormat: "anthropic",
        detected: true,
        source: "anthropic",
        resolvedBaseUrl: base.replace(/\/+$/, ""),
      };
    }
  }

  const modelsEndpoint = await probeOpenAiModels(base, key, opts.proxy);
  if (modelsEndpoint) {
    const resolvedBaseUrl =
      baseUrlFromModelsEndpoint(modelsEndpoint) || base.replace(/\/+$/, "");
    // 无 Key 时不做 POST 探测（本地服务默认 chat 最兼容）
    if (key && supported.includes("openai-responses")) {
      const responsesOk = await routeExists(
        resolvedBaseUrl,
        "responses",
        key,
        opts.proxy,
        { model: "", input: "hi" },
      );
      if (responsesOk) {
        return {
          apiFormat: "openai-responses",
          detected: true,
          source: "openai-models",
          resolvedBaseUrl,
        };
      }
    }
    return { ...chatResult, resolvedBaseUrl };
  }

  // Ollama 原生 API（/v1 兼容层可能缺失）：映射到 OpenAI Chat + /v1
  if (supported.includes("openai-chat")) {
    const ollamaOk = await probeOllamaTags(base, opts.proxy);
    if (ollamaOk) {
      return {
        ...chatResult,
        source: "ollama-tags",
        resolvedBaseUrl: `${base.replace(/\/+$/, "")}/v1`,
      };
    }
  }

  if (key && supported.includes("openai-chat")) {
    const chatOk = await routeExists(base, "chat/completions", key, opts.proxy, {
      model: "",
      messages: [],
    });
    if (chatOk) return { ...chatResult, source: "openai-route" };
  }

  return fallback;
}
