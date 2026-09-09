import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InstallLayout } from "../../src/install-layout";
import { inspectInstallation } from "../../src/install/doctor";
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
