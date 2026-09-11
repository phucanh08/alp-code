import { ExecutionGraphError } from "./errors";
import {
  childrenOf,
  isActiveNodeStatus,
  type ExecutionGraphDocument,
  type ExecutionNode,
  type ExecutionReservation,
} from "./types";

/**
 * Toàn bộ phép tính trần, tách thành hàm thuần.
 *
 * Chúng phải chạy được mà không cần lock, không cần đĩa, không cần backend — đó là điều kiện
 * để một test kể được câu chuyện "chỗ cuối cùng, hai caller" mà không phải dựng process thật.
 * Chỗ duy nhất chúng được gọi trong production là dưới graph lease, và đó là chuyện của
 * service chứ không của file này.
 */

/** Reservation chưa hết hạn. Hết hạn thì coi như không tồn tại, không cần dọn trước. */
export function liveReservations(
  graph: ExecutionGraphDocument,
  now: Date,
): readonly ExecutionReservation[] {
  const at = now.getTime();
  return Object.freeze(graph.reservations.filter((reservation) => Date.parse(reservation.expiresAt) > at));
}

export function expiredReservations(
  graph: ExecutionGraphDocument,
  now: Date,
): readonly ExecutionReservation[] {
  const at = now.getTime();
  return Object.freeze(graph.reservations.filter((reservation) => Date.parse(reservation.expiresAt) <= at));
}

export function activeNodes(graph: ExecutionGraphDocument): readonly ExecutionNode[] {
  return Object.freeze(graph.nodes.filter((node) => isActiveNodeStatus(node.status)));
}

/**
 * Số execution đang chạy trong cả cây, tính cả chỗ đã giữ.
 *
 * Reservation được cộng vào vì đó chính là khoảng mà trần này tồn tại để đóng: nếu chỉ đếm
 * node đã commit thì sáu caller cùng thấy "còn chỗ" và cả sáu cùng đi tiếp.
 */
export function concurrentExecutions(graph: ExecutionGraphDocument, now: Date): number {
  return activeNodes(graph).length + liveReservations(graph, now).length;
}

/** Con đang chạy của một node, cộng chỗ đã giữ cho node đó. */
export function concurrentChildren(
  graph: ExecutionGraphDocument,
  parentExecutionId: string,
  now: Date,
): number {
  return (
    childrenOf(graph, parentExecutionId).filter((node) => isActiveNodeStatus(node.status)).length +
    liveReservations(graph, now).filter((reservation) => reservation.parentExecutionId === parentExecutionId).length
  );
}

/**
 * Số con một node đã dùng trong cả đời nó.
 *
 * Con đã kết thúc vẫn tính. Trần này không phải trần đồng thời — nó là ngân sách; một node
 * đẻ bốn con lần lượt đã tiêu hết ngân sách đó, và cho nó đẻ tiếp chỉ vì ba con đầu đã xong
 * là bỏ đúng cái đang chặn một vòng lặp vô hạn chạy chậm.
 */
export function lifetimeChildren(
  graph: ExecutionGraphDocument,
  parentExecutionId: string,
  now: Date,
): number {
  return (
    childrenOf(graph, parentExecutionId).length +
    liveReservations(graph, now).filter((reservation) => reservation.parentExecutionId === parentExecutionId).length
  );
}

/** Delegation đã commit cộng chỗ đang giữ — ngân sách của cả cây. */
export function provisionalDelegationUsed(graph: ExecutionGraphDocument, now: Date): number {
  return graph.delegationUsed + liveReservations(graph, now).length;
}

export interface ChildCapacityInput {
  readonly graph: ExecutionGraphDocument;
  readonly parentExecutionId: string;
  readonly now: Date;
}

/**
 * Cây này có chỗ cho thêm một con của `parentExecutionId` không.
 *
 * Thứ tự kiểm là thứ tự người đọc lỗi cần: hình dạng cây trước (depth), rồi ngân sách của
 * chính node đó, rồi trần đồng thời, rồi ngân sách cả cây. Một caller vượt depth muốn nghe
 * `DEPTH_LIMIT_EXCEEDED` chứ không phải `GRAPH_CONCURRENCY_LIMIT_EXCEEDED` chỉ vì lúc đó cây
 * cũng đang đông.
 */
export function assertChildCapacity(input: ChildCapacityInput): void {
  const { graph, parentExecutionId, now } = input;
  const parent = graph.nodes.find((node) => node.executionId === parentExecutionId);
  if (!parent) {
    throw new ExecutionGraphError(
      "EXECUTION_NODE_NOT_FOUND",
      `execution \`${parentExecutionId}\` is not part of graph \`${graph.graphId}\``,
    );
  }
  const { limits } = graph;
  const depth = parent.depth + 1;
  if (depth > limits.maxDepth) {
    throw new ExecutionGraphError(
      "DEPTH_LIMIT_EXCEEDED",
      `delegation would reach depth ${depth}, above the limit of ${limits.maxDepth}`,
    );
  }
  const lifetime = lifetimeChildren(graph, parentExecutionId, now);
  if (lifetime >= limits.maxChildrenPerExecution) {
    throw new ExecutionGraphError(
      "CHILD_LIMIT_EXCEEDED",
      `execution \`${parentExecutionId}\` has used all ${limits.maxChildrenPerExecution} of its delegations`,
    );
  }
  const concurrent = concurrentChildren(graph, parentExecutionId, now);
  if (concurrent >= limits.maxConcurrentChildrenPerExecution) {
    throw new ExecutionGraphError(
      "CONCURRENCY_LIMIT_EXCEEDED",
      `execution \`${parentExecutionId}\` already runs ${concurrent} of ${limits.maxConcurrentChildrenPerExecution} concurrent children`,
    );
  }
  const graphConcurrent = concurrentExecutions(graph, now);
  if (graphConcurrent >= limits.maxConcurrentExecutions) {
    throw new ExecutionGraphError(
      "GRAPH_CONCURRENCY_LIMIT_EXCEEDED",
      `graph \`${graph.graphId}\` already runs ${graphConcurrent} of ${limits.maxConcurrentExecutions} concurrent executions`,
    );
  }
  const delegations = provisionalDelegationUsed(graph, now);
  if (delegations >= limits.delegationLimit) {
    throw new ExecutionGraphError(
      "DELEGATION_LIMIT_EXCEEDED",
      `graph \`${graph.graphId}\` has used all ${limits.delegationLimit} delegations of its lifetime allowance`,
    );
  }
}

export function assertWithinDeadline(graph: ExecutionGraphDocument, now: Date): void {
  if (now.getTime() >= Date.parse(graph.deadlineAt)) {
    throw new ExecutionGraphError(
      "WALL_CLOCK_EXCEEDED",
      `graph \`${graph.graphId}\` passed its deadline at ${graph.deadlineAt}`,
    );
  }
}
