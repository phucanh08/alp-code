import { createHash } from "node:crypto";
import type { RuntimeId } from "../agents/types";
import type { ContinuityPin } from "../context/types";
import type { ExecutionId } from "../execution/types";
import { ThreadError } from "./errors";
import { THREAD_ID_PATTERN, THREAD_EXECUTION_OUTCOMES, type ThreadExecutionOutcome, type ThreadId } from "./types";

/**
 * Context của Thread — lớp **giữa** các execution, khác `ContinuityCheckpointV1` là lớp
 * **trong** một execution. Hai lớp không merge: checkpoint thuộc Execution và chết cùng nó;
 * snapshot thuộc Thread, bất biến theo revision, và là thứ duy nhất E-(n+1) nhận từ E-n.
 *
 * Mọi dòng ở đây là **work state, không phải authority**: một pin ghi "bật tool X" vẫn chỉ
 * là text — PolicyEngine không đọc snapshot, và `ExecutionPolicy` của E-(n+1) hash độc lập.
 */
export interface ContextLine {
  readonly text: string;
  /** Execution đã ghi dòng này (pin trong checkpoint của nó, hoặc kết cục của chính nó). */
  readonly sourceExecutionId: ExecutionId;
  /** ID pin gốc trong checkpoint, nếu dòng đến từ một pin. */
  readonly pinId?: string;
}

export interface ThreadContextOutcome {
  readonly executionId: ExecutionId;
  readonly sequence: number;
  readonly outcome: ThreadExecutionOutcome;
  /** `null` khi execution chết trước lúc adapter nào launch nó. */
  readonly runtime: RuntimeId | null;
  readonly finishedAt: string;
}

export interface ThreadContextSnapshotV1 {
  readonly version: 1;
  readonly threadId: ThreadId;
  /** ≥ 1. Revision 0 là "chưa có", không bao giờ có file. */
  readonly revision: number;
  readonly objective: string | null;
  readonly decisions: readonly ContextLine[];
  readonly constraints: readonly ContextLine[];
  readonly openItems: readonly ContextLine[];
  readonly nextActions: readonly ContextLine[];
  readonly outcomes: readonly ThreadContextOutcome[];
  /**
   * `true` khi revision này được chiếu mà không có checkpoint tin được của execution nguồn
   * (mất file, integrity sai): chỉ có outcome, pins của execution đó không bao giờ tới.
   */
  readonly degraded: boolean;
  readonly createdAt: string;
  /** sha256 canonical của snapshot **trừ** field này. Cùng luật với `execution-policy.ts`. */
  readonly digest: string;
}

/**
 * Bản ghi một lần cắt context để giữ trong trần, với provenance đủ để đối chiếu: snapshot
 * nào vào, snapshot nào ra, khoảng message nào đang được tóm.
 */
export interface ThreadCompactionRecordV1 {
  readonly version: 1;
  readonly id: string;
  readonly threadId: ThreadId;
  readonly fromRevision: number;
  readonly toRevision: number;
  readonly droppedCount: number;
  /** Khoảng message (theo `sequence` trong `thread.messages`) mà context này bao. 0 = chưa có. */
  readonly fromMessageSequence: number;
  readonly toMessageSequence: number;
  /** Digest snapshot đầu vào (rev `fromRevision`); digest rỗng khi `fromRevision` = 0. */
  readonly inputDigest: string;
  readonly outputContextRevision: number;
  readonly outputContextDigest: string;
  /** Thread compaction là thuần và tất định — không model, không trộn với native compaction. */
  readonly strategy: "deterministic";
  readonly createdAt: string;
}

/**
 * Những gì một root execution mang theo từ Thread vào `materialize` và session context.
 * Không hash, không cấp quyền — `ExecutionThreadBinding` (trong policy) mới là phần hash.
 */
export interface ThreadContextHandoff {
  readonly threadId: ThreadId;
  /** Root thứ mấy của Thread — `#1` là lần đầu, chưa có gì để tiếp tục. */
  readonly sequence: number;
  readonly title: string | null;
  /** `null` ⇔ binding ở revision 0. */
  readonly snapshot: ThreadContextSnapshotV1 | null;
}

/** Trần kích thước snapshot (bytes JSON). Nội bộ, test tiêm qua projector; không phải config. */
export const THREAD_CONTEXT_MAX_BYTES = 32 * 1024;

const HEX_64 = /^[0-9a-f]{64}$/;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function threadContextDigest(snapshot: Omit<ThreadContextSnapshotV1, "digest">): string {
  const { digest: _ignored, ...body } = snapshot as ThreadContextSnapshotV1;
  return createHash("sha256").update(JSON.stringify(canonicalize(body))).digest("hex");
}

/** Bytes JSON của snapshot — thứ trần `THREAD_CONTEXT_MAX_BYTES` đo. */
export function threadContextBytes(snapshot: Omit<ThreadContextSnapshotV1, "digest">): number {
  return Buffer.byteLength(JSON.stringify(canonicalize(snapshot)), "utf8");
}

function tampered(message: string): never {
  throw new ThreadError("THREAD_CONTEXT_TAMPERED", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertLines(value: unknown, field: string): readonly ContextLine[] {
  if (!Array.isArray(value)) tampered(`${field} must be an array`);
  return value.map((line, index) => {
    if (!isRecord(line)) tampered(`${field}[${index}] must be an object`);
    if (typeof line.text !== "string" || line.text === "") tampered(`${field}[${index}].text must be a non-empty string`);
    if (typeof line.sourceExecutionId !== "string" || line.sourceExecutionId === "") {
      tampered(`${field}[${index}].sourceExecutionId must be a non-empty string`);
    }
    if (line.pinId !== undefined && (typeof line.pinId !== "string" || line.pinId === "")) {
      tampered(`${field}[${index}].pinId must be a non-empty string`);
    }
    return {
      text: line.text,
      sourceExecutionId: line.sourceExecutionId,
      ...(line.pinId === undefined ? {} : { pinId: line.pinId }),
    };
  });
}

function assertOutcomes(value: unknown): readonly ThreadContextOutcome[] {
  if (!Array.isArray(value)) tampered("outcomes must be an array");
  return value.map((entry, index) => {
    const field = `outcomes[${index}]`;
    if (!isRecord(entry)) tampered(`${field} must be an object`);
    if (typeof entry.executionId !== "string" || entry.executionId === "") tampered(`${field}.executionId is invalid`);
    if (typeof entry.sequence !== "number" || !Number.isInteger(entry.sequence) || entry.sequence < 1) {
      tampered(`${field}.sequence must be a positive integer`);
    }
    if (!THREAD_EXECUTION_OUTCOMES.includes(entry.outcome as ThreadExecutionOutcome)) tampered(`${field}.outcome is invalid`);
    if (entry.runtime !== null && entry.runtime !== "claude" && entry.runtime !== "codex") tampered(`${field}.runtime is invalid`);
    if (typeof entry.finishedAt !== "string" || Number.isNaN(Date.parse(entry.finishedAt))) tampered(`${field}.finishedAt is invalid`);
    return {
      executionId: entry.executionId,
      sequence: entry.sequence,
      outcome: entry.outcome as ThreadExecutionOutcome,
      runtime: entry.runtime as RuntimeId | null,
      finishedAt: entry.finishedAt,
    };
  });
}

/**
 * Snapshot đọc từ đĩa phải tự nhất quán **và** khớp digest mà index (hoặc binding) ghi.
 * Lệch ở đâu cũng là `THREAD_CONTEXT_TAMPERED` — không rebuild im lặng, không chấp nhận
 * một nửa: E-(n+1) đọc một dòng bịa còn tệ hơn không đọc gì.
 */
export function assertThreadContextSnapshot(
  value: unknown,
  expected: { readonly threadId: ThreadId; readonly revision: number; readonly digest: string },
): ThreadContextSnapshotV1 {
  if (!isRecord(value)) tampered("context snapshot must be an object");
  if (value.version !== 1) tampered("context snapshot version must be 1");
  if (typeof value.threadId !== "string" || !THREAD_ID_PATTERN.test(value.threadId)) tampered("context snapshot threadId is invalid");
  if (typeof value.revision !== "number" || !Number.isInteger(value.revision) || value.revision < 1) {
    tampered("context snapshot revision must be a positive integer");
  }
  if (value.objective !== null && typeof value.objective !== "string") tampered("context snapshot objective is invalid");
  if (typeof value.degraded !== "boolean") tampered("context snapshot degraded must be a boolean");
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) tampered("context snapshot createdAt is invalid");
  if (typeof value.digest !== "string" || !HEX_64.test(value.digest)) tampered("context snapshot digest is invalid");
  const snapshot: ThreadContextSnapshotV1 = {
    version: 1,
    threadId: value.threadId,
    revision: value.revision,
    objective: value.objective,
    decisions: assertLines(value.decisions, "decisions"),
    constraints: assertLines(value.constraints, "constraints"),
    openItems: assertLines(value.openItems, "openItems"),
    nextActions: assertLines(value.nextActions, "nextActions"),
    outcomes: assertOutcomes(value.outcomes),
    degraded: value.degraded,
    createdAt: value.createdAt,
    digest: value.digest,
  };
  if (threadContextDigest(snapshot) !== snapshot.digest) {
    tampered(`context snapshot ${snapshot.revision} of thread \`${snapshot.threadId}\` does not match its digest`);
  }
  if (snapshot.threadId !== expected.threadId || snapshot.revision !== expected.revision || snapshot.digest !== expected.digest) {
    tampered(
      `context snapshot ${snapshot.revision} of thread \`${snapshot.threadId}\` does not match the index `
      + `(expected revision ${expected.revision} of \`${expected.threadId}\`)`,
    );
  }
  return snapshot;
}

/** Bốn mục pin, cùng tên ở checkpoint và ở snapshot. */
export const CONTEXT_PIN_SECTIONS = ["decisions", "constraints", "openItems", "nextActions"] as const;
export type ContextPinSection = (typeof CONTEXT_PIN_SECTIONS)[number];

/** Nguồn của pin seed từ Thread — projector nhận ra để không promote lại thứ đã có. */
export const THREAD_SEED_PIN_SOURCE: ContinuityPin["source"] = "execution";

/**
 * Pins mà checkpoint của E-(n+1) mở đầu với: đúng các dòng của snapshot rev N, nguồn
 * `execution`, ID tất định theo revision — nên projector của E-(n+1) biết bỏ qua chúng.
 */
export function seedPinsFromSnapshot(
  snapshot: ThreadContextSnapshotV1 | null,
  createdAt: string,
): Readonly<Record<ContextPinSection, readonly ContinuityPin[]>> {
  const empty = { decisions: [], constraints: [], openItems: [], nextActions: [] };
  if (snapshot === null) return empty;
  return Object.fromEntries(CONTEXT_PIN_SECTIONS.map((section) => [
    section,
    snapshot[section].map((line, index) => ({
      id: `thread-${snapshot.revision}-${section}-${index + 1}`,
      text: line.text,
      source: THREAD_SEED_PIN_SOURCE,
      createdAt,
    })),
  ])) as unknown as Record<ContextPinSection, readonly ContinuityPin[]>;
}
