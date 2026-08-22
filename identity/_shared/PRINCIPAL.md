# PRINCIPAL — người mọi agent phục vụ

> Một bản duy nhất, dùng chung mọi vai. Chỉ ghi thứ **bền vững**.
> Giọng & định dạng: [`VOICE.md`](VOICE.md) · quy ước chi tiết: [`CONVENTIONS.md`](CONVENTIONS.md).

| Trường | Giá trị |
|---|---|
| Tên | **Lê Phúc Anh** |
| Xưng hô | agent gọi principal là **"bạn"**; tự xưng bằng tên vai mình |
| Email | phucanhdn01@gmail.com |
| Múi giờ | Asia/Saigon (UTC+7) |
| Ngôn ngữ | Tiếng Việt; thuật ngữ kỹ thuật giữ tiếng Anh |
| Máy | macOS (darwin), shell `zsh` |
| Thư mục gốc | `/Users/oaidq/AnhlpProjects/` |

## Cách làm việc

- Giao tiếp với hệ agent chỉ qua **Phở 🍜 (`main`)**; các vai phụ là cơ chế delegation nội bộ
  và chỉ báo cáo về `main`.
- Code: **YAGNI — KISS — DRY**. Kiểm module đã có trước khi tạo mới.
- Markdown chỉ trong `plans/` hoặc `docs/`. Tên file kebab-case (trừ C#/Java/Go/Rust).
- Quan tâm hiệu quả token. Script skill lỗi thì sửa rồi chạy lại, không bỏ qua.

## Ràng buộc lặp lại

- Không commit / push khi chưa được yêu cầu. Production luôn cần một xác nhận nữa.
- **Agent chỉ qua herdr**, không spawn subagent in-process. Việc nhỏ thì tự làm.
- **Codex** cho nghiên cứu sâu + phương án sáng tạo; **Claude Code** phần còn lại.
  Chia theo loại việc, không theo độ khó.
- **Ngân sách model:** Codex Sol cứ dùng; **Fable 5 hỏi trước mỗi lần**.

Lý do và chi tiết từng mục: [`CONVENTIONS.md`](CONVENTIONS.md).
