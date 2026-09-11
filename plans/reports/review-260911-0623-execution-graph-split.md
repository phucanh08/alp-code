# Review — chia nhỏ Execution Graph P0

**Ngày:** 2026-09-11
**Nguồn:** `plans/P0 — Execution Graph Implementation Plan.md`
**Kết quả:** giữ phạm vi kỹ thuật, thay một master plan 1.259 dòng bằng plan index + 5 phase.

## Thách thức phạm vi

- **Đã có sẵn:** `ExecutionService`, `DelegationService`, `ExecutionBackend`, durable local backend state, atomic file helpers, directory-lock pattern, runtime adapters và CLI lifecycle.
- **Tập tối thiểu:** graph bền vững; parent capability; depth/fan-out/concurrency/delegation limits; absolute deadline; reconciliation; cascade cancellation; tree query.
- **Hoãn:** token budget, tool-call budget, event sourcing, SQLite, DAG, distributed execution, retry model, built-in recursive grants, orchestration/schedule/heartbeat.
- **Độ phức tạp:** hơn 8 file và hơn 2 module mới là có lý do: feature cắt qua domain, persistence, authorization, backend lifecycle và CLI. Chia 5 phase để mỗi gate chạy độc lập; gộp ít hơn sẽ trộn persistence race với runtime lifecycle.
- **Hướng đã chốt:** GIỮ NGUYÊN. Principal đã giao quyền tự chọn phương án kỹ thuật; yêu cầu hiện tại chỉ là chia plan theo `alp-plan`.

## Dependency scan

| Plan | Trạng thái ghi trong plan | Giao nhau | Phán quyết |
|---|---|---|---|
| `260903-0959-adapter-no-synthetic-turn` | in-progress | adapters, `run-main.ts` | Không chặn: checklist hoàn tất và commit `2625faf` đã chứa thay đổi |
| `260907-2322-native-binary-distribution` | pending | CLI, internal supervisor, backend, install paths | Execution Graph P0 chặn Native Binary P1 để tránh hai plan đổi cùng lifecycle contract |
| `260903-1436-local-backend-parity` | completed trong thân plan | local backend | Không chặn: durable backend hiện tại là đầu vào của plan mới |
| `260903-1345-paseo-permit-acl` | legacy, không frontmatter chuẩn | backend cũ Paseo | Không chặn: current code đã cut over local-only |

## Quyết định kiến trúc

| # | Chọn | Vì sao | Bỏ |
|---|---|---|---|
| D1 | `ExecutionGraphService` sở hữu cây; backend sở hữu một process | Giữ hierarchy khỏi driver process | Backend có `children()`/`cancelTree()` |
| D2 | `delegatesTo` là allowlist; `reportsTo` là metadata | Một nguồn quyền, không khóa specialist vào một caller | `target.reportsTo === actor`; `reportsTo[]` |
| D3 | Built-in roles tiếp tục flat | P0 là safety infrastructure, không đổi hành vi sản phẩm | `Worker → Worker` ngay trong P0 |
| D4 | JSON snapshot + directory lock + atomic rename | Graph nhỏ, local-only, tái dùng pattern có sẵn | SQLite; event sourcing; unlocked JSON |
| D5 | `graphId === rootExecutionId`; locator chỉ là hint | Ít identity hơn, lookup child vẫn nhanh mà graph là authority | Authoritative global index |
| D6 | Một absolute deadline truyền cho mọi node; backend enforce từng process | Không cần watchdog daemon, background vẫn bị dừng | Deadline on-demand; reset duration ở child |
| D7 | Graph là logical source of truth; backend store là process truth; legacy read-only fallback | Không dual-write hai file không thể transaction cùng nhau | Ghi đồng thời graph + delegation store |
| D8 | Root capability random 256-bit; child capability HMAC từ parent + IDs; graph chỉ giữ hash | Retry xác định mà không lưu plaintext | Tin `parentRole`/env role; lưu plaintext trong graph |

## Safety envelope cố định ở P0

```ts
{
  maxDepth: 2,
  maxChildrenPerExecution: 4,
  maxConcurrentChildrenPerExecution: 2,
  maxConcurrentExecutions: 6,
  delegationLimit: 8,
  wallClockMs: 2 * 60 * 60 * 1_000,
  reservationTtlMs: 2 * 60 * 1_000,
}
```

Không mở public config ở P0. Test được inject limit nhỏ hơn.

## Contract xuyên phase

- Node status: `preparing | queued | running | cancelling | completed | failed | cancelled | interrupted`.
- Terminal không quay lại active.
- Structural fields bất biến: graph/root/parent/agent/request/fingerprint/capability hash/depth/created time.
- Reservation tính vào provisional limits; chỉ committed node tăng `delegationUsed`.
- Request fingerprint SHA-256 trên canonical normalized request; cùng ID khác fingerprint fail.
- Capability được re-authenticate dưới graph lease trước commit.
- `backend.spawn()` chạy trong graph lease sau mọi preparation; spawn trả khi process/backend record tồn tại, không chờ completion.
- Reconciliation hỏi backend ngoài graph lock, rồi apply monotonic transition dưới lock.
- Cancel đánh dấu cả subtree trước, gọi backend leaf-first sau khi thả lock.
- Detached supervisor spec `0600` bị unlink ngay sau validated read, trước runtime spawn.

## Vì sao chưa có token/tool budget

ALP spawn Claude/Codex CLI và không sở hữu model gateway chung. Usage sau response không thể ngăn overspend đồng thời; per-tool hook sẽ đưa lại interception overhead mà repo đã chủ động bỏ. Structural limits + lifetime allowance + concurrency + deadline đủ đóng recursion trong P0. Metering là proposal riêng khi interactive/headless có cùng measured contract.

## Rủi ro đã đưa xuống phase

1. Lost update giữa CLI processes → process contention test ở Phase 0.
2. Capability giả/mất/leak → fail-closed auth + HMAC + supervisor-spec security tests ở Phase 1/3.
3. Caller chết giữa reservation và spawn → TTL/queued recovery ở Phase 2.
4. Cancel giao cắt spawn → graph lease + deterministic race barriers ở Phase 3.
5. Deadline giết sai/nghỉ timer → injected clocks và attached/detached tests ở Phase 3.
6. Locator lệch graph → validate + scan-and-repair ở Phase 0/4.
7. Legacy/new dual path drift → graph-first, legacy-only-when-absent tests ở Phase 2.
8. Phạm vi phình sang orchestration/metering → explicit non-goals và built-in role assertion ở Phase 4.

## Rà đối kháng khi chia plan

- **Đường chạy:** tự rà; đây là tái tổ chức một thiết kế đã review, không mở kiến trúc mới.
- **Phát hiện:** 0 CHẶN · 4 NÊN SỬA · 2 GHI NHẬN.
- **Nhận có sửa:** dependency native-binary; request fingerprint đầy đủ; capability retry bằng HMAC; supervisor spec unlink sớm.
- **Ghi nhận:** scan fallback tăng tuyến tính theo lịch sử graph nhưng chỉ chạy khi locator hỏng; fixed limits cần proposal cấu hình sau P0.
- **Quyền quyết định:** principal đã yêu cầu tự kiểm tra và tự chọn phương án, nên các sửa trên được áp dụng trực tiếp.
