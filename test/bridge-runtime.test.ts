import { describe, expect, test } from "bun:test";
import {
  DEFAULT_BRIDGE_RUNTIME_LIMITS,
  advertiseHostForBind,
  assertBridgeListenerAllowed,
  formatHostForUrl,
  isLoopbackHost,
  normalizeHost,
  parseBridgePort,
  parseBridgeRuntimeLimits,
  resolveBridgeListener,
} from "../src/bridge/runtime.ts";

describe("bridge host primitives", () => {
  test("recognizes only the specified loopback forms", () => {
    for (const host of [
      "localhost",
      "LOCALHOST",
      "127.0.0.1",
      "127.255.1.2",
      "::1",
      "[::1]",
      "0:0:0:0:0:0:0:1",
      "::ffff:127.0.0.1",
      "0:0:0:0:0:ffff:7f00:1",
    ]) {
      expect(isLoopbackHost(host)).toBe(true);
    }

    for (const host of [
      "",
      "0.0.0.0",
      "::",
      "192.168.1.2",
      "example.test",
      "::ffff:192.168.1.2",
    ]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });

  test("normalizes brackets and formats IPv6 URLs", () => {
    expect(normalizeHost(" [::1] ")).toBe("::1");
    expect(formatHostForUrl("::1")).toBe("[::1]");
    expect(formatHostForUrl("[::1]")).toBe("[::1]");
    expect(formatHostForUrl("127.0.0.1")).toBe("127.0.0.1");
  });

  test("requires an explicit remote opt-in", () => {
    expect(() => assertBridgeListenerAllowed("0.0.0.0", false)).toThrow(
      /allow-remote/i,
    );
    expect(() => assertBridgeListenerAllowed("::", false)).toThrow(
      /allow-remote/i,
    );
    expect(() => assertBridgeListenerAllowed("0.0.0.0", true)).not.toThrow();
    expect(() => assertBridgeListenerAllowed("127.0.0.1", false)).not.toThrow();
  });

  test("derives connectable advertise hosts for wildcard binds", () => {
    expect(advertiseHostForBind("0.0.0.0")).toBe("127.0.0.1");
    expect(advertiseHostForBind("")).toBe("127.0.0.1");
    expect(advertiseHostForBind("::")).toBe("::1");
    expect(advertiseHostForBind("[::1]")).toBe("::1");

    expect(
      resolveBridgeListener({
        host: "::",
        port: 17890,
        allowRemote: true,
      }),
    ).toEqual({
      bindHost: "::",
      advertiseHost: "::1",
      port: 17890,
      allowRemote: true,
    });
  });
});

describe("bridge runtime parsing", () => {
  test("parses ports strictly", () => {
    expect(parseBridgePort("1")).toBe(1);
    expect(parseBridgePort(65535)).toBe(65535);
    for (const value of ["", "0", "65536", "1.5", "12x", -1, NaN]) {
      expect(() => parseBridgePort(value)).toThrow(/port/i);
    }
  });

  test("uses documented defaults and accepts boundary overrides", () => {
    expect(parseBridgeRuntimeLimits({})).toEqual(
      DEFAULT_BRIDGE_RUNTIME_LIMITS,
    );
    expect(
      parseBridgeRuntimeLimits({
        LLM_SWITCH_MAX_BODY_BYTES: "1024",
        LLM_SWITCH_MAX_RESPONSE_BYTES: "134217728",
        LLM_SWITCH_MAX_SSE_FRAME_BYTES: "16777216",
        LLM_SWITCH_CONNECT_TIMEOUT_MS: "120000",
        LLM_SWITCH_IDLE_TIMEOUT_MS: "600000",
        LLM_SWITCH_TOTAL_TIMEOUT_MS: "3600000",
        LLM_SWITCH_MAX_CONCURRENCY: "128",
        LLM_SWITCH_RATE_LIMIT_PER_MINUTE: "10000",
      }),
    ).toEqual({
      maxBodyBytes: 1024,
      maxResponseBytes: 134217728,
      maxSseFrameBytes: 16777216,
      connectTimeoutMs: 120000,
      idleTimeoutMs: 600000,
      totalTimeoutMs: 3600000,
      maxConcurrency: 128,
      rateLimitPerMinute: 10000,
    });
  });

  test("rejects malformed or out-of-range runtime values", () => {
    for (const value of ["0", "1023", "1.5", " 1024", "nope"]) {
      expect(() =>
        parseBridgeRuntimeLimits({ LLM_SWITCH_MAX_BODY_BYTES: value }),
      ).toThrow(/LLM_SWITCH_MAX_BODY_BYTES/);
    }
    expect(() =>
      parseBridgeRuntimeLimits({ LLM_SWITCH_MAX_CONCURRENCY: "129" }),
    ).toThrow(/LLM_SWITCH_MAX_CONCURRENCY/);
  });
});
