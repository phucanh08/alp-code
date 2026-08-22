---
name: alp-debug
description: Điều tra sự cố có hệ thống — truy nguyên nhân gốc trước khi bàn cách sửa, phân tích log và CI/CD, chẩn đoán hiệu năng, kiểm chứng bằng bằng chứng. Kích hoạt khi bế tắc với một bug, test fail, hành vi lạ, pipeline hỏng, hoặc hệ chậm bất thường.
---

# alp-debug — điều tra trước, kết luận sau

Dùng khi **đã có giả thuyết và bằng chứng mà vẫn bế tắc** — nên đừng bắt đầu lại từ đầu,
hãy hỏi đã thử những gì rồi.

## Luật cứng

**KHÔNG KẾT LUẬN KHI CHƯA TRUY RA NGUYÊN NHÂN GỐC.**

Đoán rồi sửa là cách tạo bug mới trong lúc giấu bug cũ. Và nếu loadout không cấp `Edit` thì luật
này còn dễ giữ hơn: bạn **không sửa được gì**, chỉ giao nguyên nhân gốc cho người sửa.

Hệ quả: sản phẩm của bạn là **chuỗi bằng chứng**, không phải bản vá. Một chuỗi bằng chứng
tốt phải để người đọc tự đi lại được và tới cùng kết luận.

## Chọn kỹ thuật

```
Bug trong code      → systematic-debugging.md      (4 pha, không nhảy pha)
  sâu trong stack     → root-cause-tracing.md      (lần ngược tới chỗ phát sinh)
  đã ra nguyên nhân   → defense-in-depth.md        (khuyến nghị chốt chặn từng lớp)
  sắp kết luận        → verification.md            (bằng chứng mới, không dùng lại cũ)

Sự cố mức hệ       → investigation-methodology.md  (5 bước)
  CI/CD hỏng          → log-and-ci-analysis.md     (`gh` CLI)
  chậm bất thường     → performance-diagnostics.md
  cần viết báo cáo    → reporting-standards.md
```

| # | Kỹ thuật | Đọc khi |
|---|---|---|
| 1 | **Gỡ lỗi có hệ thống** | mọi bug cần điều tra — 4 pha: truy nguyên nhân → phân tích mẫu → thử giả thuyết → kết luận. Xong pha này mới sang pha kia |
| 2 | **Lần ngược nguyên nhân** | lỗi nổ sâu trong call stack, chưa rõ dữ liệu hỏng sinh ra từ đâu. Có `scripts/find-polluter.sh` để bisect test bị nhiễm |
| 3 | **Phòng thủ nhiều lớp** | đã ra nguyên nhân, cần chỉ ra nên chốt ở những lớp nào: chặn ở cửa vào → nghiệp vụ → guard môi trường → chỗ đặt log |
| 4 | **Kiểm chứng** | sắp nói "đã tìm ra" hoặc "đã hết" |
| 5 | **Phương pháp điều tra** | sự cố nhiều thành phần: đánh giá ban đầu → thu thập dữ liệu → phân tích → xác định gốc → phương án |
| 6 | **Phân tích log và CI/CD** | pipeline hỏng, lỗi phía server, sự cố deploy |
| 7 | **Chẩn đoán hiệu năng** | truy vấn chậm, độ trễ cao, cạn tài nguyên |
| 8 | **Chuẩn báo cáo** | cần xuất báo cáo chẩn đoán có cấu trúc |

## Công cụ có sẵn

- **Database:** `psql` cho PostgreSQL.
- **CI/CD:** `gh` CLI cho log GitHub Actions.
- **Bế tắc thật sự:** skill `problem-solving` — đổi kiểu nghĩ, không nghĩ chăm hơn.

Cần thứ bạn không lấy được (tìm code diện rộng, tra tài liệu ngoài) → **nói rõ cần gì và
báo lại**. Loadout không cho giao việc thì đừng tự đi tìm đường vòng.

## Cờ đỏ — dừng lại nếu bắt gặp mình đang nghĩ

- "sửa tạm đã, điều tra sau"
- "cứ thử đổi X xem sao"
- "chắc là do X, sửa chỗ đó"
- "chắc hết rồi" · "nhìn có vẻ ổn"
- "test xanh rồi, xong"

Tất cả đều nghĩa là: quay lại quy trình. Và còn một cờ đỏ nữa — **"để tôi sửa luôn"**:
nếu loadout không cấp `Edit` thì viết đề xuất ra, đừng tìm đường vòng qua `Bash`
(HOUSE-RULES §1.9).

## Bàn giao

Báo cáo gồm đúng bốn phần:

```
## Điều tra: <triệu chứng>

### Nguyên nhân gốc
<một câu. Chưa ra thì ghi "chưa xác định được" — không thay bằng nguyên nhân gần nhất>

### Chuỗi bằng chứng
1. <quan sát> — `path:line` hoặc output lệnh
2. <suy ra> — vì sao bước 1 dẫn tới đây
...

### Đã loại trừ
<giả thuyết nào đã thử và bị bác, bằng gì — để người đọc không đi lại đường cũ>

### Đề xuất sửa
<sửa ở đâu, vì sao ở đó chứ không phải chỗ triệu chứng nổ ra>
```

Nháp và giả thuyết chưa kiểm chứng → kho riêng của bạn trong `memory/private/`. Chỉ kết
luận đã có bằng chứng mới đi vào báo cáo.
