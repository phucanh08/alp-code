import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { ModeId } from "../../src/agents/modes";
import { agentRegistry } from "../../src/agents/registry";
import type { BackendExecutionResult } from "../../src/backend/execution-backend";
import { runThreadCommand } from "../../src/cli/commands/thread";
import { backendProbe } from "../../src/delegation/delegation-service";
import {
  continueThreadSession,
  historySourceFromDisk,
  runMainSession,
  type ContinueThreadDependencies,
  type RunMainDependencies,
} from "../../src/cli/commands/run-main";
import { isThreadError } from "../../src/thread/errors";
import { FileThreadStore } from "../../src/thread/file-thread-store";
import { ThreadService, threadGraphReader } from "../../src/thread/thread-service";
import { cleanupEnvironments, createE2eEnvironment, type E2eEnvironment } from "./harness";

const OUTPUT = "Done.";

afterEach(cleanupEnvironments);

function dependencies(
  environment: E2eEnvironment,
  options: { readonly executionId: string; readonly threads?: RunMainDependencies["threads"]; readonly announced?: string[] },
): ContinueThreadDependencies {
  return {
    registry: agentRegistry,
    selector: { select: async (input) => ({ ok: true, mode: input.requestedMode ?? "medium", source: "explicit" }) },
    executionService: environment.executionService,
    graph: environment.graph,
    threads: { ...environment.threads, ...(options.threads ?? {}) } as ContinueThreadDependencies["threads"],
    announce: (line) => options.announced?.push(line),
    adapters: environment.adapters,
    backend: environment.backend,
    executionId: () => options.executionId,
    interactive: false,
    workspaceModeFor: async () => "workspace-write",
    executionsRoot: environment.executionsRoot,
  };
}

/** `environment.threads` là class instance — spread mất prototype, nên bind từng method. */
function boundThreads(environment: E2eEnvironment): ContinueThreadDependencies["threads"] {
  const threads = environment.threads;
  return {
    createThread: (input) => threads.createThread(input),
    reserveRoot: (id, executionId) => threads.reserveRoot(id, executionId),
    settleRoot: (id, executionId, outcome) => threads.settleRoot(id, executionId, outcome),
    projectContext: (id, executionId, input) => threads.projectContext(id, executionId, input),
    collectHistory: (id, source) => threads.collectHistory(id, source),
    get: (id) => threads.get(id),
    reconcile: (id) => threads.reconcile(id),
    pendingProjection: (thread) => threads.pendingProjection(thread),
  };
}

async function bare(environment: E2eEnvironment, executionId: string, options: { mode?: ModeId; title?: string; announced?: string[] } = {}) {
  const deps = { ...dependencies(environment, { executionId, announced: options.announced }), threads: boundThreads(environment) };
  return runMainSession({ cwd: environment.project, mode: options.mode ?? "ultra", ...(options.title ? { title: options.title } : {}) }, deps);
}

async function continueThread(
  environment: E2eEnvironment,
  threadId: string,
  executionId: string,
  options: { mode?: ModeId; announced?: string[]; threads?: Partial<ContinueThreadDependencies["threads"]> } = {},
): Promise<BackendExecutionResult> {
  const deps = {
    ...dependencies(environment, { executionId, announced: options.announced }),
    threads: { ...boundThreads(environment), ...(options.threads ?? {}) },
  };
  return continueThreadSession({ threadId, cwd: environment.project, mode: options.mode ?? "puck" }, deps);
}

async function codeOf(operation: () => Promise<unknown>): Promise<string | null> {
  try {
    await operation();
    return null;
  } catch (error) {
    if (isThreadError(error)) return error.code;
    throw error;
  }
}

async function onlyThreadId(environment: E2eEnvironment): Promise<string> {
  const summaries = await environment.threads.list({ workspace: environment.project });
  expect(summaries).toHaveLength(1);
  return summaries[0].id;
}

async function show(environment: E2eEnvironment, threadId: string): Promise<string> {
  const output: string[] = [];
  await runThreadCommand(["show", threadId], {
    threads: environment.threads,
    continueThread: async () => 0,
    historySource: (executionId) => historySourceFromDisk(environment.executionsRoot, executionId),
    cwd: environment.project,
    env: {},
    write: (text) => { output.push(text); },
  });
  return output.join("");
}

describe("e2e: alp thread continue", () => {
  it("opens a new execution on the same thread after the first process is gone", async () => {
    const environment = await createE2eEnvironment({ output: OUTPUT });
    const announced: string[] = [];
    expect((await bare(environment, "exec_e1", { title: "fix login", announced })).status).toBe("completed");
    const threadId = await onlyThreadId(environment);
    expect(announced).toEqual([`Thread: ${threadId}   (continue later: alp thread continue ${threadId})`]);

    // "Kill CLI": process E-1 đã kết thúc; Thread còn. Continue = execution mới, runtime khác.
    const result = await continueThread(environment, threadId, "exec_e2", { announced });
    expect(result.status).toBe("completed");
    expect(announced[1]).toBe(`Thread: ${threadId}   (continuation #2)`);
    const thread = await environment.threads.get(threadId);
    expect(thread.executions.map((ref) => [ref.executionId, ref.sequence, ref.settled?.outcome, ref.settled?.nextContextRevision])).toEqual([
      ["exec_e1", 1, "completed", 1],
      ["exec_e2", 2, "completed", 2],
    ]);
    const first = await environment.captureOf("exec_e1");
    const second = await environment.captureOf("exec_e2");
    expect([first.runtime, second.runtime]).toEqual(["claude", "codex"]);
    expect(first.env.ALP_THREAD_ID).toBe(threadId);
    expect(second.env.ALP_THREAD_ID).toBe(threadId);
    expect(second.sessionContext).toContain(`continuation #2 · previous: exec_e1 (claude, completed)`);

    const text = await show(environment, threadId);
    expect(text).toContain("Activity:  idle");
    expect(text).toMatch(/#1 {2}exec_e1 {2}completed/);
    expect(text).toMatch(/#2 {2}exec_e2 {2}completed/);
  });

  it("lets exactly one of two concurrent continues open a root", async () => {
    const environment = await createE2eEnvironment({ output: OUTPUT, holdMs: 600, holdRoles: ["main"] });
    await bare(environment, "exec_e1");
    const threadId = await onlyThreadId(environment);

    const outcomes = await Promise.all([
      codeOf(() => continueThread(environment, threadId, "exec_a")),
      codeOf(() => continueThread(environment, threadId, "exec_b")),
    ]);
    expect(outcomes.filter((code) => code === null)).toHaveLength(1);
    expect(outcomes.filter((code) => code === "THREAD_BUSY")).toHaveLength(1);
    const thread = await environment.threads.get(threadId);
    expect(thread.executions).toHaveLength(2);
    expect(thread.executions[1].settled).toMatchObject({ outcome: "completed" });
  });

  it("lets exactly one of `continue` and `close` win the race", async () => {
    const environment = await createE2eEnvironment({ output: OUTPUT, holdMs: 600, holdRoles: ["main"] });
    await bare(environment, "exec_e1");
    const threadId = await onlyThreadId(environment);

    const [continued, closed] = await Promise.all([
      codeOf(() => continueThread(environment, threadId, "exec_e2")),
      codeOf(() => environment.threads.close(threadId)),
    ]);
    const thread = await environment.threads.get(threadId);
    if (closed === null) {
      // Close thắng: continue bị từ chối, và không root nào được mở lên Thread đã đóng.
      expect(continued).toBe("THREAD_CLOSED");
      expect(thread.status).toBe("closed");
      expect(thread.executions).toHaveLength(1);
    } else {
      expect(closed).toBe("THREAD_BUSY");
      expect(continued).toBeNull();
      expect(thread.executions).toHaveLength(2);
    }
  });

  it("never lets `continue` and `archive` both succeed, whichever state the thread is in", async () => {
    const environment = await createE2eEnvironment({ output: OUTPUT, holdMs: 600, holdRoles: ["main"] });
    await bare(environment, "exec_e1");
    const threadId = await onlyThreadId(environment);

    // Mở: archive không có gì để thắng — nó cần `closed` trước — và continue đi tiếp.
    const [continued, archived] = await Promise.all([
      codeOf(() => continueThread(environment, threadId, "exec_e2")),
      codeOf(() => environment.threads.archive(threadId)),
    ]);
    expect(continued).toBeNull();
    expect(archived).toBe("THREAD_INVARIANT_VIOLATION");
    expect((await environment.threads.get(threadId)).status).toBe("open");

    // Đóng rồi: archive thắng, continue bị từ chối bằng lý do của trạng thái nó thấy.
    await environment.threads.close(threadId);
    const [again, archivedNow] = await Promise.all([
      codeOf(() => continueThread(environment, threadId, "exec_e3")),
      codeOf(() => environment.threads.archive(threadId)),
    ]);
    expect(archivedNow).toBeNull();
    expect(["THREAD_CLOSED", "THREAD_ARCHIVED"]).toContain(again);
    const thread = await environment.threads.get(threadId);
    expect(thread.status).toBe("archived");
    expect(thread.executions).toHaveLength(2);
  });

  /**
   * Chiếu context và mở root kế tiếp là hai bước dưới hai lease. Hai `continue` cùng gặp một
   * root chưa chiếu: cả hai có thể chiếu, nhưng chỉ một revision được ghi và chỉ một root mở.
   */
  it("keeps one revision chain when two continues race a pending projection", async () => {
    const environment = await createE2eEnvironment({ output: OUTPUT, holdMs: 600, holdRoles: ["main"] });
    const crashed = { ...boundThreads(environment), settleRoot: async () => { throw new Error("SIGKILL"); } };
    await expect(runMainSession(
      { cwd: environment.project, mode: "ultra" },
      { ...dependencies(environment, { executionId: "exec_e1" }), threads: crashed },
    )).rejects.toThrow("SIGKILL");
    const threadId = await onlyThreadId(environment);

    const outcomes = await Promise.all([
      codeOf(() => continueThread(environment, threadId, "exec_a")),
      codeOf(() => continueThread(environment, threadId, "exec_b")),
    ]);
    expect(outcomes.filter((code) => code === null)).toHaveLength(1);
    expect(outcomes.filter((code) => code === "THREAD_BUSY")).toHaveLength(1);
    const thread = await environment.threads.get(threadId);
    expect(thread.executions.map((ref) => [ref.sequence, ref.contextRevision, ref.settled?.nextContextRevision])).toEqual([
      [1, 0, 1],
      [2, 1, 2],
    ]);
    // Không revision nào bị ghi hai lần, không revision nào bị bỏ trống: rev 2 kể cả hai kết cục.
    expect(thread.currentContext).toMatchObject({ revision: 2 });
    expect(await environment.threads.currentContext(threadId)).toMatchObject({
      revision: 2,
      outcomes: [{ executionId: "exec_e1", outcome: "completed" }, { executionId: thread.executions[1].executionId, outcome: "completed" }],
    });
  });

  it("refuses to continue a thread whose root is still running, naming the execution", async () => {
    const environment = await createE2eEnvironment({ output: OUTPUT, holdMs: 1_500, holdRoles: ["main"] });
    const running = bare(environment, "exec_e1");
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const summaries = await environment.threads.list({ workspace: environment.project });
      if (summaries.length === 1 && summaries[0].unsettledExecutionId) break;
      await sleep(20);
    }
    const threadId = await onlyThreadId(environment);
    await expect(continueThread(environment, threadId, "exec_e2")).rejects.toMatchObject({ code: "THREAD_BUSY", executionId: "exec_e1" });
    expect(await show(environment, threadId)).toContain("Activity:  running (exec_e1)");
    await running;
  });

  it("recovers a root whose process died after the graph finished but before the thread was settled", async () => {
    const environment = await createE2eEnvironment({ output: OUTPUT });
    // E-1 chạy trọn, nhưng process "chết" đúng trước settleRoot: graph terminal, ref unsettled.
    const crashed = { ...boundThreads(environment), settleRoot: async () => { throw new Error("SIGKILL"); } };
    await expect(runMainSession(
      { cwd: environment.project, mode: "ultra" },
      { ...dependencies(environment, { executionId: "exec_e1" }), threads: crashed },
    )).rejects.toThrow("SIGKILL");
    const threadId = await onlyThreadId(environment);
    expect(await environment.threads.activity(threadId)).toEqual({ kind: "unsettled", executionId: "exec_e1" });

    // continue: reconcile chép `completed` từ graph, chiếu context từ checkpoint E-1 trên đĩa, rồi mở E-2.
    expect((await continueThread(environment, threadId, "exec_e2")).status).toBe("completed");
    const thread = await environment.threads.get(threadId);
    expect(thread.executions[0].settled).toMatchObject({ outcome: "completed", nextContextRevision: 1 });
    // E-2 mở trên rev 1 (bản chiếu của E-1), rồi để lại rev 2. Không degraded: checkpoint của
    // E-1 còn nguyên trên đĩa và khớp policy.
    expect(thread.executions[1]).toMatchObject({ executionId: "exec_e2", contextRevision: 1, settled: { nextContextRevision: 2 } });
    const rev2 = await environment.threads.currentContext(threadId);
    expect(rev2).toMatchObject({
      revision: 2,
      degraded: false,
      outcomes: [
        { executionId: "exec_e1", runtime: "claude", outcome: "completed" },
        { executionId: "exec_e2", runtime: "codex", outcome: "completed" },
      ],
    });
  });

  it("marks a reservation that never reached the graph as interrupted once its TTL passes", async () => {
    const environment = await createE2eEnvironment({ output: OUTPUT });
    await bare(environment, "exec_e1");
    const threadId = await onlyThreadId(environment);
    // Chết ngay sau reserve: ref có, graph không.
    await environment.threads.reserveRoot(threadId, "exec_dead");
    // Trong TTL: giữ — root có thể đang preparing.
    await expect(continueThread(environment, threadId, "exec_e3")).rejects.toMatchObject({ code: "THREAD_BUSY", executionId: "exec_dead" });

    const impatient = new ThreadService({
      store: new FileThreadStore({ root: environment.threadsRoot }),
      graph: threadGraphReader(environment.graph, backendProbe(environment.backend)),
      reservationTtlMs: 0,
    });
    await sleep(5);
    const reconciled = await impatient.reconcile(threadId);
    expect(reconciled.executions[1].settled).toMatchObject({ outcome: "interrupted" });
    expect((await continueThread(environment, threadId, "exec_e3")).status).toBe("completed");
    const rev2 = await environment.threads.currentContext(threadId);
    expect(rev2?.nextActions.map((line) => line.text)).toContain("E-2 (exec_dead) ended interrupted");
  }, 10_000);
});
