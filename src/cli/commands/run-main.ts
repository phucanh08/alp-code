import type { AgentDefinition, AgentRegistry, RuntimeId } from "../../agents/types";
import { readFile } from "node:fs/promises";
import type { BackendExecutionResult, ExecutionBackend } from "../../backend/execution-backend";
import type { ExecutionService } from "../../execution/execution-service";
import type { RuntimeAdapter } from "../../runtime/runtime-adapter";
import type { RuntimeSelector } from "../../runtime/runtime-selector";

export interface RunMainInput {
  readonly cwd: string;
  readonly requestedRuntime?: RuntimeId;
}

export interface RunMainDependencies {
  readonly registry: Pick<AgentRegistry, "get">;
  readonly selector: Pick<RuntimeSelector, "select">;
  readonly executionService: Pick<ExecutionService, "prepare">;
  readonly adapters: ReadonlyMap<RuntimeId, RuntimeAdapter>;
  readonly backend: ExecutionBackend;
  readonly executionId: () => string;
  readonly interactive: boolean;
  readonly workspaceModeFor?: (cwd: string) => Promise<"read-only" | "workspace-write">;
}

export async function runMainSession(
  input: RunMainInput,
  dependencies: RunMainDependencies,
): Promise<BackendExecutionResult> {
  const definition = dependencies.registry.get("main") as AgentDefinition<unknown>;
  if (definition.reportsTo !== "principal") throw new Error("main must report to principal");
  const selection = await dependencies.selector.select({
    requestedRuntime: input.requestedRuntime,
    interactive: dependencies.interactive && input.requestedRuntime === undefined,
  });
  if (!selection.ok) return { executionId: "cancelled", status: "cancelled" };
  const executionId = dependencies.executionId();
  const workspaceMode = dependencies.workspaceModeFor
    ? await dependencies.workspaceModeFor(input.cwd)
    : "read-only";
  const execution = await dependencies.executionService.prepare({
    executionId,
    parent: "principal",
    target: definition.id,
    task: "Principal-facing main session",
    workspace: input.cwd,
    workspaceMode,
    memoryQueries: [],
    characterBudget: 0,
    invariantContext: "ALP execution policy is authoritative and fails closed.",
    policyContext: "Direct raw runtime launch is unsupported; use ALP workflows.",
  });
  const adapter = dependencies.adapters.get(selection.runtime);
  if (!adapter) throw new Error(`runtime \`${selection.runtime}\` is not registered`);
  const health = await adapter.probe();
  if (!health.ok) throw new Error(`${health.message}${health.remediation ? `; ${health.remediation}` : ""}`);
  const launchSpec = await adapter.prepare({
    execution,
    model: definition.model[selection.runtime],
    reasoningEffort: definition.reasoningEffort[selection.runtime],
    interactive: true,
  });
  const spawned = await dependencies.backend.spawn({ executionId, launchSpec });
  const backendResult = spawned.status === "running" ? await dependencies.backend.wait(executionId) : spawned;
  const stateFile = execution.artifacts?.stateFile;
  if (!stateFile || !["completed", "failed", "cancelled"].includes(backendResult.status)) return backendResult;
  try {
    const state = JSON.parse(await readFile(stateFile, "utf8")) as { status?: unknown; output?: unknown };
    const status = ["completed", "failed", "cancelled"].includes(String(state.status))
      ? state.status as BackendExecutionResult["status"]
      : backendResult.status;
    return {
      ...backendResult,
      status,
      ...(state.output === undefined ? {} : { output: JSON.stringify(state.output) }),
    };
  } catch { return backendResult; }
}
