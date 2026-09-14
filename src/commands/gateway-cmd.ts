import { Command, Option } from "commander";
import { confirm, isCancel, password, select, text } from "@clack/prompts";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  watchFile,
} from "node:fs";
import { isApiFormat, type ApiFormat } from "../types.js";
import { formatLabel } from "../formats/compatibility.js";
import { detectApiFormat } from "../utils/detect-format.js";
import { fetchModelList } from "../utils/fetch-models.js";
import {
  requestWithNodeTransport,
} from "../bridge/transport.js";
import { providerFormat } from "../gateway/types.js";
import {
  buildUpstreamHeaders,
  upstreamUrl,
} from "../gateway/server.js";
import {
  chatRequestToUpstream,
  upstreamPath,
} from "../gateway/pipeline.js";
import {
  getGatewayLogPath,
  isGatewayAlive,
  isPidRunning,
  probeGateway,
  readGatewayPid,
  runGatewayForeground,
  startGatewayDaemon,
  stopGateway,
} from "../gateway/manager.js";
import { gatewayBaseUrl, gatewayRootUrl, readGatewayState } from "../gateway/state.js";
import { parseGatewayPort } from "../gateway/runtime.js";
import {
  createGatewayKey,
  deleteGatewayKey,
  listGatewayKeys,
  peekDailyQuota,
  peekRateLimit,
  publicKeyView,
  resetRateLimits,
  revokeGatewayKey,
  rotateGatewayKey,
  updateGatewayKey,
} from "../gateway/keys.js";
import { parseBridgeRuntimeLimits } from "../bridge/runtime.js";
import { renderTable } from "../utils/display.js";
import { rotateGatewayLogIfNeeded } from "../gateway/manager.js";
import {
  deleteGatewayProvider,
  deleteGatewayRoute,
  importProvidersFromProfiles,
  listGatewayProviders,
  listGatewayRoutes,
  publicProviderView,
  readGatewayConfig,
  requireGatewayProvider,
  saveGatewayProvider,
  saveGatewayRoute,
  writeGatewayConfig,
} from "../gateway/store.js";
import {
  listRoutableModelIds,
  listRoutableModels,
  resolveModelRoute,
  splitQualified,
} from "../gateway/router.js";
import { resetUsage, summarizeUsage } from "../gateway/usage.js";
import {
  DEFAULT_GATEWAY_HOST,
  DEFAULT_GATEWAY_PORT,
  type GatewayProvider,
} from "../gateway/types.js";

/**
 * `path=` marker for the provider list. `v1` is the default and stays implicit;
 * an empty prefix means "hit baseUrl directly" and must be shown — the previous
 * condition excluded the empty string, so that case silently rendered nothing.
 */
function formatPathPrefix(pathPrefix: string | undefined): string {
  if (pathPrefix === undefined || pathPrefix === "v1") return "";
  return pathPrefix === "" ? " path=(直连)" : ` path=${pathPrefix}`;
}

/**
 * Abort a gateway command. Uses the same `错误：` prefix on stderr as the rest of
 * the CLI (see cli.ts) instead of clack's boxed output, so piped consumers get a
 * consistent, parseable line. Cancellations are printed as-is.
 */
function bail(message: string): never {
  if (message === "已取消") console.error(message);
  else console.error(`错误：${message}`);
  process.exit(1);
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}天${hours}小时`;
  if (hours) return `${hours}小时${minutes}分钟`;
  if (minutes) return `${minutes}分钟`;
  return `${seconds}秒`;
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Parse a repeatable `--header "Name: value"` option. */
function parseHeaderEntry(
  value: string,
  collected: Record<string, string>,
): Record<string, string> {
  const index = value.indexOf(":");
  const name = index > 0 ? value.slice(0, index).trim() : "";
  const headerValue = index > 0 ? value.slice(index + 1).trim() : "";
  if (!name || !headerValue) {
    bail(`无效的 --header「${value}」，格式应为 "名称: 值"`);
  }
  return { ...collected, [name]: headerValue };
}

function randomProviderName(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let name = "";
  for (let i = 0; i < 5; i += 1) {
    name += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return name;
}

export function registerGatewayCommand(program: Command): void {
  const gateway = program
    .command("gateway")
    .description(
      "对外 AI 网关：独立端口 + 网关 API Key，按模型路由到多个供应商并做格式转换",
    );

  registerServerCommands(gateway);
  registerProviderCommands(gateway);
  registerKeyCommands(gateway);
  registerRouteCommands(gateway);
  registerConfigCommands(gateway);
  registerRateLimitCommands(gateway);
  registerUsageCommands(gateway);
  registerLogsCommands(gateway);
}

// --- logs -------------------------------------------------------------------

function registerLogsCommands(gateway: Command): void {
  gateway
    .command("logs")
    .description("查看网关日志（gateway.log）")
    .option("--lines <n>", "显示最后 N 行（默认 100）", "100")
    .option("--follow", "持续跟踪新日志（Ctrl+C 退出）")
    .action((opts: { lines?: string; follow?: boolean }) => {
      const lines = Number(opts.lines ?? "100");
      if (!Number.isInteger(lines) || lines < 1 || lines > 10_000) {
        bail("--lines 必须是 1..10000 的整数");
      }
      const path = getGatewayLogPath();
      rotateGatewayLogIfNeeded();
      if (!existsSync(path)) {
        console.log("暂无日志文件。");
        return;
      }
      const printTail = (): number => {
        const raw = readFileSync(path, "utf8");
        if (!raw) return 0;
        const all = raw.split(/\r?\n/);
        if (all.length && all[all.length - 1] === "") all.pop();
        const tail = all.slice(Math.max(0, all.length - lines));
        for (const line of tail) console.log(line);
        return raw.length;
      };
      printTail();
      if (!opts.follow) return;
      console.log("── 正在跟踪日志，Ctrl+C 退出 ──");
      let shown = statSync(path).size;
      watchFile(path, { interval: 1_000 }, () => {
        try {
          const stat = statSync(path);
          if (stat.size < shown) {
            // Rotated or truncated: restart from the beginning.
            shown = 0;
          }
          if (stat.size === shown) return;
          const fd = openSync(path, "r");
          const buffer = Buffer.alloc(stat.size - shown);
          readSync(fd, buffer, 0, buffer.length, shown);
          closeSync(fd);
          shown = stat.size;
          process.stdout.write(buffer.toString("utf8"));
        } catch {
          // File vanished mid-follow; retry on next tick.
        }
      });
    });
}

// --- rate limits ------------------------------------------------------------

function registerRateLimitCommands(gateway: Command): void {
  const rateLimit = gateway
    .command("ratelimit")
    .description("查看或清空限流计数（计数持久化，重启不丢失）");

  rateLimit
    .command("show", { isDefault: true })
    .description("显示每个 Key 当前窗口的用量")
    .option("--json", "JSON 输出")
    .action((opts: { json?: boolean }) => {
      const config = readGatewayConfig();
      const rows = listGatewayKeys().map((key) => {
        const limit =
          key.rateLimitPerMinute === -1
            ? 0
            : key.rateLimitPerMinute > 0
              ? key.rateLimitPerMinute
              : config.rateLimitPerMinute;
        const snapshot = peekRateLimit(key.id, limit);
        const daily = key.requestsPerDay
          ? peekDailyQuota(key.id, key.requestsPerDay)
          : null;
        return {
          id: key.id,
          name: key.name,
          limit: snapshot.limit,
          remaining: snapshot.remaining,
          resetAt: snapshot.resetAt
            ? new Date(snapshot.resetAt * 1000).toISOString()
            : null,
          unlimited: key.rateLimitPerMinute === -1,
          daily: daily
            ? { limit: daily.limit, remaining: daily.remaining }
            : null,
        };
      });
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (!rows.length) {
        console.log("暂无 API Key。");
        return;
      }
      for (const row of rows) {
        if (row.unlimited) {
          console.log(`${row.id} ${row.name}：不限流`);
          continue;
        }
        if (row.limit <= 0) {
          console.log(`${row.id} ${row.name}：不限流（未设置限额）`);
          continue;
        }
        const daily = row.daily
          ? `，今日剩余 ${row.daily.remaining}/${row.daily.limit}`
          : "";
        console.log(
          `${row.id} ${row.name}：剩余 ${row.remaining}/${row.limit}，窗口重置于 ${row.resetAt}${daily}`,
        );
      }
    });

  rateLimit
    .command("reset")
    .description("清空所有限流计数")
    .action(() => {
      resetRateLimits();
      console.log("已清空限流计数");
    });
}

// --- usage ------------------------------------------------------------------

function registerUsageCommands(gateway: Command): void {
  const usage = gateway
    .command("usage")
    .description("查看按天聚合的用量统计（Key / 供应商 / 模型）");

  usage
    .command("show", { isDefault: true })
    .description("显示最近 N 天的用量")
    .option("--days <n>", "统计最近几天的数据（默认 7）", "7")
    .option("--json", "JSON 输出")
    .action((opts: { days?: string; json?: boolean }) => {
      const days = Number(opts.days ?? "7");
      if (!Number.isInteger(days) || days < 1 || days > 90) {
        bail("--days 必须是 1..90 的整数");
      }
      const rows = summarizeUsage({ days });
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (!rows.length) {
        console.log(`最近 ${days} 天暂无用量记录。`);
        return;
      }
      console.log(`统计范围：最近 ${days} 天\n`);
      // 中文表头占两列宽，用 padEnd 会错位，改按显示宽度排版。
      for (const line of renderTable(rows, [
        { header: "日期", value: (r) => r.day },
        { header: "请求数", value: (r) => String(r.requests), align: "right" },
        { header: "输入 tokens", value: (r) => String(r.inputTokens), align: "right" },
        { header: "输出 tokens", value: (r) => String(r.outputTokens), align: "right" },
        { header: "Key", value: (r) => r.key },
        { header: "供应商", value: (r) => r.provider },
        { header: "模型", value: (r) => r.model },
      ])) {
        console.log(line);
      }
    });

  usage
    .command("reset")
    .description("清空所有用量记录")
    .action(() => {
      resetUsage();
      console.log("已清空用量记录");
    });
}

// --- serve / start / stop / status -----------------------------------------

function registerServerCommands(gateway: Command): void {
  gateway
    .command("serve")
    .description("前台运行网关（Ctrl+C 停止）")
    .option("--host <host>", "监听地址", DEFAULT_GATEWAY_HOST)
    .option("--port <port>", "监听端口", String(DEFAULT_GATEWAY_PORT))
    .option(
      "--allow-remote",
      "允许非回环监听（必须已创建至少一个 API Key）",
    )
    .action(
      async (opts: { host: string; port: string; allowRemote?: boolean }) => {
        await runGatewayForeground(
          opts.host || DEFAULT_GATEWAY_HOST,
          parseGatewayPort(opts.port),
          Boolean(opts.allowRemote),
        );
      },
    );

  gateway
    .command("start")
    .description("后台启动网关")
    .option("--host <host>", "监听地址", DEFAULT_GATEWAY_HOST)
    .option("--port <port>", "监听端口", String(DEFAULT_GATEWAY_PORT))
    .option(
      "--allow-remote",
      "允许非回环监听（必须已创建至少一个 API Key）",
    )
    .action(
      async (opts: { host: string; port: string; allowRemote?: boolean }) => {
        const host = opts.host || DEFAULT_GATEWAY_HOST;
        const port = parseGatewayPort(opts.port);
        const pid = await startGatewayDaemon(
          host,
          port,
          Boolean(opts.allowRemote),
        );
        for (let attempt = 0; attempt < 40; attempt += 1) {
          if (await isGatewayAlive()) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!(await isGatewayAlive())) {
          throw new Error(
            `网关启动失败。查看日志：${getGatewayLogPath()}，或前台运行：llms gateway serve`,
          );
        }
        if (pid > 0) {
          console.log(`网关已启动 pid=${pid} ${gatewayRootUrl()}`);
        } else {
          console.log(`网关已在运行 ${gatewayRootUrl()}`);
        }
        console.log(`OpenAI base：${gatewayBaseUrl()}`);
      },
    );

  gateway
    .command("stop")
    .description("停止网关")
    .action(async () => {
      const stopped = await stopGateway();
      console.log(stopped ? "已发送停止信号" : "没有正在运行的网关进程");
    });

  gateway
    .command("status")
    .description("查看网关状态")
    .option("--json", "JSON 输出")
    .action(async (opts: { json?: boolean }) => {
      const state = readGatewayState();
      const probe = await probeGateway(
        state.listener.advertiseHost,
        state.listener.port,
      );
      const pid = readGatewayPid();
      const providers = listGatewayProviders();
      const keys = listGatewayKeys().map(publicKeyView);
      const data = {
        alive: probe.healthy,
        reachable: probe.reachable,
        // 文本区区分三态，JSON 之前只有两个布尔，脚本无法还原「端口被占用」。
        state: probe.healthy
          ? ("running" as const)
          : probe.reachable
            ? ("port_occupied" as const)
            : ("stopped" as const),
        listener: state.listener,
        rootUrl: gatewayRootUrl(state),
        openaiBaseUrl: gatewayBaseUrl(state),
        anthropicBaseUrl: gatewayRootUrl(state),
        pid,
        pidRunning: pid ? isPidRunning(pid) : false,
        logPath: getGatewayLogPath(),
        providers: providers.map(publicProviderView),
        routes: listGatewayRoutes(),
        keys,
        config: readGatewayConfig(),
        breakers: probe.breakers ?? [],
      };
      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      console.log(
        `状态：${
          data.state === "running"
            ? "运行中"
            : data.state === "port_occupied"
              ? "端口被占用（非本网关）"
              : "未运行"
        }`,
      );
      if (data.alive && probe.uptimeSeconds !== undefined) {
        console.log(`已运行：${formatDuration(probe.uptimeSeconds)}`);
      }
      if (data.alive && probe.stats) {
        const stats = probe.stats;
        console.log(
          `请求：共 ${stats.requests} 次（4xx ${stats.errors4xx}，5xx ${stats.errors5xx}），` +
            `并发 ${stats.activeConnections}${stats.maxConcurrency > 0 ? `/${stats.maxConcurrency}` : "（不限）"}`,
        );
      }
      console.log(`监听：${data.listener.bindHost}:${data.listener.port}${data.listener.allowRemote ? "（已对外暴露）" : "（仅本机）"}`);
      console.log(`OpenAI base：${data.openaiBaseUrl}`);
      console.log(`Anthropic base：${data.anthropicBaseUrl}`);
      console.log(`PID：${pid ?? "-"}`);
      console.log(`日志：${data.logPath}`);
      console.log(
        `供应商：${providers.length} 个（启用 ${providers.filter((p) => p.enabled).length} 个）`,
      );
      console.log(
        `API Key：${keys.length} 个（有效 ${keys.filter((k) => k.status === "active").length} 个）`,
      );
      console.log(`模型路由：${data.routes.length} 条`);
      const cooling = data.breakers.filter((row) => row.coolingMsRemaining > 0);
      for (const row of cooling) {
        console.log(
          `熔断冷却：${row.provider}（连续失败 ${row.consecutiveFailures} 次，剩余 ${Math.ceil(row.coolingMsRemaining / 1000)}s，最近错误：${row.lastError || "未知"}）`,
        );
      }
      if (!keys.some((key) => key.status === "active")) {
        console.log("提示：尚无有效 API Key，请执行 llms gateway key create");
      }
    });

  gateway
    .command("models")
    .description("列出网关可路由的模型")
    .option("--json", "JSON 输出")
    .action((opts: { json?: boolean }) => {
      const models = listRoutableModels();
      if (opts.json) {
        console.log(JSON.stringify(models, null, 2));
        return;
      }
      if (!models.length) {
        console.log("暂无可路由模型。请先执行：llms gateway provider add");
        return;
      }
      for (const model of models) {
        console.log(
          `${model.id}  →  ${model.provider}（${model.format}） 上游模型 ${model.upstreamModel}`,
        );
      }
    });

  gateway
    .command("resolve")
    .description("查看某个模型 id 的路由与 fallback 顺序")
    .argument("<model>", "客户端请求里的 model 值")
    .option("--json", "JSON 输出")
    .action((model: string, opts: { json?: boolean }) => {
      const resolution = resolveModelRoute(model);
      const rows = resolution.candidates.map((candidate, index) => ({
        order: index + 1,
        provider: candidate.provider.name,
        format: candidate.provider.apiFormat,
        upstreamModel: candidate.model,
        source: candidate.source,
      }));
      if (opts.json) {
        console.log(JSON.stringify({ requested: resolution.requested, candidates: rows }, null, 2));
        return;
      }
      console.log(`模型「${resolution.requested}」路由顺序：`);
      for (const row of rows) {
        console.log(
          `  ${row.order}. ${row.provider}（${row.format}） → ${row.upstreamModel}  [${row.source}]`,
        );
      }
    });
}

// --- providers --------------------------------------------------------------

function registerProviderCommands(gateway: Command): void {
  const provider = gateway
    .command("provider")
    .description("管理网关供应商（与 llms <tool> provider 相互独立）");

  provider
    .command("list", { isDefault: true })
    .description("列出网关供应商")
    .option("--json", "JSON 输出")
    .action((opts: { json?: boolean }) => {
      const providers = listGatewayProviders().map(publicProviderView);
      if (opts.json) {
        console.log(JSON.stringify(providers, null, 2));
        return;
      }
      if (!providers.length) {
        console.log("暂无供应商。添加：llms gateway provider add");
        console.log("或从现有工具配置导入：llms gateway provider import");
        return;
      }
      for (const item of providers) {
        console.log(
          `${item.enabled ? "●" : "○"} ${item.name}（${item.displayName}） ${item.apiFormat} ${item.baseUrl} key=${item.apiKey} priority=${item.priority} models=${item.models.length}${formatPathPrefix(item.pathPrefix)}${item.headerNames?.length ? ` headers=${item.headerNames.join("/")}` : ""}`,
        );
      }
    });

  provider
    .command("add")
    .description("添加网关供应商（缺省参数时进入交互式引导）")
    .option("--name <name>", "供应商名称（默认随机生成）")
    .option("--display-name <name>", "显示名称")
    .option("--base-url <url>", "API 地址")
    .option("--api-key <key>", "API Key")
    .option(
      "--format <format>", 
      "接口类型：anthropic | openai-chat | openai-responses（缺省自动探测）",
    )
    .option("--models <list>", "逗号分隔的模型列表（缺省尝试自动获取）")
    .option("--priority <n>", "优先级，越小越先被选中", "100")
    .option("--proxy <url>", "上游代理 URL")
    .option(
      "--path-prefix <prefix>",
      "baseUrl 与 API 路径之间的前缀，默认 v1；传空字符串表示直连 baseUrl（如 Gemini 兼容端点）",
    )
    .addOption(
      new Option("--header <value>", '自定义上游请求头，格式 "名称: 值"，可重复传入')
        .argParser((value: string, previous: Record<string, string>) =>
          parseHeaderEntry(value, previous ?? {}),
        )
        .default({}),
    )
    .action(async (opts: Record<string, string | undefined> & { header?: Record<string, string> }) => {
      const baseUrl =
        opts.baseUrl ??
        (await promptText("API 地址（base URL）", "请改用 --base-url <url>。"));
      if (!baseUrl) bail("已取消");
      const apiKey =
        opts.apiKey ??
        (await promptSecret("API Key（本地上游可留空）", "请改用 --api-key <key>。"));

      let apiFormat: ApiFormat;
      if (opts.format) {
        if (!isApiFormat(opts.format)) {
          bail(`无效的 --format：${opts.format}`);
        }
        apiFormat = opts.format;
      } else {
        // opencode supports all three formats, so detection is unconstrained.
        const detected = await detectApiFormat("opencode", {
          baseUrl,
          apiKey: apiKey || "",
        });
        if (detected.detected) {
          apiFormat = detected.apiFormat;
          console.log(`已自动识别接口类型：${formatLabel(apiFormat)}`);
        } else {
          apiFormat = await promptFormat();
        }
      }

      let models = splitList(opts.models);
      if (!models.length) {
        try {
          const result = await fetchModelList({
            baseUrl,
            apiKey: apiKey || "",
            apiFormat,
          });
          models = result.models;
          if (models.length) {
            console.log(`已获取 ${models.length} 个模型`);
          }
        } catch {
          console.log("未能自动获取模型列表；该供应商将接受任意模型 id（passthrough）");
        }
      }

      const priority = Number(opts.priority ?? "100");
      const saved = saveGatewayProvider({
        name: opts.name || randomProviderName(),
        displayName: opts.displayName || opts.name || "",
        apiFormat,
        baseUrl,
        apiKey: apiKey || "",
        models,
        headers: opts.header ?? {},
        proxy: opts.proxy,
        ...(opts.pathPrefix !== undefined
          ? { pathPrefix: opts.pathPrefix }
          : {}),
        priority: Number.isFinite(priority) ? priority : 100,
        enabled: true,
        sourceProfile: null,
        updatedAt: new Date().toISOString(),
      });
      console.log(
        `已添加供应商 ${saved.name}（${formatLabel(saved.apiFormat)}） ${saved.baseUrl}`,
      );
      if (!saved.models.length) {
        console.log("该供应商未声明模型列表，将作为兜底 passthrough 上游。");
      }
    });

  provider
    .command("import")
    .description("从现有 llms <tool> provider 配置导入（按上游去重）")
    .action(() => {
      const result = importProvidersFromProfiles();
      if (!result.imported.length) {
        console.log("没有新的供应商需要导入。");
      }
      for (const item of result.imported) {
        console.log(
          `已导入 ${item.name}（来自 ${item.sourceProfile?.tool}/${item.sourceProfile?.name}） ${item.apiFormat} ${item.baseUrl}`,
        );
      }
      for (const item of result.skipped) {
        console.log(`跳过 ${item.tool}/${item.name}：${item.reason}`);
      }
    });

  provider
    .command("test")
    .description("测试供应商连通性：拉取模型列表，可选发送一次最小补全请求")
    .argument("<name>", "供应商名称")
    .option("--model <id>", "用于 --call 的模型 id（缺省取模型列表第一个）")
    .option("--call", "额外发送一次 1-token 补全请求验证推理可用")
    .option("--json", "JSON 输出")
    .action(async (name: string, opts: { model?: string; call?: boolean; json?: boolean }) => {
      const provider = requireGatewayProvider(name);
      const result: Record<string, unknown> = { provider: provider.name };

      const startedAt = Date.now();
      try {
        const fetched = await fetchModelList({
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          apiFormat: provider.apiFormat,
          proxy: provider.proxy,
          headers: provider.headers,
        });
        result.modelsEndpoint = { ok: true, count: fetched.models.length, endpoint: fetched.endpoint };
        result.modelsLatencyMs = Date.now() - startedAt;
        result.models = fetched.models.slice(0, 10);
        if (fetched.models.length > 10) result.modelsTruncated = true;
      } catch (err) {
        result.modelsEndpoint = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }

      if (opts.call) {
        const model = opts.model || provider.models[0] || (result.models as string[] | undefined)?.[0];
        if (!model) {
          result.completion = { ok: false, error: "没有可用模型 id；请用 --model 指定" };
        } else {
          const targetFormat = providerFormat(provider);
          const hub: Record<string, unknown> = {
            model,
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 1,
          };
          const callStarted = Date.now();
          try {
            const response = await requestWithNodeTransport({
              url: upstreamUrl(provider, upstreamPath(targetFormat)),
              method: "POST",
              headers: buildUpstreamHeaders(provider),
              body: JSON.stringify(chatRequestToUpstream(targetFormat, hub)),
              proxy: provider.proxy,
              signal: AbortSignal.timeout(30_000),
              totalTimeoutMs: 30_000,
            });
            const text = await response.text().catch(() => "");
            result.completion = {
              ok: response.ok,
              status: response.status,
              latencyMs: Date.now() - callStarted,
              model,
              ...(response.ok
                ? { body: text.slice(0, 300) }
                : { error: text.slice(0, 300) }),
            };
          } catch (err) {
            result.completion = {
              ok: false,
              latencyMs: Date.now() - callStarted,
              model,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }
      }

      const models = result.modelsEndpoint as { ok: boolean; count?: number; error?: string };
      const completion = result.completion as { ok?: boolean; status?: number; latencyMs?: number; error?: string } | undefined;
      // 退出码要在 JSON 分支之前决定，否则脚本用 --json 时拿不到失败信号。
      const allOk = models?.ok && (!completion || completion.ok);
      if (!allOk) process.exitCode = 1;

      if (opts.json) {
        console.log(JSON.stringify({ ...result, ok: Boolean(allOk) }, null, 2));
        return;
      }
      if (models?.ok) {
        console.log(`模型列表：OK（${models.count} 个，${result.modelsLatencyMs}ms）`);
      } else {
        console.log(`模型列表：失败 — ${models?.error ?? "未知错误"}`);
      }
      if (completion) {
        if (completion.ok) {
          console.log(`补全请求：OK（HTTP ${completion.status}，${completion.latencyMs}ms）`);
        } else {
          console.log(`补全请求：失败 — ${completion.error ?? `HTTP ${completion.status}`}`);
        }
      }
    });

  provider
    .command("refresh-models")
    .description("从上游重新拉取模型列表并覆盖本地缓存")
    .argument("<name>", "供应商名称")
    .action(async (name: string) => {
      const provider = requireGatewayProvider(name);
      const fetched = await fetchModelList({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        apiFormat: provider.apiFormat,
        proxy: provider.proxy,
        headers: provider.headers,
      });
      if (!fetched.models.length) {
        console.log("上游返回空列表，未做修改。");
        return;
      }
      const saved = saveGatewayProvider({ ...provider, models: fetched.models });
      console.log(`已更新 ${saved.name} 的模型列表（${saved.models.length} 个）`);
      for (const model of saved.models.slice(0, 20)) console.log(`  - ${model}`);
      if (saved.models.length > 20) console.log(`  … 共 ${saved.models.length} 个`);
    });

  provider
    .command("edit")
    .description("修改供应商字段")
    .argument("<name>", "供应商名称")
    .option("--display-name <name>", "显示名称")
    .option("--base-url <url>", "API 地址")
    .option("--api-key <key>", "API Key")
    .option("--format <format>", "接口类型")
    .option("--models <list>", "逗号分隔的模型列表（覆盖）")
    .option("--priority <n>", "优先级")
    .option("--proxy <url>", "上游代理 URL（传空字符串清除）")
    .option(
      "--path-prefix <prefix>",
      "baseUrl 与 API 路径之间的前缀，默认 v1；传空字符串表示直连 baseUrl",
    )
    .option("--clear-headers", "清除已配置的自定义请求头")
    .addOption(
      new Option("--header <value>", '自定义上游请求头，格式 "名称: 值"，可重复传入（合并进现有配置）')
        .argParser((value: string, previous: Record<string, string>) =>
          parseHeaderEntry(value, previous ?? {}),
        )
        .default({}),
    )
    .action((name: string, opts: Record<string, string | undefined> & { header?: Record<string, string>; clearHeaders?: boolean }) => {
      const current = requireGatewayProvider(name);
      const next: GatewayProvider = { ...current };
      if (opts.displayName) next.displayName = opts.displayName;
      if (opts.baseUrl) next.baseUrl = opts.baseUrl;
      if (opts.apiKey !== undefined) next.apiKey = opts.apiKey;
      if (opts.format) {
        if (!isApiFormat(opts.format)) bail(`无效的 --format：${opts.format}`);
        next.apiFormat = opts.format;
      }
      if (opts.models !== undefined) next.models = splitList(opts.models);
      if (opts.priority !== undefined) {
        const priority = Number(opts.priority);
        if (!Number.isFinite(priority)) bail("--priority 必须是数字");
        next.priority = priority;
      }
      if (opts.proxy !== undefined) {
        next.proxy = opts.proxy.trim() ? opts.proxy.trim() : undefined;
      }
      if (opts.pathPrefix !== undefined) {
        next.pathPrefix = opts.pathPrefix.trim() ? opts.pathPrefix : "";
      }
      if (opts.clearHeaders) {
        next.headers = {};
      }
      if (opts.header && Object.keys(opts.header).length) {
        next.headers = { ...next.headers, ...opts.header };
      }
      const saved = saveGatewayProvider(next);
      console.log(`已更新供应商 ${saved.name}`);
    });

  provider
    .command("enable")
    .description("启用供应商")
    .argument("<name>", "供应商名称")
    .action((name: string) => {
      const saved = saveGatewayProvider({
        ...requireGatewayProvider(name),
        enabled: true,
      });
      console.log(`已启用 ${saved.name}`);
    });

  provider
    .command("disable")
    .description("停用供应商（保留配置，不参与路由）")
    .argument("<name>", "供应商名称")
    .action((name: string) => {
      const saved = saveGatewayProvider({
        ...requireGatewayProvider(name),
        enabled: false,
      });
      console.log(`已停用 ${saved.name}`);
    });

  provider
    .command("remove")
    .description("删除供应商（同时清理相关路由）")
    .argument("<name>", "供应商名称")
    .option("--yes", "跳过确认")
    .action(async (name: string, opts: { yes?: boolean }) => {
      requireGatewayProvider(name);
      if (!opts.yes) {
        const ok = await confirm({ message: `确认删除供应商 ${name}？` });
        if (isCancel(ok) || !ok) bail("已取消");
      }
      deleteGatewayProvider(name);
      console.log(`已删除供应商 ${name}`);
    });
}

// --- keys -------------------------------------------------------------------

function registerKeyCommands(gateway: Command): void {
  const key = gateway
    .command("key")
    .description("管理网关 API Key（发给第三方客户端使用）");

  key
    .command("list", { isDefault: true })
    .description("列出 API Key（不含明文）")
    .option("--json", "JSON 输出")
    .action((opts: { json?: boolean }) => {
      const keys = listGatewayKeys().map(publicKeyView);
      if (opts.json) {
        console.log(JSON.stringify(keys, null, 2));
        return;
      }
      if (!keys.length) {
        console.log("暂无 API Key。创建：llms gateway key create");
        return;
      }
      for (const item of keys) {
        const scopes: string[] = [];
        if (item.providers.length) scopes.push(`providers=${item.providers.join("/")}`);
        if (item.models.length) scopes.push(`models=${item.models.join("/")}`);
        if (!item.formats.includes("*")) scopes.push(`formats=${item.formats.join("/")}`);
        if (item.rateLimitPerMinute === -1) scopes.push("rpm=unlimited");
        else if (item.rateLimitPerMinute > 0) scopes.push(`rpm=${item.rateLimitPerMinute}`);
        if (item.requestsPerDay) scopes.push(`daily=${item.requestsPerDay}`);
        console.log(
          `${item.status === "active" ? "●" : "○"} ${item.id} ${item.name} ${item.hint} ${item.status}${item.expiresAt ? ` 过期=${item.expiresAt}` : ""}${scopes.length ? ` [${scopes.join(" ")}]` : ""}`,
        );
      }
    });

  key
    .command("create")
    .description("创建 API Key（明文仅显示一次）")
    .option("--name <name>", "备注名称")
    .option("--expires-in-days <n>", "有效期天数（缺省永不过期）")
    .option("--providers <list>", "限定可用供应商，逗号分隔")
    .option("--models <list>", "限定可用模型，逗号分隔")
    .option(
      "--formats <list>",
      "限定可用接口格式：openai-chat,anthropic,openai-responses",
    )
    .option(
      "--rate-limit <rpm>",
      "该 Key 每分钟请求上限；-1 表示完全不限流，0 表示继承全局默认",
    )
    .option("--daily-requests <n>", "该 Key 每日请求配额（UTC 日重置，0 表示不限）")
    .action((opts: Record<string, string | undefined>) => {
      const days = opts.expiresInDays ? Number(opts.expiresInDays) : 0;
      if (opts.expiresInDays && !Number.isFinite(days)) {
        bail("--expires-in-days 必须是数字");
      }
      const rateLimitRaw = opts.rateLimit ? Number(opts.rateLimit) : 0;
      if (opts.rateLimit && !Number.isFinite(rateLimitRaw)) {
        bail("--rate-limit 必须是数字");
      }
      const dailyRaw = opts.dailyRequests ? Number(opts.dailyRequests) : 0;
      if (opts.dailyRequests && (!Number.isInteger(dailyRaw) || dailyRaw < 0)) {
        bail("--daily-requests 必须是非负整数");
      }
      // Typos in scope lists fail closed (all requests denied) and are hard to
      // diagnose later, so flag anything unknown at creation time.
      const knownProviders = new Set(
        listGatewayProviders().map((p) => p.name.toLowerCase()),
      );
      for (const name of splitList(opts.providers)) {
        if (!knownProviders.has(name.toLowerCase())) {
          console.warn(
            `警告：供应商「${name}」不存在，限定该供应商的请求将全部被拒绝。`,
          );
        }
      }
      const routable = new Set(
        listRoutableModelIds().map((m) => m.toLowerCase()),
      );
      for (const model of splitList(opts.models)) {
        if (!routable.has(model.toLowerCase())) {
          console.warn(
            `警告：模型「${model}」当前不在可路由列表中（passthrough 上游仍可能接受它）。`,
          );
        }
      }
      const created = createGatewayKey({
        name: opts.name,
        expiresInDays: days,
        providers: splitList(opts.providers),
        models: splitList(opts.models),
        formats: splitList(opts.formats),
        rateLimitPerMinute: Math.trunc(rateLimitRaw),
        requestsPerDay: opts.dailyRequests ? Number(opts.dailyRequests) : 0,
      });
      console.log("已创建 API Key。请立即保存，明文不会再次显示：");
      console.log("");
      console.log(`  ${created.plaintext}`);
      console.log("");
      console.log(`id=${created.key.id} name=${created.key.name}`);
      console.log(`OpenAI base：${gatewayBaseUrl()}`);
      console.log(`Anthropic base：${gatewayRootUrl()}`);
    });

  key
    .command("edit")
    .description("修改 API Key 的作用域、限额或有效期")
    .argument("<idOrName>", "Key id 或名称")
    .option("--name <name>", "备注名称")
    .option("--providers <list>", "限定可用供应商，逗号分隔（覆盖）")
    .option("--models <list>", "限定可用模型，逗号分隔（覆盖）")
    .option(
      "--formats <list>",
      "限定可用接口格式：openai-chat,anthropic,openai-responses（覆盖）",
    )
    .option(
      "--rate-limit <rpm>",
      "每分钟请求上限；-1 表示完全不限流，0 表示继承全局默认",
    )
    .option(
      "--daily-requests <n>",
      "每日请求配额（UTC 日重置，0 表示不限）",
    )
    .option(
      "--expires-in-days <n>",
      "新的有效期天数（从现在起算）；0 表示永不过期",
    )
    .action((idOrName: string, opts: Record<string, string | undefined>) => {
      const patch: Record<string, unknown> = {};
      if (opts.name !== undefined) patch.name = opts.name;
      if (opts.providers !== undefined) patch.providers = splitList(opts.providers);
      if (opts.models !== undefined) patch.models = splitList(opts.models);
      if (opts.formats !== undefined) patch.formats = splitList(opts.formats);
      if (opts.rateLimit !== undefined) {
        const value = Number(opts.rateLimit);
        if (!Number.isFinite(value)) bail("--rate-limit 必须是数字");
        patch.rateLimitPerMinute = Math.trunc(value);
      }
      if (opts.dailyRequests !== undefined) {
        const value = Number(opts.dailyRequests);
        if (!Number.isInteger(value) || value < 0) {
          bail("--daily-requests 必须是非负整数");
        }
        patch.requestsPerDay = value;
      }
      if (opts.expiresInDays !== undefined) {
        const value = Number(opts.expiresInDays);
        if (!Number.isFinite(value) || value < 0) {
          bail("--expires-in-days 必须是非负数字");
        }
        patch.expiresInDays = value;
      }
      if (!Object.keys(patch).length) {
        bail("没有指定任何修改项；可用 --name/--providers/--models/--formats/--rate-limit/--daily-requests/--expires-in-days");
      }
      const updated = updateGatewayKey(idOrName, patch);
      console.log(`已更新 ${updated.id}（${updated.name}）`);
      console.log("当前作用域与限额：llms gateway key list");
    });

  key
    .command("rotate")
    .description("换发 API Key（保留作用域，旧明文立即失效，新明文只显示一次）")
    .argument("<idOrName>", "Key id 或名称")
    .action((idOrName: string) => {
      const rotated = rotateGatewayKey(idOrName);
      console.log(`已换发 ${rotated.key.id}（${rotated.key.name}）。请立即保存新明文，不会再次显示：`);
      console.log("");
      console.log(`  ${rotated.plaintext}`);
      console.log("");
    });

  key
    .command("revoke")
    .description("吊销 API Key（保留记录）")
    .argument("<idOrName>", "Key id 或名称")
    .action((idOrName: string) => {
      const revoked = revokeGatewayKey(idOrName);
      console.log(`已吊销 ${revoked.id}（${revoked.name}）`);
    });

  key
    .command("remove")
    .description("彻底删除 API Key 记录")
    .argument("<idOrName>", "Key id 或名称")
    .option("--yes", "跳过确认")
    .action(async (idOrName: string, opts: { yes?: boolean }) => {
      if (!opts.yes) {
        const ok = await confirm({
          message: `确认删除 API Key ${idOrName}？删除后无法审计其历史。`,
        });
        if (isCancel(ok) || !ok) bail("已取消");
      }
      const removed = deleteGatewayKey(idOrName);
      console.log(`已删除 ${removed.id}（${removed.name}）`);
    });
}

// --- routes -----------------------------------------------------------------

function registerRouteCommands(gateway: Command): void {
  const route = gateway
    .command("route")
    .description("管理模型别名路由（把客户端模型 id 映射到供应商/模型）");

  route
    .command("list", { isDefault: true })
    .description("列出模型路由")
    .option("--json", "JSON 输出")
    .action((opts: { json?: boolean }) => {
      const routes = listGatewayRoutes();
      if (opts.json) {
        console.log(JSON.stringify(routes, null, 2));
        return;
      }
      if (!routes.length) {
        console.log("暂无模型路由。添加：llms gateway route add <alias> --provider <name>");
        return;
      }
      for (const item of routes) {
        const fallbacks = (item.fallbacks || [])
          .map((fb) => `${fb.provider}${fb.model ? `/${fb.model}` : ""}`)
          .join(" → ");
        console.log(
          `${item.alias} → ${item.provider}${item.model ? `/${item.model}` : ""}${fallbacks ? `  fallback: ${fallbacks}` : ""}`,
        );
      }
    });

  route
    .command("add")
    .description("添加或覆盖模型路由")
    .argument("<alias>", "客户端看到的模型 id")
    .requiredOption("--provider <name>", "主供应商名称")
    .option("--model <model>", "上游模型 id（缺省与 alias 相同）")
    .option(
      "--fallback <list>",
      "fallback 列表，逗号分隔，支持 provider 或 provider/model",
    )
    .action(
      (
        alias: string,
        opts: { provider: string; model?: string; fallback?: string },
      ) => {
        const fallbacks = splitList(opts.fallback).map((entry) => {
          // 与 router 解析请求模型 id 的规则保持一致：provider/model 与
          // provider:model 都认，否则用户按文档写 `provider:model` 会被静默错配。
          const qualified = splitQualified(entry);
          return qualified ? qualified : { provider: entry };
        });
        const saved = saveGatewayRoute({
          alias,
          provider: opts.provider,
          ...(opts.model ? { model: opts.model } : {}),
          ...(fallbacks.length ? { fallbacks } : {}),
          updatedAt: new Date().toISOString(),
        });
        console.log(
          `已配置路由 ${saved.alias} → ${saved.provider}${saved.model ? `/${saved.model}` : ""}`,
        );
      },
    );

  route
    .command("remove")
    .description("删除模型路由")
    .argument("<alias>", "模型别名")
    .action((alias: string) => {
      deleteGatewayRoute(alias);
      console.log(`已删除路由 ${alias}`);
    });
}

// --- config -----------------------------------------------------------------

function registerConfigCommands(gateway: Command): void {
  const config = gateway
    .command("config")
    .description("查看或修改网关全局配置");

  config
    .command("show", { isDefault: true })
    .description("显示当前配置与生效的运行时限额")
    .option("--json", "JSON 输出")
    .action((opts: { json?: boolean }) => {
      const config = readGatewayConfig();
      const limits = parseBridgeRuntimeLimits();
      if (opts.json) {
        console.log(JSON.stringify({ config, runtimeLimits: limits }, null, 2));
        return;
      }
      // 其他命令都是「文本为主，--json 可选」，这里以前只吐 JSON，风格不一致。
      console.log(`兜底供应商：${config.defaultProvider ?? "（未设置）"}`);
      console.log(
        `默认限流：${config.rateLimitPerMinute > 0 ? `${config.rateLimitPerMinute} 次/分钟` : "不限"}`,
      );
      console.log(
        `Provider fallback：${config.fallback.enabled ? "启用" : "关闭"}` +
          `（最多尝试 ${config.fallback.maxAttempts} 个上游，触发状态码 ${config.fallback.retryStatuses.join("/") || "无"}）`,
      );
      console.log(
        `CORS 来源：${config.corsOrigins?.length ? config.corsOrigins.join(", ") : "（未开启）"}`,
      );
      console.log("");
      console.log("运行时限额（环境变量可调，与 bridge 共用）：");
      for (const line of renderTable(
        [
          {
            k: "最大并发",
            v: limits.maxConcurrency > 0 ? String(limits.maxConcurrency) : "不限",
            env: "LLM_SWITCH_MAX_CONCURRENCY",
          },
          { k: "请求体上限", v: `${limits.maxBodyBytes} B`, env: "LLM_SWITCH_MAX_BODY_BYTES" },
          { k: "上游响应上限", v: `${limits.maxResponseBytes} B`, env: "LLM_SWITCH_MAX_RESPONSE_BYTES" },
          { k: "连接超时", v: `${limits.connectTimeoutMs} ms`, env: "LLM_SWITCH_CONNECT_TIMEOUT_MS" },
          { k: "流式空闲超时", v: `${limits.idleTimeoutMs} ms`, env: "LLM_SWITCH_IDLE_TIMEOUT_MS" },
          { k: "单请求总超时", v: `${limits.totalTimeoutMs} ms`, env: "LLM_SWITCH_TOTAL_TIMEOUT_MS" },
        ],
        [
          { header: "项目", value: (r) => r.k },
          { header: "当前值", value: (r) => r.v, align: "right" },
          { header: "环境变量", value: (r) => r.env },
        ],
      )) {
        console.log(`  ${line}`);
      }
    });

  config
    .command("set")
    .description("修改配置项")
    .option("--default-provider <name>", "未知模型的兜底供应商（传空清除）")
    .option("--fallback <bool>", "是否启用 provider fallback：true | false")
    .option("--max-attempts <n>", "单次请求最多尝试的上游数量")
    .option("--retry-statuses <list>", "触发 fallback 的 HTTP 状态码，逗号分隔")
    .option("--cors-origins <list>", "允许的浏览器来源，逗号分隔，* 表示全部")
    .option("--rate-limit <rpm>", "默认每分钟请求上限（0 表示不限）")
    .action((opts: Record<string, string | undefined>) => {
      const current = readGatewayConfig();
      const next = { ...current };

      if (opts.defaultProvider !== undefined) {
        const name = opts.defaultProvider.trim();
        if (name) requireGatewayProvider(name);
        next.defaultProvider = name || null;
      }
      if (opts.fallback !== undefined) {
        if (!/^(true|false)$/i.test(opts.fallback)) {
          bail("--fallback 只能是 true 或 false");
        }
        next.fallback = {
          ...next.fallback,
          enabled: /^true$/i.test(opts.fallback),
        };
      }
      if (opts.maxAttempts !== undefined) {
        const value = Number(opts.maxAttempts);
        if (!Number.isInteger(value) || value < 1 || value > 10) {
          bail("--max-attempts 必须是 1..10 的整数");
        }
        next.fallback = { ...next.fallback, maxAttempts: value };
      }
      if (opts.retryStatuses !== undefined) {
        const statuses = splitList(opts.retryStatuses).map(Number);
        if (statuses.some((code) => !Number.isInteger(code) || code < 100 || code > 599)) {
          bail("--retry-statuses 必须是 100..599 的整数列表");
        }
        next.fallback = { ...next.fallback, retryStatuses: statuses };
      }
      if (opts.corsOrigins !== undefined) {
        next.corsOrigins = splitList(opts.corsOrigins);
      }
      if (opts.rateLimit !== undefined) {
        const value = Number(opts.rateLimit);
        if (!Number.isInteger(value) || value < 0) {
          bail("--rate-limit 必须是非负整数");
        }
        next.rateLimitPerMinute = value;
      }

      writeGatewayConfig(next);
      console.log("已更新网关配置。当前生效值：llms gateway config show");
    });
}

// --- prompts ----------------------------------------------------------------

/**
 * clack 在非 TTY 下会永久等待输入，表现为「命令卡住」而不是报错。
 * 每个交互入口先在这里挡一次，并说明该用哪个参数改成非交互。
 */
function requireTty(what: string, hint: string): void {
  if (process.stdin.isTTY) return;
  bail(`${what}需要交互式终端（当前 stdin 不是 TTY）。${hint}`);
}

async function promptText(message: string, hint?: string): Promise<string> {
  requireTty(message, hint ?? "请在终端中运行，或改用对应命令行参数。");
  const value = await text({ message });
  if (isCancel(value)) bail("已取消");
  return String(value ?? "").trim();
}

async function promptSecret(message: string, hint?: string): Promise<string> {
  requireTty(message, hint ?? "请在终端中运行，或改用对应命令行参数。");
  const value = await password({ message });
  if (isCancel(value)) bail("已取消");
  return String(value ?? "").trim();
}

async function promptFormat(): Promise<ApiFormat> {
  requireTty(
    "接口类型选择",
    "自动探测失败，请改用 --format <openai-chat|anthropic|openai-responses>。",
  );
  const value = await select({
    message: "无法自动识别接口类型，请选择",
    options: [
      { value: "openai-chat", label: formatLabel("openai-chat") },
      { value: "anthropic", label: formatLabel("anthropic") },
      { value: "openai-responses", label: formatLabel("openai-responses") },
    ],
  });
  if (isCancel(value)) bail("已取消");
  return value as ApiFormat;
}
