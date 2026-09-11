# P3 — CLI continue + recovery

**Mục tiêu:** Thread trở thành unit of work ở cấp CLI: tạo, xem, tiếp tục, đóng, và tự phục hồi sau crash — không còn đồng nhất với một terminal process.
**Phụ thuộc:** P2.

---

## Bối cảnh

- Dispatcher `src/cli/alp.ts:119-120` — thêm nhánh `thread` cùng kiểu `delegation`/`context`.
- Reconcile mẫu: `ExecutionGraphService.reconcile` (`execution-graph-service.ts:769`) — snapshot intention, release lease, probe backend, reacquire với expected revision.
- Graph reservation TTL: `defaults.ts:23` (2 phút). Thread dùng TTL riêng cùng ý nghĩa, test-injectable.

## CLI surface v1

```text
alp [--title <t>]                  Thread mới + root #1
alp thread list [--all]            mặc định lọc workspace = cwd, status = open
alp thread show <id>
alp thread continue <id> [--mode]  root #n+1
alp thread close <id>
alp thread archive <id>
alp thread context <id>            in snapshot hiện tại
alp thread reconcile <id>          debug
```

Không expose store path. Không có `thread executions` riêng: `show` đã liệt kê; child xem qua `alp delegation tree <root-id>` — **không** duplicate tree renderer.

<!-- Sửa: kiểm chứng lượt 1 — chốt luôn tạo mới -->
**Bare `alp` luôn tạo Thread mới**; không auto-continue, không prompt. In ra stderr trước khi launch:

```text
Thread: thread_x   (continue later: alp thread continue thread_x)
```

### `continue`

```text
1. load Thread; ThreadService.reconcile(id)
2. require status = open                      → THREAD_CLOSED | THREAD_ARCHIVED
3. require không ref unsettled                → THREAD_BUSY <executionId>
4. projection pending → projectContext trước
5. mode: selector như hiện tại (có thể khác E-1 → runtime khác)
6–: y hệt root flow P1 từ bước 2 (authorize → reserveRoot → createRoot → materialize → launch)
```

**Không** reuse `ExecutionPolicy` cũ. E-2 authorize lại theo `AgentDefinition`/policy hiện tại.

`THREAD_BUSY` gợi ý: `alp delegation status <exec>`, `alp delegation cancel <exec>`, hoặc fork Thread (P2+ tương lai). P1 không có live attach.

### "Reconnect" nghĩa là gì

Process cũ đã chết/terminal đóng → Thread còn → `continue` mở **Execution mới**. Không phải attach vào stdin/stdout cũ. Ghi rõ trong docs (P5) để không hứa parity Amp.

### close / archive

| | Điều kiện | Làm | Không làm |
|---|---|---|---|
| close | không ref unsettled | status → closed | xoá data, cancel graph |
| archive | closed ∧ không unsettled | status → archived | xoá execution/thread artifact |

### `ThreadService.reconcile(id)`

Cho mỗi ref `settled === null`, **ngoài lease**:

```text
graph = findByExecutionId(ref.executionId)
  none ∧ now − reservedAt > TTL          → intent: settle interrupted
  none ∧ trong TTL                       → giữ (đang preparing)
  root terminal                          → intent: settle <root.status>
  root active → graph.reconcile(graphId) → probe backend → terminal? settle : giữ
```

Rồi Thread lease + expected revision → apply intent nếu ref vẫn unsettled. Monotonic: đã settled thì bỏ qua intent.

`ThreadActivity` = `idle` | `running` (ref unsettled ∧ graph root active) | `unsettled` (ref unsettled ∧ graph terminal/missing → cần reconcile). `show` luôn reconcile trước khi in.

### Env

Root process nhận thêm `ALP_THREAD_ID` (cạnh `EXECUTION_BINDING_ENV`). Chỉ label — `alp thread show` không có đối số đọc nó cho tiện; không dùng cho authorization.

## Việc phải làm

1. Test fail trước: hai `continue` đồng thời → một `THREAD_BUSY`/revision conflict; `continue` vs `close` race; crash sau reserve → reconcile interrupted sau TTL; graph terminal nhưng ref unsettled → settle đúng outcome; close/archive rules; lock-order test cho reconcile.
2. `src/cli/commands/thread.ts` — parse + render; usage vào `alp.ts` help.
3. `src/cli/alp.ts` — nhánh `thread`, flag `--title`, wiring `ThreadService` (store path từ `threadsDirectory()`).
4. `src/cli/commands/run-main.ts` — tách `startRoot(thread, deps)` dùng chung cho bare `alp` và `continue`.
5. `src/thread/thread-service.ts` — `reconcile`, `close`, `archive`, `activity`; TTL option.
6. `src/runtime/adapter-files.ts` — `ALP_THREAD_ID` vào env.

## File đụng tới

| File | Hành động | Đổi gì |
|---|---|---|
| `src/cli/commands/thread.ts` | tạo | subcommands |
| `src/cli/alp.ts` | sửa | dispatch, `--title`, wiring, help |
| `src/cli/commands/run-main.ts` | sửa | dùng chung root flow cho continue |
| `src/thread/thread-service.ts` | sửa | reconcile/close/archive/activity |
| `src/runtime/adapter-files.ts` | sửa | env `ALP_THREAD_ID` |
| `test/cli/thread-command.test.ts`, `test/thread/thread-reconcile.test.ts`, `test/e2e/thread-continue.test.ts` | tạo | |

## Rủi ro

| Failure mode | Giảm thiểu |
|---|---|
| Terminal chết, process còn sống | graph/backend là truth; `show` = `running` tới khi backend nói terminal |
| Graph terminal, ref unsettled | reconcile monotonic settle |
| Hai terminal `continue` cùng lúc | Thread lease + invariant 4 (một unsettled) → một thắng |
| `close` race với `continue` | cùng lease; exactly one wins |
| Reconcile giữ Thread lease khi probe backend | cấm bởi nguyên tắc 5; test đếm lease |
| Windows path/lock | chạy suite trên CI matrix như graph store đã làm |
| Thread sprawl (mỗi `alp` một Thread) | `list` lọc cwd + open, sort `updatedAt` desc; chấp nhận ở P1 (đã chốt, xem Nhật ký kiểm chứng) |

## Tiêu chí hoàn thành

- `npx vitest run test/cli/thread-command.test.ts test/thread test/e2e/thread-continue.test.ts` xanh.
- E2E: bare `alp` → Thread T, E-1; kill CLI; `alp thread continue T` → E-2, cùng T, ID khác; `alp thread show T` in 2 execution + activity idle.
- Concurrent `continue` ×2 → đúng một root mới.
- `npm test` xanh (gồm e2e main/delegation/graph hiện có).
