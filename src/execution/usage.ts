import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicRuntimeFile } from "../runtime/adapter-files";
import type { HistoryCompleteness } from "../thread/history-types";

/**
 * Usage (P6): ALP đếm hộ token và tool call từ transcript runtime-owned — quan sát, không
 * chặn. Mỗi cột `null` là "không biết", và không biết thì không bao giờ được làm tròn thành
 * 0: một cột đã `null` giữ `null` qua mọi lần cộng, để budget so trên nó chỉ có thể trả
 * `unknown`, không bao giờ trả `within` giả.
 *
 * Bốn cột token tách riêng vì hai runtime báo khác nhau (Anthropic tách cache khỏi
 * `input_tokens`, OpenAI gộp); bridge chuẩn hoá về cùng nghĩa trước khi tới đây — xem
 * `research/transcript-usage.md`.
 */
export interface UsageCounters {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly toolCalls: number | null;
}

export const USAGE_COLUMNS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "toolCalls"] as const;
export type UsageColumn = (typeof USAGE_COLUMNS)[number];
const TOKEN_COLUMNS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const;

export const NO_USAGE: UsageCounters = Object.freeze({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0 });
export const UNKNOWN_USAGE: UsageCounters = Object.freeze({ inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, toolCalls: null });

/** `<execution>/usage.json`: cộng dồn của mọi lát bridge đã đọc cho execution này. */
export interface ExecutionUsageV1 extends UsageCounters {
  readonly version: 1;
  readonly executionId: string;
  readonly source: "history-bridge";
  readonly completeness: HistoryCompleteness;
  readonly collectedAt: string;
}

/** Trần cha đặt lúc giao. Thiếu field = không đặt trần đó. */
export interface ExecutionBudget {
  readonly tokens?: number;
  readonly toolCalls?: number;
}

export type BudgetStatus = "within" | "exceeded" | "unknown";

function addColumn(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a + b;
}

export function addUsage(a: UsageCounters, b: UsageCounters): UsageCounters {
  return {
    inputTokens: addColumn(a.inputTokens, b.inputTokens),
    outputTokens: addColumn(a.outputTokens, b.outputTokens),
    cacheReadTokens: addColumn(a.cacheReadTokens, b.cacheReadTokens),
    cacheWriteTokens: addColumn(a.cacheWriteTokens, b.cacheWriteTokens),
    toolCalls: addColumn(a.toolCalls, b.toolCalls),
  };
}

/**
 * Cộng một lát vào tổng đã có. Lát `null`/vắng = bridge không đọc được transcript lần này
 * (`final-only`/`unsupported`) — không có số mới, tổng cũ giữ nguyên; khác với một lát có
 * cột `null`, cái đó làm cột tổng `null` (xem `addUsage`).
 */
export function accumulateUsage(previous: UsageCounters | null, delta: UsageCounters | null | undefined): UsageCounters | null {
  if (delta === null || delta === undefined) return previous;
  return previous === null ? delta : addUsage(previous, delta);
}

/** Tổng mọi token đã xử lý; `null` khi một cột không biết. */
export function totalTokens(usage: UsageCounters | null): number | null {
  if (usage === null) return null;
  let total = 0;
  for (const column of TOKEN_COLUMNS) {
    const value = usage[column];
    if (value === null) return null;
    total += value;
  }
  return total;
}

/**
 * Tổng cho một cây: cột đã biết cộng lại, node/cột không biết bỏ qua và đánh dấu `partial`.
 * Đây là số để *xem*, không phải để so budget — budget so trên từng node.
 */
export function sumUsage(parts: readonly (UsageCounters | null)[]): { readonly usage: UsageCounters; readonly partial: boolean } {
  const total: Record<UsageColumn, number> = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0 };
  let partial = false;
  for (const part of parts) {
    if (part === null) { partial = true; continue; }
    for (const column of USAGE_COLUMNS) {
      const value = part[column];
      if (value === null) partial = true;
      else total[column] += value;
    }
  }
  return { usage: total, partial };
}

/** `exceeded` khi một trần đã bị vượt bởi số đã biết; `unknown` khi một trần không so được; còn lại `within`. */
export function evaluateBudget(budget: ExecutionBudget | null, usage: UsageCounters | null): BudgetStatus {
  if (budget === null) return "within";
  let unknown = false;
  const check = (ceiling: number | undefined, value: number | null): boolean => {
    if (ceiling === undefined) return false;
    if (value === null) { unknown = true; return false; }
    return value > ceiling;
  };
  if (check(budget.tokens, totalTokens(usage))) return "exceeded";
  if (check(budget.toolCalls, usage?.toolCalls ?? null)) return "exceeded";
  return unknown ? "unknown" : "within";
}

/** Chuẩn hoá budget từ input ngoài: số nguyên dương, không thì từ chối; không đặt gì → `null`. */
export function parseBudget(input: { readonly tokens?: number; readonly toolCalls?: number } | undefined): ExecutionBudget | null {
  if (input === undefined) return null;
  const budget: { tokens?: number; toolCalls?: number } = {};
  for (const field of ["tokens", "toolCalls"] as const) {
    const value = input[field];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw new Error(`budget.${field} must be a positive integer, got ${JSON.stringify(value)}`);
    }
    budget[field] = value;
  }
  return Object.keys(budget).length === 0 ? null : budget;
}

/** Tổng của một tập node: `partial` khi có node/cột chưa có số. Cùng hình với `ExecutionTreeView.usage`. */
export interface ExecutionTreeUsageLike {
  readonly total: UsageCounters;
  readonly partial: boolean;
}

export const USAGE_FILE_NAME = "usage.json";

export function usageFile(executionsRoot: string, executionId: string): string {
  return join(executionsRoot, executionId, USAGE_FILE_NAME);
}

export async function readExecutionUsage(executionsRoot: string, executionId: string): Promise<ExecutionUsageV1 | null> {
  let text: string;
  try {
    text = await readFile(usageFile(executionsRoot, executionId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = JSON.parse(text) as ExecutionUsageV1;
  if (parsed.version !== 1) throw new Error(`usage of ${executionId} is not a version 1 record`);
  return parsed;
}

export async function writeExecutionUsage(executionsRoot: string, record: ExecutionUsageV1): Promise<string> {
  return atomicRuntimeFile(usageFile(executionsRoot, record.executionId), `${JSON.stringify(record, null, 2)}\n`);
}

/** Chỉ năm cột, không kéo theo metadata của `ExecutionUsageV1`. */
export function countersOf(usage: UsageCounters | null): UsageCounters | null {
  if (usage === null) return null;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    toolCalls: usage.toolCalls,
  };
}
