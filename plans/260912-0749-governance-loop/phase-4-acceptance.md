# P4 — Acceptance

**Mục tiêu:** cha chấp nhận/từ chối kết quả child bằng hành động được xác thực; quyết định tới Thread context qua `projectContext` như **nguồn thứ hai**, không phải pin.
**Phụ thuộc:** P3 (evidence digest). Đóng vòng governance.

---

## Bối cảnh

- `alp delegate` xác thực cha: `readBindingFromEnvironment(env)` (`src/cli/commands/delegate.ts:300`) → `graph.authenticateParent(binding)` (`execution-graph-service.ts:512`); sai binding ⇒ `CAPABILITY_INVALID` / `EXECUTION_NODE_NOT_FOUND`.
- Graph node structural fields bất biến; ghi node = `revision + 1`; doc `version: 1`.
- `projectContext` (`thread-service.ts:223`) đọc checkpoint; `context-projector.ts` chỉ lấy pins (`pin.source !== THREAD_SEED_PIN_SOURCE`). Pins là agent-authored.
- `settleRoot` (`thread-service.ts:453`) ghi boundary.
- `delegatesViaBash` (`permission-rules.ts:176`) cho role có `delegatesTo` gọi `alp delegate` — cùng cửa cho `accept|reject`.

## Thiết kế

### Contract

```ts
// src/execution/acceptance.ts
export interface AcceptanceRecordV1 {
  readonly version: 1;
  readonly requestId: string;
  readonly subjectExecutionId: string;
  readonly acceptedByExecutionId: string;     // phải === node.parentExecutionId của subject
  readonly decision: "accepted" | "rejected";
  readonly evidenceDigest: string;            // digest lúc quyết; evidence đổi sau ⇒ lệch, thấy được
  readonly reasons: readonly string[];        // redact
  readonly decidedAt: string;
}
```

- Lưu `<parent execution>/acceptance/<requestId>.json` (atomic). Graph node subject thêm `acceptance: { decision, evidenceDigest, decidedAt } | null` — additive, `version` giữ 1, `revision + 1`.
- Không có record = `undecided` (derive, không lưu).

### Guard (mọi cái fail-closed, mã lỗi mới trong `ExecutionGraphErrorCode`)

| Điều kiện | Mã |
|---|---|
| binding không xác thực được | `CAPABILITY_INVALID` (hiện có) |
| `authenticated.node.executionId !== subject.parentExecutionId` (sibling, ông, chính nó) | `ACCEPTANCE_NOT_PARENT` |
| subject chưa settled | `ACCEPTANCE_SUBJECT_RUNNING` |
| đã có record | `ACCEPTANCE_ALREADY_DECIDED` |
| chưa có `evidence.json` | **cho quyết**; `evidenceDigest` = digest evidence rỗng — record tự nói "quyết khi chưa có bằng chứng" |

Root không có cha ⇒ không ai accept root; root settle qua Thread như hiện nay.

### Producer

`alp delegation accept <requestId> [--reason …]` / `alp delegation reject <requestId> --reason …` (reject bắt buộc reason). Thêm vào `TOOL_CATALOG` cùng nhóm `alp delegate` cho role có `delegatesTo`. Instruction `main` (`src/agents/main.ts`) cập nhật: sau `wait`, đọc evidence, gọi accept/reject.

### Consumer

1. `settleRoot`: boundary thêm `delegations: { accepted, rejected, undecided }` (đếm; additive). **Không chặn** settle khi `undecided` — gate `orchestrator` mới bật.
2. `projectContext`: nhận `acceptances` (đọc graph của root vừa settle, ngoài Thread lease, trước khi vào lease) ⇒ checkpoint section do ALP sinh:
   ```ts
   // context-types.ts — additive
   readonly delegations: readonly {
     requestId: string; target: AgentId; task: string;      // task cắt 200 ký tự
     decision: "accepted" | "rejected" | "undecided"; evidenceDigest: string | null;
   }[];
   ```
   Giữ N = 20 mục gần nhất (hằng nội bộ, test-injectable, cùng cơ chế `THREAD_CONTEXT_MAX_BYTES`). Render trong handoff dưới heading riêng `## Delegations of E-n (ALP-recorded)` — **sau** Thread context pins, không trộn.
3. `alp thread show`: section này; `alp delegation tree`: cột `decision`.

**Quyết định:** không dùng pin. Pin = agent-authored; acceptance = ALP-authored từ record xác thực. Trộn là mất provenance ngay ở lớp context.

## Việc phải làm

1. Test fail trước: guard từng dòng (sibling/ông/chính nó/running/đã quyết); accept ⇒ `revision + 1`, node có `acceptance`; `projectContext` sinh `delegations` đúng thứ tự, cắt N; boundary đếm đúng; policy engine không import `acceptance` (import-graph test); E2E binding cha ok / binding khác ⇒ `CAPABILITY_INVALID`.
2. `src/execution/acceptance.ts`: contract, `recordAcceptance`, `readAcceptances(parentExecutionId)`.
3. `src/execution/graph/execution-graph-service.ts`, `types.ts`, `errors.ts`: node `acceptance`, ba mã lỗi, `acceptChild(binding, requestId, decision, …)`.
4. `src/cli/commands/delegate.ts`: subcommand `accept\|reject` cạnh `tree` + đăng ký ở `src/cli/alp.ts`; `src/runtime/permission-rules.ts` / `TOOL_CATALOG`: cho phép.
5. `src/thread/context-types.ts`, `context-projector.ts`, `thread-service.ts` (`projectContext` nhận `acceptances`; `settleRoot` đếm), `src/runtime/render-session-context.ts` (heading mới).
6. `src/cli/commands/run-main.ts`: đọc acceptances trước `projectContext`.
7. `src/agents/main.ts` instructions; `alp thread show`, `alp delegation tree`.
8. `test/policy/import-graph.test.ts`: `src/policy/**` không import `evidence|acceptance|usage|thread`.

## File đụng tới

| File | Hành động | Đổi gì |
|---|---|---|
| `src/execution/acceptance.ts` | tạo | contract + store |
| `src/execution/graph/{execution-graph-service,types,errors}.ts` | sửa | `acceptChild`, node field, mã lỗi |
| `src/cli/commands/delegate.ts`, `src/cli/alp.ts` | sửa | lệnh |
| `src/runtime/permission-rules.ts`, capability catalog | sửa | cho phép `alp delegation accept\|reject` |
| `src/thread/{context-types,context-projector,thread-service}.ts`, `src/runtime/render-session-context.ts` | sửa | nguồn thứ hai |
| `src/cli/commands/run-main.ts` | sửa | truyền acceptances |
| `src/agents/main.ts` | sửa | instruction |
| `test/execution/acceptance.test.ts`, `test/thread/projector-delegations.test.ts`, `test/policy/import-graph.test.ts`, `test/e2e/acceptance.test.ts` | tạo | |
| `docs/delegation.md`, `docs/architecture.md` | sửa | |

## Rủi ro

| Failure mode | Giảm thiểu |
|---|---|
| `main` không gọi accept/reject | Boundary ghi `undecided`; handoff hiện `undecided`; gate orchestrator mới bắt buộc |
| Cha accept trước khi evidence thu xong | Cho phép, `evidenceDigest` rỗng tự khai; `alp delegation tree` đánh dấu `decided-before-evidence` |
| Đọc graph dưới Thread lease | Đọc **trước** `withExclusiveLease` trong `projectContext`; test khẳng định không nest |
| Section `delegations` phình handoff | N = 20, task cắt 200; drop theo `THREAD_CONTEXT_MAX_BYTES` sau pins |
| Model viết `reasons` chứa policy-like text | Text thuần; redact; policy không đọc |

## Tiêu chí hoàn thành

- `npx vitest run test/execution test/thread test/policy test/e2e/acceptance.test.ts` xanh.
- `main` thật: delegate → wait → `alp delegation accept` trên cả Claude và Codex; `alp thread continue` handoff có `## Delegations of E-1`.
- Import-graph test xanh; `npm test` xanh.
- **Gate "governance loop đóng"** đánh dấu trong `plan.md`.
