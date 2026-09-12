import type { AgentId, MemoryScopeGrant } from "../agents/types";

export type PolicyErrorCode =
  | "UNKNOWN_ACTOR"
  | "UNKNOWN_TARGET"
  | "DELEGATION_NOT_ALLOWED"
  | "PRIVATE_MEMORY_DENIED"
  | "MEMORY_NOT_GRANTED"
  | "WORKSPACE_NOT_GRANTED"
  | "WORKSPACE_READ_ONLY"
  | "WORKSPACE_SCOPE_MISMATCH"
  | "PATH_RESOLUTION_FAILED"
  | "POLICY_MUTATION_DENIED"
  | "DEFINITION_MUTATION_DENIED"
  | "RAW_RUNTIME_TOOL_DENIED"
  | "INDIRECT_TOOL_REQUEST"
  | "TOOL_NOT_GRANTED"
  | "SKILL_NOT_GRANTED"
  | "SUBAGENT_NOT_GRANTED"
  | "MCP_SERVER_NOT_GRANTED"
  | "APPROVAL_UNAVAILABLE"
  | "APPROVAL_DENIED"
  | "UNKNOWN_REQUEST";

export type Authorization =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly code: PolicyErrorCode;
      readonly reason: string;
    };

export interface ExecutionWorkspaceScope {
  readonly activeWorkspace: string;
  readonly workspaceMode: "read-only" | "workspace-write";
  readonly delegated: boolean;
}

/**
 * Where a launch is being asked for *from*: the workspace the launcher itself was granted
 * (`root`) and the registered project around it (`project`). Absent on a request that is not
 * a launch — a hook checking one path — and then no question is ever asked.
 */
export interface LaunchScope {
  readonly root: string;
  readonly project: string;
}

/**
 * The one thing a principal may be asked, by name. There is exactly one rule in phase 1:
 * a launch outside the granted workspace but inside the project root. Everything that is
 * identity — tools, delegation, memory, the role's own roots — is never a question.
 */
export const APPROVAL_RULE_IDS = ["workspace-outside-grant-inside-project"] as const;
export type ApprovalRuleId = (typeof APPROVAL_RULE_IDS)[number];

/** How long a "yes" holds: this launch, this execution, or every launch under the same root. */
export const APPROVAL_SCOPES = ["once", "execution", "session"] as const;
export type ApprovalScope = (typeof APPROVAL_SCOPES)[number];

/**
 * A three-way answer. `authorize()` folds it back to two — a decision with no principal
 * present is a deny — so a caller that cannot ask never sees the question.
 */
export type PolicyDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly code: PolicyErrorCode; readonly reason: string }
  | {
      readonly kind: "require_approval";
      readonly rule: ApprovalRuleId;
      readonly scope: ApprovalScope;
      /** The canonical path the question is about — what a session-scoped "yes" is keyed by. */
      readonly subject: string;
      /** The question, phrased for a person: what is widened, to what, from where. */
      readonly prompt: string;
    };

export type AuthorizationRequest =
  | {
      readonly type: "delegation";
      readonly actor: AgentId;
      readonly target: AgentId;
    }
  | {
      readonly type: "memory";
      readonly actor: AgentId;
      readonly operation: "read" | "write";
      readonly scope: MemoryScopeGrant;
    }
  | {
      readonly type: "workspace";
      readonly actor: AgentId;
      readonly operation: "read" | "write";
      readonly path: string;
      readonly execution: ExecutionWorkspaceScope;
      readonly launch?: LaunchScope;
    }
  | {
      readonly type: "configuration";
      readonly actor: AgentId;
      readonly operation: "write";
      readonly target:
        | { readonly kind: "policy-source" }
        | { readonly kind: "agent-definition"; readonly agentId: AgentId };
    }
  | {
      readonly type: "tool";
      readonly actor: AgentId;
      readonly tool: string;
      readonly command?: string;
    }
  | {
      readonly type: "skill";
      readonly actor: AgentId;
      readonly skill: string;
    }
  | {
      readonly type: "subagent";
      readonly actor: AgentId;
      readonly subagent: string;
    }
  | {
      readonly type: "mcp";
      readonly actor: AgentId;
      readonly server: string;
    };

export type PathCanonicalizer = (value: string) => string;

export const ALLOW: Authorization = Object.freeze({ allowed: true });

export function deny(code: PolicyErrorCode, reason: string): Authorization {
  return Object.freeze({ allowed: false, code, reason });
}

/**
 * The two-way view of a decision. `require_approval` becomes `APPROVAL_UNAVAILABLE`: the
 * question existed and nobody was there to answer it. `APPROVAL_DENIED` is never produced
 * here — only a surface that asked and heard "no" says that.
 */
export function toAuthorization(decision: PolicyDecision): Authorization {
  switch (decision.kind) {
    case "allow":
      return ALLOW;
    case "deny":
      return deny(decision.code, decision.reason);
    case "require_approval":
      return deny("APPROVAL_UNAVAILABLE", `approval required (${decision.rule}) and no principal can be asked: ${decision.prompt}`);
  }
}
