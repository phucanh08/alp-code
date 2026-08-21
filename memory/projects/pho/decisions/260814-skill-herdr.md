---
name: skill-herdr
type: decision
created: 2026-08-14
updated: 2026-08-14
---

# Skill dùng chung: một canonical store trung lập runtime

## Bối cảnh
`docs/herdr/` đã có đủ hướng dẫn, nhưng Phở phải tự nhớ mà đọc. Skill cho phép agent runtime
tự nạp đúng lúc: description nằm trong catalog (~50 tok), SKILL.md chỉ nạp khi thật sự cần.

Ban đầu file thật được đặt dưới `pho/.claude/skills/herdr/`. Cách đặt này dùng được với
Claude Code nhưng biến Claude thành chủ sở hữu ngầm, trong khi Phở cần dùng cùng skill trên
cả Claude Code và Codex.

## Quyết định
- Mọi skill dùng chung chỉ có **một canonical store cố định, trung lập runtime** trong
  workspace Phở; không đặt nguồn thật dưới `.claude/` hay `.codex/`.
- `herdr` hiện tại và mọi skill tạo sau này cùng tuân theo cấu trúc đó.
- Claude Code và Codex là consumer: mỗi runtime chỉ dùng cơ chế discovery/link phù hợp để
  trỏ tới cùng canonical directory, không giữ bản sao riêng.
- Chưa triển khai hook riêng cho runtime nào. Hook chỉ được thêm sau một lượt nghiên cứu và
  một quyết định riêng.
- Kèm 3 script: `fleet-scan.sh`, `fleet-inbox.sh`, `fleet-watch.py`
- SKILL.md **không chép lại** `docs/herdr/` — nó là L0 (6 lệnh, luật context, 5 bẫy) và trỏ
  sang docs bằng đường dẫn tuyệt đối từ workspace Phở.

## Vì sao có script
Skill thuần markdown bắt Phở viết lại python inline mỗi lần quét fleet — tốn token, dễ sai.
Ba script là bản chạy được của recipe 1, 2, 8; đồng thời giấu luôn ba chỗ khó
(reconnect socket, chuẩn hoá tên event, bắt state có sẵn).

## Ba tầng của skill khớp đúng progressive disclosure
```
description trong catalog   ~50 tok    luôn có
SKILL.md                   ~1.1k tok   khi phiên chạm herdr
docs/herdr/<file>.md       1.1–1.8k    khi cần đúng chủ đề đó
```

## Phát hiện khi kiểm thử script (làm sai tài liệu viết lượt trước)
- **`report-agent` không nhận `done`** — chỉ `idle|working|blocked|unknown`. `done` là state
  herdr tự suy ra khi tiến trình kết thúc; giữ quyền bằng seq cao còn đè mất nó.
- **Mỗi kết nối socket chỉ `events.subscribe` được MỘT lần.** Request thứ hai không ack và
  làm nghẽn stream, không báo lỗi. Thêm pane phải đóng/mở lại kết nối.
- **Tên event không thống nhất ngay trong cùng stream**: `pane.agent_status_changed` (chấm)
  vs `pane_agent_detected` (gạch dưới).

Cả ba đã sửa vào `docs/herdr/gotchas.md` §8, §8b, §8c.

## Hệ quả
- Sửa skill ở canonical store = cả Claude Code và Codex cùng nhận một nội dung.
- Không sửa trực tiếp bản discovery/link của từng runtime.
- Migration vật lý đã hoàn tất ngày 2026-08-14: nguồn thật nằm tại `skills/herdr/`.
- Claude Code discovery qua `~/.claude/skills/herdr`; Codex discovery qua
  `~/.agents/skills/herdr`. Cả hai là symlink tới cùng canonical directory.
- Không có bản sao trong `~/.codex/skills` và không cài integration hook riêng.
- `fleet-watch.py` quét `agent list` sau mỗi lần reconnect để bù khoảng trống — chấp nhận
  một lần gọi thừa để không mất sự kiện.
- Xoá workspace Phở sẽ làm các link discovery chết. Đây là đánh đổi của một nguồn sự thật.

Liên quan: [[herdr-lam-lop-fleet]] · [[project-layer-3-tang]]
