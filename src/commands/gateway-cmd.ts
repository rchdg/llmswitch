import { Command } from "commander";
import { cancel, confirm, isCancel, password, select, text } from "@clack/prompts";
import { isApiFormat, type ApiFormat } from "../types.js";
import { formatLabel } from "../formats/compatibility.js";
import { detectApiFormat } from "../utils/detect-format.js";
import { fetchModelList } from "../utils/fetch-models.js";
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
  peekRateLimit,
  publicKeyView,
  resetRateLimits,
  revokeGatewayKey,
} from "../gateway/keys.js";
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
import { listRoutableModels, resolveModelRoute } from "../gateway/router.js";
import {
  DEFAULT_GATEWAY_HOST,
  DEFAULT_GATEWAY_PORT,
  type GatewayProvider,
} from "../gateway/types.js";

function bail(message: string): never {
  cancel(message);
  process.exit(1);
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
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
          key.rateLimitPerMinute > 0
            ? key.rateLimitPerMinute
            : config.rateLimitPerMinute;
        const snapshot = peekRateLimit(key.id, limit);
        return {
          id: key.id,
          name: key.name,
          limit: snapshot.limit,
          remaining: snapshot.remaining,
          resetAt: snapshot.resetAt
            ? new Date(snapshot.resetAt * 1000).toISOString()
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
        if (row.limit <= 0) {
          console.log(`${row.id} ${row.name}：不限流`);
          continue;
        }
        console.log(
          `${row.id} ${row.name}：剩余 ${row.remaining}/${row.limit}，窗口重置于 ${row.resetAt}`,
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
        console.log(`网关已启动 pid=${pid} ${gatewayRootUrl()}`);
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
      };
      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      console.log(`状态：${data.alive ? "运行中" : data.reachable ? "端口被占用（非本网关）" : "未运行"}`);
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
          `${item.enabled ? "●" : "○"} ${item.name}（${item.displayName}） ${item.apiFormat} ${item.baseUrl} key=${item.apiKey} priority=${item.priority} models=${item.models.length}`,
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
    .action(async (opts: Record<string, string | undefined>) => {
      const baseUrl = opts.baseUrl ?? (await promptText("API 地址（base URL）"));
      if (!baseUrl) bail("已取消");
      const apiKey =
        opts.apiKey ?? (await promptSecret("API Key（本地上游可留空）"));

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
        headers: {},
        proxy: opts.proxy,
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
    .action((name: string, opts: Record<string, string | undefined>) => {
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
        if (item.rateLimitPerMinute) scopes.push(`rpm=${item.rateLimitPerMinute}`);
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
    .option("--rate-limit <rpm>", "该 Key 每分钟请求上限（0 表示不限）")
    .action((opts: Record<string, string | undefined>) => {
      const days = opts.expiresInDays ? Number(opts.expiresInDays) : 0;
      if (opts.expiresInDays && !Number.isFinite(days)) {
        bail("--expires-in-days 必须是数字");
      }
      const rateLimit = opts.rateLimit ? Number(opts.rateLimit) : 0;
      if (opts.rateLimit && !Number.isFinite(rateLimit)) {
        bail("--rate-limit 必须是数字");
      }
      const created = createGatewayKey({
        name: opts.name,
        expiresInDays: days,
        providers: splitList(opts.providers),
        models: splitList(opts.models),
        formats: splitList(opts.formats),
        rateLimitPerMinute: rateLimit,
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
          const index = entry.indexOf("/");
          if (index <= 0) return { provider: entry };
          return {
            provider: entry.slice(0, index),
            model: entry.slice(index + 1),
          };
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
    .description("显示当前配置")
    .action(() => {
      console.log(JSON.stringify(readGatewayConfig(), null, 2));
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
      console.log(JSON.stringify(readGatewayConfig(), null, 2));
    });
}

// --- prompts ----------------------------------------------------------------

async function promptText(message: string): Promise<string> {
  const value = await text({ message });
  if (isCancel(value)) bail("已取消");
  return String(value ?? "").trim();
}

async function promptSecret(message: string): Promise<string> {
  const value = await password({ message });
  if (isCancel(value)) bail("已取消");
  return String(value ?? "").trim();
}

async function promptFormat(): Promise<ApiFormat> {
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
