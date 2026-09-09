import { mkdir, mkdtemp, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atomicSwitchCurrent, resolveLatestReleaseVersion, updateBinaryInstallation, updateInstallation } from "../../src/install/update";
import { binaryArchiveName, hostBinaryTarget } from "../../src/install/targets";
import { removeTemporary } from "../support/temporary-root";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(removeTemporary)));

describe("atomic binary activation", () => {
  it("renames a new symlink over current without an unlink gap", async () => {
    const home = await mkdtemp(join(tmpdir(), "alp-update-"));
    roots.push(home);
    await mkdir(join(home, "versions", "v1"), { recursive: true });
    await mkdir(join(home, "versions", "v2"));
    await symlink(join("versions", "v1"), join(home, "current"));
    const events: string[] = [];
    await atomicSwitchCurrent(home, join(home, "versions", "v2"), { observe: (event) => events.push(event) });
    expect(await readlink(join(home, "current"))).toBe(join("versions", "v2"));
    expect(events).toEqual(["temporary-created", "pointer-replaced"]);
  });

  it("preserves the old current pointer when replacement fails", async () => {
    const home = await mkdtemp(join(tmpdir(), "alp-update-"));
    roots.push(home);
    await mkdir(join(home, "versions", "v1"), { recursive: true });
    await mkdir(join(home, "versions", "v2"));
    await symlink(join("versions", "v1"), join(home, "current"));
    await expect(atomicSwitchCurrent(home, join(home, "versions", "v2"), {
      beforeReplace: () => { throw new Error("injected"); },
    })).rejects.toThrow("injected");
    expect(await readlink(join(home, "current"))).toBe(join("versions", "v1"));
  });
});

describe("channel-aware update", () => {
  it("accepts only an exact stable release tag from GitHub", async () => {
    const fetcher = async () => new Response(JSON.stringify({ tag_name: "v1.2.3" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    await expect(resolveLatestReleaseVersion(fetcher as typeof fetch)).resolves.toBe("1.2.3");
    await expect(resolveLatestReleaseVersion(async () => new Response(JSON.stringify({ tag_name: "latest" })) as never))
      .rejects.toThrow(/invalid release tag/);
  });

  it("routes a binary install through the native state machine and skips an equal release", async () => {
    const layout = {
      channel: "binary",
      version: "1.0.0",
      selfExecutable: "/home/user/.alp-code/versions/v1.0.0/bin/alp",
      stableCommand: "/home/user/.alp-code/bin/alp",
      installRoot: "/home/user/.alp-code/versions/v1.0.0",
      assetRoot: "/home/user/.alp-code/versions/v1.0.0",
    } as const;
    const calls: string[] = [];
    await expect(updateInstallation({
      layout,
      resolveTargetVersion: async () => "1.1.0",
      updateBinary: async ({ targetVersion }) => { calls.push(targetVersion); return { version: targetVersion, previous: layout.installRoot }; },
    })).resolves.toMatchObject({ from: "1.0.0", to: "1.1.0", channel: "binary", unchanged: false });
    expect(calls).toEqual(["1.1.0"]);

    await expect(updateInstallation({
      layout,
      resolveTargetVersion: async () => "1.0.0",
      updateBinary: async () => { throw new Error("must not run"); },
    })).resolves.toMatchObject({ unchanged: true, to: "1.0.0" });
  });

  it("lets npm replace the wrapper at the exact resolved version", async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const layout = {
      channel: "npm",
      version: "1.0.0",
      selfExecutable: "/cache/alp",
      stableCommand: "/global/bin/alp",
      installRoot: "/cache/root",
      assetRoot: "/cache/root",
    } as const;
    const spawnProcess = ((command: string, args: readonly string[]) => {
      calls.push({ command, args });
      return { status: 0, stdout: "", stderr: "", pid: 1, output: [], signal: null };
    }) as never;
    await expect(updateInstallation({ layout, resolveTargetVersion: async () => "1.2.0", spawnProcess }))
      .resolves.toMatchObject({ channel: "npm", to: "1.2.0", unchanged: false });
    expect(calls).toEqual([
      { command: "npm", args: ["install", "--global", "alp-code@1.2.0"] },
      { command: layout.stableCommand, args: ["__internal", "ensure-state"] },
    ]);
  });

  it("rolls current back when failure is injected after pointer replacement", async () => {
    const home = await mkdtemp(join(tmpdir(), "alp-update-machine-"));
    roots.push(home);
    const oldRoot = join(home, "versions", "v1.0.0");
    await mkdir(join(oldRoot, "bin"), { recursive: true });
    await mkdir(join(oldRoot, "skills"));
    await mkdir(join(oldRoot, "scaffold"));
    await symlink(join("versions", "v1.0.0"), join(home, "current"));
    const target = hostBinaryTarget();
    const payload = join(home, "payload");
    await mkdir(join(payload, "bin"), { recursive: true });
    await mkdir(join(payload, "skills"));
    await mkdir(join(payload, "scaffold"));
    await writeFile(join(payload, "bin", target.executable), process.platform === "win32"
      ? "@echo off\r\nif \"%1\"==\"--version\" echo alp 1.1.0\r\n"
      : "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'alp 1.1.0'; fi\nexit 0\n", { mode: 0o755 });
    await writeFile(join(payload, "install-manifest.json"), `${JSON.stringify({
      schemaVersion: 1, app: "alp-code", version: "1.1.0", target: target.id,
      compiler: { name: "bun", version: "1.4.2" },
    })}\n`);
    const filename = binaryArchiveName("1.1.0", target.id);
    const archiveFile = join(home, filename);
    execFileSync("tar", ["-czf", archiveFile, "-C", payload, "."]);
    const archive = await readFile(archiveFile);
    const sums = Buffer.from(`${createHash("sha256").update(archive).digest("hex")}  ${filename}\n`);
    const fetcher = async (url: string | URL | Request) => new Response(String(url).endsWith("SHA256SUMS") ? sums : archive);
    const layout = {
      channel: "binary", version: "1.0.0", selfExecutable: join(oldRoot, "bin", target.executable),
      stableCommand: join(home, "bin", target.executable), installRoot: oldRoot, assetRoot: oldRoot,
    } as const;
    await expect(updateBinaryInstallation({
      layout, targetVersion: "1.1.0", fetcher: fetcher as typeof fetch,
      injectFailure(step) { if (step === "pointer-switched") throw new Error("injected pointer failure"); },
    })).rejects.toThrow(/injected pointer failure/);
    expect(await readlink(join(home, "current"))).toBe(join("versions", "v1.0.0"));

    await expect(updateBinaryInstallation({ layout, targetVersion: "1.1.0", fetcher: fetcher as typeof fetch }))
      .resolves.toMatchObject({ version: "1.1.0", previous: oldRoot });
    expect(await readlink(join(home, "current"))).toBe(join("versions", "v1.1.0"));
  });
});
