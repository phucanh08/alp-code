# P2 — Child reservation, reconciliation và legacy

**Mục tiêu:** Delegation con attach atomically vào graph, retry không spawn trùng, và lifecycle sống qua restart/crash.
**Phụ thuộc:** P1 — Authenticated root lifecycle.

---

## Bối cảnh

- Policy denial phải xảy ra trước artifact/runtime/backend work.
- Reservation giải quyết khoảng trống giữa limit check và backend registration.
- Graph mới không dual-write `DelegationExecutionStore`; record cũ vẫn phải thao tác được.

## Việc phải làm

1. CLI đọc `graphId`, parent execution ID và capability từ inherited env; thiếu binding → `PARENT_EXECUTION_REQUIRED`.
2. `authenticateParent()` verify hash rồi derive `agentId` từ node. Không nhận actor từ request/env role.
3. Normalize full request và hash canonical JSON với recursively sorted keys. Fingerprint gồm parent, target, task, workspace, workspace mode, selected mode, background/interactive, timeout và metadata.
4. Gọi `ExecutionService.authorize(parentAgent → target)` trước reconciliation/reservation/materialization/probe.
5. `reserveChild()` re-authenticate original capability dưới graph lease rồi:
   - expire stale reservations;
   - parent phải `preparing | queued | running`; ancestor không cancelling/cancelled;
   - deadline chưa hết;
   - check depth, lifetime children, concurrent children, active graph count, lifetime delegation allowance;
   - reservation tính provisional capacity.
6. Idempotency:
   - same request ID + different fingerprint → `REQUEST_ID_CONFLICT`;
   - same request đang reserved → `REQUEST_IN_PROGRESS` + existing execution ID; caller thứ hai không materialize;
   - same request đã thành node → trả `ExistingChild`; không prepare/spawn lần nữa;
   - expired reservation có thể tạo execution ID mới.
7. Child capability:

   ```text
   HMAC-SHA-256(parentCapability,
     "alp-execution-capability-v1\0" + graphId + "\0" + childExecutionId)
   ```

   Graph/reservation chỉ giữ hash. Retry committed request derive lại cùng capability nhưng không respawn.
8. Sau reservation: materialize → adapter prepare với child binding → backend health. Local failure trước start gọi `releaseReservation(graphId, reservationId)` và dọn runtime temporary files.
9. `startReservedChild()` dưới graph lease:
   - validate reservation/fingerprint/deadline/cancellation;
   - reservation → queued node; tăng `delegationUsed` đúng một lần;
   - giữ lease qua `backend.spawn()`;
   - backend record tồn tại rồi mới persist running/terminal;
   - definite spawn failure → failed; không hoàn allowance.
10. Reconciliation trước reserve/tree/status/wait/cancel:
    - snapshot active IDs;
    - query backend ngoài graph lock, concurrency bounded;
    - re-lock và apply monotonic transitions;
    - backend lookup error giữ active;
    - queued không có backend sau startup grace 30 giây → failed;
    - expire reservation; incomplete artifact chỉ xoá khi chứng minh không backend/live process.
11. Parent failed/interrupted: persist parent terminal, release lease, rồi cascade active descendants với `PARENT_FAILED`; không recursive lock.
12. Legacy routing:

    ```text
    graph contains execution → graph lifecycle
    graph absent             → DelegationExecutionStore legacy path
    ```

    Không ghi new records vào legacy store.

## File đụng tới

| Hành động | File | Thay đổi |
|---|---|---|
| Sửa | `src/execution/graph/execution-graph-service.ts` | Parent auth, reserve/start/reconcile |
| Sửa | `src/delegation/types.ts` | Request/result/error migration |
| Sửa | `src/delegation/delegation-service.ts` | Graph-first child workflow + legacy fallback |
| Sửa | `src/cli/commands/delegate.ts` | Inherited binding; bỏ trusted parent role |
| Tạo | `test/execution/execution-graph-reservation.test.ts` | Limits/auth/idempotency |
| Tạo | `test/execution/execution-graph-reconciliation.test.ts` | Crash/restart/monotonic transitions |
| Sửa | `test/delegation/delegation-service.test.ts` | Graph-first + legacy paths |

## Tiêu chí hoàn thành

```bash
npx vitest run \
  test/execution/execution-graph-reservation.test.ts \
  test/execution/execution-graph-reconciliation.test.ts \
  test/delegation/delegation-service.test.ts
npm run typecheck
```

Đạt khi depth boundary chặn trước artifact/backend; concurrent final slot có đúng một winner; retry không double-spawn/double-charge; restart reconcile terminal; new record không xuất hiện trong legacy store.

## Rủi ro

| Failure mode | Giảm thiểu |
|---|---|
| Check capability trước lock rồi parent đổi trạng thái | Re-authenticate + re-check status dưới lease |
| Hai retry cùng materialize một execution | Live reservation trả `REQUEST_IN_PROGRESS`; chỉ owner tiếp tục |
| Caller chết sau queued trước spawn | Startup grace + backend lookup → failed |
| Spawn thành công nhưng graph chưa running | Backend record ghi trong lease; reconciliation advance queued → running/terminal |
| Backend tạm unavailable bị coi terminal | Lookup error giữ active, không trả slot sớm |
| Legacy fallback nuốt graph corruption | Chỉ fallback khi graph thực sự absent; corrupt graph fail đóng |

## Cần principal duyệt

Không. Breaking change `alp delegate` unmanaged → `PARENT_EXECUTION_REQUIRED` đã được chốt trong source review.
