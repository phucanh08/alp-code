import { describe, expect, it } from "vitest";
import type { UsageCounters } from "../../src/execution/usage";
import { isThreadError } from "../../src/thread/errors";
import { HistoryBridgeRegistry, type RuntimeHistoryBridge } from "../../src/thread/history-bridge";
import type { CollectedEntry, ThreadEntry } from "../../src/thread/history-types";
import { assertThreadDocument } from "../../src/thread/invariants";
import { InMemoryThreadStore } from "../../src/thread/in-memory-thread-store";
import { ThreadService, type ThreadGraphReader } from "../../src/thread/thread-service";
import { at, executionRef, threadFixture } from "../support/thread-fixture";

/**
 * Oracle: plan P6 §"Thread" — root cộng dồn `usageDelta` của từng lần collect lên
 * `history.usage`, đi cùng cursor dưới cùng một lease nên không đếm đôi; boundary mang tổng
 * lúc nó được ghi; `null` cột giữ `null`; validator từ chối cột không phải số nguyên ≥ 0.
 */
const noGraph: ThreadGraphReader = { async findGraphFor() { return null; } };
const counters = (partial: Partial<UsageCounters>): UsageCounters =>
  ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0, ...partial });

interface Slice { readonly entries: readonly CollectedEntry[]; readonly usage: UsageCounters | null }

/** Bridge giả trả từng lát theo thứ tự gọi; cursor tiến theo số entry đã trả. */
function slicedBridge(slices: readonly Slice[]): RuntimeHistoryBridge {
  let call = 0;
  return {
    runtime: "claude",
    probe: async () => ({ completeness: "complete", pinnedVersion: "9.9" }),
    collectDelta: async (input) => {
      const slice = slices[call++] ?? { entries: [], usage: null };
      const offset = input.cursor?.lineOffset ?? 0;
      return {
        entries: slice.entries,
        cursor: { transcriptPath: "/state/claude.jsonl", lineOffset: offset + slice.entries.length, lastNativeId: slice.entries.at(-1)?.nativeId ?? input.cursor?.lastNativeId ?? null },
        completeness: "complete",
        pinnedVersion: "9.9",
        skipped: 0,
        usageDelta: slice.usage,
      };
    },
  };
}

function harness(slices: readonly Slice[]) {
  let tick = 0;
  const now = () => new Date(at(tick++));
  const store = new InMemoryThreadStore({ now });
  const threads = new ThreadService({ store, graph: noGraph, now, history: new HistoryBridgeRegistry([slicedBridge(slices)]) });
  return { store, threads };
}
const source = { executionId: "exec_1", runtime: "claude" as const, workspace: "/project", contextDirectory: "/exec/exec_1/context" };
const user = (nativeId: string, second: number): CollectedEntry => ({ kind: "user", nativeId, createdAt: at(second), text: "…" });

describe("ThreadService.collectHistory usage", () => {
  it("accumulates each slice once and stamps the boundary with the total at settle", async () => {
    const { threads, store } = harness([
      { entries: [user("u1", 1)], usage: counters({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, toolCalls: 1 }) },
      { entries: [user("u2", 2)], usage: counters({ inputTokens: 3, outputTokens: 2, cacheReadTokens: 50 }) },
    ]);
    const { id } = await threads.createThread({ agentId: "main", workspace: "/project" });
    await threads.reserveRoot(id, "exec_1");
    const running = await threads.collectHistory(id, source);
    expect(running.executions[0].history?.usage).toEqual(counters({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, toolCalls: 1 }));
    expect(running.messages.map((ref) => ref.kind)).toEqual(["user"]);

    await threads.settleRoot(id, "exec_1", "completed");
    const settled = await threads.collectHistory(id, source);
    const total = counters({ inputTokens: 13, outputTokens: 7, cacheReadTokens: 150, toolCalls: 1 });
    expect(settled.executions[0].history).toMatchObject({ entryCount: 2, usage: total, cursor: { lineOffset: 2 } });
    const boundary = await store.readPayload(id, settled.messages.at(-1)!.artifact) as ThreadEntry;
    expect(boundary).toMatchObject({ kind: "boundary", collected: 2, usage: total });
  });

  it("commits a slice that brings numbers but no entries, and skips the commit when it brings neither", async () => {
    const { threads } = harness([
      { entries: [user("u1", 1)], usage: counters({ outputTokens: 1 }) },
      { entries: [], usage: counters({ outputTokens: 4 }) },
      { entries: [], usage: null },
    ]);
    const { id } = await threads.createThread({ agentId: "main", workspace: "/project" });
    await threads.reserveRoot(id, "exec_1");
    await threads.settleRoot(id, "exec_1", "completed");
    const first = await threads.collectHistory(id, source);
    const second = await threads.collectHistory(id, source);
    expect(second.revision).toBe(first.revision + 1);
    expect(second.executions[0].history?.usage).toEqual(counters({ outputTokens: 5 }));
    const third = await threads.collectHistory(id, source);
    expect(third.revision).toBe(second.revision);
    expect(third.executions[0].history?.usage).toEqual(counters({ outputTokens: 5 }));
  });

  it("keeps a column unknown forever once one slice could not read it", async () => {
    const { threads } = harness([
      { entries: [user("u1", 1)], usage: counters({ inputTokens: 10 }) },
      { entries: [user("u2", 2)], usage: counters({ inputTokens: null, outputTokens: 2 }) },
      { entries: [user("u3", 3)], usage: counters({ inputTokens: 4, outputTokens: 1 }) },
    ]);
    const { id } = await threads.createThread({ agentId: "main", workspace: "/project" });
    await threads.reserveRoot(id, "exec_1");
    await threads.collectHistory(id, source);
    await threads.collectHistory(id, source);
    const thread = await threads.collectHistory(id, source);
    expect(thread.executions[0].history?.usage).toEqual(counters({ inputTokens: null, outputTokens: 3 }));
  });

  it("leaves usage null when no slice ever carried numbers", async () => {
    const { threads } = harness([{ entries: [user("u1", 1)], usage: null }]);
    const { id } = await threads.createThread({ agentId: "main", workspace: "/project" });
    await threads.reserveRoot(id, "exec_1");
    const thread = await threads.collectHistory(id, source);
    expect(thread.executions[0].history?.usage).toBeNull();
  });
});

describe("thread invariants on history.usage", () => {
  const history = (usage: unknown) => ({
    completeness: "complete" as const, pinnedVersion: "9.9", cursor: null, entryCount: 0, skipped: 0, collectedAt: at(1), usage,
  } as never);
  const codeOf = (fn: () => unknown): string | null => {
    try { fn(); return null; } catch (error) { return isThreadError(error) ? error.code : "other"; }
  };

  it("accepts absent, null, and integer-or-null columns; refuses anything else", () => {
    const ok = (usage: unknown) => codeOf(() => assertThreadDocument(threadFixture({ executions: [executionRef("exec_1", 1, { history: history(usage) })] })));
    expect(ok(undefined)).toBeNull();
    expect(ok(null)).toBeNull();
    expect(ok(counters({ inputTokens: null }))).toBeNull();
    expect(ok(counters({ inputTokens: 1.5 }))).toBe("THREAD_INVARIANT_VIOLATION");
    expect(ok(counters({ toolCalls: -1 }))).toBe("THREAD_INVARIANT_VIOLATION");
    expect(ok(counters({ outputTokens: "2" as unknown as number }))).toBe("THREAD_INVARIANT_VIOLATION");
    expect(ok({ inputTokens: 1 })).toBe("THREAD_INVARIANT_VIOLATION");
    expect(ok("lots")).toBe("THREAD_INVARIANT_VIOLATION");
  });
});
