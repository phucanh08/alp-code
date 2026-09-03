# Backend `local`: parity với Paseo 0.7.2

Tiếp nối Phase 4 của `plans/260903-1345-paseo-permit-acl/plan.md`.
Nhánh gợi ý: `feat/local-backend-parity`. Phạm vi: **chỉ backend `local`**.

## "Full tính năng như Paseo 0.7.2" nghĩa là gì

Paseo 0.7.2 có 20+ nhóm lệnh: `hub`, `terminal`, `script`, `schedule`, `heartbeat`,
`plugin`, `speech`, `project`, `workspace`, `provider`, `permit`, worktree isolation,
`--image`, `--output-schema`. Parity với **toàn bộ** sản phẩm đó = dựng lại một daemon
đa-workspace. Đó không phải thứ ALP cần và không phải mục tiêu ở đây.

Parity thực chất, và là thứ bản này nhắm tới: **`local` và `paseo` thay thế được cho nhau
sau contract `ExecutionBackend`** (`src/backend/execution-backend.ts`, 6 method). Cộng thêm
một điều kiện riêng — `local` phải giữ được lợi thế mà Paseo không có: nó exec thẳng
launch spec kèm `--settings`, nên `permissions.deny` và `sandbox.filesystem.denyWrite`
tới được agent. Đó là lý do Phase 4 tồn tại.

### Ánh xạ capability

| Paseo 0.7.2 | ALP dùng qua | `local` hôm nay | Trong phạm vi |
|---|---|---|---|
| `run --background` | `spawn()` | không detach, không lưu state | **có** — P1, P2 |
| `run --json` → `agentId` | `runtimeId` trong state | không ghi pid đi đâu | **có** — P1 |
| `run --cwd/--env` | `launchSpec.cwd/env` | có | — |
| `run --label` | metadata truy vết | không có | **có** — P1 (field trong record) |
| `run --provider/--model/--mode` | `launchSpec.command/args` | có, **và** kèm `--settings` | — (local mạnh hơn) |
| `run --wait-timeout`, `wait --timeout` | `wait(id, {timeoutMs})` | **bỏ qua tham số** | **có** — P3 |
| `inspect --json` | `status()` | chỉ in-memory | **có** — P1 |
| `logs --tail 200` | `transcript()` | không có gì | **có** — P2 |
| `stop` | `cancel()` | chỉ in-memory, không giết cây process | **có** — P1, P2 |
| `agent archive --force` | `cleanup()` | chỉ xoá temp file | **có** — P1 |
| `ls --label` | `listExecutions()` | core store có; backend không có orphan list | **có** — P4 |
| `daemon status` | `healthCheck()` | hằng số `ok: true` | **có** — P4 |
| `permit allow/deny` | — | **không cần**: `--settings` chặn trước khi có prompt | **có** — P5 (đo để chứng minh) |
| `run --output-schema` | `WorkflowRunner` + `output-validator.ts` | đã có ở tầng core | — |
| `send`, `attach`, `agent mode/reload/detach/update` | — | không nằm trong contract delegation | không |
| `run --new-workspace local\|worktree` | — | ALP chưa có khái niệm worktree isolation | không (xem câu hỏi cuối) |
| `hub`, `terminal`, `script`, `schedule`, `heartbeat`, `plugin`, `speech` | — | không phải delegation | không |

## Phase 0 — Đo. **Xong 2026-09-03**

Không đoán. Mười một phép đo, chạy thật.

### A. Probe trực tiếp `LocalProcessBackend` (child là `node -e`, exit code 3)

| # | Đo | Kết quả |
|---|---|---|
| 1 | `spawn()` | `{status: "running"}` — không có state `queued`, không ghi đĩa |
| 2 | `status()` từ **instance thứ hai** | **THROWS** `unknown local execution \`exec_probe1\`` |
| 3 | `wait(id, {timeoutMs: 50})` | block **437ms** tới khi child xong, không có timeout error |
| 4 | `output` ở kết quả terminal | **không có** |
| 5 | `error` ở kết quả terminal | **không có** — fix Phase 1 của bản trước chỉ áp cho `paseo` |
| 6 | `healthCheck()` | `{ok: true, message: "local process backend available"}` — hằng số, không probe runtime |
| 7 | `wait()` khi binary không tồn tại | throw `Error` trần `spawn … ENOENT`, không phải lỗi có type |
| 8 | `status()` khi binary không tồn tại | có `output` = message ENOENT (đường duy nhất output chảy ra hôm nay) |

### B. Đo qua CLI thật

**Tiền đề chính đã được xác nhận**: `local` chạy được end-to-end. Trước hôm nay chưa từng
được đo — cả 8 record trong `code-native-executions.json` đều là `backend: "paseo"`.

```
$ node scripts/delegate.cjs delegate search --backend local "Đếm số file .ts trong src/backend…"
{ "executionId": "exec_86d3dede93ac4538bfa0", "status": "completed",
  "output": "**2** …", "exitCode": 0, "metadata": { "backend": "local", "runtime": "claude" } }
```

Đúng đáp án, `output` chảy về qua `state.json` (hook `execution-bridge`), `--settings` tới nơi.

Hai đo tiếp, cả hai đều hỏng:

| # | Đo | Kết quả |
|---|---|---|
| 9 | `delegate … --background` | Trả JSON `running` ngay, **nhưng** transcript của agent vẫn đổ thẳng ra stdout của principal (stdio `inherit`), và tiến trình CLI **không thoát** cho tới khi child xong. `--background` hiện không background. |
| 10 | `delegation status <id>` ở process khác | **ERROR** `unknown local execution \`exec_32aea4a0a3f6458688a6\`` |
| 11 | `input.lifecycle` | `spawn()` nhận nhưng **không đọc** — `background`/`interactive`/`timeoutMs` bị bỏ nguyên |

### Kết luận Phase 0

`local` đúng ở đường foreground và là đường duy nhất có ACL đầy đủ. Nó hỏng ở **mọi** thứ
liên quan tới thời gian sống vượt quá một process CLI. Nguyên nhân gốc là một dòng:
`private readonly executions = new Map()`. Bảy trong mười một khiếm khuyết trên đổ về đó.

## Gap tổng hợp

1. **State chỉ nằm trong RAM** → `status`/`wait`/`cancel`/`cleanup` chết ở process thứ hai. (đo 2, 10)
2. **Không detach** → `--background` không background, child giữ tty của principal. (đo 9)
3. **Không bắt output** → không có gì tương đương `paseo logs --tail`. Execution crash trước khi hook finalize thì `state.json` còn `status: "prepared"`, `result()` giữ nguyên `failed` và **không có một dòng chẩn đoán nào**. (đo 4)
4. **Không có `error`** trên đường thất bại. (đo 5)
5. **`wait` bỏ qua `timeoutMs`** → `--timeout-ms` là no-op; agent treo thì treo vô hạn. (đo 3)
6. **`healthCheck` là hằng số** → không biết `claude`/`codex` có trên PATH hay không; `alp delegation switch local` luôn xanh kể cả khi runtime chưa cài. (đo 6)
7. **Lỗi không có type** → `DelegationErrorCode` không có `EXECUTION_TIMEOUT`; `runtimeFailure()` phía CJS không có bản TS tương ứng. (đo 7)
8. **Không có orphan reconciliation** → child sống sót qua CLI exit mà không ai biết pid.
9. **`cancel` giết mỗi process gốc**, không giết cây con của runtime.

## Phase 1 — State bền. *Nền của tất cả phần còn lại*

`src/backend/local-execution-store.ts` (mới): JSON file atomic + lock, record

```ts
{ executionId, pid, pgid, status, cancelled, cwd, logFile, resultFile,
  temporaryFiles, labels: { requestId, parentExecutionId, role }, createdAt, exitCode, signal }
```

- File: `<stateDir>/local.json`, đối xứng với `<stateDir>/paseo.json`.
- `record()` đọc từ đĩa, không từ Map. `status()` hợp nhất record với liveness thật.
- `labels` thay cho `--label` của Paseo — cùng bốn khoá `alp.*` mà backend paseo gắn.

**DRY, cần quyết trước khi code**: repo đang có **ba** file-store gần giống nhau —
`scripts/lib/delegation/core/execution-store.cjs` (có lock), `FileDelegationExecutionStore`
(`delegation-service.ts`, atomic rename), `FileExecutionStore` (`src/execution/`). Đừng thêm
cái thứ tư một cách mù quáng: tách helper "atomic JSON file + lock" dùng chung, hoặc nêu rõ
lý do vì sao ba cái phải khác nhau.

Xong Phase 1: đo 2 và đo 10 phải xanh.

## Phase 2 — Background thật, và transcript

Kiến trúc: **supervisor mỗi execution** — bản không-daemon của thứ Paseo daemon làm.

`src/backend/local-supervisor.ts` (mới, ~80 dòng, chạy như entry script):

1. `spawn` runtime thật (qua `resolveSpawnCommand` để giữ nguyên fix Windows `.cmd`).
2. Pipe stdout+stderr vào `<stateDir>/logs/<executionId>.log`.
3. Khi child đóng: ghi `<stateDir>/results/<executionId>.json` = `{exitCode, signal, endedAt}`, xoá `temporaryFiles`.

`LocalProcessBackend.spawn()` phân nhánh theo `input.lifecycle` — thứ hôm nay đang bị bỏ:

| lifecycle | đường đi |
|---|---|
| `background: true` | spawn supervisor với `detached: true`, `stdio: "ignore"`, rồi `unref()` |
| `interactive: true` | giữ nguyên đường hiện tại, `stdio: "inherit"` — tty là bắt buộc |
| còn lại (foreground) | supervisor + log file; CLI `wait()` tail log ra stdout |

Lợi ích, theo đúng thứ tự các gap:
- Exit status bền, không phải đoán từ pid → hết PID-reuse hazard (gap 1, 8).
- `transcript()` = 200 dòng cuối của log file → parity với `paseo logs --tail 200` (gap 3).
- `cancel()` giết cả process group: `process.kill(-pgid, sig)`; Windows dùng
  `taskkill /PID <pid> /T /F` — ghi rõ trong `windows-shim.ts` (gap 9).
- `--background` thôi chiếm tty của principal (gap 2).

Xong Phase 2: đo 9 phải xanh — JSON trả về, shell trả prompt ngay, transcript nằm trong log.

## Phase 3 — `wait` có timeout, lỗi có type

- `wait(id, {timeoutMs})`: poll result file tới deadline. Quá hạn → ném lỗi timeout, **không**
  giết execution (Paseo cũng vậy: `wait --timeout` hết giờ trả `timeout`, agent chạy tiếp).
- Thêm `"EXECUTION_TIMEOUT"` vào `DelegationErrorCode` (`src/delegation/types.ts:4`).
- Điền `error: {code, message}` cho mọi đường thất bại: ENOENT binary, exit khác 0, signal.
  Đây là bản TS của `runtimeFailure()` bên `backend.cjs`; phân loại giống nhau
  (`BACKEND_UNAVAILABLE` khi binary không tồn tại, `EXECUTION_TIMEOUT` khi hết giờ).
- Khi exit khác 0 mà `state.json` chưa terminal: đặt `output` = tail của log. Đây là chỗ vá
  lỗ chẩn đoán ở gap 3 — hiện tại một execution crash trả `failed` trống trơn.

Xong Phase 3: đo 3, 5, 7 phải xanh.

## Phase 4 — `healthCheck` thật, và orphan

- `healthCheck()` gọi `RuntimeAdapter.probe()` cho runtime đang chọn (`claude-adapter.ts` /
  `codex-adapter.ts` đã có `probe()`), trả `{ok, message, remediation}` cùng shape với backend
  paseo. `alp delegation switch local` khi chưa cài runtime phải **fail**, không phải xanh giả.
- `orphanExecutions()`: record `running` mà pid đã chết và không có result file → báo cáo.
  Backend paseo trả `[]` (daemon tự lo); `local` không có daemon nên phải tự đối soát.
- Đối soát chạy ở `status()` và ở `alp delegation list`.

## Phase 5 — Chứng minh lợi thế ACL. *Đây là lý do Phase 4 tồn tại*

Phase 2 của bản trước dừng vì Paseo **không** lấy lại được cách ly private memory theo path.
`local` đưa `--settings` thẳng cho runtime, nên về lý thuyết làm được. Chưa ai đo.

Đo, theo đúng kiểu Phase 0 của bản trước:

1. Giao cho role `search` (read-only) task đọc private memory của role khác → kỳ vọng
   `permissions.deny` chặn, agent **không** dừng ở prompt (background không ai trả lời).
2. Giao task ghi file trong workspace read-only → kỳ vọng `sandbox.filesystem.denyWrite` chặn.
3. Giao task gọi tool ngoài `capsule.allowedTools` → kỳ vọng deny.

Cả ba phải chặn **mà không sinh permission prompt**. Nếu có prompt, `local` thừa hưởng đúng
bệnh parked-agent của Paseo và cần cơ chế phát hiện riêng — ghi lại kết quả trước khi
quyết định gì thêm.

Kết quả phase này là câu trả lời cho: có nên đổi `delegation.backend` mặc định sang `local` không.

## Phase 6 — Harness parity

`scripts/test-delegation-backends.cjs` hiện chỉ dựng stub cho paseo; `local` chỉ xuất hiện ở
hai dòng kiểm `switch`. Nâng thành **một bộ test chạy hai lần**, một lần mỗi backend, trên
cùng contract: spawn → status ở process khác → wait có timeout → cancel → cleanup → orphan.

Backend nào không qua được thì không gọi là parity.

## Kết quả thi công (2026-09-03)

Làm theo thứ tự khuyến nghị: P5 trước, rồi P1–P4, P6.

### Phase 5 — ACL. **Xanh dứt khoát.** Tiền đề đúng

Settings sinh ra đúng shape: deny `Read`/`Edit` cho cả 7 private dir của role khác,
deny `Write`/`Edit`/`WebSearch`/`WebFetch` theo tên, `sandbox.filesystem.denyWrite` trên
workspace, `failIfUnavailable: true`.

Giao `search` (read-only) ba việc, đo thật:

| Việc | Kết quả |
|---|---|
| Read `memory/private/oracle/README.md` | **BỊ CHẶN** — `File is in a directory that is denied by your permission settings.` |
| `echo probe > acl-probe.txt` | **BỊ CHẶN** ở ba tầng độc lập: plan mode, sandbox (`operation not permitted`), tool availability (`Write is disabled for this session`). File không được tạo. |
| `cat /etc/hosts` | thành công — đọc ngoài workspace không bị chặn, đây là giới hạn đã biết, không phải regression |

`status: completed`, `exitCode: 0`, **không sinh permission prompt nào**. Đây chính là thứ
Phase 2 bản trước phải bỏ vì Paseo không làm được: cách ly private memory **theo path**.

### Phase 1–4 — đã thi công

| File | Vai trò |
|---|---|
| `src/backend/local-execution-store.ts` (mới) | record bền + `FileLocalExecutionStore` có dir-lock, `<stateDir>/local.json` |
| `src/backend/local-supervisor.ts` (mới) | supervisor mỗi execution: tee log, ghi result file, dọn temp |
| `src/backend/local-process-backend.ts` | rẽ nhánh theo `lifecycle`, transcript, timeout, orphan, kill process group, healthCheck thật |
| `src/delegation/types.ts` | thêm `EXECUTION_TIMEOUT` |
| `src/cli/commands/delegate.ts` | truyền `stateDir` cho `local` |
| `src/cli/commands/run-main.ts` | khai báo `lifecycle.interactive` |

### Đo lại — 11 phép đo Phase 0, chạy trên code mới

| # | Trước | Sau |
|---|---|---|
| 1 | `spawn` không ghi đĩa | `running` + `metadata.logFile`, record trên đĩa |
| 2 | cross-instance status **THROWS** | `{status: "running"}` |
| 3 | `wait({timeoutMs:50})` block 437ms rồi trả | ném `EXECUTION_TIMEOUT` sau 53ms |
| 4 | output **không có** | `"HELLO-FROM-CHILD\nERR-LINE"` |
| 5 | `error` **không có** | `ExecutionFailed` kèm transcript |
| 6 | healthCheck hằng số `ok:true` | `ok:true (claude, codex)`; `ok:false` + remediation khi PATH rỗng |
| 7 | binary thiếu → `Error` trần | `BACKEND_UNAVAILABLE` + "Check that `claude`/`codex` is on PATH" |
| 8 | — | orphan list hoạt động |
| 9 | `--background` chiếm terminal, CLI không thoát | **0.23s**, JSON trả ngay, không in transcript ra terminal |
| 10 | `status` ở process khác **ERROR** | `running` → `wait` ở process thứ ba → `completed`, `output: "pong"` |
| 11 | `lifecycle` bị bỏ | quyết định cả ba chế độ chạy |

Thêm, đo end-to-end qua CLI:

- **Cancel**: background → `status: running` → `cancel` → `cancelled`, và `pgrep` xác nhận
  không còn process `claude --settings` nào sống. Process group bị giết cả cây.
- **Timeout foreground**: `--timeout-ms 4000` → exit 2, đúng 1 dòng output, trả shell về ngay,
  không để lại process treo.
- **Foreground thường**: vẫn stream trực tiếp ra terminal, `output` đúng, `completed`.

### Bốn bug phát hiện trong lúc thi công

1. **Supervisor gọi `finish` hai lần.** Spawn hỏng phát cả `error` lẫn `close`; lần sau ghi đè
   lần đầu, nên runtime thiếu trên PATH bị ghi là `exit code -2` → phân loại thành lỗi
   execution thay vì lỗi máy. Đã guard.
2. **Đọc transcript trước khi stream flush.** `end()` chỉ *lên lịch* flush; đọc ngay sau đó
   cắt mất đúng những dòng cuối — tức là dòng nói vì sao chạy hỏng. Cả backend lẫn supervisor
   đều dính; supervisor còn phải flush log **trước** khi ghi result file, vì `status()` coi
   result file là bằng chứng đã xong và đọc transcript cùng lúc.
3. **`status()` đoán liveness bằng pid kể cả khi đang giữ child handle** → một foreground run
   khoẻ mạnh bị báo là orphan. Execution mà chính process này đang giữ thì đang chạy theo
   định nghĩa.
4. **`run-main` spawn không có `lifecycle`** → với code mới nó rơi vào nhánh `pipe`, làm hỏng
   phiên interactive của principal (mất tty). Đây là regression do chính bản này gây ra, bắt
   được nhờ đọc lại call site chứ không phải nhờ test. Đã sửa + pin bằng test.

Thêm một wart do bản này gây ra rồi sửa: `stdio: "pipe"` để stdin treo, khiến Claude chờ hết
timeout stdin của nó — **mỗi delegation foreground chậm thêm 3 giây**. stdin giờ là `ignore`.

### Một chỗ cố ý lệch Paseo

**Timeout ở attached mode thì dừng execution**, khác với background và khác Paseo.
Lý do: background có supervisor giữ và sẽ ghi lại kết cục, nên wait hết giờ chỉ là caller bỏ
cuộc. Attached thì không có ai giữ — nó là child của chính CLI, đang ghi vào stdout của CLI.
Bỏ mặc thì nó chiếm terminal, chạy xong không ai ghi nhận, rồi hiện ra như orphan ở lần
`status` sau. Cả hai nhánh đều có test riêng.

### Phase 6 — harness parity

`scripts/test-delegation-backends.cjs` giờ chạy **một contract hai lần**, mỗi backend một
lần: spawn → status từ instance khác → wait quá hạn có type → wait tới terminal có transcript
→ cleanup. Fixture `local` chạy supervised, vì đó mới là chế độ hai backend thay thế được
cho nhau.

### Verify

- 255 test xanh (thêm 17 so với 238), typecheck sạch.
- `scripts/test-delegation-backends.cjs` xanh cả hai backend.
- `scripts/test-execution-hooks.cjs` xanh.
- `scripts/doctor.cjs` → `code-native alp-code healthy`.

## Trạng thái

| Phase | Nội dung | Trạng thái |
|---|---|---|
| 0 | Đo gap | **xong**, 11 phép đo |
| 1 | State bền | **xong** |
| 2 | Supervisor: background + transcript | **xong** |
| 3 | `wait` timeout + lỗi có type | **xong** |
| 4 | `healthCheck` thật + orphan | **xong** |
| 5 | Đo ACL | **xong, xanh** — tiền đề đúng |
| 6 | Harness parity hai backend | **xong** |
| 7 | Đổi mặc định sang `local` | **xong** |
| 8 | Test battery trước commit | **xong** — tìm ra 1 bug thật, đã vá |

## Quyết định DRY đã chốt

Không gộp bốn file-store. Lý do từng cái phải riêng:

- `src/execution/execution-store.ts` — thư mục mỗi execution, staged rename. Primitive khác hẳn.
- `scripts/lib/delegation/core/execution-store.cjs` — phải là CJS vì Paseo backend là CJS.
- `FileDelegationExecutionStore` — record tầng core, mảng, không lock.
- `FileLocalExecutionStore` (mới) — **cần lock**, vì `status()` đối soát pid chết thành record
  terminal, nên hai process cùng poll một execution sẽ read-modify-write đè lên nhau.

Việc gộp sẽ phải kéo theo cả `FileDelegationExecutionStore`, tức sửa code đang chạy tốt cho
một lợi ích ~8 dòng. Không làm.

## Phase 7 — Đổi mặc định sang `local`. **Xong 2026-09-03**

Principal quyết: đổi. Lý do đã đủ sau Phase 5 — `local` là đường duy nhất còn cách ly private
memory theo path, và sau P1–P4 nó không còn thua Paseo về vận hành nữa.

| Chỗ sửa | Từ | Sang |
|---|---|---|
| `alp.config.yaml:backend` | `paseo` | `local` |
| `config.cjs` fallback khi không có config | `"paseo"` | `"local"` |
| `README.md` ví dụ `alp init --backend` | `paseo # hoặc local` | `local # mặc định; hoặc paseo` |
| `<stateDir>/backend` trên máy dev | ghim `paseo` | xoá về default |

Cái cuối là chỗ dễ sót: `alp delegation switch` **thắng** config, nên đổi file config thôi
không có tác dụng cho tới khi `switch default` xoá lựa chọn cũ.

Verify: `alp delegate search "…"` không kèm cờ → `metadata.backend: "local"`, `completed`.
`switch paseo` vẫn hoạt động bình thường — Paseo không bị bỏ, chỉ thôi là mặc định.
255 test xanh, harness parity xanh, doctor `healthy`.

## Phase 8 — Test `local` trước khi commit. **Xong 2026-09-03.** Tìm ra 1 bug thật

Phase 0–7 chỉ đo role `search` (read-only). Battery này chạy những đường **chưa** đo.

| Đường | Kết quả |
|---|---|
| `principal → main`, workspace-write | **HỎNG lần đầu** → đã vá, xem dưới |
| runtime `codex` | xanh, `output: "codex-ok"` |
| 3 background song song | cả ba đúng, `local.json` 14 record, không lost-update |
| orphan: SIGKILL supervisor | `failed` + "is orphaned: process 5401 is gone and no result was recorded" |
| cancel process group | không còn process `claude --settings` sống |

### Bug: role `workspace-write` không đọc được task file của chính nó

Delegated `main` chết ngay lệnh đầu:

```
Read /Users/anhlp/.alp/delegation/…/runtime/task.md → permission denied
status: completed, nhưng không làm gì cả, hello.txt không được tạo
```

Nguyên nhân: `claudePermissions()` không hề nhận `runtimeDirectory`, nên
`additionalDirectories` thiếu đúng thư mục chứa `task.md` — trong khi launch spec bảo agent
"ALP task is in `<file>`; execute it".

Vì sao trước đó không ai thấy: role read-only chạy `--permission-mode plan`, và plan mode cho
read tool qua không cần hỏi. Role `workspace-write` **không** có mode nào như vậy
(`claude-adapter.ts`: interactive → `--dangerously-skip-permissions`, read-only → `plan`,
còn lại → không cờ), nên nó là role duy nhất lộ ra lỗi. Read-only chỉ sống sót **do may**.

Đây cũng là chỗ `local` từng **tệ hơn** Paseo: Paseo chạy role workspace-write ở mode `bypass`
nên không bao giờ dính.

Vá: thêm `runtimeDirectory` vào `RuntimePermissionInput` (bắt buộc, không optional — chính
việc để nó optional là thứ cho phép Claude ship thiếu) và đưa vào `additionalDirectories`.
Codex cũng truyền, dù sandbox của nó chỉ chặn ghi nên không dính.

Đo lại: `hello.txt` được tạo, nội dung `written-by-local`. Pin bằng test trong
`runtime-adapters.test.ts`.

### Một điểm lệch **không** phải bug

Delegated `main` báo capsule liệt kê `Tools: Read, Glob, Grep` nhưng `Write` vẫn chạy được.
Đúng, nhưng đã ghi sẵn ở `permission-rules.ts:16`: deny list dựng từ grant cấp **role**, còn
capsule hiển thị grant của **workflow state** hiện tại (ASSESS). Workflow-state tool gating
cố ý không cưỡng chế declaratively. Không sửa.

## Câu chưa có lời đáp

- **`FileDelegationExecutionStore` có race lost-update** (hai `alp delegate` chạy song song
  cùng `put()`). Có sẵn từ trước, không thuộc phạm vi bản này, nhưng nên vá.
- **Worktree isolation** (`paseo run --new-workspace worktree`): kéo vào `local` không?
- **Giới hạn song song.** `local` spawn không cap. Cap ở backend hay `DelegationService`?
- **Log retention.** `<stateDir>/logs/*.log` hiện `cleanup()` **giữ lại** để điều tra. Ai dọn,
  và sau bao lâu?
