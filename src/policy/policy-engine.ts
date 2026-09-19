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
  /**
   * Trees no launch may ever be allowed to write — the executions root first of all, where
   * `policy.json` and the evidence live. A write launch whose workspace or scope covers one of
   * these is refused outright (`WRITE_SCOPE_PROTECTED_ROOT`); reading there is not a launch
   * question. Empty by default so a test engine stays a pure function of its inputs.
   */
  readonly protectedRoots?: readonly string[];
}

export class PolicyEngine {
  private readonly registry: AgentRegistry;
  private readonly delegation: DelegationPolicy;
  private readonly memory = new MemoryPolicy();
  private readonly capability = new CapabilityPolicy();
  private readonly workspace: WorkspacePolicy;
  private readonly canonicalizePath: PathCanonicalizer;
  private readonly protectedRoots: readonly string[];

  constructor(options: PolicyEngineOptions) {
    this.registry = options.registry;
    this.delegation = new DelegationPolicy(options.registry);
    this.canonicalizePath = options.canonicalizePath ?? canonicalizePath;
    this.workspace = new WorkspacePolicy(options.registry, this.canonicalizePath);
    this.protectedRoots = Object.freeze((options.protectedRoots ?? []).map((root) => this.canonicalizePath(root)));
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
    if (request.type !== "workspace") return { kind: "allow" };
    // A scope is judged before the launch rule: a scope that escapes the workspace is wrong
    // wherever the workspace is, and never something a principal is asked to approve.
    if (request.writeScope !== undefined) {
      const scope = this.decideWriteScope(request, request.writeScope);
      if (scope !== null) return scope;
    }
    if (request.excludeScope !== undefined) {
      const excluded = this.decideExcludeScope(request, request.excludeScope);
      if (excluded !== null) return excluded;
    }
    if (request.launch === undefined) return { kind: "allow" };

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
    if (request.operation === "write" && request.writeScope === undefined) {
      // Unscoped write launch: the whole workspace is the scope, so it must not cover a
      // protected root either. A scoped launch was already checked entry by entry.
      const covered = this.protectedRootTouching(target);
      if (covered !== null) {
        return {
          kind: "deny",
          code: "WRITE_SCOPE_PROTECTED_ROOT",
          reason: `\`${request.actor}\` cannot be launched writable at \`${target}\`: it covers the protected root \`${covered}\`; narrow it with a write scope`,
        };
      }
      const parent = this.decideParentScope(request, target, [target]);
      if (parent !== null) return parent;
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

  /**
   * The write-scope checks, in order: a scope on a read-only launch is a contradiction; each
   * entry must resolve, sit inside the workspace, and touch no protected root; and under a
   * scoped parent each entry must sit inside something the parent may write. `null` when the
   * scope is acceptable and the launch rule gets to speak.
   */
  private decideWriteScope(
    request: Extract<AuthorizationRequest, { type: "workspace" }>,
    writeScope: readonly string[],
  ): PolicyDecision | null {
    if (request.operation !== "write") {
      return {
        kind: "deny",
        code: "WRITE_SCOPE_ON_READ_ONLY",
        reason: `\`${request.actor}\` was given a write scope for a read-only launch at \`${request.path}\``,
      };
    }
    let workspace: string;
    const entries: string[] = [];
    try {
      workspace = this.canonicalizePath(request.path);
      for (const entry of writeScope) entries.push(this.canonicalizePath(entry));
    } catch (error) {
      return { kind: "deny", code: "PATH_RESOLUTION_FAILED", reason: `cannot resolve write scope: ${String(error)}` };
    }
    for (const entry of entries) {
      if (!within(workspace, entry)) {
        return {
          kind: "deny",
          code: "WRITE_SCOPE_OUTSIDE_WORKSPACE",
          reason: `write scope entry \`${entry}\` is outside the workspace \`${workspace}\``,
        };
      }
      const covered = this.protectedRootTouching(entry);
      if (covered !== null) {
        return {
          kind: "deny",
          code: "WRITE_SCOPE_PROTECTED_ROOT",
          reason: `write scope entry \`${entry}\` touches the protected root \`${covered}\``,
        };
      }
    }
    return this.decideParentScope(request, workspace, entries);
  }

  /**
   * The exclude-scope checks (master plan 2b): an exclusion on a read-only launch is a
   * contradiction; each entry must resolve and sit inside an owned root — the scope, or the
   * whole workspace when there is none — without swallowing that root whole, which would
   * leave the child owning nothing under a name that says it owns something.
   */
  private decideExcludeScope(
    request: Extract<AuthorizationRequest, { type: "workspace" }>,
    excludeScope: readonly string[],
  ): PolicyDecision | null {
    if (request.operation !== "write") {
      return {
        kind: "deny",
        code: "EXCLUDE_SCOPE_ON_READ_ONLY",
        reason: `\`${request.actor}\` was given an exclude scope for a read-only launch at \`${request.path}\``,
      };
    }
    let owned: string[];
    const entries: string[] = [];
    try {
      owned = (request.writeScope ?? [request.path]).map((entry) => this.canonicalizePath(entry));
      for (const entry of excludeScope) entries.push(this.canonicalizePath(entry));
    } catch (error) {
      return { kind: "deny", code: "PATH_RESOLUTION_FAILED", reason: `cannot resolve exclude scope: ${String(error)}` };
    }
    for (const entry of entries) {
      const root = owned.find((candidate) => within(candidate, entry));
      if (root === undefined) {
        return {
          kind: "deny",
          code: "EXCLUDE_SCOPE_OUTSIDE_WRITE_SCOPE",
          reason: `exclude scope entry \`${entry}\` is outside what \`${request.actor}\` may write [${owned.join(", ")}]`,
        };
      }
      if (root === entry) {
        return {
          kind: "deny",
          code: "EXCLUDE_SCOPE_COVERS_WRITE_SCOPE",
          reason: `exclude scope entry \`${entry}\` covers the whole owned root; drop the root from the write scope instead`,
        };
      }
    }
    return null;
  }

  /**
   * Under a scoped parent, every subtree the child may write must be one the parent may
   * write — the child's scope, or its whole workspace when it asks for none.
   */
  private decideParentScope(
    request: Extract<AuthorizationRequest, { type: "workspace" }>,
    workspace: string,
    entries: readonly string[],
  ): PolicyDecision | null {
    const parentScope = request.launch?.writeScope;
    if (parentScope === undefined || parentScope === null) return null;
    let parentEntries: string[];
    try {
      parentEntries = parentScope.map((entry) => this.canonicalizePath(entry));
    } catch (error) {
      return { kind: "deny", code: "PATH_RESOLUTION_FAILED", reason: `cannot resolve the launcher's write scope: ${String(error)}` };
    }
    for (const entry of entries) {
      if (parentEntries.some((parent) => within(parent, entry))) continue;
      return {
        kind: "deny",
        code: "WRITE_SCOPE_EXCEEDS_PARENT",
        reason: entry === workspace
          ? `\`${request.actor}\` cannot write all of \`${workspace}\`: the launcher may only write [${parentEntries.join(", ")}]; narrow it with a write scope`
          : `write scope entry \`${entry}\` is outside what the launcher may write [${parentEntries.join(", ")}]`,
      };
    }
    return null;
  }

  /** The protected root `path` equals, contains, or lies inside — or `null`. */
  private protectedRootTouching(path: string): string | null {
    return this.protectedRoots.find((root) => within(root, path) || within(path, root)) ?? null;
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
