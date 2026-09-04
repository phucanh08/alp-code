import type {
  McpServerCatalogEntry,
  SubagentCatalogEntry,
} from "../agents/capability-catalog";
import type {
  AgentId,
  MemoryGrants,
  ToolId,
} from "../agents/types";
import type {
  ContextDiagnostics,
  MemoryKind,
  MemoryQuery,
} from "../memory/types";
import type { WorkflowExecutionState } from "../workflow/types";
import type { WorkflowRunStatus } from "../workflow/types";

export type ExecutionId = string;

/**
 * A capability grant after its name has been resolved against the catalog.
 *
 * The resolution is snapshotted rather than looked up again at launch: the policy record is
 * what an execution is judged against afterwards, and "which command did this run, reaching
 * what" is exactly the question a name alone cannot answer once the catalog has moved on.
 */
export interface McpServerAuthorization extends McpServerCatalogEntry {
  readonly name: string;
}

export interface SubagentAuthorization extends SubagentCatalogEntry {
  readonly name: string;
}

export interface ExecutionPolicy {
  readonly executionId: ExecutionId;
  readonly role: AgentId;
  readonly workspace: string;
  readonly workspaceMode: "read-only" | "workspace-write";
  /**
   * Whether this role holds any workspace grant at all. `none` for a role that declares no
   * root (read-thread, compaction, titling): it works from memory, the workspace is only
   * the process cwd, and the runtime ACL must not hand it the tree as a read root.
   */
  readonly workspaceAccess: "granted" | "none";
  readonly allowedTools: readonly ToolId[];
  /** Named skill grants (§5.3). The runtime ACL allows exactly these through `Skill`. */
  readonly skills: readonly string[];
  readonly subagents: readonly SubagentAuthorization[];
  readonly mcpServers: readonly McpServerAuthorization[];
  /**
   * Token count at which the runtime compacts, or `null` when the role declared none and
   * the adapter resolves 90% of the model's window at launch. `null` rather than an absent
   * key: the snapshot has to say "not declared" out loud, the same way it says which tools
   * were withheld. The resolved number is not stored here because it depends on the runtime
   * the execution is dispatched to, and this snapshot is runtime-agnostic.
   */
  readonly autoCompactTokens: number | null;
  readonly memory: MemoryGrants;
  readonly delegatesTo: readonly AgentId[];
  readonly createdAt: string;
  readonly definitionHash: string;
  readonly policyHash: string;
}

export interface CapsuleMemoryEntry {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly version: number;
}

export interface CapsuleMemoryContext {
  readonly invariantContext: string;
  readonly policyContext: string;
  readonly entries: readonly CapsuleMemoryEntry[];
  readonly diagnostics: ContextDiagnostics;
}

export interface IdentityCapsule {
  readonly executionId: ExecutionId;
  readonly definitionHash: string;
  readonly policyHash: string;
  readonly role: AgentId;
  readonly displayName: string;
  readonly instructions: string;
  readonly task: string;
  readonly activeWorkspace: string;
  readonly memoryContext: CapsuleMemoryContext;
  readonly workflowState: WorkflowExecutionState;
  readonly allowedTools: readonly ToolId[];
  readonly outputContract: {
    readonly name: string;
    readonly schema: Readonly<Record<string, unknown>>;
  };
}

export interface StoredExecutionState {
  readonly executionId: ExecutionId;
  readonly status: "prepared" | WorkflowRunStatus;
  readonly workflow: WorkflowExecutionState;
  readonly policyHash: string;
  readonly createdAt: string;
  readonly output?: unknown;
}

export interface ExecutionArtifactPaths {
  readonly directory: string;
  readonly stateFile: string;
  readonly policyFile: string;
  readonly runtimeDirectory: string;
  /** `context/`, `0700`, survives `runtime/` cleanup — see plan §7. */
  readonly contextDirectory: string;
  readonly checkpointFile: string;
  readonly continuityFile: string;
  readonly compactEventsFile: string;
}

export interface PreparedExecution {
  readonly capsule: IdentityCapsule;
  readonly policy: ExecutionPolicy;
  readonly state: StoredExecutionState;
  readonly artifacts: ExecutionArtifactPaths;
}

export interface PrepareExecutionInput {
  readonly executionId: ExecutionId;
  readonly parent: AgentId | "principal";
  readonly target: AgentId;
  readonly task: string;
  readonly workspace: string;
  readonly workspaceMode: "read-only" | "workspace-write";
  readonly memoryQueries: readonly MemoryQuery[];
  readonly characterBudget: number;
  readonly invariantContext: string;
  readonly policyContext: string;
}

export function deepFreezeExecutionValue<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const key of Reflect.ownKeys(value)) {
    deepFreezeExecutionValue((value as Record<PropertyKey, unknown>)[key]);
  }
  return Object.freeze(value);
}
