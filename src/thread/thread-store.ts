import { ThreadError } from "./errors";
import { assertThreadDocument, assertThreadId, contextArtifactRef, type ArtifactKind } from "./invariants";
import {
  generateThreadId,
  THREAD_ID_PATTERN,
  type CreateThreadInput,
  type ThreadDocumentV1,
  type ThreadId,
  type ThreadListQuery,
  type ThreadStatus,
  type ThreadSummary,
} from "./types";

/**
 * Quyền ghi độc quyền lên một Thread, giữ suốt một thao tác.
 *
 * `current()` là bản đọc lại **dưới lock**, không phải bản caller cầm từ trước. Thứ tự
 * trong lease: đọc → tính → `writePayload` (bất biến) → `commit` index. Payload trước index
 * vì crash sau payload chỉ để lại orphan (vô hại, `collectOrphans` dọn); crash sau index
 * mà payload chưa có thì index trỏ vào file không tồn tại — đó là corrupt.
 *
 * Lease này **không** được giữ chồng lên lease graph, theo cả hai chiều, và không backend
 * I/O nào chạy dưới nó. Nó chỉ bảo vệ một file JSON, và giữ nó lâu hơn thế là biến một
 * `alp thread show` thành thứ phải chờ một process khác spawn xong.
 */
export interface ThreadLease {
  readonly threadId: ThreadId;
  current(): ThreadDocumentV1;
  /** Ghi một payload bất biến; trả artifact ref để đưa vào index. Tên đã có thì hỏng. */
  writePayload(kind: ArtifactKind, name: string, body: unknown): Promise<string>;
  /** Ghi index mới. `revision` bắt buộc bằng `revision` hiện tại + 1; thay thế nguyên tử. */
  commit(next: ThreadDocumentV1): Promise<ThreadDocumentV1>;
}

export interface ThreadStore {
  create(input: CreateThreadInput): Promise<ThreadDocumentV1>;
  get(id: ThreadId): Promise<ThreadDocumentV1 | null>;
  /** Mới nhất trước (`updatedAt` giảm dần). */
  list(query?: ThreadListQuery): Promise<readonly ThreadSummary[]>;
  withExclusiveLease<T>(id: ThreadId, operation: (lease: ThreadLease) => Promise<T>): Promise<T>;
  /**
   * Payload bất biến theo ref (`context/3.json`…). Không kiểm digest — caller có index hoặc
   * binding nói digest phải là gì, và chính caller quyết `THREAD_CONTEXT_TAMPERED`.
   */
  readPayload(id: ThreadId, ref: string): Promise<unknown>;
  /**
   * Payload có trên đĩa mà index không trỏ tới → chuyển vào quarantine. Trả các ref đã dọn.
   *
   * Không bao giờ attach lại: một payload mà index không biết là kết quả của một lần ghi
   * chết giữa chừng, và không có gì nói nó thuộc revision nào.
   */
  collectOrphans(id: ThreadId): Promise<readonly string[]>;
}

/**
 * Dựng document đầu tiên của một Thread từ input tạo. Chung cho mọi store, vì hình dạng
 * "vừa tạo" là hợp đồng chứ không phải chi tiết lưu trữ.
 */
export function newThreadDocument(input: CreateThreadInput, now: () => Date): ThreadDocumentV1 {
  const createdAt = input.createdAt ?? now().toISOString();
  const parentThreadId = input.parentThreadId ?? null;
  if (parentThreadId !== null) assertThreadId(parentThreadId, "parentThreadId");
  return assertThreadDocument({
    version: 1,
    id: input.id ?? generateThreadId(),
    agentId: input.agentId,
    workspace: input.workspace,
    parentThreadId,
    title: input.title ?? null,
    status: "open",
    revision: 1,
    currentContext: null,
    messages: [],
    compactions: [],
    executions: [],
    createdAt,
    updatedAt: createdAt,
  } satisfies ThreadDocumentV1);
}

/** ID từ argv đi qua đây trước khi chạm path: `..`, `/`, hay bất kỳ gì ngoài regex đều dừng ở đây. */
export function requireThreadId(id: string): ThreadId {
  if (!THREAD_ID_PATTERN.test(id)) {
    throw new ThreadError("THREAD_INVARIANT_VIOLATION", `invalid thread ID \`${id}\``);
  }
  return id;
}

export function matchesQuery(summary: ThreadSummary, query: ThreadListQuery): boolean {
  if (query.workspace !== undefined && summary.workspace !== query.workspace) return false;
  if (query.status !== undefined && summary.status !== (query.status as ThreadStatus)) return false;
  return true;
}

export function sortNewestFirst(summaries: ThreadSummary[]): ThreadSummary[] {
  return summaries.sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
}

/**
 * Mọi artifact mà index còn cần trên đĩa.
 *
 * Context tính theo revision chứ không theo `currentContext.artifact`: các revision cũ là
 * lịch sử (chuỗi digest `rev0 → rev1 → rev2` là thứ P5 kiểm), không phải orphan.
 */
export function referencedArtifacts(thread: ThreadDocumentV1): Set<string> {
  const refs = new Set<string>();
  for (let revision = 1; revision <= (thread.currentContext?.revision ?? 0); revision += 1) {
    refs.add(contextArtifactRef(revision));
  }
  for (const ref of thread.messages) refs.add(ref.artifact);
  for (const ref of thread.compactions) refs.add(ref.artifact);
  return refs;
}

/** Ref xuất hiện ở `next` mà `previous` chưa trỏ tới — những payload commit này phải thấy trên đĩa. */
export function newArtifacts(previous: ThreadDocumentV1, next: ThreadDocumentV1): string[] {
  const before = referencedArtifacts(previous);
  return [...referencedArtifacts(next)].filter((ref) => !before.has(ref));
}

/** Bản sao đóng băng sâu — snapshot trả ra khỏi store không được sửa tại chỗ. */
export function freezeThread(thread: ThreadDocumentV1): ThreadDocumentV1 {
  return deepFreeze(structuredClone(thread)) as ThreadDocumentV1;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  }
  return Object.freeze(value);
}
