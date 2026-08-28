import { randomUUID } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentRegistry } from "../agents/registry";
import type { AgentDefinition } from "../agents/types";
import { createExecutionPolicy } from "../execution/execution-policy";
import type { ExecutionPolicy, StoredExecutionState } from "../execution/types";
import { WorkflowRunner } from "../workflow/workflow-runner";
import type { WorkflowExecutionState } from "../workflow/types";

export interface HookExecutionInput {
  readonly executionId: string;
  readonly executionRoot?: string;
  readonly memoryRoot?: string;
  readonly skillRoots?: readonly string[];
}

export interface FinalizeExecutionInput extends HookExecutionInput {
  readonly output: unknown;
}

export async function validateHookExecution(input: HookExecutionInput): Promise<{ executionId: string; role: string }> {
  const { policy } = await loadExecution(input);
  return { executionId: policy.executionId, role: policy.role };
}

function executionRoot(input: HookExecutionInput): string {
  return input.executionRoot ?? process.env.ALP_EXECUTION_ROOT ?? join(process.env.HOME ?? "", ".alp", "executions");
}

function assertExecutionId(id: string): void {
  if (!/^exec_[a-zA-Z0-9_-]+$/.test(id)) throw new Error("missing or invalid execution ID");
}

async function loadExecution(input: HookExecutionInput): Promise<{
  policy: ExecutionPolicy;
  state: StoredExecutionState;
}> {
  assertExecutionId(input.executionId);
  const directory = join(executionRoot(input), input.executionId);
  const [policy, state] = await Promise.all([
    readFile(join(directory, "policy.json"), "utf8").then((value) => JSON.parse(value) as ExecutionPolicy),
    readFile(join(directory, "state.json"), "utf8").then((value) => JSON.parse(value) as StoredExecutionState),
  ]);
  if (policy.executionId !== input.executionId || state.executionId !== input.executionId) throw new Error("execution ID mismatch");
  if (state.policyHash !== policy.policyHash) throw new Error("execution state policy hash mismatch");
  const definition = agentRegistry.get(policy.role);
  const expected = createExecutionPolicy({
    executionId: policy.executionId,
    definition,
    workspace: policy.workspace,
    workspaceMode: policy.workspaceMode,
    createdAt: policy.createdAt,
  });
  if (JSON.stringify(expected) !== JSON.stringify(policy)) throw new Error("execution policy snapshot is invalid or stale");
  return { policy, state };
}

/** Walk a still-running workflow forward to its terminal state so output can be submitted. */
function advanceToOutput(
  runner: WorkflowRunner,
  definition: AgentDefinition<unknown>,
  state: WorkflowExecutionState,
): WorkflowExecutionState {
  let candidate = state;
  while (candidate.status === "running") {
    const transitions = definition.workflow.states[candidate.currentState].transitions;
    if (transitions.length !== 1) throw new Error(`workflow state \`${candidate.currentState}\` has no unambiguous output path`);
    candidate = runner.transition(definition.workflow, candidate, transitions[0]);
  }
  return candidate;
}

async function persistState(input: HookExecutionInput, state: StoredExecutionState): Promise<void> {
  const file = join(executionRoot(input), input.executionId, "state.json");
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, file);
  await chmod(file, 0o600);
}

export async function finalizeExecution(input: FinalizeExecutionInput): Promise<{ ok: boolean; status: string; issues: readonly string[] }> {
  const { policy, state } = await loadExecution(input);
  const definition = agentRegistry.get(policy.role);
  if (state.workflow.status === "completed") return { ok: true, status: "completed", issues: [] };
  if (state.workflow.status === "failed") return { ok: false, status: "failed", issues: ["output repair budget exhausted"] };
  const runner = new WorkflowRunner();
  const workflow = advanceToOutput(runner, definition, state.workflow);
  const result = runner.submitOutput(workflow, definition.output, input.output);
  await persistState(input, {
    ...state,
    status: result.state.status,
    workflow: result.state,
    ...(result.validation.ok ? { output: result.validation.value ?? input.output } : {}),
  });
  return {
    ok: result.validation.ok,
    status: result.state.status,
    issues: result.validation.ok ? [] : result.validation.issues,
  };
}
