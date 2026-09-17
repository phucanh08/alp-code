import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acceptanceFile,
  countDelegations,
  delegationDecision,
  DELEGATION_SUMMARY_LIMIT,
  readAcceptanceRecord,
  summarizeDelegations,
  TASK_EXCERPT_MAX_CHARS,
  taskExcerpt,
  writeAcceptanceRecord,
  type AcceptanceRecordV1,
} from "../../src/execution/acceptance";
import { DEFAULT_EXECUTION_GRAPH_LIMITS } from "../../src/execution/graph/defaults";
import { isExecutionGraphError } from "../../src/execution/graph/errors";
import {
  ExecutionGraphService,
  type ChildRequest,
  type ExecutionBinding,
  type ReservedChild,
} from "../../src/execution/graph/execution-graph-service";
import { InMemoryExecutionGraphStore } from "../../src/execution/graph/in-memory-execution-graph-store";
import { assertGraphDocument } from "../../src/execution/graph/invariants";
import type { ExecutionAcceptanceRef, ExecutionGraphDocument, ExecutionNode } from "../../src/execution/graph/types";
import { REDACTED } from "../../src/thread/history-redact";

const BASE_TIME = "2026-09-11T00:00:00.000Z";

function harness() {
  const store = new InMemoryExecutionGraphStore();
  let clock = Date.parse(BASE_TIME);
  let executions = 0;
  let reservations = 0;
  const service = new ExecutionGraphService({
    store,
    now: () => new Date(clock),
    newExecutionId: () => `exec_${++executions}`,
    newReservationId: () => `rsv_${++reservations}`,
    limits: { ...DEFAULT_EXECUTION_GRAPH_LIMITS, maxChildrenPerExecution: 40, maxConcurrentChildrenPerExecution: 8, maxConcurrentExecutions: 12, delegationLimit: 40 },
  });
  return { store, service, advance: (ms: number) => { clock += ms; } };
}

function request(overrides: Partial<ChildRequest> = {}): ChildRequest {
  return {
    requestId: "req_1",
    agentId: "worker",
    task: "add a parser",
    workspace: "/project",
    workspaceMode: "workspace-write",
    writeScope: null,
    mode: "medium",
    background: true,
    interactive: false,
    timeoutMs: null,
    metadata: {},
    ...overrides,
  };
}

/** Reserve + register, the way `DelegationService` does; the child is then `running`. */
async function spawn(service: ExecutionGraphService, parent: ExecutionBinding, overrides: Partial<ChildRequest> = {}): Promise<ExecutionBinding> {
  const reserved = await service.reserveChild(parent, request(overrides)) as ReservedChild;
  await service.startReservedChild(reserved, async () => ({ executionId: reserved.binding.executionId, status: "running" as const }));
  return reserved.binding;
}

async function codeOf(operation: () => Promise<unknown>): Promise<string | null> {
  try {
    await operation();
    return null;
  } catch (error) {
    if (isExecutionGraphError(error)) return error.code;
    throw error;
  }
}

const accepted: ExecutionAcceptanceRef = { decision: "accepted", evidenceDigest: "a".repeat(64), decidedAt: "2026-09-11T00:00:05.000Z" };

/**
 * A root with two finished children and one still running, plus a grandchild under the
 * first child. Every guard in the P4 table has a node here to trip over.
 */
async function family() {
  const h = harness();
  const root = await h.service.createRoot({ agentId: "main", thread: null });
  await h.service.startRoot(root.binding, async () => undefined);
  const first = await spawn(h.service, root.binding, { requestId: "req_first" });
  const second = await spawn(h.service, root.binding, { requestId: "req_second", agentId: "search" });
  const running = await spawn(h.service, root.binding, { requestId: "req_running" });
  const grandchild = await spawn(h.service, first, { requestId: "req_grand", agentId: "search" });
  h.advance(1_000);
  await h.service.finishExecution(grandchild, { status: "completed" });
  await h.service.finishExecution(first, { status: "completed" });
  await h.service.finishExecution(second, { status: "failed", error: { code: "X", message: "boom" } });
  return { ...h, root: root.binding, first, second, running, grandchild };
}

/**
 * Oracle: P4 spec, "Guard" table — only the *parent* of a subject may decide it, the
 * subject must have ended, a decision is taken once, and a forged binding is refused
 * before any of that is looked at. Nobody accepts a root: it has no parent.
 */
describe("ExecutionGraphService.acceptChild — who may decide what", () => {
  it("refuses a forged capability before looking at the subject", async () => {
    const { service, root } = await family();
    const forged = { ...root, capability: "f".repeat(root.capability.length) };
    expect(await codeOf(() => service.acceptChild(forged, "req_first", accepted))).toBe("CAPABILITY_INVALID");
  });

  it("refuses a sibling, a grandparent, and the subject itself — ACCEPTANCE_NOT_PARENT", async () => {
    const { service, root, first, second } = await family();
    // The sibling `second` is finished, so it cannot even present itself as a live parent;
    // `first`'s own binding is a live-looking one only while it runs — decide on `running`.
    expect(await codeOf(() => service.acceptChild(root, "req_grand", accepted))).toBe("ACCEPTANCE_NOT_PARENT");
    const { service: s2, root: r2 } = await family();
    const sibling = await spawn(s2, r2, { requestId: "req_live_sibling" });
    expect(await codeOf(() => s2.acceptChild(sibling, "req_first", accepted))).toBe("ACCEPTANCE_NOT_PARENT");
    expect(await codeOf(() => s2.acceptChild(sibling, "req_live_sibling", accepted))).toBe("ACCEPTANCE_NOT_PARENT");
    void first; void second;
  });

  it("refuses a subject that has not ended — ACCEPTANCE_SUBJECT_RUNNING", async () => {
    const { service, root } = await family();
    expect(await codeOf(() => service.acceptChild(root, "req_running", accepted))).toBe("ACCEPTANCE_SUBJECT_RUNNING");
  });

  it("refuses a request the graph does not know", async () => {
    const { service, root } = await family();
    expect(await codeOf(() => service.acceptChild(root, "req_nobody", accepted))).toBe("EXECUTION_NODE_NOT_FOUND");
  });

  it("records the decision once on the subject: revision +1, nothing else moves, a second decision is refused", async () => {
    const { service, store, root, first, advance } = await family();
    const before = (await store.get(root.graphId))!;
    const subjectBefore = before.nodes.find((node) => node.executionId === first.executionId)!;
    expect(subjectBefore.acceptance).toBeNull();
    advance(5_000);

    const decided = await service.acceptChild(root, "req_first", accepted);
    expect(decided).toMatchObject({ executionId: first.executionId, acceptance: accepted, status: "completed", updatedAt: "2026-09-11T00:00:06.000Z" });
    const after = (await store.get(root.graphId))!;
    expect(after.revision).toBe(before.revision + 1);
    // Structure, outcome and evidence are untouched: acceptance is a verdict *about* the run.
    const { acceptance: _a, updatedAt: _u, ...restBefore } = subjectBefore;
    const { acceptance: _b, updatedAt: _v, ...restAfter } = after.nodes.find((node) => node.executionId === first.executionId)!;
    expect(restAfter).toEqual(restBefore);
    expect(after.nodes.filter((node) => node.executionId !== first.executionId)).toEqual(before.nodes.filter((node) => node.executionId !== first.executionId));

    const rejected: ExecutionAcceptanceRef = { decision: "rejected", evidenceDigest: "b".repeat(64), decidedAt: "2026-09-11T00:00:07.000Z" };
    expect(await codeOf(() => service.acceptChild(root, "req_first", rejected))).toBe("ACCEPTANCE_ALREADY_DECIDED");
    expect((await store.get(root.graphId))!.revision).toBe(before.revision + 1);
  });

  it("a graph document never carries a verdict on a node that is still running", async () => {
    const { store, root, running } = await family();
    const graph = (await store.get(root.graphId))!;
    const tampered: ExecutionGraphDocument = {
      ...graph,
      nodes: graph.nodes.map((node) => node.executionId === running.executionId ? { ...node, acceptance: accepted } : node),
    };
    expect(() => assertGraphDocument(tampered)).toThrow(/acceptance/);
    // And a node written before P4 reads back as undecided, not as broken.
    const legacy = { ...graph, nodes: graph.nodes.map(({ acceptance: _a, taskExcerpt: _t, ...node }) => node) };
    expect(assertGraphDocument(legacy).nodes.every((node) => node.acceptance === null && node.taskExcerpt === null)).toBe(true);
  });
});

/**
 * Oracle: P4 "Consumer" — the handoff names each delegation by request, target and a task
 * excerpt cut at 200 characters, so the next execution reads *what* was asked, not only
 * that something was.
 */
describe("task excerpt on the node", () => {
  it("keeps the first 200 characters of the task on a child, and null on a root", async () => {
    const { service, store } = harness();
    const root = await service.createRoot({ agentId: "main", thread: null });
    await service.startRoot(root.binding, async () => undefined);
    const long = "x".repeat(TASK_EXCERPT_MAX_CHARS + 50);
    await spawn(service, root.binding, { requestId: "req_long", task: long });
    const nodes = (await store.get(root.binding.graphId))!.nodes;
    expect(nodes.find((node) => node.parentExecutionId === null)!.taskExcerpt).toBeNull();
    expect(nodes.find((node) => node.requestId === "req_long")!.taskExcerpt).toBe(taskExcerpt(long));
    expect(taskExcerpt(long)).toHaveLength(TASK_EXCERPT_MAX_CHARS);
    expect(taskExcerpt("  short  ")).toBe("short");
    // Cut by character, never in the middle of a surrogate pair.
    const emoji = "🙂".repeat(TASK_EXCERPT_MAX_CHARS);
    expect([...taskExcerpt(emoji)].every((char) => char === "🙂")).toBe(true);
  });
});

/**
 * Oracle: P4 "Consumer" 2 — `accepted`/`rejected` from the record, `cancelled` derived from
 * a node that ended `cancelled`/`interrupted` with no record (a cascade is not the parent
 * forgetting), `undecided` otherwise; direct children only; the N most recent are kept.
 */
describe("summarizeDelegations / countDelegations", () => {
  function node(overrides: Partial<ExecutionNode> & Pick<ExecutionNode, "executionId">): ExecutionNode {
    return {
      graphId: "exec_root",
      parentExecutionId: "exec_root",
      agentId: "worker",
      thread: null,
      depth: 1,
      status: "completed",
      requestId: `req_${overrides.executionId}`,
      requestFingerprint: "f".repeat(64),
      capabilityHash: "c".repeat(64),
      createdAt: BASE_TIME,
      updatedAt: BASE_TIME,
      startedAt: BASE_TIME,
      endedAt: BASE_TIME,
      cancellation: null,
      error: null,
      terminationReason: null,
      requiredEvidence: [],
      evidence: null,
      taskExcerpt: `task of ${overrides.executionId}`,
      acceptance: null,
      ...overrides,
    };
  }
  function graph(nodes: readonly ExecutionNode[]): ExecutionGraphDocument {
    return {
      version: 1, graphId: "exec_root", rootExecutionId: "exec_root", revision: 1, createdAt: BASE_TIME, updatedAt: BASE_TIME,
      deadlineAt: "2026-09-12T00:00:00.000Z", delegationUsed: nodes.length, limits: { ...DEFAULT_EXECUTION_GRAPH_LIMITS },
      nodes: [node({ executionId: "exec_root", parentExecutionId: null, depth: 0, requestId: null, requestFingerprint: null, taskExcerpt: null }), ...nodes],
      reservations: [],
    } as unknown as ExecutionGraphDocument;
  }
  const at = (seconds: number) => new Date(Date.parse(BASE_TIME) + seconds * 1_000).toISOString();

  it("derives one decision per direct child, in creation order, with the evidence digest it was judged on", () => {
    const g = graph([
      node({ executionId: "a", createdAt: at(1), acceptance: { decision: "accepted", evidenceDigest: "1".repeat(64), decidedAt: at(9) }, evidence: { digest: "2".repeat(64), evaluation: "satisfied" } }),
      node({ executionId: "b", createdAt: at(2), status: "failed", acceptance: { decision: "rejected", evidenceDigest: "3".repeat(64), decidedAt: at(9) } }),
      node({ executionId: "c", createdAt: at(3), status: "cancelled" }),
      node({ executionId: "d", createdAt: at(4), status: "interrupted" }),
      node({ executionId: "e", createdAt: at(5), evidence: { digest: "5".repeat(64), evaluation: "unknown" } }),
      node({ executionId: "f", createdAt: at(6), status: "running", endedAt: null }),
      node({ executionId: "g", createdAt: at(0), parentExecutionId: "a", depth: 2, acceptance: { decision: "accepted", evidenceDigest: "7".repeat(64), decidedAt: at(9) } }),
    ]);
    expect(summarizeDelegations(g, "exec_root")).toEqual([
      { requestId: "req_a", target: "worker", task: "task of a", decision: "accepted", evidenceDigest: "1".repeat(64) },
      { requestId: "req_b", target: "worker", task: "task of b", decision: "rejected", evidenceDigest: "3".repeat(64) },
      { requestId: "req_c", target: "worker", task: "task of c", decision: "cancelled", evidenceDigest: null },
      { requestId: "req_d", target: "worker", task: "task of d", decision: "cancelled", evidenceDigest: null },
      { requestId: "req_e", target: "worker", task: "task of e", decision: "undecided", evidenceDigest: "5".repeat(64) },
      { requestId: "req_f", target: "worker", task: "task of f", decision: "undecided", evidenceDigest: null },
    ]);
    expect(countDelegations(g, "exec_root")).toEqual({ accepted: 1, rejected: 1, cancelled: 2, undecided: 2 });
    expect(summarizeDelegations(g, "a")).toEqual([{ requestId: "req_g", target: "worker", task: "task of g", decision: "accepted", evidenceDigest: "7".repeat(64) }]);
    expect(summarizeDelegations(g, "e")).toEqual([]);
    for (const [status, expected] of [["completed", "undecided"], ["failed", "undecided"], ["cancelled", "cancelled"], ["interrupted", "cancelled"]] as const) {
      expect(delegationDecision(node({ executionId: "z", status, endedAt: at(1) }))).toBe(expected);
    }
  });

  it("keeps only the most recent N, newest last, and the count still sees them all", () => {
    const many = Array.from({ length: DELEGATION_SUMMARY_LIMIT + 5 }, (_, index) => node({ executionId: `n${index}`, createdAt: at(index) }));
    const g = graph(many);
    const kept = summarizeDelegations(g, "exec_root");
    expect(kept).toHaveLength(DELEGATION_SUMMARY_LIMIT);
    expect(kept[0].requestId).toBe("req_n5");
    expect(kept.at(-1)!.requestId).toBe(`req_n${DELEGATION_SUMMARY_LIMIT + 4}`);
    expect(summarizeDelegations(g, "exec_root", { limit: 2 }).map((entry) => entry.requestId)).toEqual([`req_n${DELEGATION_SUMMARY_LIMIT + 3}`, `req_n${DELEGATION_SUMMARY_LIMIT + 4}`]);
    expect(countDelegations(g, "exec_root").undecided).toBe(DELEGATION_SUMMARY_LIMIT + 5);
  });
});

/**
 * Oracle: P4 "Contract" — the record sits at `<parent execution>/acceptance/<requestId>.json`,
 * carries the digest it was judged on, and its reasons are redacted the way history is:
 * a verdict is read by the next execution, and a secret in it would travel.
 */
describe("acceptance record on disk", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  it("writes atomically under the parent, reads back, and redacts reasons", async () => {
    const root = await mkdtemp(join(tmpdir(), "alp-acceptance-"));
    roots.push(root);
    const record: AcceptanceRecordV1 = {
      version: 1,
      requestId: "req_first",
      subjectExecutionId: "exec_child",
      acceptedByExecutionId: "exec_parent",
      decision: "rejected",
      evidenceDigest: "a".repeat(64),
      reasons: ["tests fail", "leaked api_key=abcdefghijklmnop while running"],
      decidedAt: "2026-09-11T00:00:05.000Z",
    };
    const file = await writeAcceptanceRecord(root, record);
    expect(file).toBe(acceptanceFile(root, "exec_parent", "req_first"));
    expect(file).toBe(join(root, "exec_parent", "acceptance", "req_first.json"));
    const raw = JSON.parse(await readFile(file, "utf8")) as AcceptanceRecordV1;
    expect(raw.reasons[1]).toContain(REDACTED);
    expect(raw.reasons[1]).not.toContain("abcdefghijklmnop");
    expect(raw).toMatchObject({ ...record, reasons: ["tests fail", raw.reasons[1]] });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readAcceptanceRecord(root, "exec_parent", "req_first")).toEqual(raw);
    expect(await readAcceptanceRecord(root, "exec_parent", "req_none")).toBeNull();
    // Nothing half-written is left beside it.
    expect(await readFile(file, "utf8")).toMatch(/\n$/);
  });
});
