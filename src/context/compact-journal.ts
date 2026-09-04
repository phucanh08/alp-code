import { appendFile, readFile, rename, stat } from "node:fs/promises";
import { z } from "zod";
import { normalizeCompactEvent } from "./compact-payload";
import type { CompactEventV1, CompactionStateV1, CompactSource } from "./types";

const EXECUTION_ID_PATTERN = /^exec_[a-zA-Z0-9_-]+$/;

/** §6 size limits. */
export const JOURNAL_LINE_MAX_BYTES = 16 * 1024;
export const JOURNAL_ROTATE_BYTES = 1024 * 1024;

/**
 * One line of `compact-events.jsonl`, exactly as the hook writes it — filtered but not yet
 * normalized. `source` may hold `{ parseError: "..." }` instead of the usual whitelist when
 * the hook's own stdin failed to parse (§8.4 step 2); it is still a valid envelope.
 */
export interface CompactJournalEnvelope {
  readonly v: 1;
  readonly at: string;
  readonly executionId: string;
  readonly policyHash: string;
  readonly runtime: "claude" | "codex";
  readonly phase: "pre" | "post";
  readonly source: Readonly<Record<string, unknown>>;
}

const envelopeSchema = z.object({
  v: z.literal(1),
  at: z.string().min(1),
  executionId: z.string().regex(EXECUTION_ID_PATTERN, "invalid execution ID"),
  policyHash: z.string().min(1),
  runtime: z.enum(["claude", "codex"]),
  phase: z.enum(["pre", "post"]),
  source: z.record(z.string(), z.unknown()),
});

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * The TS append path used by the CLI and by tests. The hook itself (`compact-record.cjs`)
 * is zero-dependency and appends with a raw `appendFileSync` — this reimplements the same
 * one-syscall, `O_APPEND` shape so both writers produce lines the other can replay, without
 * pulling the hook into the dependency graph this module already has (invariant 4).
 */
export async function appendCompactJournalLine(path: string, envelope: CompactJournalEnvelope): Promise<void> {
  const line = `${JSON.stringify(envelope)}\n`;
  if (byteLength(line) > JOURNAL_LINE_MAX_BYTES) {
    throw new Error(`journal line exceeds ${JOURNAL_LINE_MAX_BYTES} bytes`);
  }
  await appendFile(path, line, { encoding: "utf8", mode: 0o600, flag: "a" });
}

/**
 * Rotates `path` to `path.1` (overwriting any prior `.1`) when it has reached
 * `JOURNAL_ROTATE_BYTES`. Called from `alp context status|validate`, never from the hook —
 * the hook only ever appends (invariant 4).
 */
export async function rotateCompactJournalIfNeeded(path: string): Promise<boolean> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return false;
  }
  if (size < JOURNAL_ROTATE_BYTES) return false;
  await rename(path, `${path}.1`);
  return true;
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

export interface CompactJournalReplay {
  readonly events: readonly CompactEventV1[];
  /** Lines that failed to parse or failed schema — replay continues past them. */
  readonly droppedLines: number;
}

/**
 * Reads `path.1` (if rotation has happened) then `path`, in that order, and turns every
 * well-formed line into a `CompactEventV1`. A line that is not valid JSON, or does not match
 * the envelope schema, is dropped and counted rather than failing the whole replay — a
 * single corrupted append (e.g. a process killed mid-write) must not make the rest of the
 * journal unreadable.
 */
export async function replayCompactJournal(path: string): Promise<CompactJournalReplay> {
  const rotated = await readIfExists(`${path}.1`);
  const current = await readIfExists(path);
  const lines = [rotated ?? "", current ?? ""]
    .join("\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const events: CompactEventV1[] = [];
  let droppedLines = 0;
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      droppedLines += 1;
      continue;
    }
    const result = envelopeSchema.safeParse(parsed);
    if (!result.success) {
      droppedLines += 1;
      continue;
    }
    const envelope = result.data;
    const normalized = normalizeCompactEvent({
      runtime: envelope.runtime,
      phase: envelope.phase,
      // `normalizeCompactEvent` treats this as unknown input and filters it against its own
      // per-runtime whitelist; the envelope schema only guarantees an object, not that its
      // values are already strings.
      source: envelope.source as CompactSource,
      observedAt: envelope.at,
    });
    if (!normalized.ok) {
      droppedLines += 1;
      continue;
    }
    events.push(normalized.value);
  }
  return { events: Object.freeze(events), droppedLines };
}

/** The pairing key a `started`/`completed` pair share — `dedupeKey` without its phase suffix. */
function pairKeyOf(event: CompactEventV1): string {
  return event.dedupeKey.slice(0, event.dedupeKey.lastIndexOf("|"));
}

/**
 * Folds a replayed event list into the state `alp context status` reports. Duplicate lines
 * (same `dedupeKey`, e.g. a hook retried by the runtime) are collapsed before anything else,
 * so `generation` counts distinct completions rather than journal lines.
 *
 * `pending` tracks only the single most recent `started` — a later `started` always
 * supersedes an earlier, still-unmatched one (the orphaned-`PreCompact` case measured on
 * Claude 2026-09-04), and a `completed` only clears it when the pairing key actually
 * matches: a late completion for an older event must not clear a newer pending one.
 */
export function reduceCompactJournal(events: readonly CompactEventV1[]): CompactionStateV1 {
  const seenDedupeKeys = new Set<string>();
  let generation = 0;
  let lastCompleted: CompactEventV1 | null = null;
  let pending: CompactEventV1 | null = null;
  let pendingPairKey: string | null = null;

  for (const event of events) {
    if (seenDedupeKeys.has(event.dedupeKey)) continue;
    seenDedupeKeys.add(event.dedupeKey);

    const pairKey = pairKeyOf(event);
    if (event.phase === "started") {
      pending = event;
      pendingPairKey = pairKey;
      continue;
    }
    generation += 1;
    lastCompleted = event;
    if (pairKey === pendingPairKey) {
      pending = null;
      pendingPairKey = null;
    }
  }

  return { generation, pending, lastCompleted };
}
