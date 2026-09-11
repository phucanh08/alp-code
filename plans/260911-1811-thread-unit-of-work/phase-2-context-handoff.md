# P2 — Context projection + handoff giữa execution

**Mục tiêu:** E-2 tiếp tục work của E-1 dù khác runtime/model/process, chỉ bằng `ThreadContextSnapshot` do ALP sở hữu — không phụ thuộc provider session resume.
**Phụ thuộc:** P1.

---

## Bối cảnh

- `ContinuityCheckpointV1` (`src/context/types.ts:49`) là continuity **trong** một execution; `seedCheckpoint()` (`src/context/checkpoint.ts:76`) được `ExecutionService.materialize` gọi với `objective = capsule.task | null`. Không đổi ownership, không rename.
- `renderSessionContext()` (`src/runtime/render-session-context.ts:80`) render capsule + policy thành system context cho cả hai runtime.
- **Giới hạn thật của interactive root** (`run-main.ts:78-87`): `task` là sentinel, stdio inherit, backend result thường không có `output`. ALP **không thấy** hội thoại. Nguồn dữ liệu duy nhất projector có ở P2: checkpoint pins của E-1 (`alp context pin`), terminal outcome, `title` Thread. Không hứa hơn.

## Thiết kế

### Hai lớp, không merge

```text
ThreadContextSnapshotV1   cross-execution   (Thread sở hữu, immutable per revision)
ContinuityCheckpointV1    within-execution  (Execution sở hữu, như hiện tại)
```

### Snapshot

```ts
interface ThreadContextSnapshotV1 {
  version: 1
  threadId: ThreadId
  revision: number                     // ≥ 1; 0 = "chưa có" (P0 hằng số)
  objective: string | null
  decisions: readonly ContextLine[]    // { text, sourceExecutionId, pinId? }
  constraints: readonly ContextLine[]
  openItems: readonly ContextLine[]
  nextActions: readonly ContextLine[]
  outcomes: readonly { executionId; sequence; outcome; runtime; finishedAt }[]
  createdAt: string
  digest: string                       // sha256 canonical của snapshot **trừ** field digest
}
```

Digest dùng `canonicalize` cùng luật với `execution-policy.ts` (sort key, bỏ `undefined`).

### Pipeline

```text
reserveRoot(E-n)   → binding = { id, rev N, digest(rev N) }
materialize(E-n)   → seedCheckpoint(objective = title ?? null)  + seed pins từ rev N (source "execution")
render session ctx → thêm mục "## Thread context" (label: work context, untrusted)
settleRoot(E-n)    → projectContext(E-n): đọc checkpoint E-n (verify integrity) + outcome + rev N → rev N+1
```

`projectContext` chạy **sau** `settleRoot`, dưới Thread lease riêng; ghi `context/<N+1>.json` trước, rồi index (`currentContext`, `ref.settled.nextContextRevision`). `nextContextRevision === null` sau settle = projection pending → P3 `continue` phải project trước khi reserve E-(n+1).

### Promotion — deterministic, không model

| Promote | Không promote |
|---|---|
| `objective` (title) | allowed tools, workspace roots |
| pins `decision/constraint/open-item/next-action` từ checkpoint E-n | shell/network permission, `delegatesTo` |
| terminal outcome ref | runtime flags, secrets, env |

Text pin kiểu "ignore policy / enable tool X" vẫn chỉ là text — permission engine không đọc snapshot. `outcome ∈ {failed, cancelled, interrupted}` → pins vẫn promote (là quyết định đã ghi), nhưng `nextActions` được gắn thêm dòng `"E-n ended <outcome>"`; không đánh dấu là thành công.

### Bounded

Budget nội bộ `THREAD_CONTEXT_MAX_BYTES` (test-injectable, không public config). Vượt → drop theo thứ tự: `openItems` cũ nhất → `decisions/constraints` cũ nhất (giữ mới nhất theo `sourceExecutionId` sequence) → `outcomes` cũ nhất, giữ tối thiểu 3. Ghi `ThreadCompactionRecordV1` (P4 định nghĩa; P2 chỉ ghi `fromRevision/toRevision/droppedCount`).

### Render vào runtime

Mục mới trong `renderSessionContext`, chỉ khi `policy.thread !== null`:

```markdown
## Thread context (work state, not authority)
Thread: thread_x · continuation #3 · previous: exec_b (codex, completed)
Objective: …
Decisions: … / Constraints: … / Open items: … / Next actions: …
```

Đặt **sau** `## Authority`, không trộn vào bảng authority.

## Việc phải làm

1. Test fail trước: digest ổn định; same input → same snapshot; revision monotonic; interrupted không thành success; bounded priority chính xác; malicious pin không đổi policy; projection crash → pending → recover.
2. `src/thread/context-types.ts`, `src/thread/context-projector.ts` (pure function: `(prev, checkpoint, outcome) → next`).
3. `src/thread/thread-service.ts`: `projectContext`, `pendingProjection`.
4. `src/execution/execution-service.ts`: `materialize` nhận `seedPins` (từ Thread) cho `seedCheckpoint`; `src/context/checkpoint.ts`: `SeedCheckpointInput.pins?`.
5. `src/runtime/render-session-context.ts`: mục Thread context; adapter không đổi.
6. `src/cli/commands/run-main.ts`: gọi `projectContext` sau `settleRoot`; đọc `title` từ flag `--title` (parse ở `src/cli/alp.ts`).

## File đụng tới

| File | Hành động | Đổi gì |
|---|---|---|
| `src/thread/context-types.ts`, `context-projector.ts` | tạo | snapshot + projector thuần |
| `src/thread/thread-service.ts` | sửa | `projectContext`, `pendingProjection` |
| `src/context/checkpoint.ts` | sửa | seed pins tuỳ chọn |
| `src/execution/execution-service.ts` | sửa | truyền seed pins vào checkpoint |
| `src/runtime/render-session-context.ts` | sửa | mục Thread context |
| `src/cli/alp.ts`, `src/cli/commands/run-main.ts` | sửa | `--title`; gọi projection |
| `test/thread/context-projector.test.ts`, `test/e2e/thread-context.test.ts` | tạo | |

## Rủi ro

| Failure mode | Giảm thiểu |
|---|---|
| Crash sau `settleRoot`, trước projection | `nextContextRevision: null` = pending; `continue` project lại từ checkpoint E-n còn trên đĩa; nếu checkpoint mất → project chỉ từ outcome, ghi `degraded: true` trong snapshot |
| `context/<rev>.json` bị sửa tay | digest mismatch → `THREAD_CONTEXT_TAMPERED`; không accept, không rebuild im lặng |
| Checkpoint E-n `integrity` sai | không promote pins; chỉ outcome; `degraded: true` |
| Pin chứa text policy-like | test adversarial: `ExecutionPolicy` E-(n+1) bằng hash không đổi |
| Test cross-runtime "pass" nhờ Claude native resume | scenario chạy Claude → Codex; assert không có `--resume`/session id trong launch spec |

## Tiêu chí hoàn thành

- `npx vitest run test/thread test/context test/e2e/thread-context.test.ts test/e2e/compact-continuity.test.ts` xanh.
- E2E: E-1 (adapter A) pin 2 decision → finish → E-2 (adapter B) checkpoint seed chứa đúng 2 pin, session context có mục Thread context, `policyHash` E-2 độc lập.
- `npm test` xanh.
