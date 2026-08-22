# Kiểm chứng trước khi kết luận

Đây là việc chẩn đoán, không phải việc sửa. Nên thứ bạn phải kiểm chứng không phải "đã làm
xong chưa" mà là **"kết luận này có đứng vững không"**.

Nói sai nguyên nhân gốc còn tệ hơn nói không biết: người ta sẽ đi sửa nhầm chỗ, mất thời
gian gấp đôi, và lần sau không tin bạn nữa.

## Luật sắt

```
KHÔNG KẾT LUẬN KHI CHƯA CÓ BẰNG CHỨNG MỚI, LẤY TRONG PHIÊN NÀY
```

## Hàm cổng

```
TRƯỚC khi nói bất cứ kết luận nào:

1. XÁC ĐỊNH: lệnh hoặc quan sát nào chứng minh được điều này?
2. CHẠY:     chạy đủ, mới, không cắt
3. ĐỌC:      đọc hết output, xem exit code, đếm số fail
4. ĐỐI CHIẾU: output có xác nhận không?
   - KHÔNG → nói trạng thái thật, kèm bằng chứng
   - CÓ    → nói kết luận, KÈM bằng chứng
5. RỒI MỚI: phát biểu

Bỏ bước nào = đoán, không phải kết luận
```

## Ba mức tin cậy — phải nói rõ mức nào

| Mức | Điều kiện | Viết thế nào |
|---|---|---|
| **Đã xác nhận** | tái hiện được, có output | "chạy X, output cho thấy Y" |
| **Giả thuyết** | hợp lý nhưng chưa tái hiện | "có thể do X — chưa tái hiện được" |
| **Tương quan** | hai thứ cùng xuất hiện | "X và Y cùng xuất hiện — chưa chứng minh nhân quả" |

Trộn ba mức này vào cùng một giọng khẳng định là lỗi hay gặp nhất trong báo cáo điều tra.

## Bảng đối chiếu

| Kết luận | Bằng chứng bắt buộc | KHÔNG đủ |
|---|---|---|
| đây là nguyên nhân gốc | tái hiện được, và gỡ nguyên nhân thì triệu chứng biến mất | code đọc thấy có vẻ sai |
| lỗi nằm ở thành phần X | log ở ranh giới cho thấy dữ liệu vào đúng, ra sai | X là chỗ stack trace nổ |
| test fail do môi trường | chạy lại ở môi trường sạch: pass | "chắc do máy CI" |
| chậm vì truy vấn N+1 | có số đo: số truy vấn, thời gian | đọc code thấy vòng lặp có query |
| đã loại trừ giả thuyết Y | thử Y, kết quả bác bỏ | thấy Y không hợp lý |

## Cờ đỏ — dừng lại

- Dùng "chắc là", "nhiều khả năng", "có vẻ" trong phần **Nguyên nhân gốc**.
- Kết luận dựa trên đọc code mà chưa chạy gì.
- Nhận báo cáo của agent khác làm bằng chứng — nó chạy phiên riêng, bạn không thấy nó đã
  chạy gì.
- Dừng ở nguyên nhân **gần nhất** vì nó đủ hợp lý.
- Mệt và muốn xong cho rồi.

## Chặn biện minh

| Lý do | Thực tế |
|---|---|
| "đọc code là thấy ngay mà" | đọc code cho giả thuyết, không cho kết luận |
| "tôi khá chắc" | chắc ≠ bằng chứng |
| "không tái hiện được nhưng chắc đúng" | thì ghi là giả thuyết, đừng ghi là nguyên nhân gốc |
| "đang gấp" | kết luận sai làm mất nhiều thời gian hơn |
| "bên kia đã kiểm rồi" | kiểm độc lập, hoặc ghi rõ là dựa vào báo cáo của họ |

## Bài kiểm quyết định

Một nguyên nhân gốc chỉ được gọi là **đã xác nhận** khi trả lời được cả hai:

1. **Tái hiện được triệu chứng** theo đúng cơ chế đã mô tả?
2. **Gỡ nguyên nhân đi thì triệu chứng biến mất?** — hoặc chứng minh được bằng suy luận từ
   bằng chứng đã có.

Không trả lời được câu 2 thì đó vẫn là giả thuyết mạnh, không phải nguyên nhân gốc. Nói
đúng như vậy trong báo cáo.

## Chốt

Chạy. Đọc output. **Rồi mới** kết luận.

Chưa ra thì nói chưa ra, kèm danh sách đã loại trừ. Đó là câu trả lời hợp lệ và hữu ích —
Một lượt chẩn đoán được mở ra vì độ tin cậy, không vì tốc độ.
