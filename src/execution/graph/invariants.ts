import { ExecutionGraphError } from "./errors";
import {
  isTerminalNodeStatus,
  type ExecutionGraphDocument,
  type ExecutionGraphLimits,
  type ExecutionNode,
  type ExecutionNodeStatus,
  type ExecutionReservation,
} from "./types";

const HEX_64 = /^[0-9a-f]{64}$/;

const NODE_STATUSES: readonly ExecutionNodeStatus[] = [
  "preparing",
  "queued",
  "running",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
];

/**
 * Chuyển trạng thái nào là hợp lệ.
 *
 * Bảng liệt kê chứ không tính bằng thứ hạng, vì hai luật ở đây không cùng hình dạng:
 * "không lùi về active" là đơn điệu, còn "`cancelling` vẫn có thể kết thúc `completed`" thì
 * không — một agent hoàn thành xong đúng lúc lệnh huỷ tới là chuyện bình thường, và ghi đè
 * nó thành `cancelled` sẽ vứt mất kết quả nó đã trả.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<ExecutionNodeStatus, readonly ExecutionNodeStatus[]>> =
  Object.freeze({
    preparing: ["queued", "running", "cancelling", "completed", "failed", "cancelled", "interrupted"],
    queued: ["running", "cancelling", "completed", "failed", "cancelled", "interrupted"],
    running: ["cancelling", "completed", "failed", "cancelled", "interrupted"],
    cancelling: ["completed", "failed", "cancelled", "interrupted"],
    completed: [],
    failed: [],
    cancelled: [],
    interrupted: [],
  });

export function canTransition(from: ExecutionNodeStatus, to: ExecutionNodeStatus): boolean {
  return from === to || ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertNodeTransition(
  executionId: string,
  from: ExecutionNodeStatus,
  to: ExecutionNodeStatus,
): void {
  if (!canTransition(from, to)) {
    throw new ExecutionGraphError(
      "INVALID_NODE_TRANSITION",
      `execution \`${executionId}\` cannot move from \`${from}\` to \`${to}\``,
    );
  }
}

function invalid(message: string): never {
  throw new ExecutionGraphError("EXECUTION_GRAPH_INVALID", message);
}

function assertTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    invalid(`${field} must be an ISO timestamp`);
  }
  return value;
}

function assertNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") invalid(`${field} must be a non-empty string`);
  return value;
}

function assertPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    invalid(`${field} must be a positive integer`);
  }
  return value;
}

function assertHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !HEX_64.test(value)) {
    invalid(`${field} must be a lowercase SHA-256 hex digest`);
  }
  return value;
}

export function assertLimits(value: unknown): ExecutionGraphLimits {
  if (typeof value !== "object" || value === null) invalid("limits must be an object");
  const limits = value as Record<string, unknown>;
  for (const field of [
    "maxDepth",
    "maxChildrenPerExecution",
    "maxConcurrentChildrenPerExecution",
    "maxConcurrentExecutions",
    "delegationLimit",
    "wallClockMs",
    "reservationTtlMs",
  ]) {
    // `maxDepth` một mình được phép bằng 0: đó là một cây chỉ có root, hình dạng hợp lệ và
    // là thứ một test muốn dựng khi nó chứng minh depth boundary chặn đúng chỗ.
    if (field === "maxDepth") {
      if (typeof limits[field] !== "number" || !Number.isInteger(limits[field]) || (limits[field] as number) < 0) {
        invalid("limits.maxDepth must be a non-negative integer");
      }
      continue;
    }
    assertPositiveInteger(limits[field], `limits.${field}`);
  }
  return limits as unknown as ExecutionGraphLimits;
}

function assertNodeShape(value: unknown, graphId: string): ExecutionNode {
  if (typeof value !== "object" || value === null) invalid("node must be an object");
  const node = value as Record<string, unknown>;
  assertNonEmpty(node.executionId, "node.executionId");
  if (node.graphId !== graphId) invalid(`node \`${String(node.executionId)}\` belongs to another graph`);
  assertNonEmpty(node.agentId, "node.agentId");
  if (typeof node.depth !== "number" || !Number.isInteger(node.depth) || node.depth < 0) {
    invalid(`node \`${String(node.executionId)}\` has an invalid depth`);
  }
  if (!NODE_STATUSES.includes(node.status as ExecutionNodeStatus)) {
    invalid(`node \`${String(node.executionId)}\` has an unknown status \`${String(node.status)}\``);
  }
  assertHash(node.capabilityHash, `node \`${String(node.executionId)}\`.capabilityHash`);
  assertTimestamp(node.createdAt, `node \`${String(node.executionId)}\`.createdAt`);
  assertTimestamp(node.updatedAt, `node \`${String(node.executionId)}\`.updatedAt`);
  for (const field of ["startedAt", "endedAt"] as const) {
    if (node[field] !== null) assertTimestamp(node[field], `node \`${String(node.executionId)}\`.${field}`);
  }
  const terminal = isTerminalNodeStatus(node.status as ExecutionNodeStatus);
  if (terminal && node.endedAt === null) {
    invalid(`terminal node \`${String(node.executionId)}\` must record endedAt`);
  }
  if (!terminal && node.endedAt !== null) {
    invalid(`active node \`${String(node.executionId)}\` must not record endedAt`);
  }
  if (node.parentExecutionId === null) {
    if (node.requestId !== null || node.requestFingerprint !== null) {
      invalid("the root node must not carry a delegation request");
    }
  } else {
    assertNonEmpty(node.parentExecutionId, "node.parentExecutionId");
    assertNonEmpty(node.requestId, `node \`${String(node.executionId)}\`.requestId`);
    assertHash(node.requestFingerprint, `node \`${String(node.executionId)}\`.requestFingerprint`);
  }
  return node as unknown as ExecutionNode;
}

function assertReservationShape(value: unknown): ExecutionReservation {
  if (typeof value !== "object" || value === null) invalid("reservation must be an object");
  const reservation = value as Record<string, unknown>;
  assertNonEmpty(reservation.reservationId, "reservation.reservationId");
  assertNonEmpty(reservation.executionId, "reservation.executionId");
  assertNonEmpty(reservation.parentExecutionId, "reservation.parentExecutionId");
  assertNonEmpty(reservation.agentId, "reservation.agentId");
  assertNonEmpty(reservation.requestId, "reservation.requestId");
  assertHash(reservation.requestFingerprint, "reservation.requestFingerprint");
  assertHash(reservation.capabilityHash, "reservation.capabilityHash");
  if (typeof reservation.depth !== "number" || !Number.isInteger(reservation.depth) || reservation.depth < 1) {
    invalid(`reservation \`${String(reservation.reservationId)}\` has an invalid depth`);
  }
  assertTimestamp(reservation.createdAt, "reservation.createdAt");
  assertTimestamp(reservation.expiresAt, "reservation.expiresAt");
  return reservation as unknown as ExecutionReservation;
}

/**
 * Kiểm toàn bộ document, và ném `EXECUTION_GRAPH_INVALID` khi nó không thoả.
 *
 * Chạy trên cả đường đọc lẫn đường ghi. Đường ghi để một bug ở service không kịp thành state
 * bền vững; đường đọc vì một file bị sửa tay là thứ duy nhất còn có thể nói dối về hình dạng
 * cây sau khi service đã đúng — và câu trả lời đúng cho nó là dừng, không phải tự sửa.
 */
export function assertGraphDocument(value: unknown): ExecutionGraphDocument {
  if (typeof value !== "object" || value === null) invalid("execution graph must be an object");
  const graph = value as Record<string, unknown>;
  if (graph.version !== 1) invalid(`unsupported execution graph version \`${String(graph.version)}\``);
  const graphId = assertNonEmpty(graph.graphId, "graphId");
  const rootExecutionId = assertNonEmpty(graph.rootExecutionId, "rootExecutionId");
  if (graphId !== rootExecutionId) invalid("graphId must equal rootExecutionId");
  if (typeof graph.revision !== "number" || !Number.isInteger(graph.revision) || graph.revision < 0) {
    invalid("revision must be a non-negative integer");
  }
  assertTimestamp(graph.createdAt, "createdAt");
  assertTimestamp(graph.updatedAt, "updatedAt");
  assertTimestamp(graph.deadlineAt, "deadlineAt");
  const limits = assertLimits(graph.limits);
  if (typeof graph.delegationUsed !== "number" || !Number.isInteger(graph.delegationUsed) || graph.delegationUsed < 0) {
    invalid("delegationUsed must be a non-negative integer");
  }
  if (graph.delegationUsed > limits.delegationLimit) {
    invalid("delegationUsed exceeds the graph's delegation limit");
  }
  if (!Array.isArray(graph.nodes)) invalid("nodes must be an array");
  if (!Array.isArray(graph.reservations)) invalid("reservations must be an array");

  const nodes = graph.nodes.map((node) => assertNodeShape(node, graphId));
  const byId = new Map<string, ExecutionNode>();
  for (const node of nodes) {
    if (byId.has(node.executionId)) invalid(`duplicate node \`${node.executionId}\``);
    byId.set(node.executionId, node);
  }
  const roots = nodes.filter((node) => node.parentExecutionId === null);
  if (roots.length !== 1) invalid("an execution graph must contain exactly one root node");
  if (roots[0].executionId !== rootExecutionId) invalid("the root node must be rootExecutionId");
  if (roots[0].depth !== 0) invalid("the root node must be at depth 0");

  const requestIds = new Set<string>();
  for (const node of nodes) {
    if (node.requestId === null) continue;
    if (requestIds.has(node.requestId)) invalid(`duplicate delegation request \`${node.requestId}\``);
    requestIds.add(node.requestId);
  }

  for (const node of nodes) {
    if (node.parentExecutionId === null) continue;
    const parent = byId.get(node.parentExecutionId);
    if (!parent) invalid(`node \`${node.executionId}\` names a parent that is not in the graph`);
    if (node.depth !== parent.depth + 1) {
      invalid(`node \`${node.executionId}\` must sit one level below its parent`);
    }
  }

  // Đủ để loại chu trình: mỗi node có nhiều nhất một cha, chỉ có một root, và mọi node phải
  // tới được từ root — ba điều đó cộng lại thì một vòng sẽ nằm ngoài tập tới được.
  const reachable = new Set<string>([rootExecutionId]);
  const frontier = [rootExecutionId];
  while (frontier.length > 0) {
    const current = frontier.pop() as string;
    for (const node of nodes) {
      if (node.parentExecutionId === current && !reachable.has(node.executionId)) {
        reachable.add(node.executionId);
        frontier.push(node.executionId);
      }
    }
  }
  if (reachable.size !== nodes.length) invalid("execution graph contains an unreachable node or a cycle");

  const reservations = graph.reservations.map(assertReservationShape);
  const reservationIds = new Set<string>();
  for (const reservation of reservations) {
    if (reservationIds.has(reservation.reservationId)) {
      invalid(`duplicate reservation \`${reservation.reservationId}\``);
    }
    reservationIds.add(reservation.reservationId);
    if (byId.has(reservation.executionId)) {
      invalid(`reservation \`${reservation.reservationId}\` names an execution that already exists`);
    }
    const parent = byId.get(reservation.parentExecutionId);
    if (!parent) invalid(`reservation \`${reservation.reservationId}\` names a parent that is not in the graph`);
    if (reservation.depth !== parent.depth + 1) {
      invalid(`reservation \`${reservation.reservationId}\` must sit one level below its parent`);
    }
    if (requestIds.has(reservation.requestId)) {
      invalid(`reservation \`${reservation.reservationId}\` duplicates a committed request`);
    }
  }

  return graph as unknown as ExecutionGraphDocument;
}

/**
 * Các trường cấu trúc của một node không đổi được.
 *
 * Store không có `updateNode` tổng quát, nhưng service thì dựng document mới mỗi lần ghi —
 * và đó là chỗ một trường cấu trúc có thể lặng lẽ đổi. Kiểm ở đây, dưới lease, trước khi
 * document mới thành sự thật.
 */
export function assertStructuralFieldsPreserved(
  previous: ExecutionGraphDocument,
  next: ExecutionGraphDocument,
): void {
  if (previous.graphId !== next.graphId) invalid("graphId is immutable");
  if (previous.rootExecutionId !== next.rootExecutionId) invalid("rootExecutionId is immutable");
  if (previous.createdAt !== next.createdAt) invalid("createdAt is immutable");
  if (previous.deadlineAt !== next.deadlineAt) invalid("deadlineAt is immutable");
  if (JSON.stringify(previous.limits) !== JSON.stringify(next.limits)) invalid("limits are immutable");
  if (next.delegationUsed < previous.delegationUsed) invalid("delegationUsed cannot decrease");

  for (const before of previous.nodes) {
    const after = next.nodes.find((node) => node.executionId === before.executionId);
    if (!after) invalid(`node \`${before.executionId}\` cannot be removed from the graph`);
    for (const field of [
      "graphId",
      "parentExecutionId",
      "agentId",
      "depth",
      "requestId",
      "requestFingerprint",
      "capabilityHash",
      "createdAt",
    ] as const) {
      if (before[field] !== after[field]) {
        invalid(`node \`${before.executionId}\`.${field} is immutable`);
      }
    }
    assertNodeTransition(before.executionId, before.status, after.status);
  }
}
