export type AgentId = string;
export const TOOL_CATALOG = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash",
  "WebSearch",
  "WebFetch",
  "Skill",
] as const;
export type ToolId = (typeof TOOL_CATALOG)[number];
export type RuntimeId = "claude" | "codex";
export type RuntimeModelMap = Readonly<Record<RuntimeId, string>>;
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type RuntimeReasoningMap = Readonly<Record<RuntimeId, ReasoningEffort>>;

export type MemoryScopeGrant =
  | "shared"
  | `shared:${string}`
  | `project:${string}`
  | `private:${AgentId}`;

export interface MemoryGrants {
  readonly read: readonly MemoryScopeGrant[];
  readonly write: readonly MemoryScopeGrant[];
}

export interface WorkspaceGrants {
  readonly readRoots: readonly string[];
  readonly writeRoots: readonly string[];
}

export interface AgentCapabilities {
  readonly tools: readonly ToolId[];
  readonly memory: MemoryGrants;
  readonly workspace: WorkspaceGrants;
}

export type OutputValidation<TOutput> =
  | { readonly ok: true; readonly value?: TOutput }
  | { readonly ok: false; readonly issues: readonly string[] };

export interface OutputContract<TOutput> {
  readonly name: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly validate: (value: unknown) => OutputValidation<TOutput>;
}

export interface AgentDefinition<TOutput> {
  readonly id: AgentId;
  readonly displayName: string;
  readonly model: RuntimeModelMap;
  readonly reasoningEffort: RuntimeReasoningMap;
  readonly reportsTo: AgentId | "principal";
  readonly delegatesTo: readonly AgentId[];
  readonly capabilities: AgentCapabilities;
  /** Static identity text — no per-execution context. See `renderInstructions`. */
  readonly instructions: () => string;
  readonly workflow: WorkflowDefinition;
  readonly output: OutputContract<TOutput>;
}

export interface AgentRegistry {
  get(id: AgentId): AgentDefinition<unknown>;
  has(id: AgentId): boolean;
  list(): readonly AgentDefinition<unknown>[];
}
import type { WorkflowDefinition } from "../workflow/types";
