import { describe, expect, it } from "vitest";
import { agentRegistry } from "../../src/agents/registry";
import { runMainSession } from "../../src/cli/commands/run-main";
import type { ExecutionGraphLease, ExecutionGraphStore } from "../../src/execution/graph/execution-graph-store";
import { ExecutionGraphService } from "../../src/execution/graph/execution-graph-service";
import { InMemoryExecutionGraphStore } from "../../src/execution/graph/in-memory-execution-graph-store";
import type { ExecutionGraphDocument, ExecutionNode } from "../../src/execution/graph/types";
import type { MaterializeExecutionInput } from "../../src/execution/types";
import { isThreadError } from "../../src/thread/errors";
import { InMemoryThreadStore } from "../../src/thread/in-memory-thread-store";
import { isRootThreadExecution, ThreadService, type ThreadGraphReader } from "../../src/thread/thread-service";
import type { ThreadLease, ThreadStore } from "../../src/thread/thread-store";
import { EMPTY_THREAD_CONTEXT_DIGEST, type ThreadId } from "../../src/thread/types";
import { at, digest, THREAD_BASE_TIME } from "../support/thread-fixture";

async function codeOf(operation: () => Promise<unknown>): Promise<string | null> {
  try {
    await operation();
    return null;
  } catch (error) {
    if (isThreadError(error)) return error.code;
    throw error;
  }
}

/** Graph giả, chỉ đọc: Thread chỉ hỏi "root này còn sống không". */
function graphReader(nodes: Record<string, Partial<ExecutionNode>> = {}): ThreadGraphReader {
  return {
    async findGraphFor(executionId) {
      const node = nodes[executionId];
      if (!node) return null;
      return {
        graphId: executionId,
        rootExecutionId: executionId,
        nodes: [{ executionId, parentExecutionId: null, status: "running", thread: null, ...node }],
      } as unknown as ExecutionGraphDocument;
    },
  };
}

function service(options: { graph?: ThreadGraphReader; tick?: number } = {}) {
  let tick = options.tick ?? 0;
  const now = () => new Date(at(tick++));
  const store = new InMemoryThreadStore({ now });
  return { store, threads: new ThreadService({ store, graph: options.graph ?? graphReader(), now }) };
}

async function threadWith(threads: ThreadService, title: string | null = null): Promise<ThreadId> {
  return (await threads.createThread({ agentId: "main", workspace: "/project", title })).id;
}

describe("ThreadService — root lifecycle", () => {
  it("reserves root #1 against the empty context and returns the binding that goes into graph and policy", async () => {
    const { threads } = service();
    const id = await threadWith(threads);
    const reserved = await threads.reserveRoot(id, "exec_1");

    expect(reserved.ref).toEqual({
      executionId: "exec_1",
      sequence: 1,
      contextRevision: 0,
      contextDigest: EMPTY_THREAD_CONTEXT_DIGEST,
      reservedAt: at(1),
      settled: null,
    });
    expect(reserved.binding).toEqual({ id, contextRevision: 0, contextDigest: EMPTY_THREAD_CONTEXT_DIGEST });
    expect(Object.isFrozen(reserved.binding)).toBe(true);
    expect(reserved.thread.revision).toBe(2);
    expect(reserved.thread.executions).toEqual([reserved.ref]);
  });

  it("refuses a second root while the first is unsettled, naming the execution in the way", async () => {
    const { threads } = service();
    const id = await threadWith(threads);
    await threads.reserveRoot(id, "exec_1");

    await expect(threads.reserveRoot(id, "exec_2")).rejects.toMatchObject({
      code: "THREAD_BUSY",
      executionId: "exec_1",
    });
    expect((await threads.get(id)).executions).toHaveLength(1);
  });

  it("numbers roots consecutively across settlements, each against the context it saw", async () => {
    const { threads } = service();
    const id = await threadWith(threads);
    await threads.reserveRoot(id, "exec_1");
    await threads.settleRoot(id, "exec_1", "completed");
    expect((await threads.get(id)).executions[0].settled).toEqual({ outcome: "completed", finishedAt: at(2), nextContextRevision: null });

    // Settled nhưng chưa chiếu: root tiếp theo sẽ đứng trên một context thiếu E-1 → từ chối.
    expect(await codeOf(() => threads.reserveRoot(id, "exec_2"))).toBe("THREAD_INVARIANT_VIOLATION");
    await threads.projectContext(id, "exec_1", { checkpoint: null, runtime: "claude" });
    const second = await threads.reserveRoot(id, "exec_2");

    expect(second.ref.sequence).toBe(2);
    expect(second.binding).toMatchObject({ id, contextRevision: 1 });
    expect(second.handoff).toMatchObject({ threadId: id, sequence: 2, snapshot: { revision: 1, degraded: true } });
    const thread = await threads.get(id);
    expect(thread.executions.map((ref) => [ref.executionId, ref.sequence, ref.settled?.outcome ?? null])).toEqual([
      ["exec_1", 1, "completed"],
      ["exec_2", 2, null],
    ]);
    expect(thread.executions[0].settled?.nextContextRevision).toBe(1);
  });

  it("settles once: a later outcome for the same execution is ignored, not overwritten", async () => {
    const { threads } = service();
    const id = await threadWith(threads);
    await threads.reserveRoot(id, "exec_1");
    const first = await threads.settleRoot(id, "exec_1", "failed");
    const again = await threads.settleRoot(id, "exec_1", "completed");

    expect(again.revision).toBe(first.revision);
    expect(again.executions[0].settled?.outcome).toBe("failed");
  });

  it("refuses to settle an execution the thread never reserved", async () => {
    const { threads } = service();
    const id = await threadWith(threads);
    expect(await codeOf(() => threads.settleRoot(id, "exec_ghost", "completed"))).toBe("THREAD_EXECUTION_BINDING_MISMATCH");
    expect(await codeOf(() => threads.settleRoot(id, "exec_ghost", "exploded" as never))).toBe("THREAD_INVARIANT_VIOLATION");
    expect(await codeOf(() => threads.reserveRoot("thread_missing", "exec_1"))).toBe("THREAD_NOT_FOUND");
  });

  it("closes and archives only a settled thread, and never reopens", async () => {
    const { threads } = service();
    const id = await threadWith(threads);
    await threads.reserveRoot(id, "exec_1");

    expect(await codeOf(() => threads.close(id))).toBe("THREAD_BUSY");
    expect(await codeOf(() => threads.archive(id))).toBe("THREAD_INVARIANT_VIOLATION");
    await threads.settleRoot(id, "exec_1", "completed");

    expect((await threads.close(id)).status).toBe("closed");
    expect((await threads.close(id)).status).toBe("closed");
    expect(await codeOf(() => threads.reserveRoot(id, "exec_2"))).toBe("THREAD_CLOSED");

    expect((await threads.archive(id)).status).toBe("archived");
    expect((await threads.archive(id)).status).toBe("archived");
    expect(await codeOf(() => threads.reserveRoot(id, "exec_2"))).toBe("THREAD_ARCHIVED");
    expect(await codeOf(() => threads.close(id))).toBe("THREAD_ARCHIVED");
  });

  it("lists what the store lists", async () => {
    const { threads } = service();
    const id = await threadWith(threads, "Fix auth");
    expect((await threads.list({ workspace: "/project" })).map((summary) => [summary.id, summary.title])).toEqual([[id, "Fix auth"]]);
  });
});

describe("ThreadService — derived views", () => {
  it("derives activity from the unsettled ref and what the graph says about its root", async () => {
    const graph: Record<string, Partial<ExecutionNode>> = {};
    const { threads } = service({ graph: graphReader(graph) });
    const id = await threadWith(threads);
    expect(await threads.activity(id)).toEqual({ kind: "idle" });

    await threads.reserveRoot(id, "exec_1");
    // Reserve xong, graph chưa có: đang preparing hoặc đã chết giữa chừng — cần reconcile.
    expect(await threads.activity(id)).toEqual({ kind: "unsettled", executionId: "exec_1" });

    graph.exec_1 = { status: "running" };
    expect(await threads.activity(id)).toEqual({ kind: "running", executionId: "exec_1" });

    graph.exec_1 = { status: "completed" };
    expect(await threads.activity(id)).toEqual({ kind: "unsettled", executionId: "exec_1" });

    await threads.settleRoot(id, "exec_1", "completed");
    expect(await threads.activity(id)).toEqual({ kind: "idle" });
  });

  it("describes an execution only when thread ref and graph node agree on the binding", async () => {
    const graph: Record<string, Partial<ExecutionNode>> = {};
    const { threads } = service({ graph: graphReader(graph) });
    const id = await threadWith(threads);
    const other = await threadWith(threads);
    const reserved = await threads.reserveRoot(id, "exec_1");
    graph.exec_1 = { thread: reserved.binding };

    const described = await threads.describeExecution(id, "exec_1");
    expect(described.ref).toEqual(reserved.ref);
    expect(described.node.thread).toEqual(reserved.binding);

    // Gắn execution của Thread A vào Thread B: B không có ref.
    expect(await codeOf(() => threads.describeExecution(other, "exec_1"))).toBe("THREAD_EXECUTION_BINDING_MISMATCH");
    // Node nói Thread khác.
    graph.exec_1 = { thread: { ...reserved.binding, id: other } };
    expect(await codeOf(() => threads.describeExecution(id, "exec_1"))).toBe("THREAD_EXECUTION_BINDING_MISMATCH");
    // Node nói context khác.
    graph.exec_1 = { thread: { ...reserved.binding, contextRevision: 1, contextDigest: digest("rev-1") } };
    expect(await codeOf(() => threads.describeExecution(id, "exec_1"))).toBe("THREAD_EXECUTION_BINDING_MISMATCH");
    // Node không có binding (legacy) hoặc là child.
    graph.exec_1 = { thread: null };
    expect(await codeOf(() => threads.describeExecution(id, "exec_1"))).toBe("THREAD_EXECUTION_BINDING_MISMATCH");
    graph.exec_1 = { thread: reserved.binding, parentExecutionId: "exec_0" };
    expect(await codeOf(() => threads.describeExecution(id, "exec_1"))).toBe("THREAD_EXECUTION_BINDING_MISMATCH");
    // Không có graph.
    delete graph.exec_1;
    expect(await codeOf(() => threads.describeExecution(id, "exec_1"))).toBe("THREAD_EXECUTION_BINDING_MISMATCH");
  });

  it("tells a thread root apart by shape, not by agent", () => {
    const binding = { id: "thread_a", contextRevision: 0, contextDigest: EMPTY_THREAD_CONTEXT_DIGEST };
    const node = (overrides: Partial<ExecutionNode>) => ({ agentId: "main", ...overrides }) as ExecutionNode;
    expect(isRootThreadExecution(node({ parentExecutionId: null, thread: binding }))).toBe(true);
    expect(isRootThreadExecution(node({ parentExecutionId: null, thread: null }))).toBe(false);
    expect(isRootThreadExecution(node({ parentExecutionId: "exec_p", thread: binding }))).toBe(false);
    expect(isRootThreadExecution(node({ parentExecutionId: "exec_p", thread: binding, agentId: "worker" }))).toBe(false);
  });
});

/**
 * Nguyên tắc 5: Thread lease và graph lease không bao giờ lồng nhau. Hai store dưới đây đếm
 * lease đang giữ; bất kỳ lúc nào cả hai cùng > 0 là một deadlock đang chờ xảy ra khi hai CLI
 * đi hai chiều ngược nhau.
 */
describe("ThreadService — lock order", () => {
  it("never holds a thread lease and a graph lease at the same time across a whole root run", async () => {
    const held = { thread: 0, graph: 0 };
    const violations: string[] = [];
    const observe = (kind: keyof typeof held, phase: string) => {
      if (held.thread > 0 && held.graph > 0) violations.push(`${phase}: thread=${held.thread} graph=${held.graph}`);
      void kind;
    };

    const rawThreads = new InMemoryThreadStore();
    const threadStore: ThreadStore = {
      create: (input) => rawThreads.create(input),
      get: (id) => rawThreads.get(id),
      list: (query) => rawThreads.list(query),
      collectOrphans: (id) => rawThreads.collectOrphans(id),
      readPayload: (id, ref) => rawThreads.readPayload(id, ref),
      async withExclusiveLease<T>(id: ThreadId, operation: (lease: ThreadLease) => Promise<T>): Promise<T> {
        return rawThreads.withExclusiveLease(id, async (lease) => {
          held.thread += 1;
          observe("thread", "thread-acquire");
          try {
            return await operation(lease);
          } finally {
            held.thread -= 1;
          }
        });
      },
    };
    const rawGraphs = new InMemoryExecutionGraphStore();
    const graphStore: ExecutionGraphStore = {
      create: (graph) => rawGraphs.create(graph),
      get: (id) => rawGraphs.get(id),
      findByExecutionId: (id) => rawGraphs.findByExecutionId(id),
      async withExclusiveLease<T>(graphId: string, operation: (lease: ExecutionGraphLease) => Promise<T>): Promise<T> {
        return rawGraphs.withExclusiveLease(graphId, async (lease) => {
          held.graph += 1;
          observe("graph", "graph-acquire");
          try {
            return await operation(lease);
          } finally {
            held.graph -= 1;
          }
        });
      },
    };

    const graph = new ExecutionGraphService({ store: graphStore });
    const threads = new ThreadService({ store: threadStore, graph: { findGraphFor: (id) => graph.findGraphFor(id) } });
    const events: string[] = [];
    let materialized: MaterializeExecutionInput | undefined;

    const result = await runMainSession({ cwd: "/project", mode: "medium" }, {
      registry: agentRegistry,
      selector: { async select(input) { return { ok: true, mode: input.requestedMode!, source: "explicit" }; } },
      executionService: {
        async authorize(input) { return { executionId: input.executionId } as never; },
        async materialize(_authorization, input) {
          materialized = input;
          observe("thread", "materialize");
          return {
            capsule: { executionId: "exec_root" },
            policy: { model: "claude-opus-5", reasoningEffort: "high", runtime: "claude", thread: input.thread },
          } as never;
        },
      },
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
        async spawn(input) {
          events.push("spawn");
          observe("graph", "spawn");
          return { executionId: input.executionId, status: "running" };
        },
        async status(executionId) { return { executionId, status: "running" }; },
        async wait(executionId) { events.push("wait"); return { executionId, status: "completed" }; },
        async cancel(executionId) { return { executionId, status: "cancelled" }; },
        async cleanup() {},
      },
      executionId: () => "exec_root",
      interactive: false,
    });

    expect(result.status).toBe("completed");
    expect(violations).toEqual([]);
    expect(events).toEqual(["spawn", "wait"]);

    const [summary] = await threads.list({ workspace: "/project" });
    const thread = await threads.get(summary.id);
    expect(thread.executions.map((ref) => [ref.executionId, ref.settled?.outcome])).toEqual([["exec_root", "completed"]]);
    // Cùng một binding ở cả ba nơi: ref Thread, graph node, input của policy.
    const node = (await graph.findGraphFor("exec_root"))?.nodes[0];
    expect(node?.thread).toEqual({ id: summary.id, contextRevision: 0, contextDigest: EMPTY_THREAD_CONTEXT_DIGEST });
    expect(materialized?.thread).toEqual(node?.thread);
    expect(await threads.activity(summary.id)).toEqual({ kind: "idle" });
    expect((await threads.describeExecution(summary.id, "exec_root")).node.status).toBe("completed");
    void THREAD_BASE_TIME;
  });
});
