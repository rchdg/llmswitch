import { Command } from "commander";
import { TOOLS, isTool } from "../types.js";
import { pickSetupTool, runToolFlow } from "./setup-cmd.js";

/**
 * 无子命令时：选择工具 → 连贯启动（未配置则自动引导）。
 *
 * 这里额外声明一个可选位置参数，专门用来接住不匹配任何子命令的输入。
 * 若不声明，commander 会把 `llms nosuchcmd` 报成「too many arguments,
 * expected 0 arguments」——既看不出是命令拼错，也无法给出可用命令提示。
 */
export function registerHomeCommand(program: Command): void {
  program
    .argument("[command]", `子命令或工具名：${TOOLS.join(" | ")}（省略则交互选择）`)
    .action(async (commandArg?: string) => {
      if (commandArg) {
        // 能走到这里说明它没匹配上任何已注册子命令。
        if (!isTool(commandArg)) {
          throw new Error(
            `未知命令「${commandArg}」。工具可选：${TOOLS.join("、")}；` +
              `完整命令列表：llms --help`,
          );
        }
        await runToolFlow(commandArg);
        return;
      }
      const tool = await pickSetupTool();
      await runToolFlow(tool);
    });
}
