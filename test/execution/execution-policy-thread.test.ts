import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { agentRegistry } from "../../src/agents/registry";
import type { AgentDefinition } from "../../src/agents/types";
import { createExecutionPolicy, type CreateExecutionPolicyInput } from "../../src/execution/execution-policy";
import { EMPTY_THREAD_CONTEXT_DIGEST } from "../../src/thread/types";

const definition = agentRegistry.get("search") as AgentDefinition<unknown>;

function digest(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

const base: CreateExecutionPolicyInput = {
  executionId: "exec-thread",
  thread: null,
  definition,
  workspace: "/workspace",
  workspaceMode: "read-only",
  createdAt: "2026-09-11T00:00:00.000Z",
};

/**
 * Thread binding nằm **trong** snapshot đã hash. Đó là cái làm cho "chuyển Thread" cho một
 * execution đã tồn tại thành bất khả: đổi binding là đổi hash, và hash là thứ mọi hook so.
 */
describe("execution policy — thread binding", () => {
  it("changes the policy hash when the binding changes, and only then", () => {
    const unthreaded = createExecutionPolicy(base);
    const bound = createExecutionPolicy({
      ...base,
      thread: { id: "thread_a", contextRevision: 0, contextDigest: EMPTY_THREAD_CONTEXT_DIGEST },
    });
    const otherThread = createExecutionPolicy({
      ...base,
      thread: { id: "thread_b", contextRevision: 0, contextDigest: EMPTY_THREAD_CONTEXT_DIGEST },
    });
    const laterRevision = createExecutionPolicy({
      ...base,
      thread: { id: "thread_a", contextRevision: 1, contextDigest: digest("rev-1") },
    });

    expect(bound.thread).toEqual({ id: "thread_a", contextRevision: 0, contextDigest: EMPTY_THREAD_CONTEXT_DIGEST });
    expect(unthreaded.thread).toBeNull();
    const hashes = new Set([unthreaded.policyHash, bound.policyHash, otherThread.policyHash, laterRevision.policyHash]);
    expect(hashes.size).toBe(4);
    // Còn lại của snapshot thì không: binding là provenance, không phải quyền.
    for (const policy of [bound, otherThread, laterRevision]) {
      expect(policy.allowedTools).toEqual(unthreaded.allowedTools);
      expect(policy.delegatesTo).toEqual(unthreaded.delegatesTo);
      expect(policy.workspace).toBe(unthreaded.workspace);
      expect(policy.definitionHash).toBe(unthreaded.definitionHash);
    }
    // Cùng input, cùng hash — binding không kéo theo gì ngẫu nhiên.
    expect(createExecutionPolicy({ ...base, thread: bound.thread }).policyHash).toBe(bound.policyHash);
  });

  /**
   * `canonicalize()` bỏ key `undefined`: một caller quên `thread` sẽ tạo ra policy trùng hash
   * với policy legacy, và lúc đó "không có Thread" và "quên Thread" không phân biệt được nữa.
   * Nên vắng là lỗi, `null` mới là "không có".
   */
  it("rejects a missing binding instead of silently hashing it as unthreaded", () => {
    const { thread: _thread, ...missing } = base;
    expect(() => createExecutionPolicy(missing as CreateExecutionPolicyInput)).toThrowError(/requires `thread`/);
    expect(() => createExecutionPolicy({ ...base, thread: undefined as never })).toThrowError(/requires `thread`/);
  });

  it("rejects a malformed binding", () => {
    for (const thread of [
      { id: "exec_x", contextRevision: 0, contextDigest: EMPTY_THREAD_CONTEXT_DIGEST },
      { id: "thread_a", contextRevision: -1, contextDigest: EMPTY_THREAD_CONTEXT_DIGEST },
      { id: "thread_a", contextRevision: 1.5, contextDigest: EMPTY_THREAD_CONTEXT_DIGEST },
      { id: "thread_a", contextRevision: 0, contextDigest: "abc" },
    ]) {
      expect(() => createExecutionPolicy({ ...base, thread: thread as never })).toThrow();
    }
  });

  it("keeps only the three binding fields in the snapshot", () => {
    const policy = createExecutionPolicy({
      ...base,
      thread: {
        id: "thread_a",
        contextRevision: 0,
        contextDigest: EMPTY_THREAD_CONTEXT_DIGEST,
        allowedTools: ["Bash"],
      } as never,
    });
    expect(policy.thread).toEqual({ id: "thread_a", contextRevision: 0, contextDigest: EMPTY_THREAD_CONTEXT_DIGEST });
    expect(policy.allowedTools).toEqual(createExecutionPolicy(base).allowedTools);
  });
});
