import { describe, expect, it } from "vitest";
import { defineAgent } from "../../src/agents/agent-definition";
import { createAgentRegistry } from "../../src/agents/registry";
import type { AgentDefinition, AgentId } from "../../src/agents/types";
import { PolicyEngine } from "../../src/policy/policy-engine";
import type {
  AuthorizationRequest,
  PolicyErrorCode,
} from "../../src/policy/types";

function agent(
  id: AgentId,
  overrides: Partial<AgentDefinition<unknown>> = {},
): AgentDefinition<unknown> {
  return defineAgent({
    id,
    displayName: id,
    model: { claude: `claude-${id}`, codex: `codex-${id}` },
    reasoningEffort: { claude: "low", codex: "low" },
    reportsTo: id === "main" ? "principal" : "main",
    delegatesTo: id === "main" ? ["search"] : [],
    capabilities: {
      tools: id === "main" ? ["Read", "Write", "Bash"] : ["Read", "Bash"],
      memory: {
        read: ["shared", `private:${id}`],
        write: [`private:${id}`],
      },
      workspace: {
        readRoots: ["/workspace/active", "/workspace/other"],
        writeRoots:
          id === "main" ? ["/workspace/active", "/workspace/other"] : [],
      },
    },
    instructions: () => `${id} instructions`,
    workflow: {
      id: `${id}-workflow`,
      initial: "REPORT",
      states: {
        REPORT: { allowedTools: [], transitions: [], terminal: true },
      },
    },
    output: { name: `${id}-output`, schema: {}, validate: () => ({ ok: true }) },
    ...overrides,
  });
}

function engine(
  overrides: Partial<AgentDefinition<unknown>>[] = [],
): PolicyEngine {
  const definitions = [agent("main"), agent("search"), agent("review")];
  for (const override of overrides) {
    const index = definitions.findIndex(({ id }) => id === override.id);
    if (index >= 0) definitions[index] = agent(override.id!, override);
  }
  return new PolicyEngine({ registry: createAgentRegistry(definitions) });
}

const activeExecution = {
  activeWorkspace: "/workspace/active",
  workspaceMode: "workspace-write" as const,
  delegated: true,
};

describe("PolicyEngine deny-first matrix", () => {
  const denied: readonly [string, AuthorizationRequest, PolicyErrorCode][] = [
    [
      "main cannot read another role's private memory",
      {
        type: "memory",
        actor: "main",
        operation: "read",
        scope: "private:search",
      },
      "PRIVATE_MEMORY_DENIED",
    ],
    [
      "a specialist cannot delegate",
      { type: "delegation", actor: "search", target: "review" },
      "DELEGATION_NOT_ALLOWED",
    ],
    [
      "main can delegate only to exact declared targets",
      { type: "delegation", actor: "main", target: "review" },
      "DELEGATION_NOT_ALLOWED",
    ],
    [
      "read-only execution rejects writes",
      {
        type: "workspace",
        actor: "main",
        operation: "write",
        path: "/workspace/active/result.txt",
        execution: { ...activeExecution, workspaceMode: "read-only" },
      },
      "WORKSPACE_READ_ONLY",
    ],
    [
      "delegated execution rejects another registered workspace",
      {
        type: "workspace",
        actor: "main",
        operation: "read",
        path: "/workspace/other/source.ts",
        execution: activeExecution,
      },
      "WORKSPACE_SCOPE_MISMATCH",
    ],
    [
      "a role cannot mutate policy source",
      {
        type: "configuration",
        actor: "main",
        operation: "write",
        target: { kind: "policy-source" },
      },
      "POLICY_MUTATION_DENIED",
    ],
    [
      "a role cannot mutate its own definition",
      {
        type: "configuration",
        actor: "main",
        operation: "write",
        target: { kind: "agent-definition", agentId: "main" },
      },
      "DEFINITION_MUTATION_DENIED",
    ],
    [
      "raw Paseo tools are always denied",
      { type: "tool", actor: "main", tool: "mcp__paseo__create_agent" },
      "RAW_RUNTIME_TOOL_DENIED",
    ],
    [
      "raw spawn tools are always denied",
      { type: "tool", actor: "main", tool: "spawn_agent" },
      "RAW_RUNTIME_TOOL_DENIED",
    ],
    [
      "raw Herdr commands are always denied",
      {
        type: "tool",
        actor: "main",
        tool: "Bash",
        command: "herdr agent start search",
      },
      "RAW_RUNTIME_TOOL_DENIED",
    ],
    [
      "unknown tools fail closed",
      { type: "tool", actor: "main", tool: "MysteryTool" },
      "TOOL_NOT_GRANTED",
    ],
    [
      "indirect commands fail closed",
      {
        type: "tool",
        actor: "main",
        tool: "Bash",
        command: "cat $(resolve-secret)",
      },
      "INDIRECT_TOOL_REQUEST",
    ],
    [
      "environment-expanded paths fail closed",
      { type: "tool", actor: "main", tool: "Bash", command: 'cat "$HOME/secret"' },
      "INDIRECT_TOOL_REQUEST",
    ],
    [
      "process substitutions fail closed",
      { type: "tool", actor: "main", tool: "Bash", command: "cat <(resolve-secret)" },
      "INDIRECT_TOOL_REQUEST",
    ],
  ];

  it.each(denied)("denies: %s", (_label, request, code) => {
    expect(engine().authorize(request)).toMatchObject({ allowed: false, code });
  });

  it("requires a delegation target to report to its parent", () => {
    const policy = engine([{ id: "search", reportsTo: "principal" }]);

    expect(
      policy.authorize({ type: "delegation", actor: "main", target: "search" }),
    ).toMatchObject({ allowed: false, code: "DELEGATION_PARENT_MISMATCH" });
  });

  it("allows the declared delegation, own memory, active workspace, and granted tools", () => {
    const policy = engine();
    const requests: AuthorizationRequest[] = [
      { type: "delegation", actor: "main", target: "search" },
      {
        type: "memory",
        actor: "main",
        operation: "read",
        scope: "private:main",
      },
      {
        type: "workspace",
        actor: "main",
        operation: "write",
        path: "/workspace/active/result.txt",
        execution: activeExecution,
      },
      { type: "tool", actor: "main", tool: "Read" },
    ];

    for (const request of requests) {
      expect(policy.authorize(request)).toEqual({ allowed: true });
    }
  });

  it("canonicalizes workspace paths at the policy boundary", () => {
    const aliases = new Map([
      ["/alias", "/workspace/active/result.txt"],
      ["/workspace/active", "/workspace/active"],
      ["/workspace/other", "/workspace/other"],
    ]);
    const policy = new PolicyEngine({
      registry: createAgentRegistry([agent("main"), agent("search"), agent("review")]),
      canonicalizePath: (value) => aliases.get(value) ?? value,
    });

    expect(
      policy.authorize({
        type: "workspace",
        actor: "main",
        operation: "write",
        path: "/alias",
        execution: activeExecution,
      }),
    ).toEqual({ allowed: true });
  });

  it("allows librarian writes only below shared/reference and project refs", () => {
    const librarian = agent("librarian", {
      reportsTo: "main",
      capabilities: {
        ...agent("librarian").capabilities,
        memory: {
          read: ["shared", "project:*", "private:librarian"],
          write: ["shared:reference:*", "project:*:refs:*", "private:librarian"],
        },
      },
    });
    const main = agent("main", { delegatesTo: ["librarian"] });
    const policy = new PolicyEngine({ registry: createAgentRegistry([main, librarian]) });

    expect(policy.authorize({
      type: "memory", actor: "librarian", operation: "write", scope: "shared:reference:source",
    })).toEqual({ allowed: true });
    expect(policy.authorize({
      type: "memory", actor: "librarian", operation: "write", scope: "project:alp:refs:source",
    })).toEqual({ allowed: true });
    expect(policy.authorize({
      type: "memory", actor: "librarian", operation: "write", scope: "shared:decisions:source",
    })).toMatchObject({ allowed: false, code: "MEMORY_NOT_GRANTED" });
    expect(policy.authorize({
      type: "memory", actor: "librarian", operation: "write", scope: "project:alp:log:source",
    })).toMatchObject({ allowed: false, code: "MEMORY_NOT_GRANTED" });
  });

  it("fails closed for an unrecognized runtime request", () => {
    const request = { type: "future-action", actor: "main" } as unknown as AuthorizationRequest;

    expect(engine().authorize(request)).toMatchObject({
      allowed: false,
      code: "UNKNOWN_REQUEST",
    });
  });
});
