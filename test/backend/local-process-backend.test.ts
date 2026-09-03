import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalProcessBackend } from "../../src/backend/local-process-backend";
import type { RuntimeLaunchSpec } from "../../src/runtime/runtime-adapter";
import { removeTemporary } from "../support/temporary-root";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeTemporary(root)));
});

class FakeChild extends EventEmitter {
  readonly pid = 42;
  killedWith: NodeJS.Signals | number | undefined;
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killedWith = signal;
    return true;
  }
}

describe("LocalProcessBackend", () => {
  it("preserves exit status and cleans only temporary runtime files after exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-local-backend-"));
    roots.push(root);
    const executionDir = join(root, "execution");
    const runtimeDir = join(executionDir, "runtime");
    await mkdir(runtimeDir, { recursive: true });
    const stateFile = join(executionDir, "state.json");
    const temporary = join(runtimeDir, "prompt.md");
    await writeFile(stateFile, "state");
    await writeFile(temporary, "prompt");
    const child = new FakeChild();
    const calls: unknown[][] = [];
    const backend = new LocalProcessBackend({
      spawnProcess(command, args, options) {
        calls.push([command, args, options]);
        return child;
      },
    });
    const spec: RuntimeLaunchSpec = {
      command: "fake-runtime",
      args: ["--probe"],
      cwd: root,
      env: { ALP_DELEGATION_EXECUTION_ID: "exec-local" },
      temporaryFiles: [temporary],
      intent: { prompt: "task", model: "m", mode: "bypass" },
    };

    expect(await backend.spawn({ executionId: "exec-local", launchSpec: spec })).toMatchObject({ status: "running" });
    const waited = backend.wait("exec-local");
    child.emit("close", 7, null);

    await expect(waited).resolves.toMatchObject({
      executionId: "exec-local",
      status: "failed",
      exitCode: 7,
      signal: null,
    });
    expect(calls[0][0]).toBe("fake-runtime");
    await expect(stat(temporary)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(stateFile)).resolves.toBeDefined();
  });

  it("forwards cancellation signals and reports signal termination", async () => {
    const child = new FakeChild();
    const backend = new LocalProcessBackend({ spawnProcess: () => child });
    await backend.spawn({
      executionId: "exec-signal",
      launchSpec: { command: "fake", args: [], cwd: process.cwd(), env: {}, temporaryFiles: [], intent: { prompt: "task", model: "m", mode: "bypass" } },
    });

    await backend.cancel("exec-signal", "SIGTERM");
    expect(child.killedWith).toBe("SIGTERM");
    const waited = backend.wait("exec-signal");
    child.emit("close", null, "SIGTERM");
    await expect(waited).resolves.toMatchObject({ status: "cancelled", exitCode: null, signal: "SIGTERM" });
  });
});
