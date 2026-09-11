---
title: Từ điển khái niệm
description: Mỗi khái niệm lõi của ALP một dòng định nghĩa, và một trang giải thích chuyên sâu.
---

Phần **Hướng dẫn** trả lời "làm thế nào". Phần này trả lời "**nó là cái gì**" — mỗi khái niệm một trang, đủ sâu để bạn dự đoán được hành vi của ALP thay vì phải thử.

Đọc theo thứ tự bảng dưới là đi từ *ai được làm gì* xuống *việc đó chạy ra sao*.

| Khái niệm | Một câu |
|---|---|
| [Agent](../agent/) | Một **vai** có definition bất biến viết bằng code — không phải một model process tự do |
| [Capability](../capability/) | Sáu nhóm quyền một vai được cấp; tên không có trong catalog bị từ chối chứ không bị bỏ qua |
| [Policy](../policy/) | Cửa duy nhất trả lời cho/không cho, chạy **trước** mọi runtime probe và spawn |
| [Delegation](../delegation/) | Một vai nhờ vai khác làm việc — đường duy nhất, và cha phải được xác thực |
| [Execution](../execution/) | Một lượt chạy có ID, có snapshot quyền trên đĩa, có vòng đời tra được từ process khác |
| [Execution graph](../execution-graph/) | Cây của cả một phiên: quan hệ cha–con, trần, allowance, hạn và lý do huỷ |
| [Workflow](../workflow/) | State machine thu hẹp tool theo từng bước, kết thúc bằng output contract |
| [Memory](../memory/) | Kiến thức dùng lại, địa chỉ bằng logical ID chứ không bằng đường dẫn file |
| [Skill](../skill/) | Gói knowledge/workflow có `SKILL.md`; thư mục `skills/` của vai **chính là** danh sách grant |
| [Runtime và launch spec](../runtime/) | Claude Code hoặc Codex CLI, cùng bản dịch từ quyền sang lệnh khởi chạy |
| [Hook](../hook/) | Hai điểm ALP chạy *bên trong* tiến trình runtime: mở phiên và đóng phiên |
| [Checkpoint và continuity](../continuity/) | Objective + pin của một execution, sống sót qua compaction |

## Ba câu chi phối tất cả

1. **Identity là code, không phải Markdown.** Definition viết bằng TypeScript, freeze lúc load, và hash vào policy của từng lượt chạy. Không có file nào sửa tay được để đổi quyền.
2. **ALP quyết ai giao việc cho ai; runtime chỉ quyết việc đó chạy thế nào.** Policy chạy xong mới tới probe, health check, spawn.
3. **Fail-closed.** Tool lạ, path lạ, vai lạ, request lạ → từ chối. Không có nhánh "mặc định cho phép".

Mỗi trang bên dưới là một hệ quả của ba câu này, đọc ngược từ hệ quả về nguyên nhân.

## Cái ALP cố ý **không** làm

| Không có | Vì sao |
|---|---|
| Chọn runtime trực tiếp | Runtime là hệ quả của model, model là hệ quả của [nấc](../../concepts/modes-and-runtimes/) |
| Cờ giả vai gọi (`--as`, `ALP_ROLE`) | Danh tính đến từ [execution graph](../execution-graph/), không từ input |
| Config mở trần delegation | Trần cố định trong code; sửa trần là sửa code và đi qua review |
| Token/tool-call budget | Chưa có. Trần hiện tại đếm *execution*, không đếm thứ execution tiêu |
| Sandbox chống tiến trình thù địch | ALP là guardrail cho agent hợp tác; source ghi rõ giới hạn này |
