/**
 * Mã lỗi của Thread.
 *
 * Tách khỏi `ExecutionGraphErrorCode` vì chúng trả lời câu khác: graph nói "cây này còn
 * chỗ / còn quyền không", Thread nói "công việc này còn nhận việc mới không, và bản ghi của
 * nó còn tin được không".
 */
export type ThreadErrorCode =
  | "THREAD_NOT_FOUND"
  | "THREAD_EXISTS"
  /** Đọc được file nhưng không phải Thread hợp lệ — fail đóng, không tự tạo lại. */
  | "THREAD_STORE_CORRUPT"
  /** Ghi mà revision không phải `previous + 1` — dấu hiệu lost update. */
  | "THREAD_REVISION_CONFLICT"
  /** Document hoặc một lần ghi không thoả invariants. */
  | "THREAD_INVARIANT_VIOLATION"
  /** Thread `archived` chỉ nhận đổi `title`. */
  | "THREAD_ARCHIVED"
  /** Thread `closed` không nhận execution mới. */
  | "THREAD_CLOSED"
  | "THREAD_LOCK_TIMEOUT"
  /** Đã có một root execution chưa settled; `continue` phải chờ hoặc reconcile. */
  | "THREAD_BUSY"
  /** Binding trong policy không khớp Thread mà nó nói là thuộc về. */
  | "THREAD_EXECUTION_BINDING_MISMATCH"
  /** Snapshot context trên đĩa không khớp digest index ghi. */
  | "THREAD_CONTEXT_TAMPERED";

export class ThreadError extends Error {
  readonly code: ThreadErrorCode;
  /** Execution đang giữ Thread, cho `THREAD_BUSY`: caller cần nó để status/cancel. */
  readonly executionId?: string;

  constructor(
    code: ThreadErrorCode,
    message: string,
    options: ErrorOptions & { readonly executionId?: string } = {},
  ) {
    super(message, options);
    this.name = "ThreadError";
    this.code = code;
    if (options.executionId !== undefined) this.executionId = options.executionId;
  }
}

export function isThreadError(error: unknown, code?: ThreadErrorCode): error is ThreadError {
  return error instanceof ThreadError && (code === undefined || error.code === code);
}
