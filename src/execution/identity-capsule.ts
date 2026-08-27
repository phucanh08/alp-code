import { memoryGrantCovers } from "../agents/memory-grant";
import type { AgentDefinition, MemoryScopeGrant, ToolId } from "../agents/types";
import type { BuiltMemoryContext, MemoryEntry } from "../memory/types";
import type { WorkflowExecutionState } from "../workflow/types";
import {
  deepFreezeExecutionValue,
  type ExecutionPolicy,
  type IdentityCapsule,
} from "./types";

export interface CreateIdentityCapsuleInput {
  readonly definition: AgentDefinition<unknown>;
  readonly policy: ExecutionPolicy;
  readonly task: string;
  readonly memoryContext: BuiltMemoryContext;
  readonly workflowState: WorkflowExecutionState;
}

function memoryIdIsGranted(
  definition: AgentDefinition<unknown>,
  id: string,
): boolean {
  const segments = id.split(":");
  if (segments[0] === "private" && segments[1] !== definition.id) {
    return false;
  }
  return definition.capabilities.memory.read.some((grant) =>
    memoryGrantCovers(grant, id as MemoryScopeGrant),
  );
}

function memoryIsGranted(
  definition: AgentDefinition<unknown>,
  entry: MemoryEntry,
): boolean {
  return (
    (entry.scope !== "private" || entry.ownerRole === definition.id) &&
    memoryIdIsGranted(definition, entry.id)
  );
}

export function createIdentityCapsule(
  input: CreateIdentityCapsuleInput,
): IdentityCapsule {
  if (
    input.policy.role !== input.definition.id ||
    input.policy.definitionHash.length === 0
  ) {
    throw new Error("execution policy does not match the resolved definition");
  }

  const workflow = input.definition.workflow.states[input.workflowState.currentState];
  if (
    input.workflowState.workflowId !== input.definition.workflow.id ||
    workflow === undefined
  ) {
    throw new Error("workflow state does not match the resolved definition");
  }
  const grantedTools = new Set<ToolId>(input.policy.allowedTools);
  const allowedTools = workflow.allowedTools.filter((tool) => grantedTools.has(tool));
  const entries = input.memoryContext.entries
    .filter((entry) => memoryIsGranted(input.definition, entry))
    .map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      content: entry.content,
      version: entry.version,
    }));
  const omittedEntryIds = input.memoryContext.diagnostics.omittedEntryIds.filter(
    (id) => memoryIdIsGranted(input.definition, id),
  );

  return deepFreezeExecutionValue({
    executionId: input.policy.executionId,
    definitionHash: input.policy.definitionHash,
    policyHash: input.policy.policyHash,
    role: input.definition.id,
    displayName: input.definition.displayName,
    instructions: input.definition.instructions({
      task: input.task,
      workspace: input.policy.workspace,
    }),
    task: input.task,
    activeWorkspace: input.policy.workspace,
    memoryContext: {
      invariantContext: input.memoryContext.invariantContext,
      policyContext: input.memoryContext.policyContext,
      entries,
      diagnostics: {
        characterBudget: input.memoryContext.diagnostics.characterBudget,
        charactersUsed: entries.reduce(
          (characters, entry) => characters + entry.content.length,
          0,
        ),
        truncated: omittedEntryIds.length > 0,
        omittedEntryIds,
      },
    },
    workflowState: { ...input.workflowState },
    allowedTools,
    outputContract: {
      name: input.definition.output.name,
      schema: input.definition.output.schema,
    },
  });
}
