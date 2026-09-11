---
title: Runtime và launch spec
description: Hai adapter dịch một policy thành lệnh spawn — và cưỡng chế được tới đâu trên mỗi runtime.
---

> **Một câu:** Runtime là **CLI thật sự chạy model** (Claude Code hoặc Codex CLI), còn adapter là thứ dịch một `ExecutionPolicy` thành một lệnh cụ thể mà CLI đó hiểu.

ALP không nói chuyện với model. Nó chuẩn bị file, dựng argv, đặt biến môi trường, rồi spawn một CLI. Tất cả quyền lực của ALP nằm ở **những gì nó đặt vào lệnh đó**.

## Hai runtime

| | `claude` | `codex` |
|---|---|---|
| Binary | `claude` (`claude.cmd` trên Windows) | `codex` (`codex.cmd`) |
| Config ALP viết | `claude-settings.json` | `codex-config.toml` |
| Cấu hình vào phiên qua | `--settings <file>` | `-c key=value` trên argv |
| Sandbox ghi | `sandbox.filesystem.denyWrite` | `sandbox_mode` / `-s` |
| Deny list mức tool | `permissions.deny` (ACL thật) | không có tương đương |
| Subagent trong tiến trình | `--agents` | không có |

`probe()` của mỗi adapter chỉ trả lời một câu: binary có trên PATH không. Không có thì `alp doctor` báo kèm cách khắc phục, và không execution nào được spawn.

## Launch spec

`prepare()` trả về một `RuntimeLaunchSpec` đóng băng gồm năm phần: `command`, `args`, `cwd`, `env`, `temporaryFiles`.

`cwd` **luôn** là `capsule.activeWorkspace` — không phải thư mục người dùng đang đứng. Một execution làm việc ở nơi policy nói, không phải nơi terminal tình cờ đang mở.

## File adapter viết vào `runtime/`

| File | Nội dung |
|---|---|
| `identity-capsule.json` | Vai, execution ID, policy hash, workspace |
| `session-context.md` | Identity + invariant + policy context, pre-render |
| `task.md` | Nhiệm vụ (vắng mặt ở phiên interactive) |
| `claude-settings.json` / `codex-config.toml` | Cấu hình phiên |
| `mcp-config.json` | Chỉ Claude — danh sách MCP server được cấp |
| `skill-roots.json` | Các root skill đã resolve |

Tất cả ghi atomic, và mọi file đều nằm trong `temporaryFiles` để `cleanup` biết đường dọn.

Pre-render là một quyết định về tốc độ: hook khởi động chỉ đọc file, không nạp `dist/`, không dựng registry, không chạy Zod. Trỏ agent vào một file rồi bảo nó tự `Read` sẽ tốn một vòng tool trước khi có bất kỳ việc thật nào xảy ra.

## MCP fail-closed

Claude adapter viết `mcp-config.json` cho **mọi** execution, kể cả khi không server nào được cấp. File rỗng mới là điểm chính: đi cùng `--strict-mcp-config`, nó chặn một specialist kế thừa mọi MCP server tình cờ đang được cấu hình trên máy — tức là egress không policy nào cho phép và bảng Authority chưa từng nhắc tới.

`--strict-mcp-config` chỉ vắng mặt ở phiên interactive, nơi principal đang ngồi trước máy của chính họ.

Codex không có in-process subagent, nên một grant `subagents` đơn giản là không được dịch sang phía đó — subagent là tối ưu hoá, không phải điều kiện để một vai làm việc.

## Read-only được cưỡng chế thế nào

Trên **Claude**: `sandbox.enabled = true` với `failIfUnavailable: true`, `allowUnsandboxedCommands: false`, và `denyWrite` trỏ vào workspace; thêm `--permission-mode plan`.

Nhưng Claude Code **không bật sandbox trên Windows** — nó báo feature gate đang tắt, và vì ALP xin `failIfUnavailable`, nó từ chối khởi động. Xin một sandbox không thể tồn tại sẽ biến mọi execution trên Windows thành lỗi khởi động. Nên ở đó adapter không xin sandbox, và **rút `Bash`** thay thế: shell là đường còn lại duy nhất để một vai read-only ghi được.

Trên **Codex**: `sandbox_mode` và `-s` mang đúng `workspaceMode`. Sandbox của Codex chỉ hạn chế **ghi** — mọi path đều đọc được — nên cách ly private memory ở đó là ràng buộc mức prompt, không phải ACL.

| | Claude | Codex |
|---|---|---|
| Chặn ghi ngoài workspace | Sandbox | Sandbox |
| Chặn đọc ngoài workspace | `permissions.deny` | **Không** cưỡng chế được |
| Cách ly private memory | ACL thật | Mức prompt |

## Phiên interactive đánh đổi cái gì

`alp` (run-main) đặt `interactive = true`; **`alp delegate` luôn `false`**.

| | Claude | Codex |
|---|---|---|
| Cờ | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` |
| Mất gì | Toàn bộ `permissions.deny`, gồm cả cách ly private memory | Approval và sandbox |
| Turn 1 | Trống — tin nhắn đầu là của principal | Trống — không có positional PROMPT |

:::caution[Đây là một đánh đổi được khai, không phải một sơ suất]
Principal ngồi trước phiên interactive và tự duyệt được từng bước, nên prompt quyền chỉ là ma sát. Specialist được giao việc thì **không** có ai ngồi đó, nên chúng giữ nguyên sandbox và deny list.
:::

Ở phía Codex, `-s` bị **bỏ hẳn** khi bypass chứ không để lẫn: Codex không báo lỗi khi có cả hai, cờ bypass thắng, và một `-s` còn sót lại sẽ thành một dòng chết nói sai về chế độ đang chạy.

## Identity tới model bằng đường nào

Không bằng turn 1. Cả hai runtime đều biến `additionalContext` của hook `SessionStart` thành một message role `developer` **trước** lượt đầu tiên của người dùng.

Đo trên Codex CLI 0.149.0: một positional PROMPT trở thành message `role: user`, tức là turn 1. Phiên interactive vì thế không được có positional prompt — identity phải tới với tư cách `developer`, đứng trước người dùng.

Đây là cách một phiên interactive bắt đầu với đầy đủ brief mà **không tốn một lượt nào**.

## Auto-compact

Vai khai ngưỡng thì dùng ngưỡng đó; không khai thì ALP tự tính **90% cửa sổ context của model**. Claude nhận qua `autoCompactWindow`, Codex qua `model_auto_compact_token_limit`.

Con số 90% trùng đúng mặc định của Codex — nhưng tính ở phía ALP thì Claude cũng nén ở cùng chỗ, và "hai runtime nén ở cùng điểm" là thứ làm cho một so sánh giữa chúng có nghĩa.

Khi ALP cũng không biết cửa sổ của model, nó **không đặt gì** và để runtime tự tune.

## Hook trên Windows

Hai runtime cần hai cách viết lệnh hook khác nhau, và đây là chỗ đã từng ship sai.

- **Claude** spawn qua `cmd /d /s /c "<command>"`, nên dạng có dấu nháy là dạng chạy được.
- **Codex** tự tách lệnh thành argv, và token đầu tiên **không được** nằm trong dấu nháy: một command line *bắt đầu bằng* `"` không bao giờ resolve ra executable. Đo trên codex-cli 0.153.0: cả `"<node>" "<script>"` lẫn dạng nháy đôi đều báo `hook: SessionStart Failed`, không in gì, và để lại phiên không có identity.

Nên interpreter đi vào trần. `process.execPath` được dùng nguyên khi không có khoảng trắng; khi có — `C:\Program Files\nodejs\node.exe`, tức bản cài mặc định — cách viết trần duy nhất còn lại là `node` trên PATH. Đối số phía sau vẫn được nháy bình thường, vì path script có thể chứa khoảng trắng.

## Kiểm chứng

```bash
alp doctor                                   # cả hai binary có trên PATH?
cat ~/.alp/executions/exec_abc123/runtime/claude-settings.json
cat ~/.alp/executions/exec_abc123/runtime/mcp-config.json
```

## Liên quan

- [Execution](../execution/) — thư mục `runtime/` sống ở đâu
- [Capability](../capability/) — bảng runtime nào cưỡng chế phần nào
- [Hook](../hook/) — ba hook adapter đăng ký
- [Nấc và runtime](../../concepts/modes-and-runtimes/) — chọn runtime hằng ngày
