import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEFAULT_EXECUTION_GRAPH_LIMITS } from "../../src/execution/graph/defaults";
import { isExecutionGraphError } from "../../src/execution/graph/errors";
import {
  CHILD_CAPABILITY_CONTEXT,
  ExecutionGraphService,
  capabilityMatches,
  deriveChildCapability,
  requestFingerprint,
  type ChildRequest,
  type ExecutionBinding,
  type ReservedChild,
} from "../../src/execution/graph/execution-graph-service";
import { InMemoryExecutionGraphStore } from "../../src/execution/graph/in-memory-execution-graph-store";
import type { ExecutionGraphLimits } from "../../src/execution/graph/types";

const BASE_TIME = "2026-09-11T00:00:00.000Z";

function harness(limits?: Partial<ExecutionGraphLimits>) {
  const store = new InMemoryExecutionGraphStore();
  let clock = Date.parse(BASE_TIME);
  let executions = 0;
  let reservations = 0;
  const service = new ExecutionGraphService({
    store,
    ...(limits ? { limits: { ...DEFAULT_EXECUTION_GRAPH_LIMITS, ...limits } } : {}),
    now: () => new Date(clock),
    newExecutionId: () => `exec_${++executions}`,
    newReservationId: () => `rsv_${++reservations}`,
  });
  return { store, service, advance: (ms: number) => { clock += ms; } };
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

/** Commits a reservation the way `DelegationService` does, with a backend that always works. */
async function start(
  service: ExecutionGraphService,
  reserved: ReservedChild,
): Promise<ExecutionBinding> {
  await service.startReservedChild(reserved, async () => ({
    executionId: reserved.binding.executionId,
    status: "running" as const,
  }));
  return reserved.binding;
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

describe("ExecutionGraphService child reservation", () => {
  /**
   * The window this whole mechanism exists to close: the ceiling is checked long before the
   * process is registered, so without a reservation two callers both read "one slot left"
   * and both take it. A reservation is the slot, taken at the moment it is checked.
   */
  it("holds a slot against the ceiling before any artifact exists", async () => {
    const { store, service } = harness();
    const root = await service.createRoot({ agentId: "main" });

    const reserved = await service.reserveChild(root.binding, request());

    expect(reserved.kind).toBe("reserved");
    const graph = await store.get(root.binding.graphId);
    // Node chưa có — chỉ có chỗ đã giữ. `delegationUsed` cũng chưa tăng: reservation tính vào
    // capacity qua `provisionalDelegationUsed`, không qua ngân sách đã tiêu.
    expect(graph).toMatchObject({ delegationUsed: 0, revision: 1 });
    expect(graph!.nodes).toHaveLength(1);
    expect(graph!.reservations).toHaveLength(1);
    expect(graph!.reservations[0]).toMatchObject({
      reservationId: "rsv_1",
      executionId: "exec_2",
      parentExecutionId: root.binding.executionId,
      agentId: "search",
      depth: 1,
      requestId: "req_1",
      createdAt: BASE_TIME,
      expiresAt: new Date(Date.parse(BASE_TIME) + DEFAULT_EXECUTION_GRAPH_LIMITS.reservationTtlMs).toISOString(),
    });
  });

  /**
   * The child's secret is HMAC'd under the parent's, so only a holder of the parent's
   * capability can compute it — and the tree keeps the hash alone, never the secret.
   */
  it("derives the child capability from the parent and stores only its hash", async () => {
    const { store, service } = harness();
    const root = await service.createRoot({ agentId: "main" });

    const reserved = await service.reserveChild(root.binding, request()) as ReservedChild;

    const expected = createHmac("sha256", root.binding.capability)
      .update(`${CHILD_CAPABILITY_CONTEXT}\0${root.binding.graphId}\0exec_2`, "utf8")
      .digest("base64url");
    expect(reserved.binding.capability).toBe(expected);
    // Cùng graph, cùng deadline: hạn chốt một lần ở root và truyền xuống nguyên vẹn.
    expect(reserved.binding).toMatchObject({
      graphId: root.binding.graphId,
      executionId: "exec_2",
      deadlineAt: root.binding.deadlineAt,
    });
    const graph = await store.get(root.binding.graphId);
    expect(JSON.stringify(graph)).not.toContain(reserved.binding.capability);
    expect(capabilityMatches(graph!.reservations[0].capabilityHash, reserved.binding.capability)).toBe(true);
  });

  /** Ai không cầm capability của cha thì không giữ được chỗ nào — vai không phải bằng chứng. */
  it("refuses a parent binding the graph did not issue", async () => {
    const { service } = harness();
    const root = await service.createRoot({ agentId: "main" });

    const forged = { ...root.binding, capability: "not-the-capability-this-graph-issued" };
    expect(await codeOf(() => service.reserveChild(forged, request()))).toBe("CAPABILITY_INVALID");
  });

  /**
   * A retry must land on the child it already made. Two processes editing one workspace
   * because a connection dropped is the failure this rule exists to prevent.
   */
  it("returns the existing child for a repeated request instead of making another", async () => {
    const { store, service } = harness();
    const root = await service.createRoot({ agentId: "main" });
    const reserved = await service.reserveChild(root.binding, request()) as ReservedChild;
    await start(service, reserved);

    const again = await service.reserveChild(root.binding, request());

    expect(again).toMatchObject({ kind: "existing", node: { executionId: "exec_2" } });
    // Capability dẫn xuất lại được, nên caller vẫn đủ quyền kết thúc con cũ.
    expect(again.binding.capability).toBe(reserved.binding.capability);
    const graph = await store.get(root.binding.graphId);
    expect(graph).toMatchObject({ delegationUsed: 1 });
    expect(graph!.nodes).toHaveLength(2);
  });

  /** Một request đang được dựng dở là một request đang chạy, không phải một chỗ trống. */
  it("reports a repeated request that is still being started", async () => {
    const { service } = harness();
    const root = await service.createRoot({ agentId: "main" });
    await service.reserveChild(root.binding, request());

    const error = await service.reserveChild(root.binding, request()).catch((value) => value);
    expect(error).toMatchObject({ code: "REQUEST_IN_PROGRESS", executionId: "exec_2" });
  });

  /**
   * Fingerprint trả lời "việc gì", request ID trả lời "lần gọi nào". Cùng ID mà khác việc là
   * hai việc trùng tên, và đi tiếp ở đây là biến idempotency thành một lời hứa sai.
   */
  it("rejects a reused request ID that describes different work", async () => {
    const { service } = harness();
    const root = await service.createRoot({ agentId: "main" });
    const reserved = await service.reserveChild(root.binding, request()) as ReservedChild;
    await start(service, reserved);

    expect(await codeOf(() => service.reserveChild(root.binding, request({ task: "something else" }))))
      .toBe("REQUEST_ID_CONFLICT");
    // Cũng thế khi bản cũ mới chỉ là một chỗ giữ.
    expect(await codeOf(() => service.reserveChild(root.binding, request({ requestId: "req_2" }))))
      .toBe(null);
    expect(await codeOf(() => service.reserveChild(root.binding, request({ requestId: "req_2", mode: "ultra" }))))
      .toBe("REQUEST_ID_CONFLICT");
  });

  /** Khoá sắp xếp ở mọi tầng, nên cùng nội dung viết khác thứ tự vẫn là một việc. */
  it("fingerprints a request by content, not by key order", async () => {
    const ordered = requestFingerprint("exec_1", request({ metadata: { a: 1, b: { x: 1, y: 2 } } }));
    const shuffled = requestFingerprint("exec_1", request({ metadata: { b: { y: 2, x: 1 }, a: 1 } }));
    expect(ordered).toBe(shuffled);
    expect(ordered).toMatch(/^[0-9a-f]{64}$/);
    // Cha khác thì việc khác: cùng một câu hỏi do hai node khác nhau đặt ra là hai việc.
    expect(requestFingerprint("exec_9", request())).not.toBe(requestFingerprint("exec_1", request()));
  });

  /**
   * A slot held by a caller that died must come back. Two minutes of a dead process's
   * reservation is two minutes the tree is smaller than it really is.
   */
  it("expires a stale reservation and lets the request be made again", async () => {
    const { store, service, advance } = harness();
    const root = await service.createRoot({ agentId: "main" });
    await service.reserveChild(root.binding, request());

    advance(DEFAULT_EXECUTION_GRAPH_LIMITS.reservationTtlMs + 1);
    const retried = await service.reserveChild(root.binding, request()) as ReservedChild;

    // ID mới, vì cái cũ có thể đã được dùng để dựng artifact dở dang ở đâu đó.
    expect(retried.binding.executionId).toBe("exec_3");
    const graph = await store.get(root.binding.graphId);
    expect(graph!.reservations).toHaveLength(1);
    expect(graph!.reservations[0]).toMatchObject({ reservationId: "rsv_2", executionId: "exec_3" });
  });

  it("releases a reservation that never became a child", async () => {
    const { store, service } = harness();
    const root = await service.createRoot({ agentId: "main" });
    const reserved = await service.reserveChild(root.binding, request()) as ReservedChild;

    await service.releaseReservation(root.binding.graphId, reserved.reservationId);

    expect((await store.get(root.binding.graphId))!.reservations).toEqual([]);
    // Dọn dẹp hai lần không được ném: đường gọi duy nhất là sau một lỗi khác, và một lỗi
    // thứ hai ở đây sẽ nuốt mất lỗi thật.
    await expect(service.releaseReservation(root.binding.graphId, reserved.reservationId)).resolves.toBeUndefined();
  });

  /** Cha đã chết thì không còn ai chờ kết quả của con — và không ai giao việc thay nó. */
  it("refuses to reserve under a parent that is no longer active", async () => {
    const { service } = harness();
    const root = await service.createRoot({ agentId: "main" });
    await service.finishExecution(root.binding, { status: "completed" });

    expect(await codeOf(() => service.reserveChild(root.binding, request()))).toBe("PARENT_NOT_ACTIVE");
  });

  /**
   * Huỷ đánh dấu node rồi mới lan xuống, nên có một khoảnh khắc cha vẫn `running` dưới một
   * ông đã `cancelling`. Một con sinh ra đúng lúc đó là một process ngoài danh sách.
   */
  it("refuses to reserve under a cancelled ancestor", async () => {
    const { store, service } = harness();
    const root = await service.createRoot({ agentId: "main" });
    const child = await service.reserveChild(root.binding, request({ agentId: "worker" })) as ReservedChild;
    await start(service, child);

    const graph = (await store.get(root.binding.graphId))!;
    await store.withExclusiveLease(graph.graphId, async (lease) => {
      const current = await lease.read();
      await lease.write({
        ...current,
        revision: current.revision + 1,
        nodes: current.nodes.map((node) =>
          node.executionId === root.binding.executionId ? { ...node, status: "cancelling" as const } : node),
      });
    });

    expect(await codeOf(() => service.reserveChild(child.binding, request({ requestId: "req_2" }))))
      .toBe("EXECUTION_CANCELLED");
  });

  it("refuses to reserve past the graph's absolute deadline", async () => {
    const { service, advance } = harness();
    const root = await service.createRoot({ agentId: "main" });

    advance(DEFAULT_EXECUTION_GRAPH_LIMITS.wallClockMs + 1);

    expect(await codeOf(() => service.reserveChild(root.binding, request()))).toBe("WALL_CLOCK_EXCEEDED");
  });

  /**
   * Trần đếm cả chỗ đã giữ. Nếu không thì hai caller cùng đọc "còn một chỗ" rồi cùng đi tiếp,
   * và giới hạn đồng thời chỉ đúng khi không ai chạy song song — tức là không bao giờ.
   */
  it("counts live reservations against the concurrency ceiling", async () => {
    const { service } = harness({ maxConcurrentChildrenPerExecution: 1 });
    const root = await service.createRoot({ agentId: "main" });
    await service.reserveChild(root.binding, request());

    expect(await codeOf(() => service.reserveChild(root.binding, request({ requestId: "req_2" }))))
      .toBe("CONCURRENCY_LIMIT_EXCEEDED");
  });

  it("stops a child from delegating past the depth ceiling", async () => {
    const { service } = harness({ maxDepth: 1 });
    const root = await service.createRoot({ agentId: "main" });
    const child = await service.reserveChild(root.binding, request({ agentId: "worker" })) as ReservedChild;
    await start(service, child);

    expect(await codeOf(() => service.reserveChild(child.binding, request({ requestId: "req_2" }))))
      .toBe("DEPTH_LIMIT_EXCEEDED");
  });

  /**
   * Ngân sách đếm số lần cây **đã thử** đẻ con. Hoàn lại khi spawn hỏng là cách một vòng lặp
   * hỏng đều đặn chạy mãi mà không bao giờ chạm trần.
   */
  it("spends the delegation allowance once and never refunds a failed spawn", async () => {
    const { store, service } = harness();
    const root = await service.createRoot({ agentId: "main" });
    const reserved = await service.reserveChild(root.binding, request()) as ReservedChild;

    const failure = new Error("spawn died");
    await expect(service.startReservedChild(reserved, async () => { throw failure; })).rejects.toBe(failure);

    const graph = await store.get(root.binding.graphId);
    expect(graph).toMatchObject({ delegationUsed: 1, reservations: [] });
    expect(graph!.nodes[1]).toMatchObject({
      executionId: "exec_2",
      status: "failed",
      error: { code: "CHILD_START_FAILED", message: "spawn died" },
    });
    expect(graph!.nodes[1].endedAt).toBe(BASE_TIME);
  });

  /**
   * Invariant 5, at the one place it can break: the node must be `queued` on disk before the
   * backend is asked for a process, and `running` only after it answers — all under one
   * lease, so no reader ever sees a tree that claims a process nobody has spawned.
   */
  it("registers the process under the same lease that commits the node", async () => {
    const { store, service } = harness();
    const root = await service.createRoot({ agentId: "main" });
    const reserved = await service.reserveChild(root.binding, request()) as ReservedChild;

    let statusDuringSpawn: string | undefined;
    await service.startReservedChild(reserved, async (binding) => {
      statusDuringSpawn = (await store.get(binding.graphId))!.nodes[1].status;
      return { executionId: binding.executionId, status: "running" as const };
    });

    expect(statusDuringSpawn).toBe("queued");
    const graph = await store.get(root.binding.graphId);
    expect(graph!.nodes[1]).toMatchObject({
      executionId: "exec_2",
      status: "running",
      startedAt: BASE_TIME,
      createdAt: BASE_TIME,
      requestId: "req_1",
      requestFingerprint: requestFingerprint(root.binding.executionId, request()),
    });
    expect(capabilityMatches(graph!.nodes[1].capabilityHash, reserved.binding.capability)).toBe(true);
  });

  it("refuses to start a reservation that expired while artifacts were being built", async () => {
    const { store, service, advance } = harness();
    const root = await service.createRoot({ agentId: "main" });
    const reserved = await service.reserveChild(root.binding, request()) as ReservedChild;

    advance(DEFAULT_EXECUTION_GRAPH_LIMITS.reservationTtlMs + 1);

    expect(await codeOf(() => start(service, reserved))).toBe("RESERVATION_EXPIRED");
    const graph = await store.get(root.binding.graphId);
    expect(graph).toMatchObject({ delegationUsed: 0, reservations: [] });
    expect(graph!.nodes).toHaveLength(1);
  });

  it("refuses to start a reservation that was already released", async () => {
    const { service } = harness();
    const root = await service.createRoot({ agentId: "main" });
    const reserved = await service.reserveChild(root.binding, request()) as ReservedChild;
    await service.releaseReservation(root.binding.graphId, reserved.reservationId);

    expect(await codeOf(() => start(service, reserved))).toBe("RESERVATION_NOT_FOUND");
  });

  /** `deriveChildCapability` là thuần: cùng đầu vào, cùng kết quả — đó là điều làm retry an toàn. */
  it("derives the same child capability every time and a different one per child", async () => {
    const parent = "parent-capability";
    expect(deriveChildCapability(parent, "exec_root", "exec_child"))
      .toBe(deriveChildCapability(parent, "exec_root", "exec_child"));
    expect(deriveChildCapability(parent, "exec_root", "exec_child"))
      .not.toBe(deriveChildCapability(parent, "exec_root", "exec_other"));
    expect(deriveChildCapability(parent, "exec_root", "exec_child"))
      .not.toBe(deriveChildCapability("other-parent", "exec_root", "exec_child"));
  });
});
