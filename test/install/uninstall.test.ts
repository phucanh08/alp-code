import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InstallLayout } from "../../src/install-layout";
import { uninstallBinary, uninstallInstallation } from "../../src/install/uninstall";
import { removeTemporary } from "../support/temporary-root";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(removeTemporary)));

describe("native uninstall", () => {
  it("removes owned installation/state while backing up memory and preserving foreign state", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-uninstall-native-"));
    roots.push(root);
    const home = join(root, "install");
    const version = join(home, "versions", "v0.10.0");
    const state = join(root, "state");
    await mkdir(join(version, "bin"), { recursive: true });
    await mkdir(join(home, "bin"));
    await symlink(join("versions", "v0.10.0"), join(home, "current"));
    await symlink(join("..", "current", "bin", "alp"), join(home, "bin", "alp"));
    await mkdir(join(state, "memory"), { recursive: true });
    await writeFile(join(state, "memory", "user.md"), "keep\n");
    await writeFile(join(state, "foreign.txt"), "foreign\n");
    await mkdir(join(state, "agents"));
    const layout: InstallLayout = {
      channel: "binary", version: "0.10.0", selfExecutable: join(version, "bin", "alp"),
      stableCommand: join(home, "bin", "alp"), installRoot: version, assetRoot: version,
    };

    const result = uninstallBinary(layout, { env: { ALP_STATE_HOME: state, HOME: join(root, "user") }, cwd: root });
    await expect(stat(home)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(state, "foreign.txt"), "utf8")).toBe("foreign\n");
    expect(result.memoryBackup).not.toBeNull();
    expect(await readFile(join(result.memoryBackup!, "user.md"), "utf8")).toBe("keep\n");
  });

  it("delegates npm package ownership to npm and removes only its payload cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-uninstall-npm-"));
    roots.push(root);
    const cache = join(root, "cache", "npm");
    const installRoot = join(cache, "versions", "0.10.0", "darwin-arm64");
    const state = join(root, "state");
    await mkdir(join(installRoot, "bin"), { recursive: true });
    await mkdir(join(state, "memory"), { recursive: true });
    await writeFile(join(state, "memory", "user.md"), "keep\n");
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const result = uninstallInstallation({
      channel: "npm", version: "0.10.0", selfExecutable: join(installRoot, "bin", "alp"),
      stableCommand: join(root, "global", "alp"), installRoot, assetRoot: installRoot,
    }, {
      env: { ALP_STATE_HOME: state, HOME: join(root, "user") },
      cwd: root,
      spawnProcess: ((command: string, args: readonly string[]) => {
        calls.push({ command, args });
        return { status: 0, stdout: "", stderr: "", pid: 1, output: [], signal: null };
      }) as never,
    });
    expect(calls).toEqual([{ command: "npm", args: ["uninstall", "--global", "alp-code"] }]);
    await expect(stat(cache)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(result.memoryBackup!, "user.md"), "utf8")).toBe("keep\n");
  });
});
