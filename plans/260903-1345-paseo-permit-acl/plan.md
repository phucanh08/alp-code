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

## Phase 2 — Arbiter `permit`

Một thành phần đứng giữa `DelegationService` và Paseo.

- Poll `permit ls --json`, lọc theo agent thuộc execution đang quản (`agentId` === `runtimeId`).
- Với mỗi request: quyết định từ `ExecutionPolicy` — tool có trong `allowedTools` không, path có
  nằm trong workspace / own private memory không.
- `permit allow <agent> <req_id>` hoặc `permit deny`; ghi quyết định vào execution artifacts.
- Không quyết định được → `deny` (fail-closed, khớp `PolicyEngine`).

Khi có arbiter, mode có thể bỏ `bypass` quay về `default`: cứ để runtime hỏi, ALP trả lời. Đó là
enforcement **mạnh hơn** deny list tĩnh vì nó per-call và đọc được cả tham số.

Đánh đổi phải nói rõ: quay lại per-call interception mà `permission-rules.ts:8-11` đã cố tình bỏ.
Lần này chi phí là polling daemon chứ không phải spawn process mỗi tool call, nhưng vẫn là
stateful component mới phải quản lifecycle.

Chưa biết:

- Poll interval bao nhiêu để agent không chờ lâu mà cũng không đốt CPU.
- Request có TTL không; `permit ls` chỉ trả `{id, agentId, agentShortId, name, description}` —
  `description` là `-` trong mẫu quan sát được, nên **chưa rõ lấy tham số tool ở đâu** để quyết
  định theo path. Có thể phải đọc `logs --filter permissions`. Đây là rủi ro lớn nhất của Phase 2.
- `id` quan sát được là `"permissi"` (8 ký tự, trông như bị cắt) — cần xác minh trước khi dùng làm
  `req_id`, hoặc dùng `--all` cho mỗi agent.

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

## Câu chưa có lời đáp

- `permit ls` có đủ thông tin để quyết định theo path không, hay phải ghép với
  `logs --filter permissions`? (chặn Phase 2)
- `permit ls` field `id` có bị cắt không?
- Execution treo 12 phút hôm 2026-09-03: **đã giải thích** — parked ở permission prompt, `inspect`
  báo `running` nên không ai thấy. Không còn là câu hỏi mở.
