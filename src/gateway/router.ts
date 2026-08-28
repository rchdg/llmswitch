/**
 * Model routing and fallback ordering.
 *
 * Resolution order for the `model` field a third party sends:
 *  1. an explicit route alias (`llms gateway route add`)
 *  2. a qualified reference: `provider/model` or `provider:model`
 *  3. a bare model id declared by one or more providers
 *  4. providers that declare no model list (passthrough upstreams)
 *  5. the configured default provider
 *
 * When several providers can serve the same model they are ordered by
 * `priority` (ascending) and become each other's fallbacks, so ambiguity is
 * deterministic rather than an error.
 */

import {
  listGatewayProviders,
  listGatewayRoutes,
  readGatewayConfig,
} from "./store.js";
import type {
  GatewayConfig,
  GatewayProvider,
  GatewayRoute,
} from "./types.js";

export interface RouteCandidate {
  provider: GatewayProvider;
  /** Model id sent upstream. */
  model: string;
  /** Where this candidate came from, for diagnostics. */
  source: "route" | "qualified" | "model-list" | "passthrough" | "default";
}

export interface RouteResolution {
  /** Model id as requested by the client. */
  requested: string;
  candidates: RouteCandidate[];
}

export class ModelNotRoutableError extends Error {
  constructor(
    readonly requested: string,
    readonly availableModels: string[],
  ) {
    const hint = availableModels.length
      ? `可用模型：${availableModels.slice(0, 20).join(", ")}${availableModels.length > 20 ? " …" : ""}`
      : "尚未配置任何 provider。请执行：llms gateway provider add";
    super(`模型「${requested}」无法路由。${hint}`);
    this.name = "ModelNotRoutableError";
  }
}

export interface RouterInput {
  providers?: readonly GatewayProvider[];
  routes?: readonly GatewayRoute[];
  config?: GatewayConfig;
}

function enabledProviders(
  providers: readonly GatewayProvider[],
): GatewayProvider[] {
  return providers
    .filter((provider) => provider.enabled && provider.baseUrl)
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
}

function findProvider(
  providers: readonly GatewayProvider[],
  name: string,
): GatewayProvider | undefined {
  const wanted = name.trim().toLowerCase();
  return providers.find(
    (provider) =>
      provider.name.toLowerCase() === wanted ||
      provider.displayName.toLowerCase() === wanted,
  );
}

function providerHasModel(provider: GatewayProvider, model: string): boolean {
  if (!provider.models.length) return false;
  const wanted = model.toLowerCase();
  return provider.models.some((item) => item.toLowerCase() === wanted);
}

/** Split `provider/model` or `provider:model`; the model part may contain `/`. */
function splitQualified(
  requested: string,
): { provider: string; model: string } | null {
  for (const separator of ["/", ":"]) {
    const index = requested.indexOf(separator);
    if (index <= 0) continue;
    const provider = requested.slice(0, index).trim();
    const model = requested.slice(index + 1).trim();
    if (provider && model) return { provider, model };
  }
  return null;
}

function pushCandidate(
  out: RouteCandidate[],
  seen: Set<string>,
  provider: GatewayProvider,
  model: string,
  source: RouteCandidate["source"],
): void {
  const dedupe = `${provider.name}::${model}`;
  if (seen.has(dedupe)) return;
  seen.add(dedupe);
  out.push({ provider, model, source });
}

export function resolveModelRoute(
  requestedRaw: string,
  input: RouterInput = {},
): RouteResolution {
  const requested = (requestedRaw || "").trim();
  const allProviders = input.providers ?? listGatewayProviders();
  const providers = enabledProviders(allProviders);
  const routes = input.routes ?? listGatewayRoutes();
  const config = input.config ?? readGatewayConfig();

  const candidates: RouteCandidate[] = [];
  const seen = new Set<string>();

  if (!requested) {
    throw new ModelNotRoutableError(
      "(empty)",
      listRoutableModelIds({ providers: allProviders, routes }),
    );
  }

  // 1. Explicit alias.
  const route = routes.find(
    (item) => item.alias.toLowerCase() === requested.toLowerCase(),
  );
  if (route) {
    const primary = findProvider(providers, route.provider);
    if (primary) {
      pushCandidate(
        candidates,
        seen,
        primary,
        route.model || requested,
        "route",
      );
    }
    for (const fallback of route.fallbacks || []) {
      const provider = findProvider(providers, fallback.provider);
      if (provider) {
        pushCandidate(
          candidates,
          seen,
          provider,
          fallback.model || route.model || requested,
          "route",
        );
      }
    }
  }

  // 2. Qualified provider reference.
  const qualified = splitQualified(requested);
  if (qualified) {
    const provider = findProvider(providers, qualified.provider);
    if (provider) {
      pushCandidate(candidates, seen, provider, qualified.model, "qualified");
    }
  }

  // 3. Bare model id declared by providers, ordered by priority.
  const bare = qualified ? qualified.model : requested;
  for (const provider of providers) {
    if (providerHasModel(provider, bare)) {
      pushCandidate(candidates, seen, provider, bare, "model-list");
    }
  }

  // 4. Passthrough providers (no declared model list).
  for (const provider of providers) {
    if (!provider.models.length) {
      pushCandidate(candidates, seen, provider, bare, "passthrough");
    }
  }

  // 5. Configured default provider.
  if (config.defaultProvider) {
    const provider = findProvider(providers, config.defaultProvider);
    if (provider) {
      pushCandidate(candidates, seen, provider, bare, "default");
    }
  }

  if (!candidates.length) {
    throw new ModelNotRoutableError(
      requested,
      listRoutableModelIds({ providers: allProviders, routes }),
    );
  }

  const maxAttempts = config.fallback.enabled
    ? Math.max(1, config.fallback.maxAttempts)
    : 1;

  return { requested, candidates: candidates.slice(0, maxAttempts) };
}

export interface RoutableModel {
  id: string;
  provider: string;
  /** Upstream model id when the client-visible id is an alias. */
  upstreamModel: string;
  format: string;
}

/** Client-visible model catalogue: aliases, bare ids and qualified ids. */
export function listRoutableModels(input: RouterInput = {}): RoutableModel[] {
  const providers = enabledProviders(input.providers ?? listGatewayProviders());
  const routes = input.routes ?? listGatewayRoutes();
  const out: RoutableModel[] = [];
  const seen = new Set<string>();

  const add = (
    id: string,
    provider: GatewayProvider,
    upstreamModel: string,
  ): void => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({
      id,
      provider: provider.name,
      upstreamModel,
      format: provider.apiFormat,
    });
  };

  for (const route of routes) {
    const provider = providers.find(
      (item) => item.name.toLowerCase() === route.provider.toLowerCase(),
    );
    if (provider) add(route.alias, provider, route.model || route.alias);
  }
  for (const provider of providers) {
    for (const model of provider.models) {
      add(model, provider, model);
    }
  }
  // Qualified ids are always addressable, listed after the bare ids.
  for (const provider of providers) {
    for (const model of provider.models) {
      add(`${provider.name}/${model}`, provider, model);
    }
  }
  return out;
}

export function listRoutableModelIds(input: RouterInput = {}): string[] {
  return listRoutableModels(input).map((model) => model.id);
}
