import type { ReasoningEffort, RuntimeId } from "../agents/types";
import type { PreparedExecution } from "../execution/types";

export interface RuntimeHealth {
  readonly ok: boolean;
  readonly runtime: RuntimeId;
  readonly message: string;
  readonly remediation?: string;
}

/**
 * The same launch expressed declaratively, for a backend that cannot run `command`/`args`.
 *
 * `paseo run` takes a prompt and spawns the runtime process itself — its CLI is
 * `run [options] <prompt>` with no exec passthrough. Handing it `-- claude --settings …`
 * made its parser read `claude` as the prompt and discard the rest, so the task, the model
 * pin and the permission mode never arrived and every delegated agent woke up with no work
 * and the backend's own defaults. These three fields are what such a backend has to
 * reproduce; a backend that can exec `command` directly ignores them.
 */
export interface RuntimeLaunchIntent {
  /** First turn for the agent, or null for an interactive launch, which must not spend one. */
  readonly prompt: string | null;
  /** Model to pin, so a backend cannot quietly substitute its own default. */
  readonly model: string;
  /** Permission mode in the runtime's own vocabulary — `plan`/`bypass` on Claude, `auto` on Codex. */
  readonly mode: string;
}

export interface RuntimeLaunchSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly temporaryFiles: readonly string[];
  readonly intent: RuntimeLaunchIntent;
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
