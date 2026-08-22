# Nhận mẫu meta

Tìm mẫu xuất hiện ở **3+ lĩnh vực** để rút ra nguyên lý dùng chung được.

## Nguyên lý

**Tìm mẫu trong cách các mẫu hình thành.** Cùng một hình dạng xuất hiện ở 3 lĩnh vực không
liên quan thì nhiều khả năng nó là nguyên lý phổ quát, đáng rút ra.

## Khi nào dùng

| Triệu chứng | Việc phải làm |
|---|---|
| cùng vấn đề ở nhiều chỗ khác nhau | rút dạng trừu tượng |
| cảm giác đã gặp bài này rồi | tìm mẫu phổ quát |
| phát minh lại bánh xe ở nhiều mảng | nhận diện mẫu meta |
| "hình như mình làm cái này rồi?" | rồi — tìm lại và dùng lại |

## Mẫu tham chiếu

| Mẫu xuất hiện ở | Dạng trừu tượng | Còn ở đâu nữa |
|---|---|---|
| cache CPU / DB / HTTP / DNS | đưa dữ liệu hay dùng lại gần chỗ dùng | cache prompt LLM, CDN |
| phân lớp (mạng / lưu trữ / tính toán) | tách mối quan tâm thành các tầng trừu tượng | kiến trúc, cơ cấu tổ chức |
| hàng đợi (message / task / request) | tách người sản xuất khỏi người tiêu thụ bằng bộ đệm | hệ sự kiện, bất đồng bộ |
| pool (kết nối / thread / object) | dùng lại tài nguyên đắt | quản lý bộ nhớ |

## Quy trình

1. **Thấy lặp lại** — cùng một hình dạng ở 3+ chỗ.
2. **Rút dạng trừu tượng** — mô tả nó mà **không nhắc tới lĩnh vực nào**.
3. **Nhận điểm biến thiên** — mỗi lĩnh vực thích nghi khác nhau ở chỗ nào?
4. **Kiểm khả dụng** — còn chỗ nào dùng được nữa?
5. **Ghi lại mẫu** cho lần sau.

Bước 2 là bài kiểm tra thật: **mô tả được mà không nhắc lĩnh vực nào không?** Không mô tả
được nghĩa là bạn đang thấy ba thứ giống nhau bề ngoài, không phải một mẫu.

## Ví dụ

**Mẫu:** giới hạn tần suất xuất hiện ở —

- throttle API (request mỗi phút)
- định hình lưu lượng mạng (gói tin mỗi giây)
- cầu dao (số lỗi trong một cửa sổ)
- kiểm soát nạp vào (số kết nối đồng thời)

**Dạng trừu tượng:** chặn mức tiêu thụ tài nguyên để tránh cạn kiệt.

**Điểm biến thiên:** tài nguyên gì · giới hạn theo cửa sổ thời gian hay đồng thời hay tích
luỹ · vượt thì làm gì (từ chối, xếp hàng, xuống cấp).

**Ứng dụng mới:** ngân sách token cho LLM — cùng mẫu, tài nguyên là token, giới hạn là
kích thước cửa sổ context, vượt thì cắt bớt hoặc từ chối.

Ngân sách 5 lượt tìm của `research` và giới hạn "boot set ≤ 7 nguồn" của CHARTER §2.6
cũng là cùng mẫu này.

## Luật 3 lĩnh vực

| Số lần thấy | Nghĩa |
|---|---|
| 1 | trùng hợp |
| 2 | có thể là mẫu |
| 3+ | nhiều khả năng phổ quát |

Rút mẫu từ 2 lần thấy là trừu tượng hoá sớm — và trừu tượng sai đắt hơn trùng lặp.

## Cờ đỏ — đang bỏ lỡ mẫu meta

- "vấn đề này đặc thù, không giống ai" — hầu như luôn sai.
- Nhiều người đang giải những bài "khác nhau" theo cách giống hệt nhau.
- Phát minh lại bánh xe ở các mảng khác nhau.

## Nhớ

- Dạng trừu tượng cho thấy **ứng dụng mới** — đó mới là giá trị, không phải việc đặt tên.
- Điểm biến thiên cho biết mẫu thích nghi ở đâu, và ở đâu thì gãy.
- Ghi lại để lần sau khỏi tìm lại — với alp-code, fact loại này thuộc `memory/shared/`,
  và việc ghi thuộc về bên có quyền ghi.
