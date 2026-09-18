# Đo: `alp` gọi từ **trong** sandbox của `main` — thoát được không, và bằng gì?

**Đo ngày:** 2026-09-18 · **Binary:** `claude` 2.1.274–2.1.275 (Claude Code), `codex-cli` 0.154.0 · **Platform:** darwin 25.6.0 (Seatbelt) · **Model chạy lệnh:** haiku (`claude -p --allowedTools Bash`, `autoAllowBashIfSandboxed`), gpt-5.6-terra (`codex exec --skip-git-repo-check`). Mọi lệnh đọc stdin từ `/dev/null`.

## Vì sao phải đo

Chạy thật `RUNBOOK.md` (alp-usage-probe) trên cả hai runtime, 2026-09-18: `main` gõ
`alp delegate worker …` và **không giao được việc nào** — graph root `delegationUsed: 0`.

| Runtime | Triệu chứng |
|---|---|
| Claude (`--mode low`, root `exec_37039b…`) | `ERROR EPERM: operation not permitted, open '~/.alp/install.json.<pid>.tmp'`, exit 2 |
| Codex (`--mode puck`, root `exec_d5f7e7…`) | `exec_command` trả `stdout: ""`, `exit_code: 0`, duration 4 µs; model bỏ cuộc |

Nguyên nhân gần: `dispatchEntry` chạy `ensureState()` cho mọi lệnh (trừ `--version`/`hook`/
`__internal`), và `ensureState` **ghi lại** `~/.alp/install.json` — trong sandbox read-only thì
chết ngay dòng đầu. Nguyên nhân xa: kể cả bỏ `ensureState`, `alp delegate` cần ghi
`~/.alp/executions/<child>/`, `~/.alp/execution-graphs/`, `~/.alp/delegation/<hash>/`, và
**spawn** một worker — worker đó thừa kế sandbox của `main` (read-only cả workspace) nên
không thể ghi `src/hello.ts` dù policy của nó là `workspace-write`. Vấn đề là **kiến trúc**:
process `alp` chạy trong sandbox không thể là process thi hành delegation.

Trước 2026-09-18 vòng governance chỉ được chứng minh trên fake binary (e2e không có sandbox).

## Câu hỏi 1 — Cho riêng `alp` chạy ngoài sandbox được không?

### Claude: `sandbox.excludedCommands: ["alp *"]`

| Lệnh (Bash tool) | Kết quả |
|---|---|
| `alp mode show` | `medium`, exit 0, `install.json` được ghi lại → **thoát được** |
| `/Users/anhlp/.local/bin/alp mode show` | EPERM — pattern không khớp đường dẫn tuyệt đối |
| `alp mode show && touch <ws>/leak.txt` | **tạo được `leak.txt`** trong workspace bị `denyWrite` |
| `alp mode show; touch <ws>/leak2.txt` | **tạo được `leak2.txt`** |

`excludedCommands` áp cho **cả dòng lệnh**: chỉ cần mở đầu bằng `alp` là mọi thứ nối sau
`&&`/`;` cũng chạy ngoài sandbox. Với một vai read-only đây là cửa thoát sandbox trọn vẹn —
**loại**.

### Codex: execpolicy `allow` + escalation

| Cấu hình | Kết quả `alp mode show` |
|---|---|
| `sandbox_mode="read-only"`, `approval_policy="never"` | EPERM exit 2 |
| + `-c 'rules=[{prefix=["alp"],allow=true}]'` | EPERM exit 2 (rule không tự đưa lệnh ra ngoài sandbox) |
| `approval_policy="on-request"` + rule, prompt bảo "rerun with escalated permissions" | model **không** xin escalation; EPERM |
| `on-request` + rule, prompt ép `sandbox_permissions:"require_escalated"` | `Cannot run: elevated sandbox permissions are disallowed by the current environment.` |

Tài liệu (`codex-rs/prompts/templates/permissions/…`): allow rule chỉ bỏ sandbox khi model
**xin** `require_escalated` và rule khớp; `approval_policy=never` cấm `sandbox_permissions`
hoàn toàn; `codex exec` không có ai duyệt. Thoát sandbox phụ thuộc vào việc model có xin hay
không — không fail-closed, và trên đường ALP đang phóng thì bị cấm hẳn — **loại**.

### Kết luận câu 1

Không có cách nào để "chỉ `alp` chạy ngoài sandbox" mà (i) không rò cho phần còn lại của
dòng lệnh, và (ii) có trên cả hai runtime. **Process `alp` trong sandbox phải ở lại trong
sandbox.** Việc phải làm ở process khác — process root `alp` (run-main) đang sống suốt phiên,
ngoài sandbox, đã cầm binding của root.

## Câu hỏi 2 — Kênh nào từ trong sandbox tới process root?

### Unix socket — không

Server `net.createServer().listen(~/.alp/sbx-probe/alp.sock)`; client `net.connect` từ trong
sandbox:

| Runtime | Kết quả |
|---|---|
| Claude, sandbox mặc định | `connect EPERM` |
| Codex `read-only` | `connect EPERM` |

Claude có `sandbox.network.allowUnixSockets: [path]` (chỉ macOS; Linux phải
`allowAllUnixSockets`). Codex chỉ cho unix socket **qua network proxy** (`[permissions.<p>.network.unix_sockets]`,
header `x-unix-socket`) — không phải `connect()` trực tiếp. Không có đường chung, và trên
Linux Claude phải mở *mọi* socket. Ghi chú thêm: `sun_path` macOS giới hạn 104 byte —
`listen EINVAL` khi đặt socket trong scratchpad dài. **Loại**.

### File trong một thư mục được cho ghi — **được, cả hai**

Claude `sandbox.filesystem.allowWrite: ["~/.alp/sbx-probe"]` cùng `denyWrite: [ws]`:

| Lệnh | Kết quả |
|---|---|
| `echo hi > ~/.alp/sbx-probe/req.txt` | ghi được |
| `echo hi > <ws>/leak4.txt` | `Operation not permitted` |
| `touch ~/.alp/leak5.txt` (ngoài thư mục mở) | bị từ chối |

Codex — **`default_permissions` profile** (hệ mới, thắng `sandbox_mode` — xem câu 3):

```
-c 'default_permissions="alp"'
-c 'permissions.alp.filesystem={":root"="read","/Users/anhlp/.alp/sbx-probe"="write"}'
```

| Lệnh | Kết quả |
|---|---|
| `echo hi > ~/.alp/sbx-probe/req.txt` | ghi được |
| `echo hi > <ws>/leak3.txt` | `Operation not permitted` |

**Kết luận câu 2:** kênh là **file**: `alp` trong sandbox ghi request vào một thư mục ALP mở
riêng cho execution đó; process root thấy file, thi hành với binding của execution ấy, ghi
response về cùng thư mục. Không cần network, không cần socket, cùng cơ chế trên hai runtime,
và trên Linux cũng chỉ là một đường dẫn `allowWrite`.

## Câu hỏi 3 — Codex: `sandbox_mode` với `default_permissions` cái nào thắng?

| `-c sandbox_mode` | profile | ws ghi được? | probe ghi được? |
|---|---|---|---|
| `read-only` | root=read, probe=write | — | có |
| `workspace-write` | root=read, probe=write | **không** | có |

Profile thắng trọn: khi có `default_permissions`, `sandbox_mode` không còn nói gì về filesystem.

Thêm một lần đo scope con: profile `{":root"="read", "<ws>/scope"="write", "<ws>/.git"="read"}`,
cwd = `<ws>`:

| Lệnh | Kết quả |
|---|---|
| `touch <ws>/scope/a.txt` | tạo được |
| `touch <ws>/other/b.txt` | từ chối |
| `touch <ws>/.git/c.txt` | từ chối |
| `touch <ws>/new.txt` (entry mới cạnh scope) | **từ chối** |

Tốt hơn Claude (`partial`): entry mới bên cạnh scope cũng bị chặn ⇒ Codex `writeScope` thật
sự `enforced` — **khi cấu hình đi tới Codex**.

## Phát hiện phụ (bug có sẵn)

`src/runtime/codex-adapter.ts` ghi `approval_policy`, `web_search`, `writable_roots`,
`[[rules]]` vào `<execution>/runtime/codex-config.toml` — file **Codex không đọc** (chính
comment trong `permission-rules.ts` §`codexMcpOverrides` và `test/agents/auto-compact.test.ts`
nói vậy; hooks/MCP/auto-compact vì thế đã đi bằng `-c`). Sandbox thật của một launch Codex do
ALP phóng chỉ gồm `-s <workspaceMode>`: worker có `--write-scope src/foo` trên Codex vẫn
ghi được cả workspace, còn `[[rules]] prefix=["herdr"] allow=false` không bao giờ có hiệu
lực. `capabilities.ts` khai `CODEX_POSIX.writeScope: "enforced"` dựa trên phép đo bằng
`codex sandbox -c …` — đo đúng cơ chế, nhưng ALP chưa từng nối cơ chế đó vào launch.

Thêm nữa: phiên `main` interactive trên Codex phóng với
`--dangerously-bypass-approvals-and-sandbox` — `main` **không có sandbox nào** trên Codex,
trong khi trên Claude cùng vai chạy sandbox read-only. Chính vì vậy lần chạy thật trên Codex
không chết vì EPERM (mà chết vì lý do khác, chưa tách được: `unified_exec_startup` báo
`completed` sau 4 µs với output rỗng, không có execution con nào được tạo).

## Quyết định

1. **Relay qua file** (`<execution>/relay/`): `alp` trong sandbox chỉ viết request và đợi
   response; process root `alp` là process duy nhất thi hành lệnh delegation — với binding
   của execution gửi request, do ALP gắn lúc đăng ký thư mục, không đọc từ request.
2. Bỏ `ensureState` khỏi đường relay; bên trong execution không có lệnh nào chạy in-process
   ngoài `hook`/`__internal`/`--version`.
3. Cấu hình sandbox Codex đi bằng `-c` trên argv (profile `default_permissions`), cho cả
   delegated lẫn interactive; bỏ `--dangerously-bypass-approvals-and-sandbox` cho `main`.
4. Claude: `sandbox.filesystem.allowWrite: [<execution>/relay]` cho mọi launch có sandbox.

Chi tiết trong [`../plan.md`](../plan.md).
