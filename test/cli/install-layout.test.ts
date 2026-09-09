import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveInstallLayout } from "../../src/install-layout";
import { removeTemporary } from "../support/temporary-root";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(removeTemporary)));

async function artifact(version = "0.10.0", target = "darwin-arm64"): Promise<{ root: string; executable: string }> {
  const parent = await mkdtemp(join(tmpdir(), "alp layout with spaces "));
  roots.push(parent);
  const root = join(parent, "versions", `v${version}`);
  const executable = join(root, "bin", "alp");
  await mkdir(join(root, "bin"), { recursive: true });
  await mkdir(join(root, "skills"));
  await mkdir(join(root, "scaffold"));
  await writeFile(executable, "binary\n");
  await chmod(executable, 0o755);
  await writeFile(
    join(root, "install-manifest.json"),
    `${JSON.stringify({ schemaVersion: 1, app: "alp-code", version, target, compiler: { name: "bun", version: "1.4.2" } }, null, 2)}\n`,
  );
  return { root, executable };
}

describe("InstallLayout", () => {
  it("separates a versioned binary from its stable command", async () => {
    const built = await artifact();
    const home = join(built.root, "..", "..");
    await mkdir(join(home, "bin"));
    await symlink(built.root, join(home, "current"));
    await symlink(join("..", "current", "bin", "alp"), join(home, "bin", "alp"));

    const layout = resolveInstallLayout({ executable: built.executable, version: "0.10.0", platform: "darwin" });
    expect(layout).toEqual({
      channel: "binary",
      version: "0.10.0",
      selfExecutable: built.executable,
      stableCommand: join(home, "bin", "alp"),
      installRoot: built.root,
      assetRoot: built.root,
    });
    expect(layout.selfExecutable).not.toBe(layout.stableCommand);
  });

  it("accepts validated npm-wrapper handoff metadata without losing spaces", async () => {
    const built = await artifact();
    const stable = join(built.root, "..", "npm global with spaces", "alp");
    const layout = resolveInstallLayout({
      executable: built.executable,
      version: "0.10.0",
      platform: "darwin",
      env: {
        ALP_LAYOUT_CHANNEL: "npm",
        ALP_INSTALL_ROOT: built.root,
        ALP_STABLE_COMMAND: stable,
        ALP_WRAPPER_VERSION: "0.10.0",
      },
    });
    expect(layout.channel).toBe("npm");
    expect(layout.installRoot).toBe(built.root);
    expect(layout.stableCommand).toBe(stable);
  });

  it("rejects forged or stale npm wrapper metadata", async () => {
    const built = await artifact();
    const base = {
      ALP_LAYOUT_CHANNEL: "npm",
      ALP_INSTALL_ROOT: built.root,
      ALP_STABLE_COMMAND: join(built.root, "..", "alp"),
    };
    expect(() => resolveInstallLayout({ executable: built.executable, version: "0.10.0", env: base }))
      .toThrow(/wrapper version/);
    expect(() => resolveInstallLayout({ executable: built.executable, version: "0.10.0", env: { ...base, ALP_WRAPPER_VERSION: "0.9.0" } }))
      .toThrow(/wrapper version/);
  });

  it("resolves a development clone without requiring an artifact manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-dev-layout-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    await mkdir(join(root, "scripts"));
    await mkdir(join(root, "skills"));
    await mkdir(join(root, "scaffold"));
    await writeFile(join(root, "package.json"), '{"name":"alp-code","version":"0.10.0"}\n');
    await writeFile(join(root, "scripts", "alp.cjs"), "");

    expect(resolveInstallLayout({ executable: process.execPath, version: "0.10.0", devRoot: root })).toEqual({
      channel: "dev",
      version: "0.10.0",
      selfExecutable: process.execPath,
      stableCommand: join(root, "scripts", "alp.cjs"),
      installRoot: root,
      assetRoot: root,
    });
  });

  it("rejects incomplete, foreign and version-mismatched artifacts clearly", async () => {
    const built = await artifact();
    await expect(async () => resolveInstallLayout({ executable: built.executable, version: "0.10.1" }))
      .rejects.toThrow(/manifest version 0\.10\.0 does not match executable version 0\.10\.1/);

    const missing = await mkdtemp(join(tmpdir(), "alp-layout-missing-"));
    roots.push(missing);
    await mkdir(join(missing, "bin"));
    await writeFile(join(missing, "bin", "alp"), "");
    expect(() => resolveInstallLayout({ executable: join(missing, "bin", "alp"), version: "0.10.0" }))
      .toThrow(/install-manifest\.json/);
  });
});
