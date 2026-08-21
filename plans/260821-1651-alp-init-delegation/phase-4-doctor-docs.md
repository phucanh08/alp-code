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

- [ ] `alp doctor` mọi finding có dòng `→ fix:` chạy được
- [ ] README không còn hướng dẫn `cd identity/main`
- [ ] README không còn câu sai về Codex-main
- [ ] `compile-acl.cjs --check` + `doctor.cjs` xanh trên máy sạch sau `alp init`
