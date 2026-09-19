import type { RuntimeId } from "../agents/types";
import type { BackendExecutionStatus } from "../backend/execution-backend";
import type { EvidenceEvaluation, Provenance } from "../execution/evidence";
import type { ExecutionTreeNode, ExecutionTreeView } from "../execution/graph/execution-graph-service";
import type { ExecutionOutcome } from "../execution/outcome";
import type { BudgetStatus, ExecutionBudget, UsageCounters } from "../execution/usage";

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
  /**
   * Trần token / tool call cha *mong* con giữ. Observe-only: đánh giá sau khi con chạy xong
   * (`budgetStatus` trên `wait`), không chặn giữa chừng, không đổi kết cục. Mỗi trần là số
   * nguyên dương, khác thế là `INVALID_REQUEST`. Đi vào fingerprint.
   */
  readonly budget?: ExecutionBudget;
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
  /** Chỉ những trần đã khai, đã kiểm — `null` là không khai. */
  readonly budget: ExecutionBudget | null;
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
   * Kết cục con tự khai qua trailer `Disposition:` của output (master plan 2a) — chỉ có khi
   * execution đã kết thúc. `unknown` khi con không khai, khai sai bảng, hay chết trước khi
   * kịp khai: khác `status: completed` (process đã dừng bình thường) và khác `evidence`
   * (workspace có đổi không). Cha đọc ba thứ này tách nhau.
   */
  readonly outcome?: ExecutionOutcome;
  /**
   * Evidence thu được khi `wait` thấy execution kết thúc — `null` khi execution này không
   * nằm trong cây (legacy) nên không có gì để thu; vắng khi kết quả không phải từ `wait`.
   */
  readonly evidence?: DelegationEvidenceSummary | null;
  /**
   * Cái con đã tốn, như bridge đếm được — `null` khi không đo được. Chỉ có cùng lúc với
   * `evidence` từ `wait` trên một execution trong cây.
   */
  readonly usage?: UsageCounters | null;
  /** So `usage` với `budget` của request: `within` khi không khai budget; `unknown` khi thiếu số để so. Không đổi `status`. */
  readonly budgetStatus?: BudgetStatus;
  readonly metadata: Readonly<{ backend: string; runtime: RuntimeId } & Record<string, unknown>>;
}

/**
 * Một item `change` rút gọn cho `wait --json`: đủ để coordinator biết con *có làm gì không*
 * mà không phải gọi thêm `evidence`. Đường dẫn cụ thể vẫn ở `alp delegation evidence --json`.
 */
export interface DelegationEvidenceChange {
  /** `observed` — chỉ con này có thể đã ghi; `derived` — có thể có node khác góp; `unknown` — không đọc được. */
  readonly provenance: Provenance;
  readonly source: "git" | "history-bridge";
  /** Commit HEAD sau khi con dừng, khác HEAD lúc `materialize`; `null` khi không commit. */
  readonly commit: string | null;
  readonly pathCount: number;
  readonly outsideScopeCount: number;
}

/**
 * Một tool call kết thúc lỗi, rút gọn cho `wait --json` (GitHub #26): cha thấy ngay "npm test
 * fail" mà không phải mở log của backend. Chỉ tool có `isError`; đuôi output nếu bridge ghi.
 */
export interface DelegationEvidenceToolError {
  readonly name: string;
  readonly summary: string;
  readonly tail: string | null;
}

export interface DelegationEvidenceSummary {
  readonly digest: string;
  /**
   * `unevaluated` khi request không có `requiredEvidence` — ALP chưa kiểm gì, không phải "đủ".
   * Trước v0.16 ca này trả `satisfied` và coordinator đọc nhầm thành "đã xong" (GitHub #23).
   */
  readonly evaluation: EvidenceEvaluation;
  /** Những mục đã đòi mà evidence nói rõ là *không* có — rỗng khi không `unsatisfied`. */
  readonly missing: readonly string[];
  /** Item `change` đã thu, mỗi nguồn một dòng; rỗng khi không nguồn nào thấy thay đổi. */
  readonly changes: readonly DelegationEvidenceChange[];
  /** Số tool call bridge thấy trong transcript của con. */
  readonly toolCalls: number;
  /** Tool call kết thúc lỗi, theo thứ tự transcript, tối đa `EVIDENCE_TOOL_ERRORS_MAX`. */
  readonly toolErrors: readonly DelegationEvidenceToolError[];
}

export const EVIDENCE_TOOL_ERRORS_MAX = 5;

export interface DelegationIds {
  request(): string;
  execution(): string;
}

/**
 * Node của cây như `alp delegation tree` trả: node của graph, cộng `outcome` đọc từ
 * `state.json` của chính execution đó. Graph không giữ outcome — nó là lời con tự khai, có
 * ngay khi con dừng, không cần cha `wait` hay thu evidence. `null` khi node chưa dừng;
 * node đã dừng mà không có state là `unknown`.
 */
export type DelegationTreeNode = Omit<ExecutionTreeNode, "children"> & {
  readonly outcome: ExecutionOutcome | null;
  readonly children: readonly DelegationTreeNode[];
};

export type DelegationTreeView = Omit<ExecutionTreeView, "root"> & { readonly root: DelegationTreeNode };
