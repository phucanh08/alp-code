# CONVENTIONS — quy ước làm việc chi tiết

> **Không nằm trong boot set.** `PRINCIPAL.md` giữ bản tóm tắt ba dòng; file này giữ chi tiết.
> Nạp khi sắp viết code, chọn runtime, hoặc khi principal hỏi về model.

## Khi nào hỏi principal

**Hỏi** khi: hai cách đọc yêu cầu dẫn tới hai kết quả khác hẳn · hành động khó đảo ngược /
ra ngoài / tốn tiền · đánh đổi thuộc sở thích cá nhân, không có đáp án kỹ thuật đúng.

**Không hỏi** khi: có lựa chọn mặc định hợp lý (chọn, nói ra, đi tiếp) · câu trả lời nằm
trong code, `memory/`, hay git history (tự tra). Chỉ một phần công việc phụ thuộc câu hỏi
→ **làm hết phần không phụ thuộc trước**, rồi hỏi.

## Code

- **YAGNI — KISS — DRY.** Kiểm tra module đã có trước khi tạo mới.
- Đặt tên file: kebab-case cho JS/TS/Python/shell; theo chuẩn ngôn ngữ với
  C#/Java (PascalCase), Go/Rust (snake_case).
- Markdown chỉ đặt trong `plans/` hoặc `docs/` của project, trừ khi được yêu cầu rõ.
- Script của skill lỗi thì sửa rồi chạy lại đến khi chạy được, không bỏ qua.
- Quan tâm hiệu quả token — làm tốt nhưng đừng tiêu hoang context.

## Skill dùng chung _(chốt 2026-08-14)_

Một nguồn chuẩn cố định, trung lập với runtime; Claude Code và Codex chỉ trỏ tới nguồn đó.
Áp dụng cho `delegation` và mọi skill tạo sau này. Hook riêng từng runtime phải nghiên cứu và
chốt riêng trước khi triển khai.

## Agent chỉ qua ALP Delegation API _(cập nhật 2026-08-24)_

Không spawn subagent in-process. Không dùng raw Herdr/Paseo tool. Mọi việc giao đi qua
**ALP Delegation API** để `delegates_to`, ACL, identity và memory policy chạy trước runtime.

Backend hiện có là Herdr và Paseo. Backend chỉ sở hữu process/session/workspace execution,
status/result/cancel/cleanup; không sở hữu role hay quyền. Việc nhỏ thì tự làm.

Nạp skill `delegation` cho luồng chuẩn. Tài liệu `docs/herdr/` chỉ dùng khi principal/admin
bảo trì adapter Herdr, không phải interface giao việc của role.

## Codex vs Claude Code _(chốt 2026-08-14)_

Hai runtime chạy **song song, độc lập**:

> **Codex** → nghiên cứu sâu, và khi cần phương án sáng tạo hơn.
> **Claude Code** → mọi việc còn lại.

Chia theo **loại việc**, không theo độ khó. Codex là tiến trình rời, không thấy context
phiên này — prompt gửi sang phải tự đủ. Kết quả vẫn phải đọc lại trước khi báo cáo.

Tra model/giá Codex → **docs OpenAI**, không dùng blog bên thứ ba.
Bảng giá, điểm mạnh/yếu từng model, ma trận định tuyến: [`docs/model-routing.md`](../../docs/model-routing.md)
(~1.6k tok). Nạp khi sắp spawn agent hoặc khi principal hỏi về model.

## Ngân sách model _(chốt 2026-08-14)_

- Codex **Sol**: cứ dùng, không hỏi lại từng lần — nghiên cứu sâu vốn đáng tiền.
- **Fable 5**: hỏi trước **mỗi lần**, kèm lý do vì sao Opus 5 không đủ.

## Bộ công cụ

Claude Code là môi trường chính; plugin `alp:*` (AnhlpKit) cho skill và subagent.
MCP đã kết nối: Context7, Figma, Gmail, Google Calendar, Google Drive.
Báo cáo → `plans/reports/`, kế hoạch → `plans/`, tài liệu → `docs/`.
