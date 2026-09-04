import { chmod, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { ModeId } from "../../src/agents/modes";
import {
  FileModePreferenceStore,
  type ModePreferenceRead,
  type ModePreferenceStore,
} from "../../src/cli/mode-preference-store";
import { ModeSelector } from "../../src/cli/mode-selector";
import { removeTemporary } from "../support/temporary-root";

const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await chmod(root, 0o700).catch(() => undefined);
    await removeTemporary(root);
  }
});

class FakePreferenceStore implements ModePreferenceStore {
  reads = 0;
  readonly writes: ModeId[] = [];

  constructor(private readonly value: ModePreferenceRead) {}

  async read(): Promise<ModePreferenceRead> {
    this.reads += 1;
    return this.value;
  }

  async write(mode: ModeId): Promise<void> {
    this.writes.push(mode);
  }
}

function outputBuffer() {
  let content = "";
  return {
    stream: {
      isTTY: true,
      write(chunk: string) {
        content += chunk;
        return true;
      },
    },
    read: () => content,
  };
}

function keyReader(...keys: readonly ("up" | "down" | "enter" | "cancel" | "other")[]) {
  const queue = [...keys];
  return async () => queue.shift() ?? "other";
}

describe("ModeSelector", () => {
  it("lets --mode win without reading preference or prompting", async () => {
    const store = new FakePreferenceStore({ mode: "medium" });
    const output = outputBuffer();
    const selector = new ModeSelector({
      preferenceStore: store,
      output: output.stream,
      readKey: () => {
        throw new Error("prompt must not be called");
      },
    });

    await expect(selector.select({ requestedMode: "ultra", interactive: true })).resolves.toEqual({
      ok: true,
      mode: "ultra",
      source: "explicit",
    });
    expect(store.reads).toBe(0);
    expect(store.writes).toEqual([]);
    expect(output.read()).toBe("");
  });

  it("lets an interactive choice override and persist the stored preference", async () => {
    const store = new FakePreferenceStore({ mode: "medium" });
    const selector = new ModeSelector({
      preferenceStore: store,
      output: outputBuffer().stream,
      readKey: keyReader("down", "enter"),
    });

    await expect(selector.select({ interactive: true })).resolves.toEqual({
      ok: true,
      mode: "high",
      source: "interactive",
    });
    expect(store.writes).toEqual(["high"]);
  });

  it("accepts the highlighted stored preference on Enter", async () => {
    const store = new FakePreferenceStore({ mode: "puck" });
    const selector = new ModeSelector({
      preferenceStore: store,
      output: outputBuffer().stream,
      readKey: keyReader("enter"),
    });

    await expect(selector.select({ interactive: true })).resolves.toMatchObject({
      ok: true,
      mode: "puck",
      source: "interactive",
    });
    expect(store.writes).toEqual(["puck"]);
  });

  it("uses medium by default when no preference exists", async () => {
    const store = new FakePreferenceStore({ mode: null });
    const selector = new ModeSelector({
      preferenceStore: store,
      output: outputBuffer().stream,
    });

    await expect(selector.select({ interactive: false })).resolves.toEqual({
      ok: true,
      mode: "medium",
      source: "default",
    });
    expect(store.writes).toEqual([]);
  });

  it("fails closed to medium with a warning for corrupt preference state", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-mode-corrupt-"));
    temporaryRoots.push(root);
    const file = join(root, "mode.json");
    await writeFile(file, '{"mode":"paseo"}\n', "utf8");
    const output = outputBuffer();
    const selector = new ModeSelector({
      preferenceStore: new FileModePreferenceStore({ file }),
      output: output.stream,
    });

    await expect(selector.select({ interactive: false })).resolves.toEqual({
      ok: true,
      mode: "medium",
      source: "default",
    });
    expect(output.read()).toMatch(/warning.*invalid mode preference.*medium/i);
  });

  it("persists an interactive selection atomically", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-mode-persist-"));
    temporaryRoots.push(root);
    const file = join(root, "state", "mode.json");
    const store = new FileModePreferenceStore({ file });
    const selector = new ModeSelector({
      preferenceStore: store,
      output: outputBuffer().stream,
      readKey: keyReader("down", "enter"),
    });

    await expect(selector.select({ interactive: true })).resolves.toMatchObject({
      ok: true,
      mode: "high",
    });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ mode: "high" });
    expect(await readdir(join(root, "state"))).toEqual(["mode.json"]);
    await expect(store.read()).resolves.toEqual({ mode: "high" });
  });

  it("returns exit 130 without persisting when the prompt is cancelled", async () => {
    const store = new FakePreferenceStore({ mode: "medium" });
    const selector = new ModeSelector({
      preferenceStore: store,
      output: outputBuffer().stream,
      readKey: keyReader("cancel"),
    });

    await expect(selector.select({ interactive: true })).resolves.toEqual({
      ok: false,
      exitCode: 130,
    });
    expect(store.writes).toEqual([]);
  });

  it("decodes Windows-style Down + Enter chunks and restores stdin state", async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY: boolean;
      isRaw: boolean;
      setRawMode(value: boolean): void;
    };
    input.isTTY = true;
    input.isRaw = false;
    const rawModes: boolean[] = [];
    const originalPause = input.pause.bind(input);
    let pauses = 0;
    input.setRawMode = (value) => {
      rawModes.push(value);
      input.isRaw = value;
    };
    input.pause = (() => {
      pauses += 1;
      return originalPause();
    }) as typeof input.pause;
    const store = new FakePreferenceStore({ mode: "medium" });
    const output = outputBuffer();
    const selector = new ModeSelector({
      preferenceStore: store,
      input,
      output: output.stream,
    });

    queueMicrotask(() => input.write("\u001b[B\r"));
    await expect(selector.select({ interactive: true })).resolves.toMatchObject({
      ok: true,
      mode: "high",
    });
    expect(rawModes).toEqual([true, false]);
    expect(pauses).toBeGreaterThan(0);
    expect(input.isRaw).toBe(false);
    expect(output.read()).toContain("\u001b[?25h");
  });
});
