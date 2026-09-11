import { describe, expect, it } from "vitest";
import { HistoryBridgeRegistry, type CollectDeltaInput, type RuntimeHistoryBridge } from "../../src/thread/history-bridge";
import type { CollectedEntry, HistoryDelta, ThreadEntry } from "../../src/thread/history-types";
import { InMemoryThreadStore } from "../../src/thread/in-memory-thread-store";
import { ThreadService, type ThreadGraphReader } from "../../src/thread/thread-service";
import { at } from "../support/thread-fixture";

const noGraph: ThreadGraphReader = { async findGraphFor() { return null; } };

function user(nativeId: string, text: string, second: number): CollectedEntry {
  return { kind: "user", nativeId, createdAt: at(second), text };
}
function assistant(nativeId: string, text: string, second: number): CollectedEntry {
  return { kind: "assistant", nativeId, createdAt: at(second), text };
}

/**
 * Bridge giả: trả cả transcript từ đầu khi cursor null, phần sau `lineOffset` khi có cursor —
 * đúng hợp đồng của bridge thật, nhưng nội dung do test đặt.
 */
function scriptedBridge(runtime: "claude" | "codex", script: readonly CollectedEntry[], options: { completeness?: HistoryDelta["completeness"]; calls?: CollectDeltaInput[] } = {}): RuntimeHistoryBridge {
  return {
    runtime,
    probe: async () => ({ completeness: options.completeness ?? "complete", pinnedVersion: "9.9" }),
    collectDelta: async (input) => {
      options.calls?.push(input);
      const offset = input.cursor?.transcriptPath === `/state/${runtime}.jsonl` ? input.cursor.lineOffset : 0;
      const entries = script.slice(offset);
      return {
        entries,
        cursor: { transcriptPath: `/state/${runtime}.jsonl`, lineOffset: script.length, lastNativeId: entries.at(-1)?.nativeId ?? input.cursor?.lastNativeId ?? null },
        completeness: options.completeness ?? "complete",
        pinnedVersion: "9.9",
        skipped: 0,
      };
    },
  };
}

function harness(bridges: readonly RuntimeHistoryBridge[]) {
  let tick = 0;
  const now = () => new Date(at(tick++));
  const store = new InMemoryThreadStore({ now });
  const threads = new ThreadService({ store, graph: noGraph, now, history: new HistoryBridgeRegistry(bridges) });
  return { store, threads };
}

const source = (executionId: string, runtime: "claude" | "codex" | null) => ({ executionId, runtime, workspace: "/project", contextDirectory: `/exec/${executionId}/context` });

describe("ThreadService.collectHistory", () => {
  it("mirrors the delta in transcript order, writes each entry once, and appends one boundary after settle", async () => {
    const script = [user("u1", "hello", 1), assistant("a1", "hi", 2), user("u2", "do it", 3)];
    const { threads, store } = harness([scriptedBridge("claude", script)]);
    const { id } = await threads.createThread({ agentId: "main", workspace: "/project" });
    await threads.reserveRoot(id, "exec_1");
    await threads.settleRoot(id, "exec_1", "completed");

    const thread = await threads.collectHistory(id, source("exec_1", "claude"));
    expect(thread.messages.map((ref) => [ref.sequence, ref.kind, ref.id, ref.artifact])).toEqual([
      [1, "user", "exec_1:u1", "messages/1.json"],
      [2, "assistant", "exec_1:a1", "messages/2.json"],
      [3, "user", "exec_1:u2", "messages/3.json"],
      [4, "boundary", expect.stringMatching(/^exec_1:boundary-/), "messages/4.json"],
    ]);
    expect(thread.executions[0].history).toEqual({
      completeness: "complete", pinnedVersion: "9.9",
      cursor: { transcriptPath: "/state/claude.jsonl", lineOffset: 3, lastNativeId: "u2" },
      entryCount: 3, skipped: 0, collectedAt: expect.any(String),
    });
    // Payload bất biến, index chỉ giữ ref + digest — đọc lại phải khớp digest.
    const first = await threads.readEntry(id, thread.messages[0]);
    expect(first).toEqual({ version: 1, executionId: "exec_1", kind: "user", nativeId: "u1", createdAt: at(1), text: "hello" });
    const boundary = await store.readPayload(id, "messages/4.json") as ThreadEntry;
    expect(boundary).toMatchObject({
      kind: "boundary", executionId: "exec_1", sequence: 1, outcome: "completed", runtime: "claude",
      historyCompleteness: "complete", pinnedVersion: "9.9", collected: 3, skipped: 0,
    });
  });

  it("is idempotent: collecting twice adds nothing, and a reset cursor still cannot duplicate an entry", async () => {
    const script = [user("u1", "hello", 1), assistant("a1", "hi", 2)];
    const calls: CollectDeltaInput[] = [];
    const { threads } = harness([scriptedBridge("codex", script, { calls })]);
    const { id } = await threads.createThread({ agentId: "main", workspace: "/project" });
    await threads.reserveRoot(id, "exec_1");
    await threads.settleRoot(id, "exec_1", "completed");

    const once = await threads.collectHistory(id, source("exec_1", "codex"));
    const twice = await threads.collectHistory(id, source("exec_1", "codex"));
    expect(twice.messages).toEqual(once.messages);
    expect(twice.revision).toBe(once.revision);
    // Lần hai đọc từ cursor lần một — bridge không phải đọc lại dòng đã đọc.
    expect(calls.map((call) => call.cursor?.lineOffset ?? null)).toEqual([null, 2]);

    // Cursor về 0 (transcript đổi path, hay ai đó xoá `history`): lớp thứ hai — ID native — chặn trùng.
    const registry = new HistoryBridgeRegistry([scriptedBridge("codex", [...script, user("u3", "more", 3)])]);
    const reset = new ThreadService({ store: (threads as unknown as { store: InMemoryThreadStore }).store, graph: noGraph, history: registry });
    const third = await reset.collectHistory(id, source("exec_1", "codex"));
    expect(third.messages.map((ref) => ref.id)).toEqual([...once.messages.map((ref) => ref.id), "exec_1:u3"]);
    expect(third.executions[0].history?.entryCount).toBe(3);
  });

  it("keeps entries of two roots apart and orders them by collection, each with its own boundary", async () => {
    const calls: CollectDeltaInput[] = [];
    const { threads } = harness([
      scriptedBridge("claude", [user("u1", "first", 1)], { calls }),
      scriptedBridge("codex", [user("u1", "second", 5)], { calls }),
    ]);
    const { id } = await threads.createThread({ agentId: "main", workspace: "/project" });
    await threads.reserveRoot(id, "exec_1");
    await threads.settleRoot(id, "exec_1", "completed");
    await threads.collectHistory(id, source("exec_1", "claude"));
    await threads.projectContext(id, "exec_1", { checkpoint: null, runtime: "claude" });
    await threads.reserveRoot(id, "exec_2");
    await threads.settleRoot(id, "exec_2", "failed");
    const thread = await threads.collectHistory(id, source("exec_2", "codex"));
    // Cùng nativeId `u1` ở hai runtime khác nhau — ID entry mang executionId nên không đụng.
    expect(thread.messages.map((ref) => [ref.executionId, ref.kind])).toEqual([
      ["exec_1", "user"], ["exec_1", "boundary"], ["exec_2", "user"], ["exec_2", "boundary"],
    ]);
    expect(threads.historyCompleteness(thread)).toBe("complete");
    expect(calls.map((call) => call.execution.runtime)).toEqual(["claude", "codex"]);
  });

  it("records unsupported for a runtime without a bridge and still lets the thread continue", async () => {
    const { threads } = harness([]);
    const { id } = await threads.createThread({ agentId: "main", workspace: "/project" });
    await threads.reserveRoot(id, "exec_1");
    await threads.settleRoot(id, "exec_1", "completed");
    const thread = await threads.collectHistory(id, source("exec_1", null));
    expect(thread.messages.map((ref) => ref.kind)).toEqual(["boundary"]);
    expect(thread.executions[0].history).toMatchObject({ completeness: "unsupported", pinnedVersion: null, cursor: null, entryCount: 0 });
    expect(threads.historyCompleteness(thread)).toBe("unsupported");
    await threads.projectContext(id, "exec_1", { checkpoint: null, runtime: null });
    const reserved = await threads.reserveRoot(id, "exec_2");
    expect(reserved.ref.sequence).toBe(2);
  });

  it("does not write a boundary before settle, and a throwing bridge degrades to final-only", async () => {
    const throwing: RuntimeHistoryBridge = {
      runtime: "claude",
      probe: async () => ({ completeness: "complete", pinnedVersion: "9.9" }),
      collectDelta: async () => { throw new Error("transcript exploded"); },
    };
    const { threads } = harness([throwing]);
    const { id } = await threads.createThread({ agentId: "main", workspace: "/project" });
    await threads.reserveRoot(id, "exec_1");
    const running = await threads.collectHistory(id, source("exec_1", "claude"));
    expect(running.messages).toEqual([]);
    expect(running.executions[0].history).toMatchObject({ completeness: "final-only", entryCount: 0 });
    await threads.settleRoot(id, "exec_1", "completed");
    const settled = await threads.collectHistory(id, source("exec_1", "claude"));
    expect(settled.messages.map((ref) => ref.kind)).toEqual(["boundary"]);
    expect(threads.historyCompleteness(settled)).toBe("final-only");
  });

  it("refuses an execution that is not part of the thread", async () => {
    const { threads } = harness([]);
    const { id } = await threads.createThread({ agentId: "main", workspace: "/project" });
    await expect(threads.collectHistory(id, source("exec_stranger", "claude"))).rejects.toMatchObject({ code: "THREAD_EXECUTION_BINDING_MISMATCH" });
  });
});
