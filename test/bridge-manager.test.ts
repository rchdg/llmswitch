import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BridgeControlError,
  PortOccupiedError,
  isBridgeAlive,
  probeBridge,
  runBridgeForeground,
  startBridgeDaemon,
  stopBridge,
} from "../src/bridge/manager.ts";
import {
  generateBridgeToken,
  readBridgeState,
  updateBridgeState,
} from "../src/bridge/state.ts";

let root: string;
const children = new Set<ChildProcess>();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "llms-bridge-manager-"));
  process.env.LLM_SWITCH_HOME = join(root, "home");
});

afterEach(() => {
  for (const child of children) child.kill("SIGKILL");
  children.clear();
  rmSync(root, { recursive: true, force: true });
  delete process.env.LLM_SWITCH_HOME;
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition timed out");
}

async function spawnPortHolder(
  port: number,
  signalMarker: string,
): Promise<ChildProcess> {
  const fixture = join(import.meta.dir, "fixtures", "port-holder.mjs");
  const child = spawn(process.execPath, [fixture, String(port), signalMarker], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let output = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    output += String(chunk);
  });
  await waitFor(() => output.includes("READY"));
  return child;
}

describe("authenticated bridge lifecycle", () => {
  test("probe requires the recorded control token and instance ID", async () => {
    const port = await freePort();
    const running = runBridgeForeground("127.0.0.1", port, false);
    await waitFor(() => readBridgeState().instance !== null);

    const probe = await probeBridge("127.0.0.1", port);
    expect(probe).toMatchObject({
      reachable: true,
      healthy: true,
      authenticated: true,
    });
    expect(await isBridgeAlive("127.0.0.1", port)).toBe(true);

    const state = readBridgeState();
    updateBridgeState(
      (current) => ({
        ...current,
        instance: current.instance
          ? { ...current.instance, controlToken: generateBridgeToken() }
          : null,
      }),
      state.revision,
    );
    const rejected = await probeBridge("127.0.0.1", port);
    expect(rejected.reachable).toBe(true);
    expect(rejected.healthy).toBe(false);
    expect(rejected.authenticated).toBe(false);

    updateBridgeState(
      (current) => ({ ...current, instance: state.instance }),
      readBridgeState().revision,
    );
    expect(await stopBridge()).toBe(true);
    await running;
  });

  test("stops through the control endpoint and clears only its own identity", async () => {
    const port = await freePort();
    const running = runBridgeForeground("127.0.0.1", port, false);
    await waitFor(() => readBridgeState().instance !== null);
    const instanceId = readBridgeState().instance?.id;

    expect(await stopBridge()).toBe(true);
    await running;
    expect(readBridgeState().instance).toBeNull();
    expect(readBridgeState().pid).toBeNull();
    expect(readBridgeState().revision).toBeGreaterThan(1);
    expect(instanceId).toBeTruthy();
  });
});

describe("occupied port safety", () => {
  test("never signals an external listener or a reused recorded PID", async () => {
    const port = await freePort();
    const marker = join(root, "signal.txt");
    const holder = await spawnPortHolder(port, marker);
    const token = generateBridgeToken();
    const state = readBridgeState();
    updateBridgeState(
      (current) => ({
        ...current,
        listener: {
          bindHost: "127.0.0.1",
          advertiseHost: "127.0.0.1",
          port,
          allowRemote: false,
        },
        host: "127.0.0.1",
        port,
        pid: holder.pid ?? null,
        instance: {
          id: "stale-instance",
          controlToken: token,
          pid: holder.pid!,
          startedAt: new Date().toISOString(),
        },
      }),
      state.revision,
    );

    await expect(
      startBridgeDaemon("127.0.0.1", port),
    ).rejects.toBeInstanceOf(PortOccupiedError);
    await expect(stopBridge()).rejects.toBeInstanceOf(BridgeControlError);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(existsSync(marker)).toBe(false);
    expect(holder.exitCode).toBeNull();
    holder.kill("SIGKILL");
    children.delete(holder);
  });
});
