# Quét vùng ảnh hưởng

Tìm file bị ảnh hưởng mà diff **không** cho thấy. Chạy trước khi đọc chi tiết từng dòng.

## Vì sao cần

Đọc diff cho biết cái gì đổi. Nó **không** cho biết cái gì lẽ ra phải đổi mà không đổi —
và đó mới là chỗ bug sống sót qua review.

Ví dụ điển hình: đổi chữ ký một hàm dùng chung, sửa hết chỗ gọi trực tiếp, bỏ sót chỗ gọi
qua một lớp wrapper. Diff sạch, test cũ vẫn xanh, hỏng lúc chạy thật.

## Khi nào bắt buộc

Tính năng nhiều file · refactor tiện ích dùng chung · sửa bug phức tạp · đổi chữ ký hàm
hoặc hình dạng dữ liệu.

Bỏ qua được: sửa một file, tài liệu, config không có nhánh logic.

## Quy trình

### 1. Lấy danh sách file đổi

```bash
git diff --name-only HEAD~1     # hoặc so với base được giao
```

### 2. Tìm ngược ra ngoài diff

Tự làm bằng `Grep`/`Glob`/`Bash`, không giao đi.

Với mỗi symbol công khai bị đổi trong diff:

```bash
rg -n '<tên hàm|tên hằng|tên type>' --glob '!node_modules'
```

Sáu thứ phải trả lời được:

1. **File nào import/phụ thuộc module đã đổi** — kể cả gọi gián tiếp qua wrapper.
2. **Dữ liệu chảy qua hàm đã sửa đi tới đâu**, và ai đọc kết quả đó.
3. **Đường lỗi nào chưa được test** — nhánh `catch`, `else`, giá trị trả về khi thất bại.
4. **Biên:** null, rỗng, 0, một phần tử, độ dài tối đa.
5. **Bất đồng bộ:** có race không, có thứ tự nào bị giả định ngầm không.
6. **Trạng thái dùng chung:** biến module, cache, singleton bị sửa ở đâu.

Cần đầy đủ tuyệt đối (trước một refactor lớn) → báo bên giao việc để nhờ một lượt phân
tích ảnh hưởng bằng `gkg`. `rg` khớp chuỗi, `gkg` đi theo quan hệ AST.

Bổ có hệ thống hơn nữa: skill `alp-scenario` (12 chiều).

### 3. Xử lý

| Phát hiện | Làm gì |
|---|---|
| file bị ảnh hưởng nằm ngoài diff | đưa vào phạm vi đọc, ghi rõ trong báo cáo |
| đường dữ liệu có rủi ro | truy tiếp tới nơi tiêu thụ, đừng dừng ở hàm bị sửa |
| edge case chưa có test | ghi vào NÊN SỬA |
| thay đổi im lặng phá hành vi cũ | CHẶN |

### 4. Đưa vào báo cáo

Kết quả quét **không** phải một mục riêng. Nó nhập vào báo cáo `code-review` theo đúng ba
mức CHẶN / NÊN SỬA / GHI NHẬN.

Riêng phần đã kiểm mà **không** thấy vấn đề thì vẫn nói — nó cho bên giao việc biết phạm vi bạn đã
phủ, và biết chỗ nào bạn chưa đụng tới:

```
Đã quét ngoài diff: <n> file gọi tới <symbol>
Không thấy vấn đề ở: <danh sách>
Chưa quét được: <chỗ nào, vì sao>
```

## Luật

Quét trước, đọc sau. Và **đừng tin "thay đổi này đơn giản"** — thay đổi đơn giản là loại
hay được cho qua nhất, nên cũng là loại sống sót qua review nhiều nhất.
