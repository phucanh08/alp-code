import { describe, expect, it } from "vitest";
import { seedCheckpoint } from "../../src/context/checkpoint";
import { runThreadCommand, type ThreadCommandDependencies } from "../../src/cli/commands/thread";
import { DELEGATION_SUMMARY_LIMIT } from "../../src/execution/acceptance";
import type { ExecutionGraphDocument, ExecutionNode, ExecutionNodeStatus } from "../../src/execution/graph/types";
import type { ExecutionPolicy, IdentityCapsule } from "../../src/execution/types";
import { renderSessionContext } from "../../src/runtime/render-session-context";
import { projectThreadContext, type ProjectContextInput } from "../../src/thread/context-projector";
import {
  assertThreadContextSnapshot,
  threadContextDigest,
  type ThreadContextDelegation,
  type ThreadContextHandoff,
  type ThreadContextSnapshotV1,
} from "../../src/thread/context-types";
import { HistoryBridgeRegistry } from "../../src/thread/history-bridge";
import type { ThreadEntry } from "../../src/thread/history-types";
import { InMemoryThreadStore } from "../../src/thread/in-memory-thread-store";
import { ThreadService, type ThreadGraphReader } from "../../src/thread/thread-service";
import { at } from "../support/thread-fixture";

const DIGEST = /^[0-9a-f]{64}$/;

function delegation(requestId: string, overrides: Partial<ThreadContextDelegation> = {}): ThreadContextDelegation {
  return { requestId, target: "worker", task: `task for ${requestId}`, decision: "accepted", evidenceDigest: "e".repeat(64), ...overrides };
}

function projection(overrides: Partial<ProjectContextInput> = {}): ProjectContextInput {
  return {
    threadId: "thread_fixture01",
    previous: null,
    title: "Fix auth",
    execution: { executionId: "exec_1", sequence: 1, outcome: "completed", runtime: "claude", finishedAt: at(10) },
    checkpoint: seedCheckpoint({ executionId: "exec_1", policyHash: "p".repeat(64), objective: null, now: () => at(0) }),
    createdAt: at(11),
    ...overrides,
  };
}

/**
 * Oracle: P4 "Consumer" 2 — the snapshot carries E-n's delegations (request, target, task,
 * decision, digest) so the next execution reads *what the parent decided*, from ALP's record
 * and not from the agent's own account; a revision with none is byte-for-byte what P5 wrote.
 */
describe("projectThreadContext — delegations of this execution", () => {
  it("carries the delegations verbatim, inside the digest, and the strict reader accepts them", () => {
    const delegations = [delegation("req_a"), delegation("req_b", { decision: "rejected", target: "search", evidenceDigest: null })];
    const { snapshot } = projectThreadContext(projection({ delegations }));
    expect(snapshot.delegations).toEqual(delegations);
    expect(threadContextDigest(snapshot)).toBe(snapshot.digest);
    expect(() => assertThreadContextSnapshot(snapshot, { threadId: snapshot.threadId, revision: 1, digest: snapshot.digest })).not.toThrow();
    // Not an accumulating list: revision 2 shows E-2's, not E-1's.
    const next = projectThreadContext(projection({
      previous: snapshot,
      execution: { executionId: "exec_2", sequence: 2, outcome: "completed", runtime: "claude", finishedAt: at(20) },
      delegations: [delegation("req_c")],
    })).snapshot;
    expect(next.delegations).toEqual([delegation("req_c")]);
  });

  it("omits the field when there are none, so a P5 snapshot on disk still digests", () => {
    const none = projectThreadContext(projection()).snapshot;
    expect(none).not.toHaveProperty("delegations");
    expect(projectThreadContext(projection({ delegations: [] })).snapshot).not.toHaveProperty("delegations");
    expect(() => assertThreadContextSnapshot(none, { threadId: none.threadId, revision: 1, digest: none.digest })).not.toThrow();
  });

  it("refuses a tampered delegation: digest first, then shape", () => {
    const { snapshot } = projectThreadContext(projection({ delegations: [delegation("req_a")] }));
    const flipped = { ...snapshot, delegations: [delegation("req_a", { decision: "rejected" })] };
    expect(() => assertThreadContextSnapshot(flipped, { threadId: snapshot.threadId, revision: 1, digest: snapshot.digest })).toThrow();
    const malformed = { ...snapshot, delegations: [{ ...delegation("req_a"), decision: "maybe" }] } as unknown as ThreadContextSnapshotV1;
    const redigested = { ...malformed, digest: threadContextDigest(malformed) };
    expect(() => assertThreadContextSnapshot(redigested, { threadId: snapshot.threadId, revision: 1, digest: redigested.digest })).toThrow(/decision/);
  });

  it("drops old outcomes before any delegation, then the oldest delegations, and the newest survives", () => {
    const delegations = Array.from({ length: 6 }, (_, index) => delegation(`req_${index}`, { task: "t".repeat(150) }));
    const outcome = (sequence: number) => ({ executionId: `exec_${sequence}`, sequence, outcome: "completed" as const, runtime: "claude" as const, finishedAt: at(sequence) });
    const previous: ThreadContextSnapshotV1 = {
      version: 1, threadId: "thread_fixture01", revision: 4, objective: "Fix auth", decisions: [], constraints: [], openItems: [], nextActions: [],
      outcomes: [outcome(1), outcome(2), outcome(3), outcome(4)], degraded: false, createdAt: at(4), digest: "0".repeat(64),
    };
    const execution = { executionId: "exec_5", sequence: 5, outcome: "completed" as const, runtime: "claude" as const, finishedAt: at(5) };
    const full = projectThreadContext(projection({ previous, execution, checkpoint: null, delegations })).snapshot;
    expect(full.outcomes).toHaveLength(5);
    // Just over: one old outcome goes, every delegation stays.
    const oneOutcome = projectThreadContext(projection({ previous, execution, checkpoint: null, delegations, maxBytes: Buffer.byteLength(JSON.stringify(full)) - 50 })).snapshot;
    expect(oneOutcome.outcomes.map((entry) => entry.sequence)).toEqual([2, 3, 4, 5]);
    expect(oneOutcome.delegations).toHaveLength(6);
    // Far under: outcomes stop at the floor, delegations go oldest-first, the newest is last to go.
    const tight = projectThreadContext(projection({ previous, execution, checkpoint: null, delegations, maxBytes: Buffer.byteLength(JSON.stringify(full)) - 800 })).snapshot;
    expect(tight.outcomes.map((entry) => entry.sequence)).toEqual([3, 4, 5]);
    expect(tight.delegations!.length).toBeLessThan(6);
    expect(tight.delegations!.at(-1)!.requestId).toBe("req_5");
    const bare = projectThreadContext(projection({ previous, execution, checkpoint: null, delegations, maxBytes: 200 })).snapshot;
    expect(bare).not.toHaveProperty("delegations");
    expect(bare.outcomes).toHaveLength(3);
  });
});

/** A graph reader that answers with the given direct children of `exec_1`. */
function graphWith(children: readonly Partial<ExecutionNode>[]): ThreadGraphReader {
  const node = (overrides: Partial<ExecutionNode>): ExecutionNode => ({
    graphId: "exec_1", parentExecutionId: "exec_1", agentId: "worker", thread: null, depth: 1, status: "completed" as ExecutionNodeStatus,
    requestId: "req_x", requestFingerprint: "f".repeat(64), capabilityHash: "c".repeat(64), createdAt: at(1), updatedAt: at(1),
    startedAt: at(1), endedAt: at(2), cancellation: null, error: null, terminationReason: null, requiredEvidence: [], evidence: null,
    taskExcerpt: "some task", acceptance: null, executionId: "exec_child",
    ...overrides,
  });
  const document = {
    graphId: "exec_1", rootExecutionId: "exec_1",
    nodes: [node({ executionId: "exec_1", parentExecutionId: null, depth: 0, requestId: null, taskExcerpt: null }), ...children.map(node)],
  } as unknown as ExecutionGraphDocument;
  return { async findGraphFor(executionId) { return executionId === "exec_1" || children.some((child) => child.executionId === executionId) ? document : null; } };
}

function harness(graph: ThreadGraphReader, options: { delegationLimit?: number } = {}) {
  let tick = 0;
  const now = () => new Date(at(tick++));
  const store = new InMemoryThreadStore({ now });
  const threads = new ThreadService({ store, graph, now, history: new HistoryBridgeRegistry([]), ...options });
  return { store, threads };
}

/**
 * Oracle: P4 "Consumer" 1–2 — ALP reads the graph itself when it projects and when it
 * writes the boundary; the agent cannot put a decision there. `cancelled` is derived from
 * the node's end, `undecided` is the honest default.
 */
describe("ThreadService — delegations from the graph, not from the agent", () => {
  const children = [
    { executionId: "c1", requestId: "req_1", createdAt: at(1), acceptance: { decision: "accepted" as const, evidenceDigest: "1".repeat(64), decidedAt: at(5) } },
    { executionId: "c2", requestId: "req_2", createdAt: at(2), agentId: "search", status: "cancelled" as const, taskExcerpt: "look around" },
    { executionId: "c3", requestId: "req_3", createdAt: at(3), status: "failed" as const, acceptance: { decision: "rejected" as const, evidenceDigest: "3".repeat(64), decidedAt: at(6) } },
    { executionId: "c4", requestId: "req_4", createdAt: at(4), evidence: { digest: "4".repeat(64), evaluation: "unknown" as const } },
  ];

  it("projects E-1's direct children in creation order and counts them on the boundary", async () => {
    const { store, threads } = harness(graphWith(children));
    const { id } = await threads.createThread({ agentId: "main", workspace: "/project", title: "Fix auth" });
    await threads.reserveRoot(id, "exec_1");
    await threads.settleRoot(id, "exec_1", "completed");
    const thread = await threads.collectHistory(id, { executionId: "exec_1", runtime: null, workspace: "/project", contextDirectory: "/nowhere" });
    const boundary = await store.readPayload(id, thread.messages.find((ref) => ref.kind === "boundary")!.artifact) as ThreadEntry;
    expect(boundary).toMatchObject({ kind: "boundary", executionId: "exec_1", delegations: { accepted: 1, rejected: 1, cancelled: 1, undecided: 1 } });

    await threads.projectContext(id, "exec_1", { checkpoint: null, runtime: "claude" });
    const snapshot = (await threads.currentContext(id))!;
    expect(snapshot.delegations).toEqual([
      { requestId: "req_1", target: "worker", task: "some task", decision: "accepted", evidenceDigest: "1".repeat(64) },
      { requestId: "req_2", target: "search", task: "look around", decision: "cancelled", evidenceDigest: null },
      { requestId: "req_3", target: "worker", task: "some task", decision: "rejected", evidenceDigest: "3".repeat(64) },
      { requestId: "req_4", target: "worker", task: "some task", decision: "undecided", evidenceDigest: "4".repeat(64) },
    ]);
    expect(snapshot.digest).toMatch(DIGEST);
    // The next root inherits exactly that.
    const reserved = await threads.reserveRoot(id, "exec_2");
    expect(reserved.handoff.snapshot?.delegations).toEqual(snapshot.delegations);
  });

  it("keeps the last N, with N injectable, and writes no field when the root delegated nothing", async () => {
    const many = Array.from({ length: DELEGATION_SUMMARY_LIMIT + 3 }, (_, index) => ({ executionId: `c${index}`, requestId: `req_${index}`, createdAt: at(index) }));
    const { threads } = harness(graphWith(many), { delegationLimit: 2 });
    const { id } = await threads.createThread({ agentId: "main", workspace: "/project" });
    await threads.reserveRoot(id, "exec_1");
    await threads.settleRoot(id, "exec_1", "completed");
    await threads.projectContext(id, "exec_1", { checkpoint: null, runtime: "claude" });
    expect((await threads.currentContext(id))!.delegations!.map((entry) => entry.requestId)).toEqual([`req_${DELEGATION_SUMMARY_LIMIT + 1}`, `req_${DELEGATION_SUMMARY_LIMIT + 2}`]);

    const lonely = harness(graphWith([]));
    const alone = await lonely.threads.createThread({ agentId: "main", workspace: "/project" });
    await lonely.threads.reserveRoot(alone.id, "exec_1");
    await lonely.threads.settleRoot(alone.id, "exec_1", "completed");
    const thread = await lonely.threads.collectHistory(alone.id, { executionId: "exec_1", runtime: null, workspace: "/project", contextDirectory: "/nowhere" });
    const boundary = await lonely.store.readPayload(alone.id, thread.messages[0].artifact) as ThreadEntry;
    expect(boundary).toMatchObject({ kind: "boundary", delegations: { accepted: 0, rejected: 0, cancelled: 0, undecided: 0 } });
    await lonely.threads.projectContext(alone.id, "exec_1", { checkpoint: null, runtime: "claude" });
    expect(await lonely.threads.currentContext(alone.id)).not.toHaveProperty("delegations");
  });
});

/**
 * Oracle: P4 "Consumer" 3 — the handoff shows `## Delegations of E-n (ALP-recorded)` after
 * the pins, one line per delegation with its decision; nothing when there were none.
 */
describe("renderSessionContext — delegations section", () => {
  const THREAD = { id: "thread_abc", contextRevision: 1, contextDigest: "a".repeat(64) };
  const HEADING = "## Delegations of E-1 (ALP-recorded)";
  const capsule = { executionId: "exec-x", role: "main", displayName: "Phở", instructions: "x", task: "t", activeWorkspace: "/p",
    memoryContext: { invariantContext: "", policyContext: "", entries: [], diagnostics: { characterBudget: 0, charactersUsed: 0, truncated: false, omittedEntryIds: [] } },
    workflowState: { workflowId: "coordinate", currentState: "ASSESS", status: "running", repairAttempts: 0 }, allowedTools: ["Read"], outputContract: { name: "r", schema: {} } } as unknown as IdentityCapsule;
  const policy = { executionId: "exec-x", role: "main", workspace: "/p", workspaceMode: "workspace-write", allowedTools: ["Read", "Bash"], memory: { read: [], write: [] },
    delegatesTo: ["worker"], skills: [], subagents: [], mcpServers: [], createdAt: at(0), definitionHash: "d", policyHash: "p", thread: THREAD } as unknown as ExecutionPolicy;
  const handoff = (delegations?: ThreadContextDelegation[]): ThreadContextHandoff => ({
    threadId: "thread_abc", sequence: 2, title: "fix login",
    snapshot: {
      version: 1, threadId: "thread_abc", revision: 1, objective: "fix login", decisions: [{ text: "use jwt", sourceExecutionId: "exec_e1" }], constraints: [], openItems: [], nextActions: [],
      outcomes: [{ executionId: "exec_e1", sequence: 1, outcome: "completed", runtime: "claude", finishedAt: at(1) }], degraded: false, createdAt: at(1), digest: "a".repeat(64),
      ...(delegations ? { delegations } : {}),
    },
  });

  it("lists each delegation with its decision after the thread context, before the delegation how-to", () => {
    const context = renderSessionContext(capsule, policy, handoff([
      delegation("req_a", { task: "add a parser" }),
      delegation("req_b", { decision: "rejected", target: "search", evidenceDigest: null, task: "look around" }),
      delegation("req_c", { decision: "undecided", evidenceDigest: null, task: "" }),
    ]));
    const heading = context.indexOf(HEADING);
    expect(heading).toBeGreaterThan(context.indexOf("Decisions:\n- use jwt"));
    expect(heading).toBeLessThan(context.indexOf("## Delegation\n"));
    expect(context).toContain(`- req_a → worker: accepted (evidence ${"e".repeat(12)}…) — add a parser`);
    expect(context).toContain("- req_b → search: rejected — look around");
    expect(context).toContain("- req_c → worker: undecided");
    expect(context).toContain("alp delegation accept");
    expect(context).toContain("alp delegation reject");
  });

  it("shows nothing for a revision without delegations", () => {
    expect(renderSessionContext(capsule, policy, handoff())).not.toContain("## Delegations of");
    expect(renderSessionContext(capsule, policy, handoff([]))).not.toContain("## Delegations of");
  });
});

/** Oracle: P4 "Consumer" 4 — `alp thread show` and `alp thread context` print the same list. */
describe("alp thread show / context — delegations", () => {
  it("prints the ALP-recorded delegations of the last projected execution", async () => {
    const graph = graphWith([{ executionId: "c1", requestId: "req_1", createdAt: at(1), taskExcerpt: "add a parser", acceptance: { decision: "accepted", evidenceDigest: "1".repeat(64), decidedAt: at(5) } }]);
    const { threads } = harness(graph);
    const output: string[] = [];
    const dependencies = {
      threads, continueThread: async () => 0, cwd: "/project", env: {}, write: (text: string) => { output.push(text); },
      historySource: async (executionId: string) => ({ executionId, runtime: "claude" as const, workspace: "/project", contextDirectory: "/nowhere" }),
    } as unknown as ThreadCommandDependencies;
    const { id } = await threads.createThread({ agentId: "main", workspace: "/project", title: "fix login" });
    await threads.reserveRoot(id, "exec_1");
    await threads.settleRoot(id, "exec_1", "completed");
    await threads.projectContext(id, "exec_1", { checkpoint: null, runtime: "claude" });
    await runThreadCommand(["context", id], dependencies);
    expect(output.join("")).toContain("Delegations (ALP-recorded):\n  - req_1 → worker: accepted  (evidence 111111111111…)  add a parser");
    output.length = 0;
    await runThreadCommand(["show", id], dependencies);
    expect(output.join("")).toContain("Delegations (ALP-recorded):\n  - req_1 → worker: accepted");
  });
});
