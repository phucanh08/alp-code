import { chmod, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_VERSION_TIMEOUT_MS,
  buildLaunchProvenance,
  createRuntimeVersionReader,
  detectAuthMethod,
  launchSpecDigest,
  parseRuntimeVersion,
  readLaunchReceipt,
  writeLaunchReceipt,
} from "../../src/runtime/launch-provenance";
import type { RuntimeLaunchSpec } from "../../src/runtime/runtime-adapter";
import { expectPosixMode } from "../support/file-mode";
import { removeTemporary } from "../support/temporary-root";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(removeTemporary)));

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "alp-launch-"));
  roots.push(root);
  return root;
}

function spec(overrides: Partial<RuntimeLaunchSpec> = {}): RuntimeLaunchSpec {
  return {
    command: "claude",
    args: ["--model", "opus", "ALP task is in /x/task.md; execute it."],
    cwd: "/workspace",
    env: { ALP_EXECUTION_ID: "exec_1", ALP_SESSION_CONTEXT: "/x/ctx.md" },
    temporaryFiles: ["/x/task.md"],
    ...overrides,
  };
}

/**
 * Oracle: the receipt says *how* the runtime authenticated, never *with what*. The detector
 * is handed the environment and an existence check, and the existence check is the only
 * thing allowed to touch the filesystem — so a test can prove no value was ever read.
 */
describe("detectAuthMethod — existence only, never a value", () => {
  it("reports api-key when the runtime's key variable is set, whatever its value", () => {
    expect(detectAuthMethod("claude", { ANTHROPIC_API_KEY: "sk-ant-x" }, () => false)).toBe("api-key");
    expect(detectAuthMethod("codex", { OPENAI_API_KEY: "sk-x" }, () => false)).toBe("api-key");
  });

  it("reports oauth from a token variable or the credentials file, without opening it", () => {
    expect(detectAuthMethod("claude", { CLAUDE_CODE_OAUTH_TOKEN: "t" }, () => false)).toBe("oauth");
    const asked: string[] = [];
    const exists = (path: string) => { asked.push(path); return path === join("/home/u", ".claude", ".credentials.json"); };
    expect(detectAuthMethod("claude", { HOME: "/home/u" }, exists)).toBe("oauth");
    expect(asked).toEqual([join("/home/u", ".claude", ".credentials.json")]);
  });

  it("honours CLAUDE_CONFIG_DIR and CODEX_HOME when locating the credentials file", () => {
    expect(detectAuthMethod("claude", { HOME: "/home/u", CLAUDE_CONFIG_DIR: "/cfg" }, (path) => path === join("/cfg", ".credentials.json"))).toBe("oauth");
    expect(detectAuthMethod("codex", { HOME: "/home/u", CODEX_HOME: "/cx" }, (path) => path === join("/cx", "auth.json"))).toBe("oauth");
    expect(detectAuthMethod("codex", { HOME: "/home/u" }, (path) => path === join("/home/u", ".codex", "auth.json"))).toBe("oauth");
  });

  it("prefers the explicit key over a stored login, matching how the runtimes resolve it", () => {
    expect(detectAuthMethod("claude", { ANTHROPIC_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "t" }, () => true)).toBe("api-key");
  });

  it("reports unknown when nothing is configured", () => {
    expect(detectAuthMethod("claude", { HOME: "/home/u" }, () => false)).toBe("unknown");
    expect(detectAuthMethod("codex", {}, () => false)).toBe("unknown");
  });
});

describe("parseRuntimeVersion", () => {
  it("extracts the dotted version from each runtime's --version line", () => {
    expect(parseRuntimeVersion("2.1.269 (Claude Code)\n")).toBe("2.1.269");
    expect(parseRuntimeVersion("codex-cli 0.154.0\n")).toBe("0.154.0");
  });

  it("returns null when no version is present", () => {
    expect(parseRuntimeVersion("")).toBeNull();
    expect(parseRuntimeVersion("command not found")).toBeNull();
  });
});

describe("createRuntimeVersionReader", () => {
  it("defaults to a two-second budget", () => {
    expect(DEFAULT_VERSION_TIMEOUT_MS).toBe(2000);
  });

  it("answers unknown, within the budget, when --version hangs", async () => {
    const root = await temporaryRoot();
    const hang = join(root, "hang.js");
    await writeFile(hang, "setTimeout(() => {}, 10_000);\n");
    const read = createRuntimeVersionReader({ timeoutMs: 150, versionArgs: [hang] });
    const started = Date.now();
    await expect(read(process.execPath)).resolves.toBe("unknown");
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("answers unknown when the binary is missing or prints nothing usable", async () => {
    const root = await temporaryRoot();
    const read = createRuntimeVersionReader({ timeoutMs: 1000 });
    await expect(read(join(root, "no-such-runtime"))).resolves.toBe("unknown");
    const silent = join(root, "silent.js");
    await writeFile(silent, "process.exit(0);\n");
    await expect(createRuntimeVersionReader({ timeoutMs: 1000, versionArgs: [silent] })(process.execPath)).resolves.toBe("unknown");
  });

  it("reads the version from a real --version and caches it by binary path and mtime", async () => {
    const root = await temporaryRoot();
    const binary = join(root, "codex");
    await writeFile(binary, `#!/bin/sh\necho "codex-cli 0.154.0"\n`, { mode: 0o755 });
    await chmod(binary, 0o755);
    let spawned = 0;
    const read = createRuntimeVersionReader({
      timeoutMs: 1000,
      run: async (command, args, timeoutMs) => {
        spawned += 1;
        // Shape of the real runner: stdout or null on any failure.
        const { execFile } = await import("node:child_process");
        return new Promise((settle) => execFile(command, args, { timeout: timeoutMs }, (error, stdout) => settle(error ? null : stdout)));
      },
    });

    expect(await read(binary)).toBe("0.154.0");
    expect(await read(binary)).toBe("0.154.0");
    expect(spawned).toBe(1);

    // A new binary at the same path is a new question.
    const { mtime } = await stat(binary);
    await utimes(binary, new Date(), new Date(mtime.getTime() + 5000));
    expect(await read(binary)).toBe("0.154.0");
    expect(spawned).toBe(2);
  });
});

/**
 * The digest identifies *what was launched*. Two launches with the same argv, cwd and set
 * of variable names are the same launch even when a variable's value differs — a value can
 * be a secret, and a digest that moved with it would leak one bit of it per run.
 */
describe("launchSpecDigest", () => {
  it("is stable across env values and moves with args, cwd and env names", () => {
    const base = launchSpecDigest(spec());
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(launchSpecDigest(spec({ env: { ALP_EXECUTION_ID: "exec_2", ALP_SESSION_CONTEXT: "/y" } }))).toBe(base);
    expect(launchSpecDigest(spec({ env: { ALP_SESSION_CONTEXT: "/x/ctx.md", ALP_EXECUTION_ID: "exec_1" } }))).toBe(base);
    expect(launchSpecDigest(spec({ env: { ...spec().env, EXTRA: "1" } }))).not.toBe(base);
    expect(launchSpecDigest(spec({ args: ["--model", "sonnet"] }))).not.toBe(base);
    expect(launchSpecDigest(spec({ cwd: "/elsewhere" }))).not.toBe(base);
    expect(launchSpecDigest(spec({ command: "codex" }))).not.toBe(base);
    // Temporary files are bookkeeping, not the launch.
    expect(launchSpecDigest(spec({ temporaryFiles: [] }))).toBe(base);
  });
});

describe("buildLaunchProvenance + receipt file", () => {
  it("assembles a v1 receipt from injected version and auth facts", async () => {
    const receipt = await buildLaunchProvenance({
      executionId: "exec_1",
      runtime: "claude",
      launchSpec: spec(),
      platform: "darwin",
      env: { ANTHROPIC_API_KEY: "sk-ant-secret-value" },
      launchedAt: "2026-09-12T10:00:00.000Z",
      versionOf: async () => "2.1.269",
      exists: () => false,
    });
    expect(receipt).toEqual({
      version: 1,
      executionId: "exec_1",
      runtime: "claude",
      runtimeVersion: "2.1.269",
      platform: "darwin",
      authMethod: "api-key",
      credentialConfigured: true,
      launchSpecDigest: launchSpecDigest(spec()),
      launchedAt: "2026-09-12T10:00:00.000Z",
    });
  });

  it("marks the credential as not configured only when the method is unknown", async () => {
    const receipt = await buildLaunchProvenance({
      executionId: "exec_1",
      runtime: "codex",
      launchSpec: spec({ command: "codex" }),
      platform: "linux",
      env: {},
      launchedAt: "2026-09-12T10:00:00.000Z",
      versionOf: async () => "unknown",
      exists: () => false,
    });
    expect(receipt.authMethod).toBe("unknown");
    expect(receipt.credentialConfigured).toBe(false);
    expect(receipt.runtimeVersion).toBe("unknown");
  });

  it("writes the receipt owner-only and reads it back; never a secret value", async () => {
    const root = await temporaryRoot();
    const file = join(root, "context", "launch.json");
    const secret = "sk-ant-secret-value-9f8e7d";
    const receipt = await buildLaunchProvenance({
      executionId: "exec_1",
      runtime: "claude",
      launchSpec: spec({ env: { ...spec().env, ANTHROPIC_API_KEY: secret } }),
      platform: "darwin",
      env: { ANTHROPIC_API_KEY: secret },
      launchedAt: "2026-09-12T10:00:00.000Z",
      versionOf: async () => "2.1.269",
      exists: () => false,
    });
    await writeLaunchReceipt(file, receipt);
    const raw = await readFile(file, "utf8");
    expect(raw).not.toContain(secret);
    expect(raw.endsWith("\n")).toBe(true);
    await expectPosixMode(file, 0o600);
    await expect(readLaunchReceipt(file)).resolves.toEqual(receipt);
  });

  it("reads null for a missing receipt and refuses a foreign version", async () => {
    const root = await temporaryRoot();
    await expect(readLaunchReceipt(join(root, "launch.json"))).resolves.toBeNull();
    await writeFile(join(root, "v2.json"), `${JSON.stringify({ version: 2 })}\n`);
    await expect(readLaunchReceipt(join(root, "v2.json"))).rejects.toThrowError(/launch receipt/);
  });
});
