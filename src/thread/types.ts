import { createHash, randomUUID } from "node:crypto";
import type { AgentId } from "../agents/types";
import type { ExecutionId } from "../execution/types";
import type { ThreadExecutionHistory } from "./history-types";

/**
 * Thread — unit of work bền vững, nằm **trên** Execution.
 *
 * Một Thread sống qua nhiều Execution, nhiều Runtime, nhiều Process. Nó trả lời "công việc
 * này là gì, đã chạy bao nhiêu lần, context hiện tại là gì, lần chạy tiếp theo tiếp tục từ
 * đâu" — và **không** trả lời "lần chạy này được phép làm gì". Câu sau vẫn là của
 * `ExecutionPolicy`: PolicyEngine không đọc Thread, và không field nào ở đây cấp quyền.
 */
export type ThreadId = string;

/** ID do ALP sinh, opaque. Regex này chạy **trước** mọi lần ghép path từ ID người dùng nhập. */
export const THREAD_ID_PATTERN = /^thread_[A-Za-z0-9]+$/;

export function generateThreadId(): ThreadId {
  return `thread_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

export type ThreadStatus = "open" | "closed" | "archived";

export const THREAD_STATUSES: readonly ThreadStatus[] = ["open", "closed", "archived"];

export type ThreadExecutionOutcome = "completed" | "failed" | "cancelled" | "interrupted";

export const THREAD_EXECUTION_OUTCOMES: readonly ThreadExecutionOutcome[] = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
];

/** Revision context của một Thread chưa có snapshot nào. */
export const EMPTY_THREAD_CONTEXT_REVISION = 0;

/**
 * Digest của "chưa có context".
 *
 * Root execution #1 vẫn phải bind vào một Thread có `contextRevision = 0` và hash được,
 * nên "rỗng" cần một digest cố định thay vì `null` — `null` không đi qua policy hash được
 * mà không thêm một nhánh đặc biệt cho đúng một trường hợp.
 */
export const EMPTY_THREAD_CONTEXT_DIGEST = createHash("sha256")
  .update("alp-thread-context-v1:empty")
  .digest("hex");

/** Trần cho `title` — field mềm duy nhất, và cũng là thứ duy nhất người dùng gõ vào. */
export const THREAD_TITLE_MAX_CHARS = 200;

/** Trỏ tới `context/<rev>.json`, snapshot bất biến của một revision context. */
export interface ThreadContextRef {
  readonly revision: number;
  readonly digest: string;
  /** Path tương đối trong `threads/<id>/`, ví dụ `context/3.json`. */
  readonly artifact: string;
}

/** Trỏ tới `messages/<seq>.json` — một `ThreadEntry` bất biến, đã redact. */
export interface ThreadMessageRef {
  readonly id: string;
  readonly sequence: number;
  readonly executionId: ExecutionId;
  readonly kind: string;
  readonly artifact: string;
  readonly digest: string;
  readonly createdAt: string;
}

/** Trỏ tới `compactions/<id>.json` — một lần context bị cắt để giữ trong trần. */
export interface ThreadCompactionRef {
  readonly id: string;
  readonly fromRevision: number;
  readonly toRevision: number;
  readonly droppedCount: number;
  /** Khoảng `messages[].sequence` mà lần cắt này tóm. Vắng ở record P2. */
  readonly fromMessageSequence?: number;
  readonly toMessageSequence?: number;
  readonly artifact: string;
  readonly createdAt: string;
}

/**
 * Một root execution của Thread.
 *
 * Không có `status`: graph root node đã là truth của `preparing/running/terminal`. Thread giữ
 * thêm một bản là hai nguồn truth cho một lifecycle — reconcile phải viết hai lần và cửa sổ
 * crash nhân đôi. Ref chỉ đi `reserved → settled`, và `ThreadActivity` là view tính ra từ
 * ref + graph, không phải field lưu.
 */
export interface ThreadExecutionRef {
  readonly executionId: ExecutionId;
  /** 1, 2, 3… liên tục, không trùng, không lùi. */
  readonly sequence: number;
  /** Revision context Thread lúc reserve — đúng bản mà execution này nhìn thấy. */
  readonly contextRevision: number;
  readonly contextDigest: string;
  readonly reservedAt: string;
  readonly settled: ThreadExecutionSettlement | null;
  /**
   * Mirror transcript của root này (P4). Không thuộc write-once `reserved → settled`: đây là
   * trạng thái của bản sao, đơn điệu (cursor chỉ tiến), và `alp thread sync` cập nhật nó
   * được bao nhiêu lần tùy. Vắng (document cũ) ≡ `null` = chưa collect.
   */
  readonly history?: ThreadExecutionHistory | null;
}

export interface ThreadExecutionSettlement {
  readonly outcome: ThreadExecutionOutcome;
  readonly finishedAt: string;
  /** `null` = projection context sau execution này còn pending. */
  readonly nextContextRevision: number | null;
}

export interface ThreadDocumentV1 {
  readonly version: 1;
  readonly id: ThreadId;
  readonly agentId: AgentId;
  /** Canonical path lúc tạo. Provenance/filter cho `list`; policy vẫn tự canonicalize per execution. */
  readonly workspace: string;
  /** Lineage fork/handoff. Chỉ provenance — không cấp quyền, không kế thừa gì. */
  readonly parentThreadId: ThreadId | null;
  /** Field mềm duy nhất: đổi được ở mọi status, kể cả `archived`. */
  readonly title: string | null;
  readonly status: ThreadStatus;
  readonly revision: number;
  readonly currentContext: ThreadContextRef | null;
  readonly messages: readonly ThreadMessageRef[];
  readonly compactions: readonly ThreadCompactionRef[];
  readonly executions: readonly ThreadExecutionRef[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** View tính ra, không lưu: ref chưa settled + graph nói gì về root của nó. */
export type ThreadActivity =
  | { readonly kind: "idle" }
  | { readonly kind: "running"; readonly executionId: ExecutionId }
  /** Ref chưa settled nhưng graph đã terminal hoặc không có — cần reconcile. */
  | { readonly kind: "unsettled"; readonly executionId: ExecutionId };

/** Đủ để `alp thread list` in một dòng mà không đọc payload nào. */
export interface ThreadSummary {
  readonly id: ThreadId;
  readonly agentId: AgentId;
  readonly workspace: string;
  readonly parentThreadId: ThreadId | null;
  readonly title: string | null;
  readonly status: ThreadStatus;
  readonly revision: number;
  readonly contextRevision: number;
  readonly executionCount: number;
  readonly unsettledExecutionId: ExecutionId | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateThreadInput {
  /** Bỏ trống thì store sinh. Có thì phải khớp `THREAD_ID_PATTERN`. */
  readonly id?: ThreadId;
  readonly agentId: AgentId;
  readonly workspace: string;
  readonly parentThreadId?: ThreadId | null;
  readonly title?: string | null;
  readonly createdAt?: string;
}

export interface ThreadListQuery {
  readonly workspace?: string;
  readonly status?: ThreadStatus;
}

/** Ref chưa settled của Thread, nếu có — tối đa một (invariant 4). */
export function unsettledExecution(thread: ThreadDocumentV1): ThreadExecutionRef | null {
  return thread.executions.find((ref) => ref.settled === null) ?? null;
}

export function summarizeThread(thread: ThreadDocumentV1): ThreadSummary {
  return {
    id: thread.id,
    agentId: thread.agentId,
    workspace: thread.workspace,
    parentThreadId: thread.parentThreadId,
    title: thread.title,
    status: thread.status,
    revision: thread.revision,
    contextRevision: thread.currentContext?.revision ?? EMPTY_THREAD_CONTEXT_REVISION,
    executionCount: thread.executions.length,
    unsettledExecutionId: unsettledExecution(thread)?.executionId ?? null,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}
