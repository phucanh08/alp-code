---
status: done
created: 2026-09-11
slug: execution-graph
source: plans/reports/review-260911-0623-execution-graph-split.md
blockedBy: []
blocks: [260907-2322-native-binary-distribution]
---

# P0 — Execution Graph, bounded delegation và cascade cancellation

## Tổng quan

Thêm execution tree bền vững và process-safe cho `main` cùng mọi delegation. Graph enforce parent identity, structural limits, lifetime allowance, deadline, reconciliation và subtree cancellation; `ExecutionBackend` vẫn chỉ quản lý một process.

Nguồn sự thật: [review và quyết định kiến trúc](../reports/review-260911-0623-execution-graph-split.md).

**Ngoài phạm vi:** hard token/tool-call budget; event bus; SQLite; DAG; cross-machine; model retry; built-in recursive grants; orchestrator/schedule/heartbeat; public limit config.

## Nguyên tắc bất biến

1. **Graph là logical authority.** Backend store chỉ là process authority; legacy delegation store chỉ fallback khi graph không có node.
2. **Parent phải được xác thực.** Derive actor từ node sau capability check; không tin `parentRole` hoặc `ALP_ROLE`.
3. **Một nguồn quyền.** `delegatesTo` authorize; `reportsTo` chỉ mô tả tổ chức.
4. **Mọi graph mutation linearizable.** Re-read và ghi revision dưới inter-process lease; corruption fail đóng.
5. **Không có cửa sổ spawn/cancel.** Reservation hoặc node+backend record phải nhìn thấy được; giữ graph lease qua backend registration.
6. **Deadline tuyệt đối.** Root chốt một timestamp; mọi node/backend kế thừa đúng timestamp đó.
7. **Secret không thành durable logical state.** Graph chỉ giữ capability hash; supervisor spec là handoff `0600` và unlink trước spawn.
8. **P0 không đổi topology.** `worker.delegatesTo` vẫn `[]`; nested flow chỉ dùng registry test.

## Phase

| Phase | Tên | Trạng thái |
|---|---|---|
| 0 | [Contract và graph store process-safe](./phase-0-contract-store.md) | xong |
| 1 | [Authenticated root lifecycle](./phase-1-authenticated-root.md) | xong |
| 2 | [Child reservation, reconciliation và legacy](./phase-2-child-reconciliation.md) | xong |
| 3 | [Cascade cancellation và absolute deadline](./phase-3-cancellation-deadline.md) | xong |
| 4 | [Tree CLI, docs và adversarial gate](./phase-4-cli-rollout.md) | xong |

## Phụ thuộc kế hoạch khác

| Quan hệ | Kế hoạch | Trạng thái |
|---|---|---|
| Chặn | [Native Binary Distribution](../260907-2322-native-binary-distribution/plan.md) | pending |

Lý do: cả hai đổi CLI bootstrap, internal supervisor và local backend. P0 phải chốt lifecycle contract trước khi P1 đóng distribution surface.

## Rà đối kháng

### Lượt — 2026-09-11

**Phát hiện:** 6 (4 nhận có sửa, 2 ghi nhận) · 0 CHẶN · 4 NÊN SỬA · 2 GHI NHẬN. Chi tiết và phân xử nằm trong [source review](../reports/review-260911-0623-execution-graph-split.md).

## Nhật ký kiểm chứng

### Lượt 1 — 2026-09-11

| Câu hỏi | Principal chọn | Ảnh hưởng |
|---|---|---|
| Ai chốt các phương án kỹ thuật sau khi kiểm tra? | “Em hãy tự quyết” | D1–D8 được chốt, không còn câu hỏi kiến trúc mở |
| Tổ chức plan thế nào? | Chia bằng `skills/alp-plan` | Index dưới 80 dòng, chi tiết chuyển vào 5 phase |

## Câu hỏi còn mở

Không.
