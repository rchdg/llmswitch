import { Command } from "commander";
import * as p from "@clack/prompts";
import type { Tool } from "../types.js";
import { TOOLS, isTool } from "../types.js";
import { applyProfile } from "../adapters/index.js";
import {
  ensureDefaultProvider,
  getActiveProfile,
  listProfiles,
  requireProfile,
} from "../store/profiles.js";
import { exitOnCancel, formatProfileListLabel, promptProfileDraft } from "./prompts.js";
import { launchTool, resolveBinary, which } from "./launch.js";

const TOOL_LABEL: Record<Tool, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .alias("init")
    .description(
      "引导式初始化：选择工具 → 添加供应商 → 选择模型 → 启用 → 启动",
    )
    .option("-t, --tool <tool>", "跳过工具选择，直接为指定工具引导")
    .option("--json", "以 JSON 输出引导结果")
    .action(async (opts: { tool?: string; json?: boolean }) => {
      if (opts.tool && !isTool(opts.tool)) {
        throw new Error(`未知工具「${opts.tool}」。可选：${TOOLS.join(", ")}`);
      }
      const tool: Tool =
        opts.tool !== undefined && isTool(opts.tool)
          ? opts.tool
          : await pickSetupTool();
      const result = await runSetupWizard(tool);
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      p.outro(
        `${TOOL_LABEL[tool]} 配置完成。下次直接启动：llms launch ${tool}`,
      );
    });
}

/** 工具选择：只列出已安装的工具；仅装一个时自动选中。 */
export async function pickSetupTool(): Promise<Tool> {
  const installed = TOOLS.filter(
    (tool) => which(resolveBinary(tool)) !== null,
  );

  if (installed.length === 1) {
    p.log.info(`检测到已安装 ${TOOL_LABEL[installed[0]]}，直接进入配置。`);
    return installed[0]!;
  }

  const selected = await p.select({
    message: "选择要配置的工具",
    options: TOOLS.map((tool) => ({
      value: tool,
      label: TOOL_LABEL[tool],
      hint: installed.includes(tool)
        ? "已安装"
        : "未检测到（启动前需安装或设置 *_BIN）",
    })),
    initialValue: installed[0] ?? TOOLS[0],
  });
  exitOnCancel(selected);
  return selected;
}

export interface SetupResult {
  tool: Tool;
  profile: string;
  defaultModel: string;
  enabled: boolean;
  launched: boolean;
  configPath: string;
}

/**
 * 连贯启动流程：
 * - 已有供应商 → 直接启动（当前启用 / 默认供应商）。
 * - 无供应商 → 自动引导：添加供应商 → 选择模型 → 静默启用 → 自动启动。
 */
export async function runToolFlow(tool: Tool): Promise<void> {
  const profiles = listProfiles(tool);

  if (profiles.length === 0) {
    if (!process.stdin.isTTY) {
      throw new Error(`暂无 ${tool} 供应商，请先：llms ${tool} provider`);
    }
    p.log.step("尚未配置供应商，开始引导。");
    const created = await promptProfileDraft(tool);
    ensureDefaultProvider(tool);
    try {
      await launchTool({ tool, profile: created.name });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      p.log.error(msg);
      p.log.warn(
        `供应商「${created.name}」已保存并启用。可用：llms launch ${tool}，或设置 ${tool.toUpperCase()}_BIN 指定可执行文件。`,
      );
    }
    return;
  }

  try {
    await launchTool({ tool });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    p.log.error(msg);
    p.log.warn(
      `可用：llms launch ${tool} [模型]，或设置 ${tool.toUpperCase()}_BIN 指定可执行文件。`,
    );
  }
}

/**
 * 引导式初始化：添加（或复用）供应商 → 启用 → 可选启动。
 * 内部复用 provider / model / use / launch 的既有逻辑。
 */
export async function runSetupWizard(tool: Tool): Promise<SetupResult> {
  p.intro(`初始化 ${TOOL_LABEL[tool]}`);

  const existing = listProfiles(tool);
  let profileName: string;

  if (existing.length > 0) {
    const choice = await p.select({
      message: "检测到已有供应商配置，如何继续？",
      options: [
        {
          value: "add",
          label: "添加新供应商",
          hint: "重新走一遍引导",
        },
        {
          value: "use",
          label: "使用现有供应商",
          hint: "直接启用并启动",
        },
      ],
      initialValue: "add",
    });
    exitOnCancel(choice);

    if (choice === "use") {
      const active = getActiveProfile(tool)?.name ?? null;
      const defaultName = ensureDefaultProvider(tool);
      const picked = await p.select({
        message: "选择要启用的供应商",
        options: existing.map((profile) => ({
          value: profile.name,
          label: formatProfileListLabel(profile, {
            defaultName,
            activeName: active,
          }),
        })),
        initialValue: active || defaultName || existing[0]!.name,
      });
      exitOnCancel(picked);
      profileName = picked;
    } else {
      profileName = (await promptProfileDraft(tool)).name;
    }
  } else {
    profileName = (await promptProfileDraft(tool)).name;
  }

  ensureDefaultProvider(tool);
  const profile = requireProfile(tool, profileName);

  // 静默启用：不再询问，用户可在 provider 菜单中关闭
  const applied = await applyProfile(tool, profile);
  p.log.success(
    `已启用 ${tool}/${profile.name}（${profile.displayName || profile.name}），默认模型 ${profile.models.default}`,
  );
  p.log.info(`配置文件：${applied.configPath}`);
  p.log.info(applied.restartHint);

  const result: SetupResult = {
    tool,
    profile: profile.name,
    defaultModel: profile.models.default,
    enabled: true,
    launched: false,
    configPath: applied.configPath,
  };

  const launch = await p.confirm({
    message: `是否立即启动 ${TOOL_LABEL[tool]}？`,
    initialValue: true,
  });
  if (p.isCancel(launch)) {
    p.cancel("已取消");
    process.exit(0);
  }
  if (launch) {
    try {
      const plan = await launchTool({ tool, profile: profile.name });
      result.launched = true;
      result.configPath = plan.configPath || result.configPath;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      p.log.error(msg);
      p.log.warn(
        `未能启动。稍后可用：llms launch ${tool}，或设置 ${tool.toUpperCase()}_BIN 指定可执行文件。`,
      );
    }
  }

  p.outro(`已就绪：llms launch ${tool}`);
  return result;
}
