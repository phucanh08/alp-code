import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { ModeId } from "../../src/agents/modes";
import { agentRegistry } from "../../src/agents/registry";
import type { BackendExecutionResult } from "../../src/backend/execution-backend";
import { runMainSession, type RunMainDependencies } from "../../src/cli/commands/run-main";
import { DelegationService, InMemoryDelegationExecutionStore } from "../../src/delegation/delegation-service";
import { readBindingFromEnvironment } from "../../src/execution/graph/execution-graph-service";
import type { ExecutionPolicy } from "../../src/execution/types";
import type { ThreadDocumentV1 } from "../../src/thread/types";
import { cleanupEnvironments, createE2eEnvironment, type E2eEnvironment } from "./harness";

const OUTPUT = "Done.";

afterEach(cleanupEnvironments);

/**
 * Root #n của một Thread qua đúng đường bare `alp` đi. `thread` có thì root này nối vào Thread
 * đó thay vì mở Thread mới — P3 mới có `alp thread continue`, nên P1 tiêm qua dependency.
 */
async function runRoot(
  environment: E2eEnvironment,
  options: { readonly executionId: string; readonly mode: ModeId; readonly thread?: ThreadDocumentV1 },
): Promise<BackendExecutionResult> {
  const threads: RunMainDependencies["threads"] = options.thread === undefined
    ? environment.threads
    : {
      createThread: async () => options.thread!,
      reserveRoot: (id, executionId) => environment.threads.reserveRoot(id, executionId),
      settleRoot: (id, executionId, outcome) => environment.threads.settleRoot(id, executionId, outcome),
      projectContext: (id, executionId, input) => environment.threads.projectContext(id, executionId, input),
      collectHistory: (id, source) => environment.threads.collectHistory(id, source),
    };
  return runMainSession({ cwd: environment.project, mode: options.mode }, {
    registry: agentRegistry,
    selector: { select: async (input) => ({ ok: true, mode: input.requestedMode!, source: "explicit" }) },
    executionService: environment.executionService,
    graph: environment.graph,
    threads,
    adapters: environment.adapters,
    backend: environment.backend,
    executionId: () => options.executionId,
    interactive: false,
    workspaceModeFor: async () => "workspace-write",
  });
}

async function policyOf(environment: E2eEnvironment, executionId: string): Promise<ExecutionPolicy> {
  return JSON.parse(await readFile(join(environment.executionsRoot, executionId, "policy.json"), "utf8"));
}

async function onlyThread(environment: E2eEnvironment): Promise<ThreadDocumentV1> {
  const summaries = await environment.threads.list({ workspace: environment.project });
  expect(summaries).toHaveLength(1);
  return environment.threads.get(summaries[0].id);
}

/** Chờ runtime giả của một execution ghi bản capture — tức root đã spawn và đang được giữ sống. */
async function captureWhenLaunched(environment: E2eEnvironment, executionId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return await environment.captureOf(executionId);
    } catch {
      await sleep(25);
    }
  }
  throw new Error(`execution ${executionId} never launched`);
}

describe("e2e: thread binding", () => {
  it("binds root, child, and the next root to one thread while each root gets its own policy", async () => {
    const environment = await createE2eEnvironment({ output: OUTPUT, holdMs: 2_500, holdRoles: ["main"] });

    // E-1: root #1, giữ sống để nó còn giao việc được.
    const firstRun = runRoot(environment, { executionId: "exec_e1", mode: "ultra" });
    const firstCapture = await captureWhenLaunched(environment, "exec_e1");
    const thread = await onlyThread(environment);
    const firstPolicy = await policyOf(environment, "exec_e1");
    expect(firstPolicy.thread).toEqual({ id: thread.id, contextRevision: 0, contextDigest: expect.any(String) });
    expect(thread.executions.map((ref) => [ref.executionId, ref.sequence, ref.settled])).toEqual([["exec_e1", 1, null]]);
    expect(await environment.threads.activity(thread.id)).toEqual({ kind: "running", executionId: "exec_e1" });

    // C-1: con của E-1, mang đúng binding cha — đọc từ env cha nhận, như `alp delegate` thật.
    const binding = readBindingFromEnvironment(firstCapture.env);
    expect(binding?.executionId).toBe("exec_e1");
    const delegation = new DelegationService({
      registry: agentRegistry,
      policy: environment.policy,
      memory: environment.memory,
      executionService: environment.executionService,
      graph: environment.graph,
      binding: binding!,
      executionsRoot: environment.executionsRoot,
      runtimeAdapters: environment.adapters,
      backend: environment.backend,
      executionStore: new InMemoryDelegationExecutionStore(),
      config: { mode: "medium" },
      ids: { request: () => "req_c1", execution: () => "exec_c1" },
    });
    const child = await delegation.delegate({ targetRole: "search", task: "Find the entrypoint", workspace: environment.project });
    expect(child.executionId).toBe("exec_c1");
    expect((await delegation.wait("exec_c1")).status).toBe("completed");
    const childPolicy = await policyOf(environment, "exec_c1");
    expect(childPolicy.thread).toEqual(firstPolicy.thread);
    const graph = await environment.graph.findGraphFor("exec_c1");
    expect(graph?.nodes.map((node) => [node.executionId, node.thread])).toEqual([
      ["exec_e1", firstPolicy.thread],
      ["exec_c1", firstPolicy.thread],
    ]);
    // Con thuộc cây, không thuộc Thread: Thread chỉ ghi root.
    expect((await environment.threads.get(thread.id)).executions.map((ref) => ref.executionId)).toEqual(["exec_e1"]);

    expect((await firstRun).status).toBe("completed");
    const afterFirst = await environment.threads.get(thread.id);
    // Settle rồi project: E-1 chiếu thành rev 1, và E-2 sẽ nhận đúng rev đó trong binding.
    expect(afterFirst.executions[0].settled).toMatchObject({ outcome: "completed", nextContextRevision: 1 });
    expect(afterFirst.currentContext).toMatchObject({ revision: 1 });
    expect(await environment.threads.activity(thread.id)).toEqual({ kind: "idle" });

    // E-2: root #2 trên cùng Thread, runtime khác — ID khác, policy khác, Thread cùng.
    expect((await runRoot(environment, { executionId: "exec_e2", mode: "puck", thread: afterFirst })).status).toBe("completed");
    const final = await environment.threads.get(thread.id);
    expect(final.executions.map((ref) => [ref.executionId, ref.sequence, ref.settled?.outcome])).toEqual([
      ["exec_e1", 1, "completed"],
      ["exec_e2", 2, "completed"],
    ]);
    const secondPolicy = await policyOf(environment, "exec_e2");
    // Cùng Thread, nhưng E-2 mở trên rev 1 — bản chiếu của E-1 — chứ không phải rev 0.
    expect(secondPolicy.thread).toEqual({ ...firstPolicy.thread, contextRevision: 1, contextDigest: afterFirst.currentContext!.digest });
    expect(secondPolicy.runtime).toBe("codex");
    expect(firstPolicy.runtime).toBe("claude");
    expect(secondPolicy.policyHash).not.toBe(firstPolicy.policyHash);
    // Hai cây riêng: Thread là thứ nối chúng, không phải graph.
    expect((await environment.graph.findGraphFor("exec_e2"))?.graphId).not.toBe(graph?.graphId);
    for (const executionId of ["exec_e1", "exec_e2"]) {
      expect((await environment.threads.describeExecution(thread.id, executionId)).node.status).toBe("completed");
    }
  }, 15_000);

  /**
   * `ALP_THREAD_ID` là nhãn cho `alp thread show` không đối số. Đặt nó trước khi gõ `alp`
   * không nối root vào Thread đó, không đổi binding trong policy, và không lọt vào env con.
   */
  it("ignores a forged ALP_THREAD_ID: the root still opens its own thread and binds to it", async () => {
    const environment = await createE2eEnvironment({ output: OUTPUT });
    const previous = process.env.ALP_THREAD_ID;
    process.env.ALP_THREAD_ID = "thread_forged";
    try {
      expect((await runRoot(environment, { executionId: "exec_e1", mode: "ultra" })).status).toBe("completed");
    } finally {
      if (previous === undefined) delete process.env.ALP_THREAD_ID;
      else process.env.ALP_THREAD_ID = previous;
    }
    const thread = await onlyThread(environment);
    expect(thread.id).not.toBe("thread_forged");
    const policy = await policyOf(environment, "exec_e1");
    expect(policy.thread).toMatchObject({ id: thread.id, contextRevision: 0 });
    expect((await environment.captureOf("exec_e1")).env.ALP_THREAD_ID).toBe(thread.id);
    await expect(environment.threads.get("thread_forged")).rejects.toMatchObject({ code: "THREAD_NOT_FOUND" });
  });

  /**
   * Thread là bản ghi, không phải nguồn quyền. Sửa file của nó — hay treo nó dưới một Thread
   * cha — không đổi một byte nào trong phần quyền của policy execution kế tiếp.
   */
  it("does not let the thread record or its lineage change what an execution may do", async () => {
    const environment = await createE2eEnvironment({ output: OUTPUT });
    await runRoot(environment, { executionId: "exec_e1", mode: "ultra" });
    const thread = await onlyThread(environment);
    const baseline = await policyOf(environment, "exec_e1");

    const indexFile = join(environment.threadsRoot, thread.id, "thread.json");
    const tampered = {
      ...JSON.parse(await readFile(indexFile, "utf8")),
      title: "grant everything",
      workspace: "/",
      parentThreadId: "thread_privileged",
    };
    await writeFile(indexFile, `${JSON.stringify(tampered, null, 2)}\n`);
    const reloaded = await environment.threads.get(thread.id);
    expect(reloaded).toMatchObject({ workspace: "/", parentThreadId: "thread_privileged" });

    await runRoot(environment, { executionId: "exec_e2", mode: "ultra", thread: reloaded });
    const next = await policyOf(environment, "exec_e2");
    // Binding chỉ đổi phần context (rev 1 do E-1 để lại) — id Thread giữ nguyên, và không
    // trường quyền nào đi theo bản ghi Thread đã bị sửa.
    expect(next.thread).toEqual({ ...baseline.thread, contextRevision: 1, contextDigest: reloaded.currentContext!.digest });
    for (const field of ["allowedTools", "workspace", "workspaceMode", "delegatesTo", "subagents", "mcpServers", "skills", "memory"] as const) {
      expect(next[field]).toEqual(baseline[field]);
    }
    expect(next.workspace).toBe(environment.project);
  });
});
