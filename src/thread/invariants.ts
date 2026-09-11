import { isAbsolute } from "node:path";
import { ThreadError } from "./errors";
import {
  EMPTY_THREAD_CONTEXT_DIGEST,
  EMPTY_THREAD_CONTEXT_REVISION,
  THREAD_EXECUTION_OUTCOMES,
  THREAD_ID_PATTERN,
  THREAD_STATUSES,
  THREAD_TITLE_MAX_CHARS,
  type ThreadCompactionRef,
  type ThreadContextRef,
  type ThreadDocumentV1,
  type ThreadExecutionOutcome,
  type ThreadExecutionRef,
  type ThreadMessageRef,
  type ThreadStatus,
} from "./types";
import { HISTORY_COMPLETENESS, THREAD_ENTRY_KINDS, type ThreadExecutionHistory } from "./history-types";

const HEX_64 = /^[0-9a-f]{64}$/;

/** Một segment path tương đối: không rỗng, không `.`/`..`, không ký tự lạ. */
const ARTIFACT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Thư mục payload mà một artifact ref được phép trỏ vào. */
export const ARTIFACT_KINDS = ["context", "messages", "compactions"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/**
 * Status chỉ đi một chiều. P1 không có reopen: một Thread đóng rồi mở lại là một Thread
 * mà lịch sử execution của nó có một lỗ không ai giải thích được.
 */
const STATUS_TRANSITIONS: Readonly<Record<ThreadStatus, readonly ThreadStatus[]>> = Object.freeze({
  open: ["closed"],
  closed: ["archived"],
  archived: [],
});

function invalid(message: string): never {
  throw new ThreadError("THREAD_INVARIANT_VIOLATION", message);
}

function assertTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    invalid(`${field} must be an ISO timestamp`);
  }
  return value;
}

function assertNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") invalid(`${field} must be a non-empty string`);
  return value;
}

function assertNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    invalid(`${field} must be a non-negative integer`);
  }
  return value;
}

function assertPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    invalid(`${field} must be a positive integer`);
  }
  return value;
}

function assertHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !HEX_64.test(value)) {
    invalid(`${field} must be a lowercase SHA-256 hex digest`);
  }
  return value;
}

function assertObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function assertArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) invalid(`${field} must be an array`);
  return value;
}

export function assertThreadId(value: unknown, field = "id"): string {
  if (typeof value !== "string" || !THREAD_ID_PATTERN.test(value)) {
    invalid(`${field} must match ${THREAD_ID_PATTERN.source}`);
  }
  return value;
}

/**
 * Invariant 9: artifact ref là path tương đối, nằm trong một thư mục payload của Thread.
 *
 * Kiểm bằng cấu trúc, không bằng `path.resolve`: `resolve` chấp nhận `..` chỉ cần kết quả
 * còn nằm trong root, và `context/../context/1.json` là một ref mà không ai cố ý viết ra.
 * Symlink chỉ file store nhìn thấy, nên nó kiểm ở đó.
 */
export function assertArtifactRef(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) invalid(`${field} must be a non-empty string`);
  if (isAbsolute(value) || value.startsWith("/") || value.includes("\\") || /^[A-Za-z]:/.test(value)) {
    invalid(`${field} must be a relative path inside the thread directory`);
  }
  const segments = value.split("/");
  if (segments.length !== 2) invalid(`${field} must be \`<kind>/<file>\``);
  const [kind, file] = segments as [string, string];
  if (!(ARTIFACT_KINDS as readonly string[]).includes(kind)) {
    invalid(`${field} must live under one of ${ARTIFACT_KINDS.join(", ")}`);
  }
  if (!ARTIFACT_SEGMENT.test(file) || !file.endsWith(".json")) {
    invalid(`${field} names an invalid payload file \`${file}\``);
  }
  return value;
}

export function artifactRefFor(kind: ArtifactKind, name: string): string {
  if (!ARTIFACT_SEGMENT.test(name)) invalid(`payload name \`${name}\` is not a valid file name`);
  return `${kind}/${name}.json`;
}

/** Entry thứ `seq` luôn nằm ở `messages/<seq>.json`. */
export function messageArtifactRef(sequence: number): string {
  return artifactRefFor("messages", String(sequence));
}

/** Snapshot của revision `r` luôn nằm ở `context/<r>.json` — index và đĩa cùng một luật đặt tên. */
export function contextArtifactRef(revision: number): string {
  return artifactRefFor("context", String(revision));
}

function assertContextRef(value: unknown, field: string): ThreadContextRef {
  const ref = assertObject(value, field);
  const revision = assertPositiveInteger(ref.revision, `${field}.revision`);
  assertHash(ref.digest, `${field}.digest`);
  if (assertArtifactRef(ref.artifact, `${field}.artifact`) !== contextArtifactRef(revision)) {
    invalid(`${field}.artifact must be \`${contextArtifactRef(revision)}\``);
  }
  return ref as unknown as ThreadContextRef;
}

function assertMessageRef(value: unknown, index: number): ThreadMessageRef {
  const field = `messages[${index}]`;
  const ref = assertObject(value, field);
  assertNonEmpty(ref.id, `${field}.id`);
  if (ref.sequence !== index + 1) invalid(`${field}.sequence must be ${index + 1}`);
  assertNonEmpty(ref.executionId, `${field}.executionId`);
  if (!(THREAD_ENTRY_KINDS as readonly string[]).includes(ref.kind as string)) {
    invalid(`${field}.kind is unknown: \`${String(ref.kind)}\``);
  }
  if (assertArtifactRef(ref.artifact, `${field}.artifact`) !== messageArtifactRef(index + 1)) {
    invalid(`${field}.artifact must be \`${messageArtifactRef(index + 1)}\``);
  }
  assertHash(ref.digest, `${field}.digest`);
  assertTimestamp(ref.createdAt, `${field}.createdAt`);
  return ref as unknown as ThreadMessageRef;
}

function assertCompactionRef(value: unknown, index: number): ThreadCompactionRef {
  const field = `compactions[${index}]`;
  const ref = assertObject(value, field);
  assertNonEmpty(ref.id, `${field}.id`);
  const from = assertNonNegativeInteger(ref.fromRevision, `${field}.fromRevision`);
  const to = assertPositiveInteger(ref.toRevision, `${field}.toRevision`);
  if (to <= from) invalid(`${field}.toRevision must be greater than fromRevision`);
  assertNonNegativeInteger(ref.droppedCount, `${field}.droppedCount`);
  assertArtifactRef(ref.artifact, `${field}.artifact`);
  assertTimestamp(ref.createdAt, `${field}.createdAt`);
  return ref as unknown as ThreadCompactionRef;
}

function assertExecutionRef(value: unknown, index: number, contextRevision: number): ThreadExecutionRef {
  const field = `executions[${index}]`;
  const ref = assertObject(value, field);
  assertNonEmpty(ref.executionId, `${field}.executionId`);
  // Invariant 3: sequence liên tục 1..n, suy ra từ vị trí chứ không từ số tự khai.
  if (ref.sequence !== index + 1) invalid(`${field}.sequence must be ${index + 1}`);
  const revision = assertNonNegativeInteger(ref.contextRevision, `${field}.contextRevision`);
  const digest = assertHash(ref.contextDigest, `${field}.contextDigest`);
  // Invariant 8: một execution không thể đã nhìn thấy revision mà Thread chưa có.
  if (revision > contextRevision) {
    invalid(`${field}.contextRevision ${revision} exceeds the thread context revision ${contextRevision}`);
  }
  if (revision === EMPTY_THREAD_CONTEXT_REVISION && digest !== EMPTY_THREAD_CONTEXT_DIGEST) {
    invalid(`${field}.contextDigest must be the empty-context digest when contextRevision is 0`);
  }
  assertTimestamp(ref.reservedAt, `${field}.reservedAt`);
  if (ref.settled !== null) {
    const settled = assertObject(ref.settled, `${field}.settled`);
    if (!THREAD_EXECUTION_OUTCOMES.includes(settled.outcome as ThreadExecutionOutcome)) {
      invalid(`${field}.settled.outcome is unknown: \`${String(settled.outcome)}\``);
    }
    assertTimestamp(settled.finishedAt, `${field}.settled.finishedAt`);
    if (settled.nextContextRevision !== null) {
      const next = assertPositiveInteger(settled.nextContextRevision, `${field}.settled.nextContextRevision`);
      if (next > contextRevision) {
        invalid(`${field}.settled.nextContextRevision ${next} exceeds the thread context revision ${contextRevision}`);
      }
    }
  }
  if (ref.history !== undefined && ref.history !== null) assertExecutionHistory(ref.history, `${field}.history`);
  return ref as unknown as ThreadExecutionRef;
}

function assertExecutionHistory(value: unknown, field: string): ThreadExecutionHistory {
  const history = assertObject(value, field);
  if (!(HISTORY_COMPLETENESS as readonly string[]).includes(history.completeness as string)) {
    invalid(`${field}.completeness is unknown: \`${String(history.completeness)}\``);
  }
  if (history.pinnedVersion !== null) assertNonEmpty(history.pinnedVersion, `${field}.pinnedVersion`);
  if (history.cursor !== null) {
    const cursor = assertObject(history.cursor, `${field}.cursor`);
    assertNonEmpty(cursor.transcriptPath, `${field}.cursor.transcriptPath`);
    assertNonNegativeInteger(cursor.lineOffset, `${field}.cursor.lineOffset`);
    if (cursor.lastNativeId !== null) assertNonEmpty(cursor.lastNativeId, `${field}.cursor.lastNativeId`);
  }
  assertNonNegativeInteger(history.entryCount, `${field}.entryCount`);
  assertNonNegativeInteger(history.skipped, `${field}.skipped`);
  assertTimestamp(history.collectedAt, `${field}.collectedAt`);
  return history as unknown as ThreadExecutionHistory;
}

/**
 * Hình dạng hợp lệ của một Thread, đọc từ đâu cũng vậy.
 *
 * Ném `THREAD_INVARIANT_VIOLATION`; store đọc từ đĩa bọc lại thành `THREAD_STORE_CORRUPT`
 * vì với nó câu hỏi khác: không phải "caller đưa gì sai" mà "file này còn tin được không".
 */
export function assertThreadDocument(value: unknown): ThreadDocumentV1 {
  const thread = assertObject(value, "thread");
  if (thread.version !== 1) invalid(`unsupported thread version \`${String(thread.version)}\``);
  const id = assertThreadId(thread.id);
  assertNonEmpty(thread.agentId, "agentId");
  const workspace = assertNonEmpty(thread.workspace, "workspace");
  if (!isAbsolute(workspace)) invalid("workspace must be an absolute path");
  if (thread.parentThreadId !== null) {
    // Invariant 6: parent là lineage, và một Thread không thể là tổ tiên của chính nó.
    if (assertThreadId(thread.parentThreadId, "parentThreadId") === id) {
      invalid("parentThreadId must not equal id");
    }
  }
  if (thread.title !== null) {
    const title = assertNonEmpty(thread.title, "title");
    if (title.length > THREAD_TITLE_MAX_CHARS) invalid(`title exceeds ${THREAD_TITLE_MAX_CHARS} characters`);
  }
  if (!THREAD_STATUSES.includes(thread.status as ThreadStatus)) {
    invalid(`unknown thread status \`${String(thread.status)}\``);
  }
  assertPositiveInteger(thread.revision, "revision");
  const context = thread.currentContext === null ? null : assertContextRef(thread.currentContext, "currentContext");
  const contextRevision = context?.revision ?? EMPTY_THREAD_CONTEXT_REVISION;

  assertArray(thread.messages, "messages").forEach(assertMessageRef);
  const compactions = assertArray(thread.compactions, "compactions").map(assertCompactionRef);
  if (new Set(compactions.map((ref) => ref.id)).size !== compactions.length) {
    invalid("compactions must not repeat an id");
  }

  const executions = assertArray(thread.executions, "executions")
    .map((ref, index) => assertExecutionRef(ref, index, contextRevision));
  if (new Set(executions.map((ref) => ref.executionId)).size !== executions.length) {
    invalid("executions must not repeat an executionId");
  }
  // Invariant 4: tối đa một ref chưa settled — và nó phải là ref cuối, vì không có gì
  // được reserve trong lúc một root khác còn mở.
  const unsettled = executions.filter((ref) => ref.settled === null);
  if (unsettled.length > 1) invalid("at most one execution may be unsettled");
  if (unsettled.length === 1 && unsettled[0] !== executions[executions.length - 1]) {
    invalid("the unsettled execution must be the latest one");
  }
  if (unsettled.length === 1 && thread.status !== "open") {
    invalid(`a ${String(thread.status)} thread must not hold an unsettled execution`);
  }
  assertTimestamp(thread.createdAt, "createdAt");
  assertTimestamp(thread.updatedAt, "updatedAt");
  return thread as unknown as ThreadDocumentV1;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Một lần ghi có được thành sự thật không, so với bản trước nó.
 *
 * `assertThreadDocument` nói "bản này tự nó hợp lệ"; hàm này nói "từ bản trước đi tới bản
 * này là hợp lệ" — hai câu khác nhau, và câu sau là nơi lost update, reopen, hay một
 * settlement bị viết lại lộ ra.
 */
export function validateThreadWrite(previous: ThreadDocumentV1, next: ThreadDocumentV1): ThreadDocumentV1 {
  // Invariant 7 kiểm trước hình dạng: "Thread này đã đóng" là câu trả lời có ích hơn
  // "document không hợp lệ" khi caller cố reserve vào một Thread đã closed.
  if (previous.status === "closed" && Array.isArray(next.executions) && next.executions.length > previous.executions.length) {
    throw new ThreadError("THREAD_CLOSED", `thread \`${previous.id}\` is closed and accepts no new executions`);
  }
  if (previous.status === "archived" && !onlyTitleChanged(previous, next)) {
    throw new ThreadError("THREAD_ARCHIVED", `thread \`${previous.id}\` is archived and only accepts a new title`);
  }
  const document = assertThreadDocument(next);
  if (document.id !== previous.id) {
    invalid(`lease on \`${previous.id}\` cannot write thread \`${document.id}\``);
  }
  // Invariant 2.
  if (document.revision !== previous.revision + 1) {
    throw new ThreadError(
      "THREAD_REVISION_CONFLICT",
      `expected revision ${previous.revision + 1} for thread \`${previous.id}\`, received ${document.revision}`,
    );
  }
  // Invariant 1.
  for (const field of ["agentId", "workspace", "parentThreadId", "createdAt"] as const) {
    if (document[field] !== previous[field]) invalid(`${field} is immutable`);
  }
  if (document.status !== previous.status && !STATUS_TRANSITIONS[previous.status].includes(document.status)) {
    invalid(`thread \`${previous.id}\` cannot move from \`${previous.status}\` to \`${document.status}\``);
  }
  assertExecutionsPreserved(previous, document);
  assertPrefixPreserved(previous.messages, document.messages, "messages");
  assertPrefixPreserved(previous.compactions, document.compactions, "compactions");
  // Invariant 8: context không quay lui, và không "đổi nội dung" một revision đã có.
  if (previous.currentContext !== null) {
    if (document.currentContext === null) invalid("currentContext cannot return to null");
    if (document.currentContext.revision < previous.currentContext.revision) {
      invalid("currentContext.revision must not decrease");
    }
    if (
      document.currentContext.revision === previous.currentContext.revision &&
      !sameJson(document.currentContext, previous.currentContext)
    ) {
      invalid("currentContext cannot change without a new revision");
    }
  }
  return document;
}

function onlyTitleChanged(previous: ThreadDocumentV1, next: ThreadDocumentV1): boolean {
  const strip = (thread: ThreadDocumentV1): unknown => {
    const { title: _title, revision: _revision, updatedAt: _updatedAt, ...rest } = thread;
    return rest;
  };
  return sameJson(strip(previous), strip(next));
}

function assertExecutionsPreserved(previous: ThreadDocumentV1, next: ThreadDocumentV1): void {
  if (next.executions.length < previous.executions.length) invalid("executions cannot be removed");
  previous.executions.forEach((before, index) => {
    const after = next.executions[index]!;
    for (const field of ["executionId", "sequence", "contextRevision", "contextDigest", "reservedAt"] as const) {
      if (after[field] !== before[field]) {
        invalid(`executions[${index}].${field} is immutable once reserved`);
      }
    }
    // Invariant 5: settled ghi một lần. Ngoại lệ duy nhất là `nextContextRevision`: projection
    // chạy **sau** settle dưới lease riêng, nên `null → n` là bước thứ hai của cùng một lần
    // settle, không phải viết lại kết cục.
    if (before.settled !== null) {
      if (after.settled === null) invalid(`executions[${index}] cannot be unsettled`);
      if (before.settled.outcome !== after.settled.outcome || before.settled.finishedAt !== after.settled.finishedAt) {
        invalid(`executions[${index}] is already settled`);
      }
      if (
        before.settled.nextContextRevision !== null
        && before.settled.nextContextRevision !== after.settled.nextContextRevision
      ) {
        invalid(`executions[${index}] already projected revision ${before.settled.nextContextRevision}`);
      }
    }
  });
}

function assertPrefixPreserved(previous: readonly unknown[], next: readonly unknown[], field: string): void {
  if (next.length < previous.length) invalid(`${field} cannot be removed`);
  previous.forEach((before, index) => {
    if (!sameJson(before, next[index])) invalid(`${field}[${index}] is immutable`);
  });
}
