import { describe, expect, it, vi } from "vitest";
import { dispatchEntry } from "../../src/cli/entry";

function dependencies() {
  return {
    version: "0.10.0",
    stdout: { write: vi.fn() },
    ensureState: vi.fn(),
    runHook: vi.fn(async () => 0),
    runInternal: vi.fn(async () => 0),
    loadFullCli: vi.fn(async () => ({ main: vi.fn(async () => 7) })),
  };
}

describe("lightweight CLI entry", () => {
  it("serves --version without state, hook, network or full CLI evaluation", async () => {
    const deps = dependencies();
    expect(await dispatchEntry(["--version"], deps)).toBe(0);
    expect(deps.stdout.write).toHaveBeenCalledWith("alp 0.10.0\n");
    expect(deps.ensureState).not.toHaveBeenCalled();
    expect(deps.loadFullCli).not.toHaveBeenCalled();
  });

  it("routes hooks and internal commands before state/full dependencies", async () => {
    const hook = dependencies();
    expect(await dispatchEntry(["hook", "session-boot"], hook)).toBe(0);
    expect(hook.runHook).toHaveBeenCalledWith(["session-boot"]);
    expect(hook.ensureState).not.toHaveBeenCalled();
    expect(hook.loadFullCli).not.toHaveBeenCalled();

    const internal = dependencies();
    expect(await dispatchEntry(["__internal", "ensure-state"], internal)).toBe(0);
    expect(internal.runInternal).toHaveBeenCalledWith(["ensure-state"]);
    expect(internal.loadFullCli).not.toHaveBeenCalled();
  });

  it("ensures state then lazy-loads the full CLI for a normal command", async () => {
    const deps = dependencies();
    expect(await dispatchEntry(["help"], deps)).toBe(7);
    expect(deps.ensureState).toHaveBeenCalledOnce();
    expect(deps.loadFullCli).toHaveBeenCalledOnce();
  });
});
