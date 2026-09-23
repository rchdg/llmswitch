import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProgram } from "../src/cli.ts";
import { getVersion } from "../src/utils/version.ts";
import { saveProfile } from "../src/store/profiles.ts";
import type { Profile } from "../src/types.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "llms-cli-"));
  process.env.LLM_SWITCH_HOME = join(root, "llms-home");
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
  process.env.CODEX_HOME = join(root, "codex");
  process.env.OPENCODE_CONFIG_DIR = join(root, "opencode");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.LLM_SWITCH_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  delete process.env.OPENCODE_CONFIG_DIR;
});

function seedProfile(): Profile {
  const profile: Profile = {
    name: "aaa11",
    displayName: "DeepSeek",
    apiFormat: "anthropic",
    baseUrl: "https://api.deepseek.com/anthropic",
    apiKey: "sk-test-key",
    models: { default: "deepseek-chat", list: ["deepseek-chat"] },
    headers: {},
    updatedAt: new Date().toISOString(),
  };
  saveProfile("claude", profile);
  return profile;
}

/** Run the real CLI in-process and capture stdout. */
async function runCli(argv: string[]): Promise<string> {
  const chunks: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    chunks.push(args.map(String).join(" "));
  };
  try {
    await createProgram().parseAsync(["node", "llms", ...argv]);
  } finally {
    console.log = original;
  }
  return chunks.join("\n");
}

describe("cli --json wiring", () => {
  // Regression: declaring --json on the root program made commander treat it as
  // a root option, so every subcommand's own --json stayed undefined. That both
  // broke JSON output everywhere and made `provider --json` fall into the
  // interactive menu (hanging on non-TTY stdin).
  test("root program declares no --json option", () => {
    const rootFlags = createProgram()
      .options.map((opt) => opt.long)
      .filter(Boolean);
    expect(rootFlags).not.toContain("--json");
  });

  test("<tool> current --json prints JSON", async () => {
    seedProfile();
    const out = await runCli(["claude", "current", "--json"]);
    const parsed = JSON.parse(out) as { default: { name: string } | null };
    expect(parsed.default?.name).toBe("aaa11");
  });

  test("<tool> provider --json prints an array and never prompts", async () => {
    seedProfile();
    const out = await runCli(["claude", "provider", "--json"]);
    const parsed = JSON.parse(out) as Array<{ name: string; apiKey: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.name).toBe("aaa11");
    // 列表输出必须脱敏
    expect(parsed[0]!.apiKey).not.toContain("sk-test-key");
  });

  test("every subcommand that supports JSON declares its own --json", () => {
    const program = createProgram();
    const withJson: string[] = [];
    const walk = (cmd: typeof program, path: string[]) => {
      const name = cmd.name();
      const here = name === "llms" ? path : [...path, name];
      if (cmd.options.some((opt) => opt.long === "--json")) {
        withJson.push(here.join(" "));
      }
      for (const sub of cmd.commands) walk(sub as typeof program, here);
    };
    walk(program, []);
    // 抽查几个高频命令，确保 --json 挂在子命令而不是根命令上
    expect(withJson).toContain("claude current");
    expect(withJson).toContain("bridge status");
    expect(withJson).toContain("gateway status");
    expect(withJson).toContain("launch");
  });
});

describe("version flag", () => {
  /**
   * Run `-v`/`--version` and capture the version commander writes to stdout.
   *
   * exitOverride() is required: without it commander's version handler calls
   * process.exit(0) and tears down the whole test runner.
   */
  async function runVersionFlag(flag: string): Promise<string> {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((str: string | Uint8Array) => {
      chunks.push(typeof str === "string" ? str : Buffer.from(str).toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      await createProgram().exitOverride().parseAsync(["node", "llms", flag]);
    } catch {
      // commander.version throws under exitOverride; the output is what matters.
    } finally {
      process.stdout.write = original;
    }
    return chunks.join("").trim();
  }

  test("-v prints the package.json version", async () => {
    const pkg = JSON.parse(
      await Bun.file(new URL("../package.json", import.meta.url)).text(),
    ) as { version: string };
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(await runVersionFlag("-v")).toBe(pkg.version);
  });

  test("--version prints the same version", async () => {
    expect(await runVersionFlag("--version")).toBe(getVersion());
  });

  test("the root program advertises -v, not -V", () => {
    const versionOption = createProgram().options.find((opt) =>
      opt.long === "--version",
    );
    expect(versionOption?.short).toBe("-v");
  });
});
