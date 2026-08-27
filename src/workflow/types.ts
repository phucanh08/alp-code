import type { ToolId } from "../agents/types";

export type WorkflowStateId = string;

export interface WorkflowStateDefinition {
  readonly allowedTools: readonly ToolId[];
  readonly transitions: readonly WorkflowStateId[];
  readonly terminal?: true;
}

export interface WorkflowDefinition {
  readonly id: string;
  readonly initial: WorkflowStateId;
  readonly states: Readonly<Record<WorkflowStateId, WorkflowStateDefinition>>;
}

export type WorkflowRunStatus =
  | "running"
  | "awaiting-output"
  | "repairing"
  | "completed"
  | "failed"
  | "cancelled";

export interface WorkflowExecutionState {
  readonly workflowId: string;
  readonly currentState: WorkflowStateId;
  readonly status: WorkflowRunStatus;
  readonly repairAttempts: number;
}

export interface LinearWorkflowState {
  readonly id: WorkflowStateId;
  readonly allowedTools: readonly ToolId[];
}

export function defineLinearWorkflow(
  id: string,
  linearStates: readonly LinearWorkflowState[],
): WorkflowDefinition {
  if (linearStates.length === 0) {
    throw new Error(`workflow \`${id}\` must declare at least one state`);
  }

  const states: Record<WorkflowStateId, WorkflowStateDefinition> = {};
  linearStates.forEach((state, index) => {
    const next = linearStates[index + 1];
    states[state.id] = {
      allowedTools: [...state.allowedTools],
      transitions: next === undefined ? [] : [next.id],
      ...(next === undefined ? { terminal: true as const } : {}),
    };
  });

  return {
    id,
    initial: linearStates[0].id,
    states,
  };
}
