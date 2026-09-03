import type { RuntimeLaunchSpec } from "../runtime/runtime-adapter";

export type BackendExecutionStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface BackendExecutionResult {
  readonly executionId: string;
  readonly status: BackendExecutionStatus;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly output?: string;
  /**
   * Why a `failed` execution failed. Backends produced this long before the type admitted
   * it, and the omission was load-bearing: `DelegationService` could not copy a field it did
   * not know about, so every failure reached the caller as a bare `failed` with the reason
   * discarded — including one that names the exact grant to fix.
   */
  readonly error?: Readonly<{ code: string; message: string }>;
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
