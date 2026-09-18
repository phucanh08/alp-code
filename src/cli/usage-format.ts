import type { UsageCounters } from "../execution/usage";

/** `in 122 out 53 cache 1110/20 tools 2` — cột bridge không đếm được là `?`, không phải 0. */
export function renderUsage(usage: UsageCounters): string {
  const column = (value: number | null): string => (value === null ? "?" : String(value));
  return `in ${column(usage.inputTokens)} out ${column(usage.outputTokens)} cache ${column(usage.cacheReadTokens)}/${column(usage.cacheWriteTokens)} tools ${column(usage.toolCalls)}`;
}
