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

export interface ExecutionPolicy {
  readonly executionId: ExecutionId;
  readonly role: AgentId;
  readonly workspace: string;
  readonly workspaceMode: "read-only" | "workspace-write";
  readonly allowedTools: readonly ToolId[];
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
