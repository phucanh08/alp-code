import type { AgentId } from "../../agents/types";
import type { ExecutionId } from "../types";

/**
 * Cây thực thi bền vững của một phiên — thứ `ExecutionBackend` cố tình không biết.
 *
 * Backend sở hữu **một** process: nó trả lời được "process này còn sống không", không trả lời
 * được "ai đã gọi ai" hay "cây này còn được phép đẻ thêm bao nhiêu con". Hai câu sau là cái
 * đóng đệ quy lại, và chúng phải sống sót qua việc process gọi lệnh biến mất — nên chúng nằm
 * trong một document JSON riêng chứ không trong bộ nhớ của ai cả.
 *
 * `graphId === rootExecutionId`: một identity ít hơn để đồng bộ, và root luôn mở được graph
 * mà không cần tra bảng nào.
 */
export type ExecutionGraphId = string;

/**
 * `preparing` → node đã tồn tại trong graph nhưng chưa có process.
 * `queued` → đã cấp phát chỗ, đang chờ backend đăng ký process.
 * `running` → backend đã có record.
 * `cancelling` → đã đánh dấu dừng, chưa có kết quả cuối.
 *
 * Bốn trạng thái cuối là terminal và không quay lại active được. `interrupted` tách khỏi
 * `failed` vì nó nói "không ai ghi lại kết cục" — orphan — chứ không phải "chạy xong và hỏng".
 */
export type ExecutionNodeStatus =
  | "preparing"
  | "queued"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export const ACTIVE_NODE_STATUSES = Object.freeze([
  "preparing",
  "queued",
  "running",
  "cancelling",
] as const satisfies readonly ExecutionNodeStatus[]);

export const TERMINAL_NODE_STATUSES = Object.freeze([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const satisfies readonly ExecutionNodeStatus[]);

export function isTerminalNodeStatus(status: ExecutionNodeStatus): boolean {
  return (TERMINAL_NODE_STATUSES as readonly string[]).includes(status);
}

export function isActiveNodeStatus(status: ExecutionNodeStatus): boolean {
  return !isTerminalNodeStatus(status);
}

/**
 * Vì sao một node dừng. Ghi lại lý do chứ không chỉ trạng thái, vì `cancelled` một mình không
 * phân biệt nổi "principal bấm huỷ" với "hết hạn 2 giờ" — hai chuyện dẫn tới hai hành động
 * hoàn toàn khác của người vận hành.
 */
export type CancellationReason =
  | "USER_REQUEST"
  | "PARENT_CANCELLED"
  | "PARENT_FAILED"
  | "WALL_CLOCK_EXCEEDED"
  | "SYSTEM_SHUTDOWN";

export interface CancellationRecord {
  readonly reason: CancellationReason;
  /** Execution ID đã yêu cầu, hoặc `principal` khi lệnh đến từ CLI. */
  readonly requestedBy: string;
  readonly requestedAt: string;
}

export interface ExecutionNodeError {
  readonly code: string;
  readonly message: string;
}

export interface ExecutionGraphLimits {
  readonly maxDepth: number;
  readonly maxChildrenPerExecution: number;
  readonly maxConcurrentChildrenPerExecution: number;
  readonly maxConcurrentExecutions: number;
  readonly delegationLimit: number;
  readonly wallClockMs: number;
  readonly reservationTtlMs: number;
}

/**
 * Một execution trong cây.
 *
 * Các trường **cấu trúc** — `graphId`, `rootExecutionId` (qua graph), `parentExecutionId`,
 * `agentId`, `requestId`, `requestFingerprint`, `capabilityHash`, `depth`, `createdAt` — bất
 * biến sau khi node ra đời. Không có `updateNode` tổng quát ở tầng store chính vì thế: một
 * patch tự do là đường để `depth` hay `parentExecutionId` bị viết lại, và lúc đó mọi limit
 * tính trên cây đều nói dối.
 */
export interface ExecutionNode {
  readonly executionId: ExecutionId;
  readonly graphId: ExecutionGraphId;
  readonly parentExecutionId: ExecutionId | null;
  readonly agentId: AgentId;
  readonly depth: number;
  readonly status: ExecutionNodeStatus;
  /** `null` ở root: root không đến từ một delegation request nào. */
  readonly requestId: string | null;
  readonly requestFingerprint: string | null;
  /** SHA-256 của capability plaintext. Plaintext không bao giờ thành durable state. */
  readonly capabilityHash: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly cancellation: CancellationRecord | null;
  readonly error: ExecutionNodeError | null;
  /** `deadline` khi node bị giết bởi wall clock; `null` ở mọi kết cục khác. */
  readonly terminationReason: "deadline" | null;
}

/**
 * Chỗ đã giữ cho một child chưa attach xong.
 *
 * Giữa lúc kiểm limit và lúc backend đăng ký process có một khoảng — chuẩn bị artifact, dựng
 * launch spec, probe runtime — đủ dài để hai caller cùng đi qua cùng một "còn một chỗ". Chỗ
 * giữ này lấp khoảng đó: nó tính vào provisional capacity ngay từ lúc limit được kiểm.
 */
export interface ExecutionReservation {
  readonly reservationId: string;
  readonly executionId: ExecutionId;
  readonly parentExecutionId: ExecutionId;
  readonly agentId: AgentId;
  readonly depth: number;
  readonly requestId: string;
  readonly requestFingerprint: string;
  readonly capabilityHash: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ExecutionGraphDocument {
  readonly version: 1;
  readonly graphId: ExecutionGraphId;
  readonly rootExecutionId: ExecutionId;
  /** Tăng đúng 1 mỗi lần ghi. Lost update là ghi mà revision không tăng liên tục. */
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * Một timestamp tuyệt đối, chốt một lần ở root và truyền nguyên xuống mọi node.
   *
   * Không phải "thời lượng" — thời lượng reset được ở mỗi tầng, và một cây sâu 2 tầng với
   * thời lượng 2 giờ mỗi tầng sống 6 giờ. Timestamp thì không cộng dồn.
   */
  readonly deadlineAt: string;
  readonly limits: ExecutionGraphLimits;
  /** Số child đã commit trong cả cây. Reservation chưa commit không tính vào đây. */
  readonly delegationUsed: number;
  readonly nodes: readonly ExecutionNode[];
  readonly reservations: readonly ExecutionReservation[];
}

export function findNode(
  graph: ExecutionGraphDocument,
  executionId: ExecutionId,
): ExecutionNode | null {
  return graph.nodes.find((node) => node.executionId === executionId) ?? null;
}

export function childrenOf(
  graph: ExecutionGraphDocument,
  executionId: ExecutionId,
): readonly ExecutionNode[] {
  return graph.nodes.filter((node) => node.parentExecutionId === executionId);
}

/**
 * Node cùng toàn bộ hậu duệ, cạn trước sâu sau.
 *
 * Duyệt bằng vòng lặp trên danh sách chứ không đệ quy: graph đã được `assertGraphDocument`
 * chứng minh là cây không chu trình trước khi tới đây, nhưng một document hỏng đọc từ đĩa
 * vẫn có thể tới thẳng chỗ này qua một đường khác, và một vòng lặp có `seen` thì dừng còn
 * đệ quy thì tràn stack.
 */
export function subtreeOf(
  graph: ExecutionGraphDocument,
  executionId: ExecutionId,
): readonly ExecutionNode[] {
  const root = findNode(graph, executionId);
  if (!root) return Object.freeze([]);
  const collected: ExecutionNode[] = [root];
  const seen = new Set<ExecutionId>([root.executionId]);
  for (let index = 0; index < collected.length; index += 1) {
    for (const child of childrenOf(graph, collected[index].executionId)) {
      if (seen.has(child.executionId)) continue;
      seen.add(child.executionId);
      collected.push(child);
    }
  }
  return Object.freeze(collected);
}

/** Tổ tiên từ cha lên tới root, không gồm chính node. */
export function ancestorsOf(
  graph: ExecutionGraphDocument,
  executionId: ExecutionId,
): readonly ExecutionNode[] {
  const chain: ExecutionNode[] = [];
  const seen = new Set<ExecutionId>([executionId]);
  let current = findNode(graph, executionId);
  while (current?.parentExecutionId) {
    if (seen.has(current.parentExecutionId)) break;
    seen.add(current.parentExecutionId);
    const parent = findNode(graph, current.parentExecutionId);
    if (!parent) break;
    chain.push(parent);
    current = parent;
  }
  return Object.freeze(chain);
}
