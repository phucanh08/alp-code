import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MODE_PROFILES, modelForMode, reasoningEffortForMode, runtimeForMode, type ModeProfiles } from "../../src/agents/modes";
import { applyModeSettings, parseModeSettings } from "../../src/agents/mode-settings";
import { agentRegistry } from "../../src/agents/registry";
import { DelegationService, FileDelegationExecutionStore, InMemoryDelegationExecutionStore } from "../../src/delegation/delegation-service";
import { DelegationError } from "../../src/delegation/types";
import type { ExecutionBackend } from "../../src/backend/execution-backend";
import type { ExecutionService } from "../../src/execution/execution-service";
import { executionArtifactPaths } from "../../src/execution/execution-store";
import {
  childBinding,
  ExecutionGraphService,
  type ReservedChild,
} from "../../src/execution/graph/execution-graph-service";
import { FileExecutionGraphStore } from "../../src/execution/graph/file-execution-graph-store";
import type {
  ExecutionAuthorization,
  MaterializeExecutionInput,
  PreparedExecution,
  PrepareExecutionInput,
} from "../../src/execution/types";
import type { RuntimeAdapter, RuntimeLaunchSpec } from "../../src/runtime/runtime-adapter";
import { removeTemporary } from "../support/temporary-root";

/**
 * Bản giả của `ExecutionService.prepare`. Loadout phải **tự suy ra** từ nấc + profiles đúng
 * như `createExecutionPolicy` thật làm: `DelegationService` giờ đọc model/effort/runtime từ
 * snapshot, nên một fake ghim cứng ba giá trị này sẽ biến mọi test loadout thành vô nghĩa.
 */
function prepared(executionId: string, target = "search", profiles: ModeProfiles = MODE_PROFILES): PreparedExecution {
  const workspace = process.cwd();
  const definition = agentRegistry.get(target);
  return {
    capsule: {
      executionId,
      definitionHash: "definition",
      policyHash: "policy",
      role: target,
      displayName: target,
      instructions: "prepared identity",
      task: "probe",
      activeWorkspace: workspace,
      memoryContext: {
        invariantContext: "invariants",
        policyContext: "policy",
        entries: [],
        diagnostics: { characterBudget: 0, charactersUsed: 0, truncated: false, omittedEntryIds: [] },
      },
      workflowState: { workflowId: "flow", currentState: "work", status: "running", repairAttempts: 0 },
      allowedTools: ["Read"],
      outputContract: { name: "result", schema: { type: "object" } },
    },
    policy: {
      executionId,
      role: target,
      workspace,
      workspaceMode: "read-only",
      mode: "medium",
      model: modelForMode(definition, "medium", profiles),
      reasoningEffort: reasoningEffortForMode(definition, "medium", profiles),
      runtime: runtimeForMode(definition, "medium", profiles),
      workspaceAccess: "granted",
      allowedTools: ["Read"],
      skills: [],
      skillRoots: [],
      subagents: [],
      mcpServers: [],
      autoCompactTokens: { claude: null, codex: null },
      memory: { read: [], write: [] },
      delegatesTo: [],
      createdAt: "2026-08-26T00:00:00.000Z",
      definitionHash: "definition",
      policyHash: "policy",
    },
    state: {
      executionId,
      status: "prepared",
      workflow: { workflowId: "flow", currentState: "work", status: "running", repairAttempts: 0 },
      policyHash: "policy",
      createdAt: "2026-08-26T00:00:00.000Z",
    },
    artifacts: {
      directory: "/tmp/execution",
      stateFile: "/tmp/execution/state.json",
      policyFile: "/tmp/execution/policy.json",
      runtimeDirectory: "/tmp/execution/runtime",
      contextDirectory: "/tmp/execution/context",
      checkpointFile: "/tmp/execution/context/checkpoint.json",
      continuityFile: "/tmp/execution/context/continuity.md",
      compactEventsFile: "/tmp/execution/context/compact-events.jsonl",
    },
  };
}

class FakeRuntime implements RuntimeAdapter {
  readonly name = "codex" as const;
  readonly compact = { preCompact: true, postCompact: true, sessionStartAfterCompact: true };
  calls: unknown[] = [];
  async probe() { return { ok: true, runtime: this.name, message: "ok" } as const; }
  async prepare(input: Parameters<RuntimeAdapter["prepare"]>[0]): Promise<RuntimeLaunchSpec> {
    this.calls.push(input);
    return {
      command: "fake-codex",
      args: [input.execution.capsule.task],
      cwd: input.execution.capsule.activeWorkspace,
      env: { ALP_DELEGATION_EXECUTION_ID: input.execution.capsule.executionId },
      temporaryFiles: [],
    };
  }
}

class FakeBackend implements ExecutionBackend {
  readonly calls: string[] = [];
  readonly spawnInputs: unknown[] = [];
  constructor(readonly name: string, private readonly healthy = true, private readonly spawnError?: Error) {}
  async healthCheck() { this.calls.push("health"); return { ok: this.healthy, message: this.healthy ? "ok" : "offline" }; }
  async spawn(input: Parameters<ExecutionBackend["spawn"]>[0]) {
    this.calls.push("spawn");
    this.spawnInputs.push(input);
    if (this.spawnError) throw this.spawnError;
    return { executionId: input.executionId, status: "running" as const };
  }
  statusError: { code: string; message: string } | null = null;
  /** Cái backend nói khi được hỏi lại — reconciliation đọc đúng chỗ này. */
  reports: "queued" | "running" | "completed" | "failed" | "cancelled" = "running";
  async status(executionId: string) {
    this.calls.push("status");
    return this.statusError
      ? { executionId, status: "failed" as const, error: this.statusError }
      : { executionId, status: this.reports };
  }
  async wait(executionId: string) { this.calls.push("wait"); return { executionId, status: "completed" as const, output: `${this.name} output` }; }
  readonly cancelled: string[] = [];
  async cancel(executionId: string) {
    this.calls.push("cancel");
    this.cancelled.push(executionId);
    return { executionId, status: "cancelled" as const };
  }
  cleanupError: Error | null = null;
  async cleanup(_executionId: string) {
    this.calls.push("cleanup");
    if (this.cleanupError) throw this.cleanupError;
  }
}

/**
 * A real tree on a throwaway directory, with `main` already standing in it.
 *
 * Not a stub: the reservation ordering, the capability derivation and the concurrency
 * ceilings are the behaviour under test, and a fake graph would assert only that the service
 * calls methods in some order — never that the order is the safe one.
 */
async function graphFixture(root: string) {
  const graph = new ExecutionGraphService({
    store: new FileExecutionGraphStore({ root: join(root, "execution-graphs") }),
  });
  const parent = await graph.createRoot({ agentId: "main", executionId: "exec_parent" });
  return { graph, parent };
}

/**
 * Writes the snapshot a real `materialize()` would leave behind.
 *
 * Lifecycle commands in a later process have no `PreparedExecution` in hand — they rebuild
 * one from the tree plus `policy.json` on disk. A fixture that skips the write would let the
 * service claim a runtime it never recorded.
 */
async function persist(root: string, execution: PreparedExecution): Promise<PreparedExecution> {
  const artifacts = executionArtifactPaths(join(root, "executions"), execution.policy.executionId);
  await mkdir(artifacts.contextDirectory, { recursive: true });
  await writeFile(artifacts.policyFile, JSON.stringify(execution.policy));
  await writeFile(artifacts.stateFile, JSON.stringify(execution.state));
  return { ...execution, artifacts };
}

/**
 * `authorize` + `materialize` standing in for `ExecutionService`, with the same split the
 * real one has: the ticket carries the execution ID, and nothing touches disk until it is
 * spent. `authorizeError` fails the first half, which is where a policy denial lands.
 */
function fakeExecutionService(options: {
  root: string;
  materialize?: (input: PrepareExecutionInput) => Promise<PreparedExecution>;
  authorizeError?: Error;
}) {
  const tickets = new Map<object, PrepareExecutionInput>();
  return {
    async authorize(input: Parameters<ExecutionService["authorize"]>[0]) {
      if (options.authorizeError) throw options.authorizeError;
      const ticket = { executionId: input.executionId } as ExecutionAuthorization;
      tickets.set(ticket, { ...input, task: "", memoryQueries: [], characterBudget: 0, invariantContext: "", policyContext: "" } as PrepareExecutionInput);
      return ticket;
    },
    async materialize(authorization: ExecutionAuthorization, input: MaterializeExecutionInput) {
      const authorized = tickets.get(authorization);
      if (!authorized) throw new Error("execution authorization was not issued by this service");
      const request = { ...authorized, ...input } as PrepareExecutionInput;
      const execution = options.materialize
        ? await options.materialize(request)
        : prepared(request.executionId, request.target, request.modeProfiles);
      return persist(options.root, execution);
    },
  };
}

async function serviceFixture(options: {
  root: string;
  materialize?: (input: PrepareExecutionInput) => Promise<PreparedExecution>;
  authorizeError?: Error;
  primary?: FakeBackend;
  modeProfiles?: ModeProfiles;
}) {
  const runtime = new FakeRuntime();
  const primary = options.primary ?? new FakeBackend("primary");
  const store = new InMemoryDelegationExecutionStore();
  const { graph, parent } = await graphFixture(options.root);
  let sequence = 0;
  const service = new DelegationService({
    registry: agentRegistry,
    policy: { authorize: () => ({ allowed: true as const }) },
    memory: { buildContext: async () => { throw new Error("owned by ExecutionService"); } },
    executionService: fakeExecutionService(options),
    graph,
    binding: parent.binding,
    executionsRoot: join(options.root, "executions"),
    runtimeAdapters: new Map([["codex", runtime]]),
    backend: primary,
    executionStore: store,
    config: { mode: "medium", ...(options.modeProfiles ? { modeProfiles: options.modeProfiles } : {}) },
    ids: {
      request: () => `req_${++sequence}`,
      execution: () => `exec_${sequence}`,
    },
  });
  return { service, store, runtime, primary, graph, parent };
}

const input = {
  requestId: "request-explicit",
  targetRole: "search",
  task: "find launcher",
  workspace: process.cwd(),
  executionOptions: { background: true },
};

describe("DelegationService", () => {
  let root = "";
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "alp-delegation-")); });
  afterEach(async () => { await removeTemporary(root); });

  /**
   * Nấc kế thừa từ phiên cha; loadout của nấc thì đọc từ settings của máy/project. Vai được
   * giao phải chạy đúng model đã cấu hình, không phải model ALP ship sẵn cho nấc đó — nếu
   * không thì cấu hình chỉ có tác dụng ở ghế ngoài cùng.
   */
  it("launches a delegated role on the model settings pinned for the mode", async () => {
    const file = "/project/.alp/settings.json";
    const fixture = await serviceFixture({
      root,
      modeProfiles: applyModeSettings(MODE_PROFILES, [{
        file,
        settings: parseModeSettings({ modes: { medium: { search: { model: "gpt-5.6-luna", reasoningEffort: "medium" } } } }, file),
      }]),
    });

    await fixture.service.delegate(input);

    expect(modelForMode(agentRegistry.get("search"), "medium")).toBe("gpt-5.6-terra");
    expect(fixture.runtime.calls[0]).toMatchObject({ model: "gpt-5.6-luna", reasoningEffort: "medium" });
  });

  /**
   * A denial must cost the tree nothing. Authorization runs before the reservation, so a
   * refused request never holds a concurrency slot — not even for the instant it takes to be
   * refused, which is the instant a caller looping on denials would spend it all in.
   */
  it("denies before the tree reserves, before runtime preparation, and before spawn", async () => {
    const denied = new Error("delegation authorization failed: denied");
    const fixture = await serviceFixture({ root, authorizeError: denied });

    await expect(fixture.service.delegate(input)).rejects.toBe(denied);
    expect(fixture.runtime.calls).toHaveLength(0);
    expect(fixture.primary.calls).toEqual([]);
    expect(fixture.store.list()).toEqual([]);
    const graph = await fixture.graph.getGraph(fixture.parent.binding.graphId);
    expect(graph).toMatchObject({ delegationUsed: 0, reservations: [] });
    expect(graph!.nodes).toHaveLength(1);
  });

  /**
   * Cây là thẩm quyền logic: con sống trong graph, không trong legacy store, và mọi lệnh
   * lifecycle sau đó tra cây trước rồi mới hỏi backend.
   */
  it("preserves IDs, commits the child to the tree, and routes lifecycle to the spawned backend", async () => {
    const fixture = await serviceFixture({ root });
    const spawned = await fixture.service.delegate(input);

    expect(spawned).toMatchObject({
      executionId: "exec_0",
      requestId: "request-explicit",
      status: "running",
      metadata: { backend: "primary", runtime: "codex" },
    });
    expect(fixture.runtime.calls[0]).toMatchObject({
      model: modelForMode(agentRegistry.get("search"), "medium"),
      reasoningEffort: reasoningEffortForMode(agentRegistry.get("search"), "medium"),
    });
    // Con là một node dưới cha, kèm đúng request đã sinh ra nó — và legacy store trống trơn.
    const graph = await fixture.graph.getGraph(fixture.parent.binding.graphId);
    expect(graph).toMatchObject({ delegationUsed: 1, reservations: [] });
    expect(graph!.nodes[1]).toMatchObject({
      executionId: "exec_0",
      parentExecutionId: "exec_parent",
      agentId: "search",
      depth: 1,
      status: "running",
      requestId: "request-explicit",
    });
    expect(fixture.store.list()).toEqual([]);
    // Con nhận chỗ đứng của nó qua env, và chính cây là nơi giữ hash của capability đó.
    expect(fixture.runtime.calls[0]).toMatchObject({
      binding: { graphId: "exec_parent", executionId: "exec_0", deadlineAt: graph!.deadlineAt },
    });
    expect(fixture.primary.spawnInputs[0]).toMatchObject({
      lifecycle: {
        requestId: "request-explicit",
        parentExecutionId: "exec_parent",
        background: true,
        interactive: false,
        timeoutMs: null,
      },
    });

    await expect(fixture.service.status("exec_0")).resolves.toMatchObject({ metadata: { backend: "primary" } });
    await expect(fixture.service.wait("exec_0")).resolves.toMatchObject({ status: "completed", output: "primary output" });
    await fixture.service.cancel("exec_0");
    await fixture.service.cleanup("exec_0");
    // `status` cũng là câu reconciliation hỏi backend trước mỗi lệnh, nên nó bị lọc ra: điều
    // đang được khẳng định là lệnh lifecycle đi tới đúng backend đã spawn.
    expect(fixture.primary.calls.filter((call) => call !== "status"))
      .toEqual(["health", "spawn", "wait", "cancel", "cleanup"]);
  });

  /**
   * Cùng một `requestId` gọi hai lần là một lần gọi bị lặp, không phải hai việc. Đẻ con thứ
   * hai ở đây là hai process cùng sửa một workspace vì một lần mất kết nối.
   */
  it("returns the existing child when the same request is delegated twice", async () => {
    const fixture = await serviceFixture({ root });
    const first = await fixture.service.delegate(input);
    const second = await fixture.service.delegate(input);

    expect(second.executionId).toBe(first.executionId);
    expect(fixture.primary.spawnInputs).toHaveLength(1);
    const graph = await fixture.graph.getGraph(fixture.parent.binding.graphId);
    expect(graph).toMatchObject({ delegationUsed: 1 });
    expect(graph!.nodes).toHaveLength(2);
  });

  /** Cùng ID, khác việc, là hai việc trùng tên — và một trong hai phải bị từ chối. */
  it("rejects a reused request ID that describes different work", async () => {
    const fixture = await serviceFixture({ root });
    await fixture.service.delegate(input);

    await expect(fixture.service.delegate({ ...input, task: "find something else" }))
      .rejects.toMatchObject({ code: "REQUEST_ID_CONFLICT" });
  });

  /**
   * Không có cha thì không có quyền. Một `alp delegate` gõ từ terminal trần không thừa hưởng
   * binding nào, và suy ra cha từ `ALP_ROLE` là để bất kỳ ai cũng tự phong cho mình một cha.
   */
  it("refuses to delegate without an authenticated parent execution", async () => {
    const fixture = await serviceFixture({ root });
    const unbound = new DelegationService({
      registry: agentRegistry,
      policy: { authorize: () => ({ allowed: true as const }) },
      memory: { buildContext: async () => { throw new Error("owned by ExecutionService"); } },
      executionService: fakeExecutionService({ root }),
      graph: fixture.graph,
      binding: null,
      executionsRoot: join(root, "executions"),
      runtimeAdapters: new Map([["codex", fixture.runtime]]),
      backend: fixture.primary,
      executionStore: new InMemoryDelegationExecutionStore(),
      config: { mode: "medium" },
    });

    await expect(unbound.delegate(input)).rejects.toMatchObject({ code: "PARENT_EXECUTION_REQUIRED" });
    expect(fixture.primary.calls).toEqual([]);
  });

  /**
   * A `failed` execution that will not say why is barely more useful than a hung one. The
   * reason was produced by the backend and dropped here, because the result type had no
   * field for it — including the message that names the grant to fix.
   */
  it("carries the backend's failure reason through to the caller", async () => {
    const fixture = await serviceFixture({ root });
    await fixture.service.delegate(input);
    fixture.primary.statusError = { code: "ExecutionFailed", message: "dừng ở permission prompt" };

    await expect(fixture.service.status("exec_0")).resolves.toMatchObject({
      status: "failed",
      error: { code: "ExecutionFailed", message: "dừng ở permission prompt" },
    });
  });

  it("routes validated structured output from execution state when backend capture is empty", async () => {
    const fixture = await serviceFixture({ root });
    const spawned = await fixture.service.delegate(input);
    // Đúng file mà một execution do cây quản ghi kết cục của nó vào — đường dẫn suy ra từ
    // executions root và ID, vì process đọc lại nó không cầm `PreparedExecution` nào.
    await writeFile(
      executionArtifactPaths(join(root, "executions"), spawned.executionId).stateFile,
      JSON.stringify({ status: "completed", output: { status: "clear", findings: [] } }),
    );

    await expect(fixture.service.wait(spawned.executionId)).resolves.toMatchObject({
      status: "completed",
      output: JSON.stringify({ status: "clear", findings: [] }),
    });
  });

  /**
   * A spawn that fails partway must stay failed. There is nothing to retry onto — the
   * fallback that used to exist was removed with Paseo — but the tree still has to say
   * `failed` rather than leave the node at `queued`, which reads as an execution still
   * coming. The allowance it spent is not refunded: a loop that fails on every attempt would
   * otherwise never reach its ceiling.
   */
  it("records a failed spawn in the tree without refunding the delegation allowance", async () => {
    const primary = new FakeBackend("primary", true, new Error("partial spawn failure"));
    const fixture = await serviceFixture({ root, primary });

    await expect(fixture.service.delegate(input)).rejects.toThrowError("partial spawn failure");
    expect(primary.calls).toEqual(["health", "spawn"]);
    const graph = await fixture.graph.getGraph(fixture.parent.binding.graphId);
    expect(graph).toMatchObject({ delegationUsed: 1, reservations: [] });
    expect(graph!.nodes[1]).toMatchObject({
      executionId: "exec_0",
      status: "failed",
      error: { code: "CHILD_START_FAILED", message: "partial spawn failure" },
    });
  });

  /**
   * Runtime không còn được truyền vào — nó là hệ quả của model mà nấc ghim cho vai. `review`
   * ở `medium` chạy `claude-opus-5`, nên fixture chỉ đăng ký Codex sẽ trượt ở đây, và phải
   * trượt bằng lỗi có tên chứ không phải phóng nhầm CLI. Chỗ đã giữ được trả lại ngay: hỏng
   * trước khi có process thì không lý do gì cây phải chật thêm hai phút nữa.
   */
  it("returns a typed error when the dialled model's runtime is not registered", async () => {
    const fixture = await serviceFixture({ root });
    await expect(fixture.service.delegate({
      ...input,
      targetRole: "review",
    })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" } satisfies Partial<DelegationError>);
    expect(fixture.primary.calls).toEqual([]);
    const graph = await fixture.graph.getGraph(fixture.parent.binding.graphId);
    expect(graph).toMatchObject({ delegationUsed: 0, reservations: [] });
    expect(graph!.nodes).toHaveLength(1);
  });

  /**
   * Huỷ là một lệnh lên một nhánh, không lên một node.
   *
   * Một chuyên gia đã giao việc tiếp sở hữu những process mà người bấm huỷ chưa từng nghe
   * tên — và tất cả đang ghi vào cùng một workspace. Dừng mỗi cái được gọi tên để lại đúng
   * đám đó chạy tiếp, không còn ai chờ kết quả của chúng.
   */
  it("stops the branch below a cancelled child, not just the child", async () => {
    const fixture = await serviceFixture({ root });
    await fixture.service.delegate(input);
    // Cháu được dựng thẳng trên cây: nó là con của `exec_0`, nên binding của nó suy ra được
    // từ binding của cha mà không cần một DelegationService thứ hai.
    const childBindingOfDelegate = childBinding(fixture.parent.binding, "exec_0");
    const reserved = await fixture.graph.reserveChild(childBindingOfDelegate, {
      requestId: "req_grandchild",
      agentId: "search",
      task: "read one more file",
      workspace: process.cwd(),
      workspaceMode: "read-only",
      mode: "medium",
      background: true,
      interactive: false,
      timeoutMs: null,
      metadata: {},
    }) as ReservedChild;
    await fixture.graph.startReservedChild(reserved, async () => undefined);

    const result = await fixture.service.cancel("exec_0");

    expect(result).toMatchObject({ executionId: "exec_0", status: "cancelled" });
    // Lá trước gốc: cha đang chết không được dọn dẹp chồng lên con vẫn đang ghi.
    expect(fixture.primary.cancelled).toEqual([reserved.binding.executionId, "exec_0"]);
    const graph = await fixture.graph.getGraph(fixture.parent.binding.graphId);
    expect(graph!.nodes.find((node) => node.executionId === "exec_0")).toMatchObject({
      status: "cancelled",
      cancellation: { reason: "USER_REQUEST", requestedBy: "exec_parent" },
    });
    expect(graph!.nodes.find((node) => node.executionId === reserved.binding.executionId)).toMatchObject({
      status: "cancelled",
      cancellation: { reason: "PARENT_CANCELLED", requestedBy: "exec_0" },
    });
  });

  /**
   * Execution mở bằng một bản `alp` cũ hơn không nằm trong cây nào. Nó vẫn phải dừng được ở
   * bản này — và nó không có nhánh nào bên dưới để mà dừng theo.
   */
  it("sends a legacy execution straight to its backend", async () => {
    const fixture = await serviceFixture({ root });
    fixture.store.put({
      executionId: "exec_legacy",
      requestId: "req_legacy",
      parentExecutionId: null,
      parentRole: "main",
      targetRole: "search",
      workspace: process.cwd(),
      runtime: "codex",
      backend: "primary",
      createdAt: "2026-09-01T00:00:00.000Z",
      status: "running",
    });

    expect(await fixture.service.cancel("exec_legacy")).toMatchObject({
      executionId: "exec_legacy",
      status: "cancelled",
    });
    expect(fixture.primary.cancelled).toEqual(["exec_legacy"]);
    expect(fixture.store.get("exec_legacy")).toMatchObject({ status: "cancelled" });
  });

  /**
   * Huỷ một việc đã xong không được viết lại kết cục của nó: kết quả agent đã trả là một
   * việc đã làm, và `cancelled` ở đây sẽ vứt nó đi vì một lệnh tới muộn vài giây.
   */
  it("does not rewrite the outcome of an execution that already finished", async () => {
    const fixture = await serviceFixture({ root });
    await fixture.service.delegate(input);
    await fixture.graph.finishExecution(childBinding(fixture.parent.binding, "exec_0"), { status: "completed" });

    const result = await fixture.service.cancel("exec_0");

    expect(result.status).toBe("completed");
    // Và không có tín hiệu nào được bắn vào một process đã kết thúc — record của nó có thể
    // đã bị dọn, và pid đó giờ có thể thuộc về ai khác.
    expect(fixture.primary.cancelled).toEqual([]);
    const graph = await fixture.graph.getGraph(fixture.parent.binding.graphId);
    expect(graph!.nodes.find((node) => node.executionId === "exec_0")).toMatchObject({
      status: "completed",
      cancellation: null,
    });
  });
});

describe("lifecycle routing", () => {
  let root = "";
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "alp-delegation-")); });
  afterEach(async () => { await removeTemporary(root); });

  /** Một record legacy: không node nào trong cây, chỉ một dòng trong store cũ. */
  function legacy(store: InMemoryDelegationExecutionStore, status: "running" | "completed" = "running"): void {
    store.put({
      executionId: "exec_legacy",
      requestId: "req_legacy",
      parentExecutionId: null,
      parentRole: "main",
      targetRole: "search",
      workspace: process.cwd(),
      runtime: "codex",
      backend: "primary",
      createdAt: "2026-09-01T00:00:00.000Z",
      status,
    });
  }

  /**
   * Cây trả lời trước, và khi nó có câu trả lời thì store cũ không được hỏi tới.
   *
   * Hai sổ sách cho cùng một execution là hai câu trả lời có thể lệch nhau; cái quyết định
   * là cái đã kiểm trần và giữ quan hệ cha con, tức là cây.
   */
  it("answers from the tree for an execution the tree owns", async () => {
    const fixture = await serviceFixture({ root });
    await fixture.service.delegate(input);

    const status = await fixture.service.status("exec_0");

    expect(status).toMatchObject({ executionId: "exec_0", status: "running" });
    // Con sống trong cây, nên nó không có dòng nào trong store cũ để mà đọc nhầm.
    expect(fixture.store.get("exec_0")).toBeNull();
  });

  it.each(["status", "wait", "cleanup"] as const)(
    "falls back to the legacy record for `%s` when no tree holds the execution",
    async (command) => {
      const fixture = await serviceFixture({ root });
      legacy(fixture.store, command === "cleanup" ? "completed" : "running");
      fixture.primary.reports = "completed";

      const result = await fixture.service[command]("exec_legacy");

      expect(result).toMatchObject({ executionId: "exec_legacy" });
    },
  );

  it("still refuses an execution that neither the tree nor the legacy store knows", async () => {
    const fixture = await serviceFixture({ root });

    await expect(fixture.service.status("exec_ghost")).rejects.toMatchObject({ code: "EXECUTION_NOT_FOUND" });
  });

  /**
   * Một graph không đọc được **không** phải là "không có graph".
   *
   * Đường legacy không có trần, không có quan hệ cha con và không có hạn; rơi vào đó vì một
   * file hỏng là biến một lỗi lưu trữ thành một execution không còn ai chặn. Lệnh phải dừng
   * và nói ra, kể cả khi store cũ có sẵn một câu trả lời nghe xuôi tai.
   */
  it("refuses to fall back to legacy when a graph on disk is unreadable", async () => {
    const fixture = await serviceFixture({ root });
    legacy(fixture.store);
    await mkdir(join(root, "execution-graphs"), { recursive: true });
    await writeFile(join(root, "execution-graphs", "exec_broken.json"), "{ not json");

    for (const command of ["status", "wait", "cancel", "cleanup"] as const) {
      await expect(fixture.service[command]("exec_legacy"))
        .rejects.toMatchObject({ code: "EXECUTION_GRAPH_CORRUPT" });
    }
    // Và không một tín hiệu nào được bắn đi trong lúc thẩm quyền còn chưa xác định.
    expect(fixture.primary.cancelled).toEqual([]);
    expect(fixture.primary.calls).not.toContain("cleanup");
  });

  /**
   * `cleanup` trả lại đĩa, không xoá sổ sách: node và kết cục của nó là thứ `alp delegation
   * tree` dựa vào để trả lời "nhánh này đã chạy chưa" sau khi mọi file tạm đã đi.
   */
  it("returns the backend's state but keeps the node and its outcome", async () => {
    const fixture = await serviceFixture({ root });
    await fixture.service.delegate(input);
    fixture.primary.reports = "completed";
    await fixture.service.status("exec_0");

    const result = await fixture.service.cleanup("exec_0");

    expect(result).toMatchObject({ executionId: "exec_0", status: "completed" });
    expect(fixture.primary.calls).toContain("cleanup");
    const view = await fixture.service.tree("exec_0");
    expect(view.root.children[0]).toMatchObject({ executionId: "exec_0", status: "completed" });
  });

  /**
   * Dọn một execution còn sống là xoá đúng sợi dây duy nhất còn giết được process của nó,
   * và lần reconcile sau sẽ đọc nó thành `interrupted` trong khi nó vẫn đang ghi vào workspace.
   */
  it("refuses to clean up an execution that is still alive", async () => {
    const fixture = await serviceFixture({ root });
    await fixture.service.delegate(input);

    await expect(fixture.service.cleanup("exec_0")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(fixture.primary.calls).not.toContain("cleanup");
  });

  /** Backend quên trước cây — máy khởi động lại. Không còn gì để trả lại thì lệnh đã xong. */
  it("treats a backend that has forgotten the execution as already cleaned", async () => {
    const fixture = await serviceFixture({ root });
    await fixture.service.delegate(input);
    fixture.primary.reports = "completed";
    await fixture.service.status("exec_0");
    fixture.primary.cleanupError = new DelegationError("EXECUTION_NOT_FOUND", "unknown local execution `exec_0`");

    await expect(fixture.service.cleanup("exec_0")).resolves.toMatchObject({ status: "completed" });
  });

  /** Nhưng một backend hỏng thì không: im lặng ở đây là để lại file tạm mà không ai biết. */
  it("propagates a cleanup failure that is not a forgotten execution", async () => {
    const fixture = await serviceFixture({ root });
    await fixture.service.delegate(input);
    fixture.primary.reports = "completed";
    await fixture.service.status("exec_0");
    fixture.primary.cleanupError = new Error("disk is read-only");

    await expect(fixture.service.cleanup("exec_0")).rejects.toThrow(/read-only/);
  });

  /** `tree` không có đường legacy nào để rơi vào: một record cũ không phải một cây. */
  it("tells a legacy execution apart instead of drawing a one-node tree", async () => {
    const fixture = await serviceFixture({ root });
    legacy(fixture.store);

    await expect(fixture.service.tree("exec_legacy")).rejects.toMatchObject({ code: "EXECUTION_NOT_FOUND" });
  });
});

describe("FileDelegationExecutionStore", () => {
  it("persists backend pinning across CLI processes", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-delegation-store-"));
    const file = join(root, "executions.json");
    try {
      const first = new FileDelegationExecutionStore({ file });
      first.put({
        executionId: "exec-persisted",
        requestId: "req-persisted",
        parentExecutionId: null,
        parentRole: "main",
        targetRole: "search",
        workspace: "/project",
        runtime: "codex",
        backend: "local",
        createdAt: "2026-08-26T00:00:00.000Z",
        status: "running",
      });
      const second = new FileDelegationExecutionStore({ file });
      expect(second.get("exec-persisted")).toMatchObject({ backend: "local", status: "running" });
      second.update("exec-persisted", { status: "completed" });
      expect(new FileDelegationExecutionStore({ file }).get("exec-persisted")).toMatchObject({ status: "completed" });
    } finally {
      await removeTemporary(root);
    }
  });
});
