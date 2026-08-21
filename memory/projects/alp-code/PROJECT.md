---
slug: alp-code
name: alp-code — Multi-agent Knowledge Retrieval
status: ACTIVE
priority: P1
summary: Multi-agent identity, memory, ACL và knowledge retrieval routing
path: ~/AnhlpProjects/agent-memory
updated: 2026-08-21
---

# alp-code — Multi-agent Knowledge Retrieval

## Mục tiêu
Một hệ multi-agent giữ identity và memory xuyên phiên, route knowledge retrieval cho đúng
Search, Librarian hoặc Read Thread, đồng thời để chief-of-staff chịu trách nhiệm kết quả cuối.

## Trạng thái hiện tại
Bộ file identity đã dựng xong theo mô hình OpenClaw (SOUL / IDENTITY / AGENTS / USER / TOOLS /
MEMORY / HEARTBEAT / BOOTSTRAP). Project Layer 3 tầng theo mô hình Hermes đã hoạt động, có
script kiểm soát drift bằng `modified`. Lớp fleet (herdr) và lớp định tuyến model đã có luật
và tài liệu. Skill `herdr` đã nằm trong canonical store `skills/`, dùng chung qua symlink cho
Claude Code và Codex. Chưa có project thật nào ngoài chính nó.

## Việc tiếp theo
1. Chờ Lê Phúc Anh nhập danh sách project thật → tạo card L1 cho từng cái
2. Chạy thử một phiên thật để kiểm chứng thứ tự nạp trong `BOOTSTRAP.md` có đúng nhịp không
3. Cân nhắc `git init` để theo dõi identity đổi theo thời gian
4. Chạy thử một việc thật qua Codex để kiểm chứng luật phân chia — chưa gọi `codex exec` lần nào

## Stack & lệnh
| | |
|---|---|
| Stack | Markdown + Node/Bash/PowerShell; runtime Claude Code + Codex |
| Chạy | `cd ~/AnhlpProjects/agent-memory/identity/chief-of-staff && claude` |
| Kiểm tra | `scripts/sync-project-index.sh` |
| Đồng bộ L0 | `scripts/sync-project-index.sh --write` |

## Người liên quan
- Lê Phúc Anh — principal. Chi tiết: `USER.md`

## Cạm bẫy đã biết
- **Đừng nạp cả `projects/` hay cả `memory/`.** Đó là cách nhanh nhất giết context — cũng
  chính là vấn đề mà kiến trúc này sinh ra để tránh.
- **L0 đổi byte = prompt cache hỏng.** Không sửa `INDEX.md` vì lý do vụn vặt, không ghi giờ
  vào đó.
- **Tính cách và quy trình phải tách nhau.** Đổi giọng → `SOUL.md`. Đổi cách làm → `AGENTS.md`.
  Trộn hai thứ là lý do bộ file kiểu này thường mục sau vài tháng.

## Quyết định
- [260814 — Ba tầng progressive disclosure cho project layer](decisions/260814-project-layer-3-tang.md)
- [260814 — herdr làm lớp quản fleet agent](decisions/260814-herdr-lam-lop-fleet.md)
- [260814 — Skill dùng chung: một canonical store trung lập runtime](decisions/260814-skill-herdr.md)
- [260814 — Codex và Claude Code chạy song song, chia theo loại việc](decisions/260814-phan-chia-codex-claude-code.md)

## Nhật ký
- [2026-08](log/2026-08.md)
