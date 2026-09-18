import { describe, expect, it } from "vitest";
import { DEFAULT_EXECUTION_GRAPH_LIMITS } from "../../../src/execution/graph/defaults";
import { isExecutionGraphError } from "../../../src/execution/graph/errors";
import {
  ExecutionGraphService,
  requestFingerprint,
  type ChildRequest,
  type ExecutionBinding,
  type ReservedChild,
} from "../../../src/execution/graph/execution-graph-service";
import { InMemoryExecutionGraphStore } from "../../../src/execution/graph/in-memory-execution-graph-store";
import { assertGraphDocument, assertStructuralFieldsPreserved } from "../../../src/execution/graph/invariants";
import type { ExecutionGraphDocument } from "../../../src/execution/graph/types";
import type { UsageCounters } from "../../../src/execution/usage";
import { childNode, graphFixture, rootNode } from "../../support/execution-graph-fixture";

/**
 * Oracle: plan P6 §"Graph" — `budget` là cấu trúc (vào fingerprint chỉ khi có, để request cũ
 * giữ nguyên fingerprint; bất biến sau khi giao); `usage` chỉ ghi ở node đã dừng, cùng lúc với
 * evidence; node legacy đọc lên có `budget: null`, `usage: null`.
 */
const base: ChildRequest = {
  requestId: "req_1", agentId: "worker", task: "edit the parser", workspace: "/ws", workspaceMode: "workspace-write",
  mode: "medium", background: false, interactive: false, timeoutMs: null, metadata: {}, writeScope: null,
};
/** Fingerprint của request không budget tại `7ada32f` (P5): P6 không được làm nó đổi. */
const P5_FINGERPRINT = "ea3d42254ac4e19f574bfd530dd958294b6be93374f873c173fa94226d225b6c";

describe("requestFingerprint — budget", () => {
  it("keeps the pre-P6 fingerprint for a request without a budget, however the absence is spelled", () => {
    expect(requestFingerprint("exec_parent", base)).toBe(P5_FINGERPRINT);
    expect(requestFingerprint("exec_parent", { ...base, budget: null })).toBe(P5_FINGERPRINT);
    expect(requestFingerprint("exec_parent", { ...base, budget: undefined })).toBe(P5_FINGERPRINT);
  });

  it("makes a budgeted request a different piece of work, and two ceilings different from each other", () => {
    const tokens = requestFingerprint("exec_parent", { ...base, budget: { tokens: 1000 } });
    const tokens2 = requestFingerprint("exec_parent", { ...base, budget: { tokens: 2000 } });
    const tools = requestFingerprint("exec_parent", { ...base, budget: { toolCalls: 5 } });
    expect(new Set([P5_FINGERPRINT, tokens, tokens2, tools]).size).toBe(4);
    expect(requestFingerprint("exec_parent", { ...base, budget: { tokens: 1000 } })).toBe(tokens);
  });
});

function harness() {
  const store = new InMemoryExecutionGraphStore();
  let clock = Date.parse("2026-09-17T00:00:00.000Z");
  let executions = 0;
  let reservations = 0;
  const service = new ExecutionGraphService({
    store,
    now: () => new Date(clock),
    newExecutionId: () => `exec_${++executions}`,
    newReservationId: () => `rsv_${++reservations}`,
    limits: { ...DEFAULT_EXECUTION_GRAPH_LIMITS, maxChildrenPerExecution: 8, maxConcurrentChildrenPerExecution: 8, maxConcurrentExecutions: 12, delegationLimit: 8 },
  });
  return { store, service, advance: (ms: number) => { clock += ms; } };
}

async function spawn(service: ExecutionGraphService, parent: ExecutionBinding, overrides: Partial<ChildRequest> = {}): Promise<ExecutionBinding> {
  const reserved = await service.reserveChild(parent, { ...base, workspace: "/project", background: true, ...overrides }) as ReservedChild;
  await service.startReservedChild(reserved, async () => ({ executionId: reserved.binding.executionId, status: "running" as const }));
  return reserved.binding;
}

async function codeOf(operation: () => Promise<unknown>): Promise<string | null> {
  try { await operation(); return null; } catch (error) {
    if (isExecutionGraphError(error)) return error.code;
    throw error;
  }
}

const usage: UsageCounters = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 0, toolCalls: 2 };
const ref = { digest: "a".repeat(64), evaluation: "satisfied" as const };

describe("ExecutionGraphService — budget on the node", () => {
  it("carries the budget from request to reservation to node, null when none was asked", async () => {
    const { service, store } = harness();
    const root = await service.createRoot({ agentId: "main", thread: null });
    await service.startRoot(root.binding, async () => undefined);
    const budgeted = await spawn(service, root.binding, { requestId: "req_b", budget: { tokens: 500, toolCalls: 3 } });
    const plain = await spawn(service, root.binding, { requestId: "req_p" });
    const graph = (await store.get(root.binding.graphId))!;
    const nodeOf = (id: string) => graph.nodes.find((node) => node.executionId === id)!;
    expect(nodeOf(budgeted.executionId).budget).toEqual({ tokens: 500, toolCalls: 3 });
    expect(nodeOf(plain.executionId).budget).toBeNull();
    expect(nodeOf(root.binding.executionId).budget).toBeNull();
    expect(graph.nodes.every((node) => node.usage === null)).toBe(true);
  });

  it("records usage only on an ended node, alongside the evidence ref, and rewrites nothing for the same numbers", async () => {
    const { service, store, advance } = harness();
    const root = await service.createRoot({ agentId: "main", thread: null });
    await service.startRoot(root.binding, async () => undefined);
    const child = await spawn(service, root.binding, { requestId: "req_c" });
    expect(await codeOf(() => service.recordEvidence(root.binding.graphId, child.executionId, ref, usage))).toBe("INVALID_NODE_TRANSITION");
    advance(1_000);
    await service.finishExecution(child, { status: "completed" });
    const before = (await store.get(root.binding.graphId))!.revision;
    const recorded = await service.recordEvidence(root.binding.graphId, child.executionId, ref, usage);
    expect(recorded).toMatchObject({ evidence: ref, usage });
    expect((await store.get(root.binding.graphId))!.revision).toBe(before + 1);
    await service.recordEvidence(root.binding.graphId, child.executionId, ref, { ...usage });
    expect((await store.get(root.binding.graphId))!.revision).toBe(before + 1);
    // Numbers that moved (a later slice) are a real write; a call without usage leaves the old numbers.
    const more = { ...usage, outputTokens: 9 };
    expect(await service.recordEvidence(root.binding.graphId, child.executionId, ref, more)).toMatchObject({ usage: more });
    expect((await store.get(root.binding.graphId))!.revision).toBe(before + 2);
    expect(await service.recordEvidence(root.binding.graphId, child.executionId, ref)).toMatchObject({ usage: more });
    expect((await store.get(root.binding.graphId))!.revision).toBe(before + 2);
  });
});

describe("graph invariants — budget and usage", () => {
  it("normalizes a legacy node without the keys to budget null / usage null", () => {
    const { budget: _b, usage: _u, ...legacy } = childNode("child-a", "root-1") as never as Record<string, unknown>;
    const normalized = assertGraphDocument(graphFixture({ nodes: [rootNode(), legacy as never] }));
    expect(normalized.nodes[1]).toMatchObject({ budget: null, usage: null });
    expect("budget" in normalized.nodes[1] && "usage" in normalized.nodes[1]).toBe(true);
  });

  // GitHub #23: `unevaluated` is a stored verdict now; a graph written by this version must
  // read back, and an unknown word must still be refused.
  it("accepts `unevaluated` as an evidence verdict and refuses anything outside the enum", () => {
    const codeOfSync = (run: () => unknown): string | null => { try { run(); return null; } catch (error) { if (isExecutionGraphError(error)) return error.code; throw error; } };
    const ended = { status: "completed" as const, startedAt: "2026-09-11T00:00:01.000Z", endedAt: "2026-09-11T00:00:02.000Z" };
    const withVerdict = (evaluation: string) => graphFixture({ nodes: [rootNode(), childNode("child-a", "root-1", { ...ended, evidence: { digest: "a".repeat(64), evaluation } as never })] });
    for (const evaluation of ["unevaluated", "satisfied", "unsatisfied", "unknown"]) {
      expect(codeOfSync(() => assertGraphDocument(withVerdict(evaluation))), evaluation).toBeNull();
    }
    expect(codeOfSync(() => assertGraphDocument(withVerdict("maybe")))).toBe("EXECUTION_GRAPH_INVALID");
  });

  it("refuses a malformed budget, usage on an active node, and a budget that changes after delegation", () => {
    const codeOfSync = (run: () => unknown): string | null => { try { run(); return null; } catch (error) { if (isExecutionGraphError(error)) return error.code; throw error; } };
    for (const bad of [{ tokens: 0 }, { tokens: 1.5 }, { toolCalls: -1 }, { tokens: "10" }, "lots", {}]) {
      const graph = graphFixture({ nodes: [rootNode(), childNode("child-a", "root-1", { budget: bad as never })] });
      expect(codeOfSync(() => assertGraphDocument(graph)), JSON.stringify(bad)).toBe("EXECUTION_GRAPH_INVALID");
    }
    const active = graphFixture({ nodes: [rootNode(), childNode("child-a", "root-1", { status: "running", startedAt: "2026-09-11T00:00:01.000Z", usage })] });
    expect(codeOfSync(() => assertGraphDocument(active))).toBe("EXECUTION_GRAPH_INVALID");
    const badUsage = graphFixture({ nodes: [rootNode(), childNode("child-a", "root-1", { status: "completed", startedAt: "2026-09-11T00:00:01.000Z", endedAt: "2026-09-11T00:00:02.000Z", usage: { ...usage, toolCalls: 1.5 } })] });
    expect(codeOfSync(() => assertGraphDocument(badUsage))).toBe("EXECUTION_GRAPH_INVALID");

    const previous: ExecutionGraphDocument = graphFixture({ nodes: [rootNode(), childNode("child-a", "root-1", { budget: { tokens: 10 } })] });
    const next = { ...previous, revision: previous.revision + 1, nodes: [previous.nodes[0], { ...previous.nodes[1], budget: { tokens: 20 } }] };
    expect(codeOfSync(() => assertStructuralFieldsPreserved(previous, next))).toBe("EXECUTION_GRAPH_INVALID");
    const same = { ...previous, revision: previous.revision + 1, nodes: [previous.nodes[0], { ...previous.nodes[1], budget: { tokens: 10 } }] };
    expect(codeOfSync(() => assertStructuralFieldsPreserved(previous, same))).toBeNull();
  });
});
