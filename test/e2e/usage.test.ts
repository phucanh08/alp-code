import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentRegistry } from "../../src/agents/registry";
import { runDelegateCommand, runDelegationLifecycleCommand } from "../../src/cli/commands/delegate";
import { DelegationService, InMemoryDelegationExecutionStore } from "../../src/delegation/delegation-service";
import type { ExecutionTreeNode, ExecutionTreeView } from "../../src/execution/graph/execution-graph-service";
import { readExecutionUsage, type UsageCounters } from "../../src/execution/usage";
import { ClaudeHistoryBridge } from "../../src/runtime/claude-history-bridge";
import { HistoryBridgeRegistry } from "../../src/thread/history-bridge";
import { cleanupEnvironments, createE2eEnvironment, createMaterializedRoot } from "./harness";

afterEach(cleanupEnvironments);

/**
 * A root `main` delegating to a fake runtime that writes one file and leaves a Claude
 * transcript with one API message (split over two lines, as 2.1.268 does) carrying
 * `usage` — 120 in / 45 out / 900 cache read / 30 cache write — and one tool call.
 */
async function session(executionId: string) {
  const environment = await createE2eEnvironment({ output: "done", extraEnv: { ALP_E2E_WRITE_FILE: "src/parser/new.ts", ALP_E2E_TRANSCRIPT: "1" } });
  const { project } = environment;
  await mkdir(join(project, "src", "parser"), { recursive: true });
  const env = { HOME: environment.root };
  const root = await createMaterializedRoot(environment, { agentId: "main", executionId: "exec_root_main" });
  const service = new DelegationService({
    registry: agentRegistry,
    policy: environment.policy,
    memory: environment.memory,
    executionService: environment.executionService,
    graph: environment.graph,
    binding: root.binding,
    executionsRoot: environment.executionsRoot,
    runtimeAdapters: environment.adapters,
    backend: environment.backend,
    executionStore: new InMemoryDelegationExecutionStore(),
    config: { mode: "low" },
    ids: { request: () => `req_${executionId}`, execution: () => executionId },
    evidence: { history: new HistoryBridgeRegistry([new ClaudeHistoryBridge({ env })]) },
  });
  return { environment, service, project, env };
}

const EXPECTED: UsageCounters = { inputTokens: 120, outputTokens: 45, cacheReadTokens: 900, cacheWriteTokens: 30, toolCalls: 1 };
const flatten = (node: ExecutionTreeNode): ExecutionTreeNode[] => [node, ...node.children.flatMap(flatten)];

/**
 * Oracle: P6 "Tiêu chí hoàn thành" — `alp delegation tree` prints token / tool-call counts
 * for the node; `--budget-tokens` yields `exceeded` correctly; a budget is observe-only
 * (the child's outcome is what it was); the transcript is counted once, not per line;
 * no new hook (`PreToolUse`) appears in the settings ALP emits.
 */
describe("e2e: usage after a delegated run", () => {
  it("counts the transcript once, writes usage.json, and reports a budget verdict on wait", async () => {
    const { environment, service, project } = await session("exec_usage");
    const spawned = await service.delegate({
      targetRole: "worker", task: "Add a parser", workspace: project, workspaceMode: "workspace-write", budget: { tokens: 1000 },
    });
    const waited = await service.wait(spawned.executionId);
    expect(waited).toMatchObject({ status: "completed", output: "done", usage: EXPECTED, budgetStatus: "exceeded" });
    expect(await readExecutionUsage(environment.executionsRoot, spawned.executionId)).toMatchObject({ version: 1, executionId: spawned.executionId, source: "history-bridge", ...EXPECTED });

    const tree = await runDelegationLifecycleCommand(["tree", spawned.executionId, "--json"], service) as ExecutionTreeView;
    expect(flatten(tree.root).find((node) => node.executionId === spawned.executionId)).toMatchObject({ status: "completed", budget: { tokens: 1000 }, usage: EXPECTED });
    // The root never ran a counted transcript, so the sum is partial; the child's numbers are all of it.
    expect(tree.usage).toEqual({ total: EXPECTED, partial: true });
    const rendered = await runDelegationLifecycleCommand(["tree", spawned.executionId], service) as { rendered: string };
    expect(rendered.rendered).toContain("usage in 120 out 45 cache 900/30 tools 1  ·  budget exceeded");
    expect(rendered.rendered).toContain("usage in 120  ·  out 45  ·  cache r/w 900/30  ·  tools 1  (partial)");

    const evidence = await runDelegationLifecycleCommand(["evidence", spawned.executionId], service) as { rendered: string };
    expect(evidence.rendered).toContain("in 120 out 45 cache 900/30 tools 1 · budget exceeded · tokens ≤ 1000");

    // Nothing in what ALP handed the runtime blocks a tool call: observe-only means no PreToolUse.
    // The fake runtime captured the settings file it was launched with (`--settings <path>`).
    const capture = await environment.captureOf(spawned.executionId);
    expect(capture.argv).toContain("--settings");
    const settings = JSON.parse(capture.runtimeConfig!) as { hooks: Record<string, unknown> };
    expect(Object.keys(settings.hooks)).toEqual(expect.arrayContaining(["SessionStart", "Stop"]));
    expect(settings.hooks).not.toHaveProperty("PreToolUse");
  }, 15_000);

  it("`alp delegate --budget-tokens/--budget-tool-calls` reach the node; `within` when the run fits", async () => {
    const { environment, service, project } = await session("exec_usage_cli");
    const result = await runDelegateCommand(
      ["worker", "--workspace", project, "--budget-tokens", "5000", "--budget-tool-calls", "2", "--", "Add", "a", "parser"],
      { cwd: project, env: { HOME: environment.root }, service },
    );
    expect(result).toMatchObject({ executionId: "exec_usage_cli", status: "completed", usage: EXPECTED, budgetStatus: "within" });
    const node = flatten((await service.tree("exec_usage_cli")).root).find((entry) => entry.executionId === "exec_usage_cli");
    expect(node).toMatchObject({ budget: { tokens: 5000, toolCalls: 2 }, usage: EXPECTED });
  }, 15_000);
});
