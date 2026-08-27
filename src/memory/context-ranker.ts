import type { MemoryEntry, MemoryQuery } from "./types";

export interface ContextRanker {
  rank(
    entries: readonly MemoryEntry[],
    queries: readonly MemoryQuery[],
  ): readonly MemoryEntry[];
}

function matchScore(entry: MemoryEntry, queries: readonly MemoryQuery[]): number {
  const terms = queries
    .flatMap((query) => query.text?.toLocaleLowerCase().split(/\s+/) ?? [])
    .filter(Boolean);
  if (terms.length === 0) return 0;
  const haystack = `${entry.id}\n${entry.content}`.toLocaleLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

export class DeterministicContextRanker implements ContextRanker {
  rank(
    entries: readonly MemoryEntry[],
    queries: readonly MemoryQuery[],
  ): readonly MemoryEntry[] {
    return [...entries].sort((left, right) => {
      const score = matchScore(right, queries) - matchScore(left, queries);
      return score || right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
    });
  }
}
