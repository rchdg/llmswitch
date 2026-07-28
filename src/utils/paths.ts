import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { Tool } from "../types.js";

export function getAppConfigRoot(): string {
  if (process.env.LLM_SWITCH_HOME) {
    return process.env.LLM_SWITCH_HOME;
  }
  if (platform() === "win32") {
    const base = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(base, "llm-switch");
  }
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdg, "llm-switch");
}

export function getToolStoreDir(tool: Tool): string {
  return join(getAppConfigRoot(), tool);
}

export function getProfilesDir(tool: Tool): string {
  return join(getToolStoreDir(tool), "profiles");
}

export function getProfilePath(tool: Tool, name: string): string {
  return join(getProfilesDir(tool), `${name}.json`);
}

export function getStatePath(tool: Tool): string {
  return join(getToolStoreDir(tool), "state.json");
}

export function getBackupsDir(tool: Tool): string {
  return join(getToolStoreDir(tool), "backups");
}

export function getClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

export function getClaudeSettingsPath(): string {
  return join(getClaudeConfigDir(), "settings.json");
}

export function getCodexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

export function getCodexConfigPath(): string {
  return join(getCodexHome(), "config.toml");
}

export function getCodexAuthPath(): string {
  return join(getCodexHome(), "auth.json");
}

export function getCodexEnvPath(): string {
  return join(getCodexHome(), ".env");
}

export function getOpenCodeConfigDir(): string {
  if (process.env.OPENCODE_CONFIG_DIR) {
    return process.env.OPENCODE_CONFIG_DIR;
  }
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdg, "opencode");
}

export function getOpenCodeConfigPath(): string {
  return join(getOpenCodeConfigDir(), "opencode.json");
}

export function getOpenCodeAuthPath(): string {
  if (process.env.OPENCODE_DATA_DIR) {
    return join(process.env.OPENCODE_DATA_DIR, "auth.json");
  }
  if (platform() === "win32") {
    const base =
      process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    return join(base, "opencode", "auth.json");
  }
  const data = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(data, "opencode", "auth.json");
}
