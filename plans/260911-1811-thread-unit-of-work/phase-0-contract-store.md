# P0 — Contract + store process-safe

**Mục tiêu:** Có domain `src/thread/` với contract, invariants và JSON store không mất update giữa nhiều CLI process — chưa chạm Execution, Graph hay Runtime.
**Phụ thuộc:** không (execution-graph đã done).

---

## Bối cảnh

- Tái dùng directory-lock + atomic temp/rename + mode `0700` từ `src/execution/graph/file-execution-graph-store.ts`.
- Mẫu contract suite dùng chung cho in-memory và file: `test/execution/execution-graph-store.contract.ts`.
- Mẫu multiprocess: `test/execution/execution-graph-multiprocess.test.ts`.
- Không SQLite, không event sourcing. Quy mô thật: vài chục Thread/máy.

## Contract

```ts
type ThreadId = string                       // `thread_<random>`, opaque
type ThreadStatus = "open" | "closed" | "archived"

interface ThreadDocumentV1 {
  version: 1
  id: ThreadId
  agentId: AgentId
  /** Canonical path lúc tạo. Provenance/filter cho `list`; policy vẫn tự canonicalize per execution. */
  workspace: string
  parentThreadId: ThreadId | null
  title: string | null                      // mutable, duy nhất field "mềm"
  status: ThreadStatus
  revision: number
  currentContext: ThreadContextRef | null   // { revision, digest, artifact }
  messages: readonly ThreadMessageRef[]     // P4 mới dùng; P0 luôn []
  compactions: readonly ThreadCompactionRef[]
  executions: readonly ThreadExecutionRef[]
  createdAt: string
  updatedAt: string
}

interface ThreadExecutionRef {
  executionId: ExecutionId
  sequence: number                          // 1, 2, 3… không trùng, không lùi
  contextRevision: number                   // revision Thread context lúc reserve
  contextDigest: string
  reservedAt: string
  settled: null | {
    outcome: "completed" | "failed" | "cancelled" | "interrupted"
    finishedAt: string
    nextContextRevision: number | null      // null = projection còn pending
  }
}

type ThreadActivity =
  | { kind: "idle" }
  | { kind: "running"; executionId: ExecutionId }
  | { kind: "unsettled"; executionId: ExecutionId }   // ref chưa settled, cần reconcile
```

**Vì sao ref không có `status`:** graph root node đã là truth của `preparing/running/terminal`. Thread giữ thêm một bản là hai nguồn truth cho một lifecycle (nguyên tắc 4); reconcile phải viết hai lần và crash window nhân đôi. `ThreadActivity` là **derived view** do `ThreadService` (P1/P3) tính từ ref + graph, không phải field lưu.

**Context rỗng:** `currentContext = null` ⇔ `contextRevision = 0`, `contextDigest = EMPTY_THREAD_CONTEXT_DIGEST = sha256("alp-thread-context-v1:empty")`. Hằng số export từ `types.ts` để P1 hash binding được cho root #1.

## Invariants (`src/thread/invariants.ts`)

1. `id`, `agentId`, `workspace`, `parentThreadId`, `createdAt` bất biến sau create.
2. `revision` tăng đúng +1 mỗi mutation.
3. `executions[].sequence` = 1..n liên tục; `executionId` không trùng trong Thread.
4. Tối đa **một** ref có `settled === null`.
5. `settled` chỉ ghi một lần; không quay lại `null`.
6. `parentThreadId !== id`; create phải validate parent tồn tại nếu supplied. Đọc Thread cũ không cần parent còn.
7. `archived` không nhận mutation ngoài `title`. `closed` không nhận execution mới. P1 không có reopen.
8. `currentContext.revision` tăng đơn điệu; `contextRevision` của ref ≤ `currentContext.revision` lúc reserve.
9. Artifact ref (`artifact` trong `ThreadContextRef`/`ThreadMessageRef`) là path tương đối, không `..`, không absolute, không symlink ra ngoài `threads/<id>/`.
10. Structural corrupt → `THREAD_STORE_CORRUPT`; không tự tạo lại.

## Store API (`src/thread/thread-store.ts`)

```ts
interface ThreadStore {
  create(input: CreateThreadInput): Promise<ThreadDocumentV1>
  get(id: ThreadId): Promise<ThreadDocumentV1 | null>
  list(query?: { workspace?: string; status?: ThreadStatus }): Promise<readonly ThreadSummary[]>
  withExclusiveLease<T>(id: ThreadId, fn: (lease: ThreadLease) => Promise<T>): Promise<T>
  /** Orphan payload (file có, index không trỏ) → quarantine dir. Không attach. */
  collectOrphans(id: ThreadId): Promise<readonly string[]>
}
interface ThreadLease {
  current(): ThreadDocumentV1
  writePayload(kind: "context" | "message" | "compaction", name: string, body: unknown): Promise<string> // trả artifact ref
  commit(next: ThreadDocumentV1): Promise<void>   // validate invariants + expectedRevision, atomic replace
}
```

`ThreadService` (P1+) là nơi duy nhất gọi `withExclusiveLease`; CLI không gọi store trực tiếp.

Layout:

```text
~/.alp/threads/<threadId>/
  thread.json          index/projection, bounded
  context/<rev>.json   immutable
  messages/<seq>.json  immutable (P4)
  compactions/<id>.json
  .quarantine/         orphan
```

Thứ tự ghi trong lease: read → validate → payload immutable → fsync (nếu helper có) → atomic replace `thread.json` → release.

**Vì sao payload trước index:** crash sau payload chỉ để lại orphan (vô hại, `collectOrphans` dọn); crash sau index thì không có gì để dọn. Ngược lại là index trỏ vào file không tồn tại = corrupt.

## Việc phải làm

1. Test fail trước: invariants 1–10; contract suite cho hai store; multiprocess 20 writer; corrupt JSON; path escape; symlink.
2. `src/thread/types.ts`, `errors.ts` (`THREAD_NOT_FOUND | THREAD_STORE_CORRUPT | THREAD_REVISION_CONFLICT | THREAD_INVARIANT_VIOLATION | THREAD_ARCHIVED | THREAD_CLOSED`), `invariants.ts`.
3. `src/thread/thread-store.ts`, `in-memory-thread-store.ts`, `file-thread-store.ts`.
4. `src/state-paths.ts`: `threadsDirectory()`; đồng bộ `scripts/lib/install-paths.cjs` — `test/cli/state-paths.test.ts` so hai bản.
5. `src/install/state.ts` / `ensure-state`: tạo `threads/` với mode như `execution-graphs/`.

## File đụng tới

| File | Hành động | Đổi gì |
|---|---|---|
| `src/thread/{types,errors,invariants,thread-store,in-memory-thread-store,file-thread-store}.ts` | tạo | domain + hai store |
| `src/state-paths.ts` | sửa | thêm `threadsDirectory()` |
| `scripts/lib/install-paths.cjs` | sửa | bản CJS của path mới |
| `src/install/state.ts` | sửa | ensure `threads/` |
| `test/thread/*.ts` | tạo | contract, store, invariants, multiprocess |
| `test/cli/state-paths.test.ts` | sửa | thêm path mới vào so sánh |

## Rủi ro

| Failure mode | Giảm thiểu |
|---|---|
| Lost update giữa hai CLI | directory lease + `expectedRevision`; test 20 process không mất revision |
| Crash sau payload, trước index | orphan; `collectOrphans` quarantine; không auto-attach |
| `thread.json` corrupt | `THREAD_STORE_CORRUPT`, fail đóng, giữ nguyên file |
| ID do user nhập (`alp thread show <id>`) chứa `..`/`/` | validate regex `^thread_[A-Za-z0-9]+$` trước khi ghép path |
| Parent bị archive sau khi child tồn tại | child đọc bình thường; provenance only |

## Tiêu chí hoàn thành

<!-- Sửa: kiểm chứng lượt 1 — P0 xong là mở khoá Native Binary -->

- `npx vitest run test/thread` xanh, gồm multiprocess.
- `npx vitest run test/cli/state-paths.test.ts` xanh.
- `npm run typecheck` sạch.
- Tạo/get/list/mutate Thread sống qua restart process, chưa cần Execution.
- Sau khi merge: bỏ plan này khỏi `blockedBy` của `plans/260907-2322-native-binary-distribution/plan.md`.
