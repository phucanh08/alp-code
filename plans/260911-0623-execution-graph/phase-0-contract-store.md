# P0 — Contract và graph store process-safe

**Mục tiêu:** Có domain contract, invariants và JSON graph store không mất update giữa nhiều CLI process.
**Phụ thuộc:** không.

---

## Bối cảnh

- Tái dùng directory-lock + atomic rename từ `FileLocalExecutionStore`.
- Graph nhỏ theo fixed limits; JSON phù hợp hơn SQLite ở P0.
- Graph document là authority. Locator theo execution ID chỉ là hint được kiểm lại.
- Defaults: depth 2; lifetime children 4; concurrent children 2; active graph 6; delegation 8; deadline 2h; reservation TTL 2 phút.

## Việc phải làm

1. Viết test fail trước cho domain:
   - root duy nhất, parent null, depth 0;
   - child cùng graph, parent tồn tại, depth = parent + 1;
   - structural fields bất biến;
   - cycle, duplicate request ID, invalid timestamps/limits/hash bị từ chối;
   - terminal status không quay lại active;
   - reservation tính provisional capacity; terminal node không tính concurrency;
   - completed child vẫn tính lifetime child limit.
2. Tạo types/error/defaults/invariants/limiter trong `src/execution/graph/`.
3. Status node: `preparing | queued | running | cancelling | completed | failed | cancelled | interrupted`.
4. Cancellation reason: `USER_REQUEST | PARENT_CANCELLED | PARENT_FAILED | WALL_CLOCK_EXCEEDED | SYSTEM_SHUTDOWN`.
5. Node chứa `requestId` + canonical SHA-256 `requestFingerprint`; root dùng `null`.
6. Store contract:

   ```ts
   interface ExecutionGraphStore {
     create(graph: ExecutionGraphDocument): Promise<void>;
     get(graphId: ExecutionGraphId): Promise<ExecutionGraphDocument | null>;
     findByExecutionId(executionId: ExecutionId): Promise<ExecutionGraphDocument | null>;
     withExclusiveLease<T>(
       graphId: ExecutionGraphId,
       operation: (lease: ExecutionGraphLease) => Promise<T>,
     ): Promise<T>;
   }
   ```

7. Viết reusable contract suite; chạy cho in-memory store trước.
8. File store dùng:
   - `~/.alp/execution-graphs/<root>.json`;
   - `<root>.json.lock/` với PID + acquired time;
   - temp file cùng directory → rename → chmod `0600`;
   - graph/lock directories `0700`;
   - timeout 5 giây → `EXECUTION_GRAPH_LOCK_TIMEOUT`;
   - chỉ phá stale lock trên 30 giây khi chứng minh owner process đã chết; không xác minh được thì fail đóng.
9. Mỗi lease re-read sau lock. Mỗi write yêu cầu `revision = previous + 1`; snapshot trả ra không mutable.
10. Locator `execution-graphs/by-execution/<execution-id>.json`:
    - root ID thử mở graph trực tiếp;
    - locator phải trỏ tới graph thực sự chứa node;
    - missing/stale/corrupt locator → scan validated graphs → tự sửa locator;
    - locator không tham gia transaction authority.
11. Multiprocess fixture mở nhiều Node processes tăng revision dưới lease; assert không lost update.
12. Export public contracts cần thiết qua `src/index.ts`.

## File đụng tới

| Hành động | File | Thay đổi |
|---|---|---|
| Tạo | `src/execution/graph/types.ts` | Graph/node/reservation/status contracts |
| Tạo | `src/execution/graph/errors.ts` | Typed graph error codes |
| Tạo | `src/execution/graph/defaults.ts` | Frozen P0 limits |
| Tạo | `src/execution/graph/invariants.ts` | Schema + transition validation |
| Tạo | `src/execution/graph/execution-limiter.ts` | Pure limit calculations |
| Tạo | `src/execution/graph/execution-graph-store.ts` | Store/lease interfaces |
| Tạo | `src/execution/graph/in-memory-execution-graph-store.ts` | Contract implementation for tests |
| Tạo | `src/execution/graph/file-execution-graph-store.ts` | Atomic JSON, lock, locator |
| Sửa | `src/state-paths.ts` | Execution graph directory |
| Sửa | `src/install/paths.ts` | Giữ path parity cho binary |
| Sửa | `src/index.ts` | Export public graph types |
| Tạo | `test/execution/execution-graph-invariants.test.ts` | Domain/limit tests |
| Tạo | `test/execution/execution-graph-store.contract.ts` | Reusable store suite |
| Tạo | `test/execution/in-memory-execution-graph-store.test.ts` | In-memory contract |
| Tạo | `test/execution/file-execution-graph-store.test.ts` | File/lock/locator contract |
| Tạo | `test/fixtures/execution-graph-store-writer.ts` | Cross-process writer |
| Sửa | `test/cli/state-paths.test.ts` | Path parity |

## Tiêu chí hoàn thành

```bash
npx vitest run \
  test/execution/execution-graph-invariants.test.ts \
  test/execution/in-memory-execution-graph-store.test.ts \
  test/execution/file-execution-graph-store.test.ts \
  test/cli/state-paths.test.ts
npm run typecheck
for i in 1 2 3 4 5; do npx vitest run test/execution/file-execution-graph-store.test.ts || exit 1; done
```

Đạt khi mọi lệnh exit 0; multiprocess final revision đúng số write; mode `0700/0600`; corrupt graph fail đóng; stale live lock không bị cướp.

## Rủi ro

| Failure mode | Giảm thiểu |
|---|---|
| Atomic JSON nhưng concurrent update vẫn mất | Mọi read-modify-write bắt buộc trong exclusive lease; multiprocess test |
| PID reuse/stale metadata làm cướp lock sống | Chỉ recover khi owner được chứng minh chết; còn nghi ngờ thì timeout |
| Locator lệch authority | Verify graph membership; scan-and-repair; locator không quyết định mutation |
| Scan fallback chậm khi lịch sử lớn | Chỉ chạy khi locator hỏng; benchmark chưa cần ở quy mô P0 |
| Contract cho phép patch structural field | Không có generic `updateNode`; semantic methods dùng pure transition validator |

## Cần principal duyệt

Không. Phase không sửa compiled policy invariants hoặc built-in agent registry.
