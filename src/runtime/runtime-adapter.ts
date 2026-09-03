import type { ReasoningEffort, RuntimeId } from "../agents/types";
import type { PreparedExecution } from "../execution/types";

export interface RuntimeHealth {
  readonly ok: boolean;
  readonly runtime: RuntimeId;
  readonly message: string;
  readonly remediation?: string;
}

/**
 * A launch ALP can exec directly. The runtime's own CLI is the whole interface: the task,
 * the model pin and the permission mode all travel inside `args`, so nothing about the
 * execution depends on a backend re-deriving them.
 *
 * This carried a second, declarative `intent` form until 2026-09-03, for a backend that
 * spawned the runtime itself and could not exec `command`. Both adapters had to keep the
 * two spellings of one launch in agreement, and only the exec form was ever enforced —
 * a permission mode set in `args` was real, the same mode in `intent` was a request. That
 * backend is gone; one spelling means the mode a role runs under cannot drift from the
 * mode its policy asked for.
 */
export interface RuntimeLaunchSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly temporaryFiles: readonly string[];
}

export interface PrepareRuntimeInput {
  readonly execution: PreparedExecution;
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly interactive: boolean;
}

export interface RuntimeAdapter {
  readonly name: RuntimeId;
  probe(): Promise<RuntimeHealth>;
  prepare(input: PrepareRuntimeInput): Promise<RuntimeLaunchSpec>;
}
