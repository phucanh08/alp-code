import { join } from "node:path";
import { PolicyEngine } from "../policy/policy-engine";
import type { AuthorizationRequest, PolicyErrorCode } from "../policy/types";
import { SKILL_CATALOG } from "../agents/capability-catalog";
import { memoryGrantCovers } from "../agents/memory-grant";
import type { AgentDefinition, AgentRegistry, MemoryScopeGrant } from "../agents/types";
import { TOOL_CATALOG } from "../agents/types";
import type { AgentTestCheck } from "./types";

export interface Tier3Input {
  readonly definition: AgentDefinition<unknown>;
  readonly registry: AgentRegistry;
  /** The workspace the role was prepared against, so the probes speak about a real path. */
  readonly workspace: string;
}

interface Probe {
  readonly id: string;
  readonly what: string;
  readonly request: AuthorizationRequest;
  readonly expected: readonly PolicyErrorCode[];
}

/**
 * Tier 3 — every ceiling has to deny with the code that names it, not merely fail.
 *
 * The distinction is the whole tier. A grant that is refused for the wrong reason is a
 * ceiling nobody can reason about: the operator sees a denial and cannot tell whether the
 * role lacked the tool, was pointed outside its workspace, or hit a bug in the engine, and
 * an over-broad grant that happens to be refused today by an unrelated rule looks exactly
 * like one that is genuinely closed.
 *
 * Probes are derived from the definition rather than written per role: what a role is *not*
 * granted is a function of what it is granted, and a hand-written list would go stale the
 * first time a grant changes.
 */
function buildProbes(input: Tier3Input): readonly Probe[] {
  const { definition, registry, workspace } = input;
  const self = definition.id;
  const { tools, skills, subagents, mcpServers, memory, workspace: roots } = definition.capabilities;
  const others = registry.list().map((entry) => entry.id).filter((id) => id !== self);
  const probes: Probe[] = [];

  const ungrantedTool = TOOL_CATALOG.find((tool) => !tools.includes(tool)) ?? "AlpProbeTool";
  probes.push({
    id: "tool-not-granted",
    what: `tool \`${ungrantedTool}\``,
    request: { type: "tool", actor: self, tool: ungrantedTool },
    expected: ["TOOL_NOT_GRANTED"],
  });
  probes.push({
    id: "raw-runtime-tool",
    what: "in-process agent tool `mcp__paseo__spawn_agent`",
    request: { type: "tool", actor: self, tool: "mcp__paseo__spawn_agent" },
    expected: ["RAW_RUNTIME_TOOL_DENIED"],
  });
  probes.push({
    id: "indirect-command",
    what: "a command whose real payload is hidden from inspection",
    request: { type: "tool", actor: self, tool: "Bash", command: "eval $(cat payload)" },
    expected: ["INDIRECT_TOOL_REQUEST", "RAW_RUNTIME_TOOL_DENIED"],
  });

  const foreign = others[0];
  if (foreign !== undefined) {
    probes.push({
      id: "private-memory",
      what: `private memory of \`${foreign}\``,
      request: { type: "memory", actor: self, operation: "read", scope: `private:${foreign}` },
      expected: ["PRIVATE_MEMORY_DENIED"],
    });
  }

  const candidates: readonly MemoryScopeGrant[] = ["shared", "shared:alp-probe", "project:alp-probe", `private:${self}`];
  const ungrantedScope = candidates.find((scope) => !memory.read.some((grant) => memoryGrantCovers(grant, scope)));
  if (ungrantedScope !== undefined) {
    probes.push({
      id: "memory-not-granted",
      what: `memory scope \`${ungrantedScope}\``,
      request: { type: "memory", actor: self, operation: "read", scope: ungrantedScope },
      expected: ["MEMORY_NOT_GRANTED"],
    });
  }

  const ungrantedSkill = SKILL_CATALOG.find((skill) => !skills.includes(skill)) ?? "alp-probe-skill";
  probes.push({
    id: "skill-not-granted",
    what: `skill \`${ungrantedSkill}\``,
    request: { type: "skill", actor: self, skill: ungrantedSkill },
    expected: ["SKILL_NOT_GRANTED"],
  });
  const ungrantedSubagent = subagents.includes("explore") ? "alp-probe-subagent" : "explore";
  probes.push({
    id: "subagent-not-granted",
    what: `in-process subagent \`${ungrantedSubagent}\``,
    request: { type: "subagent", actor: self, subagent: ungrantedSubagent },
    expected: ["SUBAGENT_NOT_GRANTED"],
  });
  const ungrantedServer = mcpServers.includes("docs") ? "alp-probe-server" : "docs";
  probes.push({
    id: "mcp-not-granted",
    what: `MCP server \`${ungrantedServer}\``,
    request: { type: "mcp", actor: self, server: ungrantedServer },
    expected: ["MCP_SERVER_NOT_GRANTED"],
  });

  const outside = join(workspace, "..", "elsewhere");
  probes.push({
    id: "workspace-scope-mismatch",
    what: "a path outside the workspace this execution was scoped to",
    request: {
      type: "workspace", actor: self, operation: "read", path: outside,
      execution: { activeWorkspace: workspace, workspaceMode: "read-only", delegated: true },
    },
    expected: ["WORKSPACE_SCOPE_MISMATCH"],
  });
  probes.push({
    id: "workspace-read-only",
    what: "a write inside a read-only execution",
    request: {
      type: "workspace", actor: self, operation: "write", path: join(workspace, "file.ts"),
      execution: { activeWorkspace: workspace, workspaceMode: "read-only", delegated: true },
    },
    expected: ["WORKSPACE_READ_ONLY"],
  });
  // Not delegated, so the scope rule stays out of the way and the answer is about the
  // declared root alone — the ceiling this probe is actually asking about.
  probes.push({
    id: "workspace-not-granted",
    what: "a path outside every declared read root",
    request: {
      type: "workspace", actor: self, operation: "read", path: outside,
      execution: { activeWorkspace: workspace, workspaceMode: "read-only", delegated: false },
    },
    expected: ["WORKSPACE_NOT_GRANTED"],
  });
  if (roots.writeRoots.length === 0) {
    probes.push({
      id: "workspace-write-not-granted",
      what: "a write in a workspace-write execution, with no write root declared",
      request: {
        type: "workspace", actor: self, operation: "write", path: join(workspace, "file.ts"),
        execution: { activeWorkspace: workspace, workspaceMode: "workspace-write", delegated: true },
      },
      expected: ["WORKSPACE_NOT_GRANTED"],
    });
  }

  // Who may reach this role, asked from the outside. The inverse — this role reaching
  // someone it does not delegate to — has no probe for a coordinator that already delegates
  // to everyone, while "nobody but my parent may launch me" is a ceiling every role has.
  const stranger = others.find((id) => id !== definition.reportsTo && !registry.get(id).delegatesTo.includes(self));
  if (stranger !== undefined) {
    probes.push({
      id: "delegation-not-allowed",
      what: `\`${stranger}\` launching this role`,
      request: { type: "delegation", actor: stranger, target: self },
      expected: ["DELEGATION_NOT_ALLOWED", "DELEGATION_PARENT_MISMATCH"],
    });
  }

  probes.push({
    id: "definition-mutation",
    what: "editing an agent definition from inside an execution",
    request: {
      type: "configuration", actor: self, operation: "write",
      target: { kind: "agent-definition", agentId: self },
    },
    expected: ["DEFINITION_MUTATION_DENIED"],
  });
  probes.push({
    id: "policy-mutation",
    what: "editing policy source from inside an execution",
    request: { type: "configuration", actor: self, operation: "write", target: { kind: "policy-source" } },
    expected: ["POLICY_MUTATION_DENIED"],
  });

  return probes;
}

export function runTier3(input: Tier3Input): readonly AgentTestCheck[] {
  const engine = new PolicyEngine({ registry: input.registry });
  return buildProbes(input).map((probe) => {
    const authorization = engine.authorize(probe.request);
    if (authorization.allowed) {
      return { tier: 3, id: probe.id, status: "fail", detail: `${probe.what} was ALLOWED` } as const;
    }
    const expected = probe.expected.includes(authorization.code);
    return {
      tier: 3,
      id: probe.id,
      status: expected ? "pass" : "fail",
      detail: expected
        ? `${probe.what} → ${authorization.code}`
        : `${probe.what} → ${authorization.code}, expected ${probe.expected.join(" or ")}`,
    } as const;
  });
}
