# P4 — Tree CLI, docs và adversarial gate

**Mục tiêu:** Lifecycle graph quan sát/điều khiển được qua CLI, tài liệu khớp behavior, và full adversarial suite chứng minh P0 an toàn.
**Phụ thuộc:** P3 — Cascade cancellation và absolute deadline.

---

## Bối cảnh

- Người vận hành cần nhìn root → descendants, allowance và cancellation reason mà không đọc raw JSON.
- Mọi lifecycle command phải graph-first nhưng vẫn thao tác record legacy.
- P0 chỉ hoàn tất khi concurrent/crash/restart cases chạy qua process thật, không chỉ unit mocks.

## Việc phải làm

1. `getExecutionTree(executionId)`:
   - node bất kỳ resolve graph qua validated locator;
   - root/children order ổn định theo `createdAt`, tie-break bằng execution ID;
   - trả status summary, depth, request correlation, cancellation context, fixed limits, delegation used/remaining và deadline;
   - không trả capability hash, token hoặc raw reservation internals.
2. Thêm `alp delegation tree <execution-id>` với human-readable output và JSON mode theo conventions hiện tại.
3. Route `status`, `wait`, `cancel`, `cleanup`:
   - graph node → reconcile/graph service;
   - không có graph → legacy behavior;
   - corrupt graph không fallback;
   - cleanup xóa backend temporary/process state nhưng giữ graph node + historical result.
4. Cập nhật docs:
   - graph/backend/workflow authority split;
   - `delegatesTo` versus `reportsTo`;
   - unmanaged delegate breaking change và remediation `alp`;
   - fixed P0 limits;
   - deadline khác wait timeout;
   - legacy fallback/removal window;
   - token/tool budget và built-in recursion không thuộc P0.
5. E2E registry chỉ trong test: `main → worker → search`. Production definitions không đổi.
6. Adversarial integration:
   - depth 0/1/2; depth 3 fail trước artifact/backend;
   - multiprocess reservations đạt exact limits, zero lost update;
   - cancel worker lúc nó reserve child → không late process;
   - kill caller ở reservation, queued, post-spawn phases → reconcile không để untracked process;
   - restart service mid-graph giữ parentage, allowance, deadline, cancellation, backend reachability;
   - cancel worker không chạm oracle sibling; cancel main dừng mọi active descendants;
   - retry same request không spawn/charge hai lần;
   - built-in `worker.delegatesTo` vẫn `[]`.
7. Security grep/fixture assert capability không xuất hiện trong graph/policy/state JSON, snapshots, logs, results hoặc CLI. Supervisor spec chỉ tồn tại trong handoff và có mode `0600`.
8. Chạy full source/build/binary gates. Ghi rõ dependency với native-binary nếu contract thay đổi file P1 đang dựa vào.
9. Rollback nếu release gate fail: không migrate/xóa legacy store; graph-first routing có thể revert mà record cũ còn nguyên. Không xóa graph history tự động.

## File đụng tới

| Hành động | File | Thay đổi |
|---|---|---|
| Sửa | `src/execution/graph/execution-graph-service.ts` | Tree view/query summary |
| Sửa | `src/cli/commands/delegate.ts` | Tree + lifecycle routing |
| Sửa | `src/cli/alp.ts` | Command wiring/output |
| Tạo | `test/execution/execution-tree-view.test.ts` | Ordering/redaction/summary |
| Tạo | `test/e2e/execution-graph.test.ts` | Nested lifecycle E2E |
| Tạo | `test/execution/execution-graph-multiprocess.test.ts` | Cross-process adversarial tests |
| Sửa | `test/cli/alp.test.ts` | CLI tree/status/wait/cancel/cleanup |
| Sửa | `test/agents/definitions.test.ts` | Chỉ assert topology hiện tại; không đổi expected role grants |
| Sửa | `docs/architecture.md` | Ownership + data flow |
| Sửa | `docs/delegation.md` | Graph lifecycle/authorization |
| Sửa | `docs/alp-design-philosophy-and-vision.md` | Bounded delegation invariant |
| Sửa | `docs/orchestrator-vision.md` | P0 foundation, recursion deferred |
| Sửa | `docs/user/guides/delegation.md` | User workflow/tree/deadline |
| Sửa | `docs/user/reference/cli.md` | Commands/errors/output |
| Sửa | `docs/user/reference/troubleshooting.md` | Corruption/lock/orphan/remediation |
| Sửa | `CHANGELOG.md` | Breaking change + capability/deadline behavior |

## Tiêu chí hoàn thành

```bash
npx vitest run \
  test/execution/execution-tree-view.test.ts \
  test/execution/execution-graph-multiprocess.test.ts \
  test/e2e/execution-graph.test.ts \
  test/cli/alp.test.ts \
  test/agents/definitions.test.ts
npm run typecheck
npm test
npm run build
npm run test:binary
git diff --check
```

Đạt khi tất cả exit 0, Vitest có 0 failed, TypeScript 0 error, binary suite xanh, production topology không đổi, và security assertions không thấy capability trong durable/output surfaces.

## Rủi ro

| Failure mode | Giảm thiểu |
|---|---|
| CLI vô tình lộ hash/reservation internals | Dedicated DTO + snapshot redaction tests |
| Legacy fallback che graph lỗi | Fallback chỉ `not found`; corruption/lock error propagate |
| E2E chỉ test mock nên bỏ lọt process race | Multiprocess fixtures + real local backend test harness |
| Docs gọi token/tool budget là enforced | Explicit grep/review; wording chỉ “excluded” |
| P0 làm vỡ native binary pending | `blocks` relationship; chạy `test:binary`; cập nhật P1 sau P0 |
| Rollback mất lifecycle records | Không migration destructive, không dual-write, giữ legacy + graph history |

## Cần principal duyệt

- Duyệt riêng trước khi đổi built-in role definitions hoặc compiled policy invariants. P0 hiện không yêu cầu các thay đổi này.
- Duyệt release/merge theo workflow repository sau khi toàn bộ gate xanh; phase không tự publish.
