import type { ExecutionId } from "../types";
import { ExecutionGraphError } from "./errors";
import {
  freezeGraph,
  validateGraphWrite,
  type ExecutionGraphLease,
  type ExecutionGraphStore,
} from "./execution-graph-store";
import { assertGraphDocument } from "./invariants";
import type { ExecutionGraphDocument, ExecutionGraphId } from "./types";

/**
 * Store trong bộ nhớ, cho unit tests và cho một composition không cần bền vững.
 *
 * Cùng bộ contract test với bản file. Nó tồn tại để tách hai câu hỏi: "logic cây có đúng
 * không" trả lời được ở đây trong vài mili-giây, còn "hai process có nuốt update của nhau
 * không" thì chỉ bản file trả lời được — và trộn hai câu vào một suite là cách một lỗi khoá
 * ẩn dưới ba trăm assertion về limit.
 */
export class InMemoryExecutionGraphStore implements ExecutionGraphStore {
  private readonly graphs = new Map<ExecutionGraphId, ExecutionGraphDocument>();
  /** Hàng đợi một chiều cho mỗi graph — lease này không reentrant, đúng như bản file. */
  private readonly leases = new Map<ExecutionGraphId, Promise<unknown>>();

  async create(graph: ExecutionGraphDocument): Promise<void> {
    const document = assertGraphDocument(graph);
    if (this.graphs.has(document.graphId)) {
      throw new ExecutionGraphError(
        "EXECUTION_GRAPH_EXISTS",
        `execution graph \`${document.graphId}\` already exists`,
      );
    }
    this.graphs.set(document.graphId, freezeGraph(document));
  }

  async get(graphId: ExecutionGraphId): Promise<ExecutionGraphDocument | null> {
    const graph = this.graphs.get(graphId);
    return graph ? freezeGraph(graph) : null;
  }

  async findByExecutionId(executionId: ExecutionId): Promise<ExecutionGraphDocument | null> {
    const direct = this.graphs.get(executionId);
    if (direct) return freezeGraph(direct);
    for (const graph of this.graphs.values()) {
      if (graph.nodes.some((node) => node.executionId === executionId)) return freezeGraph(graph);
    }
    return null;
  }

  async withExclusiveLease<T>(
    graphId: ExecutionGraphId,
    operation: (lease: ExecutionGraphLease) => Promise<T>,
  ): Promise<T> {
    const previous = this.leases.get(graphId) ?? Promise.resolve();
    const run = previous.then(
      () => this.runLeased(graphId, operation),
      () => this.runLeased(graphId, operation),
    );
    // Hàng đợi phải tiếp tục kể cả khi thao tác này ném, nếu không một lỗi sẽ khoá graph
    // vĩnh viễn — đúng cái mà lease phải tránh.
    this.leases.set(graphId, run.then(() => undefined, () => undefined));
    return run;
  }

  private async runLeased<T>(
    graphId: ExecutionGraphId,
    operation: (lease: ExecutionGraphLease) => Promise<T>,
  ): Promise<T> {
    const existing = this.graphs.get(graphId);
    if (!existing) {
      throw new ExecutionGraphError(
        "EXECUTION_GRAPH_NOT_FOUND",
        `execution graph \`${graphId}\` does not exist`,
      );
    }
    let current = assertGraphDocument(existing);
    const lease: ExecutionGraphLease = {
      graphId,
      read: async () => freezeGraph(current),
      write: async (next) => {
        const document = validateGraphWrite(current, next);
        current = document;
        this.graphs.set(graphId, freezeGraph(document));
        return freezeGraph(document);
      },
    };
    return operation(lease);
  }
}
