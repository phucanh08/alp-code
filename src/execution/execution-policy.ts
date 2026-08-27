import { createHash } from "node:crypto";
import type { AgentDefinition } from "../agents/types";
import {
  deepFreezeExecutionValue,
  type ExecutionId,
  type ExecutionPolicy,
} from "./types";

export interface CreateExecutionPolicyInput {
  readonly executionId: ExecutionId;
  readonly definition: AgentDefinition<unknown>;
  readonly workspace: string;
  readonly workspaceMode: "read-only" | "workspace-write";
  readonly createdAt: string;
}

function canonicalize(value: unknown): unknown {
  if (typeof value === "function") return value.toString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export function hashAgentDefinition(
  definition: AgentDefinition<unknown>,
): string {
  return sha256({
    id: definition.id,
    displayName: definition.displayName,
    model: definition.model,
    reasoningEffort: definition.reasoningEffort,
    reportsTo: definition.reportsTo,
    delegatesTo: definition.delegatesTo,
    capabilities: definition.capabilities,
    instructions: definition.instructions,
    workflow: definition.workflow,
    output: {
      name: definition.output.name,
      schema: definition.output.schema,
      validate: definition.output.validate,
    },
  });
}

export function createExecutionPolicy(
  input: CreateExecutionPolicyInput,
): ExecutionPolicy {
  const definitionHash = hashAgentDefinition(input.definition);
  const snapshot = {
    executionId: input.executionId,
    role: input.definition.id,
    workspace: input.workspace,
    workspaceMode: input.workspaceMode,
    allowedTools: [...input.definition.capabilities.tools],
    memory: {
      read: [...input.definition.capabilities.memory.read],
      write: [...input.definition.capabilities.memory.write],
    },
    delegatesTo: [...input.definition.delegatesTo],
    createdAt: input.createdAt,
    definitionHash,
  };
  return deepFreezeExecutionValue({
    ...snapshot,
    policyHash: sha256(snapshot),
  });
}
