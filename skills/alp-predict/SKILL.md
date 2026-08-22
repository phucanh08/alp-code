---
name: alp-predict
description: Năm persona chuyên môn phân tích độc lập một đề xuất thay đổi rồi tranh luận để ra phán quyết GO/THẬN TRỌNG/DỪNG. Kích hoạt khi cần phản biện trước một quyết định rủi ro cao, khi so sánh nhiều phương án kiến trúc, hoặc khi một migration khó đảo ngược.
---

# alp-predict — năm persona tranh luận

Công cụ chính cho việc **phản biện độc lập trước một quyết định rủi ro cao**.

Giá trị nằm ở chỗ ép năm góc nhìn nói **trước khi** biết nhau nghĩ gì. Để chúng ảnh hưởng
nhau ngay từ đầu thì cả năm hội tụ về ý kiến của cái đầu tiên, và bài tập thành diễn.

## Khi nào dùng

- Kiến trúc có nhiều đánh đổi, hoặc migration khó đảo ngược.
- Đã có phương án và cần người tìm cách bác nó.
- Hai phương án cạnh tranh, cần so có cấu trúc chứ không so cảm tính.

**Không dùng cho:** thay đổi nhỏ, việc đã chốt và chỉ còn triển khai, nâng phiên bản phụ
thuộc không đổi API. Gọi năm persona cho một quyết định nhỏ là đốt ngân sách phiên và làm
loãng giá trị của phán quyết DỪNG.

## Năm persona

| Persona | Soi gì | Câu hỏi lõi |
|---|---|---|
| **Kiến trúc** | thiết kế hệ, khả năng mở rộng, coupling | Có khớp kiến trúc hiện tại không? Sinh ra phụ thuộc mới nào? |
| **Bảo mật** | bề mặt tấn công, bảo vệ dữ liệu, xác thực | Lạm dụng được chỗ nào? Dữ liệu hở ở đâu? Ranh giới quyền có bị phá? |
| **Hiệu năng** | độ trễ, bộ nhớ, truy vấn, kích thước bundle | Trễ thêm bao nhiêu? Có N+1 không? Rò bộ nhớ? |
| **Trải nghiệm** | UX, tiếp cận, trạng thái lỗi | Có trực giác không? Lỗi thì người dùng thấy gì? |
| **Phản biện** | giả định ngầm, phương án đơn giản hơn | Không làm gì thì sao? Cách đơn giản nhất là gì? Giả định nào có thể sai? |

## Quy trình

1. **Đọc đề xuất** được đưa. Không rõ ranh giới thì hỏi lại — đoán sai phạm vi thì cả năm
   persona phân tích nhầm thứ.
2. **Đọc code liên quan** nếu có đường dẫn. `Grep` tìm vùng ảnh hưởng.
3. **Từng persona phân tích độc lập.** Viết xong persona này mới sang persona kia; không
   sửa lại persona trước cho khớp.
4. **Gom điểm đồng thuận** — chỗ cả năm (hoặc 4+) cùng ý.
5. **Gom điểm xung đột** — chỗ thật sự trái nhau, không phải khác cách diễn đạt.
6. **Cân đánh đổi** từng xung đột: mối lo nào tác động lớn hơn, và nếu chọn sai thì đảo
   ngược tốn bao nhiêu.
7. **Ra phán quyết.**

## Phán quyết

| Mức | Nghĩa |
|---|---|
| **GO** | năm persona thống nhất, không rủi ro nghiêm trọng, làm được |
| **THẬN TRỌNG** | có lo ngại nhưng xử lý được — đã chỉ ra cách giảm thiểu |
| **DỪNG** | có vấn đề nghiêm trọng chưa giải quyết — cần thiết kế lại hoặc thêm thông tin |

**Kích hoạt DỪNG** (chỉ cần một):

- Bảo mật thấy vượt xác thực hoặc lộ dữ liệu mà không có cách giảm thiểu khả thi.
- Kiến trúc thấy không tương thích nền tảng, phải làm lại phần lớn.
- Hiệu năng thấy độ trễ hoặc bùng nổ truy vấn không chấp nhận được, không có đường vòng.
- Phản biện lật được một giả định sai làm sụp cả cách tiếp cận.

DỪNG là phán quyết **đắt**. Dùng nó cho thứ thật sự phải dừng, không dùng để tỏ ra cẩn thận.

## Mẫu xuất

```
## Dự đoán: <tên đề xuất>

## Phán quyết: GO | THẬN TRỌNG | DỪNG

### Đồng thuận
- <điểm cả năm cùng ý>

### Xung đột và cách giải

| Vấn đề | Kiến trúc | Bảo mật | Hiệu năng | Trải nghiệm | Phản biện | Kết luận |
|---|---|---|---|---|---|---|
| <chủ đề> | <ý> | <ý> | <ý> | <ý> | <ý> | <chọn gì, vì sao> |

### Rủi ro

| Rủi ro | Mức | Cách giảm thiểu | Chi phí nếu sai |
|---|---|---|---|
| <mô tả> | cao/vừa/thấp | <hành động cụ thể> | <đảo ngược tốn gì> |

### Khuyến nghị
1. <hành động — vì sao>

### Chưa đủ thông tin để kết luận
<phần nào cần được cung cấp thêm>
```

## Sau đó

- Phán quyết đi về **bên giao việc**, không đi đâu khác.
- Rủi ro cần bổ chi tiết thành edge case → đề xuất một lượt `alp-scenario` riêng.
- Giả định sai bị lật ra → nói thẳng nó làm hỏng phần nào của kế hoạch, đừng gói trong
  ngôn ngữ lịch sự. Người ta mở một lượt phản biện chính là để nghe điều đó.
- Nháp và giả thuyết chưa kiểm chứng → kho riêng của bạn trong `memory/private/`.
