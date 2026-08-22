# Rà đối kháng kế hoạch

Đọc kế hoạch với thái độ **thù địch**: mục tiêu là phá nó, không phải khen nó.

Tâm thế: như thuê một người ghét người viết kế hoạch, trả tiền để họ tìm ra chỗ hỏng.

## Hai đường chạy — chọn theo rủi ro

### A. Giao đi một lượt phản biện độc lập — mặc định cho kế hoạch rủi ro cao

```bash
scripts/run-role.sh <vai>
```

Vai được giao có `alp-predict` (năm persona tranh luận) và `problem-solving`. Dùng nó thay
vì tự phản biện chính kế hoạch mình vừa viết.

Brief phải có: đường dẫn `plan.md` và các `phase-*.md`, quyết định nào đang cần chốt,
ràng buộc nào không đổi được.

**Phán quyết DỪNG nghĩa là thiết kế lại.** Không phải thêm một dòng "rủi ro đã
biết" rồi đi tiếp.

### B. Tự rà — khi việc nhỏ, hoặc không giao đi được

Tự đọc kế hoạch qua từng lăng kính trong `red-team-personas.md`. Số lăng kính theo quy mô:

| Số phase | Lăng kính |
|---|---|
| 1–2 | Kẻ tấn công bảo mật + Kẻ phá giả định |
| 3–5 | thêm Người phân tích failure mode |
| 6+ | thêm Người chỉ trích phạm vi |

Đọc **hết một lăng kính** rồi mới sang lăng kính kế tiếp. Trộn lẫn thì cả bốn hội tụ về
cùng một góc nhìn, và bài tập thành diễn.

## Xử lý phát hiện

1. **Gom** tất cả phát hiện.
2. **Khử trùng lặp** mạnh tay — hai cách nói của cùng một vấn đề là một phát hiện.
3. **Xếp** theo mức: CHẶN → NÊN SỬA → GHI NHẬN (cùng thang với `code-review`).
4. **Cắt còn tối đa 15.** Danh sách 40 mục thì không ai xử lý, và mục quan trọng chìm mất.
5. **Phân xử** từng phát hiện: nhận hay bác — **kèm lý do có bằng chứng**. "Cảm thấy không
   quan trọng" không phải lý do.

## Hỏi principal

Trình bày gọn:

- Tổng số phát hiện theo mức.
- Phát hiện nào bạn đề nghị nhận, phát hiện nào bác — kèm lý do.
- Hỏi: áp dụng hết phần đề nghị nhận, xem từng cái, hay bác tất cả?

**Không tự sửa kế hoạch trước khi principal quyết.** Kế hoạch là hợp đồng đã trình; sửa
lặng lẽ nghĩa là principal duyệt một bản, còn thực thi theo bản khác.

## Áp dụng

Principal duyệt rồi mới sửa. Với mỗi phát hiện được nhận:

- Sửa thẳng vào `phase-*.md` liên quan.
- Thêm mục `## Rà đối kháng` vào `plan.md`: phát hiện, mức, xử lý (nhận/bác/nhận có sửa),
  lý do.

Mục đó tồn tại để sáu tháng sau còn trả lời được câu "sao lúc đó biết rủi ro này mà vẫn làm?".

## Báo cáo

```
Rà đối kháng: <đường dẫn kế hoạch>
Đường chạy: giao đi | tự rà
Phát hiện: CHẶN n · NÊN SỬA n · GHI NHẬN n
Nhận: n · Bác: n
File đã sửa: <danh sách>
Rủi ro đã xử lý: <tóm tắt>
Câu hỏi còn mở: …
```

## Bước sau

Chạy `validate-workflow.md`. Xong thì báo principal — **không tự bắt tay triển khai**.
