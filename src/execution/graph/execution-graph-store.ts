import type { ExecutionId } from "../types";
import { ExecutionGraphError } from "./errors";
import { assertGraphDocument, assertStructuralFieldsPreserved } from "./invariants";
import type { ExecutionGraphDocument, ExecutionGraphId } from "./types";

/**
 * Quyền ghi độc quyền lên một graph, giữ suốt một thao tác.
 *
 * `read()` luôn trả bản vừa đọc lại **dưới lock**, không phải bản caller đã cầm trước đó:
 * mọi read-modify-write phải bắt đầu từ sự thật hiện tại, nếu không thì hai CLI process cùng
 * đọc "còn một chỗ" rồi cùng ghi, và bản ghi sau nuốt bản trước.
 */
export interface ExecutionGraphLease {
  readonly graphId: ExecutionGraphId;
  read(): Promise<ExecutionGraphDocument>;
  /** Ghi một document mới. `revision` bắt buộc bằng `revision` hiện tại + 1. */
  write(next: ExecutionGraphDocument): Promise<ExecutionGraphDocument>;
}

export interface ExecutionGraphStore {
  create(graph: ExecutionGraphDocument): Promise<void>;
  get(graphId: ExecutionGraphId): Promise<ExecutionGraphDocument | null>;
  /**
   * Graph chứa node này, tra theo execution ID bất kỳ trong cây.
   *
   * Trả `null` khi không graph nào chứa nó — đó là tín hiệu duy nhất cho phép caller rơi về
   * đường legacy. Một graph hỏng thì ném, không trả `null`: fallback nuốt corruption là cách
   * một cây mất trần mà không ai biết.
   */
  findByExecutionId(executionId: ExecutionId): Promise<ExecutionGraphDocument | null>;
  withExclusiveLease<T>(
    graphId: ExecutionGraphId,
    operation: (lease: ExecutionGraphLease) => Promise<T>,
  ): Promise<T>;
}

/**
 * Kiểm một lần ghi trước khi nó thành sự thật, dùng chung cho mọi implementation.
 *
 * Đặt ở đây chứ không trong từng store vì đây là hợp đồng chứ không phải chi tiết lưu trữ:
 * một store mới viết đúng phần đĩa mà quên phần này sẽ nhận mọi document, kể cả cái vừa xoá
 * một node hoặc vừa lùi một trạng thái terminal.
 */
export function validateGraphWrite(
  previous: ExecutionGraphDocument,
  next: ExecutionGraphDocument,
): ExecutionGraphDocument {
  const document = assertGraphDocument(next);
  if (document.graphId !== previous.graphId) {
    throw new ExecutionGraphError(
      "EXECUTION_GRAPH_INVALID",
      `lease on \`${previous.graphId}\` cannot write graph \`${document.graphId}\``,
    );
  }
  if (document.revision !== previous.revision + 1) {
    throw new ExecutionGraphError(
      "EXECUTION_GRAPH_REVISION_CONFLICT",
      `expected revision ${previous.revision + 1} for graph \`${previous.graphId}\`, received ${document.revision}`,
    );
  }
  assertStructuralFieldsPreserved(previous, document);
  return document;
}

/**
 * Bản sao đóng băng sâu.
 *
 * Snapshot trả ra khỏi store không được sửa: caller giữ tham chiếu tới document rồi sửa tại
 * chỗ sẽ tạo một phiên bản cây không lần nào đi qua `validateGraphWrite` — nó chỉ tồn tại
 * trong bộ nhớ của một process, và mọi quyết định của process đó tính trên nó.
 */
export function freezeGraph(graph: ExecutionGraphDocument): ExecutionGraphDocument {
  return deepFreeze(structuredClone(graph)) as ExecutionGraphDocument;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  }
  return Object.freeze(value);
}
