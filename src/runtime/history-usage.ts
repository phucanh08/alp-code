import { NO_USAGE, type UsageCounters } from "../execution/usage";
import { objectOf, stringOf } from "./history-bridge-shared";

/**
 * Đếm token từ transcript của hai runtime (P6). Luật chung, đo ở `research/transcript-usage.md`:
 * cột nào một lần không đọc được thì `null` cho cả lát; lát không có dòng usage nào → `null`
 * (không có số mới, không phải 0). `toolCalls` không đếm ở đây — nó là số entry `tool` của
 * lát, bridge gắn sau.
 */
export interface UsageAccumulator {
  /** Số đã cộng, `null` khi chưa có dòng usage nào trong lát. */
  counters: UsageCounters | null;
}

export function usageAccumulator(): UsageAccumulator {
  return { counters: null };
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function add(acc: UsageAccumulator, delta: Omit<UsageCounters, "toolCalls">): void {
  const previous = acc.counters ?? NO_USAGE;
  const column = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : a + b);
  acc.counters = {
    inputTokens: column(previous.inputTokens, delta.inputTokens),
    outputTokens: column(previous.outputTokens, delta.outputTokens),
    cacheReadTokens: column(previous.cacheReadTokens, delta.cacheReadTokens),
    cacheWriteTokens: column(previous.cacheWriteTokens, delta.cacheWriteTokens),
    toolCalls: 0,
  };
}

/** Kết quả của một lát: cột token đã cộng + số tool call bridge đếm được; `null` khi không có dòng usage. */
export function finishUsage(acc: UsageAccumulator, toolCalls: number): UsageCounters | null {
  return acc.counters === null ? null : { ...acc.counters, toolCalls };
}

// ---------------------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------------------

/**
 * Một API response của Claude nằm trên nhiều dòng `assistant` (mỗi content block một dòng),
 * cùng `message.id` và cùng `usage`. Đếm theo `message.id`; dòng đầu tiên của lát mà
 * `apiBlockIndex > 0` thuộc về một message đã đếm ở lát trước — bỏ. Dòng không có `id`
 * (`isApiErrorMessage`, synthetic) không phải response — không tính, không hạ `null`.
 */
export interface ClaudeUsageState extends UsageAccumulator {
  readonly seen: Set<string>;
  /** `true` cho tới khi gặp dòng assistant đầu tiên của lát. */
  first: boolean;
}

export function claudeUsageState(): ClaudeUsageState {
  return { counters: null, seen: new Set(), first: true };
}

export function collectClaudeUsage(state: ClaudeUsageState, record: Record<string, unknown>, continuing: boolean): void {
  const message = objectOf(record.message);
  if (message === null) return;
  const id = stringOf(message.id);
  const first = state.first;
  state.first = false;
  if (id === null) return;
  if (state.seen.has(id)) return;
  state.seen.add(id);
  if (first && continuing && numberOf(record.apiBlockIndex) !== null && (record.apiBlockIndex as number) > 0) return;
  const usage = objectOf(message.usage);
  add(state, {
    inputTokens: numberOf(usage?.input_tokens),
    outputTokens: numberOf(usage?.output_tokens),
    cacheReadTokens: numberOf(usage?.cache_read_input_tokens),
    cacheWriteTokens: numberOf(usage?.cache_creation_input_tokens),
  });
}

// ---------------------------------------------------------------------------------------
// Codex CLI
// ---------------------------------------------------------------------------------------

/**
 * `event_msg`/`token_count`: `info.last_token_usage` là lượt vừa rồi, `info.total_token_usage`
 * cộng dồn. Cộng `last`; bỏ event có `total` trùng event trước (Codex phát lại lúc
 * `task_complete`); bỏ `info: null`. `input_tokens` của OpenAI gồm cached — tách ra.
 */
export interface CodexUsageState extends UsageAccumulator {
  lastTotal: string | null;
}

export function codexUsageState(): CodexUsageState {
  return { counters: null, lastTotal: null };
}

/** `true` khi payload là `token_count` (đã xử lý, kể cả khi bỏ). */
export function collectCodexUsage(state: CodexUsageState, payload: Record<string, unknown>): boolean {
  if (payload.type !== "token_count") return false;
  const info = objectOf(payload.info);
  if (info === null) return true;
  const total = JSON.stringify(info.total_token_usage ?? null);
  if (state.lastTotal !== null && total === state.lastTotal) return true;
  state.lastTotal = total;
  const last = objectOf(info.last_token_usage);
  const input = numberOf(last?.input_tokens);
  const cached = numberOf(last?.cached_input_tokens);
  add(state, {
    inputTokens: input === null || cached === null ? null : Math.max(0, input - cached),
    outputTokens: numberOf(last?.output_tokens),
    cacheReadTokens: cached,
    cacheWriteTokens: numberOf(last?.cache_write_input_tokens),
  });
  return true;
}
