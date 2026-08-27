import type { OutputContract, OutputValidation, ToolId } from "../agents/types";
import { validateOutput } from "./output-validator";
import { canRepairOutput } from "./repair-policy";
import type {
  WorkflowDefinition,
  WorkflowExecutionState,
  WorkflowRunStatus,
  WorkflowStateId,
} from "./types";

export interface OutputSubmission<TOutput> {
  readonly state: WorkflowExecutionState;
  readonly validation: OutputValidation<TOutput>;
}

function stateSnapshot(
  workflowId: string,
  currentState: WorkflowStateId,
  status: WorkflowRunStatus,
  repairAttempts: number,
): WorkflowExecutionState {
  return Object.freeze({ workflowId, currentState, status, repairAttempts });
}

function validateDefinition(definition: WorkflowDefinition): void {
  if (!definition.states[definition.initial]) {
    throw new Error(
      `workflow \`${definition.id}\` has unknown initial state \`${definition.initial}\``,
    );
  }

  for (const [stateId, state] of Object.entries(definition.states)) {
    if (state.terminal && state.transitions.length > 0) {
      throw new Error(
        `terminal workflow state \`${stateId}\` cannot declare transitions`,
      );
    }
    for (const target of state.transitions) {
      if (!definition.states[target]) {
        throw new Error(
          `workflow state \`${stateId}\` has unknown transition target \`${target}\``,
        );
      }
    }
  }
}

function assertStateBelongsToWorkflow(
  definition: WorkflowDefinition,
  state: WorkflowExecutionState,
): void {
  if (state.workflowId !== definition.id) {
    throw new Error(
      `workflow state belongs to \`${state.workflowId}\`, not \`${definition.id}\``,
    );
  }
  if (!definition.states[state.currentState]) {
    throw new Error(
      `workflow \`${definition.id}\` has no state \`${state.currentState}\``,
    );
  }
}

export class WorkflowRunner {
  initialize(definition: WorkflowDefinition): WorkflowExecutionState {
    validateDefinition(definition);
    const initial = definition.states[definition.initial];
    return stateSnapshot(
      definition.id,
      definition.initial,
      initial.terminal ? "awaiting-output" : "running",
      0,
    );
  }

  transition(
    definition: WorkflowDefinition,
    state: WorkflowExecutionState,
    next: WorkflowStateId,
  ): WorkflowExecutionState {
    assertStateBelongsToWorkflow(definition, state);
    if (state.status !== "running") {
      throw new Error(
        `cannot transition workflow in \`${state.status}\` status`,
      );
    }

    const current = definition.states[state.currentState];
    if (!current.transitions.includes(next)) {
      throw new Error(
        `transition \`${state.currentState}\` -> \`${next}\` is not declared`,
      );
    }
    const target = definition.states[next];
    return stateSnapshot(
      definition.id,
      next,
      target.terminal ? "awaiting-output" : "running",
      state.repairAttempts,
    );
  }

  isToolAllowed(
    definition: WorkflowDefinition,
    state: WorkflowExecutionState,
    tool: ToolId,
  ): boolean {
    assertStateBelongsToWorkflow(definition, state);
    return (
      state.status === "running" &&
      definition.states[state.currentState].allowedTools.includes(tool)
    );
  }

  submitOutput<TOutput>(
    state: WorkflowExecutionState,
    contract: OutputContract<TOutput>,
    value: unknown,
  ): OutputSubmission<TOutput> {
    if (state.status !== "awaiting-output" && state.status !== "repairing") {
      throw new Error(`cannot submit output in \`${state.status}\` status`);
    }

    const validation = validateOutput(contract, value);
    if (validation.ok) {
      return Object.freeze({
        state: stateSnapshot(
          state.workflowId,
          state.currentState,
          "completed",
          state.repairAttempts,
        ),
        validation,
      });
    }

    const repairAllowed = canRepairOutput(state.repairAttempts);
    return Object.freeze({
      state: stateSnapshot(
        state.workflowId,
        state.currentState,
        repairAllowed ? "repairing" : "failed",
        repairAllowed ? state.repairAttempts + 1 : state.repairAttempts,
      ),
      validation,
    });
  }

  cancel(state: WorkflowExecutionState): WorkflowExecutionState {
    if (
      state.status !== "running" &&
      state.status !== "awaiting-output" &&
      state.status !== "repairing"
    ) {
      throw new Error(`cannot cancel workflow in \`${state.status}\` status`);
    }
    return stateSnapshot(
      state.workflowId,
      state.currentState,
      "cancelled",
      state.repairAttempts,
    );
  }
}
