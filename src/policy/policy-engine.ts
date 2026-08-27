import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { AgentRegistry } from "../agents/types";
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
  type Authorization,
  type AuthorizationRequest,
  type PathCanonicalizer,
} from "./types";
import { WorkspacePolicy } from "./workspace-policy";

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
  private readonly workspace: WorkspacePolicy;

  constructor(options: PolicyEngineOptions) {
    this.registry = options.registry;
    this.delegation = new DelegationPolicy(options.registry);
    this.workspace = new WorkspacePolicy(
      options.registry,
      options.canonicalizePath ?? canonicalizePath,
    );
  }

  authorize(request: AuthorizationRequest): Authorization {
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
