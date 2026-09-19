import type { RuntimeId } from "../agents/types";
import type { ExecutionId } from "../execution/types";
import type { UsageCounters } from "../execution/usage";
import type { ThreadExecutionOutcome } from "./types";

/**
 * History của Thread là **mirror** từ transcript runtime-owned, và mirror phải nói nó thiếu gì.
 *
 * - `complete`: transcript đọc được, format khớp version pin, không dòng nào bị bỏ vì lạ.
 * - `partial`: đọc được nhưng version lệch pin, hoặc có dòng không parse được — những gì có
 *   là thật, nhưng có thể thiếu.
 * - `final-only`: không đọc được transcript (thiếu con trỏ, path ngoài state dir, ENOENT) —
 *   chỉ còn boundary + kết cục đã có trong `state.json`.
 * - `unsupported`: runtime không có bridge.
 */
export type HistoryCompleteness = "complete" | "partial" | "final-only" | "unsupported";

export const HISTORY_COMPLETENESS: readonly HistoryCompleteness[] = ["complete", "partial", "final-only", "unsupported"];

/** Xếp theo "tệ hơn": `show` in cái tệ nhất của Thread. */
export function worseCompleteness(a: HistoryCompleteness, b: HistoryCompleteness): HistoryCompleteness {
  return HISTORY_COMPLETENESS.indexOf(a) >= HISTORY_COMPLETENESS.indexOf(b) ? a : b;
}

/**
 * Vị trí đã đọc tới trong transcript. `transcriptPath` là canonical path đã qua kiểm state
 * dir; đổi path = transcript khác = đọc lại từ 0. `lastNativeId` là ID native của entry cuối
 * cùng đã lấy — chốt chặn thứ hai chống đọc trùng khi file bị ghi lại.
 */
export interface RuntimeHistoryCursor {
  readonly transcriptPath: string;
  readonly lineOffset: number;
  readonly lastNativeId: string | null;
}

interface ThreadEntryBase {
  readonly version: 1;
  readonly executionId: ExecutionId;
  /** ID runtime đặt (uuid Claude, `msg_…`/`call_…` Codex); `null` khi runtime không đặt. */
  readonly nativeId: string | null;
  readonly createdAt: string;
}

/** Canonical text sau redaction — không env dump, không context ALP tiêm. */
export interface ThreadUserMessage extends ThreadEntryBase {
  readonly kind: "user";
  readonly text: string;
}

export interface ThreadAssistantMessage extends ThreadEntryBase {
  readonly kind: "assistant";
  readonly text: string;
}

/**
 * Những gì giữ lại của một tool result: digest của toàn bộ text (sau redaction) để đối chiếu,
 * kích thước, và **đuôi** — phần cuối là chỗ `npm test` nói pass/fail, nên đuôi giữ lại chứ
 * không phải đầu. Raw output không đi xa hơn hàm dựng ra nó.
 */
export interface ThreadToolResultRef {
  readonly digest: string;
  readonly bytes: number;
  readonly tail: string;
}

/** Tên + thứ tự + summary đã redact + đuôi result đã redact. Raw args/output **không** copy. */
export interface ThreadToolCallRef extends ThreadEntryBase {
  readonly kind: "tool";
  readonly name: string;
  readonly callId: string | null;
  readonly summary: string;
  readonly isError: boolean;
  /**
   * Result của call này, khi transcript có nó trong cùng lát đọc (GitHub #26). Vắng mặt ở
   * entry ghi trước khi có trường này, khi result chưa tới, hay khi runtime không ghi result.
   */
  readonly result?: ThreadToolResultRef;
  /** Ref tới artifact của execution nếu có (P4 chưa ghi — luôn `null`). */
  readonly artifact: string | null;
}

/** Một lần sửa workspace, suy ra từ tool call ghi file. Diff không vào `thread.json`. */
export interface ThreadChangeRef extends ThreadEntryBase {
  readonly kind: "change";
  readonly workspace: string;
  readonly paths: readonly string[];
  readonly commit: string | null;
  readonly artifact: string | null;
}

/** Ranh giới một root execution: ghi một lần lúc settle, nói rõ mirror của nó đủ tới đâu. */
export interface ThreadExecutionBoundary extends ThreadEntryBase {
  readonly kind: "boundary";
  readonly sequence: number;
  readonly outcome: ThreadExecutionOutcome;
  readonly runtime: RuntimeId | null;
  readonly historyCompleteness: HistoryCompleteness;
  readonly pinnedVersion: string | null;
  /** Số entry đã mirror / số dòng bỏ qua vì không parse được. */
  readonly collected: number;
  readonly skipped: number;
  /**
   * Root này đã giao bao nhiêu việc và cha đã nói gì về chúng (P4), đếm từ cây lúc settle.
   * Vắng mặt ở boundary ghi trước P4 và ở execution không có cây.
   */
  readonly delegations?: {
    readonly accepted: number;
    readonly rejected: number;
    readonly cancelled: number;
    readonly undecided: number;
  };
  /** Token / tool call root này đã dùng tới lúc boundary được ghi (P6). Vắng mặt khi chưa lát nào có số. */
  readonly usage?: UsageCounters;
}

export type ThreadEntry =
  | ThreadUserMessage
  | ThreadAssistantMessage
  | ThreadToolCallRef
  | ThreadChangeRef
  | ThreadExecutionBoundary;

export type ThreadEntryKind = ThreadEntry["kind"];

export const THREAD_ENTRY_KINDS: readonly ThreadEntryKind[] = ["user", "assistant", "tool", "change", "boundary"];

/** Entry bridge trả về — chưa gắn `executionId`/`version`, bridge không cần biết Thread. */
export type CollectedEntry =
  | Omit<ThreadUserMessage, "version" | "executionId">
  | Omit<ThreadAssistantMessage, "version" | "executionId">
  | Omit<ThreadToolCallRef, "version" | "executionId">
  | Omit<ThreadChangeRef, "version" | "executionId">;

export interface HistoryDelta {
  readonly entries: readonly CollectedEntry[];
  readonly cursor: RuntimeHistoryCursor | null;
  readonly completeness: HistoryCompleteness;
  readonly pinnedVersion: string | null;
  /** Dòng bỏ qua trong lần đọc này (lạ / hỏng). */
  readonly skipped: number;
  /**
   * Token / tool call của riêng lát này (P6). `null` = không có số mới: transcript không đọc
   * được, runtime không có bridge, hay không có dòng mới. Một cột `null` bên trong = có dòng
   * mới nhưng cột đó không đọc được. Vắng mặt (bridge cũ) ≡ `null`.
   */
  readonly usageDelta?: UsageCounters | null;
}

/**
 * Trạng thái mirror của một root, lưu trên `ThreadExecutionRef.history`. Đơn điệu: `cursor`
 * chỉ tiến, `entryCount` chỉ tăng; `completeness` là của lần collect gần nhất.
 */
export interface ThreadExecutionHistory {
  readonly completeness: HistoryCompleteness;
  readonly pinnedVersion: string | null;
  readonly cursor: RuntimeHistoryCursor | null;
  readonly entryCount: number;
  readonly skipped: number;
  readonly collectedAt: string;
  /** Cộng dồn `usageDelta` của mọi lần collect (P6); vắng mặt ở ref ghi trước P6, `null` khi chưa có lát nào có số. */
  readonly usage?: UsageCounters | null;
}

/** Trần text một entry giữ lại sau redaction — phần còn lại cắt, không copy. */
export const HISTORY_TEXT_MAX_BYTES = 16 * 1024;
/** Trần summary của tool call. */
export const HISTORY_TOOL_SUMMARY_MAX_BYTES = 512;
/** Trần đuôi của tool result giữ lại trong `ThreadToolResultRef.tail`. */
export const HISTORY_TOOL_RESULT_TAIL_MAX_BYTES = 2 * 1024;
