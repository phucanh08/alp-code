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
  /**
   * Các cây con trong workspace mà con được ghi — tương đối so với workspace hoặc tuyệt đối.
   * Chỉ có nghĩa với `workspace-write`; bỏ trống là cả workspace. Danh sách rỗng hoặc phần
   * tử trống là `INVALID_REQUEST`.
   */
  readonly writeScope?: readonly string[];
  /**
   * Bằng chứng cha đòi khi con kết thúc: `change` (work tree đã đổi) hoặc `verify:<id>` (một
   * lệnh verify của project đã chạy và thoát 0). Khác thế là `INVALID_REQUEST`. Đi vào
   * fingerprint và bất biến trên node — đòi thêm sau khi giao là một việc khác.
   */
  readonly requiredEvidence?: readonly string[];
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
  /** Đã trim, sort, bỏ trùng — `null` là cả workspace. */
  readonly writeScope: readonly string[] | null;
  /** Đã trim, sort, bỏ trùng — rỗng là không đòi gì. */
  readonly requiredEvidence: readonly string[];
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
  /** Scope ghi đã ký trong `policy.json` — `null` là cả workspace; vắng ở bản ghi legacy. */
  readonly writeScope?: readonly string[] | null;
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
  /** The write scope in the execution's signed policy — `null` for the whole workspace; absent for a legacy record. */
  readonly writeScope?: readonly string[] | null;
  /**
   * Evidence thu được khi `wait` thấy execution kết thúc — `null` khi execution này không
   * nằm trong cây (legacy) nên không có gì để thu; vắng khi kết quả không phải từ `wait`.
   */
  readonly evidence?: DelegationEvidenceSummary | null;
  readonly metadata: Readonly<{ backend: string; runtime: RuntimeId } & Record<string, unknown>>;
}

export interface DelegationEvidenceSummary {
  readonly digest: string;
  readonly evaluation: "satisfied" | "unsatisfied" | "unknown";
  /** Những mục đã đòi mà evidence nói rõ là *không* có — rỗng khi `satisfied` hoặc `unknown`. */
  readonly missing: readonly string[];
}

export interface DelegationIds {
  request(): string;
  execution(): string;
}
