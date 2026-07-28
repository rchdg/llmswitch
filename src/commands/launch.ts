import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Profile, Tool } from "../types.js";
import { isTool } from "../types.js";
import { applyProfile } from "../adapters/index.js";
import {
  getActiveProfile,
  getDefaultProfile,
  listProfiles,
  requireProfile,
  saveProfile,
  ensureDefaultProvider,
} from "../store/profiles.js";

const BINARY: Record<Tool, string> = {
  claude: "claude",
  codex: "codex",
  opencode: "opencode",
};

const BINARY_ENV: Record<Tool, string> = {
  claude: "CLAUDE_BIN",
  codex: "CODEX_BIN",
  opencode: "OPENCODE_BIN",
};

export interface LaunchOptions {
  tool: string;
  model?: string;
  profile?: string;
  args?: string[];
  printOnly?: boolean;
  dryRun?: boolean;
}

export interface LaunchPlan {
  tool: Tool;
  profile: Profile;
  model: string;
  binary: string;
  args: string[];
  applied: boolean;
  configPath?: string;
  restartHint: string;
}

/**
 * Resolve profile/model, write tool config, optionally spawn the native CLI.
 */
export async function launchTool(options: LaunchOptions): Promise<LaunchPlan> {
  if (!isTool(options.tool)) {
    throw new Error(
      `未知工具「${options.tool}」。可选：claude、codex、opencode`,
    );
  }
  const tool = options.tool;

  let { profile, model } = resolveLaunchTarget(tool, {
    model: options.model,
    profile: options.profile,
  });

  if (profile.models.default !== model) {
    if (!profile.models.list.includes(model)) {
      profile.models.list.push(model);
    }
    profile.models.default = model;
    saveProfile(tool, profile);
    profile = requireProfile(tool, profile.name);
  } else if (!profile.models.list.includes(model)) {
    profile.models.list.push(model);
    saveProfile(tool, profile);
    profile = requireProfile(tool, profile.name);
  }

  const result = await applyProfile(tool, profile);
  const binary = resolveBinary(tool);
  const args = options.args ?? [];

  const plan: LaunchPlan = {
    tool,
    profile,
    model,
    binary,
    args,
    applied: true,
    configPath: result.configPath,
    restartHint: result.restartHint,
  };

  if (options.dryRun || options.printOnly) {
    return plan;
  }

  const binPath = which(binary);
  if (!binPath) {
    throw new Error(
      `未找到可执行文件「${binary}」。请确认已安装，或设置环境变量 ${BINARY_ENV[tool]}=/path/to/${binary}`,
    );
  }

  // Announce before handing over the TTY
  console.error(`已切换 ${tool}/${profile.name} → ${model}`);
  console.error(
    `启动 ${binary}${args.length ? ` ${args.join(" ")}` : ""}`,
  );

  const code = await spawnInherited(binPath, args);
  process.exitCode = code ?? 1;
  return plan;
}

export function resolveLaunchTarget(
  tool: Tool,
  opts: { model?: string; profile?: string },
): { profile: Profile; model: string } {
  const profiles = listProfiles(tool);
  if (profiles.length === 0) {
    throw new Error(`暂无 ${tool} 供应商，请先：llms ${tool} provider`);
  }
  ensureDefaultProvider(tool);

  const modelQuery = opts.model?.trim() || undefined;
  let profile: Profile | null = null;

  if (opts.profile) {
    profile = requireProfile(tool, opts.profile);
  }

  if (!profile && modelQuery) {
    profile = findProfileForModel(profiles, modelQuery);
  }

  if (!profile) {
    profile = getActiveProfile(tool);
  }

  if (!profile) {
    profile = getDefaultProfile(tool);
  }

  if (!profile) {
    throw new Error(
      `未指定供应商。请使用 --profile <name>，或先：llms ${tool} provider`,
    );
  }

  let model = profile.models.default;

  if (modelQuery) {
    const inSelected = matchModel(profile.models.list, modelQuery);
    if (inSelected) {
      model = inSelected;
    } else if (!opts.profile) {
      const other = findProfileForModel(profiles, modelQuery);
      if (other) {
        profile = other;
        model = matchModel(other.models.list, modelQuery) || modelQuery;
      } else {
        model = modelQuery;
      }
    } else {
      model = modelQuery;
    }
  }

  return { profile, model };
}

export function findProfileForModel(
  profiles: Profile[],
  query: string,
): Profile | null {
  for (const profile of profiles) {
    if (matchModel(profile.models.list, query)) return profile;
  }
  return null;
}

export function matchModel(list: string[], query: string): string | null {
  if (list.includes(query)) return query;
  const ci = list.find((m) => m.toLowerCase() === query.toLowerCase());
  if (ci) return ci;
  const fuzzy = list.filter((m) => modelFuzzyEqual(m, query));
  if (fuzzy.length === 0) return null;
  fuzzy.sort((a, b) => a.length - b.length);
  return fuzzy[0]!;
}

/** glm5.2 ↔ glm-5.2 ↔ GLM5.2 */
export function modelFuzzyEqual(a: string, b: string): boolean {
  return normalizeModelId(a) === normalizeModelId(b);
}

export function normalizeModelId(id: string): string {
  return id.toLowerCase().replace(/[_\s./-]+/g, "");
}

export function resolveBinary(tool: Tool): string {
  const fromEnv = process.env[BINARY_ENV[tool]]?.trim();
  if (fromEnv) return fromEnv;
  return BINARY[tool];
}

export function which(command: string): string | null {
  if (command.includes("/") || command.includes("\\")) {
    return existsSync(command) ? command : null;
  }
  const pathEnv = process.env.PATH || "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (existsSync(candidate)) return candidate;
    for (const ext of [".cmd", ".exe", ".bat"]) {
      const win = candidate + ext;
      if (existsSync(win)) return win;
    }
  }
  return null;
}

function spawnInherited(
  binary: string,
  args: string[],
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: "inherit",
      env: process.env,
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });
}
