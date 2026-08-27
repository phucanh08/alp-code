import type { RuntimeId } from "../agents/types";
import type { BackendExecutionStatus } from "../backend/execution-backend";

export type DelegationErrorCode =
  | "INVALID_REQUEST"
  | "BACKEND_UNAVAILABLE"
  | "RUNTIME_UNAVAILABLE"
  | "EXECUTION_NOT_FOUND";

export class DelegationError extends Error {
  readonly code: DelegationErrorCode;

  constructor(code: DelegationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DelegationError";
    this.code = code;
  }
}

export interface DelegationExecutionOptions {
  readonly background?: boolean;
  readonly interactive?: boolean;
  readonly timeoutMs?: number | null;
  readonly runtime?: RuntimeId;
}

export interface DelegationRequestInput {
  readonly requestId?: string;
  readonly parentRole: string;
  readonly parentExecutionId?: string | null;
  readonly targetRole: string;
  readonly task: string;
  readonly workspace: string;
  readonly workspaceMode?: "read-only" | "workspace-write";
  readonly metadata?: { readonly backend?: string };
  readonly executionOptions?: DelegationExecutionOptions;
}

export interface DelegationRequest {
  readonly requestId: string;
  readonly parentRole: string;
  readonly parentExecutionId: string | null;
  readonly targetRole: string;
  readonly task: string;
  readonly workspace: string;
  readonly workspaceMode: "read-only" | "workspace-write";
  readonly metadata: { readonly backend?: string };
  readonly executionOptions: Required<Pick<DelegationExecutionOptions, "background" | "interactive">> & {
    readonly timeoutMs: number | null;
    readonly runtime?: RuntimeId;
  };
}

export interface DelegationExecutionRecord {
  readonly executionId: string;
  readonly requestId: string;
  readonly parentExecutionId: string | null;
  readonly parentRole: string;
  readonly targetRole: string;
  readonly workspace: string;
  readonly runtime: RuntimeId;
  readonly backend: string;
  readonly createdAt: string;
  readonly status: BackendExecutionStatus;
  readonly executionStateFile?: string;
  readonly error?: string;
}

export interface DelegationExecutionStore {
  put(record: DelegationExecutionRecord): void;
  get(executionId: string): DelegationExecutionRecord | null;
  update(executionId: string, patch: Partial<Pick<DelegationExecutionRecord, "status" | "error">>): void;
  list(): readonly DelegationExecutionRecord[];
}

export interface DelegationResult {
  readonly executionId: string;
  readonly requestId: string;
  readonly status: BackendExecutionStatus;
  readonly output?: string;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly metadata: Readonly<{ backend: string; runtime: RuntimeId } & Record<string, unknown>>;
}

export interface DelegationIds {
  request(): string;
  execution(): string;
}
