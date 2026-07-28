import { Command } from "commander";
import { isTool, TOOLS } from "../types.js";
import {
  launchTool,
  resolveBinary,
  resolveLaunchTarget,
} from "./launch.js";

/**
 * ollama-like quick start:
 *   llms launch codex --model gpt-4.1
 *   llms launch codex gpt-4.1
 *   llms run claude --profile my-provider
 *   llms launch opencode my-model -- resume
 */
export function registerLaunchCommand(program: Command): void {
  program
    .command("launch")
    .alias("run")
    .description(
      "切换模型并启动对应 CLI（类似 ollama run）。例：llms launch codex --model gpt-4.1",
    )
    .argument("<tool>", `目标工具：${TOOLS.join(" | ")}`)
    .argument(
      "[parts...]",
      "可选：模型 ID，以及传给底层 CLI 的参数",
    )
    .option("-m, --model <id>", "要启用的模型 ID")
    .option(
      "-p, --profile <name>",
      "指定 profile（默认：包含该模型的 profile / 当前启用）",
    )
    .option("--print-only", "只写入配置，不启动 CLI")
    .option("--dry-run", "只打印计划，不写配置、不启动")
    .option("--json", "JSON 输出")
    .action(
      async (
        toolArg: string,
        parts: string[] = [],
        opts: {
          model?: string;
          profile?: string;
          printOnly?: boolean;
          dryRun?: boolean;
          json?: boolean;
        },
      ) => {
        if (!isTool(toolArg)) {
          throw new Error(
            `未知工具「${toolArg}」。可选：${TOOLS.join(", ")}`,
          );
        }

        let model = opts.model?.trim() || undefined;
        const queue = [...parts];
        if (!model && queue[0] && !queue[0].startsWith("-")) {
          model = queue.shift();
        }
        const passthrough = queue;

        if (opts.dryRun) {
          const target = resolveLaunchTarget(toolArg, {
            model,
            profile: opts.profile,
          });
          const plan = {
            tool: toolArg,
            profile: target.profile.name,
            model: target.model,
            binary: resolveBinary(toolArg),
            args: passthrough,
            dryRun: true,
          };
          if (opts.json) {
            console.log(JSON.stringify(plan, null, 2));
          } else {
            const argStr = passthrough.length
              ? ` ${passthrough.join(" ")}`
              : "";
            console.log(
              `[dry-run] 启用 ${toolArg}/${plan.profile} → ${plan.model}，然后执行：${plan.binary}${argStr}`,
            );
          }
          return;
        }

        const plan = await launchTool({
          tool: toolArg,
          model,
          profile: opts.profile,
          args: passthrough,
          printOnly: opts.printOnly,
        });

        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                tool: plan.tool,
                profile: plan.profile.name,
                model: plan.model,
                binary: plan.binary,
                args: plan.args,
                configPath: plan.configPath,
                applied: plan.applied,
                printOnly: Boolean(opts.printOnly),
              },
              null,
              2,
            ),
          );
          return;
        }

        // When actually spawning, launchTool already printed status before exec.
        if (opts.printOnly) {
          console.error(
            `已切换 ${plan.tool}/${plan.profile.name} → ${plan.model}`,
          );
          console.error(plan.restartHint);
          console.error(
            `未启动 CLI（--print-only）。手动运行：${plan.binary}`,
          );
        }
      },
    );
}
