import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MODE_PROFILES } from "../../src/agents/modes";
import { loadModeProfiles, loadToolchainWritePaths, modeSettingsFiles, projectSettingsRoot } from "../../src/cli/settings";
import { removeTemporary } from "../support/temporary-root";

/**
 * Ba tầng settings, đọc theo thứ tự thắng dần: máy → project → local.
 *
 * Cùng khuôn Claude Code đã dạy người dùng, đặt trong `.alp/` mà `alp init` đã tạo. Thiếu
 * file là trạng thái bình thường; file có mà hỏng thì phiên dừng, vì một dòng sai bị bỏ qua
 * trong im lặng nghĩa là chạy loadout khác loadout người ta viết ra.
 */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeTemporary(root)));
});

async function workspace(): Promise<{ home: string; project: string; env: NodeJS.ProcessEnv }> {
  const root = await mkdtemp(join(tmpdir(), "alp-settings-"));
  roots.push(root);
  const home = join(root, "home");
  const project = join(root, "project");
  await mkdir(join(home, ".alp"), { recursive: true });
  await mkdir(join(project, ".alp"), { recursive: true });
  return { home, project, env: { ALP_STATE_HOME: join(home, ".alp") } };
}

const settings = (modes: unknown) => `${JSON.stringify({ modes }, null, 2)}\n`;

describe("settings files", () => {
  it("reads the machine file, then the project file, then the local one", async () => {
    const { project, env } = await workspace();
    expect(await modeSettingsFiles(project, env)).toEqual([
      join(env.ALP_STATE_HOME!, "settings.json"),
      join(project, ".alp", "settings.json"),
      join(project, ".alp", "settings.local.json"),
    ]);
  });

  /** Người ta gõ `alp` từ chỗ đang làm, không phải từ gốc repo. */
  it("finds the project from a subdirectory", async () => {
    const { project } = await workspace();
    const nested = join(project, "src", "cli");
    await mkdir(nested, { recursive: true });
    expect(await projectSettingsRoot(nested)).toBe(project);
  });

  it("falls back to the cwd when no `.alp/` is anywhere above it", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-settings-bare-"));
    roots.push(root);
    expect(await projectSettingsRoot(root)).toBe(root);
  });

  it("runs the built-in dial when no file exists", async () => {
    const { project, env } = await workspace();
    const loaded = await loadModeProfiles({ cwd: project, env });
    expect(loaded.files).toEqual([]);
    expect(loaded.profiles).toBe(MODE_PROFILES);
  });

  it("layers the three files, with the local one winning", async () => {
    const { project, env } = await workspace();
    await writeFile(join(env.ALP_STATE_HOME!, "settings.json"),
      settings({ "*": { review: { model: "gpt-5.6-terra", reasoningEffort: "low" } } }));
    await writeFile(join(project, ".alp", "settings.json"),
      settings({ high: { worker: { model: "gpt-5.6-sol", reasoningEffort: "xhigh" } } }));
    await writeFile(join(project, ".alp", "settings.local.json"),
      settings({ high: { worker: { reasoningEffort: "max" } } }));

    const loaded = await loadModeProfiles({ cwd: project, env });
    expect(loaded.files).toHaveLength(3);
    expect(loaded.profiles.high.roles.worker).toEqual({ model: "gpt-5.6-sol", reasoningEffort: "max" });
    expect(loaded.profiles.low.roles.review).toEqual({ model: "gpt-5.6-terra", reasoningEffort: "low" });
    expect(loaded.profiles.medium.roles.worker).toEqual(MODE_PROFILES.medium.roles.worker);
  });

  it("reports the file and the reason when one of them is broken", async () => {
    const { project, env } = await workspace();
    const file = join(project, ".alp", "settings.local.json");
    await writeFile(file, "{ not json\n");
    await expect(loadModeProfiles({ cwd: project, env })).rejects.toThrow(new RegExp(`${file}: not valid JSON`));

    await writeFile(file, settings({ high: { worker: { model: "gpt-42" } } }));
    await expect(loadModeProfiles({ cwd: project, env })).rejects.toThrow(/chưa được gán runtime/);
  });
});

/**
 * GitHub #25: the `toolchain` block opens directories outside the workspace for every
 * sandboxed launch on the machine — so only the machine may say it. A project file that
 * carries it stops the session, the way a broken loadout does.
 */
describe("toolchain settings", () => {
  it("is empty when the machine says nothing, even if the project has other settings", async () => {
    const { project, env } = await workspace();
    await writeFile(join(project, ".alp", "settings.json"), settings({}));
    await expect(loadToolchainWritePaths(project, env)).resolves.toEqual({ paths: [], file: null });
  });

  it("reads the machine file: `~` is HOME, presets keep what exists, typed paths must exist", async () => {
    const { home, project, env } = await workspace();
    await mkdir(join(home, "fvm"));
    await mkdir(join(home, ".pub-cache"));
    const file = join(env.ALP_STATE_HOME!, "settings.json");
    await writeFile(file, JSON.stringify({ toolchain: { presets: ["flutter"], writePaths: ["~/fvm"] } }));
    const loaded = await loadToolchainWritePaths(project, { ...env, HOME: home });
    expect(loaded.file).toBe(file);
    expect(loaded.paths).toEqual([await realpath(join(home, ".pub-cache")), await realpath(join(home, "fvm"))]);

    await writeFile(file, JSON.stringify({ toolchain: { writePaths: ["~/.gradle"] } }));
    await expect(loadToolchainWritePaths(project, { ...env, HOME: home })).rejects.toThrow(/`~\/\.gradle` does not exist/);
  });

  it("refuses the block in a project file, naming where it belongs", async () => {
    const { home, project, env } = await workspace();
    await mkdir(join(home, "fvm"));
    await writeFile(join(project, ".alp", "settings.local.json"), JSON.stringify({ toolchain: { writePaths: ["~/fvm"] } }));
    await expect(loadToolchainWritePaths(project, { ...env, HOME: home }))
      .rejects.toThrow(/settings\.local\.json: `toolchain` is a machine setting; move it to .*settings\.json/);
  });

  it("does not refuse itself when the state home is the project's own `.alp/`", async () => {
    const { home, project } = await workspace();
    await mkdir(join(home, "fvm"));
    const env = { ALP_STATE_HOME: join(project, ".alp"), HOME: home };
    await writeFile(join(project, ".alp", "settings.json"), JSON.stringify({ toolchain: { writePaths: ["~/fvm"] } }));
    await expect(loadToolchainWritePaths(project, env)).resolves.toMatchObject({ paths: [await realpath(join(home, "fvm"))] });
  });
});
