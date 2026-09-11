import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeTemporary } from "../support/temporary-root";
import { main, parseAlpArgs } from "../../src/cli/alp";
import { runMainSession } from "../../src/cli/commands/run-main";
import { applyModeSettings, parseModeSettings } from "../../src/agents/mode-settings";
import { DEFAULT_MODE, MODE_PROFILES, modelForMode, reasoningEffortForMode, runtimeForMode } from "../../src/agents/modes";
import type { AgentDefinition } from "../../src/agents/types";
import type {
  AuthorizeExecutionInput,
  MaterializeExecutionInput,
} from "../../src/execution/types";
import type { ExecutionBinding } from "../../src/execution/graph/execution-graph-service";
import {
  createDefaultDelegationComposition,
  isRenderedOutput,
  renderExecutionTree,
  runDelegateCommand,
  runDelegationLifecycleCommand,
  sharedBackendStateDirectory,
} from "../../src/cli/commands/delegate";
import type {
  ExecutionTreeNode,
  ExecutionTreeView,
} from "../../src/execution/graph/execution-graph-service";
import { DEFAULT_EXECUTION_GRAPH_LIMITS } from "../../src/execution/graph/defaults";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(removeTemporary));
});

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
    agentCommand: async () => 0,
    principalCommand: async () => 0,
    delegateCommand: async () => 0,
    contextCommand: async () => 0,
    threadCommand: async () => 0,
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
    // `--title` đặt tên Thread mới, đứng trước hay sau `--mode` đều được.
    [["--title", "fix login"], { command: "run-main", title: "fix login" }],
    [["--title=fix login", "--mode", "high"], { command: "run-main", mode: "high", title: "fix login" }],
    [["--mode=low", "--title", "  padded  "], { command: "run-main", mode: "low", title: "padded" }],
    [["mode", "show"], { command: "mode", action: "show" }],
    [["mode", "set", "high"], { command: "mode", action: "set", mode: "high" }],
    [["init", "/tmp/project"], { command: "init", project: "/tmp/project" }],
    [["deinit", "/tmp/project"], { command: "deinit", project: "/tmp/project" }],
    [["principal", "show"], { command: "principal", action: "show" }],
    [["principal", "set"], { command: "principal", action: "set" }],
    [["delegate", "search", "find", "launcher"], { command: "delegate", args: ["search", "find", "launcher"] }],
    [["context", "status", "exec_abc"], { command: "context", args: ["status", "exec_abc"] }],
    [["context", "pin", "decision", "--", "chose", "X"], { command: "context", args: ["pin", "decision", "--", "chose", "X"] }],
    [["thread", "list", "--all"], { command: "thread", args: ["list", "--all"] }],
    [["thread", "continue", "thread_abc", "--mode", "low"], { command: "thread", args: ["continue", "thread_abc", "--mode", "low"] }],
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
    ["--title"],
    ["--title", ""],
    ["--title", "a", "--title", "b"],
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

  it("hands `--title` to the session as the new thread's title", async () => {
    const runMain = vi.fn(async () => 0);
    await expect(main(["--title", "fix login", "--mode=low"], stubDependencies({ runMain }))).resolves.toBe(0);
    expect(runMain).toHaveBeenCalledWith({ cwd: "/caller/project", mode: "low", title: "fix login" });
  });

  it("dispatches `alp thread` to the thread command", async () => {
    const threadCommand = vi.fn(async () => 0);
    await expect(main(["thread", "show", "thread_abc"], stubDependencies({ threadCommand }))).resolves.toBe(0);
    expect(threadCommand).toHaveBeenCalledWith(["show", "thread_abc"]);
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
  // `main` thôi cầm bút từ 2026-09-10: không write root nào, nên phiên của nó là read-only
  // dù project đã đăng ký.
  capabilities: { workspace: { readRoots: ["."], writeRoots: [] } },
} as never;

/**
 * `ExecutionService` giả, hai bước. Vé là chính input đã authorize, nên một test nhìn thấy
 * được cả thứ tự lẫn việc `materialize` không tự tra lại target.
 */
function executionStub(options: {
  events?: string[];
  executionId?: string;
  onAuthorize?: (input: AuthorizeExecutionInput) => void;
  onMaterialize?: (input: MaterializeExecutionInput) => void;
  stateFile?: string;
} = {}) {
  return {
    async authorize(input: AuthorizeExecutionInput) {
      options.events?.push(`authorize:${input.parent}->${input.target}:${input.workspace}:${input.workspaceMode}`);
      options.onAuthorize?.(input);
      return { ...input, authorizedAt: "2026-09-11T00:00:00.000Z" } as never;
    },
    async materialize(_authorization: never, input: MaterializeExecutionInput) {
      options.events?.push(`materialize:${input.mode ?? DEFAULT_MODE}`);
      options.onMaterialize?.(input);
      return preparedMain(input, options.executionId ?? "exec-main", options.stateFile);
    },
  };
}

interface ThreadsStub {
  readonly settled: string[];
  readonly projected: { executionId: string; runtime: string | null; checkpoint: boolean }[];
  createThread(input: { agentId: string; workspace: string; title: string | null }): Promise<never>;
  reserveRoot(threadId: string, executionId: string): Promise<never>;
  settleRoot(threadId: string, executionId: string, outcome: string): Promise<never>;
  projectContext(threadId: string, executionId: string, input: { checkpoint: unknown; runtime: string | null }): Promise<never>;
  collectHistory(threadId: string, source: { executionId: string; runtime: string | null }): Promise<never>;
}

/** Thread giả: đủ để thấy reserve đứng giữa authorize và `createRoot`, và settle rồi project đứng cuối. */
function threadsStub(events?: string[]): ThreadsStub {
  const stub: ThreadsStub = {
    settled: [],
    projected: [],
    async createThread(input) {
      events?.push(`thread:create:${input.agentId}:${input.workspace}${input.title === null ? "" : `:${input.title}`}`);
      return { id: "thread_test", agentId: input.agentId, workspace: input.workspace, title: input.title } as never;
    },
    async reserveRoot(threadId, executionId) {
      events?.push(`thread:reserve:${threadId}:${executionId}`);
      return {
        ref: { executionId, sequence: 1 },
        binding: { id: threadId, contextRevision: 0, contextDigest: "0".repeat(64) },
        handoff: { threadId, sequence: 1, title: null, snapshot: null },
      } as never;
    },
    async settleRoot(threadId, executionId, outcome) {
      events?.push(`thread:settle:${outcome}`);
      stub.settled.push(`${threadId}:${executionId}:${outcome}`);
      return {} as never;
    },
    async projectContext(_threadId, executionId, input) {
      events?.push(`thread:project:${executionId}`);
      stub.projected.push({ executionId, runtime: input.runtime, checkpoint: input.checkpoint !== null });
      return {} as never;
    },
    async collectHistory(_threadId, source) {
      events?.push(`thread:history:${source.executionId}`);
      return {} as never;
    },
  };
  return stub;
}

interface GraphStub {
  readonly outcomes: { status: string; error?: { code: string; message: string } }[];
  binding: ExecutionBinding | null;
  createRoot(input: { agentId: string; executionId?: string; thread: unknown }): Promise<never>;
  rootThread: unknown;
  startRoot<T>(binding: ExecutionBinding, register: (binding: ExecutionBinding) => Promise<T>): Promise<T>;
  finishExecution(binding: ExecutionBinding, outcome: { status: string }): Promise<never>;
  failExecution(binding: ExecutionBinding, error: unknown): Promise<never>;
}

/** Cây giả: đủ để đọc thứ tự, và để thấy lease có bọc đúng `spawn` hay không. */
function graphStub(events?: string[]): GraphStub {
  const stub: GraphStub = {
    outcomes: [],
    binding: null,
    rootThread: undefined,
    async createRoot(input) {
      events?.push(`root:create:${input.agentId}`);
      stub.rootThread = input.thread;
      const executionId = input.executionId ?? "exec-main";
      stub.binding = {
        graphId: executionId,
        executionId,
        capability: "cap-test",
        deadlineAt: "2026-09-11T02:00:00.000Z",
      };
      return { binding: stub.binding } as never;
    },
    async startRoot(binding, register) {
      events?.push("root:start");
      return register(binding);
    },
    async finishExecution(_binding, outcome) {
      events?.push(`root:finish:${outcome.status}`);
      stub.outcomes.push(outcome as GraphStub["outcomes"][number]);
      return {} as never;
    },
    async failExecution(_binding, error) {
      events?.push("root:fail");
      stub.outcomes.push({ status: "failed", error: { code: "ROOT_START_FAILED", message: String(error) } });
      return {} as never;
    },
  };
  return stub;
}

/**
 * `ExecutionService.materialize` giả. Loadout phải tự chốt từ nấc + settings đúng như bản
 * thật, vì `runMainSession` giờ phóng theo snapshot — không tra lại bảng nấc lần thứ hai.
 */
function preparedMain(input: MaterializeExecutionInput, executionId = "exec-main", stateFile?: string) {
  const mode = input.mode ?? DEFAULT_MODE;
  const definition = MAIN_DEFINITION as unknown as AgentDefinition<unknown>;
  return {
    capsule: { executionId },
    artifacts: { contextDirectory: "/tmp/exec/context", ...(stateFile === undefined ? {} : { stateFile }) },
    policy: {
      model: modelForMode(definition, mode, input.modeProfiles),
      reasoningEffort: reasoningEffortForMode(definition, mode, input.modeProfiles),
      runtime: runtimeForMode(definition, mode, input.modeProfiles),
    },
  } as never;
}

describe("runMainSession", () => {
  it("uses remembered selection, code-native main definition, adapter launch spec, and local lifecycle", async () => {
    const events: string[] = [];
    const graph = graphStub(events);
    const threads = threadsStub(events);
    let launchBinding: unknown;
    let materializedThread: unknown;
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
      executionService: executionStub({ events, onMaterialize: (input) => { materializedThread = input.thread; } }),
      graph,
      threads,
      adapters: new Map([["claude", {
        name: "claude",
        compact: { preCompact: true, postCompact: true, sessionStartAfterCompact: true },
        async probe() { events.push("probe:claude"); return { ok: true, runtime: "claude", message: "ok" }; },
        async prepare(input) {
          events.push(`adapter:${input.model}:${input.reasoningEffort}`);
          launchBinding = input.binding;
          return launchSpec;
        },
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
    // `workspace-write` là thứ project đã đăng ký cho phép, nhưng `main` không khai write
    // root nào — nên nó bị hạ xuống `read-only` ở đây, chứ không bị `ExecutionService` từ
    // chối sau khi principal đã ngồi vào phiên.
    expect(events).toEqual([
      "registry:main",
      "select:remembered",
      // Thread trước mọi thứ, không lease: chỉ là bản ghi "có một việc bắt đầu ở đây".
      "thread:create:main:/project",
      "authorize:principal->main:/project:read-only",
      // Authorize trước reserve: execution bị từ chối không được chiếm slot Thread. Reserve
      // trước `createRoot`: graph mà Thread không biết là một lỗ trong lịch sử continuation.
      "thread:reserve:thread_test:exec-main",
      // Cây trước file: node `preparing` ra đời giữa hai bước, nên không byte nào của
      // execution này chạm đĩa trước khi có chỗ cho nó trong cây.
      "root:create:main",
      "materialize:medium",
      "probe:claude",
      "adapter:claude-opus-5:high",
      // Và `spawn` nằm trong lease của root, không ở ngoài.
      "root:start",
      "spawn:/project",
      "wait",
      "root:finish:completed",
      // Graph terminal trước, Thread chép lại sau — hai lease không bao giờ lồng nhau.
      "thread:settle:completed",
      // Mirror transcript (P4) đứng giữa: boundary phải có trước bản chiếu context của nó.
      "thread:history:exec-main",
      // Rồi chiếu checkpoint của E-1 thành context rev 1, dưới một Thread lease riêng nữa.
      "thread:project:exec-main",
    ]);
    // Chỗ đứng trong cây đi vào launch spec, chứ không được vá vào `env` sau đó.
    expect(launchBinding).toBe(graph.binding);
    // Binding Thread đi vào graph node và vào snapshot policy với cùng một giá trị.
    expect(graph.rootThread).toEqual({ id: "thread_test", contextRevision: 0, contextDigest: "0".repeat(64) });
    expect(materializedThread).toEqual(graph.rootThread);
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
      executionService: executionStub({ onMaterialize: (input) => { preparedMode = input.mode; } }),
      graph: graphStub(),
      threads: threadsStub(),
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

  /**
   * Settings của máy/project thắng loadout ship sẵn — và vì model quyết định CLI, ghi đè một
   * dòng model cũng đổi luôn tiến trình được phóng. Đây là chỗ chứng minh nó đi hết đường:
   * từ file cấu hình tới đúng adapter, không dừng ở một bảng trong bộ nhớ.
   */
  it("runs the loadout settings pinned, on the runtime that model implies", async () => {
    const events: string[] = [];
    const profiles = applyModeSettings(MODE_PROFILES, [{
      file: "/project/.alp/settings.local.json",
      settings: parseModeSettings({ modes: { ultra: { main: { model: "gpt-5.6-terra", reasoningEffort: "low" } } } }, "/project/.alp/settings.local.json"),
    }]);
    await runMainSession({ cwd: "/project", mode: "ultra" }, {
      registry: { get: () => MAIN_DEFINITION },
      selector: { async select() { return { ok: true, mode: "ultra", source: "explicit" }; } },
      executionService: executionStub(),
      graph: graphStub(),
      threads: threadsStub(),
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
      modeProfiles: profiles,
    });

    expect(events).toEqual(["adapter:gpt-5.6-terra:low"]);
  });

  /** `puck` là nấc duy nhất không có Claude ở bất kỳ vai nào — kể cả `main`. */
  it("keeps the puck session entirely on Codex", async () => {
    const events: string[] = [];
    await runMainSession({ cwd: "/project", mode: "puck" }, {
      registry: { get: () => MAIN_DEFINITION },
      selector: { async select() { return { ok: true, mode: "puck", source: "explicit" }; } },
      executionService: executionStub(),
      graph: graphStub(),
      threads: threadsStub(),
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
      executionService: executionStub({
        executionId: "exec",
        onAuthorize: (input) => { workspaceMode = input.workspaceMode; },
      }),
      graph: graphStub(),
      threads: threadsStub(),
      adapters: new Map([["claude", { name: "claude", compact: { preCompact: true, postCompact: true, sessionStartAfterCompact: true }, async probe() { return { ok: true, runtime: "claude", message: "ok" }; }, async prepare() { return { command: "fake", args: [], cwd: "/unknown", env: {}, temporaryFiles: [] }; } }]]),
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

  /**
   * Một root `preparing` vĩnh viễn là một cây không lệnh nào dọn được: nó vẫn tính vào trần
   * đồng thời và vẫn hiện ra trong `alp delegation tree`, mà không có process nào để giết.
   * Phiên chết ở đâu cũng phải để lại một node terminal — và lỗi gốc vẫn là thứ ném lên.
   */
  it("leaves the root terminal when the session dies before the backend", async () => {
    const events: string[] = [];
    const graph = graphStub(events);
    const threads = threadsStub(events);

    await expect(runMainSession({ cwd: "/project" }, {
      registry: { get: () => MAIN_DEFINITION },
      selector: { async select() { return { ok: true, mode: "medium", source: "default" }; } },
      executionService: executionStub({ events }),
      graph,
      threads,
      adapters: new Map([["claude", {
        name: "claude",
        compact: { preCompact: true, postCompact: true, sessionStartAfterCompact: true },
        async probe() { return { ok: false, runtime: "claude", message: "claude is not on PATH", remediation: "install it" }; },
        async prepare() { return { command: "fake", args: [], cwd: "/project", env: {}, temporaryFiles: [] }; },
      }]]),
      backend: {
        name: "local",
        async healthCheck() { return { ok: true, message: "ok" }; },
        async spawn() { throw new Error("never reached"); },
        async status(executionId) { return { executionId, status: "running" }; },
        async wait(executionId) { return { executionId, status: "completed" }; },
        async cancel(executionId) { return { executionId, status: "cancelled" }; },
        async cleanup() {},
      },
      executionId: () => "exec-main",
      interactive: false,
    })).rejects.toThrowError(/claude is not on PATH; install it/);

    expect(events).toContain("root:fail");
    expect(events).not.toContain("root:start");
    expect(graph.outcomes).toEqual([
      { status: "failed", error: { code: "ROOT_START_FAILED", message: expect.stringContaining("claude is not on PATH") } },
    ]);
    // Thread không được giữ một ref unsettled cho một root đã chết trước khi có process: cùng
    // catch ghi graph `failed` rồi settle Thread `failed`, theo đúng thứ tự của đường thành công.
    expect(events.indexOf("thread:settle:failed")).toBeGreaterThan(events.indexOf("root:fail"));
    expect(threads.settled).toEqual(["thread_test:exec-main:failed"]);
    // Chết trước khi có checkpoint thì projection chỉ mang outcome — không mang gì bịa ra.
    expect(threads.projected).toEqual([{ executionId: "exec-main", runtime: "claude", checkpoint: false }]);
  });

  /**
   * Exit code trả lời "process có chết sạch không", `state.json` trả lời "việc có xong
   * không". Cây ghi câu thứ hai — nếu nó ghi câu đầu thì một phiên viết xong kết quả rồi
   * thoát khác 0 sẽ nằm trong cây như một thất bại.
   */
  it("records the reconciled result as the root outcome, not the raw backend status", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-run-main-"));
    temporaryRoots.push(root);
    const stateFile = join(root, "state.json");
    await writeFile(stateFile, JSON.stringify({ status: "completed", output: "found it" }));
    const graph = graphStub();
    const threads = threadsStub();

    const result = await runMainSession({ cwd: "/project" }, {
      registry: { get: () => MAIN_DEFINITION },
      selector: { async select() { return { ok: true, mode: "medium", source: "default" }; } },
      executionService: executionStub({ stateFile }),
      graph,
      threads,
      adapters: new Map([["claude", {
        name: "claude",
        compact: { preCompact: true, postCompact: true, sessionStartAfterCompact: true },
        async probe() { return { ok: true, runtime: "claude", message: "ok" }; },
        async prepare() { return { command: "fake", args: [], cwd: "/project", env: {}, temporaryFiles: [] }; },
      }]]),
      backend: {
        name: "local",
        async healthCheck() { return { ok: true, message: "ok" }; },
        async spawn(input) { return { executionId: input.executionId, status: "running" }; },
        async status(executionId) { return { executionId, status: "running" }; },
        async wait(executionId) { return { executionId, status: "failed", exitCode: 130 }; },
        async cancel(executionId) { return { executionId, status: "cancelled" }; },
        async cleanup() {},
      },
      executionId: () => "exec-main",
      interactive: false,
    });

    expect(result).toMatchObject({ status: "completed", output: "found it" });
    expect(graph.outcomes).toEqual([{ status: "completed" }]);
    expect(threads.settled).toEqual(["thread_test:exec-main:completed"]);
  });
});

describe("alp delegate", () => {
  /**
   * Ai gọi không còn là một thứ command truyền đi.
   *
   * `ALP_ROLE` và `ALP_DELEGATED_ROLE` đặt ở đây đúng như một script cũ — hay một kẻ tấn
   * công — sẽ đặt, và cả hai phải rơi thẳng xuống đất: cha là ai được `DelegationService`
   * đọc từ cây sau khi capability thừa hưởng được kiểm, nên không có trường nào ở lớp này
   * cho lời khai ấy đi qua.
   */
  it("keeps the workspace and lets no caller declare its own identity", async () => {
    const calls: unknown[] = [];
    const result = await runDelegateCommand([
      "search", "--background", "--", "find", "launcher",
    ], {
      cwd: "/caller/project",
      env: { ALP_ROLE: "main", ALP_DELEGATED_ROLE: "principal", ALP_DELEGATION_EXECUTION_ID: "exec-parent" },
      service: {
        async delegate(input) { calls.push(input); return { executionId: "exec-child", requestId: "req", status: "running", metadata: { backend: "local", runtime: "codex" } }; },
        async wait() { throw new Error("background must not wait"); },
        async status() { throw new Error("unused"); },
        async cancel() { throw new Error("unused"); },
        async cleanup() { throw new Error("unused"); },
        listExecutions() { return []; },
        async tree() { throw new Error("unused"); },
      },
    });

    expect(result).toMatchObject({ status: "running" });
    expect(calls[0]).toMatchObject({
      targetRole: "search",
      task: "find launcher",
      workspace: "/caller/project",
      executionOptions: { background: true },
    });
    expect(calls[0]).not.toHaveProperty("parentRole");
    expect(calls[0]).not.toHaveProperty("parentExecutionId");
    expect(calls[0]).not.toHaveProperty("executionOptions.runtime");
  });

  /**
   * Quyền ghi workspace đi theo **vai đích**, không theo ai gọi.
   *
   * Luật cũ là "principal giao cho `main` thì được ghi". Từ 2026-09-10 `main` không khai
   * write root nào, nên luật đó vừa cấp một quyền `main` không cầm nổi, vừa bỏ đói `worker`
   * — ghế duy nhất còn cầm bút, và nó luôn được `main` gọi chứ không phải principal.
   */
  it.each([
    ["worker", "workspace-write"],
    ["search", "read-only"],
    ["main", "read-only"],
  ])("asks for the workspace mode %s can actually hold", async (targetRole, expected) => {
    const calls: { workspaceMode?: string }[] = [];
    await runDelegateCommand([targetRole, "--", "do", "the", "thing"], {
      cwd: "/caller/project",
      env: { ALP_ROLE: "main" },
      service: {
        async delegate(input) { calls.push(input); return { executionId: "exec-child", requestId: "req", status: "completed", metadata: { backend: "local", runtime: "codex" } }; },
        async wait() { throw new Error("unused"); },
        async status() { throw new Error("unused"); },
        async cancel() { throw new Error("unused"); },
        async cleanup() { throw new Error("unused"); },
        listExecutions() { return []; },
        async tree() { throw new Error("unused"); },
      },
    });

    expect(calls[0]?.workspaceMode).toBe(expected);
  });

  /** Tên không có trong registry vẫn đi tiếp: "vai này không tồn tại" là câu của
   * `ExecutionService`, nói bằng đúng mã lỗi, chứ không phải một exception bật ra ở chỗ đang
   * tính quyền workspace. */
  it("falls back to read-only for a role the registry does not know", async () => {
    const calls: { workspaceMode?: string }[] = [];
    await runDelegateCommand(["migrator", "--", "migrate"], {
      cwd: "/caller/project",
      env: {},
      service: {
        async delegate(input) { calls.push(input); return { executionId: "exec-child", requestId: "req", status: "completed", metadata: { backend: "local", runtime: "codex" } }; },
        async wait() { throw new Error("unused"); },
        async status() { throw new Error("unused"); },
        async cancel() { throw new Error("unused"); },
        async cleanup() { throw new Error("unused"); },
        listExecutions() { return []; },
        async tree() { throw new Error("unused"); },
      },
    });

    expect(calls[0]?.workspaceMode).toBe("read-only");
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
        async tree() { throw new Error("unused"); },
      },
    })).rejects.toThrow(/--runtime` không còn tồn tại/);
  });

  /**
   * Phiên root và execution được uỷ chạy trên **một** bảng process. Hai thư mục state là hai
   * `local.json`, và khi đó `alp delegation cancel` ở process sau tra một execution mà process
   * trước đã mở sẽ không thấy gì — pid vẫn sống, cây vẫn nói đang chạy, không ai giết được.
   */
  it("resolves one backend state directory for the main session and `alp delegate`", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-composition-"));
    temporaryRoots.push(root);
    const stateDir = join(root, "delegation-state");
    const layout = {
      channel: "binary" as const,
      version: "0.0.0",
      installRoot: join(root, "install"),
      assetRoot: join(root, "install"),
      selfExecutable: join(root, "install", "bin", "alp"),
      stableCommand: join(root, "install", "bin", "alp"),
    };
    const env = { ALP_DELEGATION_STATE_DIR: stateDir, ALP_MEMORY_ROOT: join(root, "memory") };

    const composition = await createDefaultDelegationComposition(layout, env);

    expect(composition.config.stateDir).toBe(stateDir);
    expect(sharedBackendStateDirectory(layout, env)).toBe(composition.config.stateDir);
  });
});

function treeNode(overrides: Partial<ExecutionTreeNode> = {}): ExecutionTreeNode {
  return {
    executionId: "exec_root",
    parentExecutionId: null,
    agentId: "main",
    depth: 0,
    status: "running",
    requestId: null,
    createdAt: "2026-09-11T00:00:00.000Z",
    startedAt: "2026-09-11T00:00:00.000Z",
    endedAt: null,
    cancellation: null,
    error: null,
    terminationReason: null,
    children: [],
    ...overrides,
  };
}

function treeView(root: ExecutionTreeNode, overrides: Partial<ExecutionTreeView> = {}): ExecutionTreeView {
  return {
    graphId: "exec_root",
    rootExecutionId: "exec_root",
    executionId: root.executionId,
    revision: 7,
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:20:00.000Z",
    deadlineAt: "2026-09-11T02:00:00.000Z",
    limits: DEFAULT_EXECUTION_GRAPH_LIMITS,
    delegation: { used: 2, limit: DEFAULT_EXECUTION_GRAPH_LIMITS.delegationLimit, remaining: 6 },
    summary: { total: 3, active: 2, byStatus: { running: 2, completed: 1 }, pending: 1 },
    thread: null,
    root,
    ...overrides,
  };
}

/** Cây ba nấc, đủ để một dòng có cả anh em lẫn con. */
function sampleView(highlighted = "exec_root"): ExecutionTreeView {
  const grandchild = treeNode({
    executionId: "exec_grandchild", parentExecutionId: "exec_worker", agentId: "search",
    depth: 2, status: "cancelled", requestId: "req_deep", endedAt: "2026-09-11T00:15:00.000Z",
    cancellation: { reason: "PARENT_CANCELLED", requestedBy: "exec_worker", requestedAt: "2026-09-11T00:15:00.000Z" },
  });
  const worker = treeNode({
    executionId: "exec_worker", parentExecutionId: "exec_root", agentId: "worker",
    depth: 1, status: "cancelled", requestId: "req_b", endedAt: "2026-09-11T00:15:00.000Z",
    cancellation: { reason: "USER_REQUEST", requestedBy: "principal", requestedAt: "2026-09-11T00:15:00.000Z" },
    children: [grandchild],
  });
  const search = treeNode({
    executionId: "exec_search", parentExecutionId: "exec_root", agentId: "search",
    depth: 1, status: "failed", requestId: "req_a",
    error: { code: "CHILD_START_FAILED", message: "runtime refused the task" },
  });
  const root = treeNode({ children: [search, worker] });
  return treeView(root, { executionId: highlighted });
}

function lifecycleService(view: ExecutionTreeView) {
  const asked: string[] = [];
  return {
    asked,
    service: {
      async delegate() { throw new Error("unused"); },
      async wait() { throw new Error("unused"); },
      async status() { throw new Error("unused"); },
      async cancel() { throw new Error("unused"); },
      async cleanup() { throw new Error("unused"); },
      listExecutions() { return []; },
      async tree(executionId: string) { asked.push(executionId); return view; },
    },
  };
}

describe("alp delegation tree", () => {
  /**
   * Lệnh này tồn tại vì JSON thô không trả lời được câu hỏi người vận hành mang tới: nhánh
   * nào chết, vì ai. Nên mặc định là chữ cho người đọc, và `--json` mới là dữ liệu cho script.
   */
  it("renders for a person by default and hands back the raw view for --json", async () => {
    const view = sampleView();
    const { asked, service } = lifecycleService(view);

    const rendered = await runDelegationLifecycleCommand(["tree", "exec_worker"], service as never);
    const json = await runDelegationLifecycleCommand(["tree", "exec_worker", "--json"], service as never);

    expect(isRenderedOutput(rendered)).toBe(true);
    expect(json).toBe(view);
    expect(isRenderedOutput(json)).toBe(false);
    expect(asked).toEqual(["exec_worker", "exec_worker"]);
  });

  /** Mọi lệnh còn lại vẫn là dữ liệu: `isRenderedOutput` không được nuốt kết quả của chúng. */
  it("leaves every other lifecycle command on the JSON path", async () => {
    const service = {
      async delegate() { throw new Error("unused"); },
      async wait() { throw new Error("unused"); },
      async status() { return { executionId: "exec_1", status: "running", rendered: "not this field" }; },
      async cancel() { throw new Error("unused"); },
      async cleanup() { throw new Error("unused"); },
      listExecutions() { return []; },
      async tree() { throw new Error("unused"); },
    };

    const status = await runDelegationLifecycleCommand(["status", "exec_1"], service as never);

    // `rendered` là string, nhưng một status không phải output đã định dạng — guard phải
    // nhìn hình dạng, không nhìn một cái tên trường mà backend nào cũng có thể trùng.
    expect(isRenderedOutput(status)).toBe(false);
  });

  it("requires the execution ID it is asked about", async () => {
    const { service } = lifecycleService(sampleView());

    await expect(runDelegationLifecycleCommand(["tree"], service as never)).rejects.toThrow(/execution ID/);
  });

  it("draws the shape of the tree, not a flat list", async () => {
    const text = renderExecutionTree(sampleView());
    const lines = text.split("\n");

    expect(lines).toEqual(expect.arrayContaining([
      expect.stringContaining("main  ·  exec_root  ·  running"),
      expect.stringMatching(/^├─ search {2}· {2}exec_search {2}· {2}failed/),
      expect.stringMatching(/^└─ worker/),
      // Cháu nối tiếp dưới thân của cha, không thụt lề bằng khoảng trắng trần.
      expect.stringMatching(/^ {3}└─ search {2}· {2}exec_grandchild/),
    ]));
  });

  /** Người vận hành hỏi về một node; cây in ra cả họ hàng, nên node được hỏi phải tự chỉ ra. */
  it("marks the node that was asked about", () => {
    const marked = renderExecutionTree(sampleView("exec_grandchild"))
      .split("\n").filter((line) => line.endsWith("←"));

    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain("exec_grandchild");
  });

  it("says why each stopped branch stopped", () => {
    const text = renderExecutionTree(sampleView());

    expect(text).toContain("USER_REQUEST · requested by principal");
    expect(text).toContain("PARENT_CANCELLED · requested by exec_worker");
    expect(text).toContain("CHILD_START_FAILED: runtime refused the task");
  });

  /** Một nhánh bị đồng hồ giết đọc y hệt một nhánh người dùng huỷ, nếu không nói ra. */
  it("separates a clock kill from a person's decision", () => {
    const root = treeNode({
      status: "cancelled",
      terminationReason: "deadline",
      cancellation: { reason: "WALL_CLOCK_EXCEEDED", requestedBy: "exec_root", requestedAt: "2026-09-11T02:00:00.000Z" },
    });

    expect(renderExecutionTree(treeView(root))).toContain("WALL_CLOCK_EXCEEDED (deadline)");
  });

  /**
   * Câu hỏi thường là "vì sao nó không đẻ thêm con nữa", và câu trả lời là một con số ở đầu
   * trang — nhưng chỉ khi trần nằm ngay cạnh mức đã dùng để so.
   */
  it("puts the allowance next to the ceiling that would stop it", () => {
    const text = renderExecutionTree(sampleView());

    expect(text).toContain("delegation 2/8 used  ·  6 remaining");
    expect(text).toContain("nodes 3  ·  2 active  ·  1 slot(s) held");
    expect(text).toContain(`depth ≤ ${DEFAULT_EXECUTION_GRAPH_LIMITS.maxDepth}`);
    expect(text).toContain("deadline 2026-09-11T02:00:00.000Z");
    expect(text).toContain("revision 7");
  });

  /**
   * Cutover P5: cây cũ không có Thread phải đọc được và nói rõ là cũ, thay vì in ra một binding
   * rỗng trông như lỗi; cây mới nêu Thread và revision context nó mở trên.
   */
  it("labels a legacy graph as unthreaded and a threaded graph by its thread", () => {
    expect(renderExecutionTree(sampleView())).toContain("thread legacy-unthreaded");

    const threaded = treeView(treeNode(), {
      thread: { id: "thread_x", contextRevision: 1, contextDigest: "a".repeat(64) },
    });
    const text = renderExecutionTree(threaded);
    expect(text).toContain("thread thread_x  ·  context rev 1");
    expect(text).not.toContain("legacy-unthreaded");
    expect(text).not.toContain("a".repeat(64));
  });

  /** Output của một lệnh đọc không được mang theo capability của execution nào. */
  it("prints no secret material", () => {
    const text = renderExecutionTree(sampleView());

    expect(text).not.toMatch(/capability/i);
    expect(text).not.toMatch(/fingerprint/i);
  });
});
