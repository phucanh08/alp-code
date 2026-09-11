import { describe, expect, it } from "vitest";
import { DEFAULT_EXECUTION_GRAPH_LIMITS } from "../../src/execution/graph/defaults";
import { isExecutionGraphError } from "../../src/execution/graph/errors";
import {
  assertChildCapacity,
  assertWithinDeadline,
  concurrentChildren,
  concurrentExecutions,
  lifetimeChildren,
  provisionalDelegationUsed,
} from "../../src/execution/graph/execution-limiter";
import {
  assertGraphDocument,
  assertNodeTransition,
  assertStructuralFieldsPreserved,
  canTransition,
} from "../../src/execution/graph/invariants";
import {
  ancestorsOf,
  subtreeOf,
  TERMINAL_NODE_STATUSES,
  type ExecutionNodeStatus,
} from "../../src/execution/graph/types";
import {
  at,
  BASE_TIME,
  childNode,
  DEADLINE,
  digest,
  graphFixture,
  reservation,
  rootNode,
} from "../support/execution-graph-fixture";

/** Mã lỗi của một lời gọi ném, hoặc `null` khi nó không ném. */
function codeOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    if (isExecutionGraphError(error)) return error.code;
    throw error;
  }
}

const NOW = new Date(at(1_000));

describe("execution graph shape", () => {
  it("accepts a tree with one root and children one level below their parent", () => {
    const graph = graphFixture({
      nodes: [
        rootNode(),
        childNode("child-a", "root-1"),
        childNode("grandchild", "child-a", { depth: 2, agentId: "search" }),
      ],
    });
    expect(assertGraphDocument(graph)).toBe(graph);
    expect(subtreeOf(graph, "child-a").map((node) => node.executionId)).toEqual(["child-a", "grandchild"]);
    expect(ancestorsOf(graph, "grandchild").map((node) => node.executionId)).toEqual(["child-a", "root-1"]);
  });

  it("requires exactly one root, at depth 0, with no delegation request behind it", () => {
    expect(codeOf(() => assertGraphDocument(graphFixture({ nodes: [] })))).toBe("EXECUTION_GRAPH_INVALID");
    expect(
      codeOf(() =>
        assertGraphDocument(
          graphFixture({ nodes: [rootNode(), rootNode({ executionId: "root-2", graphId: "root-1" })] }),
        ),
      ),
    ).toBe("EXECUTION_GRAPH_INVALID");
    expect(codeOf(() => assertGraphDocument(graphFixture({ nodes: [rootNode({ depth: 1 })] })))).toBe(
      "EXECUTION_GRAPH_INVALID",
    );
    expect(
      codeOf(() =>
        assertGraphDocument(graphFixture({ nodes: [rootNode({ requestId: "request-1" })] })),
      ),
    ).toBe("EXECUTION_GRAPH_INVALID");
  });

  it("rejects a child whose parent is missing, foreign, or at the wrong depth", () => {
    expect(
      codeOf(() => assertGraphDocument(graphFixture({ nodes: [rootNode(), childNode("child-a", "ghost")] }))),
    ).toBe("EXECUTION_GRAPH_INVALID");
    expect(
      codeOf(() =>
        assertGraphDocument(
          graphFixture({ nodes: [rootNode(), childNode("child-a", "root-1", { graphId: "other" })] }),
        ),
      ),
    ).toBe("EXECUTION_GRAPH_INVALID");
    expect(
      codeOf(() =>
        assertGraphDocument(graphFixture({ nodes: [rootNode(), childNode("child-a", "root-1", { depth: 2 })] })),
      ),
    ).toBe("EXECUTION_GRAPH_INVALID");
  });

  /**
   * Hai node trỏ vào nhau thì hỏng ở luật depth trước — depth tăng đúng một mỗi tầng, nên một
   * vòng không bao giờ khớp được cả hai đầu. Lần duyệt từ root vẫn ở đó như lớp chặn thứ hai:
   * nó là thứ duy nhất còn bắt được một component rời nếu luật depth về sau được nới ra.
   */
  it("rejects a parent chain that loops instead of leading back to the root", () => {
    const graph = graphFixture({
      nodes: [
        rootNode(),
        childNode("child-a", "child-b", { depth: 2 }),
        childNode("child-b", "child-a", { depth: 3 }),
      ],
    });
    expect(codeOf(() => assertGraphDocument(graph))).toBe("EXECUTION_GRAPH_INVALID");
  });

  it("rejects duplicate execution IDs and duplicate delegation request IDs", () => {
    expect(
      codeOf(() =>
        assertGraphDocument(
          graphFixture({ nodes: [rootNode(), childNode("child-a", "root-1"), childNode("child-a", "root-1")] }),
        ),
      ),
    ).toBe("EXECUTION_GRAPH_INVALID");
    expect(
      codeOf(() =>
        assertGraphDocument(
          graphFixture({
            nodes: [
              rootNode(),
              childNode("child-a", "root-1"),
              childNode("child-b", "root-1", { requestId: "request-child-a" }),
            ],
          }),
        ),
      ),
    ).toBe("EXECUTION_GRAPH_INVALID");
  });

  it("rejects invalid timestamps, limits, and hashes", () => {
    expect(codeOf(() => assertGraphDocument(graphFixture({ deadlineAt: "soon" })))).toBe("EXECUTION_GRAPH_INVALID");
    expect(codeOf(() => assertGraphDocument(graphFixture({ limits: { maxDepth: -1 } })))).toBe(
      "EXECUTION_GRAPH_INVALID",
    );
    expect(codeOf(() => assertGraphDocument(graphFixture({ limits: { delegationLimit: 0 } })))).toBe(
      "EXECUTION_GRAPH_INVALID",
    );
    expect(codeOf(() => assertGraphDocument(graphFixture({ limits: { reservationTtlMs: 1.5 } })))).toBe(
      "EXECUTION_GRAPH_INVALID",
    );
    expect(
      codeOf(() => assertGraphDocument(graphFixture({ nodes: [rootNode({ capabilityHash: "not-a-hash" })] }))),
    ).toBe("EXECUTION_GRAPH_INVALID");
    expect(
      codeOf(() =>
        assertGraphDocument(
          graphFixture({
            nodes: [rootNode(), childNode("child-a", "root-1", { requestFingerprint: digest("x").toUpperCase() })],
          }),
        ),
      ),
    ).toBe("EXECUTION_GRAPH_INVALID");
  });

  it("keeps endedAt in step with whether the node has finished", () => {
    expect(
      codeOf(() =>
        assertGraphDocument(
          graphFixture({ nodes: [rootNode(), childNode("child-a", "root-1", { status: "completed", endedAt: null })] }),
        ),
      ),
    ).toBe("EXECUTION_GRAPH_INVALID");
    expect(
      codeOf(() =>
        assertGraphDocument(
          graphFixture({ nodes: [rootNode(), childNode("child-a", "root-1", { status: "running", endedAt: at(5) })] }),
        ),
      ),
    ).toBe("EXECUTION_GRAPH_INVALID");
  });

  it("refuses a reservation that collides with a committed node or request", () => {
    const nodes = [rootNode(), childNode("child-a", "root-1")];
    expect(
      codeOf(() =>
        assertGraphDocument(
          graphFixture({ nodes, reservations: [reservation("r1", "root-1", { executionId: "child-a" })] }),
        ),
      ),
    ).toBe("EXECUTION_GRAPH_INVALID");
    expect(
      codeOf(() =>
        assertGraphDocument(
          graphFixture({ nodes, reservations: [reservation("r1", "root-1", { requestId: "request-child-a" })] }),
        ),
      ),
    ).toBe("EXECUTION_GRAPH_INVALID");
  });
});

describe("node transitions", () => {
  it("never lets a terminal node return to an active status", () => {
    for (const terminal of TERMINAL_NODE_STATUSES) {
      for (const active of ["preparing", "queued", "running", "cancelling"] as ExecutionNodeStatus[]) {
        expect(canTransition(terminal, active)).toBe(false);
      }
      expect(canTransition(terminal, terminal)).toBe(true);
    }
    expect(codeOf(() => assertNodeTransition("child-a", "completed", "running"))).toBe("INVALID_NODE_TRANSITION");
  });

  /**
   * Một agent trả kết quả đúng lúc lệnh huỷ vừa tới là chuyện bình thường, và ghi đè nó thành
   * `cancelled` là vứt mất công việc đã xong.
   */
  it("lets a cancelling node still finish with the result it produced", () => {
    expect(canTransition("cancelling", "completed")).toBe(true);
    expect(canTransition("cancelling", "queued")).toBe(false);
  });
});

describe("structural fields", () => {
  const previous = graphFixture({ nodes: [rootNode(), childNode("child-a", "root-1")] });

  it("rejects a write that rewrites a node's identity, parent, or depth", () => {
    for (const change of [
      { parentExecutionId: null },
      { depth: 5 },
      { agentId: "search" },
      { requestId: "request-other" },
      { capabilityHash: digest("stolen") },
      { createdAt: at(10) },
    ]) {
      const next = {
        ...previous,
        revision: 1,
        nodes: [previous.nodes[0], { ...previous.nodes[1], ...change }],
      };
      expect(codeOf(() => assertStructuralFieldsPreserved(previous, next))).toBe("EXECUTION_GRAPH_INVALID");
    }
  });

  it("rejects removing a node, moving the deadline, or shrinking delegationUsed", () => {
    expect(
      codeOf(() => assertStructuralFieldsPreserved(previous, { ...previous, nodes: [previous.nodes[0]] })),
    ).toBe("EXECUTION_GRAPH_INVALID");
    expect(
      codeOf(() =>
        assertStructuralFieldsPreserved(previous, { ...previous, deadlineAt: at(9 * 60 * 60 * 1_000) }),
      ),
    ).toBe("EXECUTION_GRAPH_INVALID");
    expect(
      codeOf(() =>
        assertStructuralFieldsPreserved(
          { ...previous, delegationUsed: 2 },
          { ...previous, delegationUsed: 1 },
        ),
      ),
    ).toBe("EXECUTION_GRAPH_INVALID");
    expect(
      codeOf(() =>
        assertStructuralFieldsPreserved(previous, {
          ...previous,
          limits: { ...previous.limits, maxDepth: 9 },
        }),
      ),
    ).toBe("EXECUTION_GRAPH_INVALID");
  });

  it("allows the changes a lifecycle actually makes", () => {
    const next = {
      ...previous,
      revision: 1,
      updatedAt: at(1_000),
      delegationUsed: previous.delegationUsed + 1,
      nodes: [previous.nodes[0], { ...previous.nodes[1], status: "completed" as const, endedAt: at(1_000) }],
    };
    expect(() => assertStructuralFieldsPreserved(previous, next)).not.toThrow();
  });
});

describe("capacity", () => {
  it("counts reservations toward provisional capacity before any child is committed", () => {
    const graph = graphFixture({ reservations: [reservation("r1", "root-1"), reservation("r2", "root-1")] });
    expect(concurrentExecutions(graph, NOW)).toBe(3);
    expect(concurrentChildren(graph, "root-1", NOW)).toBe(2);
    expect(provisionalDelegationUsed(graph, NOW)).toBe(2);
    // Trần con đồng thời là 2, và hai chỗ đã giữ đã dùng hết nó — dù chưa node nào tồn tại.
    expect(codeOf(() => assertChildCapacity({ graph, parentExecutionId: "root-1", now: NOW }))).toBe(
      "CONCURRENCY_LIMIT_EXCEEDED",
    );
  });

  it("stops counting a reservation once it has expired", () => {
    const graph = graphFixture({
      reservations: [
        reservation("r1", "root-1", { expiresAt: at(500) }),
        reservation("r2", "root-1", { expiresAt: at(500) }),
      ],
    });
    expect(concurrentChildren(graph, "root-1", NOW)).toBe(0);
    expect(() => assertChildCapacity({ graph, parentExecutionId: "root-1", now: NOW })).not.toThrow();
  });

  it("leaves terminal children out of concurrency but inside the lifetime budget", () => {
    const graph = graphFixture({
      delegationUsed: 4,
      nodes: [
        rootNode(),
        childNode("child-a", "root-1", { status: "completed" }),
        childNode("child-b", "root-1", { status: "failed" }),
        childNode("child-c", "root-1", { status: "cancelled" }),
        childNode("child-d", "root-1", { status: "interrupted" }),
      ],
    });
    expect(concurrentChildren(graph, "root-1", NOW)).toBe(0);
    expect(lifetimeChildren(graph, "root-1", NOW)).toBe(4);
    // Bốn con đã xong hết, không con nào đang chạy — nhưng ngân sách đời của node đã cạn, và
    // cho nó đẻ tiếp là bỏ đúng thứ đang chặn một vòng lặp vô hạn chạy chậm.
    expect(codeOf(() => assertChildCapacity({ graph, parentExecutionId: "root-1", now: NOW }))).toBe(
      "CHILD_LIMIT_EXCEEDED",
    );
  });

  it("reports the limit the caller actually hit, shape before budget", () => {
    const deep = graphFixture({
      limits: { maxDepth: 1 },
      nodes: [rootNode(), childNode("child-a", "root-1")],
    });
    expect(codeOf(() => assertChildCapacity({ graph: deep, parentExecutionId: "child-a", now: NOW }))).toBe(
      "DEPTH_LIMIT_EXCEEDED",
    );

    const busy = graphFixture({
      limits: { maxConcurrentExecutions: 3, maxConcurrentChildrenPerExecution: 4 },
      nodes: [rootNode(), childNode("child-a", "root-1"), childNode("child-b", "root-1")],
    });
    expect(codeOf(() => assertChildCapacity({ graph: busy, parentExecutionId: "root-1", now: NOW }))).toBe(
      "GRAPH_CONCURRENCY_LIMIT_EXCEEDED",
    );

    const spent = graphFixture({
      limits: { delegationLimit: 2, maxChildrenPerExecution: 8 },
      delegationUsed: 2,
      nodes: [rootNode(), childNode("child-a", "root-1", { status: "completed" })],
    });
    expect(codeOf(() => assertChildCapacity({ graph: spent, parentExecutionId: "root-1", now: NOW }))).toBe(
      "DELEGATION_LIMIT_EXCEEDED",
    );

    expect(
      codeOf(() => assertChildCapacity({ graph: graphFixture(), parentExecutionId: "ghost", now: NOW })),
    ).toBe("EXECUTION_NODE_NOT_FOUND");
  });

  it("treats the deadline as an absolute instant every node shares", () => {
    const graph = graphFixture();
    expect(graph.deadlineAt).toBe(DEADLINE);
    expect(() => assertWithinDeadline(graph, new Date(BASE_TIME))).not.toThrow();
    expect(codeOf(() => assertWithinDeadline(graph, new Date(DEADLINE)))).toBe("WALL_CLOCK_EXCEEDED");
    expect(
      codeOf(() => assertWithinDeadline(graph, new Date(Date.parse(DEADLINE) + 1))),
    ).toBe("WALL_CLOCK_EXCEEDED");
  });

  it("ships the P0 envelope frozen, so nothing widens it at runtime", () => {
    expect(DEFAULT_EXECUTION_GRAPH_LIMITS).toEqual({
      maxDepth: 2,
      maxChildrenPerExecution: 4,
      maxConcurrentChildrenPerExecution: 2,
      maxConcurrentExecutions: 6,
      delegationLimit: 8,
      wallClockMs: 7_200_000,
      reservationTtlMs: 120_000,
    });
    expect(Object.isFrozen(DEFAULT_EXECUTION_GRAPH_LIMITS)).toBe(true);
  });
});
