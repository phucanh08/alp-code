---
name: herdr-lam-lop-fleet
type: decision
created: 2026-08-14
updated: 2026-08-14
---

# herdr làm lớp quản fleet agent; hướng dẫn viết theo 3 tầng

## Bối cảnh
Phở cần quản batch agent chạy dài — thu thập trạng thái, ra quyết định, báo lại panel. Subagent
`alp:*` không hợp: chúng sống trong phiên Claude Code, chết theo phiên, không quan sát được giữa
chừng. herdr 0.7.4 đã cài sẵn máy Phúc Anh.

## Quyết định
Dùng herdr làm lớp fleet. Hướng dẫn đặt ở `docs/herdr/`, chia 3 tầng giống Project Layer:
L0 `README.md` (~350 tok, luôn nạp khi phiên chạm herdr) → L1 `fleet-loop.md` / `cli-map.md`
→ L2 `socket-api.md` / `gotchas.md` / `recipes.md`.

## Vì sao chia tầng
Bề mặt herdr quá lớn để nạp một lần: 85 socket method, 25 loại event, `api schema --json` nặng
~235KB. Nạp hết là tự sát context. Nhưng 90% việc chỉ cần 6 lệnh — nên 6 lệnh đó cộng luật
context và 3 bẫy chết người nằm ở L0, phần còn lại nạp theo yêu cầu.

## Trụ cột kỹ thuật: state rollup
`workspace list` trả `agent_status` **đã cuộn từ mọi agent bên trong** — ~45 token/workspace bất
kể có bao nhiêu pane. Đây là thứ khiến giám sát fleet rẻ: quét bằng rollup, chỉ `pane read` khi
rollup báo `blocked`/`done`. Đã đo: `pane list` ~78 tok/pane, `api snapshot` ~440 tok cho 2 pane
và tăng tuyến tính.

## Đã kiểm chứng tay (herdr 0.7.4, server headless, dọn sạch sau)
- rollup: report `blocked` ở pane → workspace đổi sang `blocked` ✓
- `wait agent-status` **chỉ bắt change**, chờ state đang có sẵn → hết giờ ✓
- `--seq` không tăng → **bỏ qua im lặng, exit 0** ✓
- `events.subscribe` hoạt động; `pane.agent_status_changed` bắt buộc `pane_id`, không có bản
  toàn cục ✓
- timeout trả exit 1, nhưng pipe qua `head` làm `$?` thành của `head` ✓

## Hệ quả
- `TOOLS.md` xếp `agent start` / `agent send` / `pane run` / `close` vào nhóm **phải hỏi trước**:
  chúng gõ vào phiên agent thật, tốn token thật, giết được việc đang chạy dở.
- Số đo context gắn với 0.7.4. Nâng cấp herdr thì đo lại bảng giá ở `README.md`.
- Docs viết cho macOS; đường dẫn socket `~/.config/herdr/herdr.sock`.

Liên quan: [[project-layer-3-tang]]
