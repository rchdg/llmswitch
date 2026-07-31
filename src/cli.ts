import { Command } from "commander";
import { TOOLS } from "./types.js";
import { registerToolCommand } from "./commands/tool.js";
import { registerLaunchCommand } from "./commands/launch-cmd.js";
import { registerBridgeCommand } from "./commands/bridge-cmd.js";
import { registerSetupCommand } from "./commands/setup-cmd.js";
import { registerHomeCommand } from "./commands/home-cmd.js";
import { getAppConfigRoot } from "./utils/paths.js";
import { getVersion } from "./utils/version.js";

export function createProgram(): Command {
  const program = new Command();

  program
    .name("llms")
    .description(
      "为 Claude Code / Codex / OpenCode 切换供应商、模型与上游代理",
    )
    .version(getVersion())
    .option("--json", "部分命令支持 JSON 输出（见子命令）");

  program
    .command("path")
    .description("显示 llm-switch 本地配置目录")
    .action(() => {
      console.log(getAppConfigRoot());
    });

  registerLaunchCommand(program);
  registerBridgeCommand(program);
  registerSetupCommand(program);

  for (const tool of TOOLS) {
    registerToolCommand(program, tool);
  }

  registerHomeCommand(program);

  program.configureOutput({
    writeErr: (str) => process.stderr.write(str),
  });

  program.addHelpText(
    "afterAll",
    "\n反馈与建议：rchdg50@gmail.com\nGitHub Issues：https://github.com/rchdg/llmswitch/issues\n",
  );

  return program;
}

export async function run(argv = process.argv): Promise<void> {
  const program = createProgram();
  program.exitOverride();
  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err.code === "commander.helpDisplayed" ||
        err.code === "commander.version")
    ) {
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`错误：${message}`);
    process.exitCode = 1;
  }
}
