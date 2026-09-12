import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InstallLayout } from "../../src/install-layout";
import { inspectInstallation, inspectRuntimes } from "../../src/install/doctor";
import { hostBinaryTarget } from "../../src/install/targets";
import { removeTemporary } from "../support/temporary-root";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(removeTemporary)));

async function healthyFixture(): Promise<{ layout: InstallLayout; env: NodeJS.ProcessEnv; home: string }> {
  const root = await mkdtemp(join(tmpdir(), "alp-native-doctor-"));
  roots.push(root);
  const home = join(root, "install");
  const version = join(home, "versions", "v0.10.0");
  const state = join(root, "state");
  await mkdir(join(version, "bin"), { recursive: true });
  await mkdir(join(version, "skills"));
  await mkdir(join(version, "scaffold"));
  await writeFile(join(version, "bin", "alp"), "binary\n", { mode: 0o755 });
  await writeFile(join(version, "install-manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    app: "alp-code",
    version: "0.10.0",
    target: hostBinaryTarget().id,
    compiler: { name: "bun", version: "1.4.2" },
  })}\n`);
  await mkdir(join(home, "bin"));
  await symlink(join("versions", "v0.10.0"), join(home, "current"));
  await symlink(join("..", "current", "bin", "alp"), join(home, "bin", "alp"));
  for (const directory of ["memory", "executions", join("delegation", "installed")]) {
    await mkdir(join(state, directory), { recursive: true, mode: 0o700 });
  }
  await writeFile(join(state, "install.json"), "{}\n");
  return {
    home,
    env: { ALP_STATE_HOME: state, HOME: join(root, "user") },
    layout: {
      channel: "binary", version: "0.10.0", selfExecutable: join(version, "bin", "alp"),
      stableCommand: join(home, "bin", "alp"), installRoot: version, assetRoot: version,
    },
  };
}

describe("native doctor", () => {
  it("validates target, stable launcher and atomic current pointer", async () => {
    const fixture = await healthyFixture();
    expect(inspectInstallation(fixture.layout, fixture.env).findings).toEqual([]);

    await rm(join(fixture.home, "current"));
    await mkdir(join(fixture.home, "versions", "v0.9.0"));
    await symlink(join("versions", "v0.9.0"), join(fixture.home, "current"));
    const findings = inspectInstallation(fixture.layout, fixture.env).findings;
    expect(findings.some((item) => item.tag === "CURRENT" && item.message.includes("v0.9.0"))).toBe(true);
  });
});

/**
 * Oracle: P5 of the governance-loop plan — `alp doctor` prints, per runtime, the version the
 * binary itself answers, how it will authenticate (by presence of a key or a login, never
 * the value), and the enforcement table row with a warning when that row was measured on a
 * different version. A moved version is an observation, not a finding: blocking on it
 * would take `alp` down on every CLI update.
 */
describe("native doctor — runtime version, auth and enforcement table", () => {
  it("reports version, auth method and every cell of the table for each runtime", async () => {
    const observations = await inspectRuntimes({
      env: { ANTHROPIC_API_KEY: "sk-ant-secret-value", HOME: "/home/u" },
      platform: "darwin",
      versionOf: async (command) => command.startsWith("claude") ? "2.1.269" : "0.154.0",
      exists: (path) => path === join("/home/u", ".codex", "auth.json"),
    });

    const claude = observations.find((item) => item.tag === "ENFORCEMENT-CLAUDE")?.message ?? "";
    expect(claude).toContain("2.1.269");
    expect(claude).toContain("auth api-key");
    expect(claude).not.toContain("sk-ant-secret-value");
    expect(claude).toContain("writeIsolation enforced");
    expect(claude).toContain("networkEgress declared-only");
    expect(claude).toContain("measured on 2.1");
    expect(claude).not.toContain("not re-measured");

    const codex = observations.find((item) => item.tag === "ENFORCEMENT-CODEX")?.message ?? "";
    expect(codex).toContain("0.154.0");
    expect(codex).toContain("auth oauth");
    expect(codex).toContain("readIsolation none");
    expect(codex).toContain("toolGrant declared-only");
    expect(codex).not.toContain("not re-measured");
  });

  it("warns that the table was not re-measured when the version moved or could not be read", async () => {
    const observations = await inspectRuntimes({
      env: { HOME: "/home/u" },
      platform: "linux",
      versionOf: async (command) => command.startsWith("claude") ? "2.2.0" : "unknown",
      exists: () => false,
    });
    const claude = observations.find((item) => item.tag === "ENFORCEMENT-CLAUDE")?.message ?? "";
    const codex = observations.find((item) => item.tag === "ENFORCEMENT-CODEX")?.message ?? "";
    expect(claude).toContain("not re-measured for 2.2.0");
    expect(codex).toContain("version unknown");
    expect(codex).toContain("not re-measured");
    expect(claude).toContain("auth unknown");
    // Observations only: nothing here is a broken install.
    expect(observations.every((item) => item.remediation === undefined)).toBe(true);
  });
});
