import { chmod, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileRuntimePreferenceStore,
  type RuntimePreferenceRead,
  type RuntimePreferenceStore,
} from "../../src/runtime/runtime-preference-store";
import { RuntimeSelector } from "../../src/runtime/runtime-selector";
import type { RuntimeId } from "../../src/runtime/types";
import { removeTemporary } from "../support/temporary-root";

const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await chmod(root, 0o700).catch(() => undefined);
    await removeTemporary(root);
  }
});

class FakePreferenceStore implements RuntimePreferenceStore {
  reads = 0;
  readonly writes: RuntimeId[] = [];

  constructor(private readonly value: RuntimePreferenceRead) {}

  async read(): Promise<RuntimePreferenceRead> {
    this.reads += 1;
    return this.value;
  }

  async write(runtime: RuntimeId): Promise<void> {
    this.writes.push(runtime);
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

describe("RuntimeSelector", () => {
  it("lets --runtime win without reading preference or prompting", async () => {
    const store = new FakePreferenceStore({ runtime: "claude" });
    const output = outputBuffer();
    const selector = new RuntimeSelector({
      preferenceStore: store,
      output: output.stream,
      readKey: () => {
        throw new Error("prompt must not be called");
      },
    });

    await expect(selector.select({ requestedRuntime: "codex", interactive: true })).resolves.toEqual({
      ok: true,
      runtime: "codex",
      source: "explicit",
    });
    expect(store.reads).toBe(0);
    expect(store.writes).toEqual([]);
    expect(output.read()).toBe("");
  });

  it("lets an interactive choice override and persist the stored preference", async () => {
    const store = new FakePreferenceStore({ runtime: "claude" });
    const selector = new RuntimeSelector({
      preferenceStore: store,
      output: outputBuffer().stream,
      readKey: keyReader("down", "enter"),
    });

    await expect(selector.select({ interactive: true })).resolves.toEqual({
      ok: true,
      runtime: "codex",
      source: "interactive",
    });
    expect(store.writes).toEqual(["codex"]);
  });

  it("accepts the highlighted stored preference on Enter", async () => {
    const store = new FakePreferenceStore({ runtime: "codex" });
    const selector = new RuntimeSelector({
      preferenceStore: store,
      output: outputBuffer().stream,
      readKey: keyReader("enter"),
    });

    await expect(selector.select({ interactive: true })).resolves.toMatchObject({
      ok: true,
      runtime: "codex",
      source: "interactive",
    });
    expect(store.writes).toEqual(["codex"]);
  });

  it("uses Claude by default when no preference exists", async () => {
    const store = new FakePreferenceStore({ runtime: null });
    const selector = new RuntimeSelector({
      preferenceStore: store,
      output: outputBuffer().stream,
    });

    await expect(selector.select({ interactive: false })).resolves.toEqual({
      ok: true,
      runtime: "claude",
      source: "default",
    });
    expect(store.writes).toEqual([]);
  });

  it("fails closed to Claude with a warning for corrupt preference state", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-runtime-corrupt-"));
    temporaryRoots.push(root);
    const file = join(root, "runtime.json");
    await writeFile(file, '{"runtime":"paseo"}\n', "utf8");
    const output = outputBuffer();
    const selector = new RuntimeSelector({
      preferenceStore: new FileRuntimePreferenceStore({ file }),
      output: output.stream,
    });

    await expect(selector.select({ interactive: false })).resolves.toEqual({
      ok: true,
      runtime: "claude",
      source: "default",
    });
    expect(output.read()).toMatch(/warning.*invalid runtime preference.*Claude/i);
  });

  it("persists an interactive selection atomically", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-runtime-persist-"));
    temporaryRoots.push(root);
    const file = join(root, "state", "runtime.json");
    const store = new FileRuntimePreferenceStore({ file });
    const selector = new RuntimeSelector({
      preferenceStore: store,
      output: outputBuffer().stream,
      readKey: keyReader("down", "enter"),
    });

    await expect(selector.select({ interactive: true })).resolves.toMatchObject({
      ok: true,
      runtime: "codex",
    });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ runtime: "codex" });
    expect(await readdir(join(root, "state"))).toEqual(["runtime.json"]);
    await expect(store.read()).resolves.toEqual({ runtime: "codex" });
  });

  it("returns exit 130 without persisting when the prompt is cancelled", async () => {
    const store = new FakePreferenceStore({ runtime: "claude" });
    const selector = new RuntimeSelector({
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
    const store = new FakePreferenceStore({ runtime: "claude" });
    const output = outputBuffer();
    const selector = new RuntimeSelector({
      preferenceStore: store,
      input,
      output: output.stream,
    });

    queueMicrotask(() => input.write("\u001b[B\r"));
    await expect(selector.select({ interactive: true })).resolves.toMatchObject({
      ok: true,
      runtime: "codex",
    });
    expect(rawModes).toEqual([true, false]);
    expect(pauses).toBeGreaterThan(0);
    expect(input.isRaw).toBe(false);
    expect(output.read()).toContain("\u001b[?25h");
  });
});
