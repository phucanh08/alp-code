# Vùng va chạm

Ép hai khái niệm không liên quan vào nhau để lộ tính chất mới: **"nếu coi X như Y thì sao?"**

## Nguyên lý

Đột phá đến từ **trộn ẩn dụ có chủ đích**, không từ nghĩ chăm hơn trong cùng một khung.
Nghĩ chăm hơn trong khung cũ chỉ cho ra cải tiến từng bước.

## Khi nào dùng

| Triệu chứng | Việc phải làm |
|---|---|
| kẹt trong lối nghĩ thông thường | ép va chạm với một lĩnh vực xa |
| giải pháp nào cũng chỉ nhích thêm chút | cần đột phá, không phải tối ưu |
| "thử hết cách trong mảng này rồi" | nhập khái niệm từ nơi khác |

## Va chạm mẫu

| Coi cái này | Như cái này | Lộ ra |
|---|---|---|
| tổ chức code | DNA / di truyền | mutation testing, thuật toán tiến hoá |
| kiến trúc dịch vụ | gạch Lego | microservice ghép được, cắm-là-chạy |
| quản lý dữ liệu | dòng nước | streaming, data lake, hệ theo luồng |
| xử lý request | thư bưu điện | hàng đợi, xử lý bất đồng bộ |
| xử lý lỗi | cầu dao điện | cô lập sự cố, xuống cấp có kiểm soát |

## Quy trình

1. **Chọn hai khái niệm không liên quan**, từ hai lĩnh vực khác nhau.
2. **Ép ghép** — "nếu coi A như B thì sao?"
3. **Khai thác tính chất mới** — xuất hiện năng lực nào chưa từng nghĩ tới?
4. **Thử biên** — ẩn dụ gãy ở đâu?
5. **Rút nhận định.**

**Bước 4 là bước không được bỏ.** Ẩn dụ nào cũng gãy ở đâu đó; biết nó gãy chỗ nào mới là
phần dùng được. Đem một ẩn dụ đi quá biên của nó là cách sinh ra kiến trúc sai một cách
thanh lịch.

## Ví dụ chi tiết

**Vấn đề:** hệ phân tán, lỗi lan dây chuyền.

**Va chạm:** "nếu coi service như mạch điện?"

**Tính chất mới:**
- cầu dao (ngắt khi quá tải)
- cầu chì (bảo vệ một lần)
- nối đất (cô lập lỗi)
- cân tải (phân bổ dòng)
- ổn áp (giới hạn tần suất)

**Chỗ ẩn dụ đúng:** chặn lỗi lan, cô lập sự cố.

**Chỗ ẩn dụ gãy:** mạch điện không có retry, không tự lành.

**Nhận định rút ra:** mẫu cô lập sự cố mượn được từ kỹ thuật điện; mẫu tự phục hồi thì
phải lấy từ chỗ khác — sinh học chẳng hạn.

## Lĩnh vực nguồn tốt

**Vật lý** (lực, nhiệt động, tương đối) · **Sinh học** (tiến hoá, hệ sinh thái, miễn dịch)
· **Kinh tế** (thị trường, động lực, lý thuyết trò chơi) · **Tâm lý** (nhận thức, hành vi)
· **Kiến trúc** (kết cấu, luồng di chuyển, tổ chức không gian).

## Nhớ

- Ghép càng lạ càng hay ra nhận định tốt. Ghép an toàn thì chỉ ra thứ đã biết.
- Ghi lại cả va chạm **thất bại** — chỗ ẩn dụ gãy cũng là thông tin.
- Câu hỏi mở khoá: **"người giỏi nhất ở lĩnh vực kia sẽ làm gì với bài toán này?"**
- Đem về cho main dưới dạng khuyến nghị kèm biên của ẩn dụ, đừng đem về một ẩn dụ trần.
