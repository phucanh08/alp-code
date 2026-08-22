# Lăng kính rà đối kháng

Bốn góc nhìn thù địch. Đọc **hết một lăng kính** rồi mới sang lăng kính kế tiếp — trộn lẫn
thì cả bốn hội tụ về cùng một góc, và bài tập thành diễn.

| Lăng kính | Tâm thế | Soi gì |
|---|---|---|
| **Kẻ tấn công** | như người muốn phá | vượt xác thực, injection, lộ dữ liệu, leo thang quyền, chuỗi cung ứng |
| **Người phân tích failure** | định luật Murphy | race condition, mất dữ liệu, hỏng dây chuyền, thiếu đường phục hồi, rủi ro deploy, không có đường lùi |
| **Kẻ phá giả định** | hoài nghi | phụ thuộc chưa nói ra, câu "cái này sẽ chạy" không có căn cứ, thiếu đường lỗi, giả định về quy mô và tích hợp |
| **Người chỉ trích phạm vi** | thi hành YAGNI | over-engineering, trừu tượng hoá sớm, phức tạp không cần, thiếu bản tối thiểu, phạm vi phình, đánh bóng thừa |

## Cách đọc theo một lăng kính

Bạn đang rà **một tài liệu kế hoạch**, không phải code. Không có gì để lint, build hay
test. Chỉ soi chất lượng kế hoạch.

Luật khi rà:

- **Cụ thể:** chỉ đúng phase nào, mục nào.
- **Có kịch bản:** mô tả nó hỏng ra sao, với tình huống nào — không viết "có thể có vấn đề".
- **Xếp mức:** CHẶN (chặn thành công) · NÊN SỬA (rủi ro đáng kể) · GHI NHẬN (đáng lưu ý).
- **Bỏ chuyện vụn:** văn phong, đặt tên, định dạng.
- **Không khen.** Không có câu "nhìn chung ổn". Chỉ phát hiện.
- **5–10 phát hiện mỗi lăng kính.** Chất hơn lượng — danh sách 30 mục thì không ai xử lý.

## Mẫu một phát hiện

```markdown
## Phát hiện {N}: {tiêu đề}
- **Mức:** CHẶN | NÊN SỬA | GHI NHẬN
- **Ở đâu:** Phase {X}, mục "{tên}"
- **Sai gì:** {mô tả}
- **Hỏng thế nào:** {kịch bản cụ thể — với input nào, tình huống nào}
- **Bằng chứng:** {trích từ kế hoạch, hoặc chỉ ra chỗ THIẾU}
- **Đề xuất:** {ngắn}
```

Ô **Bằng chứng** chấp nhận hai dạng: trích dẫn từ kế hoạch, hoặc chỉ ra thứ lẽ ra phải có
mà không có. Dạng thứ hai thường là phát hiện giá trị nhất.

## Mẫu phân xử

```markdown
## Phát hiện 1: {tiêu đề} — {MỨC}
**Lăng kính:** {tên}
**Ở đâu:** {phase/mục}
**Sai gì:** {mô tả}
**Hỏng thế nào:** {kịch bản}
**Xử lý:** Nhận | Bác | Nhận có sửa
**Lý do:** {cụ thể — "cảm thấy không quan trọng" không phải lý do}
```

## Mẫu mục ghi vào `plan.md`

```markdown
## Rà đối kháng

### Lượt — {YYYY-MM-DD}
**Phát hiện:** {tổng} ({nhận} nhận, {bác} bác)
**Theo mức:** {n} CHẶN · {n} NÊN SỬA · {n} GHI NHẬN

| # | Phát hiện | Mức | Xử lý | Áp vào |
|---|---|---|---|---|
| 1 | {tiêu đề} | CHẶN | Nhận | Phase 2 |
```

Mục này tồn tại để sáu tháng sau còn trả lời được: *"lúc đó đã biết rủi ro này chưa, và vì
sao vẫn làm?"*

## Giao đi thay vì tự rà

Rủi ro cao thì giao cho một vai khác (`scripts/run-role.sh <vai>`) — vai có `alp-predict`,
năm persona tranh luận, và quan trọng hơn: **nó không phải người viết kế hoạch**.

Tự rà kế hoạch mình vừa viết luôn có điểm mù. Bốn lăng kính giúp giảm, không xoá được.
