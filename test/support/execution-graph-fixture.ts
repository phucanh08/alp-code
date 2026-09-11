import { createHash } from "node:crypto";
import { DEFAULT_EXECUTION_GRAPH_LIMITS } from "../../src/execution/graph/defaults";
import type {
  ExecutionGraphDocument,
  ExecutionGraphLimits,
  ExecutionNode,
  ExecutionReservation,
} from "../../src/execution/graph/types";

/**
 * Builders for graph documents, so a test says only what it is about.
 *
 * A valid document has to satisfy every invariant at once — one root, matching depths, a hash
 * in every hash-shaped field, `endedAt` present exactly on terminal nodes. Spelling all of
 * that out inline turns a three-line assertion about a concurrency limit into forty lines of
 * scaffolding, and the reader can no longer tell which field the test is actually varying.
 */

export const BASE_TIME = "2026-09-11T00:00:00.000Z";
export const DEADLINE = new Date(Date.parse(BASE_TIME) + DEFAULT_EXECUTION_GRAPH_LIMITS.wallClockMs).toISOString();

export function digest(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

export function at(offsetMs: number): string {
  return new Date(Date.parse(BASE_TIME) + offsetMs).toISOString();
}

export function rootNode(overrides: Partial<ExecutionNode> = {}): ExecutionNode {
  const executionId = overrides.executionId ?? "root-1";
  return {
    executionId,
    graphId: overrides.graphId ?? executionId,
    parentExecutionId: null,
    agentId: "main",
    depth: 0,
    status: "running",
    requestId: null,
    requestFingerprint: null,
    capabilityHash: digest(`capability:${executionId}`),
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    startedAt: BASE_TIME,
    endedAt: null,
    cancellation: null,
    error: null,
    terminationReason: null,
    ...overrides,
  };
}

export function childNode(
  executionId: string,
  parentExecutionId: string,
  overrides: Partial<ExecutionNode> = {},
): ExecutionNode {
  const status = overrides.status ?? "running";
  const terminal = ["completed", "failed", "cancelled", "interrupted"].includes(status);
  return {
    executionId,
    graphId: overrides.graphId ?? "root-1",
    parentExecutionId,
    agentId: "worker",
    depth: 1,
    status,
    requestId: `request-${executionId}`,
    requestFingerprint: digest(`fingerprint:${executionId}`),
    capabilityHash: digest(`capability:${executionId}`),
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    startedAt: BASE_TIME,
    endedAt: terminal ? at(1_000) : null,
    cancellation: null,
    error: null,
    terminationReason: null,
    ...overrides,
  };
}

export function reservation(
  reservationId: string,
  parentExecutionId: string,
  overrides: Partial<ExecutionReservation> = {},
): ExecutionReservation {
  return {
    reservationId,
    executionId: `execution-${reservationId}`,
    parentExecutionId,
    agentId: "worker",
    depth: 1,
    requestId: `request-${reservationId}`,
    requestFingerprint: digest(`fingerprint:${reservationId}`),
    capabilityHash: digest(`capability:${reservationId}`),
    createdAt: BASE_TIME,
    expiresAt: at(DEFAULT_EXECUTION_GRAPH_LIMITS.reservationTtlMs),
    ...overrides,
  };
}

export interface GraphFixtureOptions {
  readonly graphId?: string;
  readonly limits?: Partial<ExecutionGraphLimits>;
  readonly revision?: number;
  readonly delegationUsed?: number;
  readonly nodes?: readonly ExecutionNode[];
  readonly reservations?: readonly ExecutionReservation[];
  readonly deadlineAt?: string;
}

export function graphFixture(options: GraphFixtureOptions = {}): ExecutionGraphDocument {
  const graphId = options.graphId ?? "root-1";
  return {
    version: 1,
    graphId,
    rootExecutionId: graphId,
    revision: options.revision ?? 0,
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    deadlineAt: options.deadlineAt ?? DEADLINE,
    limits: { ...DEFAULT_EXECUTION_GRAPH_LIMITS, ...options.limits },
    delegationUsed: options.delegationUsed ?? 0,
    nodes: options.nodes ?? [rootNode({ executionId: graphId, graphId })],
    reservations: options.reservations ?? [],
  };
}

/** The same document one revision later, so a test can write without restating the whole tree. */
export function nextRevision(
  graph: ExecutionGraphDocument,
  changes: Partial<ExecutionGraphDocument> = {},
): ExecutionGraphDocument {
  return { ...graph, revision: graph.revision + 1, updatedAt: at(graph.revision + 1), ...changes };
}
