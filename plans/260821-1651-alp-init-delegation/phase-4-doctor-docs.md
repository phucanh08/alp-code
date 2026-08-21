# P4 — `alp doctor` + docs

> ~0.5 ngày · phụ thuộc P3

## Bối cảnh

Pain: "doctor cảnh báo mà không rõ phải làm gì" · "không nhớ có lệnh gì".
`doctor.cjs` hiện báo DRIFT · STALE · ORPHAN · ACL-* · TRUST-MISSING — **nêu bệnh, không kê đơn**.

## Việc

### 4.1 Finding mới

| Finding | Điều kiện | Lệnh fix gợi ý |
|---|---|---|
| `CODEX-PROFILE-DRIFT` | `~/.codex/<role>.config.toml` lệch loadout | `alp init` hoặc `compile-acl.cjs` |
| `TRUST-MISSING-CODEX` | project đã đăng ký thiếu `trust_level="trusted"` | `alp init` |
| `HERDR-VERSION` | `herdr --version` ≠ bản đã verify (0.8.0) | đọc `herdr <nhóm> --help` |
| `ORPHAN-PANE` | pane có agent label nhưng tiến trình chết | `herdr pane release-agent <pane>` |
| `PROJECT-CONFIG-STALE` | `.claude/settings.local.json` cũ hơn loadout | `alp init` |

### 4.2 Mỗi finding kèm lệnh fix

Format hiện tại chỉ có code + mô tả. Thêm dòng `→ fix:`. Đây là phần **giá trị nhất** của P4 —
`alp doctor` chạy ở boot (`session-start.cjs:runDoctor`) nên Phở cũng đọc được gợi ý.

### 4.3 README viết lại

Phần phải sửa:

- **Cài đặt** — bỏ `cd identity/main && claude`, thay bằng `alp init`
- **Chạy một vai** — `alp` / `claude` trong project đã init
- **Gắn project** — `install-project.sh <abs path> --slug` → `alp init` (đứng trong repo)
- **Phở chạy các vai Codex** — thêm `--exec`; nói rõ herdr là đường chính
- **Bảng Scripts** — `alp` lên đầu, các script khác thành "chi tiết bên dưới"
- **Sửa chỗ nói dối:** "Main có thể chạy Claude Code hoặc Codex" → nói rõ Claude là chính,
  Codex là đường phụ (không nạp được `alp:plan`/`alp:cook` — marketplace của Claude Code)

### 4.4 `docs/`

- `docs/model-routing.md` — cập nhật: profile thay flag CLI
- `docs/delegation.md` (mới) — luật định tuyến herdr vs exec, seq/release, chống đệ quy

## Định nghĩa hoàn thành

- [x] `alp doctor` mọi finding có dòng `→ fix:` chạy được
- [x] README không còn hướng dẫn `cd identity/main`
- [x] README không còn câu sai về Codex-main
- [x] `compile-acl.cjs --check` + `doctor.cjs` xanh trên máy sạch sau `alp init`

---

## Đã làm gì — và một bug chỉ lộ khi có project thật

**Xong 2026-08-21.** Nghiệm thu bằng một project thật trong scratchpad: `alp init` →
doctor sạch; ép lệch từng thứ một → đúng finding hiện ra kèm `→ fix:`; chạy lệnh fix →
finding biến mất; `alp init --uninstall` trả lại nguyên trạng.

### `ACL-PATH` là cảnh báo giả — và chỉ giả sau khi có project

Luật cũ: *"mọi `additionalDirectories` phải nằm trong repoRoot"*. Nhưng workspace code hợp
lệ nằm **ngoài** repo, nên `alp init` đầu tiên biến nó thành **8 cảnh báo giả** — một cho
mỗi vai. Không ai thấy vì trước P4 chưa có project nào được đăng ký trên máy này.

Luật mới: dir hợp lệ = trong repo **hoặc** trong một `workspaces.read` đã khai. Còn lại mới
là tàn dư của repo root cũ. Cảnh báo luôn đỏ là cảnh báo không ai đọc — đúng bài học của
ngưỡng boot ở P0.

### Ba chỗ làm khác plan

| Plan | Đã làm | Lý do |
|---|---|---|
| `PROJECT-CONFIG-STALE` khi file **cũ hơn** loadout | so theo **NỘI DUNG** | đổi `name:` không đổi ACL; mtime cho cảnh báo giả, đúng lý do `ACL-DRIFT` đã so nội dung từ đầu |
| `CODEX-PROFILE-DRIFT` là finding mới | tách `CODEX-PROFILE` cũ thành `-DRIFT` / `-MISSING` | hai bệnh khác nhau, cùng một đơn thuốc nhưng khác mức khẩn |
| `→ fix:` chỉ cho finding mới | **mọi** finding, kể cả từ `communication.cjs` | `signal(tag, msg, fix)` — thiếu tham số thứ ba thì render in ra chính lời tố cáo đó |

`ORPHAN-PANE` in đúng lệnh chạy được: vai suy từ nhãn agent (`<role>-<hậu tố>` do launcher
đặt), nên `→ fix: node scripts/run-role.cjs search --release w5:pE` copy-paste là xong.

### Một chỗ dọn thêm ngoài plan

`install-project.cjs` in *"Chạy agent: cd …/identity/main && claude"* — cùng lời khuyên đã
chết mà plan bắt xoá khỏi README. Nay in gợi ý `alp init`, và im lặng khi chính `alp init`
gọi nó (`ALP_INIT=1`) để principal không đọc hai lời khuyên khác nhau cho một bước.
