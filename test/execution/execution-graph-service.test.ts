import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEFAULT_EXECUTION_GRAPH_LIMITS } from "../../src/execution/graph/defaults";
import { isExecutionGraphError } from "../../src/execution/graph/errors";
import {
  EXECUTION_BINDING_ENV,
  ExecutionGraphService,
  bindingEnvironment,
} from "../../src/execution/graph/execution-graph-service";
import { InMemoryExecutionGraphStore } from "../../src/execution/graph/in-memory-execution-graph-store";

const BASE_TIME = "2026-09-11T00:00:00.000Z";

interface Harness {
  readonly store: InMemoryExecutionGraphStore;
  readonly service: ExecutionGraphService;
  advance(ms: number): void;
}

function harness(): Harness {
  const store = new InMemoryExecutionGraphStore();
  let clock = Date.parse(BASE_TIME);
  let serial = 0;
  const service = new ExecutionGraphService({
    store,
    now: () => new Date(clock),
    newExecutionId: () => {
      serial += 1;
      return `exec_root_${serial}`;
    },
  });
  return { store, service, advance: (ms) => { clock += ms; } };
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

describe("ExecutionGraphService root lifecycle", () => {
  it("creates a root that owns its graph, its limits, and one absolute deadline", async () => {
    const { store, service } = harness();

    const root = await service.createRoot({ agentId: "main", thread: null });

    expect(root.binding.graphId).toBe(root.binding.executionId);
    const stored = await store.get(root.binding.graphId);
    expect(stored).toMatchObject({
      version: 1,
      graphId: "exec_root_1",
      rootExecutionId: "exec_root_1",
      revision: 0,
      createdAt: BASE_TIME,
      delegationUsed: 0,
      limits: DEFAULT_EXECUTION_GRAPH_LIMITS,
      reservations: [],
    });
    // Một timestamp tuyệt đối, không phải thời lượng — và binding mang đúng cái đã ghi.
    const deadline = new Date(Date.parse(BASE_TIME) + DEFAULT_EXECUTION_GRAPH_LIMITS.wallClockMs).toISOString();
    expect(stored?.deadlineAt).toBe(deadline);
    expect(root.binding.deadlineAt).toBe(deadline);
    expect(stored?.nodes).toHaveLength(1);
    expect(stored?.nodes[0]).toMatchObject({
      executionId: "exec_root_1",
      parentExecutionId: null,
      agentId: "main",
      depth: 0,
      status: "preparing",
      requestId: null,
      requestFingerprint: null,
      startedAt: null,
      endedAt: null,
      error: null,
      cancellation: null,
    });
  });

  /**
   * Invariant 7. Một capability trong graph là một secret nằm trên đĩa ở `~/.alp` cho tới khi
   * ai đó dọn nó — và graph là thứ `alp delegation tree` in ra. Hash thì chứng minh được người
   * cầm plaintext mà không phải giữ plaintext.
   */
  it("keeps the capability out of durable state and stores only its hash", async () => {
    const { store, service } = harness();

    const root = await service.createRoot({ agentId: "main", thread: null });
    const stored = await store.get(root.binding.graphId);

    expect(root.binding.capability).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(stored)).not.toContain(root.binding.capability);
    expect(stored?.nodes[0].capabilityHash).toBe(
      createHash("sha256").update(root.binding.capability, "utf8").digest("hex"),
    );
  });

  it("refuses to start a root on a capability that is not the one it issued", async () => {
    const { store, service } = harness();
    const root = await service.createRoot({ agentId: "main", thread: null });
    let registered = 0;

    const forged = { ...root.binding, capability: "a".repeat(43) };
    expect(await codeOf(() => service.startRoot(forged, async () => { registered += 1; })))
      .toBe("CAPABILITY_INVALID");

    expect(registered).toBe(0);
    const stored = await store.get(root.binding.graphId);
    expect(stored?.nodes[0].status).toBe("preparing");
    expect(stored?.revision).toBe(0);
  });

  /**
   * Invariant 5. Nếu lease được nhả trước khi backend đăng ký process, có một khoảnh khắc cây
   * nói "root đang chạy" mà chưa process nào tồn tại — và một lệnh huỷ rơi đúng vào đó sẽ huỷ
   * một thứ chưa có, rồi process xuất hiện sau đó mà không ai còn nhớ phải giết nó.
   */
  it("holds the graph lease across registration", async () => {
    const { store, service } = harness();
    const root = await service.createRoot({ agentId: "main", thread: null });
    const events: string[] = [];

    const spawned = service.startRoot(root.binding, async () => {
      events.push("register:start");
      const competitor = store.withExclusiveLease(root.binding.graphId, async () => {
        events.push("competitor");
      });
      await new Promise((settle) => setTimeout(settle, 5));
      events.push("register:end");
      return { pid: 42, competitor };
    });
    const { competitor } = await spawned;
    await competitor;

    expect(events).toEqual(["register:start", "register:end", "competitor"]);
    const stored = await store.get(root.binding.graphId);
    expect(stored?.nodes[0]).toMatchObject({ status: "running", startedAt: BASE_TIME, endedAt: null });
    expect(stored?.revision).toBe(1);
  });

  it("leaves a root that failed to spawn terminal and inspectable", async () => {
    const { store, service } = harness();
    const root = await service.createRoot({ agentId: "main", thread: null });

    await expect(
      service.startRoot(root.binding, async () => {
        throw new Error("claude binary is not on PATH");
      }),
    ).rejects.toThrowError(/claude binary is not on PATH/);

    const stored = await store.get(root.binding.graphId);
    expect(stored?.nodes[0]).toMatchObject({
      status: "failed",
      startedAt: null,
      endedAt: BASE_TIME,
      error: { code: "ROOT_START_FAILED", message: "claude binary is not on PATH" },
    });
  });

  it("refuses to start a root whose graph has already passed its deadline", async () => {
    const { service, advance } = harness();
    const root = await service.createRoot({ agentId: "main", thread: null });

    advance(DEFAULT_EXECUTION_GRAPH_LIMITS.wallClockMs);
    expect(await codeOf(() => service.startRoot(root.binding, async () => undefined)))
      .toBe("WALL_CLOCK_EXCEEDED");
  });

  it("records the result of a root that ran, and never resurrects one that ended", async () => {
    const { store, service, advance } = harness();
    const root = await service.createRoot({ agentId: "main", thread: null });
    await service.startRoot(root.binding, async () => undefined);

    advance(1_000);
    const finished = await service.finishExecution(root.binding, { status: "completed" });
    expect(finished).toMatchObject({ status: "completed", endedAt: "2026-09-11T00:00:01.000Z" });

    // Một backend trả kết quả muộn, hoặc một reconcile chạy lại sau khi restart: kết cục đầu
    // tiên là kết cục, và ghi đè nó là cách một run thành công biến thành một run hỏng.
    advance(1_000);
    const again = await service.finishExecution(root.binding, {
      status: "failed",
      error: { code: "LATE", message: "arrived after the fact" },
    });
    expect(again).toMatchObject({ status: "completed", endedAt: "2026-09-11T00:00:01.000Z" });
    expect((await store.get(root.binding.graphId))?.revision).toBe(2);
  });

  it("fails a root that never reached the backend at all", async () => {
    const { store, service } = harness();
    const root = await service.createRoot({ agentId: "main", thread: null });

    await service.failExecution(root.binding, new Error("memory context exceeded its budget"));

    expect((await store.get(root.binding.graphId))?.nodes[0]).toMatchObject({
      status: "failed",
      endedAt: BASE_TIME,
      error: { code: "ROOT_START_FAILED", message: "memory context exceeded its budget" },
    });
  });

  it("renders the binding into exactly the four launch variables", async () => {
    const { service } = harness();
    const root = await service.createRoot({ agentId: "main", thread: null });

    expect(bindingEnvironment(root.binding)).toEqual({
      [EXECUTION_BINDING_ENV.graphId]: "exec_root_1",
      [EXECUTION_BINDING_ENV.executionId]: "exec_root_1",
      [EXECUTION_BINDING_ENV.capability]: root.binding.capability,
      [EXECUTION_BINDING_ENV.deadlineAt]: root.binding.deadlineAt,
    });
  });
});
