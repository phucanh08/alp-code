# P1 — Binding Thread ↔ Execution bất biến

**Mục tiêu:** Mọi root Execution mở từ Thread mang Thread provenance bất biến (trong `policyHash` **và** graph node), child kế thừa từ node cha, và một Thread có nhiều root Execution thật — security vẫn hoàn toàn Execution-scoped.
**Phụ thuộc:** P0.

---

## Bối cảnh

- `src/execution/execution-policy.ts:31-42` — `canonicalize()` **bỏ key `undefined`**. Field thread vắng và `thread: undefined` cho cùng hash với legacy. Vì thế `thread` là key **bắt buộc**, giá trị `null` khi không có.
- `src/execution/types.ts` — `MaterializeExecutionInput` là chỗ cho "nội dung không ảnh hưởng quyết định cho phép". Binding đặt ở đây, không ở `AuthorizeExecutionInput`.
- `src/delegation/delegation-service.ts:286-297` — cha được suy từ `graph.authenticateParent(binding).node`, **không** mở `policy.json` của cha. `ExecutionStore` chỉ có `create()`.
- `src/cli/commands/run-main.ts:88-118` — root: authorize → `graph.createRoot` → materialize → prepare → `graph.startRoot(spawn)` (giữ graph lease khi spawn) → wait → `finishExecution`.

## Thiết kế

### Binding

```ts
interface ExecutionThreadBinding {
  readonly id: ThreadId
  readonly contextRevision: number
  readonly contextDigest: string
}
```

Xuất hiện ở ba chỗ, cùng giá trị:

| Nơi | Field | Vì sao |
|---|---|---|
| `ExecutionPolicy` | `thread: ExecutionThreadBinding \| null` (bắt buộc, trong snapshot hash) | execution không thể bị "chuyển Thread" bằng sửa metadata |
| `ExecutionNode` (graph) | `thread: ExecutionThreadBinding \| null`, structural immutable | child đọc từ node cha — đường duy nhất `DelegationService` đang có; không cần read path `policy.json` |
| `IdentityCapsule` | không thêm — capsule đã mang `policyHash` | DRY |

**Phương án bị bác:** thêm `ExecutionStore.read()` để child đọc `policy.json` cha. Đắt hơn (thêm read path + verify hash), và tạo chỗ thứ hai có thể lệch với graph. Graph đã là nguồn identity cha (invariant 2 của graph).

### Graph

- `ExecutionNode.thread` structural: `invariants.ts` chặn mọi patch; child `thread` phải deep-equal `parent.thread` (`THREAD_BINDING_MISMATCH`).
- `createRoot({ agentId, executionId, thread })`; `reserveChild` copy `parent.node.thread`, không nhận từ caller.
- Graph document cũ trên đĩa không có field → **đọc** normalize thành `null`; **ghi** luôn có key. Test fixture graph legacy.
- `findByExecutionId` là locator sẵn có → "một `executionId` không thuộc hai Thread" enforce bằng: executionId duy nhất trong graph store + `policy.thread`/`node.thread` bất biến. Không scan `threads/`.

### Thứ tự root (`run-main.ts`)

```text
1. resolve/create Thread (ThreadService)            — không lease
2. executionId = ids()
3. ExecutionService.authorize(principal → main)     — denied thì không chiếm slot Thread
4. ThreadService.reserveRoot(threadId, executionId) — Thread lease: append ref {sequence, contextRevision, contextDigest, settled: null}; reject nếu status ≠ open hoặc còn ref unsettled (THREAD_BUSY); release
5. graph.createRoot({ agentId, executionId, thread })
6. withRootFailure:
   materialize(authorization, { …, thread })
   adapter.prepare · graph.startRoot(spawn) · backend.wait · graph.finishExecution
7. ThreadService.settleRoot(threadId, executionId, outcome)  — Thread lease; release
8. (P2) ThreadService.projectContext(threadId, executionId)
```

**Vì sao reserve trước `createRoot`:** graph/process tồn tại mà Thread không biết → continuation history thủng. Crash giữa 4 và 5 → ref unsettled không có graph → reconcile (P3) đánh `interrupted` sau TTL.

**Vì sao authorize trước reserve:** execution bị từ chối không được chiếm active slot.

**Lock order (nguyên tắc 5):** bước 4 và 7 giữ Thread lease **một mình**; bước 5–6 giữ graph lease **một mình**. Không hàm nào của `ThreadService` nhận callback chạy dưới lease mà lại gọi graph/backend. Test: fake store đếm lease đang giữ, assert ≤ 1 loại tại mọi thời điểm.

### Root vs child

| | Root | Child (delegate) |
|---|---|---|
| `ThreadExecutionRef` | append, `sequence++` | **không** |
| `node.thread` | từ reserve | copy từ cha |
| `policy.thread` | = node.thread | = node.thread |

`isRootThreadExecution(node)` ⇔ `node.parentExecutionId === null && node.thread !== null`. Không suy từ `agentId`.

### Kiểm tra nhất quán khi đọc

`ThreadService.describeExecution(threadId, executionId)`: `ref.executionId` ∈ Thread ∧ `node.thread.id === threadId` ∧ `ref.contextRevision/Digest === node.thread.*`. Lệch → `THREAD_EXECUTION_BINDING_MISMATCH`; không sửa Thread cho khớp.

### Thread + archive/close khi root đang chạy

`close`/`archive` reject khi còn ref unsettled (`THREAD_BUSY`). Không schedule.

## Việc phải làm

1. Test fail trước: policy hash đổi khi `thread` đổi; `thread` vắng bị reject ở `createExecutionPolicy`; graph invariants child/parent thread; legacy graph doc đọc được; lock-order test; E2E dưới đây.
2. `src/execution/types.ts`: `ExecutionThreadBinding`; `ExecutionPolicy.thread`; `MaterializeExecutionInput.thread`.
3. `src/execution/execution-policy.ts`: đưa `thread` vào `snapshot`.
4. `src/execution/execution-service.ts`: `materialize` chép `input.thread` vào policy.
5. `src/execution/graph/{types,invariants,execution-graph-service,file-execution-graph-store}.ts`: field `thread`, copy sang child, normalize legacy.
6. `src/delegation/delegation-service.ts`: truyền `parent.node.thread` vào `materialize`.
7. `src/thread/thread-service.ts`: `createThread`, `reserveRoot`, `settleRoot`, `activity`, `describeExecution`, `close`, `archive`.
8. `src/cli/commands/run-main.ts`: thứ tự trên; `RunMainDependencies.threads`.
9. Fixtures tạo policy/capsule: thêm `thread: null`.

## File đụng tới

| File | Hành động | Đổi gì |
|---|---|---|
| `src/execution/types.ts` | sửa | binding type, field policy + materialize input |
| `src/execution/execution-policy.ts` | sửa | `thread` vào snapshot hash |
| `src/execution/execution-service.ts` | sửa | chép binding vào policy |
| `src/execution/graph/types.ts`, `invariants.ts` | sửa | `ExecutionNode.thread` structural + invariant |
| `src/execution/graph/execution-graph-service.ts` | sửa | `createRoot` nhận thread; `reserveChild` copy |
| `src/execution/graph/file-execution-graph-store.ts` | sửa | normalize legacy doc |
| `src/delegation/delegation-service.ts` | sửa | truyền `node.thread` |
| `src/thread/thread-service.ts` | tạo | orchestration + derived activity |
| `src/cli/commands/run-main.ts` | sửa | Thread-aware root flow |
| `test/execution/*`, `test/delegation/*`, `test/e2e/*` fixtures | sửa | `thread: null` |
| `test/thread/thread-service.test.ts`, `test/e2e/thread-binding.test.ts` | tạo | |

## Rủi ro

| Failure mode | Giảm thiểu |
|---|---|
| Attach execution Thread A sang B bằng sửa `thread.json` | `policy.thread` + `node.thread` bất biến, hash → `THREAD_EXECUTION_BINDING_MISMATCH` |
| Thread bị sửa (context rev mới) sau khi E-1 start | E-1 và child giữ rev cũ trong node/policy; child không đọc Thread mutable |
| Materialize/prepare fail sau reserve | `withRootFailure` đã ghi graph `failed`; thêm `settleRoot(failed)` trong cùng catch; nếu chính `settleRoot` fail → P3 reconcile dọn theo graph |
| Deadlock Thread/Graph lease | nguyên tắc 5 + test đếm lease |
| Fixture/hash regression làm mọi test policy đỏ | sửa fixture một lượt, không đổi hash algorithm |
| Forged `ALP_THREAD_ID` env | env chỉ label; authority là binding trong policy/node |

## Tiêu chí hoàn thành

- `npx vitest run test/execution test/delegation test/thread test/e2e/thread-binding.test.ts` xanh.
- E2E: `create T → E1 (policy.thread.id = T) → child C1 (policy.thread = E1.thread; T.executions = [E1]) → finish E1 → E2 → T.executions = [E1, E2]; policyHash(E1) ≠ policyHash(E2)`.
- Security: sửa `thread.json` không đổi `allowedTools/workspace/delegatesTo`; `parentThreadId` không authorize delegation.
- `npm test` toàn bộ xanh.
