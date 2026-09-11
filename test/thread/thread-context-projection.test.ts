import { describe, expect, it } from "vitest";
import { seedCheckpoint } from "../../src/context/checkpoint";
import type { ContinuityCheckpointV1, ContinuityPin } from "../../src/context/types";
import { seedPinsFromSnapshot } from "../../src/thread/context-types";
import { isThreadError } from "../../src/thread/errors";
import { InMemoryThreadStore } from "../../src/thread/in-memory-thread-store";
import { ThreadService, type ThreadGraphReader } from "../../src/thread/thread-service";
import type { ThreadStore } from "../../src/thread/thread-store";
import { at } from "../support/thread-fixture";

const noGraph: ThreadGraphReader = { async findGraphFor() { return null; } };

function pin(text: string): ContinuityPin {
  return { id: `pin-${text.replaceAll(/\W+/g, "-")}`, text, source: "agent", createdAt: at(5) };
}

function checkpointFor(executionId: string, pins: Partial<Pick<ContinuityCheckpointV1, "decisions" | "openItems">>): ContinuityCheckpointV1 {
  return { ...seedCheckpoint({ executionId, policyHash: "p".repeat(64), objective: null, now: () => at(0) }), ...pins };
}

function harness(options: { store?: ThreadStore; contextMaxBytes?: number } = {}) {
  let tick = 0;
  const now = () => new Date(at(tick++));
  const store = options.store ?? new InMemoryThreadStore({ now });
  const threads = new ThreadService({
    store, graph: noGraph, now,
    ...(options.contextMaxBytes === undefined ? {} : { contextMaxBytes: options.contextMaxBytes }),
  });
  return { store, threads };
}

async function codeOf(operation: () => Promise<unknown>): Promise<string | null> {
  try { await operation(); return null; } catch (error) { if (isThreadError(error)) return error.code; throw error; }
}

describe("ThreadService.projectContext", () => {
  it("projects E-1 into revision 1, links it from the ref, and hands it to E-2", async () => {
    const { threads } = harness();
    const { id } = await threads.createThread({ agentId: "main", workspace: "/project", title: "Fix auth" });
    await threads.reserveRoot(id, "exec_1");
    await threads.settleRoot(id, "exec_1", "completed");
    expect(threads.pendingProjection(await threads.get(id))?.executionId).toBe("exec_1");

    const projected = await threads.projectContext(id, "exec_1", {
      checkpoint: checkpointFor("exec_1", { decisions: [pin("use jwt"), pin("rotate keys")] }),
      runtime: "claude",
    });
    expect(projected.currentContext).toEqual({ revision: 1, digest: expect.stringMatching(/^[0-9a-f]{64}$/), artifact: "context/1.json" });
    expect(projected.executions[0].settled?.nextContextRevision).toBe(1);
    expect(threads.pendingProjection(projected)).toBeNull();
    const snapshot = await threads.currentContext(id);
    expect(snapshot).toMatchObject({
      revision: 1,
      objective: "Fix auth",
      decisions: [{ text: "use jwt", sourceExecutionId: "exec_1" }, { text: "rotate keys", sourceExecutionId: "exec_1" }],
      outcomes: [{ executionId: "exec_1", sequence: 1, outcome: "completed", runtime: "claude" }],
      degraded: false,
    });

    // Chiếu lại là no-op, không sinh rev 2.
    expect((await threads.projectContext(id, "exec_1", { checkpoint: null, runtime: null })).currentContext?.revision).toBe(1);

    const second = await threads.reserveRoot(id, "exec_2");
    expect(second.binding).toEqual({ id, contextRevision: 1, contextDigest: snapshot!.digest });
    expect(second.handoff.snapshot).toEqual(snapshot);
    expect(seedPinsFromSnapshot(second.handoff.snapshot, at(9)).decisions.map((seed) => seed.text)).toEqual(["use jwt", "rotate keys"]);
  });

  it("refuses to project an unsettled or unknown execution", async () => {
    const { threads } = harness();
    const { id } = await threads.createThread({ agentId: "main", workspace: "/project" });
    await threads.reserveRoot(id, "exec_1");
    expect(await codeOf(() => threads.projectContext(id, "exec_1", { checkpoint: null, runtime: null }))).toBe("THREAD_INVARIANT_VIOLATION");
    expect(await codeOf(() => threads.projectContext(id, "exec_9", { checkpoint: null, runtime: null }))).toBe("THREAD_EXECUTION_BINDING_MISMATCH");
  });

  it("recovers from a crash between payload and index: the orphan is swept and the projection runs again", async () => {
    let failCommits = 1;
    const raw = new InMemoryThreadStore();
    const store: ThreadStore = {
      ...raw,
      create: (input) => raw.create(input),
      get: (id) => raw.get(id),
      list: (query) => raw.list(query),
      readPayload: (id, ref) => raw.readPayload(id, ref),
      collectOrphans: (id) => raw.collectOrphans(id),
      withExclusiveLease: (id, operation) => raw.withExclusiveLease(id, (lease) => operation({
        ...lease,
        threadId: lease.threadId,
        current: () => lease.current(),
        writePayload: (kind, name, body) => lease.writePayload(kind, name, body),
        commit: async (next) => {
          if (next.currentContext !== null && failCommits-- > 0) throw new Error("power loss");
          return lease.commit(next);
        },
      })),
    };
    const { threads } = harness({ store });
    const { id } = await threads.createThread({ agentId: "main", workspace: "/project" });
    await threads.reserveRoot(id, "exec_1");
    await threads.settleRoot(id, "exec_1", "completed");

    await expect(threads.projectContext(id, "exec_1", { checkpoint: null, runtime: "codex" })).rejects.toThrow("power loss");
    // Vẫn pending; payload mồ côi nằm đó.
    expect(threads.pendingProjection(await threads.get(id))?.executionId).toBe("exec_1");
    expect(await codeOf(() => threads.reserveRoot(id, "exec_2"))).toBe("THREAD_INVARIANT_VIOLATION");

    const projected = await threads.projectContext(id, "exec_1", { checkpoint: null, runtime: "codex" });
    expect(projected.currentContext?.revision).toBe(1);
    expect(raw.quarantined(id)).toEqual(["context/1.json"]);
    expect((await threads.currentContext(id))?.degraded).toBe(true);
  });

  it("refuses a tampered snapshot instead of rebuilding or accepting it", async () => {
    const raw = new InMemoryThreadStore();
    const { threads } = harness({ store: raw });
    const { id } = await threads.createThread({ agentId: "main", workspace: "/project" });
    await threads.reserveRoot(id, "exec_1");
    await threads.settleRoot(id, "exec_1", "completed");
    await threads.projectContext(id, "exec_1", { checkpoint: checkpointFor("exec_1", { decisions: [pin("use jwt")] }), runtime: "claude" });

    const snapshot = await raw.readPayload(id, "context/1.json") as { decisions: { text: string }[] };
    raw.overwritePayload(id, "context/1.json", { ...snapshot, decisions: [{ ...snapshot.decisions[0], text: "use basic auth" }] });

    expect(await codeOf(() => threads.currentContext(id))).toBe("THREAD_CONTEXT_TAMPERED");
    expect(await codeOf(() => threads.reserveRoot(id, "exec_2"))).toBe("THREAD_CONTEXT_TAMPERED");
    expect((await threads.get(id)).executions).toHaveLength(1);
  });

  it("records a compaction when the budget forces lines out", async () => {
    const raw = new InMemoryThreadStore();
    const { threads } = harness({ contextMaxBytes: 900, store: raw });
    const { id } = await threads.createThread({ agentId: "main", workspace: "/project" });
    const many = Array.from({ length: 12 }, (_, index) => pin(`open item ${index} ${"x".repeat(60)}`));
    await threads.reserveRoot(id, "exec_1");
    await threads.settleRoot(id, "exec_1", "completed");
    await threads.projectContext(id, "exec_1", { checkpoint: checkpointFor("exec_1", { openItems: many }), runtime: "claude" });
    await threads.reserveRoot(id, "exec_2");
    await threads.settleRoot(id, "exec_2", "completed");
    const projected = await threads.projectContext(id, "exec_2", { checkpoint: checkpointFor("exec_2", { openItems: [pin("newest")] }), runtime: "codex" });

    expect(projected.compactions).toEqual([{
      id: "compaction-2", fromRevision: 1, toRevision: 2, droppedCount: expect.any(Number),
      fromMessageSequence: 0, toMessageSequence: 0,
      artifact: "compactions/compaction-2.json", createdAt: expect.any(String),
    }]);
    expect(projected.compactions[0].droppedCount).toBeGreaterThan(0);
    // Record đầy đủ provenance (P4): đầu vào là digest rev 1, đầu ra là rev 2 — cả hai kiểm được.
    const previous = await raw.readPayload(id, "context/1.json") as { digest: string };
    expect(await raw.readPayload(id, "compactions/compaction-2.json")).toMatchObject({
      version: 1, id: "compaction-2", threadId: id, strategy: "deterministic",
      fromRevision: 1, toRevision: 2, fromMessageSequence: 0, toMessageSequence: 0,
      inputDigest: previous.digest, outputContextRevision: 2, outputContextDigest: projected.currentContext!.digest,
    });
    const snapshot = await threads.currentContext(id);
    expect(snapshot?.openItems.at(-1)).toMatchObject({ text: "newest", sourceExecutionId: "exec_2" });
    expect(snapshot!.openItems.length).toBeLessThan(13);
  });
});
