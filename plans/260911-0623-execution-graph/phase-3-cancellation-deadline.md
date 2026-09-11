# P3 — Cascade cancellation và absolute deadline

**Mục tiêu:** Cancel không lọt child spawn, subtree dừng leaf-first, và mọi process bị giới hạn bởi deadline gốc kể cả background.
**Phụ thuộc:** P2 — Child reservation, reconciliation và legacy.

---

## Bối cảnh

- Cancel/start cùng dùng graph lease để loại cửa sổ “node đã attach nhưng backend chưa thấy”.
- `wait(timeoutMs)` là thời gian caller chờ; graph deadline là tuổi thọ execution. Hai contract không được trộn.
- Detached supervisor đang nhận full env qua spec; capability chỉ được tồn tại ở đó trong thời gian handoff.

## Việc phải làm

1. `cancel(executionId)` mặc định cancel subtree; root ID tương đương whole graph.
2. Reconcile backend ngoài lock trước. Dưới graph lease:
   - re-read graph;
   - snapshot target + descendants;
   - revoke reservation có parent trong subtree;
   - mark mọi active node `cancelling` với timestamp, requester, reason;
   - persist trước khi gọi backend.
3. Sau lock: group theo depth, cancel sâu nhất trước; sibling concurrency tối đa 4; `Promise.allSettled()` để một lỗi không dừng nhánh khác.
4. Re-lock và persist terminal results. Backend cancel lỗi → giữ `cancelling` để reconciliation retry. Terminal node không gọi backend lại.
5. Race tests dùng deterministic barriers:
   - cancel trước reservation commit;
   - cancel khi start đang chờ lease;
   - cancel sau queued persist và backend registration;
   - assert không có untracked live process.
6. Mở rộng backend lifecycle với `deadlineAt: string | null`; root/child luôn truyền cùng timestamp.
7. Trước spawn: deadline đã qua → `WALL_CLOCK_EXCEEDED`, không tạo process/backend record.
8. Attached execution:
   - timer tới absolute deadline;
   - terminate runtime; clear timer trên mọi settle path;
   - backend result metadata ghi `terminationReason: "deadline"`.
9. Detached supervisor:
   - `LocalSupervisorSpec` mang deadline;
   - internal command validate mode/schema, parse, rồi unlink spec **trước** runtime spawn;
   - timer thuộc supervisor, không phụ thuộc CLI caller;
   - deadline outcome ghi atomically để status/reconcile phân biệt;
   - user cancel và deadline không ghi đè reason của nhau.
10. Stale unopened supervisor spec chỉ xoá khi backend reconciliation chứng minh không process nào sở hữu execution.
11. Graph mapping:
    - deadline → `cancelled` + `WALL_CLOCK_EXCEEDED`;
    - explicit parent cancel → `PARENT_CANCELLED` ở descendants;
    - parent failed/interrupted → `PARENT_FAILED`.
12. Giữ nguyên foreground/background `wait(timeoutMs)` semantics và test hiện có.

## File đụng tới

| Hành động | File | Thay đổi |
|---|---|---|
| Sửa | `src/execution/graph/execution-graph-service.ts` | Mark/cancel/reconcile reasons |
| Sửa | `src/delegation/delegation-service.ts` | Graph cancellation; legacy fallback |
| Sửa | `src/backend/execution-backend.ts` | Deadline lifecycle/result metadata contract |
| Sửa | `src/backend/local-execution-store.ts` | Persist deadline/termination reason |
| Sửa | `src/backend/local-process-backend.ts` | Attached/detached deadline enforcement |
| Sửa | `src/backend/local-supervisor.ts` | Detached timer/result/spec cleanup |
| Sửa | `src/cli/internal.ts` | Validated read then immediate unlink |
| Tạo | `test/execution/execution-graph-cancellation.test.ts` | Cascade + races |
| Tạo | `test/execution/execution-graph-deadline.test.ts` | Root/child deadline behavior |
| Sửa | `test/delegation/delegation-service.test.ts` | Cancel routing |
| Sửa | `test/backend/local-process-backend.test.ts` | Attached/detached backend behavior |
| Sửa | `test/backend/local-supervisor.test.ts` | Timer/result/spec lifecycle |
| Sửa | `test/cli/internal.test.ts` | Spec validation/unlink security |

## Tiêu chí hoàn thành

```bash
npx vitest run \
  test/execution/execution-graph-cancellation.test.ts \
  test/execution/execution-graph-deadline.test.ts \
  test/backend/local-process-backend.test.ts \
  test/backend/local-supervisor.test.ts \
  test/cli/internal.test.ts \
  test/delegation/delegation-service.test.ts
npm run typecheck
```

Đạt khi race suite không tạo late child; cancel subtree không chạm sibling; partial failure còn retry được; attached/detached chết đúng deadline; wait timeout vẫn giữ contract cũ; spec đã biến mất trước runtime spawn.

## Rủi ro

| Failure mode | Giảm thiểu |
|---|---|
| Cancel thấy queued node nhưng backend chưa có | Start giữ graph lease qua backend registration |
| Giữ lock lúc gọi backend cancel gây deadlock/chậm | Mark dưới lock; backend cancel ngoài lock; persist kết quả sau |
| Stale backend read làm `cancelling → running` | Monotonic transition guard; terminal/cancelling không regress |
| Timer leak giữ CLI sống | Clear timer ở success/error/cancel paths; fake timers kiểm chứng |
| Deadline reset ở child | Chỉ nhận `deadlineAt` snapshot của root; equality assertion |
| Capability nằm trong spec suốt 2 giờ | Unlink ngay sau validated read, trước spawn; log/result redaction tests |

## Cần principal duyệt

Không. Không gửi signal hay cancel execution thật trong lúc lập plan; phase chỉ chạy fixtures khi được duyệt triển khai.
