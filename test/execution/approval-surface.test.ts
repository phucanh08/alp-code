import { mkdtemp, mkdir, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineAgent } from "../../src/agents/agent-definition";
import { createAgentRegistry } from "../../src/agents/registry";
import type { AgentDefinition, AgentId } from "../../src/agents/types";
import { InMemorySessionApprovals, readApprovals, type ApprovalRecordV1 } from "../../src/execution/approvals";
import { ExecutionService } from "../../src/execution/execution-service";
import { FileExecutionStore } from "../../src/execution/execution-store";
import type { ApprovalSurface, AuthorizeExecutionInput, MaterializeExecutionInput } from "../../src/execution/types";
import type { BuiltMemoryContext } from "../../src/memory/types";
import { PolicyEngine } from "../../src/policy/policy-engine";
import { defineOutputContract } from "../../src/workflow/output-validator";
import { WorkflowRunner } from "../../src/workflow/workflow-runner";
import { removeTemporary } from "../support/temporary-root";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(removeTemporary)));

function role(id: AgentId): AgentDefinition<unknown> {
  return defineAgent({
    id,
    displayName: id,
    model: { claude: `claude-${id}`, codex: `codex-${id}` },
    reasoningEffort: { claude: "low", codex: "low" },
    reportsTo: id === "main" ? "principal" : "main",
    delegatesTo: id === "main" ? ["worker"] : [],
    capabilities: {
      tools: ["Read"],
      skills: [],
      subagents: [],
      mcpServers: [],
      memory: { read: ["shared", `private:${id}`], write: [`private:${id}`] },
      workspace: { readRoots: ["."], writeRoots: id === "worker" ? ["."] : [] },
    },
    instructions: { role: id, purpose: `${id} instructions`, rules: [] },
    workflow: { id: `${id}-workflow`, initial: "REPORT", states: { REPORT: { allowedTools: [], transitions: [], terminal: true } } },
    output: defineOutputContract(`${id}-output`, z.object({ summary: z.string() })),
  });
}

const context: BuiltMemoryContext = {
  invariantContext: "invariants",
  policyContext: "policy",
  entries: [],
  diagnostics: { characterBudget: 100, charactersUsed: 0, truncated: false, omittedEntryIds: [] },
};

async function setup(): Promise<{ service: ExecutionService; root: string; project: string }> {
  const root = await mkdtemp(join(tmpdir(), "alp-approval-"));
  roots.push(root);
  const project = join(root, "project");
  await mkdir(join(project, "api"), { recursive: true });
  await mkdir(join(project, "web"), { recursive: true });
  await mkdir(join(root, "elsewhere"), { recursive: true });
  const registry = createAgentRegistry([role("main"), role("worker")]);
  const service = new ExecutionService({
    registry,
    policy: new PolicyEngine({ registry, canonicalizePath: (value) => value }),
    memory: { buildContext: async () => context },
    workflowRunner: new WorkflowRunner(),
    store: new FileExecutionStore({ root: join(root, "executions") }),
    resolveWorkspace: async (value) => value,
    now: () => new Date("2026-09-12T10:00:00.000Z"),
  });
  return { service, root, project };
}

/** A child of a parent standing at `<project>/api`, asking for `<project>/<at>`. */
function childAt(project: string, at: string, executionId = "exec_child"): AuthorizeExecutionInput {
  return {
    executionId,
    parent: "main",
    target: "worker",
    workspace: join(project, at),
    workspaceMode: "workspace-write",
    launch: { root: join(project, "api"), project },
  };
}

const materializeInput = (project: string, at: string): MaterializeExecutionInput => ({
  thread: null,
  task: "do the thing",
  memoryQueries: [],
  characterBudget: 100,
  invariantContext: "invariants",
  policyContext: "policy",
});

function surface(answer: boolean, asked: string[] = []): ApprovalSurface {
  return {
    supportsApproval: true,
    async ask(decision) {
      asked.push(decision.prompt);
      return answer;
    },
  };
}

/**
 * Oracle: phase-1 spec. `require_approval` is a step *inside* `authorize()`, before the
 * ticket exists: no surface ⇒ `APPROVAL_UNAVAILABLE`; "no" ⇒ `APPROVAL_DENIED`; "yes" ⇒
 * a ticket carrying an `ApprovalRecordV1`, which `materialize()` writes into the hashed
 * policy. A decision the principal made is part of the identity the execution ran under.
 */
describe("ExecutionService.authorize — approval surface", () => {
  it("issues a plain ticket, with no approvals, when nothing needed asking", async () => {
    const { service, project } = await setup();
    const asked: string[] = [];
    const ticket = await service.authorize(childAt(project, "api/src"), surface(true, asked));
    expect(ticket.approvals).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("denies with APPROVAL_UNAVAILABLE when no surface can ask — and nothing touches disk", async () => {
    const { service, root, project } = await setup();
    await expect(service.authorize(childAt(project, "web"))).rejects.toThrow(/APPROVAL_UNAVAILABLE/);
    await expect(service.authorize(childAt(project, "web"), { supportsApproval: false, ask: async () => true }))
      .rejects.toThrow(/APPROVAL_UNAVAILABLE/);
    await expect(readdir(join(root, "executions"))).rejects.toThrow();
  });

  it("denies with APPROVAL_DENIED when the principal says no", async () => {
    const { service, project } = await setup();
    const asked: string[] = [];
    await expect(service.authorize(childAt(project, "web"), surface(false, asked))).rejects.toThrow(/APPROVAL_DENIED/);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(join(project, "web"));
  });

  it("records the principal's yes on the ticket and in the hashed policy", async () => {
    const { service, project } = await setup();
    const ticket = await service.authorize(childAt(project, "web"), surface(true));
    const expected: ApprovalRecordV1 = {
      version: 1,
      rule: "workspace-outside-grant-inside-project",
      subject: join(project, "web"),
      scope: "session",
      decidedBy: "principal",
      decidedAt: "2026-09-12T10:00:00.000Z",
    };
    expect(ticket.approvals).toEqual([expected]);

    const prepared = await service.materialize(ticket, materializeInput(project, "web"));
    expect(prepared.policy.approvals).toEqual([expected]);
    const onDisk = JSON.parse(await readFile(prepared.artifacts.policyFile, "utf8")) as Record<string, unknown>;
    expect(readApprovals(onDisk)).toEqual([expected]);

    // Same role, same workspace, no approval needed: a different identity, a different hash.
    const plain = await service.materialize(
      await service.authorize({ ...childAt(project, "web", "exec_plain"), launch: undefined }),
      materializeInput(project, "web"),
    );
    expect(plain.policy.approvals).toEqual([]);
    expect(plain.policy.policyHash).not.toBe(prepared.policy.policyHash);
  });

  it("does not ask twice in a session for the same rule and subject, and carries the record", async () => {
    const { service, project } = await setup();
    const session = new InMemorySessionApprovals();
    const asked: string[] = [];
    const first = await service.authorize({ ...childAt(project, "web", "exec_1"), sessionApprovals: session }, surface(true, asked));
    const second = await service.authorize({ ...childAt(project, "web", "exec_2"), sessionApprovals: session }, surface(true, asked));
    expect(asked).toHaveLength(1);
    expect(second.approvals).toEqual(first.approvals);
    // A session-scoped yes is available to a surface that cannot ask — that is what the
    // scope means: the principal already answered for this root.
    const third = await service.authorize({ ...childAt(project, "web", "exec_3"), sessionApprovals: session });
    expect(third.approvals).toEqual(first.approvals);
    // A different subject is a different question.
    await expect(service.authorize({ ...childAt(project, "web/nested", "exec_4"), sessionApprovals: session }))
      .rejects.toThrow(/APPROVAL_UNAVAILABLE/);
  });

  it("does not remember a no", async () => {
    const { service, project } = await setup();
    const session = new InMemorySessionApprovals();
    await expect(service.authorize({ ...childAt(project, "web"), sessionApprovals: session }, surface(false))).rejects.toThrow(/APPROVAL_DENIED/);
    expect(await session.list()).toEqual([]);
  });
});
