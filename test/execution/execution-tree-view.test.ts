import { describe, expect, it } from "vitest";
import { DEFAULT_EXECUTION_GRAPH_LIMITS } from "../../src/execution/graph/defaults";
import { isExecutionGraphError } from "../../src/execution/graph/errors";
import {
  ExecutionGraphService,
  PRINCIPAL_REQUESTER,
  type ChildRequest,
  type ExecutionBinding,
  type ExecutionTreeNode,
  type ReservedChild,
} from "../../src/execution/graph/execution-graph-service";
import { InMemoryExecutionGraphStore } from "../../src/execution/graph/in-memory-execution-graph-store";
import type { ExecutionGraphLimits } from "../../src/execution/graph/types";

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

/** Every node in the view, flattened, so a redaction check can cover the whole shape. */
function flatten(node: ExecutionTreeNode): readonly ExecutionTreeNode[] {
  return [node, ...node.children.flatMap(flatten)];
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

describe("getExecutionTree", () => {
  /**
   * Người vận hành cầm cái ID mà `alp delegate` vừa in ra — một cái lá. Bắt họ tự tìm ngược
   * lên root là bắt họ đọc JSON thô, đúng việc lệnh này sinh ra để thay thế.
   */
  it("answers from any node with the whole tree, from the root down", async () => {
    const { service } = harness({ maxDepth: 3 });
    const root = await service.createRoot({ agentId: "main" });
    await service.startRoot(root.binding, async () => undefined);
    const child = await spawnChild(service, root.binding, { agentId: "worker" });
    const grandchild = await spawnChild(service, child, { requestId: "req_deep" });

    const view = await service.getExecutionTree(grandchild.executionId);

    expect(view).toMatchObject({
      graphId: root.binding.graphId,
      rootExecutionId: root.binding.executionId,
      // Node được hỏi vẫn được nêu tên, để CLI biết tô đậm dòng nào.
      executionId: grandchild.executionId,
      deadlineAt: root.graph.deadlineAt,
    });
    expect(view.root).toMatchObject({ executionId: root.binding.executionId, depth: 0, agentId: "main" });
    expect(view.root.children[0]).toMatchObject({ executionId: child.executionId, depth: 1 });
    expect(view.root.children[0].children[0]).toMatchObject({ executionId: grandchild.executionId, depth: 2 });
  });

  /**
   * Cái làm cho DTO này là một quyết định chứ không phải bản sao của node: capability hash và
   * fingerprint là vật liệu nội bộ, và `--json` thì chảy thẳng vào log CI của ai đó.
   */
  it("carries no capability hash, fingerprint, or reservation internals", async () => {
    const { service } = harness();
    const root = await service.createRoot({ agentId: "main" });
    await service.startRoot(root.binding, async () => undefined);
    await spawnChild(service, root.binding);
    await service.reserveChild(root.binding, request({ requestId: "req_held" }));

    const view = await service.getExecutionTree(root.binding.executionId);

    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("capabilityHash");
    expect(serialized).not.toContain("requestFingerprint");
    expect(serialized).not.toContain("reservationId");
    // Và không chứa chính giá trị bí mật, không chỉ tên trường của nó.
    const graph = (await service.getGraph(root.binding.graphId))!;
    for (const node of graph.nodes) expect(serialized).not.toContain(node.capabilityHash);
    expect(serialized).not.toContain(root.binding.capability);
    for (const node of flatten(view.root)) {
      expect(node).not.toHaveProperty("capabilityHash");
      expect(node).not.toHaveProperty("requestFingerprint");
    }
  });

  /** Nhưng request ID thì còn: đó là sợi dây duy nhất nối một node với lệnh đã sinh ra nó. */
  it("keeps the request correlation a caller can search by", async () => {
    const { service } = harness();
    const root = await service.createRoot({ agentId: "main" });
    await service.startRoot(root.binding, async () => undefined);
    await spawnChild(service, root.binding, { requestId: "req_from_ci" });

    const view = await service.getExecutionTree(root.binding.executionId);

    expect(view.root.children[0].requestId).toBe("req_from_ci");
    // Root không đến từ delegation nào, nên nó không có request để nối.
    expect(view.root.requestId).toBeNull();
  });

  /**
   * Hai con sinh trong cùng một mili-giây là bình thường — chúng được cấp trong cùng một
   * lease. Không có tie-break thì cùng một cây in ra hai lần cho hai bảng khác nhau.
   */
  it("orders children by creation, then by execution ID when they tie", async () => {
    const { service, advance } = harness({ maxConcurrentChildrenPerExecution: 4 });
    const root = await service.createRoot({ agentId: "main" });
    await service.startRoot(root.binding, async () => undefined);
    const first = await spawnChild(service, root.binding, { requestId: "req_a" });
    const second = await spawnChild(service, root.binding, { requestId: "req_b" });
    advance(1000);
    const third = await spawnChild(service, root.binding, { requestId: "req_c" });

    const view = await service.getExecutionTree(root.binding.executionId);

    expect(view.root.children.map((node) => node.executionId))
      .toEqual([first.executionId, second.executionId, third.executionId]);
  });

  it("is stable across repeated reads of an unchanged graph", async () => {
    const { service } = harness({ maxConcurrentChildrenPerExecution: 4 });
    const root = await service.createRoot({ agentId: "main" });
    await service.startRoot(root.binding, async () => undefined);
    await spawnChild(service, root.binding, { requestId: "req_a" });
    await spawnChild(service, root.binding, { requestId: "req_b" });

    const first = await service.getExecutionTree(root.binding.executionId);
    const second = await service.getExecutionTree(root.binding.executionId);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  /**
   * Câu hỏi người vận hành mang tới lệnh này thường là "vì sao nó không đẻ thêm con nữa", và
   * câu trả lời gần như luôn là một con số trong khối này.
   */
  it("reports the allowance, the ceilings, and what is holding a slot", async () => {
    const { service } = harness();
    const root = await service.createRoot({ agentId: "main" });
    await service.startRoot(root.binding, async () => undefined);
    const child = await spawnChild(service, root.binding, { requestId: "req_a" });
    await service.finishExecution(child, { status: "completed" });
    await service.reserveChild(root.binding, request({ requestId: "req_held" }));

    const view = await service.getExecutionTree(root.binding.executionId);

    expect(view.delegation).toEqual({
      used: 1,
      limit: DEFAULT_EXECUTION_GRAPH_LIMITS.delegationLimit,
      remaining: DEFAULT_EXECUTION_GRAPH_LIMITS.delegationLimit - 1,
    });
    expect(view.limits).toEqual(DEFAULT_EXECUTION_GRAPH_LIMITS);
    expect(view.summary).toEqual({
      total: 2,
      active: 1,
      byStatus: { running: 1, completed: 1 },
      // Một con số, không một danh sách: nó giải thích trần đầy mà không đưa ra ID nào.
      pending: 1,
    });
  });

  /** Chỗ giữ đã hết hạn không còn giữ gì cả, nên nó không được tính vào trần đang chặn ai. */
  it("stops counting a reservation that has expired", async () => {
    const { service, advance } = harness();
    const root = await service.createRoot({ agentId: "main" });
    await service.startRoot(root.binding, async () => undefined);
    await service.reserveChild(root.binding, request({ requestId: "req_held" }));

    advance(DEFAULT_EXECUTION_GRAPH_LIMITS.reservationTtlMs + 1);
    const view = await service.getExecutionTree(root.binding.executionId);

    expect(view.summary.pending).toBe(0);
  });

  /** Lý do dừng là thứ người vận hành đến để đọc — nó phải đi cùng node, không phải tra chỗ khác. */
  it("carries the cancellation context and the deadline mark", async () => {
    const { service } = harness();
    const root = await service.createRoot({ agentId: "main" });
    await service.startRoot(root.binding, async () => undefined);
    const child = await spawnChild(service, root.binding, { agentId: "worker" });
    const grandchild = await spawnChild(service, child, { requestId: "req_deep" });
    await service.cancelSubtree({
      graphId: root.binding.graphId,
      executionId: child.executionId,
      reason: "USER_REQUEST",
      requestedBy: PRINCIPAL_REQUESTER,
    }, async () => undefined);

    const view = await service.getExecutionTree(root.binding.executionId);
    const cancelled = flatten(view.root).find((node) => node.executionId === child.executionId)!;
    const cascaded = flatten(view.root).find((node) => node.executionId === grandchild.executionId)!;

    expect(cancelled.cancellation).toMatchObject({ reason: "USER_REQUEST", requestedBy: PRINCIPAL_REQUESTER });
    expect(cascaded.cancellation).toMatchObject({ reason: "PARENT_CANCELLED", requestedBy: child.executionId });
    expect(cancelled.terminationReason).toBeNull();
  });

  it("carries a failure reason as the node's own error", async () => {
    const { service } = harness();
    const root = await service.createRoot({ agentId: "main" });
    await service.startRoot(root.binding, async () => undefined);
    const child = await spawnChild(service, root.binding);
    await service.failExecution(child, new Error("runtime refused the task"));

    const view = await service.getExecutionTree(root.binding.executionId);

    expect(view.root.children[0]).toMatchObject({
      status: "failed",
      error: { message: expect.stringContaining("runtime refused") },
    });
  });

  /**
   * Một execution của bản cũ không thuộc cây nào. Trả về "cây trống" sẽ đọc thành "đã xong"
   * trong khi process của nó có thể vẫn đang chạy.
   */
  it("refuses an execution that belongs to no tree", async () => {
    const { service } = harness();
    await service.createRoot({ agentId: "main" });

    expect(await codeOf(() => service.getExecutionTree("exec_legacy"))).toBe("EXECUTION_NODE_NOT_FOUND");
  });

  /** Trần bị hạ giữa đời một cây không biến quota còn lại thành một số âm. */
  it("never reports a negative allowance", async () => {
    const { service } = harness({ delegationLimit: 1 });
    const root = await service.createRoot({ agentId: "main" });
    await service.startRoot(root.binding, async () => undefined);
    await spawnChild(service, root.binding, { requestId: "req_a" });

    const view = await service.getExecutionTree(root.binding.executionId);

    expect(view.delegation).toMatchObject({ used: 1, remaining: 0 });
  });
});
