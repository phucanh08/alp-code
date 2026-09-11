import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { ModeId } from "../../src/agents/modes";
import { agentRegistry } from "../../src/agents/registry";
import type { BackendExecutionResult } from "../../src/backend/execution-backend";
import { runContextCommand } from "../../src/cli/commands/context";
import {
  continueThreadSession,
  historySourceFromDisk,
  runMainSession,
  type ContinueThreadDependencies,
} from "../../src/cli/commands/run-main";
import { runThreadCommand } from "../../src/cli/commands/thread";
import { DelegationService, InMemoryDelegationExecutionStore } from "../../src/delegation/delegation-service";
import { readBindingFromEnvironment } from "../../src/execution/graph/execution-graph-service";
import type { ExecutionPolicy } from "../../src/execution/types";
import { cleanupEnvironments, createE2eEnvironment, type E2eEnvironment, type RuntimeCapture } from "./harness";

afterEach(cleanupEnvironments);

/**
 * Kịch bản bắt buộc của P5, chạy đúng đường user đi: bare `alp` mở Thread, hai lần
 * `alp thread continue` sau đó đổi runtime, và mọi context đi qua `alp context pin` — nguồn
 * duy nhất projector nhìn thấy ở phiên interactive. Không pin = kịch bản giả.
 */
function dependencies(environment: E2eEnvironment, executionId: string, announced: string[]): ContinueThreadDependencies {
  const threads = environment.threads;
  return {
    registry: agentRegistry,
    selector: { select: async (input) => ({ ok: true, mode: input.requestedMode!, source: "explicit" }) },
    executionService: environment.executionService,
    graph: environment.graph,
    threads: {
      createThread: (input) => threads.createThread(input),
      reserveRoot: (id, execution) => threads.reserveRoot(id, execution),
      settleRoot: (id, execution, outcome) => threads.settleRoot(id, execution, outcome),
      projectContext: (id, execution, input) => threads.projectContext(id, execution, input),
      collectHistory: (id, source) => threads.collectHistory(id, source),
      get: (id) => threads.get(id),
      reconcile: (id) => threads.reconcile(id),
      pendingProjection: (thread) => threads.pendingProjection(thread),
    },
    adapters: environment.adapters,
    backend: environment.backend,
    executionId: () => executionId,
    interactive: false,
    workspaceModeFor: async () => "workspace-write",
    executionsRoot: environment.executionsRoot,
    announce: (line) => { announced.push(line); },
  };
}

async function launched(environment: E2eEnvironment, executionId: string): Promise<RuntimeCapture> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try { return await environment.captureOf(executionId); } catch { await sleep(25); }
  }
  throw new Error(`execution ${executionId} never launched`);
}

/** `alp context pin …` từ trong phiên: env là env mà runtime nhận, không gì hơn. */
async function pin(environment: E2eEnvironment, capture: RuntimeCapture, kind: string, text: string): Promise<void> {
  const output: string[] = [];
  expect(await runContextCommand(["pin", kind, "--", text], {
    executionsRoot: environment.executionsRoot,
    env: capture.env,
    write: (line) => { output.push(line); },
  })).toBe(0);
  expect(output.join("")).toMatch(/^PINNED/);
}

async function policyOf(environment: E2eEnvironment, executionId: string): Promise<ExecutionPolicy> {
  return JSON.parse(await readFile(join(environment.executionsRoot, executionId, "policy.json"), "utf8"));
}

describe("e2e: one thread across Claude → Codex → Claude", () => {
  it("carries context through three executions, three runtimes launches, three processes — one thread", async () => {
    const environment = await createE2eEnvironment({ output: "Done.", holdMs: 3_000, holdRoles: ["main"] });
    const announced: string[] = [];
    const run = (executionId: string, mode: ModeId, threadId?: string): Promise<BackendExecutionResult> =>
      threadId === undefined
        ? runMainSession({ cwd: environment.project, mode, title: "Fix authentication bug" }, dependencies(environment, executionId, announced))
        : continueThreadSession({ threadId, cwd: environment.project, mode }, dependencies(environment, executionId, announced));

    // E-1 · Claude · investigate. Trong lúc còn sống, agent pin quyết định + việc kế tiếp.
    const first = run("exec_e1", "ultra");
    const c1 = await launched(environment, "exec_e1");
    const threadId = c1.env.ALP_THREAD_ID;
    expect(threadId).toMatch(/^thread_/);
    await pin(environment, c1, "decision", "Root cause: refresh token never rotated");
    await pin(environment, c1, "next-action", "Rotate refresh token on every use");
    // C-1: con của E-1 — vào cây của E-1, không vào Thread.
    const delegation = new DelegationService({
      registry: agentRegistry, policy: environment.policy, memory: environment.memory,
      executionService: environment.executionService, graph: environment.graph,
      binding: readBindingFromEnvironment(c1.env)!, executionsRoot: environment.executionsRoot,
      runtimeAdapters: environment.adapters, backend: environment.backend,
      executionStore: new InMemoryDelegationExecutionStore(), config: { mode: "medium" },
      ids: { request: () => "req_c1", execution: () => "exec_c1" },
    });
    await delegation.delegate({ targetRole: "search", task: "Find token rotation code", workspace: environment.project });
    expect((await delegation.wait("exec_c1")).status).toBe("completed");
    expect((await first).status).toBe("completed");
    const rev1 = (await environment.threads.currentContext(threadId))!;
    expect(rev1.revision).toBe(1);
    expect(rev1.decisions.map((line) => line.text)).toEqual(["Root cause: refresh token never rotated"]);

    // E-2 · Codex · implement. Thấy rev 1 trong session context, pin tiếp, ra rev 2.
    const second = run("exec_e2", "puck", threadId);
    const c2 = await launched(environment, "exec_e2");
    expect(c2.runtime).toBe("codex");
    expect(c2.sessionContext).toContain("Root cause: refresh token never rotated");
    expect(c2.sessionContext).toContain("Rotate refresh token on every use");
    await pin(environment, c2, "decision", "Implemented rotation in TokenService.refresh");
    await pin(environment, c2, "open-item", "Review the migration for old sessions");
    expect((await second).status).toBe("completed");
    const rev2 = (await environment.threads.currentContext(threadId))!;
    expect(rev2.revision).toBe(2);
    expect(rev2.decisions.map((line) => [line.text, line.sourceExecutionId])).toEqual([
      ["Root cause: refresh token never rotated", "exec_e1"],
      ["Implemented rotation in TokenService.refresh", "exec_e2"],
    ]);

    // E-3 · Claude · review. Thấy rev 2.
    const third = run("exec_e3", "ultra", threadId);
    const c3 = await launched(environment, "exec_e3");
    expect(c3.runtime).toBe("claude");
    expect(c3.sessionContext).toContain("Implemented rotation in TokenService.refresh");
    expect(c3.sessionContext).toContain("Review the migration for old sessions");
    expect((await third).status).toBe("completed");

    // — Thread không đổi; ba root, ba ID, ba runtime launch, ba process.
    const thread = await environment.threads.get(threadId);
    expect(thread.title).toBe("Fix authentication bug");
    expect(thread.executions.map((ref) => [ref.executionId, ref.sequence, ref.contextRevision, ref.settled?.outcome, ref.settled?.nextContextRevision])).toEqual([
      ["exec_e1", 1, 0, "completed", 1],
      ["exec_e2", 2, 1, "completed", 2],
      ["exec_e3", 3, 2, "completed", 3],
    ]);
    expect(thread.executions.map((ref) => ref.executionId)).not.toContain("exec_c1");
    const captures = [c1, c2, c3];
    expect(new Set(captures.map((capture) => capture.pid)).size).toBe(3);
    expect(captures.map((capture) => capture.env.ALP_THREAD_ID)).toEqual([threadId, threadId, threadId]);
    expect(captures.map((capture) => capture.env.ALP_DELEGATION_EXECUTION_ID)).toEqual(["exec_e1", "exec_e2", "exec_e3"]);
    // Không root nào được "attach" lại phiên cũ: launch spec không có resume/session id.
    for (const capture of captures) {
      expect(capture.argv.join(" ")).not.toMatch(/--resume|--continue|-r\b|session[-_]?id/i);
    }
    expect(announced).toEqual([
      `Thread: ${threadId}   (continue later: alp thread continue ${threadId})`,
      `Thread: ${threadId}   (continuation #2)`,
      `Thread: ${threadId}   (continuation #3)`,
    ]);

    // — Mỗi Execution vẫn là một security snapshot độc lập.
    const policies = await Promise.all(["exec_e1", "exec_e2", "exec_e3"].map((id) => policyOf(environment, id)));
    expect(new Set(policies.map((policy) => policy.policyHash)).size).toBe(3);
    expect(policies.map((policy) => policy.runtime)).toEqual(["claude", "codex", "claude"]);
    expect(policies.map((policy) => policy.thread)).toEqual([
      { id: threadId, contextRevision: 0, contextDigest: expect.any(String) },
      { id: threadId, contextRevision: 1, contextDigest: rev1.digest },
      { id: threadId, contextRevision: 2, contextDigest: rev2.digest },
    ]);
    // Chuỗi digest rev0 → rev1 → rev2 → rev3: mỗi root mở trên đúng bản chiếu của root trước.
    const rev3 = (await environment.threads.currentContext(threadId))!;
    expect([rev1.digest, rev2.digest, rev3.digest].every((digest, index, all) => all.indexOf(digest) === index)).toBe(true);
    expect(rev3.outcomes.map((outcome) => [outcome.executionId, outcome.runtime, outcome.outcome])).toEqual([
      ["exec_e1", "claude", "completed"], ["exec_e2", "codex", "completed"], ["exec_e3", "claude", "completed"],
    ]);
    // Ba cây riêng: Thread nối chúng, graph không.
    const graphs = await Promise.all(["exec_e1", "exec_e2", "exec_e3"].map((id) => environment.graph.findGraphFor(id)));
    expect(new Set(graphs.map((graph) => graph!.graphId)).size).toBe(3);
    expect(graphs[0]!.nodes.map((node) => node.executionId)).toEqual(["exec_e1", "exec_c1"]);

    // — `show`: ba root, history (runtime giả không có bridge → unsupported) và vẫn continue được.
    const output: string[] = [];
    await runThreadCommand(["show", threadId], {
      threads: environment.threads, continueThread: async () => 0,
      historySource: (id) => historySourceFromDisk(environment.executionsRoot, id),
      cwd: environment.project, env: {}, write: (text) => { output.push(text); },
    });
    const shown = output.join("");
    expect(shown).toContain("Context:   revision 3");
    expect(shown).toContain("History:   unsupported (3 entries)");
    expect(shown).toContain(`Continue:            alp thread continue ${threadId}`);
  }, 30_000);
});
