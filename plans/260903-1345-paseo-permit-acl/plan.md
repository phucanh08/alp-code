# Paseo: ACL qua `permit`, và nâng lên 0.7.x

Trạng thái: **Phase 0 xanh, Phase 1 xong**. Còn Phase 2 và Phase 3.
Nhánh: `feat/session-context-delegation-channel`.
Phạm vi bản này: **chỉ Paseo**. Backend `local` để phase sau.

## Vấn đề

`paseo run` là `run [options] <prompt>` và tự spawn runtime — không exec passthrough, không
cờ settings/config. Đã xác nhận **giống hệt nhau trên 0.5.1 và 0.7.2**. Hệ quả:
`claude-settings.json` không tới được agent do Paseo spawn, nên mất:

- `permissions.deny` — cách ly private memory giữa các role ở tầng file
- `permissions.deny` theo tool — tool ngoài policy
- `sandbox.filesystem.denyWrite` — read-only workspace

Đang chấp nhận đánh đổi này (mode `bypass` cho role ghi, `plan` cho read-only), enforcement còn
lại nằm ở `MemoryService` + `PolicyEngine`, trên runtime.

## Phase 0 — Gate: `permit` có nổ không? → **CÓ**

Đo ngày 2026-09-03. Giao cho role `search` (read-only, `--mode plan`) task ghi file:

```
$ paseo permit ls --json
[{ "id": "permissi", "agentId": "95bd6577-…", "agentShortId": "95bd657",
   "name": "ExitPlanMode", "description": "-" }]

$ paseo wait 95bd6577-… --timeout 2 --json
{ "status": "permission", "message": "Agent is waiting for permission: plan" }
```

Kết luận: Paseo **có** forward permission request cho agent Claude do ALP spawn. Phase 2 khả thi.

Phát hiện kèm theo, quan trọng: **`inspect` không surface permission.**

```
paseo inspect → Status: running      ← status() đọc cái này
paseo wait    → status: permission   ← chỉ wait() thấy
```

Nên phải hỏi thẳng hàng đợi `permit ls` mới thấy được block mà không phải chờ.

## Phase 1 — Đã xong

- `status()` phát hiện block qua `permit ls --json`, lọc theo `agentId`. Fail-open khi không đọc
  được hàng đợi: daemon chết không phải bằng chứng có block.
- `jsonPayload()` quét từ `{` hoặc `[` đầu tiên. `paseo run` in `Created workspace wks_… - name`
  và `Tip: …` **trước** JSON khi workspace chưa tồn tại → trước đây `JSON.parse` cả stdout làm
  **delegation đầu tiên vào mọi project mới đều fail**.
- `BackendExecutionResult.error` và `DelegationResult.error` được khai báo và propagate qua
  `DelegationService.result()`. Trước đó backend đã sinh `error` nhưng type không có trường này
  nên **mọi** lý do thất bại đều bị nuốt.

Verify end-to-end: execution kẹt ở `ExitPlanMode` giờ trả

```
STATUS: failed
ERROR: Paseo execution `exec_…` dừng ở permission prompt; delegated run chạy background
       nên không ai trả lời được. Kiểm tra tool grant của role trong src/agents/ …
```

thay vì `running` vô hạn.

**Đã rút lại:** nghi ngờ `wait --timeout` sai đơn vị là **sai**. Đo thực tế: `--timeout 8` và
`--timeout 8s` đều chờ ~9.2s rồi trả `timeout`. Paseo nhận cả hai dạng. Không cần sửa.

## Phase 2 — Arbiter `permit`. **DỪNG** (2026-09-03)

Recon xong, API đủ dùng, nhưng không xây. Lý do: giá trị thu về chỉ còn ACL theo tên tool —
thứ `capsule.allowedTools` đã nói ở tầng chỉ dẫn và `PolicyEngine` đã chặn ở `prepare`. Lỗ hổng
thật (một role đọc file private memory của role khác) **không** vá được vì permission request
không mang path. Đổi một stateful component phải quản lifecycle lấy một lớp phòng thủ mỏng là
không đáng. Chỗ giải quyết được là backend `local` — Phase 4.

Phần dưới giữ lại làm hồ sơ recon, để lần sau không phải đo lại.

### Recon đã verify

Vòng đầy đủ đã chạy thật ngày 2026-09-03 trên một agent `--mode default` được giao lệnh `rm` rồi
đọc `/etc/hosts`:

1. **Detect** — `paseo inspect <agent> --json` trả `PendingPermissions: [{id, tool}]` với id đầy
   đủ `permission-<uuid>`. Không cần gọi `permit ls`.
2. **Decide** — theo `ExecutionPolicy.allowedTools`.
3. **Act** — `paseo permit deny <agent> <full-id>` → `{"result":"denied"}`;
   `paseo permit allow …` → `{"result":"allowed"}`.
4. **Agent chạy tiếp.** Bị deny `Bash` (file `victim.txt` không bị xoá), agent không chết, đi tiếp
   và sinh request mới cho `Read`. Allow xong thì agent về `idle`.

### Giới hạn cứng: không có tham số tool

`PendingPermissions` chỉ có `{id, tool}`. `permit ls` chỉ có
`{id, agentId, agentShortId, name, description}` với `description` luôn là `-`.
`logs --filter permissions` trả **"No activity to display"** — filter đó không bắt được gì.

Hệ quả: arbiter **chỉ quyết định được theo tên tool**, không theo path. Nghĩa là
**cách ly private memory giữa các role vẫn không lấy lại được** — đó vốn là lý do ban đầu muốn
làm Phase 2. Enforcement lấy lại được đúng phần "tool ngoài policy".

Tham số tool **có** trong transcript (`[Shell] rm victim.txt && ls -la`, `[Read] /etc/hosts` là
đúng lệnh đang chờ duyệt), nhưng phải ghép dòng log cuối với `PendingPermissions[].tool` — racy,
phụ thuộc format hiển thị. Không nên xây ACL lên nền đó.

### Bug Paseo phát hiện được

`permit ls --json` cắt `id` còn 8 ký tự: mọi entry đều là `"permissi"`, bất kể agent hay tool —
truncation của bảng rò vào cả `--json`. Chỉ `inspect` cho id dùng được. Nên báo upstream.

### Còn phải quyết

- Poll interval; request có TTL không.
- Đánh đổi: quay lại per-call interception mà `permission-rules.ts:8-11` đã cố tình bỏ. Chi phí
  giờ là polling daemon chứ không phải spawn process mỗi tool call, nhưng vẫn là stateful
  component mới phải quản lifecycle.
- **Có đáng làm không**, khi giá trị thu về chỉ còn ACL theo tên tool — thứ mà `capsule.allowedTools`
  đã nói cho agent biết ở tầng chỉ dẫn. Câu này nên trả lời trước khi viết code.

## Phase 3 — Nâng Paseo lên 0.7.x

Rủi ro thấp: `wait`/`logs`/`inspect` giống hệt giữa 0.5.1 và 0.7.2. Lợi ích:

- `--prompt-file <path>` → đưa thẳng `task.md`, bỏ chuỗi `"ALP task is in …; execute it."`.
- `--no-inject-mcp` → thay cho việc `runtimeToolPolicy()` phải đọc `~/.paseo/config.json` và bắt
  principal sửa `daemon.mcp.injectIntoAgents`.
- `--isolation <local|worktree>`.

Việc phải làm: kiểm lại giả định 0.5.x hard-code trong comment `codex-adapter.ts` (Codex
`read-only` mode) xem 0.7.x đã expose chưa.

## Phase 4 — Backend `local` (ngoài phạm vi bản này)

`local` là đường duy nhất hiện có enforcement đầy đủ, vì nó exec trực tiếp launch spec kèm
`--settings`. Kiểm tra cho hoàn chỉnh ở phase sau.

## Trạng thái các phase

| Phase | Trạng thái |
|---|---|
| 0 — gate `permit` | xong, xanh |
| 1 — ba bug che khuất block | xong, đã release |
| 2 — arbiter `permit` | **dừng**, không đáng làm |
| 3 — nâng Paseo 0.7.x | chưa làm |
| 4 — backend `local` | chưa làm, là chỗ duy nhất lấy lại được ACL theo path |

## Câu chưa có lời đáp

Đã trả lời xong:

- `permit` có nổ cho agent Claude do ALP spawn — **có**.
- Tham số tool có trong `permit`/`inspect` không — **không**, chỉ có tên tool.
- `permit ls` field `id` có bị cắt không — **có**, còn 8 ký tự; dùng `inspect` thay thế.
- Execution treo 12 phút hôm 2026-09-03 — parked ở permission prompt, `inspect` báo `running` nên
  không ai thấy.
- `wait --timeout` có sai đơn vị không — **không**.
