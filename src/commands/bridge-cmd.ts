import { Command } from "commander";
import {
  bridgeToolForCliTool,
  ensureBridgeForProfile,
  isBridgeAlive,
  isPidRunning,
  profileNeedsBridge,
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
import { TOOLS, isTool } from "../types.js";
import type { BridgeLogEntry as BridgeLogEntryView } from "../bridge/logs.js";

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
              fallbacks: (upstream.fallbacks ?? [])
                .map((candidate) => candidate.profileName || candidate.baseUrl)
                .join(" → ") || null,
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
          opencode: summarize(state.upstreams.opencode),
        },
      };
      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      console.log(`状态：${alive ? "运行中" : "未运行"}`);
      console.log(`根地址：${data.rootUrl}`);
      console.log(`OpenAI 兼容 base：${data.codexBaseUrl}`);
      console.log(`PID：${pid ?? "-"}`);
      for (const tool of ["codex", "claude", "opencode"] as const) {
        const u = data.upstreams[tool];
        if (u) {
          const fallbackNote = u.fallbacks ? `，备用 ${u.fallbacks}` : "";
          console.log(
            `${tool} 上游：${u.baseUrl}（${u.mode}） profile=${u.profile ?? "-"}${fallbackNote}`,
          );
        } else {
          console.log(`${tool} 上游：未配置`);
        }
      }
    });

  bridge
    .command("reload")
    .description("用当前启用的 profile 刷新某一侧上游（不重启进程）")
    .argument("[tool]", `claude | codex | opencode（默认 codex）`, "codex")
    .option("--profile <name>", "指定 profile")
    .action(async (toolArg: string, opts: { profile?: string }) => {
      const toolName = toolArg || "codex";
      if (!isTool(toolName)) {
        throw new Error(`未知工具「${toolName}」。可选：${TOOLS.join("、")}`);
      }
      // 三个工具都可能走 bridge（openai-chat 上游），reload 必须全部支持。
      const tool = bridgeToolForCliTool(toolName);
      if (!tool) {
        throw new Error(`${toolName} 不使用本地 bridge`);
      }
      const profile = opts.profile
        ? resolveProfileOrThrow(tool, opts.profile)
        : getActiveProfile(tool);
      if (!profile) {
        throw new Error(
          `没有已启用的 ${tool} profile。可用：llms ${tool} use，或 llms bridge reload ${tool} --profile <name>`,
        );
      }
      if (!profileNeedsBridge(profile)) {
        throw new Error(
          `${tool}/${profile.name} 是 ${profile.apiFormat} 原生直连，不经过 bridge，无需 reload。`,
        );
      }
      const connection = await ensureBridgeForProfile(profile, tool);
      console.log(
        `已刷新 ${tool} 上游 ${profile.name} → bridge ${connection.baseUrl}`,
      );
    });

  bridge
    .command("logs")
    .description("查看 bridge 最近处理的数据面请求（进程内存，最多 200 条）")
    .option("--limit <n>", "显示条数", "50")
    .option("--json", "JSON 输出")
    .action(async (opts: { limit?: string; json?: boolean }) => {
      const state = readBridgeState();
      const instance = state.instance;
      if (!(await isBridgeAlive(state.listener.advertiseHost, state.listener.port)) || !instance) {
        throw new Error("bridge 未运行，没有可查看的日志。");
      }
      const limit = Math.max(1, Math.min(200, Number(opts.limit) || 50));
      const url = `http://${(state.listener.advertiseHost || "127.0.0.1").replace(/^::1$/, "[::1]")}:${state.listener.port}/_control/logs?limit=${limit}`;
      const response = await fetch(url, {
        headers: { "x-llm-switch-control": instance.controlToken },
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) {
        throw new Error(`读取日志失败：HTTP ${response.status}`);
      }
      const payload = (await response.json()) as { entries?: BridgeLogEntryView[] };
      const entries = payload.entries ?? [];
      if (opts.json) {
        console.log(JSON.stringify(entries, null, 2));
        return;
      }
      if (entries.length === 0) {
        console.log("暂无请求记录。发一次消息后再查看。");
        return;
      }
      for (const entry of entries) {
        const time = entry.ts ? entry.ts.slice(11, 19) : "-";
        const model = entry.model || "-";
        const statusLine = `${entry.status} ${entry.durationMs}ms`;
        const error = entry.error ? ` ⚠ ${entry.error}` : "";
        console.log(
          `${time} ${entry.tool.padEnd(8)} ${entry.path.padEnd(22)} ${model.padEnd(28)} ${statusLine}${error}`,
        );
      }
    });
}
