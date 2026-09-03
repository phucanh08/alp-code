import { describe, expect, it, vi } from "vitest";
import { main, parseAlpArgs } from "../../src/cli/alp";
import { runMainSession } from "../../src/cli/commands/run-main";
import { runDelegateCommand } from "../../src/cli/commands/delegate";

describe("alp CLI parsing", () => {
  it.each([
    [[], { command: "run-main" }],
    [["--runtime", "claude"], { command: "run-main", runtime: "claude" }],
    [["--runtime=codex"], { command: "run-main", runtime: "codex" }],
    [["runtime", "show"], { command: "runtime", action: "show" }],
    [["runtime", "set", "codex"], { command: "runtime", action: "set", runtime: "codex" }],
    [["init", "/tmp/project"], { command: "init", project: "/tmp/project" }],
    [["deinit", "/tmp/project"], { command: "deinit", project: "/tmp/project" }],
    [["principal", "show"], { command: "principal", action: "show" }],
    [["principal", "set"], { command: "principal", action: "set" }],
    [["delegate", "search", "find", "launcher"], { command: "delegate", args: ["search", "find", "launcher"] }],
    [["doctor", "--quiet"], { command: "maintenance", action: "doctor", args: ["--quiet"] }],
    [["update"], { command: "maintenance", action: "update", args: [] }],
    [["uninstall", "--purge-memory", "--force"], { command: "maintenance", action: "uninstall", args: ["--purge-memory", "--force"] }],
    [["--version"], { command: "version" }],
    [["-v"], { command: "version" }],
  ])("parses %j", (argv, expected) => {
    expect(parseAlpArgs(argv)).toEqual(expected);
  });

  it.each([
    ["--runtime", "claude", "--runtime", "codex"],
    ["--runtime", "other"],
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

  it("dispatches the default command with the caller cwd and explicit runtime", async () => {
    const runMain = vi.fn(async () => 0);
    await expect(main(["--runtime", "codex"], {
      cwd: "/caller/project",
      stdout: { write: () => true },
      stderr: { write: () => true },
      version: "0.0.0",
      checkForUpdate: async () => null,
      runMain,
      runtimeCommand: async () => 0,
      initProject: async () => undefined,
      deinitProject: async () => undefined,
      syncIdentity: async () => undefined,
      principalCommand: async () => 0,
      delegateCommand: async () => 0,
      maintenanceCommand: async () => 0,
    })).resolves.toBe(0);
    expect(runMain).toHaveBeenCalledWith({ cwd: "/caller/project", requestedRuntime: "codex" });
  });

  it("dispatches maintenance commands through the code-native CLI", async () => {
    const maintenanceCommand = vi.fn(async () => 7);
    await expect(main(["uninstall", "--purge-memory", "--force"], {
      cwd: "/caller/project",
      stdout: { write: () => true },
      stderr: { write: () => true },
      version: "0.0.0",
      checkForUpdate: async () => null,
      runMain: async () => 0,
      runtimeCommand: async () => 0,
      initProject: async () => undefined,
      deinitProject: async () => undefined,
      syncIdentity: async () => undefined,
      principalCommand: async () => 0,
      delegateCommand: async () => 0,
      maintenanceCommand,
    })).resolves.toBe(7);
    expect(maintenanceCommand).toHaveBeenCalledWith({ action: "uninstall", args: ["--purge-memory", "--force"] });
  });

  it("prints the installed version", async () => {
    const writes: string[] = [];
    await expect(main(["--version"], {
      cwd: "/caller/project",
      stdout: { write: (text: string) => writes.push(text) },
      stderr: { write: () => true },
      version: "1.2.3",
      checkForUpdate: async () => null,
      runMain: async () => 0,
      runtimeCommand: async () => 0,
      initProject: async () => undefined,
      deinitProject: async () => undefined,
      syncIdentity: async () => undefined,
      principalCommand: async () => 0,
      delegateCommand: async () => 0,
      maintenanceCommand: async () => 0,
    })).resolves.toBe(0);
    expect(writes).toEqual(["alp 1.2.3\n"]);
  });

  it("prints an update notice before dispatching when one is available", async () => {
    const writes: string[] = [];
    await main([], {
      cwd: "/caller/project",
      stdout: { write: (text: string) => writes.push(text) },
      stderr: { write: () => true },
      version: "0.0.0",
      checkForUpdate: async () => "UPDATE    new version available\n",
      runMain: async () => 0,
      runtimeCommand: async () => 0,
      initProject: async () => undefined,
      deinitProject: async () => undefined,
      syncIdentity: async () => undefined,
      principalCommand: async () => 0,
      delegateCommand: async () => 0,
      maintenanceCommand: async () => 0,
    });
    expect(writes).toEqual(["UPDATE    new version available\n"]);
  });
});

describe("runMainSession", () => {
  it("uses remembered selection, code-native main definition, adapter launch spec, and local lifecycle", async () => {
    const events: string[] = [];
    const prepared = { capsule: { executionId: "exec-main" } } as never;
    const launchSpec = { command: "fake", args: [], cwd: "/project", env: {}, temporaryFiles: [] };
    const result = await runMainSession({ cwd: "/project" }, {
      registry: {
        get(id: string) {
          events.push(`registry:${id}`);
          return { id: "main", reportsTo: "principal", model: { claude: "claude-main", codex: "codex-main" }, reasoningEffort: { claude: "high", codex: "xhigh" } } as never;
        },
      },
      selector: {
        async select(input) { events.push(`select:${input.requestedRuntime ?? "remembered"}`); return { ok: true, runtime: "codex", source: "persisted" }; },
      },
      executionService: {
        async prepare(input) { events.push(`prepare:${input.parent}->${input.target}:${input.workspace}:${input.workspaceMode}`); return prepared; },
      },
      adapters: new Map([["codex", {
        name: "codex",
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
      "adapter:codex-main:xhigh",
      "spawn:/project",
      "wait",
    ]);
  });

  it("defaults an unregistered cwd to read-only", async () => {
    let workspaceMode: string | undefined;
    const definition = { id: "main", reportsTo: "principal", model: { claude: "claude-main", codex: "codex-main" }, reasoningEffort: { claude: "high", codex: "xhigh" } } as never;
    await runMainSession({ cwd: "/unknown" }, {
      registry: { get: () => definition },
      selector: { async select() { return { ok: true, runtime: "claude", source: "default" }; } },
      executionService: { async prepare(input) { workspaceMode = input.workspaceMode; return { capsule: { executionId: "exec" } } as never; } },
      adapters: new Map([["claude", { name: "claude", async probe() { return { ok: true, runtime: "claude", message: "ok" }; }, async prepare() { return { command: "fake", args: [], cwd: "/unknown", env: {}, temporaryFiles: [] }; } }]]),
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
  it("keeps caller identity/workspace and forwards the runtime without raw shortcuts", async () => {
    const calls: unknown[] = [];
    const result = await runDelegateCommand([
      "search", "--runtime", "codex", "--background", "--", "find", "launcher",
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
      executionOptions: { runtime: "codex", background: true },
    });
  });
});
