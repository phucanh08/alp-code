import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runModeCommand } from "../../src/cli/commands/mode";
import { applyModeSettings, parseModeSettings } from "../../src/agents/mode-settings";
import { MODE_PROFILES } from "../../src/agents/modes";
import { FileModePreferenceStore } from "../../src/cli/mode-preference-store";
import { ModeSelector } from "../../src/cli/mode-selector";
import type { TerminalKey } from "../../src/runtime/types";
import { expectPosixMode } from "../support/file-mode";
import { removeTemporary } from "../support/temporary-root";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeTemporary(root)));
});

async function preferenceFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "alp-mode-pref-"));
  roots.push(root);
  return join(root, ".alp", "mode.json");
}

/** Drives the menu with a scripted key sequence, as a terminal would. */
function keys(sequence: readonly TerminalKey[]): () => Promise<TerminalKey> {
  let index = 0;
  return async () => sequence[index++] ?? "cancel";
}

describe("e2e: mode selection", () => {
  it("remembers the interactive choice across sessions", async () => {
    const file = await preferenceFile();
    const store = new FileModePreferenceStore({ file });
    const output = { lines: [] as string[], write(text: string) { this.lines.push(text); } };

    // First session: move one nấc up from the default and confirm.
    const first = new ModeSelector({ preferenceStore: store, output, readKey: keys(["down", "enter"]) });
    await expect(first.select({ interactive: true })).resolves.toEqual({
      ok: true,
      mode: "high",
      source: "interactive",
    });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ mode: "high" });
    await expectPosixMode(file, 0o600);

    // Second session, non-interactive: the persisted choice wins over the default.
    const second = new ModeSelector({ preferenceStore: new FileModePreferenceStore({ file }), output });
    await expect(second.select({ interactive: false })).resolves.toEqual({
      ok: true,
      mode: "high",
      source: "persisted",
    });
    // With nothing remembered, the first session's menu opened on the `medium` default.
    expect(output.lines.join("")).toContain("medium (current)");
  });

  it("uses an explicit --mode without reading or writing the preference", async () => {
    const file = await preferenceFile();
    const store = new FileModePreferenceStore({ file });
    await store.write("high");
    const selector = new ModeSelector({
      preferenceStore: store,
      output: { write() {} },
      readKey: async () => { throw new Error("explicit selection must not prompt"); },
    });

    await expect(selector.select({ requestedMode: "puck", interactive: true })).resolves.toEqual({
      ok: true,
      mode: "puck",
      source: "explicit",
    });
    // An explicit flag is per-session and leaves the remembered nấc alone.
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ mode: "high" });
  });

  it("cancels without persisting and defaults to medium when nothing is remembered", async () => {
    const file = await preferenceFile();
    const cancelled = new ModeSelector({
      preferenceStore: new FileModePreferenceStore({ file }),
      output: { write() {} },
      readKey: keys(["down", "cancel"]),
    });

    await expect(cancelled.select({ interactive: true })).resolves.toEqual({ ok: false, exitCode: 130 });
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const fresh = new ModeSelector({
      preferenceStore: new FileModePreferenceStore({ file }),
      output: { write() {} },
    });
    await expect(fresh.select({ interactive: false })).resolves.toEqual({
      ok: true,
      mode: "medium",
      source: "default",
    });
  });

  it("shows and sets the remembered nấc through `alp mode`", async () => {
    const file = await preferenceFile();
    const store = new FileModePreferenceStore({ file });
    const written: string[] = [];
    const write = (text: string) => { written.push(text); };

    await expect(runModeCommand({ action: "show" }, { store, write })).resolves.toBe("medium");
    await expect(runModeCommand({ action: "set", mode: "ultra" }, { store, write })).resolves.toBe("ultra");
    await expect(runModeCommand({ action: "show" }, { store, write })).resolves.toBe("ultra");
    expect(written).toEqual(["medium\n", "ultra\n", "ultra\n"]);
  });

  /**
   * Từ khi loadout sửa được, tên nấc một mình không còn trả lời được "nấc này ở máy này
   * nghĩa là gì". `show` in thêm file nào đã nói và vai nào đang chạy khác mặc định — dòng
   * đầu vẫn chỉ là tên nấc, để script nào đang đọc nó không gãy.
   */
  it("names the settings files and the seats they moved", async () => {
    const file = await preferenceFile();
    const store = new FileModePreferenceStore({ file });
    const written: string[] = [];
    const source = "/project/.alp/settings.local.json";
    const profiles = applyModeSettings(MODE_PROFILES, [{
      file: source,
      settings: parseModeSettings({ modes: { medium: { worker: { model: "claude-opus-5", reasoningEffort: "max" } } } }, source),
    }]);

    await expect(runModeCommand({ action: "show" }, {
      store,
      write: (text: string) => { written.push(text); },
      settings: { files: [source], profiles },
    })).resolves.toBe("medium");

    expect(written[0]).toBe("medium\n");
    expect(written[1]).toBe(`SETTINGS ${source}\n`);
    expect(written[2]).toContain("OVERRIDE worker");
    expect(written[2]).toContain("claude-opus-5 · max");
    expect(written[2]).toContain("built-in gpt-5.6-sol · high");
    expect(written).toHaveLength(3);
  });
});
