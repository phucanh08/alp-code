# Pha thu thập bối cảnh

**Bỏ qua khi:** principal đã đưa sẵn report, hoặc việc quá nhỏ.

Nguyên tắc: **main không tự đọc hết**. Giao cho vai chuyên môn, gom kết quả, kiểm chứng
trước khi tin. Đó vừa là lý do các vai tồn tại, vừa là cách giữ context của main sạch —
CHARTER §2.6 giới hạn boot set ≤ 7 nguồn.

## Giao cho ai

| Cần gì | Vai | Lệnh |
|---|---|---|
| code hiện tại nằm đâu, ai gọi ai, đổi thì vỡ đâu | `search` | `scripts/run-role.sh search` |
| thư viện/framework bên ngoài, cách làm đang là chuẩn | `librarian` | `scripts/run-role.sh librarian` |
| đã từng quyết định gì, thread nào còn hiệu lực | `read-thread` | `scripts/run-role.sh read-thread` |
| phản biện một thiết kế rủi ro cao | `oracle` | `scripts/run-role.sh oracle` |

Ba vai đầu **độc lập với nhau** → giao song song. Quản nhiều phiên cùng lúc: skill `herdr`.

## Viết brief cho vai được giao

`run-role` mở một **phiên riêng**, không phải subagent. Nó **không thấy** gì trong context
của bạn. Brief thiếu thì nó đi hỏi lại, hoặc tệ hơn — tự đoán.

Brief tối thiểu phải có:

1. **Câu hỏi kiểm chứng được**, không phải chủ đề. "Tìm hiểu auth" là chủ đề. "Chỗ nào
   trong `src/` gọi `verifyToken`, và có chỗ nào bỏ qua kiểm hạn không" là câu hỏi.
2. **Ranh giới** — thư mục nào, repo nào, tới đâu thì dừng.
3. **Dạng kết quả mong muốn** — danh sách `path:line`, bảng so sánh, hay một kết luận.
4. **Ngân sách** nếu muốn giới hạn (`librarian` mặc định tối đa 5 lượt tìm).

## Tự làm phần nào

Có vài thứ giao đi tốn hơn tự làm:

- **Đọc GitHub:** `gh pr view`, `gh run view --log` — main có `Bash`, làm trực tiếp nhanh hơn.
- **Xem repo ngoài:** `npx repomix --remote <url>` cho một bản tóm tắt. Nhớ chạy
  `--token-count-tree` trước để không kéo về thứ vượt context.

## Gom kết quả

- **Không dán nguyên báo cáo của vai khác vào plan.** Rút phần dùng được, dẫn nguồn.
- Hai vai nói ngược nhau → nói rõ trong plan, đừng chọn hộ một cách âm thầm.
- Vai nào ghi "chưa chắc" thì phần đó vào mục **Câu hỏi còn mở** của plan, không được lặng
  lẽ thành sự thật.

## Quy tắc

- Rộng trước, sâu sau. Đào sâu một hướng khi chưa biết có mấy hướng là cách chốt nhầm.
- Tìm ít nhất hai cách tiếp cận để so — một phương án duy nhất thì không phải lựa chọn.
- Ghi lại phát hiện đủ để pha thiết kế dùng lại được, không phải đọc lại từ đầu.
- Vấn đề bảo mật ghi ngay khi thấy, đừng để tới pha review.
