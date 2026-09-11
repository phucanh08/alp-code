export const ALP_CORE_VERSION = 1 as const;

/**
 * Contract của execution graph, phần công khai.
 *
 * Chỉ types, error codes, limits mặc định và interface store — không có implementation nào ở
 * đây. Một consumer cần biết cây có hình dạng gì và trần nào tồn tại; store nào ghi nó là
 * chuyện của composition, và mở nó ra ở đây là mời người ta ghi thẳng vào graph mà không đi
 * qua lease.
 */
export {
  ACTIVE_NODE_STATUSES,
  TERMINAL_NODE_STATUSES,
  isActiveNodeStatus,
  isTerminalNodeStatus,
  type CancellationReason,
  type CancellationRecord,
  type ExecutionGraphDocument,
  type ExecutionGraphId,
  type ExecutionGraphLimits,
  type ExecutionNode,
  type ExecutionNodeError,
  type ExecutionNodeStatus,
  type ExecutionReservation,
} from "./execution/graph/types";
export {
  ExecutionGraphError,
  isExecutionGraphError,
  type ExecutionGraphErrorCode,
} from "./execution/graph/errors";
export { DEFAULT_EXECUTION_GRAPH_LIMITS } from "./execution/graph/defaults";
export type { ExecutionGraphLease, ExecutionGraphStore } from "./execution/graph/execution-graph-store";
