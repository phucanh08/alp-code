---
status: completed
created: 2026-09-11
slug: thread-unit-of-work
source: plans/reports/review-260911-1811-thread-unit-of-work.md
blockedBy: []
blocks: [260907-2322-native-binary-distribution]
---

# P1 — Thread as Unit of Work

## Tổng quan

Thêm `Thread` — unit of work bền vững nằm **trên** `Execution`. Một Thread giữ identity, work context, history refs và danh sách root execution; mỗi lần tiếp tục Thread vẫn sinh một Execution bất biến mới với policy/capsule riêng. Sau P1: `alp` mở Thread + E-1, `alp thread continue <id>` mở E-2 cùng Thread, E-2 có thể chạy runtime khác E-1 và nhận bounded context từ E-1.

`Thread T ── E-1 (claude) ── G-1 ── Process · E-2 (codex) ── G-2 ── Process · E-3 (claude) ── G-3 ── Process`

Nguồn sự thật: [review kiến trúc](../reports/review-260911-1811-thread-unit-of-work.md).
**Ngoài phạm vi:** web/mobile UI; sync server/cloud Thread store; Amp protocol; runner/orb/scheduler; sharing/ACL; branch/merge Thread; >1 active root/Thread; steer message vào process đang chạy; đổi Memory thành Thread; đổi ExecutionGraph thành DAG; model gateway; lưu raw secret-bearing tool payload; xoá provider transcript; Agent mới; delete/purge Thread; live attach cross-terminal; model-based Thread compactor.

## Nguyên tắc bất biến

1. **Thread là work unit, không phải authority unit.** `PolicyEngine`/`ExecutionService.authorize()` không đọc Thread. Vi phạm → mutable file cấp quyền.
2. **Execution vẫn là security unit.** Mỗi root có `policyHash` riêng; Thread binding nằm **trong** snapshot đã hash (`thread: … | null`, key bắt buộc — `canonicalize()` bỏ `undefined`, nên field vắng sẽ trùng hash legacy).
3. **Graph vẫn là delegation/cancellation unit của một root run.** Thread chỉ index root; child query qua graph.
4. **Không hai nguồn truth cho một lifecycle.** `ThreadExecutionRef` chỉ có `reserved → settled`; `running/interrupted` derive từ graph/backend. Thread không có field `running`.
5. **Không nest lease.** Thread lease và Graph lease không bao giờ giữ lồng nhau, theo cả hai chiều; backend I/O không chạy dưới Thread lease. Vi phạm → deadlock giữa hai CLI.
6. **`parentThreadId` chỉ provenance.** Không capability, depth, cancel, `delegatesTo`.
7. **Một active root/Thread.** Song song → fork Thread mới.
8. **Context là untrusted model input.** Policy render/enforce độc lập, fail-closed.
9. **Không fabricate history, không duplicate secret.** Bridge partial khai `partial`/`final-only`; Thread giữ redacted metadata + refs/digests.
10. **Thread không quyết placement; store fail đóng.** Backend/runtime giữ process launch; `thread.json` hỏng → `THREAD_STORE_CORRUPT`, không reset.

## Phase

| Phase | Tên | Trạng thái |
|---|---|---|
| 0 | [Contract + store process-safe](./phase-0-contract-store.md) | done — 2026-09-11 |
| 1 | [Binding Thread ↔ Execution bất biến](./phase-1-execution-binding.md) | done — 2026-09-11 |
| 2 | [Context projection + handoff](./phase-2-context-handoff.md) | done — 2026-09-11 |
| 3 | [CLI continue + recovery](./phase-3-cli-continuation.md) | done — 2026-09-11 |
| 4 | [History bridge + compaction provenance](./phase-4-history-bridge.md) — sau CLI vì downgrade được, không được chặn `continue` | done — 2026-09-11 |
| 5 | [Cross-runtime proof, docs, migration, gate](./phase-5-rollout-gate.md) | done — 2026-09-11 |

## Phụ thuộc kế hoạch khác

| Quan hệ | Kế hoạch | Trạng thái |
|---|---|---|
| Cần | [Execution Graph](../260911-0623-execution-graph/plan.md) | done |
| Tái dùng | [Cross-runtime Compact Bridge](../260903-2040-cross-runtime-compact-bridge/plan.md) | done |
| Chặn (mở khoá sau **P0**) | [Native Binary Distribution](../260907-2322-native-binary-distribution/plan.md) | pending — chỉ chung state layout (`install-paths.cjs`, `ensure-state`) |

## Rà đối kháng

Lượt 1 — 2026-09-11, tự rà trên bản nháp đầu, đối chiếu code. Tất cả **nhận**, đã lan xuống phase.

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | CHẶN | Child "đọc binding từ policy cha" nhưng `ExecutionStore` chỉ có `create()`; `DelegationService` suy cha từ graph node | `thread` thành structural field của `ExecutionNode`; child copy từ `parent.node.thread` (P1) |
| 2 | CHẶN | `ThreadExecutionRef.status` sao chép graph status, vi phạm D4 | Ref chỉ `reserved → settled`; activity derive (P0/P1) |
| 3 | CHẶN | Không có luật thứ tự lease Thread/Graph | Nguyên tắc 5 + test (P1, P3) |
| 4 | CHẶN | Interactive root có `task` sentinel, `characterBudget: 0`, stdio inherit → projector không có output để đọc | Input projector = pins + outcome; scenario drive bằng `alp context pin`; `objective` từ `--title` hoặc null (P2, P5) |
| 5 | NÊN SỬA | `thread` vắng ≠ `thread: null` trong hash; digest rev 0 chưa định nghĩa; digest nằm trong snapshot | Key bắt buộc từ P1; rev 0 + digest hằng; hash bỏ field `digest` (P0, P2) |
| 7 | NÊN SỬA | `ThreadDocument` thiếu `workspace`/`title` → `thread list` vô dụng | Thêm `workspace` (immutable, provenance) + `title` (P0) |
| 8 | NÊN SỬA | "executionId không thuộc hai Thread" không enforce được không scan; `ThreadStore.reconcile` trùng tên service | Enforce qua binding bất biến + graph locator; store đổi thành `collectOrphans` (P0, P1, P3) |
| 9 | NÊN SỬA | Bridge "complete" không có default | `final-only` mặc định; `complete` chỉ khi probe pass (P4) |

## Nhật ký kiểm chứng

### Lượt 1 — 2026-09-11 (principal uỷ quyền tự chốt)

| Câu hỏi | Chọn | Vì sao | Ảnh hưởng |
|---|---|---|---|
| Thread chặn Native Binary? | **Chặn hẹp: chỉ cần P0 merge** | Native Binary không đụng `run-main`; coupling duy nhất là state layout, P0 đóng băng nó. Chặn toàn bộ idle Native Binary 2–3 tuần vô ích; không chặn để lại lỗ im lặng ở migration/uninstall test | P5 sửa điều kiện mở khoá |
| Bare `alp`: Thread mới hay tự tiếp tục? | **Luôn tạo mới, `continue` tường minh** | Tự tiếp tục = việc mới kế thừa context không ai xin (vi phạm nguyên tắc 8) và dính `THREAD_BUSY` khi Thread cũ còn process; prompt TTY thành nhiễu vì P1 không auto-close. Thêm prompt sau là additive, bỏ auto-continue là regression | P3 in gợi ý `continue` lúc launch; `list` lọc cwd+open |

## Câu hỏi còn mở

Không.
