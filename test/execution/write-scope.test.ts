import { mkdir, mkdtemp, readFile, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { defineAgent } from "../../src/agents/agent-definition";
import { createAgentRegistry } from "../../src/agents/registry";
import type { AgentDefinition, AgentId } from "../../src/agents/types";
import { createExecutionPolicy } from "../../src/execution/execution-policy";
import { ExecutionService } from "../../src/execution/execution-service";
import { FileExecutionStore } from "../../src/execution/execution-store";
import type { AuthorizeExecutionInput } from "../../src/execution/types";
import type { BuiltMemoryContext } from "../../src/memory/types";
import { PolicyEngine } from "../../src/policy/policy-engine";
import { WorkflowRunner } from "../../src/workflow/workflow-runner";
import { removeTemporary } from "../support/temporary-root";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(removeTemporary)));

function agent(id: AgentId): AgentDefinition<unknown> {
  return defineAgent({
    id,
    displayName: id,
    model: { claude: "claude-haiku-4-5", codex: "gpt-5.6-luna" },
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
    output: { name: `${id}-output`, schema: {}, validate: () => ({ ok: true }) },
  });
}

const memoryContext: BuiltMemoryContext = {
  invariantContext: "invariants",
  policyContext: "policy",
  entries: [],
  diagnostics: { characterBudget: 0, charactersUsed: 0, truncated: false, omittedEntryIds: [] },
};

/**
 * `<root>/workspace/{src,docs,link-out -> ../outside}`, `<root>/outside`, and the executions
 * root at `<root>/executions` — outside the workspace, as it is in every real install.
 */
async function harness() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "alp-write-scope-")));
  roots.push(root);
  const workspace = join(root, "workspace");
  const executionsRoot = join(root, "executions");
  await mkdir(join(workspace, "src", "lib"), { recursive: true });
  await mkdir(join(workspace, "docs"), { recursive: true });
  await mkdir(join(root, "outside"), { recursive: true });
  await symlink(join(root, "outside"), join(workspace, "link-out"), "dir");
  const registry = createAgentRegistry([agent("main"), agent("worker")]);
  const service = new ExecutionService({
    registry,
    policy: new PolicyEngine({ registry, protectedRoots: [executionsRoot] }),
    memory: { buildContext: async () => memoryContext },
    workflowRunner: new WorkflowRunner(),
    store: new FileExecutionStore({ root: executionsRoot }),
    now: () => new Date("2026-09-12T10:00:00.000Z"),
  });
  let counter = 0;
  const launch = (overrides: Partial<AuthorizeExecutionInput> = {}): AuthorizeExecutionInput => ({
    executionId: `exec_scope_${++counter}`,
    parent: "main",
    target: "worker",
    workspace,
    workspaceMode: "workspace-write",
    launch: { root: workspace, project: workspace },
    ...overrides,
  });
  const materialize = { task: "scoped work", thread: null, memoryQueries: [], characterBudget: 0, invariantContext: "i", policyContext: "p" } as const;
  return { root, workspace, executionsRoot, service, launch, materialize };
}

/**
 * Oracle: P2 spec — the scope is canonicalized at authorize (symlinks resolved, `..` and
 * absolute paths outside the workspace refused); it rides the ticket into `policy.json` and
 * into `policyHash`; an invalid scope is refused *before* anything is on disk. The codes are
 * the spec's own.
 */
describe("ExecutionService.authorize — writeScope", () => {
  it("canonicalizes a relative scope against the workspace and carries it into the signed policy", async () => {
    const { workspace, service, launch, materialize, executionsRoot } = await harness();
    const ticket = await service.authorize(launch({ writeScope: ["docs", "src/lib", "docs"] }));
    // Absolute, sorted, deduplicated: the same scope spelled two ways is one scope.
    expect(ticket.writeScope).toEqual([join(workspace, "docs"), join(workspace, "src", "lib")]);
    const prepared = await service.materialize(ticket, materialize);
    expect(prepared.policy.writeScope).toEqual(ticket.writeScope);
    const onDisk = JSON.parse(await readFile(join(executionsRoot, ticket.executionId, "policy.json"), "utf8"));
    expect(onDisk.writeScope).toEqual(ticket.writeScope);

    const unscoped = await service.materialize(await service.authorize(launch()), materialize);
    expect(unscoped.policy.writeScope).toBeNull();
    expect(unscoped.policy.policyHash).not.toBe(prepared.policy.policyHash);
  });

  it("accepts an absolute entry inside the workspace and a symlink that resolves inside it", async () => {
    const { workspace, service, launch } = await harness();
    const ticket = await service.authorize(launch({ writeScope: [join(workspace, "src")] }));
    expect(ticket.writeScope).toEqual([join(workspace, "src")]);
  });

  it("refuses a symlink that resolves outside the workspace", async () => {
    const { service, launch } = await harness();
    await expect(service.authorize(launch({ writeScope: ["link-out"] })))
      .rejects.toThrow(/WRITE_SCOPE_OUTSIDE_WORKSPACE/);
  });

  it("refuses a `..` escape and an absolute path outside the workspace", async () => {
    const { root, service, launch } = await harness();
    await expect(service.authorize(launch({ writeScope: ["src", "../outside"] })))
      .rejects.toThrow(/WRITE_SCOPE_OUTSIDE_WORKSPACE/);
    await expect(service.authorize(launch({ writeScope: [join(root, "outside")] })))
      .rejects.toThrow(/WRITE_SCOPE_OUTSIDE_WORKSPACE/);
  });

  it("refuses a scope entry that does not exist rather than scoping to nothing", async () => {
    const { service, launch } = await harness();
    await expect(service.authorize(launch({ writeScope: ["src/missing"] })))
      .rejects.toThrow(/WRITE_SCOPE_NOT_FOUND/);
  });

  it("refuses a scope on a read-only launch and an empty scope", async () => {
    const { service, launch } = await harness();
    await expect(service.authorize(launch({ workspaceMode: "read-only", writeScope: ["src"] })))
      .rejects.toThrow(/WRITE_SCOPE_ON_READ_ONLY/);
    await expect(service.authorize(launch({ writeScope: [] }))).rejects.toThrow(/empty/);
  });

  it("refuses a scope or a written workspace that reaches the executions root", async () => {
    const { root, service, launch, executionsRoot } = await harness();
    // The root exists, as it does whenever a parent is already running there.
    await mkdir(executionsRoot, { recursive: true });
    // Scope entry is the executions root itself: `policy.json` would be writable.
    await expect(service.authorize(launch({ workspace: root, writeScope: ["executions"] })))
      .rejects.toThrow(/WRITE_SCOPE_PROTECTED_ROOT/);
    // Unscoped write launch at a workspace that contains it.
    await expect(service.authorize(launch({ workspace: root, launch: { root, project: root } })))
      .rejects.toThrow(/WRITE_SCOPE_PROTECTED_ROOT/);
    // Scoped clear of it: allowed.
    const ticket = await service.authorize(launch({ workspace: root, launch: { root, project: root }, writeScope: ["workspace/src"] }));
    expect(ticket.writeScope).toEqual([join(root, "workspace", "src")]);
  });

  it("writes nothing to disk for a refused scope", async () => {
    const { service, launch, executionsRoot } = await harness();
    await expect(service.authorize(launch({ writeScope: ["link-out"] }))).rejects.toThrow();
    await expect(readdir(executionsRoot)).rejects.toThrow();
  });
});

describe("createExecutionPolicy — writeScope in the snapshot", () => {
  const definition = agent("worker");
  const base = { executionId: "exec_scope", thread: null, definition, workspace: "/ws", workspaceMode: "workspace-write" as const, createdAt: "2026-09-12T10:00:00.000Z" };

  it("is `null` out loud when unscoped, and a frozen list when scoped", () => {
    const unscoped = createExecutionPolicy(base);
    expect(unscoped.writeScope).toBeNull();
    expect("writeScope" in unscoped).toBe(true);
    const scoped = createExecutionPolicy({ ...base, writeScope: ["/ws/src"] });
    expect(scoped.writeScope).toEqual(["/ws/src"]);
    expect(Object.isFrozen(scoped.writeScope)).toBe(true);
  });

  it("changes the hash when the scope changes, and only then", () => {
    const a = createExecutionPolicy({ ...base, writeScope: ["/ws/src"] });
    const b = createExecutionPolicy({ ...base, writeScope: ["/ws/src", "/ws/docs"] });
    const again = createExecutionPolicy({ ...base, writeScope: ["/ws/src"] });
    expect(a.policyHash).not.toBe(b.policyHash);
    expect(a.policyHash).not.toBe(createExecutionPolicy(base).policyHash);
    expect(again.policyHash).toBe(a.policyHash);
    expect(a.definitionHash).toBe(b.definitionHash);
  });
});
