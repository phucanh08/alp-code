import { describe, expect, it } from "vitest";
import type { ExecutionGraphDocument, ExecutionNode, ExecutionNodeStatus } from "../../src/execution/graph/types";
import { InMemoryThreadStore } from "../../src/thread/in-memory-thread-store";
import { ThreadService, type ThreadGraphReader } from "../../src/thread/thread-service";
import type { ThreadLease, ThreadStore } from "../../src/thread/thread-store";
import { at } from "../support/thread-fixture";

const TTL_MS = 2 * 60 * 1_000;

/**
 * Graph giả có hai mặt: `findGraphFor` trả trạng thái đang lưu, `reconcile` hỏi "backend" (một
 * map trạng thái thật) rồi ghi lại — đúng hình dạng `ExecutionGraphService.reconcile`.
 */
function fakeGraph(options: {
  readonly stored?: Record<string, ExecutionNodeStatus>;
  readonly backend?: Record<string, ExecutionNodeStatus>;
} = {}) {
  const stored = new Map(Object.entries(options.stored ?? {}));
  const backend = new Map(Object.entries(options.backend ?? {}));
  const calls: string[] = [];
  const document = (executionId: string): ExecutionGraphDocument => ({
    graphId: `graph_${executionId}`,
    rootExecutionId: executionId,
    nodes: [{ executionId, parentExecutionId: null, status: stored.get(executionId), thread: null } as unknown as ExecutionNode],
  } as unknown as ExecutionGraphDocument);
  const reader: ThreadGraphReader = {
    async findGraphFor(executionId) {
      calls.push(`find:${executionId}`);
      return stored.has(executionId) ? document(executionId) : null;
    },
    async reconcile(graphId) {
      calls.push(`reconcile:${graphId}`);
      const executionId = graphId.slice("graph_".length);
      const truth = backend.get(executionId);
      if (truth !== undefined) stored.set(executionId, truth);
      return document(executionId);
    },
  };
  return { reader, calls, stored };
}

function harness(options: {
  readonly graph?: ThreadGraphReader;
  readonly store?: ThreadStore;
  readonly tick?: number;
} = {}) {
  let tick = options.tick ?? 0;
  const clock = { now: () => new Date(at(tick++)), jump(seconds: number) { tick += seconds; } };
  const store = options.store ?? new InMemoryThreadStore({ now: clock.now });
  const threads = new ThreadService({
    store,
    graph: options.graph ?? fakeGraph().reader,
    now: clock.now,
    reservationTtlMs: TTL_MS,
  });
  return { threads, clock, store };
}

async function reservedThread(threads: ThreadService, executionId = "exec_1") {
  const { id } = await threads.createThread({ agentId: "main", workspace: "/project" });
  await threads.reserveRoot(id, executionId);
  return id;
}

describe("ThreadService.reconcile", () => {
  it("leaves a fresh reservation without a graph alone — the root may still be preparing", async () => {
    const graph = fakeGraph();
    const { threads } = harness({ graph: graph.reader });
    const id = await reservedThread(threads);

    const thread = await threads.reconcile(id);
    expect(thread.executions[0].settled).toBeNull();
    expect(await threads.activity(id)).toEqual({ kind: "unsettled", executionId: "exec_1" });
  });

  it("settles a reservation that never produced a graph as interrupted once the TTL has passed", async () => {
    const graph = fakeGraph();
    const { threads, clock } = harness({ graph: graph.reader });
    const id = await reservedThread(threads);

    clock.jump(TTL_MS / 1_000 + 1);
    const thread = await threads.reconcile(id);
    expect(thread.executions[0].settled).toMatchObject({ outcome: "interrupted", nextContextRevision: null });
    expect(await threads.activity(id)).toEqual({ kind: "idle" });
    // Đã settled thì không probe thêm — reconcile lần hai là no-op.
    const again = await threads.reconcile(id);
    expect(again.revision).toBe(thread.revision);
  });

  it.each([
    ["completed", "completed"],
    ["failed", "failed"],
    ["cancelled", "cancelled"],
    ["interrupted", "interrupted"],
  ] as const)("copies a terminal root (%s) into the thread without asking the backend", async (status, outcome) => {
    const graph = fakeGraph({ stored: { exec_1: status } });
    const { threads } = harness({ graph: graph.reader });
    const id = await reservedThread(threads);

    const thread = await threads.reconcile(id);
    expect(thread.executions[0].settled).toMatchObject({ outcome });
    expect(graph.calls).toEqual(["find:exec_1"]);
  });

  it("asks the graph to probe the backend for an active root, and keeps the ref when it is still alive", async () => {
    const graph = fakeGraph({ stored: { exec_1: "running" }, backend: { exec_1: "running" } });
    const { threads } = harness({ graph: graph.reader });
    const id = await reservedThread(threads);

    const thread = await threads.reconcile(id);
    expect(thread.executions[0].settled).toBeNull();
    expect(graph.calls).toEqual(["find:exec_1", "reconcile:graph_exec_1"]);
    expect(await threads.activity(id)).toEqual({ kind: "running", executionId: "exec_1" });
  });

  it("settles from the probed status when the backend says the process is gone", async () => {
    // Graph còn ghi `running` từ process đã chết; backend là truth.
    const graph = fakeGraph({ stored: { exec_1: "running" }, backend: { exec_1: "failed" } });
    const { threads } = harness({ graph: graph.reader });
    const id = await reservedThread(threads);

    const thread = await threads.reconcile(id);
    expect(thread.executions[0].settled).toMatchObject({ outcome: "failed" });
    expect(graph.stored.get("exec_1")).toBe("failed");
  });

  it("is monotonic: a settle that lands during the probe wins over the reconcile intent", async () => {
    const graph = fakeGraph({ stored: { exec_1: "running" }, backend: { exec_1: "interrupted" } });
    let threads!: ThreadService;
    const racing: ThreadGraphReader = {
      findGraphFor: (executionId) => graph.reader.findGraphFor(executionId),
      async reconcile(graphId) {
        // Trong lúc backend được hỏi, process thật kịp ghi kết cục của chính nó.
        await threads.settleRoot(id, "exec_1", "completed");
        return graph.reader.reconcile!(graphId);
      },
    };
    ({ threads } = harness({ graph: racing }));
    const id = await reservedThread(threads);

    const thread = await threads.reconcile(id);
    expect(thread.executions[0].settled).toMatchObject({ outcome: "completed" });
  });

  it("never holds the thread lease while it talks to the graph", async () => {
    const raw = new InMemoryThreadStore();
    let held = 0;
    const violations: string[] = [];
    const store: ThreadStore = {
      create: (input) => raw.create(input),
      get: (id) => raw.get(id),
      list: (query) => raw.list(query),
      collectOrphans: (id) => raw.collectOrphans(id),
      readPayload: (id, ref) => raw.readPayload(id, ref),
      withExclusiveLease: async (id, operation) => raw.withExclusiveLease(id, async (lease: ThreadLease) => {
        held += 1;
        try {
          return await operation(lease);
        } finally {
          held -= 1;
        }
      }),
    };
    const inner = fakeGraph({ stored: { exec_1: "running" }, backend: { exec_1: "completed" } });
    const graph: ThreadGraphReader = {
      async findGraphFor(executionId) {
        if (held > 0) violations.push(`findGraphFor under lease (${executionId})`);
        return inner.reader.findGraphFor(executionId);
      },
      async reconcile(graphId) {
        if (held > 0) violations.push(`reconcile under lease (${graphId})`);
        return inner.reader.reconcile!(graphId);
      },
    };
    const { threads } = harness({ graph, store });
    const id = await reservedThread(threads);

    await threads.reconcile(id);
    await threads.activity(id);
    expect(violations).toEqual([]);
  });

  it("reports the unsettled execution and leaves the document untouched when the thread is idle", async () => {
    const { threads } = harness();
    const { id } = await threads.createThread({ agentId: "main", workspace: "/project" });
    const before = await threads.get(id);
    expect(await threads.reconcile(id)).toEqual(before);
    await expect(threads.reconcile("thread_missing")).rejects.toMatchObject({ code: "THREAD_NOT_FOUND" });
  });
});
