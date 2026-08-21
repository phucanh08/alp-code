# CONVENTIONS — quy ước làm việc chi tiết

> **Không nằm trong boot set.** `PRINCIPAL.md` giữ bản tóm tắt ba dòng; file này giữ chi tiết.
> Nạp khi sắp viết code, chọn runtime, hoặc khi principal hỏi về model.

## Code

- **YAGNI — KISS — DRY.** Kiểm tra module đã có trước khi tạo mới.
- Đặt tên file: kebab-case cho JS/TS/Python/shell; theo chuẩn ngôn ngữ với
  C#/Java (PascalCase), Go/Rust (snake_case).
- Markdown chỉ đặt trong `plans/` hoặc `docs/` của project, trừ khi được yêu cầu rõ.
- Script của skill lỗi thì sửa rồi chạy lại đến khi chạy được, không bỏ qua.
- Quan tâm hiệu quả token — làm tốt nhưng đừng tiêu hoang context.

## Skill dùng chung _(chốt 2026-08-14)_

Một nguồn chuẩn cố định, trung lập với runtime; Claude Code và Codex chỉ trỏ tới nguồn đó.
Áp dụng cho `herdr` và mọi skill tạo sau này. Hook riêng từng runtime phải nghiên cứu và
chốt riêng trước khi triển khai.

## Agent chỉ qua herdr _(chốt 2026-08-14)_

Không spawn subagent in-process. Không dùng `Agent` tool. Mọi việc giao đi qua **herdr** —
pane terminal thật, quan sát được, can thiệp giữa chừng được, sống độc lập với phiên hiện tại.

Lý do: subagent in-process là hộp đen — principal không thấy nó làm gì, không dừng được nó,
và phiên chết là kết quả mất trắng. herdr thì ngược lại. Việc nhỏ thì tự làm.

Nạp hướng dẫn herdr **theo tầng**, đừng đọc cả thư mục:

```
skill `herdr` (SKILL.md)  L0 ~2k tok   — tự nạp khi phiên chạm herdr
docs/herdr/fleet-loop.md  L1 ~2.1k tok — sắp chạy vòng lặp giám sát
docs/herdr/cli-map.md     L1 ~1.6k tok — cần tìm lệnh cụ thể
docs/herdr/socket-api.md  L2 ~1.7k tok — cần event stream
docs/herdr/gotchas.md     L2 ~2.1k tok — gặp hành vi lạ
docs/herdr/recipes.md     L2 ~1.5k tok — cần công thức sẵn
```

Nạp hết = ~11k token. Đã kiểm chứng trên herdr **0.8.0** với agent `claude` thật.

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
