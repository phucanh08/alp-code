import { mkdir, mkdtemp, readFile, readlink, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InstallLayout } from "../../src/install-layout";
import { ensureState } from "../../src/install/state";
import { removeTemporary } from "../support/temporary-root";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(removeTemporary)));

async function fixture(version: string): Promise<{ layout: InstallLayout; env: NodeJS.ProcessEnv; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "alp-native-state-"));
  roots.push(root);
  const installRoot = join(root, "versions", `v${version}`);
  await mkdir(join(installRoot, "scaffold", "memory", "shared"), { recursive: true });
  await mkdir(join(installRoot, "skills"), { recursive: true });
  await writeFile(join(installRoot, "scaffold", "memory", "README.md"), "seed\n");
  return {
    root,
    env: { HOME: join(root, "home"), ALP_STATE_HOME: join(root, "state") },
    layout: {
      channel: "binary",
      version,
      selfExecutable: join(installRoot, "bin", "alp"),
      stableCommand: join(root, "bin", "alp"),
      installRoot,
      assetRoot: installRoot,
    },
  };
}

describe("ensureState", () => {
  it("seeds missing state from assetRoot and writes a version-independent install record", async () => {
    const { layout, env } = await fixture("0.10.0");
    const result = ensureState({ layout, env, now: () => "2026-09-08T00:00:00.000Z" });
    expect(await readFile(join(result.memoryRoot, "README.md"), "utf8")).toBe("seed\n");
    expect(JSON.parse(await readFile(join(result.stateHome, "install.json"), "utf8"))).toMatchObject({
      channel: "binary",
      version: "0.10.0",
      root: layout.installRoot,
      stableCommand: layout.stableCommand,
    });
  });

  it("preserves user memory while switching immutable version roots", async () => {
    const first = await fixture("0.10.0");
    ensureState({ layout: first.layout, env: first.env });
    await writeFile(join(first.env.ALP_STATE_HOME!, "memory", "user.md"), "keep me\n");

    const secondRoot = join(first.root, "versions", "v0.10.1");
    await mkdir(join(secondRoot, "scaffold", "memory"), { recursive: true });
    await mkdir(join(secondRoot, "skills"));
    await writeFile(join(secondRoot, "scaffold", "memory", "new-seed.md"), "new\n");
    const second = { ...first.layout, version: "0.10.1", installRoot: secondRoot, assetRoot: secondRoot, selfExecutable: join(secondRoot, "bin", "alp") };
    ensureState({ layout: second, env: first.env });

    expect(await readFile(join(first.env.ALP_STATE_HOME!, "memory", "user.md"), "utf8")).toBe("keep me\n");
    expect(await readFile(join(first.env.ALP_STATE_HOME!, "memory", "new-seed.md"), "utf8")).toBe("new\n");
  });

  it("repairs only ALP-owned project hooks and is byte-stable", async () => {
    const fixtureValue = await fixture("0.10.0");
    const project = join(fixtureValue.root, "project");
    const settingsFile = join(project, ".claude", "settings.local.json");
    await mkdir(join(project, ".claude"), { recursive: true });
    await writeFile(settingsFile, `${JSON.stringify({
      $generatedBy: "alp init",
      custom: { keep: true },
      hooks: { SessionStart: [{ hooks: [
        { type: "command", command: '"/old/node" "/old/install/hooks/session-boot.cjs"' },
        { type: "command", command: "user-hook --keep" },
      ] }] },
    }, null, 2)}\n`);
    await mkdir(fixtureValue.env.ALP_STATE_HOME!, { recursive: true });
    await writeFile(join(fixtureValue.env.ALP_STATE_HOME!, "projects.json"), JSON.stringify({ version: 1, projects: [{ path: project }] }));

    ensureState({ layout: fixtureValue.layout, env: fixtureValue.env });
    const once = await readFile(settingsFile, "utf8");
    const parsed = JSON.parse(once);
    expect(parsed.custom).toEqual({ keep: true });
    expect(parsed.hooks.SessionStart[0].hooks[0].command).toContain("hook' 'session-boot");
    expect(parsed.hooks.SessionStart[0].hooks[1].command).toBe("user-hook --keep");
    const firstMtime = (await stat(settingsFile)).mtimeMs;

    ensureState({ layout: fixtureValue.layout, env: fixtureValue.env });
    expect(await readFile(settingsFile, "utf8")).toBe(once);
    expect((await stat(settingsFile)).mtimeMs).toBe(firstMtime);
  });

  it("repairs npm project skill links when the immutable payload root changes", async () => {
    const first = await fixture("0.10.0");
    const oldRoot = first.layout.installRoot;
    await mkdir(join(oldRoot, "skills", "owned"));
    const project = join(first.root, "project");
    const link = join(project, ".claude", "skills", "owned");
    await mkdir(join(project, ".claude", "skills"), { recursive: true });
    await symlink(join(oldRoot, "skills", "owned"), link);
    await mkdir(first.env.ALP_STATE_HOME!, { recursive: true });
    await writeFile(join(first.env.ALP_STATE_HOME!, "projects.json"), JSON.stringify({ version: 1, projects: [{ path: project }] }));
    ensureState({ layout: { ...first.layout, channel: "npm" }, env: first.env });

    const nextRoot = join(first.root, "npm", "versions", "0.10.1", "target");
    await mkdir(join(nextRoot, "scaffold", "memory"), { recursive: true });
    await mkdir(join(nextRoot, "skills", "owned"), { recursive: true });
    const next = { ...first.layout, channel: "npm", version: "0.10.1", installRoot: nextRoot, assetRoot: nextRoot, selfExecutable: join(nextRoot, "bin", "alp") } as const;
    ensureState({ layout: next, env: first.env });

    expect(await readlink(link)).toBe(join(nextRoot, "skills", "owned"));
  });
});
