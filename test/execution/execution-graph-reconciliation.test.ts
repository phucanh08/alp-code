import { describe, expect, it } from "vitest";
import { DEFAULT_EXECUTION_GRAPH_LIMITS, QUEUED_STARTUP_GRACE_MS } from "../../src/execution/graph/defaults";
import { isExecutionGraphError } from "../../src/execution/graph/errors";
import {
  ExecutionGraphService,
  type ChildRequest,
  type ExecutionBinding,
  type ProbeStatus,
  type ReservedChild,
} from "../../src/execution/graph/execution-graph-service";
import { InMemoryExecutionGraphStore } from "../../src/execution/graph/in-memory-execution-graph-store";
import type { ExecutionGraphLimits, ExecutionNode } from "../../src/execution/graph/types";

const BASE_TIME = "2026-09-11T00:00:00.000Z";

interface Harness {
  readonly store: InMemoryExecutionGraphStore;
  readonly service: ExecutionGraphService;
  advance(ms: number): void;
  now(): Date;
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
  return { store, service, advance: (ms: number) => { clock += ms; }, now: () => new Date(clock) };
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

/** A running child, committed the way `DelegationService` commits one. */
async function spawnChild(
  service: ExecutionGraphService,
  parent: ExecutionBinding,
  overrides: Partial<ChildRequest> = {},
): Promise<ExecutionBinding> {
  const reserved = await service.reserveChild(parent, request(overrides)) as ReservedChild;
  await service.startReservedChild(reserved, async () => undefined);
  return reserved.binding;
}

/**
 * A child that reached the tree and never reached the backend.
 *
 * `queued` is the inside of `startReservedChild` — the node is committed, the spawn has not
 * answered yet — so the only way to be left in it is for the caller to die in that window.
 * This stages exactly that: the first write lands, the second never comes.
 */
async function strandQueuedChild(
  context: Harness,
  parent: ExecutionBinding,
  overrides: Partial<ChildRequest> = {},
): Promise<string> {
  const reserved = await context.service.reserveChild(parent, request(overrides)) as ReservedChild;
  await context.store.withExclusiveLease(parent.graphId, async (lease) => {
    const graph = await lease.read();
    const reservation = graph.reservations.find((entry) => entry.reservationId === reserved.reservationId)!;
    const timestamp = context.now().toISOString();
    return lease.write({
      ...graph,
      revision: graph.revision + 1,
      updatedAt: timestamp,
      delegationUsed: graph.delegationUsed + 1,
      nodes: [...graph.nodes, {
        executionId: reservation.executionId,
        graphId: graph.graphId,
        parentExecutionId: reservation.parentExecutionId,
        agentId: reservation.agentId,
        thread: null,
        depth: reservation.depth,
        status: "queued" as const,
        requestId: reservation.requestId,
        requestFingerprint: reservation.requestFingerprint,
        capabilityHash: reservation.capabilityHash,
        createdAt: reservation.createdAt,
        updatedAt: timestamp,
        startedAt: null,
        endedAt: null,
        cancellation: null,
        error: null,
        terminationReason: null,
      }],
      reservations: graph.reservations.filter((entry) => entry.reservationId !== reserved.reservationId),
    });
  });
  return reserved.binding.executionId;
}

function nodeOf(nodes: readonly ExecutionNode[], executionId: string): ExecutionNode {
  const node = nodes.find((candidate) => candidate.executionId === executionId);
  if (!node) throw new Error(`no node \`${executionId}\``);
  return node;
}

/** A backend that answers from a table, and records every question it was asked. */
function backend(answers: Readonly<Record<string, ProbeStatus>>) {
  const asked: string[] = [];
  return {
    asked,
    probe: async (executionId: string): Promise<ProbeStatus> => {
      asked.push(executionId);
      return answers[executionId] ?? "missing";
    },
  };
}

describe("ExecutionGraphService reconciliation", () => {
  /**
   * The tree is the logical authority; the backend is the process authority. Reconciliation is
   * the one place the second informs the first, and it may only move a node forward.
   */
  it("adopts the backend's outcome for every node that was still active", async () => {
    const { store, service } = harness();
    const root = await service.createRoot({ agentId: "main", thread: null });
    await service.startRoot(root.binding, async () => undefined);
    const done = await spawnChild(service, root.binding, { requestId: "req_done" });
    const dead = await spawnChild(service, root.binding, { requestId: "req_dead", agentId: "worker" });

    const graph = await service.reconcile(root.binding.graphId, backend({
      [root.binding.executionId]: "active",
      [done.executionId]: "completed",
      [dead.executionId]: "failed",
    }).probe);

    expect(nodeOf(graph.nodes, root.binding.executionId)).toMatchObject({ status: "running", endedAt: null });
    expect(nodeOf(graph.nodes, done.executionId)).toMatchObject({ status: "completed", endedAt: BASE_TIME });
    expect(nodeOf(graph.nodes, dead.executionId)).toMatchObject({ status: "failed", endedAt: BASE_TIME });
    expect((await store.get(root.binding.graphId))!.revision).toBe(graph.revision);
  });

  /** `queued` là "đã ghi vào cây, chưa nghe backend xác nhận" — backend xác nhận thì nó chạy. */
  it("promotes a queued node once the backend confirms the process", async () => {
    const context = harness();
    const { service } = context;
    const root = await service.createRoot({ agentId: "main", thread: null });
    await service.startRoot(root.binding, async () => undefined);
    const child = await strandQueuedChild(context, root.binding);

    const graph = await service.reconcile(root.binding.graphId, backend({
      [root.binding.executionId]: "active",
      [child]: "active",
    }).probe);

    expect(nodeOf(graph.nodes, child)).toMatchObject({ status: "running", startedAt: BASE_TIME });
  });

  /**
   * Một kết cục đã ghi là đã ghi. Backend có thể quên một execution ngay sau khi nó xong, và
   * hỏi lại rồi tin câu trả lời đó là cách một run thành công tự biến thành `interrupted`.
   */
  it("asks only about nodes that are still active, and never reopens a terminal one", async () => {
    const { service } = harness();
    const root = await service.createRoot({ agentId: "main", thread: null });
    await service.startRoot(root.binding, async () => undefined);
    const child = await spawnChild(service, root.binding);
    await service.finishExecution(child, { status: "completed" });

    const probe = backend({ [root.binding.executionId]: "active" });
    const graph = await service.reconcile(root.binding.graphId, probe.probe);

    expect(probe.asked).toEqual([root.binding.executionId]);
    expect(nodeOf(graph.nodes, child.executionId).status).toBe("completed");
  });

  /**
   * "Không hỏi được" khác "không có". Một backend chập chờn mà bị đọc thành mất tích sẽ giết
   * một cây đang chạy đúng; giữ nguyên trạng thái thì lần reconcile sau vẫn còn cơ hội sửa.
   */
  it("keeps a node active when the backend cannot be reached", async () => {
    const { store, service } = harness();
    const root = await service.createRoot({ agentId: "main", thread: null });
    await service.startRoot(root.binding, async () => undefined);
    const child = await spawnChild(service, root.binding);

    const before = (await store.get(root.binding.graphId))!.revision;
    const graph = await service.reconcile(root.binding.graphId, async (executionId) => {
      if (executionId === child.executionId) throw new Error("backend socket closed");
      return "active";
    });

    expect(nodeOf(graph.nodes, child.executionId).status).toBe("running");
    // Không có gì đổi thì không ghi: mỗi revision thừa là một lần fsync và một lần chạm lease.
    expect(graph.revision).toBe(before);
  });

  it("writes nothing when the backend agrees with the tree", async () => {
    const { store, service } = harness();
    const root = await service.createRoot({ agentId: "main", thread: null });
    await service.startRoot(root.binding, async () => undefined);
    const before = (await store.get(root.binding.graphId))!.revision;

    const graph = await service.reconcile(
      root.binding.graphId,
      backend({ [root.binding.executionId]: "active" }).probe,
    );

    expect(graph.revision).toBe(before);
  });

  /**
   * Giữa "đã ghi node" và "backend biết tới process" có một khoảng thật, và trên máy đang tải
   * nặng nó không ngắn. Ân hạn 30 giây là khoảng đó; sau nó thì process gọi đã chết dở chừng.
   */
  it("gives a queued node a startup grace before calling it never-started", async () => {
    const context = harness();
    const { service, advance } = context;
    const root = await service.createRoot({ agentId: "main", thread: null });
    await service.startRoot(root.binding, async () => undefined);
    const child = await strandQueuedChild(context, root.binding);
    const probe = backend({ [root.binding.executionId]: "active" }).probe;

    advance(QUEUED_STARTUP_GRACE_MS - 1);
    expect(nodeOf((await service.reconcile(root.binding.graphId, probe)).nodes, child).status)
      .toBe("queued");

    advance(2);
    const graph = await service.reconcile(root.binding.graphId, probe);

    expect(nodeOf(graph.nodes, child)).toMatchObject({
      status: "failed",
      error: { code: "EXECUTION_NEVER_STARTED" },
      endedAt: new Date(Date.parse(BASE_TIME) + QUEUED_STARTUP_GRACE_MS + 1).toISOString(),
    });
  });

  /**
   * Một process đang chạy mà backend không còn biết tới đã chết mà không kịp ghi kết cục —
   * OOM kill, máy sập, `kill -9`. Đó không phải `failed` do chính nó: nó bị cắt ngang.
   */
  it("marks a running node interrupted when its process is gone", async () => {
    const { service } = harness();
    const root = await service.createRoot({ agentId: "main", thread: null });
    await service.startRoot(root.binding, async () => undefined);
    const child = await spawnChild(service, root.binding);

    const graph = await service.reconcile(root.binding.graphId, backend({
      [root.binding.executionId]: "active",
      [child.executionId]: "missing",
    }).probe);

    expect(nodeOf(graph.nodes, child.executionId)).toMatchObject({
      status: "interrupted",
      error: { code: "EXECUTION_INTERRUPTED" },
      endedAt: BASE_TIME,
    });
  });

  it("purges reservations whose holder never came back", async () => {
    const { store, service, advance } = harness();
    const root = await service.createRoot({ agentId: "main", thread: null });
    await service.startRoot(root.binding, async () => undefined);
    await service.reserveChild(root.binding, request());

    advance(DEFAULT_EXECUTION_GRAPH_LIMITS.reservationTtlMs + 1);
    const graph = await service.reconcile(
      root.binding.graphId,
      backend({ [root.binding.executionId]: "active" }).probe,
    );

    expect(graph.reservations).toEqual([]);
    expect((await store.get(root.binding.graphId))!.reservations).toEqual([]);
  });

  /**
   * Cây có thể rộng, và backend là process khác. Hỏi tuần tự thì mỗi lệnh `status` phải chờ
   * hết cả cây; hỏi tất cả cùng lúc thì một cây lớn tự làm nghẽn chính backend của nó.
   */
  it("queries the backend outside the lease, a bounded few at a time", async () => {
    const { service } = harness({
      maxChildrenPerExecution: 8,
      maxConcurrentChildrenPerExecution: 8,
      maxConcurrentExecutions: 12,
      delegationLimit: 12,
    });
    const root = await service.createRoot({ agentId: "main", thread: null });
    await service.startRoot(root.binding, async () => undefined);
    for (let index = 0; index < 5; index += 1) {
      await spawnChild(service, root.binding, { requestId: `req_${index}`, task: `task ${index}` });
    }

    let inFlight = 0;
    let peak = 0;
    let leaseTakenDuringProbe = false;
    await service.reconcile(root.binding.graphId, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Lease phải rảnh trong lúc hỏi: nếu không, một cây đang reconcile sẽ chặn mọi
      // reserve khác suốt cả vòng hỏi backend.
      await service.getGraph(root.binding.graphId).then(() => { leaseTakenDuringProbe = true; });
      await new Promise((settle) => setTimeout(settle, 1));
      inFlight -= 1;
      return "active";
    });

    expect(peak).toBe(4);
    expect(leaseTakenDuringProbe).toBe(true);
  });

  /**
   * Invariant of the whole delegation model: a subtree exists to answer its parent. Once the
   * parent is gone nobody is waiting for those answers, and every one of them is still holding
   * a concurrency slot the rest of the tree needs back.
   */
  it("cancels the live descendants of a node that died", async () => {
    const { store, service } = harness();
    const root = await service.createRoot({ agentId: "main", thread: null });
    await service.startRoot(root.binding, async () => undefined);
    const child = await spawnChild(service, root.binding, { agentId: "worker" });
    const grandchild = await spawnChild(service, child, { requestId: "req_deep" });
    await service.reserveChild(child, request({ requestId: "req_pending" }));

    const graph = await service.reconcile(root.binding.graphId, backend({
      [root.binding.executionId]: "active",
      [child.executionId]: "missing",
      [grandchild.executionId]: "active",
    }).probe);

    expect(nodeOf(graph.nodes, child.executionId).status).toBe("interrupted");
    expect(nodeOf(graph.nodes, grandchild.executionId)).toMatchObject({
      status: "cancelled",
      endedAt: BASE_TIME,
      cancellation: { reason: "PARENT_FAILED", requestedBy: child.executionId, requestedAt: BASE_TIME },
    });
    // Chỗ mà con đã chết giữ cho một cháu chưa kịp sinh cũng phải trả lại.
    expect(graph.reservations).toEqual([]);
    // Cascade chạy ở lease thứ hai, sau khi kết cục của cha đã nằm trên đĩa.
    expect((await store.get(root.binding.graphId))!.revision).toBe(graph.revision);
  });

  /** Một nhánh đã có kết cục của riêng nó thì giữ kết cục đó — cascade không viết đè lịch sử. */
  it("leaves a descendant that already finished alone", async () => {
    const { service } = harness();
    const root = await service.createRoot({ agentId: "main", thread: null });
    await service.startRoot(root.binding, async () => undefined);
    const child = await spawnChild(service, root.binding, { agentId: "worker" });
    const grandchild = await spawnChild(service, child, { requestId: "req_deep" });
    await service.finishExecution(grandchild, { status: "completed" });

    const graph = await service.reconcile(root.binding.graphId, backend({
      [root.binding.executionId]: "active",
      [child.executionId]: "missing",
    }).probe);

    expect(nodeOf(graph.nodes, grandchild.executionId)).toMatchObject({
      status: "completed",
      cancellation: null,
    });
  });

  /** Cha chết thì cả nhánh chết, chứ không chỉ đời con kế tiếp. */
  it("reaches every generation below the node that died", async () => {
    const { service } = harness({ maxDepth: 3 });
    const root = await service.createRoot({ agentId: "main", thread: null });
    await service.startRoot(root.binding, async () => undefined);
    const child = await spawnChild(service, root.binding, { agentId: "worker" });
    const grandchild = await spawnChild(service, child, { requestId: "req_deep", agentId: "worker" });
    const greatGrandchild = await spawnChild(service, grandchild, { requestId: "req_deeper" });

    const graph = await service.reconcile(root.binding.graphId, backend({
      [root.binding.executionId]: "active",
      [child.executionId]: "failed",
      [grandchild.executionId]: "active",
      [greatGrandchild.executionId]: "active",
    }).probe);

    expect(nodeOf(graph.nodes, child.executionId).status).toBe("failed");
    expect(nodeOf(graph.nodes, grandchild.executionId).status).toBe("cancelled");
    expect(nodeOf(graph.nodes, greatGrandchild.executionId)).toMatchObject({
      status: "cancelled",
      cancellation: { reason: "PARENT_FAILED", requestedBy: child.executionId },
    });
  });

  it("refuses to reconcile a graph that does not exist", async () => {
    const { service } = harness();

    const error = await service.reconcile("exec_missing", async () => "active").catch((value) => value);
    expect(isExecutionGraphError(error) && error.code).toBe("EXECUTION_GRAPH_NOT_FOUND");
  });
});
