import { Command } from "commander";
import {
  ensureBridgeForProfile,
  isBridgeAlive,
  isPidRunning,
  readPid,
  runBridgeForeground,
  startBridgeDaemon,
  stopBridge,
} from "../bridge/manager.js";
import {
  bridgeBaseUrl,
  bridgeRootUrl,
  readBridgeState,
} from "../bridge/state.js";
import { parseBridgePort } from "../bridge/runtime.js";
import { DEFAULT_BRIDGE_HOST, DEFAULT_BRIDGE_PORT } from "../bridge/types.js";
import { getActiveProfile, resolveProfileOrThrow } from "../store/profiles.js";
import { isTool } from "../types.js";

export function registerBridgeCommand(program: Command): void {
  const bridge = program
    .command("bridge")
    .description(
      "本地协议适配桥：Codex Responses↔Chat、Claude Messages↔Chat（共用进程，按工具隔离上游）",
    );

  bridge
    .command("serve")
    .description("前台运行 bridge（守护进程由 use/launch 自动拉起）")
    .option("--host <host>", "监听地址", DEFAULT_BRIDGE_HOST)
    .option(
      "--port <port>",
      "监听端口",
      String(DEFAULT_BRIDGE_PORT),
    )
    .option("--allow-remote", "允许非回环监听（仍强制认证和限制）")
    .action(
      async (opts: { host: string; port: string; allowRemote?: boolean }) => {
        const port = parseBridgePort(opts.port);
        await runBridgeForeground(
          opts.host || DEFAULT_BRIDGE_HOST,
          port,
          Boolean(opts.allowRemote),
        );
      },
    );

  bridge
    .command("start")
    .description("后台启动 bridge")
    .option("--host <host>", "监听地址", DEFAULT_BRIDGE_HOST)
    .option("--port <port>", "监听端口", String(DEFAULT_BRIDGE_PORT))
    .option("--allow-remote", "允许非回环监听（仍强制认证和限制）")
    .action(
      async (opts: { host: string; port: string; allowRemote?: boolean }) => {
        const host = opts.host || DEFAULT_BRIDGE_HOST;
        const port = parseBridgePort(opts.port);
        const pid = await startBridgeDaemon(
          host,
          port,
          Boolean(opts.allowRemote),
        );
        for (let i = 0; i < 30; i++) {
          if (await isBridgeAlive()) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        if (!(await isBridgeAlive())) {
          throw new Error("bridge 启动失败，请尝试：llms bridge serve");
        }
        console.log(`bridge 已启动 pid=${pid} ${bridgeRootUrl()}`);
      },
    );

  bridge
    .command("stop")
    .description("停止 bridge")
    .action(async () => {
      const ok = await stopBridge();
      console.log(ok ? "已发送停止信号" : "没有正在运行的 bridge 进程");
    });

  bridge
    .command("status")
    .description("查看 bridge 状态")
    .option("--json", "JSON 输出")
    .action(async (opts: { json?: boolean }) => {
      const state = readBridgeState();
      const alive = await isBridgeAlive(state.host, state.port);
      const pid = state.pid || readPid();
      const summarize = (
        upstream: (typeof state.upstreams)["codex"],
      ) =>
        upstream
          ? {
              baseUrl: upstream.baseUrl,
              mode: upstream.mode,
              profile: upstream.profileName || null,
              hasKey: Boolean(upstream.apiKey),
            }
          : null;
      const data = {
        alive,
        host: state.host,
        port: state.port,
        rootUrl: bridgeRootUrl(state),
        codexBaseUrl: bridgeBaseUrl(state),
        pid,
        pidRunning: pid ? isPidRunning(pid) : false,
        upstreams: {
          codex: summarize(state.upstreams.codex),
          claude: summarize(state.upstreams.claude),
        },
      };
      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      console.log(`状态：${alive ? "运行中" : "未运行"}`);
      console.log(`根地址：${data.rootUrl}`);
      console.log(`Codex base：${data.codexBaseUrl}`);
      console.log(`PID：${pid ?? "-"}`);
      for (const tool of ["codex", "claude"] as const) {
        const u = data.upstreams[tool];
        if (u) {
          console.log(
            `${tool} 上游：${u.baseUrl}（${u.mode}） profile=${u.profile ?? "-"}`,
          );
        } else {
          console.log(`${tool} 上游：未配置`);
        }
      }
    });

  bridge
    .command("reload")
    .description("用当前启用的 profile 刷新某一侧上游（不重启进程）")
    .argument("[tool]", "claude 或 codex（默认 codex）", "codex")
    .option("--profile <name>", "指定 profile")
    .action(async (toolArg: string, opts: { profile?: string }) => {
      const toolName = toolArg || "codex";
      if (!isTool(toolName) || (toolName !== "codex" && toolName !== "claude")) {
        throw new Error("tool 只能是 claude 或 codex");
      }
      const tool = toolName as "claude" | "codex";
      const profile = opts.profile
        ? resolveProfileOrThrow(tool, opts.profile)
        : getActiveProfile(tool);
      if (!profile) {
        throw new Error(`没有可用的 ${tool} profile`);
      }
      const connection = await ensureBridgeForProfile(profile, tool);
      console.log(
        `已刷新 ${tool} 上游 ${profile.name} → bridge ${connection.baseUrl}`,
      );
    });
}
