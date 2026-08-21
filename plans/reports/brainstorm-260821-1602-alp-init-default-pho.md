---
type: brainstorm
date: 2026-08-21
topic: alp init — Phở mặc định trong mọi project, cho cả Claude lẫn Codex
status: agreed
---

# Brainstorm — `alp init`: Phở là mặc định

## 1. Vấn đề

Để làm việc phải gõ `cd ~/.alp-code/identity/main && claude`. 38 ký tự, phải nhớ path,
và **sai chỗ đứng** — Phở ngồi trong alp-code, còn code thì ở repo khác. Muốn Phở đụng
code phải chạy `install-project.sh` với absolute path + `--slug` + `--read-role/--write-role`.

Pain phụ (principal xác nhận): gắn project rườm rà · không biết khi nào gọi vai phụ ·
update phải nhớ nguyên dòng `curl` · doctor cảnh báo mà không nói phải làm gì ·
9+ scripts không nhớ nổi.

Ràng buộc: KHÔNG được phá bất biến ACL của CHARTER (`loadout.yaml` là nguồn sự thật duy nhất).

## 2. Phương án đã cân nhắc

| # | Phương án | Kết luận |
|---|---|---|
| A | Chiếm `claude`/`codex` toàn máy qua `~/.claude/settings.json` + `~/.codex/config.toml` | **Loại.** +4k token boot cho MỌI phiên kể cả việc vặt; `doctor.sh` chạy mỗi lần; `memory/` mở quyền ở mọi project. Đắt và bẩn. |
| B | Lệnh ngắn `pho` symlink vào PATH | Chạy được, nhưng vẫn là một lệnh mới phải nhớ — không đúng "mặc định". |
| C | Shell function bọc `claude`, đoán theo cwd | **Loại.** Hành vi ngầm, khó debug, hijack lệnh chuẩn. |
| **D** | **`alp init` per-project → sinh config cục bộ cho cả Claude lẫn Codex** | **CHỌN.** |

## 3. Phương án chốt — D

`alp init` chạy **đứng trong project**, làm 5 việc, tất cả suy ra từ `loadout.yaml`:

1. đăng ký project card L1 + cập nhật L0 (tái dùng `install-project.cjs`)
2. ghi `workspaces.read/write` vào `identity/main/loadout.yaml`
3. `compile-acl.cjs` — recompile toàn bộ vai
4. sinh `<project>/.claude/settings.local.json` — hook + ACL của main, `env.ALP_ROLE=main`
5. sinh `<project>/.codex/config.toml` — model/effort của main + hooks + trust_level

Sau đó: gõ **`claude`** HOẶC **`codex`** trong project đó = Phở. Không `cd`, không flag, không nhớ gì.

Ngoài project đã init: `claude`/`codex` nguyên bản, không ô nhiễm.
Thư mục lạ muốn hỏi Phở nhanh: `alp` (không tham số) → phiên **read-only**.

### Bằng chứng khả thi (đã test thật, không phải giả định)

- `claude --settings <file>` **có** nạp hook, giữ nguyên cwd, không hỏi trust — test `-p` với marker file, hook chạy, `ALP_ROLE` truyền qua env OK.
- `.claude/settings.local.json` là lớp cá nhân, Claude Code tự gitignore ⇒ **không bẩn repo người khác**.
- Codex có **`.codex/config.toml` theo project**, layer cao hơn user config (`codex-rs/config/src/loader`).
- Codex có **11 hook events** giống Claude: `SessionStart` (kèm `additionalContext`), `PreToolUse`, `SessionEnd`, `Stop` — wire format `camelCase`, gần như trùng Claude Code.

⇒ **Codex làm default cho main là khả thi THẬT.** Không phải dựa vào `AGENTS.md` bấp bênh:
`hooks/session-start.cjs` + `acl-guard.cjs` dùng lại được cho cả hai runtime.
Điều này vá đúng chỗ README đang nói dối ("Main có thể chạy Claude Code hoặc Codex" —
thực tế `run-role.cjs` chặn `main`, không có launcher nào).

### ACL: cwd lạ = read-only

Claude Code mặc nhiên cho ghi cwd ⇒ phải **deny tường minh** `Edit(//<cwd>/**)` khi project
chưa đăng ký. `acl-guard.cjs` đã fail-closed nên chỉ cần compile-acl không cấp Edit.
Bất biến CHARTER giữ nguyên: chỉ `workspaces.write` trong `loadout.yaml` mới ghi được.

### Bề mặt CLI `alp`

| Lệnh | Việc |
|---|---|
| `alp init` | đăng ký project hiện tại + sinh config Claude/Codex |
| `alp init --uninstall` | gỡ `.claude/settings.local.json` + `.codex/config.toml`, huỷ đăng ký |
| `alp` | phiên Phở read-only ở cwd bất kỳ |
| `alp doctor` | `doctor.cjs` + **gợi ý lệnh fix cụ thể** cho từng finding |
| `alp update` | thay cho việc nhớ dòng `curl` |
| `alp help` | gom 9 scripts thành một chỗ |

Skill `alpcode-init` = wrapper để gọi `alp init` từ trong phiên Claude, không nhân đôi logic.

## 4. Rủi ro

| Rủi ro | Xử lý |
|---|---|
| `.codex/config.toml` là feature mới, codex của user có thể chưa hỗ trợ | `alp doctor` check `codex --version`, fallback về `AGENTS.md` |
| Codex hook cần trust persisted (`--dangerously-bypass-hook-trust` ám chỉ) | `alp init` xử lý trust một lần, doctor báo `CODEX-HOOK-UNTRUSTED` |
| Codex wire schema `deny_unknown_fields`; `session-start.cjs` xuất `systemMessage` | viết adapter mỏng, KHÔNG fork hook — một nguồn logic |
| Ghi file vào repo người khác | chỉ dùng slot cá nhân (`settings.local.json`); có `--uninstall`; không commit hộ |
| Codex mất `--settings`-style ACL của Claude | `PreToolUse` hook `acl-guard.cjs` là lớp chặn thật, ACL declarative chỉ là lớp một |

## 5. Đo lường

- ký tự để bắt đầu làm việc: **38 → 6** (`claude`)
- lệnh phải nhớ: **9 scripts → 1** (`alp`)
- `alp init` trong repo lạ chạy 2 lần liên tiếp phải idempotent
- `test-isolation.cjs` 20 ca vẫn xanh sau khi đổi role-detection sang `ALP_ROLE`

## 6. Việc phải làm trước

1. `hooks/session-start.cjs`: role detection đổi thành `ALP_ROLE` trước, cwd basename sau (fallback)
2. `compile-acl.cjs`: thêm target sinh config cục bộ cho project (Claude + Codex)
3. `run-role.cjs`/`codex-role.cjs`: mở `main` như một vai Codex hợp lệ
4. README: sửa lại phần "Cài đặt"/"Chạy một vai" theo `alp init`

## 7. Câu hỏi còn treo

- **Delegation tự động** (Phở tự gọi vai phụ thay vì gõ `run-role.sh` tay) — pain có thật
  nhưng là scope riêng, đụng PLAYBOOK + cơ chế subagent. **Đề nghị tách sang brainstorm khác.**
- `alp` nên là symlink Node hay shell shim? Ảnh hưởng Windows — chốt lúc plan.
