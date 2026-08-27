import type { ReasoningEffort, RuntimeId } from "../agents/types";
import type { PreparedExecution } from "../execution/types";

export interface RuntimeHealth {
  readonly ok: boolean;
  readonly runtime: RuntimeId;
  readonly message: string;
  readonly remediation?: string;
}

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
