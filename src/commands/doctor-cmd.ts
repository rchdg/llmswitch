import { Command } from "commander";
import {
  getActiveProfile,
  readProfile,
  resolveProfileOrThrow,
} from "../store/profiles.js";
import { isBridgeAlive, profileNeedsBridge } from "../bridge/manager.js";
import { readBridgeState } from "../bridge/state.js";
import { requestWithNodeTransport } from "../bridge/transport.js";
import { fetchModelList } from "../utils/fetch-models.js";
import { normalizeBaseUrlForFormat } from "../utils/base-url.js";
import {
  enrichProfileModelMeta,
  type ModelMeta,
} from "../utils/model-metadata.js";
import { readCodexConfig } from "../adapters/codex.js";
import { envKeyName } from "../adapters/codex.js";
import { isTool, type ApiFormat, type Profile } from "../types.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  /** ok=true 但值得注意（例如上游忽略了 stream 参数）。 */
  warn?: boolean;
  detail?: string;
}

/** 1x1 transparent PNG — minimal payload for an image-input probe. */
const TINY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

interface UpstreamReply {
  status: number;
  contentType: string;
  text: string;
}

function upstreamHeaders(apiFormat: ApiFormat, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (apiFormat === "anthropic") {
    if (apiKey) headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function completionEndpoint(apiFormat: ApiFormat, baseUrl: string): string {
  const base = normalizeBaseUrlForFormat(apiFormat, baseUrl).replace(/\/+$/, "");
  if (apiFormat === "anthropic") {
    return /\/v1$/i.test(base) ? `${base}/messages` : `${base}/v1/messages`;
  }
  if (apiFormat === "openai-responses") return `${base}/responses`;
  return `${base}/chat/completions`;
}

function smallCompletionBody(
  profile: Profile,
  stream: boolean,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const model = profile.models.default;
  if (profile.apiFormat === "anthropic") {
    return {
      model,
      max_tokens: 16,
      messages: [{ role: "user", content: "ping" }],
      stream,
      ...overrides,
    };
  }
  if (profile.apiFormat === "openai-responses") {
    return {
      model,
      input: "ping",
      max_output_tokens: 16,
      stream,
      ...overrides,
    };
  }
  return {
    model,
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 16,
    stream,
    ...overrides,
  };
}

async function postUpstream(
  profile: Profile,
  body: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<UpstreamReply> {
  const url = completionEndpoint(profile.apiFormat, profile.baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await requestWithNodeTransport({
      url,
      method: "POST",
      headers: upstreamHeaders(profile.apiFormat, profile.apiKey),
      body: JSON.stringify(body),
      proxy: profile.proxy,
      signal: controller.signal,
      totalTimeoutMs: timeoutMs,
    });
    const text = await res.text();
    return {
      status: res.status,
      contentType: res.headers.get("content-type") || "",
      text,
    };
  } finally {
    clearTimeout(timer);
  }
}

function extractUpstreamError(reply: UpstreamReply): string {
  try {
    const json = JSON.parse(reply.text) as Record<string, unknown>;
    const err = (json.error ?? json) as Record<string, unknown>;
    const message = err.message ?? err.error;
    if (typeof message === "string" && message.trim()) {
      return message.slice(0, 200);
    }
  } catch {
    // non-JSON body
  }
  return `HTTP ${reply.status}: ${reply.text.slice(0, 120)}`;
}

async function checkModelList(profile: Profile): Promise<DoctorCheck> {
  try {
    const result = await fetchModelList({
      baseUrl: profile.baseUrl,
      apiKey: profile.apiKey,
      apiFormat: profile.apiFormat,
      proxy: profile.proxy,
      headers: profile.headers,
    });
    const listed = result.models.includes(profile.models.default);
    return {
      name: "模型列表（连通 + 认证）",
      ok: true,
      warn: !listed,
      detail: listed
        ? `共 ${result.models.length} 个模型，当前模型在列表中`
        : `共 ${result.models.length} 个模型，但当前模型 ${profile.models.default} 不在列表中（第三方可能仍可用）`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name: "模型列表（连通 + 认证）",
      ok: false,
      detail: /401|403|unauthorized|invalid/i.test(message)
        ? `认证失败：${message}`
        : `无法获取模型列表：${message}`,
    };
  }
}

async function checkCompletion(profile: Profile, stream: boolean): Promise<DoctorCheck> {
  try {
    const reply = await postUpstream(profile, smallCompletionBody(profile, stream));
    if (reply.status >= 200 && reply.status < 300) {
      if (stream && !/text\/event-stream/i.test(reply.contentType)) {
        return {
          name: stream ? "流式生成（stream=true）" : "非流式生成",
          ok: true,
          warn: true,
          detail: "上游返回 200 但未使用 SSE（可能忽略了 stream 参数）",
        };
      }
      return {
        name: stream ? "流式生成（stream=true）" : "非流式生成",
        ok: true,
        detail: `HTTP ${reply.status}`,
      };
    }
    return {
      name: stream ? "流式生成（stream=true）" : "非流式生成",
      ok: false,
      detail: extractUpstreamError(reply),
    };
  } catch (err) {
    return {
      name: stream ? "流式生成（stream=true）" : "非流式生成",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function chatToolCalled(reply: UpstreamReply, apiFormat: ApiFormat): boolean | null {
  try {
    const json = JSON.parse(reply.text) as Record<string, unknown>;
    if (apiFormat === "openai-responses") {
      const output = Array.isArray(json.output) ? json.output : [];
      return output.some(
        (item) =>
          item &&
          typeof item === "object" &&
          ["function_call", "custom_tool_call"].includes(
            String((item as Record<string, unknown>).type),
          ),
      );
    }
    if (apiFormat === "anthropic") {
      const output = Array.isArray(json.content) ? json.content : [];
      return output.some(
        (item) =>
          item &&
          typeof item === "object" &&
          String((item as Record<string, unknown>).type) === "tool_use",
      );
    }
    const choices = Array.isArray(json.choices) ? json.choices : [];
    const message = (choices[0] as Record<string, unknown> | undefined)?.message as
      | Record<string, unknown>
      | undefined;
    return !!(
      Array.isArray(message?.tool_calls) && message.tool_calls.length > 0
    );
  } catch {
    return null;
  }
}

const WEATHER_TOOL: Record<string, unknown> = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get current weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
};

async function checkToolCall(profile: Profile): Promise<DoctorCheck> {
  let body: Record<string, unknown>;
  if (profile.apiFormat === "anthropic") {
    body = smallCompletionBody(profile, false, {
      max_tokens: 128,
      tools: [
        {
          name: "get_weather",
          description: "Get current weather for a city",
          input_schema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      ],
      messages: [
        { role: "user", content: "What is the weather in Paris? Use the tool." },
      ],
    });
  } else if (profile.apiFormat === "openai-responses") {
    body = smallCompletionBody(profile, false, {
      max_output_tokens: 128,
      tools: [WEATHER_TOOL],
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "What is the weather in Paris? Use the tool." }],
        },
      ],
    });
  } else {
    body = smallCompletionBody(profile, false, {
      max_tokens: 128,
      tools: [WEATHER_TOOL],
      messages: [
        { role: "user", content: "What is the weather in Paris? Use the tool." },
      ],
    });
  }

  try {
    const reply = await postUpstream(profile, body);
    if (reply.status < 200 || reply.status >= 300) {
      return {
        name: "Tool call 支持",
        ok: false,
        detail: `上游拒绝 tools 参数：${extractUpstreamError(reply)}`,
      };
    }
    const called = chatToolCalled(reply, profile.apiFormat);
    if (called) {
      return { name: "Tool call 支持", ok: true, detail: "上游返回了 tool_calls" };
    }
    return {
      name: "Tool call 支持",
      ok: true,
      warn: true,
      detail: "上游接受 tools 但未实际发起调用，代理能力可能受限",
    };
  } catch (err) {
    return {
      name: "Tool call 支持",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkImageInput(profile: Profile): Promise<DoctorCheck> {
  let body: Record<string, unknown>;
  if (profile.apiFormat === "anthropic") {
    body = smallCompletionBody(profile, false, {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this image." },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: TINY_PNG_DATA_URL.slice(TINY_PNG_DATA_URL.indexOf(",") + 1),
              },
            },
          ],
        },
      ],
    });
  } else if (profile.apiFormat === "openai-responses") {
    body = smallCompletionBody(profile, false, {
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Describe this image." },
            { type: "input_image", image_url: TINY_PNG_DATA_URL },
          ],
        },
      ],
    });
  } else {
    body = smallCompletionBody(profile, false, {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this image." },
            { type: "image_url", image_url: { url: TINY_PNG_DATA_URL } },
          ],
        },
      ],
    });
  }

  try {
    const reply = await postUpstream(profile, body);
    if (reply.status >= 200 && reply.status < 300) {
      return { name: "图片输入", ok: true, detail: "上游接受图片输入" };
    }
    if (reply.status === 429 || reply.status >= 500) {
      return {
        name: "图片输入",
        ok: true,
        warn: true,
        detail: `上游返回 ${reply.status}，无法判断是否支持图片`,
      };
    }
    return {
      name: "图片输入",
      ok: false,
      detail: `上游拒绝图片输入（HTTP ${reply.status}）：${extractUpstreamError(reply)}`,
    };
  } catch (err) {
    return {
      name: "图片输入",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function describeMeta(meta: ModelMeta): string {
  const parts: string[] = [];
  if (meta.context) parts.push(`上下文 ${Math.round(meta.context / 1000)}k`);
  if (meta.maxOutput) parts.push(`最大输出 ${Math.round(meta.maxOutput / 1000)}k`);
  if (typeof meta.reasoning === "boolean") {
    parts.push(meta.reasoning ? "支持推理" : "不支持推理");
  }
  if (typeof meta.toolCall === "boolean") {
    parts.push(meta.toolCall ? "支持 tool call" : "不支持 tool call");
  }
  if (meta.modalities?.input) {
    parts.push(`输入 ${meta.modalities.input.join("/")}`);
  }
  return parts.join("，");
}

async function checkMetadata(profile: Profile): Promise<DoctorCheck> {
  const enriched = await enrichProfileModelMeta(profile);
  const meta = enriched.models.meta?.[profile.models.default];
  if (!meta) {
    return {
      name: "模型元数据（models.lonae.com）",
      ok: true,
      warn: true,
      detail: "未匹配到该模型的元数据（手动模型 ID 或太新），Codex 将缺少上下文窗口信息",
    };
  }
  const summary = describeMeta(meta) || "匹配到元数据";
  return { name: "模型元数据（models.lonae.com）", ok: true, detail: summary };
}

function checkCodexConfig(profile: Profile): DoctorCheck {
  const config = readCodexConfig();
  const keyName = envKeyName(profile.name);
  const providers = (config.model_providers ?? {}) as Record<string, Record<string, unknown>>;
  const providerId = Object.keys(providers).find(
    (id) => providers[id]?.env_key === keyName,
  );
  if (!providerId) {
    return {
      name: "Codex config.toml 一致性",
      ok: false,
      detail: "config.toml 中没有本 profile 的 provider 块，请重新 llms codex use",
    };
  }
  const issues: string[] = [];
  if (config.model_provider !== providerId) {
    issues.push(`model_provider=${String(config.model_provider)} 不是 ${providerId}`);
  }
  if (config.model !== profile.models.default) {
    issues.push(
      `model=${String(config.model)} 与 profile 的 ${profile.models.default} 不一致`,
    );
  }
  const storedContext = profile.models.meta?.[profile.models.default]?.context;
  const writtenWindow = config.model_context_window;
  if (
    typeof storedContext === "number" &&
    typeof writtenWindow === "number" &&
    Math.abs(writtenWindow - storedContext) / storedContext > 0.05
  ) {
    issues.push(
      `model_context_window=${writtenWindow} 与元数据 ${storedContext} 不一致`,
    );
  }
  if (issues.length > 0) {
    return {
      name: "Codex config.toml 一致性",
      ok: false,
      detail: `${issues.join("；")}（重新 llms codex use 可修复）`,
    };
  }
  return {
    name: "Codex config.toml 一致性",
    ok: true,
    detail: `provider=${providerId}，model=${String(config.model)}${
      typeof writtenWindow === "number" ? `，context_window=${writtenWindow}` : ""
    }`,
  };
}

async function checkBridge(profile: Profile, tool: "codex" | "claude" | "opencode"): Promise<DoctorCheck> {
  if (!profileNeedsBridge(profile)) {
    return {
      name: "本地 bridge",
      ok: true,
      detail: "原生协议直连，不经过 bridge",
    };
  }
  const alive = await isBridgeAlive();
  const upstream = readBridgeState().upstreams[tool];
  if (!alive) {
    return {
      name: "本地 bridge",
      ok: false,
      detail: "bridge 未运行，请执行 llms codex use 或 llms bridge start",
    };
  }
  if (!upstream || (upstream.profileName && upstream.profileName !== profile.name)) {
    return {
      name: "本地 bridge",
      ok: false,
      detail: `bridge 在运行，但上游是 ${upstream?.profileName ?? "未配置"}，不是 ${profile.name}；请重新 llms codex use`,
    };
  }
  return {
    name: "本地 bridge",
    ok: true,
    detail: `运行中，上游 ${upstream.baseUrl}（模式 ${upstream.mode}）`,
  };
}

function checkFallbacks(
  profile: Profile,
  tool: "codex" | "claude" | "opencode",
): DoctorCheck {
  const chain = profile.fallbacks ?? [];
  if (chain.length === 0) {
    return {
      name: "故障转移备用链",
      ok: true,
      detail: `未配置备用供应商（llms ${tool} fallback add <name> 可添加）`,
    };
  }
  const missing = chain.filter((name) => !readProfile(tool, name));
  if (missing.length > 0) {
    return {
      name: "故障转移备用链",
      ok: false,
      detail: `备用供应商不存在：${missing.join("、")}（llms ${tool} fallback remove 可清理）`,
    };
  }
  return {
    name: "故障转移备用链",
    ok: true,
    detail: `${profile.name} → ${chain.join(" → ")}`,
  };
}

function renderChecks(checks: DoctorCheck[]): string {
  return checks
    .map((check) => {
      const mark = !check.ok ? "✗" : check.warn ? "!" : "✓";
      const detail = check.detail ? ` — ${check.detail}` : "";
      return `  ${mark} ${check.name}${detail}`;
    })
    .join("\n");
}

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("健康检查：连通、认证、生成、流式、元数据与配置一致性")
    .argument("[tool]", "claude | codex | opencode（默认 codex）", "codex")
    .option("--profile <name>", "指定 profile（默认当前启用）")
    .option("--full", "额外测试 tool call 与图片输入（会消耗少量 token）")
    .option("--json", "JSON 输出")
    .action(
      async (
        toolArg: string,
        opts: { profile?: string; full?: boolean; json?: boolean },
      ) => {
        const toolName = toolArg || "codex";
        if (!isTool(toolName)) {
          throw new Error(`未知工具「${toolName}」`);
        }
        const profile = opts.profile
          ? resolveProfileOrThrow(toolName, opts.profile)
          : getActiveProfile(toolName);
        if (!profile) {
          throw new Error(
            `没有已启用的 ${toolName} profile。先执行 llms ${toolName} use，或用 --profile 指定。`,
          );
        }

        const checks: DoctorCheck[] = [];
        checks.push(await checkBridge(profile, toolName));
        checks.push(checkFallbacks(profile, toolName));
        checks.push(await checkModelList(profile));
        checks.push(await checkCompletion(profile, false));
        checks.push(await checkCompletion(profile, true));
        checks.push(await checkMetadata(profile));
        if (toolName === "codex") checks.push(checkCodexConfig(profile));
        if (opts.full) {
          checks.push(await checkToolCall(profile));
          checks.push(await checkImageInput(profile));
        }

        if (opts.json) {
          console.log(
            JSON.stringify(
              { tool: toolName, profile: profile.name, checks },
              null,
              2,
            ),
          );
          return;
        }

        console.log(`\n${toolName} / ${profile.name}（${profile.apiFormat} → ${profile.baseUrl}）`);
        console.log(renderChecks(checks));
        const failed = checks.filter((check) => !check.ok);
        if (failed.length > 0) {
          console.log(`\n${failed.length} 项未通过。`);
        } else {
          const warned = checks.filter((check) => check.warn);
          console.log(
            warned.length > 0
              ? `\n全部通过，${warned.length} 项有提醒。`
              : "\n全部通过。",
          );
        }
      },
    );
}
