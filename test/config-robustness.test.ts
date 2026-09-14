import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atomicWriteFile,
  backupFile,
  isPlainObject,
  plainObjectAt,
  readStructuredFile,
  stringRecordAt,
  writeFilesAtomically,
} from "../src/utils/fs.ts";
import { readClaudeSettings, buildClaudeSettings } from "../src/adapters/claude.ts";
import { readCodexConfig } from "../src/adapters/codex.ts";
import { readOpenCodeConfig } from "../src/adapters/opencode.ts";
import { listProfiles, readProfile, resolveProfile } from "../src/store/profiles.ts";
import { getProfilesDir } from "../src/utils/paths.ts";
import type { Profile } from "../src/types.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "llms-robust-"));
  process.env.LLM_SWITCH_HOME = join(root, "llms-home");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.LLM_SWITCH_HOME;
});

describe("readStructuredFile", () => {
  test("missing file uses the fallback", () => {
    const value = readStructuredFile(join(root, "nope.json"), JSON.parse, {
      label: "测试配置",
      fallback: () => ({ ok: true }),
    });
    expect(value).toEqual({ ok: true });
  });

  test("empty file counts as not-yet-configured, not a parse error", () => {
    const path = join(root, "empty.json");
    writeFileSync(path, "   \n");
    const value = readStructuredFile(path, JSON.parse, {
      label: "测试配置",
      fallback: () => ({ ok: true }),
    });
    expect(value).toEqual({ ok: true });
  });

  test("broken syntax throws an actionable error naming the file", () => {
    const path = join(root, "broken.json");
    writeFileSync(path, '{ "a": 1,, }');
    expect(() =>
      readStructuredFile(path, JSON.parse, {
        label: "测试配置",
        fallback: () => ({}),
      }),
    ).toThrow(/测试配置.*broken\.json.*解析失败/s);
  });
});

describe("adapters survive a broken user config", () => {
  test("claude settings.json with a syntax error reports the path", () => {
    const path = join(root, "settings.json");
    writeFileSync(path, "{ oops");
    expect(() => readClaudeSettings(path)).toThrow(
      /Claude Code 配置.*settings\.json/s,
    );
  });

  test("codex config.toml with a syntax error reports the path", () => {
    const path = join(root, "config.toml");
    writeFileSync(path, "this is = = not toml");
    expect(() => readCodexConfig(path)).toThrow(/Codex 配置.*config\.toml/s);
  });

  test("opencode opencode.json with a syntax error reports the path", () => {
    const path = join(root, "opencode.json");
    writeFileSync(path, "[[[");
    expect(() => readOpenCodeConfig(path)).toThrow(
      /OpenCode 配置.*opencode\.json/s,
    );
  });
});

describe("non-object fields in someone else's config are not spread", () => {
  test("plainObjectAt rejects arrays and scalars", () => {
    expect(plainObjectAt({ a: ["x", "y"] }, "a")).toEqual({});
    expect(plainObjectAt({ a: "str" }, "a")).toEqual({});
    expect(plainObjectAt({ a: null }, "a")).toEqual({});
    expect(plainObjectAt({ a: { b: 1 } }, "a")).toEqual({ b: 1 });
  });

  test("stringRecordAt drops non-stringable values", () => {
    expect(stringRecordAt({ env: { A: "1", B: 2, C: true, D: { x: 1 } } }, "env")).toEqual(
      { A: "1", B: "2", C: "true" },
    );
    expect(stringRecordAt({ env: ["nope"] }, "env")).toEqual({});
  });

  test("isPlainObject", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
  });

  test("claude env that is an array does not produce index keys", () => {
    const profile: Profile = {
      name: "p1",
      displayName: "P1",
      apiFormat: "anthropic",
      baseUrl: "https://api.example.com",
      apiKey: "sk-k",
      models: { default: "m1", list: ["m1"] },
      headers: {},
      updatedAt: new Date().toISOString(),
    };
    const next = buildClaudeSettings(
      { env: ["bogus"] as unknown as Record<string, string> },
      profile,
    );
    expect(next.env).not.toHaveProperty("0");
    expect(next.env?.ANTHROPIC_MODEL).toBe("m1");
  });
});

describe("backup rotation", () => {
  test("keeps at most 10 backups per label", () => {
    const source = join(root, "settings.json");
    const backups = join(root, "backups");
    for (let i = 0; i < 15; i++) {
      writeFileSync(source, `{"i":${i}}`);
      backupFile(source, backups, "settings");
    }
    const files = readdirSync(backups).filter((f) => f.startsWith("settings-"));
    expect(files.length).toBe(10);
  });

  test("different labels are rotated independently", () => {
    const source = join(root, "x");
    const backups = join(root, "backups2");
    for (let i = 0; i < 12; i++) {
      writeFileSync(source, String(i));
      backupFile(source, backups, "config");
      backupFile(source, backups, "env");
    }
    const names = readdirSync(backups);
    expect(names.filter((f) => f.startsWith("config-")).length).toBe(10);
    expect(names.filter((f) => f.startsWith("env-")).length).toBe(10);
  });
});

describe("writeFilesAtomically", () => {
  test("rolls back an earlier file when a later write fails", () => {
    const a = join(root, "a.json");
    const b = join(root, "sub-as-file");
    writeFileSync(a, "original");
    // b 的父目录是一个已存在的普通文件，写入必然失败
    writeFileSync(join(root, "blocker"), "x");
    const bad = join(root, "blocker", "child.json");
    expect(() =>
      writeFilesAtomically([
        { path: a, content: "updated" },
        { path: bad, content: "never" },
      ]),
    ).toThrow();
    expect(readFileSync(a, "utf8")).toBe("original");
    expect(existsSync(b)).toBe(false);
  });

  test("removes a newly created file when a later write fails", () => {
    const fresh = join(root, "fresh.json");
    writeFileSync(join(root, "blocker2"), "x");
    expect(() =>
      writeFilesAtomically([
        { path: fresh, content: "new" },
        { path: join(root, "blocker2", "child.json"), content: "never" },
      ]),
    ).toThrow();
    expect(existsSync(fresh)).toBe(false);
  });

  test("all-success leaves every file written", () => {
    const a = join(root, "ok-a");
    const b = join(root, "ok-b");
    writeFilesAtomically([
      { path: a, content: "A" },
      { path: b, content: "B" },
    ]);
    expect(readFileSync(a, "utf8")).toBe("A");
    expect(readFileSync(b, "utf8")).toBe("B");
  });
});

describe("atomicWriteFile temp files", () => {
  test("no temp file is left behind after a successful write", () => {
    const target = join(root, "dir", "file.json");
    atomicWriteFile(target, "{}");
    const leftovers = readdirSync(join(root, "dir")).filter((f) =>
      f.endsWith(".tmp"),
    );
    expect(leftovers).toEqual([]);
  });
});

describe("profile store robustness", () => {
  function writeRawProfile(name: string, body: string) {
    const dir = getProfilesDir("claude");
    atomicWriteFile(join(dir, `${name}.json`), body);
  }

  test("a corrupt profile is skipped instead of breaking the whole list", () => {
    writeRawProfile("good1", JSON.stringify({
      name: "good1",
      displayName: "Good",
      apiFormat: "anthropic",
      baseUrl: "https://api.example.com",
      apiKey: "sk-k",
      models: { default: "m", list: ["m"] },
      updatedAt: new Date().toISOString(),
    }));
    writeRawProfile("broken", "{ not json");

    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    try {
      const list = listProfiles("claude");
      expect(list.map((p) => p.name)).toEqual(["good1"]);
      expect(warnings.join("\n")).toMatch(/broken/);
    } finally {
      console.warn = warn;
    }
  });

  test("an invalid apiFormat fails loudly at read time", () => {
    writeRawProfile("weird", JSON.stringify({
      name: "weird",
      apiFormat: "not-a-format",
      baseUrl: "https://api.example.com",
      models: { default: "m", list: ["m"] },
    }));
    expect(() => readProfile("claude", "weird")).toThrow(/apiFormat/);
  });

  test("a separators-only query does not fuzzy-match everything", () => {
    writeRawProfile("abc12", JSON.stringify({
      name: "abc12",
      displayName: "Something",
      apiFormat: "anthropic",
      baseUrl: "https://api.example.com",
      models: { default: "m", list: ["m"] },
      updatedAt: new Date().toISOString(),
    }));
    expect(resolveProfile("claude", "---")).toBeNull();
    expect(resolveProfile("claude", "abc12")?.name).toBe("abc12");
  });
});
