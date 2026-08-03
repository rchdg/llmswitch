import { Command } from "commander";
import * as p from "@clack/prompts";
import type { Tool } from "../types.js";
import { applyProfile, deactivateProfile } from "../adapters/index.js";
import { formatLabel } from "../formats/compatibility.js";
import {
  deleteProfile,
  ensureDefaultProvider,
  getActiveProfile,
  getDefaultProfile,
  listProfiles,
  publicProfileView,
  requireProfile,
  resolveProfileOrThrow,
  saveProfile,
  setDefaultProfile,
} from "../store/profiles.js";
import { formatProxySummary } from "../utils/proxy.js";
import { runToolFlow } from "./setup-cmd.js";
import { launchTool } from "./launch.js";
import {
  exitOnCancel,
  formatProfileListLabel,
  promptEditProfile,
  promptProfileDraft,
  resolveModelsInteractive,
} from "./prompts.js";
import type { Profile } from "../types.js";

export function registerToolCommand(program: Command, tool: Tool): void {
  const cmd = program
    .command(tool)
    .description(`管理 ${tool} 的供应商与模型配置`);

  // llms <tool>（无子命令）：连贯启动，未配置时自动引导
  cmd.action(() => runToolFlow(tool));

  cmd
    .command("provider")
    .description("管理模型供应商：添加 / 默认 / 启用禁用 / 查看 / 编辑 / 删除")
    .option("--json", "以 JSON 列出全部供应商后退出")
    .action(async (opts: { json?: boolean }) => {
      ensureDefaultProvider(tool);
      if (opts.json) {
        const active = getActiveProfile(tool)?.name ?? null;
        const defaultName = getDefaultProfile(tool)?.name ?? null;
        console.log(
          JSON.stringify(
            listProfiles(tool).map((profile) => ({
              ...publicProfileView(profile),
              active: profile.name === active,
              default: profile.name === defaultName,
            })),
            null,
            2,
          ),
        );
        return;
      }
      await runProviderManager(tool);
    });

  cmd
    .command("use")
    .description("启用已有供应商（写入对应工具配置）")
    .argument("[name]", "供应商名称；省略则交互选择")
    .option("--json", "JSON 输出")
    .action(async (name?: string, opts?: { json?: boolean }) => {
      ensureDefaultProvider(tool);
      const profileName = await resolveProfileName(tool, name);
      let profile = resolveProfileOrThrow(tool, profileName);

      // 交互模式下：启用前可选切换默认模型
      if (!opts?.json && process.stdin.isTTY) {
        profile = await maybePickDefaultModel(tool, profile);
      }

      const result = await applyProfile(tool, profile);
      if (opts?.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`已启用 ${tool}/${profile.name}`);
      console.log(`配置文件：${result.configPath}`);
      if (result.backupPath) console.log(`备份：${result.backupPath}`);
      console.log(result.restartHint);

      if (process.stdin.isTTY) {
        await maybeLaunchNow(tool, profile);
      }
    });

  cmd
    .command("current")
    .description("查看默认与当前启用的供应商")
    .option("--json", "JSON 输出")
    .action((opts: { json?: boolean }) => {
      ensureDefaultProvider(tool);
      const active = getActiveProfile(tool);
      const defaultProfile = getDefaultProfile(tool);
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              default: defaultProfile ? publicProfileView(defaultProfile) : null,
              active: active ? publicProfileView(active) : null,
            },
            null,
            2,
          ),
        );
        return;
      }
      if (!defaultProfile && !active) {
        console.log(`当前没有 ${tool} 供应商`);
        console.log(`请先：llms ${tool} provider`);
        return;
      }
      if (defaultProfile) {
        printProfileDetails(tool, defaultProfile, {
          isActive: active?.name === defaultProfile.name,
          isDefault: true,
          title: "默认供应商",
        });
      }
      if (active && active.name !== defaultProfile?.name) {
        printProfileDetails(tool, active, {
          isActive: true,
          isDefault: false,
          title: "当前启用",
        });
      } else if (!active) {
        console.log("当前没有已启用的供应商（可用 provider 菜单启用）");
      }
    });

  registerModelCommands(cmd, tool);
}

async function runProviderManager(tool: Tool): Promise<void> {
  p.intro(`${tool} 模型供应商`);

  while (true) {
    ensureDefaultProvider(tool);
    const profiles = listProfiles(tool);
    const active = getActiveProfile(tool)?.name ?? null;
    const defaultName = getDefaultProfile(tool)?.name ?? null;

    const selected = await p.select({
      message: "选择供应商",
      options: [
        {
          value: "__new__",
          label: "添加新供应商",
          hint: "自定义 / OpenAI / Anthropic",
        },
        ...profiles.map((profile) => ({
          value: profile.name,
          // hint 仅高亮时可见，状态标在 label 上便于扫一眼认出默认项
          label: formatProfileListLabel(profile, {
            defaultName,
            activeName: active,
          }),
          hint: formatLabel(profile.apiFormat),
        })),
        {
          value: "__exit__",
          label: "退出",
        },
      ],
    });
    exitOnCancel(selected);

    if (selected === "__exit__") {
      p.outro("已退出供应商管理");
      return;
    }

    if (selected === "__new__") {
      await handleProviderAdd(tool);
      // 添加完成后直接结束，不再返回供应商列表
      p.outro("添加完成");
      return;
    }

    await handleProviderActions(tool, selected);
  }
}

async function handleProviderAdd(tool: Tool): Promise<void> {
  const created = await promptProfileDraft(tool);
  ensureDefaultProvider(tool);
  // 静默启用：不再询问，用户可在 provider 菜单中关闭
  const result = await applyProfile(tool, created);
  p.log.success(
    `已启用 ${tool}/${created.name}（${created.displayName || created.name}）`,
  );
  p.log.info(`配置文件：${result.configPath}`);
  p.log.info(result.restartHint);
}

async function handleProviderActions(
  tool: Tool,
  profileName: string,
): Promise<void> {
  while (true) {
    ensureDefaultProvider(tool);
    let profile: Profile;
    try {
      profile = requireProfile(tool, profileName);
    } catch {
      p.log.warn(`「${profileName}」已不存在`);
      return;
    }

    const isActive = getActiveProfile(tool)?.name === profile.name;
    const isDefault = getDefaultProfile(tool)?.name === profile.name;
    const action = await p.select({
      message: `${profile.displayName || profile.name}`,
      options: [
        {
          value: "default",
          label: "设置为默认供应商",
          hint: isDefault ? "当前已是默认" : undefined,
        },
        {
          value: "toggle",
          label: isActive ? "禁用" : "启用",
          hint: isActive ? "清除写入工具的配置" : "写入对应工具配置",
        },
        {
          value: "view",
          label: "查看配置",
        },
        {
          value: "edit",
          label: "编辑配置",
          hint: "显示名 / 地址 / 密钥 / 代理 / 格式",
        },
        {
          value: "delete",
          label: "删除配置",
          hint: isActive ? "将先禁用再删除" : undefined,
        },
        {
          value: "back",
          label: "返回列表",
        },
      ],
    });
    exitOnCancel(action);

    if (action === "back") return;

    if (action === "default") {
      setDefaultProfile(tool, profile.name);
      p.log.success(`已将「${profile.name}」设为默认供应商`);
      continue;
    }

    if (action === "toggle") {
      if (isActive) {
        const result = await deactivateProfile(tool, profile.name);
        p.log.success(`已禁用「${profile.name}」`);
        p.log.info(`配置文件：${result.configPath}`);
        p.log.info(result.restartHint);
      } else {
        const result = await applyProfile(tool, profile);
        p.log.success(`已启用「${profile.name}」`);
        p.log.info(`配置文件：${result.configPath}`);
        if (result.backupPath) p.log.info(`备份：${result.backupPath}`);
        p.log.info(result.restartHint);
      }
      continue;
    }

    if (action === "view") {
      printProfileDetails(tool, profile, { isActive, isDefault });
      continue;
    }

    if (action === "edit") {
      const updated = await promptEditProfile(tool, profile);
      if (getActiveProfile(tool)?.name === updated.name) {
        const sync = await p.confirm({
          message: "该供应商当前已启用，是否立即写回工具配置？",
          initialValue: true,
        });
        if (p.isCancel(sync)) {
          p.cancel("已取消");
          process.exit(0);
        }
        if (sync) {
          const result = await applyProfile(tool, updated);
          p.log.success("已同步写入工具配置");
          p.log.info(result.restartHint);
        }
      }
      continue;
    }

    if (action === "delete") {
      const ok = await p.confirm({
        message: `确认删除供应商「${profile.name}」？此操作不可恢复`,
        initialValue: false,
      });
      if (p.isCancel(ok)) {
        p.cancel("已取消");
        process.exit(0);
      }
      if (!ok) continue;
      if (isActive) {
        await deactivateProfile(tool, profile.name);
      }
      deleteProfile(tool, profile.name);
      p.log.success(`已删除「${profile.name}」`);
      return;
    }
  }
}

function printProfileDetails(
  tool: Tool,
  profile: Profile,
  flags: {
    isActive: boolean;
    isDefault: boolean;
    title?: string;
  },
): void {
  const view = publicProfileView(profile);
  const status: string[] = [];
  if (flags.isDefault) status.push("默认");
  if (flags.isActive) status.push("已启用");
  if (status.length === 0) status.push("未启用");

  p.note(
    [
      `标识：${view.name}`,
      `显示名：${view.displayName}`,
      `状态：${status.join(" · ")}`,
      `格式：${formatLabel(view.apiFormat)}`,
      `Base URL：${view.baseUrl}`,
      `API Key：${view.apiKey}`,
      `默认模型：${view.models.default}`,
      `模型列表：${view.models.list.join(", ") || "（空）"}`,
      `代理：${formatProxySummary(profile.proxy)}`,
      profile.bridgeMode === "completions"
        ? "上游接口：Completions"
        : profile.bridgeMode === "chat"
          ? "上游接口：Chat Completions"
          : null,
      `更新时间：${view.updatedAt}`,
    ]
      .filter(Boolean)
      .join("\n"),
    flags.title || `${tool} / ${profile.name}`,
  );
}

/**
 * 启用供应商前：若模型列表内有多个候选，交互选择默认模型；
 * 只有一个模型时直接跳过。支持手动输入不在列表中的模型 ID。
 */
async function maybePickDefaultModel(
  tool: Tool,
  profile: Profile,
): Promise<Profile> {
  const list = profile.models.list.length
    ? profile.models.list
    : [profile.models.default];

  if (list.length <= 1) return profile;

  const picked = await p.select({
    message: `选择 ${profile.displayName || profile.name} 的默认模型`,
    options: [
      ...list.map((model) => ({
        value: model,
        label: model,
        hint: model === profile.models.default ? "当前默认" : undefined,
      })),
      { value: "__manual__", label: "手动输入模型 ID" },
    ],
    initialValue: profile.models.default,
  });
  exitOnCancel(picked);

  let model = picked;
  if (picked === "__manual__") {
    const input = await p.text({
      message: "模型 ID",
      placeholder: profile.models.default,
    });
    if (p.isCancel(input) || !input.trim()) {
      p.cancel("已取消");
      process.exit(0);
    }
    model = input.trim();
  }

  if (model === profile.models.default) return profile;

  const updated: Profile = {
    ...profile,
    models: {
      ...profile.models,
      default: model,
      list: profile.models.list.includes(model)
        ? profile.models.list
        : [...profile.models.list, model],
    },
  };
  saveProfile(tool, updated);
  return requireProfile(tool, updated.name);
}

/** 启用完成后：询问是否立即启动该工具。 */
async function maybeLaunchNow(tool: Tool, profile: Profile): Promise<void> {
  const launch = await p.confirm({
    message: `是否现在启动 ${tool}？`,
    initialValue: true,
  });
  if (p.isCancel(launch)) {
    p.cancel("已取消");
    process.exit(0);
  }
  if (!launch) return;

  try {
    await launchTool({ tool, profile: profile.name });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    p.log.error(msg);
    p.log.warn(
      `未能启动。稍后可用：llms launch ${tool}，或设置 ${tool.toUpperCase()}_BIN 指定可执行文件。`,
    );
  }
}

async function configureProfileModels(
  tool: Tool,
  profile: Profile,
): Promise<void> {
  p.log.step(`配置 ${profile.displayName || profile.name} 的模型`);
  const resolved = await resolveModelsInteractive({
    apiFormat: profile.apiFormat,
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    proxy: profile.proxy,
    preferredDefault: profile.models.default,
    preferredList: profile.models.list,
  });

  profile.models.default = resolved.defaultModel;
  profile.models.list = resolved.modelList;
  if (
    resolved.resolvedBaseUrl &&
    resolved.resolvedBaseUrl !== profile.baseUrl
  ) {
    p.log.info(
      `已根据可用接口将 Base URL 规范为 ${resolved.resolvedBaseUrl}（原：${profile.baseUrl}）`,
    );
    profile.baseUrl = resolved.resolvedBaseUrl;
  }
  saveProfile(tool, profile);

  const active = getActiveProfile(tool);
  if (active?.name === profile.name) {
    await applyProfile(tool, requireProfile(tool, profile.name));
    p.log.success(
      `已更新模型并写入工具配置：默认「${resolved.defaultModel}」，共 ${resolved.modelList.length} 个`,
    );
  } else {
    p.log.success(
      `已更新模型：默认「${resolved.defaultModel}」，共 ${resolved.modelList.length} 个。启用：llms ${tool} use ${profile.name}`,
    );
  }
}

async function resolveProfileName(
  tool: Tool,
  name?: string,
): Promise<string> {
  if (name) {
    return resolveProfileOrThrow(tool, name).name;
  }

  ensureDefaultProvider(tool);
  const profiles = listProfiles(tool);
  if (profiles.length === 0) {
    throw new Error(`暂无 ${tool} 供应商。请先：llms ${tool} provider`);
  }

  const active = getActiveProfile(tool)?.name;
  const defaultName = getDefaultProfile(tool)?.name;
  const selected = await p.select({
    message: `选择 ${tool} 供应商`,
    options: profiles.map((profile) => ({
      value: profile.name,
      label: formatProfileListLabel(profile, {
        defaultName,
        activeName: active,
      }),
      hint: formatLabel(profile.apiFormat),
    })),
    initialValue: defaultName || active || profiles[0]!.name,
  });
  exitOnCancel(selected);
  return selected;
}

function registerModelCommands(parent: Command, tool: Tool): void {
  parent
    .command("model")
    .description("先选供应商，再拉取并选择要启用的模型（空格多选，回车确认）")
    .option("--profile <name>", "指定供应商，跳过列表选择")
    .option("--json", "JSON 输出")
    .action(async (opts: { profile?: string; json?: boolean }) => {
      p.intro(`配置 ${tool} 模型`);

      const profile = opts.profile
        ? resolveProfileOrThrow(tool, opts.profile)
        : requireProfile(tool, await resolveProfileName(tool));

      await configureProfileModels(tool, profile);

      if (opts.json) {
        const latest = requireProfile(tool, profile.name);
        console.log(
          JSON.stringify(
            {
              profile: latest.name,
              default: latest.models.default,
              models: latest.models.list,
              applied: getActiveProfile(tool)?.name === latest.name,
            },
            null,
            2,
          ),
        );
        return;
      }

      p.outro("模型配置完成");
    });
}
