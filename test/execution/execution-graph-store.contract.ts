import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isExecutionGraphError } from "../../src/execution/graph/errors";
import type { ExecutionGraphStore } from "../../src/execution/graph/execution-graph-store";
import { childNode, graphFixture, nextRevision, rootNode } from "../support/execution-graph-fixture";

/**
 * The behaviour every execution graph store owes its callers, run against each implementation.
 *
 * Written once because the in-memory store exists to stand in for the file store, and a
 * stand-in that quietly disagrees about revision conflicts or frozen snapshots is worse than
 * no stand-in at all: the fast suite goes green on a contract the durable store never had.
 * Anything that is genuinely about the filesystem — modes, locks, locator repair — lives in
 * the file store's own suite instead.
 */
export function describeExecutionGraphStore(
  name: string,
  createStore: () => Promise<{ store: ExecutionGraphStore; cleanup: () => Promise<void> }>,
): void {
  describe(`${name} (execution graph store contract)`, () => {
    let store: ExecutionGraphStore;
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
        if (isExecutionGraphError(error)) return error.code;
        throw error;
      }
    }

    it("stores a graph and reads it back unchanged", async () => {
      const graph = graphFixture();
      await store.create(graph);
      expect(await store.get("root-1")).toEqual(graph);
      expect(await store.get("missing")).toBeNull();
    });

    it("refuses to create the same graph twice", async () => {
      await store.create(graphFixture());
      expect(await codeOf(() => store.create(graphFixture()))).toBe("EXECUTION_GRAPH_EXISTS");
    });

    it("rejects an invalid document before it becomes durable state", async () => {
      expect(await codeOf(() => store.create(graphFixture({ nodes: [] })))).toBe("EXECUTION_GRAPH_INVALID");
      expect(await store.get("root-1")).toBeNull();
    });

    it("finds the graph holding any execution in the tree", async () => {
      await store.create(graphFixture({ nodes: [rootNode(), childNode("child-a", "root-1")] }));
      expect((await store.findByExecutionId("root-1"))?.graphId).toBe("root-1");
      expect((await store.findByExecutionId("child-a"))?.graphId).toBe("root-1");
      expect(await store.findByExecutionId("stranger")).toBeNull();
    });

    it("hands the lease a document read under the lock, and takes one revision forward", async () => {
      await store.create(graphFixture());
      const written = await store.withExclusiveLease("root-1", async (lease) => {
        const current = await lease.read();
        expect(current.revision).toBe(0);
        return lease.write(nextRevision(current, { nodes: [...current.nodes, childNode("child-a", "root-1")] }));
      });
      expect(written.revision).toBe(1);
      expect((await store.get("root-1"))?.nodes).toHaveLength(2);
    });

    it("refuses a write that does not move the revision by exactly one", async () => {
      await store.create(graphFixture());
      for (const revision of [0, 2, 5]) {
        expect(
          await codeOf(() =>
            store.withExclusiveLease("root-1", async (lease) => {
              const current = await lease.read();
              return lease.write({ ...current, revision });
            }),
          ),
        ).toBe("EXECUTION_GRAPH_REVISION_CONFLICT");
      }
      expect((await store.get("root-1"))?.revision).toBe(0);
    });

    it("refuses a write that rewrites structure, even from inside a valid lease", async () => {
      await store.create(graphFixture({ nodes: [rootNode(), childNode("child-a", "root-1")] }));
      expect(
        await codeOf(() =>
          store.withExclusiveLease("root-1", async (lease) => {
            const current = await lease.read();
            return lease.write(nextRevision(current, { nodes: [current.nodes[0]] }));
          }),
        ),
      ).toBe("EXECUTION_GRAPH_INVALID");
      expect((await store.get("root-1"))?.nodes).toHaveLength(2);
    });

    it("will not lease a graph that does not exist", async () => {
      expect(await codeOf(() => store.withExclusiveLease("root-1", async () => undefined))).toBe(
        "EXECUTION_GRAPH_NOT_FOUND",
      );
    });

    /**
     * Đây là lý do lease tồn tại. Hai người cùng đọc revision 0 rồi cùng ghi revision 1 thì
     * một trong hai biến mất — và nếu thứ biến mất là một node vừa attach, cây đó có một
     * execution đang chạy mà không ai còn đường huỷ.
     */
    it("serialises overlapping leases instead of letting one swallow the other", async () => {
      await store.create(graphFixture());
      const addChild = (id: string) =>
        store.withExclusiveLease("root-1", async (lease) => {
          const current = await lease.read();
          await new Promise((settle) => setTimeout(settle, 5));
          return lease.write(
            nextRevision(current, { nodes: [...current.nodes, childNode(id, "root-1")] }),
          );
        });
      await Promise.all([addChild("child-a"), addChild("child-b"), addChild("child-c")]);
      const graph = await store.get("root-1");
      expect(graph?.revision).toBe(3);
      expect(graph?.nodes.map((node) => node.executionId).sort()).toEqual([
        "child-a",
        "child-b",
        "child-c",
        "root-1",
      ]);
    });

    it("keeps the graph usable after a lease throws", async () => {
      await store.create(graphFixture());
      await expect(
        store.withExclusiveLease("root-1", async () => {
          throw new Error("the caller gave up half way");
        }),
      ).rejects.toThrow("the caller gave up half way");
      const written = await store.withExclusiveLease("root-1", async (lease) =>
        lease.write(nextRevision(await lease.read())),
      );
      expect(written.revision).toBe(1);
    });

    it("hands out snapshots the caller cannot mutate", async () => {
      await store.create(graphFixture({ nodes: [rootNode(), childNode("child-a", "root-1")] }));
      const graph = await store.get("root-1");
      expect(Object.isFrozen(graph)).toBe(true);
      expect(Object.isFrozen(graph?.nodes)).toBe(true);
      expect(Object.isFrozen(graph?.nodes[1])).toBe(true);
      expect(() => {
        (graph as { revision: number }).revision = 99;
      }).toThrow();
    });
  });
}
