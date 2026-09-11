# P5 — Cross-runtime proof, docs, migration, adversarial gate

**Mục tiêu:** Chứng minh Thread không phá security Execution, chạy thật qua Claude → Codex → Claude, chốt docs/migration, và mở khoá Native Binary.
**Phụ thuộc:** P4 (hoặc P4 ở `final-only` — vẫn đủ điều kiện).

---

## Cross-runtime scenario (bắt buộc, chạy tay + e2e với fake adapters)

```text
Thread T  --title "Fix authentication bug"
E-1 main/Claude  investigate  → pin decision/next-action → completed → context rev 1
E-2 main/Codex   implement    → thấy rev 1 → pin → completed → context rev 2
E-3 main/Claude  review       → thấy rev 2
```

Assert: `T` không đổi; 3 ID khác; 3 `policyHash` khác; `policy.runtime/model` đúng từng E; digest chain `rev0 → rev1 → rev2`; child delegated không nằm trong `T.executions`; PID độc lập; launch spec E-2/E-3 không có `--resume`/session id.

**Drive bằng `alp context pin`** — đây là nguồn duy nhất projector thấy ở interactive (P2). Scenario nào "pass" mà không pin là scenario giả.

## Migration

| Loại | Chính sách |
|---|---|
| Execution/graph cũ, không có `thread` | đọc như cũ; normalize `thread: null`; hiển thị `legacy-unthreaded`; **không** backfill Thread giả |
| Root `alp` sau cutover | bắt buộc có Thread |
| Child delegate | kế thừa từ node cha; không được `null` khi cha có |
| Execution nội bộ không thuộc user work (nếu có) | allowlist tường minh, `thread: null` cố ý; test cutover không cho user-facing root bypass |

State layout thêm `~/.alp/threads/`: `ensure-state` tạo (`src/install/state.ts:206` cạnh `executionsDirectory`); update không xoá; uninstall theo luật user-state hiện hành.

## Docs

| File | Đổi gì |
|---|---|
| `docs/user/deep-dive/thread.md` | tạo — Thread là gì, `continue` nghĩa gì, "reconnect" **không** phải attach process |
| `docs/user/deep-dive/{execution,execution-graph,continuity,glossary}.md` | ranh giới với Thread; glossary thêm `Thread` |
| `docs/user/concepts/how-alp-works.md` | flow `alp` → Thread → Execution |
| `docs/user/reference/cli.md`, `docs/user/sidebar.json` | `alp thread *`, `--title` |
| `docs/architecture.md` | tầng Thread |

Glossary canonical:

```text
AgentDefinition = declarative role      Execution      = immutable authorized run
Thread          = durable unit of work  ExecutionGraph = run-local delegation/cancellation tree
Runtime         = adapter/model CLI     Process        = backend OS execution
Memory          = cross-thread durable knowledge
```

Thread ≠ Memory: Thread là một việc; Memory là tri thức tái dùng qua nhiều Thread. P1 **không** auto-write memory khi Thread đóng.

Docs canonical không gọi Execution là "session/thread". `node scripts/check-docs-drift.cjs` sạch (script chỉ đo version/pin/preview — thêm banner PREVIEW cho thread.md nếu release chưa cắt).

## Ma trận đối kháng

| Nhóm | Case | Kỳ vọng |
|---|---|---|
| Security | sửa `thread.json` xin thêm tool | policy không đổi |
| | forge `parentThreadId` | không capability |
| | gắn policy Thread A vào B | `THREAD_EXECUTION_BINDING_MISMATCH` |
| | child đọc Thread mutable thay vì `node.thread` | test phải làm implementation như vậy **fail** |
| | context chứa text policy-like | permission không đổi |
| | `ALP_THREAD_ID` giả | không ảnh hưởng authority |
| Concurrency | continue×2; continue vs close; continue vs archive; reconcile vs settle; projection vs continue | đúng một thắng, revision không mất |
| Crash (inject) | sau reserve; sau createRoot; sau materialize; sau spawn; sau process terminal trước settle; sau payload trước index | mọi case hội tụ sau `reconcile` |
| History | duplicate event; transcript hỏng; runtime unsupported; secret-like args; file đổi bị xoá; partial khai partial | không crash, không fabricate |
| Regression | execution-service, identity-capsule, graph (all), delegation, backend, continuity/compact, mode-selection, e2e main/delegation | xanh |

## Hiệu năng

Không SLO mới. Ghi baseline vào `plans/reports/test-260911-1811-thread-unit-of-work.md`: create Thread; `list` 100 Thread; `show` Thread 100 execution; overhead `continue` (trừ probe runtime). `get(id)` không scan `threads/`.

## Rollout

1. Merge P0–P1 (không đổi hành vi user-facing ngoài `thread: null` trong policy).
2. Bật Thread cho root `alp` (P1) + context (P2) + CLI (P3).
3. History bridge với completeness (P4).
4. Gỡ bypass tạm; scenario + ma trận xanh → đánh `status: completed`.

## Mở khoá Native Binary

<!-- Sửa: kiểm chứng lượt 1 — chặn hẹp, mở khoá sau P0 -->
Điều kiện đã lùi về **P0**: `threadsDirectory()` + `scripts/lib/install-paths.cjs` + `ensure-state` merge và `test/cli/state-paths.test.ts` xanh. Khi đó bỏ `260911-1811-thread-unit-of-work` khỏi `blockedBy` của Native Binary; P1–P5 chạy song song với nó. Native Binary không đụng `run-main`/hook entry, nên không còn coupling nào khác.

## Cần principal duyệt

- Cutover bare `alp` bắt buộc tạo Thread (đổi hành vi mặc định cho mọi user).

## Tiêu chí hoàn thành

- `npm test` xanh; `npm run typecheck` sạch; `node scripts/check-docs-drift.cjs` sạch.
- Scenario Claude→Codex→Claude chạy tay ít nhất một lần, log đính vào report test.
- Report test có ma trận đối kháng đánh dấu từng case + baseline hiệu năng.
- Câu sau đúng về kiến trúc lẫn test: *một Thread sống qua nhiều Execution, Runtime, Process; mỗi Execution vẫn là security snapshot độc lập; ExecutionGraph vẫn là authority delegation/cancellation của từng lần chạy.*
