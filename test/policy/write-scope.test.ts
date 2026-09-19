import { describe, expect, it } from "vitest";
import { defineAgent } from "../../src/agents/agent-definition";
import { createAgentRegistry } from "../../src/agents/registry";
import type { AgentDefinition, AgentId } from "../../src/agents/types";
import { PolicyEngine } from "../../src/policy/policy-engine";
import type { AuthorizationRequest, LaunchScope } from "../../src/policy/types";

function agent(id: AgentId): AgentDefinition<unknown> {
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
    output: { name: `${id}-output`, schema: {}, validate: () => ({ ok: true }) },
  });
}

const EXECUTIONS_ROOT = "/home/me/.alp/executions";
const engine = new PolicyEngine({
  registry: createAgentRegistry([agent("main"), agent("worker")]),
  canonicalizePath: (value) => value,
  protectedRoots: [EXECUTIONS_ROOT],
});

const GRANT: LaunchScope = { root: "/project/api", project: "/project" };

/** A `worker` launched at `workspace` with an explicit write scope, from a parent standing at the grant. */
function scoped(
  workspace: string,
  writeScope: readonly string[] | undefined,
  options: { launch?: LaunchScope | null; workspaceMode?: "read-only" | "workspace-write" } = {},
): AuthorizationRequest {
  const workspaceMode = options.workspaceMode ?? "workspace-write";
  const launch = options.launch === undefined ? GRANT : options.launch;
  return {
    type: "workspace",
    actor: "worker",
    operation: workspaceMode === "workspace-write" ? "write" : "read",
    path: workspace,
    execution: { activeWorkspace: workspace, workspaceMode, delegated: true },
    ...(writeScope === undefined ? {} : { writeScope }),
    ...(launch === null ? {} : { launch }),
  };
}

/**
 * Oracle: P2 spec (`phase-2-write-scope.md`, "Contract") — a write scope is a set of paths
 * *inside* the workspace that a `workspace-write` child may write; it is only valid on that
 * mode; a child of a child may not widen its parent's scope; and no scope, and no workspace
 * that is written to, may cover the executions root where `policy.json`, `approvals.json` and
 * `evidence.json` live (risk table, last row). Everything else about the launch — the grant
 * and the project — is P1's rule, unchanged.
 */
describe("PolicyEngine.decide — writeScope", () => {
  it("allows a scope that lies inside the workspace, with or without a parent scope", () => {
    expect(engine.decide(scoped("/project/api", ["/project/api/src", "/project/api/docs"]))).toEqual({ kind: "allow" });
    // The workspace itself is a valid scope: "everything" said explicitly.
    expect(engine.decide(scoped("/project/api", ["/project/api"]))).toEqual({ kind: "allow" });
  });

  it("denies a scope entry outside the workspace — an absolute path, a `..` escape, a resolved symlink", () => {
    for (const entry of ["/elsewhere", "/project/web", "/project/api/../web", "/project/api-evil"]) {
      expect(engine.decide(scoped("/project/api", ["/project/api/src", entry]))).toEqual({
        kind: "deny",
        code: "WRITE_SCOPE_OUTSIDE_WORKSPACE",
        reason: expect.stringContaining(entry),
      });
    }
  });

  it("denies a scope on a read-only launch: there is nothing to scope", () => {
    expect(engine.decide(scoped("/project/api", ["/project/api/src"], { workspaceMode: "read-only" })))
      .toMatchObject({ kind: "deny", code: "WRITE_SCOPE_ON_READ_ONLY" });
  });

  it("never lets a child write wider than a scoped parent", () => {
    const parent: LaunchScope = { ...GRANT, writeScope: ["/project/api/src"] };
    // Narrower or equal: fine.
    expect(engine.decide(scoped("/project/api", ["/project/api/src/lib"], { launch: parent }))).toEqual({ kind: "allow" });
    expect(engine.decide(scoped("/project/api", ["/project/api/src"], { launch: parent }))).toEqual({ kind: "allow" });
    // One entry beside the parent's scope: the whole request is refused, naming the entry.
    expect(engine.decide(scoped("/project/api", ["/project/api/src/lib", "/project/api/docs"], { launch: parent }))).toEqual({
      kind: "deny",
      code: "WRITE_SCOPE_EXCEEDS_PARENT",
      reason: expect.stringContaining("/project/api/docs"),
    });
    // No scope at all under a scoped parent means "the whole workspace" — which is wider.
    expect(engine.decide(scoped("/project/api", undefined, { launch: parent })))
      .toMatchObject({ kind: "deny", code: "WRITE_SCOPE_EXCEEDS_PARENT" });
    // A child launched *at* the parent's scope with no scope of its own writes exactly that much.
    expect(engine.decide(scoped("/project/api/src", undefined, { launch: parent }))).toEqual({ kind: "allow" });
  });

  it("does not constrain a child of an unscoped parent beyond the workspace rules", () => {
    const parent: LaunchScope = { ...GRANT, writeScope: null };
    expect(engine.decide(scoped("/project/api", undefined, { launch: parent }))).toEqual({ kind: "allow" });
    expect(engine.decide(scoped("/project/api", ["/project/api/docs"], { launch: parent }))).toEqual({ kind: "allow" });
  });

  it("refuses any scope or written workspace that reaches the executions root", () => {
    // The parent stands at `/home/me` itself, so P1's launch rule would allow every launch
    // below: only the protected root can say no.
    const home: LaunchScope = { root: "/home/me", project: "/home/me" };
    // A scope entry that is, or contains, the protected root.
    for (const entry of [EXECUTIONS_ROOT, "/home/me/.alp", "/home/me/.alp/executions/exec_1"]) {
      expect(engine.decide(scoped("/home/me", ["/home/me/code", entry], { launch: home }))).toEqual({
        kind: "deny",
        code: "WRITE_SCOPE_PROTECTED_ROOT",
        reason: expect.stringContaining(entry),
      });
    }
    // An unscoped write launch whose workspace contains it: the whole tree is writable there.
    expect(engine.decide(scoped("/home/me", undefined, { launch: home }))).toMatchObject({ kind: "deny", code: "WRITE_SCOPE_PROTECTED_ROOT" });
    // Read-only at the same place is fine — nothing is written.
    expect(engine.decide({ ...scoped("/home/me", undefined, { workspaceMode: "read-only", launch: home }), actor: "main" })).toEqual({ kind: "allow" });
    // A scoped launch in that workspace that stays clear of the root is fine.
    expect(engine.decide(scoped("/home/me", ["/home/me/code"], { launch: home }))).toEqual({ kind: "allow" });
  });

  it("checks the scope before the approval question, so a bad scope is never something to approve", () => {
    // Outside the grant, inside the project — P1 would ask. The scope is outside the workspace,
    // and that answer comes first.
    expect(engine.decide(scoped("/project/web", ["/project/api/src"])))
      .toMatchObject({ kind: "deny", code: "WRITE_SCOPE_OUTSIDE_WORKSPACE" });
    expect(engine.decide(scoped("/project/web", ["/project/web/src"])))
      .toMatchObject({ kind: "require_approval", rule: "workspace-outside-grant-inside-project" });
  });

  it("keeps identity first: a role without a write grant is denied, not scoped", () => {
    expect(engine.decide({ ...scoped("/project/api", ["/project/api/src"]), actor: "main" }))
      .toMatchObject({ kind: "deny", code: "WORKSPACE_NOT_GRANTED" });
  });
});

/**
 * Oracle: master plan 2b — `excludeScope` is the complement of `writeScope`: each entry sits
 * inside an owned root (the scope, or the whole workspace) without covering it, only on a
 * write launch. What it removes is not the policy's business to approve or widen.
 */
describe("PolicyEngine.decide — excludeScope", () => {
  const excluding = (writeScope: readonly string[] | undefined, excludeScope: readonly string[], options: Parameters<typeof scoped>[2] = {}) =>
    ({ ...scoped("/project/api", writeScope, options), excludeScope });

  it("allows an exclusion inside an owned root — scoped or the whole workspace", () => {
    expect(engine.decide(excluding(["/project/api/src"], ["/project/api/src/parser"]))).toEqual({ kind: "allow" });
    expect(engine.decide(excluding(undefined, ["/project/api/docs", "/project/api/src/parser"]))).toEqual({ kind: "allow" });
  });

  it("denies an exclusion outside every owned root, naming the entry", () => {
    expect(engine.decide(excluding(["/project/api/src"], ["/project/api/docs"]))).toEqual({
      kind: "deny",
      code: "EXCLUDE_SCOPE_OUTSIDE_WRITE_SCOPE",
      reason: expect.stringContaining("/project/api/docs"),
    });
    expect(engine.decide(excluding(undefined, ["/project/web"]))).toMatchObject({ kind: "deny", code: "EXCLUDE_SCOPE_OUTSIDE_WRITE_SCOPE" });
  });

  it("denies an exclusion that swallows an owned root whole", () => {
    expect(engine.decide(excluding(["/project/api/src"], ["/project/api/src"]))).toMatchObject({ kind: "deny", code: "EXCLUDE_SCOPE_COVERS_WRITE_SCOPE" });
    expect(engine.decide(excluding(undefined, ["/project/api"]))).toMatchObject({ kind: "deny", code: "EXCLUDE_SCOPE_COVERS_WRITE_SCOPE" });
  });

  it("denies an exclusion on a read-only launch", () => {
    expect(engine.decide(excluding(undefined, ["/project/api/src"], { workspaceMode: "read-only" })))
      .toMatchObject({ kind: "deny", code: "EXCLUDE_SCOPE_ON_READ_ONLY" });
  });

  it("judges the scope first: a bad scope is refused before its exclusions are looked at", () => {
    expect(engine.decide(excluding(["/elsewhere"], ["/elsewhere/x"]))).toMatchObject({ kind: "deny", code: "WRITE_SCOPE_OUTSIDE_WORKSPACE" });
  });
});
