import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeId } from "../../src/agents/types";
import { collectExecutionEvidence, type CollectedEvidence, type EvidenceCollectorDependencies, type EvidenceItem } from "../../src/execution/evidence";
import { executionArtifactPaths } from "../../src/execution/execution-store";
import { ExecutionGraphService, type ChildRequest, type ExecutionBinding } from "../../src/execution/graph/execution-graph-service";
import { FileExecutionGraphStore } from "../../src/execution/graph/file-execution-graph-store";
import { readExecutionUsage, usageFile, type ExecutionBudget, type UsageCounters } from "../../src/execution/usage";
import { capabilitiesFor } from "../../src/runtime/capabilities";
import { HistoryBridgeRegistry, type RuntimeHistoryBridge } from "../../src/thread/history-bridge";
import type { HistoryDelta } from "../../src/thread/history-types";
import { removeTemporary } from "../support/temporary-root";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => removeTemporary(root))); });

const CLAUDE = capabilitiesFor("claude", "darwin");
const matching = `${CLAUDE.measuredOn.runtimeVersion}.0`;

/**
 * Oracle: P6 spec — "Child: `collectEvidence` chạy bridge sau settle ⇒ ghi `<execution>/usage.json`";
 * "`budgetStatus`: `exceeded` là evidence — item `{ budget, usage, status }` để accept/reject thấy";
 * "`unknown` khi bất kỳ số cần so là `null`"; "`exceeded` không đổi outcome của child";
 * "không có hard budget". The collector is called on a finished child with a fake bridge whose
 * `usageDelta` is the only number source; the file and the item must agree with it.
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "alp-evidence-usage-"));
  roots.push(root);
  const workspace = join(root, "ws");
  await mkdir(join(workspace, "src"), { recursive: true });
  const executionsRoot = join(root, "executions");
  const now = () => new Date("2026-09-17T10:00:00.000Z");
  const graph = new ExecutionGraphService({ store: new FileExecutionGraphStore({ root: join(root, "execution-graphs") }), now });
  const main = await graph.createRoot({ agentId: "main", thread: null, executionId: "exec_root" });

  async function writePolicy(executionId: string) {
    const paths = executionArtifactPaths(executionsRoot, executionId);
    await mkdir(paths.contextDirectory, { recursive: true });
    await writeFile(paths.policyFile, JSON.stringify({
      executionId, workspace, workspaceMode: "workspace-write", writeScope: null, runtime: "claude", enforcement: CLAUDE,
    }));
    await writeFile(paths.stateFile, JSON.stringify({ executionId, status: "prepared" }));
    await writeFile(join(paths.contextDirectory, "launch.json"), JSON.stringify({
      version: 1, executionId, runtime: "claude", runtimeVersion: matching, platform: "darwin",
      authMethod: "unknown", credentialConfigured: false, launchSpecDigest: "d", launchedAt: now().toISOString(),
    }));
  }
  await writePolicy("exec_root");

  async function child(executionId: string, budget?: ExecutionBudget | null): Promise<ExecutionBinding> {
    const request: ChildRequest = {
      requestId: `req_${executionId}`, agentId: "worker", task: "do it", workspace, workspaceMode: "workspace-write", writeScope: null,
      mode: "medium", background: false, interactive: false, timeoutMs: null, metadata: {},
      ...(budget === undefined ? {} : { budget }),
    };
    const reserved = await graph.reserveChild(main.binding, request, { executionId });
    if (reserved.kind !== "reserved") throw new Error("expected a fresh reservation");
    await graph.startReservedChild(reserved, async () => undefined);
    await writePolicy(executionId);
    return reserved.binding;
  }
  return { executionsRoot, graph, now, child, workspace };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function bridge(deltas: readonly Partial<HistoryDelta>[]): RuntimeHistoryBridge & { calls: number } {
  const value = {
    runtime: "claude" as RuntimeId,
    calls: 0,
    probe: async () => ({ completeness: "complete" as const, pinnedVersion: "2.1" }),
    collectDelta: async () => {
      const delta = deltas[Math.min(value.calls, deltas.length - 1)] ?? {};
      value.calls += 1;
      return { entries: [], cursor: { transcriptPath: "/t", lineOffset: 3, lastNativeId: "a1" }, completeness: "complete" as const, pinnedVersion: "2.1", skipped: 0, usageDelta: null, ...delta };
    },
  };
  return value;
}

function deps(fx: Fixture, bridges: readonly RuntimeHistoryBridge[]): EvidenceCollectorDependencies {
  return {
    executionsRoot: fx.executionsRoot,
    graph: fx.graph,
    history: new HistoryBridgeRegistry(bridges),
    baseline: { capture: async () => ({ version: 1, head: "aaa", dirty: [] }), changedBetween: async () => [] },
    verifier: async () => ({ kind: "ran", exitCode: 0, durationMs: 1, tail: "" }),
    verifySettings: async (workspace) => ({ project: workspace, commands: [], digest: null }),
    verifyTrusted: () => false,
    now: fx.now,
  };
}

const usageItems = (collected: CollectedEvidence) => collected.evidence.items.filter((item): item is Extract<EvidenceItem, { kind: "usage" }> => item.kind === "usage");
const COUNTED: UsageCounters = { inputTokens: 122, outputTokens: 53, cacheReadTokens: 1110, cacheWriteTokens: 20, toolCalls: 2 };

describe("collectExecutionEvidence — usage", () => {
  it("writes usage.json from the bridge delta and reports it as an observed item, within budget", async () => {
    const fx = await fixture();
    const binding = await fx.child("exec_a", { tokens: 2000, toolCalls: 5 });
    await fx.graph.finishExecution(binding, { status: "completed" });
    const collected = await collectExecutionEvidence({ executionId: "exec_a" }, deps(fx, [bridge([{ usageDelta: COUNTED }])]));
    expect(usageItems(collected)).toEqual([{
      kind: "usage", provenance: "observed", source: "history-bridge",
      usage: COUNTED, budget: { tokens: 2000, toolCalls: 5 }, status: "within",
    }]);
    expect(collected.usage).toEqual(COUNTED);
    expect(collected.budgetStatus).toBe("within");
    expect(collected.evaluation).toBe("satisfied");
    const file = JSON.parse(await readFile(usageFile(fx.executionsRoot, "exec_a"), "utf8"));
    expect(file).toEqual({
      version: 1, executionId: "exec_a", source: "history-bridge", completeness: "complete", collectedAt: "2026-09-17T10:00:00.000Z", ...COUNTED,
    });
    expect(await readExecutionUsage(fx.executionsRoot, "exec_a")).toEqual(file);
  });

  it("marks `exceeded` as evidence only: the child's outcome and the requirement evaluation are untouched", async () => {
    const fx = await fixture();
    const binding = await fx.child("exec_a", { tokens: 1000 });
    await fx.graph.finishExecution(binding, { status: "completed" });
    const collected = await collectExecutionEvidence({ executionId: "exec_a" }, deps(fx, [bridge([{ usageDelta: COUNTED }])]));
    expect(usageItems(collected)[0]?.status).toBe("exceeded");
    expect(collected.budgetStatus).toBe("exceeded");
    expect(collected.evaluation).toBe("satisfied");
    const node = (await fx.graph.findGraphFor("exec_a"))!.nodes.find((entry) => entry.executionId === "exec_a")!;
    expect(node.status).toBe("completed");
  });

  it("is `unknown` when a column the budget needs is null, and `within` with no budget at all", async () => {
    const fx = await fixture();
    const a = await fx.child("exec_a", { toolCalls: 3 });
    const b = await fx.child("exec_b");
    await fx.graph.finishExecution(a, { status: "completed" });
    await fx.graph.finishExecution(b, { status: "failed" });
    const partial = await collectExecutionEvidence({ executionId: "exec_a" }, deps(fx, [bridge([{ usageDelta: { ...COUNTED, toolCalls: null }, completeness: "partial" }])]));
    expect(usageItems(partial)).toEqual([{
      kind: "usage", provenance: "derived", source: "history-bridge",
      usage: { ...COUNTED, toolCalls: null }, budget: { toolCalls: 3 }, status: "unknown",
    }]);
    expect(partial.budgetStatus).toBe("unknown");
    expect((await readExecutionUsage(fx.executionsRoot, "exec_a"))?.toolCalls).toBeNull();
    const free = await collectExecutionEvidence({ executionId: "exec_b" }, deps(fx, [bridge([{ usageDelta: COUNTED }])]));
    expect(usageItems(free)[0]).toMatchObject({ budget: null, status: "within" });
  });

  it("reports nothing when the bridge has no numbers: no item, no file, budget `unknown` only if one was set", async () => {
    const fx = await fixture();
    const a = await fx.child("exec_a", { tokens: 10 });
    const b = await fx.child("exec_b");
    await fx.graph.finishExecution(a, { status: "completed" });
    await fx.graph.finishExecution(b, { status: "completed" });
    const budgeted = await collectExecutionEvidence({ executionId: "exec_a" }, deps(fx, [bridge([{ usageDelta: null }])]));
    expect(usageItems(budgeted)).toEqual([]);
    expect(budgeted.usage).toBeNull();
    expect(budgeted.budgetStatus).toBe("unknown");
    await expect(stat(usageFile(fx.executionsRoot, "exec_a"))).rejects.toMatchObject({ code: "ENOENT" });
    const none = await collectExecutionEvidence({ executionId: "exec_b" }, deps(fx, []));
    expect(none.usage).toBeNull();
    expect(none.budgetStatus).toBe("within");
  });

  it("accumulates across a refresh instead of re-reading from the start, and returns the file unchanged when nothing moved", async () => {
    const fx = await fixture();
    const binding = await fx.child("exec_a", { tokens: 200 });
    await fx.graph.finishExecution(binding, { status: "completed" });
    const first = { inputTokens: 50, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 1 };
    const second = { inputTokens: 80, outputTokens: 70, cacheReadTokens: 5, cacheWriteTokens: 0, toolCalls: 1 };
    // The first pass is partial (an unknown-free but not complete transcript), so the collector asks the bridge again.
    const moving = bridge([{ usageDelta: first, completeness: "final-only" }, { usageDelta: second }, { usageDelta: null }]);
    const d = deps(fx, [moving]);
    const one = await collectExecutionEvidence({ executionId: "exec_a" }, d);
    expect(one.usage).toEqual(first);
    expect(one.budgetStatus).toBe("within");
    const two = await collectExecutionEvidence({ executionId: "exec_a" }, d);
    expect(two.usage).toEqual({ inputTokens: 130, outputTokens: 80, cacheReadTokens: 5, cacheWriteTokens: 0, toolCalls: 2 });
    expect(two.budgetStatus).toBe("exceeded");
    expect(usageItems(two)).toHaveLength(1);
    const three = await collectExecutionEvidence({ executionId: "exec_a" }, d);
    expect(three.usage).toEqual(two.usage);
    expect(three.evidence.digest).toBe(two.evidence.digest);
    expect(moving.calls).toBe(2);
  });
});
