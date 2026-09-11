import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isThreadError } from "../../src/thread/errors";
import type { ThreadStore } from "../../src/thread/thread-store";
import { EMPTY_THREAD_CONTEXT_DIGEST, EMPTY_THREAD_CONTEXT_REVISION } from "../../src/thread/types";
import { digest, executionRef, nextThreadRevision, settlement } from "../support/thread-fixture";

/**
 * Hành vi mọi thread store nợ caller của nó, chạy trên từng implementation.
 *
 * Viết một lần vì bản in-memory tồn tại để thế chỗ bản file, và một bản thế chỗ lặng lẽ
 * khác ý về revision conflict hay snapshot đóng băng thì tệ hơn không có: suite nhanh xanh
 * trên một hợp đồng mà store bền vững chưa từng có. Thứ thật sự thuộc filesystem — mode,
 * khoá, symlink, file hỏng — nằm ở suite riêng của bản file.
 */
export function describeThreadStore(
  name: string,
  createStore: () => Promise<{ store: ThreadStore; cleanup: () => Promise<void> }>,
): void {
  describe(`${name} (thread store contract)`, () => {
    let store: ThreadStore;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      ({ store, cleanup } = await createStore());
    });

    afterEach(async () => {
      await cleanup();
    });

    async function codeOf(run: () => Promise<unknown>): Promise<string | null> {
      try {
        await run();
        return null;
      } catch (error) {
        if (isThreadError(error)) return error.code;
        throw error;
      }
    }

    const create = (overrides: { id?: string; title?: string | null; workspace?: string; parentThreadId?: string | null } = {}) =>
      store.create({ agentId: "main", workspace: "/project", createdAt: "2026-09-11T10:00:00.000Z", ...overrides });

    it("creates an empty open thread and reads it back unchanged", async () => {
      const created = await create({ title: "Fix login" });
      expect(created).toMatchObject({
        version: 1,
        agentId: "main",
        workspace: "/project",
        parentThreadId: null,
        title: "Fix login",
        status: "open",
        revision: 1,
        currentContext: null,
        messages: [],
        compactions: [],
        executions: [],
        createdAt: "2026-09-11T10:00:00.000Z",
        updatedAt: "2026-09-11T10:00:00.000Z",
      });
      expect(created.id).toMatch(/^thread_[A-Za-z0-9]+$/);
      expect(await store.get(created.id)).toEqual(created);
      expect(await store.get("thread_missing")).toBeNull();
    });

    it("refuses to create the same thread twice", async () => {
      await create({ id: "thread_dup" });
      expect(await codeOf(() => create({ id: "thread_dup" }))).toBe("THREAD_EXISTS");
    });

    it("rejects an invalid thread before it becomes durable state", async () => {
      expect(await codeOf(() => create({ id: "thread_bad", workspace: "relative/path" }))).toBe("THREAD_INVARIANT_VIOLATION");
      expect(await codeOf(() => create({ id: "bad id" }))).toBe("THREAD_INVARIANT_VIOLATION");
      expect(await codeOf(() => create({ id: "thread_bad", title: "" }))).toBe("THREAD_INVARIANT_VIOLATION");
      expect(await store.get("thread_bad")).toBeNull();
    });

    it("rejects an ID that could leave the store before touching anything", async () => {
      for (const id of ["../thread_x", "thread_x/..", "thread_x/../thread_y", ".", "", "thread_x\\y"]) {
        expect(await codeOf(() => store.get(id))).toBe("THREAD_INVARIANT_VIOLATION");
        expect(await codeOf(() => store.withExclusiveLease(id, async () => undefined))).toBe("THREAD_INVARIANT_VIOLATION");
      }
    });

    it("requires a supplied parent to exist, and forbids a thread parenting itself", async () => {
      expect(await codeOf(() => create({ id: "thread_child", parentThreadId: "thread_nope" }))).toBe("THREAD_NOT_FOUND");
      expect(await store.get("thread_child")).toBeNull();
      expect(await codeOf(() => create({ id: "thread_self", parentThreadId: "thread_self" }))).toBe("THREAD_INVARIANT_VIOLATION");
      await create({ id: "thread_parent" });
      const child = await create({ id: "thread_child", parentThreadId: "thread_parent" });
      expect(child.parentThreadId).toBe("thread_parent");
    });

    it("lists summaries newest first, filtered by workspace and status", async () => {
      await create({ id: "thread_a", workspace: "/project" });
      await create({ id: "thread_b", workspace: "/other" });
      await create({ id: "thread_c", workspace: "/project", title: "closed one" });
      await store.withExclusiveLease("thread_c", async (lease) => {
        await lease.commit(nextThreadRevision(lease.current(), { status: "closed" }));
      });
      await store.withExclusiveLease("thread_a", async (lease) => {
        await lease.commit(nextThreadRevision(lease.current(), { title: "touched last" }));
      });

      const all = await store.list();
      expect(all.map((summary) => summary.id)).toEqual(["thread_a", "thread_c", "thread_b"]);
      expect(all[0]).toEqual({
        id: "thread_a",
        agentId: "main",
        workspace: "/project",
        parentThreadId: null,
        title: "touched last",
        status: "open",
        revision: 2,
        contextRevision: EMPTY_THREAD_CONTEXT_REVISION,
        executionCount: 0,
        unsettledExecutionId: null,
        createdAt: "2026-09-11T10:00:00.000Z",
        updatedAt: expect.any(String),
      });
      expect((await store.list({ workspace: "/project" })).map((summary) => summary.id)).toEqual(["thread_a", "thread_c"]);
      expect((await store.list({ workspace: "/project", status: "open" })).map((summary) => summary.id)).toEqual(["thread_a"]);
      expect((await store.list({ status: "archived" }))).toEqual([]);
    });

    it("commits a next revision under the lease, and reports it in later reads", async () => {
      const created = await create({ id: "thread_t" });
      const written = await store.withExclusiveLease("thread_t", async (lease) => {
        expect(lease.threadId).toBe("thread_t");
        expect(lease.current()).toEqual(created);
        return lease.commit(nextThreadRevision(lease.current(), { title: "renamed" }));
      });
      expect(written.revision).toBe(2);
      expect(written.title).toBe("renamed");
      expect(await store.get("thread_t")).toEqual(written);
    });

    it("refuses a write whose revision is not previous + 1", async () => {
      const created = await create({ id: "thread_t" });
      const stale = { ...created, title: "stale" };
      expect(await codeOf(() => store.withExclusiveLease("thread_t", (lease) => lease.commit(stale))))
        .toBe("THREAD_REVISION_CONFLICT");
      const skipped = { ...nextThreadRevision(created), revision: 3 };
      expect(await codeOf(() => store.withExclusiveLease("thread_t", (lease) => lease.commit(skipped))))
        .toBe("THREAD_REVISION_CONFLICT");
      expect(await store.get("thread_t")).toEqual(created);
    });

    it("refuses a lease on a thread that does not exist", async () => {
      expect(await codeOf(() => store.withExclusiveLease("thread_missing", async () => undefined))).toBe("THREAD_NOT_FOUND");
    });

    it("serialises overlapping leases so neither write is lost", async () => {
      await create({ id: "thread_t" });
      const bump = (title: string) => store.withExclusiveLease("thread_t", async (lease) => {
        const current = lease.current();
        await new Promise((settle) => setTimeout(settle, 5));
        await lease.commit(nextThreadRevision(current, { title }));
      });
      await Promise.all([bump("first"), bump("second"), bump("third")]);
      expect((await store.get("thread_t"))!.revision).toBe(4);
    });

    it("keeps the lease queue alive after an operation throws", async () => {
      await create({ id: "thread_t" });
      await expect(store.withExclusiveLease("thread_t", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
      const after = await store.withExclusiveLease("thread_t", async (lease) =>
        lease.commit(nextThreadRevision(lease.current(), { title: "still works" })));
      expect(after.revision).toBe(2);
    });

    it("does not let a caller mutate a snapshot it was handed", async () => {
      const created = await create({ id: "thread_t" });
      expect(Object.isFrozen(created)).toBe(true);
      expect(Object.isFrozen(created.executions)).toBe(true);
      expect(() => { (created as { title: string | null }).title = "hacked"; }).toThrow();
      const read = (await store.get("thread_t"))!;
      expect(() => { (read.executions as unknown[]).push({}); }).toThrow();
      await store.withExclusiveLease("thread_t", async (lease) => {
        expect(Object.isFrozen(lease.current())).toBe(true);
      });
    });

    it("reserves and settles root executions in sequence", async () => {
      await create({ id: "thread_t" });
      const reserved = await store.withExclusiveLease("thread_t", (lease) =>
        lease.commit(nextThreadRevision(lease.current(), { executions: [executionRef("exec_1", 1)] })));
      expect(reserved.executions[0]).toMatchObject({
        executionId: "exec_1",
        sequence: 1,
        contextRevision: 0,
        contextDigest: EMPTY_THREAD_CONTEXT_DIGEST,
        settled: null,
      });
      expect((await store.list())[0]!.unsettledExecutionId).toBe("exec_1");

      // Invariant 4: một root khác không được vào khi ref đầu còn mở.
      expect(await codeOf(() => store.withExclusiveLease("thread_t", (lease) =>
        lease.commit(nextThreadRevision(lease.current(), {
          executions: [...lease.current().executions, executionRef("exec_2", 2)],
        }))))).toBe("THREAD_INVARIANT_VIOLATION");

      const settled = await store.withExclusiveLease("thread_t", (lease) =>
        lease.commit(nextThreadRevision(lease.current(), {
          executions: [executionRef("exec_1", 1, { settled: settlement({ outcome: "failed" }) })],
        })));
      expect(settled.executions[0]!.settled).toEqual(settlement({ outcome: "failed" }));

      // Invariant 5: settled ghi một lần.
      expect(await codeOf(() => store.withExclusiveLease("thread_t", (lease) =>
        lease.commit(nextThreadRevision(lease.current(), {
          executions: [executionRef("exec_1", 1, { settled: settlement({ outcome: "completed" }) })],
        }))))).toBe("THREAD_INVARIANT_VIOLATION");

      // Invariant 3: sequence liên tục, executionId không trùng.
      expect(await codeOf(() => store.withExclusiveLease("thread_t", (lease) =>
        lease.commit(nextThreadRevision(lease.current(), {
          executions: [...lease.current().executions, executionRef("exec_3", 3)],
        }))))).toBe("THREAD_INVARIANT_VIOLATION");
      expect(await codeOf(() => store.withExclusiveLease("thread_t", (lease) =>
        lease.commit(nextThreadRevision(lease.current(), {
          executions: [...lease.current().executions, executionRef("exec_1", 2)],
        }))))).toBe("THREAD_INVARIANT_VIOLATION");

      const next = await store.withExclusiveLease("thread_t", (lease) =>
        lease.commit(nextThreadRevision(lease.current(), {
          executions: [...lease.current().executions, executionRef("exec_2", 2)],
        })));
      expect(next.executions.map((ref) => ref.sequence)).toEqual([1, 2]);
    });

    it("keeps identity fields immutable across writes", async () => {
      await create({ id: "thread_t" });
      for (const change of [
        { agentId: "other" },
        { workspace: "/elsewhere" },
        { parentThreadId: "thread_parent" },
        { createdAt: "2026-09-11T11:00:00.000Z" },
        { id: "thread_other" },
      ] as const) {
        expect(await codeOf(() => store.withExclusiveLease("thread_t", (lease) =>
          lease.commit(nextThreadRevision(lease.current(), change))))).toBe("THREAD_INVARIANT_VIOLATION");
      }
      expect((await store.get("thread_t"))!.revision).toBe(1);
    });

    it("closes and archives one way only, and limits what each state accepts", async () => {
      await create({ id: "thread_t" });
      // Không archive thẳng từ open.
      expect(await codeOf(() => store.withExclusiveLease("thread_t", (lease) =>
        lease.commit(nextThreadRevision(lease.current(), { status: "archived" }))))).toBe("THREAD_INVARIANT_VIOLATION");
      await store.withExclusiveLease("thread_t", (lease) =>
        lease.commit(nextThreadRevision(lease.current(), { status: "closed" })));
      // Closed: không execution mới, nhưng title vẫn đổi được.
      expect(await codeOf(() => store.withExclusiveLease("thread_t", (lease) =>
        lease.commit(nextThreadRevision(lease.current(), { executions: [executionRef("exec_1", 1)] })))))
        .toBe("THREAD_CLOSED");
      await store.withExclusiveLease("thread_t", (lease) =>
        lease.commit(nextThreadRevision(lease.current(), { title: "closed title" })));
      // Không reopen.
      expect(await codeOf(() => store.withExclusiveLease("thread_t", (lease) =>
        lease.commit(nextThreadRevision(lease.current(), { status: "open" }))))).toBe("THREAD_INVARIANT_VIOLATION");
      await store.withExclusiveLease("thread_t", (lease) =>
        lease.commit(nextThreadRevision(lease.current(), { status: "archived" })));
      // Archived: chỉ title.
      const renamed = await store.withExclusiveLease("thread_t", (lease) =>
        lease.commit(nextThreadRevision(lease.current(), { title: "archived title" })));
      expect(renamed).toMatchObject({ status: "archived", title: "archived title", revision: 5 });
      for (const change of [
        { status: "closed" as const },
        { status: "open" as const },
        { compactions: [{ id: "c1", fromRevision: 0, toRevision: 1, droppedCount: 0, artifact: "compactions/c1.json", createdAt: "2026-09-11T10:00:00.000Z" }] },
      ]) {
        const code = await codeOf(() => store.withExclusiveLease("thread_t", (lease) =>
          lease.commit(nextThreadRevision(lease.current(), change))));
        expect(["THREAD_ARCHIVED", "THREAD_INVARIANT_VIOLATION"]).toContain(code);
      }
      // Title-only on archived nhưng kèm execution mới → archived thắng.
      expect(await codeOf(() => store.withExclusiveLease("thread_t", (lease) =>
        lease.commit(nextThreadRevision(lease.current(), { title: "x", executions: [executionRef("exec_1", 1)] })))))
        .toBe("THREAD_ARCHIVED");
    });

    it("stores an immutable payload before the index that references it", async () => {
      await create({ id: "thread_t" });
      const written = await store.withExclusiveLease("thread_t", async (lease) => {
        const artifact = await lease.writePayload("context", "1", { objective: "ship it" });
        expect(artifact).toBe("context/1.json");
        await expect(lease.writePayload("context", "1", { objective: "again" })).rejects.toMatchObject({
          code: "THREAD_INVARIANT_VIOLATION",
        });
        return lease.commit(nextThreadRevision(lease.current(), {
          currentContext: { revision: 1, digest: digest("ctx-1"), artifact },
        }));
      });
      expect(written.currentContext).toEqual({ revision: 1, digest: digest("ctx-1"), artifact: "context/1.json" });

      // Execution mới bind vào revision 1; một ref khai revision 2 là nhìn thấy tương lai.
      expect(await codeOf(() => store.withExclusiveLease("thread_t", (lease) =>
        lease.commit(nextThreadRevision(lease.current(), {
          executions: [executionRef("exec_1", 1, { contextRevision: 2, contextDigest: digest("ctx-2") })],
        }))))).toBe("THREAD_INVARIANT_VIOLATION");
      const bound = await store.withExclusiveLease("thread_t", (lease) =>
        lease.commit(nextThreadRevision(lease.current(), {
          executions: [executionRef("exec_1", 1, { contextRevision: 1, contextDigest: digest("ctx-1") })],
        })));
      expect(bound.executions[0]!.contextRevision).toBe(1);
    });

    it("refuses an index that points at a payload which was never written", async () => {
      await create({ id: "thread_t" });
      expect(await codeOf(() => store.withExclusiveLease("thread_t", (lease) =>
        lease.commit(nextThreadRevision(lease.current(), {
          currentContext: { revision: 1, digest: digest("ctx-1"), artifact: "context/1.json" },
        }))))).toBe("THREAD_INVARIANT_VIOLATION");
      expect((await store.get("thread_t"))!.currentContext).toBeNull();
    });

    it("never lets the context revision go backwards or be rewritten in place", async () => {
      await create({ id: "thread_t" });
      await store.withExclusiveLease("thread_t", async (lease) => {
        await lease.writePayload("context", "1", {});
        await lease.writePayload("context", "2", {});
        await lease.commit(nextThreadRevision(lease.current(), {
          currentContext: { revision: 2, digest: digest("ctx-2"), artifact: "context/2.json" },
        }));
      });
      for (const currentContext of [
        null,
        { revision: 1, digest: digest("ctx-1"), artifact: "context/1.json" },
        { revision: 2, digest: digest("ctx-2b"), artifact: "context/2.json" },
      ]) {
        expect(await codeOf(() => store.withExclusiveLease("thread_t", (lease) =>
          lease.commit(nextThreadRevision(lease.current(), { currentContext }))))).toBe("THREAD_INVARIANT_VIOLATION");
      }
    });

    it("quarantines payloads the index never adopted, and leaves the rest alone", async () => {
      await create({ id: "thread_t" });
      await store.withExclusiveLease("thread_t", async (lease) => {
        await lease.writePayload("context", "1", { kept: true });
        await lease.writePayload("context", "2", { orphan: true });
        await lease.writePayload("messages", "1", { orphan: true });
        await lease.commit(nextThreadRevision(lease.current(), {
          currentContext: { revision: 1, digest: digest("ctx-1"), artifact: "context/1.json" },
        }));
      });
      expect(await store.collectOrphans("thread_t")).toEqual(["context/2.json", "messages/1.json"]);
      expect(await store.collectOrphans("thread_t")).toEqual([]);
      // Index không đổi: orphan không bao giờ được attach.
      const thread = (await store.get("thread_t"))!;
      expect(thread.revision).toBe(2);
      expect(thread.messages).toEqual([]);
      expect(await codeOf(() => store.collectOrphans("thread_missing"))).toBe("THREAD_NOT_FOUND");
    });
  });
}
