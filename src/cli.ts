import { Command } from "commander";
import { TOOLS } from "./types.js";
import { registerToolCommand } from "./commands/tool.js";
import { registerLaunchCommand } from "./commands/launch-cmd.js";
import { registerBridgeCommand } from "./commands/bridge-cmd.js";
import { registerGatewayCommand } from "./commands/gateway-cmd.js";
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
    // 注意：不要在根命令上声明 --json。commander 会把它当作根命令的选项，
    // 从而吞掉所有子命令自己的 --json（子命令 opts.json 恒为 undefined）。
    // JSON 输出一律由各子命令自行声明。
    .showSuggestionAfterError();

  program
    .command("path")
    .description("显示 llm-switch 本地配置目录")
    .action(() => {
      console.log(getAppConfigRoot());
    });

  registerLaunchCommand(program);
  registerBridgeCommand(program);
  registerGatewayCommand(program);
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
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code)
        : "";
    if (
      code === "commander.helpDisplayed" ||
      code === "commander.help" ||
      code === "commander.version"
    ) {
      return;
    }
    // commander 已经把用法错误写到 stderr 了，不要再加「错误：」重复打印一遍。
    if (code.startsWith("commander.")) {
      process.exitCode =
        typeof (err as { exitCode?: unknown }).exitCode === "number"
          ? (err as { exitCode: number }).exitCode
          : 1;
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`错误：${message}`);
    process.exitCode = 1;
  }
}
