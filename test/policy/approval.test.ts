import { describe, expect, it } from "vitest";
import { defineAgent } from "../../src/agents/agent-definition";
import { createAgentRegistry } from "../../src/agents/registry";
import type { AgentDefinition, AgentId } from "../../src/agents/types";
import { PolicyEngine } from "../../src/policy/policy-engine";
import type { AuthorizationRequest } from "../../src/policy/types";

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

const engine = new PolicyEngine({
  registry: createAgentRegistry([agent("main"), agent("worker")]),
  canonicalizePath: (value) => value,
});

/** A child launched at `path`, from a parent standing at `/project/api`, inside project `/project`. */
const GRANT = { root: "/project/api", project: "/project" } as const;
function launch(path: string, grant: { root: string; project: string } | null = GRANT): AuthorizationRequest {
  return {
    type: "workspace",
    actor: "worker",
    operation: "write",
    path,
    execution: { activeWorkspace: path, workspaceMode: "workspace-write", delegated: true },
    ...(grant === null ? {} : { launch: grant }),
  };
}

/**
 * Oracle: phase-1 spec — "`--workspace` ngoài các root đã grant nhưng nằm **trong** project
 * root hiện tại → hỏi thay vì deny. Ngoài project root ⇒ vẫn deny." The grant is the
 * workspace the launcher itself stands in; the project is the registered root around it.
 * Everything that is identity — tools, delegation, memory — never asks.
 */
describe("PolicyEngine.decide — the one approval rule", () => {
  it("allows a launch inside the granted workspace without asking", () => {
    expect(engine.decide(launch("/project/api"))).toEqual({ kind: "allow" });
    expect(engine.decide(launch("/project/api/src"))).toEqual({ kind: "allow" });
  });

  it("asks for a launch outside the grant but inside the project, session-scoped", () => {
    const decision = engine.decide(launch("/project/web"));
    expect(decision).toMatchObject({ kind: "require_approval", rule: "workspace-outside-grant-inside-project", scope: "session" });
    if (decision.kind !== "require_approval") throw new Error("unreachable");
    expect(decision.subject).toBe("/project/web");
    // The prompt says what is being widened, to what, and from where — the principal answers
    // a question, not a code.
    expect(decision.prompt).toContain("worker");
    expect(decision.prompt).toContain("/project/web");
    expect(decision.prompt).toContain("/project/api");
    expect(decision.prompt).toContain("/project");
  });

  it("denies a launch outside the project root outright, with the scope code", () => {
    expect(engine.decide(launch("/elsewhere"))).toEqual({
      kind: "deny",
      code: "WORKSPACE_SCOPE_MISMATCH",
      reason: expect.stringContaining("/elsewhere"),
    });
    // A prefix that is not a path boundary is not "inside".
    expect(engine.decide(launch("/project-evil"))).toMatchObject({ kind: "deny", code: "WORKSPACE_SCOPE_MISMATCH" });
  });

  it("is plain authorization when no launch scope is given", () => {
    expect(engine.decide(launch("/anywhere", null))).toEqual({ kind: "allow" });
  });

  it("never turns an identity deny into a question", () => {
    // The grant would ask — but the role cannot write at all, and that answer comes first.
    const readOnlyRole: AuthorizationRequest = { ...launch("/project/web"), actor: "main" };
    expect(engine.decide(readOnlyRole)).toMatchObject({ kind: "deny", code: "WORKSPACE_NOT_GRANTED" });
    expect(engine.decide({ type: "delegation", actor: "worker", target: "main" })).toMatchObject({ kind: "deny", code: "DELEGATION_NOT_ALLOWED" });
    expect(engine.decide({ type: "tool", actor: "worker", tool: "Write" })).toMatchObject({ kind: "deny", code: "TOOL_NOT_GRANTED" });
  });

  it("keeps `authorize` as the final answer: it never says `require_approval`", () => {
    // `authorize` is the answer with no principal present — fail closed.
    expect(engine.authorize(launch("/project/web"))).toMatchObject({ allowed: false, code: "APPROVAL_UNAVAILABLE" });
    expect(engine.authorize(launch("/project/api"))).toEqual({ allowed: true });
  });
});
