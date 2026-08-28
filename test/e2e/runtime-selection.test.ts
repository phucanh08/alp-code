import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runRuntimeCommand } from "../../src/cli/commands/runtime";
import { FileRuntimePreferenceStore } from "../../src/runtime/runtime-preference-store";
import { RuntimeSelector } from "../../src/runtime/runtime-selector";
import type { TerminalKey } from "../../src/runtime/types";
import { expectPosixMode } from "../support/file-mode";
import { removeTemporary } from "../support/temporary-root";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeTemporary(root)));
});

async function preferenceFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "alp-runtime-pref-"));
  roots.push(root);
  return join(root, ".alp", "runtime.json");
}

/** Drives the menu with a scripted key sequence, as a terminal would. */
function keys(sequence: readonly TerminalKey[]): () => Promise<TerminalKey> {
  let index = 0;
  return async () => sequence[index++] ?? "cancel";
}

describe("e2e: runtime selection", () => {
  it("remembers the interactive choice across sessions", async () => {
    const file = await preferenceFile();
    const store = new FileRuntimePreferenceStore({ file });
    const output = { lines: [] as string[], write(text: string) { this.lines.push(text); } };

    // First session: move to Codex and confirm.
    const first = new RuntimeSelector({ preferenceStore: store, output, readKey: keys(["down", "enter"]) });
    await expect(first.select({ interactive: true })).resolves.toEqual({
      ok: true,
      runtime: "codex",
      source: "interactive",
    });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ runtime: "codex" });
    await expectPosixMode(file, 0o600);

    // Second session, non-interactive: the persisted choice wins over the default.
    const second = new RuntimeSelector({ preferenceStore: new FileRuntimePreferenceStore({ file }), output });
    await expect(second.select({ interactive: false })).resolves.toEqual({
      ok: true,
      runtime: "codex",
      source: "persisted",
    });
    // With nothing remembered, the first session's menu opened on the Claude default.
    expect(output.lines.join("")).toContain("❯ Claude");
  });

  it("uses an explicit --runtime without reading or writing the preference", async () => {
    const file = await preferenceFile();
    const store = new FileRuntimePreferenceStore({ file });
    await store.write("codex");
    const selector = new RuntimeSelector({
      preferenceStore: store,
      output: { write() {} },
      readKey: async () => { throw new Error("explicit selection must not prompt"); },
    });

    await expect(selector.select({ requestedRuntime: "claude", interactive: true })).resolves.toEqual({
      ok: true,
      runtime: "claude",
      source: "explicit",
    });
    // An explicit flag is per-session and leaves the remembered runtime alone.
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ runtime: "codex" });
  });

  it("cancels without persisting and defaults to Claude when nothing is remembered", async () => {
    const file = await preferenceFile();
    const cancelled = new RuntimeSelector({
      preferenceStore: new FileRuntimePreferenceStore({ file }),
      output: { write() {} },
      readKey: keys(["down", "cancel"]),
    });

    await expect(cancelled.select({ interactive: true })).resolves.toEqual({ ok: false, exitCode: 130 });
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const fresh = new RuntimeSelector({
      preferenceStore: new FileRuntimePreferenceStore({ file }),
      output: { write() {} },
    });
    await expect(fresh.select({ interactive: false })).resolves.toEqual({
      ok: true,
      runtime: "claude",
      source: "default",
    });
  });

  it("shows and sets the remembered runtime through `alp runtime`", async () => {
    const file = await preferenceFile();
    const store = new FileRuntimePreferenceStore({ file });
    const written: string[] = [];
    const write = (text: string) => { written.push(text); };

    await expect(runRuntimeCommand({ action: "show" }, { store, write })).resolves.toBe("claude");
    await expect(runRuntimeCommand({ action: "set", runtime: "codex" }, { store, write })).resolves.toBe("codex");
    await expect(runRuntimeCommand({ action: "show" }, { store, write })).resolves.toBe("codex");
    expect(written).toEqual(["claude\n", "codex\n", "codex\n"]);
  });
});
