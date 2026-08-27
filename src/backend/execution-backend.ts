import type { RuntimeLaunchSpec } from "../runtime/runtime-adapter";

export type BackendExecutionStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface BackendExecutionResult {
  readonly executionId: string;
  readonly status: BackendExecutionStatus;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly output?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SpawnExecutionInput {
  readonly executionId: string;
  readonly launchSpec: RuntimeLaunchSpec;
  readonly lifecycle?: {
    readonly requestId: string;
    readonly parentExecutionId: string | null;
    readonly background: boolean;
    readonly interactive: boolean;
    readonly timeoutMs: number | null;
  };
}

export interface ExecutionBackend {
  readonly name: string;
  healthCheck(): Promise<{ readonly ok: boolean; readonly message: string }>;
  spawn(input: SpawnExecutionInput): Promise<BackendExecutionResult>;
  status(executionId: string): Promise<BackendExecutionResult>;
  wait(executionId: string, options?: { readonly timeoutMs?: number | null }): Promise<BackendExecutionResult>;
  cancel(executionId: string, signal?: NodeJS.Signals): Promise<BackendExecutionResult>;
  cleanup(executionId: string): Promise<void>;
}
