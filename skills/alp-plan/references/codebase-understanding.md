# Pha hiểu codebase

**Bỏ qua khi:** đã có báo cáo truy xuất code đủ dùng.

## Đọc luật trước, đọc code sau

Đọc code trước khi biết luật là cách viết ra một kế hoạch đúng kỹ thuật nhưng sai quy ước.
Với alp-code, thứ tự bắt buộc:

| # | File | Cho biết |
|---|---|---|
| 1 | `compiled policy invariants` | sáu nguyên tắc bất biến, ai sửa được gì. **Chỉ principal sửa** |
| 2 | `src/agents/shared/house-rules.ts` | luật cứng mọi vai, thứ tự ưu tiên khi xung đột |
| 3 | `src/agents/<vai>.ts` | quy trình của chính bạn |
| 4 | `README.md` | cây thư mục, bảng script |
| 5 | `docs/` | tài liệu chuyên đề (delegation, ACL…) |

Với repo **bên ngoài** (trong `workspaces.read`): đọc `README.md`, `repository instructions`/`repository instructions`,
rồi `docs/` nếu có. Không có tài liệu thì nói rõ trong plan là kế hoạch dựng trên việc đọc
code, không phải trên quy ước đã ghi.

## Tìm code

Giao cho vai chuyên truy xuất code (`scripts/run-role.sh <vai>`) — vai đó có `rg`, `Glob`,
`Grep`, và `gkg` cho phân tích ảnh hưởng. Xem `research-phase.md` để biết cách viết brief.

Tự tìm khi câu hỏi nhỏ và bạn đã biết đại khái file nào. Giao đi tốn một phiên; tự
`rg` một lần tốn vài giây.

## Nhận quy ước

Trước khi thiết kế, trả lời được ba câu:

1. **Chỗ này đã có mẫu chưa?** Có module tương tự thì theo nó, đừng phát minh cái thứ hai.
   `README.md` của alp-code ghi rõ: `scripts/lib/` là "MỘT nguồn cho mỗi loại config".
2. **Lỗi được xử lý kiểu gì?** Ném, trả về, hay fail đóng? alp-code chọn **fail đóng** —
   hỏng thì hỏng to và thấy ngay, không hỏng im lặng.
3. **Cái gì là sinh ra, cái gì là nguồn?** Sửa nhầm file sinh ra thì mất trong lần compile
   kế tiếp. Trong alp-code: `compiled AgentDefinition` là nguồn; `~/.alp/executions/**` và
   `$CODEX_HOME/<role>.config.toml` là sản phẩm.

## Lập kế hoạch tích hợp

- Tính năng mới nối vào kiến trúc hiện có ở đâu — đặt tên file, tên hàm cụ thể.
- Đổi cái này thì vỡ những đâu. Không chắc → giao đi một lượt phân tích ảnh hưởng bằng `gkg`.
- Tương thích ngược: có ai đang phụ thuộc hành vi cũ không.
- Có phải sinh lại artifact không (`npm run build`), và ai chạy lệnh đó.

## Ghi lại

Phần hiểu được đi vào **plan**, không nằm lại trong context của phiên. Phiên sau không nhớ
gì cả — compiled policy invariants: markdown là source of truth.

Thấy nợ kỹ thuật hoặc chỗ không nhất quán → ghi vào mục **Ngoài phạm vi** của plan.
**Không tự sửa** (HOUSE-RULES §1.6).
