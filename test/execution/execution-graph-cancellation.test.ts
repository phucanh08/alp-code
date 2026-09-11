import { describe, expect, it } from "vitest";
import { DEFAULT_EXECUTION_GRAPH_LIMITS } from "../../src/execution/graph/defaults";
import { isExecutionGraphError } from "../../src/execution/graph/errors";
import {
  ExecutionGraphService,
  PRINCIPAL_REQUESTER,
  type ChildRequest,
  type ExecutionBinding,
  type ReservedChild,
} from "../../src/execution/graph/execution-graph-service";
import { InMemoryExecutionGraphStore } from "../../src/execution/graph/in-memory-execution-graph-store";
import type { ExecutionGraphLimits, ExecutionNode } from "../../src/execution/graph/types";

const BASE_TIME = "2026-09-11T00:00:00.000Z";

interface Harness {
  readonly store: InMemoryExecutionGraphStore;
  readonly service: ExecutionGraphService;
  advance(ms: number): void;
}

function harness(limits?: Partial<ExecutionGraphLimits>): Harness {
  const store = new InMemoryExecutionGraphStore();
  let clock = Date.parse(BASE_TIME);
  let executions = 0;
  const service = new ExecutionGraphService({
    store,
    ...(limits ? { limits: { ...DEFAULT_EXECUTION_GRAPH_LIMITS, ...limits } } : {}),
    now: () => new Date(clock),
    newExecutionId: () => `exec_${++executions}`,
  });
  return { store, service, advance: (ms) => { clock += ms; } };
}

function request(overrides: Partial<ChildRequest> = {}): ChildRequest {
  return {
    requestId: "req_1",
    agentId: "search",
    task: "find the entrypoint",
    workspace: "/project",
    workspaceMode: "read-only",
    mode: "medium",
    background: true,
    interactive: false,
    timeoutMs: null,
    metadata: {},
    ...overrides,
  };
}

async function spawnChild(
  service: ExecutionGraphService,
  parent: ExecutionBinding,
  overrides: Partial<ChildRequest> = {},
): Promise<ExecutionBinding> {
  const reserved = await service.reserveChild(parent, request(overrides)) as ReservedChild;
  await service.startReservedChild(reserved, async () => undefined);
  return reserved.binding;
}

function nodeOf(nodes: readonly ExecutionNode[], executionId: string): ExecutionNode {
  const node = nodes.find((candidate) => candidate.executionId === executionId);
  if (!node) throw new Error(`no node \`${executionId}\``);
  return node;
}

async function codeOf(operation: () => Promise<unknown>): Promise<string | null> {
  try {
    await operation();
    return null;
  } catch (error) {
    if (isExecutionGraphError(error)) return error.code;
    throw error;
  }
}

/** A backend that remembers which processes it was told to start and to stop. */
function backend(options: { readonly refuse?: readonly string[] } = {}) {
  const cancelled: string[] = [];
  return {
    cancelled,
    cancel: async (executionId: string): Promise<void> => {
      if (options.refuse?.includes(executionId)) throw new Error(`backend cannot reach ${executionId}`);
      cancelled.push(executionId);
    },
  };
}

describe("ExecutionGraphService subtree cancellation", () => {
  /**
   * The reason cancel is a tree operation and not a node operation: a specialist that has
   * delegated further owns processes the person cancelling has never heard of, all of them
   * writing into the same workspace.
   */
  it("stops the target and everything it delegated below itself", async () => {
    const { service } = harness();
    const root = await service.createRoot({ agentId: "main" });
    await service.startRoot(root.binding, async () => undefined);
    const child = await spawnChild(service, root.binding, { agentId: "worker" });
    const grandchild = await spawnChild(service, child, { requestId: "req_deep" });
    const backendCalls = backend();

    const graph = await service.cancelSubtree({
      graphId: root.binding.graphId,
      executionId: child.executionId,
      reason: "USER_REQUEST",
      requestedBy: PRINCIPAL_REQUESTER,
    }, backendCalls.cancel);

    expect(nodeOf(graph.nodes, child.executionId)).toMatchObject({
      status: "cancelled",
      endedAt: BASE_TIME,
      cancellation: { reason: "USER_REQUEST", requestedBy: PRINCIPAL_REQUESTER, requestedAt: BASE_TIME },
    });
    // Cháu dừng vì cha nó dừng, và lý do phải nói đúng điều đó: không ai bấm cancel lên nó.
    expect(nodeOf(graph.nodes, grandchild.executionId)).toMatchObject({
      status: "cancelled",
      cancellation: { reason: "PARENT_CANCELLED", requestedBy: child.executionId },
    });
    // Anh em ngoài nhánh không bị chạm tới: huỷ một việc không phải huỷ cả phiên.
    expect(nodeOf(graph.nodes, root.binding.executionId).status).toBe("running");
  });

  /**
   * Lá chết trước gốc. Một cha đang hấp hối có thể dọn workspace hoặc đóng sổ trong khi con
   * nó vẫn đang ghi vào đó, và thứ tự ngược lại biến một lệnh dừng thành một cuộc đua.
   */
  it("signals the deepest generation first", async () => {
    const { service } = harness({ maxDepth: 3 });
    const root = await service.createRoot({ agentId: "main" });
    await service.startRoot(root.binding, async () => undefined);
    const child = await spawnChild(service, root.binding, { agentId: "worker" });
    const grandchild = await spawnChild(service, child, { requestId: "req_deep", agentId: "worker" });
    const greatGrandchild = await spawnChild(service, grandchild, { requestId: "req_deeper" });
    const backendCalls = backend();

    await service.cancelSubtree({
      graphId: root.binding.graphId,
      executionId: root.binding.executionId,
      reason: "USER_REQUEST",
      requestedBy: PRINCIPAL_REQUESTER,
    }, backendCalls.cancel);

    expect(backendCalls.cancelled).toEqual([
      greatGrandchild.executionId,
      grandchild.executionId,
      child.executionId,
      root.binding.executionId,
    ]);
  });

  /**
   * Invariant of the whole phase: from the moment the tree says "cancelling", nothing new can
   * be born inside the branch. The marking is persisted *before* the first signal leaves, so
   * a reservation racing the cancel finds a doomed ancestor rather than a free slot.
   */
  it("closes the branch to new children before any signal is sent", async () => {
    const { store, service } = harness();
    const root = await service.createRoot({ agentId: "main" });
    await service.startRoot(root.binding, async () => undefined);
    const child = await spawnChild(service, root.binding, { agentId: "worker" });

    let branchDuringSignal: string | undefined;
    await service.cancelSubtree({
      graphId: root.binding.graphId,
      executionId: child.executionId,
      reason: "USER_REQUEST",
      requestedBy: PRINCIPAL_REQUESTER,
    }, async () => {
      const graph = (await store.get(root.binding.graphId))!;
      branchDuringSignal = nodeOf(graph.nodes, child.executionId).status;
    });

    expect(branchDuringSignal).toBe("cancelling");
    // Và một reserve đến sau đó bị chặn bởi chính tổ tiên đã bị đánh dấu.
    expect(await codeOf(() => service.reserveChild(child, request({ requestId: "req_late" }))))
      .toBe("PARENT_NOT_ACTIVE");
  });

  /**
   * A slot held inside the branch is a process about to exist. Revoking it under the same
   * lease that marks its parent is what stops a spawn that is already halfway through
   * building its artifacts from committing a child into a branch that is being torn down.
   */
  it("revokes reservations inside the branch and refuses to start them", async () => {
    const { service } = harness();
    const root = await service.createRoot({ agentId: "main" });
    await service.startRoot(root.binding, async () => undefined);
    const child = await spawnChild(service, root.binding, { agentId: "worker" });
    const pending = await service.reserveChild(child, request({ requestId: "req_pending" })) as ReservedChild;

    const graph = await service.cancelSubtree({
      graphId: root.binding.graphId,
      executionId: child.executionId,
      reason: "USER_REQUEST",
      requestedBy: PRINCIPAL_REQUESTER,
    }, backend().cancel);

    expect(graph.reservations).toEqual([]);
    expect(await codeOf(() => service.startReservedChild(pending, async () => undefined)))
      .toBe("RESERVATION_NOT_FOUND");
    // Và không có node nào cho execution chưa từng ra đời: cây không nhắc tới process ma.
    expect(graph.nodes.map((node) => node.executionId)).not.toContain(pending.binding.executionId);
  });

  /**
   * `startReservedChild` giữ lease qua cả `backend.spawn()`, nên một lệnh huỷ tới đúng lúc đó
   * phải *xếp hàng* chứ không được chen vào giữa. Nếu chen được, nó sẽ đánh dấu một cây chưa
   * có node của con, rồi con xuất hiện ngay sau đó — sống, và ngoài mọi danh sách.
   */
  it("makes a cancel wait for a spawn that is holding the lease", async () => {
    const { service } = harness();
    const root = await service.createRoot({ agentId: "main" });
    await service.startRoot(root.binding, async () => undefined);
    const reserved = await service.reserveChild(root.binding, request()) as ReservedChild;
    const backendCalls = backend();
    const events: string[] = [];

    let cancelling!: Promise<unknown>;
    await service.startReservedChild(reserved, async () => {
      events.push("spawn:start");
      cancelling = service.cancelSubtree({
        graphId: root.binding.graphId,
        executionId: root.binding.executionId,
        reason: "USER_REQUEST",
        requestedBy: PRINCIPAL_REQUESTER,
      }, async (executionId) => {
        events.push(`cancel:${executionId}`);
        await backendCalls.cancel(executionId);
      });
      await new Promise((settle) => setTimeout(settle, 5));
      events.push("spawn:end");
    });
    const graph = await cancelling as Awaited<ReturnType<typeof service.cancelSubtree>>;

    // Lệnh huỷ không quan sát được gì trước khi spawn nhả lease.
    expect(events.slice(0, 2)).toEqual(["spawn:start", "spawn:end"]);
    // Và con vừa sinh ra nằm trong danh sách bị dừng, chứ không sống sót qua lệnh huỷ.
    expect(backendCalls.cancelled).toContain(reserved.binding.executionId);
    expect(nodeOf(graph.nodes, reserved.binding.executionId).status).toBe("cancelled");
    expect(graph.nodes.every((node) => !["preparing", "queued", "running"].includes(node.status))).toBe(true);
  });

  /**
   * Một backend không nhận được lệnh không chứng minh được process đã chết. Ghi `cancelled`
   * ở đây là xoá nó khỏi sổ sách trong lúc nó vẫn đang chạy — đúng thứ reconciliation sinh ra
   * để tránh. `cancelling` là trạng thái nói "đã bảo dừng, chưa thấy xác".
   */
  it("leaves a node cancelling when the backend refused the signal", async () => {
    const { service } = harness();
    const root = await service.createRoot({ agentId: "main" });
    await service.startRoot(root.binding, async () => undefined);
    const stubborn = await spawnChild(service, root.binding, { agentId: "worker" });
    const willing = await spawnChild(service, root.binding, { requestId: "req_ok" });

    const graph = await service.cancelSubtree({
      graphId: root.binding.graphId,
      executionId: root.binding.executionId,
      reason: "USER_REQUEST",
      requestedBy: PRINCIPAL_REQUESTER,
    }, backend({ refuse: [stubborn.executionId] }).cancel);

    expect(nodeOf(graph.nodes, stubborn.executionId)).toMatchObject({ status: "cancelling", endedAt: null });
    // Một nhánh từ chối không kéo theo nhánh khác: `allSettled`, không phải `all`.
    expect(nodeOf(graph.nodes, willing.executionId).status).toBe("cancelled");
    expect(nodeOf(graph.nodes, root.binding.executionId).status).toBe("cancelled");
  });

  /** Và lần sau reconciliation hỏi lại đúng node đó, rồi mới chốt kết cục. */
  it("lets reconciliation finish a cancel the backend could not confirm", async () => {
    const { service } = harness();
    const root = await service.createRoot({ agentId: "main" });
    await service.startRoot(root.binding, async () => undefined);
    const stubborn = await spawnChild(service, root.binding, { agentId: "worker" });
    await service.cancelSubtree({
      graphId: root.binding.graphId,
      executionId: stubborn.executionId,
      reason: "USER_REQUEST",
      requestedBy: PRINCIPAL_REQUESTER,
    }, backend({ refuse: [stubborn.executionId] }).cancel);

    const graph = await service.reconcile(root.binding.graphId, async (executionId) =>
      executionId === stubborn.executionId ? "missing" : "active");

    expect(nodeOf(graph.nodes, stubborn.executionId)).toMatchObject({
      status: "cancelled",
      // Không phải `interrupted`: lệnh dừng đã tới đích, đây là kết quả của nó.
      error: null,
      cancellation: { reason: "USER_REQUEST" },
    });
  });

  /**
   * Huỷ tới đúng lúc một agent vừa trả lời xong là chuyện thường. Kết quả nó đã trả là kết
   * quả thật, và ghi đè thành `cancelled` là vứt đi một việc đã làm xong.
   */
  it("keeps the result of an execution that finished while the signal was in flight", async () => {
    const { service } = harness();
    const root = await service.createRoot({ agentId: "main" });
    await service.startRoot(root.binding, async () => undefined);
    const child = await spawnChild(service, root.binding);

    const graph = await service.cancelSubtree({
      graphId: root.binding.graphId,
      executionId: root.binding.executionId,
      reason: "USER_REQUEST",
      requestedBy: PRINCIPAL_REQUESTER,
    }, async (executionId) => {
      if (executionId === child.executionId) await service.finishExecution(child, { status: "completed" });
    });

    expect(nodeOf(graph.nodes, child.executionId).status).toBe("completed");
    expect(nodeOf(graph.nodes, root.binding.executionId).status).toBe("cancelled");
  });

  /** Một node đã kết thúc không được gọi tới backend lần nữa — record của nó có thể đã bị dọn. */
  it("never signals a node that had already ended", async () => {
    const { service } = harness();
    const root = await service.createRoot({ agentId: "main" });
    await service.startRoot(root.binding, async () => undefined);
    const done = await spawnChild(service, root.binding);
    await service.finishExecution(done, { status: "completed" });
    const backendCalls = backend();

    await service.cancelSubtree({
      graphId: root.binding.graphId,
      executionId: root.binding.executionId,
      reason: "USER_REQUEST",
      requestedBy: PRINCIPAL_REQUESTER,
    }, backendCalls.cancel);

    expect(backendCalls.cancelled).toEqual([root.binding.executionId]);
  });

  /** Huỷ hai lần là một lần: node đã dừng, và lý do đầu tiên là lý do. */
  it("is idempotent and keeps the first reason", async () => {
    const { service } = harness();
    const root = await service.createRoot({ agentId: "main" });
    await service.startRoot(root.binding, async () => undefined);
    const child = await spawnChild(service, root.binding, { agentId: "worker" });
    const input = {
      graphId: root.binding.graphId,
      executionId: child.executionId,
      reason: "USER_REQUEST" as const,
      requestedBy: PRINCIPAL_REQUESTER,
    };
    await service.cancelSubtree(input, backend().cancel);

    const second = backend();
    const graph = await service.cancelSubtree(
      { ...input, reason: "SYSTEM_SHUTDOWN", requestedBy: "exec_other" },
      second.cancel,
    );

    expect(second.cancelled).toEqual([]);
    expect(nodeOf(graph.nodes, child.executionId).cancellation).toMatchObject({
      reason: "USER_REQUEST",
      requestedBy: PRINCIPAL_REQUESTER,
    });
  });

  /**
   * Cả cây dùng chung một `deadlineAt`, nên khi hạn tới thì mọi node trong đó đều thực sự
   * hết hạn — không có node nào "chết lây" từ cha. Đó là lý do lý do này không đổi thành
   * `PARENT_CANCELLED` khi lan xuống.
   */
  it("marks an expired tree with the wall clock, at every level", async () => {
    const { service, advance } = harness();
    const root = await service.createRoot({ agentId: "main" });
    await service.startRoot(root.binding, async () => undefined);
    const child = await spawnChild(service, root.binding, { agentId: "worker" });

    advance(DEFAULT_EXECUTION_GRAPH_LIMITS.wallClockMs + 1);
    const graph = await service.cancelSubtree({
      graphId: root.binding.graphId,
      executionId: root.binding.executionId,
      reason: "WALL_CLOCK_EXCEEDED",
      requestedBy: root.binding.graphId,
    }, backend().cancel);

    for (const executionId of [root.binding.executionId, child.executionId]) {
      expect(nodeOf(graph.nodes, executionId)).toMatchObject({
        status: "cancelled",
        terminationReason: "deadline",
        cancellation: { reason: "WALL_CLOCK_EXCEEDED" },
      });
    }
  });

  it("refuses to cancel an execution that is not in the graph", async () => {
    const { service } = harness();
    const root = await service.createRoot({ agentId: "main" });

    expect(await codeOf(() => service.cancelSubtree({
      graphId: root.binding.graphId,
      executionId: "exec_stranger",
      reason: "USER_REQUEST",
      requestedBy: PRINCIPAL_REQUESTER,
    }, backend().cancel))).toBe("EXECUTION_NODE_NOT_FOUND");
  });
});
