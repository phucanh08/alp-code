import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicRuntimeFile } from "../runtime/adapter-files";
import { sanitizeText } from "../thread/history-redact";
import { isTerminalNodeStatus, type AcceptanceDecision, type ExecutionGraphDocument, type ExecutionNode } from "./graph/types";
import type { OutcomeDisposition } from "./outcome";

export { TASK_EXCERPT_MAX_CHARS, taskExcerpt } from "./graph/types";

/**
 * Nghiệm thu (P4): phán quyết của cha trên `evidence.json` của một con đã dừng.
 *
 * Bản ghi nằm dưới execution *của cha* — nó là hành động của cha, không phải của con — và
 * chỉ đến sau khi cây đã nhận phán quyết dưới lease: cây là nơi tính "một lần", file là lời
 * giải thích đọc được. Mọi thứ ở đây là thuần hoặc là I/O ở biên; ai được quyết nằm ở
 * `assertAcceptable` trong graph.
 */
export interface AcceptanceRecordV1 {
  readonly version: 1;
  readonly requestId: string;
  readonly subjectExecutionId: string;
  readonly acceptedByExecutionId: string;
  readonly decision: AcceptanceDecision;
  /** Digest của `evidence.json` mà cha đã nhìn khi quyết. */
  readonly evidenceDigest: string;
  /**
   * Disposition con khai (2a) *lúc cha quyết* — cha đã thấy `reopen-request` mà vẫn `accepted`
   * là một sự thật đáng ghi. Vắng ở bản ghi trước 2a; đọc là `unknown`.
   */
  readonly disposition?: OutcomeDisposition;
  /** Đã redact như history: phán quyết đi vào handoff của lần chạy sau. */
  readonly reasons: readonly string[];
  readonly decidedAt: string;
}

/** Mỗi lý do bị cắt ở đây — một lý do là một câu, không phải một transcript. */
export const ACCEPTANCE_REASON_MAX_BYTES = 2_000;

export function acceptanceFile(executionsRoot: string, parentExecutionId: string, requestId: string): string {
  return join(executionsRoot, parentExecutionId, "acceptance", `${requestId}.json`);
}

export async function writeAcceptanceRecord(executionsRoot: string, record: AcceptanceRecordV1): Promise<string> {
  const sanitized: AcceptanceRecordV1 = {
    version: 1,
    requestId: record.requestId,
    subjectExecutionId: record.subjectExecutionId,
    acceptedByExecutionId: record.acceptedByExecutionId,
    decision: record.decision,
    evidenceDigest: record.evidenceDigest,
    disposition: record.disposition ?? "unknown",
    reasons: record.reasons.map((reason) => sanitizeText(reason, ACCEPTANCE_REASON_MAX_BYTES)),
    decidedAt: record.decidedAt,
  };
  return atomicRuntimeFile(acceptanceFile(executionsRoot, record.acceptedByExecutionId, record.requestId), JSON.stringify(sanitized, null, 2) + "\n");
}

export async function readAcceptanceRecord(executionsRoot: string, parentExecutionId: string, requestId: string): Promise<AcceptanceRecordV1 | null> {
  let text: string;
  try {
    text = await readFile(acceptanceFile(executionsRoot, parentExecutionId, requestId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = JSON.parse(text) as AcceptanceRecordV1;
  if (parsed.version !== 1) throw new Error(`acceptance record for ${requestId} is not a version 1 record`);
  return parsed;
}

/**
 * Điều một lần chạy sau đọc được về mỗi delegation của lần trước. `cancelled` và `undecided`
 * không phải phán quyết — chúng là "cha chưa nói gì", suy từ kết cục của node, để danh sách
 * không im lặng về một con đã bị huỷ hay bị bỏ quên.
 */
export type DelegationDecision = AcceptanceDecision | "cancelled" | "undecided";

export interface DelegationSummary {
  readonly requestId: string;
  readonly target: string;
  readonly task: string;
  readonly decision: DelegationDecision;
  readonly evidenceDigest: string | null;
}

export interface DelegationCounts {
  readonly accepted: number;
  readonly rejected: number;
  readonly cancelled: number;
  readonly undecided: number;
}

/** Bao nhiêu delegation gần nhất đi vào snapshot; phần còn lại vẫn đếm được ở boundary. */
export const DELEGATION_SUMMARY_LIMIT = 20;

export function delegationDecision(node: ExecutionNode): DelegationDecision {
  if (node.acceptance !== null) return node.acceptance.decision;
  if (isTerminalNodeStatus(node.status) && (node.status === "cancelled" || node.status === "interrupted")) return "cancelled";
  return "undecided";
}

function directChildren(graph: Pick<ExecutionGraphDocument, "nodes">, parentExecutionId: string): ExecutionNode[] {
  return graph.nodes
    .filter((node) => node.parentExecutionId === parentExecutionId && node.requestId !== null)
    .sort((left, right) => (left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : left.executionId < right.executionId ? -1 : 1));
}

export function summarizeDelegations(
  graph: Pick<ExecutionGraphDocument, "nodes">,
  parentExecutionId: string,
  options: { readonly limit?: number } = {},
): DelegationSummary[] {
  const limit = options.limit ?? DELEGATION_SUMMARY_LIMIT;
  return directChildren(graph, parentExecutionId).slice(-limit).map((node) => ({
    requestId: node.requestId as string,
    target: node.agentId,
    task: node.taskExcerpt ?? "",
    decision: delegationDecision(node),
    evidenceDigest: node.acceptance?.evidenceDigest ?? node.evidence?.digest ?? null,
  }));
}

export function countDelegations(graph: Pick<ExecutionGraphDocument, "nodes">, parentExecutionId: string): DelegationCounts {
  const counts = { accepted: 0, rejected: 0, cancelled: 0, undecided: 0 };
  for (const node of directChildren(graph, parentExecutionId)) counts[delegationDecision(node)] += 1;
  return counts;
}
