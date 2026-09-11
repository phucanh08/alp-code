import { createHash } from "node:crypto";
import {
  EMPTY_THREAD_CONTEXT_DIGEST,
  type ThreadDocumentV1,
  type ThreadExecutionRef,
  type ThreadExecutionSettlement,
} from "../../src/thread/types";

export const THREAD_BASE_TIME = "2026-09-11T10:00:00.000Z";

/** Digest giả nhưng đúng hình dạng: 64 hex thường. */
export function digest(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

export function at(offsetSeconds: number): string {
  return new Date(Date.parse(THREAD_BASE_TIME) + offsetSeconds * 1_000).toISOString();
}

export function threadFixture(overrides: Partial<ThreadDocumentV1> = {}): ThreadDocumentV1 {
  return {
    version: 1,
    id: "thread_fixture01",
    agentId: "main",
    workspace: "/project",
    parentThreadId: null,
    title: null,
    status: "open",
    revision: 1,
    currentContext: null,
    messages: [],
    compactions: [],
    executions: [],
    createdAt: THREAD_BASE_TIME,
    updatedAt: THREAD_BASE_TIME,
    ...overrides,
  };
}

export function executionRef(
  executionId: string,
  sequence: number,
  overrides: Partial<ThreadExecutionRef> = {},
): ThreadExecutionRef {
  return {
    executionId,
    sequence,
    contextRevision: 0,
    contextDigest: EMPTY_THREAD_CONTEXT_DIGEST,
    reservedAt: at(sequence),
    settled: null,
    ...overrides,
  };
}

export function settlement(overrides: Partial<ThreadExecutionSettlement> = {}): ThreadExecutionSettlement {
  return { outcome: "completed", finishedAt: at(100), nextContextRevision: null, ...overrides };
}

/** Bản kế tiếp hợp lệ: revision +1, `updatedAt` mới, phần còn lại từ `changes`. */
export function nextThreadRevision(
  thread: ThreadDocumentV1,
  changes: Partial<ThreadDocumentV1> = {},
): ThreadDocumentV1 {
  return { ...thread, ...changes, revision: thread.revision + 1, updatedAt: at(thread.revision + 1) };
}
