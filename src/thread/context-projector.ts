import type { RuntimeId } from "../agents/types";
import type { ContinuityCheckpointV1 } from "../context/types";
import type { ExecutionId } from "../execution/types";
import {
  CONTEXT_PIN_SECTIONS,
  THREAD_CONTEXT_MAX_BYTES,
  THREAD_SEED_PIN_SOURCE,
  threadContextBytes,
  threadContextDigest,
  type ContextLine,
  type ContextPinSection,
  type ThreadContextOutcome,
  type ThreadContextSnapshotV1,
} from "./context-types";
import type { ThreadExecutionOutcome, ThreadId } from "./types";

export interface ProjectedExecution {
  readonly executionId: ExecutionId;
  readonly sequence: number;
  readonly outcome: ThreadExecutionOutcome;
  readonly runtime: RuntimeId | null;
  readonly finishedAt: string;
}

export interface ProjectContextInput {
  readonly threadId: ThreadId;
  /** Snapshot rev N — `null` khi E-n chạy trên revision 0. */
  readonly previous: ThreadContextSnapshotV1 | null;
  /** `title` hiện tại của Thread: nguồn duy nhất của `objective`. */
  readonly title: string | null;
  readonly execution: ProjectedExecution;
  /**
   * Checkpoint của E-n, **đã verify integrity** bởi caller. `null` = không có hoặc không tin
   * được → chỉ outcome được chiếu, snapshot đánh `degraded`.
   */
  readonly checkpoint: ContinuityCheckpointV1 | null;
  readonly createdAt: string;
  /** Trần bytes; mặc định `THREAD_CONTEXT_MAX_BYTES`. Chỉ test đổi. */
  readonly maxBytes?: number;
}

export interface ContextCompaction {
  readonly fromRevision: number;
  readonly toRevision: number;
  readonly droppedCount: number;
}

export interface ProjectContextResult {
  readonly snapshot: ThreadContextSnapshotV1;
  /** `null` khi không phải cắt gì. */
  readonly compaction: ContextCompaction | null;
}

/** Số outcome tối thiểu còn lại sau khi cắt — đủ để đọc "ba lần gần nhất kết thúc thế nào". */
export const MIN_RETAINED_OUTCOMES = 3;

/**
 * `(rev N, checkpoint E-n, outcome E-n) → rev N+1`. Thuần, tất định, không model:
 *
 * - promote: `title` → objective; pins E-n ghi thêm (không phải pin seed từ Thread — chúng
 *   đã ở rev N); kết cục E-n.
 * - không promote: bất kỳ thứ gì về quyền — không có đường nào từ input này vào policy.
 * - outcome không phải `completed`: pins vẫn promote (là quyết định đã ghi), và `nextActions`
 *   nhận thêm một dòng nói rõ E-n kết thúc ra sao — không có gì đánh dấu nó thành công.
 * - vượt trần: cắt theo thứ tự cố định, ghi số dòng đã rơi.
 */
export function projectThreadContext(input: ProjectContextInput): ProjectContextResult {
  const { previous, execution } = input;
  const fromRevision = previous?.revision ?? 0;
  const revision = fromRevision + 1;
  const sections = Object.fromEntries(CONTEXT_PIN_SECTIONS.map((section) => [
    section,
    mergeLines(previous?.[section] ?? [], promotedPins(input.checkpoint, section, execution.executionId)),
  ])) as Record<ContextPinSection, ContextLine[]>;
  if (execution.outcome !== "completed") {
    sections.nextActions = mergeLines(sections.nextActions, [{
      text: `E-${execution.sequence} (${execution.executionId}) ended ${execution.outcome}`,
      sourceExecutionId: execution.executionId,
    }]);
  }
  const outcomes: ThreadContextOutcome[] = [
    ...(previous?.outcomes ?? []),
    {
      executionId: execution.executionId,
      sequence: execution.sequence,
      outcome: execution.outcome,
      runtime: execution.runtime,
      finishedAt: execution.finishedAt,
    },
  ];
  const body: Omit<ThreadContextSnapshotV1, "digest"> = {
    version: 1,
    threadId: input.threadId,
    revision,
    objective: input.title ?? previous?.objective ?? null,
    ...sections,
    outcomes,
    degraded: input.checkpoint === null,
    createdAt: input.createdAt,
  };
  const { body: bounded, droppedCount } = bound(body, input.maxBytes ?? THREAD_CONTEXT_MAX_BYTES, execution.executionId);
  const snapshot: ThreadContextSnapshotV1 = { ...bounded, digest: threadContextDigest(bounded) };
  return {
    snapshot,
    compaction: droppedCount === 0 ? null : { fromRevision, toRevision: revision, droppedCount },
  };
}

/** Pins E-n tự ghi. Pin seed từ Thread có nguồn `execution` và đã nằm ở rev N. */
function promotedPins(
  checkpoint: ContinuityCheckpointV1 | null,
  section: ContextPinSection,
  executionId: ExecutionId,
): ContextLine[] {
  if (checkpoint === null) return [];
  return checkpoint[section]
    .filter((pin) => pin.source !== THREAD_SEED_PIN_SOURCE)
    .map((pin) => ({ text: pin.text, sourceExecutionId: executionId, pinId: pin.id }));
}

/** Nối, bỏ dòng trùng text nguyên văn — cùng một câu pin ở hai execution không đọc hai lần. */
function mergeLines(previous: readonly ContextLine[], added: readonly ContextLine[]): ContextLine[] {
  const merged = previous.slice();
  const seen = new Set(previous.map((line) => line.text));
  for (const line of added) {
    if (seen.has(line.text)) continue;
    seen.add(line.text);
    merged.push(line);
  }
  return merged;
}

/**
 * Cắt cho tới khi lọt trần, theo thứ tự: `openItems` cũ nhất → `decisions`/`constraints`
 * cũ nhất (dòng của execution vừa chiếu không bao giờ rơi — nó là thứ mới nhất và là lý do
 * revision này tồn tại) → `outcomes` cũ nhất, giữ tối thiểu `MIN_RETAINED_OUTCOMES`.
 * Dừng khi không còn gì cắt được, kể cả khi vẫn quá trần — một snapshot to hơn dự tính
 * vẫn tốt hơn một snapshot rỗng.
 */
function bound(
  body: Omit<ThreadContextSnapshotV1, "digest">,
  maxBytes: number,
  newestExecutionId: ExecutionId,
): { readonly body: Omit<ThreadContextSnapshotV1, "digest">; readonly droppedCount: number } {
  let current = body;
  let droppedCount = 0;
  // Đo đúng thứ sẽ nằm trên đĩa: body cộng field digest (độ dài cố định).
  const oversize = (): boolean => threadContextBytes({ ...current, digest: "0".repeat(64) } as ThreadContextSnapshotV1) > maxBytes;
  const dropOldest = (section: ContextPinSection): boolean => {
    const index = current[section].findIndex((line) => line.sourceExecutionId !== newestExecutionId);
    if (index === -1) return false;
    current = { ...current, [section]: current[section].filter((_, position) => position !== index) };
    droppedCount += 1;
    return true;
  };
  while (oversize() && dropOldest("openItems")) { /* openItems trước */ }
  while (oversize() && (dropOldest("decisions") || dropOldest("constraints"))) { /* rồi decisions/constraints */ }
  while (oversize() && current.outcomes.length > MIN_RETAINED_OUTCOMES) {
    current = { ...current, outcomes: current.outcomes.slice(1) };
    droppedCount += 1;
  }
  return { body: current, droppedCount };
}
