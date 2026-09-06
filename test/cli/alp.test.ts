import { describe, expect, it, vi } from "vitest";
import { main, parseAlpArgs } from "../../src/cli/alp";
import { runMainSession } from "../../src/cli/commands/run-main";
import { runDelegateCommand } from "../../src/cli/commands/delegate";

/** Mọi lệnh chỉ khác nhau ở nấc, nên phần còn lại của dependency giống hệt nhau. */
function stubDependencies(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "/caller/project",
    stdout: { write: () => true },
    stderr: { write: () => true },
    version: "0.0.0",
    checkForUpdate: async () => null,
    runMain: async () => 0,
    modeCommand: async () => 0,
    initProject: async () => undefined,
    deinitProject: async () => undefined,
    syncIdentity: async () => undefined,
    principalCommand: async () => 0,
    delegateCommand: async () => 0,
    contextCommand: async () => 0,
    maintenanceCommand: async () => 0,
    ...overrides,
  } as never;
}

describe("alp CLI parsing", () => {
  it.each([
    [[], { command: "run-main" }],
    [["--mode", "ultra"], { command: "run-main", mode: "ultra" }],
    [["--mode=low"], { command: "run-main", mode: "low" }],
    [["--mode=puck"], { command: "run-main", mode: "puck" }],
    [["mode", "show"], { command: "mode", action: "show" }],
    [["mode", "set", "high"], { command: "mode", action: "set", mode: "high" }],
    [["init", "/tmp/project"], { command: "init", project: "/tmp/project" }],
    [["deinit", "/tmp/project"], { command: "deinit", project: "/tmp/project" }],
    [["principal", "show"], { command: "principal", action: "show" }],
    [["principal", "set"], { command: "principal", action: "set" }],
    [["delegate", "search", "find", "launcher"], { command: "delegate", args: ["search", "find", "launcher"] }],
    [["context", "status", "exec_abc"], { command: "context", args: ["status", "exec_abc"] }],
    [["context", "pin", "decision", "--", "chose", "X"], { command: "context", args: ["pin", "decision", "--", "chose", "X"] }],
    [["doctor", "--quiet"], { command: "maintenance", action: "doctor", args: ["--quiet"] }],
    [["update"], { command: "maintenance", action: "update", args: [] }],
    [["uninstall", "--purge-memory", "--force"], { command: "maintenance", action: "uninstall", args: ["--purge-memory", "--force"] }],
    [["--version"], { command: "version" }],
    [["-v"], { command: "version" }],
  ])("parses %j", (argv, expected) => {
    expect(parseAlpArgs(argv)).toEqual(expected);
  });

  it.each([
    ["--mode", "smart"],
    ["--mode"],
    ["--mode", "low", "--mode", "high"],
    ["mode", "set", "smart"],
    ["mode", "set"],
    ["wat"],
    ["claude"],
    ["codex"],
    ["run-role", "search"],
    ["--role", "main"],
    ["--version", "extra"],
    ["principal"],
    ["principal", "reset"],
  ])("rejects ambiguous or direct raw-runtime input: %j", (...argv) => {
    expect(() => parseAlpArgs(argv)).toThrow();
  });

  /**
   * `--runtime` và `alp runtime` từng là cách chọn CLI. Bỏ im lặng thì một script cũ sẽ chạy
   * đúng nấc mặc định mà người viết tưởng đang ép Codex — nên chúng dừng và nói đi đâu.
   */
  it.each([
    [["--runtime", "claude"]],
    [["--runtime=codex"]],
    [["runtime", "show"]],
    [["runtime", "set", "codex"]],
  ])("points %j at the mode dial instead of failing silently", (argv) => {
    expect(() => parseAlpArgs(argv)).toThrow(/runtime không còn là lựa chọn/);
  });

  it("dispatches the default command with the caller cwd and explicit mode", async () => {
    const runMain = vi.fn(async () => 0);
    await expect(main(["--mode", "ultra"], stubDependencies({ runMain }))).resolves.toBe(0);
    expect(runMain).toHaveBeenCalledWith({ cwd: "/caller/project", mode: "ultra" });
  });

  it("dispatches maintenance commands through the code-native CLI", async () => {
    const maintenanceCommand = vi.fn(async () => 7);
    await expect(
      main(["uninstall", "--purge-memory", "--force"], stubDependencies({ maintenanceCommand })),
    ).resolves.toBe(7);
    expect(maintenanceCommand).toHaveBeenCalledWith({ action: "uninstall", args: ["--purge-memory", "--force"] });
  });

  it("dispatches `alp mode` to the preference command", async () => {
    const modeCommand = vi.fn(async () => 0);
    await expect(main(["mode", "set", "puck"], stubDependencies({ modeCommand }))).resolves.toBe(0);
    expect(modeCommand).toHaveBeenCalledWith({ command: "mode", action: "set", mode: "puck" });
  });

  it("prints the installed version", async () => {
    const writes: string[] = [];
    await expect(main(["--version"], stubDependencies({
      stdout: { write: (text: string) => writes.push(text) },
      version: "1.2.3",
    }))).resolves.toBe(0);
    expect(writes).toEqual(["alp 1.2.3\n"]);
  });

  it("dispatches context commands with their raw sub-args", async () => {
    const contextCommand = vi.fn(async () => 0);
    await expect(main(["context", "status", "exec_abc"], stubDependencies({ contextCommand }))).resolves.toBe(0);
    expect(contextCommand).toHaveBeenCalledWith(["status", "exec_abc"]);
  });

  it("prints an update notice before dispatching when one is available", async () => {
    const writes: string[] = [];
    await main([], stubDependencies({
      stdout: { write: (text: string) => writes.push(text) },
      checkForUpdate: async () => "UPDATE    new version available\n",
    }));
    expect(writes).toEqual(["UPDATE    new version available\n"]);
  });
});

const MAIN_DEFINITION = {
  id: "main",
  reportsTo: "principal",
  model: { claude: "claude-main", codex: "codex-main" },
  reasoningEffort: { claude: "high", codex: "xhigh" },
} as never;

describe("runMainSession", () => {
  it("uses remembered selection, code-native main definition, adapter launch spec, and local lifecycle", async () => {
    const events: string[] = [];
    const prepared = { capsule: { executionId: "exec-main" } } as never;
    const launchSpec = { command: "fake", args: [], cwd: "/project", env: {}, temporaryFiles: [] };
    const result = await runMainSession({ cwd: "/project" }, {
      registry: {
        get(id: string) {
          events.push(`registry:${id}`);
          return MAIN_DEFINITION;
        },
      },
      selector: {
        async select(input) { events.push(`select:${input.requestedMode ?? "remembered"}`); return { ok: true, mode: "medium", source: "persisted" }; },
      },
      executionService: {
        async prepare(input) { events.push(`prepare:${input.parent}->${input.target}:${input.workspace}:${input.workspaceMode}`); return prepared; },
      },
      adapters: new Map([["codex", {
        name: "codex",
        compact: { preCompact: true, postCompact: true, sessionStartAfterCompact: true },
        async probe() { events.push("probe:codex"); return { ok: true, runtime: "codex", message: "ok" }; },
        async prepare(input) { events.push(`adapter:${input.model}:${input.reasoningEffort}`); return launchSpec; },
      }]]),
      backend: {
        name: "local",
        async healthCheck() { return { ok: true, message: "ok" }; },
        async spawn(input) { events.push(`spawn:${input.launchSpec.cwd}`); return { executionId: input.executionId, status: "running" }; },
        async status(executionId) { return { executionId, status: "running" }; },
        async wait(executionId) { events.push("wait"); return { executionId, status: "completed" }; },
        async cancel(executionId) { return { executionId, status: "cancelled" }; },
        async cleanup() {},
      },
      executionId: () => "exec-main",
      interactive: false,
      workspaceModeFor: async () => "workspace-write",
    });

    expect(result).toMatchObject({ status: "completed" });
    expect(events).toEqual([
      "registry:main",
      "select:remembered",
      "prepare:principal->main:/project:workspace-write",
      "probe:codex",
      "adapter:gpt-5.6-sol:high",
      "spawn:/project",
      "wait",
    ]);
  });

  /**
   * Nấc là thứ duy nhất phân biệt hai lần chạy cùng một `main`, nên nó phải đi tới tận
   * launch spec — nếu chỉ nằm trong policy thì `policy.json` nói `ultra` còn tiến trình vẫn
   * chạy model của `medium`. Nấc cũng chọn luôn CLI: `ultra` ghim Opus 5, và Opus 5 chỉ
   * chạy trên Claude Code.
   */
  it("launches the dialled model and effort on the runtime that model implies", async () => {
    const events: string[] = [];
    let preparedMode: string | undefined;
    await runMainSession({ cwd: "/project", mode: "ultra" }, {
      registry: { get: () => MAIN_DEFINITION },
      selector: { async select() { return { ok: true, mode: "ultra", source: "explicit" }; } },
      executionService: {
        async prepare(input) { preparedMode = input.mode; return { capsule: { executionId: "exec-main" } } as never; },
      },
      adapters: new Map([["claude", {
        name: "claude",
        compact: { preCompact: true, postCompact: true, sessionStartAfterCompact: true },
        async probe() { return { ok: true, runtime: "claude", message: "ok" }; },
        async prepare(input) { events.push(`adapter:${input.model}:${input.reasoningEffort}`); return { command: "fake", args: [], cwd: "/project", env: {}, temporaryFiles: [] }; },
      }]]),
      backend: {
        name: "local",
        async healthCheck() { return { ok: true, message: "ok" }; },
        async spawn(input) { return { executionId: input.executionId, status: "running" }; },
        async status(executionId) { return { executionId, status: "running" }; },
        async wait(executionId) { return { executionId, status: "completed" }; },
        async cancel(executionId) { return { executionId, status: "cancelled" }; },
        async cleanup() {},
      },
      executionId: () => "exec-main",
      interactive: false,
    });

    expect(events).toEqual(["adapter:claude-opus-5:high"]);
    expect(preparedMode).toBe("ultra");
  });

  /** `puck` là nấc duy nhất không có Claude ở bất kỳ vai nào — kể cả `main`. */
  it("keeps the puck session entirely on Codex", async () => {
    const events: string[] = [];
    await runMainSession({ cwd: "/project", mode: "puck" }, {
      registry: { get: () => MAIN_DEFINITION },
      selector: { async select() { return { ok: true, mode: "puck", source: "explicit" }; } },
      executionService: { async prepare() { return { capsule: { executionId: "exec-main" } } as never; } },
      adapters: new Map([["codex", {
        name: "codex",
        compact: { preCompact: true, postCompact: true, sessionStartAfterCompact: true },
        async probe() { return { ok: true, runtime: "codex", message: "ok" }; },
        async prepare(input) { events.push(`adapter:${input.model}:${input.reasoningEffort}`); return { command: "fake", args: [], cwd: "/project", env: {}, temporaryFiles: [] }; },
      }]]),
      backend: {
        name: "local",
        async healthCheck() { return { ok: true, message: "ok" }; },
        async spawn(input) { return { executionId: input.executionId, status: "running" }; },
        async status(executionId) { return { executionId, status: "running" }; },
        async wait(executionId) { return { executionId, status: "completed" }; },
        async cancel(executionId) { return { executionId, status: "cancelled" }; },
        async cleanup() {},
      },
      executionId: () => "exec-main",
      interactive: false,
    });

    expect(events).toEqual(["adapter:gpt-5.6-sol:xhigh"]);
  });

  it("defaults an unregistered cwd to read-only", async () => {
    let workspaceMode: string | undefined;
    await runMainSession({ cwd: "/unknown" }, {
      registry: { get: () => MAIN_DEFINITION },
      selector: { async select() { return { ok: true, mode: "medium", source: "default" }; } },
      executionService: { async prepare(input) { workspaceMode = input.workspaceMode; return { capsule: { executionId: "exec" } } as never; } },
      adapters: new Map([["codex", { name: "codex", compact: { preCompact: true, postCompact: true, sessionStartAfterCompact: true }, async probe() { return { ok: true, runtime: "codex", message: "ok" }; }, async prepare() { return { command: "fake", args: [], cwd: "/unknown", env: {}, temporaryFiles: [] }; } }]]),
      backend: {
        name: "local",
        async healthCheck() { return { ok: true, message: "ok" }; },
        async spawn() { return { executionId: "exec", status: "completed" }; },
        async status(executionId) { return { executionId, status: "completed" }; },
        async wait(executionId) { return { executionId, status: "completed" }; },
        async cancel(executionId) { return { executionId, status: "cancelled" }; },
        async cleanup() {},
      },
      executionId: () => "exec",
      interactive: false,
    });
    expect(workspaceMode).toBe("read-only");
  });
});

describe("alp delegate", () => {
  it("keeps caller identity and workspace without raw shortcuts", async () => {
    const calls: unknown[] = [];
    const result = await runDelegateCommand([
      "search", "--background", "--", "find", "launcher",
    ], {
      cwd: "/caller/project",
      env: { ALP_ROLE: "main", ALP_DELEGATION_EXECUTION_ID: "exec-parent" },
      service: {
        async delegate(input) { calls.push(input); return { executionId: "exec-child", requestId: "req", status: "running", metadata: { backend: "local", runtime: "codex" } }; },
        async wait() { throw new Error("background must not wait"); },
        async status() { throw new Error("unused"); },
        async cancel() { throw new Error("unused"); },
        async cleanup() { throw new Error("unused"); },
        listExecutions() { return []; },
      },
    });

    expect(result).toMatchObject({ status: "running" });
    expect(calls[0]).toMatchObject({
      parentRole: "main",
      parentExecutionId: "exec-parent",
      targetRole: "search",
      task: "find launcher",
      workspace: "/caller/project",
      executionOptions: { background: true },
    });
    expect(calls[0]).not.toHaveProperty("executionOptions.runtime");
  });

  /** Một `--runtime` còn sót lại chọn sai CLI cho model của nấc, nên nó dừng chứ không bị bỏ qua. */
  it("refuses a leftover --runtime instead of ignoring it", async () => {
    await expect(runDelegateCommand(["search", "--runtime", "codex", "--", "find"], {
      cwd: "/caller/project",
      env: {},
      service: {
        async delegate() { throw new Error("must not delegate"); },
        async wait() { throw new Error("unused"); },
        async status() { throw new Error("unused"); },
        async cancel() { throw new Error("unused"); },
        async cleanup() { throw new Error("unused"); },
        listExecutions() { return []; },
      },
    })).rejects.toThrow(/--runtime` không còn tồn tại/);
  });
});
