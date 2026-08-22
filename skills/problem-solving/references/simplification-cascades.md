# Thác đơn giản hoá

Tìm **một** nhận định xoá được nhiều thành phần cùng lúc: "nếu điều này đúng thì không cần
X, Y, Z nữa."

## Nguyên lý

**"Mọi thứ đều là trường hợp riêng của…"** — vế sau câu này, khi điền đúng, làm sập cả một
mảng phức tạp.

Một trừu tượng mạnh hơn mười thủ thuật khéo.

## Khi nào dùng

| Triệu chứng | Việc phải làm |
|---|---|
| cùng một thứ triển khai 5 kiểu | trừu tượng hoá mẫu chung |
| danh sách special case cứ dài ra | tìm trường hợp tổng quát |
| luật phức tạp kèm nhiều ngoại lệ | tìm luật không có ngoại lệ |
| quá nhiều tuỳ chọn config | tìm mặc định đúng cho 95% |

## Cách tìm

Tìm dấu hiệu: nhiều bản triển khai của những khái niệm na ná nhau · xử lý special case rải
khắp nơi · câu "cần xử lý A, B, C, D theo cách khác nhau" · luật nhiều ngoại lệ.

Rồi hỏi: **"nếu bên dưới chúng là cùng một thứ thì sao?"**

## Ví dụ

**Trừu tượng stream**
- Trước: handler riêng cho dữ liệu batch / thời gian thực / file / mạng.
- Nhận định: "mọi đầu vào đều là stream, chỉ khác nguồn."
- Sau: một bộ xử lý stream, nhiều nguồn stream.
- Xoá được: 4 bản triển khai.

**Quản trị tài nguyên**
- Trước: theo dõi session, giới hạn tần suất, kiểm file, pool kết nối — bốn hệ riêng.
- Nhận định: "tất cả đều là giới hạn tài nguyên theo từng thực thể."
- Sau: một `ResourceGovernor`, bốn loại tài nguyên.

**Bất biến**
- Trước: copy phòng thủ, khoá, huỷ cache, phụ thuộc thứ tự thời gian.
- Nhận định: "coi mọi thứ là dữ liệu bất biến + phép biến đổi."
- Xoá được: cả một lớp bài toán đồng bộ.

## Quy trình

1. **Liệt kê biến thể** — cái gì đang được làm nhiều kiểu?
2. **Tìm bản chất** — bên dưới chúng giống nhau ở đâu?
3. **Rút trừu tượng** — mẫu đó, bỏ hết chi tiết nghiệp vụ, là gì?
4. **Thử khớp** — mọi trường hợp hiện có có vừa không? Có cái nào phải gượng ép không?
5. **Đo thác** — bao nhiêu thứ trở thành không cần thiết?

Bước 4 là bước quyết định. Một trừu tượng phải **gượng ép** mới nhét vừa một trường hợp thì
nó chưa đúng — và nó sẽ đẻ ra special case mới ngay sau khi bạn áp dụng.

## Cờ đỏ — đang bỏ lỡ một thác

- "chỉ cần thêm một case nữa thôi" — lặp mãi không dứt.
- "chúng giống nhau nhưng khác nhau" — có thể chúng giống thật?
- Refactor như đập chuột: sửa chỗ này vỡ chỗ kia.
- File config cứ dài ra.
- "Đừng đụng vào đó, phức tạp lắm" — phức tạp đang che một mẫu chưa được nhận ra.

## Thước đo

- **Thắng 10 lần, không phải 10%.** Cải thiện 10% thì không phải thác.
- Đo bằng "xoá được bao nhiêu thứ", không phải "thêm được bao nhiêu".
- Số dòng xoá > số dòng thêm.
- Số tuỳ chọn config biến mất.

## Với alp-code

Repo này đã có sẵn nguyên tắc cùng hướng — `README.md`: `scripts/lib/` là **"MỘT nguồn cho
mỗi loại config"**. Khi đề xuất một thác, kiểm xem nó có đang dựng thêm nguồn thứ hai cho
cùng một loại dữ liệu không. Nếu có thì đó không phải thác, đó là mảnh vỡ mới.

## Nhớ

- Mẫu thường **đã có sẵn**, chỉ chưa ai gọi tên nó.
- Thác đúng thì nhìn lại thấy hiển nhiên. Nghe hiển nhiên không phải là dấu hiệu tầm thường.
- Ghi lại nhận định — nó có giá trị hơn bản refactor nó sinh ra.
