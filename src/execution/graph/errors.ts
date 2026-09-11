/**
 * Mã lỗi của execution graph.
 *
 * Tách khỏi `DelegationErrorCode` vì chúng trả lời câu khác: delegation nói "yêu cầu này
 * chạy được không", graph nói "cây này còn chỗ / còn quyền / còn hạn không". Một caller đọc
 * `DEPTH_LIMIT_EXCEEDED` biết ngay phải sửa hình dạng cây, còn `INVALID_REQUEST` thì không.
 */
export type ExecutionGraphErrorCode =
  /** Document không thoả invariants — fail đóng, không tự sửa. */
  | "EXECUTION_GRAPH_INVALID"
  | "EXECUTION_GRAPH_NOT_FOUND"
  /** Đọc được file nhưng nội dung không phải graph hợp lệ. */
  | "EXECUTION_GRAPH_CORRUPT"
  | "EXECUTION_GRAPH_LOCK_TIMEOUT"
  /** Ghi mà revision không phải `previous + 1` — dấu hiệu lost update. */
  | "EXECUTION_GRAPH_REVISION_CONFLICT"
  | "EXECUTION_GRAPH_EXISTS"
  | "EXECUTION_NODE_NOT_FOUND"
  | "INVALID_NODE_TRANSITION"
  /** `alp delegate` chạy ngoài một execution do ALP quản. */
  | "PARENT_EXECUTION_REQUIRED"
  | "PARENT_NOT_ACTIVE"
  | "CAPABILITY_INVALID"
  | "DEPTH_LIMIT_EXCEEDED"
  | "CHILD_LIMIT_EXCEEDED"
  | "CONCURRENCY_LIMIT_EXCEEDED"
  | "GRAPH_CONCURRENCY_LIMIT_EXCEEDED"
  | "DELEGATION_LIMIT_EXCEEDED"
  | "WALL_CLOCK_EXCEEDED"
  | "REQUEST_ID_CONFLICT"
  | "REQUEST_IN_PROGRESS"
  | "RESERVATION_NOT_FOUND"
  | "RESERVATION_EXPIRED"
  | "EXECUTION_CANCELLED"
  /** Child khai Thread binding khác node cha — cây không được đổi Thread giữa chừng. */
  | "THREAD_BINDING_MISMATCH";

export class ExecutionGraphError extends Error {
  readonly code: ExecutionGraphErrorCode;
  /** Execution ID đã tồn tại, cho `REQUEST_IN_PROGRESS`: caller thứ hai cần nó để chờ. */
  readonly executionId?: string;

  constructor(
    code: ExecutionGraphErrorCode,
    message: string,
    options: ErrorOptions & { readonly executionId?: string } = {},
  ) {
    super(message, options);
    this.name = "ExecutionGraphError";
    this.code = code;
    if (options.executionId !== undefined) this.executionId = options.executionId;
  }
}

export function isExecutionGraphError(
  error: unknown,
  code?: ExecutionGraphErrorCode,
): error is ExecutionGraphError {
  return error instanceof ExecutionGraphError && (code === undefined || error.code === code);
}
