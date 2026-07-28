import type { ApiFormat, Tool } from "../types.js";

const SUPPORTED: Record<Tool, readonly ApiFormat[]> = {
  // openai-chat 通过本地 bridge 转成 /v1/messages 供 Claude Code 使用
  claude: ["anthropic", "openai-chat"],
  // openai-chat 通过本地 bridge 转成 /v1/responses 供 Codex 使用
  codex: ["openai-responses", "openai-chat"],
  opencode: ["anthropic", "openai-chat", "openai-responses"],
};

export function supportedFormats(tool: Tool): readonly ApiFormat[] {
  return SUPPORTED[tool];
}

export function assertCompatible(tool: Tool, format: ApiFormat): void {
  if (SUPPORTED[tool].includes(format)) return;

  if (tool === "claude") {
    throw new Error(
      `Claude Code 支持 anthropic（直连）或 openai-chat（经本地 bridge 转为 /v1/messages）。` +
        `当前 profile 为 ${format}。`,
    );
  }
  if (tool === "codex") {
    throw new Error(
      `Codex 支持 openai-responses（原生）或 openai-chat（经本地 bridge 转为 /v1/responses）。` +
        `当前 profile 为 ${format}。`,
    );
  }
  throw new Error(`工具 ${tool} 不支持格式 ${format}`);
}

export function formatLabel(format: ApiFormat): string {
  switch (format) {
    case "anthropic":
      return "Claude（Anthropic Messages）";
    case "openai-chat":
      return "OpenAI Chat Completions";
    case "openai-responses":
      return "OpenAI Responses";
  }
}
