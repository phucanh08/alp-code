---
status: in-progress
created: 2026-08-21
slug: alp-init-delegation
source:
  - plans/reports/brainstorm-260821-1602-alp-init-default-pho.md
  - plans/reports/brainstorm-260821-1602-delegation-tu-dong.md
blockedBy: []
blocks: []
---

# `alp init` + Delegation tự động

## Tổng quan

Hai pain, một gốc chung — **cấu hình theo cwd**:

1. Phải `cd ~/.alp-code/identity/main && claude` mới làm việc được. 38 ký tự, và sai chỗ đứng:
   Phở ngồi trong alp-code còn code ở repo khác.
2. Phở không tự giao việc cho vai phụ được — phải gõ `run-role.sh` tay.

Lời giải: **`alp init` sinh config cục bộ** cho Claude + Codex ⇒ gõ `claude` trong project nào
đã init là ra Phở. Cùng cơ chế đó sinh **Codex profile cho 7 vai** ⇒ Phở tự spawn vai phụ qua
herdr mà không cần nhồi prompt.

## Nguyên tắc bất biến (kế thừa CHARTER)

1. `loadout.yaml` là **nguồn sự thật duy nhất**. Mọi config sinh ra: `.claude/settings.json`,
   `.claude/settings.local.json`, `.codex/config.toml`, `~/.codex/<role>.config.toml`.
2. **cwd lạ = read-only.** Chỉ `workspaces.write` trong loadout mới ghi được.
3. Vai phụ **không được** spawn vai khác. Chống đệ quy delegation.
4. Logic boot tồn tại **đúng một chỗ**. Xoá `run-role.buildBoot()`.

## Quyết định đã chốt

| Câu hỏi | Chốt | Lý do |
|---|---|---|
| Phạm vi "mặc định Phở" | per-project qua `alp init` | không ô nhiễm toàn máy |
| cwd chưa đăng ký | read-only | giữ bất biến CHARTER |
| Runtime chính của main | **Claude**; Codex là tuỳ chọn | Codex không nạp được `alp:plan`/`alp:cook` (marketplace Claude Code) |
| Cơ chế delegation | herdr chính, `codex exec` fallback | fallback bắt buộc cho phiên headless |
| Danh tính vai trong pane | Codex profile `-p <role>` | tách danh tính khỏi workspace |
| Tự chủ | tự quyết + báo một dòng | miễn xin phép cho 7 vai `delegates_to` |
| Trần | 3–4 phiên đồng thời + báo chi phí cuối lượt | |

## Bằng chứng đã đo (không phải giả định)

| # | Kiểm chứng | Kết quả |
|---|---|---|
| 1 | `claude --settings <file>` nạp hook, giữ cwd | ✅ hook chạy, `ALP_ROLE` qua env OK |
| 2 | `codex exec -p <profile>` áp model/effort/sandbox/approval | ✅ **cả 4 field** từ profile |
| 3 | `herdr agent start --kind claude -- <args>` pass-through | ✅ `argv:["claude","--settings",…]`, hook chạy |
| 4 | Codex có `.codex/config.toml` cấp project + 11 hook event | ✅ (`codex-rs/config/src/loader`, `hooks/src/lib.rs`) |
| 5 | Codex plugin marketplace = của OpenAI, không có `alp` | ✅ ⇒ main giữ Claude làm runtime chính |

## Ba cạm bẫy phát hiện khi test — phải code đúng ngay lần đầu

| # | Bẫy | Xử lý |
|---|---|---|
| 1 | `codex exec` **đọc stdin mặc định** → treo vô hạn khi không TTY | wrapper BẮT BUỘC `< /dev/null` |
| 2 | sandbox mặc định của `exec` là **`workspace-write`** | `sandbox_mode="read-only"` phải nằm TRONG profile |
| 3 | **Dialog trust chặn hook** — cwd chưa trust thì hook không chạy | `alp init` trust CẢ HAI runtime |

Bẫy 2 nguy hiểm nhất: phá bất biến read-only, mặc định *trông có vẻ* hợp lý, không test nào bắt được.

## Các phase

| Phase | Nội dung | Ước lượng | Phụ thuộc | Trạng thái |
|---|---|---|---|---|
| [P0](phase-0-quick-wins.md) | `RELATIONS.md` vào boot set · mở `main` cho Codex | ~1h | — | **xong 2026-08-21** |
| [P1](phase-1-codex-profile.md) | loadout → `~/.codex/<role>.config.toml` · `run-role --exec` · xoá `buildBoot()` | ~0.5 ngày | P0 | chưa làm |
| [P2](phase-2-alp-cli.md) | `alp` CLI · `alp init` · config theo project · trust hai runtime | ~1 ngày | P1 | chưa làm |
| [P3](phase-3-delegation-herdr.md) | wrapper herdr · luật định tuyến · phanh chi phí · chống đệ quy | ~0.5 ngày | P2 | chưa làm |
| [P4](phase-4-doctor-docs.md) | `alp doctor` finding mới · README viết lại | ~0.5 ngày | P3 | chưa làm |

**P0 riêng lẻ đã giải quyết ~80% pain delegation** — làm trước, ship trước, không chờ P1–P4.

> **P0 xong 2026-08-21.** Hai tiền đề của plan đo ra sai — ngân sách boot đã vượt từ trước
> (16686 > 15000, nay ngưỡng nâng lên 18000), và "thêm `main` vào `ALLOWED_ROLES`" kéo theo
> ba giả định vai-phụ bake trong `run-role.cjs`. Chi tiết + phần nợ lại cho P1:
> [phase-0](phase-0-quick-wins.md#đã-làm-gì--và-hai-chỗ-plan-đoán-sai).

## Ngoài phạm vi

- Port `alp:plan`/`alp:cook` sang skill repo-local (dự án riêng)
- Delegation đa cấp (vai phụ giao tiếp nhau)
- Windows: `alp` shim PowerShell — làm ở P2 nhưng chỉ mức parity tối thiểu

## Rủi ro tồn đọng

| Rủi ro | Giảm thiểu |
|---|---|
| herdr CLI đổi giữa minor (0.7→0.8 xoá cả nhóm `wait`) | pin `herdr --version`; doctor báo lệch |
| `release-agent` quên gọi → panel kẹt `working` | wrapper luôn release; doctor phát hiện pane mồ côi |
| `--seq` phải tăng nghiêm ngặt, seq cũ **bỏ qua im lặng** | seq counter trong wrapper, không để model tự đếm |
| Ghi file vào repo người khác | chỉ dùng slot cá nhân; có `--uninstall` |
| Phở lạm dụng delegation | trần 3–4 + luật "một câu hỏi → exec, không phải pane" |
