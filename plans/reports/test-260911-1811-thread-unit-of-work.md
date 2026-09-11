# Test report — Thread as Unit of Work (P0–P5)

**Ngày:** 2026-09-11
**Plan:** `plans/260911-1811-thread-unit-of-work/`
**Gate:** `npm run typecheck` sạch · `npx vitest run` — **85 file / 1061 test xanh** (20.5 s) · `node scripts/check-docs-drift.cjs` — `OK docs/user/ đã nói về v0.13.0`

## 1. Câu chốt

> *Một Thread sống qua nhiều Execution, Runtime, Process; mỗi Execution vẫn là security snapshot độc lập; ExecutionGraph vẫn là authority delegation/cancellation của từng lần chạy.*

Đúng về kiến trúc và về test — bằng chứng ở §2 (kịch bản chạy thật với fake adapter) và §3 (ma trận). Ba mệnh đề, ba chỗ giữ:

| Mệnh đề | Giữ bởi |
|---|---|
| Thread sống qua nhiều Execution/Runtime/Process | `test/e2e/thread-cross-runtime.test.ts` — 3 root, 3 pid, runtime claude→codex→claude, không `--resume` |
| Mỗi Execution là snapshot độc lập | cùng file: 3 `policyHash` khác, binding `{id, rev, digest}` hash vào policy; `test/cutover/thread-not-authority.test.ts` — `src/policy`, `src/execution/graph`, `src/delegation`, `src/backend`, `src/hooks` **không import** `src/thread/` |
| Graph vẫn là authority của một lần chạy | `test/e2e/thread-binding.test.ts` — con C-1 vào cây của E-1, không vào `T.executions`; `test/execution/execution-tree-view.test.ts` — view mang binding root, legacy `null` |

## 2. Kịch bản Claude → Codex → Claude

Chạy qua đúng đường user đi: bare `alp --title`, hai lần `alp thread continue` đổi nấc (đổi runtime), mọi context qua `alp context pin`. Runtime là **fake adapter** của e2e harness (`test/e2e/harness.ts`: ghi capture `{argv, env, pid, sessionContext}`, giữ sống `holdMs` rồi thoát); lệnh thật chạy y hệt `src/cli/commands/run-main.ts` + `thread.ts` + `context.ts`.

Lần chạy e2e: `test/e2e/thread-cross-runtime.test.ts` ✓ 9.6 s. Log dưới là lần chạy tay cùng kịch bản (script scratch trên harness, in output CLI thật):

```text
$ alp --mode ultra --title "Fix authentication bug"        # E-1 · claude
  Thread: thread_2923e32498124f92b81b   (continue later: alp thread continue thread_2923e32498124f92b81b)
  runtime=claude pid=29784 argv=["--settings","/private/var/folders/j0/t2mzl4xn31bcxks3dgs124_00000gn/T/alp-e2e-WhtsUY/executions/exec_e1/runtime/claude-settings.json","--model","claude-opus-5","--mcp-config","/private/var/folders/j0/t2mzl4xn31bcxks3dgs124_00000gn/T/alp-e2e-WhtsUY/executions/exec_e1/runtime/mcp-config.json","--dangerously-skip-permissions"]
  $ alp context pin decision -- "Root cause: refresh token never rotated"
  PINNED     fb0117bd-dc85-4c69-91af-9e74944585d2
  $ alp context pin next-action -- "Rotate refresh token on every use"
  PINNED     43e90f4f-35f5-44d5-973b-c0ad6ca6b5ae
  $ alp delegate search -- "Find token rotation code"        # C-1, con của E-1
  C-1 exec_c1 → completed
  E-1 → completed
$ alp thread context thread_2923e32498124f92b81b
  Thread:    thread_2923e32498124f92b81b
  Revision:  1
  Objective: Fix authentication bug
  Decisions:
    - Root cause: refresh token never rotated  [exec_e1]
  Constraints: —
  Open items: —
  Next actions:
    - Rotate refresh token on every use  [exec_e1]
  Outcomes:
    #1  exec_e1  completed  claude  2026-09-11T15:07:52.332Z
  
$ alp thread continue thread_2923e32498124f92b81b --mode puck              # E-2 · codex
  Thread: thread_2923e32498124f92b81b   (continuation #2)
  runtime=codex pid=29786 argv=["--dangerously-bypass-hook-trust","--enable","hooks","-C","/private/var/folders/j0/t2mzl4xn31bcxks3dgs124_00000gn/T/alp-e2e-WhtsUY/project","-m","gpt-5.6-sol","-c","model_reasoning_effort=\"xhigh\"","-c","hooks.SessionStart=[{ hooks = [{ type = \"command\", command = \"\\\"/usr/local/Cellar/node/26.3.0/bin/node\\\" \\\"/Users/anhlp/StudioProjects/alp-worlspace/alp-code/hooks/session-boot.cjs\\\"\", timeout = 30 }] }]","-c","hooks.Stop=[{ hooks = [{ type = \"command\", command = \"\\\"/usr/local/Cellar/node/26.3.0/bin/node\\\" \\\"/Users/anhlp/StudioProjects/alp-worlspace/alp-code/hooks/session-end.cjs\\\"\", timeout = 30 }] }]","-c","model_auto_compact_token_limit=244800","--dangerously-bypass-approvals-and-sandbox"]
  session-context.md chứa rev 1: true
  $ alp context pin decision -- "Implemented rotation in TokenService.refresh"
  PINNED     41e93b2f-83ee-4bcc-ac15-ae523b5535be
  $ alp context pin open-item -- "Review the migration for old sessions"
  PINNED     c6c8d6cf-7845-4c86-a43a-9d57a202d8c1
  E-2 → completed
$ alp thread continue thread_2923e32498124f92b81b --mode ultra             # E-3 · claude
  Thread: thread_2923e32498124f92b81b   (continuation #3)
  runtime=claude pid=29802 argv=["--settings","/private/var/folders/j0/t2mzl4xn31bcxks3dgs124_00000gn/T/alp-e2e-WhtsUY/executions/exec_e3/runtime/claude-settings.json","--model","claude-opus-5","--mcp-config","/private/var/folders/j0/t2mzl4xn31bcxks3dgs124_00000gn/T/alp-e2e-WhtsUY/executions/exec_e3/runtime/mcp-config.json","--dangerously-skip-permissions"]
  session-context.md chứa rev 2: true
  E-3 → completed
$ alp thread show thread_2923e32498124f92b81b
  Thread:    thread_2923e32498124f92b81b
  Title:     Fix authentication bug
  Status:    open
  Activity:  idle
  Workspace: /private/var/folders/j0/t2mzl4xn31bcxks3dgs124_00000gn/T/alp-e2e-WhtsUY/project
  Agent:     main
  Context:   revision 3 (e29a5a4dd455…)
  History:   unsupported (3 entries)
  Updated:   2026-09-11T15:07:57.719Z
  
  Executions:
    #1  exec_e1  completed   rev 0  2026-09-11T15:07:49.647Z  history unsupported (0 entries)
    #2  exec_e2  completed   rev 1  2026-09-11T15:07:52.355Z  history unsupported (0 entries)
    #3  exec_e3  completed   rev 2  2026-09-11T15:07:55.039Z  history unsupported (0 entries)
  
  Children of a root: alp delegation tree <execution-id>
  Continue:            alp thread continue thread_2923e32498124f92b81b
  
$ alp thread context thread_2923e32498124f92b81b
  Thread:    thread_2923e32498124f92b81b
  Revision:  3
  Objective: Fix authentication bug
  Decisions:
    - Root cause: refresh token never rotated  [exec_e1]
    - Implemented rotation in TokenService.refresh  [exec_e2]
  Constraints: —
  Open items:
    - Review the migration for old sessions  [exec_e2]
  Next actions:
    - Rotate refresh token on every use  [exec_e1]
  Outcomes:
    #1  exec_e1  completed  claude  2026-09-11T15:07:52.332Z
    #2  exec_e2  completed  codex  2026-09-11T15:07:55.021Z
    #3  exec_e3  completed  claude  2026-09-11T15:07:57.710Z
  
policy.json:
  exec_e1  runtime=claude model=claude-opus-5          policyHash=a0f724803a34… thread={"id":"thread_2923e32498124f92b81b","contextRevision":0,"contextDigest":"485a047e0673…"}
  exec_c1  runtime=codex  model=gpt-5.6-terra          policyHash=bed21ba2ea63… thread={"id":"thread_2923e32498124f92b81b","contextRevision":0,"contextDigest":"485a047e0673…"}
  exec_e2  runtime=codex  model=gpt-5.6-sol            policyHash=3434161cdef4… thread={"id":"thread_2923e32498124f92b81b","contextRevision":1,"contextDigest":"daea06395ec3…"}
  exec_e3  runtime=claude model=claude-opus-5          policyHash=990a315467a1… thread={"id":"thread_2923e32498124f92b81b","contextRevision":2,"contextDigest":"49d4df60eb82…"}
graphs: exec_e1[exec_e1,exec_c1]  exec_e2[exec_e2]  exec_e3[exec_e3]
pids: 29784, 29786, 29802  · resume flags in argv: false
```

Đọc log:

- `T` không đổi: một `thread_…` xuyên ba root, `Title` giữ nguyên.
- 3 ID, 3 `policyHash`, 3 pid khác nhau; `runtime`/`model` đúng nấc từng E (`ultra` → claude-opus-5, `puck` → gpt-5.6-sol).
- Digest chain: E-1 mở trên rev 0 (`485a…` = digest rỗng), E-2 trên rev 1 (`daea…`), E-3 trên rev 2 (`49d4…`); `show` kết ở rev 3.
- C-1 (`exec_c1`) nằm trong graph `exec_e1[exec_e1,exec_c1]`, **không** nằm trong `Executions` của Thread; mang đúng binding rev 0 của cha.
- argv của E-2/E-3 không có `--resume`/`--continue`/session id.
- `History: unsupported` vì fake adapter không có transcript bridge — đúng luật "không bịa" (§3 History).

**Chưa làm:** chạy tay với `claude`/`codex` thật. `alp` bare là phiên interactive (TUI của runtime) — cần terminal của principal và tốn token model; không chạy được từ session này. Lệnh để chạy tay:

```bash
alp --mode ultra --title "Fix authentication bug"     # trong phiên: alp context pin decision -- "…"
alp thread list
alp thread continue <thread-id> --mode puck           # codex; session-context.md có mục "Thread context"
alp thread continue <thread-id> --mode ultra          # claude
alp thread show <thread-id>; alp thread sync <thread-id>; alp thread context <thread-id>
```

Với runtime thật, `History` kỳ vọng `complete` (Claude/Codex bridge đọc transcript qua `context/runtime-session.json` mà hook để lại — `test/hooks/session-boot.test.ts`, `test/runtime/{claude,codex}-history-bridge.test.ts`).

## 3. Ma trận đối kháng

Mỗi case → test giữ nó. ✅ = có test và xanh trong lần chạy này.

### Security — Thread không phải nguồn quyền

| Case | Kỳ vọng | Test | |
|---|---|---|---|
| Sửa `thread.json` xin thêm tool (`title`, `workspace: /`) | policy không đổi | `test/e2e/thread-binding.test.ts` › *does not let the thread record or its lineage change what an execution may do* — 8 trường quyền của E-2 == E-1 | ✅ |
| Forge `parentThreadId` | không capability | cùng test trên (`parentThreadId: "thread_privileged"`); `test/thread/thread-invariants.test.ts` › *forbids a thread parenting itself* | ✅ |
| Gắn policy Thread A vào B | `THREAD_EXECUTION_BINDING_MISMATCH` | `test/thread/history-bridge.test.ts` › *refuses an execution that is not part of the thread*; `test/thread/thread-context-projection.test.ts` › *refuses to project an unsettled or unknown execution*; `test/thread/thread-service.test.ts` › *refuses to settle an execution the thread never reserved*, *describes an execution only when thread ref and graph node agree on the binding* | ✅ |
| Child đọc Thread mutable thay vì `node.thread` | implementation như vậy phải fail | Cấu trúc: `test/cutover/thread-not-authority.test.ts` › *keeps every authority module free of any import from src/thread/* — `src/execution/graph` và `src/delegation` không thể nhìn thấy Thread. Hành vi: `test/execution/execution-graph-invariants.test.ts` › *requires every child to carry exactly its parent's thread binding* (`THREAD_BINDING_MISMATCH`); `test/e2e/thread-binding.test.ts` — `childPolicy.thread` == `firstPolicy.thread` trong khi Thread đã sang rev khác | ✅ |
| Context chứa text policy-like | permission không đổi | `test/e2e/thread-context.test.ts` › *hands policy-looking context text to the next root as text only* — pin `allowedTools: [...]; workspace: /; ALP_EXECUTION_CAPABILITY=grant-all` → 8 trường quyền không đổi, text xuất hiện **sau** mục "work state, not authority"; `test/thread/context-projector.test.ts` › *carries policy-looking pin text as text only*; `test/runtime/render-session-context.test.ts` | ✅ |
| `ALP_THREAD_ID` giả | không ảnh hưởng authority | `test/e2e/thread-binding.test.ts` › *ignores a forged ALP_THREAD_ID* — root vẫn mở Thread mới, `policy.thread.id` ≠ forged, env con mang ID thật; `test/cutover/thread-not-authority.test.ts` › *reads ALP_THREAD_ID in exactly one place* (`src/cli/commands/thread.ts`) | ✅ |
| Snapshot context bị sửa trên đĩa | `THREAD_CONTEXT_TAMPERED`, không rebuild | `test/thread/thread-context-projection.test.ts` › *refuses a tampered snapshot*; `test/thread/context-projector.test.ts` › *rejects an edited line, a foreign digest, and a snapshot filed under the wrong revision* | ✅ |
| Payload symlink / tên thoát thư mục | từ chối | `test/thread/file-thread-store.test.ts` › *refuses to adopt a payload that is a symlink*, *does not let a payload name escape its folder*; `thread-invariants` › invariant 9 | ✅ |

### Concurrency — đúng một thắng, không mất revision

| Case | Test | |
|---|---|---|
| `continue` × 2 | `test/e2e/thread-continue.test.ts` › *lets exactly one of two concurrent continues open a root* (1 ok, 1 `THREAD_BUSY`) | ✅ |
| `continue` vs `close` | cùng file › *lets exactly one of `continue` and `close` win the race* | ✅ |
| `continue` vs `archive` | cùng file › *never lets `continue` and `archive` both succeed* — open: archive `THREAD_INVARIANT_VIOLATION`; closed: archive thắng, continue `THREAD_CLOSED`/`THREAD_ARCHIVED` | ✅ |
| `reconcile` vs `settle` | `test/thread/thread-reconcile.test.ts` › *is monotonic: a settle that lands during the probe wins over the reconcile intent* | ✅ |
| projection vs `continue` | `test/e2e/thread-continue.test.ts` › *keeps one revision chain when two continues race a pending projection* — chuỗi `[1,0,1],[2,1,2]`, rev 2 có cả hai kết cục | ✅ |
| 20 process ghi cùng Thread | `test/thread/file-thread-store.test.ts` › *does not lose an update when twenty processes write the same thread* | ✅ |
| Lock order | `test/thread/thread-service.test.ts` › *never holds a thread lease and a graph lease at the same time*; `thread-reconcile` › *never holds the thread lease while it talks to the graph*; `history-bridge` — `collectDelta` ngoài lease | ✅ |

### Crash injection — mọi case hội tụ sau `reconcile`

| Chết sau | Test | |
|---|---|---|
| reserve (ref có, graph không) | `test/thread/thread-reconcile.test.ts` › *leaves a fresh reservation without a graph alone*, *settles … as interrupted once the TTL has passed*; `test/e2e/thread-continue.test.ts` › *marks a reservation that never reached the graph as interrupted* | ✅ |
| createRoot (graph `preparing`) | `thread-reconcile` › *asks the graph to probe the backend for an active root, and keeps the ref when it is still alive* | ✅ |
| materialize / spawn (process không còn) | `thread-reconcile` › *settles from the probed status when the backend says the process is gone*; `it.each` terminal status → outcome | ✅ |
| process terminal trước settle | `test/e2e/thread-continue.test.ts` › *recovers a root whose process died after the graph finished but before the thread was settled* — reconcile chép `completed`, chiếu rev 1, mở E-2 | ✅ |
| payload trước index (orphan) | `test/thread/thread-context-projection.test.ts` › *recovers from a crash between payload and index*; `file-thread-store` › *moves orphans into .quarantine and never back*, *leaves no temporary files or lock behind* | ✅ |
| chết khi giữ lock | `file-thread-store` › *reclaims a stale lock once its owner is provably gone*, *keeps a stale lock it cannot attribute*, *waits out a stale lock whose owner is still alive* | ✅ |
| root fail không có checkpoint đọc được | `test/e2e/thread-context.test.ts` › *keeps the pins and marks the revision degraded* | ✅ |

### History — không crash, không bịa

| Case | Test | |
|---|---|---|
| Duplicate event / chạy lại collect | `test/thread/history-bridge.test.ts` › *is idempotent*; `test/cli/thread-command.test.ts` › *syncs every settled root … a second sync adds nothing*; `claude-history-bridge` › *resumes from the cursor* | ✅ |
| Transcript hỏng (dòng malformed) | `test/runtime/claude-history-bridge.test.ts` › *reports partial on … malformed lines it had to skip*; `codex-history-bridge` › *is partial when … unknown shape* | ✅ |
| Runtime unsupported | `history-bridge` › *records unsupported for a runtime without a bridge and still lets the thread continue* | ✅ |
| Secret-like args | `test/thread/history-redact.test.ts` (10 case, kể cả private key và cắt UTF-8); `claude-history-bridge` › *redacts secrets before anything leaves the bridge* | ✅ |
| File đổi bị xoá / transcript thoát state dir / không session | `claude-history-bridge` › *degrades to final-only when there is no runtime session or the transcript escapes the state dir*; `history-bridge` › *a throwing bridge degrades to final-only* | ✅ |
| Partial khai partial; mức Thread = xấu nhất | `claude-history-bridge` › *partial on a version outside the pin*; `thread-command` › *prints the worst history completeness across roots* | ✅ |
| Boundary ghi một lần, sau settle | `history-bridge` › *appends one boundary after settle*, *does not write a boundary before settle* | ✅ |

### Migration / cutover

| Case | Test | |
|---|---|---|
| Graph cũ không có `thread` → `null`, không backfill | `test/execution/file-execution-graph-store.test.ts` › *reads a legacy graph without thread bindings and writes the key back on the next revision* | ✅ |
| Tree view / CLI hiển thị `legacy-unthreaded` | `test/execution/execution-tree-view.test.ts` › *carries the root's thread binding, or null for a legacy graph*; `test/cli/alp.test.ts` › *labels a legacy graph as unthreaded and a threaded graph by its thread* | ✅ |
| Root `alp` sau cutover bắt buộc có Thread | `test/e2e/thread-cross-runtime.test.ts`, `thread-binding`, `alp-main` — mọi root có `policy.thread` | ✅ |
| Child thừa kế từ node cha | `execution-graph-invariants` › *requires every child to carry exactly its parent's thread binding*; `thread-binding` e2e | ✅ |
| `~/.alp/threads/` trong ensure-state | `test/cli/state-paths.test.ts` — `threadsDirectory` == `scripts/lib/install-paths.cjs` | ✅ |

### Regression

`npx vitest run` toàn bộ: 85 file / 1061 test xanh — gồm execution-service, identity-capsule, graph (store, service, invariants, tree view, reconcile, cancel), delegation, backend, continuity/compact, mode-selection, e2e main/delegation/execution-graph/memory-isolation.

## 4. Baseline hiệu năng

Không SLO mới. Đo trên máy dev (Darwin 25.6, Node 26.3, `FileThreadStore` trên APFS tmp), script scratch qua `vite-node`, một lần chạy:

```text
create Thread (1)                                               2.6 ms
create Thread ×99 (sequential)                                 27.1 ms
list (100 Thread, open, workspace)                             15.0 ms
list --all (100 Thread)                                         8.0 ms
get(id) with 100 threads on disk                                0.2 ms
100 roots: reserve+settle+project (continue overhead, no runtime)    562.6 ms
  per-root overhead: p50 5.7 ms · p95 7.3 ms · max 7.6 ms
  thread.json 38268 bytes · revision 301 · compactions 0 · context rev 100
show (reconcile + activity + render) on 100-execution Thread      1.0 ms
  graph reads during show: 0
get(id) on 100-execution Thread                                 0.4 ms
currentContext() on 100-execution Thread                        0.8 ms
```

- `get(id)` **không scan** `threads/`: `FileThreadStore.get` → `readIndex(id)` mở thẳng `<root>/<id>/thread.json` (`src/thread/file-thread-store.ts:127`); 0.2 ms với 100 Thread trên đĩa, 0.4 ms với Thread 100 execution — không phụ thuộc số Thread.
- `list` quét `readdir` + đọc từng index: ~8–15 ms / 100 Thread.
- Overhead `continue` phía Thread (reserve + settle + project, trừ probe runtime): p50 5.7 ms, p95 7.3 ms.
- `show` Thread 100 execution (reconcile + activity + render): 1 ms, 0 lần đọc graph khi không có ref unsettled.
- `thread.json` 100 execution ≈ 38 KB; context 100 decision ngắn chưa chạm trần 32 KiB (0 compaction).

## 5. Cần principal duyệt

- **Cutover bare `alp` bắt buộc tạo Thread** — đổi hành vi mặc định cho mọi user: mỗi lần gõ `alp` để lại một thư mục `~/.alp/threads/<id>/` và in một dòng `Thread: … (continue later: …)`. Không có cờ tắt. Code và test đã theo hành vi này; docs đánh dấu Preview (`docs/user/deep-dive/thread.md`, `reference/cli.md`) tới khi cắt release.

## 6. Còn lại ngoài gate

- Chạy tay với runtime thật (§2) để thấy `History: complete` end-to-end — cần terminal của principal.
- Bỏ banner Preview khi release kế tiếp cắt (`check-docs-drift` sẽ nhắc).
