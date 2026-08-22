# Chuẩn báo cáo điều tra

Hy sinh ngữ pháp cho cô đọng. Sự kiện và bằng chứng, không kể chuyện.

## Khi nào viết ra file

Điều tra ngắn → trả lời thẳng cho main trong phiên, không tạo file.

Viết file khi: điều tra nhiều bước còn dùng lại được, sự cố cần hậu kiểm, hoặc main yêu cầu.

**Đường dẫn:** `plans/reports/oracle-{YYMMDD}-{HHMM}-{slug}.md`

Tự tính ngày giờ — alp-code không có hook nào inject đường dẫn.

**Lưu ý ACL:** `oracle` có `tools: [Read, Glob, Grep, Bash, WebSearch, WebFetch]` — **không
có `Write`**. Bạn không tự tạo được file báo cáo. Đưa nội dung cho main, main ghi. Đừng tìm
đường vòng qua `Bash` để ghi file (HOUSE-RULES §1.9).

## Cấu trúc

### 1. Tóm tắt (3–5 dòng)

- **Vấn đề:** một dòng
- **Ảnh hưởng:** ai/hệ nào, mức nghiêm trọng
- **Nguyên nhân gốc:** một dòng — hoặc **"chưa xác định được"**
- **Trạng thái:** đã xong · đã giảm thiểu · đang điều tra
- **Đề xuất sửa:** ở đâu, vì sao ở đó

Chưa ra nguyên nhân gốc thì **ghi thẳng là chưa ra**. Thay bằng nguyên nhân gần nhất là
cách main đi sửa nhầm chỗ.

### 2. Phân tích

**Mốc thời gian** — chỉ khi sự cố diễn ra theo thời gian:

```
HH:MM — sự kiện
HH:MM — sự kiện
```

**Chuỗi bằng chứng** — phần quan trọng nhất:

```
1. <quan sát>  — `path:line` hoặc output lệnh
2. <suy ra>    — vì sao bước 1 dẫn tới đây
```

Main phải đi lại được chuỗi này và tới cùng kết luận. Bước nào không đi lại được thì bước
đó là giả thuyết, phải ghi là giả thuyết.

**Tách ba loại, đừng trộn:**

| Loại | Cách viết |
|---|---|
| Đã xác nhận | "chạy X, output cho thấy Y" |
| Giả thuyết | "có thể do X — chưa tái hiện được" |
| Tương quan | "X và Y cùng xuất hiện — chưa chứng minh nhân quả" |

Nhầm tương quan thành nhân quả là lỗi hay gặp nhất trong báo cáo điều tra.

### 3. Đã loại trừ

Giả thuyết nào đã thử và **bị bác**, bằng bằng chứng gì.

Mục này hay bị bỏ và nó đắt: không có nó, main sẽ đi lại đúng con đường bạn vừa đi.

### 4. Khuyến nghị

| Mức | Nghĩa |
|---|---|
| Ngay | sửa để hết vấn đề |
| Tiếp theo | cải thiện sau khi hết cháy |
| Lâu dài | giám sát, cảnh báo, phòng ngừa tái diễn |

Mỗi khuyến nghị: **làm gì · vì sao · tác động mong đợi · công sức (thấp/vừa/cao)**.

Khuyến nghị nào là thao tác khó đảo ngược (migration, xoá dữ liệu, đổi cấu hình
production) thì đánh dấu rõ **cần principal duyệt**.

### 5. Câu hỏi còn mở

Luôn có mục này. Phần chưa rõ, giả định cần kiểm chứng, thứ bạn không lấy được và cần main
giao cho vai khác.

## Mẫu

```markdown
# <Vấn đề> — Báo cáo điều tra

## Tóm tắt
- **Vấn đề:**
- **Ảnh hưởng:**
- **Nguyên nhân gốc:**
- **Trạng thái:**
- **Đề xuất sửa:**

## Chuỗi bằng chứng
1.
2.

## Đã loại trừ
-

## Khuyến nghị
### Ngay
- [ ]
### Tiếp theo
- [ ]
### Lâu dài
- [ ]

## Câu hỏi còn mở
-
```

## Luật viết

- **Có bằng chứng:** mọi khẳng định kèm log, số đo, hoặc bước tái hiện.
- **Trung thực:** nói rõ cái gì không biết. "Nhiều khả năng là" khác "đã xác nhận là".
- **Cụ thể:** khuyến nghị chỉ được `path:line`, không nói chung chung.
- **Quét được bằng mắt:** tiêu đề, bảng, gạch đầu dòng.
