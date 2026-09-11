import type { CollectedEntry } from "../thread/history-types";
import { HISTORY_TEXT_MAX_BYTES, HISTORY_TOOL_SUMMARY_MAX_BYTES } from "../thread/history-types";
import { redactDeep, sanitizeText } from "../thread/history-redact";

/** Đọc một dòng JSONL; hỏng → `null` (caller đếm `skipped`). */
export function parseLine(line: string): Record<string, unknown> | null {
  if (line.trim() === "") return null;
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function stringOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function messageText(text: string): string {
  return sanitizeText(text, HISTORY_TEXT_MAX_BYTES);
}

/**
 * Summary của tool call: tên + phần đầu của input, đã redact và cắt. Raw args không bao giờ
 * đi xa hơn hàm này.
 */
export function toolSummary(name: string, input: unknown): string {
  const body = typeof input === "string" ? input : JSON.stringify(redactDeep(input ?? null));
  return sanitizeText(`${name} ${body ?? ""}`.trim(), HISTORY_TOOL_SUMMARY_MAX_BYTES);
}

/** Đường dẫn `*** Add|Update|Delete File: <path>` trong một patch kiểu `apply_patch`. */
export function patchPaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) paths.add(match[1].trim());
  return [...paths];
}

export interface EntryAccumulator {
  readonly entries: CollectedEntry[];
  skipped: number;
  lastNativeId: string | null;
  /** callId → index của entry tool, để `is_error` của result cùng lô đánh dấu ngược lên. */
  readonly pendingTools: Map<string, number>;
}

export function accumulator(): EntryAccumulator {
  return { entries: [], skipped: 0, lastNativeId: null, pendingTools: new Map() };
}

export function push(acc: EntryAccumulator, entry: CollectedEntry): void {
  acc.entries.push(entry);
  if (entry.nativeId !== null) acc.lastNativeId = entry.nativeId;
}

export function markToolError(acc: EntryAccumulator, callId: string | null): void {
  if (callId === null) return;
  const index = acc.pendingTools.get(callId);
  if (index === undefined) return;
  const entry = acc.entries[index];
  if (entry.kind === "tool") acc.entries[index] = { ...entry, isError: true };
}
