import { describe, expect, it } from "vitest";
import { DEFAULT_EXECUTION_GRAPH_LIMITS } from "../../src/execution/graph/defaults";
import { isExecutionGraphError } from "../../src/execution/graph/errors";
import {
  bindingEnvironment,
  childBinding,
  EXECUTION_BINDING_ENV,
  ExecutionGraphService,
  readBindingFromEnvironment,
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

describe("execution graph deadlines", () => {
  it("fixes the root deadline once, at wall clock from creation", async () => {
    const { service } = harness();

    const root = await service.createRoot({ agentId: "main", thread: null });

    expect(root.graph.deadlineAt)
      .toBe(new Date(Date.parse(BASE_TIME) + DEFAULT_EXECUTION_GRAPH_LIMITS.wallClockMs).toISOString());
    expect(root.binding.deadlineAt).toBe(root.graph.deadlineAt);
  });

  /**
   * Cái chốt của invariant 6. Một khoảng thời gian sẽ *khởi động lại* ở mỗi tầng: cha tiêu một
   * giờ rồi đưa con "hai giờ" là một cây sống lâu hơn hạn của chính nó, mỗi tầng một lần. Một
   * mốc tuyệt đối thì không tiêu được — mọi process trong cây chết đúng cùng một khoảnh khắc,
   * bất kể sinh ra lúc nào.
   */
  it("hands a child the same instant, however late it is born", async () => {
    const { service, advance } = harness({ maxDepth: 3 });
    const root = await service.createRoot({ agentId: "main", thread: null });
    await service.startRoot(root.binding, async () => undefined);

    advance(90 * 60_000);
    const child = await spawnChild(service, root.binding, { agentId: "worker" });
    advance(20 * 60_000);
    const grandchild = await spawnChild(service, child, { requestId: "req_deep" });

    expect(child.deadlineAt).toBe(root.binding.deadlineAt);
    expect(grandchild.deadlineAt).toBe(root.binding.deadlineAt);
  });

  /** Cùng một kết luận, nhưng ở đường tính thuần tuý: `childBinding` cũng chỉ chép lại. */
  it("copies the deadline when a binding is derived without touching disk", async () => {
    const { service } = harness();
    const root = await service.createRoot({ agentId: "main", thread: null });

    expect(childBinding(root.binding, "exec_derived").deadlineAt).toBe(root.binding.deadlineAt);
  });

  /** Và nó sống sót chuyến đi qua env, vì đó là cách con thật sự nhận được nó. */
  it("survives the trip through the child environment", async () => {
    const { service } = harness();
    const root = await service.createRoot({ agentId: "main", thread: null });
    const child = childBinding(root.binding, "exec_child");

    const environment = bindingEnvironment(child);

    expect(environment[EXECUTION_BINDING_ENV.deadlineAt]).toBe(root.binding.deadlineAt);
    expect(readBindingFromEnvironment(environment)).toEqual(child);
  });

  /** Thiếu deadline là binding không đọc được, chứ không phải binding không hạn. */
  it("refuses a binding whose environment lost the deadline", async () => {
    const { service } = harness();
    const root = await service.createRoot({ agentId: "main", thread: null });
    const environment = bindingEnvironment(root.binding);
    delete environment[EXECUTION_BINDING_ENV.deadlineAt];

    expect(readBindingFromEnvironment(environment)).toBeNull();
  });

  /**
   * Cửa vào của cả cây. Một cây đã hết hạn không được đẻ thêm con: process mới sẽ mang đúng
   * cái hạn đã qua đó, tức là sinh ra để chết ngay — nhưng vẫn kịp tiêu một slot và một
   * lượt delegation.
   */
  it("stops accepting children once the tree has expired", async () => {
    const { service, advance } = harness();
    const root = await service.createRoot({ agentId: "main", thread: null });
    await service.startRoot(root.binding, async () => undefined);

    advance(DEFAULT_EXECUTION_GRAPH_LIMITS.wallClockMs + 1);

    expect(await codeOf(() => service.reserveChild(root.binding, request()))).toBe("WALL_CLOCK_EXCEEDED");
  });

  /** Ngay trước hạn thì vẫn là trong hạn: biên là `>`, không phải `>=`. */
  it("still accepts a child at the last instant before the deadline", async () => {
    const { service, advance } = harness();
    const root = await service.createRoot({ agentId: "main", thread: null });
    await service.startRoot(root.binding, async () => undefined);

    advance(DEFAULT_EXECUTION_GRAPH_LIMITS.wallClockMs - 1);
    const reserved = await service.reserveChild(root.binding, request());

    expect(reserved.kind).toBe("reserved");
    expect((reserved as ReservedChild).binding.deadlineAt).toBe(root.binding.deadlineAt);
  });

  /**
   * Đồng hồ nằm ở backend, không ở cây: cây không giữ timer nào, vì nó sống trong một CLI có
   * thể đã thoát từ lâu. Nó biết chuyện đã xảy ra qua đúng một đường — probe trả `expired`.
   */
  it("learns about an expired process from the probe, and records why", async () => {
    const { service, advance } = harness();
    const root = await service.createRoot({ agentId: "main", thread: null });
    await service.startRoot(root.binding, async () => undefined);
    const child = await spawnChild(service, root.binding);

    advance(DEFAULT_EXECUTION_GRAPH_LIMITS.wallClockMs + 60_000);
    const graph = await service.reconcile(root.binding.graphId, async (executionId) =>
      executionId === child.executionId ? "expired" : "active");

    expect(nodeOf(graph.nodes, child.executionId)).toMatchObject({
      status: "cancelled",
      terminationReason: "deadline",
      cancellation: { reason: "WALL_CLOCK_EXCEEDED", requestedBy: root.binding.graphId },
      error: null,
    });
  });

  /**
   * `expired` và `cancelled` tới cùng một trạng thái cuối, và đó chính là lý do phải tách
   * chúng ở tầng probe: sau khi ghi xuống thì không còn gì phân biệt được nữa ngoài
   * `terminationReason`.
   */
  it("separates a clock kill from a person's cancel at the same terminal status", async () => {
    const { service } = harness();
    const root = await service.createRoot({ agentId: "main", thread: null });
    await service.startRoot(root.binding, async () => undefined);
    const expired = await spawnChild(service, root.binding);
    const stopped = await spawnChild(service, root.binding, { requestId: "req_2" });

    const graph = await service.reconcile(root.binding.graphId, async (executionId) => {
      if (executionId === expired.executionId) return "expired";
      if (executionId === stopped.executionId) return "cancelled";
      return "active";
    });

    expect(nodeOf(graph.nodes, expired.executionId).terminationReason).toBe("deadline");
    expect(nodeOf(graph.nodes, stopped.executionId).terminationReason).toBeNull();
    for (const executionId of [expired.executionId, stopped.executionId]) {
      expect(nodeOf(graph.nodes, executionId).status).toBe("cancelled");
    }
  });

  /** Hạn của cây là bất biến: reconcile ghi node, không ghi lại luật chơi. */
  it("never moves the deadline once the tree is open", async () => {
    const { service, advance } = harness();
    const root = await service.createRoot({ agentId: "main", thread: null });
    await service.startRoot(root.binding, async () => undefined);
    const child = await spawnChild(service, root.binding);

    advance(30 * 60_000);
    await service.finishExecution(child, { status: "completed" });
    const graph = await service.reconcile(root.binding.graphId, async () => "active");

    expect(graph.deadlineAt).toBe(root.graph.deadlineAt);
    expect(graph.limits.wallClockMs).toBe(DEFAULT_EXECUTION_GRAPH_LIMITS.wallClockMs);
  });
});
