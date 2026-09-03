import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalProcessBackend, type LocalSpawnOptions } from "../../src/backend/local-process-backend";
import { DelegationError } from "../../src/delegation/types";
import type { RuntimeLaunchSpec } from "../../src/runtime/runtime-adapter";
import { removeTemporary } from "../support/temporary-root";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeTemporary(root)));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "alp-local-backend-"));
  roots.push(root);
  return root;
}

class FakeChild extends EventEmitter {
  killedWith: NodeJS.Signals | number | undefined;
  unrefCalls = 0;
  readonly stdout = new EventEmitter() as unknown as NodeJS.ReadableStream;
  readonly stderr = new EventEmitter() as unknown as NodeJS.ReadableStream;
  constructor(readonly pid = 42) { super(); }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killedWith = signal;
    return true;
  }
  unref(): void { this.unrefCalls += 1; }
}

function launchSpec(overrides: Partial<RuntimeLaunchSpec> = {}): RuntimeLaunchSpec {
  return {
    command: "fake-runtime",
    args: ["--probe"],
    cwd: process.cwd(),
    env: {},
    temporaryFiles: [],
    ...overrides,
  };
}

/** A pid above every platform's pid_max, so liveness probes always report it dead. */
const DEAD_PID = 999_999;

describe("LocalProcessBackend", () => {
  it("preserves exit status and cleans only temporary runtime files after exit", async () => {
    const root = await temporaryRoot();
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
      stdio: "inherit",
      spawnProcess(command, args, options) {
        calls.push([command, args, options]);
        return child;
      },
    });
    const spec = launchSpec({
      cwd: root,
      env: { ALP_DELEGATION_EXECUTION_ID: "exec-local" },
      temporaryFiles: [temporary],
    });

    expect(await backend.spawn({ executionId: "exec-local", launchSpec: spec })).toMatchObject({ status: "running" });
    const waited = backend.wait("exec-local");
    child.emit("close", 7, null);

    await expect(waited).resolves.toMatchObject({
      executionId: "exec-local",
      status: "failed",
      exitCode: 7,
      signal: null,
      error: { code: "ExecutionFailed" },
    });
    expect(calls[0][0]).toBe("fake-runtime");
    await expect(stat(temporary)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(stateFile)).resolves.toBeDefined();
  });

  it("forwards cancellation signals and reports signal termination", async () => {
    const child = new FakeChild();
    const backend = new LocalProcessBackend({ stdio: "inherit", spawnProcess: () => child });
    await backend.spawn({ executionId: "exec-signal", launchSpec: launchSpec() });

    await backend.cancel("exec-signal", "SIGTERM");
    expect(child.killedWith).toBe("SIGTERM");
    const waited = backend.wait("exec-signal");
    child.emit("close", null, "SIGTERM");
    await expect(waited).resolves.toMatchObject({ status: "cancelled", exitCode: null, signal: "SIGTERM" });
  });

  it("reports a signal kill that nobody asked for as failed, not cancelled", async () => {
    const child = new FakeChild();
    const backend = new LocalProcessBackend({ stdio: "inherit", spawnProcess: () => child });
    await backend.spawn({ executionId: "exec-killed", launchSpec: launchSpec() });

    const waited = backend.wait("exec-killed");
    child.emit("close", null, "SIGKILL");
    await expect(waited).resolves.toMatchObject({ status: "failed", signal: "SIGKILL" });
  });

  it("keeps an execution reachable from a second backend instance", async () => {
    const stateDir = await temporaryRoot();
    const child = new FakeChild(process.pid);
    const starter = new LocalProcessBackend({ stateDir, spawnProcess: () => child });
    await starter.spawn({
      executionId: "exec_durable",
      launchSpec: launchSpec(),
      lifecycle: { requestId: "req_1", parentExecutionId: null, background: true, interactive: false, timeoutMs: null },
    });

    // A different instance stands in for the next CLI process, which shares nothing but the
    // state directory. Before this, every lifecycle call from there died with
    // `unknown local execution`.
    const later = new LocalProcessBackend({ stateDir });
    expect(await later.status("exec_durable")).toMatchObject({ status: "running" });

    await mkdir(join(stateDir, "results"), { recursive: true });
    await writeFile(
      join(stateDir, "results", "exec_durable.json"),
      JSON.stringify({ executionId: "exec_durable", exitCode: 0, signal: null, endedAt: new Date().toISOString() }),
    );
    expect(await later.status("exec_durable")).toMatchObject({ status: "completed", exitCode: 0 });
  });

  it("hands a background run to a detached supervisor and releases the caller", async () => {
    const stateDir = await temporaryRoot();
    const child = new FakeChild(process.pid);
    const options: LocalSpawnOptions[] = [];
    const commands: string[] = [];
    const backend = new LocalProcessBackend({
      stateDir,
      spawnProcess(command, args, spawnOptions) {
        commands.push(command);
        options.push(spawnOptions);
        return child;
      },
      supervisorScript: "/supervisor.js",
    });

    const spawned = await backend.spawn({
      executionId: "exec_bg",
      launchSpec: launchSpec({ temporaryFiles: ["/tmp/should-be-supervisors-job"] }),
      lifecycle: { requestId: "req_bg", parentExecutionId: null, background: true, interactive: false, timeoutMs: null },
    });

    expect(spawned).toMatchObject({ status: "running", metadata: { mode: "background" } });
    expect(commands[0]).toBe(process.execPath);
    expect(options[0]).toMatchObject({ detached: true, stdio: "ignore" });
    expect(child.unrefCalls).toBe(1);

    // The supervisor is handed the real launch through a file, because the runtime's
    // environment and argv are both too large to survive a command line.
    const spec = JSON.parse(await readFile(join(stateDir, "specs", "exec_bg.json"), "utf8")) as Record<string, unknown>;
    expect(spec).toMatchObject({
      executionId: "exec_bg",
      command: "fake-runtime",
      temporaryFiles: ["/tmp/should-be-supervisors-job"],
    });
  });

  it("stops an attached run when its wait times out", async () => {
    const child = new FakeChild();
    const backend = new LocalProcessBackend({ stdio: "inherit", spawnProcess: () => child });
    await backend.spawn({ executionId: "exec-slow", launchSpec: launchSpec() });

    // `--timeout-ms` was silently ignored before: a hung agent held its caller forever.
    // An attached run is stopped rather than abandoned — nothing else would record its
    // outcome, and it would keep writing to a terminal whose caller has already given up.
    await expect(backend.wait("exec-slow", { timeoutMs: 20 })).rejects.toMatchObject({
      code: "EXECUTION_TIMEOUT",
    });
    expect(child.killedWith).toBe("SIGTERM");
    expect(await backend.status("exec-slow")).toMatchObject({ status: "cancelled" });
  });

  it("leaves a supervised background run alone when a wait times out", async () => {
    const stateDir = await temporaryRoot();
    const starter = new LocalProcessBackend({ stateDir, spawnProcess: () => new FakeChild(process.pid) });
    await starter.spawn({
      executionId: "exec_bg_timeout",
      launchSpec: launchSpec(),
      lifecycle: { requestId: "r", parentExecutionId: null, background: true, interactive: false, timeoutMs: null },
    });

    // The supervisor is still holding this one and will record how it ends, so a lapsed
    // wait is only the caller giving up.
    const observer = new LocalProcessBackend({ stateDir });
    await expect(observer.wait("exec_bg_timeout", { timeoutMs: 60 })).rejects.toMatchObject({
      code: "EXECUTION_TIMEOUT",
    });
    expect(await observer.status("exec_bg_timeout")).toMatchObject({ status: "running" });
  });

  it("reports an execution whose process vanished without a result as an orphan", async () => {
    const stateDir = await temporaryRoot();
    const backend = new LocalProcessBackend({
      stateDir,
      spawnProcess: () => new FakeChild(DEAD_PID),
    });
    await backend.spawn({
      executionId: "exec_orphan",
      launchSpec: launchSpec(),
      lifecycle: { requestId: "req_o", parentExecutionId: null, background: true, interactive: false, timeoutMs: null },
    });

    expect(backend.orphanExecutions().map((record) => record.executionId)).toEqual(["exec_orphan"]);
    expect(await backend.status("exec_orphan")).toMatchObject({
      status: "failed",
      error: { code: "ExecutionFailed", message: expect.stringContaining("orphaned") },
    });
  });

  it("signals the whole process group when cancelling a detached run", async () => {
    const stateDir = await temporaryRoot();
    const signalled: [number, NodeJS.Signals][] = [];
    const backend = new LocalProcessBackend({
      stateDir,
      platform: "linux",
      spawnProcess: () => new FakeChild(4242),
      killProcess: (pid, signal) => { signalled.push([pid, signal]); },
    });
    await backend.spawn({
      executionId: "exec_group",
      launchSpec: launchSpec(),
      lifecycle: { requestId: "req_g", parentExecutionId: null, background: true, interactive: false, timeoutMs: null },
    });

    await backend.cancel("exec_group", "SIGTERM");
    // Negative pid: the supervisor leads the group, and killing it alone would leave the
    // runtime it started orphaned and unrecorded.
    expect(signalled).toEqual([[-4242, "SIGTERM"]]);
  });

  it("captures the transcript and quotes it when a run fails", async () => {
    const stateDir = await temporaryRoot();
    const child = new FakeChild();
    const backend = new LocalProcessBackend({ stateDir, spawnProcess: () => child });
    await backend.spawn({ executionId: "exec_log", launchSpec: launchSpec() });

    child.stderr.emit("data", Buffer.from("boom: config missing\n"));
    const waited = backend.wait("exec_log");
    child.emit("close", 1, null);

    const result = await waited;
    expect(result.output).toContain("boom: config missing");
    expect(result.error?.message).toContain("boom: config missing");
    await expect(readFile(join(stateDir, "logs", "exec_log.log"), "utf8")).resolves.toContain("boom");
  });

  it("gives an interactive launch the terminal rather than teeing it", async () => {
    const options: LocalSpawnOptions[] = [];
    const backend = new LocalProcessBackend({
      spawnProcess(_command, _args, spawnOptions) {
        options.push(spawnOptions);
        return new FakeChild();
      },
    });

    // The principal's own session runs through here. Piping it would leave that session
    // with no tty, so `interactive` has to survive all the way to the spawn options.
    await backend.spawn({
      executionId: "exec-interactive",
      launchSpec: launchSpec(),
      lifecycle: { requestId: "r", parentExecutionId: null, background: false, interactive: true, timeoutMs: null },
    });
    expect(options[0].stdio).toBe("inherit");

    await backend.spawn({
      executionId: "exec-delegated",
      launchSpec: launchSpec(),
      lifecycle: { requestId: "r", parentExecutionId: null, background: false, interactive: false, timeoutMs: null },
    });
    // stdin closed: a delegated agent has no interactive input, and an unwritten stdin pipe
    // costs it a three-second timeout before it starts.
    expect(options[1].stdio).toEqual(["ignore", "pipe", "pipe"]);
  });

  it("refuses to look healthy when no runtime is installed", async () => {
    const missing = new LocalProcessBackend({ probeRuntimes: async () => [] });
    expect(await missing.healthCheck()).toMatchObject({ ok: false, remediation: expect.any(String) });

    const present = new LocalProcessBackend({ probeRuntimes: async () => ["claude"] });
    expect(await present.healthCheck()).toMatchObject({ ok: true, message: expect.stringContaining("claude") });
  });

  it("names a runtime that is not on PATH as a backend problem, not an execution failure", async () => {
    const child = new FakeChild();
    const backend = new LocalProcessBackend({ stdio: "inherit", spawnProcess: () => child });
    await backend.spawn({ executionId: "exec-enoent", launchSpec: launchSpec() });

    const waited = backend.wait("exec-enoent");
    child.emit("error", Object.assign(new Error("spawn fake-runtime ENOENT"), { code: "ENOENT" }));

    await expect(waited).rejects.toThrow(/ENOENT/);
    expect(await backend.status("exec-enoent")).toMatchObject({
      status: "failed",
      error: { code: "BACKEND_UNAVAILABLE" },
    });
  });

  it("forgets a cleaned execution but keeps its transcript", async () => {
    const stateDir = await temporaryRoot();
    const child = new FakeChild();
    const backend = new LocalProcessBackend({ stateDir, spawnProcess: () => child });
    await backend.spawn({ executionId: "exec_gone", launchSpec: launchSpec() });
    child.stdout.emit("data", Buffer.from("worth keeping\n"));
    const waited = backend.wait("exec_gone");
    child.emit("close", 0, null);
    await waited;

    await backend.cleanup("exec_gone");
    await expect(backend.status("exec_gone")).rejects.toThrow(/unknown local execution/);
    await expect(readFile(join(stateDir, "logs", "exec_gone.log"), "utf8")).resolves.toContain("worth keeping");
  });

  it("rejects a duplicate execution ID across processes", async () => {
    const stateDir = await temporaryRoot();
    const backend = new LocalProcessBackend({ stateDir, spawnProcess: () => new FakeChild(process.pid) });
    await backend.spawn({
      executionId: "exec_dup",
      launchSpec: launchSpec(),
      lifecycle: { requestId: "r", parentExecutionId: null, background: true, interactive: false, timeoutMs: null },
    });

    const later = new LocalProcessBackend({ stateDir, spawnProcess: () => new FakeChild(process.pid) });
    await expect(later.spawn({ executionId: "exec_dup", launchSpec: launchSpec() })).rejects.toThrow(/already exists/);
  });

  it("raises a typed timeout when polling a background run that never finishes", async () => {
    const stateDir = await temporaryRoot();
    const starter = new LocalProcessBackend({ stateDir, spawnProcess: () => new FakeChild(process.pid) });
    await starter.spawn({
      executionId: "exec_poll",
      launchSpec: launchSpec(),
      lifecycle: { requestId: "r", parentExecutionId: null, background: true, interactive: false, timeoutMs: null },
    });

    const later = new LocalProcessBackend({ stateDir });
    const error = await later.wait("exec_poll", { timeoutMs: 60 }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(DelegationError);
    expect((error as DelegationError).code).toBe("EXECUTION_TIMEOUT");
  });
});
