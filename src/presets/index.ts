import type { ApiFormat, Tool } from "../types.js";
import { supportedFormats } from "../formats/compatibility.js";

export const PRESET_IDS = ["custom", "openai", "anthropic", "ollama"] as const;
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
