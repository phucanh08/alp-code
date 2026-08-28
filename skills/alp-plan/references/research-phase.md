# Pha thu thập bối cảnh

**Bỏ qua khi:** principal đã đưa sẵn report, hoặc việc quá nhỏ.

Nguyên tắc: **đừng tự đọc hết**. Giao cho vai chuyên môn, gom kết quả, kiểm chứng trước
khi tin. Đó vừa là lý do các vai chuyên môn tồn tại, vừa là cách giữ context của bạn sạch
— compiled policy invariants giới hạn boot set ≤ 7 nguồn.

## Giao cho ai

| Cần gì | Giao cho vai chuyên |
|---|---|
| code hiện tại nằm đâu, ai gọi ai, đổi thì vỡ đâu | truy xuất code trong repo |
| thư viện/framework bên ngoài, cách làm đang là chuẩn | nghiên cứu nguồn ngoài |
| đã từng quyết định gì, thread nào còn hiệu lực | truy xuất trí nhớ |
| phản biện một thiết kế rủi ro cao | phản biện độc lập |

Ai đảm nhận vai nào: `src/agents/registry.ts` và `delegates_to` trong loadout của bạn.
Lệnh: `alp delegate <vai> "<task>"`; `scripts/run-role.sh <vai>` là facade compatibility.

Ba việc đầu **độc lập với nhau** → giao background và theo dõi bằng
`alp delegation status|wait`; runtime phía dưới có thể là local, Paseo hoặc backend khác.

## Viết brief cho vai được giao

Delegation API mở một **execution riêng**. Nó chỉ thấy context ALP đã build, không thấy toàn
bộ context phiên của bạn. Brief thiếu thì nó đi hỏi lại, hoặc tệ hơn — tự đoán.

Brief tối thiểu phải có:

1. **Câu hỏi kiểm chứng được**, không phải chủ đề. "Tìm hiểu auth" là chủ đề. "Chỗ nào
   trong `src/` gọi `verifyToken`, và có chỗ nào bỏ qua kiểm hạn không" là câu hỏi.
2. **Ranh giới** — thư mục nào, repo nào, tới đâu thì dừng.
3. **Dạng kết quả mong muốn** — danh sách `path:line`, bảng so sánh, hay một kết luận.
4. **Ngân sách** nếu muốn giới hạn (một lượt nghiên cứu mặc định tối đa 5 lượt tìm).

## Tự làm phần nào

Có vài thứ giao đi tốn hơn tự làm:

- **Đọc GitHub:** `gh pr view`, `gh run view --log` — có `Bash` thì làm trực tiếp nhanh hơn.
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
