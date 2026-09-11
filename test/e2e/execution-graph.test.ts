import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_DEFINITIONS, createAgentRegistry } from "../../src/agents/registry";
import type { AgentDefinition, AgentRegistry } from "../../src/agents/types";
import { DelegationService, InMemoryDelegationExecutionStore } from "../../src/delegation/delegation-service";
import {
  readBindingFromEnvironment,
  type ExecutionBinding,
} from "../../src/execution/graph/execution-graph-service";
import { renderExecutionTree } from "../../src/cli/commands/delegate";
import { cleanupEnvironments, createE2eEnvironment, type E2eEnvironment } from "./harness";

const OUTPUT = "Entrypoint located at index.ts:1 — `export const entrypoint`.";

afterEach(cleanupEnvironments);

/**
 * A registry that lets `worker` delegate, built here and only here.
 *
 * P0 does not change topology: `worker.delegatesTo` stays `[]` in the shipped definitions,
 * and `test/agents/definitions.test.ts` holds that line. But a graph whose every branch is
 * one level deep never exercises the depth ceiling, the inherited deadline or a cascade
 * through a middle node — so the nesting is manufactured in the test's own registry.
 */
function nestedRegistry(): AgentRegistry {
  return createAgentRegistry(AGENT_DEFINITIONS.map((definition) =>
    definition.id === "worker"
      ? { ...definition, delegatesTo: ["search"] } as AgentDefinition<unknown>
      : definition));
}

/** A service speaking for one node of the tree, holding exactly that node's capability. */
function serviceFor(environment: E2eEnvironment, binding: ExecutionBinding, executionId: string) {
  return new DelegationService({
    registry: environment.registry,
    policy: environment.policy,
    memory: environment.memory,
    executionService: environment.executionService,
    graph: environment.graph,
    binding,
    executionsRoot: environment.executionsRoot,
    runtimeAdapters: environment.adapters,
    backend: environment.backend,
    executionStore: new InMemoryDelegationExecutionStore(),
    config: { mode: "medium" },
    ids: { request: () => `req_${executionId}`, execution: () => executionId },
  });
}

const sleep = (ms: number): Promise<void> => new Promise((settle) => setTimeout(settle, ms));

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await sleep(10);
  }
}

/**
 * The chain a real nested run takes, one process boundary at a time.
 *
 * The middle node is left running, which is the only state a delegating parent is ever in:
 * a worker that has already finished has nothing left to delegate, and the tree refuses it.
 *
 * The second hop deliberately does not reuse the binding object the first hop returned: it
 * reads the binding back out of the environment the worker's runtime was actually handed,
 * which is the only thing a delegate process really has. A capability that failed to travel
 * would fail here instead of being papered over by an in-memory handoff.
 */
async function chain(environment: E2eEnvironment) {
  const root = await environment.graph.createRoot({ agentId: "main", thread: null, executionId: "exec_main" });
  const main = serviceFor(environment, root.binding, "exec_worker");
  const worker = await main.delegate({
    targetRole: "worker",
    task: "Rename the entrypoint",
    workspace: environment.project,
  });
  await waitFor(() => existsSync(join(environment.captureDirectory, "exec_worker.json")));

  const handed = await environment.captureOf("exec_worker");
  const workerBinding = readBindingFromEnvironment(handed.env);
  expect(workerBinding).not.toBeNull();
  return { root, main, worker, workerBinding: workerBinding as ExecutionBinding };
}

describe("e2e: execution graph", () => {
  it("carries a real chain main→worker→search down two levels", async () => {
    // `worker` còn sống trong lúc nó giao việc, đúng như một cha thật: một nấc đã thoát thì
    // không còn gì để giao, và cây từ chối nó.
    const environment = await createE2eEnvironment({
      output: OUTPUT, registry: nestedRegistry(), holdMs: 3_000, holdRoles: ["worker"],
    });
    const { root, main, workerBinding } = await chain(environment);

    const nested = serviceFor(environment, workerBinding, "exec_search");
    const search = await nested.delegate({
      targetRole: "search",
      task: "Find the entrypoint",
      workspace: environment.project,
    });
    const result = await nested.wait(search.executionId);

    expect(result).toMatchObject({ status: "completed", output: OUTPUT });
    const view = await main.tree("exec_search");
    expect(view.root).toMatchObject({ executionId: "exec_main", agentId: "main", depth: 0 });
    expect(view.root.children[0]).toMatchObject({ executionId: "exec_worker", agentId: "worker", depth: 1 });
    expect(view.root.children[0].children[0])
      .toMatchObject({ executionId: "exec_search", agentId: "search", depth: 2, status: "completed" });
    // Hạn cố định một lần ở root và được kế thừa nguyên vẹn: cháu không được gia hạn cho mình
    // bằng cách sinh ra muộn hơn.
    expect(view.deadlineAt).toBe(root.graph.deadlineAt);
    expect(workerBinding.deadlineAt).toBe(root.graph.deadlineAt);
    const grandchild = await environment.captureOf("exec_search");
    expect(grandchild.env.ALP_EXECUTION_DEADLINE_AT).toBe(root.graph.deadlineAt);
  });

  /**
   * Trần độ sâu phải chặn **trước** khi có bất cứ thứ gì để dọn.
   *
   * Một lần từ chối xảy ra sau khi artifact đã ghi và process đã spawn thì không còn là một
   * lần từ chối: nó là một execution đã chạy cộng thêm một thông báo lỗi.
   */
  it("refuses depth 3 before any artifact or process exists", async () => {
    const environment = await createE2eEnvironment({
      output: OUTPUT,
      holdMs: 3_000,
      holdRoles: ["worker", "search"],
      registry: createAgentRegistry(AGENT_DEFINITIONS.map((definition) => {
        if (definition.id === "worker") return { ...definition, delegatesTo: ["search"] } as AgentDefinition<unknown>;
        if (definition.id === "search") return { ...definition, delegatesTo: ["oracle"] } as AgentDefinition<unknown>;
        return definition;
      })),
    });
    const { workerBinding } = await chain(environment);
    const nested = serviceFor(environment, workerBinding, "exec_search");
    await nested.delegate({
      targetRole: "search",
      task: "Find the entrypoint",
      workspace: environment.project,
    });
    await waitFor(() => existsSync(join(environment.captureDirectory, "exec_search.json")));
    const searchBinding = readBindingFromEnvironment((await environment.captureOf("exec_search")).env);

    const tooDeep = serviceFor(environment, searchBinding as ExecutionBinding, "exec_too_deep");
    await expect(tooDeep.delegate({
      targetRole: "oracle",
      task: "Explain it, one level deeper",
      workspace: environment.project,
    })).rejects.toMatchObject({ code: "DEPTH_LIMIT_EXCEEDED" });

    await expect(stat(join(environment.executionsRoot, "exec_too_deep")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(environment.captureOf("exec_too_deep")).rejects.toMatchObject({ code: "ENOENT" });
    const view = await tooDeep.tree("exec_main");
    expect(view.summary.total).toBe(3);
    // Lần giao việc bị từ chối không tiêu allowance: `worker` và `search`, không có nấc thứ ba.
    expect(view.delegation.used).toBe(2);
  });

  /** Cùng một `requestId` gọi hai lần là một lần gọi bị lặp — không phải hai process. */
  it("charges a repeated request once and returns the same child", async () => {
    const environment = await createE2eEnvironment({ output: OUTPUT, registry: nestedRegistry() });
    const root = await environment.graph.createRoot({ agentId: "main", thread: null, executionId: "exec_main" });
    const main = serviceFor(environment, root.binding, "exec_worker");
    const request = {
      requestId: "req_retried",
      targetRole: "worker",
      task: "Rename the entrypoint",
      workspace: environment.project,
    };

    const first = await main.delegate(request);
    const second = await main.delegate(request);

    expect(second.executionId).toBe(first.executionId);
    const view = await main.tree("exec_main");
    expect(view.summary.total).toBe(2);
    expect(view.delegation.used).toBe(1);
  });

  /**
   * Huỷ một nhánh là huỷ cả nhánh, và chỉ nhánh đó. Anh em của nó đang chạy vì một lý do
   * khác, và không ai bảo dừng chúng.
   */
  it("cancels a branch to its leaves and leaves the sibling alone", async () => {
    // Mọi nấc còn sống khi tín hiệu tới: huỷ một cây đã tự thoát không chứng minh được gì.
    const environment = await createE2eEnvironment({ holdMs: 4_000, registry: nestedRegistry() });
    const root = await environment.graph.createRoot({ agentId: "main", thread: null, executionId: "exec_main" });
    const main = serviceFor(environment, root.binding, "exec_worker");
    await main.delegate({
      targetRole: "worker",
      task: "Rename the entrypoint",
      workspace: environment.project,
    });
    await waitFor(() => existsSync(join(environment.captureDirectory, "exec_worker.json")));
    const workerBinding = readBindingFromEnvironment((await environment.captureOf("exec_worker")).env);
    const nested = serviceFor(environment, workerBinding as ExecutionBinding, "exec_search");
    await nested.delegate({
      targetRole: "search",
      task: "Find the entrypoint",
      workspace: environment.project,
    });
    const sibling = serviceFor(environment, root.binding, "exec_oracle");
    await sibling.delegate({
      targetRole: "oracle",
      task: "Explain the entrypoint",
      workspace: environment.project,
    });

    await main.cancel("exec_worker");

    const view = await main.tree("exec_main");
    const worker = view.root.children.find((node) => node.executionId === "exec_worker")!;
    const oracle = view.root.children.find((node) => node.executionId === "exec_oracle")!;
    expect(worker.status).toBe("cancelled");
    expect(worker.children[0]).toMatchObject({
      executionId: "exec_search",
      cancellation: { reason: "PARENT_CANCELLED", requestedBy: "exec_worker" },
    });
    expect(oracle.cancellation).toBeNull();
    expect(oracle.status).not.toBe("cancelled");
  });

  /**
   * Cây sống trên đĩa, nên một process mới phải đọc lại được đúng nó: quan hệ cha con,
   * allowance đã tiêu, hạn, và cả lý do một nhánh đã dừng.
   */
  it("survives a restart of every in-memory service around it", async () => {
    const environment = await createE2eEnvironment({
      output: OUTPUT, registry: nestedRegistry(), holdMs: 3_000, holdRoles: ["worker"],
    });
    const { root, main, workerBinding } = await chain(environment);
    const nested = serviceFor(environment, workerBinding, "exec_search");
    await nested.delegate({
      targetRole: "search",
      task: "Find the entrypoint",
      workspace: environment.project,
    });
    await nested.wait("exec_search");

    // Một process mới: service khác, store legacy khác, không mang gì từ lần trước ngoài đĩa.
    const reopened = serviceFor(environment, root.binding, "exec_unused");
    const view = await reopened.tree("exec_search");

    expect(view.root.children[0].children[0]).toMatchObject({
      executionId: "exec_search",
      parentExecutionId: "exec_worker",
      depth: 2,
    });
    expect(view.delegation.used).toBe(2);
    expect(view.deadlineAt).toBe(root.graph.deadlineAt);
    await expect(reopened.status("exec_search")).resolves.toMatchObject({ status: "completed" });
  });
  /**
   * Capability là thứ *duy nhất* cho phép một process nói "tôi là node này". Nó sống trong
   * env của process sở hữu nó và không được ở đâu khác: cây chỉ giữ hash, còn artifact, log,
   * result và state trên đĩa thì bị đọc lại, đính vào bug report, và sao chép đi.
   */
  it("writes no capability to any durable surface", async () => {
    const environment = await createE2eEnvironment({
      output: OUTPUT, registry: nestedRegistry(), holdMs: 3_000, holdRoles: ["worker"],
    });
    const { root, workerBinding } = await chain(environment);
    const nested = serviceFor(environment, workerBinding, "exec_search");
    await nested.delegate({
      targetRole: "search",
      task: "Find the entrypoint",
      workspace: environment.project,
    });
    await nested.wait("exec_search");
    const searchBinding = readBindingFromEnvironment((await environment.captureOf("exec_search")).env);

    const secrets = [root.binding.capability, workerBinding.capability, (searchBinding as ExecutionBinding).capability];
    for (const secret of secrets) expect(secret.length).toBeGreaterThan(16);

    // Thư mục capture là bản ghi của test về env mà runtime nhận — chính là chỗ capability
    // *phải* có mặt. Mọi thứ còn lại dưới root là mặt bền của ALP.
    const offenders: string[] = [];
    const scanned: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (path === environment.captureDirectory || path === environment.binDirectory) continue;
        if (entry.isDirectory()) { await walk(path); continue; }
        if (!entry.isFile()) continue;
        scanned.push(path.slice(environment.root.length + 1));
        const content = await readFile(path, "utf8").catch(() => "");
        if (secrets.some((secret) => content.includes(secret))) offenders.push(path);
      }
    };
    await walk(environment.root);

    expect(offenders).toEqual([]);
    // Một cuộc quét không đọc gì thì luôn sạch. Ba mặt bền phải thực sự nằm trong tay nó.
    expect(scanned).toContain(join("execution-graphs", "exec_main.json"));
    expect(scanned).toContain(join("executions", "exec_worker", "state.json"));
    expect(scanned).toContain(join("executions", "exec_worker", "policy.json"));
    // Và cây giữ đúng cái nó được phép giữ: một hash, có mặt, khác với chính capability.
    const document = JSON.parse(await readFile(join(environment.graphsRoot, "exec_main.json"), "utf8")) as {
      nodes: readonly { executionId: string; capabilityHash: string }[];
    };
    const worker = document.nodes.find((node) => node.executionId === "exec_worker")!;
    expect(worker.capabilityHash).toBeTruthy();
    expect(worker.capabilityHash).not.toBe(workerBinding.capability);
  });

  /** Cùng một luật cho output của CLI: một cái cây in ra rồi được dán vào issue. */
  it("keeps the capability out of what an operator sees", async () => {
    const environment = await createE2eEnvironment({
      output: OUTPUT, registry: nestedRegistry(), holdMs: 3_000, holdRoles: ["worker"],
    });
    const { main, root, workerBinding } = await chain(environment);

    const view = await main.tree("exec_worker");

    const printed = JSON.stringify(view) + renderExecutionTree(view);
    expect(printed).not.toContain(root.binding.capability);
    expect(printed).not.toContain(workerBinding.capability);
    expect(printed).not.toMatch(/capabilityHash/);
  });
});
