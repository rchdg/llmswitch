import { Command } from "commander";
import { pickSetupTool, runToolFlow } from "./setup-cmd.js";

/** 无子命令时：选择工具 → 连贯启动（未配置则自动引导）。 */
export function registerHomeCommand(program: Command): void {
  program.action(async () => {
    const tool = await pickSetupTool();
    await runToolFlow(tool);
  });
}
