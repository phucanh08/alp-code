---
name: openclaw-architecture
type: reference
created: 2026-08-14
updated: 2026-08-14
---

# OpenClaw — mô hình identity file

Bộ file identity của Phở dựa theo cách OpenClaw tổ chức workspace agent: identity không nằm
trong database hay config panel, mà là các file markdown được nạp vào system prompt mỗi phiên.

## Ánh xạ OpenClaw → Phở

| OpenClaw | Phở | Ghi chú |
|---|---|---|
| `SOUL.md` | `SOUL.md` | Tính cách, giá trị, giọng, ranh giới |
| `IDENTITY.md` | `IDENTITY.md` | name / emoji / vibe / role — đối ngoại |
| `AGENTS.md` | `AGENTS.md` | Quy trình vận hành, luật cứng |
| `USER.md` | `USER.md` | Bối cảnh & sở thích principal |
| `TOOLS.md` | `TOOLS.md` | Quyền công cụ + bảng định tuyến subagent |
| `MEMORY.md` | `MEMORY.md` + `memory/` | Mục lục tách khỏi nội dung |
| `HEARTBEAT.md` | `HEARTBEAT.md` | Checklist khi chạy theo lịch |
| `BOOTSTRAP.md` | `BOOTSTRAP.md` | Trình tự khởi động |
| gateway bindings | `CLAUDE.md` | Điểm vào riêng của Claude Code |

## Khác biệt có chủ ý

- Phở chạy trên **Claude Code**, không có gateway/channel — nên `CLAUDE.md` đóng vai trò
  entry point tự động nạp thay cho cơ chế inject của OpenClaw.
- `TOOLS.md` của Phở mở rộng thêm bảng định tuyến subagent `alp:*` — OpenClaw bản gốc chỉ
  liệt kê quyền công cụ.
- Thêm hẳn một **Project Layer** 3 tầng theo mô hình Hermes (`projects/PROTOCOL.md`) — OpenClaw
  không có khái niệm này vì nó là trợ lý cá nhân, còn Phở phải trông nhiều project song song.

**Vì sao quan trọng:** khi muốn port Phở sang OpenClaw thật, ánh xạ đã có sẵn.
**Áp dụng thế nào:** thêm file identity mới thì đối chiếu bảng trên trước, đừng đặt tên tuỳ ý.

## Nguồn

- https://www.mmntm.net/articles/openclaw-identity-architecture
- https://claw-packs.com/articles/memory-files-explained/
- https://github.com/win4r/openclaw-workspace
