import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeId } from "../../agents/types";
import { PIN_MAX_BYTES, readCheckpoint, writeCheckpoint } from "../../context/checkpoint";
import { reduceCompactJournal, replayCompactJournal, rotateCompactJournalIfNeeded } from "../../context/compact-journal";
import { renderContinuity } from "../../context/continuity";
import type { ContinuityCheckpointV1, ContinuityPin } from "../../context/types";
import { atomicRuntimeFile } from "../../runtime/adapter-files";
import { ClaudeRuntimeAdapter } from "../../runtime/claude-adapter";
import { CodexRuntimeAdapter } from "../../runtime/codex-adapter";

const EXECUTION_ID_PATTERN = /^exec_[a-zA-Z0-9_-]+$/;

const PIN_KINDS = ["decision", "constraint", "open-item", "next-action"] as const;
type PinKind = (typeof PIN_KINDS)[number];
type PinField = "decisions" | "constraints" | "openItems" | "nextActions";
const PIN_FIELD: Readonly<Record<PinKind, PinField>> = {
  decision: "decisions",
  constraint: "constraints",
  "open-item": "openItems",
  "next-action": "nextActions",
};

const USAGE = "usage: alp context status|validate [execution-id] | alp context pin <decision|constraint|open-item|next-action> -- <text> | alp context unpin <pin-id>";

export interface ContextCommandDependencies {
  /** `~/.alp/executions` in production — the same root `FileExecutionStore` writes under. */
  readonly executionsRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly write: (text: string) => unknown;
  readonly now?: () => string;
}

interface ContextPaths {
  readonly policyFile: string;
  readonly checkpointFile: string;
  readonly continuityFile: string;
  readonly compactEventsFile: string;
}

function isPinKind(value: string | undefined): value is PinKind {
  return (PIN_KINDS as readonly string[]).includes(value ?? "");
}

/** Positional first, `ALP_DELEGATION_EXECUTION_ID` second — no ambiguous "latest" guess. */
function resolveExecutionId(positional: string | undefined, env: NodeJS.ProcessEnv): string {
  const id = positional || env.ALP_DELEGATION_EXECUTION_ID;
  if (!id) throw new Error(USAGE);
  if (!EXECUTION_ID_PATTERN.test(id)) throw new Error(`invalid execution ID \`${id}\``);
  return id;
}

function contextPaths(executionsRoot: string, executionId: string): ContextPaths {
  const directory = join(executionsRoot, executionId);
  const contextDirectory = join(directory, "context");
  return {
    policyFile: join(directory, "policy.json"),
    checkpointFile: join(contextDirectory, "checkpoint.json"),
    continuityFile: join(contextDirectory, "continuity.md"),
    compactEventsFile: join(contextDirectory, "compact-events.jsonl"),
  };
}

async function readPolicyHash(executionId: string, policyFile: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(policyFile, "utf8");
  } catch (error) {
    throw new Error(`execution \`${executionId}\` not found: ${(error as Error).message}`);
  }
  const parsed = JSON.parse(raw) as { readonly policyHash?: unknown };
  if (typeof parsed.policyHash !== "string" || parsed.policyHash.length === 0) {
    throw new Error(`policy file carries no policyHash: ${policyFile}`);
  }
  return parsed.policyHash;
}

/**
 * Reuses the same pinned capability each adapter already carries rather than keeping a
 * second copy of it here — a version bump that changes `sessionStartAfterCompact` only ever
 * has to be made in one place.
 */
function compactCapabilityFor(runtime: RuntimeId): { readonly sessionStartAfterCompact: boolean } {
  return runtime === "claude" ? new ClaudeRuntimeAdapter().compact : new CodexRuntimeAdapter().compact;
}

async function commandStatus(argv: readonly string[], dependencies: ContextCommandDependencies): Promise<number> {
  const executionId = resolveExecutionId(argv[0], dependencies.env);
  const paths = contextPaths(dependencies.executionsRoot, executionId);
  const policyHash = await readPolicyHash(executionId, paths.policyFile);

  await rotateCompactJournalIfNeeded(paths.compactEventsFile);
  const replay = await replayCompactJournal(paths.compactEventsFile);
  const state = reduceCompactJournal(replay.events);
  const checkpointResult = await readCheckpoint(paths.checkpointFile, { executionId, policyHash });

  const write = dependencies.write;
  write(`EXECUTION  ${executionId}\n`);
  if (checkpointResult.ok) {
    const checkpoint = checkpointResult.value;
    write(`OBJECTIVE  ${checkpoint.objective ?? "(none)"}\n`);
    write(
      `PINS       decisions=${checkpoint.decisions.length} constraints=${checkpoint.constraints.length} `
      + `open-items=${checkpoint.openItems.length} next-actions=${checkpoint.nextActions.length}\n`,
    );
  } else {
    // Fail closed per invariant 6: this is the same reason a runtime would refuse to inject
    // it, surfaced here instead of silently.
    write(`WARNING    checkpoint not usable: ${checkpointResult.reason}\n`);
  }
  write(`GENERATION ${state.generation}\n`);
  write(`PENDING    ${state.pending ? `${state.pending.runtime} ${state.pending.trigger} (started ${state.pending.observedAt})` : "(none)"}\n`);
  write(`COMPLETED  ${state.lastCompleted ? `${state.lastCompleted.runtime} ${state.lastCompleted.trigger} (at ${state.lastCompleted.observedAt})` : "(none)"}\n`);

  const observedRuntime = state.pending?.runtime ?? state.lastCompleted?.runtime ?? null;
  const restore = observedRuntime === null
    ? "unknown — no compaction observed yet"
    : compactCapabilityFor(observedRuntime).sessionStartAfterCompact
      ? "reinjected at the next SessionStart"
      : "next-session (persist-only; this runtime does not reinject)";
  write(`RESTORE    ${restore}\n`);
  if (replay.droppedLines > 0) write(`WARNING    journal has ${replay.droppedLines} line(s) that failed to parse and were skipped\n`);
  return 0;
}

async function commandValidate(argv: readonly string[], dependencies: ContextCommandDependencies): Promise<number> {
  const executionId = resolveExecutionId(argv[0], dependencies.env);
  const paths = contextPaths(dependencies.executionsRoot, executionId);
  const policyHash = await readPolicyHash(executionId, paths.policyFile);

  await rotateCompactJournalIfNeeded(paths.compactEventsFile);
  const replay = await replayCompactJournal(paths.compactEventsFile);
  const state = reduceCompactJournal(replay.events);
  // Reducing twice over the same events is the cheapest possible regression guard for
  // invariant 14 (idempotent lifecycle) — the function is pure, so a mismatch here would mean
  // a real bug, not noise.
  const stable = JSON.stringify(state) === JSON.stringify(reduceCompactJournal(replay.events));
  const checkpointResult = await readCheckpoint(paths.checkpointFile, { executionId, policyHash });

  const write = dependencies.write;
  write(`EXECUTION  ${executionId}\n`);
  write(`CHECKPOINT ${checkpointResult.ok ? "valid" : `INVALID — ${checkpointResult.reason}`}\n`);
  write(`JOURNAL    ${replay.events.length} event(s), ${replay.droppedLines} dropped line(s)\n`);
  write(`REPLAY     ${stable ? "stable" : "UNSTABLE"}\n`);
  write(`GENERATION ${state.generation}\n`);
  return checkpointResult.ok && stable ? 0 : 1;
}

/** A pin is one sentence: control characters (newlines included) collapse to a single space. */
function sanitizePinText(raw: string): string {
  return raw.replace(/[\x00-\x1F\x7F]/g, " ").replace(/\s+/g, " ").trim();
}

async function loadCheckpointForMutation(
  executionId: string,
  paths: ContextPaths,
  action: "pin" | "unpin",
): Promise<ContinuityCheckpointV1> {
  const policyHash = await readPolicyHash(executionId, paths.policyFile);
  const result = await readCheckpoint(paths.checkpointFile, { executionId, policyHash });
  if (!result.ok) throw new Error(`cannot ${action}: ${result.reason}`);
  return result.value;
}

async function persistCheckpoint(
  paths: ContextPaths,
  checkpoint: Omit<ContinuityCheckpointV1, "integrity">,
): Promise<ContinuityCheckpointV1> {
  const written = await writeCheckpoint(paths.checkpointFile, checkpoint);
  await atomicRuntimeFile(paths.continuityFile, renderContinuity(written));
  return written;
}

async function commandPin(argv: readonly string[], dependencies: ContextCommandDependencies): Promise<number> {
  const kind = argv[0];
  if (!isPinKind(kind)) throw new Error(USAGE);
  const separator = argv.indexOf("--");
  if (separator === -1 || separator === argv.length - 1) throw new Error(USAGE);
  const text = sanitizePinText(argv.slice(separator + 1).join(" "));
  if (text.length === 0) throw new Error("pin text is empty after sanitizing control characters");
  if (Buffer.byteLength(text, "utf8") > PIN_MAX_BYTES) throw new Error(`pin text exceeds ${PIN_MAX_BYTES} bytes`);

  const executionId = resolveExecutionId(undefined, dependencies.env);
  const paths = contextPaths(dependencies.executionsRoot, executionId);
  const checkpoint = await loadCheckpointForMutation(executionId, paths, "pin");

  const now = (dependencies.now ?? (() => new Date().toISOString()))();
  const pin: ContinuityPin = {
    id: randomUUID(),
    text,
    source: dependencies.env.ALP_DELEGATED_ROLE ? "agent" : "principal",
    createdAt: now,
  };
  const field = PIN_FIELD[kind];
  await persistCheckpoint(paths, { ...checkpoint, [field]: [...checkpoint[field], pin], updatedAt: now });
  dependencies.write(`PINNED     ${pin.id}\n`);
  return 0;
}

async function commandUnpin(argv: readonly string[], dependencies: ContextCommandDependencies): Promise<number> {
  const pinId = argv[0];
  if (!pinId) throw new Error(USAGE);

  const executionId = resolveExecutionId(undefined, dependencies.env);
  const paths = contextPaths(dependencies.executionsRoot, executionId);
  const checkpoint = await loadCheckpointForMutation(executionId, paths, "unpin");

  let found = false;
  const next: Record<PinField, readonly ContinuityPin[]> = {
    decisions: checkpoint.decisions,
    constraints: checkpoint.constraints,
    openItems: checkpoint.openItems,
    nextActions: checkpoint.nextActions,
  };
  for (const field of Object.keys(next) as PinField[]) {
    const filtered = checkpoint[field].filter((pin) => pin.id !== pinId);
    if (filtered.length !== checkpoint[field].length) found = true;
    next[field] = filtered;
  }
  // Checked before any write: an unknown ID must leave the checkpoint byte-for-byte as it was.
  if (!found) throw new Error(`no pin with ID \`${pinId}\``);

  const now = (dependencies.now ?? (() => new Date().toISOString()))();
  await persistCheckpoint(paths, { ...checkpoint, ...next, updatedAt: now });
  dependencies.write(`UNPINNED   ${pinId}\n`);
  return 0;
}

export async function runContextCommand(
  argv: readonly string[],
  dependencies: ContextCommandDependencies,
): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "status") return commandStatus(rest, dependencies);
  if (sub === "validate") return commandValidate(rest, dependencies);
  if (sub === "pin") return commandPin(rest, dependencies);
  if (sub === "unpin") return commandUnpin(rest, dependencies);
  throw new Error(USAGE);
}
