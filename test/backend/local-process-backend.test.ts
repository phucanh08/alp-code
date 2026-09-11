import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalProcessBackend, type LocalSpawnOptions } from "../../src/backend/local-process-backend";
import { DelegationError } from "../../src/delegation/types";
import type { RuntimeLaunchSpec } from "../../src/runtime/runtime-adapter";
import { expectPosixMode } from "../support/file-mode";
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

const sleep = (ms: number): Promise<void> => new Promise((settle) => setTimeout(settle, ms));

/** Waits for a condition a timer somewhere else is responsible for making true. */
async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await sleep(2);
  }
}

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
      lifecycle: { requestId: "req_1", parentExecutionId: null, background: true, interactive: false, timeoutMs: null, deadlineAt: null },
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
      lifecycle: { requestId: "req_bg", parentExecutionId: null, background: true, interactive: false, timeoutMs: null, deadlineAt: null },
    });

    expect(spawned).toMatchObject({ status: "running", metadata: { mode: "background" } });
    expect(commands[0]).toBe(process.execPath);
    expect(options[0]).toMatchObject({ detached: true, stdio: "ignore" });
    expect(child.unrefCalls).toBe(1);

    // The supervisor is handed the real launch through a file, because the runtime's
    // environment and argv are both too large to survive a command line.
    const specFile = join(stateDir, "specs", "exec_bg.json");
    const spec = JSON.parse(await readFile(specFile, "utf8")) as Record<string, unknown>;
    expect(spec).toMatchObject({
      executionId: "exec_bg",
      command: "fake-runtime",
      temporaryFiles: ["/tmp/should-be-supervisors-job"],
    });

    // Spec mang trọn env của execution — capability nằm trong đó — nên nó phải riêng tư
    // ngay từ lúc được tạo, cả file lẫn thư mục. Supervisor xoá nó trước khi spawn runtime
    // (xem test/cli/internal.test.ts); từ đầu này, việc phải làm là không bao giờ để nó
    // tồn tại dù chỉ một khoảnh khắc với quyền rộng hơn chủ sở hữu.
    await expectPosixMode(specFile, 0o600);
    await expectPosixMode(join(stateDir, "specs"), 0o700);
  });

  it("self-invokes the native internal supervisor without treating the binary as Node", async () => {
    const stateDir = await temporaryRoot();
    const child = new FakeChild(process.pid);
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const backend = new LocalProcessBackend({
      stateDir,
      spawnProcess(command, args) { calls.push({ command, args }); return child; },
      supervisorInvocation: { executable: "/versions/v0.10.0/bin/alp", args: ["__internal", "supervisor"] },
    });
    await backend.spawn({
      executionId: "exec_native_bg",
      launchSpec: launchSpec(),
      lifecycle: { requestId: "req", parentExecutionId: null, background: true, interactive: false, timeoutMs: null, deadlineAt: null },
    });
    expect(calls[0]).toEqual({
      command: "/versions/v0.10.0/bin/alp",
      args: ["__internal", "supervisor", join(stateDir, "specs", "exec_native_bg.json")],
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
      lifecycle: { requestId: "r", parentExecutionId: null, background: true, interactive: false, timeoutMs: null, deadlineAt: null },
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
      lifecycle: { requestId: "req_o", parentExecutionId: null, background: true, interactive: false, timeoutMs: null, deadlineAt: null },
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
      lifecycle: { requestId: "req_g", parentExecutionId: null, background: true, interactive: false, timeoutMs: null, deadlineAt: null },
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
      lifecycle: { requestId: "r", parentExecutionId: null, background: false, interactive: true, timeoutMs: null, deadlineAt: null },
    });
    expect(options[0].stdio).toBe("inherit");

    await backend.spawn({
      executionId: "exec-delegated",
      launchSpec: launchSpec(),
      lifecycle: { requestId: "r", parentExecutionId: null, background: false, interactive: false, timeoutMs: null, deadlineAt: null },
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
      lifecycle: { requestId: "r", parentExecutionId: null, background: true, interactive: false, timeoutMs: null, deadlineAt: null },
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
      lifecycle: { requestId: "r", parentExecutionId: null, background: true, interactive: false, timeoutMs: null, deadlineAt: null },
    });

    const later = new LocalProcessBackend({ stateDir });
    const error = await later.wait("exec_poll", { timeoutMs: 60 }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(DelegationError);
    expect((error as DelegationError).code).toBe("EXECUTION_TIMEOUT");
  });

  /**
   * Hai đồng hồ khác nhau, và gộp chúng là hỏng cả hai: `timeoutMs` nói người gọi thôi chờ,
   * `deadlineAt` nói execution phải chết. Một run có hạn hai giờ vẫn phải trả `--timeout-ms`
   * về sau hai mươi mili-giây, và lý do dừng nó không phải là đồng hồ của cây.
   */
  it("keeps a caller's timeout and the execution's deadline as separate clocks", async () => {
    const child = new FakeChild();
    const backend = new LocalProcessBackend({ stdio: "inherit", spawnProcess: () => child });
    await backend.spawn({
      executionId: "exec_two_clocks",
      launchSpec: launchSpec(),
      lifecycle: {
        requestId: "req_tc", parentExecutionId: null, background: false, interactive: false,
        timeoutMs: 20, deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });

    await expect(backend.wait("exec_two_clocks", { timeoutMs: 20 })).rejects.toMatchObject({
      code: "EXECUTION_TIMEOUT",
    });
    const stopped = await backend.status("exec_two_clocks");
    expect(stopped).toMatchObject({ status: "cancelled" });
    expect(stopped.metadata).toBeUndefined();
  });

  it("refuses to start an execution whose deadline has already passed", async () => {
    const stateDir = await temporaryRoot();
    let spawns = 0;
    const backend = new LocalProcessBackend({
      stateDir,
      spawnProcess: () => { spawns += 1; return new FakeChild(process.pid); },
    });

    // Hạn là của cả cây, nên một con sinh muộn có thể nhận một mốc đã qua. Khởi động nó là
    // tạo ra một process chỉ sống đủ lâu để bị giết — và một record phải dọn sau đó.
    const error = await backend.spawn({
      executionId: "exec_late",
      launchSpec: launchSpec(),
      lifecycle: {
        requestId: "req_late", parentExecutionId: "exec_parent", background: true,
        interactive: false, timeoutMs: null, deadlineAt: new Date(Date.now() - 1000).toISOString(),
      },
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(DelegationError);
    expect((error as DelegationError).code).toBe("WALL_CLOCK_EXCEEDED");
    expect(spawns).toBe(0);
    await expect(backend.status("exec_late")).rejects.toThrow(/unknown local execution/);
  });

  it("kills an attached run at its deadline and says the clock did it", async () => {
    const child = new FakeChild();
    const backend = new LocalProcessBackend({ stdio: "inherit", spawnProcess: () => child });
    await backend.spawn({
      executionId: "exec_deadline",
      launchSpec: launchSpec(),
      lifecycle: {
        requestId: "req_d", parentExecutionId: null, background: false, interactive: false,
        timeoutMs: null, deadlineAt: new Date(Date.now() + 20).toISOString(),
      },
    });

    const waited = backend.wait("exec_deadline");
    await waitFor(() => child.killedWith !== undefined);
    expect(child.killedWith).toBe("SIGTERM");
    child.emit("close", null, "SIGTERM");

    // `cancelled`, vì process đã bị dừng — và `terminationReason` là thứ duy nhất phân biệt
    // được nó với một lần người dùng bấm huỷ.
    await expect(waited).resolves.toMatchObject({
      status: "cancelled",
      signal: "SIGTERM",
      metadata: { terminationReason: "deadline" },
    });
  });

  it("drops the deadline timer when the run settles first", async () => {
    const child = new FakeChild();
    const backend = new LocalProcessBackend({ stdio: "inherit", spawnProcess: () => child });
    await backend.spawn({
      executionId: "exec_quick",
      launchSpec: launchSpec(),
      lifecycle: {
        requestId: "req_q", parentExecutionId: null, background: false, interactive: false,
        timeoutMs: null, deadlineAt: new Date(Date.now() + 30).toISOString(),
      },
    });

    const waited = backend.wait("exec_quick");
    child.emit("close", 0, null);
    await expect(waited).resolves.toMatchObject({ status: "completed", exitCode: 0 });

    // Một timer còn sống sau khi run đã xong giữ event loop mở: CLI đã in kết quả rồi ngồi
    // im tới hạn. Nó cũng sẽ bắn một tín hiệu vào một pid đã được hệ điều hành cấp lại.
    await sleep(50);
    expect(child.killedWith).toBeUndefined();
    const settled = await backend.status("exec_quick");
    expect(settled).toMatchObject({ status: "completed" });
    expect(settled.metadata).toBeUndefined();
  });

  it("keeps the person's reason when a cancel beats the deadline", async () => {
    const child = new FakeChild();
    const backend = new LocalProcessBackend({ stdio: "inherit", spawnProcess: () => child });
    await backend.spawn({
      executionId: "exec_raced",
      launchSpec: launchSpec(),
      lifecycle: {
        requestId: "req_r", parentExecutionId: null, background: false, interactive: false,
        timeoutMs: null, deadlineAt: new Date(Date.now() + 20).toISOString(),
      },
    });

    const waited = backend.wait("exec_raced");
    const cancelled = await backend.cancel("exec_raced");
    expect(cancelled).toMatchObject({ status: "cancelled" });
    expect(cancelled.metadata).toBeUndefined();
    await sleep(40);
    child.emit("close", null, "SIGTERM");

    // Đồng hồ nổ sau đó không được đổ lỗi cho mình một lần dừng mà người dùng đã ra lệnh.
    const settled = await waited;
    expect(settled).toMatchObject({ status: "cancelled" });
    expect(settled.metadata).toBeUndefined();
  });

  it("keeps the clock's reason when a cancel arrives after the deadline fired", async () => {
    const child = new FakeChild();
    const backend = new LocalProcessBackend({ stdio: "inherit", spawnProcess: () => child });
    await backend.spawn({
      executionId: "exec_late_cancel",
      launchSpec: launchSpec(),
      lifecycle: {
        requestId: "req_lc", parentExecutionId: null, background: false, interactive: false,
        timeoutMs: null, deadlineAt: new Date(Date.now() + 20).toISOString(),
      },
    });
    const waited = backend.wait("exec_late_cancel");
    await waitFor(() => child.killedWith !== undefined);

    expect(await backend.cancel("exec_late_cancel")).toMatchObject({
      status: "cancelled",
      metadata: { terminationReason: "deadline" },
    });
    child.emit("close", null, "SIGTERM");
    await expect(waited).resolves.toMatchObject({ metadata: { terminationReason: "deadline" } });
  });

  it("hands the deadline to the supervisor rather than holding the timer itself", async () => {
    const stateDir = await temporaryRoot();
    const deadlineAt = new Date(Date.now() + 3_600_000).toISOString();
    const backend = new LocalProcessBackend({
      stateDir,
      spawnProcess: () => new FakeChild(process.pid),
      supervisorScript: "/supervisor.js",
    });

    await backend.spawn({
      executionId: "exec_bg_deadline",
      launchSpec: launchSpec(),
      lifecycle: {
        requestId: "req_bd", parentExecutionId: null, background: true, interactive: false,
        timeoutMs: null, deadlineAt,
      },
    });

    // CLI này sẽ thoát ngay sau đây; nếu đồng hồ ở lại với nó thì `--background` là cách để
    // một agent chạy mãi mãi.
    const spec = JSON.parse(await readFile(join(stateDir, "specs", "exec_bg_deadline.json"), "utf8")) as Record<string, unknown>;
    expect(spec.deadlineAt).toBe(deadlineAt);
  });

  it("adopts a deadline kill reported by a supervisor that outlived the caller", async () => {
    const stateDir = await temporaryRoot();
    const starter = new LocalProcessBackend({ stateDir, spawnProcess: () => new FakeChild(process.pid) });
    await starter.spawn({
      executionId: "exec_bg_expired",
      launchSpec: launchSpec(),
      lifecycle: {
        requestId: "req_be", parentExecutionId: null, background: true, interactive: false,
        timeoutMs: null, deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });

    await mkdir(join(stateDir, "results"), { recursive: true });
    await writeFile(join(stateDir, "results", "exec_bg_expired.json"), JSON.stringify({
      executionId: "exec_bg_expired",
      exitCode: null,
      signal: "SIGTERM",
      endedAt: new Date().toISOString(),
      terminationReason: "deadline",
    }));

    // Một CLI khác đọc kết quả: nó chưa từng thấy process, nên `terminationReason` trong file
    // là toàn bộ những gì nó biết về việc ai đã dừng execution.
    const later = new LocalProcessBackend({ stateDir });
    const adopted = await later.status("exec_bg_expired");
    expect(adopted).toMatchObject({ status: "cancelled", metadata: { terminationReason: "deadline" } });
    // Không phải một execution hỏng: nó bị dừng, và một `error` ở đây sẽ bị in ra như lỗi
    // của agent.
    expect(adopted.error).toBeUndefined();
  });
});
