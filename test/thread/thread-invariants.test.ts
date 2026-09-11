import { describe, expect, it } from "vitest";
import { isThreadError } from "../../src/thread/errors";
import { assertArtifactRef, assertThreadDocument, validateThreadWrite } from "../../src/thread/invariants";
import { EMPTY_THREAD_CONTEXT_DIGEST } from "../../src/thread/types";
import { at, digest, executionRef, nextThreadRevision, settlement, threadFixture } from "../support/thread-fixture";

function codeOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    if (isThreadError(error)) return error.code;
    throw error;
  }
}

const context = (revision: number) => ({ revision, digest: digest(`ctx-${revision}`), artifact: `context/${revision}.json` });

describe("thread document invariants", () => {
  it("accepts the shapes the store will actually write", () => {
    expect(codeOf(() => assertThreadDocument(threadFixture()))).toBeNull();
    expect(codeOf(() => assertThreadDocument(threadFixture({
      title: "Fix login",
      parentThreadId: "thread_parent",
      currentContext: context(2),
      executions: [
        executionRef("exec_1", 1, { settled: settlement({ nextContextRevision: 1 }) }),
        executionRef("exec_2", 2, { contextRevision: 1, contextDigest: digest("ctx-1"), settled: settlement({ nextContextRevision: 2 }) }),
        executionRef("exec_3", 3, { contextRevision: 2, contextDigest: digest("ctx-2") }),
      ],
      compactions: [{ id: "c1", fromRevision: 1, toRevision: 2, droppedCount: 3, artifact: "compactions/c1.json", createdAt: at(5) }],
      messages: [{ id: "m1", sequence: 1, executionId: "exec_1", kind: "assistant", artifact: "messages/1.json", digest: digest("m1"), createdAt: at(6) }],
    })))).toBeNull();
  });

  it("rejects structurally corrupt documents instead of repairing them (invariant 10)", () => {
    for (const broken of [
      null,
      "thread",
      { ...threadFixture(), version: 2 },
      { ...threadFixture(), id: "not-a-thread" },
      { ...threadFixture(), id: "thread_a/../b" },
      { ...threadFixture(), agentId: "" },
      { ...threadFixture(), workspace: "relative" },
      { ...threadFixture(), status: "paused" },
      { ...threadFixture(), revision: 0 },
      { ...threadFixture(), title: "x".repeat(201) },
      { ...threadFixture(), executions: "none" },
      { ...threadFixture(), createdAt: "yesterday" },
    ]) {
      expect(codeOf(() => assertThreadDocument(broken))).toBe("THREAD_INVARIANT_VIOLATION");
    }
  });

  it("forbids a thread parenting itself (invariant 6)", () => {
    expect(codeOf(() => assertThreadDocument(threadFixture({ parentThreadId: "thread_fixture01" })))).toBe("THREAD_INVARIANT_VIOLATION");
    expect(codeOf(() => assertThreadDocument(threadFixture({ parentThreadId: "../thread_x" })))).toBe("THREAD_INVARIANT_VIOLATION");
  });

  it("keeps executions contiguous, unique and at most one unsettled (invariants 3, 4)", () => {
    const cases: Array<readonly ReturnType<typeof executionRef>[]> = [
      [executionRef("exec_1", 2)],
      [executionRef("exec_1", 1), executionRef("exec_2", 3, { settled: settlement() })],
      [executionRef("exec_1", 1, { settled: settlement() }), executionRef("exec_1", 2)],
      [executionRef("exec_1", 1), executionRef("exec_2", 2)],
      // Ref mở phải là ref cuối: không có gì được reserve sau nó.
      [executionRef("exec_1", 1), executionRef("exec_2", 2, { settled: settlement() })],
    ];
    for (const executions of cases) {
      expect(codeOf(() => assertThreadDocument(threadFixture({ executions })))).toBe("THREAD_INVARIANT_VIOLATION");
    }
    expect(codeOf(() => assertThreadDocument(threadFixture({
      status: "closed",
      executions: [executionRef("exec_1", 1)],
    })))).toBe("THREAD_INVARIANT_VIOLATION");
  });

  it("ties execution context refs to what the thread actually has (invariant 8)", () => {
    // Revision 0 phải đi cùng digest rỗng, và không ref nào nhìn thấy revision chưa tồn tại.
    expect(codeOf(() => assertThreadDocument(threadFixture({
      executions: [executionRef("exec_1", 1, { contextDigest: digest("something") })],
    })))).toBe("THREAD_INVARIANT_VIOLATION");
    expect(codeOf(() => assertThreadDocument(threadFixture({
      executions: [executionRef("exec_1", 1, { contextRevision: 1, contextDigest: digest("ctx-1") })],
    })))).toBe("THREAD_INVARIANT_VIOLATION");
    expect(codeOf(() => assertThreadDocument(threadFixture({
      currentContext: context(1),
      executions: [executionRef("exec_1", 1, { settled: settlement({ nextContextRevision: 2 }) })],
    })))).toBe("THREAD_INVARIANT_VIOLATION");
    expect(codeOf(() => assertThreadDocument(threadFixture({
      currentContext: { ...context(1), artifact: "context/2.json" },
    })))).toBe("THREAD_INVARIANT_VIOLATION");
    expect(EMPTY_THREAD_CONTEXT_DIGEST).toMatch(/^[0-9a-f]{64}$/);
  });

  it("only accepts artifact refs that stay inside the thread directory (invariant 9)", () => {
    for (const ref of [
      "/etc/passwd",
      "C:\\alp\\x.json",
      "context\\1.json",
      "../thread_other/context/1.json",
      "context/../../x.json",
      "context/./1.json",
      "context/.hidden.json",
      "context/1",
      "context/1.json/extra",
      "secrets/1.json",
      "context",
      "",
    ]) {
      expect(codeOf(() => assertArtifactRef(ref, "ref")), ref).toBe("THREAD_INVARIANT_VIOLATION");
    }
    expect(assertArtifactRef("context/1.json", "ref")).toBe("context/1.json");
    expect(assertArtifactRef("messages/12.json", "ref")).toBe("messages/12.json");
    expect(assertArtifactRef("compactions/cmp_a-b.json", "ref")).toBe("compactions/cmp_a-b.json");
  });

  it("validates message and compaction refs", () => {
    expect(codeOf(() => assertThreadDocument(threadFixture({
      messages: [{ id: "m1", sequence: 2, executionId: "exec_1", kind: "assistant", artifact: "messages/2.json", digest: digest("m"), createdAt: at(1) }],
    })))).toBe("THREAD_INVARIANT_VIOLATION");
    expect(codeOf(() => assertThreadDocument(threadFixture({
      compactions: [{ id: "c1", fromRevision: 2, toRevision: 2, droppedCount: 0, artifact: "compactions/c1.json", createdAt: at(1) }],
    })))).toBe("THREAD_INVARIANT_VIOLATION");
    expect(codeOf(() => assertThreadDocument(threadFixture({
      compactions: [
        { id: "c1", fromRevision: 1, toRevision: 2, droppedCount: 0, artifact: "compactions/c1.json", createdAt: at(1) },
        { id: "c1", fromRevision: 2, toRevision: 3, droppedCount: 0, artifact: "compactions/c2.json", createdAt: at(2) },
      ],
    })))).toBe("THREAD_INVARIANT_VIOLATION");
  });
});

describe("thread write validation", () => {
  it("requires revision to advance by exactly one (invariant 2)", () => {
    const previous = threadFixture();
    expect(codeOf(() => validateThreadWrite(previous, { ...previous, title: "x" }))).toBe("THREAD_REVISION_CONFLICT");
    expect(codeOf(() => validateThreadWrite(previous, { ...nextThreadRevision(previous), revision: 3 }))).toBe("THREAD_REVISION_CONFLICT");
    expect(validateThreadWrite(previous, nextThreadRevision(previous, { title: "x" })).revision).toBe(2);
  });

  it("keeps identity immutable (invariant 1)", () => {
    const previous = threadFixture({ parentThreadId: "thread_parent" });
    for (const change of [
      { agentId: "reviewer" },
      { workspace: "/other" },
      { parentThreadId: null },
      { createdAt: at(9) },
      { id: "thread_other" },
    ]) {
      expect(codeOf(() => validateThreadWrite(previous, nextThreadRevision(previous, change)))).toBe("THREAD_INVARIANT_VIOLATION");
    }
  });

  it("never rewrites a settlement, and never drops history (invariant 5)", () => {
    const previous = threadFixture({
      currentContext: context(1),
      executions: [executionRef("exec_1", 1, { settled: settlement({ outcome: "completed", nextContextRevision: 1 }) })],
      compactions: [{ id: "c1", fromRevision: 0, toRevision: 1, droppedCount: 0, artifact: "compactions/c1.json", createdAt: at(1) }],
    });
    expect(codeOf(() => validateThreadWrite(previous, nextThreadRevision(previous, {
      executions: [executionRef("exec_1", 1, { settled: settlement({ outcome: "failed", nextContextRevision: 1 }) })],
    })))).toBe("THREAD_INVARIANT_VIOLATION");
    expect(codeOf(() => validateThreadWrite(previous, nextThreadRevision(previous, {
      executions: [executionRef("exec_1", 1, { settled: null })],
    })))).toBe("THREAD_INVARIANT_VIOLATION");
    expect(codeOf(() => validateThreadWrite(previous, nextThreadRevision(previous, {
      executions: [executionRef("exec_1", 1, { reservedAt: at(50), settled: previous.executions[0]!.settled })],
    })))).toBe("THREAD_INVARIANT_VIOLATION");
    expect(codeOf(() => validateThreadWrite(previous, nextThreadRevision(previous, { executions: [] })))).toBe("THREAD_INVARIANT_VIOLATION");
    expect(codeOf(() => validateThreadWrite(previous, nextThreadRevision(previous, { compactions: [] })))).toBe("THREAD_INVARIANT_VIOLATION");
    // Ghi lại y nguyên settlement là hợp lệ — nó không đổi.
    expect(codeOf(() => validateThreadWrite(previous, nextThreadRevision(previous, { title: "t" })))).toBeNull();
  });

  it("walks status one way and narrows what closed/archived accept (invariant 7)", () => {
    const open = threadFixture();
    expect(codeOf(() => validateThreadWrite(open, nextThreadRevision(open, { status: "archived" })))).toBe("THREAD_INVARIANT_VIOLATION");
    const closed = validateThreadWrite(open, nextThreadRevision(open, { status: "closed" }));
    expect(codeOf(() => validateThreadWrite(closed, nextThreadRevision(closed, { status: "open" })))).toBe("THREAD_INVARIANT_VIOLATION");
    expect(codeOf(() => validateThreadWrite(closed, nextThreadRevision(closed, {
      executions: [executionRef("exec_1", 1, { settled: settlement() })],
    })))).toBe("THREAD_CLOSED");
    const archived = validateThreadWrite(closed, nextThreadRevision(closed, { status: "archived" }));
    expect(codeOf(() => validateThreadWrite(archived, nextThreadRevision(archived, { title: "still ok" })))).toBeNull();
    expect(codeOf(() => validateThreadWrite(archived, nextThreadRevision(archived, { status: "closed" })))).toBe("THREAD_ARCHIVED");
    expect(codeOf(() => validateThreadWrite(archived, nextThreadRevision(archived, {
      currentContext: context(1),
    })))).toBe("THREAD_ARCHIVED");
  });

  it("keeps the context revision monotonic (invariant 8)", () => {
    const previous = threadFixture({ currentContext: context(2) });
    expect(codeOf(() => validateThreadWrite(previous, nextThreadRevision(previous, { currentContext: null })))).toBe("THREAD_INVARIANT_VIOLATION");
    expect(codeOf(() => validateThreadWrite(previous, nextThreadRevision(previous, { currentContext: context(1) })))).toBe("THREAD_INVARIANT_VIOLATION");
    expect(codeOf(() => validateThreadWrite(previous, nextThreadRevision(previous, {
      currentContext: { ...context(2), digest: digest("rewritten") },
    })))).toBe("THREAD_INVARIANT_VIOLATION");
    expect(validateThreadWrite(previous, nextThreadRevision(previous, { currentContext: context(3) })).currentContext?.revision).toBe(3);
  });
});
