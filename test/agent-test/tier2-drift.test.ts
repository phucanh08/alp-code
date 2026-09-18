import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { testAgent } from "../../src/agent-test";
import { codexSandboxProbe, type SandboxProbe } from "../../src/agent-test/sandbox-probe";
import { agentRegistry } from "../../src/agents/registry";
import { capabilitiesFor } from "../../src/runtime/capabilities";
import { cleanupDryRuns } from "../support/agent-dry-run";
import { removeTemporary } from "../support/temporary-root";

const REPO_ROOT = process.cwd();
const ENVIRONMENT = {
  hooksDirectory: join(REPO_ROOT, "hooks"),
  skillsRoot: join(REPO_ROOT, "skills"),
  env: { HOME: tmpdir(), PATH: process.env.PATH ?? "" },
};

const roots: string[] = [];
afterEach(cleanupDryRuns);
afterEach(async () => Promise.all(roots.splice(0).map(removeTemporary)));

/**
 * A `codex` that answers `--version` and runs `codex sandbox … -- <command>`. With
 * `FAKE_CODEX_ENFORCE=1` it refuses to run anything under `workspace-write`, the way the real
 * seatbelt refuses a write outside the writable roots; without it, it runs the command as
 * given — a runtime whose sandbox has silently stopped enforcing.
 */
const FAKE_CODEX = `"use strict";
const argv = process.argv.slice(2);
if (argv[0] === "--version") { process.stdout.write("codex-cli 0.154.0\\n"); process.exit(0); }
if (argv[0] !== "sandbox") { process.stderr.write("unexpected: " + argv.join(" ") + "\\n"); process.exit(2); }
// codex 0.154 refuses to run without a named permission profile — exit 2, nothing executed.
if (process.env.FAKE_CODEX_USAGE_ERROR === "1" || !argv.includes("-P")) {
  process.stderr.write("error: the following required arguments were not provided:\\n  --permission-profile <NAME>\\n");
  process.exit(2);
}
const mode = argv[argv.indexOf("-P") + 1];
const command = argv.slice(argv.indexOf("--") + 1);
if (process.env.FAKE_CODEX_ENFORCE === "1" && mode === ":workspace") {
  process.stderr.write("Operation not permitted\\n");
  process.exit(1);
}
const result = require("node:child_process").spawnSync(command[0], command.slice(1), { stdio: "inherit" });
process.exit(result.status === null ? 1 : result.status);
`;

async function fakeCodexBin(): Promise<{ readonly bin: string; readonly home: string }> {
  const root = await mkdtemp(join(tmpdir(), "alp-fake-codex-"));
  roots.push(root);
  const bin = join(root, "bin");
  const home = join(root, "home");
  await mkdir(bin, { recursive: true });
  await mkdir(home, { recursive: true });
  const script = join(bin, "codex.js");
  await writeFile(script, FAKE_CODEX);
  if (process.platform === "win32") {
    await writeFile(join(bin, "codex.cmd"), `@ECHO off\r\n"${process.execPath}" "%~dp0\\codex.js" %*\r\n`);
  } else {
    await writeFile(join(bin, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
    await chmod(join(bin, "codex"), 0o755);
  }
  return { bin, home };
}

const driftCheck = (report: Awaited<ReturnType<typeof testAgent>>) =>
  report.checks.find((check) => check.id === "enforcement-drift");

/**
 * Tier 2 compares the table `policy.enforcement` snapshots against what the sandbox on this
 * machine actually does. The table is a claim; `DRIFT` is the claim being wrong here, and a
 * principal has to see that before trusting a role on the strength of that claim.
 */
describe("alp agent test — tier 2 enforcement drift", () => {
  it("passes, naming what was probed, when the sandbox behaves as the table says", async () => {
    const table = capabilitiesFor("codex", "linux");
    const probe: SandboxProbe = async () => [
      { runtime: "codex", field: "writeIsolation", observed: table.writeIsolation, evidence: "write outside the writable roots refused" },
      { runtime: "codex", field: "readIsolation", observed: table.readIsolation, evidence: "read outside the workspace succeeded" },
    ];
    const report = await testAgent({ role: "worker", registry: agentRegistry, ...ENVIRONMENT, probe, platform: "linux" });

    expect(driftCheck(report)).toMatchObject({ tier: 2, status: "pass" });
    expect(driftCheck(report)?.detail).toMatch(/probed codex: readIsolation, writeIsolation/);
    expect(report.ok).toBe(true);
  });

  it("fails with DRIFT naming the field, the table's claim and the measurement", async () => {
    const probe: SandboxProbe = async () => [
      { runtime: "codex", field: "writeIsolation", observed: "none", evidence: "wrote outside the writable roots" },
      { runtime: "codex", field: "readIsolation", observed: "none", evidence: "read outside the workspace succeeded" },
    ];
    const report = await testAgent({ role: "worker", registry: agentRegistry, ...ENVIRONMENT, probe, platform: "linux" });

    expect(driftCheck(report)).toMatchObject({ tier: 2, status: "fail" });
    expect(driftCheck(report)?.detail).toContain("DRIFT(codex writeIsolation: table says enforced, measured none");
    expect(driftCheck(report)?.detail).not.toContain("readIsolation: table");
    expect(report.ok).toBe(false);
    expect(report.stoppedAt).toBe(2);
  });

  it("is a pass that says so when nothing can be probed on this machine", async () => {
    const report = await testAgent({ role: "worker", registry: agentRegistry, ...ENVIRONMENT, probe: async () => null });

    expect(driftCheck(report)).toMatchObject({ tier: 2, status: "pass" });
    expect(driftCheck(report)?.detail).toContain("not probed");
  });

  it("does not probe at all when no probe is supplied", async () => {
    const report = await testAgent({ role: "worker", registry: agentRegistry, ...ENVIRONMENT });
    expect(driftCheck(report)).toMatchObject({ tier: 2, status: "pass" });
    expect(driftCheck(report)?.detail).toContain("not probed");
  });
});

describe("codexSandboxProbe — the real probe against a fake codex", () => {
  it("measures a sandbox that enforces as the table says", async () => {
    const { bin, home } = await fakeCodexBin();
    const results = await codexSandboxProbe({ env: { PATH: bin, HOME: home, FAKE_CODEX_ENFORCE: "1" }, platform: "linux" })({ runtime: "codex" });

    expect(results).not.toBeNull();
    const byField = Object.fromEntries((results ?? []).map((result) => [result.field, result.observed]));
    expect(byField).toEqual({ writeIsolation: "enforced", readIsolation: "none" });
  });

  it("measures a sandbox that has stopped refusing writes as `none`", async () => {
    const { bin, home } = await fakeCodexBin();
    const results = await codexSandboxProbe({ env: { PATH: bin, HOME: home }, platform: "linux" })({ runtime: "codex" });

    const byField = Object.fromEntries((results ?? []).map((result) => [result.field, result.observed]));
    expect(byField.writeIsolation).toBe("none");
  });

  /**
   * A `codex sandbox` that never ran the command (a usage error, a missing profile) refuses
   * nothing: reading its exit status as "write refused" would print `enforced` for a sandbox
   * that was never entered. The probe has to fail, and tier 2 turns that into a failed check.
   */
  it("throws, rather than reporting `enforced`, when codex sandbox does not run at all", async () => {
    const { bin, home } = await fakeCodexBin();
    await expect(codexSandboxProbe({ env: { PATH: bin, HOME: home, FAKE_CODEX_USAGE_ERROR: "1" }, platform: "linux" })({ runtime: "codex" }))
      .rejects.toThrow(/codex sandbox did not run/);
  });

  it("answers null when codex is not on PATH, on Windows, or for Claude", async () => {
    const { home } = await fakeCodexBin();
    await expect(codexSandboxProbe({ env: { PATH: home, HOME: home }, platform: "linux" })({ runtime: "codex" })).resolves.toBeNull();
    const { bin } = await fakeCodexBin();
    await expect(codexSandboxProbe({ env: { PATH: bin, HOME: home }, platform: "win32" })({ runtime: "codex" })).resolves.toBeNull();
    await expect(codexSandboxProbe({ env: { PATH: bin, HOME: home }, platform: "linux" })({ runtime: "claude" })).resolves.toBeNull();
  });

  /**
   * Codex's `workspace-write` allows `/tmp` and `$TMPDIR` by default, so a probe that wrote
   * under the system temp directory would report `none` for a sandbox that is working. The
   * probe has to write somewhere the sandbox actually covers.
   */
  it("probes under HOME, never under the system temp directory", async () => {
    const { bin, home } = await fakeCodexBin();
    const seen: string[] = [];
    await codexSandboxProbe({
      env: { PATH: bin, HOME: home },
      platform: "linux",
      run: async (command, args) => {
        seen.push(...args);
        // Echo the control marker so the probe goes on to the write and read.
        return { status: 0, stdout: `${args[args.length - 1]}\n` };
      },
    })({ runtime: "codex" });
    const targets = seen.filter((arg) => arg.startsWith(home));
    expect(targets.length).toBeGreaterThan(0);
    expect(seen.some((arg) => arg.startsWith(tmpdir()) && !arg.startsWith(home))).toBe(false);
  });
});
