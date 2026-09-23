import type { ApiFormat, Tool } from "../types.js";
import { supportedFormats } from "../formats/compatibility.js";

export const PRESET_IDS = [
  "custom",
  "openai",
  "anthropic",
  "opencode-go",
  "ollama",
] as const;
export type PresetId = (typeof PRESET_IDS)[number];

export interface PresetTemplate {
  id: PresetId;
  displayName: string;
  apiFormat: ApiFormat;
  baseUrl: string;
  defaultModel: string;
  models: string[];
  tools: Tool[];
}

export const PRESETS: PresetTemplate[] = [
  {
    id: "custom",
    displayName: "自定义（OpenAI 兼容）",
    apiFormat: "openai-chat",
    baseUrl: "",
    defaultModel: "",
    models: [],
    tools: ["claude", "codex", "opencode"],
  },
  {
    id: "openai",
    displayName: "OpenAI",
    apiFormat: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "",
    models: [],
    tools: ["codex", "opencode"],
  },
  {
    id: "anthropic",
    displayName: "Anthropic",
    apiFormat: "anthropic",
    baseUrl: "https://api.anthropic.com",
    defaultModel: "",
    models: [],
    tools: ["claude", "opencode"],
  },
  {
    id: "opencode-go",
    displayName: "OpenCode Go",
    apiFormat: "openai-chat",
    baseUrl: "https://opencode.ai/zen/go/v1",
    defaultModel: "deepseek-v4.1-flash",
    models: [
      "deepseek-v4.1-flash",
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "deepseek-v4-flash-vision-exp",
      "glm-5.3-flash",
      "glm-5.3",
      "glm-5.2",
      "glm-5.1",
      "kimi-k3",
      "kimi-k2.7-code",
      "kimi-k2.6",
      "longcat-2.0",
      "mimo-v2.6-flash",
      "mimo-v2.6-pro",
      "mimo-v2.5",
      "mimo-v2.5-pro",
      "hy4-preview",
      "hy3",
    ],
    tools: ["claude", "codex", "opencode"],
  },
  {
    id: "ollama",
    displayName: "Ollama（本地）",
    apiFormat: "openai-chat",
    baseUrl: "http://localhost:11434",
    defaultModel: "",
    models: [],
    tools: ["claude", "codex", "opencode"],
  },
];

export function isPresetId(value: string): value is PresetId {
  return (PRESET_IDS as readonly string[]).includes(value);
}

export function presetsForTool(tool: Tool): PresetTemplate[] {
  return PRESETS.filter(
    (p) =>
      p.tools.includes(tool) && supportedFormats(tool).includes(p.apiFormat),
  );
}

export function getPreset(id: string): PresetTemplate | undefined {
  return PRESETS.find((p) => p.id === id);
}
