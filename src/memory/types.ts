import type { AgentId, MemoryScopeGrant } from "../agents/types";

export type MemoryScope = "shared" | "project" | "private";
export type MemoryKind = "fact" | "decision" | "reference" | "log" | "draft";

export interface MemoryEntry {
  readonly id: string;
  readonly scope: MemoryScope;
  readonly ownerRole?: AgentId;
  readonly projectId?: string;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateMemoryInput {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly content: string;
}

export interface UpdateMemoryInput {
  readonly expectedVersion: number;
  readonly kind?: MemoryKind;
  readonly content?: string;
}

export interface MemoryQuery {
  readonly scope: MemoryScopeGrant;
  readonly text?: string;
  readonly kinds?: readonly MemoryKind[];
  readonly limit?: number;
}

export interface ParsedMemoryId {
  readonly id: string;
  readonly scope: MemoryScope;
  readonly grant: MemoryScopeGrant;
  readonly name: string;
  readonly pathSegments: readonly string[];
  readonly ownerRole?: AgentId;
  readonly projectId?: string;
}

export type MemoryOperation = "search" | "get" | "create" | "update" | "delete";
export type MemoryAuditResult = "allowed" | "denied" | "error";

export interface MemoryAuditEvent {
  readonly actor: AgentId;
  readonly operation: MemoryOperation;
  readonly logicalId: string;
  readonly result: MemoryAuditResult;
  readonly timestamp: string;
  readonly detail?: string;
}

export interface ContextDiagnostics {
  readonly characterBudget: number;
  readonly charactersUsed: number;
  readonly truncated: boolean;
  readonly omittedEntryIds: readonly string[];
}

export interface BuiltMemoryContext {
  readonly invariantContext: string;
  readonly policyContext: string;
  readonly entries: readonly MemoryEntry[];
  readonly diagnostics: ContextDiagnostics;
}

export interface BuildMemoryContextInput {
  readonly actor: AgentId;
  readonly queries: readonly MemoryQuery[];
  readonly characterBudget: number;
  readonly invariantContext: string;
  readonly policyContext: string;
}
