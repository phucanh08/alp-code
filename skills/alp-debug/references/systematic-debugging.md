# Gỡ lỗi có hệ thống

Bốn pha. Pha này xong mới sang pha kia.

## Luật sắt

```
KHÔNG ĐỀ XUẤT SỬA KHI CHƯA TRUY XONG NGUYÊN NHÂN GỐC
```

Chưa xong Pha 1 thì không được đề xuất cách sửa.

Nếu loadout không cấp `Edit` thì luật này còn dễ giữ hơn: bạn **không sửa được gì**. Sản
phẩm của bạn là nguyên nhân gốc kèm chuỗi bằng chứng; người khác mới là người sửa.

## Pha 1 — Truy nguyên nhân gốc

1. **Đọc kỹ thông báo lỗi.** Đọc hết stack trace, đừng lướt qua warning. Dòng bạn bỏ qua
   thường là dòng nói thật.
2. **Tái hiện ổn định.** Kích hoạt lại được không? Chính xác các bước nào? Không tái hiện
   được → thu thập thêm dữ liệu, **chưa** đưa giả thuyết.
3. **Xem gì vừa đổi.** `git diff`, commit gần đây, phụ thuộc mới, config đổi.
4. **Thu bằng chứng ở ranh giới giữa các thành phần.** Với mỗi ranh giới: dữ liệu vào là
   gì, ra là gì, biến môi trường có truyền qua không. Chạy **một lượt** để biết nó vỡ ở
   *đâu*, rồi mới phân tích *vì sao*.
5. **Lần theo dòng dữ liệu.** Giá trị sai sinh ra từ đâu? Lần ngược call stack tới nguồn —
   xem `root-cause-tracing.md`.

Chưa xong 5 bước này thì mọi giả thuyết đều là đoán.

## Pha 2 — Phân tích mẫu

1. **Tìm ví dụ đang chạy đúng.** Code tương tự trong cùng repo mà không hỏng.
2. **Đọc bản tham chiếu ĐẦY ĐỦ** trước khi so. Đọc lướt rồi so là cách bỏ sót đúng khác
   biệt quan trọng.
3. **Liệt kê mọi khác biệt**, dù nhỏ. Không được tự nhủ "chỗ đó không thể ảnh hưởng".
4. **Hiểu phụ thuộc** — cần thành phần nào, config nào, biến môi trường nào.

## Pha 3 — Giả thuyết và kiểm chứng

1. **Một giả thuyết, cụ thể:** "tôi cho rằng X là nguyên nhân gốc vì Y". Không phải "chắc
   do phần auth".
2. **Thử tối thiểu** — thay đổi nhỏ nhất đủ để kiểm giả thuyết. **Một biến một lần.**
3. **Kiểm chứng trước khi đi tiếp.** Đúng → Pha 4. Sai → giả thuyết **mới**, không phải
   chồng thêm bản sửa.
4. **Không biết thì nói không biết.** "Tôi chưa hiểu vì sao X" là câu hợp lệ. Giả vờ hiểu
   là cách để người đọc đi sửa nhầm chỗ.

## Pha 4 — Kết luận và bàn giao

1. **Tái hiện được, càng nhỏ càng tốt.** Tự động hoá được thì tốt. Đây là thứ chứng minh
   nguyên nhân gốc đúng.
2. **Một đề xuất sửa duy nhất**, nhắm nguyên nhân gốc. Không kèm "tiện tay cải thiện luôn".
3. **Chỉ rõ vì sao sửa ở đó**, chứ không phải ở chỗ triệu chứng nổ ra.
4. **Đề xuất không đứng vững:**
   - DỪNG. Đếm: đã thử mấy giả thuyết?
   - Dưới 3 → về Pha 1 với thông tin mới.
   - **Từ 3 trở lên → dừng và chất vấn kiến trúc.**
5. **Ba lần thất bại nghĩa là gì.** Mẫu điển hình: mỗi lần sửa lại lộ ra một chỗ dùng chung
   trạng thái hoặc coupling khác. Đó không còn là bug, đó là kiến trúc sai. Dừng, báo lại,
   và cân nhắc `alp-predict` hoặc `problem-solving` thay vì thử tiếp.

## Cờ đỏ — dừng lại, quay về Pha 1

- "sửa tạm đã, điều tra sau"
- "cứ thử đổi X xem sao"
- "đổi vài chỗ rồi chạy test"
- "bỏ qua test, kiểm tay cũng được"
- "chắc là do X, sửa chỗ đó"
- "tôi chưa hiểu hết nhưng chắc cách này được"
- "thử thêm một lần nữa thôi" — khi đã thử 2+ lần

## Tín hiệu cho thấy bạn đang làm sai

| Nghe câu này | Nghĩa là |
|---|---|
| "thế nó có xảy ra không?" | bạn đang giả định mà chưa kiểm |
| "chạy cái đó có cho thấy gì không?" | lẽ ra phải thu bằng chứng trước |
| "đừng đoán nữa" | đang đề xuất sửa khi chưa hiểu |
| "nghĩ kỹ lại từ gốc" | chất vấn nền tảng, không phải triệu chứng |

Gặp mấy câu này → về Pha 1.

## Chặn biện minh

| Lý do | Thực tế |
|---|---|
| "lỗi đơn giản, không cần quy trình" | lỗi đơn giản cũng có nguyên nhân gốc |
| "gấp lắm, không kịp làm quy trình" | có hệ thống **nhanh hơn** đoán-và-thử |
| "thử cái này trước rồi điều tra sau" | lần thử đầu đặt luôn lối mòn |
| "thử thêm lần nữa" (sau 2 lần hỏng) | 3 lần hỏng = vấn đề kiến trúc |

Cái giá thật: có hệ thống mất 15–30 phút; đoán bừa mất 2–3 giờ và hay đẻ bug mới.
