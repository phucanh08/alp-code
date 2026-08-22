# Trò chơi quy mô

Thử ở cực trị — lớn gấp 1000, nhỏ đi 1000, tức thì, kéo dài một năm — để lộ ra bản chất bị
che ở quy mô bình thường.

## Nguyên lý

**Cực trị làm lộ bản chất.** Thứ chạy tốt ở quy mô này hỏng ở quy mô khác, và chỗ nó hỏng
cho biết cái gì là thiết yếu, cái gì chỉ là ngẫu nhiên.

## Khi nào dùng

| Triệu chứng | Việc phải làm |
|---|---|
| "chắc scale được" mà chưa thử | thử ở cực trị |
| không rõ chạy thật sẽ thế nào | nhân lên 1000 lần |
| edge case chưa rõ | thử cả tối thiểu lẫn tối đa |
| cần thẩm định kiến trúc | thử cực trị trước khi chốt |

## Các chiều

| Chiều | Thử ở cực trị | Lộ ra |
|---|---|---|
| **Khối lượng** | 1 phần tử ↔ 1 tỷ | giới hạn độ phức tạp thuật toán |
| **Tốc độ** | tức thì ↔ một năm | nhu cầu bất đồng bộ, nhu cầu cache |
| **Người dùng** | 1 ↔ 1 tỷ | vấn đề đồng thời, giới hạn tài nguyên |
| **Thời lượng** | mili giây ↔ nhiều năm | rò bộ nhớ, trạng thái phình |
| **Tỷ lệ lỗi** | không bao giờ lỗi ↔ luôn lỗi | xử lý lỗi có đủ không |

## Quy trình

1. **Chọn chiều** — cái gì có thể biến thiên cực đoan?
2. **Thử cực tiểu** — nhỏ/nhanh/ít đi 1000 lần thì sao?
3. **Thử cực đại** — lớn/chậm/nhiều lên 1000 lần thì sao?
4. **Ghi cái gì vỡ** — giới hạn nằm ở đâu?
5. **Ghi cái gì sống** — phần nào vững về bản chất?
6. **Thiết kế cho thực tế** — dùng nhận định để thẩm định kiến trúc.

## Ví dụ

**Xử lý lỗi.** Quy mô thường: "có lỗi thì xử lý" — ổn. Ở 1 tỷ: lượng lỗi làm ngập hệ log,
sập hệ. → Phải làm cho lỗi **không thể xảy ra** (hệ kiểu), hoặc **coi lỗi là bình thường**
(thiết kế chịu lỗi). Thiết kế xử lý lỗi theo *khối lượng*, không chỉ theo *sự kiện*.

**API đồng bộ.** Quy mô thường: gọi trực tiếp, dưới 100ms — ổn. Quy mô toàn cầu: độ trễ
mạng 200–500ms làm đồng bộ không dùng được. → Bất đồng bộ trở thành điều kiện sống, không
phải tối ưu.

**Trạng thái trong bộ nhớ.** Chạy vài giờ/vài ngày: ổn. Chạy nhiều năm: bộ nhớ phình vô
hạn, sập. → Cần lưu ra ngoài hoặc dọn định kỳ.

## Chiều nhỏ cũng quan trọng

Thử **nhỏ lại** hay bị bỏ qua, mà nó lộ ra over-engineering:

- Nếu chỉ có 1 người dùng thì độ phức tạp này còn hợp lý không?
- Nếu chỉ có 10 phần tử thì tối ưu kia có sớm quá không?
- Nếu phản hồi tức thì thì cái gì trở thành không cần?

Với alp-code, chiều nhỏ là chiều đúng để thử: hệ này có **8 vai và một principal**. Đề xuất
nào chỉ có nghĩa ở quy mô hàng trăm agent thì là over-engineering ở đây — và YAGNI là luật
thành văn của repo.

## Cờ đỏ

- "chạy được ở máy tôi" — nhưng chạy thật thì sao?
- Không biết giới hạn nằm ở đâu.
- "chắc scale được" mà không có bằng chứng.
- Bị bất ngờ bởi hành vi lúc chạy thật.
- Kiến trúc thấy tuỳ tiện, không có lý do cho các lựa chọn.

## Xong thì phải biết

- Hệ vỡ ở đâu — **giới hạn cụ thể**, không phải cảm giác.
- Cái gì sống sót — phần vững về bản chất.
- Cái gì phải thiết kế lại — phần phụ thuộc quy mô.

## Nhớ

- Thử **cả hai chiều**, lớn và nhỏ.
- Đừng đoán — thử. "Chắc là" không phải kết luận.
- Nhận định rút ra đi vào khuyến nghị, kèm con số cụ thể chứ không kèm tính từ.
