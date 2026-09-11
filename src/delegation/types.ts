import type { RuntimeId } from "../agents/types";
import type { BackendExecutionStatus } from "../backend/execution-backend";

export type DelegationErrorCode =
  | "INVALID_REQUEST"
  | "BACKEND_UNAVAILABLE"
  | "RUNTIME_UNAVAILABLE"
  | "EXECUTION_NOT_FOUND"
  /**
   * A wait gave up before the execution finished. A background execution is deliberately
   * left running; a caller who wants it stopped has `cancel`. Distinct from `failed` because
   * nothing is known to have gone wrong yet.
   */
  | "EXECUTION_TIMEOUT"
  /**
   * Execution vượt quá tuổi thọ tuyệt đối của cây nó thuộc về.
   *
   * Khác `EXECUTION_TIMEOUT`: cái kia nói caller thôi chờ, cái này nói execution phải chết.
   * Graph có cùng mã cho cùng chuyện; backend giữ mã riêng vì nó là tầng dưới và không
   * được biết tới graph.
   */
  | "WALL_CLOCK_EXCEEDED";

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
}

/**
 * Một yêu cầu giao việc, đúng như caller viết ra.
 *
 * Không có `parentRole`, cũng không có `parentExecutionId`: cha là ai được đọc từ cây sau khi
 * capability thừa hưởng qua env được kiểm, chứ không phải từ một trường mà bất kỳ ai gọi
 * cũng điền được. `ALP_ROLE=main alp delegate ...` từng là toàn bộ chi phí để leo thang
 * quyền; giờ nó không còn là một câu có nghĩa.
 */
export interface DelegationRequestInput {
  readonly requestId?: string;
  readonly targetRole: string;
  readonly task: string;
  readonly workspace: string;
  readonly workspaceMode?: "read-only" | "workspace-write";
  /** Đi vào fingerprint của request, nên hai lần gọi khác metadata là hai việc khác nhau. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly executionOptions?: DelegationExecutionOptions;
}

export interface DelegationRequest {
  readonly requestId: string;
  readonly targetRole: string;
  readonly task: string;
  readonly workspace: string;
  readonly workspaceMode: "read-only" | "workspace-write";
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly executionOptions: Required<Pick<DelegationExecutionOptions, "background" | "interactive">> & {
    readonly timeoutMs: number | null;
  };
}

/**
 * Hình dạng của legacy store trên đĩa.
 *
 * Execution do graph quản không sinh bản ghi ở đây nữa — cây là nơi giữ sự thật. Kiểu này
 * còn sống vì những execution mở bằng bản cũ vẫn nằm trên đĩa, và `alp delegation status`
 * phải trả lời được về chúng cho tới khi chúng kết thúc.
 */
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
  /** Why a `failed` execution failed, carried through from the backend. */
  readonly error?: Readonly<{ code: string; message: string }>;
  readonly metadata: Readonly<{ backend: string; runtime: RuntimeId } & Record<string, unknown>>;
}

export interface DelegationIds {
  request(): string;
  execution(): string;
}
