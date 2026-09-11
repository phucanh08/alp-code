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
  /**
   * `terminationReason: "deadline"` marks a `cancelled` result the wall clock produced rather
   * than a person. Both arrive as `cancelled` — the process was signalled either way — and
   * without this the tree cannot tell an expired run from one the principal stopped.
   */
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
    /** How long *this caller* waits. Nothing to do with how long the execution may live. */
    readonly timeoutMs: number | null;
    /**
     * The absolute instant this execution must be dead by, inherited unchanged from the root
     * of its tree.
     *
     * A duration would restart at every hop: a two-hour budget spent by a root, then handed
     * to a child as "two hours", is a tree that outlives its own deadline once per level.
     * A timestamp cannot be spent, so every process in the tree dies at the same moment no
     * matter who spawned it or when.
     */
    readonly deadlineAt: string | null;
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
