---
name: alp-scenario
description: Sinh edge case có hệ thống bằng cách bổ một tính năng hoặc đường code theo 12 chiều. Kích hoạt khi review concern correctness, khi cần liệt kê rủi ro trước lúc chốt một thay đổi, hoặc khi phải trả lời "còn thiếu trường hợp nào".
---

# alp-scenario — bổ theo 12 chiều

Skill của vai **review**. Dùng khi cần chắc rằng mình đã quét hết, không phải khi cần
nghĩ sâu — nghĩ sâu là việc của `oracle`.

Giá trị của skill này nằm ở chỗ nó **cưỡng bức tính đầy đủ**. Người review giỏi vẫn quên
chiều mình không quen. Danh sách dưới không cho quên.

## Khi nào dùng

- Concern `correctness` — sinh sẵn edge case rồi mới đọc diff.
- Trước khi main chốt một thay đổi có trạng thái, có đồng thời, hoặc chạm dữ liệu.
- Khi main hỏi "còn thiếu trường hợp nào" và cần câu trả lời có cấu trúc.

**Không dùng cho:** đổi một dòng, sửa chính tả, đổi config không có nhánh logic. Bổ 12
chiều cho một `const` là lãng phí ngân sách phiên.

## 12 chiều

Không phải chiều nào cũng áp dụng. **Lọc trước, sinh sau** — và nói rõ chiều nào bỏ, vì sao.
Liệt kê 12 chiều rồi sinh bừa cho đủ là cách nhanh nhất biến báo cáo thành rác.

| # | Chiều | Tìm gì |
|---|---|---|
| 1 | Loại người dùng | admin, khách, bị khoá, mới, power user, bot |
| 2 | Input cực đoan | rỗng, null, dài tối đa, unicode, ký tự đặc biệt, chuỗi injection |
| 3 | Thời gian | truy cập đồng thời, race, timeout, mạng chậm, retry dồn |
| 4 | Quy mô | 0 phần tử, 1, 1 triệu, biên phân trang, cursor quay vòng |
| 5 | Chuyển trạng thái | lần đầu, bỏ dở giữa chừng, chạy lại sau crash, hoàn thành một phần |
| 6 | Môi trường | máy yếu, không JS, screen reader, proxy/VPN, timezone/locale khác |
| 7 | Lỗi dây chuyền | DB chết, API timeout, đầy đĩa, OOM, đứt mạng, ghi dở |
| 8 | Phân quyền | token hết hạn, sai role, link public, CORS, CSRF, leo thang quyền |
| 9 | Toàn vẹn dữ liệu | bản ghi trùng, tham chiếu mồ côi, lệch encoding, migration đang chạy |
| 10 | Tích hợp | webhook phát lại, lệch version API, bên thứ ba chết, contract trôi |
| 11 | Tuân thủ | yêu cầu xoá dữ liệu, thiếu audit log, thời hạn lưu trữ, lộ PII |
| 12 | Nghiệp vụ | giá 0 hoặc âm, chồng khuyến mãi, hoàn tiền khi giao một phần, hạn mức gói free |

## Quy trình

1. **Đọc** file đích, hoặc phân tích mô tả tính năng main đưa.
2. **Lọc chiều** — đánh dấu chiều nào áp dụng, chiều nào không và vì sao.
3. **Sinh 3–5 kịch bản** cho mỗi chiều còn lại.
4. **Xếp mức** theo bảng dưới.
5. **Xuất bảng**, kèm tổng theo mức.

### Mức

| Mức | Nghĩa |
|---|---|
| **CHẶN** | mất dữ liệu, thủng bảo mật, vượt xác thực, hỏng âm thầm |
| **NÊN SỬA** | hỏng với một nhóm người dùng, dữ liệu không nhất quán |
| **GHI NHẬN** | UX xuống cấp, lỗi có thể phục hồi nhưng không báo cho người dùng |

Ba mức này khớp với `code-review` — cùng một thang, để main không phải quy đổi.

## Mẫu xuất

```
## Kịch bản: <đích>

Chiều đã bổ: <danh sách>
Chiều bỏ: <danh sách + lý do>

| # | Chiều | Kịch bản | Mức | Hành vi mong đợi |
|---|---|---|---|---|
| 1 | Input cực đoan | tên rỗng ở field bắt buộc | NÊN SỬA | trả 400 kèm lỗi field |
| 2 | Phân quyền | JWT hết hạn gọi route được bảo vệ | CHẶN | về login, huỷ session |
| 3 | Thời gian | hai người submit cùng form cùng lúc | NÊN SỬA | idempotency key hoặc báo xung đột |

Tổng: CHẶN n · NÊN SỬA n · GHI NHẬN n — trên x chiều
```

## Sau đó

Kịch bản là **đầu vào cho người khác**, không phải kết luận cuối:

- Mức CHẶN → đưa vào phần CHẶN của báo cáo `code-review`, kèm bằng chứng nếu tái hiện được.
- Rủi ro kiến trúc, đánh đổi khó đảo ngược → báo main, main quyết có gọi `oracle` không.
- Kịch bản chỉ là giả thuyết cho tới khi tái hiện được. Chưa tái hiện thì ghi ở mục
  "Chưa chắc", **không** ghi ở mục CHẶN.
