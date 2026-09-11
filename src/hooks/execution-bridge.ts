import { randomUUID } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadProjectAgents } from "../agents/loader";
import { agentRegistry } from "../agents/registry";
import type { AgentDefinition } from "../agents/types";
import { loadModeProfiles } from "../cli/settings";
import { createExecutionPolicy, hashAgentDefinition } from "../execution/execution-policy";
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

/**
 * The definition this execution actually ran with.
 *
 * The shipped registry is not enough any more: a custom agent's role exists only in its
 * project, so `agentRegistry.get("echo")` threw and the Stop hook — which catches everything
 * and reports it as a note — left the execution at `prepared` with its output contract never
 * enforced. Found by the first live run; tiers 1–3 stop before the spawn, so no amount of them
 * could have caught it.
 *
 * Resolved **by hash**, not by trust: trust can be revoked between launch and Stop, and the
 * execution that is finishing ran with the definition it ran with. A hash that no longer
 * matches anything on disk is a definition that changed mid-flight, which is worth failing on.
 */
async function definitionFor(policy: ExecutionPolicy): Promise<AgentDefinition<unknown>> {
  if (agentRegistry.has(policy.role)) return agentRegistry.get(policy.role);
  const load = await loadProjectAgents({ projectRoot: policy.workspace });
  const match = [...load.loaded, ...load.overlays].find((agent) =>
    agent.id === policy.role && hashAgentDefinition(agent.definition) === policy.definitionHash);
  if (match === undefined) {
    throw new Error(`no definition for \`${policy.role}\` matching the hash this execution ran with`);
  }
  return match.definition;
}

async function loadExecution(input: HookExecutionInput): Promise<{
  policy: ExecutionPolicy;
  definition: AgentDefinition<unknown>;
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
  const definition = await definitionFor(policy);
  // Same gap as `mode` before it (see below): left out, this re-derivation always assumed the
  // built-in loadout, so every execution launched under a project/machine `settings.json`
  // override — the very thing #16 shipped — failed the tamper check on its Stop hook.
  const { profiles: modeProfiles } = await loadModeProfiles({ cwd: policy.workspace });
  const expected = createExecutionPolicy({
    executionId: policy.executionId,
    definition,
    workspace: policy.workspace,
    workspaceMode: policy.workspaceMode,
    // Carried, not defaulted. Left out, this re-derivation always assumed `medium`, so every
    // execution launched on any other nấc failed the tamper check and its Stop hook quietly
    // gave up — the eight built-in roles included. Found by the first live run.
    mode: policy.mode,
    modeProfiles,
    createdAt: policy.createdAt,
  });
  if (JSON.stringify(expected) !== JSON.stringify(policy)) throw new Error("execution policy snapshot is invalid or stale");
  return { policy, definition, state };
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
  const { policy, definition, state } = await loadExecution(input);
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
