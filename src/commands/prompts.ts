import * as p from "@clack/prompts";
import type { ApiFormat, Profile, ProxyConfig, Tool } from "../types.js";
import { normalizeProxyValue } from "../types.js";
import { isApiFormat } from "../types.js";
import { formatLabel, supportedFormats } from "../formats/compatibility.js";
import { getPreset, presetsForTool } from "../presets/index.js";
import { detectApiFormat } from "../utils/detect-format.js";
import {
  assertValidProfileName,
  listProfiles,
  profileExists,
  saveProfile,
} from "../store/profiles.js";
import {
  fetchModelList,
  preferResolvedBaseUrl,
} from "../utils/fetch-models.js";
import { normalizeBaseUrlForFormat } from "../utils/base-url.js";
import { maskSecret } from "../utils/fs.js";

export function isCancel(value: unknown): boolean {
  return p.isCancel(value);
}

export function exitOnCancel(value: unknown): asserts value is string {
  if (p.isCancel(value)) {
    p.cancel("已取消");
    process.exit(0);
  }
}

/** Safely read clack text result (guards against undefined / cancel). */
export function readPromptText(value: unknown): string {
  if (p.isCancel(value)) {
    p.cancel("已取消");
    process.exit(0);
  }
  if (value == null) return "";
  return String(value).trim();
}

export async function promptText(options: {
  message: string;
  placeholder?: string;
  initialValue?: string;
  validate?: (value: string | undefined) => string | undefined;
}): Promise<string> {
  const v = await p.text({
    message: options.message,
    placeholder: options.placeholder,
    initialValue: options.initialValue ?? "",
    validate: options.validate,
  });
  return readPromptText(v);
}

type UpstreamChoice = {
  apiFormat: ApiFormat;
  bridgeMode?: "chat" | "completions";
};

/**
 * Codex-aligned upstream picker for OpenAI-compatible endpoints.
 * Default: Chat Completions (+ local Responses bridge on Codex).
 */
export async function promptOpenAiCompatibleUpstream(
  tool: Tool,
  current?: UpstreamChoice,
): Promise<UpstreamChoice> {
  const allowed = supportedFormats(tool);
  type ChoiceValue = "chat" | "completions" | "responses";

  const options: Array<{
    value: ChoiceValue;
    label: string;
    hint?: string;
  }> = [];

  if (allowed.includes("openai-chat")) {
    options.push({
      value: "chat",
      label: "Chat Completions（/v1/chat/completions）",
      hint:
        tool === "codex"
          ? "默认 · 经本地桥兼容 Responses"
          : tool === "claude"
            ? "默认 · 经本地桥转为 Anthropic Messages"
            : "默认",
    });
    if (tool === "codex") {
      options.push({
        value: "completions",
        label: "Completions（/v1/completions）",
        hint: "经本地桥 · 旧式补全",
      });
    }
  }
  if (allowed.includes("openai-responses")) {
    options.push({
      value: "responses",
      label: "OpenAI Responses（/v1/responses）",
      hint: "原生，不经桥",
    });
  }

  if (options.length === 0) {
    throw new Error(`${tool} 不支持 OpenAI 兼容上游`);
  }

  let initial: ChoiceValue = "chat";
  if (current?.apiFormat === "openai-responses") {
    initial = "responses";
  } else if (current?.bridgeMode === "completions") {
    initial = "completions";
  } else if (current?.apiFormat === "openai-chat" || !current) {
    initial = options.some((o) => o.value === "chat") ? "chat" : options[0]!.value;
  }
  if (!options.some((o) => o.value === initial)) {
    initial = options[0]!.value;
  }

  const selected = await p.select({
    message: "上游接口类型",
    options,
    initialValue: initial,
  });
  exitOnCancel(selected);

  if (selected === "responses") {
    return { apiFormat: "openai-responses" };
  }
  if (selected === "completions") {
    return { apiFormat: "openai-chat", bridgeMode: "completions" };
  }
  return { apiFormat: "openai-chat", bridgeMode: "chat" };
}

/** Edit-time format picker aligned with Codex custom flow. */
async function promptEditUpstream(
  tool: Tool,
  current: Profile,
): Promise<UpstreamChoice> {
  const allowed = supportedFormats(tool);

  if (allowed.length === 1) {
    return { apiFormat: allowed[0]! };
  }

  // Claude-only anthropic already handled above.
  // When OpenAI-compatible formats exist, use the same menu as custom add.
  const openAiOnly = allowed.every(
    (f) => f === "openai-chat" || f === "openai-responses",
  );
  if (openAiOnly) {
    return promptOpenAiCompatibleUpstream(tool, {
      apiFormat: current.apiFormat,
      bridgeMode: current.bridgeMode,
    });
  }

  // OpenCode: anthropic + openai-* — show unified label set
  type EditValue = ApiFormat | "completions";
  const options: Array<{ value: EditValue; label: string; hint?: string }> = [];
  if (allowed.includes("anthropic")) {
    options.push({
      value: "anthropic",
      label: "Anthropic Messages",
      hint: "Claude 兼容",
    });
  }
  if (allowed.includes("openai-chat")) {
    options.push({
      value: "openai-chat",
      label: "Chat Completions（/v1/chat/completions）",
      hint:
        tool === "claude"
          ? "经本地桥转为 Anthropic Messages"
          : "OpenAI 兼容",
    });
    if (tool === "codex") {
      options.push({
        value: "completions",
        label: "Completions（/v1/completions）",
        hint: "经本地桥 · 旧式补全",
      });
    }
  }
  if (allowed.includes("openai-responses")) {
    options.push({
      value: "openai-responses",
      label: "OpenAI Responses（/v1/responses）",
      hint: "原生，不经桥",
    });
  }

  let initial: EditValue = current.apiFormat;
  if (
    current.apiFormat === "openai-chat" &&
    current.bridgeMode === "completions" &&
    options.some((o) => o.value === "completions")
  ) {
    initial = "completions";
  }

  const picked = await p.select({
    message: "上游接口类型",
    options,
    initialValue: options.some((o) => o.value === initial)
      ? initial
      : options[0]!.value,
  });
  exitOnCancel(picked);

  if (picked === "completions") {
    return { apiFormat: "openai-chat", bridgeMode: "completions" };
  }
  if (picked === "openai-chat") {
    return {
      apiFormat: "openai-chat",
      bridgeMode: tool === "codex" ? "chat" : undefined,
    };
  }
  return { apiFormat: picked as ApiFormat };
}

const NAME_GEN_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * 生成 5 位小写字母与数字的随机 profile 名称，并确保不与现有名称冲突。
 */
export function generateProfileName(tool: Tool): string {
  for (let attempt = 0; attempt < 32; attempt++) {
    let name = "";
    for (let i = 0; i < 5; i++) {
      name += NAME_GEN_CHARS[Math.floor(Math.random() * NAME_GEN_CHARS.length)];
    }
    if (!profileExists(tool, name)) return name;
  }
  return `p${Date.now().toString(36).slice(-4)}`;
}

/**
 * 显示名称默认值：基于现有 provider-N 递增（provider-1、provider-2 …）。
 */
export function suggestDisplayName(tool: Tool): string {
  let max = 0;
  for (const profile of listProfiles(tool)) {
    const match = /^provider-(\d+)$/i.exec(profile.displayName);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `provider-${max + 1}`;
}

/**
 * 供应商列表 label：显示名称 +（profile 名称 · 状态标记）。
 * 例：DeepSeek（6ham6 · 已启用）；显示名与名称相同时省略名称。
 */
export function formatProfileListLabel(
  profile: Profile,
  opts: {
    defaultName: string | null | undefined;
    activeName: string | null | undefined;
  },
): string {
  const display = profile.displayName || profile.name;
  const parts: string[] = [];
  if (profile.displayName !== profile.name) parts.push(profile.name);
  if (profile.name === opts.defaultName) parts.push("默认");
  if (profile.name === opts.activeName) parts.push("已启用");
  return parts.length ? `${display}（${parts.join(" · ")}）` : display;
}

export async function promptProfileDraft(
  tool: Tool,
  partial: Partial<{
    name: string;
    displayName: string;
    apiFormat: ApiFormat;
    baseUrl: string;
    apiKey: string;
    model: string;
    models: string[];
    proxy: string;
    preset: string;
    bridgeMode: "chat" | "completions";
  }> = {},
): Promise<Profile> {
  p.intro(`为 ${tool} 添加供应商配置`);

  const presets = presetsForTool(tool);
  if (presets.length === 0) {
    throw new Error(`${tool} 没有可用的预设模版`);
  }

  let presetId = partial.preset;
  if (!presetId) {
    const selected = await p.select({
      message: "选择预设模版",
      options: presets.map((preset) => ({
        value: preset.id,
        label: preset.displayName,
        hint:
          preset.id === "custom"
            ? tool === "claude"
              ? "OpenAI 兼容 · 经本地桥转为 Anthropic"
              : tool === "codex"
                ? "OpenAI 兼容 · 默认可经本地桥"
                : "OpenAI 兼容"
            : `${formatLabel(preset.apiFormat)} · ${preset.baseUrl}`,
      })),
    });
    exitOnCancel(selected);
    presetId = selected;
  }

  const preset = getPreset(presetId);
  if (!preset || !presets.some((item) => item.id === preset.id)) {
    throw new Error(
      `预设「${presetId}」对 ${tool} 不可用。可选：${presets.map((item) => item.id).join(", ")}`,
    );
  }

  let name = partial.name;
  if (!name) {
    name = generateProfileName(tool);
  } else {
    assertValidProfileName(name);
    if (profileExists(tool, name)) {
      throw new Error(`「${name}」已存在`);
    }
  }

  let displayName = partial.displayName;
  if (!displayName) {
    const v = await p.text({
      message: "显示名称（回车使用默认值，也可修改）",
      initialValue:
        preset.id === "custom" ? suggestDisplayName(tool) : preset.displayName,
    });
    exitOnCancel(v);
    displayName = v.trim() || name;
  }

  let baseUrl = partial.baseUrl;
  if (!baseUrl) {
    const v = await p.text({
      message: "API Base URL",
      initialValue: preset.baseUrl || "",
      placeholder:
        preset.id === "custom"
          ? "https://api.example.com/v1（缺省会自动补全 /v1）"
          : preset.baseUrl || "https://api.example.com",
      validate: (val) => (!val?.trim() ? "Base URL 不能为空" : undefined),
    });
    exitOnCancel(v);
    baseUrl = v.trim();
  }

  let apiKey = partial.apiKey;
  if (apiKey === undefined) {
    const v = await p.password({
      message: "API Key（拉取模型列表需要；可留空稍后填写）",
    });
    if (p.isCancel(v)) {
      p.cancel("已取消");
      process.exit(0);
    }
    apiKey = v || "";
  }

  // Proxy before probing / model fetch so requests go through the same upstream.
  let proxyUrl = partial.proxy;

  if (proxyUrl === undefined) {
    const wantProxy = await p.confirm({
      message:
        "是否配置上游代理？（拉取模型与后续该 provider 的请求都会走此代理）",
      initialValue: false,
    });
    if (p.isCancel(wantProxy)) {
      p.cancel("已取消");
      process.exit(0);
    }
    if (wantProxy) {
      proxyUrl =
        (await promptText({
          message: "代理地址（支持 http/https/socks5，可留空）",
          placeholder: "socks5://127.0.0.1:1080",
          validate: validateProxyUrl,
        })) || undefined;
    }
  }

  const proxy = buildProxyConfig({ url: proxyUrl });

  let apiFormat: ApiFormat;
  let bridgeMode: "chat" | "completions" | undefined;

  if (partial.apiFormat) {
    apiFormat = partial.apiFormat;
    bridgeMode = partial.bridgeMode;
  } else if (preset.id !== "custom") {
    apiFormat = preset.apiFormat;
    bridgeMode = undefined;
  } else {
    // 自定义上游：自动识别接口类型，识别失败才让用户手动选择
    const spin = p.spinner();
    spin.start("正在识别接口类型…");
    const detected = await detectApiFormat(tool, {
      baseUrl,
      apiKey: apiKey || "",
      proxy,
    });
    if (detected.detected) {
      apiFormat = detected.apiFormat;
      bridgeMode = detected.bridgeMode;
      spin.stop(
        detected.source === "ollama-tags"
          ? "已识别接口：Ollama 本地（OpenAI Chat Completions）"
          : `已识别接口：${formatLabel(apiFormat)}`,
      );
      if (
        detected.resolvedBaseUrl &&
        detected.resolvedBaseUrl !== baseUrl.trim().replace(/\/+$/, "")
      ) {
        p.log.info(
          `已根据可用接口将 Base URL 规范为 ${detected.resolvedBaseUrl}（原输入：${baseUrl}）`,
        );
        baseUrl = detected.resolvedBaseUrl;
      }
    } else {
      spin.stop("未能自动识别接口类型");
      p.log.warn("未能自动识别接口类型，请手动选择。");
      if (tool === "claude") {
        // Claude 自定义上游历史默认：Chat Completions，经本地桥转换
        apiFormat = "openai-chat";
        bridgeMode = undefined;
      } else {
        const upstream = await promptOpenAiCompatibleUpstream(tool, {
          apiFormat: "openai-chat",
          bridgeMode: "chat",
        });
        apiFormat = upstream.apiFormat;
        bridgeMode = upstream.bridgeMode;
      }
    }
  }

  if (!isApiFormat(apiFormat) || !supportedFormats(tool).includes(apiFormat)) {
    throw new Error(
      `${tool} 不支持格式 ${apiFormat}。可用：${supportedFormats(tool).join(", ")}`,
    );
  }

  {
    const before = baseUrl.trim().replace(/\/+$/, "");
    const normalized = normalizeBaseUrlForFormat(apiFormat, baseUrl);
    if (normalized !== before) {
      p.log.info(`已自动将 Base URL 规范为 ${normalized}`);
    }
    baseUrl = normalized;
  }

  if (tool === "codex" && apiFormat === "openai-chat" && !bridgeMode) {
    bridgeMode = "chat";
  }

  const resolved = await resolveModelsInteractive({
    apiFormat,
    baseUrl,
    apiKey: apiKey || "",
    proxy,
    presetDefault: preset.defaultModel,
    presetModels: preset.models,
    fixedDefault: partial.model,
    fixedList: partial.models,
  });
  const { defaultModel, modelList } = resolved;
  if (resolved.resolvedBaseUrl && resolved.resolvedBaseUrl !== baseUrl) {
    p.log.info(
      `已根据可用接口将 Base URL 规范为 ${resolved.resolvedBaseUrl}（原输入：${baseUrl}）`,
    );
    baseUrl = resolved.resolvedBaseUrl;
  }

  const profile: Profile = {
    name,
    displayName,
    apiFormat,
    baseUrl,
    apiKey: apiKey || "",
    models: {
      default: defaultModel,
      list: Array.from(new Set(modelList)),
    },
    proxy,
    bridgeMode:
      tool === "codex" && apiFormat === "openai-chat"
        ? bridgeMode || "chat"
        : undefined,
    headers: {},
    updatedAt: new Date().toISOString(),
  };

  saveProfile(tool, profile);
  p.log.success(
    `已保存供应商「${profile.displayName}」（${profile.name}，名称与显示名称均可引用）`,
  );
  return profile;
}

/**
 * Interactively edit connection settings for an existing profile.
 * Does not change model list (use model / provider → 配置模型).
 */
export async function promptEditProfile(
  tool: Tool,
  current: Profile,
): Promise<Profile> {
  p.log.step(`编辑 ${tool}/${current.name}`);

  const displayName =
    (await promptText({
      message: "显示名称",
      initialValue: current.displayName,
    })) || current.name;

  const upstream = await promptEditUpstream(tool, current);
  const apiFormat = upstream.apiFormat;
  if (!isApiFormat(apiFormat) || !supportedFormats(tool).includes(apiFormat)) {
    throw new Error(
      `${tool} 不支持格式 ${apiFormat}。可用：${supportedFormats(tool).join(", ")}`,
    );
  }

  let baseUrl = await promptText({
    message: "API Base URL",
    initialValue: current.baseUrl,
    validate: (v) => (!v?.trim() ? "不能为空" : undefined),
  });
  if (!baseUrl) throw new Error("Base URL 不能为空");
  {
    const before = baseUrl.trim().replace(/\/+$/, "");
    const normalized = normalizeBaseUrlForFormat(apiFormat, baseUrl);
    if (normalized !== before) {
      p.log.info(`已自动将 Base URL 规范为 ${normalized}`);
    }
    baseUrl = normalized;
  }

  const changeKey = await p.confirm({
    message: `是否更新 API Key？（当前 ${maskSecret(current.apiKey)}）`,
    initialValue: false,
  });
  if (p.isCancel(changeKey)) {
    p.cancel("已取消");
    process.exit(0);
  }
  let apiKey = current.apiKey;
  if (changeKey) {
    const v = await p.password({ message: "新的 API Key（可留空）" });
    if (p.isCancel(v)) {
      p.cancel("已取消");
      process.exit(0);
    }
    apiKey = v || "";
  }

  const proxyInput = await promptText({
    message: "代理地址（支持 http/https/socks5，留空清除）",
    placeholder: "socks5://127.0.0.1:1080",
    initialValue: current.proxy || "",
    validate: validateProxyUrl,
  });
  const proxy = buildProxyConfig({ url: proxyInput || undefined });

  const next: Profile = {
    ...current,
    displayName,
    apiFormat,
    baseUrl,
    apiKey,
    proxy,
    bridgeMode:
      tool === "codex" && apiFormat === "openai-chat"
        ? upstream.bridgeMode || "chat"
        : undefined,
  };
  saveProfile(tool, next);
  p.log.success(`已更新「${current.name}」的连接信息`);
  return next;
}

export type ResolveModelsInput = {
  apiFormat: ApiFormat;
  baseUrl: string;
  apiKey: string;
  proxy?: ProxyConfig;
  presetDefault?: string;
  presetModels?: string[];
  /** Non-interactive CLI flags: both set → skip prompts */
  fixedDefault?: string;
  fixedList?: string[];
  /** Prefill for interactive selection (model / use 新建时) */
  preferredDefault?: string;
  preferredList?: string[];
};

export type ResolveModelsResult = {
  defaultModel: string;
  modelList: string[];
  /** When /models succeeded on a different prefix (e.g. added /v1). */
  resolvedBaseUrl?: string;
};

/**
 * Fetch models from the provider API (when possible), then let the user
 * pick a default + a saved list. Falls back to manual text entry.
 */
export async function resolveModelsInteractive(
  input: ResolveModelsInput,
): Promise<ResolveModelsResult> {
  if (input.fixedDefault && input.fixedList?.length) {
    const list = [...input.fixedList];
    if (!list.includes(input.fixedDefault)) list.unshift(input.fixedDefault);
    return { defaultModel: input.fixedDefault, modelList: list };
  }

  if (input.fixedDefault && !input.fixedList) {
    const fetched = await tryFetchModels(input);
    if (fetched?.models.length) {
      const list = Array.from(
        new Set([input.fixedDefault, ...fetched.models]),
      );
      return {
        defaultModel: input.fixedDefault,
        modelList: list,
        resolvedBaseUrl: fetched.resolvedBaseUrl,
      };
    }
    return {
      defaultModel: input.fixedDefault,
      modelList: [input.fixedDefault],
    };
  }

  const fetched = await tryFetchModels(input);

  if (fetched && fetched.models.length > 0) {
    const selected = await selectModelsFromFetched(fetched.models, input);
    return { ...selected, resolvedBaseUrl: fetched.resolvedBaseUrl };
  }

  return manualModelsEntry(input);
}

async function selectModelsFromFetched(
  fetched: string[],
  input: ResolveModelsInput,
): Promise<{ defaultModel: string; modelList: string[] }> {
  const preferredDefault =
    (input.preferredDefault && fetched.includes(input.preferredDefault)
      ? input.preferredDefault
      : undefined) ||
    (input.presetDefault && fetched.includes(input.presetDefault)
      ? input.presetDefault
      : undefined) ||
    fetched[0]!;

  const defaultModel = await p.select({
    message: `选择默认模型（已从接口获取 ${fetched.length} 个）`,
    options: fetched.map((id) => ({
      value: id,
      label: id,
      hint: id === input.preferredDefault ? "当前" : undefined,
    })),
    initialValue: preferredDefault,
  });
  exitOnCancel(defaultModel);

  const preferredList = (input.preferredList || []).filter((m) =>
    fetched.includes(m),
  );
  const presetList = (input.presetModels || []).filter((m) =>
    fetched.includes(m),
  );

  const picked = await p.multiselect({
    message: "选择启用模型（多选，空格选择，回车确认）",
    options: fetched.map((id) => ({
      value: id,
      label: id,
      hint: (input.preferredList || []).includes(id) ? "当前" : undefined,
    })),
    initialValues: Array.from(
      new Set([defaultModel, ...preferredList, ...presetList]),
    ),
    required: true,
  });
  if (p.isCancel(picked)) {
    p.cancel("已取消");
    process.exit(0);
  }

  const modelList = Array.from(new Set([defaultModel, ...picked]));
  return { defaultModel, modelList };
}

async function manualModelsEntry(
  input: ResolveModelsInput,
): Promise<{ defaultModel: string; modelList: string[] }> {
  p.log.warn("未能自动获取模型列表，改为手动输入。");

  let defaultModel = input.fixedDefault || input.preferredDefault;
  if (!defaultModel) {
    defaultModel = await promptText({
      message: "默认模型 ID",
      initialValue: input.presetDefault || "",
      validate: (val) => (!val?.trim() ? "模型不能为空" : undefined),
    });
    if (!defaultModel) throw new Error("模型不能为空");
  }

  let modelList = input.fixedList || input.preferredList;
  if (!modelList?.length) {
    const initial =
      input.presetModels && input.presetModels.length > 0
        ? input.presetModels.join(", ")
        : defaultModel;
    const raw = await promptText({
      message: "可用模型列表（逗号分隔）",
      initialValue: initial,
    });
    modelList = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (!modelList.includes(defaultModel)) {
    modelList = [defaultModel, ...modelList];
  }

  return { defaultModel, modelList };
}

export async function tryFetchModels(input: {
  apiFormat: ApiFormat;
  baseUrl: string;
  apiKey: string;
  proxy?: ProxyConfig;
}): Promise<{ models: string[]; resolvedBaseUrl?: string } | null> {
  const spin = p.spinner();
  spin.start("正在从接口拉取模型列表…");
  try {
    const result = await fetchModelList({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      apiFormat: input.apiFormat,
      proxy: input.proxy,
    });
    const resolvedBaseUrl = preferResolvedBaseUrl(
      input.baseUrl,
      result.resolvedBaseUrl,
    );
    const normalized =
      resolvedBaseUrl !== input.baseUrl.trim().replace(/\/+$/, "")
        ? resolvedBaseUrl
        : undefined;
    spin.stop(`已获取 ${result.models.length} 个模型（${result.endpoint}）`);
    return {
      models: result.models,
      resolvedBaseUrl: normalized,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    spin.stop("拉取模型列表失败");
    p.log.error(msg);
    return null;
  }
}

const SUPPORTED_PROXY_SCHEMES = [
  "http",
  "https",
  "socks",
  "socks4",
  "socks4a",
  "socks5",
  "socks5h",
] as const;

/**
 * Validate a single proxy URL for the interactive prompts. Empty is allowed
 * (clears the proxy). Returns an error message string when invalid.
 */
export function validateProxyUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return "代理地址格式无效，示例：http://127.0.0.1:7890 或 socks5://127.0.0.1:1080";
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (!(SUPPORTED_PROXY_SCHEMES as readonly string[]).includes(scheme)) {
    return `不支持的代理协议「${scheme}」。支持：http、https、socks5（含 socks/socks4/socks4a/socks5h）`;
  }
  return undefined;
}

/** Normalize a single proxy URL input into the stored value. */
export function buildProxyConfig(input: {
  url?: string;
}): ProxyConfig | undefined {
  return normalizeProxyValue(input.url);
}
