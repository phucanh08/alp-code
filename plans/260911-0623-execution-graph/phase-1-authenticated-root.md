# P1 — Authenticated root lifecycle

**Mục tiêu:** Mọi phiên `alp` tạo root graph trước spawn và truyền capability/deadline an toàn vào runtime.
**Phụ thuộc:** P0 — Contract và graph store process-safe.

---

## Bối cảnh

- `run-main.ts` hiện đi thẳng `ExecutionService.prepare()` → adapter → backend.
- Authorization phải xảy ra trước materialization, nhưng graph root phải tồn tại trước khi process bắt đầu.
- `parentRole`/`ALP_ROLE` là input mutable, không được dùng làm identity.

## Việc phải làm

1. Viết test fail cho `ExecutionService.authorize()`:
   - chạy policy/workspace validation;
   - chưa build memory, chưa tạo directory/file;
   - output là frozen opaque value do đúng service instance phát hành.
2. Viết test fail cho `materialize()`:
   - nhận đúng authorization object;
   - từ chối forged/object của service instance khác;
   - `prepare()` tạm thời là wrapper `authorize → materialize` để migration call sites.
3. Bỏ check `target.reportsTo === actor` khỏi `DelegationPolicy`; giữ unknown actor/target và `actor.delegatesTo.includes(target)`.
4. Tạo `ExecutionGraphService` với root path:
   - generate execution ID; `graphId === rootExecutionId`;
   - root capability `randomBytes(32)` base64url; graph chỉ lưu SHA-256 hash;
   - root node depth 0/status `preparing`;
   - snapshot fixed limits + `deadlineAt` một lần;
   - root preparation/spawn failure chuyển monotonic sang `failed` và còn inspect được.
5. Runtime binding rõ ràng:

   ```text
   ALP_EXECUTION_GRAPH_ID
   ALP_DELEGATION_EXECUTION_ID
   ALP_EXECUTION_CAPABILITY
   ALP_EXECUTION_DEADLINE_AT
   ```

6. Adapter nhận binding trong `prepare()`; không mutate `RuntimeLaunchSpec` đã freeze.
7. Assert plaintext capability không vào `policy.json`, identity capsule, session context, state snapshot hoặc generated settings/config.
8. Wire `runMainSession`:
   - authorize principal → main;
   - create root;
   - materialize;
   - adapter probe/prepare;
   - backend health;
   - `startRoot` dưới graph lease;
   - wait rồi reconcile workflow/backend result vào node.
9. CLI composition dùng chung durable `LocalProcessBackend` state directory và `FileExecutionGraphStore`; không tạo in-memory backend riêng cho root.
10. Chuẩn hoá new root/delegated artifacts dưới `~/.alp/executions/<execution-id>/`; không sửa generated state bằng tay.

## File đụng tới

| Hành động | File | Thay đổi |
|---|---|---|
| Tạo | `src/execution/graph/execution-graph-service.ts` | Root graph lifecycle/auth helpers |
| Sửa | `src/execution/types.ts` | Authorized/materialized contracts |
| Sửa | `src/execution/execution-service.ts` | Split authorize/materialize |
| Sửa | `src/policy/delegation-policy.ts` | `delegatesTo` là authority |
| Sửa | `src/runtime/runtime-adapter.ts` | Runtime graph binding input |
| Sửa | `src/runtime/adapter-files.ts` | Env/file rendering boundary |
| Sửa | `src/runtime/claude-adapter.ts` | Binding → launch env |
| Sửa | `src/runtime/codex-adapter.ts` | Binding → launch env |
| Sửa | `src/cli/commands/run-main.ts` | Root graph lifecycle |
| Sửa | `src/cli/alp.ts` | Durable composition |
| Sửa | `src/cli/commands/delegate.ts` | Shared composition boundary |
| Tạo | `test/execution/execution-graph-service.test.ts` | Root service tests |
| Sửa | `test/execution/execution-service.test.ts` | Split-stage tests |
| Sửa | `test/policy/policy-engine.test.ts` | Authorization semantics |
| Sửa | `test/runtime/runtime-adapters.test.ts` | Env + no-secret persistence |
| Sửa | `test/cli/alp.test.ts` | Root ordering/composition |
| Sửa | `test/e2e/alp-main.test.ts` | Root result reconciliation |

## Tiêu chí hoàn thành

```bash
npx vitest run \
  test/execution/execution-service.test.ts \
  test/execution/execution-graph-service.test.ts \
  test/policy/policy-engine.test.ts \
  test/runtime/runtime-adapters.test.ts \
  test/cli/alp.test.ts \
  test/e2e/alp-main.test.ts
npm run typecheck
```

Đạt khi root graph được ghi trước backend spawn; capability hash verify bằng `timingSafeEqual`; forged authorization/capability fail trước runtime/backend probe; failure để lại root terminal inspectable.

## Rủi ro

| Failure mode | Giảm thiểu |
|---|---|
| Authorization split bị forge bằng plain object | Service-owned opaque identity/WeakSet; runtime rejection test |
| Graph tạo rồi materialization fail để lại active root | Catch mọi post-create error và transition root → failed |
| Secret lọt vào generated JSON/snapshot | Snapshot assertions + chỉ inject plaintext vào launch env |
| Main/delegate dùng hai backend state khác nhau | Composition test bằng hai service instances trên cùng state dir |
| Bỏ `reportsTo` mở quyền ngoài ý muốn | Registry allowlist `delegatesTo` vẫn fail đóng; policy tests enumerate edges |

## Cần principal duyệt

Không. Phase không đổi built-in `delegatesTo` hay compiled policy invariants.
