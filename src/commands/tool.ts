import { Command } from "commander";
import * as p from "@clack/prompts";
import type { Tool } from "../types.js";
import { API_FORMATS, isApiFormat, supportsSmallModel } from "../types.js";
import { applyProfile, deactivateProfile } from "../adapters/index.js";
import { formatLabel } from "../formats/compatibility.js";
import { ensureBridgeForProfile, profileNeedsBridge } from "../bridge/manager.js";
import { PRESET_IDS } from "../presets/index.js";
import {
  deleteProfile,
  ensureDefaultProvider,
  getActiveProfile,
  getDefaultProfile,
  listProfiles,
  normalizeFallbackNames,
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
  requireInteractive,
  resolveModelsInteractive,
} from "./prompts.js";
import type { Profile } from "../types.js";

export function registerToolCommand(program: Command, tool: Tool): void {
  const cmd = program
    .command(tool)
    .description(`管理 ${tool} 的供应商与模型配置`);

  // llms <tool>（无子命令）：连贯启动，未配置时自动引导
  cmd.action(() => runToolFlow(tool));

  const provider = cmd
    .command("provider")
    .description("管理模型供应商：添加 / 默认 / 启用禁用 / 查看 / 编辑 / 删除")
    .option("--json", "以 JSON 列出全部供应商后退出")
    .action(async (opts: { json?: boolean }) => {
      ensureDefaultProvider(tool);
      if (opts.json) {
        printProviderList(tool);
        return;
      }
      await runProviderManager(tool);
    });

  // 非交互入口：脚本 / CI 里也要能增删查，不必走菜单。
  provider
    .command("list")
    .description("列出全部供应商")
    .option("--json", "JSON 输出")
    .action((opts: { json?: boolean }) => {
      ensureDefaultProvider(tool);
      if (opts.json) {
        printProviderList(tool);
        return;
      }
      const profiles = listProfiles(tool);
      if (profiles.length === 0) {
        console.log(`当前没有 ${tool} 供应商。添加：llms ${tool} provider add --help`);
        return;
      }
      const active = getActiveProfile(tool)?.name ?? null;
      const defaultName = getDefaultProfile(tool)?.name ?? null;
      for (const profile of profiles) {
        console.log(
          formatProfileListLabel(profile, { defaultName, activeName: active }) +
            `  ${formatLabel(profile.apiFormat)}  ${profile.models.default}`,
        );
      }
    });

  provider
    .command("add")
    .description("非交互添加供应商（参数齐全时不会进入任何提示）")
    .option("--preset <id>", `预设：${PRESET_IDS.join(" | ")}`, "custom")
    .option("--base-url <url>", "API Base URL")
    .option("--api-key <key>", "API Key（可留空）")
    .option("--name <name>", "供应商标识（省略则自动生成 5 位随机名）")
    .option("--display-name <name>", "显示名称")
    .option("--format <format>", `接口格式：${API_FORMATS.join(" | ")}（省略则自动探测）`)
    .option("--model <id>", "默认模型 ID")
    .option("--models <list>", "启用模型列表，逗号分隔（省略则取上游全部）")
    .option(
      "--small <model>",
      "轻量小模型（仅 claude / opencode 支持）",
    )
    .option("--proxy <url>", "上游代理地址")
    .option("--no-enable", "只保存，不写入工具配置")
    .option("--json", "JSON 输出")
    .action(async (opts: ProviderAddOptions) => {
      if (opts.format && !isApiFormat(opts.format)) {
        throw new Error(
          `无效的 --format「${opts.format}」。可选：${API_FORMATS.join("、")}`,
        );
      }
      if (!process.stdin.isTTY) {
        if (!opts.baseUrl) {
          throw new Error("非交互模式下必须提供 --base-url");
        }
        if (!opts.model) {
          throw new Error("非交互模式下必须提供 --model");
        }
      }
      if (opts.small && !supportsSmallModel(tool)) {
        throw new Error(`${tool} 不支持小模型配置`);
      }

      const created = await promptProfileDraft(tool, {
        preset: opts.preset,
        baseUrl: opts.baseUrl,
        apiKey: opts.apiKey ?? (process.stdin.isTTY ? undefined : ""),
        name: opts.name,
        displayName: opts.displayName,
        apiFormat: opts.format && isApiFormat(opts.format) ? opts.format : undefined,
        model: opts.model,
        models: opts.models ? splitCommaList(opts.models) : undefined,
        smallModel: opts.small ?? (process.stdin.isTTY ? undefined : null),
        proxy: opts.proxy ?? (process.stdin.isTTY ? undefined : ""),
      });

      ensureDefaultProvider(tool);
      let configPath: string | undefined;
      if (opts.enable !== false) {
        const result = await applyProfile(tool, created);
        configPath = result.configPath;
      }
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              ...publicProfileView(created),
              enabled: opts.enable !== false,
              configPath: configPath ?? null,
            },
            null,
            2,
          ),
        );
        return;
      }
      console.log(`已添加 ${tool}/${created.name}（${created.displayName}）`);
      if (configPath) console.log(`已启用，配置文件：${configPath}`);
      else console.log(`未启用。启用：llms ${tool} use ${created.name}`);
    });

  provider
    .command("rm")
    .alias("remove")
    .description("删除供应商（若已启用会先禁用）")
    .argument("<name>", "供应商名称或显示名称")
    .option("--yes", "跳过确认")
    .action(async (name: string, opts: { yes?: boolean }) => {
      const profile = resolveProfileOrThrow(tool, name);
      if (!opts.yes) {
        requireInteractive(
          "删除确认",
          `确认无误可加 --yes：llms ${tool} provider rm ${profile.name} --yes`,
        );
        const ok = await p.confirm({
          message: `确认删除供应商「${profile.name}」？此操作不可恢复`,
          initialValue: false,
        });
        if (p.isCancel(ok)) {
          p.cancel("已取消");
          process.exit(0);
        }
        if (!ok) {
          console.log("已取消");
          return;
        }
      }
      if (getActiveProfile(tool)?.name === profile.name) {
        await deactivateProfile(tool, profile.name);
      }
      deleteProfile(tool, profile.name);
      console.log(`已删除 ${tool}/${profile.name}`);
    });

  cmd
    .command("use")
    .description("启用已有供应商（写入对应工具配置）")
    .argument("[name]", "供应商名称；省略则交互选择")
    .option(
      "--fallback <names...>",
      "备用供应商（主供应商 429/5xx/超时时按顺序切换，最多 3 个）",
    )
    .option("--json", "JSON 输出")
    .action(
      async (
        name: string | undefined,
        opts?: { json?: boolean; fallback?: string[] },
      ) => {
        ensureDefaultProvider(tool);
        const profileName = await resolveProfileName(tool, name);
        let profile = resolveProfileOrThrow(tool, profileName);

        // 交互模式下：启用前可选切换默认模型
        if (!opts?.json && process.stdin.isTTY) {
          profile = await maybePickDefaultModel(tool, profile);
        }

        if (opts?.fallback) {
          for (const fallbackName of opts.fallback) {
            if (fallbackName === profile.name) continue;
            resolveProfileOrThrow(tool, fallbackName);
          }
          profile = {
            ...profile,
            fallbacks: opts.fallback,
          };
          saveProfile(tool, profile);
        }

        const result = await applyProfile(tool, profile);
        if (opts?.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(`已启用 ${tool}/${profile.name}`);
        const chain = profile.fallbacks?.length
          ? `（故障转移：${profile.name} → ${profile.fallbacks.join(" → ")}）`
          : "";
        console.log(`配置文件：${result.configPath}${chain}`);
        if (result.backupPath) console.log(`备份：${result.backupPath}`);
        console.log(result.restartHint);

        if (process.stdin.isTTY) {
          await maybeLaunchNow(tool, profile);
        }
      });

  cmd
    .command("fallback")
    .description("查看或管理故障转移备用链（主供应商失败时自动切换）")
    .argument("[action]", "add <name> | remove <name> | clear；省略则查看")
    .argument("[name]", "备用供应商名称")
    .option("--json", "JSON 输出")
    .action(
      async (
        action: string | undefined,
        name: string | undefined,
        opts: { json?: boolean },
      ) => {
        ensureDefaultProvider(tool);
        const active = getActiveProfile(tool);
        if (!active) {
          throw new Error(
            `没有已启用的 ${tool} profile。先执行 llms ${tool} use。`,
          );
        }

        if (!action) {
          const chain = active.fallbacks ?? [];
          if (opts.json) {
            console.log(JSON.stringify({ profile: active.name, fallbacks: chain }, null, 2));
            return;
          }
          if (chain.length === 0) {
            console.log(`${active.name} 当前没有备用供应商。`);
            console.log(`添加：llms ${tool} fallback add <name>`);
            return;
          }
          console.log(`${active.name} 的故障转移链：`);
          chain.forEach((fallbackName, index) => {
            console.log(`  ${index === 0 ? "主" : `备${index}`} → ${fallbackName}`);
          });
          return;
        }

        if (action === "clear") {
          saveProfile(tool, { ...active, fallbacks: [] });
          console.log(`已清空 ${active.name} 的备用链。`);
          await maybeReloadBridge(tool, active.name);
          return;
        }

        if (!name) {
          throw new Error(`用法：llms ${tool} fallback ${action} <name>`);
        }

        if (action === "add") {
          const fallbackProfile = resolveProfileOrThrow(tool, name);
          if (fallbackProfile.name === active.name) {
            throw new Error("备用供应商不能是当前启用的供应商本身。");
          }
          const chain = normalizeFallbackNames(active.name, [
            ...(active.fallbacks ?? []),
            fallbackProfile.name,
          ]);
          saveProfile(tool, { ...active, fallbacks: chain });
          console.log(
            chain?.includes(fallbackProfile.name)
              ? `已添加备用：${active.name} → ${(chain ?? []).join(" → ")}`
              : `备用链已满（最多 3 个）：${(active.fallbacks ?? []).join(" → ")}`,
          );
          await maybeReloadBridge(tool, active.name);
          return;
        }

        if (action === "remove") {
          const fallbackProfile = resolveProfileOrThrow(tool, name);
          const chain = (active.fallbacks ?? []).filter(
            (entry) => entry !== fallbackProfile.name,
          );
          saveProfile(tool, { ...active, fallbacks: chain });
          console.log(
            chain.length > 0
              ? `已移除，当前链：${active.name} → ${chain.join(" → ")}`
              : `已移除，${active.name} 没有备用供应商了。`,
          );
          await maybeReloadBridge(tool, active.name);
          return;
        }

        throw new Error(
          `未知操作「${action}」。可选：add / remove / clear。`,
        );
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
  requireInteractive(
    `llms ${tool} provider 的管理菜单`,
    `请在终端中运行，或改用：llms ${tool} provider --json 列出、` +
      `llms ${tool} provider add --base-url … 添加、llms ${tool} use <name> 启用。`,
  );
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

    // 任一增删改查动作执行完即结束；仅「返回列表」会回到上面的列表
    const outro = await handleProviderActions(tool, selected);
    if (outro !== BACK_TO_LIST) {
      p.outro(outro);
      return;
    }
  }
}

/** handleProviderActions 的哨兵返回值：回到供应商列表而不是退出。 */
const BACK_TO_LIST = Symbol("back-to-list");

/**
 * 单个供应商的动作菜单。执行完一个动作即返回 outro 文案由调用方结束流程；
 * 只有显式「返回列表」或供应商已不存在时才返回 BACK_TO_LIST。
 */
async function handleProviderActions(
  tool: Tool,
  profileName: string,
): Promise<string | typeof BACK_TO_LIST> {
  ensureDefaultProvider(tool);
  let profile: Profile;
  try {
    profile = requireProfile(tool, profileName);
  } catch {
    p.log.warn(`「${profileName}」已不存在`);
    return BACK_TO_LIST;
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

  if (action === "back") return BACK_TO_LIST;

  if (action === "default") {
    setDefaultProfile(tool, profile.name);
    p.log.success(`已将「${profile.name}」设为默认供应商`);
    return "已设置默认供应商";
  }

  if (action === "toggle") {
    if (isActive) {
      const result = await deactivateProfile(tool, profile.name);
      p.log.success(`已禁用「${profile.name}」`);
      p.log.info(`配置文件：${result.configPath}`);
      p.log.info(result.restartHint);
      return "已禁用供应商";
    }
    const result = await applyProfile(tool, profile);
    p.log.success(`已启用「${profile.name}」`);
    p.log.info(`配置文件：${result.configPath}`);
    if (result.backupPath) p.log.info(`备份：${result.backupPath}`);
    p.log.info(result.restartHint);
    return "已启用供应商";
  }

  if (action === "view") {
    printProfileDetails(tool, profile, { isActive, isDefault });
    return "已退出供应商管理";
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
    return "编辑完成";
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
    // 放弃删除：回到该供应商的动作菜单，而不是直接退出
    if (!ok) return handleProviderActions(tool, profileName);
    if (isActive) {
      await deactivateProfile(tool, profile.name);
    }
    deleteProfile(tool, profile.name);
    p.log.success(`已删除「${profile.name}」`);
    return "已删除供应商";
  }

  return BACK_TO_LIST;
}

async function handleProviderAdd(tool: Tool): Promise<void> {
  const previous = getActiveProfile(tool)?.name ?? null;
  const created = await promptProfileDraft(tool);
  ensureDefaultProvider(tool);
  // 静默启用：不再询问，用户可在 provider 菜单中关闭
  const result = await applyProfile(tool, created);
  p.log.success(
    `已启用 ${tool}/${created.name}（${created.displayName || created.name}）`,
  );
  // 添加即启用会覆盖工具当前生效的供应商，必须说清楚被换掉的是哪个。
  if (previous && previous !== created.name) {
    p.log.warn(
      `${tool} 原先启用的是「${previous}」，已被替换。恢复：llms ${tool} use ${previous}`,
    );
  }
  p.log.info(`配置文件：${result.configPath}`);
  p.log.info(result.restartHint);
}

interface ProviderAddOptions {
  preset?: string;
  baseUrl?: string;
  apiKey?: string;
  name?: string;
  displayName?: string;
  format?: string;
  model?: string;
  models?: string;
  small?: string;
  proxy?: string;
  /** commander 的 --no-enable 会把 enable 置为 false */
  enable?: boolean;
  json?: boolean;
}

function splitCommaList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function printProviderList(tool: Tool): void {
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

  // 纯文本而不是 clack 的方框：一是这里的输出经常被管道/重定向消费，
  // 二是方框宽度按码点算，中文行会把右边框顶歪。
  const lines = [
    `标识：${view.name}`,
    `显示名：${view.displayName}`,
    `状态：${status.join(" · ")}`,
    `格式：${formatLabel(view.apiFormat)}`,
    `Base URL：${view.baseUrl}`,
    `API Key：${view.apiKey}`,
    `默认模型：${view.models.default}`,
    supportsSmallModel(tool)
      ? `小模型：${view.models.smallModel || "（未设置，沿用默认模型）"}`
      : null,
    `模型列表：${view.models.list.join(", ") || "（空）"}`,
    `代理：${formatProxySummary(profile.proxy)}`,
    profile.bridgeMode === "completions"
      ? "上游接口：Completions"
      : profile.bridgeMode === "chat"
        ? "上游接口：Chat Completions"
        : null,
    `更新时间：${view.updatedAt}`,
  ].filter((line): line is string => Boolean(line));

  console.log(`[${flags.title || `${tool} / ${profile.name}`}]`);
  for (const line of lines) console.log(`  ${line}`);
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
/**
 * After a fallback-chain change: if the touched profile is active and goes
 * through the bridge, push the new candidate list without a full re-apply.
 */
async function maybeReloadBridge(
  tool: Tool,
  profileName: string,
): Promise<void> {
  const active = getActiveProfile(tool);
  if (!active || active.name !== profileName) return;
  if (!profileNeedsBridge(active)) return;
  try {
    const connection = await ensureBridgeForProfile(active, tool);
    console.log(`bridge 上游已刷新 → ${connection.baseUrl}`);
  } catch (err) {
    console.warn(
      `bridge 刷新失败（稍后 llms bridge reload ${tool} 可重试）：${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

async function maybeLaunchNow(tool: Tool, profile: Profile): Promise<void> {  const launch = await p.confirm({
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
  opts: { fixedSmall?: string | null } = {},
): Promise<void> {
  p.log.step(`配置 ${profile.displayName || profile.name} 的模型`);
  const resolved = await resolveModelsInteractive({
    apiFormat: profile.apiFormat,
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    proxy: profile.proxy,
    preferredDefault: profile.models.default,
    preferredList: profile.models.list,
    supportsSmall: supportsSmallModel(tool),
    preferredSmall: profile.models.smallModel,
    fixedSmall: opts.fixedSmall,
  });

  profile.models.default = resolved.defaultModel;
  profile.models.smallModel = resolved.smallModel;
  profile.models.list = resolved.modelList;
  profile.models.meta = resolved.modelMeta;
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

  const smallNote = resolved.smallModel
    ? `，小模型「${resolved.smallModel}」`
    : "";
  const active = getActiveProfile(tool);
  if (active?.name === profile.name) {
    await applyProfile(tool, requireProfile(tool, profile.name));
    p.log.success(
      `已更新模型并写入工具配置：默认「${resolved.defaultModel}」${smallNote}，共 ${resolved.modelList.length} 个`,
    );
  } else {
    p.log.success(
      `已更新模型：默认「${resolved.defaultModel}」${smallNote}，共 ${resolved.modelList.length} 个。启用：llms ${tool} use ${profile.name}`,
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

  requireInteractive(
    "选择供应商",
    `请改用 llms ${tool} use <name>（现有：${profiles.map((x) => x.name).join(", ")}）。`,
  );

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
  const cmd = parent
    .command("model")
    .description("先选供应商，再拉取并选择要启用的模型（空格多选，回车确认）")
    .option("--profile <name>", "指定供应商，跳过列表选择")
    .option("--json", "JSON 输出");

  if (supportsSmallModel(tool)) {
    cmd.option(
      "--small <model>",
      "轻量小模型（标题生成等低成本任务）；跳过交互选择，传空字符串则清除",
    );
  }

  cmd.action(
    async (opts: { profile?: string; json?: boolean; small?: string }) => {
      requireInteractive(
        `llms ${tool} model 的模型选择`,
        `请在终端中运行，或用 llms ${tool} provider add --model <id> 直接指定。`,
      );
      p.intro(`配置 ${tool} 模型`);

      const profile = opts.profile
        ? resolveProfileOrThrow(tool, opts.profile)
        : requireProfile(tool, await resolveProfileName(tool));

      await configureProfileModels(tool, profile, {
        // undefined → 交互询问；"" → 清除；其他 → 直接采用
        fixedSmall: opts.small === undefined ? undefined : opts.small || null,
      });

      if (opts.json) {
        const latest = requireProfile(tool, profile.name);
        console.log(
          JSON.stringify(
            {
              profile: latest.name,
              default: latest.models.default,
              small: latest.models.smallModel ?? null,
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
    },
  );
}
