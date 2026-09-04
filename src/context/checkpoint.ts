import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { atomicRuntimeFile } from "../runtime/adapter-files";
import type { ContinuityCheckpointV1, ContinuityPin } from "./types";

/** §6 Size limits — one pin, and the checkpoint as a whole, in UTF-8 bytes. */
export const PIN_MAX_BYTES = 4 * 1024;
export const CHECKPOINT_MAX_BYTES = 128 * 1024;

const EXECUTION_ID_PATTERN = /^exec_[a-zA-Z0-9_-]+$/;

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

const continuityPinSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1).refine((value) => byteLength(value) <= PIN_MAX_BYTES, {
    message: `pin text exceeds ${PIN_MAX_BYTES} bytes`,
  }),
  source: z.enum(["execution", "principal", "agent"]),
  createdAt: z.string().min(1),
});

const checkpointSchema = z.object({
  version: z.literal(1),
  executionId: z.string().regex(EXECUTION_ID_PATTERN, "invalid execution ID"),
  policyHash: z.string().min(1),
  runtime: z.enum(["claude", "codex"]).nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  objective: z.string().nullable(),
  decisions: z.array(continuityPinSchema),
  constraints: z.array(continuityPinSchema),
  openItems: z.array(continuityPinSchema),
  nextActions: z.array(continuityPinSchema),
  integrity: z.object({ checkpointSha256: z.string().length(64) }),
}).superRefine((value, ctx) => {
  if (byteLength(JSON.stringify(value)) > CHECKPOINT_MAX_BYTES) {
    ctx.addIssue({ code: "custom", message: `checkpoint exceeds ${CHECKPOINT_MAX_BYTES} bytes` });
  }
});

/**
 * Sort object keys recursively so two checkpoints with the same logical content hash the
 * same regardless of the key order they happen to be written or read in. Arrays keep their
 * order — pins are a sequence, not a set.
 */
function sortForDigest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForDigest);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortForDigest((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** SHA-256 over the checkpoint's canonical JSON, excluding `integrity` itself. */
export function checkpointDigest(checkpoint: Omit<ContinuityCheckpointV1, "integrity">): string {
  return createHash("sha256").update(JSON.stringify(sortForDigest(checkpoint))).digest("hex");
}

export interface SeedCheckpointInput {
  readonly executionId: string;
  readonly policyHash: string;
  /** `capsule.task`, or `null` for an interactive execution — see §8.1 on the sentinel. */
  readonly objective: string | null;
  readonly now?: () => string;
}

/** The checkpoint an execution starts with: no pins, objective seeded from the task. */
export function seedCheckpoint(input: SeedCheckpointInput): ContinuityCheckpointV1 {
  const timestamp = (input.now ?? (() => new Date().toISOString()))();
  const body: Omit<ContinuityCheckpointV1, "integrity"> = {
    version: 1,
    executionId: input.executionId,
    policyHash: input.policyHash,
    runtime: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    objective: input.objective,
    decisions: [],
    constraints: [],
    openItems: [],
    nextActions: [],
  };
  return { ...body, integrity: { checkpointSha256: checkpointDigest(body) } };
}

export interface CheckpointBinding {
  readonly executionId: string;
  readonly policyHash: string;
}

export type CheckpointReadResult =
  | { readonly ok: true; readonly value: ContinuityCheckpointV1 }
  | { readonly ok: false; readonly reason: string };

/**
 * Fail closed (invariant 6): a checkpoint that doesn't parse, doesn't hash, or is bound to a
 * different execution or policy is never returned as usable — the caller gets a reason
 * instead, and decides on its own whether that means "inject nothing" or "abort".
 */
export async function readCheckpoint(path: string, binding: CheckpointBinding): Promise<CheckpointReadResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    return { ok: false, reason: `cannot read checkpoint: ${(error as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "checkpoint is not valid JSON" };
  }
  const result = checkpointSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, reason: `checkpoint failed schema validation: ${result.error.issues[0]?.message ?? "invalid"}` };
  }
  const value = result.data as ContinuityCheckpointV1;
  const { integrity, ...rest } = value;
  if (checkpointDigest(rest) !== integrity.checkpointSha256) {
    return { ok: false, reason: "checkpoint digest mismatch" };
  }
  if (value.executionId !== binding.executionId || value.policyHash !== binding.policyHash) {
    return { ok: false, reason: "checkpoint policy binding mismatch" };
  }
  return { ok: true, value };
}

/**
 * Validates before touching the filesystem at all, so a rejected write (oversize pin,
 * oversize checkpoint) never runs `atomicRuntimeFile` — the file on disk, if any, is left
 * exactly as it was. A write that does reach `atomicRuntimeFile` is itself temp-file-then-
 * rename, so a process killed mid-write leaves the prior file intact too.
 */
export async function writeCheckpoint(
  path: string,
  checkpoint: Omit<ContinuityCheckpointV1, "integrity">,
): Promise<ContinuityCheckpointV1> {
  // Callers often pass a full `ContinuityCheckpointV1` they already have in hand (e.g. a
  // seeded or previously-read one) — TS only checks excess properties on literals, so a
  // stale `integrity` can arrive here at runtime despite the `Omit` type. Strip it before
  // hashing rather than hash whatever happened to be attached.
  const { integrity: _stale, ...body } = checkpoint as ContinuityCheckpointV1;
  const value: ContinuityCheckpointV1 = { ...body, integrity: { checkpointSha256: checkpointDigest(body) } };
  const parsed = checkpointSchema.parse(value) as ContinuityCheckpointV1;
  await atomicRuntimeFile(path, `${JSON.stringify(parsed, null, 2)}\n`);
  return parsed;
}
