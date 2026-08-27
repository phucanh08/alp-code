import type { AgentId, MemoryScopeGrant } from "../agents/types";

export type PolicyErrorCode =
  | "UNKNOWN_ACTOR"
  | "UNKNOWN_TARGET"
  | "DELEGATION_NOT_ALLOWED"
  | "DELEGATION_PARENT_MISMATCH"
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
    };

export type PathCanonicalizer = (value: string) => string;

export const ALLOW: Authorization = Object.freeze({ allowed: true });

export function deny(code: PolicyErrorCode, reason: string): Authorization {
  return Object.freeze({ allowed: false, code, reason });
}
