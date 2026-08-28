/**
 * Gateway listener resolution and exposure guards.
 *
 * The gateway is intended for third-party traffic, so binding it to a
 * non-loopback address requires both an explicit opt-in and at least one active
 * API key. Otherwise an unauthenticated model proxy would be reachable from the
 * network.
 */

import {
  advertiseHostForBind,
  isLoopbackHost,
  normalizeHost,
  parseBridgePort,
} from "../bridge/runtime.js";
import { hasAnyActiveKey } from "./keys.js";
import type { GatewayListenerState } from "./types.js";

export function parseGatewayPort(value: string | number): number {
  return parseBridgePort(value);
}

export class GatewayExposureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayExposureError";
  }
}

export function assertGatewayListenerAllowed(
  host: string,
  allowRemote: boolean,
  options: { requireKey?: boolean } = {},
): void {
  if (isLoopbackHost(host)) return;
  if (!allowRemote) {
    throw new GatewayExposureError(
      `非回环监听地址 ${host || "(empty)"} 必须显式传入 --allow-remote`,
    );
  }
  const requireKey = options.requireKey !== false;
  if (requireKey && !hasAnyActiveKey()) {
    throw new GatewayExposureError(
      "对外暴露前必须至少存在一个有效 API Key。请先执行：llms gateway key create",
    );
  }
}

export function resolveGatewayListener(options: {
  host: string;
  port: string | number;
  allowRemote: boolean;
  advertiseHost?: string;
  requireKey?: boolean;
}): GatewayListenerState {
  const bindHost = normalizeHost(options.host);
  assertGatewayListenerAllowed(bindHost, options.allowRemote, {
    requireKey: options.requireKey,
  });
  return {
    bindHost,
    advertiseHost: options.advertiseHost
      ? normalizeHost(options.advertiseHost)
      : advertiseHostForBind(bindHost),
    port: parseGatewayPort(options.port),
    allowRemote: options.allowRemote,
  };
}

export { isLoopbackHost };
