import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { AgentRegistry } from "../agents/types";
import { CapabilityPolicy, mcpServerOf } from "./capability-policy";
import { DelegationPolicy } from "./delegation-policy";
import {
  hasIndirectCommand,
  invokesRawRuntime,
  isRawRuntimeTool,
} from "./invariants";
import { MemoryPolicy } from "./memory-policy";
import {
  ALLOW,
  deny,
  toAuthorization,
  type Authorization,
  type AuthorizationRequest,
  type PathCanonicalizer,
  type PolicyDecision,
} from "./types";
import { WorkspacePolicy, within } from "./workspace-policy";

function canonicalizePath(value: string): string {
  const absolute = resolve(value);
  try {
    return realpathSync(absolute);
  } catch {
    try {
      return join(realpathSync(dirname(absolute)), basename(absolute));
    } catch {
      return absolute;
    }
  }
}

export interface PolicyEngineOptions {
  readonly registry: AgentRegistry;
  readonly canonicalizePath?: PathCanonicalizer;
}

export class PolicyEngine {
  private readonly registry: AgentRegistry;
  private readonly delegation: DelegationPolicy;
  private readonly memory = new MemoryPolicy();
  private readonly capability = new CapabilityPolicy();
  private readonly workspace: WorkspacePolicy;
  private readonly canonicalizePath: PathCanonicalizer;

  constructor(options: PolicyEngineOptions) {
    this.registry = options.registry;
    this.delegation = new DelegationPolicy(options.registry);
    this.canonicalizePath = options.canonicalizePath ?? canonicalizePath;
    this.workspace = new WorkspacePolicy(options.registry, this.canonicalizePath);
  }

  /**
   * The three-way answer. Identity is checked first and its denies are final: a role that
   * cannot write is never *asked* whether it may write somewhere else. Only a request that
   * identity allows, and that carries a launch scope, can become a question — and only the
   * one question phase 1 knows: outside the launcher's grant, inside its project.
   */
  decide(request: AuthorizationRequest): PolicyDecision {
    const identity = this.authorizeIdentity(request);
    if (!identity.allowed) return { kind: "deny", code: identity.code, reason: identity.reason };
    if (request.type !== "workspace" || request.launch === undefined) return { kind: "allow" };

    let target: string;
    let root: string;
    let project: string;
    try {
      target = this.canonicalizePath(request.path);
      root = this.canonicalizePath(request.launch.root);
      project = this.canonicalizePath(request.launch.project);
    } catch (error) {
      return { kind: "deny", code: "PATH_RESOLUTION_FAILED", reason: `cannot resolve launch scope: ${String(error)}` };
    }
    if (within(root, target)) return { kind: "allow" };
    if (!within(project, target)) {
      return {
        kind: "deny",
        code: "WORKSPACE_SCOPE_MISMATCH",
        reason: `\`${request.actor}\` cannot be launched at \`${target}\`: outside the granted workspace \`${root}\` and outside the project \`${project}\``,
      };
    }
    return {
      kind: "require_approval",
      rule: "workspace-outside-grant-inside-project",
      scope: "session",
      subject: target,
      prompt: `Launch \`${request.actor}\` at \`${target}\`? It is outside the granted workspace \`${root}\` but inside the project \`${project}\`.`,
    };
  }

  /** The two-way answer: a question nobody can answer here is a deny (`APPROVAL_UNAVAILABLE`). */
  authorize(request: AuthorizationRequest): Authorization {
    return toAuthorization(this.decide(request));
  }

  private authorizeIdentity(request: AuthorizationRequest): Authorization {
    if (!request || typeof request !== "object" || !("actor" in request)) {
      return deny("UNKNOWN_REQUEST", "unrecognized policy request");
    }
    if (!this.registry.has(request.actor)) {
      return deny("UNKNOWN_ACTOR", `unknown actor \`${request.actor}\``);
    }

    const actor = this.registry.get(request.actor);
    switch (request.type) {
      case "delegation":
        return this.delegation.authorize(request.actor, request.target);
      case "memory":
        return this.memory.authorize(actor, request.operation, request.scope);
      case "workspace":
        return this.workspace.authorize(
          request.actor,
          request.operation,
          request.path,
          request.execution,
        );
      case "configuration":
        return request.target.kind === "policy-source"
          ? deny(
              "POLICY_MUTATION_DENIED",
              `\`${request.actor}\` cannot mutate policy source`,
            )
          : deny(
              "DEFINITION_MUTATION_DENIED",
              `\`${request.actor}\` cannot mutate agent definition \`${request.target.agentId}\``,
            );
      case "skill":
        return this.capability.authorize(
          actor, "skill", request.skill, actor.capabilities.skills, "SKILL_NOT_GRANTED",
        );
      case "subagent":
        return this.capability.authorize(
          actor, "subagent", request.subagent, actor.capabilities.subagents, "SUBAGENT_NOT_GRANTED",
        );
      case "mcp":
        return this.capability.authorize(
          actor, "mcp server", request.server, actor.capabilities.mcpServers, "MCP_SERVER_NOT_GRANTED",
        );
      case "tool": {
        if (
          isRawRuntimeTool(request.tool) ||
          (request.command !== undefined && invokesRawRuntime(request.command))
        ) {
          return deny(
            "RAW_RUNTIME_TOOL_DENIED",
            `raw runtime tool \`${request.tool}\` is not part of the ALP delegation API`,
          );
        }
        if (
          request.command !== undefined &&
          hasIndirectCommand(request.command)
        ) {
          return deny(
            "INDIRECT_TOOL_REQUEST",
            `indirect command cannot be authorized safely`,
          );
        }
        const server = mcpServerOf(request.tool);
        if (server !== null) {
          return this.capability.authorize(
            actor, "mcp server", server, actor.capabilities.mcpServers, "MCP_SERVER_NOT_GRANTED",
          );
        }
        if (!actor.capabilities.tools.some((tool) => tool === request.tool)) {
          return deny(
            "TOOL_NOT_GRANTED",
            `\`${request.tool}\` is not granted to \`${request.actor}\``,
          );
        }
        return ALLOW;
      }
      default:
        return deny("UNKNOWN_REQUEST", "unrecognized policy request");
    }
  }
}
