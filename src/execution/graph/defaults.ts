import type { ExecutionGraphLimits } from "./types";

/**
 * Safety envelope của P0 — cố định, không mở ra `settings.json`.
 *
 * Không phải vì cấu hình được là sai, mà vì thứ đầu tiên một cây đệ quy làm khi nó có quyền
 * ghi settings là nới chính cái trần đang giữ nó. Trần cấu hình được là một đề xuất riêng,
 * sau khi có một đường nào đó chứng minh được ai đang sửa nó.
 *
 * Test tiêm số nhỏ hơn qua `ExecutionGraphService`; production luôn chạy đúng bảng này.
 */
export const DEFAULT_EXECUTION_GRAPH_LIMITS: ExecutionGraphLimits = Object.freeze({
  /** Root là 0, nên 2 nghĩa là `main → worker → search` và không sâu hơn. */
  maxDepth: 2,
  /** Tổng số con một execution được đẻ trong cả đời nó, kể cả con đã kết thúc. */
  maxChildrenPerExecution: 4,
  maxConcurrentChildrenPerExecution: 2,
  /** Trần cho cả cây, đếm mọi node đang active kể cả root. */
  maxConcurrentExecutions: 6,
  /** Tổng số delegation cả cây được commit trong đời nó. */
  delegationLimit: 8,
  wallClockMs: 2 * 60 * 60 * 1_000,
  reservationTtlMs: 2 * 60 * 1_000,
});

/**
 * Khoảng ân hạn cho một node `queued` chưa thấy backend record.
 *
 * Ngắn hơn thì một máy chậm bị báo hỏng oan; dài hơn thì một caller chết giữa reserve và
 * spawn giữ chỗ quá lâu. 30 giây là cùng ngưỡng `FileLocalExecutionStore` đã dùng cho stale
 * lock, và giữ chung một con số đỡ phải giải thích hai lần.
 */
export const QUEUED_STARTUP_GRACE_MS = 30_000;
