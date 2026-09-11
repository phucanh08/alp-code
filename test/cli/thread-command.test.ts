import { describe, expect, it, vi } from "vitest";
import { runThreadCommand, type ThreadCommandDependencies } from "../../src/cli/commands/thread";
import { InMemoryThreadStore } from "../../src/thread/in-memory-thread-store";
import { HistoryBridgeRegistry, type RuntimeHistoryBridge } from "../../src/thread/history-bridge";
import { ThreadService, type ThreadGraphReader } from "../../src/thread/thread-service";
import type { ExecutionGraphDocument, ExecutionNode, ExecutionNodeStatus } from "../../src/execution/graph/types";
import { at } from "../support/thread-fixture";

function graphReader(nodes: Record<string, ExecutionNodeStatus> = {}): ThreadGraphReader {
  return {
    async findGraphFor(executionId) {
      const status = nodes[executionId];
      if (!status) return null;
      return {
        graphId: `graph_${executionId}`,
        rootExecutionId: executionId,
        nodes: [{ executionId, parentExecutionId: null, status, thread: null } as unknown as ExecutionNode],
      } as unknown as ExecutionGraphDocument;
    },
  };
}

/** Bridge giả: mỗi lần collect trả đúng những entry test đưa, cursor tiến theo số dòng đã trả. */
function scriptedBridge(runtime: "claude" | "codex", texts: readonly string[], completeness: "complete" | "partial" = "complete"): RuntimeHistoryBridge {
  return {
    runtime,
    probe: async () => ({ completeness, pinnedVersion: "1.0" }),
    collectDelta: async ({ cursor }) => {
      const offset = cursor?.lineOffset ?? 0;
      return {
        entries: texts.slice(offset).map((text, index) => ({ kind: "user" as const, nativeId: `n${offset + index}`, createdAt: at(offset + index), text })),
        cursor: { transcriptPath: `/state/${runtime}.jsonl`, lineOffset: texts.length, lastNativeId: null },
        completeness, pinnedVersion: "1.0", skipped: 0,
      };
    },
  };
}

function harness(options: { readonly graph?: ThreadGraphReader; readonly env?: NodeJS.ProcessEnv; readonly bridges?: readonly RuntimeHistoryBridge[] } = {}) {
  let tick = 0;
  const now = () => new Date(at(tick++));
  const store = new InMemoryThreadStore({ now });
  const threads = new ThreadService({
    store, graph: options.graph ?? graphReader(), now, reservationTtlMs: 60_000,
    history: new HistoryBridgeRegistry(options.bridges ?? []),
  });
  const output: string[] = [];
  const continueThread = vi.fn(async () => 0);
  const dependencies: ThreadCommandDependencies = {
    threads,
    continueThread,
    historySource: async (executionId) => ({ executionId, runtime: "claude", workspace: "/project", contextDirectory: "/nowhere" }),
    cwd: "/project",
    env: options.env ?? {},
    write: (text) => { output.push(text); },
  };
  const run = (...args: string[]) => runThreadCommand(args, dependencies);
  const printed = () => output.join("");
  return { threads, run, printed, continueThread, jump: (seconds: number) => { tick += seconds; } };
}

describe("alp thread — parsing", () => {
  it.each([
    [[]],
    [["wat"]],
    [["show", "not-a-thread"]],
    [["continue"]],
    [["continue", "thread_a", "--mode"]],
    [["continue", "thread_a", "--mode", "smart"]],
    [["continue", "thread_a", "--mode=low", "--mode=high"]],
    [["continue", "thread_a", "--runtime", "codex"]],
    [["close"]],
    [["list", "--everything"]],
    [["context", "../etc"]],
  ])("rejects %j", async (args) => {
    const { run } = harness();
    await expect(run(...args)).rejects.toThrow();
  });

  it("hands `continue` to the session with the parsed mode and nothing else", async () => {
    const { run, continueThread } = harness();
    await expect(run("continue", "thread_abc", "--mode=low")).resolves.toBe(0);
    expect(continueThread).toHaveBeenCalledWith({ threadId: "thread_abc", mode: "low" });
    await run("continue", "thread_abc");
    expect(continueThread).toHaveBeenLastCalledWith({ threadId: "thread_abc" });
  });
});

describe("alp thread list", () => {
  it("defaults to open threads of the current workspace, newest first, and `--all` lifts both filters", async () => {
    const { threads, run, printed } = harness();
    const here = await threads.createThread({ agentId: "main", workspace: "/project", title: "fix login" });
    const elsewhere = await threads.createThread({ agentId: "main", workspace: "/other", title: "other repo" });
    const closed = await threads.createThread({ agentId: "main", workspace: "/project", title: "done" });
    await threads.close(closed.id);
    const newest = await threads.createThread({ agentId: "main", workspace: "/project", title: null });

    await run("list");
    const first = printed();
    expect(first).toContain(here.id);
    expect(first).toContain(newest.id);
    expect(first).not.toContain(elsewhere.id);
    expect(first).not.toContain(closed.id);
    expect(first.indexOf(newest.id)).toBeLessThan(first.indexOf(here.id));
    expect(first).toContain("fix login");

    await run("list", "--all");
    const all = printed().slice(first.length);
    for (const thread of [here, elsewhere, closed, newest]) expect(all).toContain(thread.id);
    expect(all).toContain("/other");
    expect(all).toContain("closed");
  });

  it("marks a thread with an unsettled execution", async () => {
    const { threads, run, printed } = harness();
    const { id } = await threads.createThread({ agentId: "main", workspace: "/project" });
    await threads.reserveRoot(id, "exec_1");
    await run("list");
    expect(printed()).toContain("1*");
    expect(printed()).toContain("unsettled execution");
  });

  it("says so when there is nothing to list", async () => {
    const { run, printed } = harness();
    await run("list");
    expect(printed()).toContain("No open threads in this workspace");
  });
});

describe("alp thread show", () => {
  it("reconciles first, then prints executions and activity — without any store path", async () => {
    const { threads, run, printed } = harness({ graph: graphReader({ exec_1: "completed" }) });
    const { id } = await threads.createThread({ agentId: "main", workspace: "/project", title: "fix login" });
    await threads.reserveRoot(id, "exec_1");
    // Process của exec_1 chết trước khi settle; graph đã terminal.
    await run("show", id);
    const text = printed();
    expect(text).toContain(`Thread:    ${id}`);
    expect(text).toContain("Title:     fix login");
    expect(text).toContain("Activity:  idle");
    expect(text).toMatch(/#1 {2}exec_1 {2}completed/);
    expect(text).toContain("context not projected yet");
    expect(text).toContain(`alp thread continue ${id}`);
    expect(text).not.toContain("thread.json");
    expect((await threads.get(id)).executions[0].settled).toMatchObject({ outcome: "completed" });
  });

  it("prints the worst history completeness across roots, or none yet", async () => {
    const { threads, run, printed } = harness({ bridges: [scriptedBridge("claude", ["hello"]), scriptedBridge("codex", ["again"], "partial")] });
    const { id } = await threads.createThread({ agentId: "main", workspace: "/project" });
    await run("show", id);
    expect(printed()).toContain("History:   none yet");
    await threads.reserveRoot(id, "exec_1");
    await threads.settleRoot(id, "exec_1", "completed");
    await threads.collectHistory(id, { executionId: "exec_1", runtime: "claude", workspace: "/project", contextDirectory: "/x" });
    await run("show", id);
    expect(printed()).toContain("History:   complete (2 entries)");
    expect(printed()).toMatch(/#1 {2}exec_1 {2}completed.*history complete @1\.0 \(1 entries\)/);
    await threads.projectContext(id, "exec_1", { checkpoint: null, runtime: "claude" });
    await threads.reserveRoot(id, "exec_2");
    await threads.settleRoot(id, "exec_2", "completed");
    await threads.collectHistory(id, { executionId: "exec_2", runtime: "codex", workspace: "/project", contextDirectory: "/x" });
    await run("show", id);
    // Một root `partial` kéo cả Thread xuống `partial`.
    expect(printed()).toContain("History:   partial (4 entries)");
  });

  it("shows a live root as running and offers no continue line", async () => {
    const { threads, run, printed } = harness({ graph: graphReader({ exec_1: "running" }) });
    const { id } = await threads.createThread({ agentId: "main", workspace: "/project" });
    await threads.reserveRoot(id, "exec_1");
    await run("show", id);
    expect(printed()).toContain("Activity:  running (exec_1)");
    expect(printed()).toMatch(/#1 {2}exec_1 {2}running/);
    expect(printed()).not.toContain("alp thread continue");
  });

  it("reads the thread ID from ALP_THREAD_ID when none is given", async () => {
    const { threads, run, printed } = harness({ env: { ALP_THREAD_ID: "thread_fromenv" } });
    await threads.createThread({ id: "thread_fromenv", agentId: "main", workspace: "/project" });
    await run("show");
    expect(printed()).toContain("Thread:    thread_fromenv");
  });

  it("fails on an unknown thread", async () => {
    const { run } = harness();
    await expect(run("show", "thread_missing")).rejects.toMatchObject({ code: "THREAD_NOT_FOUND" });
  });
});

describe("alp thread close / archive / reconcile / context", () => {
  it("closes an idle thread, refuses a busy one, and archives only a closed one", async () => {
    const { threads, run, printed } = harness();
    const { id } = await threads.createThread({ agentId: "main", workspace: "/project" });
    await expect(run("archive", id)).rejects.toMatchObject({ code: "THREAD_INVARIANT_VIOLATION" });
    await threads.reserveRoot(id, "exec_1");
    await expect(run("close", id)).rejects.toMatchObject({ code: "THREAD_BUSY", executionId: "exec_1" });
    await threads.settleRoot(id, "exec_1", "completed");
    await expect(run("close", id)).resolves.toBe(0);
    expect(printed()).toContain(`CLOSED    ${id}`);
    await expect(run("archive", id)).resolves.toBe(0);
    expect(printed()).toContain(`ARCHIVED  ${id}`);
    expect((await threads.get(id)).status).toBe("archived");
  });

  it("reports what reconcile changed", async () => {
    const { threads, run, printed, jump } = harness();
    const { id } = await threads.createThread({ agentId: "main", workspace: "/project" });
    await threads.reserveRoot(id, "exec_1");
    await run("reconcile", id);
    expect(printed()).toContain(`UNCHANGED ${id}`);
    expect(printed()).toContain("unsettled (exec_1)");
    jump(120);
    await run("reconcile", id);
    expect(printed()).toContain(`SETTLED   ${id}`);
    expect(printed()).toContain("Activity: idle");
    expect((await threads.get(id)).executions[0].settled).toMatchObject({ outcome: "interrupted" });
  });

  it("syncs every settled root through its runtime bridge, and a second sync adds nothing", async () => {
    const { threads, run, printed } = harness({ bridges: [scriptedBridge("claude", ["one", "two"])] });
    const { id } = await threads.createThread({ agentId: "main", workspace: "/project" });
    await threads.reserveRoot(id, "exec_1");
    await threads.settleRoot(id, "exec_1", "completed");
    await threads.projectContext(id, "exec_1", { checkpoint: null, runtime: "claude" });
    await threads.reserveRoot(id, "exec_live");
    expect(await run("sync", id)).toBe(0);
    // Root đang chạy không được sync (transcript còn đang lớn, chưa có boundary để ghi).
    expect(printed()).toContain(`SYNCED    ${id} (3 entries, revision`);
    expect(printed()).toMatch(/#1 {2}exec_1 {2}\+3 entries {2}complete @1\.0 \(2 entries\)/);
    expect(printed()).not.toContain("exec_live");
    const before = await threads.get(id);
    await run("sync", id);
    expect(printed()).toMatch(/#1 {2}exec_1 {2}\+0 entries/);
    expect((await threads.get(id)).revision).toBe(before.revision);
  });

  it("prints the current context snapshot, or says there is none", async () => {
    const { threads, run, printed } = harness();
    const { id } = await threads.createThread({ agentId: "main", workspace: "/project", title: "fix login" });
    await run("context", id);
    expect(printed()).toContain("no context revision yet");
    await threads.reserveRoot(id, "exec_1");
    await threads.settleRoot(id, "exec_1", "failed");
    await threads.projectContext(id, "exec_1", { checkpoint: null, runtime: "claude" });
    await run("context", id);
    const text = printed();
    expect(text).toContain("Revision:  1  (degraded");
    expect(text).toContain("Objective: fix login");
    expect(text).toContain("Next actions:\n  - E-1 (exec_1) ended failed  [exec_1]");
    expect(text).toMatch(/#1 {2}exec_1 {2}failed {2}claude/);
  });
});
